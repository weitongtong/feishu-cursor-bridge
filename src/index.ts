import fs from "node:fs";
import path from "node:path";
import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { config, workspaces, reloadWorkspaces } from "./config.js";
import {
  extractTextFromContent,
  getModeLabel,
  parseCommand,
  HELP_TEXT,
  type Command,
  type CursorMode,
} from "./command-parser.js";
import {
  executeCursorStream,
  createChat,
  type ExecuteResult,
  type ProgressEvent,
} from "./cursor-executor.js";
import {
  buildStatusCard,
  buildInfoCard,
  buildSessionCard,
  replyCard,
  replyMarkdownCard,
  type StatusCardOptions,
} from "./feishu-card.js";
import { replyMessage, replyError, editCard } from "./feishu-reply.js";
import {
  downloadMessageImage,
  extractImageKey,
  IMAGE_DIR_NAME,
} from "./feishu-image.js";
import {
  loadUserStates,
  saveUserState,
  deleteUserState,
  type PersistedState,
  type ChatRecord,
} from "./user-state.js";
import {
  loadTools,
  reloadTools,
  getToolList,
  findTool,
  matchToolByAlias,
  executeTool,
  type ToolDefinition,
} from "./tool-registry.js";

const client = new Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
});

// ── 消息去重 ──────────────────────────────────────────────
const handledMessages = new Set<string>();

function isDuplicate(messageId: string): boolean {
  if (handledMessages.has(messageId)) {
    console.warn(`[dedup] 重复消息已跳过: ${messageId}`);
    return true;
  }
  handledMessages.add(messageId);
  setTimeout(() => handledMessages.delete(messageId), 10 * 60 * 1000);
  return false;
}

// ── 内容级去重（防御不同 message_id 的重复消息）──────────
const CONTENT_DEDUP_WINDOW_MS = 10_000;
const recentContents = new Map<string, number>();

function isContentDuplicate(userId: string, text: string): boolean {
  const key = `${userId}:${text}`;
  const lastTime = recentContents.get(key);
  const now = Date.now();
  if (lastTime && now - lastTime < CONTENT_DEDUP_WINDOW_MS) {
    console.warn(`[dedup] 内容级重复已跳过: ${key.slice(0, 40)}`);
    return true;
  }
  recentContents.set(key, now);
  setTimeout(() => recentContents.delete(key), CONTENT_DEDUP_WINDOW_MS);
  return false;
}

// ── 用户会话 ──────────────────────────────────────────────
interface TaskRecord {
  mode: CursorMode;
  prompt: string;
  startedAt: number;
  originMessageId: string;
  chatType: string;
  statusCardMessageId?: string;
  abortController?: AbortController;
  toolName?: string;
}

interface QueuedMessage {
  text: string;
  messageId: string;
  mode?: CursorMode;
}

interface UserSession {
  userId: string;
  feishuChatId: string;
  workDir: string;
  model?: string;
  activeChatId?: string;
  chats: ChatRecord[];
  nextChatLabel?: string;
  activeTask?: TaskRecord;
  messageQueue: QueuedMessage[];
  inputBuffer: QueuedMessage[];
}

function sessionKey(userId: string, feishuChatId: string): string {
  return `${userId}:${feishuChatId}`;
}

const sessions = new Map<string, UserSession>();
const persistedStates = loadUserStates();

function getSession(userId: string, feishuChatId: string): UserSession {
  const key = sessionKey(userId, feishuChatId);
  let session = sessions.get(key);
  if (!session) {
    let persisted = persistedStates.get(key);

    if (!persisted) {
      const legacyState = persistedStates.get(userId);
      if (legacyState) {
        persisted = legacyState;
        persistedStates.set(key, legacyState);
        persistedStates.delete(userId);
        deleteUserState(userId);
        console.log(
          `[state] 迁移旧 key ${userId.slice(0, 10)}... → ${key.slice(0, 20)}...`,
        );
      }
    }

    let workDir = persisted?.workDir ?? config.cursor.defaultWorkDir;
    if (
      persisted?.workDir &&
      (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory())
    ) {
      console.warn(
        `[state] 用户 ${userId.slice(0, 10)}... 的工作区 ${workDir} 已不存在，回退到默认`,
      );
      workDir = config.cursor.defaultWorkDir;
    }
    session = {
      userId,
      feishuChatId,
      workDir,
      model: persisted?.model ?? config.cursor.defaultModel,
      activeChatId: persisted?.activeChatId,
      chats: persisted?.chats ?? [],
      messageQueue: [],
      inputBuffer: [],
    };
    sessions.set(key, session);
  }
  return session;
}

