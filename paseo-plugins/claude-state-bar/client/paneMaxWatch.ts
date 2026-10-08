import { Platform } from "react-native";
import { currentWorkspaceFromUrl, lastLayoutAppliedAt, onUserInput, readSession, writeSession } from "./web";

// 이 플러그인은 DOM 타입을 쓰지 않는다 — 쓰는 것만 선언한다(web.ts 와 같은 방식)
type El = { closest?(selector: string): El | null };
type DocEvent = { target?: El | null };
declare const document: {
  visibilityState?: string;
  wasDiscarded?: boolean;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): { length: number };
  addEventListener(type: string, fn: (event: DocEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (event: DocEvent) => void, capture?: boolean): void;
};
declare const window: { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
declare const navigator: { onLine?: boolean } | undefined;
declare const performance: { timeOrigin: number } | undefined;

// 칸 최대화가 저절로 풀리는 원인 기록(10-09 리규형님 "최대화를 해 놓고 한참 있다가 돌아오면 풀려 있는 경우가 더러 있다" →
// 결정 "원인부터 기록"). 고치지는 않고, 풀린 순간의 상황만 플러그인 로그(PC 데몬 `paseo plugin logs claude-state-bar`의
// `[client] pane max lost …`)에 한 줄 남긴다.
// Paseo 0.11.1 은 최대화 칸을 화면 부품의 임시 상태(SplitContainer useState {workspaceKey, paneId})에만 두고 저장하지 않는다.
// 그래서 페이지가 새로 읽히면(브라우저가 잠재운 탭을 깨울 때 포함) 풀리고, 배치가 비거나 칸이 하나뿐이거나 그 칸이 배치에서
// 빠지면 스스로 지운다(splitNodeContainsPane(…)||setMaximized(null)). 어느 쪽인지 가리려고 아래 상황을 함께 적는다.
// 최대화 중에는 그 칸의 단추가 testID workspace-restore-pane 이다(paneMaximized.ts 와 같은 표식). 웹·데스크톱만.

const RESTORE = '[data-testid="workspace-restore-pane"]';
const MAXIMIZE = '[data-testid="workspace-maximize-pane"]';
/** 최대화 중이던 작업 공간(이 탭에만) — 페이지가 새로 읽혀도 남아서 "새로 읽혀 풀림"을 알아본다 */
const MARK_KEY = "claude-state-bar:pane-max";
/** 표본 간격 — 기록용으로 고른 값이고 동작 규칙이 아니다 */
const SAMPLE_MS = 2000;

type Mark = { ws: string; at: number };

const secondsAgo = (t: number) => (t > 0 ? `${Math.round((Date.now() - t) / 1000)}s` : "-");

export function startPaneMaxWatch(log: (message: string) => void): () => void {
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
        `away=${secondsAgo(leftAt)} panes=${document.querySelectorAll(MAXIMIZE).length}`,
    );
    writeSession(MARK_KEY, null);
  };

  const sample = () => {
    const ws = wsKey();
    const max = document.querySelector(RESTORE) !== null;
    sameWsSamples = ws === prevWs ? sameWsSamples + 1 : 0;
    const mark = readMark();
    if (max && ws) {
      if (!mark || mark.ws !== ws) writeSession(MARK_KEY, JSON.stringify({ ws, at: Date.now() } satisfies Mark));
      leftAt = 0;
    } else if (prevMax && ws === prevWs) {
      // 같은 작업 공간에서 풀림 — 직접 "창 복원"을 누른 것이면 기록하지 않는다
      if (Date.now() - lastRestoreClick <= SAMPLE_MS * 2) writeSession(MARK_KEY, null);
      else report("same-workspace", mark);
    } else if (prevMax && ws !== prevWs) {
      // 최대화한 채 다른 화면으로 — 돌아왔을 때 본다(표식은 남겨 둔다)
      leftAt = Date.now();
    } else if (mark && ws === mark.ws && sameWsSamples >= 1) {
      // 돌아왔거나 새로 읽혔는데 두 번 연속 최대화가 없다(화면이 그려지기 전 한 번은 넘긴다)
      report(mark.at < pageStart ? "after-reload" : mark.at < pluginStart ? "after-plugin-reload" : "after-return", mark);
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
    stopInput();
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointerdown", onClick, true);
    window.removeEventListener("online", onNet);
    window.removeEventListener("offline", onNet);
  };
}
