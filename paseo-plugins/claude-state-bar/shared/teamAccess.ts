// 팀원 권한 — 서버 팀원 도구에 보낼 값의 모양·기본값·검사.
// 10-20 리규형님 "팀원 관리 새로": 권한은 서버마다가 아니라 팀원 프로젝트마다 준다(팀원 프로젝트 관리 탭). 같은 서버의 프로젝트 권한은
// combineAccess 가 모아 서버 하나에 보낼 값으로 만든다 — 저장 검사(server/team)·서버 반영(server/teamApply)·화면이 이 한 함수를 쓴다.
// 다른 묶음을 불러오지 않는다 — PC 데몬 쪽 코드와 시험·화면이 Paseo 묶음 없이 쓴다(검사 정의는 shared/team.ts 의 projectAccessSchema)

/**
 * 파일 권한 세 가지(10-20 리규형님) — 서버 팀원 도구(team-daemon policy.py)의 mount mode 와 같은 값.
 * ro = 읽기만 · rw = 읽기쓰기(모든 권한 — 고치기·지우기·git 커밋까지) ·
 * add = 내가 쓴 파일만 쓰기(읽기는 전부. 새 파일을 만들고 자기가 만든 파일만 고치고 지운다 — 리규형님 "검토만 하는 경우를 위해 준비")
 */
export type FileMode = "ro" | "rw" | "add";
export const FILE_MODES: readonly { mode: FileMode; label: string; note: string }[] = [
  { mode: "ro", label: "읽기만", note: "안의 파일을 읽기만 합니다" },
  { mode: "rw", label: "읽기쓰기", note: "모든 파일을 읽고 고치고 지웁니다(git 커밋·배포 포함)" },
  { mode: "add", label: "내가 쓴 파일만", note: "모두 읽고, 새로 만든 자기 파일만 고치거나 지웁니다(원래 있던 파일은 읽기만)" },
];
export const fileModeLabel = (mode: FileMode): string => FILE_MODES.find((x) => x.mode === mode)?.label ?? mode;

/** 프로젝트 밖 경로 칸 수(10-20 리규형님 "직접 경로를 넣어주기, 두 개 정도" — 콜어드민 개발 폴더에서 운영 폴더로 배포하는 경우) */
export const OUTSIDE_MAX = 2;

/**
 * 팀원 프로젝트 하나의 권한. file = 그 프로젝트 폴더 · outside = 프로젝트 밖 경로(경로마다 같은 세 권한) ·
 * ports = 서버 안에서 열어 줄 포트(DB 3306 등) · logs = 읽기 전용으로 붙일 기록(TEAM_LOGS) · hideSecrets = 비밀 파일(.env 류)을 빈 파일로.
 * ports·logs·hideSecrets 는 팀원 Paseo(서버마다 하나) 단위로 걸려서 같은 서버의 프로젝트끼리 합쳐진다
 */
export type OutsidePath = { path: string; mode: FileMode };
export type ProjectAccess = { file: FileMode; outside: OutsidePath[]; ports: number[]; logs: string[]; hideSecrets: boolean };

/** 새로 넣은 팀원 프로젝트 — 읽기만, 밖·포트·기록 없음, 비밀 파일 그대로(10-11 리규형님 "열면 내 권한과 같게" — 서버 도구 생략값과 같다) */
export const defaultProjectAccess = (): ProjectAccess => ({ file: "ro", outside: [], ports: [], logs: [], hideSecrets: false });

/** 옛 서버 단위 권한(10-11~10-19 형식) — team.json 을 읽을 때 새 형식으로 옮기는 데만 쓴다(server/team migrateLegacy) */
export type LegacyAccess = { writable: string[]; addOnly?: string[]; ports: number[]; logs: string[]; hideSecrets: boolean };

/**
 * 팀원에게 읽기 전용으로 붙일 수 있는 기록 — 서버 팀원 도구(team-daemon policy.py PM2·LOG)가 시스템 폴더 중 이 둘만 허락한다.
 * PM2 기록은 날짜별로 새 파일이 생겨 파일 하나씩은 못 붙이고 폴더째 붙인다(그 서버 모든 앱의 기록이 보인다)
 */
