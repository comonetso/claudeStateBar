import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectEntry } from "../shared/projects";
import type { TeamJobAction, TeamMember } from "../shared/team";
import { defaultAccess, type AfterResult } from "../shared/teamAccess";
import { SAFE_HOST, sshExe } from "./projectLabels";
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
function ordered(m: TeamMember): ProjectEntry[] {
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
 * 서버 한 대에 보낼 spec(10-11 저녁 리규형님 "계정 만들 때 설정 먼저") — 홈은 쓰기 · 그 서버의 팀원 프로젝트는 읽기만이고
 * 권한의 "풀권한 폴더"만 쓰기·"계정파일만 폴더"는 서버 도구의 add(프로젝트 자체를 적으면 프로젝트 전체 쓰기) · 고른 기록은 읽기만 · 적은 포트만 열기 ·
 * 비밀 파일 가리기 · 그 서버에서 고른 스킬·명령어. outside = 팀원 프로젝트 밖이라 뺀 풀권한·계정파일만 폴더
 */
export function specFor(m: TeamMember, server: string): { spec: Record<string, unknown>; skipped: string[]; outside: string[] } {
  const home = `/home/${m.id}`;
  const projects = ordered(m).filter((p) => p.host === server);
  const access = m.access?.[server] ?? defaultAccess();
  const under = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
  const mounts: { path: string; mode: "rw" | "ro" | "add" }[] = [{ path: home, mode: "rw" }];
  const addOnly = access.addOnly ?? [];
  for (const p of projects)
    if (!mounts.some((x) => x.path === p.path))
      mounts.push({ path: p.path, mode: access.writable.includes(p.path) ? "rw" : addOnly.includes(p.path) ? "add" : "ro" });
  const outside: string[] = [];
  // 풀권한 폴더 → 계정파일만 폴더(10-12) 차례. 둘 다 팀원 프로젝트 안이어야 한다
  for (const [list, mode] of [[access.writable, "rw"], [addOnly, "add"]] as const) {
    for (const w of list) {
      // 홈 안은 이미 쓰기, 프로젝트 자체는 위에서 넣었다
      if (under(w, home) || mounts.some((x) => x.path === w)) continue;
      if (!projects.some((p) => under(w, p.path))) {
        outside.push(w);
        continue;
      }
      mounts.push({ path: w, mode });
    }
  }
  for (const l of access.logs) if (!mounts.some((x) => x.path === l)) mounts.push({ path: l, mode: "ro" });
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
    mounts,
    skills,
    commands,
    net: { allowLocalPorts: [...access.ports] },
    projects: projects.map((p) => ({ name: p.name, category: p.category, path: p.path, enabled: p.enabled })),
    // 가릴 때만 싣는다 — 옛 서버 팀원 도구는 이 칸을 모르면 반영을 멈춘다(가리라고 했는데 안 가린 채 켜지지 않게)
    ...(access.hideSecrets ? { hideSecrets: true } : {}),
  };
  return { spec, skipped, outside };
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

/** 서버 한 대에 팀원 Paseo 만들기·고치기 */
async function applyOn(job: Job, m: TeamMember, server: string): Promise<boolean> {
  const { spec, skipped, outside } = specFor(m, server);
  if (skipped.length) say(job, `${server}: 하위 폴더 명령어·이름 규칙에 안 맞는 것은 넣지 못합니다 — ${skipped.join(", ")}`);
  if (outside.length) say(job, `${server}: 풀권한·계정파일만 폴더 중 팀원 프로젝트 밖이라 뺀 것 — ${outside.join(", ")} (팀원 프로젝트를 먼저 넣으면 다음 반영 때 열립니다)`);
  say(job, `${server}: 팀원 Paseo 만들기·고치기 — 홈 /home/${m.id}, 프로젝트 ${(spec.projects as unknown[]).length}개, 스킬·명령어 ${(spec.skills as string[]).length + (spec.commands as string[]).length}개`);
  const mounts = spec.mounts as { path: string; mode: string }[];
  const ports = (spec.net as { allowLocalPorts: number[] }).allowLocalPorts;
  say(job, `${server}: 권한 — 풀권한 ${mounts.filter((x) => x.mode === "rw").map((x) => x.path).join(", ")} · 계정파일만 ${mounts.filter((x) => x.mode === "add").map((x) => x.path).join(", ") || "없음"} · 읽기만 ${mounts.filter((x) => x.mode === "ro").map((x) => x.path).join(", ") || "없음"} · 열 포트 ${ports.join(", ") || "없음"} · 비밀 파일 ${spec.hideSecrets ? "가림" : "그대로"}`);
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
  return true;
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

async function gate(args: string): Promise<{ ok: boolean; text: string; code: string }> {
  const r = await ssh(LOGIN_HOST, `${GATE} ${args} --json`);
  const j = lastJson(r.out);
  return { ok: j?.ok === true, text: failText(j, r), code: typeof j?.error === "string" ? j.error : "" };
}

/** 출력 끝 몇 줄만 — 화면에 보이고 팀원 기록 파일에 남는다 */
function tail(out: string): string {
  const lines = out.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  return lines.slice(-3).join("\n").slice(-300);
}

/**
 * 계정을 만든 뒤 실행할 명령(10-12 리규형님) — 그 서버에서 관리자 권한으로, 아직 성공한 적 없는 것만 적은 차례대로.
 * 실패하면 그 서버의 나머지는 멈추고 다음 반영 때 그 명령부터 다시 한다. 끝나면 명령이 팀원 홈에 만든 파일을 팀원 소유로
 * 돌린다(관리자 소유로 남으면 다음 반영의 권한 검사에 걸릴 수 있다)
 */
async function runAfter(job: Job, m: TeamMember, server: string): Promise<AfterResult[]> {
  const done = new Set((m.afterRan?.[server] ?? []).filter((r) => r.ok).map((r) => r.command));
  const pending = (m.after?.[server] ?? []).filter((c) => !done.has(c));
  const results: AfterResult[] = [];
  if (!pending.length) return results;
  say(job, `${server}: 생성 뒤 실행 명령어 ${pending.length}개를 실행합니다`);
  for (const command of pending) {
    const r = await ssh(server, `( ${command} ) 2>&1`, 120_000);
    const ok = r.code === 0;
    const out = tail(r.out);
    results.push({ command, ok, code: r.code, out, at: Date.now() });
    say(job, `${server}: ${ok ? "실행함" : `실패(종료 코드 ${r.code ?? "시간 초과"})`} — ${command}${out ? ` · ${out.replace(/\n/g, " / ")}` : ""}`);
    if (!ok) {
      say(job, `${server}: 나머지 명령은 멈췄습니다 — 고쳐서 저장하면 다음 반영 때 이 명령부터 다시 합니다`);
      break;
    }
  }
  await ssh(server, `chown -Rh --reference=/home/${m.id} /home/${m.id}`);
  return results;
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
    let r = loginAdded ? await gate(`member-links ${m.id} --links ${allowed.join(",")}`) : await gate(`member-add ${m.id} --links ${allowed.join(",")}`);
    if (!loginAdded && !r.ok && /EXIST|이미/.test(`${r.code} ${r.text}`)) r = await gate(`member-links ${m.id} --links ${allowed.join(",")}`);
    if (r.ok) {
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
  for (const server of dropped) {
    say(job, `${server}: 더 이상 고르지 않은 서버라 지웁니다`);
    // 팀원 고치기에서 서버를 뺀 것 — 묻지 않고 되돌릴 수 있는 쪽(홈 유지)으로 지운다
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
    say(job, `${server}: 지웠습니다(같은 아이디는 그 서버에서 다시 쓸 수 없습니다)`);
  }
  // 모든 단계가 끝난 뒤에만(10-12 리규형님 "모두 완료 후에") — 지금 고른 서버 중 만들어진 서버마다
  const afterRan: Record<string, AfterResult[]> = {};
  if (ok) {
    for (const server of m.servers) {
      if (!applied.has(server)) continue;
      const results = await runAfter(job, m, server);
      if (results.length) afterRan[server] = results;
    }
  }
  await recordJob(m.id, m.rev, { applied: [...applied], links, loginAdded, complete: ok, afterRan });
  return ok;
}

async function skillsJob(job: Job, m: TeamMember): Promise<boolean> {
  let ok = true;
  if (!m.applied.length) {
    say(job, "아직 서버에 만들지 않은 팀원입니다 — 먼저 서버에 반영하세요");
    return false;
  }
  for (const server of m.applied) {
    if (!SAFE_HOST.test(server)) throw new Error(`서버 이름 형식 오류: ${server}`);
    say(job, `${server}: 스킬·명령어를 서버 원본으로 다시 복사합니다(팀원이 고친 것은 서버 백업으로)`);
    const r = await ssh(server, `${CTL} skills-sync ${m.id} --json`, 180_000);
    const j = lastJson(r.out);
    if (!j?.ok) {
      say(job, `${server}: 실패 — ${failText(j, r)}`);
      ok = false;
    } else say(job, `${server}: 다시 맞췄습니다`);
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
  if (!ok) {
    await recordJob(m.id, m.rev, { applied: [...applied], links, loginAdded: m.loginAdded, complete: false });
    return false;
  }
  const done = await removeMember(m.id, true);
  if (!done.ok) say(job, `팀원 목록에서 지우지 못했습니다 — ${done.error}`);
  else say(job, `팀원 목록에서 ${m.id} 를 지웠습니다`);
  return done.ok;
}
