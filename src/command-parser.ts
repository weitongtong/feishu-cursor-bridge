export type CursorMode = "agent" | "ask" | "plan" | "cloud";

export interface ParsedCommand {
  type: "cursor";
  mode: CursorMode;
  prompt: string;
}

export interface InputCommand {
  type: "input";
  text: string;
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

export interface ReloadCommand {
  type: "reload";
}

export type Command =
  | ParsedCommand
  | InputCommand
  | ModelCommand
  | HelpCommand
  | StatusCommand
  | NewSessionCommand
  | WsCommand
  | CancelCommand
  | WsSwitchCommand
  | ReloadCommand;

const SLASH_COMMANDS: Record<string, CursorMode> = {
  "/plan": "plan",
  "/ask": "ask",
  "/agent": "agent",
  "/cloud": "cloud",
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

  if (trimmed === "/reload") {
    return { type: "reload" };
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

  return { type: "input", text: trimmed };
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

export const HELP_TEXT = `**使用方式**

- 直接发送文本 → 暂存需求描述，可多次补充
- \`/plan\` [指示] → 开始规划（合并已暂存的内容）
- \`/agent\` [指示] → 开始执行并允许改文件
- \`/ask\` [问题] → 只读问答，不改任何文件
- \`/cloud\` [任务] → 提交到 Cloud Agent

**上下文管理**

- \`/new\` → 清除当前会话，重新开始
- \`/cancel\` → 取消任务或清空暂存消息
- \`/status\` → 查看当前会话状态
- \`/model\` <名称> → 切换模型

**工作区管理**

- \`/ws\` → 查看可用工作区
- \`/ws\` <别名或编号> → 切换到预设工作区
- \`/reload\` → 重新加载工作区配置

**推荐流程**

1. 发送任务描述，如"给登录页加验证码并补测试"
2. 继续发消息补充细节
3. 发 \`/plan\` 查看 Cursor 的方案
4. 方案满意后发 \`/agent\` 开始执行`;
