import { setStyleSheet } from "./web";

// Paseo 입력창 위 "하위 에이전트 N개" 알약 숨기기(10-09 리규형님 "끝난 하위 워크플로우를 왜 표시하냐 — 우리 플러그인이 붙어 있는
// 데서는 없애 줘. 워크플로우 패널이 있는데 이게 백그라운드인지 워크플로우인지 헷갈렸다").
// Paseo 0.11.1 은 Claude 가 띄운 하위 에이전트(Task)와 워크플로우를 "하위 에이전트"로 세어(데몬 claude/subagents/live-source.js
// local_agent·local_workflow) 끝난 것까지 알약으로 보여 준다. 워크플로우·백그라운드는 우리 작업 현황 패널에서 본다.
// 알약 단추는 testID subagents-track-header, 누르면 뜨는 목록은 subagents-track-header-panel(ComposerTrackPill) — 둘 다 숨긴다.
// 웹·데스크톱만(setStyleSheet 이 폰 앱에선 아무것도 안 함). 점검표 25번

const STYLE_ID = "claude-state-bar-hide-subagents-pill";
const CSS = '[data-testid="subagents-track-header"],[data-testid="subagents-track-header-panel"]{display:none !important}';

/**
 * 숨김 스타일을 넣는다. 끊기 함수는 마지막에 넣은 쪽일 때만 스타일을 걷는다 — 플러그인을 다시 읽으면 옛 판 정리가 새 판보다 늦게
 * 돌아 같은 이름 스타일을 지운 일이 있었다(10-08, 메모리 project_paseo_client_hub_stale). 호스트마다 불러도 스타일은 하나다
 */
export function hideSubagentsPill(): () => void {
  const g = globalThis as { __claudeStateBar_hideSubagents_v1?: object };
  const token = {};
  g.__claudeStateBar_hideSubagents_v1 = token;
  setStyleSheet(STYLE_ID, CSS);
  return () => {
    if (g.__claudeStateBar_hideSubagents_v1 !== token) return;
    delete g.__claudeStateBar_hideSubagents_v1;
    setStyleSheet(STYLE_ID, null);
  };
}
