import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrashItem } from "../../shared/codex";
import { findCodexDirs } from "../chime/scan";
import { forgetRun } from "./runs";
import { ensureLogDir, isPlainName, moveNoClobber, serialized } from "./safeFs";

// 복사본: VS Code 확장 src/providers/codexRescue/runDiscovery.ts 의 Trash 부분(trashRun·listTrash·restoreTrashed·
// purgeTrashed·emptyTrash·followupExtras·runLogNames, 2026-10-05). vscode.workspace.fs 를 Node fs 로만 바꿨다.
// 폴더(docs/codex_rescue/.trash/<stamp>/)와 meta.json 형식이 같아 확장과 플러그인이 서로의 휴지통을 읽는다.
// 확장 쪽 규칙을 고치면 여기도 같이 고쳐야 한다.
//
// 손으로 지울 때 파일을 지우지 않고 옮기는 까닭: .log/ 는 gitignore 라 다른 안전망이 없고, 문서도 커밋 전이면 git 으로
// 못 살린다. codex_rescue 의 나이 기준 자동 정리는 이 휴지통을 거치지 않는다(디스크 회수가 목적이라).

interface TrashEntry {
  /** 파일 이름 그대로 */
  n: string;
  /** 원래 폴더(docs/codex_rescue 기준): '.log' 또는 '.' */
  d: string;
}

interface TrashMeta {
  schema: 1;
  stamp: string;
  slug: string;
  subject?: string;
  mode?: string;
  deletedAt: number;
  docsIncluded: boolean;
  entries: TrashEntry[];
}

