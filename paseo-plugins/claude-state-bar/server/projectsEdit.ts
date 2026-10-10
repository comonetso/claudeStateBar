import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { CATEGORY_ORDER_KEY, UNTAGGED_GROUP, type ProjectsEditOp } from "../shared/projects";
import { hostOf, pathOf, PROJECTS_FILE } from "./projects";
import { changeProjectOrders } from "./projectsOrder";
import { setProjectPin } from "./projectsPins";

// 프로젝트 관리 화면(10-10 리규형님: "사용자들이 json 을 건드는 건 좀 그래서")이 목록 파일을 고친다.
// 실제 폴더는 건드리지 않는다. 목록 파일 형식(name·rootPath·category·enabled, 탭 들여쓰기)은 그대로 두고 칸만 바꾼다.
// 이름표(projectLabels)·받아쓰기 힌트(sttHints)·화면은 목록 폴더 감시로 알아서 다시 읽는다.

type Item = Record<string, unknown>;
type Result = { ok: boolean; error?: string };

const IS_WIN = process.platform === "win32";

/** 같은 프로젝트인지 — 윈도우 PC 경로만 대소문자·구분자를 무시한다(리눅스 서버는 대소문자가 다르면 다른 폴더) */
function sameKey(a: string, b: string): boolean {
  const norm = (key: string) => {
    const bar = key.indexOf("|");
    const host = key.slice(0, bar);
    const path = key.slice(bar + 1);
    return host === "PC" && IS_WIN ? `${host}|${path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()}` : `${host}|${path.replace(/\/+$/, "")}`;
  };
  return norm(a) === norm(b);
}

function keyOfItem(item: Item): string | null {
  return typeof item.rootPath === "string" ? `${hostOf(item.rootPath)}|${pathOf(item.rootPath)}` : null;
}

function findItem(items: Item[], key: string): number {
  return items.findIndex((item) => {
    const k = keyOfItem(item);
    return k !== null && sameKey(k, key);
  });
}

const categoryOf = (item: Item) => (typeof item.category === "string" ? item.category.trim() : "");

// 고치기와 쓰기는 한 줄로 — 빠르게 두 번 눌러도 한쪽이 사라지지 않게(projectsPins 와 같은 방식)
let writing: Promise<unknown> = Promise.resolve();

/** 목록 파일을 읽어 change 로 고친 뒤 쓴다. change 가 글을 돌려주면 그 이유로 멈추고 쓰지 않는다 */
function editList(change: (items: Item[]) => string | null): Promise<Result> {
  const run = async (): Promise<Result> => {
    let items: Item[];
    try {
      const raw: unknown = JSON.parse(await readFile(PROJECTS_FILE, "utf8"));
      if (!Array.isArray(raw)) return { ok: false, error: "목록 파일 형식이 배열이 아닙니다" };
      items = raw as Item[];
    } catch (error) {
      // 목록이 아직 없는 사용자(VS Code 프로젝트 매니저를 안 쓰던 사람)는 첫 추가 때 새로 만든다
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { ok: false, error: `목록 파일을 읽지 못했습니다: ${String(error)}` };
      items = [];
    }
    const problem = change(items);
    if (problem) return { ok: false, error: problem };
    await mkdir(dirname(PROJECTS_FILE), { recursive: true });
    // 임시 파일에 다 쓴 뒤 바꿔 끼운다 — 쓰다 끊겨도 반쯤 쓴 파일이 남지 않는다
    const tmp = `${PROJECTS_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(items, null, "\t"), "utf8");
    await rename(tmp, PROJECTS_FILE);
    return { ok: true };
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

/** PC 경로를 목록의 모양으로(드라이브 대문자 · 역슬래시 · 끝 구분자 없음) */
function pcPath(input: string): string {
  if (!IS_WIN) return posix.normalize(input).replace(/(.)\/+$/, "$1");
  return win32.normalize(input).replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`).replace(/([^:\\])\\+$/, "$1");
}

