import fs from "node:fs";
import {
  Client,
  EventDispatcher,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { config, workspaces } from "./config.js";
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
  replyCard,
  updateCardMessage,
  replyMarkdownCard,
} from "./feishu-card.js";
import { replyMessage, replyError, editMessage } from "./feishu-reply.js";
import { loadUserStates, saveUserState, type PersistedState } from "./user-state.js";

const client = new Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
});

// ── 消息去重 ──────────────────────────────────────────────
const handledMessages = new Set<string>();

function isDuplicate(messageId: string): boolean {
  if (handledMessages.has(messageId)) return true;
  handledMessages.add(messageId);
  setTimeout(() => handledMessages.delete(messageId), 10 * 60 * 1000);
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
}

interface QueuedMessage {
  text: string;
  messageId: string;
}

interface UserSession {
  workDir: string;
  model?: string;
  chatId?: string;
  activeTask?: TaskRecord;
  messageQueue: QueuedMessage[];
}

const sessions = new Map<string, UserSession>();
const persistedStates = loadUserStates();

function getSession(userId: string): UserSession {
  let session = sessions.get(userId);
  if (!session) {
    const persisted = persistedStates.get(userId);
    let workDir = persisted?.workDir ?? config.cursor.defaultWorkDir;
    if (persisted?.workDir && (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory())) {
      console.warn(`[state] 用户 ${userId.slice(0, 10)}... 的工作区 ${workDir} 已不存在，回退到默认`);
      workDir = config.cursor.defaultWorkDir;
    }
    session = {
      workDir,
      model: persisted?.model ?? config.cursor.defaultModel,
      chatId: persisted?.chatId,
      messageQueue: [],
    };
    sessions.set(userId, session);
  }
  return session;
}

function persistSession(userId: string, session: UserSession): void {
  const state: PersistedState = {
    workDir: session.workDir,
    model: session.model,
    chatId: session.chatId,
  };
  saveUserState(userId, state);
}

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

function renderStatus(session: UserSession): string {
  const lines = [
    "当前状态",
    "",
    `工作区: ${getWorkspaceLabel(session.workDir)}`,
    `模型: ${session.model ?? "Cursor 默认"}`,
    `会话: ${session.chatId ? `已连接 (${session.chatId.slice(0, 8)})` : "未建立"}`,
  ];

  if (session.activeTask) {
    lines.push(
      `运行中: ${getModeLabel(session.activeTask.mode)} · ${summarizePrompt(session.activeTask.prompt)} · 已运行 ${formatElapsed(session.activeTask.startedAt)}`
    );
  } else {
    lines.push("运行中: 无");
  }

  if (session.messageQueue.length > 0) {
    lines.push(`排队消息: ${session.messageQueue.length} 条`);
  }

  lines.push("");
  lines.push("推荐流程: 发送任务 → 查看方案 → /run 执行");
  return lines.join("\n");
}

function renderWorkspaceList(session: UserSession): string {
  if (workspaces.size === 0) {
    return "尚未定义任何工作区。\n请在 workspaces.json 中配置别名后重启服务。";
  }

  const lines = ["可用工作区", ""];
  let idx = 1;
  for (const [alias, dir] of workspaces) {
    const suffix = session.workDir === dir ? " (当前)" : "";
    lines.push(`${idx}. ${alias}${suffix}`);
    idx++;
  }
  lines.push("");
  lines.push("发送 /ws <编号或别名> 即可切换。");
  return lines.join("\n");
}

