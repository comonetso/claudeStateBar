import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TeamJobAction, TeamMember, TeamProject } from "../../shared/team/team";
import { combineAccess, fileModeLabel } from "../../shared/team/teamAccess";
import { SAFE_HOST, sshExe } from "../projects/projectLabels";
import { listProjects } from "../projects/projects";
import { memberSnapshot, recordJob, removeMember } from "./team";

// 팀원 관리 → 서버(10-11 리규형님 "계획대로 서버 작업까지"). PC 데몬이 SSH 로 각 서버의 팀원 도구(paseo-team-ctl)와
// 로그인 서버 관리 도구(admin.mjs)를 부른다. 팀원 추가 = /home/<아이디> + 고른 스킬·명령어 복사(CLAUDE.md 없음) ·
// 프로젝트는 메인이 나눠 준 것만(팀원은 보기만). 연결 열쇠는 서버 → 로그인 서버로 바로 옮기고(scp -3) PC 디스크·화면·기록에 남기지 않는다.
// 비밀번호·OTP 등록(member-setup)은 터미널 전용이라 여기서 하지 않는다.

/** 로그인 서버(웹 로그인 문지기)가 도는 서버와 관리 도구 — 지금 배치(콜어드민) 기준 */
const LOGIN_HOST = "Calladmin-Gabia";
const GATE = "/opt/paseo-gate/node/bin/node /home/paseo/gate/admin.mjs";
/** 로그인 페이지 주소(로그인 서버 서비스 설정의 GATE_ORIGIN) — 초대 링크를 만든다 */
const LOGIN_URL = "https://paseo.yeogiaen.com";
const CTL = "/usr/local/sbin/paseo-team-ctl";
/** 연결 파일을 잠깐 두는 root 전용 폴더(서버·로그인 서버 둘 다) — 등록 뒤 바로 지운다 */
const OFFERS = "/root/paseo-team-offers";
/** 서버 팀원 도구(team-daemon policy.py)와 같은 이름 규칙 — 하위 폴더 명령어("폴더:이름")는 아직 못 넣는다 */
const ITEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ID = /^[a-z][a-z0-9-]{0,30}$/;
const WAIT_MS = 25_000;

type Run = { code: number | null; out: string };

function scpExe(): string {
  if (process.platform === "win32") {
    const builtIn = join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "scp.exe");
    if (existsSync(builtIn)) return builtIn;
  }
  return "scp";
}

/** 자식 명령 — 오류 출력은 비밀이 섞일 수 있어 버리고 표준 출력만 받는다(관리 도구는 비밀 없는 JSON 한 줄만 낸다) */
function run(exe: string, args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 200_000) out = out.slice(-100_000);
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// 시험용 — 가짜 ssh·scp(node 스크립트 경로)로 바꿔 끼운다. 평소엔 비어 있어 실제 ssh·scp 를 쓴다
const FAKE_SSH = process.env.CSB_TEAM_FAKE_SSH;
const FAKE_SCP = process.env.CSB_TEAM_FAKE_SCP;

function ssh(host: string, command: string, timeoutMs = 60_000): Promise<Run> {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, command];
  return FAKE_SSH ? run(process.execPath, [FAKE_SSH, ...args], timeoutMs) : run(sshExe(), args, timeoutMs);
}

function scp(args: string[], timeoutMs: number): Promise<Run> {
  return FAKE_SCP ? run(process.execPath, [FAKE_SCP, ...args], timeoutMs) : run(scpExe(), args, timeoutMs);
}

/** 관리 도구의 마지막 JSON 한 줄 */
function lastJson(out: string): Record<string, unknown> | null {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      /* 앞 줄 */
    }
  }
  return null;
}

const failText = (j: Record<string, unknown> | null, r: Run) =>
  typeof j?.message === "string" ? j.message : typeof j?.error === "string" ? j.error : r.code === null ? "연결 실패 또는 시간 초과" : `종료 코드 ${r.code}`;

