import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSyncKey, toShared } from "../shared/settingsSync";

// 기기 사이 Paseo 설정 맞추기의 정본(리규형님 10-07 결정). Paseo 화면은 설정을 그 화면의 브라우저 저장소에 따로 둬서
// 앱에서 바꾼 단축키가 브라우저엔 안 먹었다 — 이 PC 데몬이 정본을 들고, 화면(client/settingsSync)이 거기에 맞춘다.
// 칸은 화면 판마다 따로(shared/settingsSync). 같은 데몬에 붙은 PC 앱·웹·폰이 같은 칸을 본다.

const FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "settings-sync.json");
/** 데몬은 플러그인 요청을 30초에 끊는다(앱 0.11.0-beta.5 플러그인 실행부 REQUEST_TIMEOUT_MS) — 그 안에서 답한다 */
const WAIT_MS = 25_000;

type Entry = { v: string | null; at: number };
type Slot = { rev: number; at: number; keys: Record<string, Entry> };
type State = { slots: Record<string, Slot> };

let loading: Promise<State> | null = null;
const waiters = new Set<() => void>();

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
      if (parsed && typeof parsed.slots === "object" && parsed.slots) {
        if (prune(parsed)) await save(parsed);
        return parsed;
      }
    } catch {
      /* 아래에서 옆에 남긴다 */
    }
    // 깨진 파일은 다음 쓰기가 덮기 전에 옆에 남긴다(무엇이 있었는지 볼 수 있게)
    await rename(FILE, `${FILE}.broken`).catch(() => {});
    return { slots: {} };
  })();
  return loading;
}

/** 맞추지 않는 열쇠·칸을 걸러 낸다(10-07 범위를 설정 화면의 설정만으로 줄이기 전에 들어간 화면 상태 등). 바뀌었으면 true */
function prune(state: State): boolean {
  let changed = false;
  for (const [id, slot] of Object.entries(state.slots)) {
    for (const [key, e] of Object.entries(slot.keys)) {
      const v = isSyncKey(key) ? toShared(key, e.v) : undefined;
      if (v === undefined) {
        delete slot.keys[key];
        changed = true;
        console.log(`[settings-sync] pruned ${id.slice(0, 12)} ${key}`);
      } else if (v !== e.v) {
        slot.keys[key] = { v, at: e.at };
        changed = true;
        console.log(`[settings-sync] pruned fields ${id.slice(0, 12)} ${key}`);
      }
    }
  }
  return changed;
}

// 쓰기는 한 줄로 — 겹쳐 써도 반쯤 쓴 파일이 남지 않게 임시 파일에 다 쓴 뒤 바꿔 끼운다
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

function reply(state: State, slot: string) {
  const s = state.slots[slot];
  return {
    rev: s?.rev ?? 0,
    keys: s ? s.keys : null,
    slots: Object.entries(state.slots).map(([id, x]) => ({ slot: id, rev: x.rev, at: x.at })),
  };
}

export async function waitSettings(slot: string, rev: number) {
  const state = await load();
  if ((state.slots[slot]?.rev ?? 0) === rev) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, WAIT_MS);
      waiters.add(done);
    });
  }
  return reply(state, slot);
}

export async function putSettings(slot: string, changes: Record<string, string | null>, seed: boolean) {
  const state = await load();
  const now = Date.now();
  let s = state.slots[slot];
  if (seed) {
    if (s) return { rev: s.rev, applied: false };
    s = state.slots[slot] = { rev: 0, at: now, keys: {} };
  } else if (!s) {
    // 칸이 없으면 처음 기준(PC 앱)이 만들기 전이다 — 다른 화면의 값으로 만들지 않는다
    return { rev: 0, applied: false };
  }
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(changes)) {
    // 화면이 걸러 보내지만 옛 화면 코드가 보낸 것도 여기서 한 번 더 거른다
    const v = isSyncKey(key) ? toShared(key, raw) : undefined;
    if (v === undefined || s.keys[key]?.v === v) continue;
    s.keys[key] = { v, at: now };
    changed.push(key);
  }
  if (!seed && changed.length === 0) return { rev: s.rev, applied: false };
  s.rev += 1;
  s.at = now;
  await save(state);
  console.log(`[settings-sync] ${seed ? "seed" : "put"} ${slot.slice(0, 12)} rev=${s.rev} keys=${changed.join(",") || "-"}`);
  for (const wake of [...waiters]) wake();
  return { rev: s.rev, applied: true };
}