const TRASH_DIR = ".trash";
const STAMP_RE = /^\d{6}_\d{6}$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function statOf(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const dirsOf = findCodexDirs;

/** slug 는 파일 이름 조각이다. 경로를 넘나드는 값은 받지 않는다(카드에서 넘어온 값이라) */
function safeSlug(slug: string): boolean {
  return !!slug && slug !== "(unknown)" && !/[\\/]/.test(slug) && !slug.includes("..");
}

/** 휴지통은 추적되는 문서의 사본을 들고 있어 git 이 커밋 후보로 내밀면 안 된다(.log/ 와 같은 방식) */
async function ensureTrashDir(docsDir: string): Promise<string> {
  const root = join(docsDir, TRASH_DIR);
  await mkdir(root, { recursive: true });
  const ignore = join(root, ".gitignore");
  if (!(await statOf(ignore))) {
    try {
      await writeFile(ignore, "*\n", "utf8");
    } catch {
      /* 없어도 동작한다 */
    }
  }
  return root;
}

async function readTrashMeta(bin: string): Promise<TrashMeta | null> {
  try {
    const m = JSON.parse(await readFile(join(bin, "meta.json"), "utf8"));
    if (!m || typeof m.stamp !== "string" || !Array.isArray(m.entries)) return null;
    return m as TrashMeta;
  } catch {
    return null;
  }
}

/** 턴마다 남는 기록(항상)과 되물음·EDIT 턴 문서(문서까지 옮길 때만) */
async function followupExtras(docsDir: string, logDir: string, stamp: string, slug: string, includeDocs: boolean) {
  const st = escapeRe(stamp);
  const logRe = new RegExp(`^${st}_t\\d+_(?:stderr\\.log|last_message\\.md|launch\\.(?:out|err|exit)|reported)$`);
  const logs = (await listNames(logDir)).filter((n) => logRe.test(n)).sort();
  let docs: string[] = [];
  if (includeDocs && safeSlug(slug)) {
    const docRe = new RegExp(`^${st}_(?:followup|edit)\\d+_${escapeRe(slug)}\\.md$`);
    docs = (await listNames(docsDir)).filter((n) => docRe.test(n)).sort();
  }
  return { logs, docs };
}

/** 실행 하나가 .log/ 에 남기는 고정 이름 기록 전부 + 턴별 기록. 휴지통이 옮기는 목록은 이것 하나다 */
function runLogNames(stamp: string, perTurn: string[]): string[] {
  return [
    `${stamp}_events.jsonl`,
    `${stamp}_status.json`,
    `${stamp}_stderr.log`,
    `${stamp}_last_message.md`,
    `${stamp}_heartbeat`,
    `${stamp}_appserver.jsonl`,
    `${stamp}_steers.jsonl`,
    `${stamp}_launch.out`,
    `${stamp}_launch.err`,
    `${stamp}_launch.exit`,
    `${stamp}_reported`,
    ...perTurn,
  ];
}

/**
 * 실행 하나를 휴지통으로. lock 이 남은 실행은 건드리지 않는다 — send.sh 가 쓰는 중일 수 있고, 그 밑에서 파일을 빼면
 * 보존이 아니라 훼손이다. 옮긴 것이 없으면 false.
 */
export async function trashRun(cwd: string, stamp: string, slug: string, includeDocs: boolean, subject: string | undefined, mode: string | undefined, nowMs: number): Promise<boolean> {
  if (!STAMP_RE.test(stamp)) return false;
  const dirs = await dirsOf(cwd);
  if (!dirs) return false;
  const { docsDir, logDir } = dirs;
  const root = join(docsDir, TRASH_DIR);
  const bin = join(root, stamp);
  return serialized(bin, async () => {
    if (await statOf(join(logDir, `.${stamp}.lock`))) return false;
    await ensureTrashDir(docsDir);
    // 칸이 이미 있으면 지우지 않고 보탠다. 확장은 매번 빈 칸에서 시작해(rm), 같은 실행을 두 번 누르거나 같은 stamp 로 다시 돈
    // 실행을 넣으면 휴지통에 있던 것이 영영 사라졌다(Codex 검토 10-05 재현). 목록 없이 파일만 남은 칸(중간에 끊긴 넣기)은
    // 무엇이 어디서 왔는지 몰라 손대지 않는다
    const prior = await readTrashMeta(bin);
    if (!prior && (await listNames(bin)).length) return false;
    await mkdir(bin, { recursive: true });

    const entries: TrashEntry[] = prior ? [...prior.entries] : [];
    const meta = (): TrashMeta => ({
      schema: 1,
      stamp,
      slug: slug || prior?.slug || "",
      subject: subject ?? prior?.subject,
      mode: mode ?? prior?.mode,
      deletedAt: nowMs,
      docsIncluded: entries.some((e) => e.d === "."),
      entries,
    });
    let moved = 0;
    const move = async (src: string, name: string, origin: string) => {
      if (!(await statOf(src))) return;
      // 휴지통에 같은 이름이 이미 있으면 그 파일은 제자리에 둔다(어느 쪽도 덮어쓰지 않는다). 잠긴 파일도 건너뛴다
      if ((await moveNoClobber(src, join(bin, name))) !== "moved") return;
      entries.push({ n: name, d: origin });
      moved++;
      // 하나 옮길 때마다 목록을 쓴다 — 도중에 끊겨도 칸 안 파일이 목록에 남아 꺼낼 수 있다
      await writeFile(join(bin, "meta.json"), JSON.stringify(meta()), "utf8");
    };

    const extras = await followupExtras(docsDir, logDir, stamp, slug, includeDocs);
    for (const name of runLogNames(stamp, extras.logs)) await move(join(logDir, name), name, ".log");
    if (includeDocs && safeSlug(slug)) {
      for (const kind of ["request", "response", "review"]) {
        const name = `${stamp}_${kind}_${slug}.md`;
        await move(join(docsDir, name), name, ".");
      }
      for (const name of extras.docs) await move(join(docsDir, name), name, ".");
    }

    if (!moved) {
      // 이번에 새로 만든 빈 칸만 치운다(비어 있지 않으면 rmdir 이 실패해 그대로 남는다)
      if (!prior) await rmdir(bin).catch(() => {});
      return false;
    }
    forgetRun(join(logDir, `${stamp}_events.jsonl`));
    return true;
  });
}

/** 휴지통에 든 것 전부, 최근에 지운 것부터 */
export async function listTrash(cwd: string): Promise<TrashItem[]> {
  const dirs = await dirsOf(cwd);
  if (!dirs) return [];
  const root = join(dirs.docsDir, TRASH_DIR);
  const out: TrashItem[] = [];
  for (const name of await listNames(root)) {
    const bin = join(root, name);
    if (!(await statOf(bin))?.isDirectory()) continue;
    const meta = await readTrashMeta(bin);
    if (!meta) continue;
    // 메타가 한때 적은 것이 아니라 지금 디스크에 있는 것을 센다 — 기록만 지우면 문서가 남고, 줄이 그걸 말해야 한다
    let bytes = 0;
    let fileCount = 0;
    let hasLogs = false;
    let hasDocs = false;
    for (const e of meta.entries) {
      if (!isPlainName(e.n)) continue;
      const st = await statOf(join(bin, e.n));
      if (!st) continue;
      bytes += st.size;
      fileCount++;
      if (e.d === ".log") hasLogs = true;
      else hasDocs = true;
    }
    out.push({
      stamp: meta.stamp,
      slug: meta.slug,
      ...(meta.subject ? { subject: meta.subject } : {}),
      ...(meta.mode ? { mode: meta.mode } : {}),
      deletedAt: meta.deletedAt,
      fileCount,
      bytes,
      hasLogs,
      hasDocs,
    });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * 원래 자리로 꺼낸다. 그 자리에 파일이 있으면 절대 덮어쓰지 않는다 — codex_rescue 는 죽은 요청을 같은 stamp 로 다시
 * 돌리므로 그 이름이 새 작업의 것일 수 있다. "있는지 확인 → 옮기기"가 아니라 만들기 자체가 "있으면 실패"다(moveNoClobber —
 * 확인과 옮기기 사이에 생긴 파일을 덮어쓰던 것, Codex 검토 10-05). 칸에 무엇이든 남으면(충돌·이상한 이름·목록에 없는 파일)
 * 칸을 지우지 않고 목록을 남은 것으로 다시 쓴다 — 건너뛴 파일까지 칸째 지우던 것을 막는다.
 */
export async function restoreTrashed(cwd: string, stamp: string) {
  const res = { restored: 0, conflicts: [] as string[], restoredLogs: 0, restoredDocs: 0 };
  if (!STAMP_RE.test(stamp)) return res;
  const dirs = await dirsOf(cwd);
  if (!dirs) return res;
  const { docsDir, logDir } = dirs;
  const bin = join(docsDir, TRASH_DIR, stamp);
  return serialized(bin, async () => {
    const meta = await readTrashMeta(bin);
    if (!meta) return res;
    for (const e of meta.entries) {
      if (!isPlainName(e.n) || (e.d !== ".log" && e.d !== ".")) {
        res.conflicts.push(String(e.n));
        continue;
      }
      const src = join(bin, e.n);
      if (!(await statOf(src))) continue;
      if (e.d === ".log") await ensureLogDir(logDir);
      const dst = e.d === ".log" ? join(logDir, e.n) : join(docsDir, e.n);
      if ((await moveNoClobber(src, dst)) !== "moved") {
        res.conflicts.push(e.n);
        continue;
      }
      res.restored++;
      if (e.d === ".log") res.restoredLogs++;
      else res.restoredDocs++;
    }
    const left = new Set((await listNames(bin)).filter((n) => n !== "meta.json"));
    if (!left.size) await rm(bin, { recursive: true, force: true });
    else if (res.restored) {
      try {
        await writeFile(join(bin, "meta.json"), JSON.stringify({ ...meta, entries: meta.entries.filter((e) => left.has(e.n)) }), "utf8");
      } catch {
        /* 옛 목록이어도 꺼낼 때 없는 파일은 건너뛴다 */
      }
    }
    forgetRun(join(logDir, `${stamp}_events.jsonl`));
    return res;
  });
}

/** 휴지통에서 완전히 지운다. includeDocs=false 면 원시 기록만 지우고 문서는 휴지통에 남긴다(meta.json 다시 씀) */
export async function purgeTrashed(cwd: string, stamp: string, includeDocs: boolean): Promise<boolean> {
  if (!STAMP_RE.test(stamp)) return false;
  const dirs = await dirsOf(cwd);
  if (!dirs) return false;
  const bin = join(dirs.docsDir, TRASH_DIR, stamp);
  return serialized(bin, () => purgeBin(bin, includeDocs));
}

async function purgeBin(bin: string, includeDocs: boolean): Promise<boolean> {
  if (includeDocs) {
    if (!(await statOf(bin))) return false;
    try {
      await rm(bin, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  const meta = await readTrashMeta(bin);
  if (!meta) return false;
  let removed = 0;
  for (const e of meta.entries) {
    if (e.d !== ".log" || !isPlainName(e.n)) continue;
    try {
      await rm(join(bin, e.n));
      removed++;
    } catch {
      /* 이미 없음 */
    }
  }
  // 메타만 남은 칸은 꺼낼 것이 없는 줄이 되니 통째로 지운다
  const survivors = meta.entries.filter((e) => e.d !== ".log");
  if (!survivors.length) {
    await rm(bin, { recursive: true, force: true });
    return removed > 0;
  }
  // 나중에 꺼낼 때 없는 파일을 찾지 않게 목록을 다시 쓴다
  try {
    await writeFile(join(bin, "meta.json"), JSON.stringify({ ...meta, entries: survivors }), "utf8");
  } catch {
    /* 옛 목록이어도 꺼낼 때 없는 파일은 건너뛴다 */
  }
  return removed > 0;
}

export async function emptyTrash(cwd: string, includeDocs: boolean): Promise<number> {
  let n = 0;
  for (const it of await listTrash(cwd)) if (await purgeTrashed(cwd, it.stamp, includeDocs)) n++;
  return n;
}
