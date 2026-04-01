import type { Client, InteractiveCard } from "@larksuiteoapi/node-sdk";
import { config } from "./config.js";
import { getModeLabel, type CursorMode } from "./command-parser.js";
import { replyMessage } from "./feishu-reply.js";

interface StatusCardOptions {
  mode: CursorMode;
  prompt: string;
  workspaceLabel: string;
  model?: string;
  requesterName?: string;
  status: "queued" | "running" | "submitted" | "success" | "error";
  currentActivity?: string;
  elapsedText?: string;
  summary?: string;
  note?: string;
}

const FEISHU_OPEN_API = "https://open.feishu.cn";

let tenantTokenCache:
  | {
      token: string;
      expiresAt: number;
    }
  | undefined;

function plainText(content: string, lines = 2) {
  return { tag: "plain_text" as const, content, lines };
}

function summarizePrompt(prompt: string, maxLen = 160): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1) + "…";
}

function getStatusMeta(status: StatusCardOptions["status"]) {
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
  }
}

async function getTenantAccessToken(): Promise<string> {
  if (tenantTokenCache && tenantTokenCache.expiresAt > Date.now()) {
    return tenantTokenCache.token;
  }

  const resp = await fetch(`${FEISHU_OPEN_API}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  if (!resp.ok) {
    throw new Error(`获取 tenant_access_token 失败: HTTP ${resp.status}`);
  }

  const json = await resp.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (json.code !== 0 || !json.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: ${json.msg ?? "unknown error"}`);
  }

  const expiresInSec = json.expire ?? 7200;
  tenantTokenCache = {
    token: json.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, expiresInSec - 120) * 1000,
  };
  return tenantTokenCache.token;
}

async function feishuOpenApi<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getTenantAccessToken();
  const resp = await fetch(`${FEISHU_OPEN_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const json = await resp.json() as {
    code?: number;
    msg?: string;
    data?: T;
  };

  if (!resp.ok || json.code !== 0) {
    throw new Error(`飞书接口调用失败: ${json.msg ?? `HTTP ${resp.status}`}`);
  }

  return (json.data ?? {}) as T;
}

export async function sendEphemeralCard(
  chatId: string,
  openId: string,
  card: InteractiveCard
): Promise<string | undefined> {
  const data = await feishuOpenApi<{ message_id?: string }>("/open-apis/ephemeral/v1/send", {
    method: "POST",
    body: JSON.stringify({
      chat_id: chatId,
      open_id: openId,
      msg_type: "interactive",
      card,
    }),
  });
  return data.message_id;
}

export async function updateCardMessage(messageId: string, card: InteractiveCard): Promise<void> {
  await feishuOpenApi(`/open-apis/im/v1/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      content: JSON.stringify(card),
    }),
  });
}

export async function replyCard(
  client: Client,
  messageId: string,
  card: InteractiveCard
): Promise<string | undefined> {
  const resp = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify(card),
      msg_type: "interactive",
    },
  });
  return resp.data?.message_id;
}

export function buildStatusCard(options: StatusCardOptions): InteractiveCard {
  const meta = getStatusMeta(options.status);
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true,
    },
    header: {
      template: meta.template,
      title: plainText(meta.title, 1),
    },
    elements: [
      {
        tag: "div",
        text: plainText(summarizePrompt(options.prompt, 220), 4),
        fields: [
          {
            is_short: true,
            text: plainText(`模式: ${getModeLabel(options.mode)}`, 2),
          },
          {
            is_short: true,
            text: plainText(`工作区: ${options.workspaceLabel}`, 2),
          },
          {
            is_short: true,
            text: plainText(`模型: ${options.model ?? "Cursor 默认"}`, 2),
          },
          {
            is_short: true,
            text: plainText(`状态: ${options.currentActivity ?? meta.title}`, 2),
          },
        ],
      },
      {
        tag: "markdown",
        content: [
          options.requesterName ? `发起人: ${options.requesterName}` : "",
          options.elapsedText ? `用时: ${options.elapsedText}` : "",
          options.summary ? `轨迹: ${options.summary}` : "",
          options.note ?? "",
        ].filter(Boolean).join("\n"),
      },
    ],
  };
}

// ── Markdown 卡片 ────────────────────────────────────────

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
