// 직원용 Paseo(서버 울타리 안 직원 데몬, 10-11)에 붙은 화면인지 — host.info 의 team 으로 정한다.
// 직원 화면은 그 데몬 하나만 보므로 PC 처럼 설정·사용량·프로젝트 목록을 붙이되, 관리 탭(프로젝트 관리·팀원 관리)은 숨긴다
let member = false;

export function setTeamMember(value: boolean): void {
  member = value;
}

export function isTeamMember(): boolean {
  return member;
}
