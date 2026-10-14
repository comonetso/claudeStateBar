import { Platform } from "react-native";
import { currentWorkspaceFromUrl, lastLayoutAppliedAt, onUserInput, readSession, watchLocation, writeSession } from "./web";

// 이 플러그인은 DOM 타입을 쓰지 않는다 — 쓰는 것만 선언한다(web.ts 와 같은 방식)
type El = {
  closest?(selector: string): El | null;
  querySelectorAll?(selector: string): ArrayLike<El>;
  getAttribute?(name: string): string | null;
  getClientRects?(): { length: number };
  click?(): void;
};
type DocEvent = { target?: El | null };
declare const document: {
  visibilityState?: string;
  wasDiscarded?: boolean;
  body?: unknown;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<El>;
  addEventListener(type: string, fn: (event: DocEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (event: DocEvent) => void, capture?: boolean): void;
};
declare const window: { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
declare const navigator: { onLine?: boolean } | undefined;
declare const performance: { timeOrigin: number } | undefined;
declare const MutationObserver:
  | (new (fn: () => void) => { observe(target: unknown, options: { childList: boolean; subtree: boolean }): void; disconnect(): void })
  | undefined;

// 칸 최대화가 저절로 풀리는 원인 기록(10-09 리규형님 "최대화를 해 놓고 한참 있다가 돌아오면 풀려 있는 경우가 더러 있다" →
// 결정 "원인부터 기록") + 페이지가 새로 읽혀 풀린 것은 되살리기(같은 날 저녁 리규형님 결정 "되살리기 넣기").
// 풀린 순간의 상황은 플러그인 로그(PC 데몬 `paseo plugin logs claude-state-bar`의 `[client] pane max lost …`)에 한 줄 남긴다.
// Paseo 0.11.1 은 최대화 칸을 화면 부품의 임시 상태(SplitContainer useState {workspaceKey, paneId})에만 두고 저장하지 않는다.
// 그래서 페이지가 새로 읽히면(브라우저가 잠재운 탭을 깨울 때 포함) 풀리고, 배치가 비거나 칸이 하나뿐이거나 그 칸이 배치에서
// 빠지면 스스로 지운다(splitNodeContainsPane(…)||setMaximized(null)). 어느 쪽인지 가리려고 아래 상황을 함께 적는다.
// 최대화 중에는 그 칸의 단추가 testID workspace-restore-pane 이다(paneMaximized.ts 와 같은 표식). 웹·데스크톱만.
// 10-09 기록 정리: 리규형님 화면에서 진짜 풀린 것은 전부 새로 읽힌 직후(after-reload)였다.
//
// 되살리기: 최대화 중에 작업 공간마다 "몇 번째 칸 / 칸 몇 개"를 탭 저장소에 적어 두고, 그 작업 공간으로 돌아오거나 페이지가
// 새로 읽힌 뒤 칸 단추가 그만큼 그려지면 그 순서의 최대화 단추를 대신 누른다(RN-web 단추는 click 에도 onPress 를 부른다 —
// 0.11.1 PressResponder onClick). 최대화 중에도 다른 칸은 크기 0 으로 숨겨질 뿐 남아 있어(split-group-child-hidden) 순서를 셀 수 있다.
// 10-14 리규형님: Paseo 는 최대화를 화면 전체에 하나만 두고 다른 작업 공간으로 가면 지워서, 예전에 작업 현황으로 나눠 둔
// 프로젝트(Admin DEV)에 돌아가면 나뉜 화면이 드러나 매번 다시 최대화해야 했다 → 다른 작업 공간에 다녀온 것도 되살린다
// (예전엔 기록만). 기억은 그 탭·앱 창이 열린 동안만(리규형님 결정 — 탭마다 따로라 섞이지 않는다).
//  - 칸 수가 그때와 다르면 누르지 않는다(엉뚱한 칸 방지) · 직접 "창 복원"으로 푼 곳(작업 현황 단추가 푼 것 포함)은 표식을 지워 되살리지 않는다
//  - 주소가 바뀌었고 그 작업 공간에 표식이 있을 때만 화면 변화를 잠깐 지켜본다 · 두 번째 표본까지 칸 수가 안 맞으면 이유만 적고 그만둔다

const RESTORE = '[data-testid="workspace-restore-pane"]';
const MAXIMIZE = '[data-testid="workspace-maximize-pane"]';
const RESTORE_ID = "workspace-restore-pane";
const MAXIMIZE_ID = "workspace-maximize-pane";
/** 옛 판의 표식(작업 공간 하나뿐) — 읽어서 아래로 옮기고 지운다 */
const MARK_KEY = "claude-state-bar:pane-max";
/** 작업 공간마다 최대화했던 칸(이 탭에만, 10-14) — 다른 작업 공간에 다녀오거나 페이지가 새로 읽혀도 남아서 돌아오면 되살린다 */
const MARKS_KEY = "claude-state-bar:pane-max-by-ws";
/** 이 탭의 무작위 번호(새로 읽혀도 남음) — 같은 브라우저의 탭들이 대표 화면 번호를 같이 써서 기록만으로는 어느 탭인지 몰랐다(10-09) */
const TAB_KEY = "claude-state-bar:tab-id";
/** 표본 간격 — 기록용으로 고른 값이고 동작 규칙이 아니다(되살리기는 이 표본을 기다리지 않고 칸이 그려지는 즉시 누른다) */
const SAMPLE_MS = 2000;

/** index·count: 최대화한 칸이 몇 번째인지·그때 칸이 몇 개였는지(되살리기용, 옛 판 표식엔 없다) */
type Mark = { ws: string; at: number; index?: number; count?: number };

const secondsAgo = (t: number) => (t > 0 ? `${Math.round((Date.now() - t) / 1000)}s` : "-");

/** 플러그인이 일부러 최대화를 푼 시각 — 사람이 "창 복원"을 누른 것과 같이 다룬다(기록하지 않고 표식을 지워 되살리지 않음) */
let pluginRestoreAt = 0;

/** 지금 작업 공간 열쇠(되살리기 표식과 같은 모양) */
function currentWsKey(): string | null {
  const w = currentWorkspaceFromUrl();
  return w ? `${w.serverId}/${w.workspaceId}` : null;
}
/**
 * 이 작업 공간의 최대화 기억을 바로 지운다 — 창 복원(사람·작업 현황 단추)으로 푸는 그 순간에. 예전엔 2초 표본이 "풀렸다"를 볼 때
 * 지웠는데, 작업 현황 단추가 풀고 탭을 열며 주소가 바뀌자 그 사이에 되살리기가 기억을 보고 다시 최대화해 버렸다(10-15 리규형님
 * "전체 화면에서 작업 현황을 눌러도 아무 반응이 없다" — 기록에 같은 작업 공간 되살리기가 1초 간격으로 세 번)
 */
function forgetMark(ws: string | null): void {
  if (!ws) return;
  try {
    const all = JSON.parse(readSession(MARKS_KEY) ?? "null") as Record<string, Mark> | null;
    if (all && typeof all === "object" && ws in all) {
      delete all[ws];
      writeSession(MARKS_KEY, Object.keys(all).length ? JSON.stringify(all) : null);
    }
  } catch {
    writeSession(MARKS_KEY, null); // 깨진 값은 버린다(readMarks 와 같게)
  }
  // 옛 판 표식에 같은 작업 공간이 남아 있으면 다음 readMarks 가 다시 옮겨 와 되살아난다
  try {
    const old = JSON.parse(readSession(MARK_KEY) ?? "null") as Mark | null;
    if (old?.ws === ws) writeSession(MARK_KEY, null);
  } catch {
    writeSession(MARK_KEY, null);
  }
}

/**
 * 최대화돼 있으면 푼다(그 칸의 "창 복원" 단추를 대신 누름 — RN-web 단추는 click 에도 onPress). 풀었으면 true.
 * 10-09 리규형님: 작업 현황 칸을 연 뒤 채팅 탭을 최대화하면 작업 현황이 가려지고, 그때 작업 현황 단추를 눌러도 이미 열려 있어
 * 아무 반응이 없었다 → 단추가 먼저 최대화를 풀고 연다(activityButton.tsx). 웹·데스크톱만
 */
export function releaseMaximizedPane(): boolean {
  if (Platform.OS !== "web" || typeof document === "undefined") return false;
  // 지금 보이는 작업 공간 화면의 것만 — 숨겨진 다른 작업 공간 화면에도 "창 복원" 단추가 남아 있다(10-14 Aside 실측)
  const restore = paneButtons().find((b) => b.getAttribute?.("data-testid") === RESTORE_ID) ?? null;
  if (typeof restore?.click !== "function") return false;
  pluginRestoreAt = Date.now();
  forgetMark(currentWsKey());
  restore.click();
  return true;
}

/** 이 탭의 번호 — 처음이면 만들어 둔다. 탭 저장소를 못 쓰면 "-" */
function tabId(): string {
  const saved = readSession(TAB_KEY);
  if (saved) return saved;
  const made = Math.random().toString(36).slice(2, 6);
  writeSession(TAB_KEY, made);
  return readSession(TAB_KEY) ?? "-";
}

const DECK = '[data-testid^="workspace-deck-entry"]';
/**
 * 지금 화면의 칸 단추들(최대화·창 복원) — 문서 순서 = 칸 순서. 뒤에 남은 다른 작업 공간 화면(display:none 이라 상자가 없다)은 뺀다.
 * 🔴 지금 보이는 작업 공간 화면 안의 단추는 **최대화로 크기 0 이 된 칸 것까지** 센다(10-14 리규형님 "화면분할 안 고쳐졌잖아"):
 *    예전엔 상자 있는 단추만 세서, 최대화 중엔 [작업 현황 | 대화] 가 "칸 1개 중 첫째"로 적히고 돌아와 나뉜 화면에선 2개라
 *    칸 수가 영영 안 맞아 되살리지 못했다. 보이는 작업 공간 화면이 딱 하나일 때만 이렇게 세고, 아니면 예전 방식(상자 있는 것만)
 */
function paneButtons(): El[] {
  const decks = Array.from(document.querySelectorAll(DECK) as unknown as ArrayLike<El>).filter((d) => (d.getClientRects?.().length ?? 1) > 0);
  if (decks.length === 1 && typeof decks[0].querySelectorAll === "function") return Array.from(decks[0].querySelectorAll(`${MAXIMIZE},${RESTORE}`));
  return Array.from(document.querySelectorAll(`${MAXIMIZE},${RESTORE}`)).filter((b) => (b.getClientRects?.().length ?? 1) > 0);
}

/** screenLabel: 어느 브라우저인지(screenRole browserLabel) — 기록 줄에 붙인다 */
export function startPaneMaxWatch(log: (message: string) => void, screenLabel: () => string = () => "?"): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const pageStart = typeof performance !== "undefined" ? performance.timeOrigin : Date.now();
  const pluginStart = Date.now();
  let lastInput = 0;
  let lastRestoreClick = 0;
  let hiddenAt = document.visibilityState === "hidden" ? Date.now() : 0;
  let lastShownAt = 0;
  let lastHiddenFor = 0;
  let lastNetChange = 0;
  let prevMax = false;
  let prevWs: string | null = null;
  let sameWsSamples = 0;
  let leftAt = 0;

  const short = (ws: string) => ws.split("/").pop()?.slice(0, 8);
  /** 작업 공간별 표식. 옛 판이 남긴 표식 하나가 있으면 한 번 옮기고 지운다 */
  const readMarks = (): Record<string, Mark> => {
    const out: Record<string, Mark> = {};
    try {
      const v = JSON.parse(readSession(MARKS_KEY) ?? "null") as Record<string, Mark> | null;
      if (v && typeof v === "object") for (const [ws, m] of Object.entries(v)) if (m && typeof m.at === "number") out[ws] = { ...m, ws };
    } catch {
      /* 깨진 값은 버린다 */
    }
    try {
      const old = JSON.parse(readSession(MARK_KEY) ?? "null") as Mark | null;
      if (old && typeof old.ws === "string" && typeof old.at === "number") {
        out[old.ws] ??= old;
        writeSession(MARKS_KEY, JSON.stringify(out));
      }
      if (readSession(MARK_KEY) !== null) writeSession(MARK_KEY, null);
    } catch {
      /* 깨진 옛 값은 버린다 */
    }
    return out;
  };
  const markOf = (ws: string): Mark | null => readMarks()[ws] ?? null;
  const setMark = (ws: string, mark: Mark | null) => {
    const all = readMarks();
    if (mark) all[ws] = mark;
    else delete all[ws];
    writeSession(MARKS_KEY, Object.keys(all).length ? JSON.stringify(all) : null);
  };
  const wsKey = () => {
    const w = currentWorkspaceFromUrl();
    return w ? `${w.serverId}/${w.workspaceId}` : null;
  };
  /** 기록만 한다(표식은 부른 쪽이 정한다) */
  const report = (how: string, mark: Mark | null, ws: string = prevWs ?? wsKey() ?? "?") => {
    const discarded = document.wasDiscarded === true;
    log(
      `pane max lost: how=${how} ws=${short(ws)} maxAge=${secondsAgo(mark?.at ?? 0)} ` +
        `lastInput=${secondsAgo(lastInput)} restoreClick=${secondsAgo(lastRestoreClick)} ` +
        `hiddenFor=${Math.round(lastHiddenFor / 1000)}s shownAgo=${secondsAgo(lastShownAt)} visible=${document.visibilityState} ` +
        `layoutApply=${secondsAgo(lastLayoutAppliedAt())} pageAge=${secondsAgo(pageStart)} markFromOlderPage=${mark ? mark.at < pageStart : "-"} ` +
        `discarded=${discarded} online=${typeof navigator !== "undefined" ? navigator.onLine : "?"} netChange=${secondsAgo(lastNetChange)} ` +
        `away=${secondsAgo(leftAt)} panes=${document.querySelectorAll(MAXIMIZE).length} screen="${screenLabel()}" tab=${tabId()}`,
    );
  };

  // ── 되살리기: 주소가 바뀌었거나 페이지가 새로 읽혔는데 그 작업 공간에 표식이 있으면, 칸이 다 그려질 때까지만 화면 변화를 본다
  let observer: { disconnect(): void } | null = null;
  /** 되살릴 작업 공간 — 없으면 null */
  let pending: string | null = null;
  /** 대신 누른 시각 — 다음 표본에서 정말 최대화됐는지 적는다 */
  let restoredAt = 0;
  const stopRestore = () => {
    observer?.disconnect();
    observer = null;
  };
  /** 지금 보이는 칸 중 최대화된 것이 있는가(뒤에 남은 다른 화면 단추는 뺀다) */
  const maximizedNow = () => paneButtons().some((b) => b.getAttribute?.("data-testid") === RESTORE_ID);
  /** 되살릴 수 있으면 누르고 true. 아직 아니면 false(지켜보기는 계속) */
  const tryRestore = (): boolean => {
    const ws = wsKey();
    if (!pending || ws !== pending) return false;
    const mark = markOf(ws);
    if (!mark || typeof mark.index !== "number" || typeof mark.count !== "number" || maximizedNow()) {
      // 표식이 없거나 이미 최대화돼 있다(직접 눌렀거나 Paseo 가 되살림) — 할 일 없음
      pending = null;
      return false;
    }
    const buttons = paneButtons();
    if (buttons.length !== mark.count) return false;
    const target = buttons[mark.index];
    if (target?.getAttribute?.("data-testid") !== MAXIMIZE_ID || typeof target.click !== "function") return false;
    pending = null;
    const how = mark.at < pageStart ? "after-reload" : "after-return";
    // 새로 읽혀 풀린 것은 원인 기록을 계속 남긴다(10-09 "원인부터 기록"). 다른 작업 공간에 다녀온 것은 Paseo 가 늘 지우는 것이라 적지 않는다
    if (how === "after-reload") report(how, mark, ws);
    target.click();
    restoredAt = Date.now();
    log(`pane max restored (${how}): pane ${mark.index + 1}/${mark.count} ws=${short(ws)} pageAge=${secondsAgo(pageStart)} tab=${tabId()}`);
    return true;
  };
  const arm = () => {
    const ws = wsKey();
    pending = ws && markOf(ws) ? ws : null;
    if (!pending || tryRestore() || !pending) {
      stopRestore();
      return;
    }
    if (observer || typeof MutationObserver === "undefined" || !document.body) return;
    const o = new MutationObserver(() => {
      if (pending) tryRestore();
      if (!pending) stopRestore();
    });
    o.observe(document.body, { childList: true, subtree: true });
    observer = o;
  };
  const stopLocation = watchLocation(arm);
  arm();

  const sample = () => {
    const ws = wsKey();
    if (!ws) {
      // 작업 공간 밖 화면(설정 등) — 뒤에 남은 작업 공간 화면의 "창 복원" 단추가 보여서, 여기서 판정하면 2초마다 "풀림"을
      // 적고 표식까지 지웠다(10-09 기록 339줄 전부 이것). 판정하지 않고, 최대화한 채 떠났으면 떠난 시각만 적는다
      if (prevMax && prevWs) leftAt = Date.now();
      prevMax = false;
      prevWs = null;
      sameWsSamples = 0;
      return;
    }
    // 지금 보이는 작업 공간 화면 안에서만 본다 — 숨겨진 다른 작업 공간 화면에 남은 "창 복원" 단추로 최대화라 오판하던 것(10-14)
    const max = maximizedNow();
    sameWsSamples = ws === prevWs ? sameWsSamples + 1 : 0;
    if (restoredAt) {
      // 대신 누른 뒤 첫 표본 — 단추가 반응하지 않았으면 남긴다(Paseo 단추 구조가 바뀐 신호)
      if (!max) log(`pane max restore did not take (pressed ${secondsAgo(restoredAt)} ago)`);
      restoredAt = 0;
    }
    const mark = markOf(ws);
    if (max) {
      const buttons = paneButtons();
      const index = buttons.findIndex((b) => b.getAttribute?.("data-testid") === RESTORE_ID);
      const next: Mark = {
        ws,
        at: mark && mark.index === index ? mark.at : Date.now(),
        ...(index >= 0 ? { index, count: buttons.length } : {}),
      };
      if (!mark || mark.index !== next.index || mark.count !== next.count) setMark(ws, next);
      leftAt = 0;
      if (pending === ws) {
        pending = null;
        stopRestore();
      }
    } else if (prevMax && ws === prevWs) {
      // 같은 작업 공간에서 풀림 — 직접 "창 복원"을 누른 것(작업 현황 단추가 대신 누른 것 포함)이면 기록하지 않는다.
      // 어느 쪽이든 이 작업 공간 기억은 지운다(일부러 나눈 화면으로 본 것 — 돌아와도 되살리지 않는다)
      if (Date.now() - Math.max(lastRestoreClick, pluginRestoreAt) > SAMPLE_MS * 2) report("same-workspace", mark, ws);
      setMark(ws, null);
    } else if (prevMax && ws !== prevWs) {
      // 최대화한 채 다른 작업 공간으로 — 앞 작업 공간 표식은 남겨 둔다(돌아오면 arm 이 되살린다)
      leftAt = Date.now();
    } else if (mark && pending === ws && sameWsSamples >= 1) {
      // 돌아왔거나 새로 읽혔는데 두 표본이 지나도 못 되살렸다(화면이 그려지기 전 한 번은 넘긴다)
      if (!tryRestore()) {
        const why = typeof mark.index === "number" && typeof mark.count === "number" ? ` (not restored: panes now ${paneButtons().length}, was ${mark.count})` : "";
        report(mark.at < pageStart ? "after-reload" : mark.at < pluginStart ? "after-plugin-reload" : "after-return", mark, ws);
        if (why) log(`pane max${why}`);
        setMark(ws, null);
        pending = null;
        stopRestore();
      }
    }
    prevMax = max;
    prevWs = ws;
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else {
      lastShownAt = Date.now();
      lastHiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    }
  };
  const onNet = () => {
    lastNetChange = Date.now();
  };
  const onClick = (event: DocEvent) => {
    if (!event.target?.closest?.(RESTORE)) return;
    lastRestoreClick = Date.now();
    // 직접 푼 곳은 되살리지 않는다 — 누르는 그 순간 기억을 지운다(위 forgetMark)
    forgetMark(wsKey());
    pending = null;
    stopRestore();
  };
  const stopInput = onUserInput(() => {
    lastInput = Date.now();
  });
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("pointerdown", onClick, true);
  window.addEventListener("online", onNet);
  window.addEventListener("offline", onNet);
  const timer = setInterval(sample, SAMPLE_MS);
  return () => {
    clearInterval(timer);
    stopRestore();
    stopLocation();
    stopInput();
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointerdown", onClick, true);
    window.removeEventListener("online", onNet);
    window.removeEventListener("offline", onNet);
  };
}
