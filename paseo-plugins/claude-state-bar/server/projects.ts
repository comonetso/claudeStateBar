import { existsSync, watch } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectEntry } from "../shared/projects";

// 프로젝트 목록 — 플러그인 데이터 폴더 안 전용 폴더 project-list/ 의 projects.json 이 정본이다(리규형님 10-07 결정:
// VS Code 를 안 쓰게 되어 VS Code 프로젝트 매니저 목록을 플러그인으로 옮겨 그대로 쓴다. 공개 레포 밖에 둔다. 이 폴더를 Paseo
// "프로젝트 목록" 작업 공간으로 열어 Paseo 편집기에서 고친다 — 그래서 폴더에는 목록 파일만 둔다).
// 항목: { name, rootPath, category, enabled } — 프로젝트 매니저 형식 그대로이되 tags(늘 하나였다) → category(글자 하나).
// 원격 경로는 vscode-remote://ssh-remote+<{"hostName":…} 의 16진>/<경로> 그대로.
// 처음 한 번만 옛 위치(VS Code 사용자 설정 projectManager.projectsLocation 의 projects.json, 없으면 확장 기본 저장소)에서
// 복사해 온다. 그 뒤로는 옛 파일을 읽지 않는다.

export const PROJECTS_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "project-list", "projects.json");

function vscodeUserDir(): string {
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Code", "User");
  return join(homedir(), ".config", "Code", "User");
}

/** 옛 VS Code 프로젝트 매니저 목록 위치 — 처음 한 번 복사해 올 때만 쓴다 */
async function legacyCandidates(): Promise<string[]> {
  let folder = "";
  try {
    // 설정 파일은 주석이 섞일 수 있는 JSON 이라 통째로 해석하지 않고 이 열쇠 하나만 찾는다
    const text = await readFile(join(vscodeUserDir(), "settings.json"), "utf8");
    const m = /"projectManager\.projectsLocation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    folder = m ? (JSON.parse(`"${m[1]}"`) as string).trim() : "";
  } catch {
    /* 설정이 없으면 기본 저장소만 */
  }
  return [...(folder ? [join(folder, "projects.json")] : []), join(vscodeUserDir(), "globalStorage", "alefragnani.project-manager", "projects.json")];
}

/** 옛 항목 { name, rootPath, tags:[…], enabled } → 새 항목 { name, rootPath, category, enabled }. 다른 칸은 그대로 둔다 */
export function toCategoryEntry(o: Record<string, unknown>): Record<string, unknown> {
  if (!("tags" in o)) return o;
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) {
    if (key === "tags") out.category = tags[0] ?? "";
    else out[key] = value;
  }
  return out;
}

let preparing: Promise<void> | null = null;
/** 정본이 없으면 옛 위치에서 한 번 복사해 온다(동시에 여러 번 불려도 한 번만) */
function ensureProjectsFile(): Promise<void> {
  if (existsSync(PROJECTS_FILE)) return Promise.resolve();
  preparing ??= (async () => {
    for (const legacy of await legacyCandidates()) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(legacy, "utf8"));
      } catch {
        continue;
      }
      if (!Array.isArray(raw)) continue;
      const converted = raw.map((o) => (o && typeof o === "object" ? toCategoryEntry(o as Record<string, unknown>) : o));
      await mkdir(dirname(PROJECTS_FILE), { recursive: true });
      const tmp = `${PROJECTS_FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(converted, null, "\t"), "utf8");
      if (!existsSync(PROJECTS_FILE)) await rename(tmp, PROJECTS_FILE);
      console.log(`[projects] copied ${raw.length} projects from ${legacy}`);
      return;
    }
  })().finally(() => {
    preparing = null;
  });
  return preparing;
}

function hostOf(rootPath: string): string {
  if (!rootPath.startsWith("vscode-remote://")) return "PC";
  const authority = rootPath.slice("vscode-remote://".length).split("/")[0].replace(/^ssh-remote\+/, "");
  try {
    const decoded = JSON.parse(Buffer.from(authority, "hex").toString("utf8"));
    if (decoded && typeof decoded.hostName === "string") return decoded.hostName;
  } catch {
    /* 16진이 아닌 옛 형식은 별칭 그대로 */
  }
  return decodeURIComponent(authority);
}

function pathOf(rootPath: string): string {
  if (!rootPath.startsWith("vscode-remote://")) return rootPath;
  const rest = rootPath.slice("vscode-remote://".length);
  const slash = rest.indexOf("/");
  return slash < 0 ? "/" : decodeURIComponent(rest.slice(slash));
}

// 목록 파일이 바뀌면(Paseo 편집기에서 저장 등) 기다리던 화면에 바로 알린다 — 설정 맞추기(settingsSync)와 같은 방식.
// 화면이 지금 아는 파일 수정 시각을 보내면, 다르면 바로, 같으면 바뀔 때까지(길어도 WAIT_MS) 기다렸다 답한다
/** 데몬은 플러그인 요청을 30초에 끊는다(앱 0.11.0-beta.5 플러그인 실행부 REQUEST_TIMEOUT_MS) — 그 안에서 답한다 */
const WAIT_MS = 25_000;
const waiters = new Set<() => void>();
const listeners = new Set<() => void>();
let watching = false;
function watchProjectsFolder(): void {
  if (watching) return;
  try {
    watch(dirname(PROJECTS_FILE), () => {
      for (const wake of [...waiters]) wake();
      for (const listener of [...listeners]) listener();
    });
    watching = true;
  } catch {
    /* 폴더가 아직 없으면 다음 요청 때 다시 */
  }
}
/** 목록 폴더에 무엇이든 바뀌면 부른다(저장 한 번에 여러 번 올 수 있다 — 부르는 쪽이 내용으로 가른다). 끊기 함수를 돌려준다 */
export function onProjectsChange(listener: () => void): () => void {
  listeners.add(listener);
  watchProjectsFolder();
  return () => listeners.delete(listener);
}
async function projectsMtime(): Promise<number | null> {
  try {
    return (await stat(PROJECTS_FILE)).mtimeMs;
  } catch {
    return null;
  }
}
export async function waitProjectsChange(known: number | null): Promise<{ mtimeMs: number | null }> {
  await ensureProjectsFile();
  watchProjectsFolder();
  const now = await projectsMtime();
  if (now !== known) return { mtimeMs: now };
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, WAIT_MS);
    waiters.add(done);
  });
  return { mtimeMs: await projectsMtime() };
}

export async function listProjects(): Promise<{ source: string | null; entries: ProjectEntry[]; error?: string }> {
  await ensureProjectsFile();
  let text: string;
  try {
    text = await readFile(PROJECTS_FILE, "utf8");
  } catch {
    return { source: null, entries: [] };
  }
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return { source: PROJECTS_FILE, entries: [], error: "목록 파일 형식이 배열이 아닙니다" };
    const entries: ProjectEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item.rootPath !== "string" || typeof item.name !== "string") continue;
      const o = toCategoryEntry(item) as { name: string; rootPath: string; category?: unknown; enabled?: unknown };
      const host = hostOf(o.rootPath);
      const path = pathOf(o.rootPath);
      entries.push({
        name: o.name.trim(),
        category: typeof o.category === "string" ? o.category.trim() : "",
        enabled: o.enabled !== false,
        host,
        path,
        ...(host === "PC" && !existsSync(path) ? { missing: true } : {}),
      });
    }
    return { source: PROJECTS_FILE, entries };
  } catch (error) {
    return { source: PROJECTS_FILE, entries: [], error: `목록 파일을 읽지 못했습니다: ${String(error)}` };
  }
}
