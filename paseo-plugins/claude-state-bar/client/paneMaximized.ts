import type { PluginTheme } from "@getpaseo/plugin";
import { dotColors } from "./statusIndicator";
import { setStyleSheet } from "./web";

// 칸 최대화 중 표시(리규형님 10-08: "탭을 최대화했을 때 최대화했다는 것이 표시가 되지 않아 헷갈림" → "너무 튀면 안 되니까
// 주황색으로 칠하는 게"). Paseo 0.11.1 은 나뉜 칸 하나를 최대화하면 탭 줄 오른쪽 작은 단추만 눌린 모양·아이콘으로 바뀐다.
// 그 단추는 최대화 중에만 testID workspace-restore-pane 을 단다(평소엔 workspace-maximize-pane) — 그것만 주황으로 칠한다.
// 주황은 Paseo 상태 점 경고색 두 벌(statusIndicator dotColors)에서 테마 밝기로 고른다. 바탕은 그 주황을 옅게(20%) 깐다.
// 웹·데스크톱만(setStyleSheet 이 폰에선 아무것도 안 함). 테마는 화면 부품만 받으므로 머리줄 단추 그림이 칠한다(activityButton).

const STYLE_ID = "claude-state-bar-pane-maximized";
const BUTTON = '[data-testid="workspace-restore-pane"]';

let painted: string | null = null;

/** 지금 테마에 맞는 주황으로 칠한다. 같은 색이면 아무것도 안 한다 */
export function paintMaximizedPane(theme: PluginTheme): void {
  const orange = dotColors(theme).warning;
  if (painted === orange) return;
  painted = orange;
  setStyleSheet(
    STYLE_ID,
    `${BUTTON}{background-color:${orange}33 !important}` +
      `${BUTTON} svg,${BUTTON} svg *{color:${orange} !important;stroke:${orange} !important}`,
  );
}

/** 플러그인이 꺼질 때 칠을 걷는다 */
export function clearMaximizedPane(): void {
  painted = null;
  setStyleSheet(STYLE_ID, null);
}
