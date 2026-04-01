export type CursorMode = "agent" | "ask" | "plan" | "cloud";

export interface ParsedCommand {
  type: "cursor";
  mode: CursorMode;
  prompt: string;
}

export interface ModelCommand {
  type: "model";
  model: string;
}

export interface HelpCommand {
  type: "help";
}

export interface StatusCommand {
  type: "status";
}

export interface NewSessionCommand {
  type: "new";
}

export interface WsCommand {
  type: "ws";
}

export interface CancelCommand {
  type: "cancel";
}

export interface WsSwitchCommand {
  type: "ws-switch";
  alias: string;
}

export type Command =
  | ParsedCommand
  | ModelCommand
  | HelpCommand
  | StatusCommand
  | NewSessionCommand
  | WsCommand
  | CancelCommand
  | WsSwitchCommand;

const SLASH_COMMANDS: Record<string, CursorMode> = {
  "/ask": "ask",
  "/cloud": "cloud",
  "/run": "agent",
};

/**
 * 从飞书消息的 JSON content 中提取纯文本。
 * 飞书消息的 content 格式: {"text":"@_user_1 这里是正文"}
 * @-mention 会以 @_user_N 的形式出现，需要去掉。
 */
export function extractTextFromContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    const text = parsed.text ?? raw;
    return text.replace(/@_user_\d+/g, "").trim();
  } catch {
    return raw.trim();
  }
}

/** 将飞书消息文本解析为结构化指令 */
export function parseCommand(text: string): Command {
  const trimmed = text.trim();

  if (trimmed === "/help" || trimmed === "help") {
    return { type: "help" };
  }

  if (trimmed === "/status") {
    return { type: "status" };
  }

  if (trimmed === "/new") {
    return { type: "new" };
  }

  if (trimmed === "/ws") {
    return { type: "ws" };
  }
  if (trimmed.startsWith("/ws ")) {
    return { type: "ws-switch", alias: trimmed.slice(4).trim() };
  }

  if (trimmed.startsWith("/model ")) {
    return { type: "model", model: trimmed.slice(7).trim() };
  }

  if (trimmed === "/cancel") {
    return { type: "cancel" };
  }

  for (const [prefix, mode] of Object.entries(SLASH_COMMANDS)) {
    if (trimmed.startsWith(prefix + " ")) {
      return {
        type: "cursor",
        mode,
        prompt: trimmed.slice(prefix.length + 1).trim(),
      };
    }
    if (trimmed === prefix) {
      return {
        type: "cursor",
        mode,
        prompt: "",
      };
    }
  }

  return {
    type: "cursor",
    mode: "plan",
    prompt: trimmed,
  };
}

export function getModeLabel(mode: CursorMode): string {
  switch (mode) {
    case "agent":
      return "run";
    case "ask":
      return "ask";
    case "plan":
      return "plan";
    case "cloud":
      return "cloud";
  }
}

export const HELP_TEXT = `使用方式：

• 直接发送文本 → 自动进入 plan 模式，Cursor 会分析代码并生成方案
• 继续发送文本 → 在同一会话中细化方案
• /run [指示] → 开始执行并允许改文件；不带参数则执行之前的方案
• /ask [问题] → 只读问答，不改任何文件
• /cloud [任务] → 提交到 Cloud Agent

上下文管理：

• /new → 清除当前会话，重新开始
• /cancel → 取消正在执行的任务
• /status → 查看当前会话状态
• /model <名称> → 切换模型

工作区管理：

• /ws → 查看可用工作区
• /ws <别名> → 切换到预设工作区

推荐流程：

1. 发送任务描述，如"给登录页加验证码并补测试"
2. 查看 Cursor 的方案，继续发消息细化
3. 方案满意后发 /run 开始执行`;
