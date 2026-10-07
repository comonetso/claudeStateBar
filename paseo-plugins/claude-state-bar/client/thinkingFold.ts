import { readLocal, writeLocal } from "./web";

// 생각 상자 모두 접기·펼치기(10-08 리규형님 결정 — 입력창 위 알약 하나로 모든 대화의 생각 상자를 한꺼번에, 앞으로 생기는
// 상자도 같은 상태로, 이 기기에 기억. Paseo 설정 "생각 자동 펼치기"와는 따로). 기기마다 올라오는 플러그인이 같은 실행 공간
// (globalThis)을 쓰므로 상태는 거기 하나만 두고, 기기별 생각 상자 관리자·알약이 모두 따른다

const KEY = "claude-state-bar.thinkingOpen";
type Hub = { open: boolean; listeners: Set<(open: boolean) => void> };

function hub(): Hub {
  const g = globalThis as Record<string, unknown>;
  return (g.__claudeStateBar_thinkingFold_v1 ??= { open: readLocal(KEY) !== "0", listeners: new Set() }) as Hub;
}

/** 지금 생각 상자들이 펼침 상태인가(처음은 펼침) */
export function thinkingAllOpen(): boolean {
  return hub().open;
}

export function setThinkingAllOpen(open: boolean): void {
  const h = hub();
  h.open = open;
  writeLocal(KEY, open ? "1" : "0");
  for (const listener of [...h.listeners]) listener(open);
}

/** 상태가 바뀔 때마다 부른다. 끊기 함수를 돌려준다 */
export function onThinkingAllOpen(listener: (open: boolean) => void): () => void {
  const h = hub();
  h.listeners.add(listener);
  return () => h.listeners.delete(listener);
}
