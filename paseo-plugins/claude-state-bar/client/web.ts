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
  getComputedStyle(el: unknown, pseudo?: string): { display: string; visibility?: string; flexWrap?: string; flexDirection?: string; order?: string; content?: string; flexBasis?: string; position?: string; backgroundColor?: string; paddingBottom?: string };
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
  stopImmediatePropagation?(): void;
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
 * 풀린 것은 마우스·키를 뗀 다음 차례에 "" 로 알린다 — 생각 상자의 읽기를 누르는 순간 선택이 풀려도
 * 마지막 선택 자리부터 읽을 수 있게
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

/** 화면의 글 선택을 푼다 — 생각 상자 읽기의 형광펜을 선택 색이 덮지 않게 */
export function clearSelection(): void {
  if (Platform.OS !== "web") return;
  window.getSelection()?.removeAllRanges();
}

const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;

function blockOf(node: NodeLike): NodeLike | null {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.nodeType === 1 && BLOCK_DISPLAY.test(window.getComputedStyle(n).display)) return n;
  }
  return null;
}

/**
 * 플러그인이 직접 그린 요소(nativeID = 웹에서 id)의 지금 화면 글 — 브라우저 번역기(Chrome·DeepL)가 바꿔 놓았으면 바뀐 글이다
 * (10-09 리규형님 "자동 번역기로 번역한 것을 그대로 읽어야"). 글자 자리를 selectionStartIn 과 같은 기준(textContent)으로 센다.
 * 웹이 아니거나 그 요소가 없거나(접힌 상자 등) 글이 비었으면 null
 */
