import { renameRetry } from "./renameRetry";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { ProjectEntry, ProjectsEditOp } from "../shared/projects";
import type { TeamMember } from "../shared/team";
import { AFTER_LEN, AFTER_MAX, defaultAccess, TEAM_LOGS, type AfterResult, type TeamAccess } from "../shared/teamAccess";

// 팀원 목록과 팀원 전용 프로젝트(10-11 리규형님: 리규형님 목록과 따로, 팀원 → 그 팀원의 카테고리 → 프로젝트).
// PC 데몬의 플러그인 전용 파일 하나에 둔다. 서버에 팀원을 만들거나 폴더를 건드리는 일은 여기서 하지 않는다(뒷단 작업 때).
// 모양: { members: [{ id, servers, skills, categoryOrder, projects: [{ name, category, enabled, host, path }] }] }

const FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "team.json");

/** 서버 팀원 도구(team-daemon lib/policy.py NAME)와 같은 규칙 — 이 아이디로 서버 계정을 만든다 */
const ID_RULE = /^[a-z][a-z0-9-]{0,30}$/;

type Result = { ok: boolean; error?: string; members: TeamMember[] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function toProject(v: unknown): ProjectEntry | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.host !== "string" || typeof o.path !== "string") return null;
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name : posix.basename(o.path) || o.path,
    category: typeof o.category === "string" ? o.category.trim() : "",
    enabled: o.enabled !== false,
    host: o.host,
    path: o.path,
  };
}

/** 서버 팀원 도구(policy.py PATH)와 같은 경로 글자 규칙 */
const PATH_RULE = /^\/[A-Za-z0-9_./-]+$/;
/** 서버 팀원 도구가 열지 않는 포트 — 리규형님·팀원 Paseo(policy.py validate_spec) */
const reservedPort = (p: number) => p === 6767 || p === 6768 || p === 6799 || (p >= 6800 && p <= 6899);

/** 저장된 권한 하나 — 모양이 틀린 칸은 기본값으로(검사는 저장할 때 cleanAccess) */
function toAccess(v: unknown): TeamAccess {
  const o = v as Record<string, unknown> | null;
  const base = defaultAccess();
  if (!o || typeof o !== "object") return base;
  return {
    writable: strings(o.writable),
    addOnly: strings(o.addOnly),
    ports: Array.isArray(o.ports) ? o.ports.filter((x): x is number => Number.isInteger(x)) : base.ports,
    logs: strings(o.logs),
    hideSecrets: typeof o.hideSecrets === "boolean" ? o.hideSecrets : base.hideSecrets,
  };
}

/** 화면에서 온 권한을 서버 팀원 도구가 받는 규칙으로 검사한다 — 틀리면 이유 글 */
function cleanAccess(server: string, a: TeamAccess): TeamAccess | string {
  const writable: string[] = [];
  for (const raw of a.writable) {
    const p = raw.trim().replace(/\/+$/, "");
    if (!p) continue;
    if (!PATH_RULE.test(p) || posix.normalize(p) !== p || p === "/" || p === "/home")
      return `${server} 풀권한 폴더 "${raw}" — / 로 시작하는 절대 경로(영문·숫자·_ . - /)만 쓸 수 있습니다`;
    if (!writable.includes(p)) writable.push(p);
  }
  // 계정파일만 폴더(10-12, 서버 도구의 add) — 풀권한 폴더와 같은 경로 규칙. 풀권한 폴더와 안팎으로 겹치면 서버 도구가 거절하므로 여기서 먼저 알린다
  const addOnly: string[] = [];
  for (const raw of a.addOnly ?? []) {
    const p = raw.trim().replace(/\/+$/, "");
    if (!p) continue;
    if (!PATH_RULE.test(p) || posix.normalize(p) !== p || p === "/" || p === "/home")
      return `${server} 계정파일만 폴더 "${raw}" — / 로 시작하는 절대 경로(영문·숫자·_ . - /)만 쓸 수 있습니다`;
    const clash = writable.find((w) => w === p || w.startsWith(`${p}/`) || p.startsWith(`${w}/`));
    if (clash) return `${server} 계정파일만 폴더 "${p}" 가 풀권한 폴더 "${clash}" 와 겹칩니다 — 한쪽에만 적어 주세요`;
    if (!addOnly.includes(p)) addOnly.push(p);
  }
  const ports: number[] = [];
  for (const p of a.ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) return `${server} 열 포트 "${p}" — 1~65535 숫자만 쓸 수 있습니다`;
    if (reservedPort(p)) return `${server} 열 포트 ${p} — Paseo 가 쓰는 포트라 열 수 없습니다(6767·6768·6799·6800~6899)`;
    if (!ports.includes(p)) ports.push(p);
  }
  if (ports.length > 16) return `${server} 열 포트는 16개까지입니다`;
  const known = TEAM_LOGS.map((l) => l.path as string);
  const logs = [...new Set(a.logs)];
  const odd = logs.find((l) => !known.includes(l));
  if (odd) return `${server} 기록 "${odd}" — 고를 수 있는 기록이 아닙니다`;
  return { writable, addOnly, ports: ports.sort((x, y) => x - y), logs, hideSecrets: a.hideSecrets };
}

