// 화면 떨림 감지 기록(10-19). 리규형님: Mesa 대화(콜어드민 서버에서 도는 대화)에서만 진행 글이 가끔 심하게 떨린다 —
// 대화가 가만히 있어도, 다른 대화에 갔다 와도 떨리고, 번역 확장은 안 켰고, 생각 상자에서 진행 글을 꺼내는 움직임과도 상관없다.
// 같은 날 PC 브라우저에서 15초씩 잰 값: Mesa 화면은 생각 상자 머리가 283번 다시 그려지고 생각 상자·말 칸이 27번 다시 붙었다.
// 같은 때 PC 대화는 35번·0번이었다(docs tests-261019/browser_probe/bc_read_flip_watch_261019.mjs).
// 떨리는 순간은 드물어 지켜봐서는 잡히지 않는다. 그래서 화면 안 말 칸·생각 상자·진행 글 칸의 위치·높이가 짧은 시간에
// 오르내리면, 그 직전 2초 동안의 화면 변화를 세어 데몬 기록에 "[jitter]" 한 줄을 남긴다. 동작은 바꾸지 않고 글 내용도 남기지 않는다.
// 폰 앱은 버벅임이 생길 수 있어 넣지 않는다. 끄기: localStorage "csb-jitter-watch" = "off"(새로고침 뒤 적용)
// 이 플러그인은 DOM 타입 없이 컴파일하므로(폰과 같이 쓴다) 쓰는 것만 아래에 적는다 — client/web.ts 와 같은 방식
type Log = (message: string) => void;
type El = {
  id: string;
  nodeType: number;
  parentElement: El | null;
  matches(selector: string): boolean;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
};
type Scroller = El & { scrollTop: number; scrollHeight: number };
type Change = { type: string; addedNodes: Iterable<El>; removedNodes: Iterable<El> };
type Observer = { observe(target: El, options: Record<string, unknown>): void; disconnect(): void };
type Page = {
  document?: { hidden: boolean; getElementById(id: string): Scroller | null; documentElement: { className: string } };
  MutationObserver?: new (callback: (list: Change[]) => void) => Observer;
  localStorage?: { getItem(key: string): string | null };
  location?: { pathname: string };
  PaseoShell?: unknown;
  innerHeight?: number;
  innerWidth?: number;
};
type Track = { top: number; h: number; deltas: number[]; flips: number[]; lastDir: number };

const SCROLLER_ID = "agent-chat-scroll-web-dom-scroll";
const TARGETS = "[data-csb-turn-read=message-row], [id^=csb-think-][id$=-box], [id^=csb-think-][id$=-said]";
const SAMPLE_MS = 150;
const WINDOW_MS = 2000;
const FLIPS = 3; // 2초 안에 오르내림 방향이 이만큼 바뀌면 떨림으로 본다
const EVENT_GAP_MS = 10_000; // 기록은 10초에 한 줄까지
const EVENT_CAP = 200; // 한 화면이 켜져 있는 동안 남기는 줄 수 상한

// 말 칸은 플러그인이 표시만 단 요소라 부품 정보가 없을 수 있다 — 부모로 올라가며 부품 정보가 붙은 첫 요소에서 찾는다
function agentOf(el: El): string {
  type Fiber = { return?: Fiber | null; memoizedProps?: Record<string, unknown> } | null | undefined;
  let node: El | null = el;
  for (let up = 0; node && up < 12; up++, node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith("__reactFiber"));
    if (!key) continue;
    let fiber: Fiber = (node as unknown as Record<string, Fiber>)[key];
    for (let i = 0; fiber && i < 60; i++) {
      const id = fiber.memoizedProps?.agentId;
      if (typeof id === "string") return id.slice(0, 8);
      fiber = fiber.return;
    }
    return "?";
  }
  return "?";
}

function kindOf(el: El): string {
  if (el.id.endsWith("-said")) return "said";
  if (el.id.endsWith("-box")) return "box";
  return "row";
}

