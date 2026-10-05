import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { currentSessionSince } from "../activity/workflows";
import { codexLogDir } from "../chime/scan";
import { fm, parseEntries, parseInflight, parseStamp, pendingFrom, type ChatEntry, type InflightMarker } from "./chatParse";

// codex_rescue 채팅(핑퐁) 대화: <저장소>/docs/codex_rescue/<시각>_chat_<slug>.md 와 진행 중 표시 .log/.chat_<slug>.inflight.
// 확장 chatDiscovery.ts 의 discoverChats 와 같은 규칙을 Node 파일 읽기로 옮겨 썼다.

export interface CodexChatCard {
  stamp: string;
  slug: string;
  subject?: string;
  origin?: string;
  threadId?: string;
  lastAtMs?: number;
  live: boolean;
  /** 이번 세션 대화(확장 markCurrentChats): 진행 중이거나 이번 세션 시작 뒤에 문서가 바뀐 것. 아니면 "지난 대화"로 접힌다 */
  current: boolean;
  entries: ChatEntry[];
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function listChats(cwd: string, limit = 50): Promise<CodexChatCard[]> {
  const logDir = await codexLogDir(cwd);
  if (!logDir) return [];
  const docs = dirname(logDir);
  const found: { stamp: string; slug: string; name: string }[] = [];
  for (const n of await listNames(docs)) {
    const m = /^(\d{6}_\d{6})_chat_(.+)\.md$/.exec(n);
    if (m) found.push({ stamp: m[1], slug: m[2], name: n });
  }
  found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  const markers = new Map<string, InflightMarker>();
  for (const n of await listNames(logDir)) {
    const m = /^\.chat_(.+)\.inflight$/.exec(n);
    if (m) markers.set(m[1], parseInflight(m[1], (await readText(join(logDir, n))) ?? ""));
  }

  const out: CodexChatCard[] = [];
  const claimed = new Set<string>();
  for (const f of found.slice(0, limit)) {
    const path = join(docs, f.name);
    const text = await readText(path);
    if (text === null) continue;
    const entries = parseEntries(text);
    // 진행 중 표시가 어느 문서 것인지: 표시에 시각이 있으면 그 문서, 없으면 같은 slug 의 최신 문서
    const mk = markers.get(f.slug);
    const mine = !!mk && !claimed.has(f.slug) && (!mk.stamp || mk.stamp === f.stamp);
    if (mk && mine) {
      claimed.add(f.slug);
      entries.push(pendingFrom(mk, entries));
    }
    out.push({
      stamp: f.stamp,
      slug: fm(text, "slug") || f.slug,
      ...(fm(text, "subject") ? { subject: fm(text, "subject") } : {}),
      ...(fm(text, "origin") ? { origin: fm(text, "origin") } : {}),
      ...(fm(text, "thread_id") ? { threadId: fm(text, "thread_id") } : {}),
      lastAtMs: (await mtimeOf(path)) ?? parseStamp(f.stamp),
      live: mine,
      current: false,
      entries,
    });
  }
  // 아직 문서가 없는 첫 턴(진행 중 표시만 있음)
  for (const [slug, mk] of markers) {
    if (claimed.has(slug) || !mk.stamp) continue;
    out.push({
      stamp: mk.stamp,
      slug,
      ...(mk.subject ? { subject: mk.subject } : {}),
      lastAtMs: (await mtimeOf(join(logDir, `.chat_${slug}.inflight`))) ?? parseStamp(mk.stamp),
      live: true,
      current: true,
      entries: [pendingFrom(mk, [])],
    });
  }
  // 채팅 문서는 어느 Claude 대화가 썼는지 적지 않아, 열린 대화(확장 상태바 기준) 중 가장 이른 시작을 이번 세션 시작으로 본다
  const since = await currentSessionSince(cwd);
  for (const c of out) c.current = c.live || (since !== null && (c.lastAtMs ?? 0) >= since);
  return out.sort((a, b) => (b.lastAtMs ?? 0) - (a.lastAtMs ?? 0));
}

/**
 * listChats 가 진행 중으로 볼 대화 수를 문서를 읽지 않고 센다(확장 countLiveChats 복사 — 머리줄 단추가 쓴다).
 * 진행 중 표시 하나가 대화 하나다: 표시에 시각이 있으면 그것만으로, 옛 형식(시각 없음)은 같은 slug 문서가
 * 최신 limit 개 안에 있을 때만 센다. 표시가 없으면 폴더 목록 한 번으로 끝난다.
 */
export async function countLiveChats(cwd: string, limit = 50): Promise<number> {
  const logDir = await codexLogDir(cwd);
  if (!logDir) return 0;
  const slugs: string[] = [];
  for (const n of await listNames(logDir)) {
    const m = /^\.chat_(.+)\.inflight$/.exec(n);
    if (m) slugs.push(m[1]);
  }
  if (!slugs.length) return 0;
  let newestSlugs: Set<string> | null = null;
  let live = 0;
  for (const slug of slugs) {
    const mk = parseInflight(slug, (await readText(join(logDir, `.chat_${slug}.inflight`))) ?? "");
    if (mk.stamp) {
      live++;
      continue;
    }
    if (!newestSlugs) {
      const found: { stamp: string; slug: string }[] = [];
      for (const n of await listNames(dirname(logDir))) {
        const m = /^(\d{6}_\d{6})_chat_(.+)\.md$/.exec(n);
        if (m) found.push({ stamp: m[1], slug: m[2] });
      }
      found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
      newestSlugs = new Set(found.slice(0, limit).map((f) => f.slug));
    }
    if (newestSlugs.has(slug)) live++;
  }
  return live;
}
