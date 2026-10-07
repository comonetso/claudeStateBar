import { markWorkspaceInteraction, readPaseoLayout, updatePaseoLayout } from "./web";

// 작업 현황 단추를 누르면 화면을 둘로 나눠 왼쪽에 작업 현황, 오른쪽에 지금 대화를 둔다(리규형님 10-07 결정:
// 왼쪽 칸 = 탐색기를 뺀 남은 폭의 설정 %(기본 40) · 이미 칸이 둘 이상이면 지금 구조 그대로).
// 공개 도구에는 칸 나누기·크기가 없다. 검증된 Paseo 번들의 메모리를 한 번에 갱신한다(web.ts).
// 저장은 앱 persist가 맡으며, 앱의 엄격한 저장 스키마 검사를 통과해야만 갱신한다. 문서 새로고침은 없다.

const ROOT_GROUP = "workspace-root";
const EXPLORER_PANE = "explorer";

type Tab = { tabId: string; target: Record<string, unknown>; createdAt: number; state?: unknown };
type Pane = { id: string; tabIds: string[]; focusedTabId: string | null; tabs?: Tab[]; hidden?: boolean };
type Node = { kind: "pane"; pane: Pane } | { kind: "group"; group: { id: string; direction: "horizontal" | "vertical"; children: Node[]; sizes: number[] } };
type Layout = { root: Node; focusedPaneId: string | null; parentTabIdByTabId?: Record<string, string> };
type State = { layoutByWorkspace?: Record<string, Layout>; splitSizesByWorkspace?: Record<string, Record<string, number[]>>;
  explorerSidebarPaneIdByWorkspace?: Record<string, string | null>; focusRestorationByWorkspace?: Record<string, unknown> } & Record<string, unknown>;

/** Paseo 가 플러그인 작업 공간 패널 탭에 붙이는 번호(늘 같다) — 저장본의 실제 값과 같은 모양 */
export function pluginPanelTabId(pluginId: string, panelId: string): string {
  return `plugin_workspace_${pluginId.length}_${pluginId}_${panelId.length}_${panelId}`;
}

function newPaneId(): string {
  const uuid = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `pane_${uuid}`;
}

/**
 * 이 작업 공간의 칸이 하나뿐이면 메모리에 왼쪽 현황 칸을 만든다(true). 칸이 이미 둘 이상이거나,
 * 이 앱 판의 메모리 연결을 못 찾으면 false — 부른 쪽이 새로고침 없이 기존 패널을 연다.
 */
export function openActivitySplit(input: { serverId: string; workspaceId: string; pluginId: string; panelId: string; percent: number }): boolean {
  markWorkspaceInteraction();
  const state = readPaseoLayout() as State | null;
  if (!state) return false;
  const key = `${input.serverId}:${input.workspaceId}`;
  const layout = state.layoutByWorkspace?.[key];
  const root = layout?.root;
  if (!layout || !root || root.kind !== "group" || root.group.id !== ROOT_GROUP || root.group.direction !== "horizontal") return false;
  const children = root.group.children;
  const explorerId = state.explorerSidebarPaneIdByWorkspace?.[key] ?? EXPLORER_PANE;
  const work = children.filter((c) => !(c.kind === "pane" && c.pane.id === explorerId));
  if (work.length !== 1 || work[0].kind !== "pane") return false; // 이미 나뉘어 있다 — 지금 구조 그대로
  const main = work[0].pane;

  const tabId = pluginPanelTabId(input.pluginId, input.panelId);
  const existing = main.tabs?.find((t) => t.tabId === tabId);
  const restIds = main.tabIds.filter((id) => id !== tabId);
  if (!restIds.length) return false; // 작업 현황만 있는 칸 — 오른쪽에 둘 대화가 없다
  const rest: Pane = {
    ...main,
    tabIds: restIds,
    ...(main.tabs ? { tabs: main.tabs.filter((t) => t.tabId !== tabId) } : {}),
    focusedTabId: main.focusedTabId && main.focusedTabId !== tabId ? main.focusedTabId : restIds[0],
  };
  const tab: Tab = existing ?? { tabId, target: { kind: "plugin", pluginId: input.pluginId, panelId: input.panelId, context: "workspace" }, createdAt: Date.now() };
  const left: Pane = { id: newPaneId(), tabIds: [tabId], focusedTabId: tabId, tabs: [tab] };

  // 크기: 탐색기 몫은 그대로, 나머지를 왼쪽 percent · 오른쪽 나머지로
  const sizes = root.group.sizes.length === children.length ? root.group.sizes : children.map(() => 1 / children.length);
  const explorerShare = children.reduce((sum, c, i) => (c.kind === "pane" && c.pane.id === explorerId ? sum + (sizes[i] ?? 0) : sum), 0);
  const free = Math.max(0, 1 - explorerShare);
  const p = Math.min(90, Math.max(10, Number.isFinite(input.percent) ? input.percent : 40)) / 100;
  const nextChildren: Node[] = [];
  const nextSizes: number[] = [];
  children.forEach((c, i) => {
    if (c.kind === "pane" && c.pane.id === main.id) {
      nextChildren.push({ kind: "pane", pane: left }, { kind: "pane", pane: rest });
      nextSizes.push(free * p, free * (1 - p));
    } else {
      nextChildren.push(c);
      nextSizes.push(sizes[i] ?? 0);
    }
  });

  const nextLayout: Layout = { ...layout, root: { kind: "group", group: { ...root.group, children: nextChildren, sizes: nextSizes } }, focusedPaneId: rest.id };
  const focusRestoration = { ...state.focusRestorationByWorkspace };
  delete focusRestoration[key];
  return updatePaseoLayout({
    layoutByWorkspace: { ...state.layoutByWorkspace, [key]: nextLayout },
    // 실제 렌더러는 탐색기를 먼저 떼고 이 두 칸의 크기만 읽는다. 탐색기 폭은 별도 px 저장소 그대로이다.
    splitSizesByWorkspace: { ...(state.splitSizesByWorkspace ?? {}), [key]: { ...(state.splitSizesByWorkspace?.[key] ?? {}), [ROOT_GROUP]: [p, 1 - p] } },
    focusRestorationByWorkspace: focusRestoration,
  });
}