/** 저장된 실행 결과 하나 — 모양이 틀리면 버린다 */
function toAfterResult(v: unknown): AfterResult | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.command !== "string" || typeof o.ok !== "boolean") return null;
  return { command: o.command, ok: o.ok, code: typeof o.code === "number" ? o.code : null, out: typeof o.out === "string" ? o.out : "", at: typeof o.at === "number" ? o.at : 0 };
}

/** 서버 → 값 목록 칸 하나를 읽는다(모양이 틀린 것은 버린다) */
function perServer<T>(v: unknown, each: (x: unknown) => T | null): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) out[k] = list.map(each).filter((x): x is T => x !== null);
  }
  return out;
}

/** 만든 뒤 실행할 명령을 검사한다 — 빈 칸은 버리고, 한 줄 명령만·길이·개수 제한. 틀리면 이유 글 */
function cleanAfter(server: string, list: string[]): string[] | string {
  const out: string[] = [];
  for (const raw of list) {
    const cmd = raw.trim();
    if (!cmd) continue;
    if (/[\r\n]/.test(cmd)) return `${server} 생성 뒤 실행 명령어 — 한 칸에 한 줄만 쓸 수 있습니다(여러 줄은 칸을 추가)`;
    if (cmd.length > AFTER_LEN) return `${server} 생성 뒤 실행 명령어 — 한 줄에 ${AFTER_LEN}자까지입니다`;
    if (!out.includes(cmd)) out.push(cmd);
  }
  if (out.length > AFTER_MAX) return `${server} 생성 뒤 실행 명령어는 ${AFTER_MAX}개까지입니다`;
  return out;
}