export function elementText(id: string): string | null {
  if (!isWeb()) return null;
  const text = document.getElementById(id)?.textContent ?? "";
  return text.trim() ? text : null;
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

// ── 브라우저 탭 제목(10-10 리규형님: Paseo 웹 탭이 전부 "/start"라 구별이 안 됨 → 위쪽 머리줄과 같은 "카테고리 - 이름") ──
// Paseo 웹은 탭 제목을 열린 대화 제목으로 쓴다(Expo Router NavigationContainer documentTitle → document.title). 리규형님은 대화를
// 늘 /start 로 시작해서 탭이 전부 "/start"였다. 작업 공간 화면이면 그 작업 공간 제목(머리줄 위 줄과 같은 글 — 이름표가 있으면
// "카테고리 - 이름")을 쓰고, 다른 화면이면 Paseo 제목을 그대로 둔다. PC 앱(Electron)은 창 제목도 따라 바뀐다.
// Paseo 가 document.title 에 쓰는 값은 이 화면 실행 공간의 document 에 붙인 접근자로 받아 기억만 하고(읽으면 그 값을 돌려준다)
// 실제 제목은 작업 공간 제목으로 쓴다. 번역기는 다른 실행 공간에서 제목을 바꿔 접근자를 안 거친다 — 그 값은 우리 제목이 바뀔
// 때까지 그대로 둔다(되쓰기 싸움 없음). 번들의 알림 숫자 장치가 나중에 같은 자리에 접근자를 붙이면 그쪽에 양보한다(configurable).
// 0.11.1 실측(10-10): 제목 "/start" · 10초 동안 다시 쓰기 0번 · 알림 숫자 장치의 접근자 없음
type TabTitleHub = { sources: Map<object, (workspaceId: string) => string | null>; refresh: (() => void) | null; stop: (() => void) | null };
type TitleAccessor = { get(this: unknown): string; set(this: unknown, value: string): void };

function titleAccessor(): TitleAccessor | null {
  for (let p = Object.getPrototypeOf(document) as object | null; p; p = Object.getPrototypeOf(p) as object | null) {
    const d = Object.getOwnPropertyDescriptor(p, "title");
    if (d?.get && d.set) return { get: d.get, set: d.set } as TitleAccessor;
  }
  return null;
}

function startTabTitle(hub: TabTitleHub): { refresh(): void; stop(): void } {
  const accessor = titleAccessor();
  if (!accessor) return { refresh() {}, stop() {} };
  const read = () => accessor.get.call(document);
  const write = (value: string) => {
    if (read() !== value) accessor.set.call(document, value);
  };
  let paseo = read(); // Paseo 가 마지막에 쓴 제목
  let ours: string | null = null; // 지금 쓰는 작업 공간 제목(작업 공간 화면이 아니면 null)
  const want = () => {
    const here = currentWorkspaceFromUrl();
    if (!here) return null;
    for (const titleOf of hub.sources.values()) {
      const title = titleOf(here.workspaceId);
      if (title) return title;
    }
    return null;
  };
  /** 우리 제목이 바뀔 때만 쓴다 — 번역기가 바꿔 둔 제목을 같은 값으로 되돌리지 않게 */
  const refresh = () => {
    const next = want();
    if (next === ours) return;
    ours = next;
    write(ours ?? paseo);
  };
  const set = (value: unknown) => {
    paseo = String(value);
    ours = want();
    write(ours ?? paseo);
  };
  try {
    Object.defineProperty(document, "title", { configurable: true, get: () => paseo, set });
  } catch {
    return { refresh() {}, stop() {} };
  }
  const stopLocation = watchLocation(refresh);
  refresh();
  return {
    refresh,
    stop: () => {
      stopLocation();
      // 그 사이 다른 장치가 접근자를 덮었으면 그쪽을 깨지 않게 우리 것일 때만 떼고 Paseo 제목으로 돌린다
      if (Object.getOwnPropertyDescriptor(document, "title")?.set === set) {
        Reflect.deleteProperty(document as object, "title");
        write(paseo);
      }
    },
  };
}

/**
 * 이 화면 탭 제목을 지금 작업 공간 제목으로(웹·PC 앱만). titleOf(작업 공간 번호) → 제목, 모르면 null. 기기마다 올라오는
 * 플러그인이 같이 불러도 장치는 한 벌이다(다 끊으면 멈추고 Paseo 제목으로 돌린다). refresh = 작업 공간 이름이 바뀌었을 때
 */
export function watchTabTitle(titleOf: (workspaceId: string) => string | null): { refresh(): void; stop(): void } {
  if (!isWeb()) return { refresh() {}, stop() {} };
  const g = globalThis as { __claudeStateBar_tabTitle_v1?: TabTitleHub };
  const hub = (g.__claudeStateBar_tabTitle_v1 ??= { sources: new Map(), refresh: null, stop: null });
  const owner = {};
  hub.sources.set(owner, titleOf);
  if (!hub.stop) {
    const started = startTabTitle(hub);
    hub.stop = started.stop;
    hub.refresh = started.refresh;
  } else hub.refresh?.();
  return {
    refresh: () => hub.refresh?.(),
    stop: () => {
      hub.sources.delete(owner);
      if (hub.sources.size) {
        hub.refresh?.();
        return;
      }
      hub.stop?.();
      hub.stop = null;
      hub.refresh = null;
    },
  };
}

// ── 폰(좁은 화면) 위쪽 제목(10-08 리규형님: 폰에선 위 줄 카테고리 빼고 이름만, 아래 줄은 기기 대신 카테고리) ──
// Paseo 머리줄(0.11.0-beta.5 workspace-screen.tsx WorkspaceHeaderTitleBar): 위 줄 = workspace-header-title(작업 공간 제목),
// 아래 줄 = workspace-header-subtitle(프로젝트 이름) + "·" + 기기 배지. 둘은 같은 작은 묶음(headerTitleTextGroup) 안에 있다.
// 넓은 화면은 두 줄 글이 같으면 아래 줄을 안 그리고 좁은 화면은 늘 그린다 → "아래 줄이 있고 위 줄과 글이 같다" = 좁은 화면.
// 글은 React 가 만든 글 조각의 값만 바꾼다 — 조각을 갈아 끼우면 React 가 다음에 옛 조각을 고쳐 화면에 안 나온다.
// React 가 글을 다시 쓰면 감시가 다시 바꾼다. 폰 원본 앱(웹 화면이 아님)에는 해당 없음
declare class MutationObserver {
  constructor(callback: (records: { addedNodes: ArrayLike<unknown> }[]) => void);
  observe(target: unknown, options: { childList?: boolean; subtree?: boolean; characterData?: boolean; attributes?: boolean; attributeFilter?: string[] }): void;
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
/**
 * 안드로이드 Paseo 껍데기 앱(F:/workspace/phonegapProject/Paseo)이 "지금 화면이 정말 앞에 있다"고 하는가.
 * 껍데기는 뒤로 간 1초 뒤 웹이 멈추지 않게 "보이는 중" 신호를 보내 웹에 visible 이 찍힌다 — 그걸 "썼다"로 치면 폰을 뒤로
 * 보낼 때마다 폰이 소리 담당을 가져갔다(10-09 껍데기 세션 요청 · 리규형님 방향 "앱이 진짜 앞인지 알려 주고 플러그인은 진짜로
 * 다시 열었을 때만"). 껍데기 밖(일반 브라우저·옛 껍데기)이거나 부르다 실패하면 null — 지금 동작 그대로.
 * 약속(요청서 docs/requests/2026-10-09_plugin_shell_foreground.md): window.PaseoShell.isForeground() 동기 boolean
 */
function shellForeground(): boolean | null {
  try {
    const shell = (globalThis as { PaseoShell?: { isForeground?: () => unknown } }).PaseoShell;
    const value = typeof shell?.isForeground === "function" ? shell.isForeground() : null;
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** 포커스·다시 보임뿐 아니라 이미 열린 화면에서 실제 클릭·키 입력·제출도 사용이다. */
export function watchScreenUse(onUse: () => void): () => void {
  if (!isWeb()) return () => {};
  const doc = document as unknown as VisibilityDoc;
  // 포커스·다시 보임·처음 열 때 포커스는 껍데기가 "뒤에 있다"고 하면 사용으로 치지 않는다(실제 입력은 그대로)
  const onFront = () => { if (shellForeground() !== false) onUse(); };
  const onVisible = () => { if (doc.visibilityState === "visible") onFront(); };
  const onInput = (event: UseEvent) => { if (event.isTrusted === true) onUse(); };
  const events = ["pointerdown", "keydown", "input", "submit"];
  window.addEventListener("focus", onFront);
  doc.addEventListener("visibilitychange", onVisible);
  for (const name of events) doc.addEventListener(name, onInput);
  if (doc.hasFocus?.()) onFront();
  return () => {
    window.removeEventListener("focus", onFront);
    doc.removeEventListener("visibilitychange", onVisible);
    for (const name of events) doc.removeEventListener(name, onInput);
  };
}

// ── 입력창 위 단추 줄: 불투명 띠·맨 아래로 단추 띄우기·아이콘 가운데 유지 ──
const RAIL_SHEET = "claude-state-bar-composer-rail-v4";
const RAIL_CSS =
  // 단추 안 아이콘·글을 가운데로(10-09 리규형님 "아이콘이 왼쪽으로 쏠렸어" — 폰에선 글 없이 아이콘만 남아 49px 단추 왼쪽에 붙었다)
  "[data-csb-track] [role=\"button\"]{justify-content:center !important}" +
  // 아이콘만 보이는 우리 단추(목록·생각 상자 접기)는 글자 자리에 폭 없는 공백(U+200B)을 둔다(Paseo 가 빈 글자를 거절) — 그 칸과
  // 아이콘 사이 간격(8px) 때문에 아이콘이 4px 왼쪽으로 밀렸다(10-09 실측). 그 칸만 숨긴다
  "[data-csb-track] [data-csb-empty]{display:none !important}";
type RailEl = Omit<HeaderEl, "style" | "parentElement"> & {
  parentElement: RailEl | null;
  style: { display: string; backgroundColor: string; boxShadow: string; translate: string };
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  contains(node: unknown): boolean;
  children?: { length: number };
};

/** 이 장치 코드를 고치면 올린다 — 플러그인을 다시 읽어도 같은 페이지에는 처음 시작한 옛 판 장치가 남아 새 코드가 안 돌았다
 *  (10-08 폰 진단). 더 높은 판이 오면 옛 판 장치를 멈추고 넘겨받는다. 판이 섞인 호스트들은 높은 판 하나를 같이 쓴다 */
const RAIL_VERSION = 9; // 10-09 선택 읽기 조절 알약 전용 줄바꿈·가운데 표식 제거

// 입력창 위 단추 줄(컨텍스트·목록·접기)을 대화 화면 바탕색 띠로 칠한다(10-09 리규형님 "아이콘 뒷배경이 투명이라 거슬려 — 글자가
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
    const legacy = document.querySelectorAll("[data-csb-rail],[data-csb-ctl],[data-csb-ctl-first],[data-csb-ctl-last]") as unknown as ArrayLike<RailEl>;
    for (let i = 0; i < legacy.length; i++) for (const name of ["data-csb-rail", "data-csb-ctl", "data-csb-ctl-first", "data-csb-ctl-last"]) legacy[i].removeAttribute(name);
    setStyleSheet(RAIL_SHEET, RAIL_CSS);
    let queued = false;
    let live = true;
    const apply = () => {
      queued = false;
      if (!live) return;
      // 다른 장치가 지웠으면 다시 넣는다
      if (!document.getElementById(RAIL_SHEET)) setStyleSheet(RAIL_SHEET, RAIL_CSS);
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
      const extraTop = new Map<RailEl, number>();
      for (const t of tracks) {
        if (t.getAttribute("data-csb-track") === null) t.setAttribute("data-csb-track", "");
        const bg = solidBackgroundAbove(t);
        if (bg && t.style.backgroundColor !== bg) t.style.backgroundColor = bg;
        // 띠 위 여백을 아래 여백만큼 — 배치는 그대로 두고 같은 색 그림자로 띠 위쪽만 넓힌다(10-09 리규형님 "아이콘 패널 상단 패딩을
        // 하단과 동일하게, 상단으로 쏠렸어" — 실측 폰 위 0px·아래 8px). 그림자는 자리를 차지하지 않아 단추 줄이 움직이지 않는다
        // 아이콘만 단추의 폭 없는 공백 글자 칸 표식(위 스타일이 숨긴다)
        const texts = t.querySelectorAll('[role="button"] *') as unknown as ArrayLike<RailEl & { querySelector(selector: string): unknown }>;
        for (let k = 0; k < texts.length; k++) {
          const el = texts[k];
          if (el.textContent === "\u200B" && !el.querySelector("svg") && el.getAttribute("data-csb-empty") === null) el.setAttribute("data-csb-empty", "");
        }
        const extra = Math.round(parseFloat(window.getComputedStyle(t).paddingBottom ?? "0") || 0);
        extraTop.set(t, extra);
        const shadow = bg && extra > 0 ? `0 -${extra}px 0 0 ${bg}` : "";
        if (t.getAttribute("data-csb-shadow") !== shadow) {
          t.style.boxShadow = shadow;
          t.setAttribute("data-csb-shadow", shadow);
        }
      }
      // Paseo "맨 아래로" 둥근 단추가 띠에 겹치면 겹친 만큼 위로 띄운다(10-09 리규형님 "모바일에서 하단으로 내리기가 짤리네").
      // 단추와 띠는 대화 목록 전체 상자에서 갈라져 단추만 띠 위로 올릴 수 없다(대화 글까지 올라가 다시 비친다 — 실측). 위치는 transform 과
      // 따로 노는 translate 로만 옮겨 Paseo 의 나타나기 움직임과 섞이지 않게
      const scrollButtons = document.querySelectorAll('[data-testid="scroll-to-bottom-button"]') as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < scrollButtons.length; i++) {
        const b = scrollButtons[i];
        const prev = Number(b.getAttribute("data-csb-lift") ?? 0) || 0;
        const r = b.getBoundingClientRect();
        const bottom = r.bottom + prev;
        let lift = 0;
        for (const t of tracks) {
          const tr = t.getBoundingClientRect();
          if (r.right <= tr.left || r.left >= tr.right || r.top + prev >= tr.bottom) continue;
          const over = Math.ceil(bottom - (tr.top - (extraTop.get(t) ?? 0) - 4));
          if (over > lift) lift = over;
        }
        if (lift !== prev) {
          b.style.translate = lift > 0 ? `0 -${lift}px` : "";
          if (lift > 0) b.setAttribute("data-csb-lift", String(lift));
          else b.removeAttribute("data-csb-lift");
        }
      }
      const painted = document.querySelectorAll("[data-csb-track]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < painted.length; i++) {
        if (tracks.has(painted[i])) continue;
        painted[i].removeAttribute("data-csb-track");
        painted[i].removeAttribute("data-csb-shadow");
        painted[i].style.backgroundColor = "";
        painted[i].style.boxShadow = "";
      }
    };
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      void Promise.resolve().then(apply);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    apply();
    // 입력창이 여러 줄로 커지면 글 조각이 안 바뀌어도 띠가 올라간다 — 1초마다 한 번 더 맞춘다(맨 아래로 단추 위치)
    const tick = setInterval(() => {
      if (queued) return;
      queued = true;
      void Promise.resolve().then(apply);
    }, 1000);
    hub.stop = () => {
      live = false;
      observer.disconnect();
      clearInterval(tick);
      setStyleSheet(RAIL_SHEET, null);
      const empty = document.querySelectorAll("[data-csb-empty]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < empty.length; i++) empty[i].removeAttribute("data-csb-empty");
      const painted = document.querySelectorAll("[data-csb-track]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < painted.length; i++) {
        painted[i].removeAttribute("data-csb-track");
        painted[i].removeAttribute("data-csb-shadow");
        painted[i].style.backgroundColor = "";
        painted[i].style.boxShadow = "";
      }
      const lifted = document.querySelectorAll("[data-csb-lift]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < lifted.length; i++) {
        lifted[i].removeAttribute("data-csb-lift");
        lifted[i].style.translate = "";
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

// ── 대화의 턴·말 읽기(10-09) — Paseo 본문은 그대로 두고 웹 단추만 덧붙인다 ──
type SpeedKeyBinding = { active: boolean; adjust(direction: -1 | 1): void };
type SpeedKeyHub = { version: number; users: Map<object, () => SpeedKeyBinding>; stop: (() => void) | null };
const SPEED_KEYS_VERSION = 1;
/** 같은 페이지의 호스트·옛 판이 남아도 키 듣기는 하나. 가장 나중에 등록한 읽기 중 재생기 하나만 조절한다. */
export function listenTtsSpeedKeys(binding: () => SpeedKeyBinding): () => void {
  if (!isWeb()) return () => {};
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_speedKeys_v1 ??= { version: SPEED_KEYS_VERSION, users: new Map(), stop: null }) as SpeedKeyHub;
  if (hub.version < SPEED_KEYS_VERSION) { hub.stop?.(); hub.stop = null; hub.users.clear(); hub.version = SPEED_KEYS_VERSION; }
  const token = {};
  hub.users.set(token, binding);
  if (!hub.stop) {
    const onKey = (event: KeyEventLike) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || (event.key !== "<" && event.key !== ">")) return;
      const active = [...hub.users.values()].reverse().map((get) => get()).find((b) => b.active);
      if (!active) return;
      active.adjust(event.key === "<" ? -1 : 1);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    document.addEventListener("keydown", onKey, true);
    hub.stop = () => document.removeEventListener("keydown", onKey, true);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    hub.users.delete(token);
    if (!hub.users.size) { hub.stop?.(); hub.stop = null; }
  };
}

type ReadSpeedState = { rate: number; options: number[]; color: string; background: string; border: string; px: number };
function speedLabel(rate: number): string { return (rate === 1 ? "1.0" : String(rate)) + "x"; }
function fillReadSpeedSelect(select: ReadEl, options: number[], rate: number): void {
  const key = options.join(",");
  if (select.getAttribute("data-csb-rates") !== key) {
    select.setAttribute("data-csb-rates", key);
    select.innerHTML = "";
    for (const value of options) {
      const option = document.createElement("option") as unknown as ReadEl;
      option.value = String(value);
      option.textContent = speedLabel(value);
      select.appendChild(option);
    }
  }
  if (select.value !== String(rate)) select.value = String(rate);
  const label = speedLabel(rate);
  if (select.getAttribute("aria-valuetext") !== label) select.setAttribute("aria-valuetext", label);
}
/** react-native-web View의 빈 내부만 소유한다. react-dom이나 HTML JSX를 플러그인에 추가하지 않는다. */
export function mountReadSpeedSelect(node: unknown, change: (rate: number) => void): { update(state: ReadSpeedState): void; dispose(): void } {
  const noop = { update: (_state: ReadSpeedState) => {}, dispose: () => {} };
  const parent = node as { appendChild?: (el: unknown) => void } | null;
  if (!isWeb() || !parent?.appendChild) return noop;
  const select = document.createElement("select") as unknown as ReadEl;
  select.setAttribute("aria-label", "TTS 속도");
  select.setAttribute("title", "TTS 속도");
  select.setAttribute("data-csb-read-speed", "select");
  select.addEventListener("change", (event) => { event.stopPropagation(); change(Number(select.value)); });
  parent.appendChild(select);
  let styleKey = "";
  return {
    update: (state) => {
      fillReadSpeedSelect(select, state.options, state.rate);
      const key = JSON.stringify([state.color, state.background, state.border, state.px]);
      if (styleKey !== key) {
        styleKey = key;
        select.style.cssText = "width:100%;height:28px;border:1px solid " + state.border + ";border-radius:5px;padding:0 4px;color:" + state.color + ";background:" + state.background + ";font-size:" + state.px + "px;cursor:pointer";
      }
    },
    dispose: () => select.remove(),
  };
}

export type TurnReadBinding = {
  hostId: string | null;
  enabled: boolean;
  speedOptions?: number[];
  /** index: 재생기가 지금 읽는 문단 번호(형광펜 자리, 10-09) · status "loading" = 소리 만드는 중(스피커 옆 빙글빙글, 10-11) */
  playing: { target: unknown; paused: boolean; rate: number; error: string; index?: number; status?: string } | null;
  read(target: unknown, text: string): void;
  previous(): void;
  toggle(): void;
  stop(): void;
  next(): void;
  speed(value: number): void;
};
type ReadEl = NodeLike & {
  tagName: string;
  parentElement: ReadEl | null;
  nextSibling: ReadEl | null;
  previousElementSibling: ReadEl | null;
  nextElementSibling: ReadEl | null;
  firstElementChild: ReadEl | null;
  lastElementChild: ReadEl | null;
  isConnected: boolean;
  textContent: string | null;
  innerHTML: string;
  style: { cssText: string; display: string; setProperty(name: string, value: string): void; getPropertyValue(name: string): string };
  value: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): ReadEl | null;
  querySelectorAll(selector: string): ArrayLike<ReadEl>;
  appendChild(node: ReadEl): void;
  insertBefore(node: ReadEl, before: ReadEl | null): void;
  compareDocumentPosition(node: ReadEl): number;
  addEventListener(type: string, fn: (e: KeyEventLike) => void): void;
  remove(): void;
};
type ReadFiber = {
  return?: ReadFiber | null;
  alternate?: ReadFiber | null;
  memoizedProps?: Record<string, unknown>;
  stateNode?: { current?: ReadFiber };
};
// 0.11.1 모듈 4880 Qe 의 copyTurn. copyMessage(사용자 글)·코드 복사와는 다르다.
const TURN_COPY_LABELS = new Set(["نسخ بدوره", "Copy turn", "Copiar turno", "Copier l’échange", "ターンをコピー", "턴 복사", "Скопировать ответ", "复制回合"]);
const READ_MARK = "data-csb-turn-read";
// v6(10-11): 읽기 조절은 입력창 위 한 곳(startReadDock)으로 옮기고 여기는 스피커만 — 맨 오른쪽 · 읽는 중 녹색 · 소리 만드는 중 빙글빙글
const READ_SHEET = "claude-state-bar-turn-read-v6";
const TURN_READ_VERSION = 6;
/** 읽는 중 스피커·컨트롤러 재생 단추 색 — Paseo 테마의 밝은 녹색(상태 점 색) */
const READ_GREEN = "var(--colors-status-dot-success, #35c264)";
const READ_ICONS: Record<string, string> = {
  Volume2: '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.08M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  SkipBack: '<path d="m19 20-9-8 9-8v16Z"/><path d="M5 19V5"/>',
  Pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
  Play: '<path d="m6 3 14 9-14 9V3Z"/>',
  Square: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  SkipForward: '<path d="m5 4 9 8-9 8V4Z"/><path d="M19 5v14"/>',
};
function readFiber(el: ReadEl): ReadFiber | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  const fiber = (el as unknown as Record<string, unknown>)[key] as ReadFiber;
  // DOM 의 fiber 는 이전 커밋 쪽일 수도 있다. root.current 로 현재 쪽을 고른다.
  let root = fiber;
  const seen = new Set<ReadFiber>();
  while (root.return && !seen.has(root)) { seen.add(root); root = root.return; }
  return root.stateNode?.current && root.stateNode.current !== root ? fiber.alternate ?? null : fiber;
}
function readProps(el: ReadEl, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const seen = new Set<ReadFiber>();
  for (let f = readFiber(el); f && !seen.has(f); f = f.return ?? null) {
    seen.add(f);
    if (f.memoizedProps && match(f.memoizedProps)) return f.memoizedProps;
  }
  return null;
}
function messageProps(el: ReadEl): Record<string, unknown> | null {
  return readProps(el, (p) => typeof p.message === "string" && typeof p.serverId === "string");
}
function footerProps(el: ReadEl): Record<string, unknown> | null {
  return readProps(el, (p) => typeof p.getContent === "function" && ("completedAt" in p || "durationMs" in p));
}
function streamProps(el: ReadEl): Record<string, unknown> | null {
  return readProps(el, (p) => typeof p.agentId === "string" && (typeof p.serverId === "string" || typeof (p.context as { serverId?: unknown } | undefined)?.serverId === "string"));
}
function footerHost(el: ReadEl): string | null {
  const props = readProps(el, (p) => typeof p.serverId === "string" || typeof (p.context as { serverId?: unknown } | undefined)?.serverId === "string");
  return (props?.serverId ?? (props?.context as { serverId?: string } | undefined)?.serverId) as string ?? null;
}
function readNode(tag: string, kind: string): ReadEl {
  const el = document.createElement(tag) as unknown as ReadEl;
  el.setAttribute(READ_MARK, kind);
  el.setAttribute("translate", "no");
  return el;
}
function labelRead(el: ReadEl, name: string): void {
  if (el.getAttribute("aria-label") !== name) el.setAttribute("aria-label", name);
}
function readIcon(el: ReadEl, icon: string, size: string): void {
  if (el.getAttribute("data-csb-read-icon") === icon && el.querySelector("svg")?.getAttribute("width") === size) return;
  el.setAttribute("data-csb-read-icon", icon);
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${READ_ICONS[icon]}</svg>`;
}
/** 화면 문단마다 글과 그 문단 요소(형광펜 자리, 10-09). 글은 문단 안 빈 줄을 없애 재생기 splitParagraphs 와 번호가 하나씩 맞는다 */
function screenParts(root: ReadEl): { block: ReadEl | null; text: string }[] {
  const walker = document.createTreeWalker(root, 5); // 요소 + 글자: br 도 문단 안 줄바꿈으로 읽는다.
  const parts: { block: NodeLike | null; text: string }[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as ReadEl;
    if (node.nodeType !== 3 && el.tagName !== "BR") continue;
    let hidden = false;
    for (let p = node.nodeType === 3 ? el.parentElement : el; p; p = p.parentElement) {
      const style = window.getComputedStyle(p);
      if (p.getAttribute(READ_MARK) !== null || p.getAttribute("aria-hidden") === "true" || p.getAttribute("hidden") !== null ||
          p.getAttribute("role") === "button" || /^(BUTTON|SVG|SCRIPT|STYLE)$/.test(p.tagName) || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
          p.getAttribute("data-testid") === "assistant-message-capped-notice") { hidden = true; break; }
      if (p === root) break;
    }
    if (hidden) continue;
    const block = blockOf(node);
    let part = parts[parts.length - 1];
    if (!part || part.block !== block) { part = { block, text: "" }; parts.push(part); }
    part.text += node.nodeType === 3 ? node.nodeValue ?? "" : "\n";
  }
  return parts.map((p) => ({ block: p.block as ReadEl | null, text: p.text.replace(/\n[\t ]*\n\s*/g, "\n").trim() })).filter((p) => p.text);
}
/** 읽는 문단 형광펜 — 생각 상자 READING_HIGHLIGHT 와 같은 색. 브라우저 글 강조(CSS Highlight)로 칠해 Paseo 글 요소를 바꾸지 않는다
 *  (요소를 감싸거나 스타일을 바꾸면 번역기가 글을 되돌리거나 Paseo 가 다시 그리며 지운다). 글줄마다 칠해지는 것도 생각 상자와 같다 */
const READ_HIGHLIGHT = "csb-read-paragraph";
let litBlock: { block: ReadEl; text: string } | null = null;
function paintReading(block: ReadEl | null): void {
  const reg = (globalThis as { CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } } }).CSS?.highlights;
  const Make = (globalThis as { Highlight?: new (...ranges: unknown[]) => unknown }).Highlight;
  if (!reg || !Make) return;
  if (!block || !block.isConnected) {
    if (litBlock) { reg.delete(READ_HIGHLIGHT); litBlock = null; }
    return;
  }
  // 같은 문단이어도 번역기가 글을 바꿨으면 범위를 다시 잡는다(글자 노드가 바뀌면 옛 범위가 접힌다)
  const text = block.textContent ?? "";
  if (litBlock?.block === block && litBlock.text === text) return;
  const range = (document as unknown as { createRange(): { selectNodeContents(node: unknown): void } }).createRange();
  range.selectNodeContents(block);
  reg.set(READ_HIGHLIGHT, new Make(range));
  litBlock = { block, text };
}
type SpeechGroup = { first: ReadEl; last: ReadEl; messages: ReadEl[] };
/**
 * 대화 칸 식별 값(에이전트 번호 + 호스트 번호). fiber props 객체로 비교하면 안 된다 — Paseo 가 다시 그릴 때 요소마다 새 fiber·옛
 * fiber(alternate)가 섞여 같은 칸도 다른 객체로 나온다. 그래서 같은 말 여섯 블록이 프레임마다 한 묶음↔여섯 조각으로 번갈아
 * 판정돼 스피커를 지웠다 붙였다 했고 글이 떨렸다(10-09 리규형님 "졸라 떨린다", 실측 4초에 판정 60번 바뀜)
 */
function streamKey(el: ReadEl): string | null {
  const p = streamProps(el);
  if (!p) return null;
  const serverId = typeof p.serverId === "string" ? p.serverId : (p.context as { serverId?: string } | undefined)?.serverId;
  return `${p.agentId as string}|${serverId ?? ""}`;
}
/** 4873 de → We: 각 타임라인 항목은 itemId·gapBelow를 가진 자기 행이다. */
function timelineRow(el: ReadEl): { root: ReadEl; stream: string; kind: string } | null {
  const rowProps = readProps(el, (p) => typeof p.itemId === "string" && "gapBelow" in p);
  const layout = readProps(el, (p) => !!(p.layoutItem as { item?: unknown } | undefined)?.item);
  const item = (layout?.layoutItem as { item?: { id?: string; kind?: string } } | undefined)?.item;
  const stream = streamKey(el);
  if (!rowProps || !stream || typeof item?.kind !== "string" || item.id !== rowProps.itemId) return null;
  let root = el;
  // 같은 행인지도 객체가 아니라 항목 번호로 본다(위 streamKey 와 같은 까닭)
  while (root.parentElement && readProps(root.parentElement, (p) => p.itemId === rowProps.itemId && "gapBelow" in p)) root = root.parentElement;
  return { root, stream, kind: item.kind };
}
function speechRow(el: ReadEl) {
  const row = timelineRow(el);
  return row?.kind === "assistant_message" ? row : null;
}
function speechRowMessages(root: ReadEl, stream: string): ReadEl[] {
  const nodes = root.getAttribute("data-testid") === "assistant-message" ? [root] : Array.from(root.querySelectorAll('[data-testid="assistant-message"]'));
  // 다른 항목/다른 칸/모르는 감싸개를 넘어서 묶지 않는다.
  return nodes.length && nodes.every((el) => speechRow(el)?.root === root && streamKey(el) === stream) ? nodes : [];
}
/** 항목이 아닌 바깥 감싸개는 투명하게 지나가고 실제 첫/끝 타임라인 행에서 판정한다. */
function timelineEdge(root: ReadEl, direction: "previousElementSibling" | "nextElementSibling"): ReadEl | null {
  if (root.getAttribute(READ_MARK) !== null) return null;
  const row = timelineRow(root);
  if (row) return row.root;
  if (footerProps(root)) return root;
  for (let child = direction === "previousElementSibling" ? root.lastElementChild : root.firstElementChild; child; child = child[direction]) {
    const edge = timelineEdge(child, direction);
    if (edge) return edge;
  }
  // 표식/글이 있는 모르는 행은 경계로 둔다. 빈 배치용 감싸개만 건너뛴다.
  return root.getAttribute("data-testid") !== null || root.textContent?.trim() ? root : null;
}
function adjacentTimeline(row: ReadEl, direction: "previousElementSibling" | "nextElementSibling", stream: string): ReadEl | null {
  for (let edge: ReadEl | null = row; edge && streamKey(edge) === stream; edge = edge.parentElement) {
    for (let sibling = edge[direction]; sibling; sibling = sibling[direction]) {
      const found = timelineEdge(sibling, direction);
      if (found) return found;
    }
  }
  return null;
}
function adjacentSpeech(row: ReadEl, direction: "previousElementSibling" | "nextElementSibling", stream: string): ReadEl[] {
  let sibling = adjacentTimeline(row, direction, stream);
  if (!sibling) return [];
  return speechRowMessages(sibling, stream);
}
/** 같은 대화 칸에서 이어진 Claude 말 행만 한 묶음. 도구·플러그인·사용자·압축·꼬리 줄에서 끊긴다. */
function speechGroup(el: ReadEl): SpeechGroup | null {
  const row = speechRow(el);
  if (!row) return null;
  const messages = speechRowMessages(row.root, row.stream);
  if (!messages.includes(el)) return null;
  let edge = row.root;
  for (;;) {
    const previous = adjacentSpeech(edge, "previousElementSibling", row.stream);
    if (!previous.length) break;
    messages.unshift(...previous);
    edge = speechRow(previous[0])!.root;
  }
  edge = row.root;
  for (;;) {
    const next = adjacentSpeech(edge, "nextElementSibling", row.stream);
    if (!next.length) break;
    messages.push(...next);
    edge = speechRow(next[next.length - 1])!.root;
  }
  return { first: messages[0], last: messages[messages.length - 1], messages };
}
/** 꼬리 줄 바로 앞의 말만. 복사 글이나 앞쪽 말로 대체하지 않는다. */
function lastSpeech(copy: ReadEl): SpeechGroup | null {
  const stream = streamKey(copy);
  if (!stream) return null;
  const messages = copy.parentElement ? adjacentSpeech(copy.parentElement, "previousElementSibling", stream) : [];
  return messages.length ? speechGroup(messages[messages.length - 1]) : null;
}
type ReadPalette = { accent: string; border: string; muted: string; background: string };
function readPalette(el: ReadEl): ReadPalette {
  type ColorStyle = { color: string; getPropertyValue(name: string): string };
  const local = window.getComputedStyle(el) as unknown as ColorStyle;
  const root = window.getComputedStyle(document.documentElement) as unknown as ColorStyle;
  // Unistyles 128 addTheme가 만든 --colors-* (4837도 같은 변수로 스크롤바를 칠한다).
  const color = (name: string) => local.getPropertyValue(name).trim() || root.getPropertyValue(name).trim();
  const stroke = el.querySelector("svg")?.getAttribute("stroke");
  const muted = color("--colors-foreground-muted") || (stroke && stroke !== "currentColor" ? stroke : local.color) || "currentColor";
  return { muted, accent: color("--colors-accent") || muted, border: color("--colors-border") || muted, background: color("--colors-surface2") || color("--colors-surface1") || window.getComputedStyle(el).backgroundColor || "Canvas" };
}

type ReadRecord = {
  anchor: ReadEl;
  hostId: string;
  kind: "turn" | "message";
  row: ReadEl;
  button: ReadEl;
  group: ReadEl | null;
  /** 소리 만드는 중 스피커 옆 빙글빙글(10-11) */
  spin: ReadEl | null;
  look?: string;
  muted?: string;
  /** 읽기 시작 때 넘긴 문단마다의 화면 문단 요소 — 재생기 문단 번호로 형광펜을 칠한다 */
  blocks?: (ReadEl | null)[];
};
type ReadHub = { version: number; users: Map<object, (() => TurnReadBinding) & { csbVersion?: number }>; stop: (() => void) | null; refresh: (() => void) | null };
/** 한 페이지·한 장치. 호스트 번호가 맞고 읽기가 켜진 연결만 자기 데몬의 TTS 를 쓴다. */
export function startTurnReadButtons(binding: () => TurnReadBinding): { refresh(): void; dispose(): void } {
  const noop = { refresh: () => {}, dispose: () => {} };
  if (!isWeb() || typeof MutationObserver === "undefined") return noop;
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_turnRead_v1 ??= { version: TURN_READ_VERSION, users: new Map(), stop: null, refresh: null }) as ReadHub;
  if (hub.version < TURN_READ_VERSION) { hub.stop?.(); hub.stop = null; hub.refresh = null; hub.users.clear(); hub.version = TURN_READ_VERSION; }
  const token = {};
  hub.users.set(token, Object.assign(binding, { csbVersion: TURN_READ_VERSION }));
  if (!hub.stop) {
    const records = new Map<ReadEl, ReadRecord>();
    let live = true;
    let queued = false;
    const owner = (hostId: string) => [...hub.users.values()].filter((get) => get.csbVersion === TURN_READ_VERSION).map((get) => get()).find((b) => b.hostId === hostId && b.enabled);
    // 옛 판 정리가 늦었던 요소도 전용 표식으로만 걷는다.
    const orphaned = document.querySelectorAll(`[${READ_MARK}]`) as unknown as ArrayLike<ReadEl>;
    for (let i = 0; i < orphaned.length; i++) orphaned[i].remove();
    setStyleSheet(READ_SHEET,
      `[${READ_MARK}="button"]{display:flex;align-items:center;justify-content:center;background:transparent;border:0;cursor:pointer;color:inherit;font:inherit;padding:4px;border-radius:5px}` +
      `[${READ_MARK}="button"]:focus-visible{outline:2px solid currentColor;outline-offset:2px}` +
      `[${READ_MARK}="message-row"]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:100%;min-width:0}` +
      // 읽는 중이면 녹색 — 턴 단추는 복사 단추 색을 cssText 로 받으므로 !important 로 덮는다(10-11)
      `[${READ_MARK}="button"][data-csb-read-on]{color:${READ_GREEN}!important}` +
      `[${READ_MARK}="spin"]{display:inline-block;flex-shrink:0;align-self:center;width:12px;height:12px;margin:0 2px;box-sizing:border-box;border:2px solid ${READ_GREEN};border-right-color:transparent;border-radius:50%;animation:csb-read-spin .8s linear infinite}` +
      `@keyframes csb-read-spin{to{transform:rotate(360deg)}}` +
      `::highlight(${READ_HIGHLIGHT}){background-color:rgba(255, 226, 0, 0.3)}`);
    const button = (name: string, icon: string, action: () => void, size = String((readAppFontSizes().content ?? 15) - 1)) => {
      const el = readNode("button", "button");
      el.setAttribute("type", "button");
      labelRead(el, name);
      readIcon(el, icon, size);
      el.addEventListener("click", (event) => { event.stopPropagation(); try { action(); } catch { /* 구조가 바뀌면 조용히 생략한다 */ } });
      return el;
    };
    const remove = (r: ReadRecord) => {
      const b = owner(r.hostId);
      if (b?.playing?.target === r.anchor) b.stop();
      r.spin?.remove();
      r.button.remove();
      r.group?.remove();
      records.delete(r.anchor);
    };
    const start = (r: ReadRecord) => {
      const b = owner(r.hostId);
      if (!b) return;
      const group = r.kind === "turn" ? lastSpeech(r.anchor) : speechGroup(r.anchor);
      if (!group) return;
      // 덜 그려졌으면 현재 그려진 부분만 읽는다. getContent·원문으로 범위를 늘리지 않는다.
      const parts = group.messages.flatMap(screenParts);
      const text = parts.map((p) => p.text).join("\n\n").trim();
      if (!text) return;
      r.blocks = parts.map((p) => p.block);
      b.read(r.anchor, text);
    };
    const paintTurn = (r: ReadRecord) => {
      // Qe 의 계산된 여백·크기와 실제 아이콘 색을 따른다. 원래 DOM 은 움직이지 않는다.
      const style = window.getComputedStyle(r.anchor) as unknown as Record<string, string>;
      const keys = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft", "borderRadius", "alignSelf", "height", "width"];
      const color = r.anchor.querySelector("svg")?.getAttribute("stroke") ?? style.color ?? "inherit";
      const look = keys.filter((key) => style[key]).map((key) => `${key.replace(/[A-Z]/g, (s) => `-${s.toLowerCase()}`)}:${style[key]}`).join(";") + `;color:${color}`;
      if (r.look !== look) { r.look = look; r.button.style.cssText = look; }
      const size = r.anchor.querySelector("svg")?.getAttribute("width") ?? "14";
      readIcon(r.button, "Volume2", size);
    };
    const make = (anchor: ReadEl, hostId: string, kind: ReadRecord["kind"], row: ReadEl) => {
      const size = kind === "turn" ? anchor.querySelector("svg")?.getAttribute("width") ?? "14" : String((readAppFontSizes().content ?? 15) - 1);
      const r: ReadRecord = { anchor, hostId, kind, row, button: null as unknown as ReadEl, group: null, spin: null };
      r.button = button(kind === "turn" ? "턴 읽기" : "이 말 읽기", "Volume2", () => start(r), size);
      if (kind === "turn") {
        paintTurn(r);
        // 단추 줄 맨 오른쪽(작업 시간 뒤) — 10-11 리규형님. 예전엔 복사 단추 바로 뒤
        row.appendChild(r.button);
      } else {
        r.group = readNode("div", "message-row");
        r.group.appendChild(r.button);
        row.appendChild(r.group);
      }
      records.set(anchor, r);
      return r;
    };
    // 스피커 상태만 — 읽는 중 녹색, 소리 만드는 중 옆에 빙글빙글(10-11). 이전·일시정지·중지·다음·속도는 입력창 위 한 곳(startReadDock)
    const speaker = (r: ReadRecord, b: TurnReadBinding) => {
      const playing = b.playing?.target === r.anchor ? b.playing : null;
      const on = playing ? "" : null;
      if (r.button.getAttribute("data-csb-read-on") !== on) {
        if (on === null) r.button.removeAttribute("data-csb-read-on");
        else r.button.setAttribute("data-csb-read-on", on);
      }
      const name = r.kind === "turn" ? "턴 읽기" : "이 말 읽기";
      labelRead(r.button, playing?.error ? `${name} — ${playing.error}` : playing ? `${name}(읽는 중)` : name);
      const loading = !!playing && playing.status === "loading";
      if (loading && !r.spin) {
        r.spin = readNode("span", "spin");
        r.spin.setAttribute("aria-hidden", "true");
      }
      if (loading && r.spin && (r.spin.parentElement !== r.button.parentElement || r.button.nextSibling !== r.spin)) r.button.parentElement?.insertBefore(r.spin, r.button.nextSibling);
      if (!loading && r.spin) { r.spin.remove(); r.spin = null; }
    };
    const apply = () => {
      queued = false;
      if (!live) return;
      try {
        const wanted = new Set<ReadEl>();
        const lastWithFooter = new Set<ReadEl>();
        const copies = new Set(Array.from(document.querySelectorAll('[role="button"][aria-label]') as unknown as ArrayLike<ReadEl>).filter((el) => TURN_COPY_LABELS.has(el.getAttribute("aria-label") ?? "")));
        // 복사 직후 '복사됨' 이름표여도 기존 꼬리 줄 단추는 유지한다.
        for (const r of records.values()) if (r.kind === "turn" && r.anchor.isConnected) copies.add(r.anchor);
        for (const copy of copies) {
          const row = copy.parentElement;
          const hostId = footerHost(copy);
          if (!row || !hostId || !footerProps(copy) || window.getComputedStyle(row).flexDirection !== "row") continue;
          const b = owner(hostId);
          if (!b) continue;
          const last = lastSpeech(copy);
          if (last) lastWithFooter.add(last.first);
          wanted.add(copy);
          let r = records.get(copy);
          if (r && (r.hostId !== hostId || r.row !== row || !r.button.isConnected)) { remove(r); r = undefined; }
          r ??= make(copy, hostId, "turn", row);
          paintTurn(r);
          // 작업 시간 글자 등이 뒤늦게 붙으면 다시 맨 오른쪽으로(10-11)
          if (row.lastElementChild !== r.button && row.lastElementChild !== r.spin) row.appendChild(r.button);
          speaker(r, b);
        }
        const messages = document.querySelectorAll('[data-testid="assistant-message"]') as unknown as ArrayLike<ReadEl>;
        const visited = new Set<ReadEl>();
        for (let i = 0; i < messages.length; i++) {
          if (visited.has(messages[i])) continue;
          const speech = speechGroup(messages[i]);
          if (!speech) continue;
          for (const el of speech.messages) visited.add(el);
          const el = speech.first;
          const hostId = messageProps(el)?.serverId as string | undefined;
          const b = hostId ? owner(hostId) : undefined;
          if (!b) continue;
          let r = records.get(el);
          const active = b.playing?.target === el;
          if (lastWithFooter.has(el) && !active) continue;
          wanted.add(el);
          if (r && (r.hostId !== hostId || !r.group?.isConnected)) { remove(r); r = undefined; }
          r ??= make(el, hostId!, "message", speech.last);
          // 같은 말에 블록이 늘어나면,재생은 유지하고 자기 조절만 마지막으로 옮긴다.
          if (r.row !== speech.last) { r.row = speech.last; r.row.appendChild(r.group!); }
          const muted = readPalette(r.row).muted;
          if (r.muted !== muted) { r.muted = muted; r.group!.style.setProperty("color", muted); }
          const display = lastWithFooter.has(el) ? "none" : "";
          if (r.button.style.display !== display) r.button.style.display = display;
          speaker(r, b);
        }
        for (const r of records.values()) if (!wanted.has(r.anchor)) remove(r);
        // 읽는 문단 형광펜: 재생 중인 기록의 문단 번호 자리 하나만. 읽기가 끝나거나 다른 것을 읽으면 옮기거나 지운다
        let lit: ReadEl | null = null;
        for (const r of records.values()) {
          const playing = owner(r.hostId)?.playing;
          if (playing?.target === r.anchor && typeof playing.index === "number") lit = r.blocks?.[playing.index] ?? null;
        }
        paintReading(lit);
      } catch { /* 모르는 DOM·fiber 는 단추만 생략한다. Paseo 본문은 건드리지 않는다. */ }
    };
    // 대화 화면은 스트리밍 중 글자마다 바뀐다 — 바뀔 때마다 단추 붙이기(전체 찾기·fiber 오르기)를 돌리지 않고 화면을 한 번
    // 그릴 때 한 번만 돈다(Claude 10-09 검토: 처음엔 매 변경 직후 마이크로태스크였다). 화면 그리기 맞춤 함수가 없으면 예전대로
    const frame = (globalThis as { requestAnimationFrame?: (fn: () => void) => number }).requestAnimationFrame;
    const refresh = () => {
      if (!live || queued) return;
      queued = true;
      if (frame) frame(() => apply());
      else void Promise.resolve().then(apply);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "class", "style", "stroke", "width", "height"] });
    hub.refresh = refresh;
    hub.stop = () => {
      live = false;
      observer.disconnect();
      for (const r of records.values()) remove(r);
      paintReading(null);
      setStyleSheet(READ_SHEET, null);
    };
    apply();
  } else hub.refresh?.();
  let disposed = false;
  return {
    refresh: () => hub.refresh?.(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      hub.users.delete(token);
      if (hub.version === TURN_READ_VERSION && ![...hub.users.values()].some((get) => get.csbVersion === TURN_READ_VERSION)) { hub.stop?.(); hub.stop = null; hub.refresh = null; }
      else hub.refresh?.();
    },
  };
}

/**
 * 입력창 위 읽기 컨트롤러 — 화면에 하나(10-11 리규형님 "컨트롤러를 여기로 통일 · 찾아 다니는 일도 일").
 * 턴·말·생각 상자·꺼낸 말 무엇을 읽든 같은 자리: 넓은 화면은 입력창 위 알약 줄 맨 오른쪽, 좁은 화면(폰)은 그 줄 아래 새 줄.
 * 읽기는 한 번에 하나라 컨트롤러도 하나다. 칸이 나뉘어 있으면 읽기를 누른 칸의 입력창 위. 읽는 동안에만 보인다.
 * 색(리규형님 "컨트롤러에 색상"): 일시정지·이어서 = 녹색, 중지 = 빨강, 이전·다음 = 흐린 글자색, 속도 = 밝은 강조색 — 모두 Paseo 테마 변수.
 * 알약 줄 찾기는 startComposerRail 이 붙이는 data-csb-track(입력창 위 띠) 표식을 쓴다.
 */
export type ReadDockState = {
  /** 지금 읽는 것이 없으면 null — 컨트롤러가 사라진다 */
  playing: { paused: boolean; rate: number; error: string } | null;
  speedOptions: number[];
  previous(): void;
  toggle(): void;
  stop(): void;
  next(): void;
  speed(value: number): void;
};
const DOCK_MARK = "data-csb-read-dock";
const DOCK_SHEET = "claude-state-bar-read-dock-v1";
const DOCK_VERSION = 1;
type DockHub = { version: number; users: Map<object, (() => ReadDockState) & { csbVersion?: number }>; stop: (() => void) | null; refresh: (() => void) | null };
export function startReadDock(state: () => ReadDockState): { refresh(): void; dispose(): void } {
  const noop = { refresh: () => {}, dispose: () => {} };
  if (!isWeb() || typeof MutationObserver === "undefined") return noop;
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_readDock_v1 ??= { version: DOCK_VERSION, users: new Map(), stop: null, refresh: null }) as DockHub;
  if (hub.version < DOCK_VERSION) { hub.stop?.(); hub.stop = null; hub.refresh = null; hub.users.clear(); hub.version = DOCK_VERSION; }
  const token = {};
  hub.users.set(token, Object.assign(state, { csbVersion: DOCK_VERSION }));
  if (!hub.stop) {
    let live = true;
    let queued = false;
    let dock: ReadEl | null = null;
    let toggle: ReadEl | null = null;
    let select: ReadEl | null = null;
    /** 마지막으로 누른 화면 요소 — 읽기를 시작한 칸을 찾는다 */
    let pressed: ReadEl | null = null;
    /** 이번 읽기의 자리(그 칸의 입력창 위 띠). 읽기가 끝나면 비운다 */
    let home: ReadEl | null = null;
    // 호스트(PC·서버)마다 플러그인이 따로 올라와 재생기도 따로다 — 지금 읽는 쪽 하나를 고른다
    const current = () => {
      for (const get of hub.users.values()) {
        if (get.csbVersion !== DOCK_VERSION) continue;
        const s = get();
        if (s.playing) return s;
      }
      return null;
    };
    const press = (event: { target?: unknown }) => { pressed = (event.target as ReadEl | null) ?? null; };
    document.addEventListener("pointerdown", press as unknown as (e: Event) => void, true);
    const orphaned = document.querySelectorAll(`[${DOCK_MARK}]`) as unknown as ArrayLike<ReadEl>;
    for (let i = 0; i < orphaned.length; i++) orphaned[i].remove();
    setStyleSheet(DOCK_SHEET,
      `[${DOCK_MARK}="dock"]{display:flex;align-items:center;gap:2px;flex-shrink:0;height:32px;box-sizing:border-box;padding:0 4px;border:1px solid var(--colors-border, rgba(127,127,127,.4));border-radius:999px;background:var(--colors-surface1, transparent)}` +
      `[${DOCK_MARK}="dock"][data-place="row"]{margin-left:auto}` +
      `[${DOCK_MARK}="dock"][data-place="after"]{margin-left:4px}` +
      `[${DOCK_MARK}="dock"][data-place="below"]{align-self:flex-end;margin-top:4px}` +
      `[${DOCK_MARK}="button"]{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin:0;border:0;border-radius:999px;background:transparent;cursor:pointer;color:var(--colors-foreground-muted, currentColor)}` +
      `[${DOCK_MARK}="button"]:hover{background:var(--colors-surface2, rgba(127,127,127,.15))}` +
      `[${DOCK_MARK}="button"]:focus-visible{outline:2px solid currentColor;outline-offset:1px}` +
      `[${DOCK_MARK}="button"][data-tone="go"]{color:${READ_GREEN}}` +
      `[${DOCK_MARK}="button"][data-tone="stop"]{color:var(--colors-status-dot-danger, #f7796d)}` +
      `[${DOCK_MARK}="speed"]{height:24px;margin:0 0 0 2px;border:1px solid var(--colors-accent-bright, currentColor);border-radius:999px;padding:0 6px;color:var(--colors-accent-bright, currentColor);background:var(--colors-surface1, transparent);font:inherit;font-size:12px;cursor:pointer}` +
      `[${DOCK_MARK}="speed"] option{color:var(--colors-foreground, inherit);background:var(--colors-surface1, Canvas)}`);
    const node = (tag: string, kind: string) => {
      const el = document.createElement(tag) as unknown as ReadEl;
      el.setAttribute(DOCK_MARK, kind);
      el.setAttribute("translate", "no");
      return el;
    };
    const size = () => String(readAppFontSizes().content ?? 15);
    const name = (el: ReadEl, text: string) => {
      labelRead(el, text);
      if (el.getAttribute("title") !== text) el.setAttribute("title", text);
    };
    const button = (text: string, icon: string, tone: string, action: (s: ReadDockState) => void) => {
      const el = node("button", "button");
      el.setAttribute("type", "button");
      el.setAttribute("data-tone", tone);
      name(el, text);
      readIcon(el, icon, size());
      el.addEventListener("click", (event) => { event.stopPropagation(); const s = current(); if (!s) return; try { action(s); } catch { /* 구조가 바뀌면 조용히 생략한다 */ } });
      return el;
    };
    const build = () => {
      dock = node("div", "dock");
      dock.appendChild(button("이전 문단", "SkipBack", "plain", (s) => s.previous()));
      toggle = button("일시정지", "Pause", "go", (s) => s.toggle());
      dock.appendChild(toggle);
      dock.appendChild(button("읽기 중지", "Square", "stop", (s) => s.stop()));
      dock.appendChild(button("다음 문단", "SkipForward", "plain", (s) => s.next()));
      select = node("select", "speed");
      name(select, "TTS 속도");
      select.addEventListener("change", (event) => { event.stopPropagation(); const s = current(); if (s && select) s.speed(Number(select.value)); });
      dock.appendChild(select);
    };
    // 그 요소에서 위로 올라가며 처음 만나는 입력창 위 띠 — 칸이 나뉘어 있으면 그 칸의 것
    const trackNear = (from: ReadEl | null): ReadEl | null => {
      for (let el = from; el; el = el.parentElement) {
        const found = el.querySelector?.("[data-csb-track]") ?? null;
        if (found) return found;
      }
      return null;
    };
    const firstVisibleTrack = (): ReadEl | null => {
      const all = document.querySelectorAll("[data-csb-track]") as unknown as ArrayLike<ReadEl & { getBoundingClientRect(): { width: number } }>;
      for (let i = 0; i < all.length; i++) if (all[i].getBoundingClientRect().width > 0) return all[i];
      return null;
    };
    const place = (track: ReadEl) => {
      const row = track.firstElementChild;
      if (!isCompactWidth() && row) {
        // 오른쪽 끝에 이미 Paseo "변경사항" 알약이 붙어 있으면(그 알약이 남는 칸을 차지) 그 뒤에 바로 붙인다
        const where = row.querySelector('[data-testid="composer-diff-stat-pill"]') ? "after" : "row";
        if (dock!.getAttribute("data-place") !== where) dock!.setAttribute("data-place", where);
        if (dock!.parentElement !== row || row.lastElementChild !== dock) row.appendChild(dock!);
      } else {
        if (dock!.getAttribute("data-place") !== "below") dock!.setAttribute("data-place", "below");
        if (dock!.parentElement !== track || track.lastElementChild !== dock) track.appendChild(dock!);
      }
    };
    const apply = () => {
      queued = false;
      if (!live) return;
      try {
        const s = current();
        const playing = s?.playing;
        if (!s || !playing) {
          dock?.remove();
          dock = toggle = select = null;
          home = null;
          return;
        }
        if (!home || !home.isConnected) home = trackNear(pressed) ?? firstVisibleTrack();
        if (!home) return;
        if (!dock) build();
        place(home);
        name(toggle!, playing.paused ? "이어서 읽기" : "일시정지");
        readIcon(toggle!, playing.paused ? "Play" : "Pause", size());
        fillReadSpeedSelect(select!, s.speedOptions.length ? s.speedOptions : [playing.rate], playing.rate);
        labelRead(dock!, playing.error ? `읽기 조절 — ${playing.error}` : "읽기 조절");
      } catch { /* 모르는 DOM 은 컨트롤러만 생략한다 */ }
    };
    const frame = (globalThis as { requestAnimationFrame?: (fn: () => void) => number }).requestAnimationFrame;
    const refresh = () => {
      if (!live || queued) return;
      queued = true;
      if (frame) frame(() => apply());
      else void Promise.resolve().then(apply);
    };
    // 입력창 위 띠가 다시 그려지거나(칸 바꾸기·화면 폭) 알약이 늘고 줄 때 자리를 다시 잡는다
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const stopWidth = watchCompactWidth(refresh);
    hub.refresh = refresh;
    hub.stop = () => {
      live = false;
      observer.disconnect();
      stopWidth();
      document.removeEventListener("pointerdown", press as unknown as (e: Event) => void, true);
      dock?.remove();
      setStyleSheet(DOCK_SHEET, null);
    };
    apply();
  } else hub.refresh?.();
  let disposed = false;
  return {
    refresh: () => hub.refresh?.(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      hub.users.delete(token);
      if (hub.version === DOCK_VERSION && ![...hub.users.values()].some((get) => get.csbVersion === DOCK_VERSION)) { hub.stop?.(); hub.stop = null; hub.refresh = null; }
      else hub.refresh?.();
    },
  };
}

/** 화면 테마 색 변수 값(웹) — 플러그인 테마 값에 없는 색(밝은 녹색 등)을 생각 상자(react-native)에서도 같은 색으로 쓰려고(10-11) */
export function themeVar(name: string, fallback: string): string {
  if (!isWeb()) return fallback;
  try {
    const style = window.getComputedStyle(document.documentElement) as unknown as { getPropertyValue(name: string): string };
    return style.getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}
