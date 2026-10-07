import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { isLayoutKey } from "../shared/layoutSync";

// PC 에서 가져오기의 저장본(리규형님 10-07 결정) — PC 앱이 맡긴 작업 공간 순서·화면 구성. 웹·폰이 열 때와 톱니 메뉴로 가져간다.
// 설정 맞추기 정본(settingsSync)과 같은 방식으로 판마다 칸을 따로 두고, 한 줄로 바꿔 끼워 쓴다.

const HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const FILE = join(HOME, "plugin-data", "claude-state-bar", "layout-sync.json");

/** 이 데몬의 서버 번호(데몬이 `server-id` 파일에 둔다)와 컴퓨터 이름 — 웹 연결 목록의 이 PC 항목 이름을 고치는 데 쓴다 */
export async function hostIdentity(): Promise<{ serverId: string | null; hostname: string }> {
  const serverId = await readFile(join(HOME, "server-id"), "utf8").then((t) => t.trim() || null, () => null);
  return { serverId, hostname: hostname() };
}

type Entry = { v: string; at: number };
type State = { slots: Record<string, { at: number; keys: Record<string, Entry> }> };

let loading: Promise<State> | null = null;

function load(): Promise<State> {
  loading ??= (async (): Promise<State> => {
    let text: string;
    try {
      text = await readFile(FILE, "utf8");
    } catch {
      return { slots: {} };
    }
    try {
      const parsed = JSON.parse(text) as State;
      if (parsed && typeof parsed.slots === "object" && parsed.slots) return parsed;
    } catch {
      /* 아래에서 옆에 남긴다 */
    }
    await rename(FILE, `${FILE}.broken`).catch(() => {});
    return { slots: {} };
  })();
  return loading;
}

let writing: Promise<unknown> = Promise.resolve();
function save(state: State): Promise<void> {
  const run = async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, FILE);
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

export async function saveLayout(slot: string, key: string, value: string) {
  // 가져오는 열쇠만 받는다 — 연결 목록 같은 다른 저장 열쇠가 여기로 새어 나가지 않게
  if (!isLayoutKey(key)) throw new Error(`not a layout key: ${key}`);
  const state = await load();
  const now = Date.now();
  const s = (state.slots[slot] ??= { at: now, keys: {} });
  if (s.keys[key]?.v === value) return { at: s.keys[key].at };
  s.keys[key] = { v: value, at: now };
  s.at = now;
  await save(state);
  console.log(`[layout-sync] saved ${slot.slice(0, 12)} ${key} (${value.length} chars)`);
  return { at: now };
}

export async function loadLayout(slot: string) {
  const state = await load();
  return {
    keys: state.slots[slot]?.keys ?? null,
    slots: Object.entries(state.slots).map(([id, x]) => ({ slot: id, at: x.at })),
  };
}
