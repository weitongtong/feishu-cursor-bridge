import fs from "node:fs";
import path from "node:path";

export interface PersistedState {
  workDir: string;
  model?: string;
  chatId?: string;
}

const STATE_FILE = path.resolve(process.cwd(), "user-state.json");
const DEBOUNCE_MS = 500;

let stateCache: Record<string, PersistedState> = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function loadUserStates(): Map<string, PersistedState> {
  const map = new Map<string, PersistedState>();
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, PersistedState>;
    for (const [userId, state] of Object.entries(obj)) {
      if (state && typeof state.workDir === "string") {
        map.set(userId, state);
      }
    }
    stateCache = obj;
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