/** 로그인 서버의 연결 이름 — 영문·숫자로 시작하는 64자 이하 영문·숫자·_·- */
export function linkName(server: string, id: string): string {
  const slug = server.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug}-${id}`.slice(0, 64);
}

/** 메인이 정한 순서 — 끌어 놓은 카테고리 순서, 그다음 처음 나오는 순서, 카테고리 없음은 끝(화면 번호와 같은 계산) */
function ordered(m: TeamMember): TeamProject[] {
  const present: string[] = [];
  for (const p of m.projects) if (p.category && !present.includes(p.category)) present.push(p.category);
  const rank = (c: string) => {
    const i = m.categoryOrder.indexOf(c);
    return i < 0 ? m.categoryOrder.length : i;
  };
  const cats = present.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  return [...cats.flatMap((c) => m.projects.filter((p) => p.category === c)), ...m.projects.filter((p) => !p.category)];
}

/**
 * 서버 한 대에 보낼 spec — 10-20 리규형님 "팀원 관리 새로": 그 서버의 팀원 프로젝트마다 준 권한(읽기만·읽기쓰기·내가 쓴 파일만 ·
 * 프로젝트 밖 경로 · 포트 · 기록 · 비밀 가리기)을 combineAccess 로 모은다(저장할 때 같은 함수로 검사했다) · 그 서버에서 고른 스킬·명령어.
 * error = 모으다 겹침·한도에 걸림(저장 검사를 지나온 뒤라 옛 기록·손으로 고친 파일 정도) — 반영하지 않는다
 */
export function specFor(m: TeamMember, server: string): { spec: Record<string, unknown>; skipped: string[]; error?: string } {
  const projects = ordered(m).filter((p) => p.host === server);
  const combined = combineAccess(`/home/${m.id}`, projects);
  const skills: string[] = [];
  const commands: string[] = [];
  const skipped: string[] = [];
  for (const key of m.skills) {
    if (!key.startsWith(`${server}|`)) continue;
    const rest = key.slice(server.length + 1);
    const kind = rest.slice(0, rest.indexOf(":"));
    const name = rest.slice(kind.length + 1);
    if (!ITEM.test(name)) {
      skipped.push(kind === "command" ? `/${name}` : name);
      continue;
    }
    (kind === "skill" ? skills : commands).push(name);
  }
  const spec = {
    label: `${server} · ${m.id}`.slice(0, 100),
    mounts: combined.mounts,
    skills,
    commands,
    net: { allowLocalPorts: combined.ports },
    // 팀원 화면 목록 = 팀원 프로젝트만(밖 경로·기록은 열기만 하고 목록에 올리지 않는다)
    projects: projects.map((p) => ({ name: p.name, category: p.category, path: p.path, enabled: p.enabled })),
    // 가릴 때만 싣는다 — 옛 서버 팀원 도구는 이 칸을 모르면 반영을 멈춘다(가리라고 했는데 안 가린 채 켜지지 않게)
    ...(combined.hideSecrets ? { hideSecrets: true } : {}),
    // 본인 로그인일 때만 싣는다(10-21) — 같은 이유로, 옛 도구가 모르는 채 회사 토큰을 넣고 켜지지 않게
    ...(m.ownClaude ? { ownClaude: true } : {}),
    // 부를 이름(10-21 팀원 표준판) — 정했을 때만. 비우면 서버 도구가 아이디 + "님"
    ...(m.callName ? { callName: m.callName } : {}),
  };
  return { spec, skipped, ...(combined.error ? { error: combined.error } : {}) };
}

type Invite = { member: string; key: string; expiresAt: number; link: string };
type Job = {
  id: string;
  member: string;
  action: TeamJobAction;
  lines: string[];
  done: boolean;
  ok: boolean;
  waiters: Set<() => void>;
  /** 이 작업이 발급한 초대 키 — 진행 줄에는 넣지 않고 화면에만 넘긴다(작업은 10분 뒤 잊는다) */
  invite?: Invite;
};
const jobs = new Map<string, Job>();
const busy = new Set<string>();

function say(job: Job, line: string): void {
  job.lines.push(line);
  for (const wake of job.waiters) wake();
  job.waiters.clear();
}

export async function startTeamJob(memberId: string, action: TeamJobAction): Promise<{ ok: boolean; error?: string; jobId?: string }> {
  if (!ID.test(memberId)) return { ok: false, error: "아이디 형식 오류" };
  if (busy.has(memberId)) return { ok: false, error: "이 팀원의 서버 작업이 이미 진행 중입니다" };
  const m = await memberSnapshot(memberId);
  if (!m) return { ok: false, error: "그 팀원을 찾지 못했습니다" };
  const job: Job = { id: randomUUID(), member: memberId, action, lines: [], done: false, ok: false, waiters: new Set() };
  jobs.set(job.id, job);
  busy.add(memberId);
  void (async () => {
    try {
      job.ok =
        action === "apply"
          ? await applyJob(job, m)
          : action === "skills"
            ? await skillsJob(job, m)
            : action === "invite"
              ? await inviteJob(job, m)
              : action === "reset"
                ? await resetJob(job, m)
                : await removeJob(job, m, action === "remove-purge" ? "purge" : "keep");
    } catch (error) {
      say(job, `멈춤: ${(error as Error).message}`);
      job.ok = false;
    } finally {
      busy.delete(memberId);
      job.done = true;
      say(job, job.ok ? "끝났습니다" : "실패로 끝났습니다 — 위 줄을 확인하세요");
      // 끝난 작업은 10분 뒤 잊는다
      setTimeout(() => jobs.delete(job.id), 10 * 60_000);
    }
  })();
  return { ok: true, jobId: job.id };
}

export async function waitTeamJob(
  jobId: string,
  seen: number,
): Promise<{ lines: string[]; done: boolean; ok: boolean; lost: boolean; invite?: Invite }> {
  const job = jobs.get(jobId);
  if (!job) return { lines: [], done: true, ok: false, lost: true };
  if (job.lines.length <= seen && !job.done) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WAIT_MS);
      job.waiters.add(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return { lines: job.lines.slice(seen), done: job.done, ok: job.ok, lost: false, ...(job.invite ? { invite: job.invite } : {}) };
}

/** 로그인 서버에서 초대 키를 받는다(10-10 결정: 일회용·24시간 · 팀원이 로그인 페이지에서 비밀번호·OTP 를 직접 등록) */
async function issueInvite(job: Job, m: TeamMember): Promise<boolean> {
  const r = await ssh(LOGIN_HOST, `${GATE} member-invite ${m.id} --json`);
  const j = lastJson(r.out) as { ok?: boolean; invite?: { key?: unknown; expiresAt?: unknown } } | null;
  const key = j?.ok ? j.invite?.key : undefined;
  const expiresAt = j?.ok ? j.invite?.expiresAt : undefined;
  if (typeof key !== "string" || typeof expiresAt !== "number") {
    say(job, `초대 키를 발급하지 못했습니다 — ${failText(j as Record<string, unknown> | null, r)}`);
    return false;
  }
  job.invite = { member: m.id, key, expiresAt, link: `${LOGIN_URL}/__gate/login#invite=${key}` };
  say(job, `${m.id} 의 초대 키를 발급했습니다 — 위 상자에서 복사해 팀원에게 전해 주세요(24시간 안에 한 번만 쓸 수 있습니다)`);
  return true;
}

