import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  entry: string;
  dir: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  durationMs: number;
}

interface ToolJson {
  name?: string;
  description?: string;
  aliases?: string[];
  entry?: string;
}

const TOOLS_DIR = path.resolve(process.cwd(), "tools");

let tools: ToolDefinition[] = [];

function scanToolsDir(): ToolDefinition[] {
  if (!fs.existsSync(TOOLS_DIR) || !fs.statSync(TOOLS_DIR).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
  const result: ToolDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(TOOLS_DIR, entry.name);
    const jsonPath = path.join(dir, "tool.json");

    let meta: ToolJson = {};
    if (fs.existsSync(jsonPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ToolJson;
      } catch (err) {
        console.warn(`[tool] 解析 ${jsonPath} 失败:`, err);
      }
    }

    const entryFile = meta.entry ?? "deploy.sh";
    const entryPath = path.join(dir, entryFile);
    if (!fs.existsSync(entryPath)) {
      console.warn(`[tool] ${entry.name}: 入口脚本 ${entryFile} 不存在，跳过`);
      continue;
    }

    result.push({
      id: entry.name,
      name: meta.name ?? entry.name,
      description: meta.description ?? "",
      aliases: meta.aliases ?? [],
      entry: entryPath,
      dir,
    });
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function loadTools(): number {
  tools = scanToolsDir();
  console.log(`[tool] 已加载 ${tools.length} 个工具 (${TOOLS_DIR})`);
  return tools.length;
}

export function reloadTools(): number {
  tools = scanToolsDir();
  console.log(`[tool] 已重新加载 ${tools.length} 个工具`);
  return tools.length;
}

export function getToolList(): ToolDefinition[] {
  return tools;
}

export function findTool(query: string): ToolDefinition | undefined {
  const index = Number(query);
  if (Number.isInteger(index) && index >= 1 && index <= tools.length) {
    return tools[index - 1];
  }

  const lower = query.toLowerCase();

  const exactByName = tools.find((t) => t.name.toLowerCase() === lower);
  if (exactByName) return exactByName;

  const prefixByName = tools.find((t) => t.name.toLowerCase().startsWith(lower));
  if (prefixByName) return prefixByName;

  const exactById = tools.find((t) => t.id.toLowerCase() === lower);
  if (exactById) return exactById;

  const prefixById = tools.find((t) => t.id.toLowerCase().startsWith(lower));
  if (prefixById) return prefixById;

  return undefined;
}

export function matchToolByAlias(text: string): ToolDefinition | undefined {
  const trimmed = text.trim();
  for (const tool of tools) {
    for (const alias of tool.aliases) {
      if (alias === trimmed) return tool;
    }
  }
  return undefined;
}

export function executeTool(
  tool: ToolDefinition,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const chunks: string[] = [];

    const proc = spawn("bash", [tool.entry], {
      cwd: tool.dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const onAbort = () => {
      proc.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (data: Buffer) => {
      chunks.push(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      chunks.push(data.toString());
    });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({
        success: code === 0,
        output: chunks.join(""),
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({
        success: false,
        output: `执行失败: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}
