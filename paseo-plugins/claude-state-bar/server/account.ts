import { readdirSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountKind } from "../shared/account";
import { renameRetry } from "./renameRetry";
import { isTeamDaemon } from "./sound";

// 기록만 바꾼다. 실행기가 기록을 감시해 Claude 를 끄며 다음 말에 새 계정으로 이어 뜬다.
/** 사용량 보기용 로그인 폴더(server/usageLogin)도 이 값을 쓴다 — Paseo 홈 계산을 새로 늘리지 않는다(guard G2) */
export const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const FILE = join(PASEO_HOME, "plugin-data", "claude-state-bar", "accounts.json");
const CONFIG = join(PASEO_HOME, "config.json");
/**
 * Claude 계열 공급자 판정 — 플러그인 쪽 정본(10-18 정리). 기본 공급자 claude 와 Paseo 설정에서 extends: "claude" 인 공급자(팀 등)가 Claude 계열이다.
 * 판정할 때 공급자 이름("claude"·팀 이름)을 직접 비교하지 말고 isClaudeProvider·claudeProviders·baseOf 를 쓴다.
 * 실행기 쪽 짝은 claude-rc-relay/account.mjs isClaudeProvider(둘이 같은 답을 내는지 docs tests-261018/launcher_unify_test.mjs 가 본다)
 */
export const CLAUDE_ROOT = "claude";
/** 기본(개인) 공급자 번호 — CLAUDE_ROOT 와 같은 값의 별칭 */
export const PERSONAL_PROVIDER = CLAUDE_ROOT;
const WAIT_MS = 25_000;
type Entry = { to: string; base: string; at: string };
type Document = { entries: Record<string, Entry>; [key: string]: unknown };
let entries: Record<string, Entry> = {};
let rev = Date.now();
const waiters = new Set<() => void>();
// 옛 기록 값 이행용('team'·'personal' — 공급자 번호로 바꾸기 전 accounts.json). 판정이 아니라 데이터 변환이라 이름이 남는다
export const normalizeProvider = (id: unknown): string | null => typeof id !== "string" ? null
  : id === "team" ? "claude-yeogiaen" : id === "personal" ? CLAUDE_ROOT : id || null;
export type ProviderConfig = { env?: Record<string, unknown>; label?: unknown; extends?: unknown; command?: unknown };
/** Claude 계열인지 — 설정 칸이 비어 있으면(null 등) 아니다 */
export function isClaudeProvider(id: string, p: ProviderConfig | null | undefined): boolean {
  return !!p && (id === CLAUDE_ROOT || p.extends === CLAUDE_ROOT);
}
export function readProviders(): Record<string, ProviderConfig> {
  try {
    const doc = JSON.parse(readFileSync(CONFIG, "utf8")) as { agents?: { providers?: Record<string, ProviderConfig> } };
    return doc.agents?.providers ?? {};
  } catch { return {}; }
}
export function claudeProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = { [CLAUDE_ROOT]: {}, ...readProviders() };
  return Object.fromEntries(Object.entries(providers).filter(([id, p]) => isClaudeProvider(id, p)));
}
export function baseOf(provider: string | null | undefined): AccountKind | null {
  const id = normalizeProvider(provider);
  return id && Object.hasOwn(claudeProviders(), id) ? id : null;
}
function providerNames(): Record<string, string> {
  return Object.fromEntries(Object.entries(claudeProviders()).map(([id, p]) =>
    [id, typeof p.label === "string" && p.label.trim() ? p.label : id === CLAUDE_ROOT ? "Claude" : id]));
}
export function providerFromDisk(agentId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  try {
    for (const dir of readdirSync(join(PASEO_HOME, "agents"))) {
      try {
        const doc = JSON.parse(readFileSync(join(PASEO_HOME, "agents", dir, `${agentId}.json`), "utf8")) as { provider?: unknown };
        if (typeof doc.provider === "string") return doc.provider;
      } catch { /* 이 폴더엔 없다 */ }
    }
  } catch { /* 저장 폴더가 없다 */ }
  return null;
}
export function accountSupported(): boolean {
  return !isTeamDaemon() && Object.keys(claudeProviders()).length > 1;
}
function parseDocument(text: string): Document {
  const doc = JSON.parse(text) as Document;
  if (!doc || !doc.entries || typeof doc.entries !== "object" || Array.isArray(doc.entries)) throw Error("invalid accounts");
  return doc;
}
function load(): void {
  try {
    const next: Record<string, Entry> = {};
    for (const [id, e] of Object.entries(parseDocument(readFileSync(FILE, "utf8")).entries)) {
      const to = normalizeProvider(e?.to), base = normalizeProvider(e?.base);
      if (to && base) next[id] = { to, base, at: e.at };
    }
    entries = next;
  } catch { entries = {}; }
}
function bump(): void {
  rev = Math.max(rev + 1, Date.now());
  for (const fn of [...waiters]) fn();
}
// 자동 전환 실행기도 이 파일을 쓴다. 외부 변경을 롱폴·로그인 대상에 반영한다.
const onDiskChange = () => { load(); bump(); };
watchFile(FILE, { persistent: false, interval: 500 }, onDiskChange);
export function stopAccounts(): void { unwatchFile(FILE, onDiskChange); }

