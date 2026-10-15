import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LoginSnapshot, LoginTarget } from "../shared/claudeLogin";
import { PERSONAL_PROVIDER, readProviders, switchedProvider, type ProviderConfig } from "./account";
import { isTeamDaemon } from "./sound";

// Claude 다시 로그인(shared/claudeLogin, 리규형님 10-14). 기기마다 돈다 — 이 기기 데몬의 대화와 이 기기 로그인 파일만 다룬다.
// 로그인 대상 = 이 기기 Paseo 설정의 Claude 공급자 중 로그인 파일을 쓰는 것. 같은 로그인 파일을 쓰는 공급자는 하나로 묶는다.
// 서버 팀 공급자처럼 env 에 CLAUDE_CODE_OAUTH_TOKEN(1년 토큰)을 넣는 공급자는 로그인으로 고칠 수 없어 뺀다.

const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const DATA = join(PASEO_HOME, "plugin-data", "claude-state-bar");
/** 데몬은 플러그인 요청을 30초에 끊는다(account.ts WAIT_MS 와 같은 사정) — 링크·로그인 끝을 그 안에서 기다린다 */
const WAIT_MS = 25_000;

type Target = LoginTarget & { providers: string[]; configDir: string | null; claude: string };

/** Claude 가 로그인 오류를 낼 때 마지막 답 글 전체가 이 한 줄이다. Claude 는 이걸 실패한 턴이 아니라 오류 표시가 붙은 답 글로 낸다
 *  (10-14 실측: assistant error=authentication_failed + result subtype=success is_error=true → Paseo 는 정상 종료로 받는다).
 *  앞 둘은 10-14 실측 문구, 뒤 둘은 같은 오류의 알려진 다른 문구. 대화에서 이 오류를 이야기하는 답에 붙지 않게 한 줄·맨 앞만 본다 */
const AUTH_ERROR = /^(Failed to authenticate\b|Not logged in\b|Invalid API key\b|OAuth token has expired\b)/i;

export function isAuthErrorText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return !!t && !t.includes("\n") && AUTH_ERROR.test(t);
}

function isClaudeProvider(id: string, p: ProviderConfig | undefined): boolean {
  return id === PERSONAL_PROVIDER || p?.extends === PERSONAL_PROVIDER;
}

