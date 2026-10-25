import { renameRetry } from "./renameRetry";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { ProjectsEditOp } from "../shared/projects";
import type { TeamMember, TeamProject } from "../shared/team";
import { callNameProblem } from "../shared/teamStandard";
import { cleanProjectAccess, combineAccess, defaultProjectAccess, type FileMode, type LegacyAccess, type ProjectAccess } from "../shared/teamAccess";
import { SAFE_HOST } from "./projectLabels";

// 팀원 목록과 팀원 전용 프로젝트(10-11 리규형님: 리규형님 목록과 따로, 팀원 → 그 팀원의 카테고리 → 프로젝트).
// PC 데몬의 플러그인 전용 파일 하나에 둔다. 서버에 팀원을 만들거나 폴더를 건드리는 일은 여기서 하지 않는다(server/teamApply).
// 10-20 리규형님 "팀원 관리 새로": 팀원은 아이디·스킬만, 권한은 팀원 프로젝트마다(project.access), 서버는 팀원 프로젝트에서 센다.
// 모양: { members: [{ id, servers, skills, categoryOrder, projects: [{ name, category, enabled, host, path, access }], applied, links, … }] }

const FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "team.json");

/** 서버 팀원 도구(team-daemon lib/policy.py NAME)와 같은 규칙 — 이 아이디로 서버 계정을 만든다 */
const ID_RULE = /^[a-z][a-z0-9-]{0,30}$/;

type Result = { ok: boolean; error?: string; members: TeamMember[] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const MODES: readonly FileMode[] = ["ro", "rw"];
const toMode = (v: unknown): FileMode => (MODES.includes(v as FileMode) ? (v as FileMode) : "ro");

/** 저장된 권한 하나 — 모양이 틀린 칸은 기본값으로(검사는 저장할 때 cleanProjectAccess) */
function toProjectAccess(v: unknown): ProjectAccess | undefined {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return undefined;
  return {
    file: toMode(o.file),
    outside: (Array.isArray(o.outside) ? o.outside : [])
      .map((x) => x as Record<string, unknown> | null)
      .filter((x): x is Record<string, unknown> => !!x && typeof x.path === "string")
      .map((x) => ({ path: x.path as string, mode: toMode(x.mode) })),
    ports: Array.isArray(o.ports) ? o.ports.filter((x): x is number => Number.isInteger(x)) : [],
    logs: strings(o.logs),
    hideSecrets: o.hideSecrets === true,
  };
}

function toProject(v: unknown): TeamProject | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.host !== "string" || typeof o.path !== "string") return null;
  const access = toProjectAccess(o.access);
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name : posix.basename(o.path) || o.path,
    category: typeof o.category === "string" ? o.category.trim() : "",
    enabled: o.enabled !== false,
    host: o.host,
    path: o.path,
    ...(access ? { access } : {}),
  };
}

/** 옛 서버 단위 권한 하나(10-11~10-19 형식) */
function toLegacy(v: unknown): LegacyAccess {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    writable: strings(o.writable),
    addOnly: strings(o.addOnly),
    ports: Array.isArray(o.ports) ? o.ports.filter((x): x is number => Number.isInteger(x)) : [],
    logs: strings(o.logs),
    hideSecrets: o.hideSecrets === true,
  };
}

/**
 * 옛 서버 단위 권한을 프로젝트마다로 옮긴다(10-20 리규형님 "대표님 설정은 지금과 똑같이"). 이미 새 형식(권한이 붙은 프로젝트가 있음)이면 그대로.
 * 프로젝트 경로를 풀권한에 적었으면 읽기쓰기·아니면 읽기만(계정파일만 = 옛 "내가 쓴 파일만"은 10-25 에 없애 읽기만) ·
 * 프로젝트 안 하위 폴더(대표님 보고서함)는 같은 카테고리의 숨긴 팀원 프로젝트로 따로 넣는다(숨김 = 지금처럼 팀원 목록에 안 보임) ·
 * 프로젝트 밖이던 폴더는 옛 반영도 열지 않았으므로 버린다 · 포트·기록·비밀 가리기는 그 서버 첫 프로젝트에(서버 단위로 합쳐지니 결과가 같다)
 */
