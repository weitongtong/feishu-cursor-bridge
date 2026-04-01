import type { Client } from "@larksuiteoapi/node-sdk";
import { config } from "./config.js";

/** 将文本按最大长度拆分，尽量在换行处断开 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      splitAt = maxLen;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return parts;
}

function buildTextContent(text: string): string {
  return JSON.stringify({ text });
}

/** 回复一条消息，返回回复的 message_id */
async function sendReply(
  client: Client,
  messageId: string,
  text: string
): Promise<string | undefined> {
  const resp = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: buildTextContent(text),
      msg_type: "text",
    },
  });
  return resp.data?.message_id;
}

/** 回复消息，自动处理超长文本分段。返回第一条回复的 message_id */
export async function replyMessage(
  client: Client,
  messageId: string,
  text: string
): Promise<string | undefined> {
  const parts = splitText(text, config.maxMessageLength);

  if (parts.length === 1) {
    return sendReply(client, messageId, parts[0]);
  }

  let firstId: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const header = `[${i + 1}/${parts.length}]\n`;
    const id = await sendReply(client, messageId, header + parts[i]);
    if (i === 0) firstId = id;
  }
  return firstId;
}

/** 编辑已发送的文本消息（飞书 PUT API，每条消息最多编辑 20 次） */
export async function editMessage(
  client: Client,
  messageId: string,
  text: string
): Promise<void> {
  const truncated =
    text.length > config.maxMessageLength
      ? text.slice(0, config.maxMessageLength - 20) + "\n\n...(内容过长已截断)"
      : text;

  await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: "text",
      content: buildTextContent(truncated),
    },
  });
}

/** 回复错误信息 */
export async function replyError(
  client: Client,
  messageId: string,
  error: unknown
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await sendReply(client, messageId, `出错了: ${msg}`);
}
