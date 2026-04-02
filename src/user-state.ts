import fs from "node:fs";
import path from "node:path";

export interface ChatRecord {
  chatId: string;
  label: string;
  workDir: string;
  createdAt: number;
}

export interface PersistedState {
  workDir: string;
  model?: string;
  activeChatId?: string;
  chats: ChatRecord[];
}

const STATE_FILE = path.resolve(process.cwd(), "user-state.json");
const DEBOUNCE_MS = 500;

let stateCache: Record<string, PersistedState> = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface LegacyPersistedState {
  workDir: string;
  model?: string;
  chatId?: string;
}

function migrateState(raw: LegacyPersistedState & Partial<PersistedState>): PersistedState {
  if (Array.isArray(raw.chats)) {
    return { workDir: raw.workDir, model: raw.model, activeChatId: raw.activeChatId, chats: raw.chats };
  }
  const chats: ChatRecord[] = [];
  let activeChatId: string | undefined;
  if (raw.chatId) {
    chats.push({ chatId: raw.chatId, label: "chat-1", workDir: raw.workDir, createdAt: Date.now() });
    activeChatId = raw.chatId;
  }
  return { workDir: raw.workDir, model: raw.model, activeChatId, chats };
}

export function loadUserStates(): Map<string, PersistedState> {
  const map = new Map<string, PersistedState>();
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [userId, rawState] of Object.entries(obj)) {
      const s = rawState as LegacyPersistedState & Partial<PersistedState>;
      if (s && typeof s.workDir === "string") {
        const migrated = migrateState(s);
        map.set(userId, migrated);
        stateCache[userId] = migrated;
      }
    }
    console.log(`[state] 已恢复 ${map.size} 个用户状态 (${STATE_FILE})`);
  } catch {
    console.log("[state] 无已有用户状态文件，将在首次保存时创建");
  }
  return map;
}

export function saveUserState(userId: string, state: PersistedState): void {
  stateCache[userId] = { ...state };

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(stateCache, null, 2), "utf-8");
    } catch (err) {
      console.error("[state] 写入用户状态失败:", err);
    }
  }, DEBOUNCE_MS);
}