async function readTeam(): Promise<TeamMember[]> {
  let text: string;
  try {
    text = await readFile(FILE, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { members?: unknown };
    if (Array.isArray(parsed?.members)) {
      const out: TeamMember[] = [];
      for (const m of parsed.members as Record<string, unknown>[]) {
        if (!m || typeof m.id !== "string") continue;
        const links: Record<string, string> = {};
        if (m.links && typeof m.links === "object" && !Array.isArray(m.links)) {
          for (const [k, v] of Object.entries(m.links as Record<string, unknown>)) if (typeof v === "string") links[k] = v;
        }
        const access: Record<string, TeamAccess> = {};
        if (m.access && typeof m.access === "object" && !Array.isArray(m.access)) {
          for (const [k, v] of Object.entries(m.access as Record<string, unknown>)) access[k] = toAccess(v);
        }
        out.push({
          id: m.id,
          servers: strings(m.servers),
          skills: strings(m.skills),
          categoryOrder: strings(m.categoryOrder),
          projects: (Array.isArray(m.projects) ? m.projects : []).map(toProject).filter((p): p is ProjectEntry => p !== null),
          access,
          after: perServer(m.after, (x) => (typeof x === "string" ? x : null)),
          afterRan: perServer(m.afterRan, toAfterResult),
          applied: strings(m.applied),
          links,
          loginAdded: m.loginAdded === true,
          dirty: m.dirty !== false,
          rev: typeof m.rev === "number" ? m.rev : 0,
        });
      }
      return out;
    }
  } catch {
    /* 아래에서 옆에 남긴다 */
  }
  // 깨진 파일은 다음 쓰기가 덮기 전에 옆에 남긴다(무엇이 있었는지 볼 수 있게)
  await rename(FILE, `${FILE}.broken`).catch(() => {});
  return [];
}

// 고치기와 쓰기는 한 줄로 — 빠르게 두 번 눌러도 한쪽이 사라지지 않게(projectsOrder 와 같은 방식)
let writing: Promise<unknown> = Promise.resolve();

/** 파일을 읽어 change 로 고친 뒤 쓴다. change 가 글을 돌려주면 그 이유로 멈추고 쓰지 않는다 */
function changeTeam(change: (members: TeamMember[]) => string | null): Promise<Result> {
  const run = async (): Promise<Result> => {
    const members = await readTeam();
    const problem = change(members);
    if (problem) return { ok: false, error: problem, members: await readTeam() };
    await mkdir(dirname(FILE), { recursive: true });
    // 임시 파일에 다 쓴 뒤 바꿔 끼운다 — 쓰다 끊겨도 반쯤 쓴 파일이 남지 않는다
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ members }, null, "\t"), "utf8");
    await renameRetry(tmp, FILE);
    return { ok: true, members };
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}

/** 서버 반영 뒤 바뀐 것이 있다고 표시한다(반영 작업 중이면 끝날 때 다시 반영 필요로 남는다) */
function touched(m: TeamMember): void {
  m.rev += 1;
  m.dirty = true;
}

export async function teamStateRead(): Promise<Result> {
  return { ok: true, members: await readTeam() };
}

export function saveMember(input: {
  previousId: string | null;
  id: string;
  servers: string[];
  skills: string[];
  access?: Record<string, TeamAccess>;
  after?: Record<string, string[]>;
}): Promise<Result> {
  const id = input.id.trim();
  const servers = [...new Set(input.servers)];
  return changeTeam((members) => {
    if (!ID_RULE.test(id)) return "아이디는 영문 소문자로 시작하고 영문 소문자·숫자·- 만, 31자까지 쓸 수 있습니다";
    if (servers.length === 0) return "서버를 하나 이상 골라 주세요";
    // 고른 서버마다 권한 — 화면이 안 보낸 서버는 기본값(쓰기 없음·포트 없음·기록 없음·비밀 가림), 빠진 서버 것은 버린다
    const access: Record<string, TeamAccess> = {};
    for (const s of servers) {
      const clean = cleanAccess(s, input.access?.[s] ?? defaultAccess());
      if (typeof clean === "string") return clean;
      access[s] = clean;
    }
    // 만든 뒤 실행할 명령(10-12) — 고른 서버 것만. 빈 서버는 칸을 두지 않는다
    const after: Record<string, string[]> = {};
    for (const s of servers) {
      const clean = cleanAfter(s, input.after?.[s] ?? []);
      if (typeof clean === "string") return clean;
      if (clean.length) after[s] = clean;
    }
    if (members.some((m) => m.id === id && m.id !== input.previousId)) return "같은 아이디가 이미 있습니다";
    const at = input.previousId ? members.findIndex((m) => m.id === input.previousId) : -1;
    if (input.previousId && at < 0) return "고치려던 팀원을 찾지 못했습니다";
    if (at >= 0) {
      // 팀원 프로젝트가 있는 서버를 빼면 그 프로젝트의 기기가 사라진다 — 프로젝트를 먼저 지우거나 옮기게
      const orphan = members[at].projects.find((p) => !servers.includes(p.host));
      if (orphan) return `${orphan.host} 에 이 팀원의 프로젝트("${orphan.name}")가 있어 그 서버를 뺄 수 없습니다`;
      // 서버에 만든 팀원은 이름이 서버 계정·로그인 계정에 박혀 있다 — 지우고 새로 추가해야 한다
      if (members[at].applied.length > 0 && id !== input.previousId) return "서버에 만든 뒤에는 아이디를 바꿀 수 없습니다 — 지우고 새로 추가해 주세요";
      // 빠진 서버의 실행 결과는 버린다 — 다시 고르면 새로 만든 계정이라 다시 실행한다
      const afterRan = Object.fromEntries(Object.entries(members[at].afterRan ?? {}).filter(([s]) => servers.includes(s)));
      members[at] = { ...members[at], id, servers, skills: input.skills, access, after, afterRan };
      touched(members[at]);
    } else {
      members.push({ id, servers, skills: input.skills, categoryOrder: [], projects: [], access, after, afterRan: {}, applied: [], links: {}, loginAdded: false, dirty: true, rev: 1 });
    }
    return null;
  });
}

