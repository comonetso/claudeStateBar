import { uiProvider } from "./uiRole";
import type { PluginButtonBehavior, PluginClientContext } from "@getpaseo/plugin/client";
import { soundProvider } from "./sounds";
import type { HeaderButtonSet } from "./usageButton";

/** Paseo 설정 안 우리 화면의 id — 예전 "Claude 상태 소리" 화면 그대로 쓴다(이름만 Claude State Bar 로 바뀜). */
export const SETTINGS_SCREEN_ID = "sounds";

/**
 * 톱니(Claude State Bar 설정)는 입력창 위 알약 줄 맨 오른쪽 알약이다(phonePills.tsx — 10-18 리규형님 "설정을 알약들 맨 오른쪽에").
 * 누르면 메뉴 없이 바로 Paseo 설정 안 우리 화면(10-18 "매번 두 번 눌러서 불편"). 설정 화면은 소리 담당 호스트(이 PC) 플러그인만
 * 등록하므로 서버 작업 공간의 톱니도 그쪽 화면을 연다. 머리줄엔 사용량·작업 현황과 작업 장부(work-ledger 플러그인)가 남는다 —
 * Paseo 는 넓은 화면 머리줄 플러그인 단추를 앞에서부터 셋까지만 보이고 나머지를 ⋯ 로 접는다(창 폭 1100 미만은 하나).
 * 웹의 "대표 배치 가져오기"는 10-26 머리줄에서 빼 설정 화면 "기기 사이 맞추기" 칸으로 옮겼다(layoutSync.tsx LayoutSyncPanel)
 */
/** 설정 알약 이름 = 접근성 이름. 두 줄 배치 CSS(web.ts RAIL_CSS)가 이 이름으로 찾는다 */
export const SETTINGS_TITLE = "Claude State Bar 설정";
/** 톱니를 눌렀을 때의 동작 — 바로 설정 화면 */
export function settingsBehavior(client: PluginClientContext): PluginButtonBehavior {
  return {
    kind: "action",
    onPress: () => {
      const provider = uiProvider() ?? soundProvider();
      if (provider?.openSettings) provider.openSettings();
      else client.openSettings(SETTINGS_SCREEN_ID);
    },
  };
}

/** 단추 묶음을 이 순서로 단다 — Paseo 는 등록한 순서대로 왼쪽부터 놓는다. */
export function chainButtons(...sets: HeaderButtonSet[]): HeaderButtonSet {
  return {
    add(workspaceId) {
      for (const set of sets) set.add(workspaceId);
    },
    drop(workspaceId) {
      for (const set of sets) set.drop(workspaceId);
    },
    dispose() {
      for (const set of sets) set.dispose?.();
    },
  };
}
