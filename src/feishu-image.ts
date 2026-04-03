import fs from "node:fs";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { withRetry } from "./feishu-reply.js";

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
};

function inferExt(contentType: string | undefined): string {
  if (!contentType) return ".png";
  const lower = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_EXT[lower] ?? ".png";
}

export const IMAGE_DIR_NAME = ".cursor-images";

/** 下载飞书消息中的图片并保存到本地，返回绝对路径 */
export async function downloadMessageImage(
  client: Client,
  messageId: string,
  imageKey: string,
  destDir: string,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });

  const resp = await withRetry(() =>
    client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    }),
  );

  const ext = inferExt(resp.headers?.["content-type"]);
  const shortKey = imageKey.slice(-8);
  const fileName = `${Date.now()}-${shortKey}${ext}`;
  const filePath = path.join(destDir, fileName);

  await resp.writeFile(filePath);
  console.log(`[image] 已保存: ${filePath}`);
  return filePath;
}

/** 从飞书图片消息的 content JSON 中提取 image_key */
export function extractImageKey(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { image_key?: string };
    return parsed.image_key;
  } catch {
    return undefined;
  }
}
