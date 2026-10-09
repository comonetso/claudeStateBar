import { Platform } from "react-native";
import { currentWorkspaceFromUrl, lastLayoutAppliedAt, onUserInput, readSession, writeSession } from "./web";

// 이 플러그인은 DOM 타입을 쓰지 않는다 — 쓰는 것만 선언한다(web.ts 와 같은 방식)
type El = {
  closest?(selector: string): El | null;
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
// 되살리기: 최대화 중에 "몇 번째 칸 / 칸 몇 개"를 탭 저장소에 적어 두고, 페이지가 새로 읽힌 뒤 같은 작업 공간에서 칸 단추가
// 그만큼 그려지면 그 순서의 최대화 단추를 대신 누른다(RN-web 단추는 click 에도 onPress 를 부른다 — 0.11.1 PressResponder onClick).
// 최대화 중에도 다른 칸은 크기 0 으로 숨겨질 뿐 남아 있어(split-group-child-hidden) 순서를 셀 수 있다.
//  - 칸 수가 그때와 다르면 누르지 않는다(엉뚱한 칸 방지) · 직접 "창 복원"으로 푼 것은 표식을 지워 되살리지 않는다
//  - 탭 저장소라 탭을 닫으면 기억도 사라진다 · 플러그인만 다시 읽힌 것·다른 작업 공간에 다녀온 것은 기록만 한다
//  - 기다리는 끝은 원래 "새로 읽혀 풀림" 판정 시점(두 번째 표본)이다 — 그때까지 칸 수가 안 맞으면 이유만 적고 그만둔다

const RESTORE = '[data-testid="workspace-restore-pane"]';
const MAXIMIZE = '[data-testid="workspace-maximize-pane"]';
const RESTORE_ID = "workspace-restore-pane";
const MAXIMIZE_ID = "workspace-maximize-pane";
/** 최대화 중이던 작업 공간·칸(이 탭에만) — 페이지가 새로 읽혀도 남아서 "새로 읽혀 풀림"을 알아보고 되살린다 */
const MARK_KEY = "claude-state-bar:pane-max";
/** 이 탭의 무작위 번호(새로 읽혀도 남음) — 같은 브라우저의 탭들이 대표 화면 번호를 같이 써서 기록만으로는 어느 탭인지 몰랐다(10-09) */
const TAB_KEY = "claude-state-bar:tab-id";
/** 표본 간격 — 기록용으로 고른 값이고 동작 규칙이 아니다(되살리기는 이 표본을 기다리지 않고 칸이 그려지는 즉시 누른다) */
const SAMPLE_MS = 2000;

/** index·count: 최대화한 칸이 몇 번째인지·그때 칸이 몇 개였는지(되살리기용, 옛 판 표식엔 없다) */
type Mark = { ws: string; at: number; index?: number; count?: number };

const secondsAgo = (t: number) => (t > 0 ? `${Math.round((Date.now() - t) / 1000)}s` : "-");

/** 플러그인이 일부러 최대화를 푼 시각 — 사람이 "창 복원"을 누른 것과 같이 다룬다(기록하지 않고 표식을 지워 되살리지 않음) */
let pluginRestoreAt = 0;

/**
 * 최대화돼 있으면 푼다(그 칸의 "창 복원" 단추를 대신 누름 — RN-web 단추는 click 에도 onPress). 풀었으면 true.
 * 10-09 리규형님: 작업 현황 칸을 연 뒤 채팅 탭을 최대화하면 작업 현황이 가려지고, 그때 작업 현황 단추를 눌러도 이미 열려 있어
 * 아무 반응이 없었다 → 단추가 먼저 최대화를 풀고 연다(activityButton.tsx). 웹·데스크톱만
 */
export function releaseMaximizedPane(): boolean {
  if (Platform.OS !== "web" || typeof document === "undefined") return false;
  const restore = document.querySelector(RESTORE) as { click?: () => void } | null;
  if (typeof restore?.click !== "function") return false;
  pluginRestoreAt = Date.now();
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

/** 지금 화면의 칸 단추들(최대화·창 복원) — 문서 순서 = 칸 순서. 뒤에 남은 다른 화면 것(상자가 없는 것)은 뺀다 */
function paneButtons(): El[] {
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

  const readMark = (): Mark | null => {
    try {
      const v = JSON.parse(readSession(MARK_KEY) ?? "null") as Mark | null;
      return v && typeof v.ws === "string" && typeof v.at === "number" ? v : null;
    } catch {
      return null;
    }
  };
  const wsKey = () => {
    const w = currentWorkspaceFromUrl();
    return w ? `${w.serverId}/${w.workspaceId}` : null;
  };
  const report = (how: string, mark: Mark | null) => {
    const discarded = document.wasDiscarded === true;
    const ws = prevWs ?? wsKey() ?? "?";
    log(
      `pane max lost: how=${how} ws=${ws.split("/").pop()?.slice(0, 8)} maxAge=${secondsAgo(mark?.at ?? 0)} ` +
        `lastInput=${secondsAgo(lastInput)} restoreClick=${secondsAgo(lastRestoreClick)} ` +
        `hiddenFor=${Math.round(lastHiddenFor / 1000)}s shownAgo=${secondsAgo(lastShownAt)} visible=${document.visibilityState} ` +
        `layoutApply=${secondsAgo(lastLayoutAppliedAt())} pageAge=${secondsAgo(pageStart)} markFromOlderPage=${mark ? mark.at < pageStart : "-"} ` +
        `discarded=${discarded} online=${typeof navigator !== "undefined" ? navigator.onLine : "?"} netChange=${secondsAgo(lastNetChange)} ` +
        `away=${secondsAgo(leftAt)} panes=${document.querySelectorAll(MAXIMIZE).length} screen="${screenLabel()}" tab=${tabId()}`,
    );
    writeSession(MARK_KEY, null);
  };

  // ── 되살리기: 이 페이지보다 먼저 적힌 표식이 있을 때만 칸이 그려지는 것을 지켜본다
  let observer: { disconnect(): void } | null = null;
  /** 대신 누른 시각 — 다음 표본에서 정말 최대화됐는지 적는다 */
  let restoredAt = 0;
  const stopRestore = () => {
    observer?.disconnect();
    observer = null;
  };
  const startMark = readMark();
  /** 되살릴 수 있으면 누르고 true. 아직 아니면 false(지켜보기는 계속) */
  const tryRestore = (): boolean => {
    // 화면이 바뀔 때마다 불리므로 가벼운 것(주소)부터 본다
    const ws = wsKey();
    if (!ws || ws !== startMark?.ws) return false;
    const mark = readMark();
    if (!mark || mark.at >= pageStart || typeof mark.index !== "number" || typeof mark.count !== "number") {
      stopRestore();
      return false;
    }
    if (document.querySelector(RESTORE) !== null) {
      // 이미 최대화돼 있다(직접 눌렀거나 Paseo 가 되살림) — 할 일 없음
      stopRestore();
      return false;
    }
    if (ws !== mark.ws) return false;
    const buttons = paneButtons();
    if (buttons.length !== mark.count) return false;
    const target = buttons[mark.index];
    if (target?.getAttribute?.("data-testid") !== MAXIMIZE_ID || typeof target.click !== "function") return false;
    // 먼저 표식을 지운다(report) — 같은 페이지에 다른 판 인스턴스가 있어도 두 번 눌려 다시 풀리지 않게
    report("after-reload", mark);
    target.click();
    restoredAt = Date.now();
    log(`pane max restored: pane ${mark.index + 1}/${mark.count} ws=${ws.split("/").pop()?.slice(0, 8)} pageAge=${secondsAgo(pageStart)} tab=${tabId()}`);
    stopRestore();
    return true;
  };
  if (startMark && startMark.at < pageStart && typeof startMark.index === "number" && typeof MutationObserver !== "undefined" && document.body) {
    const o = new MutationObserver(() => {
      tryRestore();
    });
    o.observe(document.body, { childList: true, subtree: true });
    observer = o;
  }

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
    const max = document.querySelector(RESTORE) !== null;
    sameWsSamples = ws === prevWs ? sameWsSamples + 1 : 0;
    if (restoredAt) {
      // 대신 누른 뒤 첫 표본 — 단추가 반응하지 않았으면 남긴다(Paseo 단추 구조가 바뀐 신호)
      if (!max) log(`pane max restore did not take (pressed ${secondsAgo(restoredAt)} ago)`);
      restoredAt = 0;
    }
    const mark = readMark();
    if (max) {
      const buttons = paneButtons();
      const index = buttons.findIndex((b) => b.getAttribute?.("data-testid") === RESTORE_ID);
      const next: Mark = {
        ws,
        at: mark && mark.ws === ws && mark.index === index ? mark.at : Date.now(),
        ...(index >= 0 ? { index, count: buttons.length } : {}),
      };
      if (!mark || mark.ws !== ws || mark.index !== next.index || mark.count !== next.count) writeSession(MARK_KEY, JSON.stringify(next));
      leftAt = 0;
      stopRestore();
    } else if (prevMax && ws === prevWs) {
      // 같은 작업 공간에서 풀림 — 직접 "창 복원"을 누른 것(플러그인이 대신 누른 것 포함)이면 기록하지 않는다
      if (Date.now() - Math.max(lastRestoreClick, pluginRestoreAt) <= SAMPLE_MS * 2) writeSession(MARK_KEY, null);
      else report("same-workspace", mark);
    } else if (prevMax && ws !== prevWs) {
      // 최대화한 채 다른 화면으로 — 돌아왔을 때 본다(표식은 남겨 둔다)
      leftAt = Date.now();
    } else if (mark && ws === mark.ws && sameWsSamples >= 1) {
      // 돌아왔거나 새로 읽혔는데 두 번 연속 최대화가 없다(화면이 그려지기 전 한 번은 넘긴다)
      if (mark.at < pageStart && tryRestore()) {
        // 되살렸다 — tryRestore 가 기록했다
      } else {
        const why =
          mark.at < pageStart && typeof mark.index === "number" && typeof mark.count === "number"
            ? ` (not restored: panes now ${paneButtons().length}, was ${mark.count})`
            : "";
        report(mark.at < pageStart ? "after-reload" : mark.at < pluginStart ? "after-plugin-reload" : "after-return", mark);
        if (why) log(`pane max${why}`);
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
    if (event.target?.closest?.(RESTORE)) lastRestoreClick = Date.now();
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
    stopInput();
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointerdown", onClick, true);
    window.removeEventListener("online", onNet);
    window.removeEventListener("offline", onNet);
  };
}
