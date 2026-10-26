import { setStyleSheet } from "../web";
import { retainSharedStyle } from "../sharedStyle";

// 폰(좁은 화면) "모델 선택" 아래 창의 모델·사고·모드 값이 "Opus …"·"매우 …"·"Bypa…" 로 잘리던 것(10-21 리규형님 캡처 — "점점점으로 보여, 수정해").
// Paseo 0.12.0 자체 규칙이다: 값 칸이 max-width 45%(자기를 담은 묶음 기준)인데, 이 창에서는 묶음(아이콘·이름·값)이 내용만큼만 폭을 잡아
// (약 119px) 값이 54px 안에 갇혔다. 줄 폭은 376px 이고 플러그인 규칙은 하나도 걸리지 않았다(폰 WebView 실측).
// 이 창 목록(testID agent-controls-settings-list) 안에서만 묶음 자식들의 폭 제한을 푼다 — 묶음은 제 max-width 100%(줄 폭) 안에 남아
// 아주 긴 값은 여전히 말줄임된다. 묶음을 넓히는 방식은 이름 칸이 남는 폭을 다 차지해 이름과 값이 양 끝으로 갈라져 쓰지 않았다(같은 실측).
// 입력창 위 모델 알약도 같은 부품이라(이름표 "모델 선택 (…)") 이름표가 아니라 이 창 목록 이름으로 고른다.
const STYLE_ID = "claude-state-bar-agent-controls-values";
const STYLE_VERSION = 1;
const CSS = '[data-testid="agent-controls-settings-list"] [role="button"] > div:first-child > *{max-width:none !important}';

/** 연결마다 소유권 하나. 마지막 연결이 내려갈 때만 걷는다. */
export function fixAgentControlsValues(): () => void {
  const style = retainSharedStyle(STYLE_ID, STYLE_VERSION, setStyleSheet);
  style.set(CSS);
  return style.dispose;
}
