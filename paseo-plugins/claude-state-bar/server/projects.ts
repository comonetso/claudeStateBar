import { existsSync } from "node:fs";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectsTextProblem } from "../shared/projectsFile";
import type { ProjectEntry } from "../shared/projects";

// VS Code 프로젝트 매니저(alefragnani.project-manager — 리규형님은 고친 판 project-manager-blueming) 목록을 그대로 읽는다.
// 파일 위치: VS Code 사용자 설정 "projectManager.projectsLocation"(폴더) 의 projects.json, 없으면 확장 기본 저장소.
// 항목: { name, rootPath, tags, enabled } — 원격 경로는 vscode-remote://ssh-remote+<{"hostName":…} 의 16진>/<경로>.

function vscodeUserDir(): string {
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Code", "User");
  return join(homedir(), ".config", "Code", "User");
}

/** 설정 파일은 주석이 섞일 수 있는 JSON 이라 통째로 해석하지 않고 이 열쇠 하나만 찾는다 */
async function projectsLocation(): Promise<string | null> {
  try {
    const text = await readFile(join(vscodeUserDir(), "settings.json"), "utf8");
    const m = /"projectManager\.projectsLocation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    const value = m ? (JSON.parse(`"${m[1]}"`) as string) : "";
    return value.trim() || null;
  } catch {
    return null;
  }
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

/** 목록 파일 후보 — 설정한 폴더가 먼저, 없으면 확장 기본 저장소 */
async function projectsCandidates(): Promise<string[]> {
  const folder = await projectsLocation();
  return [...(folder ? [join(folder, "projects.json")] : []), join(vscodeUserDir(), "globalStorage", "alefragnani.project-manager", "projects.json")];
}

/** 편집 화면이 여는 파일 — 목록 읽기(listProjects)와 같은 순서로 처음 있는 것 */
async function projectsFile(): Promise<string | null> {
  for (const file of await projectsCandidates()) if (existsSync(file)) return file;
  return null;
}

// 편집 화면(리규형님 10-06 결정: Paseo 안에서 고친다). 저장은 ① 목록을 못 읽게 되는 글이면 거부 ② 읽은 뒤 다른 곳(VS Code
// 프로젝트 매니저 등)에서 바뀌었으면 덮어쓰지 않음 ③ 직전 내용을 같은 폴더 projects.json.bak 에 남기고 쓴다
export async function readProjectsFile(): Promise<{ file: string | null; text: string; mtimeMs: number | null; error?: string }> {
  const file = await projectsFile();
  if (!file) return { file: null, text: "", mtimeMs: null, error: "목록 파일을 찾지 못했습니다" };
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { file, text, mtimeMs: info.mtimeMs };
  } catch (error) {
    return { file, text: "", mtimeMs: null, error: `목록 파일을 읽지 못했습니다: ${String(error)}` };
  }
}

export async function writeProjectsFile(text: string, baseMtimeMs: number | null): Promise<{ ok: boolean; mtimeMs?: number; error?: string }> {
  const file = await projectsFile();
  if (!file) return { ok: false, error: "목록 파일을 찾지 못했습니다" };
  const problem = projectsTextProblem(text);
  if (problem) return { ok: false, error: problem };
  try {
    if ((await stat(file)).mtimeMs !== baseMtimeMs) {
      return { ok: false, error: "편집하는 사이 다른 곳에서 파일이 바뀌었습니다. [다시 읽기]로 새 내용을 받은 뒤 고쳐 주세요" };
    }
    await copyFile(file, `${file}.bak`);
    await writeFile(file, text, "utf8");
    return { ok: true, mtimeMs: (await stat(file)).mtimeMs };
  } catch (error) {
    return { ok: false, error: `저장하지 못했습니다: ${String(error)}` };
  }
}

export async function listProjects(): Promise<{ source: string | null; entries: ProjectEntry[]; error?: string }> {
  const candidates = await projectsCandidates();
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      const raw = JSON.parse(text);
      if (!Array.isArray(raw)) return { source: file, entries: [], error: "목록 파일 형식이 배열이 아닙니다" };
      const entries: ProjectEntry[] = [];
      for (const o of raw) {
        if (!o || typeof o.rootPath !== "string" || typeof o.name !== "string") continue;
        const host = hostOf(o.rootPath);
        const path = pathOf(o.rootPath);
        entries.push({
          name: o.name.trim(),
          tags: Array.isArray(o.tags) ? o.tags.filter((t: unknown): t is string => typeof t === "string") : [],
          enabled: o.enabled !== false,
          host,
          path,
          ...(host === "PC" && !existsSync(path) ? { missing: true } : {}),
        });
      }
      return { source: file, entries };
    } catch (error) {
      return { source: file, entries: [], error: `목록 파일을 읽지 못했습니다: ${String(error)}` };
    }
  }
  return { source: null, entries: [] };
}
