import { useEffect, useState } from "react";
import { activityCounts, type ActivityCounts } from "../shared/activity";
import { soundOrigin, watchSoundOrigins } from "./soundScreen";
import { IDLE_POLL_MS, LIVE_POLL_MS } from "./useCounts";

// 프로젝트 목록 줄 이름 옆 "(서브에이전트, 백그라운드, Codex)" 숫자(10-14 리규형님 결정 4건): 활성(열린 대화가 있는) 프로젝트만 ·
// Codex = 실행 + 핑퐁 채팅 · 셋 다 0 이면 숨김 · 간격은 작업 현황 단추와 같다(돌고 있으면 2초, 아니면 30초 — useCounts).
// 숫자는 그 프로젝트가 있는 기기의 데몬에 작업 현황 단추와 같은 activityCounts 로 묻는다(서버 3대에 이미 있다 — 새 서버 기능 없음).
// 기기 연결은 화면이 기기마다 붙여 둔 플러그인 연결(soundScreen origins)을 쓴다. 아직 안 붙었으면 붙는 순간 다시 읽는다.

export type ProjectTarget = { key: string; serverId: string; directory: string };
export type ProjectCounts = { subagents: number; background: number; codex: number };

const toRow = (c: ActivityCounts): ProjectCounts => ({ subagents: c.workflows, background: c.background, codex: c.codexRuns + c.codexChats });
const same = (a: ProjectCounts | undefined, b: ProjectCounts) => !!a && a.subagents === b.subagents && a.background === b.background && a.codex === b.codex;

/** 목록이 그려져 있는 동안만 읽는다. 대상이 바뀌면 그 대상만 새로 돈다(같은 프로젝트는 타이머를 이어 간다) */
export function useProjectCounts(targets: ProjectTarget[]): Map<string, ProjectCounts> {
  const [counts, setCounts] = useState<Map<string, ProjectCounts>>(() => new Map());
  // 대상 목록이 렌더마다 새 배열이라 내용으로만 비교한다
  const signature = targets.map((t) => `${t.key}\u0000${t.serverId}\u0000${t.directory}`).sort().join("\u0001");
  useEffect(() => {
    const list = signature ? signature.split("\u0001").map((s) => { const [key, serverId, directory] = s.split("\u0000"); return { key, serverId, directory }; }) : [];
    let stopped = false;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const seq = new Map<string, number>();
    const waiting = new Set<string>(); // 기기 연결이 아직 없어 붙기를 기다리는 대상
    const tick = async (t: ProjectTarget) => {
      timers.delete(t.key);
      const origin = soundOrigin(t.serverId);
      if (!origin) { waiting.add(t.key); return; }
      waiting.delete(t.key);
      const mine = (seq.get(t.key) ?? 0) + 1;
      seq.set(t.key, mine);
      let live = false;
      try {
        const row = toRow(await origin.rpc(activityCounts, { cwd: t.directory }));
        live = row.subagents + row.background + row.codex > 0;
        if (!stopped && seq.get(t.key) === mine) setCounts((prev) => (same(prev.get(t.key), row) ? prev : new Map(prev).set(t.key, row)));
      } catch {
        /* 데몬이 잠깐 못 받으면 다음 차례에 다시 읽는다 */
      }
      if (!stopped && seq.get(t.key) === mine) timers.set(t.key, setTimeout(() => void tick(t), live ? LIVE_POLL_MS : IDLE_POLL_MS));
    };
    for (const t of list) void tick(t);
    const unwatch = watchSoundOrigins(() => {
      for (const t of list) if (waiting.has(t.key) && soundOrigin(t.serverId)) void tick(t);
    });
    // 빠진 대상의 숫자는 지운다
    const keys = new Set(list.map((t) => t.key));
    setCounts((prev) => { const next = new Map([...prev].filter(([k]) => keys.has(k))); return next.size === prev.size ? prev : next; });
    return () => {
      stopped = true;
      unwatch();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [signature]);
  return counts;
}

export const countsTotal = (c: ProjectCounts | undefined) => (c ? c.subagents + c.background + c.codex : 0);
