import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

// 차례 끝 훅의 대화 내용(10-24) — Paseo 0.13.0 부터 agent.turn_ended 가 timeline 을 빈 목록으로 넘긴다(발표 글 #7477
// "fetch recent history with timeline.refetch instead"). 0.12.0 이하 데몬(서버를 올리기 전)은 그대로 내용이 오므로 온 내용을 먼저 쓰고,
// 비었을 때만 그 대화 기록의 끝을 다시 읽는다. 이 내용을 읽는 곳: 압축 명령 자동 넣기(autoCompact.ts) · 압축 대기 아이콘(push.ts) ·
// 로그인 오류 알약(claudeLogin.ts) — 셋 다 빈 목록을 "보고 아님·오류 없음"으로 읽어 0.13.0 PC 에서 조용히 멈췄다

type PaseoApi = PluginHookContext["paseo"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
export type TurnItem = TurnEnded["timeline"][number];
type Entry = { item?: TurnItem; turnId?: string | null; seqEnd?: number };

/** 다시 읽을 때 기록 끝에서 가져올 항목 수 — 압축 명령 장치가 넣기 직전 다시 확인할 때 쓰던 수와 같다 */
export const TURN_TAIL_LIMIT = 40;

/** 마지막 답 글 뒤에 붙어도 "답으로 끝났다"를 바꾸지 않는 항목 — 생각·할 일·알림·플러그인 줄(10-25 같이 보기 팀원 답글) ·
 *  백그라운드 작업 끝 알림(Paseo 가 `tool_call` 이름 `task_notification` 으로 만든다 — Claude 가 부른 도구가 아니다. 10-25 콜어드민 Potal1:
 *  체크포인트 보고 뒤 1분 사이 하위 작업 끝 알림이 붙어 "보고가 아님"으로 읽고 압축 명령을 안 넣었다 — 사람이 붙여 넣을 때까지 멈춤) */
export function isAsideItem(item: { type: string }): boolean {
  if (item.type === "reasoning" || item.type === "todo" || item.type === "notification" || item.type === "plugin") return true;
  return item.type === "tool_call" && (item as { name?: unknown }).name === "task_notification";
}

/** 훅이 내용을 넘겼으면 그 내용, 비었으면 null(다시 읽어야 한다) */
export function deliveredTimeline<T>(event: { timeline?: readonly T[] }): readonly T[] | null {
  return event.timeline?.length ? event.timeline : null;
}

/** 다시 읽은 항목에서 끝난 차례까지만 — 그 사이 다음 차례가 시작됐으면 차례 번호가 다른 첫 항목부터 뺀다.
 *  차례 번호가 없는 항목은 남긴다(번호가 모든 항목에 붙는다는 보장이 없어, 번호로 자르면 마지막 답이 잘릴 수 있다) */
export function itemsUpToTurn(entries: readonly Entry[], turnId: string | null | undefined): TurnItem[] {
  const ordered = entries.every((e) => typeof e.seqEnd === "number") ? [...entries].sort((a, b) => a.seqEnd! - b.seqEnd!) : [...entries];
  let end = ordered.length;
  const mine = turnId ? ordered.map((e) => e.turnId).lastIndexOf(turnId) : -1;
  if (mine >= 0) {
    const next = ordered.findIndex((e, i) => i > mine && !!e.turnId && e.turnId !== turnId);
    if (next >= 0) end = next;
  }
  return ordered.slice(0, end).map((e) => e.item).filter((item): item is TurnItem => !!item);
}

/** 끝난 차례의 대화 내용. 훅이 넘긴 내용이 있으면 그것, 없으면 기록 끝을 다시 읽는다. 못 읽으면 null(모름 — 부르는 곳은 아무것도 바꾸지 않는다) */
export async function turnEndedTimeline(event: { agent: { id: string }; turnId?: string | null; timeline?: readonly unknown[] }, paseo: PaseoApi, limit = TURN_TAIL_LIMIT): Promise<readonly TurnItem[] | null> {
  const delivered = deliveredTimeline(event);
  if (delivered) return delivered as readonly TurnItem[];
  const page = await paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit, projection: "canonical" });
  if (!page || page.error) return null;
  return itemsUpToTurn((page.entries ?? []) as unknown as Entry[], event.turnId);
}
