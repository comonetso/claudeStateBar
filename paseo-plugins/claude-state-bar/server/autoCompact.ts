import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { checkpointCommandLine } from "./chime/lastTurn";
import { deliveredTimeline, isAsideItem, turnEndedTimeline, type TurnItem } from "./turnTimeline";

// 압축 명령 자동 넣기(10-24 리규형님 — Mesa 메인·하위 대화가 자는 동안 압축 준비에서 멈춰 무중단이 깨졌다. 버튼: 플러그인이 대신 넣기 ·
// 모든 대화 · 답이 끝나고 1분 동안 말이 없으면 — 처음엔 3분, 같은 날 1분으로 줄임). 체크포인트 보고(start_compact)로 끝난 답이면 그 대화에 1분을 예약하고, 그 사이 새 차례가
// 시작되면(사람 말·다른 입력) 취소한다. 1분이 지나면 대화가 쉬고 있는지·마지막 답이 아직 그 보고인지 다시 보고, 보고 안의 명령어 줄을
// 그대로 보낸다(Paseo 는 /compact 를 입력창과 같은 길로 Claude Code 에 넘긴다 — 되감기만 자체 처리). 한 답에 한 번만(같은 글 번호면 데몬도
// 두 번 받지 않는다). 압축이 끝나면 깨우기 감시(start_compact compact_wake.js)가 Claude 를 깨워 하던 일을 잇는다.
// 한계: 예약은 이 플러그인 프로세스 안에만 있다 — 1분 안에 데몬·플러그인이 다시 뜨면 그 대화는 지금처럼 사람을 기다린다

type PaseoApi = PluginHookContext["paseo"];
type TimelineItem = { type: string; text?: string };

/** 1분 — 압축 준비 소리를 듣고 와서 다른 말을 먼저 할 틈(10-24 리규형님 버튼 "3분 기다렸다가, 그 사이 말이 없으면" → 같은 날 "1분으로 줄여, 압축 들어갈 때 할 말은 흔치 않다") */
export const AUTO_COMPACT_DELAY_MS = 60_000;

/** 차례 끝 기록에서 마지막 답의 압축 명령어 줄 — 답 글 뒤에 도구를 불렀거나 사람 말이 끼면 없다(push.ts endsWithCheckpoint 와 같은 판정) */
export function compactCommandOf(timeline: readonly TimelineItem[]): string | null {
  const parts: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") {
      parts.unshift(item.text ?? "");
      continue;
    }
    if (parts.length) break;
    if (isAsideItem(item)) continue;
    return null;
  }
  if (!parts.length) return null;
  // 답이 조각으로 쌓였으면 이어 붙여야 줄 맨 앞이 보이고, 따로 쌓인 답이면 하나씩 봐야 한다
  return checkpointCommandLine(parts.join("")) ?? parts.map((p) => checkpointCommandLine(p)).find((line) => line !== null) ?? null;
}

type Pending = { timer: unknown; turnId: string | null; line: string; paseo: PaseoApi };