function persistSession(session: UserSession): void {
  const key = sessionKey(session.userId, session.feishuChatId);
  const state: PersistedState = {
    workDir: session.workDir,
    model: session.model,
    activeChatId: session.activeChatId,
    chats: session.chats,
  };
  saveUserState(key, state);
}

// ── 输入缓冲 ─────────────────────────────────────────────

function clearBuffer(session: UserSession): QueuedMessage[] {
  return session.inputBuffer.splice(0);
}

const IMAGE_REF_MARKER = "[图片已保存:";
const IMAGE_PROMPT_HINT =
  "\n\n（上述路径指向的图片文件已保存在工作区中，请使用文件读取工具查看图片内容。）";

function mergeBufferText(buffer: QueuedMessage[]): string {
  const merged = buffer.map((m) => m.text).join("\n");
  if (merged.includes(IMAGE_REF_MARKER)) {
    return merged + IMAGE_PROMPT_HINT;
  }
  return merged;
}

// ── 工具函数 ──────────────────────────────────────────────

function findWorkspaceAlias(dir: string): string | undefined {
  for (const [alias, workspaceDir] of workspaces) {
    if (workspaceDir === dir) return alias;
  }
  return undefined;
}

function getWorkspaceLabel(dir: string): string {
  const alias = findWorkspaceAlias(dir);
  return alias ? `${alias} (${dir})` : dir;
}

function summarizePrompt(prompt: string, maxLen = 90): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1) + "…";
}

function formatElapsed(ts: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatDurationMs(durationMs?: number): string | undefined {
  if (!durationMs) return undefined;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest}s`;
}

function renderSummary(counts: {
  read: number;
  write: number;
  command: number;
  search: number;
  other: number;
}): string {
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read}`);
  if (counts.write) parts.push(`编辑 ${counts.write}`);
  if (counts.command) parts.push(`命令 ${counts.command}`);
  if (counts.search) parts.push(`搜索 ${counts.search}`);
  if (counts.other) parts.push(`其他 ${counts.other}`);
  return parts.join(" · ");
}

function renderWorkspaceList(session: UserSession): string {
  if (workspaces.size === 0) {
    return "尚未定义任何工作区。\n请在 `workspaces.json` 中配置别名后发 `/reload`。";
  }

  const lines: string[] = [];
  let idx = 1;
  for (const [alias, dir] of workspaces) {
    const isCurrent = session.workDir === dir;
    lines.push(isCurrent ? `${idx}. **${alias}** (当前)` : `${idx}. ${alias}`);
    idx++;
  }
  lines.push("", "发送 `/ws` <编号或别名> 即可切换。");
  return lines.join("\n");
}

function getTaskLabel(task: TaskRecord): string {
  return task.toolName ? `工具 ${task.toolName}` : getModeLabel(task.mode);
}

function isSessionMutable(command: Command): boolean {
  return (
    command.type === "chat-new" ||
    command.type === "chat-switch" ||
    command.type === "ws-switch" ||
    command.type === "model"
  );
}

// ── 实时状态面板 (卡片模式) ──────────────────────────────
const THROTTLE_MS = 15_000;
const MAX_EDITS_PER_MSG = 18;

class CardProgressUpdater {
  private client: Client;
  private originMessageId: string;
  private currentMessageId: string;
  private workDir: string;
  private mode: CursorMode;
  private prompt: string;
  private sessionLabel: string;
  private model?: string;
  private startTime = Date.now();
  private currentActivity = "正在启动";
  private counts = { read: 0, write: 0, command: 0, search: 0, other: 0 };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastEditTime = 0;
  private editCount = 0;

  constructor(
    feishuClient: Client,
    originMessageId: string,
    progressMessageId: string,
    options: {
      workDir: string;
      mode: CursorMode;
      prompt: string;
      sessionLabel: string;
      model?: string;
    },
  ) {
    this.client = feishuClient;
    this.originMessageId = originMessageId;
    this.currentMessageId = progressMessageId;
    this.workDir = options.workDir;
    this.mode = options.mode;
    this.prompt = options.prompt;
    this.sessionLabel = options.sessionLabel;
    this.model = options.model;
    this.heartbeatTimer = setInterval(() => this.scheduleFlush(), THROTTLE_MS);
  }

  setModel(model: string) {
    this.model = model;
  }

  setSessionLabel(sessionLabel: string) {
    this.sessionLabel = sessionLabel;
  }

  update(event: ProgressEvent) {
    this.counts[event.category]++;
    this.currentActivity = event.detail;
    this.scheduleFlush();
  }

