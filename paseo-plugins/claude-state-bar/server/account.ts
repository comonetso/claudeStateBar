import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountKind } from "../shared/account";
import { isTeamDaemon } from "./sound";

// 같은 창에서 계정 바꾸기(shared/account, 리규형님 10-14). 기기마다 돈다 — 이 기기 데몬의 대화만 다룬다.
// 여기서는 "이 대화를 어느 계정으로 바꿔 뒀다"는 기록만 쓴다. 실제로 계정을 바꾸는 건 실행기(claude-rc-relay·claude-team-launch 의
// account.mjs)다 — 켜질 때 이 기록을 읽어 계정 값을 정하고, 켜져 있는 동안 기록을 지켜보다 자기 대화가 바뀌면 Claude 를 끈다.
// 다음 말 때 Paseo 가 기록을 둔 채 같은 대화를 다시 띄우고, 그때 새 계정이 적용된다.
// 처음 판(10-14 새벽)은 대화 열기 훅으로 계정 값을 넣고 paseo agent reload 로 다시 띄웠는데, 그 새로 고침은 화면 기록을 지우고
// 대화 전체를 처음부터 다시 흘려보내 긴 대화에서 폰 앱이 멈췄다(Paseo session.js handleRefreshAgentRequest → rehydrateFromDisk:true).
// Paseo 가 넘기는 공급자 이름은 믿지 않고, 바꿀 때 Paseo 에게 물은 원래 계정(base)을 같이 저장한다.

const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const FILE = join(PASEO_HOME, "plugin-data", "claude-state-bar", "accounts.json");
const CONFIG = join(PASEO_HOME, "config.json");
export const TEAM_PROVIDER = "claude-yeogiaen";
export const PERSONAL_PROVIDER = "claude";
/** 데몬은 플러그인 요청을 30초에 끊는다(projects.ts WAIT_MS 와 같은 사정) — 그 안에서 답한다 */
const WAIT_MS = 25_000;

type Entry = { to: AccountKind; base: AccountKind; at: string };

let entries: Record<string, Entry> = {};
// 번호는 시각에서 시작한다 — 데몬이 다시 떠도 화면이 들고 있던 번호와 겹치지 않게
let rev = Date.now();
let loading: Promise<void> | null = null;
const waiters = new Set<() => void>();

export function baseOf(provider: string | null | undefined): AccountKind | null {
  return provider === TEAM_PROVIDER ? "team" : provider === PERSONAL_PROVIDER ? "personal" : null;
}

type ProviderConfig = { env?: Record<string, unknown>; label?: unknown };
function readProviders(): Record<string, ProviderConfig> {
  try {
    const doc = JSON.parse(readFileSync(CONFIG, "utf8")) as { agents?: { providers?: Record<string, ProviderConfig> } };
    return doc.agents?.providers ?? {};
  } catch {
    return {};
  }
}

/** 이 기기 Paseo 설정의 팀 공급자 env. 없으면 이 기기에선 계정을 바꿀 수 없다 */
function teamEnv(): Record<string, string> | null {
  const env = readProviders()[TEAM_PROVIDER]?.env ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v) out[k] = v;
  return Object.keys(out).length ? out : null;
}

/** 화면에 보일 계정 이름 = 이 기기 Paseo 공급자 이름(설정 label). 기본 Claude 공급자는 label 이 없으면 Paseo 가 보이는 이름 "Claude" */
function providerNames(): { team: string; personal: string } {
  const providers = readProviders();
  const label = (id: string, fallback: string) => {
    const v = providers[id]?.label;
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  };
  return { team: label(TEAM_PROVIDER, TEAM_PROVIDER), personal: label(PERSONAL_PROVIDER, "Claude") };
}

/** Paseo 가 대화마다 남기는 저장 파일(~/.paseo/agents/<폴더>/<대화 번호>.json)의 공급자 — 화면 도구 묶음이 공급자를 비워 줄 때 쓴다 */
export function providerFromDisk(agentId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const root = join(PASEO_HOME, "agents");
  try {
    for (const dir of readdirSync(root)) {
      try {
        const doc = JSON.parse(readFileSync(join(root, dir, `${agentId}.json`), "utf8")) as { provider?: unknown };
        if (typeof doc.provider === "string") return doc.provider;
      } catch {
        /* 이 폴더엔 없다 */
      }
    }
  } catch {
    /* 저장 폴더가 없다 */
  }
  return null;
}

/** 팀원 데몬(서버 울타리 안 직원 Paseo)은 직원 계정으로만 돈다 — 바꾸지 않는다 */
export function accountSupported(): boolean {
  return !isTeamDaemon() && teamEnv() !== null;
}

function load(): Promise<void> {
  return (loading ??= (async () => {
    try {
      const doc = JSON.parse(await readFile(FILE, "utf8")) as { entries?: Record<string, Entry> };
      const next: Record<string, Entry> = {};
      for (const [id, e] of Object.entries(doc.entries ?? {})) {
        if (e && (e.to === "team" || e.to === "personal") && (e.base === "team" || e.base === "personal")) next[id] = e;
      }
      entries = next;
    } catch {
      entries = {};
    }
  })());
}

// 쓰기는 한 줄로 — 빠르게 두 번 눌러도 한쪽이 사라지지 않게(projectsPins 와 같다)
let writing: Promise<unknown> = Promise.resolve();
function save(): Promise<void> {
  const run = async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ entries }), "utf8");
    await rename(tmp, FILE);
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

function bump(): void {
  rev = Math.max(rev + 1, Date.now());
  for (const fn of [...waiters]) fn();
}

function snapshot() {
  const accounts: Record<string, AccountKind> = {};
  for (const [id, e] of Object.entries(entries)) if (e.to !== e.base) accounts[id] = e.to;
  return { rev, supported: accountSupported(), accounts, names: providerNames() };
}

export async function waitAccounts(known: number | null) {
  await load();
  if (known !== rev) return snapshot();
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, WAIT_MS);
    waiters.add(done);
  });
  return snapshot();
}

/** 계정을 바꿔 둔다(기록만). 실행기가 기록을 보고 Claude 를 끄고, 다음 말 때 새 계정으로 다시 뜬다.
 *  provider 는 Paseo 에게 물은 그 대화의 공급자. 원래 계정으로 바꾸면 기록을 지운다 */
export async function switchAccount(agentId: string, to: AccountKind, provider: string | null): Promise<{ ok: boolean; error?: string }> {
  await load();
  const base = baseOf(provider);
  if (!base) return { ok: false, error: "Claude 대화가 아니라 계정을 바꿀 수 없습니다" };
  if (!accountSupported()) return { ok: false, error: "이 기기에는 팀 계정 설정이 없습니다" };
  if (to === base) delete entries[agentId];
  else entries[agentId] = { to, base, at: new Date().toISOString() };
  await save();
  bump();
  console.log(`[account] ${agentId.slice(0, 8)}: → ${to} 로 바꿔 둠(원래 ${base}) — 다음 말부터`);
  return { ok: true };
}

/** 보관된 대화의 기억은 지운다 */
export async function forgetAccount(agentId: string): Promise<void> {
  await load();
  if (!entries[agentId]) return;
  delete entries[agentId];
  await save();
  bump();
}
