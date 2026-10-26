// 팀원 표준판(10-21 리규형님) — 리규형님판 규칙·압축 준비·시작·마무리는 고르지 않고, 서버 팀원 도구가 표준판을 팀원 홈에 없을 때만 넣는다.
// 화면(client/team/teamManage)과 저장(server/team/team)이 같이 쓴다. 아무것도 가져오지 않는다 — 저장 모듈을 따로 떼어 도는 시험(team-rebuild)이 있다

/** 서버 도구 team-daemon policy.py STANDARD 와 같은 이름이어야 한다 */
export const TEAM_STANDARD: Readonly<Record<"skill" | "command", readonly string[]>> = {
  skill: ["start_compact"],
  command: ["korean-rule", "start", "finish"],
};
export const isTeamStandard = (kind: string, name: string): boolean =>
  (kind === "skill" || kind === "command") && TEAM_STANDARD[kind].includes(name);

/** 부를 이름 검사 — 서버 도구 policy.py validate_spec 의 callName 규칙과 같다. 문제가 없으면 null */
export const CALL_NAME_MAX = 20;
export function callNameProblem(value: string): string | null {
  if (!value) return null;
  if (value !== value.trim()) return "부를 이름 앞뒤에 빈칸을 넣지 마세요";
  if (value.length > CALL_NAME_MAX) return `부를 이름은 ${CALL_NAME_MAX}자까지 쓸 수 있습니다`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f{}<>`$\\]/.test(value)) return "부를 이름에는 { } < > ` $ \\ 와 줄바꿈을 쓸 수 없습니다";
  return null;
}
