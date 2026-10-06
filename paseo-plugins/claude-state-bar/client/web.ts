import { Linking, Platform } from "react-native";
import type { Edit } from "./markdownList";
import type { AudioFile, ThinkingAudio } from "./thinkingPlayer";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: {
  open(url: string, target: string, features: string): unknown;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  innerHeight: number;
  getSelection(): { toString(): string; rangeCount: number; getRangeAt(index: number): RangeLike; removeAllRanges(): void } | null;
  getComputedStyle(el: unknown): { display: string };
  /** PC 앱(Electron)이 화면에 심는 연결 고리 — 앱 화면 코드 getElectronHost 가 이것으로 PC 앱인지 가린다 */
  paseoDesktop?: unknown;
};
// 선택 읽기 형광펜에 쓰는 DOM 조각(이 파일 밖으로는 불투명한 token 으로만 나간다)
type NodeLike = { nodeType: number; nodeValue: string | null; parentNode: NodeLike | null };
type RangeLike = {
  startContainer: NodeLike;
  startOffset: number;
  endContainer: NodeLike;
  endOffset: number;
  commonAncestorContainer: NodeLike;
  cloneRange(): RangeLike;
  intersectsNode(node: NodeLike): boolean;
  setStart(node: NodeLike, offset: number): void;
  setEnd(node: NodeLike, offset: number): void;
};
declare class Highlight {
  constructor(...ranges: RangeLike[]);
}
declare const CSS: { highlights?: { set(name: string, highlight: Highlight): void; delete(name: string): void } } | undefined;
declare class Audio {
  constructor(src?: string);
  src: string;
  playbackRate: number;
  preservesPitch: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  error: { message?: string; code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}

// 데스크톱(Electron)·웹 앱에서만 소리를 낸다. 휴대폰 앱은 아무것도 하지 않는다.
export async function playSoundUrl(url: string): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  await new Audio(url).play();
  return true;
}

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};
declare const localStorage: StorageLike | undefined;
declare const sessionStorage: StorageLike | undefined;
declare const Storage: { prototype: StorageLike } | undefined;
declare const history: { readonly length: number; back(): void } | undefined;
declare const location: { reload(): void } | undefined;

function storage() {
  return Platform.OS === "web" && typeof localStorage !== "undefined" ? localStorage : null;
}