export function createAutoCompact(options: {
  delayMs?: number;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
} = {}) {
  const delayMs = options.delayMs ?? AUTO_COMPACT_DELAY_MS;
  const log = options.log ?? ((message: string) => console.log(`[auto-compact] ${message}`));
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const pending = new Map<string, Pending>();
  const sent = new Set<string>(); // "대화:차례" — 한 답에 한 번
  let stopped = false;

  const cancel = (agentId: string, why: string) => {
    const p = pending.get(agentId);
    if (!p) return;
    clearTimer(p.timer);
    pending.delete(agentId);
    log(`${agentId.slice(0, 8)}: ${why} — 압축 명령 자동 넣기 취소`);
  };

  const fire = async (agentId: string, p: Pending) => {
    if (pending.get(agentId) !== p) return;
    pending.delete(agentId);
    if (stopped) return;
    const short = agentId.slice(0, 8);
    const key = `${agentId}:${p.turnId ?? ""}`;
    if (p.turnId && sent.has(key)) return;
    const handle = p.paseo.agents.ref(agentId);
    await handle.refresh();
    const now = handle.current();
    if (!now || now.archivedAt) return log(`${short}: 대화가 없거나 보관됨 — 압축 명령 안 넣음`);
    if (now.status !== "idle" || now.activeTurn || (now.pendingPermissions?.length ?? 0) > 0) {
      return log(`${short}: 쉬고 있지 않음(${now.status}${now.activeTurn ? " · 진행 중 차례" : ""}${now.pendingPermissions?.length ? " · 질문 대기" : ""}) — 압축 명령 안 넣음`);
    }
    // 차례 시작 알림을 놓쳤을 때를 위해 마지막 답이 아직 체크포인트 보고인지 다시 본다(기록을 못 읽으면 위 상태 확인만으로 넣는다)
    try {
      const page = await handle.timeline.refetch({ direction: "tail", limit: 40, projection: "canonical" });
      const items = (page?.entries ?? []).map((entry) => (entry as { item?: TimelineItem }).item).filter((item): item is TimelineItem => !!item);
      if (items.length && compactCommandOf(items) === null) return log(`${short}: 마지막 답이 체크포인트 보고가 아님 — 압축 명령 안 넣음`);
    } catch (error) {
      log(`${short}: 기록 다시 읽기 실패(${String(error)}) — 상태만 보고 넣음`);
    }
    sent.add(key);
    await handle.send(p.line, { messageId: `csb-compact-${short}-${p.turnId ?? Date.now()}` });
    log(`${short}: ${Math.round(delayMs / 1000)}초 동안 말이 없어 압축 명령을 넣음`);
  };

  // 대화마다 차례 시작·보관 횟수 — 기록을 다시 읽는 사이(0.13.0) 새 차례가 시작됐거나 보관됐으면 늦게 온 결과로 예약하지 않는다
  const turns = new Map<string, number>();
  const bump = (agentId: string) => turns.set(agentId, (turns.get(agentId) ?? 0) + 1);

  const arm = (agentId: string, turnId: string | null, timeline: readonly TurnItem[], paseo: PaseoApi) => {
    const line = compactCommandOf(timeline as readonly TimelineItem[]);
    if (!line) return;
    if (turnId && sent.has(`${agentId}:${turnId}`)) return;
    const old = pending.get(agentId);
    if (old) clearTimer(old.timer);
    const p: Pending = { timer: null, turnId, line, paseo };
    p.timer = setTimer(() => {
      fire(agentId, p).catch((error: unknown) => log(`${agentId.slice(0, 8)}: 압축 명령 넣기 실패 — ${String(error)}`));
    }, delayMs);
    pending.set(agentId, p);
    log(`${agentId.slice(0, 8)}: 체크포인트 보고로 끝남 — ${Math.round(delayMs / 1000)}초 동안 말이 없으면 압축 명령을 넣음`);
  };

  return {
    onTurnStarted({ agent }: PluginLifecycleEvents["agent.turn_started"]) {
      bump(agent.id);
      cancel(agent.id, "새 차례가 시작됨");
    },
    onTurnEnded(event: PluginLifecycleEvents["agent.turn_ended"], { paseo }: { paseo: PaseoApi }) {
      const { agent, turnId, outcome } = event;
      cancel(agent.id, "다른 차례가 끝남");
      if (stopped || outcome.kind !== "completed") return;
      // 0.12.0 이하 데몬은 훅이 내용을 넘긴다 — 지금처럼 바로 예약
      const delivered = deliveredTimeline(event);
      if (delivered) return arm(agent.id, turnId ?? null, delivered, paseo);
      // 0.13.0 — 빈 목록이라 기록 끝을 다시 읽는다(server/turnTimeline.ts)
      const short = agent.id.slice(0, 8);
      const seen = turns.get(agent.id) ?? 0;
      return turnEndedTimeline(event, paseo).then(
        (items) => {
          if (stopped) return;
          if ((turns.get(agent.id) ?? 0) !== seen) return log(`${short}: 기록을 다시 읽는 사이 새 차례가 시작되거나 보관됨 — 예약 안 함`);
          if (!items) return log(`${short}: 끝난 차례 기록을 못 읽음 — 예약 안 함`);
          arm(agent.id, turnId ?? null, items, paseo);
        },
        (error: unknown) => log(`${short}: 끝난 차례 기록 다시 읽기 실패(${String(error)}) — 예약 안 함`),
      );
    },
    onArchived({ agent }: PluginLifecycleEvents["agent.archived"]) {
      bump(agent.id);
      cancel(agent.id, "보관됨");
    },
    /** 예약이 걸린 대화(시험·진단용) */
    pendingIds: () => [...pending.keys()],
    stop() {
      stopped = true;
      for (const p of pending.values()) clearTimer(p.timer);
      pending.clear();
    },
  };
}