/** 팀원 목록에서 지운다 — 서버에 만든 팀원은 서버 작업(remove)이 서버·로그인 서버를 먼저 지운 뒤에만(fromJob) */
export function removeMember(id: string, fromJob = false): Promise<Result> {
  return changeTeam((members) => {
    const at = members.findIndex((m) => m.id === id);
    if (at < 0) return "그 팀원을 찾지 못했습니다";
    if (!fromJob && (members[at].applied.length > 0 || members[at].loginAdded)) return "서버에 만든 팀원은 서버에서 먼저 지웁니다";
    members.splice(at, 1);
    return null;
  });
}

/** 서버 작업 결과를 적는다. 작업을 시작한 뒤 또 바뀌었으면(rev) 반영 필요 표시를 남긴다 */
export function recordJob(
  id: string,
  rev: number,
  patch: { applied: string[]; links: Record<string, string>; loginAdded: boolean; complete: boolean; afterRan?: Record<string, AfterResult[]> },
): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === id);
    if (!m) return "그 팀원을 찾지 못했습니다";
    m.applied = patch.applied;
    m.links = patch.links;
    m.loginAdded = patch.loginAdded;
    // 실행 결과는 명령마다 마지막 것 하나 — 이번에 실행한 명령만 바꾸고 나머지는 둔다
    for (const [server, results] of Object.entries(patch.afterRan ?? {})) {
      const kept = (m.afterRan?.[server] ?? []).filter((r) => !results.some((x) => x.command === r.command));
      m.afterRan = { ...(m.afterRan ?? {}), [server]: [...kept, ...results] };
    }
    m.dirty = !patch.complete || m.rev !== rev;
    return null;
  });
}

export async function memberSnapshot(id: string): Promise<TeamMember | null> {
  return (await readTeam()).find((m) => m.id === id) ?? null;
}

export function setMemberCategoryOrder(memberId: string, names: string[]): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) return "그 팀원을 찾지 못했습니다";
    m.categoryOrder = names.filter((n, i) => n && names.indexOf(n) === i);
    touched(m);
    return null;
  });
}

/** 서버 경로만(팀원 프로젝트는 서버에만 둔다) — 대소문자를 구분하고 끝 / 만 뗀다 */
const cleanPath = (input: string) => posix.normalize(input).replace(/(.)\/+$/, "$1");
const keyOf = (p: ProjectEntry) => `${p.host}|${cleanPath(p.path)}`;
const sameKey = (a: string, b: string) => {
  const bar = (k: string) => k.indexOf("|");
  return a.slice(0, bar(a)) === b.slice(0, bar(b)) && cleanPath(a.slice(bar(a) + 1)) === cleanPath(b.slice(bar(b) + 1));
};