  private buildCard(status: StatusCardOptions["status"], note?: string) {
    return buildStatusCard({
      mode: this.mode,
      prompt: this.prompt,
      workspaceLabel: getWorkspaceLabel(this.workDir),
      model: this.model,
      sessionLabel: this.sessionLabel,
      status,
      currentActivity: this.currentActivity,
      elapsedText: formatElapsed(this.startTime),
      summary: renderSummary(this.counts) || undefined,
      note,
    });
  }

  private scheduleFlush() {
    if (this.timer) return;

    const elapsed = Date.now() - this.lastEditTime;
    const delay = Math.max(0, THROTTLE_MS - elapsed);

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush() {
    if (this.editCount >= MAX_EDITS_PER_MSG) {
      const newId = await replyCard(
        this.client,
        this.originMessageId,
        this.buildCard("running"),
      );
      if (newId) {
        this.currentMessageId = newId;
        this.editCount = 0;
      }
      return;
    }
    this.editCount++;
    this.lastEditTime = Date.now();
    await editCard(
      this.client,
      this.currentMessageId,
      this.buildCard("running"),
    ).catch(console.error);
  }

  async finalize(result: ExecuteResult) {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const dur =
      formatDurationMs(result.durationMs) ?? formatElapsed(this.startTime);

    const cardStatus: StatusCardOptions["status"] = result.cancelled
      ? "cancelled"
      : result.success
        ? result.isCloud
          ? "submitted"
          : "success"
        : "error";

    this.currentActivity = `耗时 ${dur}`;

    let note: string | undefined;
    if (
      this.mode === "agent" &&
      result.success &&
      !result.isCloud &&
      !result.cancelled
    ) {
      note =
        "继续发消息可在同一 chat 中追加需求，发 `/chat new` 开启新 chat，发 `/chat` 查看所有 chat。";
    }

    await editCard(
      this.client,
      this.currentMessageId,
      this.buildCard(cardStatus, note),
    ).catch(console.error);

    if (result.output && !result.cancelled) {
      await replyMarkdownCard(this.client, this.originMessageId, result.output);
    }
  }
}

// ── Cursor 指令处理 ──────────────────────────────────────
function generateChatLabel(session: UserSession): string {
  const workDirChats = session.chats.filter(
    (c) => c.workDir === session.workDir,
  );
  const base = `chat-${workDirChats.length + 1}`;
  const existing = new Set(workDirChats.map((c) => c.label));
  if (!existing.has(base)) return base;
  let i = workDirChats.length + 2;
  while (existing.has(`chat-${i}`)) i++;
  return `chat-${i}`;
}

async function ensureChatId(session: UserSession): Promise<string> {
  if (session.activeChatId) {
    const found = session.chats.find((c) => c.chatId === session.activeChatId);
    if (found) return session.activeChatId;
  }

  const chatId = await createChat(session.workDir);
  const label = session.nextChatLabel || generateChatLabel(session);
  session.nextChatLabel = undefined;
  session.chats.push({
    chatId,
    label,
    workDir: session.workDir,
    createdAt: Date.now(),
  });
  session.activeChatId = chatId;
  return chatId;
}

function isResumeError(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("chat not found") ||
    lower.includes("invalid chat") ||
    lower.includes("no such chat") ||
    lower.includes("resume") ||
    lower.includes("does not exist")
  );
}