/** 공급자 실행 명령에서 진짜 claude 경로 — 중계 실행기를 거치면 `--real` 다음 값, 아니면 첫 값이 claude 일 때 그것 */
function claudeFromCommand(command: unknown): string | null {
  if (!Array.isArray(command) || !command.every((v) => typeof v === "string")) return null;
  const args = command as string[];
  const real = args.indexOf("--real");
  if (real >= 0 && args[real + 1]) return args[real + 1];
  return args[0] && /^claude(\.exe|\.cmd)?$/i.test(basename(args[0])) ? args[0] : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function loginTargets(): Target[] {
  if (isTeamDaemon()) return [];
  const providers = readProviders();
  const claudeIds = Object.keys(providers).filter((id) => isClaudeProvider(id, providers[id]));
  // 기본 Claude 공급자는 설정에 없어도 Paseo 가 띄운다
  if (!claudeIds.includes(PERSONAL_PROVIDER)) claudeIds.unshift(PERSONAL_PROVIDER);
  const fallbackClaude = claudeIds.map((id) => claudeFromCommand(providers[id]?.command)).find(Boolean) ?? "claude";
  const byDir = new Map<string, Target>();
  for (const id of claudeIds) {
    const p = providers[id];
    const env = p?.env ?? {};
    if (str(env.CLAUDE_CODE_OAUTH_TOKEN)) continue;
    const configDir = str(env.CLAUDE_CONFIG_DIR);
    const label = str(p?.label) ?? (id === PERSONAL_PROVIDER ? "Claude" : id);
    const key = configDir ?? "";
    const known = byDir.get(key);
    if (known) {
      known.providers.push(id);
      known.label = `${known.label} · ${label}`;
      continue;
    }
    byDir.set(key, { id, label, providers: [id], configDir, claude: claudeFromCommand(p?.command) ?? fallbackClaude });
  }
  return [...byDir.values()];
}

function credentialsFile(t: Target): string {
  return join(t.configDir ?? join(homedir(), ".claude"), ".credentials.json");
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ── 상태(롱폴) ──
const needs = new Map<string, string>();
let rev = Date.now();
const waiters = new Set<() => void>();
function bump(): void {
  rev = Math.max(rev + 1, Date.now());
  for (const fn of [...waiters]) fn();
}

type Run = { target: string; child: ChildProcess; url: string | null; out: string; startedAt: number; exit: Promise<number | null> };
let run: Run | null = null;

function snapshot(): LoginSnapshot {
  const targets = loginTargets();
  return {
    rev,
    supported: targets.length > 0,
    targets: targets.map(({ id, label }) => ({ id, label })),
    needs: Object.fromEntries(needs),
    running: run ? { target: run.target, url: run.url } : null,
  };
}

export async function waitLogin(known: number | null): Promise<LoginSnapshot> {
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

// ── 턴 끝에서 로그인 오류 알아보기 ──
type TimelineLike = ReadonlyArray<{ type: string; text?: unknown }>;
type TurnEnded = {
  agent: { id: string; provider: string };
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
  timeline: TimelineLike;
};

function lastAssistantText(timeline: TimelineLike): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message" && typeof item.text === "string") return item.text;
  }
  return null;
}

/** 이 대화가 지금 쓰는 로그인 파일 — 공급자 바꾸기 기록이 있으면 바꾼 공급자 기준 */
async function targetOf(agentId: string, provider: string): Promise<string | null> {
  const effective = (await switchedProvider(agentId)) ?? provider;
  return loginTargets().find((t) => t.providers.includes(effective))?.id ?? null;
}

export async function onTurnEnded(event: TurnEnded): Promise<void> {
  const { agent, outcome, timeline } = event;
  const text = outcome.kind === "failed" ? outcome.error.message : lastAssistantText(timeline);
  if (isAuthErrorText(text)) {
    const target = await targetOf(agent.id, agent.provider);
    // 토큰으로 로그인하는 공급자(서버 팀)는 다시 로그인으로 못 고쳐 알약을 띄우지 않는다
    if (!target) {
      console.log(`[claude-login] ${agent.id.slice(0, 8)}: login error on ${agent.provider} — no login file to renew`);
      return;
    }
    if (needs.get(agent.id) !== target) {
      needs.set(agent.id, target);
      console.log(`[claude-login] ${agent.id.slice(0, 8)}: login error → needs login (${target})`);
      bump();
    }
    return;
  }
  if (outcome.kind === "completed" && needs.delete(agent.id)) bump();
}

export function forgetLogin(agentId: string): void {
  if (needs.delete(agentId)) bump();
}

// ── 로그인 실행 ──
/** 로그인 명령은 그 기기 브라우저를 스스로 연다(BROWSER 환경변수를 따른다 — 10-14 실측). 링크는 화면 단추로만 열게 아무것도 안 하는 명령을 준다
 *  (10-14 시험 때 PC 에 승인 창이 갑자기 떠 리규형님이 물었다 — 폰으로 보고 있을 때 PC 화면에 뜨지 않게) */
async function noopBrowser(): Promise<string> {
  if (process.platform !== "win32") return "true";
  const file = join(DATA, "noop-browser.cmd");
  await mkdir(DATA, { recursive: true });
  await writeFile(file, "@exit /b 0\r\n", "utf8");
  return file;
}

function stopRun(): void {
  const r = run;
  if (!r) return;
  run = null;
  try {
    r.child.kill();
  } catch {
    /* 이미 끝났다 */
  }
  bump();
}

/** 화면에 돌려줄 출력 마지막 줄 — 링크와 넣은 코드는 가린다 */
function lastLine(out: string, code?: string): string {
  let text = out.replace(/https?:\/\/\S+/g, "<링크>");
  if (code) text = text.split(code).join("<코드>");
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^Paste code here if prompted >\s*/, "").trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    void promise.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

export async function startLogin(targetId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const t = loginTargets().find((x) => x.id === targetId);
  if (!t) return { ok: false, error: "이 기기에서 다시 로그인할 수 있는 Claude 공급자가 아닙니다" };
  stopRun();
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: await noopBrowser() };
  if (t.configDir) env.CLAUDE_CONFIG_DIR = t.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  let child: ChildProcess;
  try {
    child = spawn(t.claude, ["auth", "login"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 윈도우에서 경로 없이 "claude" 만 알면 claude.cmd 라 셸이 있어야 뜬다
      shell: process.platform === "win32" && !/\.exe$/i.test(t.claude),
    });
  } catch (error) {
    return { ok: false, error: `로그인 명령을 띄우지 못했습니다: ${String(error)}` };
  }
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  const r: Run = { target: t.id, child, url: null, out: "", startedAt: Date.now(), exit };
  run = r;
  const gotUrl = new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      r.out += chunk.toString("utf8");
      const m = /visit:\s*(https:\/\/\S+)/.exec(r.out);
      if (m && !r.url) {
        r.url = m[1];
        resolve(m[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
  const first = await waitFor(Promise.race([gotUrl, exit.then(() => null)]), WAIT_MS);
  // 시간이 넘으면 waitFor 가 "timeout" 글자를 돌려준다 — 링크로 받지 않는다(Codex 261015_224111: 링크 없이 성공처럼 "timeout" 을 띄웠다)
  if (typeof first === "string" && first !== "timeout") {
    console.log(`[claude-login] ${t.id}: started — waiting for the code`);
    bump();
    return { ok: true, url: first };
  }
  const why = first === "timeout" ? "로그인 링크가 나오지 않았습니다" : `로그인 명령이 끝났습니다: ${lastLine(r.out) || "출력 없음"}`;
  if (run === r) stopRun();
  console.log(`[claude-login] ${t.id}: start failed — ${first === "timeout" ? "no link" : "exited"}`);
  return { ok: false, error: why };
}

export async function submitCode(code: string): Promise<{ ok: boolean; error?: string }> {
  const r = run;
  const trimmed = code.trim();
  if (!r || !r.url) return { ok: false, error: "진행 중인 로그인이 없습니다 — 링크를 다시 받아 주세요" };
  if (!trimmed) return { ok: false, error: "코드를 붙여 넣어 주세요" };
  const t = loginTargets().find((x) => x.id === r.target);
  const before = t ? mtimeOf(credentialsFile(t)) : 0;
  r.child.stdin?.write(`${trimmed}\n`);
  const result = await waitFor(r.exit, WAIT_MS);
  if (run === r) run = null;
  if (result === "timeout") {
    try {
      r.child.kill();
    } catch {
      /* 이미 끝났다 */
    }
    bump();
    console.log(`[claude-login] ${r.target}: code sent — no finish`);
    return { ok: false, error: "로그인이 끝나지 않았습니다 — 링크를 다시 받아 주세요" };
  }
  // 끝난 값만 믿지 않고 로그인 파일이 새로 쓰였는지도 본다
  const written = t ? mtimeOf(credentialsFile(t)) > Math.max(before, r.startedAt - 1000) : false;
  if (result === 0 && written) {
    for (const [agentId, target] of [...needs]) if (target === r.target) needs.delete(agentId);
    console.log(`[claude-login] ${r.target}: logged in`);
    bump();
    return { ok: true };
  }
  console.log(`[claude-login] ${r.target}: login failed (exit ${result}, file ${written ? "written" : "unchanged"})`);
  bump();
  return { ok: false, error: lastLine(r.out, trimmed) || "로그인하지 못했습니다" };
}

export function cancelLogin(): { ok: boolean } {
  stopRun();
  return { ok: true };
}

export function stopLogin(): void {
  stopRun();
}
