// "열려 있는 대화"를 고른다 — VS Code 확장 상태바가 보여 주는 Claude 대화와 같은 규칙(리규형님 10-05 결정:
// Paseo 에는 상태바가 없어 확장 규칙을 데몬에서 재현한다). 복사본 출처:
//   · parseSessionFacts — 확장 src/providers/claude/tokenParser.ts getLatestTokenCount 의 판정 부분(2026-10-05)
//   · pickOpenSessions  — 확장 src/extension.ts findActiveSessions 의 대화 고르기(작업 공간 폴더 하나 = 묶음 하나)
// 확장 쪽 규칙을 고치면 여기도 같이 고쳐야 한다. 확장에서 손으로 숨긴 대화는 여기서 알 수 없어 빼지 못한다.

export interface SessionFacts {
  /** 마지막 /clear 뒤 마지막 응답의 컨텍스트 토큰(입력+캐시). 0 이면 응답이 없는 대화라 상태바에 안 나온다 */
  totalTokens: number;
  /** /clear 로 끝났고 그 뒤 사용자 메시지가 없다 */
  wasCleared: boolean;
  /** 마지막 /clear 뒤 첫 기록 시각 */
  sessionCreated: number | null;
  /** 마지막 실제 기록 시각(last-prompt 줄 제외 — 새 대화가 생길 때 옛 파일에 써져 수정 시각을 부풀린다) */
  lastRealTimestamp: number | null;
}

export function parseSessionFacts(content: string): SessionFacts {
  const lines = content.trim().split("\n");
  let lastClearIndex = -1;
  let userMessagesAfterClear = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "user" && entry.message?.content) {
        const msg = entry.message.content;
        if (typeof msg === "string" && msg.includes("<command-name>/clear</command-name>")) {
          lastClearIndex = i;
          break;
        }
        userMessagesAfterClear++;
      }
    } catch {
      continue;
    }
  }
  const wasCleared = lastClearIndex !== -1 && userMessagesAfterClear === 0;
  let sessionCreated: number | null = null;
  let lastRealTimestamp: number | null = null;
  let totalTokens = 0;
  for (let i = lastClearIndex >= 0 ? lastClearIndex + 1 : 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (sessionCreated === null && entry.timestamp) sessionCreated = new Date(entry.timestamp).getTime();
      if (entry.timestamp && entry.type !== "last-prompt") lastRealTimestamp = new Date(entry.timestamp).getTime();
      const u = entry.message?.usage || entry.usage;
      if (u) totalTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } catch {
      continue;
    }
  }
  return { totalTokens, wasCleared, sessionCreated, lastRealTimestamp };
}

export interface SessionFile {
  id: string;
  mtimeMs: number;
}

/**
 * 확장 findActiveSessions 와 같은 고르기: hideAfter(24시간) 안 · 응답 있음 · /clear 로 끝나지 않음 · 더 새 대화가
 * 이 대화의 마지막 기록 뒤에 생겼으면 밀린 것으로 보고 뺌 · 최근 순 5개. 하나도 없으면 기간과 상관없이 가장 최근 대화 하나.
 * @param files 대화 파일(agent- 제외), 아무 순서
 * @param factsOf 대화 하나의 판정(호출하는 쪽이 크기·수정 시각으로 캐시한다)
 */
export async function pickOpenSessions(files: SessionFile[], factsOf: (id: string) => Promise<SessionFacts | null>, now: number, hideAfterMs: number): Promise<Set<string>> {
  return (await pickOpenSessionsDetailed(files, factsOf, now, hideAfterMs)).ids;
}

/**
 * pickOpenSessions 에 "이번 세션 시작"을 더한 것(확장 currentChatSince): 열린 대화 가운데 가장 이른 시작 시각.
 * 대신 띄운 가장 최근 대화 하나(fallback)만 있으면 null — 확장도 그것은 세지 않는다.
 */
export async function pickOpenSessionsDetailed(
  files: SessionFile[],
  factsOf: (id: string) => Promise<SessionFacts | null>,
  now: number,
  hideAfterMs: number,
): Promise<{ ids: Set<string>; since: number | null }> {
  const ids = await pickCore(files, factsOf, now, hideAfterMs);
  if (ids.fallback) return { ids: ids.ids, since: null };
  let since: number | null = null;
  for (const id of ids.ids) {
    const created = (await factsOf(id))?.sessionCreated;
    if (created && (since === null || created < since)) since = created;
  }
  return { ids: ids.ids, since };
}

async function pickCore(files: SessionFile[], factsOf: (id: string) => Promise<SessionFacts | null>, now: number, hideAfterMs: number): Promise<{ ids: Set<string>; fallback: boolean }> {
  const recent = files.filter((f) => f.mtimeMs > now - hideAfterMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cands: { id: string; created: number; lastUpdated: number; cleared: boolean }[] = [];
  for (const f of recent) {
    const facts = await factsOf(f.id);
    if (!facts || facts.totalTokens <= 0) continue;
    cands.push({ id: f.id, created: facts.sessionCreated ?? 0, lastUpdated: facts.lastRealTimestamp ?? f.mtimeMs, cleared: facts.wasCleared });
  }
  // 생성 시각 최신순으로 놓고, 앞(더 새 대화)의 생성 시각이 이 대화의 마지막 기록보다 늦으면 밀린 대화다
  cands.sort((a, b) => b.created - a.created);
  const active: typeof cands = [];
  for (let i = 0; i < cands.length; i++) {
    const s = cands[i];
    if (s.cleared) continue;
    let superseded = false;
    for (let j = 0; j < i; j++) {
      if (cands[j].created > s.lastUpdated) {
        superseded = true;
        break;
      }
    }
    if (!superseded) active.push(s);
  }
  active.sort((a, b) => b.lastUpdated - a.lastUpdated);
  if (!active.length) {
    const newest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (newest) {
      const facts = await factsOf(newest.id);
      if (facts && facts.totalTokens > 0) return { ids: new Set([newest.id]), fallback: true };
    }
    return { ids: new Set(), fallback: false };
  }
  return { ids: new Set(active.slice(0, 5).map((s) => s.id)), fallback: false };
}