export const TEAM_LOGS = [
  { path: "/root/.pm2/logs", label: "서버 기록 전체(PM2)", note: "이 서버 모든 앱의 기록 — 날짜별로 새 파일이 생겨 폴더째만 붙일 수 있습니다" },
  { path: "/var/log/poi_departure_monitor.log", label: "POI 감시 기록", note: "출발지 감시 기록 파일 하나" },
] as const;
const LOG_PATHS: readonly string[] = TEAM_LOGS.map((l) => l.path);

/** 서버 팀원 도구(policy.py PATH)와 같은 경로 글자 규칙 */
const PATH_RULE = /^\/[A-Za-z0-9_./-]+$/;
/** 서버 팀원 도구가 열지 않는 포트 — 리규형님·팀원 Paseo(policy.py validate_spec) */
const reservedPort = (p: number) => p === 6767 || p === 6768 || p === 6799 || (p >= 6800 && p <= 6899);
/** 서버 팀원 도구의 한도(policy.py validate_spec — mounts 32 · 포트 16) */
const MOUNT_MAX = 32;
const PORT_MAX = 16;

/** 경로 한 칸 — 앞뒤 빈칸·끝 / 를 떼고, 서버 도구가 받는 모양이 아니면 null */
export function cleanPathText(raw: string): string | null {
  const p = raw.trim().replace(/(.)\/+$/, "$1");
  if (!PATH_RULE.test(p) || p.split("/").some((x) => x === "." || x === "..") || p.includes("//") || p === "/" || p === "/home") return null;
  return p;
}

/**
 * 화면에서 온 프로젝트 권한 하나를 검사·정리한다 — 틀리면 이유 글. 관리자·시스템 폴더 거절은 서버 도구가 한다
 * (같은 판정을 두 벌 두지 않는다 — 반영 기록에 서버가 거절한 이유가 남는다)
 */
export function cleanProjectAccess(a: ProjectAccess, where: string): ProjectAccess | string {
  if (!FILE_MODES.some((x) => x.mode === a.file)) return `${where} 파일 권한을 골라 주세요`;
  const outside: OutsidePath[] = [];
  for (const o of a.outside) {
    if (!o.path.trim()) continue;
    const p = cleanPathText(o.path);
    if (!p) return `${where} 프로젝트 밖 경로 "${o.path}" — / 로 시작하는 절대 경로(영문·숫자·_ . - /)만 쓸 수 있습니다`;
    if (!FILE_MODES.some((x) => x.mode === o.mode)) return `${where} 프로젝트 밖 경로 "${p}" 의 권한을 골라 주세요`;
    if (LOG_PATHS.includes(p) && o.mode !== "ro") return `${where} "${p}" 는 서버 기록이라 읽기만 열 수 있습니다`;
    if (outside.some((x) => x.path === p)) continue;
    outside.push({ path: p, mode: o.mode });
  }
  if (outside.length > OUTSIDE_MAX) return `${where} 프로젝트 밖 경로는 ${OUTSIDE_MAX}개까지입니다`;
  const ports: number[] = [];
  for (const p of a.ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) return `${where} DB 접속 포트 "${p}" — 1~65535 숫자만 쓸 수 있습니다`;
    if (reservedPort(p)) return `${where} 포트 ${p} — Paseo 가 쓰는 포트라 열 수 없습니다(6767·6768·6799·6800~6899)`;
    if (!ports.includes(p)) ports.push(p);
  }
  if (ports.length > PORT_MAX) return `${where} 포트는 ${PORT_MAX}개까지입니다`;
  const logs = [...new Set(a.logs)];
  const odd = logs.find((l) => !LOG_PATHS.includes(l));
  if (odd) return `${where} 기록 "${odd}" — 고를 수 있는 기록이 아닙니다`;
  return { file: a.file, outside, ports: ports.sort((x, y) => x - y), logs, hideSecrets: a.hideSecrets === true };
}

export type Mount = { path: string; mode: FileMode };
export type Combined = { mounts: Mount[]; ports: number[]; logs: string[]; hideSecrets: boolean; error?: string };

const beneath = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);

/**
 * 서버 팀원 도구가 열지 않는 시스템·관리 폴더(policy.py FORBIDDEN) — 그 아래와 그것을 품은 상위 폴더도 안 된다.
 * 같은 값이 policy.py 에 있다 — 시험(docs tests-261020/team_rebuild)이 두 목록이 같은지 대조한다(판정이 두 벌로 갈라지지 않게)
 */
