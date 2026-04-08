import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 清除代理环境变量，避免飞书 SDK WebSocket 连接被本地代理拦截
for (const key of [
  "http_proxy", "HTTP_PROXY",
  "https_proxy", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY",
]) {
  delete process.env[key];
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少必要的环境变量: ${key}`);
  }
  return value;
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

export const config = {
  feishu: {
    appId: requireEnv("FEISHU_APP_ID"),
    appSecret: requireEnv("FEISHU_APP_SECRET"),
  },
  cursor: {
    apiKey: process.env.CURSOR_API_KEY ?? "",
    defaultWorkDir: expandHome(process.env.DEFAULT_WORK_DIR ?? process.cwd()),
    /** agent -p 执行超时（毫秒），默认 5 分钟 */
    timeoutMs: Number(process.env.CURSOR_TIMEOUT_MS) || 5 * 60 * 1000,
    /** Cursor CLI 可执行文件名 */
    bin: process.env.CURSOR_BIN ?? "agent",
    /** 默认模型，不设则使用 Cursor CLI 默认 */
    defaultModel: process.env.DEFAULT_MODEL || undefined,
    /** 队列排空时使用的默认模式 */
    defaultMode: (process.env.DEFAULT_MODE as "agent" | "ask" | "plan" | "cloud" | undefined) ?? "plan",
  },
  /** 飞书单条文本消息的安全截断长度 */
  maxMessageLength: 4000,
};

function loadWorkspaces(): Map<string, string> {
  const file = path.resolve(process.cwd(), "workspaces.json");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [alias, dir] of Object.entries(obj)) {
      map.set(alias.toLowerCase(), expandHome(dir));
    }
    console.log(`[config] 已加载 ${map.size} 个工作区 (${file})`);
    return map;
  } catch {
    console.warn(`[config] 未找到或无法解析 workspaces.json，跳过工作区别名`);
    return new Map();
  }
}

export const workspaces = loadWorkspaces();

/** 重新加载 workspaces.json，原地更新 Map，返回加载数量 */
export function reloadWorkspaces(): number {
  const file = path.resolve(process.cwd(), "workspaces.json");
  workspaces.clear();
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [alias, dir] of Object.entries(obj)) {
      workspaces.set(alias.toLowerCase(), expandHome(dir));
    }
    console.log(`[config] 已重新加载 ${workspaces.size} 个工作区 (${file})`);
  } catch {
    console.warn(`[config] 重新加载失败，无法解析 workspaces.json`);
  }
  return workspaces.size;
}

/** 解析用户传入的路径，支持 ~ 展开 */
export function resolveWorkDir(input: string): string {
  const expanded = expandHome(input);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(config.cursor.defaultWorkDir, expanded);
}
