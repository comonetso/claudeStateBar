import { useSyncExternalStore } from "react";
import { ACTIVITY_PANEL_ID } from "./activityKinds";
import { layoutHasPanel } from "./activitySplit";
import { watchPaseoLayout } from "./web";

// 작업 현황 패널이 열려 있는지(작업 공간별) — 머리줄 단추 글자·아이콘을 초록으로 칠한다(10-14 리규형님).
// 🔴 열려 있으면 늘 초록이다. 대화 칸을 최대화해 작업 현황 칸이 가려져도 초록이어야 한다(리규형님: 최대화했을 때 패널이
// 열려 있다는 걸 알려는 것). 처음엔 "화면에 보일 때만"으로 만들어 최대화 중에 꺼졌다 — 크기로 판정하지 마라.
// 판정: 그 작업 공간 배치의 어느 칸에든 작업 현황 탭이 있으면 열림. 배치를 못 읽는 판(PASEO_BUNDLES 표에 없음)에서는
// 패널이 그려져 있는 동안(크기 무관) 열림으로 본다. 단추와 패널은 같은 호스트 플러그인이 그리므로 이 모듈 안에 둔다.

const PLUGIN_ID = "claude-state-bar";
const mounted = new Map<string, Set<symbol>>();
const listeners = new Set<() => void>();

export function setActivityMounted(workspaceId: string, key: symbol, on: boolean): void {
  const set = mounted.get(workspaceId) ?? new Set<symbol>();
  const before = set.size > 0;
  if (on) set.add(key);
  else set.delete(key);
  if (set.size) mounted.set(workspaceId, set);
  else mounted.delete(workspaceId);
  if (before !== set.size > 0) for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const stopLayout = watchPaseoLayout(fn);
  return () => {
    listeners.delete(fn);
    stopLayout();
  };
}

export function activityOpen(workspaceId: string): boolean {
  const inLayout = layoutHasPanel(workspaceId, PLUGIN_ID, ACTIVITY_PANEL_ID);
  return inLayout ?? (mounted.get(workspaceId)?.size ?? 0) > 0;
}

export function useActivityOpen(workspaceId: string): boolean {
  const read = () => activityOpen(workspaceId);
  return useSyncExternalStore(subscribe, read, read);
}
