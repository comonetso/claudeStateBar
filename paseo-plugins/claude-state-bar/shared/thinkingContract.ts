import type { BoundaryAnswer, BoundaryReason, BoundaryState } from "./thinkingBoundary";

// 생각 상자 글을 쓰는 다섯 기능(상자에서 말 꺼내기·번역·읽기 단추·따라 읽기·작업 끝 소리)의 공통 약속(10-18, Codex 261018_052815
// C3·C4·C6). 전체 약속과 기능별 기대는 docs/paseo-plugin-tools/THINKING_CONTRACT.md(비공개 docs 레포). 이 파일은 순수 함수만 둔다 —
// 화면(thinking.tsx·web.ts)과 시험이 같이 쓴다. 시간 간격·시간 문턱은 쓰지 않는다: 다시 묻는 계기는 글이 바뀜·턴 상태가 바뀜·앞 답이
// 옴뿐이고, 기다리는 시간은 데몬의 WAIT_MS(server/thinkingBoundary.ts, 25초) 하나다. 횟수 상한은 하나 — ACTIVE_PENDING_LIMIT(아래).

// ── C3. 경계 묻기 ──────────────────────────────────────────────────────────────────────────────

/** 대화의 지금 상태(화면이 Paseo 대화 갱신으로 안다). starts = 이 화면이 본 "일하기 시작" 횟수 — activeTurn 이 없는 판에서 턴을 가른다 */
export type AgentTurnInfo = { status: string; turnId: string | null; starts: number };
/**
 * 상자가 어느 턴의 것인가 — 상자를 처음 볼 때 한 번 정한다(상자 상태에 둔다).
 * live = 대화가 일하는 중에 생각 중(streaming)으로 처음 봤다 → 그 턴의 상자 · old = 대화가 쉬는 중에 처음 봤다 → 지난 상자 ·
 * unsure = 일하는 중인데 이미 끝난(complete) 상자로 처음 봤다(턴 중간에 연 화면 등) → 이 턴 것인지 지난 턴 것인지 모른다.
 *   그래도 처음 본 그 턴(starts·turnId)은 적어 둔다 — 그 턴이 끝나면 기록이 다 적혀 있으니 그때 마지막 한 번을 쓴다(10-18 2차).
 *   starts 가 null 이면 대화 상태를 못 얻어 그 턴도 모른다 → 턴 끝을 알 수 없어 한 번만 묻는다
 */
export type BoxTurn =
  | { mark: "live"; starts: number; turnId: string | null }
  | { mark: "old" }
  | { mark: "unsure"; starts: number | null; turnId: string | null };
/**
 * 경계 묻기에서 본 상자와 지금 턴의 관계.
 * active = 이 턴에 생각 중으로 본 상자, 그 턴이 아직 돈다 — "아직 기록에 없음"을 이어 기다린다(ACTIVE_PENDING_LIMIT 까지) ·
 * unsure = 턴을 모르는 상자인데 처음 본 그 턴이 아직 돈다 — 기다리는 한 번만 묻고 마지막 한 번은 남겨 둔다 ·
 * ended = 상자를 본 그 턴이 끝났다 — 마지막 한 번 · old = 지난 상자 — 기다리지 않는 한 번 ·
 * unknown = 턴도 턴 끝도 알 수 없다 — 기다리는 한 번(그것이 마지막 한 번)
 */
export type BoundaryTurn = "active" | "unsure" | "ended" | "old" | "unknown";

export function classifyBoxTurn(info: AgentTurnInfo | "failed", phase: "streaming" | "complete"): BoxTurn {
  if (info === "failed") return { mark: "unsure", starts: null, turnId: null };
  if (info.status !== "running") return { mark: "old" };
  return phase === "streaming"
    ? { mark: "live", starts: info.starts, turnId: info.turnId }
    : { mark: "unsure", starts: info.starts, turnId: info.turnId };
}