export const SYSTEM_DIRS: readonly string[] = ["/root", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev", "/run", "/tmp", "/var", "/opt"];

/** 서버 팀원 도구 mount_allowed 와 같은 판정 — 기록 두 곳은 읽기만, / 와 /home 자체는 안 되고 시스템·관리 폴더와 그 상위도 안 된다 */
export function mountAllowed(path: string, mode: FileMode): boolean {
  if (LOG_PATHS.includes(path)) return mode === "ro";
  if (path === "/" || path === "/home") return false;
  return !SYSTEM_DIRS.some((d) => beneath(path, d) || beneath(d, path));
}

/**
 * 한 서버의 팀원 프로젝트 권한을 모아 서버 팀원 도구에 보낼 값으로. 홈은 늘 읽기쓰기 ·
 * 같은 경로를 다른 권한으로 두 번 열 수 없다 · "내가 쓴 파일만" 폴더는 읽기쓰기·내가 쓴 파일만 폴더(홈 포함)와 안팎으로 겹칠 수 없다
 * (서버 도구 validate_spec 과 같은 규칙 — 겹치면 나중에 붙인 권한이 앞의 것을 덮는다) · 포트·기록은 합치고 비밀 가리기는 하나라도 켜면 켠다.
 * error 가 있으면 mounts 는 그 앞까지만 — 저장하지 말고 이유를 보여 준다
 */
export function combineAccess(home: string, projects: readonly { name: string; path: string; access?: ProjectAccess }[]): Combined {
  const mounts: Mount[] = [{ path: home, mode: "rw" }];
  const owner = new Map<string, string>([[home, "팀원 홈"]]);
  const ports = new Set<number>();
  const logs: string[] = [];
  let hideSecrets = false;
  const put = (path: string, mode: FileMode, who: string): string | null => {
    if (path !== home && !mountAllowed(path, mode))
      return `${path}(${who})는 서버가 열지 않는 시스템·관리 폴더입니다 — /root·/etc·/usr·/var·/opt 같은 폴더와 그 아래·위는 넣을 수 없습니다`;
    const at = mounts.find((m) => m.path === path);
    if (at) {
      if (at.mode === mode || path === home) return null;
      return `${path} 가 ${owner.get(path)} 에서는 "${fileModeLabel(at.mode)}", ${who} 에서는 "${fileModeLabel(mode)}" 로 열려 있습니다 — 한 가지로 맞춰 주세요`;
    }
    mounts.push({ path, mode });
    owner.set(path, who);
    return null;
  };
  const done = (error?: string): Combined => ({ mounts, ports: [...ports].sort((x, y) => x - y), logs, hideSecrets, ...(error ? { error } : {}) });
  for (const p of projects) {
    const a = p.access ?? defaultProjectAccess();
    const problem = put(p.path, a.file, `프로젝트 "${p.name}"`) ?? a.outside.map((o) => put(o.path, o.mode, `프로젝트 "${p.name}" 의 밖 경로`)).find(Boolean) ?? null;
    if (problem) return done(problem);
    for (const port of a.ports) ports.add(port);
    for (const l of a.logs) if (!logs.includes(l)) logs.push(l);
    if (a.hideSecrets) hideSecrets = true;
  }
  for (const l of logs) {
    const problem = put(l, "ro", "서버 기록");
    if (problem) return done(problem);
  }
  for (const add of mounts.filter((m) => m.mode === "add")) {
    const clash = mounts.find((m) => m.mode !== "ro" && m.path !== add.path && (beneath(add.path, m.path) || beneath(m.path, add.path)));
    if (clash) return done(`"내가 쓴 파일만" 폴더 ${add.path}(${owner.get(add.path)})가 ${clash.path}(${owner.get(clash.path)}, "${fileModeLabel(clash.mode)}")와 안팎으로 겹칩니다 — 겹치지 않게 나눠 주세요`);
  }
  if (mounts.length > MOUNT_MAX) return done(`한 서버에서 열 수 있는 폴더는 ${MOUNT_MAX}개까지입니다(지금 ${mounts.length}개)`);
  if (ports.size > PORT_MAX) return done(`한 서버에서 열 수 있는 포트는 ${PORT_MAX}개까지입니다`);
  return done();
}