export function migrateLegacy(id: string, projects: TeamProject[], legacy: Record<string, LegacyAccess>): { projects: TeamProject[]; changed: boolean } {
  if (projects.some((p) => p.access) || Object.keys(legacy).length === 0) return { projects, changed: false };
  const out = projects.map((p) => ({ ...p }));
  const home = `/home/${id}`;
  const under = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
  for (const [server, a] of Object.entries(legacy)) {
    const addOnly = a.addOnly ?? [];
    const own = out.filter((p) => p.host === server);
    for (const p of own) p.access = { ...defaultProjectAccess(), file: a.writable.includes(p.path) ? "rw" : "ro" };
    for (const [list, mode] of [[a.writable, "rw"], [addOnly, "ro"]] as const) {
      for (const path of list) {
        if (under(path, home) || out.some((x) => x.host === server && x.path === path)) continue;
        const parent = own.find((x) => path.startsWith(`${x.path}/`));
        if (!parent) continue;
        out.push({ name: posix.basename(path) || path, category: parent.category, enabled: false, host: server, path, access: { ...defaultProjectAccess(), file: mode } });
      }
    }
    if (own[0]) own[0].access = { ...own[0].access!, ports: [...a.ports], logs: [...a.logs], hideSecrets: a.hideSecrets };
  }
  return { projects: out, changed: true };
}

/** 팀원 프로젝트가 있는 서버 — 프로젝트에 처음 나오는 순서(10-20 부터 고르지 않고 센다) */
function syncServers(m: TeamMember): void {
  m.servers = [...new Set(m.projects.map((p) => p.host))];
}

/** 서버마다 권한을 모아 본다 — 같은 서버 안에서 겹치거나 한도를 넘으면 이유 글 */
function checkServers(m: TeamMember): string | null {
  for (const s of m.servers) {
    const r = combineAccess(`/home/${m.id}`, m.projects.filter((p) => p.host === s));
    if (r.error) return `${s}: ${r.error}`;
  }
  return null;
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
        const legacy: Record<string, LegacyAccess> = {};
        if (m.access && typeof m.access === "object" && !Array.isArray(m.access)) {
          for (const [k, v] of Object.entries(m.access as Record<string, unknown>)) legacy[k] = toLegacy(v);
        }
        const read = (Array.isArray(m.projects) ? m.projects : []).map(toProject).filter((p): p is TeamProject => p !== null);
        const moved = migrateLegacy(m.id, read, legacy);
        const member: TeamMember = {
          id: m.id,
          servers: [],
          skills: strings(m.skills),
          categoryOrder: strings(m.categoryOrder),
          projects: moved.projects,
          // 10-21 전 기록엔 없다 — 그때까지는 모두 회사 공용이었다
          ownClaude: m.ownClaude === true,
          // 10-21 전 기록엔 없다 — 빈 값 = 아이디 + "님"
          callName: typeof m.callName === "string" && !callNameProblem(m.callName) ? m.callName : "",
          applied: strings(m.applied),
          links,
          loginAdded: m.loginAdded === true,
          // 옮겨 온 팀원은 팀원 목록(숨긴 보고서함)이 달라져 한 번 다시 반영해야 맞는다
          dirty: moved.changed || m.dirty !== false,
          rev: typeof m.rev === "number" ? m.rev : 0,
        };
        syncServers(member);
        out.push(member);
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

/** 팀원 추가·고치기 — 아이디와 스킬·명령어만(10-20 리규형님: 서버·권한·생성 뒤 명령 칸 없앰) · 부를 이름(10-21 팀원 표준판) */
export function saveMember(input: { previousId: string | null; id: string; skills: string[]; callName?: string }): Promise<Result> {
  const id = input.id.trim();
  // 키 모양 "서버|skill:이름"·"서버|command:이름" 만 — 그 서버에 팀원 프로젝트가 생길 때 복사한다
  const skills = [...new Set(input.skills.filter((k) => /^[^|]+\|(skill|command):.+$/.test(k)))];
  const callName = input.callName === undefined ? undefined : input.callName.trim();
  return changeTeam((members) => {
    if (!ID_RULE.test(id)) return "아이디는 영문 소문자로 시작하고 영문 소문자·숫자·- 만, 31자까지 쓸 수 있습니다";
    const callError = callName === undefined ? null : callNameProblem(callName);
    if (callError) return callError;
    if (members.some((m) => m.id === id && m.id !== input.previousId)) return "같은 아이디가 이미 있습니다";
    const at = input.previousId ? members.findIndex((m) => m.id === input.previousId) : -1;
    if (input.previousId && at < 0) return "고치려던 팀원을 찾지 못했습니다";
    if (at >= 0) {
      // 서버에 만든 팀원은 이름이 서버 계정·로그인 계정에 박혀 있다 — 지우고 새로 추가해야 한다
      if ((members[at].applied.length > 0 || members[at].loginAdded) && id !== input.previousId) return "서버에 만든 뒤에는 아이디를 바꿀 수 없습니다 — 지우고 새로 추가해 주세요";
      members[at] = { ...members[at], id, skills, ...(callName === undefined ? {} : { callName }) };
      touched(members[at]);
    } else {
      members.push({ id, servers: [], skills, categoryOrder: [], projects: [], ownClaude: false, callName: callName ?? "", applied: [], links: {}, loginAdded: false, dirty: true, rev: 1 });
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
export function recordJob(id: string, rev: number, patch: { applied: string[]; links: Record<string, string>; loginAdded: boolean; complete: boolean }): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === id);
    if (!m) return "그 팀원을 찾지 못했습니다";
    m.applied = patch.applied;
    m.links = patch.links;
    m.loginAdded = patch.loginAdded;
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
const keyOf = (p: TeamProject) => `${p.host}|${cleanPath(p.path)}`;
const sameKey = (a: string, b: string) => {
  const bar = (k: string) => k.indexOf("|");
  return a.slice(0, bar(a)) === b.slice(0, bar(b)) && cleanPath(a.slice(bar(a) + 1)) === cleanPath(b.slice(bar(b) + 1));
};

/** 프로젝트 관리 화면(server/projectsEdit)과 같은 고치기를 한 팀원의 팀원 프로젝트에 — 서버는 프로젝트에서 다시 센다 */
export function editMemberProjects(memberId: string, op: ProjectsEditOp): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) return "그 팀원을 찾지 못했습니다";
    const problem = editProjectList(m, op);
    if (problem) return problem;
    syncServers(m);
    const clash = checkServers(m);
    if (clash) return clash;
    touched(m);
    return null;
  });
}