/** null = 대화 상태를 아직 받는 중 — 묻지 않고 기다린다(받으면 다시 정한다) */
export function boundaryTurnOf(box: BoxTurn | undefined, info: AgentTurnInfo | "loading" | "failed"): BoundaryTurn | null {
  if (!box) return info === "loading" ? null : "unknown";
  if (box.mark === "old") return "old";
  if (box.mark === "unsure" && box.starts === null) return "unknown";
  if (info === "loading" || info === "failed") return "ended";
  const sameTurn = info.status === "running" && info.starts === box.starts && (box.turnId === null || info.turnId === null || box.turnId === info.turnId);
  if (!sameTurn) return "ended";
  return box.mark === "live" ? "active" : "unsure";
}

/** 상자 하나의 경계 묻기 진행 — 상자 상태에 둔다(가상 목록이 상자를 다시 그려도 같은 글로 또 묻지 않게) */
export type BoundaryTrack = {
  /** 요청 하나가 나가 있다 — 한 상자에 한 번에 하나만 */
  busy: boolean;
  /** 마지막으로 받아들인 답의 기준 글(\r 뺀) — 글이 바뀌면 새 글로 다시 묻는다 */
  text?: string;
  /** 마지막 답 — legacy = 상태를 모르는 옛 데몬이 cut:null 을 줌 · failed = 요청 자체가 실패(전송 끊김 등) */
  last?: BoundaryState | "legacy" | "failed";
  reason?: BoundaryReason;
  /** 턴이 끝났거나 턴을 모를 때 쓰는 마지막 한 번을 썼다 */
  finalUsed: boolean;
  /** 같은 글로 잇달아 받은 pending 수 — 글이 바뀌거나 pending 이 아닌 답이 오면 0. active 의 이어 기다리기 상한(ACTIVE_PENDING_LIMIT)에 쓴다 */
  pendingStreak: number;
  /** 보낸 요청 수(시험·기록용) */
  asks: number;
};

/**
 * 지금 턴 상자가 같은 글로 "아직 기록에 없음(pending)"을 받고 이어 기다리는 횟수 상한(10-18 2차, 1차 검증 2 issue 9).
 * 데몬은 기다리는 요청마다 WAIT_MS(25초)를 다 기다린 뒤에야 pending 을 주므로 24번 ≈ 10분이다. 기록은 그 응답의 도구 호출 직전에
 * 적혀(10-09 실측) 긴 도구 입력(큰 파일 쓰기 등)을 만드는 동안 늦는다 — 그 몇 분은 넘기고, 글이 기록과 끝내 안 맞는 상자가
 * 몇 시간짜리 턴(Mesa 무중단) 내내 25초마다 묻고 데몬 로그 "[thinking] boundary not found after wait" 를 쌓는 것은 막는다.
 * 상한에 닿으면 이어 묻지 않고 턴이 끝날 때 마지막 한 번만 묻는다(그 사이 진행 글은 상자 안에 남는다 — 턴 모르는 상자와 같은 대가)
 */
export const ACTIVE_PENDING_LIMIT = 24;

export function newBoundaryTrack(): BoundaryTrack {
  return { busy: false, finalUsed: false, pendingStreak: 0, asks: 0 };
}

/**
 * 지금 물을지 정하고, 물으면 진행 표시(busy·asks·마지막 한 번)를 바꾼다. null = 묻지 않음.
 * - 꺼낼 자리가 이미 있거나 요청이 나가 있거나 Claude 대화가 아니면(unsupported) 묻지 않는다
 * - 새 글: active·unsure 는 기다리는 요청(마지막 한 번은 남겨 둔다), old 는 기다리지 않는 한 번,
 *   ended·unknown 은 기다리는 한 번(옛 동작과 같은 한 번 — 마지막 한 번으로 친다)
 * - 같은 글로 이미 답을 받았으면: matched·unavailable 은 끝(한 칸 matched:null 도 확정 — C5 자동 꺼내기 안 함).
 *   active 는 pending 일 때만, 잇단 pending 이 ACTIVE_PENDING_LIMIT 보다 적을 때만 다시 기다린다(데몬이 WAIT_MS 동안 기다린 뒤
 *   답하므로 촘촘히 돌지 않는다. legacy·failed 는 이어 묻지 않는다). unsure 는 턴이 끝나기를 기다린다(묻지 않음).
 *   ended·unknown 은 마지막 한 번이 남았으면 한 번 더(턴이 끝나면 기록이 다 적혀 있다), old 는 끝
 */
