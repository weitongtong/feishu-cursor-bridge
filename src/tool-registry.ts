import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { expandHome } from "./config.js";

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

interface ToolsJsonEntry {
  name?: string;
  description?: string;
  aliases?: string[];
  entry?: string;
  dir: string;
}

const TOOLS_JSON = path.resolve(process.cwd(), "tools.json");

let tools: ToolDefinition[] = [];

function loadToolsFromJson(): ToolDefinition[] {
  if (!fs.existsSync(TOOLS_JSON)) {
    return [];
  }

  let obj: Record<string, ToolsJsonEntry>;
  try {
    const raw = fs.readFileSync(TOOLS_JSON, "utf-8");
    obj = JSON.parse(raw) as Record<string, ToolsJsonEntry>;
  } catch (err) {
    console.warn(`[tool] 解析 ${TOOLS_JSON} 失败:`, err);
    return [];
  }

  const result: ToolDefinition[] = [];

  for (const [id, meta] of Object.entries(obj)) {
    if (!meta.dir) {
      console.warn(`[tool] ${id}: 缺少 dir 字段，跳过`);
      continue;
    }

    const dir = expandHome(meta.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.warn(`[tool] ${id}: 目录 ${dir} 不存在，跳过`);
      continue;
    }

    const entryFile = meta.entry ?? "index.sh";
    const entryPath = path.join(dir, entryFile);
    if (!fs.existsSync(entryPath)) {
      console.warn(`[tool] ${id}: 入口脚本 ${entryFile} 不存在，跳过`);
      continue;
    }

    result.push({
      id,
      name: meta.name ?? id,
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
  tools = loadToolsFromJson();
  console.log(`[tool] 已加载 ${tools.length} 个工具 (${TOOLS_JSON})`);
  return tools.length;
}

export function reloadTools(): number {
  tools = loadToolsFromJson();
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

function getSpawnArgs(entry: string): [string, string[]] {
  const ext = path.extname(entry).toLowerCase();
  switch (ext) {
    case ".ps1":
      return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", entry]];
    case ".js":
      return ["node", [entry]];
    default:
      return ["bash", [entry]];
  }
}

export function executeTool(
  tool: ToolDefinition,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const chunks: string[] = [];

    const [cmd, args] = getSpawnArgs(tool.entry);
    console.log(`[tool] spawn: ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args, {
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