/** 이 기기 앱 저장소(웹·데스크톱). 휴대폰 앱은 null·저장 안 함 */
export function readLocal(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* 저장 못 해도 이번 실행 동안은 맞다 */
  }
}
export function removeLocal(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* 못 지워도 이번 실행 동안은 맞다 */
  }
}
/** 이 기기 앱 저장소의 열쇠 이름 전부. 휴대폰 앱이면 빈 목록 */
export function localKeys(): string[] {
  const s = storage();
  if (!s) return [];
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/** 이 탭(창)이 열려 있는 동안만 남는 저장소 — 새로고침해도 남는다. 웹이 아니면 null·저장 안 함 */
export function readSession(key: string): string | null {
  try {
    return Platform.OS === "web" && typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
export function writeSession(key: string, value: string | null): void {
  try {
    if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return;
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* 못 남겨도 다음 동작만 한 번 더 일어난다 */
  }
}

/**
 * 이 기기 앱 저장소에 쓰고 지우는 것을 모두 알린다(웹·데스크톱만). Paseo 의 저장(AsyncStorage·zustand persist)도 결국
 * 브라우저 저장소의 setItem·removeItem 을 거쳐서 다 잡힌다. 원래 쓰기를 먼저 하고, 알림에서 오류가 나도 쓰기는 살린다.
 */
export function watchLocalWrites(fn: (key: string, value: string | null) => void): () => void {
  const store = storage();
  if (!store || typeof Storage === "undefined") return () => {};
  const proto = Storage.prototype;
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  const tell = (key: string, value: string | null) => {
    try {
      fn(String(key), value);
    } catch {
      /* 알림 실패가 앱 저장을 막지 않게 */
    }
  };
  const patchedSet = function (this: StorageLike, key: string, value: string) {
    origSet.call(this, key, value);
    if (this === store) tell(key, String(value));
  };
  const patchedRemove = function (this: StorageLike, key: string) {
    origRemove.call(this, key);
    if (this === store) tell(key, null);
  };
  proto.setItem = patchedSet;
  proto.removeItem = patchedRemove;
  return () => {
    // 그 사이 다른 누가 또 감쌌으면 그쪽을 깨지 않게 우리 것일 때만 되돌린다
    if (proto.setItem === patchedSet) proto.setItem = origSet;
    if (proto.removeItem === patchedRemove) proto.removeItem = origRemove;
  };
}

/**
 * Paseo 앱 설정의 글자 크기(설정 → 화면 → 글꼴: 인터페이스 크기 uiBaseFontSize · 콘텐츠 크기 contentFontSize). 플러그인 테마에는
 * 색만 와서 앱이 저장한 값을 직접 읽는다 — 앱 저장소 열쇠 `@paseo:app-settings`(앱 hooks/use-settings/keys.ts). 웹(PC 앱·브라우저)
 * 에서만 읽히고, 휴대폰 앱이거나 값이 없으면 null.
 */
export function readAppFontSizes(): { ui: number | null; content: number | null } {
  const pick = (v: unknown) => (typeof v === "number" && v >= 10 && v <= 21 ? v : null);
  try {
    const raw = storage()?.getItem("@paseo:app-settings");
    const o = raw ? JSON.parse(raw) : null;
    return { ui: pick(o?.uiBaseFontSize), content: pick(o?.contentFontSize) };
  } catch {
    return { ui: null, content: null };
  }
}

/** 패널 글자 크기(A−/A+) — 이 기기 앱 저장소에 둔다 */
const FONT_PX_KEY = "claude-state-bar:panel-font-px";
export function readPanelFontPx(): number | null {
  try {
    const v = Number(storage()?.getItem(FONT_PX_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function writePanelFontPx(px: number): void {
  try {
    storage()?.setItem(FONT_PX_KEY, String(px));
  } catch {
    /* 저장 못 해도 이번 실행 동안은 맞다 */
  }
}

// Ctrl+Tab · Ctrl+Shift+Tab 으로 패널 안 탭 넘기기(확장 media/activity.js 와 같은 키). 마지막으로 누른 곳이 그 패널일 때만 —
// 입력창이나 터미널을 누른 뒤에는 가로채지 않는다. Paseo 자체에는 Ctrl+Tab 단축키가 없다(앱 keyboard/ 확인, 10-05).
type ElementLike = {
  contains(node: unknown): boolean;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  textContent: string | null;
  remove(): void;
};
declare const document: {
  getElementById(id: string): ElementLike | null;
  querySelector(selector: string): ElementLike | null;
  createElement(tag: string): ElementLike & { id: string };
  head: { appendChild(node: unknown): void };
  body: unknown;
  documentElement: unknown;
  addEventListener(type: string, fn: (e: KeyEventLike) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (e: KeyEventLike) => void, capture: boolean): void;
  createTreeWalker(root: NodeLike, whatToShow: number): { nextNode(): NodeLike | null };
  createRange(): RangeLike;
  execCommand(command: string, showUi: boolean, value?: string): boolean;
};
type KeyEventLike = {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** 한글 같은 조합 입력 중이면 true(조합 중 keydown 은 keyCode 229 로도 온다) */
  isComposing?: boolean;
  keyCode?: number;
  /** input · beforeinput 이벤트의 입력 종류(deleteContentBackward · insertFromPaste …) */
  inputType?: string;
  target?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
};

function isWeb(): boolean {
  return Platform.OS === "web" && typeof document !== "undefined";
}

/**
 * 앱 화면 이동 기록에서 한 칸 뒤로(웹·데스크톱만). Paseo 화면은 주소(URL)로 움직여서 브라우저 뒤로가기와 같다.
 * 플러그인 도구에는 "이전 화면으로"가 없다(10-06 확인). 뒤로 갈 기록이 없거나 폰 앱이면 false — 부른 쪽이 대신 처리한다.
 */
export function goBack(): boolean {
  if (!isWeb() || typeof history === "undefined" || history.length <= 1) return false;
  history.back();
  return true;
}

type DragEventLike = {
  preventDefault(): void;
  clientY: number;
  dataTransfer?: { setData(type: string, value: string): void; effectAllowed?: string; dropEffect?: string } | null;
};
type DragRowNode = {
  draggable?: boolean;
  addEventListener(type: string, fn: (e: DragEventLike) => void): void;
  getBoundingClientRect(): { top: number; height: number };
  style: { boxShadow: string; opacity: string };
  __csbDrag?: { key: string; color: string; onDrop: (from: string, to: string, after: boolean) => void };
};
// 지금 끌고 있는 줄 — 같은 창 안에서만 옮기므로 dataTransfer 대신 이걸 본다(밖에서 끌어온 파일 등은 받지 않는다)
let draggingKey: string | null = null;

/**
 * 줄을 마우스로 끌어 순서를 바꾸게 한다(웹·데스크톱만, 10-06 고정 프로젝트 순서). 플러그인 도구에 끌어 옮기기가 없어서
 * react-native-web 이 ref 로 넘겨주는 DOM 요소에 브라우저 드래그를 직접 단다. 놓을 자리는 줄 위·아래 반쪽으로 가르고
 * 그 쪽에 선을 그린다. ref 는 그릴 때마다 불리므로 리스너는 처음 한 번만 달고 key·onDrop 만 새로 바꾼다.
 */
export function setDraggableRow(node: unknown, key: string, color: string, onDrop: (from: string, to: string, after: boolean) => void): void {
  if (!isWeb() || !node) return;
  const el = node as DragRowNode;
  const first = !el.__csbDrag;
  el.__csbDrag = { key, color, onDrop };
  if (!first) return;
  el.draggable = true;
  const clear = () => {
    el.style.boxShadow = "";
  };
  const below = (e: DragEventLike) => {
    const r = el.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  el.addEventListener("dragstart", (e) => {
    draggingKey = el.__csbDrag?.key ?? null;
    if (draggingKey) e.dataTransfer?.setData("text/plain", draggingKey);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    el.style.opacity = "0.5";
  });
  el.addEventListener("dragend", () => {
    draggingKey = null;
    el.style.opacity = "";
    clear();
  });
  el.addEventListener("dragover", (e) => {
    const me = el.__csbDrag;
    if (!draggingKey || !me || draggingKey === me.key) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    el.style.boxShadow = `inset 0 ${below(e) ? -2 : 2}px 0 ${me.color}`;
  });
  el.addEventListener("dragleave", clear);
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    clear();
    const from = draggingKey;
    draggingKey = null;
    const me = el.__csbDrag;
    if (from && me && from !== me.key) me.onDrop(from, me.key, below(e));
  });
}

/**
 * 마우스를 올리면 뜨는 설명(브라우저 title)을 단다(웹·데스크톱만). 플러그인 도구에 툴팁 부품이 없어서(10-06 확인)
 * react-native-web 이 ref 로 넘겨주는 DOM 요소에 직접 단다. 폰 앱은 마우스가 없으니 아무것도 안 한다.
 */
export function setHoverTitle(node: unknown, text: string): void {
  if (!isWeb() || !node) return;
  (node as { setAttribute?: (name: string, value: string) => void }).setAttribute?.("title", text);
}

/**
 * 앱 화면 일부를 스타일로 가린다(웹·데스크톱만). css 를 null 로 주면 걷는다. 플러그인은 Paseo 왼쪽 목록을 숨길 수 없어서
 * (플러그인 도구에 없음, 10-06 확인) 워크스페이스 목록 상자를 이름표(testID → data-testid)로 가린다 — 이름표가 바뀌면
 * 가림만 풀리고 다른 고장은 없다.
 */
export function setStyleSheet(id: string, css: string | null): void {
  if (!isWeb()) return;
  const old = document.getElementById(id);
  if (css === null) {
    old?.remove();
    return;
  }
  if (old) {
    old.textContent = css;
    return;
  }
  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

/** 앱 어디에 있든 받는 단축키(웹·데스크톱만). 조합 판정은 부르는 쪽이 한다 — Alt 와 같이 누르면 key 가 특수문자로 바뀌어 code 로 본다 */
export function listenGlobalKey(match: (e: { code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }) => boolean, fn: () => void): () => void {
  if (!isWeb()) return () => {};
  const onKey = (e: KeyEventLike) => {
    if (!match({ code: e.code ?? "", ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey })) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  document.addEventListener("keydown", onKey, true);
  return () => document.removeEventListener("keydown", onKey, true);
}

/**
 * 이 화면 코드 파일의 지문(Expo 웹 묶음 `index-<지문>.js`). 화면 판이 같으면 같다 — PC 앱과 우리가 직접 올린 웹은
 * PC 앱의 app-dist 를 그대로 올려서 같은 파일이다. 웹이 아니거나 못 찾으면 null
 */
export function appBundleId(): string | null {
  if (!isWeb()) return null;
  const el = document.querySelector('script[src*="/_expo/static/js/web/index-"]') as unknown as { src?: string } | null;
  const m = el?.src?.match(/\/index-([0-9a-f]+)\.js/);
  return m ? m[1] : null;
}

/** 지금 PC 앱(Electron) 안인지 — 브라우저·폰 웹 감싸기 앱이면 false */
export function isDesktopApp(): boolean {
  return isWeb() && typeof window !== "undefined" && !!window.paseoDesktop && typeof window.paseoDesktop === "object";
}

/** 사람이 화면을 누르거나 키를 쳤을 때 알린다(웹·데스크톱만) */
export function onUserInput(fn: () => void): () => void {
  if (!isWeb()) return () => {};
  const on = () => fn();
  document.addEventListener("pointerdown", on, true);
  document.addEventListener("keydown", on, true);
  return () => {
    document.removeEventListener("pointerdown", on, true);
    document.removeEventListener("keydown", on, true);
  };
}

/**
 * 저장값을 써 넣고 이 페이지가 끝날 때까지 같은 열쇠를 Paseo 가 다시 쓰지 못하게 막은 뒤 화면을 새로 읽는다(웹·데스크톱만).
 * 써 넣고 새로 읽히기 전 사이에 Paseo 가 메모리의 옛 상태를 다시 저장해 덮어쓴다 — 동기화 단추로 가져온 화면 구성이 그렇게
 * 사라졌다(10-07 실화면: 작업 공간 순서는 남고 화면 구성만 옛것. 진짜 웹 화면에 넣고 새로 읽기만 하면 그대로 남는 것을 확인).
 * 막은 것은 이 페이지에만 있어 새로 읽으면 사라진다.
 */
export function writeLocalAndReload(entries: Record<string, string>): void {
  const store = storage();
  if (!store || typeof Storage === "undefined") return;
  const proto = Storage.prototype;
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  for (const [key, value] of Object.entries(entries)) origSet.call(store, key, value);
  const held = new Set(Object.keys(entries));
  proto.setItem = function (this: StorageLike, key: string, value: string) {
    if (this === store && held.has(String(key))) return;
    origSet.call(this, key, value);
  };
  proto.removeItem = function (this: StorageLike, key: string) {
    if (this === store && held.has(String(key))) return;
    origRemove.call(this, key);
  };
  reloadPage();
}

/** 화면을 새로 읽는다(웹·데스크톱만) — Paseo 는 설정을 시작할 때만 읽어서, 바뀐 저장값을 보이려면 이 길뿐이다 */
export function reloadPage(): void {
  if (isWeb() && typeof location !== "undefined") location.reload();
}

/**
 * 화면에서 마우스로 선택한 글을 알린다(웹·데스크톱만 — 폰 앱은 아무것도 하지 않는다). 선택이 생기면 바로 알리고,
 * 풀린 것은 마우스·키를 뗀 다음 차례에 "" 로 알린다 — 입력창 위 "선택 읽기" 알약을 누르는 순간 선택이 풀려도
 * 누름이 먼저 처리돼 마지막 선택을 읽을 수 있게(리규형님 10-06 선택 읽기)
 */
export type SelectionSnapshot = { text: string; token: unknown };

export function watchSelection(fn: (snapshot: SelectionSnapshot | null) => void): () => void {
  if (Platform.OS !== "web") return () => {};
  const read = (): SelectionSnapshot | null => {
    const sel = window.getSelection();
    const text = (sel?.toString() ?? "").trim();
    return sel && text && sel.rangeCount > 0 ? { text, token: sel.getRangeAt(0).cloneRange() } : null;
  };
  const onChange = () => {
    const snapshot = read();
    if (snapshot) fn(snapshot);
  };
  const onRelease = () => {
    setTimeout(() => fn(read()), 0);
  };
  document.addEventListener("selectionchange", onChange, false);
  document.addEventListener("mouseup", onRelease, false);
  document.addEventListener("keyup", onRelease, false);
  return () => {
    document.removeEventListener("selectionchange", onChange, false);
    document.removeEventListener("mouseup", onRelease, false);
    document.removeEventListener("keyup", onRelease, false);
  };
}

/** 화면의 글 선택을 푼다 — 선택 읽기가 시작되면 선택 색 대신 형광펜만 보이게(리규형님 10-06) */
export function clearSelection(): void {
  if (Platform.OS !== "web") return;
  window.getSelection()?.removeAllRanges();
}

const READING_HL = "claude-state-bar-reading";
const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;

function blockOf(node: NodeLike): NodeLike | null {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.nodeType === 1 && BLOCK_DISPLAY.test(window.getComputedStyle(n).display)) return n;
  }
  return null;
}

/**
 * 선택 범위를 화면 문단(가장 가까운 블록 요소)마다 나눈다 — 재생기가 문단 단위로 읽고 이전·다음이 먹게(리규형님 10-06).
 * highlight(i) 는 i 번째 문단에 노란 형광펜을 칠한다 — 크롬 확장 read-aloud-hrg 와 같은 방식(CSS 강조 기능·같은 색, js/events.js:374).
 * 선택 범위를 그대로 쓰므로 Paseo 화면 요소 이름에 기대지 않는다. 대화가 다시 그려지면 칠한 자리는 사라질 수 있다
 */
export function selectionParagraphs(token: unknown): { texts: string[]; highlight(index: number | null): void } | null {
  if (Platform.OS !== "web" || !token) return null;
  const range = token as RangeLike;
  const common = range.commonAncestorContainer;
  const root = common.nodeType === 3 ? common.parentNode : common;
  if (!root) return null;
  const walker = document.createTreeWalker(root, 4); // 글자 노드만
  const parts: { text: string; ranges: RangeLike[]; block: NodeLike | null }[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const value = n.nodeValue ?? "";
    const start = n === range.startContainer ? range.startOffset : 0;
    const end = n === range.endContainer ? range.endOffset : value.length;
    if (end <= start) continue;
    const block = blockOf(n);
    let part = parts[parts.length - 1];
    if (!part || part.block !== block) {
      part = { text: "", ranges: [], block };
      parts.push(part);
    }
    const piece = document.createRange();
    piece.setStart(n, start);
    piece.setEnd(n, end);
    part.text += value.slice(start, end);
    part.ranges.push(piece);
  }
  // 재생기는 빈 줄로 문단을 나눈다 — 문단 안 빈 줄은 한 줄로 줄이고 공백뿐인 문단은 뺀다(문단 번호를 화면과 맞춘다)
  const list = parts.map((p) => ({ text: p.text.replace(/\n[\t ]*\n\s*/g, "\n").trim(), ranges: p.ranges })).filter((p) => p.text);
  if (!list.length) return null;
  return {
    texts: list.map((p) => p.text),
    highlight: (index) => {
      const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
      if (!highlights) return;
      const target = index === null ? undefined : list[index];
      if (!target) return highlights.delete(READING_HL);
      setStyleSheet(`${READING_HL}-style`, `::highlight(${READING_HL}) { background-color: rgba(255, 226, 0, 0.3); }`);
      highlights.set(READING_HL, new Highlight(...target.ranges));
    },
  };
}

/**
 * 왼쪽 목록에서 rootId 요소 윗변부터 아래쪽 줄(sidebar-footer) 바로 위까지의 높이 — 칸이 그만큼 늘어나 가린 워크스페이스 목록
 * 자리를 채운다. 아래쪽 줄은 창 바닥에 붙어 있으므로 "창 바닥(아래쪽 줄이 밀려 나갔으면 창 바닥) − 아래쪽 줄 높이"로 잰다 —
 * 칸이 이미 늘어난 뒤 창을 줄여도 줄어든 값이 나오게. 웹이 아니거나 아직 그려지지 않았으면 null.
 */
export function measureRoomAbove(rootId: string, footerTestId: string): number | null {
  if (!isWeb()) return null;
  const root = document.getElementById(rootId);
  const footer = document.querySelector(`[data-testid="${footerTestId}"]`);
  if (!root || !footer) return null;
  const f = footer.getBoundingClientRect();
  const bottom = Math.min(f.bottom, window.innerHeight);
  const room = bottom - f.height - root.getBoundingClientRect().top;
  return room > 0 ? Math.floor(room) : null;
}

export function onWindowResize(fn: () => void): () => void {
  if (!isWeb() || typeof window === "undefined") return () => {};
  window.addEventListener("resize", fn);
  return () => window.removeEventListener("resize", fn);
}
export function listenCtrlTab(rootId: string, onTab: (backward: boolean) => void): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  let armed = false;
  const onPointer = (e: KeyEventLike) => {
    armed = !!document.getElementById(rootId)?.contains(e.target);
  };
  const onKey = (e: KeyEventLike) => {
    if (e.key !== "Tab" || !e.ctrlKey || e.altKey || e.metaKey || !armed || !document.getElementById(rootId)) return;
    e.preventDefault();
    e.stopPropagation();
    onTab(!!e.shiftKey);
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

// ── 대화 입력창 마크다운 목록 보조(리규형님 10-07) ──
// 플러그인 도구에는 입력창 글 읽기·쓰기가 없어서(addComposerPill·addSlashCommand·addAttachmentSource 뿐, 10-07 확인)
// 입력창 묶음 이름표(testID "message-input-root" → data-testid) 안의 글상자(textarea)를 직접 만진다. 이름표가 바뀌면
// 보조만 멈추고 입력창은 원래대로 쓴다. 글은 브라우저 글 넣기(execCommand insertText)로 바꿔 Ctrl+Z 로 되돌릴 수 있고,
// 진짜 입력 이벤트가 나서 Paseo 입력 상태도 따라온다.
const COMPOSER_ROOT = '[data-testid="message-input-root"]';
const COMPOSER_TEXTAREA = `${COMPOSER_ROOT} textarea`;
const AUTOCOMPLETE = '[data-testid="composer-autocomplete-popover"]';

type TextAreaEl = {
  tagName?: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  isConnected: boolean;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  closest?(selector: string): unknown;
  dispatchEvent(event: unknown): boolean;
};
type TreeEl = { parentElement: TreeEl | null; querySelector?(selector: string): unknown };
declare class Event {
  constructor(type: string, init?: { bubbles?: boolean });
}

/** 입력창 글상자 — 이 파일 밖에서는 글과 고른 범위만 읽는다 */
export type ComposerTextArea = { readonly value: string; readonly selectionStart: number; readonly selectionEnd: number; readonly isConnected: boolean };
export type ComposerKey = "shift-enter" | "tab" | "backspace";

function asComposer(target: unknown): TextAreaEl | null {
  const el = target as TextAreaEl | null;
  if (!el || el.tagName !== "TEXTAREA" || typeof el.closest !== "function" || !el.closest(COMPOSER_ROOT)) return null;
  return el;
}

/** 누른 자리에서 위로 올라가며 가장 가까운 입력창. 화면 맨 바깥(body)에 걸린 메뉴 같은 것을 누르면 null */
function nearestComposer(target: unknown): TextAreaEl | null {
  for (let n = target as TreeEl | null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const found = n.querySelector?.(COMPOSER_TEXTAREA);
    if (found) return found as TextAreaEl;
  }
  return null;
}

function lineCount(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

/**
 * 글상자 글을 edit 대로 바꾸고 커서를 놓는다. 앞뒤가 같은 부분은 두고 가운데만 갈아 끼워 되돌리기 한 번에 돌아가게 한다.
 * 글 넣기가 막히면(옛 브라우저) 값을 직접 넣고 입력 이벤트를 낸다 — 이때는 되돌리기 기록이 없다.
 */
export function applyComposerEdit(target: ComposerTextArea, edit: Edit): void {
  const el = target as unknown as TextAreaEl;
  const old = el.value;
  el.focus();
  if (old !== edit.text) {
    let a = 0;
    while (a < old.length && a < edit.text.length && old[a] === edit.text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < edit.text.length - a && old[old.length - 1 - b] === edit.text[edit.text.length - 1 - b]) b++;
    const insert = edit.text.slice(a, edit.text.length - b);
    el.setSelectionRange(a, old.length - b);
    let ok = false;
    try {
      ok = insert ? document.execCommand("insertText", false, insert) : document.execCommand("delete", false);
    } catch {
      ok = false;
    }
    if (!ok || el.value !== edit.text) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, edit.text);
      else el.value = edit.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  el.setSelectionRange(edit.start, edit.end);
}

/**
 * 입력창 키·삭제·누름을 듣는다(웹·데스크톱만).
 * - key: Shift+Enter · Tab · Backspace(다른 조합 키 없이). edit 를 돌려주면 그대로 고치고 키는 Paseo 에 안 넘긴다. null 이면 넘긴다.
 *   한글 조합 중이거나 자동완성 메뉴가 열려 있으면 묻지도 않고 넘긴다. Paseo 단축키 처리기는 창(window)에서 먼저 받지만
 *   이 세 키에는 단축키가 없다(Shift+Tab 만 있다 — 그래서 내어쓰기를 Backspace 로 정했다, 10-07).
 * - linesChanged: 지우기·붙여넣기·끌어 놓기로 줄 수가 바뀌었을 때. Paseo 가 입력을 다 받은 다음 차례에 부른다.
 * - pointed: 화면을 누른 자리에서 가장 가까운 입력창 — 알약 메뉴가 어느 입력창을 고칠지 정한다. 메뉴처럼 화면 맨 바깥에
 *   뜬 것을 누르면 부르지 않는다(알약을 누를 때 기억한 입력창이 남게).
 */
export function listenComposer(on: {
  key(key: ComposerKey, el: ComposerTextArea): Edit | null;
  linesChanged(el: ComposerTextArea): Edit | null;
  pointed(el: ComposerTextArea): void;
}): () => void {
  if (!isWeb()) return () => {};
  let before = -1;
  const onKey = (e: KeyEventLike) => {
    if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey) return;
    const kind: ComposerKey | null =
      e.key === "Enter" && e.shiftKey ? "shift-enter" : e.key === "Tab" && !e.shiftKey ? "tab" : e.key === "Backspace" && !e.shiftKey ? "backspace" : null;
    if (!kind) return;
    const el = asComposer(e.target);
    if (!el || document.querySelector(AUTOCOMPLETE)) return;
    const edit = on.key(kind, el);
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    applyComposerEdit(el, edit);
  };
  const onBeforeInput = (e: KeyEventLike) => {
    const el = asComposer(e.target);
    before = el ? lineCount(el.value) : -1;
  };
  const onInput = (e: KeyEventLike) => {
    const type = e.inputType ?? "";
    if (!type.startsWith("delete") && type !== "insertFromPaste" && type !== "insertFromDrop") return;
    const el = asComposer(e.target);
    if (!el || before < 0 || lineCount(el.value) === before) return;
    setTimeout(() => {
      if (!el.isConnected) return;
      const edit = on.linesChanged(el);
      if (edit) applyComposerEdit(el, edit);
    }, 0);
  };
  const onPointer = (e: KeyEventLike) => {
    const el = nearestComposer(e.target);
    if (el) on.pointed(el);
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("pointerdown", onPointer, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("beforeinput", onBeforeInput, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("pointerdown", onPointer, true);
  };
}

declare const atob: (base64: string) => string;
declare class Blob { constructor(parts: Uint8Array[], options: { type: string }); }
declare const URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };

/** 생각 읽기 전용 Audio 하나. 다른 알림 소리 함수는 기존 동작 그대로 둔다. */
export function createThinkingAudio(): ThinkingAudio {
  let audio: Audio | undefined;
  let url: string | undefined;
  let generation = 0;
  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  };
  const load = (file: AudioFile) => {
    const raw = atob(file.base64);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
    audio!.src = url;
  };
  return {
    async play(file, rate, ended, error) {
      if (Platform.OS !== "web") throw new Error("이 앱에서는 소리 읽기를 지원하지 않습니다");
      const token = ++generation;
      audio ??= new Audio();
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      release();
      load(file);
      audio.playbackRate = rate;
      audio.preservesPitch = true;
      audio.onended = () => { if (generation === token) ended(); };
      audio.onerror = () => { if (generation === token) error(audio?.error?.message || `오디오 오류 ${audio?.error?.code ?? ""}`); };
      await audio.play();
    },
    pause() { if (Platform.OS === "web") audio?.pause(); },
    async resume() {
      if (Platform.OS !== "web") return;
      await audio?.play();
    },
    stop() {
      if (Platform.OS !== "web") return;
      generation += 1;
      if (audio) {
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
        audio.removeAttribute("src");
        audio.load();
      }
      release();
    },
    setRate(rate) {
      if (Platform.OS !== "web" || !audio) return;
      audio.playbackRate = rate;
      audio.preservesPitch = true;
    },
  };
}