/** 서버 항목의 rootPath — 기존 항목과 같은 vscode-remote://ssh-remote+<{"hostName":…} 의 16진>/<경로> */
function remoteRootPath(host: string, path: string): string {
  const authority = Buffer.from(JSON.stringify({ hostName: host }), "utf8").toString("hex");
  return `vscode-remote://ssh-remote+${authority}${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function editProjects(op: ProjectsEditOp): Promise<Result> {
  switch (op.op) {
    case "rename": {
      const name = op.name.trim();
      if (!name) return { ok: false, error: "이름이 비어 있습니다" };
      return editList((items) => {
        const i = findItem(items, op.key);
        if (i < 0) return "목록에서 그 프로젝트를 찾지 못했습니다";
        items[i].name = name;
        return null;
      });
    }
    case "category": {
      const category = op.category.trim();
      const r = await editList((items) => {
        const i = findItem(items, op.key);
        if (i < 0) return "목록에서 그 프로젝트를 찾지 못했습니다";
        if (categoryOf(items[i]) === category) return null;
        // 옮긴 프로젝트는 그 묶음 맨 아래(10-10 결정) — 끌어 놓은 적 없는 줄은 목록 파일 순서라 파일 끝으로 보낸다
        const [item] = items.splice(i, 1);
        item.category = category;
        items.push(item);
        return null;
      });
      // 예전에 그 묶음에서 끌어 놓았던 자리가 남아 있으면 그 자리로 가 버린다 → 새 묶음 순서에서 이 줄을 뺀다
      if (r.ok) await changeProjectOrders((groups) => {
        const group = category || UNTAGGED_GROUP;
        if (groups[group]) groups[group] = groups[group].filter((k) => !sameKey(k, op.key));
      });
      return r;
    }
    case "enabled":
      return editList((items) => {
        const i = findItem(items, op.key);
        if (i < 0) return "목록에서 그 프로젝트를 찾지 못했습니다";
        items[i].enabled = op.enabled;
        return null;
      });
    case "remove": {
      const r = await editList((items) => {
        const i = findItem(items, op.key);
        if (i < 0) return "목록에서 그 프로젝트를 찾지 못했습니다";
        items.splice(i, 1);
        return null;
      });
      if (r.ok) await setProjectPin(op.key, false).catch(() => {});
      return r;
    }
    case "add": {
      const host = op.host.trim();
      const input = op.path.trim();
      if (!host) return { ok: false, error: "기기를 고르세요" };
      if (!input) return { ok: false, error: "경로가 비어 있습니다" };
      let rootPath: string;
      let path: string;
      if (host === "PC") {
        path = pcPath(input);
        if (!existsSync(path)) return { ok: false, error: `이 PC 에 그 폴더가 없습니다: ${path}` };
        rootPath = path;
      } else {
        if (!input.startsWith("/")) return { ok: false, error: "서버 경로는 / 로 시작해야 합니다" };
        path = posix.normalize(input).replace(/(.)\/+$/, "$1");
        rootPath = remoteRootPath(host, path);
      }
      const name = op.name.trim() || (host === "PC" && IS_WIN ? win32.basename(path) : posix.basename(path)) || path;
      return editList((items) => {
        if (findItem(items, `${host}|${path}`) >= 0) return "이미 목록에 있는 프로젝트입니다";
        items.push({ name, rootPath, category: op.category.trim(), enabled: true });
        return null;
      });
    }
    case "renameCategory": {
      const from = op.from.trim();
      const to = op.to.trim();
      if (!to) return { ok: false, error: "카테고리 이름이 비어 있습니다" };
      if (from === to) return { ok: true };
      const r = await editList((items) => {
        let n = 0;
        for (const item of items) {
          if (categoryOf(item) === from) {
            item.category = to;
            n++;
          }
        }
        return n ? null : "그 카테고리를 찾지 못했습니다";
      });
      // 끌어 놓은 순서도 새 이름으로 옮긴다. 이미 있는 카테고리 이름이면 두 묶음이 합쳐진다
      if (r.ok) await changeProjectOrders((groups) => {
        const moved = groups[from] ?? [];
        const kept = groups[to] ?? [];
        if (moved.length || groups[to]) groups[to] = [...kept, ...moved.filter((k) => !kept.includes(k))];
        delete groups[from];
        const cats = groups[CATEGORY_ORDER_KEY];
        if (cats) groups[CATEGORY_ORDER_KEY] = cats.includes(to) ? cats.filter((c) => c !== from) : cats.map((c) => (c === from ? to : c));
      });
      return r;
    }
    case "deleteCategory": {
      const name = op.name.trim();
      const r = await editList((items) => {
        let n = 0;
        for (const item of items) {
          if (categoryOf(item) === name) {
            item.category = "";
            n++;
          }
        }
        return n ? null : "그 카테고리를 찾지 못했습니다";
      });
      if (r.ok) await changeProjectOrders((groups) => {
        delete groups[name];
        const cats = groups[CATEGORY_ORDER_KEY];
        if (cats) groups[CATEGORY_ORDER_KEY] = cats.filter((c) => c !== name);
      });
      return r;
    }
  }
}

/** 새 프로젝트를 둘 기기 — "PC" + ~/.ssh/config 의 Host 별칭(와일드카드 *·?·! 가 든 이름은 뺀다, 10-10 결정) */
export async function projectHosts(): Promise<{ hosts: string[] }> {
  const hosts = ["PC"];
  try {
    const text = await readFile(join(homedir(), ".ssh", "config"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*host\s+(.+?)\s*$/i.exec(line);
      if (!m) continue;
      for (const name of m[1].split(/\s+/)) {
        if (!/[*?!]/.test(name) && !hosts.includes(name)) hosts.push(name);
      }
    }
  } catch {
    /* ssh 설정이 없으면 PC 만 */
  }
  return { hosts };
}