export function boundaryBegin(track: BoundaryTrack, text: string, cutKnown: boolean, turn: BoundaryTurn): { wait: boolean } | null {
  if (cutKnown || track.busy || track.reason === "unsupported") return null;
  let plan: { wait: boolean } | null = null;
  if (track.text !== text) {
    if (turn === "active" || turn === "unsure") plan = { wait: true };
    else if (turn === "old") plan = { wait: false };
    else {
      track.finalUsed = true;
      plan = { wait: true };
    }
  } else if (track.last === "matched" || track.last === "unavailable") plan = null;
  else if (turn === "active") plan = track.last === "pending" && track.pendingStreak < ACTIVE_PENDING_LIMIT ? { wait: true } : null;
  else if ((turn === "ended" || turn === "unknown") && !track.finalUsed) {
    track.finalUsed = true;
    plan = { wait: true };
  }
  if (plan) {
    track.busy = true;
    track.asks += 1;
  }
  return plan;
}

/**
 * 답을 받아들인다. answer 가 undefined 면 요청이 실패한 것. 돌려주는 값이 숫자면 그 자리로 꺼낸다.
 * 답이 온 사이 상자 글이 바뀌었으면(current !== sent) 그 답은 버린다 — 옛 글로 찾은 자리를 새 글에 쓰지 않는다(다음 묻기가 새 글로 다시 묻는다)
 */
export function boundaryEnd(track: BoundaryTrack, sent: string, answer: BoundaryAnswer | undefined, current: string): number | null {
  track.busy = false;
  if (current !== sent) return null;
  if (track.text !== sent) track.pendingStreak = 0;
  track.text = sent;
  track.reason = undefined;
  if (!answer) {
    track.last = "failed";
    track.pendingStreak = 0;
    return null;
  }
  if (!answer.state) {
    track.last = answer.cut != null ? "matched" : "legacy";
    track.pendingStreak = 0;
    return answer.cut;
  }
  track.last = answer.state;
  track.pendingStreak = answer.state === "pending" ? track.pendingStreak + 1 : 0;
  if (answer.state === "unavailable") track.reason = answer.reason;
  return answer.state === "matched" ? answer.cut : null;
}

/**
 * 묻기 한 걸음(thinking.tsx 가 쓰고 시험도 같은 함수를 돈다). 물을 일이 있으면 요청을 보내고 true. 답이 오면 자리를 넣고(apply)
 * next 를 부른다 — next 는 그때 그려진 상자의 묻기 함수다(없으면 멈춤). text 는 \r 을 뺀 지금 상자 글을 돌려준다.
 * recheck(10-18 2차, 1차 검증 2 issue 9): 지금 턴(active·unsure)으로 보고 보낸 요청이 pending 이면, 대화가 아직 일하는지 한 번
 * 다시 받아 온 뒤 next 를 부른다 — 대화 갱신(agents.subscribe)이 안 와도 턴이 끝난 것을 알아채 이어 묻기를 멈추고 마지막 한 번으로 넘어간다
 */