async function inviteJob(job: Job, m: TeamMember): Promise<boolean> {
  if (!m.loginAdded) {
    say(job, "로그인 계정이 아직 없습니다 — 서버 반영이 끝나면 초대 키가 함께 나옵니다");
    return false;
  }
  return issueInvite(job, m);
}

/**
 * 등록 초기화(10-12 리규형님 — 인계·폰 바꿈): 로그인 서버에서 비밀번호·OTP 를 지우고 등록 대기로 되돌린 뒤(그 팀원 로그인은 끊긴다)
 * 초대 키까지 한 번에 받는다. 서버 계정·프로젝트·기록은 건드리지 않는다
 */
async function resetJob(job: Job, m: TeamMember): Promise<boolean> {
  if (!m.loginAdded) {
    say(job, "로그인 계정이 아직 없습니다 — 초기화할 등록이 없습니다");
    return false;
  }
  const r = await ssh(LOGIN_HOST, `${GATE} member-reset ${m.id} --json`);
  const j = lastJson(r.out);
  if (!j?.ok) {
    say(job, `등록을 초기화하지 못했습니다 — ${failText(j, r)}`);
    return false;
  }
  say(job, `${m.id} 의 비밀번호·인증 앱 등록을 지우고 등록 대기로 되돌렸습니다(지금 로그인은 끊겼습니다)`);
  return issueInvite(job, m);
}

/** 서버 한 대에 팀원 Paseo 만들기·고치기 */
async function applyOn(job: Job, m: TeamMember, server: string): Promise<boolean> {
  const { spec, skipped, error } = specFor(m, server);
  if (error) {
    say(job, `${server}: 권한이 서로 겹쳐 반영하지 않았습니다 — ${error}`);
    return false;
  }
  if (skipped.length) say(job, `${server}: 하위 폴더 명령어·이름 규칙에 안 맞는 것은 넣지 못합니다 — ${skipped.join(", ")}`);
  say(job, `${server}: 팀원 Paseo 만들기·고치기 — 홈 /home/${m.id}, 프로젝트 ${(spec.projects as unknown[]).length}개, 스킬·명령어 ${(spec.skills as string[]).length + (spec.commands as string[]).length}개`);
  const mounts = spec.mounts as { path: string; mode: "ro" | "rw" }[];
  const ports = (spec.net as { allowLocalPorts: number[] }).allowLocalPorts;
  const list = (mode: "ro" | "rw") => mounts.filter((x) => x.mode === mode).map((x) => x.path).join(", ") || "없음";
  say(job, `${server}: 권한 — ${fileModeLabel("rw")} ${list("rw")} · ${fileModeLabel("ro")} ${list("ro")} · 포트 ${ports.join(", ") || "없음"} · 비밀 파일 ${spec.hideSecrets ? "가림" : "그대로"} · Claude ${spec.ownClaude ? "본인 로그인" : "회사 공용"}`);
  const b64 = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  const command =
    `umask 077; [ -x ${CTL} ] || { echo '{"ok":false,"error":"이 서버에는 팀원 도구가 설치되지 않았습니다"}'; exit 3; }; ` +
    `f=$(mktemp /root/.paseo-team-spec.XXXXXX) && echo ${b64} | base64 -d > "$f" && ${CTL} apply ${m.id} --spec-file "$f" --json; rc=$?; rm -f "$f"; exit $rc`;
  const r = await ssh(server, command, 240_000);
  const j = lastJson(r.out);
  if (!j?.ok) {
    say(job, `${server}: 실패 — ${failText(j, r)}`);
    return false;
  }
  const result = (j.result ?? {}) as { uid?: number; port?: number };
  say(job, `${server}: 준비됨(UID ${result.uid ?? "?"} · 포트 ${result.port ?? "?"})`);
  const standard = standardText(resultField(j, "standard"));
  if (standard) say(job, `${server}: ${standard}`);
  return true;
}

