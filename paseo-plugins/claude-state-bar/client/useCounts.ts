import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { activityCounts, type ActivityCounts } from "../shared/activity";

// 작업 공간 폴더에서 돌고 있는 수(확장 activityCounts) — 머리줄 단추와 작업 현황 탭 숫자가 같이 쓴다.
// 확장 탭과 같은 간격: 무언가 돌고 있으면 2초, 아니면 상태바 기본 새로 고침 30초
const LIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 30000;

export const totalOf = (c: ActivityCounts) => c.workflows + c.background + c.codexRuns + c.codexChats;

// 작업 공간별 마지막으로 받은 숫자 — 머리줄 단추를 누를 때 어느 탭을 열지 고른다
const latest = new Map<string, ActivityCounts>();
export const latestCounts = (workspaceId: string) => latest.get(workspaceId);

/** 그려져 있는 동안만 읽는다. 마지막에 시작한 요청의 답만 반영한다(늦게 온 옛 답이 새 숫자를 덮던 것 — Codex 검토 10-05) */
export function useCounts(workspaceId: string): ActivityCounts | null {
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const fetchCounts = useRpc(activityCounts);
  const [counts, setCounts] = useState<ActivityCounts | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!directory) return;
    const mine = ++seq.current;
    try {
      const next = await fetchCounts({ cwd: directory });
      if (mine === seq.current) {
        latest.set(workspaceId, next);
        setCounts(next);
      }
    } catch {
      /* 데몬이 잠깐 못 받으면 다음 차례에 다시 읽는다 */
    }
  }, [directory, fetchCounts, workspaceId]);
  // 폴더가 바뀌면 앞 폴더의 숫자와 아직 안 온 답을 버린다
  useEffect(() => {
    setCounts(null);
    return () => {
      seq.current++;
    };
  }, [directory]);
  const live = counts ? totalOf(counts) > 0 : false;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [load, live]);
  return counts;
}

// 머리줄 단추 작은 창에서 고른 탭을 작업 현황 패널에 건넨다(패널 열기에는 탭을 실어 보낼 칸이 없다)
const requested = new Map<string, string>();
const listeners = new Set<() => void>();
export function requestTab(workspaceId: string, tab: string): void {
  requested.set(workspaceId, tab);
  for (const fn of listeners) fn();
}
export function takeRequestedTab(workspaceId: string): string | undefined {
  const tab = requested.get(workspaceId);
  requested.delete(workspaceId);
  return tab;
}
export function onTabRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