export function boundaryStep(o: {
  track: BoundaryTrack;
  text: () => string;
  cutKnown: boolean;
  turn: BoundaryTurn | null;
  rpc: (input: { text: string; wait: boolean }) => Promise<BoundaryAnswer>;
  apply: (cut: number) => void;
  next: () => void;
  recheck?: () => Promise<unknown>;
}): boolean {
  if (o.turn === null) return false; // 대화 상태를 받는 중 — 받으면 다시 부른다
  const sent = o.text();
  const turn = o.turn;
  const plan = boundaryBegin(o.track, sent, o.cutKnown, turn);
  if (!plan) return false;
  const settle = (answer: BoundaryAnswer | undefined) => {
    const current = o.text();
    const cut = boundaryEnd(o.track, sent, answer, current);
    if (typeof cut === "number") o.apply(cut);
    // 받아들인 pending 답일 때만(글이 바뀌어 버린 답은 새 글로 바로 다시 묻는다)
    if (!o.recheck || current !== sent || answer?.state !== "pending" || (turn !== "active" && turn !== "unsure")) {
      o.next();
      return;
    }
    let again: Promise<unknown>;
    try {
      again = Promise.resolve(o.recheck());
    } catch (error) {
      again = Promise.reject(error);
    }
    void again.then(() => o.next(), () => o.next());
  };
  let reply: Promise<BoundaryAnswer>;
  try {
    reply = o.rpc({ text: sent, wait: plan.wait });
  } catch (error) {
    reply = Promise.reject(error);
  }
  void reply.then(settle, () => settle(undefined));
  return true;
}

// ── C4. 따라 읽기 순서 ─────────────────────────────────────────────────────────────────────────

/** 따라 읽기 상태 중 순서 판단에 쓰는 것(client/web.ts FollowState) */
export type FollowMarks = { skip: ReadonlySet<string>; taken: ReadonlyMap<string, number>; pushed: ReadonlySet<string> };
/** 한 번 훑기의 결정 — scan=false 면 아는 말이 하나도 안 보여 새로 받지 않는다 */
export type FollowPlan = { scan: boolean; take: string[]; old: string[]; late: string[] };

/**
 * 화면 순서(keys = 같은 대화의 말 단위 열쇠, 한 번 훑은 순서)로 새 말을 받을지 정한다. 읽기 순서는 앞으로만 간다(C4):
 * - old: 출발점 앞(읽지 않는 말 중 마지막 것보다 앞, 안 보이면 받은 말 중 첫 것보다 앞)에 새로 보인 옛 말 — 조용히 건너뜀(예전 규칙)
 * - late: 이미 재생기에 넘긴 말(pushed) 중 화면에 보이는 마지막 것보다 앞에 늦게 생긴 말 — 생각 상자에서 늦게 꺼낸 말 등. 지금 읽는
 *   순서 뒤에 끼워 넣지 않고 건너뛴다(화면에는 남고 "이 말 읽기"로 따로 읽는다)
 * - take: 그 밖 — 화면 순서대로 받는다
 * 비교는 한 번 훑은 화면 안의 앞뒤만 쓴다(Paseo 화면 SDK 가 생각 항목에 원본 순번을 주지 않아서 — 숫자 순번을 지어내지 않는다).
 * 넘긴 말 중 마지막 것이 화면 밖이면 보이는 것 중 마지막으로 비교한다(그보다 뒤는 예전처럼 받는다)
 */
export function followPlan(keys: readonly string[], marks: FollowMarks): FollowPlan {
  let lastSkip = -1;
  let firstTaken = -1;
  let lastPushed = -1;
  keys.forEach((key, i) => {
    if (marks.skip.has(key)) lastSkip = i;
    else if (marks.taken.has(key)) {
      if (firstTaken < 0) firstTaken = i;
      if (marks.pushed.has(key)) lastPushed = i;
    }
  });
  const oldBefore = lastSkip >= 0 ? lastSkip : firstTaken;
  const plan: FollowPlan = { scan: oldBefore >= 0 || (!marks.skip.size && !marks.taken.size), take: [], old: [], late: [] };
  if (!plan.scan) return plan;
  keys.forEach((key, i) => {
    if (marks.skip.has(key) || marks.taken.has(key)) return;
    if (i < oldBefore) plan.old.push(key);
    else if (i < lastPushed) plan.late.push(key);
    else plan.take.push(key);
  });
  return plan;
}