/** 팀원 프로젝트 하나의 권한(10-20) — 같은 서버의 다른 프로젝트·밖 경로와 겹치면 저장하지 않는다 */
export function setProjectAccess(memberId: string, key: string, input: ProjectAccess): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) return "그 팀원을 찾지 못했습니다";
    const i = m.projects.findIndex((p) => sameKey(keyOf(p), key));
    if (i < 0) return "그 프로젝트를 찾지 못했습니다";
    const clean = cleanProjectAccess(input, `"${m.projects[i].name}"`);
    if (typeof clean === "string") return clean;
    m.projects[i] = { ...m.projects[i], access: clean };
    const clash = checkServers(m);
    if (clash) return clash;
    touched(m);
    return null;
  });
}

/** 팀원 Claude 계정(10-21) — own = 본인 로그인, 아니면 회사 공용. 서버에 반영해야 먹는다 */
export function setMemberClaude(memberId: string, own: boolean): Promise<Result> {
  return changeTeam((members) => {
    const m = members.find((x) => x.id === memberId);
    if (!m) return "그 팀원을 찾지 못했습니다";
    if (m.ownClaude === own) return null;
    m.ownClaude = own;
    touched(m);
    return null;
  });
}

function editProjectList(m: TeamMember, op: ProjectsEditOp): string | null {
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
      // 팀원 프로젝트는 서버에만(팀원 Paseo 는 서버 울타리 안에서 돈다) — 서버는 팀원 추가 때 고르지 않고 여기서 정해진다
      if (host === "PC" || !SAFE_HOST.test(host)) return "팀원 프로젝트는 서버에만 넣을 수 있습니다 — 디바이스에서 서버를 고르세요";
      if (!input) return "경로가 비어 있습니다";
      if (!input.startsWith("/")) return "서버 경로는 / 로 시작해야 합니다";
      const path = cleanPath(input);
      // 팀원 홈은 기본 프로젝트로 늘 맨 위에 있다(10-11 리규형님 "삭제 불가, 항상 최상위" — 서버 팀원 도구가 넣는다)
      if (path === `/home/${m.id}`) return "팀원 홈은 기본 프로젝트로 이미 맨 위에 있습니다";
      if (find(`${host}|${path}`) >= 0) return "이미 이 팀원의 목록에 있는 프로젝트입니다";
      // 새로 넣은 프로젝트는 읽기만 — 줄의 "권한" 단추로 바꾼다
      list.push({ name: op.name.trim() || posix.basename(path) || path, category: op.category.trim(), enabled: true, host, path, access: defaultProjectAccess() });
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
  return null;
}
