import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProviders, PASEO_HOME } from "./account";
import { isTeamDaemon } from "./presentation/sound";

// 사용량 보기용 로그인(10-22 리규형님 결정 — PC 가 꺼져도 회사 계정 사용량 카드가 보이게).
// 서버의 팀 공급자는 env 의 CLAUDE_CODE_OAUTH_TOKEN(1년 열쇠)으로 대화를 돌리는데 그 열쇠로는 사용량 조회가 막혀(10-15 콜어드민 실측 429),
// PC 가 꺼져 콜어드민이 사용량 칸을 대신 맡으면 팀 카드가 없었다. 그래서 공급자마다 사용량만 읽는 로그인 폴더를 따로 두고, 설정 화면
// "Claude 로그인" 칸에서 한 번 로그인하면 그 로그인으로 사용량을 읽고 갱신한다(server/teamUsage). 대화 실행(열쇠·설정 폴더·훅)은 건드리지
// 않는다 — 공급자 env 에 CLAUDE_CONFIG_DIR 을 넣으면 대화의 설정·기록 폴더까지 바뀐다. 폴더는 이 플러그인 데이터 아래라 다른 Claude 가 쓰지 않는다.
// 팀원 데몬은 하지 않는다 — 회사 열쇠는 관리자 것이고, 팀원 데몬의 로그인 칸은 본인 로그인만 다룬다(claudeLogin.loginTargets).

const ROOT = join(PASEO_HOME, "plugin-data", "claude-state-bar", "usage-login");

/** 그 공급자의 사용량 보기용 로그인 폴더 — 공급자 번호는 Paseo 규칙상 소문자·숫자·하이픈뿐이라 폴더 이름으로 그대로 쓴다 */
export function usageLoginDir(provider: string): string {
  return join(ROOT, provider);
}

/** 1년 열쇠로만 도는 Claude 공급자 번호(Paseo 설정 차례) — 사용량 보기용 로그인 대상. 팀원 데몬이면 없다 */
export function tokenProviders(): string[] {
  if (isTeamDaemon()) return [];
  const all = claudeProviders();
  return Object.keys(all).filter((id) => {
    const token = all[id]?.env?.CLAUDE_CODE_OAUTH_TOKEN;
    return typeof token === "string" && token.trim() !== "";
  });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 그 폴더의 로그인 상태 — loggedIn = 액세스 열쇠가 있음(만료는 사용량 조회·유지 타이머가 갱신한다), account = 로그인한 계정 메일(Claude 가 같은
 *  폴더 .claude.json 의 oauthAccount 에 적는다). 열쇠 값은 돌려주지 않는다 */
export function usageLoginState(dir: string): { loggedIn: boolean; account: string | null } {
  const creds = readJson(join(dir, ".credentials.json")) as { claudeAiOauth?: { accessToken?: unknown } } | null;
  const loggedIn = typeof creds?.claudeAiOauth?.accessToken === "string" && creds.claudeAiOauth.accessToken !== "";
  const conf = readJson(join(dir, ".claude.json")) as { oauthAccount?: { emailAddress?: unknown } } | null;
  const email = conf?.oauthAccount?.emailAddress;
  return { loggedIn, account: loggedIn && typeof email === "string" && email ? email : null };
}