/** 팀원 Paseo 폴더(서버 팀원 도구 ctl.py DATA + '/instances/<아이디>/paseo' — 팀원 데몬의 PASEO_HOME 이 여기 붙는다) */
const teamHome = (id: string) => `/var/lib/paseo-team/instances/${id}/paseo`;
/** 이 PC 데몬의 설정 화면 값 — Paseo 가 registerSettings 값을 두는 자리(PASEO_HOME/plugin-settings/<플러그인>/<설정 id>.json) */
const SETTINGS_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-settings", "claude-state-bar", "sounds.json");
/** 이 PC 의 공급자 선택(server/presentation/speech.ts speechFile 과 같은 자리 — 그 모듈은 Paseo 플러그인 도구를 불러와 여기선 경로만 같게 쓴다) */
const SPEECH_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar", "speech.json");

/** 팀원에게 처음 줄 설정(base64) — 설정 화면 값과 공급자 선택. 이 PC 에 없는 것은 빈 글 */
export function seedPayload(): { settings: string; speech: string } {
  let settings = "";
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { values?: Record<string, unknown> };
    // 소리 파일 칸은 이 PC 의 경로라 서버에선 못 쓴다 — 비워서 팀원 쪽 기본음으로
    for (const value of Object.values(parsed.values ?? {})) {
      if (value && typeof value === "object" && "file" in value) (value as { file: unknown }).file = "";
    }
    settings = Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8").toString("base64");
  } catch { /* 이 PC 에서 설정을 저장한 적이 없다 */ }
  let speech = "";
  try { speech = Buffer.from(readFileSync(SPEECH_FILE, "utf8"), "utf8").toString("base64"); } catch { /* 공급자를 저장한 적이 없다 */ }
  return { settings, speech };
}

const SEED_TEXT: Record<string, string> = { seeded: "리규형님 값으로 시작", kept: "팀원 것 그대로", none: "리규형님 쪽에 없음", failed: "넣지 못함" };

/**
 * 팀원 첫 설정 = 리규형님 값(10-13 리규형님 결정 "처음엔 내 값, 그 뒤는 팀원 것") — 설정 화면 값(자동 번역·읽기 속도 등)과
 * 공급자 선택을 팀원 쪽에 파일이 없을 때만 넣고, 있으면 그대로 둔다. 그 전엔 둘 다 기본값이라 대표님 쪽 자동 번역이 꺼져 있었다.
 * 실패해도 반영은 계속한다(팀원은 설정 화면에서 직접 맞출 수 있다)
 */
async function seedSettings(job: Job, m: TeamMember, server: string): Promise<void> {
  const { settings, speech } = seedPayload();
  if (!settings && !speech) return;
  const r = await ssh(server, seedCommand(teamHome(m.id), settings, speech));
  const j = lastJson(r.out);
  if (!j?.ok) {
    say(job, `${server}: 팀원 첫 설정을 넣지 못했습니다 — ${failText(j, r)} (팀원이 설정 화면에서 직접 맞출 수 있습니다)`);
    return;
  }
  say(job, `${server}: 팀원 설정 — 설정 화면 값 ${SEED_TEXT[String(j.settings)] ?? "?"} · 공급자 선택 ${SEED_TEXT[String(j.speech)] ?? "?"}`);
}

/** 팀원 폴더에 첫 설정을 넣는 서버 명령 — 없을 때만 넣고 팀원 폴더 소유자·600 으로. 결과는 JSON 한 줄(seeded·kept·none·failed) */
export function seedCommand(home: string, settings: string, speech: string): string {
  return (
    `umask 077; D=${home}; [ -d "$D" ] || { echo '{"ok":false,"error":"팀원 Paseo 폴더가 없습니다"}'; exit 3; }; ` +
    `o=$(stat -c %u "$D"); g=$(stat -c %g "$D"); ` +
    `for d in plugin-settings plugin-settings/claude-state-bar claude-state-bar; do [ -d "$D/$d" ] || install -d -o "$o" -g "$g" -m 700 "$D/$d" || exit 4; done; ` +
    `put(){ t="$D/$1"; [ -n "$2" ] || { printf none; return; }; [ -e "$t" ] && { printf kept; return; }; ` +
    `echo "$2" | base64 -d > "$t.csb" && chown "$o:$g" "$t.csb" && chmod 600 "$t.csb" && mv "$t.csb" "$t" && printf seeded || printf failed; }; ` +
    `a=$(put plugin-settings/claude-state-bar/sounds.json '${settings}'); b=$(put claude-state-bar/speech.json '${speech}'); ` +
    `echo "{\\"ok\\":true,\\"settings\\":\\"$a\\",\\"speech\\":\\"$b\\"}"`
  );
}

