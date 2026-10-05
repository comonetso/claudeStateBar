import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export async function listProjects(): Promise<{ source: string | null; entries: ProjectEntry[]; error?: string }> {
  const folder = await projectsLocation();
  const candidates = [
    ...(folder ? [join(folder, "projects.json")] : []),
    join(vscodeUserDir(), "globalStorage", "alefragnani.project-manager", "projects.json"),
  ];
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
