// 공급자 계정 값과 accounts.json 계약. 자동 전환 정책은 rotation.mjs 에만 둔다.
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paseoHome } from "./workstate.mjs";

export const HOME = paseoHome();
const DIR = join(HOME, "plugin-data", "claude-state-bar");
export const FILE = join(DIR, "accounts.json");
export const ACCOUNT_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];
/**
 * Claude 계열 공급자 판정 — 실행기 쪽 정본(10-18 정리). 기본 공급자 claude 와 설정에서 extends: "claude" 인 공급자(팀 등)가 Claude 계열이다.
 * 판정할 때 공급자 이름("claude"·팀 이름)을 직접 비교하지 말고 이것을 쓴다. 플러그인 쪽 짝은 claude-state-bar/server/account.ts isClaudeProvider
 * (둘이 같은 답을 내는지 docs tests-261018/launcher_unify_test.mjs 가 본다)
 */
export const CLAUDE_ROOT = "claude";
export const isClaudeProvider = (id, p) => !!p && (id === CLAUDE_ROOT || p.extends === CLAUDE_ROOT);
/** 화면 이름 — 설정 label, 없으면 기본 공급자는 "Claude", 그 밖은 공급자 번호 */
export const providerLabel = (id, p) => (typeof p?.label === "string" && p.label.trim() ? p.label : id === CLAUDE_ROOT ? "Claude" : id);
// 옛 기록 값 이행용('team'·'personal' — 공급자 번호로 바꾸기 전 accounts.json). 판정이 아니라 데이터 변환이라 이름이 남는다
export const normalizeProvider = (id) => typeof id !== "string" ? null
  : id === "team" ? "claude-yeogiaen" : id === "personal" ? CLAUDE_ROOT : id || null;

export function readProviders() {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
    const configured = doc?.agents?.providers ?? {};
    return Object.entries({ [CLAUDE_ROOT]: {}, ...configured })
      .filter(([id, p]) => isClaudeProvider(id, p))
      .map(([id, p]) => ({
        id, label: providerLabel(id, p),
        env: Object.fromEntries(ACCOUNT_KEYS.filter((k) => typeof p.env?.[k] === "string" && p.env[k]).map((k) => [k, p.env[k]])),
      }));
  } catch { return []; }
}
export const isTeamProvider = (p) => !!p && Object.keys(p.env).length > 0;
export function providerForEnv(env, providers = readProviders()) {
  const matches = providers.filter((p) => ACCOUNT_KEYS.every((k) => (env[k] || "") === (p.env[k] || "")));
  return matches.length === 1 ? matches[0].id
    : matches.every((p) => !isTeamProvider(p)) ? matches.find((p) => p.id === CLAUDE_ROOT)?.id ?? null : null;
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
// Windows 는 다른 프로세스가 대상 파일을 여는 순간 이름 바꾸기를 EPERM·EACCES·EBUSY 로 거부한다 — 이 파일은 다른 실행기들(watchAccount)과
// 상태바 플러그인이 같이 읽고 쓴다(10-18 18:08 PC 상태바가 이 거부로 죽음 — claude-state-bar/server/account.ts renameRetry 와 같은 처리).
// 25ms 씩 최대 40번(1초, 잠금 대기 5초 안) 다시 하고, 끝내 안 되면 임시 파일을 지우고 오류를 넘긴다
const RENAME_TRIES = 40;
const RENAME_WAIT_MS = 25;
async function renameRetry(from, to) {
  for (let i = 1; ; i++) {
    try { renameSync(from, to); return; }
    catch (e) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(e?.code) || i >= RENAME_TRIES) {
        try { unlinkSync(from); } catch { /* 이미 없음 */ }
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_WAIT_MS));
    }
  }
}
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
    await renameRetry(tmp, FILE);
    return true;
  } finally { rmdirSync(lock); }
}
/**
 * 켜져 있는 동안 이 대화의 계정 기록이 바뀌면 onChange. 기록 파일을 못 읽은 때(다른 프로세스가 바꿔 쓰는 순간 · 손상)는 "바뀜"으로 보지 않는다 —
 * 예전엔 읽기 실패를 "기록 없음"으로 읽어, 기록이 있던 대화가 아무도 안 바꿨는데 꺼질 수 있었다(10-17 저녁 전수 조사, 19:34 여러 실행기 동시 꺼짐).
 * 실패하면 잠시 뒤 한 번 더 읽는다 — 그 사이 진짜 변경이 끝났으면 놓치지 않게
 */
export function watchAccount(agentId, onChange) {
  if (!agentId) return () => {};
  const key = () => {
    try {
      const e = readDocument().entries[agentId];
      const to = normalizeProvider(e?.to), base = normalizeProvider(e?.base);
      return JSON.stringify(to && base && to !== base ? { to, base } : null);
    } catch { return undefined; }
  };
  // 시작 기준은 applyAccount 가 본 것과 같게 — 그때 못 읽었으면 기록 없이 띄웠다(accountEntry 가 null)
  let last = key() ?? JSON.stringify(null);
  let retry = null;
  const check = (again = false) => {
    const now = key();
    if (now === undefined) {
      // 다시 읽기는 변경 알림 한 번에 한 번만 — 파일이 계속 깨져 있으면 다음 변경 알림을 기다린다
      if (!again && !retry) { retry = setTimeout(() => { retry = null; check(true); }, 200); retry.unref?.(); }
      return;
    }
    if (now === last) return;
    last = now;
    onChange();
  };
  try {
    mkdirSync(DIR, { recursive: true });
    const w = watch(DIR, () => check());
    w.on("error", () => {});
    return () => { if (retry) clearTimeout(retry); try { w.close(); } catch { /* 이미 닫힘 */ } };
  } catch { return () => {}; }
}