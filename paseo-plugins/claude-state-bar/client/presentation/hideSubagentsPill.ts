import { setStyleSheet } from "../web";
import { retainSharedStyle } from "../sharedStyle";

// Paseo 입력창 위 "하위 에이전트 N개" 알약 숨기기(10-09 리규형님 "끝난 하위 워크플로우를 왜 표시하냐 — 우리 플러그인이 붙어 있는
// 데서는 없애 줘. 워크플로우 패널이 있는데 이게 백그라운드인지 워크플로우인지 헷갈렸다").
// Paseo 0.11.1 은 Claude 가 띄운 하위 에이전트(Task)와 워크플로우를 "하위 에이전트"로 세어(데몬 claude/subagents/live-source.js
// local_agent·local_workflow) 끝난 것까지 알약으로 보여 준다. 워크플로우·백그라운드는 우리 작업 현황 패널에서 본다.
// 알약 단추는 testID subagents-track-header, 누르면 뜨는 목록은 subagents-track-header-panel(ComposerTrackPill) — 둘 다 숨긴다.
// 웹·데스크톱만(setStyleSheet 이 폰 앱에선 아무것도 안 함). 점검표 25번

// 좁은 화면(폰 모양)에서는 변경 줄 수 알약(testID composer-diff-stat-pill, "+38.7k -0")도 숨긴다(10-15 리규형님 "폰에서 디프로
// 수정할 것도 아닌데 치우는 게 낫다, 너무 비좁아"). 폭 기준은 Paseo 의 좁은 화면 판정과 같은 720px 미만(web.ts COMPACT_MAX_WIDTH)
const STYLE_ID = "claude-state-bar-hide-subagents-pill";
const STYLE_VERSION = 1;
const CSS = '[data-testid="subagents-track-header"],[data-testid="subagents-track-header-panel"]{display:none !important}' +
  '@media (max-width: 719.98px){[data-testid="composer-diff-stat-pill"]{display:none !important}}';

/** 연결마다 소유권 하나. 마지막 연결이 내려갈 때만 숨김을 걷는다. */
export function hideSubagentsPill(): () => void {
  const style = retainSharedStyle(STYLE_ID, STYLE_VERSION, setStyleSheet);
  style.set(CSS);
  return style.dispose;
}