async function executeCursorCommand(
  messageId: string,
  session: UserSession,
  mode: CursorMode,
  prompt: string,
): Promise<ExecuteResult> {
  const abortController = new AbortController();
  if (session.activeTask) {
    session.activeTask.abortController = abortController;
  }
  const { signal } = abortController;

  let chatId: string | undefined;
  try {
    chatId = await ensureChatId(session);
    persistSession(session);
  } catch (err) {
    console.error("[session] 创建会话失败，将以无上下文模式执行:", err);
  }

  const activeRecord = chatId
    ? session.chats.find((c) => c.chatId === chatId)
    : undefined;
  const sessionLabel = activeRecord
    ? `${activeRecord.label} (${chatId!.slice(0, 8)})`
    : "独立执行";

  const initialCard = buildStatusCard({
    mode,
    prompt,
    workspaceLabel: getWorkspaceLabel(session.workDir),
    model: session.model,
    sessionLabel,
    status: "running",
    currentActivity: mode === "cloud" ? "正在提交到 Cloud Agent" : "正在启动",
  });

  const progressMsgId = await replyCard(client, messageId, initialCard);
  if (!progressMsgId) {
    const failed: ExecuteResult = {
      success: false,
      output: "发送进度消息失败，请重试。",
      isCloud: false,
    };
    await replyMessage(client, messageId, failed.output);
    return failed;
  }

  const updater = new CardProgressUpdater(client, messageId, progressMsgId, {
    workDir: session.workDir,
    mode,
    prompt,
    sessionLabel,
    model: session.model,
  });

  const result = await executeCursorStream(
    {
      prompt,
      mode,
      workDir: session.workDir,
      model: session.model,
      chatId,
    },
    {
      onProgress: (event) => updater.update(event),
      onModel: (model) => updater.setModel(model),
    },
    signal,
  );

  if (
    !result.success &&
    !result.cancelled &&
    chatId &&
    isResumeError(result.output)
  ) {
    if (signal.aborted) {
      await updater.finalize({
        ...result,
        cancelled: true,
        output: "任务已取消。",
      });
      return { ...result, cancelled: true, output: "任务已取消。" };
    }

    console.log(`[session] chatId ${chatId} 已失效，清除后重试`);
    session.chats = session.chats.filter((c) => c.chatId !== chatId);
    session.activeChatId = undefined;
    updater.update({ category: "other", detail: "会话已失效，正在重建后重试" });

    try {
      const newChatId = await ensureChatId(session);
      persistSession(session);
      const newRecord = session.chats.find((c) => c.chatId === newChatId);
      updater.setSessionLabel(
        `${newRecord?.label ?? "chat"} (${newChatId.slice(0, 8)})`,
      );
      const retry = await executeCursorStream(
        {
          prompt,
          mode,
          workDir: session.workDir,
          model: session.model,
          chatId: newChatId,
        },
        {
          onProgress: (event) => updater.update(event),
          onModel: (model) => updater.setModel(model),
        },
        signal,
      );
      await updater.finalize(retry);
      return retry;
    } catch {
      // fall through
    }
  }

  await updater.finalize(result);
  return result;
}

// ── 消息队列处理 ─────────────────────────────────────────
async function drainMessageQueue(
  session: UserSession,
  lastMessageId: string,
): Promise<void> {
  if (session.messageQueue.length === 0) return;

  const queued = session.messageQueue.splice(0);
  const mergedPrompt = queued.map((m) => m.text).join("\n");
  const replyTo = queued[queued.length - 1].messageId;
  const explicitMode = [...queued].reverse().find((m) => m.mode)?.mode;
  const mode = explicitMode ?? (config.cursor.defaultMode as CursorMode);

  console.log(
    `[queue] 合并 ${queued.length} 条排队消息，以 ${mode} 模式继续${explicitMode ? " (用户指定)" : ""}`,
  );
  await replyMessage(
    client,
    replyTo,
    `前序任务已完成，正在处理你排队的 ${queued.length} 条消息...`,
  );

  const task: TaskRecord = {
    mode,
    prompt: mergedPrompt,
    startedAt: Date.now(),
    originMessageId: replyTo,
    chatType: "p2p",
  };

  session.activeTask = task;
  try {
    await executeCursorCommand(replyTo, session, mode, mergedPrompt);
  } catch (err) {
    console.error("[queue] 队列消息执行失败:", err);
  } finally {
    session.activeTask = undefined;
  }

  await drainMessageQueue(session, replyTo);
}

// ── 工具执行 ─────────────────────────────────────────────

const MAX_OUTPUT_PER_CARD = 7500;

function splitOutputToCodeBlocks(output: string): string[] {
  if (output.length <= MAX_OUTPUT_PER_CARD) {
    return [`\`\`\`\n${output}\n\`\`\``];
  }

  const lines = output.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length + 1 > MAX_OUTPUT_PER_CARD && current.length > 0) {
      blocks.push(`\`\`\`\n${current.join("\n")}\n\`\`\``);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length > 0) {
    blocks.push(`\`\`\`\n${current.join("\n")}\n\`\`\``);
  }

  return blocks;
}