/** 그 서버의 팀원 Paseo 연결을 로그인 서버에 등록한다 — 연결 파일은 서버 → 로그인 서버로 바로 옮기고 등록 뒤 양쪽에서 지운다 */
async function registerLink(job: Job, m: TeamMember, server: string): Promise<string | null> {
  const link = linkName(server, m.id);
  const file = `${OFFERS}/${link}.link`;
  const made = await ssh(server, `install -d -m 700 ${OFFERS} && rm -f ${file} && ${CTL} link ${m.id} --out ${file} --json`, 120_000);
  const mj = lastJson(made.out);
  if (!mj?.ok) {
    say(job, `${server}: 연결 파일을 만들지 못했습니다 — ${failText(mj, made)}`);
    await ssh(server, `rm -f ${file}`);
    return null;
  }
  try {
    if (server !== LOGIN_HOST) {
      const dir = await ssh(LOGIN_HOST, `install -d -m 700 ${OFFERS}`);
      const copy = dir.code === 0 ? await scp(["-3", "-q", "-o", "BatchMode=yes", `${server}:${file}`, `${LOGIN_HOST}:${file}`], 90_000) : dir;
      if (copy.code !== 0) {
        say(job, `${server}: 연결 파일을 로그인 서버로 옮기지 못했습니다`);
        return null;
      }
    }
    const set = await ssh(LOGIN_HOST, `chmod 600 ${file}; ${GATE} link-set ${link} --file ${file} --label '${server} · ${m.id}' --json; rc=$?; rm -f ${file}; exit $rc`);
    const sj = lastJson(set.out);
    if (!sj?.ok) {
      say(job, `${server}: 로그인 서버에 연결을 등록하지 못했습니다 — ${failText(sj, set)}`);
      return null;
    }
    say(job, `${server}: 로그인 서버에 연결 등록(${link})`);
    return link;
  } finally {
    await ssh(server, `rm -f ${file}`);
    if (server !== LOGIN_HOST) await ssh(LOGIN_HOST, `rm -f ${file}`);
  }
}

/** 같이 보기 열쇠 이름 — 연결 이름 앞에 t-(팀원 Paseo 몫, 10-25) */
export function shareKeyName(server: string, id: string): string {
  return `t-${linkName(server, id)}`.slice(0, 64);
}

/** 팀원 폴더에 같이 보기 열쇠를 넣는 서버 명령 — 이미 있으면 그대로(kept), 없으면 받은 파일을 팀원 소유·600 으로(put). 결과는 JSON 한 줄 */
export function shareKeyCommand(home: string, file: string): string {
  return (
    `umask 077; D=${home}; [ -d "$D" ] || { echo '{"ok":false,"error":"팀원 Paseo 폴더가 없습니다"}'; exit 3; }; ` +
    `o=$(stat -c %u "$D"); g=$(stat -c %g "$D"); t="$D/claude-state-bar/push-central.json"; ` +
    `[ -d "$D/claude-state-bar" ] || install -d -o "$o" -g "$g" -m 700 "$D/claude-state-bar" || exit 4; ` +
    `[ -s "$t" ] && { echo '{"ok":true,"key":"kept"}'; exit 0; }; ` +
    `install -o "$o" -g "$g" -m 600 ${file} "$t.csb" && mv "$t.csb" "$t" && echo '{"ok":true,"key":"put"}'`
  );
}

/**
 * 같이 보기 게이트 열쇠(10-25 명시 지시 5 — 팀원도 공유). 그 서버 팀원 Paseo 폴더에 열쇠(claude-state-bar/push-central.json)가 없을 때만
 * 로그인 서버에서 그 팀원 몫 열쇠(주인 = 그 팀원)를 만들어 옮긴다 — 비밀은 서버끼리만 오가고(scp -3) PC 디스크·화면·기록에 남기지 않는다(registerLink 와 같다).
 * 있으면 건드리지 않는다(다시 만들면 게이트의 비밀이 바뀌어 지금 열쇠를 못 쓰게 된다). 팀원 데몬 플러그인은 이 파일을 쓸 때마다 다시 읽어 재시작이 필요 없다
 */
