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