// 실행기 account.mjs 와 같은 잠금. 잠금 안에서 최신 문서를 읽어 다른 대화 변경을 보존한다.
// 죽은 프로세스의 잠금을 임의로 뺏지 않는다. 5초 안에 못 얻으면 실패를 반환한다.
let writing: Promise<unknown> = Promise.resolve();
// Windows 는 다른 프로세스가 대상 파일을 여는 순간 이름 바꾸기를 EPERM·EACCES·EBUSY 로 거부한다 — 이 파일은 실행기들이 감시하며 읽는다
// (claude-rc-relay/account.mjs watchAccount). 10-18 18:08 PC: 거부가 처리되지 않아 플러그인 프로세스가 죽고 웹이 PC 를 "꺼짐"으로 봤다.
// 잠깐 뒤 다시 하면 된다 — 공용 재시도를 1초 상한으로 쓴다(잠금을 쥔 채라 실행기들의 잠금 대기 5초 안에 끝나야 한다). 끝내 안 되면 임시 파일을 지우고 오류를 넘긴다
const RENAME_MAX_MS = 1000;
function save(change: (doc: Document) => void): Promise<void> {
  const run = async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const lock = FILE + ".lock", deadline = Date.now() + 5000;
    while (true) {
      try { await mkdir(lock); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw Error("account lock unavailable");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      let doc: Document;
      try { doc = parseDocument(await readFile(FILE, "utf8")); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        doc = { entries: {} };
      }
      change(doc);
      const tmp = `${FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(doc), { encoding: "utf8", mode: 0o600 });
      try { await renameRetry(tmp, FILE, { maxMs: RENAME_MAX_MS }); }
      catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
      load(); bump();
    } finally { await rmdir(lock); }
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}
export async function switchedProvider(agentId: string): Promise<string | null> {
  load();
  const e = entries[agentId];
  return e && e.to !== e.base ? e.to : null;
}
function snapshot() {
  const accounts: Record<string, AccountKind> = {};
  for (const [id, e] of Object.entries(entries)) if (e.to !== e.base) accounts[id] = e.to;
  return { rev, supported: accountSupported(), accounts, names: providerNames() };
}
export async function waitAccounts(known: number | null) {
  load();
  if (known !== rev) return snapshot();
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(done, WAIT_MS);
    waiters.add(done);
  });
  load();
  return snapshot();
}
export async function switchAccount(agentId: string, target: AccountKind, provider: string | null): Promise<{ ok: boolean; error?: string }> {
  const base = baseOf(provider), to = baseOf(target);
  if (!base || !to) return { ok: false, error: "이 기기에 등록된 Claude 공급자 사이에서만 바꿀 수 있습니다" };
  if (!accountSupported()) return { ok: false, error: "이 기기에서는 Claude 공급자를 바꿀 수 없습니다" };
  try {
    await save((doc) => {
      if (to === base) delete doc.entries[agentId];
      else doc.entries[agentId] = { to, base, at: new Date().toISOString() };
    });
  } catch { return { ok: false, error: "공급자 변경 기록을 저장하지 못했습니다(파일 또는 잠금 확인)" }; }
  console.log(`[account] ${agentId.slice(0, 8)}: → ${to} 로 바꿔 둠(원래 ${base}) — 다음 말부터`);
  return { ok: true };
}
export async function forgetAccount(agentId: string): Promise<void> {
  await save((doc) => { delete doc.entries[agentId]; });
}
