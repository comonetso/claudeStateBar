import { Linking, Platform } from "react-native";
import type { Edit } from "./markdownList";
import type { AudioFile, ThinkingAudio } from "./thinkingPlayer";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: {
  open(url: string, target: string, features: string): unknown;
  dispatchEvent(event: unknown): boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  innerHeight: number;
  innerWidth: number;
  getSelection(): { toString(): string; rangeCount: number; getRangeAt(index: number): RangeLike; removeAllRanges(): void } | null;
  getComputedStyle(el: unknown, pseudo?: string): { display: string; flexWrap?: string; flexDirection?: string; order?: string; content?: string; flexBasis?: string; position?: string; backgroundColor?: string };
  matchMedia?(query: string): { matches: boolean };
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
  toString(): string;
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
type HistoryWrite = (data: unknown, unused: string, url?: string | null) => void;
declare const history: { readonly length: number; back(): void; pushState: HistoryWrite; replaceState: HistoryWrite } | undefined;
declare const location: { reload(): void; readonly pathname: string } | undefined;

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
  getBoundingClientRect(): { top: number; bottom: number; height: number; left: number; right: number; width: number };
  textContent: string | null;
  remove(): void;
};
declare const document: {
  getElementById(id: string): ElementLike | null;
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<HeaderEl>;
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
 * 지금 화면이 보고 있는 작업 공간(웹·데스크톱만, 10-07 프로젝트 목록 현재 프로젝트 녹색). 플러그인 도구에는 "지금 보는
 * 작업 공간"이 없어서 Paseo 화면 주소 /h/<서버>/workspace/<작업 공간> 에 기댄다 — 주소 모양이 바뀌면 녹색만 안 나온다.
 * 폰 앱은 주소가 없어 null
 */
export function currentWorkspaceFromUrl(): { serverId: string; workspaceId: string } | null {
  if (!isWeb() || typeof location === "undefined") return null;
  const m = /^\/h\/([^/]+)\/workspace\/([^/?#]+)/.exec(location.pathname);
  return m ? { serverId: decodeURIComponent(m[1]), workspaceId: decodeURIComponent(m[2]) } : null;
}

type LocationHub = { listeners: Set<() => void> };
/**
 * 화면 주소가 바뀔 때마다 부른다(웹·데스크톱만). Paseo 는 주소를 history.pushState·replaceState 로 바꾸므로 그 둘을 한 번만
 * 감싸 알린다(원래 동작은 그대로 하고 뒤에 알리기만). 호스트마다 플러그인이 따로 실려도 감싸기는 한 벌 — globalThis 표식.
 * (10-08: 옛 "주소 ?open= + 가짜 popstate" 파일 열기 함수 navigateInApp·base64Url 은 부르는 곳이 없어 지웠다 — 파일 열기는
 * 아래 openWorkspaceFile 이 Paseo 내부 이동 함수를 쓴다)
 */
export function watchLocation(listener: () => void): () => void {
  if (!isWeb() || typeof history === "undefined") return () => {};
  const g = globalThis as { __claudeStateBar_locationHub_v1?: LocationHub };
  let hub = g.__claudeStateBar_locationHub_v1;
  if (!hub) {
    const made: LocationHub = { listeners: new Set() };
    const fire = () => queueMicrotask(() => {
      for (const l of made.listeners) l();
    });
    const h = history;
    for (const name of ["pushState", "replaceState"] as const) {
      const original = h[name].bind(h);
      h[name] = (...args: Parameters<HistoryWrite>) => {
        original(...args);
        fire();
      };
    }
    window.addEventListener("popstate", fire);
    hub = g.__claudeStateBar_locationHub_v1 = made;
  }
  const own = hub;
  own.listeners.add(listener);
  return () => {
    own.listeners.delete(listener);
  };
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
  __csbDrag?: { key: string; group: string; color: string; onDrop: (from: string, to: string, after: boolean) => void };
};
// 지금 끌고 있는 줄과 그 묶음 — 같은 창 안에서만 옮기므로 dataTransfer 대신 이걸 본다(밖에서 끌어온 파일 등은 받지 않는다)
let draggingKey: string | null = null;
let draggingGroup: string | null = null;

/**
 * 줄을 마우스로 끌어 순서를 바꾸게 한다(웹·데스크톱만, 10-06 고정 프로젝트 순서 → 10-07 모든 묶음). 플러그인 도구에 끌어
 * 옮기기가 없어서 react-native-web 이 ref 로 넘겨주는 DOM 요소에 브라우저 드래그를 직접 단다. 놓을 자리는 줄 위·아래 반쪽으로
 * 가르고 그 쪽에 선을 그린다. 같은 group 의 줄에만 놓인다(한 프로젝트가 활성과 태그 묶음에 함께 보여서).
 * ref 는 그릴 때마다 불리므로 리스너는 처음 한 번만 달고 key·group·onDrop 만 새로 바꾼다.
 */
export function setDraggableRow(node: unknown, key: string, group: string, color: string, onDrop: (from: string, to: string, after: boolean) => void): void {
  if (!isWeb() || !node) return;
  const el = node as DragRowNode;
  const first = !el.__csbDrag;
  el.__csbDrag = { key, group, color, onDrop };
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
    draggingGroup = el.__csbDrag?.group ?? null;
    if (draggingKey) e.dataTransfer?.setData("text/plain", draggingKey);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    el.style.opacity = "0.5";
  });
  el.addEventListener("dragend", () => {
    draggingKey = null;
    draggingGroup = null;
    el.style.opacity = "";
    clear();
  });
  el.addEventListener("dragover", (e) => {
    const me = el.__csbDrag;
    if (!draggingKey || !me || draggingKey === me.key || draggingGroup !== me.group) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    el.style.boxShadow = `inset 0 ${below(e) ? -2 : 2}px 0 ${me.color}`;
  });
  el.addEventListener("dragleave", clear);
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    clear();
    const from = draggingKey;
    const fromGroup = draggingGroup;
    draggingKey = null;
    draggingGroup = null;
    const me = el.__csbDrag;
    if (from && me && from !== me.key && fromGroup === me.group) me.onDrop(from, me.key, below(e));
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
 * 브라우저 페이지 번역(Chrome 번역·DeepL 등)이 이 요소 안 글을 건드리지 않게 표시한다(웹·데스크톱만). 10-09 리규형님 화면:
 * 번역이 켜져 사용량 표의 "10/10 15:00" 이 "10월 10일 15:00", "5h" 가 "5시간" 으로 바뀌어 길어지면서 칸 밖으로 튀어나갔다
 * (표가 그려지고 약 0.5초 뒤). 숫자·날짜·계정 이름뿐인 칸에 쓴다
 */
export function setNoTranslate(node: unknown): void {
  if (!isWeb() || !node) return;
  const el = node as { setAttribute?: (name: string, value: string) => void; classList?: { add(name: string): void } };
  el.setAttribute?.("translate", "no");
  el.classList?.add("notranslate");
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

type MemoryState = Record<string, unknown>;
type MemoryStore = {
  getState(): MemoryState;
  setState(state: MemoryState): void;
  persist: {
    hasHydrated(): boolean;
    getOptions(): {
      name: string;
      version: number;
      partialize(state: MemoryState): unknown;
      merge(saved: unknown, current: MemoryState): MemoryState;
    };
  };
};

// Paseo 내부 모듈 번호는 화면 코드 파일(번들)마다 다르다 — 판마다 번들에서 직접 확인한 번호만 쓴다(업데이트 점검표 19·20).
// 모르는 번들에서는 쓰지 않고 해당 기능을 끈다(번호를 짐작해 맞추지 않는다). 설정 화면의 "이 화면의 Paseo 판" 칸이 꺼진 것을 알린다.
// 새 판을 넣을 때: 번들에서 export 이름(useWorkspaceLayoutStore·WorkspaceLayoutPersistedStateSchema·navigateToWorkspace·
// useSidebarOrderStore·queryClient)이 있는 모듈 번호를 찾고 본문이 이전 판과 같은지 확인한 뒤 한 줄 더한다.
export type PaseoModuleIds = { layout: number; schema: number; navigate: number; sidebarOrder: number; queryClient: number };
export const PASEO_BUNDLES: Record<string, { version: string; ids: PaseoModuleIds }> = {
  // PC 앱 0.11.0-beta.5 (= 10-07 에 올린 웹)
  f07439c15f40c0ca1689fb49e3dcc6c8: { version: "0.11.0-beta.5", ids: { layout: 3801, schema: 3802, navigate: 3898, sidebarOrder: 4025, queryClient: 848 } },
  // PC 앱 0.11.1 (10-08 업데이트) — 위 판과 모듈 본문이 같고 번호만 2씩 밀렸다(tmp/paseo_0111_probe/probe.cjs)
  "3a92a6be2c6767623cc9fa2aa410618e": { version: "0.11.1", ids: { layout: 3803, schema: 3804, navigate: 3900, sidebarOrder: 4027, queryClient: 850 } },
};

/** 이 화면 번들에서 확인한 모듈 번호. 모르는 판이거나 웹이 아니면 null */
export function paseoModuleIds(): PaseoModuleIds | null {
  const id = appBundleId();
  return id ? PASEO_BUNDLES[id]?.ids ?? null : null;
}

function paseoModule(which: keyof PaseoModuleIds): MemoryState | null {
  const ids = paseoModuleIds();
  if (!ids) return null;
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return null;
  try {
    const value = require(ids[which]);
    return value && typeof value === "object" ? value as MemoryState : null;
  } catch {
    return null;
  }
}

function paseoMemoryStore(which: keyof PaseoModuleIds, exported: string, key: string): MemoryStore | null {
  const store = paseoModule(which)?.[exported] as MemoryStore | undefined;
  if (typeof store?.getState !== "function" || typeof store.setState !== "function" ||
      typeof store.persist?.hasHydrated !== "function" || typeof store.persist.getOptions !== "function") return null;
  const options = store.persist.getOptions();
  return store.persist.hasHydrated() && options.name === key && typeof options.partialize === "function" &&
    typeof options.merge === "function" ? store : null;
}

// ── 업데이트 대비 상태 표시(10-08 리규형님 결정 — Codex 261008_150613 작업 1~3) ──
// 위 연결은 실패하면 null/false 만 돌려줘 왜 꺼졌는지가 사라진다(0.11.1 업데이트 때 "어떤 게 안 되는지조차 모름").
// 같은 연결을 읽기만 해서 막힌 이유를 돌려준다. 값을 쓰거나 화면 배치를 바꾸지 않는다(client/health.ts 가 기능별로 판정).
export type InternalsReason = "not-web" | "unknown-bundle" | "no-require" | "load-failed" | "no-export" | "shape-mismatch" | "not-hydrated";
export type PaseoInternals = { layout: InternalsReason | null; schema: InternalsReason | null; navigate: InternalsReason | null; sidebarOrder: InternalsReason | null };

function probeModule(which: keyof PaseoModuleIds): MemoryState | InternalsReason {
  if (!isWeb()) return "not-web";
  const ids = paseoModuleIds();
  if (!ids) return "unknown-bundle";
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return "no-require";
  try {
    const value = require(ids[which]);
    return value && typeof value === "object" ? (value as MemoryState) : "no-export";
  } catch {
    return "load-failed";
  }
}

/** paseoMemoryStore 와 같은 조건을 하나씩 보고 처음 걸린 것을 돌려준다. null = 갖춰짐 */
function probeStore(which: keyof PaseoModuleIds, exported: string, key: string): InternalsReason | null {
  const mod = probeModule(which);
  if (typeof mod === "string") return mod;
  const store = mod[exported] as MemoryStore | undefined;
  if (typeof store?.getState !== "function" || typeof store.setState !== "function" ||
      typeof store.persist?.hasHydrated !== "function" || typeof store.persist.getOptions !== "function") return "no-export";
  const options = store.persist.getOptions();
  if (options.name !== key || typeof options.partialize !== "function" || typeof options.merge !== "function") return "shape-mismatch";
  return store.persist.hasHydrated() ? null : "not-hydrated";
}

export function probePaseoInternals(): PaseoInternals {
  const schema = probeModule("schema");
  const navigate = probeModule("navigate");
  return {
    layout: probeStore("layout", "useWorkspaceLayoutStore", "workspace-layout-state"),
    schema: typeof schema === "string" ? schema : typeof (schema.WorkspaceLayoutPersistedStateSchema as { safeParse?: unknown } | undefined)?.safeParse === "function" ? null : "no-export",
    navigate: typeof navigate === "string" ? navigate : typeof navigate.navigateToWorkspace === "function" ? null : "no-export",
    sidebarOrder: probeStore("sidebarOrder", "useSidebarOrderStore", "sidebar-project-workspace-order"),
  };
}

/** 배치·순서 저장소가 저장 파일을 다 읽으면 알린다(시작 직후엔 읽는 중 — 그 사이 판정은 "확인 중"). 끊기 함수 */
export function onPaseoStoresHydrated(fn: () => void): () => void {
  const stops: (() => void)[] = [];
  for (const [which, exported] of [["layout", "useWorkspaceLayoutStore"], ["sidebarOrder", "useSidebarOrderStore"]] as const) {
    const mod = probeModule(which);
    if (typeof mod === "string") continue;
    const persist = (mod[exported] as { persist?: { hasHydrated?(): boolean; onFinishHydration?(f: () => void): () => void } } | undefined)?.persist;
    if (typeof persist?.onFinishHydration !== "function" || persist.hasHydrated?.()) continue;
    stops.push(persist.onFinishHydration(fn));
  }
  return () => {
    for (const stop of stops) stop();
  };
}

function layoutSchema(): { safeParse(value: unknown): { success: boolean } } | null {
  const schema = paseoModule("schema")?.WorkspaceLayoutPersistedStateSchema as ReturnType<typeof layoutSchema>;
  return typeof schema?.safeParse === "function" ? schema : null;
}

/** 배치는 저장 파일 대신 화면이 구독하는 메모리에서 읽고, 엄격한 앱 스키마를 통과한 변경만 한 번에 알린다. */
export function readPaseoLayout(): MemoryState | null {
  return paseoMemoryStore("layout", "useWorkspaceLayoutStore", "workspace-layout-state")?.getState() ?? null;
}
export function updatePaseoLayout(patch: MemoryState): boolean {
  const store = paseoMemoryStore("layout", "useWorkspaceLayoutStore", "workspace-layout-state");
  const schema = layoutSchema();
  if (!store || !schema) return false;
  if (!schema.safeParse(store.persist.getOptions().partialize({ ...store.getState(), ...patch })).success) return false;
  store.setState(patch);
  return true;
}

/** 모든 호스트의 플러그인 인스턴스가 공유한다. 늦게 도착한 시작 시 PC 복사가 사용자 동작을 되돌리지 못하게 한다. */
export function workspaceInteractionVersion(): number {
  const g = globalThis as { __claudeStateBar_workspaceAction_v1?: { revision: number } };
  return (g.__claudeStateBar_workspaceAction_v1 ??= { revision: 0 }).revision;
}
export function markWorkspaceInteraction(): void {
  workspaceInteractionVersion();
  const g = globalThis as { __claudeStateBar_workspaceAction_v1?: { revision: number } };
  g.__claudeStateBar_workspaceAction_v1!.revision++;
}

/** 공개 navigation에는 파일 target이 없어 같은 앱 내부 정상 이동 함수를 사용한다. 주소 지시·가짜 popstate는 쓰지 않는다. */
export function canOpenWorkspaceFile(): boolean {
  return readPaseoLayout() !== null && typeof paseoModule("navigate")?.navigateToWorkspace === "function";
}
export function openWorkspaceFile(serverId: string, workspaceId: string, path: string): boolean {
  if (!canOpenWorkspaceFile()) return false;
  const navigate = paseoModule("navigate")!.navigateToWorkspace as (input: MemoryState) => void;
  navigate({ serverId, workspaceId, target: { kind: "file", path } });
  return true;
}

let layoutAppliedAt = 0;
/** 마지막으로 다른 화면 배치를 메모리에 덮은 시각(0 = 없음) — 칸 최대화가 풀린 원인 기록용(paneMaxWatch, 10-09) */
export function lastLayoutAppliedAt(): number {
  return layoutAppliedAt;
}

/** 시작 시 PC 복사도 메모리에 반영한다. 모르는 판·저장 형식은 변경하지 않는다. */
export function applyPaseoLayoutCopy(key: string, value: string): boolean {
  const store = key === "workspace-layout-state"
    ? paseoMemoryStore("layout", "useWorkspaceLayoutStore", key)
    : key === "sidebar-project-workspace-order" ? paseoMemoryStore("sidebarOrder", "useSidebarOrderStore", key) : null;
  if (!store) return false;
  try {
    const saved = JSON.parse(value) as { state?: MemoryState; version?: number };
    const options = store.persist.getOptions();
    if (saved.version !== options.version || !saved.state || typeof saved.state !== "object" || Array.isArray(saved.state)) return false;
    if (key === "workspace-layout-state") {
      if (!layoutSchema()?.safeParse(saved.state).success) return false;
    } else {
      // sidebarOrder 모듈의 비공개 엄격한 스키마 중 현행 저장 필드만 받아들인다.
      const stringList = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
      if (Object.keys(saved.state).some((k) => !["projectOrder", "pinnedWorkspaceOrder", "workspaceOrderByProject"].includes(k))) return false;
      if (!stringList(saved.state.projectOrder) || !stringList(saved.state.pinnedWorkspaceOrder)) return false;
      const groups = saved.state.workspaceOrderByProject;
      if (!groups || typeof groups !== "object" || Array.isArray(groups) || !Object.values(groups).every(stringList)) return false;
    }
    const next = options.merge(saved.state, store.getState());
    if (key === "workspace-layout-state" && !layoutSchema()?.safeParse(options.partialize(next)).success) return false;
    store.setState(next);
    if (key === "workspace-layout-state") layoutAppliedAt = Date.now();
    return true;
  } catch {
    return false;
  }
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
 * 써 넣고 새로 읽히기 전 사이에 Paseo 가 메모리의 옛 상태를 다시 저장해 덮어쓴다 — PC 에서 가져온 화면 구성이 그렇게
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

/** 화면을 새로 읽는다(웹·데스크톱만) — Paseo 는 설정을 처음 한 번만 저장소에서 읽는다. 설정 맞추기는 먼저 캐시 다시 읽기
 *  (settingsCache)를 쓰고, 그게 안 되는 판에서만 이것으로 물러난다(10-08 리규형님 결정) */
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
 * 선택(watchSelection 의 token)이 어느 문단에서 시작하는가(10-08 생각 상자 선택 읽기 — 리규형님 "선택해 두고 읽기를 누르면 그 위치부터").
 * paragraphIds = 플러그인이 직접 그린 문단 요소의 nativeID(웹에서 id) 순서대로. 선택이 걸친 첫 문단의 번호와, 선택이 그 문단 안에서
 * 시작했으면 그 문단 글 안의 글자 자리(문단 밖에서 시작했으면 0). 어느 문단에도 걸치지 않거나 웹이 아니면 null.
 * 표준 Selection·Range 만 쓰고 Paseo 화면 요소 이름에 기대지 않는다
 */
export function selectionStartIn(token: unknown, paragraphIds: readonly string[]): { index: number; offset: number } | null {
  if (!isWeb() || !token) return null;
  const range = token as RangeLike;
  for (let index = 0; index < paragraphIds.length; index++) {
    const el = document.getElementById(paragraphIds[index]);
    if (!el) continue;
    const node = el as unknown as NodeLike;
    try {
      if (!range.intersectsNode(node)) continue;
      if (!el.contains(range.startContainer)) return { index, offset: 0 };
      // 문단 처음부터 선택 시작점까지의 글 길이 = 그 문단 글 안의 글자 자리(글자 노드 안이든 요소 경계든 같이 잰다)
      const before = document.createRange();
      before.setStart(node, 0);
      before.setEnd(range.startContainer, range.startOffset);
      return { index, offset: before.toString().length };
    } catch {
      return { index, offset: 0 };
    }
  }
  return null;
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

/**
 * rowId 줄의 오른쪽 끝을 coverId 요소가 덮고 있으면 비워야 할 폭(px), 아니면 0. 10-09 폰 웹: Paseo 가 왼쪽 칸을 서랍으로 열 때
 * 닫기 단추(nativeID `sidebar-close`, 32×32·바탕색 칠함, 0.11.1 `mobileCloseButtonRow` 가 칸 위에 절대 위치)를 오른쪽 위에
 * 얹어 프로젝트 목록 머리줄의 A+ 를 가렸다. 줄 안쪽 여백은 줄 크기를 안 바꾸므로 여백을 줘도 값이 흔들리지 않는다
 */
export function overlapFromRight(rowId: string, coverId: string): number {
  if (!isWeb()) return 0;
  const row = document.getElementById(rowId);
  const cover = document.getElementById(coverId);
  if (!row || !cover) return 0;
  const r = row.getBoundingClientRect();
  const c = cover.getBoundingClientRect();
  if (!c.width || !c.height || c.bottom <= r.top || c.top >= r.bottom || c.left >= r.right || c.right <= r.left) return 0;
  return Math.ceil(r.right - c.left + 4);
}

declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: unknown): void;
  unobserve(target: unknown): void;
  disconnect(): void;
}
/**
 * 이름표(testID) 요소의 크기가 바뀌는 순간 fn 을 부른다(웹·데스크톱만). 요소가 새로 그려져 바뀌었을 수 있어 attach() 로 대상을 다시
 * 잡는다(부르는 쪽 주기 확인에서). 10-09: 사용량 칸을 올리면 프로젝트 목록이 1초 확인을 기다리느라 늦게 줄어 표가 화면 아래로
 * 밀렸다 올라왔다(리규형님 "잠깐 멈췄다가 올라와")
 */
export function watchSizeOf(testId: string, fn: () => void): { attach(): void; stop(): void } {
  if (!isWeb() || typeof ResizeObserver === "undefined") return { attach() {}, stop() {} };
  const observer = new ResizeObserver(fn);
  let target: unknown = null;
  const attach = () => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (el === target) return;
    if (target) observer.unobserve(target);
    target = el;
    if (el) observer.observe(el);
  };
  attach();
  return { attach, stop: () => observer.disconnect() };
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
declare const btoa: (text: string) => string;
declare class PopStateEvent { constructor(type: string, init?: { state: unknown }); }
declare class TextEncoder { encode(text: string): Uint8Array; }
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

// ── 좁은 화면(폰 모양) 판정 ──
// Paseo 는 폭 720px 미만을 좁은 화면으로 그린다(0.11.0-beta.5 styles/unistyles.ts breakpoints md: 720 ·
// constants/layout.ts useIsCompactFormFactor = xs·sm). 좁은 화면은 칸을 하나만 보여 주고 탭 전환도 그 칸의 탭만 보여 준다
const COMPACT_MAX_WIDTH = 720;
export function isCompactWidth(): boolean {
  return isWeb() && typeof window.innerWidth === "number" && window.innerWidth < COMPACT_MAX_WIDTH;
}
/** 좁은 화면 ↔ 넓은 화면이 바뀔 때마다 부른다(웹·데스크톱만). 끊기 함수 */
export function watchCompactWidth(onChange: (compact: boolean) => void): () => void {
  if (!isWeb()) return () => {};
  let last = isCompactWidth();
  const onResize = () => {
    const now = isCompactWidth();
    if (now === last) return;
    last = now;
    onChange(now);
  };
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}

// ── 폰(좁은 화면) 위쪽 제목(10-08 리규형님: 폰에선 위 줄 카테고리 빼고 이름만, 아래 줄은 기기 대신 카테고리) ──
// Paseo 머리줄(0.11.0-beta.5 workspace-screen.tsx WorkspaceHeaderTitleBar): 위 줄 = workspace-header-title(작업 공간 제목),
// 아래 줄 = workspace-header-subtitle(프로젝트 이름) + "·" + 기기 배지. 둘은 같은 작은 묶음(headerTitleTextGroup) 안에 있다.
// 넓은 화면은 두 줄 글이 같으면 아래 줄을 안 그리고 좁은 화면은 늘 그린다 → "아래 줄이 있고 위 줄과 글이 같다" = 좁은 화면.
// 글은 React 가 만든 글 조각의 값만 바꾼다 — 조각을 갈아 끼우면 React 가 다음에 옛 조각을 고쳐 화면에 안 나온다.
// React 가 글을 다시 쓰면 감시가 다시 바꾼다. 폰 원본 앱(웹 화면이 아님)에는 해당 없음
declare class MutationObserver {
  constructor(callback: (records: { addedNodes: ArrayLike<unknown> }[]) => void);
  observe(target: unknown, options: { childList?: boolean; subtree?: boolean; characterData?: boolean }): void;
  disconnect(): void;
}
type HeaderEl = {
  parentElement: HeaderEl | null;
  nextElementSibling: HeaderEl | null;
  textContent: string | null;
  style: { display: string };
  querySelector(selector: string): HeaderEl | null;
  querySelectorAll(selector: string): ArrayLike<HeaderEl>;
};
const HEADER_TITLE = '[data-testid="workspace-header-title"]';
const HEADER_SUBTITLE = '[data-testid="workspace-header-subtitle"]';

/** shortOf(위쪽 제목 전체) → 좁은 화면에 쓸 이름, 모르는 제목이면 null. 끊기 함수를 돌려준다 */
export function watchCompactHeader(shortOf: (full: string) => string | null): () => void {
  if (!isWeb() || typeof MutationObserver === "undefined") return () => {};
  const fullOf = new WeakMap<object, string>(); // 바꾼 글 조각 → 원래 글
  const firstText = (el: HeaderEl) => document.createTreeWalker(el as unknown as NodeLike, 4).nextNode(); // 글자 노드만
  /** 글 조각의 원래 글 — 우리가 바꾼 값 그대로면 기억한 원래 글, React 가 새로 썼으면 지금 글 */
  const original = (node: NodeLike, changed: (full: string) => string | null) => {
    const saved = fullOf.get(node);
    const now = node.nodeValue ?? "";
    return saved !== undefined && changed(saved) === now ? saved : now;
  };
  const setText = (node: NodeLike, full: string, value: string) => {
    if (node.nodeValue === value) return;
    if (value !== full) fullOf.set(node, full);
    node.nodeValue = value;
  };
  const hide = (el: HeaderEl | null) => {
    if (el && el.style.display !== "none") el.style.display = "none";
  };
  const show = (el: HeaderEl | null) => {
    if (el && el.style.display === "none") el.style.display = "";
  };
  /** "카테고리 - 이름" 의 카테고리. 카테고리가 없는 제목이면 null */
  const categoryOf = (full: string) => {
    const name = shortOf(full);
    return name && full.endsWith(` - ${name}`) ? full.slice(0, full.length - name.length - 3) : null;
  };
  let queued = false;
  const apply = () => {
    queued = false;
    const titles = document.querySelectorAll(HEADER_TITLE);
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      const tNode = firstText(title);
      if (!tNode || tNode.nodeValue === null) continue;
      const tFull = original(tNode, shortOf);
      // 같은 머리줄의 아래 줄만 — 올라가다 제목이 둘 이상 든 묶음(다른 작업 공간 화면까지 품은 곳)에 닿으면 멈춘다
      let sub: HeaderEl | null = null;
      for (let p = title.parentElement, n = 0; p && n < 3 && !sub; p = p.parentElement, n++) {
        if (p.querySelectorAll(HEADER_TITLE).length > 1) break;
        sub = p.querySelector(HEADER_SUBTITLE);
      }
      const sNode = sub ? firstText(sub) : null;
      const sFull = sNode ? original(sNode, categoryOf) : null;
      const sep = sub?.nextElementSibling && sub.nextElementSibling.textContent?.trim() === "·" ? sub.nextElementSibling : null;
      const badge = sep?.nextElementSibling ?? null;
      const name = shortOf(tFull);
      if (sub && sNode && name && sFull === tFull) {
        // 좁은 화면: 위 줄 = 이름, 아래 줄 = 카테고리(기기 배지·가운데 점은 숨김). 카테고리가 없으면 아래 줄은 기기만
        setText(tNode, tFull, name);
        const category = categoryOf(tFull);
        if (category) {
          setText(sNode, sFull, category);
          show(sub);
          hide(sep);
          hide(badge);
        } else {
          hide(sub);
          hide(sep);
          show(badge);
        }
      } else {
        // 넓어졌거나 이름표·프로젝트 이름이 바뀜 — 원래대로
        setText(tNode, tFull, tFull);
        if (sNode && sFull !== null) setText(sNode, sFull, sFull);
        show(sub);
        show(sep);
        show(badge);
      }
    }
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    void Promise.resolve().then(apply);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  apply();
  return () => observer.disconnect();
}

// ── 소리를 낼 화면 고르기(10-08 리규형님: 소리는 화면 하나에서만, 없으면 마지막으로 쓴 화면) ──
type UseEvent = { isTrusted?: boolean };
type VisibilityDoc = {
  visibilityState?: string;
  hasFocus?(): boolean;
  addEventListener(type: string, fn: (event: UseEvent) => void): void;
  removeEventListener(type: string, fn: (event: UseEvent) => void): void;
};
/** 포커스·다시 보임뿐 아니라 이미 열린 화면에서 실제 클릭·키 입력·제출도 사용이다. */
export function watchScreenUse(onUse: () => void): () => void {
  if (!isWeb()) return () => {};
  const doc = document as unknown as VisibilityDoc;
  const onVisible = () => { if (doc.visibilityState === "visible") onUse(); };
  const onInput = (event: UseEvent) => { if (event.isTrusted === true) onUse(); };
  const events = ["pointerdown", "keydown", "input", "submit"];
  window.addEventListener("focus", onUse);
  doc.addEventListener("visibilitychange", onVisible);
  for (const name of events) doc.addEventListener(name, onInput);
  if (doc.hasFocus?.()) onUse();
  return () => {
    window.removeEventListener("focus", onUse);
    doc.removeEventListener("visibilitychange", onVisible);
    for (const name of events) doc.removeEventListener(name, onInput);
  };
}

// ── 좁은 화면 알약 줄 두 줄로(10-08 리규형님 "컨트롤러를 모바일에서 개행해서 아래 두던가") ──
// Paseo 알약 줄(0.11.0-beta.5 composer/tracks.tsx ComposerTrackBar 의 track)은 줄바꿈 없는 한 줄 가로 묶음이다. 좁은 화면
// (폭 720px 미만)에서 선택 읽기 조절 단추(이전·일시정지/이어서 읽기·중지·다음·속도 — selectionRead.tsx 단추 이름)가 떠 있을 때만
// 그 묶음에 줄바꿈을 켜고 조절 단추를 둘째 줄로 보낸다. 묶음과 단추에는 우리 표식(data-csb-*)만 붙이고 모양은 스타일 한 벌로 —
// React 는 자기가 안 붙인 data 속성을 지우지 않는다. 묶음 찾기: 조절 단추에서 올라가며 "목록 쓰기" 알약까지 품은 첫 조상
const RAIL_CONTROL_LABELS = new Set(["이전 문단", "일시정지", "이어서 읽기", "읽기 중지", "다음 문단", "읽기 속도"]);
const RAIL_ANCHOR = '[aria-label="목록 쓰기"]';
// 10-08 폰 실화면: 줄바꿈만 먹고 순서 바꾸기·줄 바꿀 자리는 안 먹어 등록 순서대로 넘쳐 흘렀다(원인 미확정). 폰 브라우저가 다르게
// 다룰 수 있는 :has() 를 빼고, 조절 단추가 떠 있는 묶음에만 표식을 붙였다 뗀다(원인은 아래 감싸개 contents — 진단 로그는 10-08 저녁 뺐다)
// 스타일 이름도 판마다 새로 — 옛 판 장치가 정리되며 같은 이름의 스타일을 지워 버렸다(10-08 폰 진단 sheet:false)
const RAIL_SHEET = "claude-state-bar-composer-rail-v2";
const RAIL_CSS =
  "@media (max-width: 719px){" +
  "[data-csb-rail]{flex-wrap:wrap}" +
  "[data-csb-rail]::after{content:'';flex-basis:100%;height:0;order:9}" +
  // 알약 감싸개가 박스 없는 감싸개라 감싸개의 order 가 무시됐다(10-08 폰 진단: 계산값 10 인데 순서 그대로) — 안쪽 단추에도 건다
  "[data-csb-rail] [data-csb-ctl]{order:10}}";
type RailEl = Omit<HeaderEl, "style" | "parentElement"> & {
  parentElement: RailEl | null;
  style: { display: string; backgroundColor: string };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  contains(node: unknown): boolean;
  children?: { length: number };
};

/** 이 장치 코드를 고치면 올린다 — 플러그인을 다시 읽어도 같은 페이지에는 처음 시작한 옛 판 장치가 남아 새 코드가 안 돌았다
 *  (10-08 폰 진단). 더 높은 판이 오면 옛 판 장치를 멈추고 넘겨받는다. 판이 섞인 호스트들은 높은 판 하나를 같이 쓴다 */
const RAIL_VERSION = 6; // 5: 10-08 저녁 원인 확정 뒤 진단 로그(report)를 뺐다 · 6: 10-09 단추 줄 바탕 칠하기

// 입력창 위 단추 줄(컨텍스트·목록·접기·읽기 조절)을 대화 화면 바탕색 띠로 칠한다(10-09 리규형님 "아이콘 뒷배경이 투명이라 거슬려 — 글자가
// 안 보여야 해, 헷갈리고 잘 안 보여" · "웹도 동일한 경험으로, 폰 분기 하지 말고"). 단추는 Paseo 가 불투명하게 칠하지만(composerPillStyles
// surface1) 단추를 담은 줄(0.11.1: 절대 위치 상자)이 투명해 단추 사이·둘레로 대화 글이 비쳤다(실측: PC·폰 폭 모두 줄 rgba(0,0,0,0)).
// 줄 찾기: 늘 떠 있는 우리 단추(목록·컨텍스트)에서 올라가며 첫 절대 위치 조상. 색은 그 위로 처음 칠해진 조상의 바탕색(테마 따라감)
const TRACK_ANCHORS = '[aria-label="목록 쓰기"],[aria-label^="컨텍스트 사용량"]';
function solidBackgroundAbove(el: RailEl): string | null {
  for (let p = el.parentElement, n = 0; p && n < 30; p = p.parentElement, n++) {
    const bg = window.getComputedStyle(p).backgroundColor ?? "";
    if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return null;
}

/** 화면에 한 벌만 돈다(기기마다 올라오는 플러그인이 같이 부르면 함께 쓰고, 다 끊으면 멈춘다). 끊기 함수 */
export function startComposerRail(): () => void {
  if (!isWeb() || typeof MutationObserver === "undefined") return () => {};
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_composerRail_v2 ??= { users: 0, stop: null }) as { users: number; stop: (() => void) | null; version?: number };
  if ((hub.version ?? 0) < RAIL_VERSION) {
    hub.stop?.();
    hub.stop = null;
    hub.version = RAIL_VERSION;
  }
  hub.users += 1;
  if (!hub.stop) {
    setStyleSheet(RAIL_SHEET, RAIL_CSS);
    let queued = false;
    const apply = () => {
      queued = false;
      // 다른 장치가 지웠으면 다시 넣는다
      if (!document.getElementById(RAIL_SHEET)) setStyleSheet(RAIL_SHEET, RAIL_CSS);
      const rails = new Set<RailEl>();
      const all = document.querySelectorAll("[aria-label]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!RAIL_CONTROL_LABELS.has(el.getAttribute("aria-label") ?? "")) continue;
        // 알약 하나 = 묶음의 바로 아래 자식. 그 자식의 부모(묶음)가 "목록 쓰기" 알약을 품는 첫 곳을 찾는다
        let item: RailEl | null = el;
        for (let n = 0; item && n < 6; n++) {
          const parent = item.parentElement as RailEl | null;
          if (parent && parent.querySelector(RAIL_ANCHOR)) {
            rails.add(parent);
            if (parent.getAttribute("data-csb-rail") === null) parent.setAttribute("data-csb-rail", "");
            if (item.getAttribute("data-csb-ctl") === null) item.setAttribute("data-csb-ctl", "");
            if (el.getAttribute("data-csb-ctl") === null) el.setAttribute("data-csb-ctl", "");
            break;
          }
          item = parent;
        }
      }
      // 조절 단추가 사라진 묶음은 표식을 뗀다 — 남으면 좁은 화면에서 빈 둘째 줄(줄 간격)이 생긴다
      const marked = document.querySelectorAll("[data-csb-rail]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < marked.length; i++) if (!rails.has(marked[i])) marked[i].removeAttribute("data-csb-rail");
      // 단추 줄 띠 칠하기 — 칠한 색이 같으면 다시 쓰지 않는다(감시가 제 변경으로 다시 돌지 않게)
      const tracks = new Set<RailEl>();
      const anchors = document.querySelectorAll(TRACK_ANCHORS) as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < anchors.length; i++) {
        for (let t = anchors[i].parentElement, n = 0; t && n < 6; t = t.parentElement, n++) {
          if (window.getComputedStyle(t).position === "absolute") {
            tracks.add(t);
            break;
          }
        }
      }
      for (const t of tracks) {
        if (t.getAttribute("data-csb-track") === null) t.setAttribute("data-csb-track", "");
        const bg = solidBackgroundAbove(t);
        if (bg && t.style.backgroundColor !== bg) t.style.backgroundColor = bg;
      }
      const painted = document.querySelectorAll("[data-csb-track]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < painted.length; i++) {
        if (tracks.has(painted[i])) continue;
        painted[i].removeAttribute("data-csb-track");
        painted[i].style.backgroundColor = "";
      }
    };
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      void Promise.resolve().then(apply);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    apply();
    hub.stop = () => {
      observer.disconnect();
      setStyleSheet(RAIL_SHEET, null);
      const painted = document.querySelectorAll("[data-csb-track]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < painted.length; i++) {
        painted[i].removeAttribute("data-csb-track");
        painted[i].style.backgroundColor = "";
      }
    };
  }
  return () => {
    hub.users -= 1;
    if (hub.users <= 0 && hub.stop) {
      hub.stop();
      hub.stop = null;
      hub.users = 0;
    }
  };
}

// ── 머리줄 단추의 Paseo 도움말 숨기기(10-09 리규형님: 사용량 단추에 마우스를 올리면 뜨는 도움말 "별 필요 없어 — 없애") ──
// Paseo 는 플러그인 단추 설명(title, 꼭 넣어야 함)을 마우스를 올리면 늘 도움말 상자로 띄우고 끌 방법이 없다(0.11.1 앱 번들의
// 플러그인 단추: Tooltip 안 TooltipContent 에 title 글). 도움말 상자에는 이름표가 없어서, 마우스가 그 단추 위에 있는 동안만 화면에
// 새로 붙는 요소를 보고 글이 단추 설명으로 시작하면 그 상자를 감춘다. 단추는 접근성 이름(= title)으로 고른다.
// 감추지 못해도(Paseo 가 구조를 바꾸면) 도움말이 다시 보일 뿐 다른 고장은 없다
type TipEl = { nodeType: number; textContent: string | null; setAttribute(name: string, value: string): void };
type OverEvent = { target: { closest?(selector: string): unknown } | null };
const TIP_SHEET = "claude-state-bar-hidden-tip";
const TIP_ATTR = "data-csb-hidden-tip";
const TIP_VERSION = 1;

/** titlePrefix 로 시작하는 설명을 가진 단추의 도움말을 감춘다. 화면에 한 벌만 돈다. 끊기 함수 */
export function hideButtonTooltip(titlePrefix: string): () => void {
  if (!isWeb() || typeof MutationObserver === "undefined") return () => {};
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_hiddenTip_v1 ??= { users: 0, stop: null }) as { users: number; stop: (() => void) | null; version?: number };
  if ((hub.version ?? 0) < TIP_VERSION) {
    hub.stop?.();
    hub.stop = null;
    hub.version = TIP_VERSION;
  }
  hub.users += 1;
  if (!hub.stop) {
    const trigger = `[aria-label^="${titlePrefix}"]`;
    setStyleSheet(TIP_SHEET, `[${TIP_ATTR}]{display:none !important}`);
    let observer: MutationObserver | null = null;
    const hideTips = (records: { addedNodes: ArrayLike<unknown> }[]) => {
      for (const record of records) {
        for (let i = 0; i < record.addedNodes.length; i++) {
          const node = record.addedNodes[i] as TipEl;
          if (node.nodeType === 1 && (node.textContent ?? "").startsWith(titlePrefix)) node.setAttribute(TIP_ATTR, "");
        }
      }
    };
    // 앱(React)보다 먼저 받도록 문서 단계에서 가로챈다 — 도움말이 붙기 전에 지켜보기를 켠다
    const onOver = (e: OverEvent) => {
      const inside = !!e.target?.closest?.(trigger);
      if (inside && !observer) {
        observer = new MutationObserver(hideTips);
        observer.observe(document.body, { childList: true, subtree: true });
      } else if (!inside && observer) {
        observer.disconnect();
        observer = null;
      }
    };
    const doc = document as unknown as { addEventListener(type: string, fn: (e: OverEvent) => void, capture: boolean): void; removeEventListener(type: string, fn: (e: OverEvent) => void, capture: boolean): void };
    doc.addEventListener("pointerover", onOver, true);
    doc.addEventListener("focusin", onOver, true);
    hub.stop = () => {
      doc.removeEventListener("pointerover", onOver, true);
      doc.removeEventListener("focusin", onOver, true);
      observer?.disconnect();
      observer = null;
      setStyleSheet(TIP_SHEET, null);
    };
  }
  return () => {
    hub.users -= 1;
    if (hub.users <= 0 && hub.stop) {
      hub.stop();
      hub.stop = null;
      hub.users = 0;
    }
  };
}
