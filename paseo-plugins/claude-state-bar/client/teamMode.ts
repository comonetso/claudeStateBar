// 직원용 Paseo(서버 울타리 안 직원 데몬, 10-11)에 붙은 화면인지 — host.info 의 team 으로 정한다.
// 직원 화면은 그 데몬 하나만 보므로 PC 처럼 설정·사용량·프로젝트 목록을 붙이되, 관리 탭(프로젝트 관리·팀원 관리)은 숨긴다
let member = false;
// 직원 홈(10-11 리규형님 "로그인하면 홈이 바로 나와야") — 시작 화면으로 들어오면 한 번만 연다
let home: { serverId: string; path: string } | null = null;
let homeOpened = false;

export function setTeamMember(value: boolean, staffHome: { serverId: string; path: string } | null = null): void {
  member = value;
  home = value ? staffHome : null;
}

export function isTeamMember(): boolean {
  return member;
}

/**
 * 직원 화면이 붙은 자기 데몬 — 직원 목록의 프로젝트는 모두 여기서 연다. 처음 만든 직원 데몬은 아직 연 적 없는 폴더를
 * 프로젝트 목록(projects.list)에 안 줘서 경로로는 못 찾는다(10-11 대표님 새 계정 "연결된 Paseo 가 없어 열 수 없습니다")
 */
export function staffServerId(): string | undefined {
  return member ? home?.serverId : undefined;
}

/** 아직 안 열었으면 직원 홈을 돌려주고 연 것으로 친다(페이지를 새로 열 때마다 한 번) */
export function takeStaffHome(): { serverId: string; path: string } | null {
  if (!member || !home || homeOpened) return null;
  homeOpened = true;
  return home;
}