/**
 * 좁은 화면(폰 모양)에서 작업 현황 탭만 든 칸이 따로 있으면 옆 칸에 합친다(true). 좁은 화면은 칸 하나만 보여 주고 탭 전환도
 * 그 칸의 탭만 보여 줘서(0.11.0-beta.5 workspace-screen.tsx focusedPaneTabState) 나뉜 채로는 대화 탭이 목록에서 사라진다
 * (10-08 리규형님 "탭 전환에서 채팅 목록이 아예 안 나타남"). 작업 공간 칸이 둘이고 그중 하나가 작업 현황 탭 하나뿐일 때만 —
 * 사람이 직접 나눈 다른 구조는 건드리지 않는다. 합친 칸은 작업 현황 탭을 보이고, 대화 탭은 같은 칸 탭 목록에 남는다
 */
export function mergeActivitySplit(input: { serverId: string; workspaceId: string; pluginId: string; panelId: string }): boolean {
  markWorkspaceInteraction();
  const state = readPaseoLayout() as State | null;
  if (!state) return false;
  const key = `${input.serverId}:${input.workspaceId}`;
  const layout = state.layoutByWorkspace?.[key];
  const root = layout?.root;
  if (!layout || !root || root.kind !== "group" || root.group.id !== ROOT_GROUP || root.group.direction !== "horizontal") return false;
  const children = root.group.children;
  const explorerId = state.explorerSidebarPaneIdByWorkspace?.[key] ?? EXPLORER_PANE;
  const tabId = pluginPanelTabId(input.pluginId, input.panelId);
  const work = children.filter((c) => !(c.kind === "pane" && c.pane.id === explorerId));
  if (work.length !== 2 || work.some((c) => c.kind !== "pane")) return false;
  const activityNode = work.find((c) => c.kind === "pane" && c.pane.tabIds.length === 1 && c.pane.tabIds[0] === tabId);
  const otherNode = work.find((c) => c !== activityNode);
  if (!activityNode || activityNode.kind !== "pane" || !otherNode || otherNode.kind !== "pane") return false;
  const other = otherNode.pane;
  const tab: Tab = activityNode.pane.tabs?.find((t) => t.tabId === tabId) ?? {
    tabId,
    target: { kind: "plugin", pluginId: input.pluginId, panelId: input.panelId, context: "workspace" },
    createdAt: Date.now(),
  };
  const merged: Pane = {
    ...other,
    tabIds: other.tabIds.includes(tabId) ? other.tabIds : [...other.tabIds, tabId],
    ...(other.tabs && !other.tabs.some((t) => t.tabId === tabId) ? { tabs: [...other.tabs, tab] } : {}),
    focusedTabId: tabId,
  };
  const sizes = root.group.sizes.length === children.length ? [...root.group.sizes] : children.map(() => 1 / children.length);
  const from = children.indexOf(activityNode);
  sizes[children.indexOf(otherNode)] += sizes[from] ?? 0;
  sizes.splice(from, 1);
  const nextChildren = children.filter((c) => c !== activityNode).map((c) => (c === otherNode ? ({ kind: "pane", pane: merged } as Node) : c));
  const nextLayout: Layout = { ...layout, root: { kind: "group", group: { ...root.group, children: nextChildren, sizes } }, focusedPaneId: merged.id };
  const sizesOfWorkspace = { ...(state.splitSizesByWorkspace?.[key] ?? {}) };
  delete sizesOfWorkspace[ROOT_GROUP];
  const focusRestoration = { ...state.focusRestorationByWorkspace };
  delete focusRestoration[key];
  return updatePaseoLayout({
    layoutByWorkspace: { ...state.layoutByWorkspace, [key]: nextLayout },
    splitSizesByWorkspace: { ...(state.splitSizesByWorkspace ?? {}), [key]: sizesOfWorkspace },
    focusRestorationByWorkspace: focusRestoration,
  });
}