async function executeToolCommand(
  messageId: string,
  chatType: string,
  session: UserSession,
  query: string,
): Promise<void> {
  const tool = typeof query === "string" ? findTool(query) : undefined;
  if (!tool) {
    const tools = getToolList();
    const available =
      tools.length > 0
        ? "\n\n可用工具: " +
          tools.map((t, i) => `${i + 1}. ${t.name}`).join("、")
        : "\n\n尚未定义任何工具。";
    await replyMessage(
      client,
      messageId,
      `未找到工具 '${query}'。${available}`,
    );
    return;
  }

  const abortController = new AbortController();
  const task: TaskRecord = {
    mode: "agent",
    prompt: tool.description || tool.name,
    startedAt: Date.now(),
    originMessageId: messageId,
    chatType,
    toolName: tool.name,
    abortController,
  };

  session.activeTask = task;

  const initialCard = buildInfoCard(
    "工具执行中",
    `**工具**: ${tool.name}\n**描述**: ${tool.description || "无"}\n**脚本**: ${tool.id}/${tool.entry.split("/").pop()}\n\n正在执行...`,
    "indigo",
  );
  const cardMsgId = await replyCard(client, messageId, initialCard);

  try {
    const result = await executeTool(tool, abortController.signal);
    const dur = formatDurationMs(result.durationMs) ?? "未知";

    if (cardMsgId) {
      const finalCard = buildInfoCard(
        result.success ? "工具执行成功" : "工具执行失败",
        `**工具**: ${tool.name}\n**耗时**: ${dur}`,
        result.success ? "green" : "red",
      );
      await editCard(client, cardMsgId, finalCard).catch(console.error);
    }

    const outputText = result.output.trim();
    if (outputText) {
      const blocks = splitOutputToCodeBlocks(outputText);
      for (const block of blocks) {
        await replyMarkdownCard(client, messageId, block);
      }
    }

    if (!result.success) {
      console.error(
        `[tool] ${tool.name} 执行失败 (${dur}):`,
        result.output.slice(0, 200),
      );
    } else {
      console.log(`[tool] ${tool.name} 执行成功 (${dur})`);
    }
  } catch (err) {
    console.error(`[tool] ${tool.name} 执行异常:`, err);
    if (cardMsgId) {
      const errCard = buildInfoCard(
        "工具执行失败",
        `**工具**: ${tool.name}\n**错误**: ${err instanceof Error ? err.message : String(err)}`,
        "red",
      );
      await editCard(client, cardMsgId, errCard).catch(console.error);
    }
  } finally {
    session.activeTask = undefined;
  }
}

