import type { Client, InteractiveCard } from "@larksuiteoapi/node-sdk";
import { getModeLabel, type CursorMode } from "./command-parser.js";
import { replyMessage, withRetry } from "./feishu-reply.js";

// ── Helpers ──────────────────────────────────────────────

function plainText(content: string, lines = 2) {
  return { tag: "plain_text" as const, content, lines };
}

function summarizePrompt(prompt: string, maxLen = 160): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1) + "…";
}

// ── Status Card ──────────────────────────────────────────

type CardStatus = "queued" | "running" | "submitted" | "success" | "error" | "cancelled";

export interface StatusCardOptions {
  mode: CursorMode;
  prompt: string;
  workspaceLabel: string;
  model?: string;
  sessionLabel?: string;
  status: CardStatus;
  currentActivity?: string;
  elapsedText?: string;
  summary?: string;
  note?: string;
}

function getStatusMeta(status: CardStatus) {
  switch (status) {
    case "queued":
      return { title: "任务排队中", template: "blue" as const };
    case "running":
      return { title: "任务执行中", template: "indigo" as const };
    case "submitted":
      return { title: "Cloud 任务已提交", template: "green" as const };
    case "success":
      return { title: "任务已完成", template: "green" as const };
    case "error":
      return { title: "任务失败", template: "red" as const };
    case "cancelled":
      return { title: "任务已取消", template: "orange" as const };
  }
}

export function buildStatusCard(options: StatusCardOptions): InteractiveCard {
  const meta = getStatusMeta(options.status);

  const fields: Array<{ is_short: boolean; text: ReturnType<typeof plainText> }> = [
    { is_short: true, text: plainText(`模式: ${getModeLabel(options.mode)}`) },
    { is_short: true, text: plainText(`工作区: ${options.workspaceLabel}`) },
    { is_short: true, text: plainText(`模型: ${options.model ?? "Cursor 默认"}`) },
  ];

  if (options.sessionLabel) {
    fields.push({ is_short: true, text: plainText(`会话: ${options.sessionLabel}`) });
  }

  fields.push({
    is_short: true,
    text: plainText(`状态: ${options.currentActivity ?? meta.title}`),
  });

  const elements: unknown[] = [
    {
      tag: "div",
      text: plainText(summarizePrompt(options.prompt, 220), 4),
      fields,
    },
  ];

  const mdParts = [
    options.elapsedText ? `用时: ${options.elapsedText}` : "",
    options.summary ? `轨迹: ${options.summary}` : "",
    options.note ?? "",
  ].filter(Boolean);

  if (mdParts.length > 0) {
    elements.push({ tag: "markdown", content: mdParts.join("\n") });
  }

  return {
    config: { wide_screen_mode: true, enable_forward: false, update_multi: true },
    header: { template: meta.template, title: plainText(meta.title, 1) },
    elements: elements as InteractiveCard["elements"],
  };
}

// ── Info Card (带标题的 Markdown 卡片) ───────────────────

export function buildInfoCard(
  title: string,
  markdown: string,
  template = "blue",
): InteractiveCard {
  return {
    config: { wide_screen_mode: true },
    header: { template: template as never, title: plainText(title, 1) },
    elements: [{ tag: "markdown", content: markdown }],
  };
}

// ── Info Card with Actions (带按钮的 Markdown 卡片) ─────

export interface CardButtonAction {
  text: string;
  type?: "default" | "primary" | "danger";
  value: Record<string, unknown>;
}

export function buildInfoCardWithActions(
  title: string,
  markdown: string,
  actions: CardButtonAction[],
  template = "blue",
): InteractiveCard {
  const elements: unknown[] = [
    { tag: "markdown", content: markdown },
  ];

  if (actions.length > 0) {
    elements.push({
      tag: "action",
      actions: actions.map((a) => ({
        tag: "button",
        text: plainText(a.text, 1),
        type: a.type ?? "primary",
        value: a.value,
      })),
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: template as never, title: plainText(title, 1) },
    elements: elements as InteractiveCard["elements"],
  };
}

// ── Session Card (/status) ──────────────────────────────

export interface SessionCardOptions {
  workspaceLabel: string;
  model?: string;
  sessionLabel: string;
  activeTaskInfo?: string;
  bufferCount?: number;
  queueCount?: number;
  chatCount?: number;
}

export function buildSessionCard(options: SessionCardOptions): InteractiveCard {
  const mdLines: string[] = [
    `**工作区**: ${options.workspaceLabel}`,
    `**模型**: ${options.model ?? "Cursor 默认"}`,
    `**当前 Chat**: ${options.sessionLabel}`,
    `**Chat 总数**: ${options.chatCount ?? 0}`,
    `**运行中**: ${options.activeTaskInfo ?? "无"}`,
  ];

  if (options.bufferCount && options.bufferCount > 0) {
    mdLines.push(`**暂存消息**: ${options.bufferCount} 条`);
  }
  if (options.queueCount && options.queueCount > 0) {
    mdLines.push(`**排队消息**: ${options.queueCount} 条`);
  }

  mdLines.push("", "发 `/chat` 查看所有 chat，`/chat new` 新建。");

  return {
    config: { wide_screen_mode: true },
    header: { template: "turquoise" as never, title: plainText("当前状态", 1) },
    elements: [{ tag: "markdown", content: mdLines.join("\n") }],
  };
}

// ── Reply Card ───────────────────────────────────────────

export async function replyCard(
  client: Client,
  messageId: string,
  card: InteractiveCard,
): Promise<string | undefined> {
  const resp = await withRetry(() =>
    client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card), msg_type: "interactive" },
    }),
  );
  return resp.data?.message_id;
}

// ── Markdown Card ────────────────────────────────────────

const MAX_CARD_CONTENT = 8000;

function buildMarkdownCard(content: string): InteractiveCard {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: "markdown", content }],
  };
}

function splitMarkdown(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return parts;
}

/** 以 Markdown 卡片回复消息。失败时自动回退为纯文本。返回第一条回复的 message_id。 */
export async function replyMarkdownCard(
  client: Client,
  messageId: string,
  markdown: string,
): Promise<string | undefined> {
  try {
    const parts = splitMarkdown(markdown, MAX_CARD_CONTENT);
    let firstId: string | undefined;
    for (const part of parts) {
      const id = await replyCard(client, messageId, buildMarkdownCard(part));
      if (!firstId) firstId = id;
    }
    return firstId;
  } catch (err) {
    console.warn("[card] Markdown 卡片发送失败，回退纯文本:", err);
    return replyMessage(client, messageId, markdown);
  }
}