// ── C5. 따라 읽기 번역 기다리기(10-24) ─────────────────────────────────────────────────────────
// 리규형님: "따라 읽기 할 때 이미 번역된 한글은 한글로 읽는데, 그 후 생긴 영문은 번역본이 있어도 영어로 읽음" — 끝난 문단을 넘기는
// 순간 DeepL 이 아직 번역 전이라 영어 글이 재생기로 갔다. 웹 읽기 확장(read-aloud-hrg, peer_mail e164953b)과 같은 방식으로 기다린다
// (리규형님 버튼 "웹 읽기 확장과 같게"): 번역 중 표시면 최대 5초, 표시가 없는 문단은 1초 지켜본 뒤 넘긴다

/** 번역 중 표시(data-dl-translated="false")를 본 문단을 기다리는 최대 시간 — 넘으면 지금 글(원문)로 넘긴다 */
export const TRANSLATION_WAIT_MS = 5000;
/** 페이지에 DeepL 표시가 있는데 이 문단엔 아직 없을 때 표시가 붙는지 지켜보는 시간 — 안 붙으면 번역 대상이 아닌 글로 본다 */
export const TRANSLATION_MARK_WAIT_MS = 1000;

/**
 * 문단의 번역 상태 — pending: 번역 중 표시 · done: 번역 끝 표시 · none: 페이지엔 DeepL 표시가 있는데 이 문단엔 없음 ·
 * off: 기다릴 것 없음(페이지에 DeepL 표시가 없음 = 번역을 안 켠 화면·폰 앱, 또는 이미 한국어 위주인 문단)
 */
export type TranslationMark = "pending" | "done" | "none" | "off";
export type TranslationWait = { key: string; part: number; since: number; marked: boolean };

/**
 * 한국어 위주 글인가 — 한글이 든 어절이 영문만 있는 어절보다 적지 않다. Claude 가 한글로 쓴 문단은 DeepL 이 손대지 않아 표시가
 * 없으니 기다리지 않는다(안 그러면 문단마다 1초씩 늦는다). 글자 수가 아니라 어절로 센다 — 한국어 문장 안 긴 코드 이름(findAllCodexDirs)이
 * 한 어절이어야 한다. 영어 문단에 짧은 한글 인용이 섞인 것은 영어로 본다
 */
export function koreanMostly(text: string): boolean {
  let ko = 0;
  let latin = 0;
  for (const word of text.split(/\s+/)) {
    if (/[가-힣ㄱ-ㆎ]/.test(word)) ko++;
    else if (/[A-Za-z]/.test(word)) latin++;
  }
  return ko > 0 && ko >= latin;
}

/**
 * 그 문단을 지금 재생기에 넘겨도 되는가. 같은 문단(key·part)을 이어서 기다리면 since 를 유지한다. 표시 없이 지켜보던 문단에 번역 중
 * 표시가 붙으면 marked 가 되어 상한이 5초로 늘어난다(since 는 처음 기다린 때). 시간이 다 되면 timedOut 과 함께 넘긴다
 */
export function translationGate(wait: TranslationWait | undefined, key: string, part: number, mark: TranslationMark, now: number): { pass: boolean; wait?: TranslationWait; timedOut?: boolean } {
  if (mark === "done" || mark === "off") return { pass: true };
  const same = wait && wait.key === key && wait.part === part;
  const w: TranslationWait = same ? { ...wait } : { key, part, since: now, marked: false };
  if (mark === "pending") w.marked = true;
  const limit = w.marked ? TRANSLATION_WAIT_MS : TRANSLATION_MARK_WAIT_MS;
  if (now - w.since >= limit) return { pass: true, timedOut: true };
  return { pass: false, wait: w };
}
