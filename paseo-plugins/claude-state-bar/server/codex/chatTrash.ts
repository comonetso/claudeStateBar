import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatTrashItem } from "../../shared/codex";
import { findCodexDirs } from "../chime/scan";
import { fm, parseEntries } from "./chatParse";
import { isPlainName, moveNoClobber, serialized } from "./safeFs";

// 복사본: VS Code 확장 src/providers/codexRescue/chatDiscovery.ts 의 채팅 휴지통(trashChat·listChatTrash·restoreChat·
// purgeChat·emptyChatTrash, 2026-10-05). vscode.workspace.fs 를 Node fs 로만 바꿨다. 폴더·meta.json 형식이 같아
// 확장과 서로 읽힌다. 확장 쪽 규칙을 고치면 여기도 같이 고쳐야 한다.
//
// 🔴 진행 휴지통(.trash/)과 완전히 나눈 폴더다(리규형님 08-22 "완전히 나눈다"). 자동 정리는 없다 — 실행 기록은
// 부피 큰 원격 측정이라 나이로 지우지만, 대화는 기록 그 자체라 나이는 지울 이유가 아니다(같은 날 결정).

const TRASH_DIR = ".chat_trash";
const STAMP_RE = /^\d{6}_\d{6}$/;

interface ChatTrashMeta {
  schema: 1;
  kind: "chat";
  stamp: string;
  slug: string;
  subject?: string;
  turns: number;
  deletedAt: number;
  /** 파일 이름 그대로(꺼낼 때 원래 자리) */
  name: string;
}

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

async function docsDirOf(cwd: string): Promise<string | null> {
  return (await findCodexDirs(cwd))?.docsDir ?? null;
}

async function ensureTrashDir(docs: string): Promise<string> {
  const root = join(docs, TRASH_DIR);
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

async function readMeta(bin: string): Promise<ChatTrashMeta | null> {
  try {
    const m = JSON.parse(await readFile(join(bin, "meta.json"), "utf8"));
    if (!m || m.kind !== "chat" || !isPlainName(m.name)) return null;
    return m as ChatTrashMeta;
  } catch {
    return null;
  }
}

/** 대화 하나를 휴지통으로. 옮길 것이 없으면 false */
export async function trashChat(cwd: string, stamp: string, nowMs: number): Promise<boolean> {
  if (!STAMP_RE.test(stamp)) return false;
  const docs = await docsDirOf(cwd);
  if (!docs) return false;
  const re = new RegExp(`^${stamp}_chat_.+\\.md$`);
  const name = (await listNames(docs)).find((n) => re.test(n));
  if (!name) return false;

  const src = join(docs, name);
  const bin = join(docs, TRASH_DIR, stamp);
  return serialized(bin, async () => {
    let text: string | null = null;
    try {
      text = await readFile(src, "utf8");
    } catch {
      return false; // 앞선 넣기가 이미 옮겼다
    }
    await ensureTrashDir(docs);
    // 같은 stamp 칸이 이미 있으면 넣지 않는다. 확장은 매번 빈 칸에서 시작해(rm) 같은 stamp 의 새 대화를 넣으면 휴지통에 있던
    // 옛 대화가 영영 사라졌다(Codex 검토 10-05 재현). 채팅 칸은 파일 하나만 담는 형식이라 보탤 수 없다 — 대화는 목록에 그대로 남는다
    if ((await listNames(bin)).length) return false;
    await mkdir(bin, { recursive: true });
    if ((await moveNoClobber(src, join(bin, name))) !== "moved") {
      await rmdir(bin).catch(() => {});
      return false;
    }
    const meta: ChatTrashMeta = {
      schema: 1,
      kind: "chat",
      stamp,
      slug: (text && fm(text, "slug")) || (/^\d{6}_\d{6}_chat_(.+)\.md$/.exec(name)?.[1] ?? ""),
      ...(text && fm(text, "subject") ? { subject: fm(text, "subject") } : {}),
      turns: text ? parseEntries(text).filter((e) => e.type === "turn").length : 0,
      deletedAt: nowMs,
      name,
    };
    await writeFile(join(bin, "meta.json"), JSON.stringify(meta), "utf8");
    return true;
  });
}

/** 채팅 휴지통 전부, 최근에 지운 것부터 */
export async function listChatTrash(cwd: string): Promise<ChatTrashItem[]> {
  const docs = await docsDirOf(cwd);
  if (!docs) return [];
  const root = join(docs, TRASH_DIR);
  const out: ChatTrashItem[] = [];
  for (const dir of await listNames(root)) {
    const bin = join(root, dir);
    if (!(await statOf(bin))?.isDirectory()) continue;
    const meta = await readMeta(bin);
    if (!meta) continue;
    const st = await statOf(join(bin, meta.name));
    if (!st) continue; // 꺼낼 것이 없는 줄은 도움이 안 된다
    out.push({
      stamp: meta.stamp,
      slug: meta.slug,
      ...(meta.subject ? { subject: meta.subject } : {}),
      deletedAt: meta.deletedAt,
      turns: meta.turns,
      bytes: st.size,
    });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** 원래 자리로 꺼낸다. 그 자리에 파일이 있으면 덮어쓰지 않는다(codex_rescue 는 같은 stamp 를 다시 쓸 수 있다) */
export async function restoreChat(cwd: string, stamp: string): Promise<{ restored: boolean; conflict?: string }> {
  if (!STAMP_RE.test(stamp)) return { restored: false };
  const docs = await docsDirOf(cwd);
  if (!docs) return { restored: false };
  const bin = join(docs, TRASH_DIR, stamp);
  return serialized(bin, async () => {
    const meta = await readMeta(bin);
    if (!meta) return { restored: false };
    const src = join(bin, meta.name);
    if (!(await statOf(src))) return { restored: false };
    // 만들기 자체가 "있으면 실패"(확인과 옮기기 사이에 생긴 파일을 덮어쓰던 것 — Codex 검토 10-05)
    if ((await moveNoClobber(src, join(docs, meta.name))) !== "moved") return { restored: false, conflict: meta.name };
    // 칸에 다른 것이 남았으면(목록에 없는 파일) 지우지 않는다
    if (!(await listNames(bin)).some((n) => n !== "meta.json")) await rm(bin, { recursive: true, force: true });
    return { restored: true };
  });
}

export async function purgeChat(cwd: string, stamp: string): Promise<boolean> {
  if (!STAMP_RE.test(stamp)) return false;
  const docs = await docsDirOf(cwd);
  if (!docs) return false;
  const bin = join(docs, TRASH_DIR, stamp);
  return serialized(bin, async () => {
    if (!(await statOf(bin))) return false;
    try {
      await rm(bin, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  });
}

export async function emptyChatTrash(cwd: string): Promise<number> {
  let n = 0;
  for (const it of await listChatTrash(cwd)) if (await purgeChat(cwd, it.stamp)) n++;
  return n;
}