export function startJitterWatch(log: Log): () => void {
  const page = globalThis as unknown as Page;
  const doc = page.document;
  const Watch = page.MutationObserver;
  if (!doc || !Watch || page.PaseoShell) return () => {};
  try {
    if (page.localStorage?.getItem("csb-jitter-watch") === "off") return () => {};
  } catch {
    /* 저장소를 못 읽으면 켠 채로 둔다 */
  }

  let scroller: Scroller | null = null;
  let observer: Observer | null = null;
  const changes: { t: number; kind: string }[] = [];
  const tracks = new Map<string | El, Track>();
  let scrollTop = 0;
  let scrollMoves: number[] = [];
  let scrollHeight = 0;
  let heightDir = 0;
  let heightFlips: number[] = [];
  let lastEvent = -Infinity;
  let events = 0;

  const note = (kind: string) => changes.push({ t: Date.now(), kind });
  const sort = (el: El, sign: string) => {
    if (el.nodeType !== 1) return;
    if (el.id?.startsWith("csb-think-") || el.querySelector("[id^=csb-think-]")) note("think" + sign);
    if (el.matches("[data-csb-turn-read=message-row]") || el.querySelector("[data-csb-turn-read=message-row]")) note("row" + sign);
    if (el.matches("[data-csb-turn-read=button]") || el.querySelector("[data-csb-turn-read=button]")) note("btn" + sign);
  };
  const attach = (next: Scroller | null) => {
    if (next === scroller) return;
    observer?.disconnect();
    observer = null;
    scroller = next;
    tracks.clear();
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    scrollHeight = scroller.scrollHeight;
    observer = new Watch((list) => {
      for (const m of list) {
        if (m.type === "attributes") note("redraw");
        else {
          for (const n of m.addedNodes) sort(n, "+");
          for (const n of m.removedNodes) sort(n, "-");
        }
      }
    });
    observer.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  };

  const report = (el: El, track: Track, now: number) => {
    if (now - lastEvent < EVENT_GAP_MS || events >= EVENT_CAP) return;
    lastEvent = now;
    events++;
    const recent = changes.filter((c) => now - c.t <= WINDOW_MS);
    const count = (kind: string) => recent.filter((c) => c.kind === kind).length;
    const path = page.location?.pathname ?? "";
    const host = (/\/h\/([^/]+)/.exec(path)?.[1] ?? "?").slice(0, 8);
    const wks = (/\/workspace\/([^/]+)/.exec(path)?.[1] ?? "?").slice(0, 8);
    const translated = /translated-/.test(doc.documentElement.className) || !!scroller?.querySelector("font") ? 1 : 0;
    log(
      `[jitter] agent=${agentOf(el)} host=${host} wks=${wks} kind=${kindOf(el)} flips=${track.flips.length} d=${track.deltas.join(",")}` +
        ` think+=${count("think+")} think-=${count("think-")} row+=${count("row+")} row-=${count("row-")} btn+=${count("btn+")} btn-=${count("btn-")}` +
        ` redraw=${count("redraw")} scroll=${scrollMoves.length} heightFlips=${heightFlips.length} translated=${translated} w=${page.innerWidth ?? 0}`,
    );
  };

  const sample = () => {
    if (doc.hidden) return;
    attach(doc.getElementById(SCROLLER_ID));
    const box = scroller;
    if (!box) return;
    const now = Date.now();
    while (changes.length && now - changes[0].t > WINDOW_MS) changes.shift();
    scrollMoves = scrollMoves.filter((t) => now - t <= WINDOW_MS);
    heightFlips = heightFlips.filter((t) => now - t <= WINDOW_MS);
    if (box.scrollTop !== scrollTop) {
      scrollMoves.push(now);
      scrollTop = box.scrollTop;
    }
    if (box.scrollHeight !== scrollHeight) {
      const dir = Math.sign(box.scrollHeight - scrollHeight);
      if (heightDir && dir !== heightDir) heightFlips.push(now);
      heightDir = dir;
      scrollHeight = box.scrollHeight;
    }
    const view = page.innerHeight ?? 0;
    const seen = new Set<string | El>();
    for (const el of box.querySelectorAll(TARGETS)) {
      const r = el.getBoundingClientRect();
      if (!r.height || r.bottom < 0 || r.top > view) continue;
      const key = el.id || el;
      seen.add(key);
      const top = Math.round(r.top + scrollTop);
      const h = Math.round(r.height);
      const track = tracks.get(key);
      if (!track) {
        tracks.set(key, { top, h, deltas: [], flips: [], lastDir: 0 });
        continue;
      }
      track.flips = track.flips.filter((t) => now - t <= WINDOW_MS);
      const delta = top !== track.top ? top - track.top : h - track.h;
      if (delta) {
        const dir = Math.sign(delta);
        if (track.lastDir && dir !== track.lastDir) track.flips.push(now);
        track.lastDir = dir;
        track.deltas = [...track.deltas, delta].slice(-6);
      }
      track.top = top;
      track.h = h;
      if (track.flips.length >= FLIPS) {
        report(el, track, now);
        track.flips = [];
      }
    }
    for (const key of tracks.keys()) if (!seen.has(key)) tracks.delete(key);
  };

  const timer = setInterval(sample, SAMPLE_MS);
  return () => {
    clearInterval(timer);
    observer?.disconnect();
    tracks.clear();
  };
}
