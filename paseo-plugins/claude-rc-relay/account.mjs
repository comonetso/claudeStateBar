// 공급자 계정 값과 accounts.json 계약. 자동 전환 정책은 rotation.mjs 에만 둔다.
import { mkdirSync, readFileSync, renameSync, rmdirSync, watch, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const DIR = join(HOME, "plugin-data", "claude-state-bar");
export const FILE = join(DIR, "accounts.json");
export const ACCOUNT_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];
export const normalizeProvider = (id) => typeof id !== "string" ? null
  : id === "team" ? "claude-yeogiaen" : id === "personal" ? "claude" : id || null;

export function readProviders() {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
    const configured = doc?.agents?.providers ?? {};
    return Object.entries({ claude: {}, ...configured })
      .filter(([id, p]) => p && (id === "claude" || p.extends === "claude"))
      .map(([id, p]) => ({
        id, label: typeof p.label === "string" && p.label.trim() ? p.label : id === "claude" ? "Claude" : id,
        env: Object.fromEntries(ACCOUNT_KEYS.filter((k) => typeof p.env?.[k] === "string" && p.env[k]).map((k) => [k, p.env[k]])),
      }));
  } catch { return []; }
}
export const isTeamProvider = (p) => !!p && Object.keys(p.env).length > 0;
export function providerForEnv(env, providers = readProviders()) {
  const matches = providers.filter((p) => ACCOUNT_KEYS.every((k) => (env[k] || "") === (p.env[k] || "")));
  return matches.length === 1 ? matches[0].id
    : matches.every((p) => !isTeamProvider(p)) ? matches.find((p) => p.id === "claude")?.id ?? null : null;
}
function readDocument() {
  try {
    const doc = JSON.parse(readFileSync(FILE, "utf8"));
    if (!doc || typeof doc.entries !== "object" || !doc.entries || Array.isArray(doc.entries)) throw Error("invalid accounts");
    return doc;
  } catch (e) {
    if (e.code === "ENOENT") return { entries: {} };
    throw e; // 손상된 기록을 빈 문서로 덮어쓰지 않는다.
  }
}
export function accountEntry(agentId) {
  if (!agentId) return null;
  try {
    const e = readDocument().entries[agentId];
    const to = normalizeProvider(e?.to), base = normalizeProvider(e?.base);
    return to && base && to !== base ? { to, base } : null;
  } catch { return null; }
}
export function accountEnv(env, provider) {
  const next = { ...env };
  for (const key of ACCOUNT_KEYS) delete next[key];
  Object.assign(next, provider.env);
  return next;
}
export function applyAccount(env, agentId) {
  const e = accountEntry(agentId);
  if (!e) return null;
  const target = readProviders().find((p) => p.id === e.to);
  if (!target) throw Error("account provider unavailable");
  for (const key of ACCOUNT_KEYS) delete env[key];
  Object.assign(env, target.env);
  return target.id;
}

/** 플러그인과 같은 디렉터리 잠금 + 최신 문서 읽기 + 임시 파일 rename.
 * 잠금 안에서 guard 를 다시 확인하여 탐침 중 수동 변경/새 입력을 덮어쓰지 않는다. */
export async function writeAccount(agentId, to, base, guard = () => true) {
  if (!agentId || !normalizeProvider(to) || !normalizeProvider(base)) return false;
  mkdirSync(DIR, { recursive: true });
  const lock = FILE + ".lock", deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST" || Date.now() >= deadline) throw Error("account lock unavailable");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    if (!guard()) return false;
    const doc = readDocument();
    if (to === base) delete doc.entries[agentId];
    else doc.entries[agentId] = { to, base, at: new Date().toISOString() };
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, FILE);
    return true;
  } finally { rmdirSync(lock); }
}
export function watchAccount(agentId, onChange) {
  if (!agentId) return () => {};
  const key = () => JSON.stringify(accountEntry(agentId));
  let last = key();
  try {
    mkdirSync(DIR, { recursive: true });
    const w = watch(DIR, () => {
      const now = key();
      if (now === last) return;
      last = now;
      onChange();
    });
    w.on("error", () => {});
    return () => { try { w.close(); } catch { /* 이미 닫힘 */ } };
  } catch { return () => {}; }
}