/** 프로젝트 관리 화면(server/projectsEdit)과 같은 고치기를 한 팀원의 팀원 프로젝트에 */
export function editMemberProjects(memberId: string, op: ProjectsEditOp): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) return "그 팀원을 찾지 못했습니다";
    const problem = editProjectList(m, op);
    if (!problem) touched(m);
    return problem;
  });
}

function editProjectList(m: TeamMember, op: ProjectsEditOp): string | null {
  {
    const list = m.projects;
    const find = (key: string) => list.findIndex((p) => sameKey(keyOf(p), key));
    switch (op.op) {
      case "rename": {
        const name = op.name.trim();
        if (!name) return "이름이 비어 있습니다";
        const i = find(op.key);
        if (i < 0) return "그 프로젝트를 찾지 못했습니다";
        list[i].name = name;
        return null;
      }
      case "category": {
        const i = find(op.key);
        if (i < 0) return "그 프로젝트를 찾지 못했습니다";
        const category = op.category.trim();
        if (list[i].category === category) return null;
        // 옮긴 프로젝트는 그 묶음 맨 아래(프로젝트 관리 화면 10-10 결정과 같게)
        const [p] = list.splice(i, 1);
        p.category = category;
        list.push(p);
        return null;
      }
      case "enabled": {
        const i = find(op.key);
        if (i < 0) return "그 프로젝트를 찾지 못했습니다";
        list[i].enabled = op.enabled;
        return null;
      }
      case "remove": {
        const i = find(op.key);
        if (i < 0) return "그 프로젝트를 찾지 못했습니다";
        list.splice(i, 1);
        return null;
      }
      case "add": {
        const host = op.host.trim();
        const input = op.path.trim();
        if (!host) return "디바이스를 고르세요";
        if (!m.servers.includes(host)) return `${host} 는 이 팀원에게 고른 서버가 아닙니다 — 팀원 추가 탭에서 서버를 먼저 넣어 주세요`;
        if (!input) return "경로가 비어 있습니다";
        if (!input.startsWith("/")) return "서버 경로는 / 로 시작해야 합니다";
        const path = cleanPath(input);
        // 팀원 홈은 기본 프로젝트로 늘 맨 위에 있다(10-11 리규형님 "삭제 불가, 항상 최상위" — 서버 팀원 도구가 넣는다)
        if (path === `/home/${m.id}`) return "팀원 홈은 기본 프로젝트로 이미 맨 위에 있습니다";
        if (find(`${host}|${path}`) >= 0) return "이미 이 팀원의 목록에 있는 프로젝트입니다";
        list.push({ name: op.name.trim() || posix.basename(path) || path, category: op.category.trim(), enabled: true, host, path });
        return null;
      }
      case "renameCategory": {
        const from = op.from.trim();
        const to = op.to.trim();
        if (!to) return "카테고리 이름이 비어 있습니다";
        if (from === to) return null;
        let n = 0;
        for (const p of list) {
          if (p.category === from) {
            p.category = to;
            n++;
          }
        }
        if (!n) return "그 카테고리를 찾지 못했습니다";
        // 순서도 새 이름으로 — 이미 있는 이름이면 두 묶음이 합쳐지고 그쪽 자리를 쓴다
        m.categoryOrder = m.categoryOrder.includes(to) ? m.categoryOrder.filter((c) => c !== from) : m.categoryOrder.map((c) => (c === from ? to : c));
        return null;
      }
      case "deleteCategory": {
        const name = op.name.trim();
        let n = 0;
        for (const p of list) {
          if (p.category === name) {
            p.category = "";
            n++;
          }
        }
        if (!n) return "그 카테고리를 찾지 못했습니다";
        m.categoryOrder = m.categoryOrder.filter((c) => c !== name);
        return null;
      }
    }
  }
  return null;
}
