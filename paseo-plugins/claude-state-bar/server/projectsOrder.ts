import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 프로젝트 목록 묶음 안 순서(리규형님 10-07 결정: 활성 묶음과 태그 묶음도 끌어서 옮기고, 같은 묶음 안에서만).
// 고정(projectsPins)과 같은 방식 — 프로젝트 매니저 목록 파일은 VS Code 확장도 쓰는 파일이라 건드리지 않고, 데몬이 Paseo 홈 아래
// 플러그인 전용 파일에 따로 둔다. 같은 데몬에 붙은 PC 앱·웹·폰이 같은 순서를 본다.
// 모양: { groups: { "<묶음 이름>": ["<기기>|<경로>", …] } } — 활성 묶음은 ":active". 지금 그 묶음에 없는 키도 남긴다
// (활성은 대화를 열고 닫을 때마다 들고 나서, 다시 들어오면 끌어 놓았던 자리로 간다)

const FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "project-order.json");

type Orders = Record<string, string[]>;

async function readOrders(): Promise<Orders> {
  let text: string;
  try {
    text = await readFile(FILE, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { groups?: unknown };
    const groups = parsed?.groups;
    if (groups && typeof groups === "object" && !Array.isArray(groups)) {
      const out: Orders = {};
      for (const [name, keys] of Object.entries(groups)) {
        if (Array.isArray(keys)) out[name] = keys.filter((k): k is string => typeof k === "string");
      }
      return out;
    }
  } catch {
    /* 아래에서 옆에 남긴다 */
  }
  // 깨진 파일은 다음 쓰기가 덮기 전에 옆에 남긴다(무엇이 있었는지 볼 수 있게)
  await rename(FILE, `${FILE}.broken`).catch(() => {});
  return {};
}

export async function projectOrders(): Promise<{ groups: Orders }> {
  return { groups: await readOrders() };
}

// 고치기와 쓰기는 한 줄로 — 빠르게 두 번 끌어도 한쪽이 사라지지 않게
let writing: Promise<unknown> = Promise.resolve();

/** 모든 묶음 순서를 지운다(초기화 — 화면은 목록 파일 순서로 돌아간다) */
export function clearProjectOrders(): Promise<{ groups: Orders }> {
  const run = async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ groups: {} }), "utf8");
    await rename(tmp, FILE);
    return { groups: {} };
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

/** 순서 파일을 통째로 고친다 — 프로젝트 관리 화면(10-10)이 카테고리 이름을 바꾸거나 지울 때, 프로젝트를 다른 묶음으로 옮길 때 */
export function changeProjectOrders(change: (groups: Orders) => void): Promise<{ groups: Orders }> {
  const run = async () => {
    const groups = await readOrders();
    change(groups);
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ groups }), "utf8");
    await rename(tmp, FILE);
    return { groups };
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

/** 한 묶음의 순서를 통째로 바꾼다(겹친 키는 처음 것만). 다른 묶음은 그대로 */
export function setProjectOrder(group: string, keys: string[]): Promise<{ groups: Orders }> {
  const run = async () => {
    const groups = await readOrders();
    groups[group] = keys.filter((k, i) => keys.indexOf(k) === i);
    await mkdir(dirname(FILE), { recursive: true });
    // 임시 파일에 다 쓴 뒤 바꿔 끼운다 — 쓰다 끊겨도 반쯤 쓴 파일이 남지 않는다
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ groups }), "utf8");
    await rename(tmp, FILE);
    return { groups };
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}