async function shareKeyOn(job: Job, m: TeamMember, server: string): Promise<boolean> {
  const target = `${teamHome(m.id)}/claude-state-bar/push-central.json`;
  const seen = lastJson((await ssh(server, `[ -s ${target} ] && echo '{"ok":true,"has":true}' || echo '{"ok":true,"has":false}'`)).out);
  if (seen?.ok !== true) {
    say(job, `${server}: 같이 보기 열쇠가 있는지 확인하지 못했습니다`);
    return false;
  }
  if (seen.has === true) return true;
  const name = shareKeyName(server, m.id);
  const file = `${OFFERS}/${name}.key`;
  try {
    const made = await ssh(LOGIN_HOST, `install -d -m 700 ${OFFERS} && rm -f ${file} && ${GATE} push-origin-add ${name} --member ${m.id} --mode central --out ${file} --label '팀원 ${m.id} · ${server}' --json`);
    const mj = lastJson(made.out);
    if (!mj?.ok) {
      say(job, `${server}: 같이 보기 열쇠를 만들지 못했습니다 — ${failText(mj, made)}`);
      return false;
    }
    if (server !== LOGIN_HOST) {
      const dir = await ssh(server, `install -d -m 700 ${OFFERS}`);
      const copy = dir.code === 0 ? await scp(["-3", "-q", "-o", "BatchMode=yes", `${LOGIN_HOST}:${file}`, `${server}:${file}`], 90_000) : dir;
      if (copy.code !== 0) {
        say(job, `${server}: 같이 보기 열쇠를 옮기지 못했습니다`);
        return false;
      }
    }
    const put = await ssh(server, shareKeyCommand(teamHome(m.id), file));
    const pj = lastJson(put.out);
    if (!pj?.ok) {
      say(job, `${server}: 같이 보기 열쇠를 넣지 못했습니다 — ${failText(pj, put)}`);
      return false;
    }
    say(job, `${server}: 같이 보기 열쇠를 넣었습니다(${name} — 팀원 Paseo 도 공유를 켤 수 있습니다)`);
    return true;
  } finally {
    await ssh(LOGIN_HOST, `rm -f ${file}`);
    if (server !== LOGIN_HOST) await ssh(server, `rm -f ${file}`);
  }
}

async function gate(args: string): Promise<{ ok: boolean; text: string; code: string }> {
  const r = await ssh(LOGIN_HOST, `${GATE} ${args} --json`);
  const j = lastJson(r.out);
  return { ok: j?.ok === true, text: failText(j, r), code: typeof j?.error === "string" ? j.error : "" };
}

/**
 * 새 팀원 아이디를 써도 되는가(10-25 리규형님 — 아이디 중복 확인이 없어 웹 로그인 관리자 아이디로 팀원을 만들었다). 팀원을 저장하기 전에
 * 웹 로그인(관리자·팀원 계정)과 프로젝트 목록에 나오는 서버마다(원래 있던 /home/<아이디>·서버 계정 이름·같은 아이디 팀원) 묻는다.
 * 겹치면 error. 닿지 않거나 아직 옛 도구인 곳은 unchecked — 그 서버에 처음 만들 때 서버 도구가 다시 막는다(ctl.name_taken)
 */
export async function memberIdProblems(id: string): Promise<{ error: string | null; unchecked: string[] }> {
  if (!ID.test(id)) return { error: null, unchecked: [] }; // 형식 오류 문구는 저장(saveMember)이 낸다
  const { entries } = await listProjects();
  const servers = [...new Set([LOGIN_HOST, ...entries.map((e) => e.host)])].filter((h) => h !== "PC" && SAFE_HOST.test(h));
  const problems: string[] = [];
  const unchecked: string[] = [];
  await Promise.all([
    (async () => {
      const j = lastJson((await ssh(LOGIN_HOST, `${GATE} member-check ${id} --json`, 20_000)).out);
      if (j?.ok === true && typeof j.free === "boolean") {
        if (!j.free) problems.push(`웹 로그인 — ${typeof j.reason === "string" ? j.reason : "이미 있는 아이디입니다"}`);
      } else unchecked.push("웹 로그인");
    })(),
    ...servers.map(async (server) => {
      const r = await ssh(server, `[ -x ${CTL} ] || exit 3; ${CTL} name-check ${id} --json`, 20_000);
      if (r.code === 3) return; // 팀원 도구가 없는 서버 — 팀원을 만들 수 없는 곳
      const j = lastJson(r.out);
      const result = (j?.ok === true ? j.result : null) as { free?: unknown; reason?: unknown } | null;
      if (typeof result?.free === "boolean") {
        if (!result.free) problems.push(`${server} — ${typeof result.reason === "string" ? result.reason : "쓸 수 없는 아이디입니다"}`);
      } else unchecked.push(server);
    }),
  ]);
  return { error: problems.length ? `이 아이디는 쓸 수 없습니다: ${problems.join(" · ")}` : null, unchecked };
}

