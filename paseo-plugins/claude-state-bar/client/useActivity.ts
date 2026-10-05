import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { activityList, type BgCard, type WorkflowCard } from "../shared/activity";

type ActivityData = { projectDir: string | null; sessions: number; workflows: WorkflowCard[]; background: BgCard[] };

// 확장과 같은 간격: 무언가 돌고 있으면 2초, 아니면 상태바 기본 새로 고침 30초
const LIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 30000;

/** 작업 공간 폴더의 워크플로우·백그라운드 목록. isLive 로 돌고 있는지 알려 주면 빨리 다시 읽는다. */
export function useActivity(workspaceId: string, isLive: (data: ActivityData) => boolean) {
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const fetchList = useRpc(activityList);
  const [data, setData] = useState<ActivityData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 마지막에 시작한 읽기의 답만 반영한다 — 늦게 온 옛 답이 새 목록을 덮던 것(Codex 검토 10-05). 폴더가 바뀌면 진행 중인 답도 버린다
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [directory],
  );
  const load = useCallback(async () => {
    if (!directory) return;
    const mine = ++seq.current;
    try {
      const next = await fetchList({ cwd: directory });
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    }
  }, [directory, fetchList]);

  const live = data ? isLive(data) : false;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [load, live]);

  return { directory, data, error, live, reload: load };
}