function renderSummary(counts: { read: number; write: number; command: number; search: number; other: number }): string {
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read}`);
  if (counts.write) parts.push(`编辑 ${counts.write}`);
  if (counts.command) parts.push(`命令 ${counts.command}`);
  if (counts.search) parts.push(`搜索 ${counts.search}`);
  if (counts.other) parts.push(`其他 ${counts.other}`);
  return parts.join(" · ");
}

function isSessionMutable(command: Command): boolean {
  return command.type === "new"
    || command.type === "ws-switch"
    || command.type === "model";
}

// ── 实时状态面板 ─────────────────────────────────────────
const THROTTLE_MS = 15_000;
const MAX_EDITS_PER_MSG = 18;

class TextProgressUpdater {
  private originMessageId: string;
  private currentMessageId: string;
  private workDir: string;
  private mode: CursorMode;
  private prompt: string;
  private sessionLabel: string;
  private model?: string;
  private startTime = Date.now();
  private currentActivity = "准备中";
  private counts = { read: 0, write: 0, command: 0, search: 0, other: 0 };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastEditTime = 0;
  private editCount = 0;

  constructor(
    originMessageId: string,
    progressMessageId: string,
    options: { workDir: string; mode: CursorMode; prompt: string; sessionLabel: string; model?: string }
  ) {
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
      const newId = await replyMessage(client, this.originMessageId, this.renderRunning());
      if (newId) {
        this.currentMessageId = newId;
        this.editCount = 0;
      }
      return;
    }
    this.editCount++;
    this.lastEditTime = Date.now();
    await editMessage(client, this.currentMessageId, this.renderRunning()).catch(console.error);
  }

  private renderRunning(): string {
    const lines = [
      "任务执行中",
      "",
      `模式: ${getModeLabel(this.mode)}`,
      `工作区: ${getWorkspaceLabel(this.workDir)}`,
      `会话: ${this.sessionLabel}`,
      `模型: ${this.model ?? "Cursor 默认"}`,
      `任务: ${summarizePrompt(this.prompt, 120)}`,
      "",
      `状态: ${this.currentActivity}`,
      `用时: ${formatElapsed(this.startTime)}`,
    ];

    const summary = renderSummary(this.counts);
    if (summary) {
      lines.push(`轨迹: ${summary}`);
    }
    return lines.join("\n");
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

    const dur = formatDurationMs(result.durationMs) ?? formatElapsed(this.startTime);
    const summary = renderSummary(this.counts);
    const status = result.cancelled
      ? `任务已取消 (耗时 ${dur})`
      : result.success
        ? result.isCloud ? `任务已提交 (耗时 ${dur})` : `任务已完成 (耗时 ${dur})`
        : `任务失败 (耗时 ${dur})`;

    const lines = [
      status,
      "",
      `模式: ${getModeLabel(this.mode)}`,
      `工作区: ${getWorkspaceLabel(this.workDir)}`,
      `会话: ${this.sessionLabel}`,
      `模型: ${this.model ?? "Cursor 默认"}`,
      `任务: ${summarizePrompt(this.prompt, 120)}`,
    ];

    if (summary) {
      lines.push(`轨迹: ${summary}`);
    }

    await editMessage(client, this.currentMessageId, lines.join("\n")).catch(console.error);

    if (result.output && !result.cancelled) {
      let output = result.output;
      if (this.mode === "agent" && result.success && !result.isCloud) {
        output += "\n\n---\n继续发消息可在同一会话中追加需求，或发 /new 开始新任务。";
      }
      await replyMarkdownCard(client, this.originMessageId, output);
    }
  }
}

// ── Cursor 指令处理 ──────────────────────────────────────
async function ensureChatId(session: UserSession): Promise<string> {
  if (session.chatId) return session.chatId;

  const chatId = await createChat(session.workDir);
  session.chatId = chatId;
  return chatId;
}

function isResumeError(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes("chat not found")
    || lower.includes("invalid chat")
    || lower.includes("no such chat")
    || lower.includes("resume")
    || lower.includes("does not exist");
}

async function executeCursorCommand(
  messageId: string,
  userId: string,
  session: UserSession,
  mode: CursorMode,
  prompt: string
): Promise<ExecuteResult> {
  const abortController = new AbortController();
  if (session.activeTask) {
    session.activeTask.abortController = abortController;
  }
  const { signal } = abortController;

  let chatId: string | undefined;
  try {
    chatId = await ensureChatId(session);
    persistSession(userId, session);
  } catch (err) {
    console.error("[session] 创建会话失败，将以无上下文模式执行:", err);
  }

  const sessionLabel = chatId ? `已连接 (${chatId.slice(0, 8)})` : "独立执行";
  const intro = [
    "任务已接收",
    "",
    `模式: ${getModeLabel(mode)}`,
    `工作区: ${getWorkspaceLabel(session.workDir)}`,
    `会话: ${sessionLabel}`,
    `模型: ${session.model ?? "Cursor 默认"}`,
    `任务: ${summarizePrompt(prompt, 120)}`,
    "",
    mode === "cloud" ? "状态: 正在提交到 Cloud Agent" : "状态: 正在启动",
  ].join("\n");

  const progressMsgId = await replyMessage(client, messageId, intro);
  if (!progressMsgId) {
    const failed: ExecuteResult = {
      success: false,
      output: "发送进度消息失败，请重试。",
      isCloud: false,
    };
    await replyMessage(client, messageId, failed.output);
    return failed;
  }

  const updater = new TextProgressUpdater(messageId, progressMsgId, {
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

  if (!result.success && !result.cancelled && chatId && isResumeError(result.output)) {
    if (signal.aborted) {
      await updater.finalize({ ...result, cancelled: true, output: "任务已取消。" });
      return { ...result, cancelled: true, output: "任务已取消。" };
    }

    console.log(`[session] chatId ${chatId} 已失效，清除后重试`);
    session.chatId = undefined;
    updater.update({ category: "other", detail: "会话已失效，正在重建后重试" });

    try {
      const newChatId = await ensureChatId(session);
      persistSession(userId, session);
      updater.setSessionLabel(`已连接 (${newChatId.slice(0, 8)})`);
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
  userId: string,
  session: UserSession,
  lastMessageId: string
): Promise<void> {
  if (session.messageQueue.length === 0) return;

  const queued = session.messageQueue.splice(0);
  const mergedPrompt = queued.map((m) => m.text).join("\n");
  const replyTo = queued[queued.length - 1].messageId;

  console.log(`[queue] 合并 ${queued.length} 条排队消息，以 plan 模式继续`);
  await replyMessage(client, replyTo, `前序任务已完成，正在处理你排队的 ${queued.length} 条消息...`);

  const task: TaskRecord = {
    mode: "plan",
    prompt: mergedPrompt,
    startedAt: Date.now(),
    originMessageId: replyTo,
    chatType: "p2p",
  };

  session.activeTask = task;
  try {
    await executeCursorCommand(replyTo, userId, session, "plan", mergedPrompt);
  } catch (err) {
    console.error("[queue] 队列消息执行失败:", err);
  } finally {
    session.activeTask = undefined;
  }

  await drainMessageQueue(userId, session, replyTo);
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

  if (message.message_type !== "text") {
    await replyMessage(
      client,
      message.message_id,
      "暂时只支持文本消息，请发送文字指令。"
    );
    return;
  }

  const text = extractTextFromContent(message.content);
  if (!text) return;

  const userId = sender.sender_id?.open_id ?? "unknown";
  const session = getSession(userId);
  const command = parseCommand(text);

  const cmdLabel = command.type === "cursor" ? `${command.type} (${command.mode})` : command.type;
  console.log(`[msg] ${userId.slice(0, 10)}... | ${cmdLabel} | ${text.slice(0, 80)}`);

  if (session.activeTask) {
    if (command.type === "cursor") {
      session.messageQueue.push({ text: command.prompt, messageId: message.message_id });
      await replyMessage(
        client,
        message.message_id,
        `当前正在执行 ${getModeLabel(session.activeTask.mode)} 任务，你的消息已记录（队列中 ${session.messageQueue.length} 条），完成后会自动继续。`
      );
      return;
    }
    if (isSessionMutable(command)) {
      await replyMessage(
        client,
        message.message_id,
        `当前有任务执行中，请等待完成后再操作，或先发送 /cancel 取消。`
      );
      return;
    }
  }

  switch (command.type) {
    case "help": {
      await replyMessage(client, message.message_id, HELP_TEXT);
      break;
    }

    case "status": {
      await replyMessage(client, message.message_id, renderStatus(session));
      break;
    }

    case "cancel": {
      if (!session.activeTask) {
        await replyMessage(client, message.message_id, "当前没有正在执行的任务。");
        break;
      }
      session.activeTask.abortController?.abort();
      session.messageQueue = [];
      await replyMessage(client, message.message_id, "已取消当前任务，排队消息已清空。");
      break;
    }

    case "new": {
      session.chatId = undefined;
      session.messageQueue = [];
      persistSession(userId, session);
      await replyMessage(
        client,
        message.message_id,
        `已清除会话。\n工作区: ${getWorkspaceLabel(session.workDir)}\n下一条消息会开启新会话。`
      );
      break;
    }

    case "ws": {
      await replyMessage(client, message.message_id, renderWorkspaceList(session));
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
        const available = workspaces.size > 0
          ? "\n\n可用工作区: " + [...workspaces.keys()].join(", ")
          : "\n\n尚未定义任何工作区，请在 workspaces.json 中添加。";
        await replyMessage(client, message.message_id, `工作区 '${command.alias}' 不存在。${available}`);
        break;
      }
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        await replyMessage(client, message.message_id, `工作区 '${targetAlias}' 指向的目录不存在或不可用：${targetDir}`);
        break;
      }
      session.workDir = targetDir;
      session.chatId = undefined;
      session.messageQueue = [];
      persistSession(userId, session);
      await replyMessage(
        client,
        message.message_id,
        `已切换到工作区 ${targetAlias}\n会话已重置，下一条消息会开启新会话。`
      );
      break;
    }

    case "model": {
      session.model = command.model;
      persistSession(userId, session);
      await replyMessage(
        client,
        message.message_id,
        `默认模型已切换为: ${command.model}`
      );
      break;
    }

    case "cursor": {
      let prompt = command.prompt;

      if (command.mode === "agent" && !prompt) {
        if (!session.chatId) {
          await replyMessage(
            client,
            message.message_id,
            "请先发送任务描述，我会帮你规划方案，满意后再 /run 执行。"
          );
          break;
        }
        prompt = "请执行上面讨论的方案";
      }

      if (!prompt) {
        await replyMessage(
          client,
          message.message_id,
          "请提供任务描述或问题。"
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
        await executeCursorCommand(message.message_id, userId, session, command.mode, prompt);
      } catch (err) {
        console.error("[cursor] 执行异常:", err);
      } finally {
        session.activeTask = undefined;
      }

      await drainMessageQueue(userId, session, message.message_id);
      break;
    }
  }
}

const eventDispatcher = new EventDispatcher({
  loggerLevel: 2,
}).register({
  "im.message.receive_v1": async (data) => {
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

  await wsClient.start({ eventDispatcher });
  console.log("飞书 Cursor 桥接服务已启动，等待消息...");
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
