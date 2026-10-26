import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectEntry } from "../../shared/projects/projects";
import { mutableSoundKinds, type MutableSoundKind } from "../../shared/projects/projectSound";
import { globalClaudeHome } from "../claudePaths";

// 프로젝트별 소리 끄기(10-24 리규형님 — Mesa 처럼 사람 없이 도는 프로젝트의 소리를 끄기 · 질문만 남기고 다 끄는 옵션 · 폰으로도 안 나감).
// 정본은 PC 목록 파일 항목의 mute 칸(shared/projects/projects.ts). PC 가 이름표 파일(project-labels.json, server/projects/projectLabels.ts)에 경로마다 실제로
// 적용할 끈 소리를 실어 기기마다 보내고, 소리 사건을 만드는 데몬(server/presentation/soundEvents.ts — 그 대화가 도는 기기)이 그 파일로 거른다.
// 끈 종류는 사건을 아예 만들지 않으니 PC·웹·폰 앱 어느 화면에서도 안 울린다. 질문은 늘 울린다(버튼 "질문은 늘 울림").

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(s) || s.startsWith("//") ? s.toLowerCase() : s;
};

/**
 * 하위 공간 → 맨 위 메인. client/projects/projectSubs.ts mainsOf 와 같은 규칙이다 — 규칙을 바꾸면 둘 다 바꾼다(시험 tests-261024/project_mute 가 둘을 견준다).
 * parent(메인 경로) 가 있으면 그것, 없으면 <메인>/.worktrees/ 아래 경로의 가장 깊은 메인. 메인이 또 하위면 맨 위까지 올린다
 */
export function topMains(entries: readonly ProjectEntry[]): Map<ProjectEntry, ProjectEntry> {
  const byPath = new Map<string, ProjectEntry>();
  for (const e of entries) {
    const k = `${e.host}|${norm(e.path)}`;
    const had = byPath.get(k);
    if (!had || (had.parent && !e.parent)) byPath.set(k, e);
  }
  const direct = new Map<ProjectEntry, ProjectEntry>();
  for (const e of entries) {
    let m: ProjectEntry | undefined;
    if (e.parent) m = byPath.get(`${e.host}|${norm(e.parent)}`);
    else {
      const p = norm(e.path);
      for (const o of entries) {
        if (o === e || o.host !== e.host) continue;
        const base = norm(o.path);
        if (p.startsWith(`${base}/.worktrees/`) && (!m || base.length > norm(m.path).length)) m = o;
      }
    }
    if (m && m !== e) direct.set(e, m);
  }
  const top = new Map<ProjectEntry, ProjectEntry>();
  for (const [e, m] of direct) {
    let root = m;
    const seen = new Set<ProjectEntry>([e]);
    for (let next = direct.get(root); next && !seen.has(root); next = direct.get(root)) {
      seen.add(root);
      root = next;
    }
    if (root !== e) top.set(e, root);
  }
  return top;
}

/** 항목마다 실제로 적용할 끈 소리 — 하위 공간은 메인 것을 따른다(10-24 버튼 "메인 설정을 하위도 따름") */
export function effectiveMute(entries: readonly ProjectEntry[]): Map<ProjectEntry, MutableSoundKind[]> {
  const mains = topMains(entries);
  const out = new Map<ProjectEntry, MutableSoundKind[]>();
  for (const e of entries) out.set(e, [...((mains.get(e) ?? e).mute ?? [])]);
  return out;
}

export type MuteLabel = { path: string; mute?: readonly string[] };

/** 대화 폴더의 끈 소리 — 그 폴더와 같거나 그 위에 있는 이름표 중 가장 깊은 것(하위 폴더에서 연 대화·목록에 없는 워크트리는 위 항목을 따른다) */
export function muteForDirectory(labels: readonly MuteLabel[], directory: string | null | undefined): MutableSoundKind[] {
  if (!directory) return [];
  const d = norm(directory);
  let best: MuteLabel | null = null;
  let bestLen = -1;
  for (const l of labels) {
    const p = norm(l.path);
    if ((d === p || d.startsWith(`${p}/`)) && p.length > bestLen) {
      best = l;
      bestLen = p.length;
    }
  }
  const raw = best?.mute ?? [];
  return mutableSoundKinds.filter((k) => raw.includes(k));
}

const LABELS_FILE = join(globalClaudeHome(), "project-labels.json");
let cache: { sig: string; labels: MuteLabel[] } | null = null;

/** 이 기기 이름표 파일의 경로·끈 소리 — 바뀌었을 때만 다시 읽는다. 없거나 못 읽으면 빈 목록(아무것도 안 끔) */
async function readMuteLabels(): Promise<MuteLabel[]> {
  try {
    const s = await stat(LABELS_FILE);
    const sig = `${s.mtimeMs}|${s.size}`;
    if (cache?.sig === sig) return cache.labels;
    const doc = JSON.parse(await readFile(LABELS_FILE, "utf8")) as { projects?: unknown };
    const labels: MuteLabel[] = [];
    for (const p of Array.isArray(doc?.projects) ? doc.projects : []) {
      if (p && typeof p.path === "string") labels.push({ path: p.path, mute: Array.isArray(p.mute) ? p.mute.filter((k: unknown) => typeof k === "string") : [] });
    }
    cache = { sig, labels };
    return labels;
  } catch {
    return [];
  }
}

/** 이 대화 폴더에서 끈 소리 종류 — server/presentation/soundEvents.ts 가 소리 사건을 만들기 전에 묻는다 */
export async function mutedKindsOf(directory: string | null | undefined): Promise<MutableSoundKind[]> {
  if (!directory) return [];
  return muteForDirectory(await readMuteLabels(), directory);
}