async function applyJob(job: Job, m: TeamMember): Promise<boolean> {
  for (const s of [...m.servers, ...m.applied]) if (!SAFE_HOST.test(s)) throw new Error(`서버 이름 형식 오류: ${s}`);
  const applied = new Set(m.applied);
  const links = { ...m.links };
  let ok = true;
  for (const server of m.servers) {
    if (!(await applyOn(job, m, server))) {
      ok = false;
      continue;
    }
    applied.add(server);
    await seedSettings(job, m, server);
    if (!links[server]) {
      const link = await registerLink(job, m, server);
      if (link) links[server] = link;
      else ok = false;
    }
  }
  // 고르지 않게 된 서버 — 그 서버의 팀원 Paseo 와 로그인 서버 연결을 지운다(서버 도구는 같은 이름을 다시 쓰지 않는다)
  const dropped = [...applied].filter((s) => !m.servers.includes(s));
  // 로그인 계정 — 처음이면 만들고, 아니면 허락할 연결 목록만 맞춘다
  let loginAdded = m.loginAdded;
  const allowed = m.servers.map((s) => links[s]).filter((l): l is string => !!l);
  if (allowed.length) {
    // 같은 아이디가 이미 있으면(관리자 아이디 또는 다른 팀원 계정) 덮지 않고 멈춘다(10-25 — 전엔 연결 맞추기로 넘어가 남의 계정 연결을
    // 덮거나, 관리자 아이디면 "직원 계정이 없습니다"로 끝났다). 저장 전 확인(memberIdProblems)이 먼저 막는다
    const r = loginAdded ? await gate(`member-links ${m.id} --links ${allowed.join(",")}`) : await gate(`member-add ${m.id} --links ${allowed.join(",")}`);
    if (!loginAdded && r.code === "ID_EXISTS") {
      say(job, `로그인 서버에 같은 아이디(${m.id})가 이미 있어 웹 계정을 만들지 않았습니다 — 관리자 아이디이거나 다른 팀원 계정입니다. 이 팀원을 지우고 다른 아이디로 다시 추가해 주세요`);
      ok = false;
    } else if (r.ok) {
      const first = !loginAdded;
      if (first) say(job, `로그인 서버에 팀원 계정 ${m.id} 를 만들었습니다`);
      else say(job, `로그인 서버: ${m.id} 가 쓸 수 있는 연결을 맞췄습니다(${allowed.length}개)`);
      loginAdded = true;
      // 처음 만든 계정은 초대 키를 함께 낸다 — 팀원이 로그인 페이지에서 비밀번호·OTP 를 직접 등록한다
      if (first && !(await issueInvite(job, m))) ok = false;
    } else {
      say(job, `로그인 서버 계정을 맞추지 못했습니다 — ${r.text}`);
      ok = false;
    }
  } else if (loginAdded && dropped.length) {
    const r = await gate(`member-links ${m.id} --links ''`);
    if (!r.ok) ok = false;
  }
  // 같이 보기 열쇠(10-25 명시 지시 5) — 열쇠 주인이 그 팀원이라 웹 계정이 있어야 만든다. 계정을 맞춘 뒤 서버마다(있으면 그대로)
  if (loginAdded) for (const server of m.servers) if (applied.has(server) && !(await shareKeyOn(job, m, server))) ok = false;
  for (const server of dropped) {
    say(job, `${server}: 이 서버에 팀원 프로젝트가 더 없어 그 서버의 팀원 Paseo 를 지웁니다(/home/${m.id} 는 남김)`);
    // 그 서버의 마지막 팀원 프로젝트를 뺀 것 — 묻지 않고 되돌릴 수 있는 쪽(홈 유지)으로 지운다
    const r = await ssh(server, `${CTL} remove ${m.id} --home keep --json`, 180_000);
    const j = lastJson(r.out);
    if (!j?.ok) {
      say(job, `${server}: 지우지 못했습니다 — ${failText(j, r)}`);
      ok = false;
      continue;
    }
    applied.delete(server);
    if (links[server]) {
      const g = await gate(`link-remove ${links[server]}`);
      if (g.ok) delete links[server];
      else ok = false;
    }
    // 그 서버 팀원 Paseo 의 같이 보기 열쇠도 거둔다(없으면 그냥 지나감)
    if (!(await gate(`push-origin-remove ${shareKeyName(server, m.id)}`)).ok) say(job, `${server}: 같이 보기 열쇠를 지우지 못했습니다(로그인 서버 관리 화면에서 지울 수 있습니다)`);
    say(job, `${server}: 지웠습니다(그 서버에 다시 팀원 프로젝트를 넣으면 같은 아이디·같은 홈으로 다시 만듭니다)`);
  }
  if (!m.servers.length && !dropped.length) say(job, "아직 팀원 프로젝트가 없어 서버에 만들 것이 없습니다 — \"팀원 프로젝트 관리\" 탭에서 프로젝트를 넣으면 그 서버에 만들어집니다");
  await recordJob(m.id, m.rev, { applied: [...applied], links, loginAdded, complete: ok });
  return ok;
}

/** 서버 도구가 돌려준 건너뛴 팀원판("skills/이름"·"commands/이름")을 "스킬 …· 명령어 …" 로 */
function keptText(v: unknown): string {
  const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const pick = (field: string) => items.filter((x) => x.startsWith(field + "/")).map((x) => x.slice(field.length + 1));
  return [
    ["스킬", pick("skills")],
    ["명령어", pick("commands")],
  ]
    .filter(([, names]) => names.length)
    .map(([label, names]) => `${label} ${(names as string[]).join(", ")}`)
    .join(" · ");
}

/** 서버 도구 결과(j.result) 안의 칸 — 응답 모양은 {"ok": true, "result": {...}}(ctl.py main) */
const resultField = (j: Record<string, unknown> | null, key: string): unknown =>
  j && j.result && typeof j.result === "object" ? (j.result as Record<string, unknown>)[key] : undefined;

const STANDARD_LABELS: Record<string, string> = {
  "commands/korean-rule": "규칙",
  "commands/start": "시작",
  "commands/finish": "마무리",
  "skills/start_compact": "압축 준비",
  "hooks/ask_watch": "글 질문 막기",
  "hooks/narrate_watch": "진행 알림 감시",
};

