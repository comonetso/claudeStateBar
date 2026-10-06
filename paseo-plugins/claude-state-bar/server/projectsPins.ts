import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 프로젝트 목록 "맨 위 고정"(리규형님 10-06 결정: 주로 쓰는 6~7개만 위에). 프로젝트 매니저 목록 파일은 VS Code 확장도 쓰는
// 파일이라 건드리지 않고, 데몬이 Paseo 홈 아래 플러그인 전용 파일에 따로 둔다 — 같은 데몬에 붙은 PC 앱·폰이 같은 고정을 본다.
// 키는 "<기기>|<경로>"(ProjectEntry 의 host·path) — 이름을 바꿔도 고정이 남는다.

const FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "project-pins.json");

async function readKeys(): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(FILE, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { keys?: unknown };
    if (Array.isArray(parsed?.keys)) return parsed.keys.filter((k): k is string => typeof k === "string");
  } catch {
    /* 아래에서 옆에 남긴다 */
  }
  // 깨진 파일은 다음 쓰기가 덮기 전에 옆에 남긴다(무엇이 있었는지 볼 수 있게)
  await rename(FILE, `${FILE}.broken`).catch(() => {});
  return [];
}

export async function projectPins(): Promise<{ keys: string[] }> {
  return { keys: await readKeys() };
}

// 고치기와 쓰기는 한 줄로 — 빠르게 두 번 눌러도 한쪽이 사라지지 않게
let writing: Promise<unknown> = Promise.resolve();

/** 지금 키를 읽어 change 로 바꾼 뒤 쓴다. 키 배열의 순서가 화면의 고정 묶음 순서다(10-06 드래그로 바꿈) */
function update(change: (keys: string[]) => string[]): Promise<{ keys: string[] }> {
  const run = async () => {
    const next = change(await readKeys());
    await mkdir(dirname(FILE), { recursive: true });
    // 임시 파일에 다 쓴 뒤 바꿔 끼운다 — 쓰다 끊겨도 반쯤 쓴 파일이 남지 않는다
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ keys: next }), "utf8");
    await rename(tmp, FILE);
    return { keys: next };
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

/** 새로 고정한 것은 맨 아래에 붙는다 */
export function setProjectPin(key: string, pinned: boolean): Promise<{ keys: string[] }> {
  return update((keys) => (pinned ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter((k) => k !== key)));
}

/** 드래그로 바꾼 순서. 그사이 다른 곳(폰 등)에서 고정을 풀었거나 더한 것은 그대로 살린다 — 없는 키는 빼고, 빠진 키는 뒤에 붙인다 */
export function setProjectPinOrder(order: string[]): Promise<{ keys: string[] }> {
  return update((keys) => {
    const next = order.filter((k, i) => keys.includes(k) && order.indexOf(k) === i);
    for (const k of keys) if (!next.includes(k)) next.push(k);
    return next;
  });
}
