// 작업 현황의 네 갈래 — 확장 ACTIVITY_TABS 순서, 탭 이름 act.tab.*, 메뉴 조각 menu.actPart.* (i18n.ts 한국어)
export const ACTIVITY_PANEL_ID = "activity";

export const KINDS = [
  { key: "workflows", tab: "워크플로우", part: "워크플로우", icon: "Workflow" },
  { key: "background", tab: "백그라운드", part: "백그라운드", icon: "SquareTerminal" },
  { key: "codexRuns", tab: "Codex 진행", part: "Codex", icon: "Bot" },
  { key: "codexChats", tab: "Codex 채팅", part: "Codex 채팅", icon: "MessageSquare" },
] as const;

export type KindKey = (typeof KINDS)[number]["key"];
export const isKindKey = (v: unknown): v is KindKey => KINDS.some((k) => k.key === v);

// 다섯째 탭 "통계"(리규형님 10-08 결정 — 확장 Claude Status 패널의 통계 탭을 작업 현황으로). 돌고 있는 수가 없는 탭이라
// KINDS(머리줄 단추·탭 숫자가 세는 네 갈래)와 따로 두고, 탭 줄만 TABS 로 다섯을 그린다. 자리는 맨 끝.
export const STATS_TAB = { key: "stats", tab: "통계", icon: "ChartColumn" } as const;
export const TABS = [...KINDS, STATS_TAB] as const;

export type TabKey = (typeof TABS)[number]["key"];
export const isTabKey = (v: unknown): v is TabKey => TABS.some((k) => k.key === v);