/** 표준판 넣기 결과(ctl.install_standard — 10-21) 한 줄. onlyChanges 면 새로 넣거나 더한 것이 없을 때 "" */
function standardText(v: unknown, onlyChanges = false): string {
  if (!v || typeof v !== "object") return "";
  const s = v as { callName?: unknown; installed?: unknown; existing?: unknown; hooksAdded?: unknown };
  const names = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is string => typeof k === "string").map((k) => STANDARD_LABELS[k] ?? k) : []);
  const installed = names(s.installed);
  const existing = names(s.existing);
  const hooks = s.hooksAdded === null ? "훅 설정이 JSON 이 아니라 손대지 않음" : typeof s.hooksAdded === "number" && s.hooksAdded > 0 ? `훅 ${s.hooksAdded}묶음 더함` : "";
  if (onlyChanges && !installed.length && !hooks) return "";
  return [
    `표준판(부를 이름 "${typeof s.callName === "string" ? s.callName : "?"}")`,
    installed.length ? `새로 넣음: ${installed.join("·")}` : "",
    existing.length ? `이미 있어 그대로: ${existing.join("·")}` : "",
    hooks,
  ]
    .filter(Boolean)
    .join(" — ");
}

async function skillsJob(job: Job, m: TeamMember): Promise<boolean> {
  let ok = true;
  if (!m.applied.length) {
    say(job, "아직 서버에 만들지 않은 팀원입니다 — 먼저 서버에 반영하세요");
    return false;
  }
  for (const server of m.applied) {
    if (!SAFE_HOST.test(server)) throw new Error(`서버 이름 형식 오류: ${server}`);
    say(job, `${server}: 스킬·명령어를 서버 원본으로 다시 복사합니다(팀원판으로 적어 둔 것은 건너뜀 · 팀원이 고친 나머지는 서버 백업으로)`);
    const r = await ssh(server, `${CTL} skills-sync ${m.id} --json`, 180_000);
    const j = lastJson(r.out);
    if (!j?.ok) {
      say(job, `${server}: 실패 — ${failText(j, r)}`);
      ok = false;
    } else {
      const kept = keptText(resultField(j, "memberCopiesKept"));
      say(job, kept ? `${server}: 다시 맞췄습니다 — 팀원판이라 건너뜀: ${kept}` : `${server}: 다시 맞췄습니다`);
      const standard = standardText(resultField(j, "standard"), true);
      if (standard) say(job, `${server}: ${standard}`);
    }
  }
  return ok;
}

async function removeJob(job: Job, m: TeamMember, home: "keep" | "purge"): Promise<boolean> {
  const applied = new Set(m.applied);
  const links = { ...m.links };
  let ok = true;
  for (const server of [...applied]) {
    if (!SAFE_HOST.test(server)) throw new Error(`서버 이름 형식 오류: ${server}`);
    say(
      job,
      home === "purge"
        ? `${server}: 팀원 Paseo 를 완전히 지웁니다(설정·대화 기록·/home/${m.id} 까지)`
        : `${server}: 팀원 Paseo 를 지웁니다(/home/${m.id} 는 남김, 설정·대화 기록은 서버 백업으로)`,
    );
    const r = await ssh(server, `${CTL} remove ${m.id} --home ${home} --json`, 180_000);
    const j = lastJson(r.out);
    if (!j?.ok) {
      say(job, `${server}: 지우지 못했습니다 — ${failText(j, r)}`);
      ok = false;
      continue;
    }
    applied.delete(server);
  }
  if (m.loginAdded) {
    const r = await gate(`member-remove ${m.id}`);
    if (r.ok || /NO_MEMBER|없/.test(`${r.code} ${r.text}`)) say(job, `로그인 서버: 팀원 계정 ${m.id} 를 지웠습니다`);
    else {
      say(job, `로그인 서버 계정을 지우지 못했습니다 — ${r.text}`);
      ok = false;
    }
  }
  for (const [server, link] of Object.entries(links)) {
    const r = await gate(`link-remove ${link}`);
    if (r.ok || /NO_LINK|없/.test(`${r.code} ${r.text}`)) delete links[server];
    else ok = false;
  }
  // 같이 보기 열쇠도 거둔다(10-25 — 없으면 그냥 지나감)
  for (const server of m.applied) {
    if (!(await gate(`push-origin-remove ${shareKeyName(server, m.id)}`)).ok) say(job, `${server}: 같이 보기 열쇠를 지우지 못했습니다(로그인 서버 관리 화면에서 지울 수 있습니다)`);
  }
  if (!ok) {
    await recordJob(m.id, m.rev, { applied: [...applied], links, loginAdded: m.loginAdded, complete: false });
    return false;
  }
  const done = await removeMember(m.id, true);
  if (!done.ok) say(job, `팀원 목록에서 지우지 못했습니다 — ${done.error}`);
  else say(job, `팀원 목록에서 ${m.id} 를 지웠습니다`);
  return done.ok;
}
