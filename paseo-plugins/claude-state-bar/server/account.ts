import { readdirSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountKind } from "../shared/account";
import { isTeamDaemon } from "./sound";

// 기록만 바꾼다. 실행기가 기록을 감시해 Claude 를 끄며 다음 말에 새 계정으로 이어 뜬다.
const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const FILE = join(PASEO_HOME, "plugin-data", "claude-state-bar", "accounts.json");
const CONFIG = join(PASEO_HOME, "config.json");
export const PERSONAL_PROVIDER = "claude";
const WAIT_MS = 25_000;
type Entry = { to: string; base: string; at: string };
type Document = { entries: Record<string, Entry>; [key: string]: unknown };
let entries: Record<string, Entry> = {};
let rev = Date.now();
const waiters = new Set<() => void>();
export const normalizeProvider = (id: unknown): string | null => typeof id !== "string" ? null
  : id === "team" ? "claude-yeogiaen" : id === "personal" ? "claude" : id || null;
export type ProviderConfig = { env?: Record<string, unknown>; label?: unknown; extends?: unknown; command?: unknown };
export function readProviders(): Record<string, ProviderConfig> {
  try {
    const doc = JSON.parse(readFileSync(CONFIG, "utf8")) as { agents?: { providers?: Record<string, ProviderConfig> } };
    return doc.agents?.providers ?? {};
  } catch { return {}; }
}
export function claudeProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = { claude: {}, ...readProviders() };
  return Object.fromEntries(Object.entries(providers)
    .filter(([id, p]) => p && (id === PERSONAL_PROVIDER || p.extends === PERSONAL_PROVIDER)));
}
export function baseOf(provider: string | null | undefined): AccountKind | null {
  const id = normalizeProvider(provider);
  return id && Object.hasOwn(claudeProviders(), id) ? id : null;
}
function providerNames(): Record<string, string> {
  return Object.fromEntries(Object.entries(claudeProviders()).map(([id, p]) =>
    [id, typeof p.label === "string" && p.label.trim() ? p.label : id === "claude" ? "Claude" : id]));
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
      await rename(tmp, FILE);
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
