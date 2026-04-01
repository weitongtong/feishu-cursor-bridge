import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { config } from "./config.js";
import type { CursorMode } from "./command-parser.js";

export interface ExecuteOptions {
  prompt: string;
  mode: CursorMode;
  workDir: string;
  model?: string;
  chatId?: string;
}

export interface ExecuteResult {
  success: boolean;
  output: string;
  isCloud: boolean;
  durationMs?: number;
  cancelled?: boolean;
}

export interface ProgressEvent {
  category: "read" | "write" | "command" | "search" | "other";
  detail: string;
}

export interface StreamCallbacks {
  onProgress: (event: ProgressEvent) => void;
  onModel?: (model: string) => void;
}

function shortenPath(fullPath: string, workDir: string): string {
  if (fullPath.startsWith(workDir)) {
    const rel = fullPath.slice(workDir.length).replace(/^\//, "");
    return rel || path.basename(workDir);
  }
  return path.basename(fullPath);
}

function extractToolPath(tc: Record<string, unknown>, toolKey: string, workDir: string): string {
  const tool = tc[toolKey] as Record<string, unknown> | undefined;
  const p = (tool?.args as Record<string, unknown>)?.path as string | undefined;
  return p ? shortenPath(p, workDir) : "";
}

/** 从 stream-json tool_call.started 事件提取结构化进度 */
function describeStreamEvent(event: Record<string, unknown>, workDir: string): ProgressEvent | null {
  const type = event.type as string | undefined;
  const subtype = event.subtype as string | undefined;

  if (type !== "tool_call" || subtype !== "started") return null;

  const tc = event.tool_call as Record<string, unknown> | undefined;
  if (!tc) return null;

  if (tc.readToolCall) {
    const name = extractToolPath(tc, "readToolCall", workDir);
    return { category: "read", detail: name ? `读取 ${name}` : "读取文件" };
  }
  if (tc.globToolCall) {
    return { category: "read", detail: "查找文件" };
  }
  if (tc.writeToolCall) {
    const name = extractToolPath(tc, "writeToolCall", workDir);
    return { category: "write", detail: name ? `编辑 ${name}` : "写入文件" };
  }
  if (tc.shellToolCall) {
    const s = tc.shellToolCall as Record<string, unknown>;
    const cmd = (s.args as Record<string, unknown>)?.command as string | undefined;
    return { category: "command", detail: cmd ? `命令: ${cmd.slice(0, 60)}` : "执行命令" };
  }
  if (tc.searchToolCall) {
    return { category: "search", detail: "搜索代码" };
  }

  const toolKey = Object.keys(tc).find((k) => k.endsWith("ToolCall"));
  const label = toolKey ? toolKey.replace(/ToolCall$/, "") : "工具";
  return { category: "other", detail: label };
}

const PLAN_PROMPT_PREFIX =
  "请以规划模式回复：分析需求并给出完整的实现方案，包括文件结构、关键代码和步骤，但不要实际修改任何文件。\n\n---\n\n";

function buildArgs(opts: ExecuteOptions, stream: boolean): string[] {
  if (opts.mode === "cloud") {
    return ["-c", opts.prompt];
  }

  const args: string[] = ["-p", "--trust"];
  if (opts.mode === "agent") {
    args.push("--force");
  }

  if (opts.chatId) {
    args.push(`--resume=${opts.chatId}`);
  }

  if (opts.mode === "plan") {
    // plan 模式实际以 ask（只读）执行，防止 -p 自动批准写入
    args.push("--mode=ask");
  } else if (opts.mode !== "agent") {
    args.push(`--mode=${opts.mode}`);
  }

  args.push("--output-format", stream ? "stream-json" : "text");

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const prompt = opts.mode === "plan"
    ? PLAN_PROMPT_PREFIX + opts.prompt
    : opts.prompt;
  args.push(prompt);
  return args;
}

function makeEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (config.cursor.apiKey) {
    env.CURSOR_API_KEY = config.cursor.apiKey;
  }
  return env;
}

/** exit 143 = 128+15(SIGTERM)，Cursor CLI 捕获 SIGTERM 后以此退出 */
function isTimeoutExit(code: number | null, signal: string | null): boolean {
  return (code === null && signal != null) || code === 143;
}

