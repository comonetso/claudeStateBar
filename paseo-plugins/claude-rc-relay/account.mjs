// 같은 창 계정 바꾸기(10-14, claude-state-bar 의 계정 알약)를 실행기 쪽에서 맡는다 — 중계 실행기(relay.mjs)와 팀 실행기
// (claude-team-launch/launch.mjs)가 같이 쓴다.
//
// 왜 실행기에서: 처음엔 플러그인이 대화 열기 훅으로 계정 값을 넣고 Paseo 새로 고침(paseo agent reload)으로 다시 띄웠다.
// 그런데 그 새로 고침은 화면 기록을 지우고 Claude 대화 파일 전체를 처음부터 다시 흘려보낸다(Paseo 0.11.1 session.js
// handleRefreshAgentRequest → rehydrateFromDisk:true) — 긴 대화에서 폰 앱이 그걸 다 받다 멈췄다(10-14 리규형님). Claude 프로그램만
// 끄면 Paseo 는 다음 말 때 기록을 둔 채 같은 대화를 이어 띄우지만, 그때는 처음 열 때의 env 를 그대로 다시 써서 훅이 다시 불리지
// 않는다(10-14 실측). 그래서 실행기가 켜질 때마다 기록 파일을 직접 읽어 계정을 정하고, 켜져 있는 동안 기록을 지켜보다
// 자기 대화의 계정이 바뀌면 Claude 를 끈다. 다음 말이 오면 Paseo 가 실행기를 다시 띄우고, 그때 새 계정이 적용된다.
//
// 기록 = Paseo 홈의 plugin-data/claude-state-bar/accounts.json { entries: { <대화 번호>: { to, base } } } (플러그인 server/account 가 쓴다).
// 대화 번호 = Paseo 가 실행기 env 에 넣어 주는 PASEO_AGENT_ID. 계정 값 = 이 기기 Paseo 설정의 팀 공급자(claude-yeogiaen) env
// 그대로(PC 는 CLAUDE_CONFIG_DIR, 서버는 CLAUDE_CODE_OAUTH_TOKEN). 팀으로 = 그 값을 넣고, 개인으로 = 그 이름들을 지운다.

import { mkdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const DIR = join(HOME, "plugin-data", "claude-state-bar");
const FILE = join(DIR, "accounts.json");
const TEAM_PROVIDER = "claude-yeogiaen";

const KINDS = new Set(["team", "personal"]);

/** 이 대화를 원래 계정과 다른 계정으로 바꿔 둔 기록. 없거나 원래 계정이면 null */
export function accountEntry(agentId) {
  if (!agentId) return null;
  try {
    const e = JSON.parse(readFileSync(FILE, "utf8"))?.entries?.[agentId];
    return e && KINDS.has(e.to) && KINDS.has(e.base) && e.to !== e.base ? { to: e.to, base: e.base } : null;
  } catch {
    return null;
  }
}

/** 이 기기 Paseo 설정의 팀 공급자 env(빈 값 제외). 없으면 null */
export function teamEnv() {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
    const env = doc?.agents?.providers?.[TEAM_PROVIDER]?.env ?? {};
    const out = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v) out[k] = v;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** 띄울 env 에 바꿔 둔 계정을 적용한다. 적용한 계정("team"|"personal") 또는 null(그대로) */
export function applyAccount(env, agentId) {
  const e = accountEntry(agentId);
  if (!e) return null;
  const team = teamEnv();
  if (!team) return null;
  if (e.to === "team") Object.assign(env, team);
  else for (const k of Object.keys(team)) delete env[k];
  return e.to;
}

/** 이 대화의 계정 기록이 바뀌면 onChange 를 부른다(바뀔 때마다). 그만 지켜보는 함수를 돌려준다.
 *  폴더를 지켜본다 — 플러그인은 임시 파일에 쓴 뒤 바꿔 끼우고, Windows 는 파일 이름을 안 알려 줄 때가 있어 이벤트마다 다시 읽는다 */
export function watchAccount(agentId, onChange) {
  if (!agentId) return () => {};
  const key = () => JSON.stringify(accountEntry(agentId));
  let last = key();
  try {
    mkdirSync(DIR, { recursive: true });
    const w = watch(DIR, () => {
      const now = key();
      if (now === last) return;
      last = now;
      onChange();
    });
    w.on("error", () => {});
    return () => {
      try {
        w.close();
      } catch {
        /* 이미 닫힘 */
      }
    };
  } catch {
    return () => {};
  }
}