// ── 事件分发 ─────────────────────────────────────────────
async function handleMessage(data: {
  sender: { sender_id?: { open_id?: string }; sender_type?: string };
  message: {
    message_id: string;
    message_type: string;
    content: string;
    chat_id: string;
    chat_type: string;
    mentions?: Array<{ name: string }>;
  };
}) {
  const { message, sender } = data;

  if (message.chat_type === "group") {
    const mentioned = message.mentions && message.mentions.length > 0;
    if (!mentioned) return;
  }

  const userId = sender.sender_id?.open_id ?? "unknown";

  if (message.message_type === "image") {
    const session = getSession(userId, message.chat_id);
    const imageKey = extractImageKey(message.content);
    if (!imageKey) {
      await replyMessage(
        client,
        message.message_id,
        "图片消息解析失败，请重试。",
      );
      return;
    }
    try {
      const destDir = path.join(session.workDir, IMAGE_DIR_NAME);
      const filePath = await downloadMessageImage(
        client,
        message.message_id,
        imageKey,
        destDir,
      );
      session.inputBuffer.push({
        text: `[图片已保存: ${filePath}]`,
        messageId: message.message_id,
      });
      const count = session.inputBuffer.length;
      await replyMessage(
        client,
        message.message_id,
        count === 1
          ? `已接收图片。继续发送补充，或发 /plan 开始规划。`
          : `已接收图片 (共 ${count} 条暂存)`,
      );
    } catch (err) {
      console.error("[image] 下载图片失败:", err);
      await replyMessage(
        client,
        message.message_id,
        "图片下载失败，请重试或改为文字描述。",
      );
    }
    return;
  }

  if (message.message_type !== "text") {
    await replyMessage(
      client,
      message.message_id,
      "暂时只支持文本和图片消息，请发送文字指令或图片。",
    );
    return;
  }

  const text = extractTextFromContent(message.content);
  if (!text) return;
  if (isContentDuplicate(userId, text)) return;

  const session = getSession(userId, message.chat_id);
  const command = parseCommand(text);

  const cmdLabel =
    command.type === "cursor"
      ? `${command.type} (${command.mode})`
      : command.type;
  console.log(
    `[msg] ${message.message_id} | ${userId.slice(0, 10)}... | ${cmdLabel} | ${text.slice(0, 80)}`,
  );

  if (session.activeTask) {
    if (command.type === "tool-run") {
      await replyMessage(
        client,
        message.message_id,
        `当前正在执行 ${getTaskLabel(session.activeTask)} 任务，请等待完成后再操作，或先发送 /cancel 取消。`,
      );
      return;
    }
    if (command.type === "cursor" || command.type === "input") {
      const queueText =
        command.type === "cursor" ? command.prompt : command.text;
      const queueMode = command.type === "cursor" ? command.mode : undefined;
      session.messageQueue.push({
        text: queueText,
        messageId: message.message_id,
        mode: queueMode,
      });
      await replyMessage(
        client,
        message.message_id,
        `当前正在执行 ${getTaskLabel(session.activeTask)} 任务，你的消息已记录（队列中 ${session.messageQueue.length} 条），完成后会自动继续。`,
      );
      return;
    }
    if (isSessionMutable(command)) {
      await replyMessage(
        client,
        message.message_id,
        `当前有任务执行中，请等待完成后再操作，或先发送 /cancel 取消。`,
      );
      return;
    }
  }

  switch (command.type) {
    case "help": {
      await replyCard(
        client,
        message.message_id,
        buildInfoCard("使用帮助", HELP_TEXT),
      );
      break;
    }

    case "status": {
      const activeChat = session.activeChatId
        ? session.chats.find((c) => c.chatId === session.activeChatId)
        : undefined;
      const sessionLabel = activeChat
        ? `${activeChat.label} (${activeChat.chatId.slice(0, 8)})`
        : "无（执行任务时自动创建）";
      const workDirChatCount = session.chats.filter(
        (c) => c.workDir === session.workDir,
      ).length;
      let activeTaskInfo: string | undefined;
      if (session.activeTask) {
        activeTaskInfo = `${getTaskLabel(session.activeTask)} · ${summarizePrompt(session.activeTask.prompt)} · 已运行 ${formatElapsed(session.activeTask.startedAt)}`;
      }
      await replyCard(
        client,
        message.message_id,
        buildSessionCard({
          workspaceLabel: getWorkspaceLabel(session.workDir),
          model: session.model,
          sessionLabel,
          activeTaskInfo,
          bufferCount: session.inputBuffer.length,
          queueCount: session.messageQueue.length,
          chatCount: workDirChatCount,
        }),
      );
      break;
    }

    case "cancel": {
      if (session.activeTask) {
        session.activeTask.abortController?.abort();
        session.messageQueue = [];
        await replyMessage(
          client,
          message.message_id,
          "已取消当前任务，排队消息已清空。",
        );
      } else if (session.inputBuffer.length > 0) {
        const count = session.inputBuffer.length;
        clearBuffer(session);
        await replyMessage(
          client,
          message.message_id,
          `已清空 ${count} 条暂存消息。`,
        );
      } else {
        await replyMessage(
          client,
          message.message_id,
          "当前没有正在执行的任务，也没有暂存消息。",
        );
      }
      break;
    }

    case "chat-list": {
      const workDirChats = session.chats.filter(
        (c) => c.workDir === session.workDir,
      );
      if (workDirChats.length === 0) {
        await replyCard(
          client,
          message.message_id,
          buildInfoCard(
            "Chat 列表",
            "当前工作区暂无 chat，发送任务时会自动创建。",
          ),
        );
        break;
      }
      const lines: string[] = [
        `当前工作区共 **${workDirChats.length}** 个 chat\n`,
      ];
      workDirChats.forEach((c, i) => {
        const active = c.chatId === session.activeChatId ? " ← 当前" : "";
        lines.push(
          `**${i + 1}.** ${c.label} \`(${c.chatId.slice(0, 8)})\`${active}`,
        );
      });
      lines.push("", "发 `/chat <编号或标签>` 切换，`/chat new` 新建。");
      await replyCard(
        client,
        message.message_id,
        buildInfoCard("Chat 列表", lines.join("\n")),
      );
      break;
    }

    case "chat-new": {
      clearBuffer(session);
      session.activeChatId = undefined;
      session.messageQueue = [];
      if (command.label) {
        session.nextChatLabel = command.label;
      }
      persistSession(session);
      const labelHint = command.label ? `标签: ${command.label}\n` : "";
      await replyMessage(
        client,
        message.message_id,
        `已准备新 chat。\n${labelHint}工作区: ${getWorkspaceLabel(session.workDir)}\n下一条消息会开启新 chat。`,
      );
      break;
    }

    case "chat-switch": {
      const workDirChats = session.chats.filter(
        (c) => c.workDir === session.workDir,
      );
      const index = Number(command.target);
      let target: ChatRecord | undefined;
      if (
        Number.isInteger(index) &&
        index >= 1 &&
        index <= workDirChats.length
      ) {
        target = workDirChats[index - 1];
      }
      if (!target) {
        target = workDirChats.find((c) => c.label === command.target);
      }
      if (!target) {
        const available =
          workDirChats.length > 0
            ? "\n\n可用: " +
              workDirChats.map((c, i) => `${i + 1}. ${c.label}`).join("、")
            : "\n\n当前工作区暂无 chat。";
        await replyMessage(
          client,
          message.message_id,
          `未找到 chat '${command.target}'。${available}`,
        );
        break;
      }
      clearBuffer(session);
      session.activeChatId = target.chatId;
      session.messageQueue = [];
      persistSession(session);
      await replyMessage(
        client,
        message.message_id,
        `已切换到 chat: ${target.label} (${target.chatId.slice(0, 8)})`,
      );
      break;
    }

    case "ws": {
      await replyCard(
        client,
        message.message_id,
        buildInfoCard("可用工作区", renderWorkspaceList(session)),
      );
      break;
    }

    case "ws-switch": {
      let targetAlias: string | undefined;
      let targetDir: string | undefined;

      const index = Number(command.alias);
      if (Number.isInteger(index) && index >= 1) {
        const entries = [...workspaces.entries()];
        if (index <= entries.length) {
          [targetAlias, targetDir] = entries[index - 1];
        }
      }

      if (!targetDir) {
        targetAlias = command.alias.toLowerCase();
        targetDir = workspaces.get(targetAlias);
      }

      if (!targetAlias || !targetDir) {
        const available =
          workspaces.size > 0
            ? "\n\n可用工作区: " + [...workspaces.keys()].join(", ")
            : "\n\n尚未定义任何工作区，请在 workspaces.json 中添加。";
        await replyMessage(
          client,
          message.message_id,
          `工作区 '${command.alias}' 不存在。${available}`,
        );
        break;
      }
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        await replyMessage(
          client,
          message.message_id,
          `工作区 '${targetAlias}' 指向的目录不存在或不可用：${targetDir}`,
        );
        break;
      }
      clearBuffer(session);
      session.workDir = targetDir;
      session.activeChatId = undefined;
      session.messageQueue = [];
      persistSession(session);
      const existingChats = session.chats.filter(
        (c) => c.workDir === targetDir,
      ).length;
      const chatHint =
        existingChats > 0
          ? `该工作区已有 ${existingChats} 个 chat，发 \`/chat\` 查看并选择。`
          : "下一条消息会自动创建新 chat。";
      await replyMessage(
        client,
        message.message_id,
        `已切换到工作区 ${targetAlias}\n${chatHint}`,
      );
      break;
    }

    case "model": {
      session.model = command.model;
      persistSession(session);
      await replyMessage(
        client,
        message.message_id,
        `默认模型已切换为: ${command.model}`,
      );
      break;
    }

    case "reload": {
      const wsCount = reloadWorkspaces();
      const toolCount = reloadTools();
      await replyMessage(
        client,
        message.message_id,
        `已重新加载 ${wsCount} 个工作区，${toolCount} 个工具。`,
      );
      break;
    }

    case "chats-global": {
      const allKeys = new Set<string>([
        ...sessions.keys(),
        ...persistedStates.keys(),
      ]);

      if (allKeys.size === 0) {
        await replyCard(
          client,
          message.message_id,
          buildInfoCard("全局 Chat 概览", "当前无任何记录。"),
        );
        break;
      }

      interface SessionSummary {
        key: string;
        feishuChatId: string;
        workDir: string;
        model: string;
        allChats: ChatRecord[];
        activeChatId?: string;
        taskInfo: string;
        extra: string[];
      }

      const byUser = new Map<string, SessionSummary[]>();
      for (const key of allKeys) {
        const colonIdx = key.indexOf(":");
        const uid = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
        const fChatId = colonIdx >= 0 ? key.slice(colonIdx + 1) : "p2p";

        const s = sessions.get(key);
        const p = persistedStates.get(key);
        const workDir =
          s?.workDir ?? p?.workDir ?? config.cursor.defaultWorkDir;
        const model = s?.model ?? p?.model ?? "Cursor 默认";
        const allChats = s?.chats ?? p?.chats ?? [];
        const activeChatId = s?.activeChatId ?? p?.activeChatId;

        let taskInfo = "空闲";
        if (s?.activeTask) {
          taskInfo = `${getTaskLabel(s.activeTask)} · 已运行 ${formatElapsed(s.activeTask.startedAt)}`;
        }

        const extra: string[] = [];
        if (s?.inputBuffer.length) extra.push(`暂存 ${s.inputBuffer.length}`);
        if (s?.messageQueue.length) extra.push(`排队 ${s.messageQueue.length}`);

        const summary: SessionSummary = {
          key,
          feishuChatId: fChatId,
          workDir,
          model,
          allChats,
          activeChatId,
          taskInfo,
          extra,
        };
        const list = byUser.get(uid) ?? [];
        list.push(summary);
        byUser.set(uid, list);
      }

      const lines: string[] = [];
      let idx = 1;
      for (const [uid, summaries] of byUser) {
        lines.push(
          `**${idx}.** \`${uid.slice(0, 10)}…\` (${summaries.length} 个会话)`,
        );
        for (const sm of summaries) {
          const activeChat = sm.activeChatId
            ? sm.allChats.find((c) => c.chatId === sm.activeChatId)
            : undefined;
          const chatStatus = activeChat
            ? `${activeChat.label} (${activeChat.chatId.slice(0, 8)})`
            : "无活跃 chat";
          lines.push(
            `　飞书会话: \`${sm.feishuChatId.slice(0, 10)}…\``,
            `　工作区: ${getWorkspaceLabel(sm.workDir)} · 模型: ${sm.model}`,
            `　当前 Chat: ${chatStatus} · Chat 总数: ${sm.allChats.length}`,
            `　状态: ${sm.taskInfo}${sm.extra.length ? ` · ${sm.extra.join(" / ")}` : ""}`,
          );
        }
        lines.push("");
        idx++;
      }

      lines.unshift(
        `共 **${byUser.size}** 个用户，**${allKeys.size}** 个会话\n`,
      );
      await replyCard(
        client,
        message.message_id,
        buildInfoCard("全局 Chat 概览", lines.join("\n")),
      );
      break;
    }

    case "tool-list": {
      const tools = getToolList();
      if (tools.length === 0) {
        await replyCard(
          client,
          message.message_id,
          buildInfoCard(
            "可用工具",
            "尚未定义任何工具。\n请在 `tools/` 目录下添加工具后发 `/reload`。",
          ),
        );
        break;
      }
      const lines: string[] = [`共 **${tools.length}** 个工具\n`];
      tools.forEach((t, i) => {
        const desc = t.description ? ` — ${t.description}` : "";
        lines.push(`**${i + 1}.** ${t.name}${desc}`);
      });
      lines.push("", "发 `/tool` <编号或名称> 即可执行。");
      await replyCard(
        client,
        message.message_id,
        buildInfoCard("可用工具", lines.join("\n")),
      );
      break;
    }

    case "tool-run": {
      await executeToolCommand(
        message.message_id,
        message.chat_type,
        session,
        command.query,
      );
      break;
    }

    case "input": {
      const matchedTool = matchToolByAlias(command.text);
      if (matchedTool) {
        await executeToolCommand(
          message.message_id,
          message.chat_type,
          session,
          matchedTool.name,
        );
        break;
      }

      session.inputBuffer.push({
        text: command.text,
        messageId: message.message_id,
      });

      const count = session.inputBuffer.length;
      if (count === 1) {
        await replyMessage(
          client,
          message.message_id,
          `已记录。继续发送补充，或发 /plan 开始规划。`,
        );
      } else {
        await replyMessage(
          client,
          message.message_id,
          `已记录 (共 ${count} 条)`,
        );
      }
      break;
    }

    case "cursor": {
      const buffer = clearBuffer(session);
      const bufferText = mergeBufferText(buffer);
      let prompt = [bufferText, command.prompt].filter(Boolean).join("\n");

      if (command.mode === "agent" && !prompt) {
        if (!session.activeChatId) {
          await replyMessage(
            client,
            message.message_id,
            "请先发送任务描述，我会帮你规划方案，满意后再 /agent 执行。",
          );
          break;
        }
        prompt = "请执行上面讨论的方案";
      }

      if (!prompt) {
        await replyMessage(
          client,
          message.message_id,
          "请提供任务描述或问题。",
        );
        break;
      }

      const task: TaskRecord = {
        mode: command.mode,
        prompt,
        startedAt: Date.now(),
        originMessageId: message.message_id,
        chatType: message.chat_type,
      };

      session.activeTask = task;
      try {
        await executeCursorCommand(
          message.message_id,
          session,
          command.mode,
          prompt,
        );
      } catch (err) {
        console.error("[cursor] 执行异常:", err);
      } finally {
        session.activeTask = undefined;
      }

      await drainMessageQueue(session, message.message_id);
      break;
    }
  }
}

const eventDispatcher = new EventDispatcher({
  loggerLevel: 2,
}).register({
  "im.message.receive_v1": async (data) => {
    const eventId = (data as any)?.event_id;
    if (eventId && isDuplicate(eventId)) return;

    const { message } = data;
    if (isDuplicate(message.message_id)) return;

    handleMessage(data).catch((err) => {
      replyError(client, message.message_id, err).catch(console.error);
    });
  },
});

const wsClient = new WSClient({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: 2,
});

async function main() {
  console.log("正在连接飞书长连接服务...");
  console.log(`默认工作目录: ${config.cursor.defaultWorkDir}`);
  console.log(`Cursor CLI: ${config.cursor.bin}`);
  console.log(`已加载 ${workspaces.size} 个工作区`);
  const toolCount = loadTools();
  console.log(`已加载 ${toolCount} 个工具`);

  await wsClient.start({ eventDispatcher });
  console.log("飞书 Cursor 桥接服务已启动，等待消息...");
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