/** 流式执行 Cursor CLI，通过回调报告中间进度、模型信息 */
export function executeCursorStream(
  opts: ExecuteOptions,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    if (opts.mode === "cloud") {
      executeCursorBasic(opts).then(resolve);
      return;
    }

    const args = buildArgs(opts, true);
    console.log(`[cursor] 启动: ${config.cursor.bin} ${args.join(" ")}`);
    console.log(`[cursor] 工作目录: ${opts.workDir}`);

    const child = spawn(config.cursor.bin, args, {
      cwd: opts.workDir,
      env: makeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.cursor.timeoutMs,
    });

    let aborted = false;
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        child.kill("SIGTERM");
      } else {
        const onAbort = () => { aborted = true; child.kill("SIGTERM"); };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

    const errChunks: Buffer[] = [];
    child.stderr.on("data", (data: Buffer) => {
      errChunks.push(data);
      const text = data.toString("utf-8").trim();
      if (text) console.log(`[cursor][stderr] ${text}`);
    });

    let assistantText = "";
    let durationMs: number | undefined;

    const rl = createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = event.type as string | undefined;
        const subtype = event.subtype as string | undefined;

        if (type === "system" && subtype === "init") {
          const model = event.model as string | undefined;
          if (model) {
            console.log(`[cursor] 模型: ${model}`);
            callbacks.onModel?.(model);
          }
          return;
        }

        if (type === "assistant") {
          const msg = event.message as Record<string, unknown> | undefined;
          const content = msg?.content as Array<Record<string, unknown>> | undefined;
          const text = content?.[0]?.text as string | undefined;
          if (text) assistantText += text;
          console.log(`[cursor][assistant] +${text?.length ?? 0} chars (total: ${assistantText.length})`);
          return;
        }

        if (type === "result") {
          durationMs = event.duration_ms as number | undefined;
          console.log(`[cursor] 完成 (${durationMs ? Math.round(durationMs / 1000) + "s" : "?"})`);
          return;
        }

        const progress = describeStreamEvent(event, opts.workDir);
        if (progress) {
          console.log(`[cursor] ${progress.detail}`);
          callbacks.onProgress(progress);
        }
      } catch {
        console.log(`[cursor][raw] ${line.slice(0, 200)}`);
      }
    });

    child.on("error", (err) => {
      console.error(`[cursor] 进程错误: ${err.message}`);
      rl.close();
      resolve({
        success: false,
        output: `执行失败: ${err.message}`,
        isCloud: false,
      });
    });

    child.on("close", (code, sig) => {
      console.log(`[cursor] 进程退出: code=${code}, signal=${sig}`);
      rl.close();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();

      if (aborted) {
        resolve({
          success: false,
          output: "任务已取消。",
          isCloud: false,
          durationMs,
          cancelled: true,
        });
      } else if (code === 0) {
        resolve({
          success: true,
          output: assistantText.trim() || "(无输出)",
          isCloud: false,
          durationMs,
        });
      } else if (isTimeoutExit(code, sig)) {
        const timeoutSec = Math.round(config.cursor.timeoutMs / 1000);
        const partial = assistantText.trim() || stderr || "";
        resolve({
          success: false,
          output: `执行超时 (超过 ${timeoutSec}s 限制)，进程被终止。\n可在 .env 中调大 CURSOR_TIMEOUT_MS。${partial ? `\n\n已获取的部分输出:\n${partial}` : ""}`,
          isCloud: false,
          durationMs,
        });
      } else {
        const detail = stderr || assistantText.trim() || `退出码: ${code}`;
        resolve({
          success: false,
          output: `执行出错 (exit ${code}):\n${detail}`,
          isCloud: false,
          durationMs,
        });
      }
    });
  });
}

/** 创建一个新的空会话，返回 chatId */
export function createChat(workDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["create-chat", "--workspace", workDir];
    console.log(`[cursor] 创建会话: ${config.cursor.bin} ${args.join(" ")}`);

    const child = spawn(config.cursor.bin, args, {
      cwd: workDir,
      env: makeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("error", (err) => reject(new Error(`create-chat 失败: ${err.message}`)));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();

      if (code !== 0) {
        reject(new Error(`create-chat 退出码 ${code}: ${stderr || stdout}`));
        return;
      }

      const chatId = stdout.split("\n").pop()?.trim();
      if (!chatId) {
        reject(new Error(`create-chat 未返回 chatId: ${stdout}`));
        return;
      }

      console.log(`[cursor] 新会话已创建: ${chatId}`);
      resolve(chatId);
    });
  });
}

/** 列出历史会话 */
export function listSessions(): Promise<string> {
  return new Promise((resolve) => {
    const args = ["ls"];
    console.log(`[cursor] 列出会话: ${config.cursor.bin} ${args.join(" ")}`);

    const child = spawn(config.cursor.bin, args, {
      env: makeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));

    child.on("error", (err) => {
      resolve(`获取会话列表失败: ${err.message}`);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      if (code !== 0 || !stdout) {
        resolve("暂无历史会话。");
        return;
      }
      resolve(stdout);
    });
  });
}

/** 基础非流式执行（用于 cloud 模式等不支持流式的场景） */
export function executeCursorBasic(opts: ExecuteOptions): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    const args = buildArgs(opts, false);
    console.log(`[cursor] 启动(basic): ${config.cursor.bin} ${args.join(" ")}`);

    const child = spawn(config.cursor.bin, args, {
      cwd: opts.workDir,
      env: makeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.cursor.timeoutMs,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => errChunks.push(data));

    child.on("error", (err) => {
      console.error(`[cursor] 进程错误: ${err.message}`);
      resolve({ success: false, output: `执行失败: ${err.message}`, isCloud: false });
    });

    child.on("close", (code, signal) => {
      console.log(`[cursor] 进程退出: code=${code}, signal=${signal}`);
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();

      if (opts.mode === "cloud") {
        resolve({
          success: code === 0,
          output: stdout
            ? `Cloud Agent 任务已提交。\n\n${stdout}`
            : "Cloud Agent 任务已提交，请前往 https://cursor.com/agents 查看进度。",
          isCloud: true,
        });
        return;
      }

      if (code === 0) {
        resolve({ success: true, output: stdout || "(无输出)", isCloud: false });
      } else if (isTimeoutExit(code, signal)) {
        const timeoutSec = Math.round(config.cursor.timeoutMs / 1000);
        const partial = stdout || stderr || "";
        resolve({
          success: false,
          output: `执行超时 (超过 ${timeoutSec}s 限制)，进程被终止。\n可在 .env 中调大 CURSOR_TIMEOUT_MS。${partial ? `\n\n已获取的部分输出:\n${partial}` : ""}`,
          isCloud: false,
        });
      } else {
        const detail = stderr || stdout || `退出码: ${code}`;
        resolve({ success: false, output: `执行出错 (exit ${code}):\n${detail}`, isCloud: false });
      }
    });
  });
}
