import { homedir } from "node:os";
import { join } from "node:path";

// 플러그인이 Claude Code 의 설정·대화 기록 폴더를 계산하는 단 한 곳(10-18 정리, 결정 3).
// 같은 식이 chime/tracker·activity/workflows·stats/claudeStats·teamSkills 에 따로 있었다 — 새 사용처도 여기서 가져다 쓴다.
// 🔴 이 파일은 node:os·node:path 만 쓴다. 재귀 로더로 원본 TS 를 부르는 시험(team_settings_test·pc-offline-fallback·
//    sound_v2 등)은 node:os 에 homedir 만 넣어 주므로, 다른 의존성을 붙이면 그 시험들이 깨진다.
//
// 전제: PC 의 팀 공급자(Paseo 설정 extends === "claude" 인 공급자) 대화도 데몬 환경의 이 폴더에 보인다.
// claude-team-sync.js 가 팀 계정 설정 폴더의 projects 를 이 폴더로 잇는 정션을 만들어 두었기 때문이다.
// 그 정션이 없는 기기에서 팀 대화 기록을 따로 찾게 되면 여기 한 곳만 고친다.

/** Claude Code 설정 폴더. CLAUDE_CONFIG_DIR 을 쓰면 그 값, 아니면 ~/.claude (Claude Code 와 같은 규칙) */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude Code 대화 기록(jsonl) 폴더 — claudeConfigDir() 아래 projects */
export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

/**
 * CLAUDE_CONFIG_DIR 과 무관하게 이 기기 홈의 ~/.claude (홈 고정).
 * 두 곳만 쓴다: codex/clean 의 보안 허용 목록(플러그인 정리 스크립트가 깔리는 곳)과
 * /start 의 ~/.claude/scripts/rc_title.js 가 읽는 전역 프로젝트 이름표 자리(projectLabels).
 * 기록 폴더 계산에는 쓰지 마라 — 그건 claudeConfigDir()/claudeProjectsDir() 다.
 */
export function globalClaudeHome(): string {
  return join(homedir(), ".claude");
}
