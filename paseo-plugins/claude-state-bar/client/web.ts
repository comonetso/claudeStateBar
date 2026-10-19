import { Linking, Platform } from "react-native";
import { pageHidden } from "./pageVisible";
import type { Edit } from "./markdownList";
import type { AudioFile, ThinkingAudio } from "./thinkingPlayer";
import { shellMuted, watchShellMute } from "./shellMute";
import { createShellAudio, shellCanSpeak } from "./shellSpeech";
import { comboOfKey, shortcutMatches, type KeyLike } from "../shared/shortcuts";
import { joinSplitParens } from "./readParts";
import { followPlan } from "../shared/thinkingContract";
import { joinSharedDevice, type SharedDevice } from "./sharedDevice";

/** 키 이벤트 → 단축키 표(shared/shortcuts.ts)가 보는 모양 */
const keyLike = (e: { code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): KeyLike =>
  ({ code: e.code, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey });

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
  muted: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onpause: (() => void) | null;
  ended: boolean;
  paused: boolean;
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
  const audio = new Audio(url);
  // 폰 앱 음소거 중이면 소리 없이(10-15). 끝남 소리는 PC 가 음소거 화면을 후보에서 빼 다른 화면으로 넘기니, 이건 넘기기 직전에
  // 받은 것까지 막는 안전장치다
  audio.muted = shellMuted();
  await audio.play();
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
/** 브라우저 클립보드에 넣는다 — 못 쓰는 곳(폰 앱 등)이면 false(글자를 눌러 직접 고르게 둔다). 팀원 관리·프로젝트 메뉴가 쓴다 */
export async function copyText(text: string): Promise<boolean> {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator;
  if (!nav?.clipboard?.writeText) return false;
  try {
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type MenuNode = {
  __csbMenu?: (x: number, y: number) => void;
  addEventListener(type: string, fn: (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) => void): void;
};
/**
 * 오른쪽 클릭 메뉴(10-15 리규형님 — 프로젝트 이름 복사·바꾸기). 안드로이드 크롬은 길게 누르면 같은 contextmenu 를 낸다.
 * 브라우저 메뉴는 막는다. ref 마다 불려도 듣기는 한 번, 할 일은 마지막에 준 것
 */
export function setContextMenu(node: unknown, open: (x: number, y: number) => void): void {
  if (!isWeb() || !node) return;
  const el = node as MenuNode;
  const first = !el.__csbMenu;
  el.__csbMenu = open;
  if (!first) return;
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.__csbMenu?.(e.clientX, e.clientY);
  });
}

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
  const el = node as { getAttribute?: (name: string) => string | null; setAttribute?: (name: string, value: string) => void };
  if (el.getAttribute?.("title") !== text) el.setAttribute?.("title", text);
}

// 알약 줄 위 왼쪽 끝 작은 글씨(10-17 폰 "작업 현황" 알약의 개수 — phonePills.tsx). Paseo 는 알약 아이콘을 16px 상자에 담고 그 밖을
// 잘라(overflow hidden, 제 탭 실측) 아이콘 안에서는 밖으로 못 그린다 → 아이콘이 자기를 담은 알약 줄에 글을 적어 두고 의사 요소로 띄운다.
// 10-17 엔 알약 위 가운데였는데 오른쪽에 떠서 애매했다(10-18 리규형님 Mesa 화면 "위치가 애매함, 왼쪽정렬") → 알약 줄 기준 왼쪽 끝.
// 알약 줄은 바탕이 비쳐 대화 글이 겹쳐 보일 수 있어 글씨에 바탕색을 깐다. 어느 알약의 글씨인지 data-csb-badge-of 에 적어 두고,
// 그 알약이 줄에서 사라지면 띠 장치(startComposerRail)가 지운다
const PILL_BADGE_STYLE = "claude-state-bar-pill-badge-v2";
const PILL_BADGE_CSS = "[data-csb-badge]{position:relative;overflow:visible}"
  + "[data-csb-badge]::before{content:attr(data-csb-badge);position:absolute;bottom:calc(100% + 3px);left:0;"
  + "font-size:10px;line-height:13px;white-space:nowrap;padding:0 3px;border-radius:3px;pointer-events:none;"
  + "color:var(--csb-badge-color,#999);background:var(--csb-badge-bg,transparent)}";
type BadgeEl = {
  closest?(selector: string): BadgeEl | null; parentElement: BadgeEl | null;
  setAttribute(n: string, v: string): void; removeAttribute(n: string): void; style: { setProperty(n: string, v: string): void };
};
// 알약 이름 → 글씨를 단 알약 줄. 알약이 먼저 빠지면(대화 바꾸기) node 로는 줄을 못 찾아 여기서 지운다
const badgeRows = new Map<string, BadgeEl>();
// 알약 줄 = 알약(감싸개는 display:contents)을 담은, 부모가 절대 위치 띠인 요소(10-18 폰 폭 실측 — 띠 > 줄 > 감싸개 > 알약)
function pillRowOf(pill: BadgeEl): BadgeEl | null {
  for (let el = pill.parentElement, n = 0; el && el.parentElement && n < 6; el = el.parentElement, n++) {
    if (window.getComputedStyle(el.parentElement as never).position === "absolute") return el;
  }
  return null;
}
/** node(알약 안의 요소)를 담은 알약(aria-label = pillLabel)이 있는 알약 줄 위 왼쪽 끝에 글씨를 단다. text 가 null 이면 뗀다 */
export function setPillBadge(node: unknown, pillLabel: string, text: string | null, color: string, background: string): void {
  if (!isWeb()) return;
  const pill = node ? (node as BadgeEl).closest?.(`[aria-label="${pillLabel}"]`) ?? null : null;
  const row = pill ? pillRowOf(pill) : null;
  const old = badgeRows.get(pillLabel);
  if (old && old !== row) { old.removeAttribute("data-csb-badge"); old.removeAttribute("data-csb-badge-of"); badgeRows.delete(pillLabel); }
  if (!row) return;
  if (!document.getElementById(PILL_BADGE_STYLE)) setStyleSheet(PILL_BADGE_STYLE, PILL_BADGE_CSS);
  if (text === null) { row.removeAttribute("data-csb-badge"); row.removeAttribute("data-csb-badge-of"); badgeRows.delete(pillLabel); return; }
  row.setAttribute("data-csb-badge", text);
  row.setAttribute("data-csb-badge-of", pillLabel);
  row.style.setProperty("--csb-badge-color", color);
  row.style.setProperty("--csb-badge-bg", background);
  badgeRows.set(pillLabel, row);
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
    if (old.textContent !== css) old.textContent = css;
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
 * 설정 화면 단축키 칸의 "바꾸기"(10-16) — 다음에 누른 키 하나를 받아 조합 글로 준다. 조합 키만 누르면 계속 기다리고,
 * 다른 키 없이 Esc 면 취소(null). 창(window)에서 먼저 받아 막아서, 지금 단축키(F·W·B 등)나 Paseo 단축키가 같이 돌지 않는다
 */
export function captureShortcutKey(done: (combo: string | null) => void): () => void {
  if (!isWeb() || typeof window === "undefined") return () => {};
  const w = window as unknown as { addEventListener(t: string, fn: (e: KeyEventLike) => void, capture: boolean): void; removeEventListener(t: string, fn: (e: KeyEventLike) => void, capture: boolean): void };
  const onKey = (e: KeyEventLike) => {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    const k = keyLike(e);
    if (e.code === "Escape" && !k.ctrl && !k.alt && !k.shift && !k.meta) return finish(null);
    const combo = comboOfKey(k);
    if (combo) finish(combo);
  };
  const finish = (combo: string | null) => {
    w.removeEventListener("keydown", onKey, true);
    done(combo);
  };
  w.addEventListener("keydown", onKey, true);
  return () => w.removeEventListener("keydown", onKey, true);
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
  subscribe?(listener: (state: MemoryState) => void): () => void;
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
// hostRuntime(10-17, getHostRuntimeStore — 사용량 "기억 건너뛰고 새로 받기")은 확인한 판에만 있다
export type PaseoModuleIds = { layout: number; schema: number; navigate: number; sidebarOrder: number; queryClient: number; hostRuntime?: number };
export const PASEO_BUNDLES: Record<string, { version: string; ids: PaseoModuleIds }> = {
  // PC 앱 0.11.0-beta.5 (= 10-07 에 올린 웹)
  f07439c15f40c0ca1689fb49e3dcc6c8: { version: "0.11.0-beta.5", ids: { layout: 3801, schema: 3802, navigate: 3898, sidebarOrder: 4025, queryClient: 848 } },
  // PC 앱 0.11.1 (10-08 업데이트) — 위 판과 모듈 본문이 같고 번호만 2씩 밀렸다(tmp/paseo_0111_probe/probe.cjs)
  // hostRuntime 3761 은 두 판 모두 사용량 부품(4398)이 불러오는 연결 보관소(getHostRuntimeStore 내보냄 — 10-17 확인)
  "3a92a6be2c6767623cc9fa2aa410618e": { version: "0.11.1", ids: { layout: 3803, schema: 3804, navigate: 3900, sidebarOrder: 4027, queryClient: 850, hostRuntime: 3761 } },
  // PC 앱 0.11.4 (10-17 아침 앱 재시작 때 자동 설치) — 번호·본문 모두 0.11.1 과 같다(update-check/check-bundle.cjs, 결과 tests-261017/check_bundle_0114.json)
  "8bce0495199b6764c1ef3c14273ac681": { version: "0.11.4", ids: { layout: 3803, schema: 3804, navigate: 3900, sidebarOrder: 4027, queryClient: 850, hostRuntime: 3761 } },
};

/** 이 화면 번들에서 확인한 모듈 번호. 모르는 판이거나 웹이 아니면 null */
export function paseoModuleIds(): PaseoModuleIds | null {
  const id = appBundleId();
  return id ? PASEO_BUNDLES[id]?.ids ?? null : null;
}

function paseoModule(which: keyof PaseoModuleIds): MemoryState | null {
  const ids = paseoModuleIds();
  const id = ids?.[which];
  if (typeof id !== "number") return null;
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return null;
  try {
    const value = require(id);
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

type UsageReportsClient = { listUsageReports?(options: { forceRefresh: boolean }): Promise<{ reports?: Array<{ report?: { status?: string } }> }> };
/**
 * 사용량 "기억 건너뛰고 새로 받기" — 사용량 칸의 "지금 갱신" 아이콘이 부른다(10-17 리규형님 "Paseo 하던 대로 두고, 내가 원할 때
 * 즉시 갱신"). Paseo 사용량 화면 새로고침과 같은 요청(usage.list_reports.request forceRefresh)이라 데몬이 바깥 조회 5분 기억
 * (UsageSourceRegistry ttlMs)을 건너뛴다. 🔴 자동으로 자주 부르지 마라 — 30초마다 강제하자 Anthropic 이 막았다(10-17 09:26 429).
 * true = 받음 · false = 요청 실패나 오류 항목(status "error") · null = 이 판에선 못 함(번호 모름·연결 없음 — 예전처럼 데몬 기억값)
 * 진행 중에 또 부르면 같은 요청을 같이 기다린다(화면 하나에 한 번)
 */
function usageForces(): Map<string, Promise<boolean | null>> {
  const g = globalThis as { __claudeStateBar_usageForce_v2?: Map<string, Promise<boolean | null>> };
  return (g.__claudeStateBar_usageForce_v2 ??= new Map());
}
export function forceUsageRefresh(serverId: string): Promise<boolean | null> {
  const forces = usageForces();
  const pending = forces.get(serverId);
  if (pending) return pending;
  const running = runUsageForce(serverId).finally(() => forces.delete(serverId));
  forces.set(serverId, running);
  return running;
}
/** 그 데몬에 사용량 보고를 물을 연결(hostRuntime 연결 보관소). 못 찾으면 이유 — probeModule 이유 · "no-export"(보관소 함수 없음) ·
 *  "no-client"(그 데몬 연결이 없거나 listUsageReports 가 없음). 웹이 아니거나 모르는 판이면 예전(paseoModule)처럼 못 찾음이다 */
function usageClient(serverId: string): (UsageReportsClient & { listUsageReports: NonNullable<UsageReportsClient["listUsageReports"]> }) | InternalsReason | "no-client" {
  const mod = probeModule("hostRuntime");
  if (typeof mod === "string") return mod;
  const getStore = mod.getHostRuntimeStore as (() => { getClient?(id: string): unknown }) | undefined;
  if (typeof getStore !== "function") return "no-export";
  let client: UsageReportsClient | null = null;
  try {
    client = (getStore().getClient?.(serverId) ?? null) as UsageReportsClient | null;
  } catch {
    return "no-client";
  }
  if (!client || typeof client.listUsageReports !== "function") return "no-client";
  return client as UsageReportsClient & { listUsageReports: NonNullable<UsageReportsClient["listUsageReports"]> };
}
async function runUsageForce(serverId: string): Promise<boolean | null> {
  const client = usageClient(serverId);
  if (typeof client === "string") return null;
  try {
    const { reports } = await client.listUsageReports({ forceRefresh: true });
    return !(reports ?? []).some((r) => r.report?.status === "error");
  } catch {
    return false;
  }
}

/**
 * 그 데몬의 사용량 원본 보고(10-18 C2 — 같은 계정 카드 거르기, client/usageFooter readUsage). 보고 번호에 계정 열쇠가 들어 있어
 * 옛 목록(providers.listUsage)으로는 못 하는 판정을 한다. 🔴 forceRefresh 는 false — 데몬 5분 기억값을 읽을 뿐 바깥 조회를 늘리지 않는다
 * (자동 강제 금지 — 위 forceUsageRefresh 주석, 10-17 09:26 429). 받은 값은 손대지 않고 돌려준다(모양 검사는 shared/usageIdentity).
 * 못 물으면 이유를 글로 담은 Error 를 던진다(usageFooter 가 잡아 옛 목록으로 돌아가고, 기능 상태 칸이 그 이유를 보인다)
 */
export async function listUsageReportsRaw(serverId: string): Promise<unknown> {
  const client = usageClient(serverId);
  if (typeof client === "string") throw new Error(client);
  return client.listUsageReports({ forceRefresh: false });
}

// ── 업데이트 대비 상태 표시(10-08 리규형님 결정 — Codex 261008_150613 작업 1~3) ──
// 위 연결은 실패하면 null/false 만 돌려줘 왜 꺼졌는지가 사라진다(0.11.1 업데이트 때 "어떤 게 안 되는지조차 모름").
// 같은 연결을 읽기만 해서 막힌 이유를 돌려준다. 값을 쓰거나 화면 배치를 바꾸지 않는다(client/health.ts 가 기능별로 판정).
export type InternalsReason = "not-web" | "unknown-bundle" | "no-require" | "load-failed" | "no-export" | "shape-mismatch" | "not-hydrated";
export type PaseoInternals = { layout: InternalsReason | null; schema: InternalsReason | null; navigate: InternalsReason | null; sidebarOrder: InternalsReason | null };

function probeModule(which: keyof PaseoModuleIds): MemoryState | InternalsReason {
  if (!isWeb()) return "not-web";
  const id = paseoModuleIds()?.[which];
  if (typeof id !== "number") return "unknown-bundle";
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (typeof require !== "function") return "no-require";
  try {
    const value = require(id);
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
/** 배치가 바뀔 때마다 부른다(작업 현황 단추 초록, 10-14). 이 판의 저장소를 못 찾으면 아무것도 안 한다 */
export function watchPaseoLayout(listener: () => void): () => void {
  const store = paseoMemoryStore("layout", "useWorkspaceLayoutStore", "workspace-layout-state");
  return typeof store?.subscribe === "function" ? store.subscribe(() => listener()) : () => {};
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

/** 첫 연결부터 Paseo 자체 조작도 기록한다. PC가 늦게 붙어도 자동 배치가 쓰던 화면을 덮지 않게 한다. */
export function watchWorkspaceInput(): () => void {
  const g = globalThis as { __claudeStateBar_workspaceInput_v1?: { users: Set<object>; stop: (() => void) | null } };
  const hub = (g.__claudeStateBar_workspaceInput_v1 ??= { users: new Set(), stop: null });
  const token = {};
  hub.users.add(token);
  hub.stop ??= onUserInput(markWorkspaceInteraction);
  return () => {
    hub.users.delete(token);
    if (!hub.users.size) { hub.stop?.(); hub.stop = null; }
  };
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
/** Paseo 시작 화면(열린 작업 공간이 없을 때의 "프로젝트 추가·세션 가져오기")인가 — 웹만 */
export function atStartScreen(): boolean {
  if (typeof location === "undefined") return false;
  return location.pathname === "/" || location.pathname === "/open-project";
}

/**
 * 로그인 서버(web-gate)를 거쳐 직원 계정으로 열린 화면인가 — 로그인 서버가 화면 맨 앞에 끼우는 guard.js 의 표식(paseoGate).
 * 직원 화면에는 관리자 계정 칸·기기 사이 설정 맞추기(기준 화면이 리규형님 PC)가 맞지 않는다(10-11)
 */
export function isGateMember(): boolean {
  const g = (globalThis as { paseoGate?: { canManageAccount?: unknown } }).paseoGate;
  return !!g && g.canManageAccount === false;
}

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
    // 입력창 목록 키는 고정이다(10-16 리규형님 "채팅 입력창에서 하는 건 설정 안 해도 됨") — 다른 단축키로는 못 쓰게 막아 둔다(shared/shortcuts.ts RESERVED)
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

/**
 * 생각 읽기·따라 읽기·목소리 미리 듣기 소리. 폰 앱이 소리를 틀 수 있으면 앱에 넘기고(client/shellSpeech.ts — 10-16 22시 리규형님
 * "앱이 소리를 직접 튼다"), 아니면(PC·브라우저) 웹 Audio 하나로 튼다. 틀 때마다 고르고, 나머지 조작은 마지막으로 튼 쪽에 보낸다.
 * 🔴 재생이 둘로 갈린다 — 빠르기·일시정지·음소거·끝남을 고치면 아래 웹 판과 shellSpeech.ts 를 다 고친다. 다른 알림 소리 함수는 기존 동작 그대로.
 */
export function createThinkingAudio(): ThinkingAudio {
  const web = createWebThinkingAudio();
  const app = createShellAudio();
  let use: ThinkingAudio = web;
  return {
    play(file, rate, ended, error, interrupted) {
      const next = shellCanSpeak() ? app : web;
      if (next !== use) use.stop();
      use = next;
      return use.play(file, rate, ended, error, interrupted);
    },
    pause() { use.pause(); },
    resume() { return use.resume(); },
    stop() { use.stop(); },
    setRate(rate) { use.setRate(rate); },
  };
}

/** 웹 Audio 하나로 트는 판(PC·브라우저, 앱 함수가 없는 옛 폰 앱) */
function createWebThinkingAudio(): ThinkingAudio {
  let audio: Audio | undefined;
  let url: string | undefined;
  let generation = 0;
  // 우리가 멈춘 것인가 — 아니면 바깥(폰에서 다른 앱이 소리를 가져감 등)이 멈춘 것이다(10-16 리규형님 "플레이 표시는 되지만 읽지는 않네")
  let selfPause = false;
  const pauseOwn = () => { if (audio && !audio.paused) { selfPause = true; audio.pause(); } };
  // 폰 앱 음소거 중엔 소리만 끈다 — 읽기(형광펜·진행)는 그대로 가고, 풀면 그 자리부터 들린다(10-15)
  let stopMute: (() => void) | undefined;
  const releaseMute = () => { stopMute?.(); stopMute = undefined; };
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
    async play(file, rate, ended, error, interrupted) {
      if (Platform.OS !== "web") throw new Error("이 앱에서는 소리 읽기를 지원하지 않습니다");
      const token = ++generation;
      audio ??= new Audio();
      pauseOwn();
      audio.onended = null;
      audio.onerror = null;
      audio.onpause = null;
      release();
      load(file);
      audio.playbackRate = rate;
      audio.preservesPitch = true;
      audio.muted = shellMuted();
      stopMute ??= watchShellMute(() => { if (audio) audio.muted = shellMuted(); });
      audio.onended = () => { if (generation === token) { releaseMute(); ended(); } };
      audio.onerror = () => { if (generation === token) { releaseMute(); error(audio?.error?.message || `오디오 오류 ${audio?.error?.code ?? ""}`); } };
      // 끝까지 들려 멈춘 것(ended)·우리가 멈춘 것은 빼고, 바깥이 멈춘 것만 알린다 — 재생기는 일시정지로 바꿔 컨트롤러가 재생 단추를 보인다
      audio.onpause = () => {
        if (selfPause) { selfPause = false; return; }
        if (generation === token && audio && !audio.ended) interrupted?.();
      };
      selfPause = false;
      try { await audio.play(); } catch (error) { if (generation === token) releaseMute(); throw error; }
    },
    pause() { if (Platform.OS === "web") pauseOwn(); },
    async resume() {
      if (Platform.OS !== "web") return;
      selfPause = false;
      await audio?.play();
    },
    stop() {
      if (Platform.OS !== "web") return;
      generation += 1;
      releaseMute();
      if (audio) {
        pauseOwn();
        audio.onended = null;
        audio.onerror = null;
        audio.onpause = null;
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
// Paseo PluginHeaderButtons: compact || width < 1100 이면 단추 하나만 보인다.
// 폰 가로·PC 반쪽 창도 같은 알약·두 줄·읽기 조절 배치를 쓴다(10-19 결정).
const COMPACT_MAX_WIDTH = 1100;
export function isCompactWidth(): boolean {
  return isWeb() && typeof window.innerWidth === "number" && window.innerWidth < COMPACT_MAX_WIDTH;
}
/** 폰 알약(사용량·작업 현황, phonePills.tsx)을 붙이는 화면인가 — 웹은 좁은 화면, 웹이 아니면 늘. 머리줄 단추(activityButton.tsx)는
 *  이것이 거짓일 때만 붙인다(10-18 리규형님 "상단 세로 쩜쩜쩜 제거" — 좁은 화면에서 머리줄 단추가 세로 점 메뉴로 접혀 있었다) */
export function phonePillsShown(): boolean {
  return isWeb() ? isCompactWidth() : true;
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
  // 크기 알림이 생략되는 웹뷰·폭 흉내에서도 두 줄 배치와 알약 등록이 함께 바뀌게 한다.
  const timer = setInterval(onResize, 1000);
  return () => { clearInterval(timer); window.removeEventListener("resize", onResize); };
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
type MutationLike = { type: string; target: unknown; attributeName?: string | null; addedNodes: ArrayLike<unknown> };
declare class MutationObserver {
  constructor(callback: (records: MutationLike[]) => void);
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
  let live = true;
  const fullOf = new Map<NodeLike, { full: string; written: string }>();
  const displays = new Map<HeaderEl, { before: string; written: string }>();
  const firstText = (el: HeaderEl) => document.createTreeWalker(el as unknown as NodeLike, 4).nextNode(); // 글자 노드만
  /** 글 조각의 원래 글 — 우리가 바꾼 값 그대로면 기억한 원래 글, React 가 새로 썼으면 지금 글 */
  const original = (node: NodeLike) => {
    const saved = fullOf.get(node);
    const now = node.nodeValue ?? "";
    return saved !== undefined && saved.written === now ? saved.full : now;
  };
  const setText = (node: NodeLike, full: string, value: string) => {
    if (node.nodeValue === value) return;
    if (value !== full) fullOf.set(node, { full, written: value });
    else fullOf.delete(node);
    node.nodeValue = value;
  };
  const hide = (el: HeaderEl | null) => {
    if (el && el.style.display !== "none") {
      displays.set(el, { before: el.style.display, written: "none" });
      el.style.display = "none";
    }
  };
  const show = (el: HeaderEl | null) => {
    if (!el) return;
    const saved = displays.get(el);
    if (saved && el.style.display === saved.written) el.style.display = saved.before;
    displays.delete(el);
  };
  /** "카테고리 - 이름" 의 카테고리. 카테고리가 없는 제목이면 null */
  const categoryOf = (full: string) => {
    const name = shortOf(full);
    return name && full.endsWith(` - ${name}`) ? full.slice(0, full.length - name.length - 3) : null;
  };
  let queued = false;
  const apply = () => {
    queued = false;
    if (!live) return;
    // 복원용 Map이 지나간 작업 공간의 DOM을 계속 붙잡지 않게 한다.
    for (const node of fullOf.keys()) if ((node as NodeLike & { isConnected?: boolean }).isConnected === false) fullOf.delete(node);
    for (const el of displays.keys()) if ((el as HeaderEl & { isConnected?: boolean }).isConnected === false) displays.delete(el);
    const titles = document.querySelectorAll(HEADER_TITLE);
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      const tNode = firstText(title);
      if (!tNode || tNode.nodeValue === null) continue;
      const tFull = original(tNode);
      // 같은 머리줄의 아래 줄만 — 올라가다 제목이 둘 이상 든 묶음(다른 작업 공간 화면까지 품은 곳)에 닿으면 멈춘다
      let sub: HeaderEl | null = null;
      for (let p = title.parentElement, n = 0; p && n < 3 && !sub; p = p.parentElement, n++) {
        if (p.querySelectorAll(HEADER_TITLE).length > 1) break;
        sub = p.querySelector(HEADER_SUBTITLE);
      }
      const sNode = sub ? firstText(sub) : null;
      const sFull = sNode ? original(sNode) : null;
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
  return () => {
    if (!live) return;
    live = false;
    observer.disconnect();
    for (const [node, saved] of fullOf) if (node.nodeValue === saved.written) node.nodeValue = saved.full;
    for (const [el, saved] of displays) if (el.style.display === saved.written) el.style.display = saved.before;
    fullOf.clear();
    displays.clear();
  };
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
const RAIL_SHEET = "claude-state-bar-composer-rail-v11";
const RAIL_CSS =
  // 단추 안 아이콘·글을 가운데로(10-09 리규형님 "아이콘이 왼쪽으로 쏠렸어" — 폰에선 글 없이 아이콘만 남아 49px 단추 왼쪽에 붙었다)
  "[data-csb-track] [role=\"button\"]{justify-content:center !important}" +
  // 아이콘만 보이는 우리 단추(목록·생각 상자 접기)는 글자 자리에 폭 없는 공백(U+200B)을 둔다(Paseo 가 빈 글자를 거절) — 그 칸과
  // 아이콘 사이 간격(8px) 때문에 아이콘이 4px 왼쪽으로 밀렸다(10-09 실측). 그 칸만 숨긴다
  "[data-csb-track] [data-csb-empty]{display:none !important}" +
  // 좁은 화면 두 줄(10-18 리규형님 — 알약 8개라 컨텍스트 알약이 "3.." 으로 잘렸다): 컨텍스트 사용률·작업 현황·사용량 세 알약만
  // 줄바꿈해 아랫줄로 보낸다. Paseo 가 그린 알약은 옮기지 않고 순서·줄바꿈만 준다(감싸개가 display:contents 라 알약 단추가 줄의
  // 칸이다 — 폰 폭 실측). 높이 0 의 한 줄짜리 의사 요소가 줄을 끊는다. 읽기 조절기는 그 줄 맨 뒤 남는 공간 가운데에 작게(DOCK row2)
  "[data-csb-track][data-csb-rows] > :first-child{flex-wrap:wrap !important;row-gap:6px}" +
  "[data-csb-track][data-csb-rows] > :first-child::after{content:\"\";flex-basis:100%;order:50;height:0}" +
  "[data-csb-track][data-csb-rows] [aria-label^=\"컨텍스트 사용량\"]{order:51}" +
  "[data-csb-track][data-csb-rows] [aria-label=\"작업 현황\"]{order:52}" +
  "[data-csb-track][data-csb-rows] [aria-label=\"사용량\"]{order:53}" +
  // 두 줄일 때 윗줄은 왼쪽부터 붙이고 맨 오른쪽에 설정 알약(10-18 리규형님). 생각 상자 펼치기 알약의 오른쪽 밀기(thinkingFoldPill.ts
  // margin-left:auto — 10-08 "채팅창 위 오른쪽")는 넓은 화면에서만 산다. 설정 알약 오른쪽 24px 은 폰 앱이 화면 오른쪽 끝에 띄우는
  // 단추(새로고침·소리·전원)와 겹치지 않게(10-18 리규형님 "왼쪽으로 쪼금" — 캡처에서 그 단추 왼쪽 끝이 화면 끝에서 약 32px)
  "[data-csb-track][data-csb-rows] [aria-label^=\"생각 상자 모두\"]{margin-left:0 !important}" +
  "[data-csb-track][data-csb-rows] [aria-label=\"Claude State Bar 설정\"]{order:49;margin-left:auto;margin-right:24px}" +
  // 좁은 화면 알약 안쪽 좌우 여백 12px → 8px(10-18 리규형님 "약간씩만 줄여 첫째 줄에 알약 두 개 더") — 아이콘 알약 41 → 33px.
  // 읽기 조절기 단추는 제 크기 규칙(DOCK row2)이 있어 뺀다
  "[data-csb-track][data-csb-rows] > :first-child :is([role=button],button):not([data-csb-read-dock]){padding-left:8px !important;padding-right:8px !important}" +
  // 넓은 화면: 설정 알약은 공급자 알약(⇆) 다음, Paseo 변경사항 단추 앞(10-18 리규형님 "설정을 알약들 맨 오른쪽에"). 등록 순서로는
  // 설정이 ⇆ 앞에 놓였다(제 탭 1400 실측) → 순번으로 못박는다. 변경사항 단추는 알약 줄 직속 button(플러그인 알약은 감싸개 안)이라
  // 이름 대신 구조로 골라 Paseo 언어와 상관없다. 생각 상자 펼치기 알약(order 0, margin-left:auto)은 그대로 오른쪽 묶음의 시작
  "[data-csb-track]:not([data-csb-rows]) > :first-child [aria-label^=\"Claude 공급자\"]{order:1}" +
  "[data-csb-track]:not([data-csb-rows]) > :first-child [aria-label=\"Claude State Bar 설정\"]{order:2}" +
  "[data-csb-track]:not([data-csb-rows]) > :first-child > button{order:3}";
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
const RAIL_VERSION = 16; // 10: 10-18 좁은 화면 두 줄·목록 끝 여백·개수 글씨 정리 · 11: 윗줄 왼쪽 정렬·설정 알약 맨 오른쪽(10-18 저녁) · 12: 설정 알약 오른쪽 24px(폰 앱 떠 있는 단추) · 13: 넓은 화면 설정 알약 ⇆ 다음 · 14: 좁은 화면 알약 안쪽 여백 8px

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

// 좁은 화면 두 줄로 띠가 커진 만큼 대화 목록 끝 여백을 더한다(10-18 폰 폭 실측: 띠는 아래가 고정된 절대 위치라 위로 44px 커지고,
// Paseo 는 목록 끝 여백을 띠 높이에 맞추지 않아 맨 아래 줄이 띠에 가려졌다). 목록 상자 자체에 여백을 주면 상자만 화면 밖으로 커져
// 효과가 없었고, 안쪽 내용 상자(첫 자식) 아래 여백이 먹었다.
// 대상은 Paseo 웹 대화 목록 표식 [data-testid="agent-chat-scroll"](설치 번들 0.11.4 모듈 4948)만 쓴다 — "가장 큰 스크롤 상자"로 고르면
// 키보드·가로 화면에서 펼친 생각 상자를 골랐다(10-18 Codex 261018_164051 F3). 같은 칸에서 보이는 것이 하나로 정해지지 않으면 손대지 않는다.
// 띠마다 고친 내용 상자와 원래 값을 기억하고(padOwners), 띠가 사라짐·대화 전환(내용 상자가 바뀜)·폭 전환·장치 멈춤 모두 같은 복원을 쓴다.
// 복원은 지금 값이 우리가 쓴 값일 때만 — Paseo 가 그 사이 다시 그렸으면 덮어쓰지 않는다
const CHAT_LIST_SELECTOR = '[data-testid="agent-chat-scroll"]';
type Rect = { top: number; bottom: number; left: number; right: number; width: number };
type ListContent = { isConnected: boolean; style: { paddingBottom: string; setProperty(n: string, v: string): void; removeProperty(n: string): void } };
type ListEl = {
  scrollTop: number; scrollHeight: number; clientHeight: number; parentElement: ListEl | null; firstElementChild: ListContent | null;
  getBoundingClientRect(): Rect; querySelectorAll(selector: string): ArrayLike<ListEl>;
};
type RowEl = { getBoundingClientRect(): Rect; getAttribute(n: string): string | null; querySelector(selector: string): RowEl | null };
type PadOwner = { list: ListEl; content: ListContent; base: number; inline: string; written: string };
const padOwners = new Map<RailEl, PadOwner>();
/** 띠와 같은 칸의 대화 목록 — 띠에서 위로 올라가며 처음 목록 표식이 나오는 조상에서, 보이고 띠와 가로로 겹치는 것이 정확히 하나일 때만 */
function chatListFor(track: RailEl): ListEl | null {
  const tr = track.getBoundingClientRect();
  for (let p = (track as unknown as ListEl).parentElement, n = 0; p && n < 8; p = p.parentElement, n++) {
    const all = p.querySelectorAll(CHAT_LIST_SELECTOR);
    if (!all.length) continue;
    const near: ListEl[] = [];
    for (let i = 0; i < all.length; i++) {
      const r = all[i].getBoundingClientRect();
      if (r.width > 0 && r.right > tr.left && r.left < tr.right) near.push(all[i]);
    }
    return near.length === 1 ? near[0] : null;
  }
  return null;
}
function releasePad(track: RailEl): void {
  const owner = padOwners.get(track);
  if (!owner) return;
  padOwners.delete(track);
  if (!owner.content.isConnected || owner.content.style.paddingBottom !== owner.written) return;
  if (owner.inline) owner.content.style.setProperty("padding-bottom", owner.inline);
  else owner.content.style.removeProperty("padding-bottom");
}
/** 지금 띠 목록(live)에 없는 띠의 여백을 되돌린다 — live 를 비우면 전부 */
function releasePadsExcept(live: Set<RailEl>): void {
  for (const track of [...padOwners.keys()]) if (!live.has(track)) releasePad(track);
}
/** 두 줄 띠(track)에 맞춰 대화 목록 끝 여백을 맞춘다. 두 줄이 아니면(rows false 이거나 아랫줄이 비어 늘어난 높이가 0) 되돌린다 */
function fitChatListToRail(track: RailEl, rows: boolean): void {
  const row = (track as unknown as { firstElementChild: RowEl | null }).firstElementChild;
  let extra = 0;
  if (rows && row) {
    const pill = row.querySelector('[role="button"]');
    const line = pill ? pill.getBoundingClientRect().bottom - pill.getBoundingClientRect().top : 0;
    extra = Math.max(0, Math.round(row.getBoundingClientRect().bottom - row.getBoundingClientRect().top - (line || 32)));
    // 개수 글씨(setPillBadge)는 알약 줄 위로 13px+3px 뜬다 — 한 줄일 때는 원래 여유 안에 들어가고, 두 줄이면 그만큼 더 준다
    if (extra > 0 && row.getAttribute("data-csb-badge") !== null) extra += 16;
  }
  const list = extra > 0 ? chatListFor(track) : null;
  const content = list?.firstElementChild ?? null;
  let owner = padOwners.get(track);
  if (!list || !content) { releasePad(track); return; }
  if (owner && (owner.content !== content || !owner.content.isConnected)) { releasePad(track); owner = undefined; }
  if (!owner) {
    const base = (window.getComputedStyle(content as never) as unknown as { paddingBottom?: string }).paddingBottom ?? "0";
    owner = { list, content, base: parseFloat(base) || 0, inline: content.style.paddingBottom || "", written: "" };
    padOwners.set(track, owner);
  }
  const want = `${owner.base + extra}px`;
  if (content.style.paddingBottom === want) { owner.written = want; return; }
  // 맨 아래를 보고 있었으면 여백을 늘린 뒤에도 맨 아래에 둔다(Paseo 의 "맨 아래 붙음"이 풀리지 않게)
  const stuck = list.scrollHeight - list.clientHeight - list.scrollTop < 4;
  content.style.setProperty("padding-bottom", want);
  owner.written = want;
  if (stuck) list.scrollTop = list.scrollHeight;
}

/** 화면에 한 벌만 돈다(기기마다 올라오는 플러그인이 같이 부르면 함께 쓰고, 다 끊으면 멈춘다). 끊기 함수 */
export function startComposerRail(): () => void {
  if (!isWeb() || typeof MutationObserver === "undefined") return () => {};
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_composerRail_v2 ??= { users: 0, stop: null }) as SharedDevice & { users: number };
  hub.users += 1;
  return joinSharedDevice(hub, RAIL_VERSION, () => {
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
      const rows = isCompactWidth();
      for (const t of tracks) {
        if (t.getAttribute("data-csb-track") === null) t.setAttribute("data-csb-track", "");
        // 좁은 화면 두 줄 표식(위 RAIL_CSS) · 커진 만큼 대화 목록 끝 여백
        if (rows !== (t.getAttribute("data-csb-rows") !== null)) {
          if (rows) t.setAttribute("data-csb-rows", "");
          else t.removeAttribute("data-csb-rows");
        }
        // 개수 글씨(setPillBadge)를 단 알약이 줄에서 빠졌으면(대화 바꾸기·넓은 화면) 글씨도 뗀다
        const badgeRow = (t as unknown as { firstElementChild: (RailEl & { querySelector(s: string): unknown }) | null }).firstElementChild;
        const badgeOf = badgeRow?.getAttribute("data-csb-badge-of");
        if (badgeRow && badgeOf && !badgeRow.querySelector(`[aria-label="${badgeOf}"]`)) {
          badgeRow.removeAttribute("data-csb-badge");
          badgeRow.removeAttribute("data-csb-badge-of");
        }
        try { fitChatListToRail(t, rows); } catch { /* 모르는 DOM 은 여백만 생략한다 */ }
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
      // 입력창이 사라져 띠가 목록에서 빠지면 fitChatListToRail 이 안 불린다 — 그 띠가 고친 여백을 여기서 되돌린다(Codex F3 정리 누락)
      try { releasePadsExcept(tracks); } catch { /* 모르는 DOM 은 생략한다 */ }
      const painted = document.querySelectorAll("[data-csb-track]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < painted.length; i++) {
        if (tracks.has(painted[i])) continue;
        painted[i].removeAttribute("data-csb-track");
        painted[i].removeAttribute("data-csb-rows");
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
        painted[i].removeAttribute("data-csb-rows");
        painted[i].removeAttribute("data-csb-shadow");
        painted[i].style.backgroundColor = "";
        painted[i].style.boxShadow = "";
      }
      releasePadsExcept(new Set());
      const lifted = document.querySelectorAll("[data-csb-lift]") as unknown as ArrayLike<RailEl>;
      for (let i = 0; i < lifted.length; i++) {
        lifted[i].removeAttribute("data-csb-lift");
        lifted[i].style.translate = "";
      }

    };
  }, () => { hub.users = Math.max(0, hub.users - 1); return hub.users === 0; });
}

// ── 머리줄 단추의 Paseo 도움말 숨기기(10-09 리규형님: 사용량 단추에 마우스를 올리면 뜨는 도움말 "별 필요 없어 — 없애") ──
// Paseo 는 플러그인 단추 설명(title, 꼭 넣어야 함)을 마우스를 올리면 늘 도움말 상자로 띄우고 끌 방법이 없다(0.11.1 앱 번들의
// 플러그인 단추: Tooltip 안 TooltipContent 에 title 글). 도움말 상자에는 이름표가 없어서, 마우스가 그 단추 위에 있는 동안만 화면에
// 새로 붙는 요소를 보고 글이 단추 설명으로 시작하면 그 상자를 감춘다. 단추는 접근성 이름(= title)으로 고른다.
// 감추지 못해도(Paseo 가 구조를 바꾸면) 도움말이 다시 보일 뿐 다른 고장은 없다
type TipEl = { nodeType: number; textContent: string | null; setAttribute(name: string, value: string): void };
type OverEvent = { target: { closest?(selector: string): unknown } | null };
const TIP_SHEET = "claude-state-bar-hidden-tip-v2";
const TIP_ATTR = "data-csb-hidden-tip";
const TIP_VERSION = 2;

/** titlePrefix 로 시작하는 설명을 가진 단추의 도움말을 감춘다. 화면에 한 벌만 돈다. 끊기 함수 */
export function hideButtonTooltip(titlePrefix: string): () => void {
  if (!isWeb() || typeof MutationObserver === "undefined") return () => {};
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_hiddenTip_v1 ??= { users: 0, stop: null }) as SharedDevice & { users: number };
  hub.users += 1;
  return joinSharedDevice(hub, TIP_VERSION, () => {
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
  }, () => { hub.users = Math.max(0, hub.users - 1); return hub.users === 0; });
}

// ── 대화의 턴·말 읽기(10-09) — Paseo 본문은 그대로 두고 웹 단추만 덧붙인다 ──
type SpeedKeyBinding = { active: boolean; adjust(direction: -1 | 1): void };
type SpeedKeyHub = SharedDevice & { users: Map<object, () => SpeedKeyBinding> };
// 3(10-16): 키를 단축키 표에서 읽는다 — 옛 판(< > 고정) 듣기는 물러난다
const SPEED_KEYS_VERSION = 4;
/** 같은 페이지의 호스트·옛 판이 남아도 키 듣기는 하나. 가장 나중에 등록한 읽기 중 재생기 하나만 조절한다.
 *  키 = 단축키 표(처음 값 Ctrl+← →, 10-17 — 옛 처음 값 < > 는 읽는 동안 입력창에 < > 를 못 쳤다). 읽는 중에만 가로챈다 */
export function listenTtsSpeedKeys(binding: () => SpeedKeyBinding): () => void {
  if (!isWeb()) return () => {};
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_speedKeys_v1 ??= { version: SPEED_KEYS_VERSION, users: new Map(), stop: null }) as SpeedKeyHub;
  const token = {};
  hub.users.set(token, binding);
  return joinSharedDevice(hub, SPEED_KEYS_VERSION, () => {
    const onKey = (event: KeyEventLike) => {
      // 키는 설정 화면 단축키 칸에서 바꾼다(10-16, 처음 값 Ctrl+← → 10-17)
      const slower = shortcutMatches("read-slower", keyLike(event));
      if (event.isComposing || (!slower && !shortcutMatches("read-faster", keyLike(event)))) return;
      const active = [...hub.users.values()].reverse().map((get) => get()).find((b) => b.active);
      if (!active) return;
      active.adjust(slower ? -1 : 1);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    document.addEventListener("keydown", onKey, true);
    hub.stop = () => document.removeEventListener("keydown", onKey, true);
  }, () => { hub.users.delete(token); return !hub.users.size; }, () => !hub.users.size);
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
  /** 마지막으로 실패한 읽기 — 그 단추 옆에 빨간 글로 남긴다(10-11 리규형님 "눌러도 아무 반응도 없어", 다시 누르면 지운다) */
  failed?: { target: unknown; error: string } | null;
  log?(message: string): void;
  fail?(target: unknown, reason: string): void;
  /** from: 화면에서 선택한 글이 걸친 첫 문단 번호 — 있으면 그 문단부터 읽는다(10-13) */
  read(target: unknown, text: string, from?: number): void;
  previous(): void;
  toggle(): void;
  stop(): void;
  next(): void;
  speed(value: number): void;
  /** 이 호스트에서 켜진 따라 읽기(10-15) — 없으면 null */
  follow?: FollowBinding | null;
};
/**
 * 따라 읽기(10-15 리규형님 "생각 상자를 뺀 Claude 말을 지금 시점부터 계속 읽어 주는 알약") — 켜진 대화 하나의 새 말을 문단이 끝나는
 * 대로 재생기에 넘긴다. 생각 상자 본문은 빼고 상자에서 꺼낸 말은 넣는다. 읽는 글은 화면 글이다(브라우저 번역기가 바꿨으면 바뀐 글)
 */
export type FollowBinding = {
  agentId: string;
  /** 켤 때마다 새 번호 — 바뀌면 어디부터 읽을지 다시 정한다 */
  session: number;
  /** 켤 때 화면에서 선택해 둔 글(Range) — 따라 읽을 말의 문단에 걸치면 그 문단부터(10-16). 없으면 null */
  from: unknown;
  /** 대화가 일하는 중이 아니면 마지막 문단까지 끝난 글로 본다 */
  idle: boolean;
  /** 재생기가 지금 읽는 문단 번호(넘긴 순서) — 형광펜 자리. 읽는 중이 아니면 null */
  index: number | null;
  /** 새로 끝난 문단 글을 차례로 넘긴다 */
  push(texts: string[]): void;
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
  closest?(selector: string): ReadEl | null;
  contains?(node: ReadEl): boolean;
  appendChild(node: ReadEl): void;
  insertBefore(node: ReadEl, before: ReadEl | null): void;
  compareDocumentPosition(node: ReadEl): number;
  addEventListener(type: string, fn: (e: KeyEventLike) => void): void;
  remove(): void;
};
type ReadFiber = {
  type?: unknown;
  return?: ReadFiber | null;
  alternate?: ReadFiber | null;
  memoizedProps?: Record<string, unknown>;
  stateNode?: { current?: ReadFiber };
};
// 0.11.1 모듈 4880 Qe 의 copyTurn. copyMessage(사용자 글)·코드 복사와는 다르다.
const TURN_COPY_LABELS = new Set(["نسخ بدوره", "Copy turn", "Copiar turno", "Copier l’échange", "ターンをコピー", "턴 복사", "Скопировать ответ", "复制回合"]);
const READ_MARK = "data-csb-turn-read";
// v6(10-11): 읽기 조절은 입력창 위 한 곳(startReadDock)으로 옮기고 여기는 스피커만 — 맨 오른쪽 · 읽는 중 녹색 · 소리 만드는 중 빙글빙글
// v7(10-15): 턴 끝난 시각·내 말 시각 항상 보이기 규칙이 붙었다 — 판이 오르면 이름도 바꿔 옛 판이 지우는 스타일과 겹치지 않게
const READ_SHEET = "claude-state-bar-turn-read-v9";
const TURN_READ_VERSION = 21; // 18: 따라 읽기 켤 때 선택한 문단부터 — follow.from(10-16) · 17: 따라 읽기 — 바인딩에 follow(10-15) ·9: 0.11.1 liveHead 행도 읽기·판 7/8 넘겨받기(10-12) · 10: 읽는 중 다시 누르면 중지(10-12) · 11: 선택한 문단부터 · 12: 표 한 덩어리·글머리 칸 빼기(10-13) · 13: 검사 안 탐색 결과 공유·꼬리 줄 색인(10-14 폰 버벅임) · 14: 말·복사 단추와 관계없는 화면 변화로는 검사 안 깨움(10-15) · 15: fiber 오를 때 Set·경로 목록 안 만듦(10-15 메모리) · 16: 꼬리 줄에 턴 끝난 시각·내 말 시각 항상 보이기(10-15)
/**
 * 꼬리 줄 "작업 시간" 단추의 이름표에서 끝난 시각만 — 0.11.1 AssistantTurnFooter(모듈 4880 Ue)는 작업 시간과 끝난 시각이 둘 다
 * 있을 때 이름표를 `${작업 시간}, ended ${시각}` 으로 만든다("ended" 는 번역 없는 고정 글). 시각은 Paseo formatMessageTimestamp
 * 그대로(오늘이면 "오후 2:17", 이번 주면 요일, 그 전이면 날짜) — 10-15 리규형님 "Paseo 가 숨겨 둔 모양 그대로"
 */
export function endedTimeOf(label: string | null): string | null {
  if (!label) return null;
  const at = label.lastIndexOf(ENDED_SEP);
  const time = at < 0 ? "" : label.slice(at + ENDED_SEP.length).trim();
  return time || null;
}
const ENDED_SEP = ", ended ";
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
// ── 한 번의 화면 검사(apply) 안에서만 쓰는 탐색 결과 공유(10-14 Codex 261014_214612 5.1·5.2) ──
// 폰 버벅임의 주범이 같은 요소의 fiber 를 루트까지 수백 단계씩 되풀이해 오르던 것이었다(원본 프로파일 10초 중 말 읽기 3.8초).
// 결과는 그 검사가 끝나면 버린다 — 다음 프레임에는 React 의 current/alternate·props 가 바뀌어 있을 수 있다. 검사 밖(클릭해서
// 읽기 시작 등)에서는 예전처럼 매번 새로 읽는다. null 결과도 그 검사 안에서만 기억한다
type TimelineRow = { root: ReadEl; stream: string; kind: string; id: string };
type ReadScan = {
  fibers: WeakMap<ReadEl, ReadFiber | null>;
  streams: WeakMap<ReadEl, string | null>;
  rows: WeakMap<ReadEl, TimelineRow | null>;
  groups: WeakMap<ReadEl, SpeechGroup | null>;
  messages?: ReadEl[];
  byId?: Map<string, Map<string, ReadEl>>;
};
let readScan: ReadScan | null = null;
function inReadScan<T>(run: () => T): T {
  const previous = readScan;
  readScan = { fibers: new WeakMap(), streams: new WeakMap(), rows: new WeakMap(), groups: new WeakMap() };
  try {
    return run();
  } finally {
    readScan = previous;
  }
}
function once<K extends object, V>(cache: WeakMap<K, V> | undefined, key: K, read: () => V): V {
  if (!cache) return read();
  if (cache.has(key)) return cache.get(key) as V;
  const value = read();
  cache.set(key, value);
  return value;
}
/** 화면의 Claude 말 블록 — 한 검사 안에서는 한 번만 찾는다 */
function scanMessages(): ReadEl[] {
  const read = () => Array.from(document.querySelectorAll('[data-testid="assistant-message"]') as unknown as ArrayLike<ReadEl>);
  return readScan ? (readScan.messages ??= read()) : read();
}
function readFiber(el: ReadEl): ReadFiber | null {
  return once(readScan?.fibers, el, () => readFiberUncached(el));
}
function readFiberUncached(el: ReadEl): ReadFiber | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  const fiber = (el as unknown as Record<string, unknown>)[key] as ReadFiber;
  // DOM 의 fiber 는 이전 커밋 쪽일 수도 있다. root.current 로 현재 쪽을 고른다.
  let root = fiber;
  for (let fast: ReadFiber | null | undefined = fiber; root.return; ) {
    root = root.return;
    fast = fast?.return?.return;
    if (fast === root) break;
  }
  return root.stateNode?.current && root.stateNode.current !== root ? fiber.alternate ?? null : fiber;
}
/**
 * fiber 를 루트 쪽으로 오르며 처음 맞는 props. 빙빙 도는 고리는 한 칸·두 칸씩 가는 둘이 만나면 멈춘다 — 지나간 것을 모아 두지
 * 않는다(10-15 폰 실측: 말 137개에서 오를 때마다 만든 Set 이 20초에 55MB 쓰레기 → 메모리 1.1GB·아래 창 버벅임)
 */
function firstProps(start: ReadFiber | null, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  for (let f = start, fast = start; f; ) {
    if (f.memoizedProps && match(f.memoizedProps)) return f.memoizedProps;
    f = f.return ?? null;
    fast = fast?.return?.return ?? null;
    if (f && f === fast) return null;
  }
  return null;
}
function readProps(el: ReadEl, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  // 판 13 은 검사 안에서 요소마다 루트까지 props 목록을 모아 두었다 — 시간은 22% 줄었지만 쓰레기가 커서(10-15) 판 15 부터 바로 오른다
  return firstProps(readFiber(el), match);
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
/**
 * Paseo 표 칸인가 — 공개 소스 0.11.1 `components/markdown/renderer.tsx` 의 th·td 규칙이 칸을 `MarkdownTableCellText`(문맥 값 "table-cell")로
 * 감싼다. 그 문맥 바로 아래의 화면 요소가 칸이다(사이에 다른 화면 요소가 끼면 칸 안쪽 요소). 화면 요소 이름에 기대지 않는다
 */
function isTableCell(el: ReadEl): boolean {
  let f = readFiber(el);
  for (let i = 0; f && i < 8; i++, f = f.return ?? null) {
    if (i > 0 && typeof f.type === "string") return false;
    if (f.memoizedProps?.value === "table-cell") return true;
  }
  return false;
}
/**
 * 말 블록 안 표마다 읽을 글 — 줄마다 "첫 칸, 머리글 값, 머리글 값." (10-13 리규형님 "표는 한 덩어리로, 안에서는 줄마다 머리글과 짝지어").
 * 칸 → 줄(칸의 부모) → 표(줄 묶음 thead·tbody 의 부모). 머리줄만 있거나 칸을 못 찾으면 표로 보지 않아 예전처럼 칸마다 읽는다.
 * 칸 글은 화면 글(번역기가 바꿨으면 바뀐 글). 생각 상자 원문 표는 서버 spokenText tableToSentences 가 같은 모양으로 만든다
 */
function readTables(root: ReadEl): Map<ReadEl, string> {
  const rowsOf = new Map<ReadEl, ReadEl[][]>();
  const cellsOf = new Map<ReadEl, ReadEl[]>();
  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const cell = all[i];
    if (!isTableCell(cell)) continue;
    const row = cell.parentElement;
    const table = row?.parentElement?.parentElement;
    if (!row || !table) continue;
    let rows = rowsOf.get(table);
    if (!rows) rowsOf.set(table, (rows = []));
    let cells = cellsOf.get(row);
    if (!cells) { cellsOf.set(row, (cells = [])); rows.push(cells); }
    cells.push(cell);
  }
  const out = new Map<ReadEl, string>();
  for (const [table, rows] of rowsOf) {
    if (rows.length < 2) continue;
    const text = (c: ReadEl) => (c.textContent ?? "").replace(/\s+/g, " ").trim();
    const head = rows[0].map(text);
    const sentences = rows.slice(1).map((cells) => {
      const parts = cells.map((c, k) => { const v = text(c); return !v ? "" : k === 0 || !head[k] ? v : `${head[k]} ${v}`; }).filter(Boolean);
      return parts.length ? `${parts.join(", ")}.` : "";
    }).filter(Boolean);
    if (sentences.length) out.set(table, sentences.join(" "));
  }
  return out;
}
/**
 * 화면 문단마다 글과 그 문단 요소(형광펜 자리, 10-09). 글은 문단 안 빈 줄을 없애 재생기 splitParagraphs 와 번호가 하나씩 맞는다.
 * 10-13: 표는 표마다 한 문단(readTables — 다음 한 번이면 표 전체를 건너뛴다), 글자가 하나도 없는 문단(목록 글머리 "•"·번호 "1." 칸 —
 * Paseo 는 목록 한 줄을 글머리 칸 + 내용 칸 가로 줄로 그린다)은 뺀다 — 글머리를 따로 "점"으로 읽고 다음을 두 번 눌러야 했다
 */
/** 마지막으로 모은 말 묶음에서 표로 묶은 수 — 읽기 기록 줄에 남겨 표 칸 표시를 못 찾게 됐는지(Paseo 판 변경) 알아본다 */
let tablesSeen = 0;
function screenParts(root: ReadEl): { block: ReadEl | null; text: string }[] {
  const tables = readTables(root);
  tablesSeen += tables.size;
  const spoken = new Set<ReadEl>();
  const walker = document.createTreeWalker(root, 5); // 요소 + 글자: br 도 문단 안 줄바꿈으로 읽는다.
  const parts: { block: NodeLike | null; text: string }[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as ReadEl;
    if (node.nodeType !== 3 && el.tagName !== "BR") continue;
    let hidden = false;
    let table: ReadEl | null = null;
    for (let p = node.nodeType === 3 ? el.parentElement : el; p; p = p.parentElement) {
      const style = window.getComputedStyle(p);
      if (p.getAttribute(READ_MARK) !== null || p.getAttribute("aria-hidden") === "true" || p.getAttribute("hidden") !== null ||
          p.getAttribute("role") === "button" || /^(BUTTON|SVG|SCRIPT|STYLE)$/.test(p.tagName) || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
          p.getAttribute("data-testid") === "assistant-message-capped-notice") { hidden = true; break; }
      if (!table && tables.has(p)) table = p;
      if (p === root) break;
    }
    if (hidden) continue;
    if (table) {
      // 표 첫 글자 자리에 그 표 문단 하나 — 나머지 칸 글은 건너뛴다
      if (!spoken.has(table)) { spoken.add(table); parts.push({ block: table, text: tables.get(table)! }); }
      continue;
    }
    const block = blockOf(node);
    let part = parts[parts.length - 1];
    if (!part || part.block !== block) { part = { block, text: "" }; parts.push(part); }
    part.text += node.nodeType === 3 ? node.nodeValue ?? "" : "\n";
  }
  return joinSplitParens(parts.map((p) => ({ block: p.block as ReadEl | null, text: p.text.replace(/\n[\t ]*\n\s*/g, "\n").trim() })))
    .filter((p) => /\p{L}/u.test(p.text));
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
/**
 * 화면에서 선택한 글이 걸친 첫 문단 번호(blocks = screenParts 의 문단 요소 순서) — 말 읽기를 그 문단부터(10-13 리규형님 "생각 상자와
 * 마찬가지로, 선택 글자가 있으면 그 문단부터"). 선택이 없거나 이 말의 어느 문단에도 안 걸치면 null(처음부터)
 */
function selectedPart(blocks: readonly (ReadEl | null)[]): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;
  return partIn(sel.getRangeAt(0), blocks);
}
/** 선택 범위가 걸친 첫 문단 번호 — 어느 문단에도 안 걸치면 null */
function partIn(range: RangeLike, blocks: readonly (ReadEl | null)[]): number | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try { if (block && range.intersectsNode(block)) return i; } catch { /* 문서에서 떨어진 요소 */ }
  }
  return null;
}
type SpeechGroup = { first: ReadEl; last: ReadEl; messages: ReadEl[] };
/**
 * 대화 칸 식별 값(에이전트 번호 + 호스트 번호). fiber props 객체로 비교하면 안 된다 — Paseo 가 다시 그릴 때 요소마다 새 fiber·옛
 * fiber(alternate)가 섞여 같은 칸도 다른 객체로 나온다. 그래서 같은 말 여섯 블록이 프레임마다 한 묶음↔여섯 조각으로 번갈아
 * 판정돼 스피커를 지웠다 붙였다 했고 글이 떨렸다(10-09 리규형님 "매우 떨린다", 실측 4초에 판정 60번 바뀜)
 */
function streamKey(el: ReadEl): string | null {
  return once(readScan?.streams, el, () => streamKeyUncached(el));
}
function streamKeyUncached(el: ReadEl): string | null {
  const p = streamProps(el);
  if (!p) return null;
  const serverId = typeof p.serverId === "string" ? p.serverId : (p.context as { serverId?: string } | undefined)?.serverId;
  return `${p.agentId as string}|${serverId ?? ""}`;
}
/** 4873 de → We: 각 타임라인 항목은 itemId·gapBelow를 가진 자기 행이다. */
function timelineRow(el: ReadEl): TimelineRow | null {
  return once(readScan?.rows, el, () => timelineRowUncached(el));
}
function timelineRowUncached(el: ReadEl): TimelineRow | null {
  const rowProps = readProps(el, (p) => typeof p.itemId === "string" && "gapBelow" in p);
  if (!rowProps) return null;
  type Item = { id?: string; kind?: string };
  const layout = readProps(el, (p) => (p.layoutItem as { item?: Item } | undefined)?.item?.id === rowProps.itemId);
  // 0.11.1 liveHead는 layoutItem 없이 item/index/items/render로 그린다(대표님 실제 fiber 10-12).
  // 같은 행 번호·배열·그리는 함수가 모두 맞아야 한다. 번호 접두어로 다른 턴을 추측하지 않는다.
  const liveRow = layout ? null : readProps(el, (p) => (p.item as Item | undefined)?.id === rowProps.itemId &&
    typeof (p.item as Item).kind === "string" && Array.isArray(p.items) && typeof p.render === "function");
  const item = (layout?.layoutItem as { item?: Item } | undefined)?.item ?? liveRow?.item as Item | undefined;
  const stream = streamKey(el);
  if (!rowProps || !stream || typeof item?.kind !== "string" || item.id !== rowProps.itemId) return null;
  let root = el;
  // 같은 행인지도 객체가 아니라 항목 번호로 본다(위 streamKey 와 같은 까닭)
  while (root.parentElement && readProps(root.parentElement, (p) => p.itemId === rowProps.itemId && "gapBelow" in p)) root = root.parentElement;
  return { root, stream, kind: item.kind, id: rowProps.itemId as string };
}
/** 이미 검증하던 타임라인 행 정보만 노출한다. 모르는 항목은 추측하지 않는다. */
export function timelineIdentity(node: unknown): { stream: string; id: string; kind: string } | null {
  if (!isWeb() || !node) return null;
  const row = timelineRow(node as ReadEl);
  return row ? { stream: row.stream, id: row.id, kind: row.kind } : null;
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
  const cache = readScan?.groups;
  if (!cache) return speechGroupUncached(el);
  if (cache.has(el)) return cache.get(el) ?? null;
  const group = speechGroupUncached(el);
  // 한 묶음의 말 블록은 어느 것으로 물어도 같은 묶음이다 — 묶음에 든 블록 모두에 기억해 둔다
  if (group) for (const message of group.messages) cache.set(message, group);
  else cache.set(el, null);
  return group;
}
function speechGroupUncached(el: ReadEl): SpeechGroup | null {
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
/**
 * 꼬리 줄 번호(stream + 항목 번호)의 말 블록 — 화면 순서상 처음 맞는 것(예전 전체 훑기와 같은 결과). 검사 안에서는 한 번 만든
 * 색인을 쓴다(10-14 Codex 5.2 — 꼬리 줄마다 화면의 말을 처음부터 다시 훑어 꼬리 줄 수 × 말 수로 커지던 것)
 */
function footerMessage(stream: string, itemId: string): ReadEl | null {
  const scan = readScan;
  if (!scan) {
    for (const message of scanMessages()) {
      const row = speechRow(message);
      if (row?.stream === stream && row.id === itemId) return message;
    }
    return null;
  }
  if (!scan.byId) {
    scan.byId = new Map();
    for (const message of scanMessages()) {
      const row = speechRow(message);
      if (!row) continue;
      let ids = scan.byId.get(row.stream);
      if (!ids) scan.byId.set(row.stream, (ids = new Map()));
      if (!ids.has(row.id)) ids.set(row.id, message); // 처음 맞는 것 유지
    }
  }
  return scan.byId.get(stream)?.get(itemId) ?? null;
}
/** 4873 de / 4959 I: 꼬리 줄은 마지막 도구 뒤에도 놓인다. 자기 말 번호로 화면의 말만 찾는다. */
function lastSpeech(copy: ReadEl): SpeechGroup | null {
  const stream = streamKey(copy);
  if (!stream) return null;
  type Footer = { itemId?: string; items?: unknown[]; startIndex?: number };
  const props = readProps(copy, (p) => typeof (p.layoutItem as { completedFooter?: Footer } | undefined)?.completedFooter?.itemId === "string" ||
    (typeof (p.host as Footer | undefined)?.itemId === "string" && Array.isArray((p.host as Footer).items)));
  const footer = (props?.layoutItem as { completedFooter?: Footer } | undefined)?.completedFooter ?? props?.host as Footer | undefined;
  if (footer?.itemId) {
    const message = footerMessage(stream, footer.itemId);
    // 자기 말이 가상 목록 밖이면 앞선 다른 턴을 대신 읽지 않는다.
    return message ? speechGroup(message) : null;
  }
  // 번호가 없는 옛 판만 바로 이웃한 말로 확인한다. 복사 글·대화 전체를 대체로 쓰지 않는다.
  const messages = copy.parentElement ? adjacentSpeech(copy.parentElement, "previousElementSibling", stream) : [];
  return messages.length ? speechGroup(messages[messages.length - 1]) : null;
}

// ── 따라 읽기(10-15) — 켜진 대화의 말 단위(Claude 말 블록 · 생각 상자에서 꺼낸 말, thinking.tsx saidId)를 화면 순서대로 모은다 ──
const FOLLOW_SAID = '[id^="csb-think-"][id$="-said"]';
const FOLLOW_UNITS = `[data-testid="assistant-message"], ${FOLLOW_SAID}`;
/** 생각 상자 바깥 칸(thinking.tsx `${domId}-box`) — 아직 꺼낸 말이 없는 상자도 출발점 계산에 넣는다(10-18 C4) */
const FOLLOW_BOX = '[id^="csb-think-"][id$="-box"]';
/** 말 단위 하나. key = 타임라인 항목 번호 + 항목 안 순번 — 다시 그려져 요소가 바뀌어도 같은 말이면 같은 키다 */
type FollowUnit = { el: ReadEl; key: string; root: ReadEl };
/** 꺼낸 말이 아직 없는 생각 상자 — key 는 나중에 꺼낸 말이 생기면 그 말 단위의 키, at = 화면 순서상 이 상자 앞에 있는 말 단위 수 */
type FollowBox = { key: string; at: number; root: ReadEl };
type FollowState = {
  session: number;
  /** 읽지 않는 말 — 켤 때 이미 있던 말(출발점 앞)과 그보다 앞에 뒤늦게 그려진 옛 말, 지나간 자리에 늦게 생긴 말(10-18 C4) */
  skip: Set<string>;
  /** 말 단위마다 넘긴 문단 수 */
  taken: Map<string, number>;
  /** 문단을 하나라도 재생기에 넘긴 말 — 읽기 순서 커서(이보다 앞에 늦게 생긴 말은 끼워 넣지 않는다, shared/thinkingContract followPlan) */
  pushed: Set<string>;
  /** 뒤에 다른 항목이 생겨 끝까지 넘긴 말 — 다시 화면 글을 모으지 않는다 */
  done: Set<string>;
  /** 넘긴 문단마다 (말 단위, 그 안 문단 번호) — 형광펜 자리를 다시 찾는다 */
  where: { key: string; part: number }[];
};
/** 화면 순서대로 말 단위와, 꺼낸 말이 아직 없는 생각 상자를 한 번에 모은다(한 번 훑은 순서가 곧 앞뒤 비교 기준) */
function followScan(stream: string): { units: FollowUnit[]; boxes: FollowBox[] } {
  const all = document.querySelectorAll(`${FOLLOW_UNITS}, ${FOLLOW_BOX}`) as unknown as ArrayLike<ReadEl>;
  const units: FollowUnit[] = [];
  const boxes: FollowBox[] = [];
  const perRow = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (streamKey(el) !== stream) continue;
    const row = timelineRow(el);
    if (!row) continue;
    const said = el.getAttribute("data-testid") !== "assistant-message";
    if (said && (el.getAttribute("id") ?? "").endsWith("-box")) {
      boxes.push({ key: `${row.id}#said`, at: units.length, root: row.root });
      continue;
    }
    const n = perRow.get(row.id) ?? 0;
    perRow.set(row.id, n + 1);
    units.push({ el, key: `${row.id}#${said ? "said" : n}`, root: row.root });
  }
  const unitKeys = new Set(units.map((u) => u.key));
  return { units, boxes: boxes.filter((b) => !unitKeys.has(b.key)) };
}
function followUnits(stream: string): FollowUnit[] {
  return followScan(stream).units;
}
/** 상자가 대화의 맨 끝 항목인가(뒤에 항목 번호가 있는 행·꼬리 줄이 없다) — followClosed 와 같은 기준 */
function followBoxLast(box: FollowBox, stream: string): boolean {
  const next = adjacentTimeline(box.root, "nextElementSibling", stream);
  return !next || (!timelineRow(next) && !footerProps(next));
}
/**
 * 끝난 말인가 — 뒤에 같은 대화의 다른 항목(다음 말·도구·생각 상자·꼬리 줄)이 있거나 대화가 쉬는 중. 아니면 마지막 문단은 아직 쓰는
 * 중이다. 뒤의 것이 항목 번호가 있는 행이나 꼬리 줄일 때만 친다 — 글만 있는 모르는 줄(일하는 중 표시 같은 것)로 끝났다고 보면 쓰는 중인
 * 문단을 넘겨 앞부분만 읽는다
 */
function followClosed(units: readonly FollowUnit[], i: number, idle: boolean, stream: string): boolean {
  if (idle || i < units.length - 1) return true;
  const next = adjacentTimeline(units[i].root, "nextElementSibling", stream);
  return !!next && (!!timelineRow(next) || !!footerProps(next));
}
/**
 * 켤 때 읽지 않을 말(10-15 리규형님 결정 "말하는 중이면 그 말 처음부터, 쉬는 중이면 다음 말부터"). 말하는 중 = 대화가 일하는 중이고
 * 화면 마지막 말 단위가 아직 안 끝났다(도구를 돌리거나 생각하는 중이면 다음 말부터). Claude 말 블록이면 이어진 말 묶음의 첫 블록부터.
 * 켤 때 선택해 둔 글이 따라 읽을 말의 문단에 걸치면 그 문단부터 뒤를 모두 읽는다(10-16 리규형님 "선택된 글자가 있으면 그 문단부터,
 * 없을 시 기존대로") — taken 에 그 말의 시작 문단 번호를 미리 넣는다. picked = 그 말의 화면 순번(못 찾으면 null)
 * 10-18 C4: 꺼낸 말이 아직 없는 생각 상자(boxes)도 출발점 앞이면 그 상자에서 나중에 꺼낼 말의 키를 skip 에 넣는다 — 켜기 전 상자가
 * 나중에 풀려 새 말처럼 읽히지 않게. 대화가 일하는 중이고 맨 끝 항목인 상자(지금 생각 중)만 빼 둔다 — 거기서 나올 말은 다음 말이다
 */
function followStart(units: readonly FollowUnit[], idle: boolean, stream: string, selection: unknown, boxes: readonly FollowBox[] = []): { skip: Set<string>; taken: Map<string, number>; picked: { unit: number; part: number } | null } {
  if (selection) {
    for (let i = 0; i < units.length; i++) {
      const part = partIn(selection as RangeLike, screenParts(units[i].el).map((p) => p.block));
      if (part === null) continue;
      const skip = new Set(units.slice(0, i).map((u) => u.key));
      for (const box of boxes) if (box.at <= i) skip.add(box.key);
      return { skip, taken: new Map([[units[i].key, part]]), picked: { unit: i, part } };
    }
  }
  const skip = new Set(units.map((u) => u.key));
  const begin = { skip, taken: new Map<string, number>(), picked: null };
  const last = units.length - 1;
  if (idle || last < 0 || followClosed(units, last, false, stream)) {
    for (const box of boxes) if (idle || !followBoxLast(box, stream)) skip.add(box.key);
    return begin;
  }
  let from = last;
  const group = units[last].key.endsWith("#said") ? null : speechGroup(units[last].el);
  if (group) {
    const at = units.findIndex((u) => u.el === group.first);
    if (at >= 0) from = at;
  }
  for (let i = from; i < units.length; i++) skip.delete(units[i].key);
  for (const box of boxes) if (box.at <= from) skip.add(box.key);
  return begin;
}
/** 새로 끝난 문단을 넘기고, 지금 읽는 문단의 화면 요소(형광펜 자리)를 돌려준다 */
function followStep(st: FollowState, follow: FollowBinding, stream: string, log: (message: string) => void): ReadEl | null {
  const units = followUnits(stream);
  const parts = new Map<string, { block: ReadEl | null; text: string }[]>();
  const partsOf = (u: FollowUnit) => {
    let list = parts.get(u.key);
    if (!list) parts.set(u.key, (list = screenParts(u.el)));
    return list;
  };
  // 옛 말 거르기 — 화면에 읽지 않는 말이 보이면 그 마지막 것보다 앞, 안 보이면 넘긴 말 중 첫 것보다 앞에 새로 그려진 것은 켜기 전의
  // 옛 말이다(위로 올려 가며 다시 그려진 것). 10-18 C4: 이미 재생기에 넘긴 말보다 앞에 늦게 생긴 말(생각 상자에서 늦게 꺼낸 말)은
  // 지금 읽는 순서 뒤에 끼워 넣지 않고 건너뛴다 — 읽기 순서는 앞으로만 간다(shared/thinkingContract followPlan).
  // 아는 말이 하나도 안 보이면(위로 멀리 올려 화면이 옛 기록만 그림) 새로 넘기지 않는다 — 옛 말을 새 말로 잘못 읽지 않게
  const plan = followPlan(units.map((u) => u.key), st);
  if (plan.scan) {
    for (const key of plan.old) st.skip.add(key);
    // 글 내용은 남기지 않고 항목 번호만(어느 말을 건너뛰었는지 기록으로 가린다)
    for (const key of plan.late) {
      st.skip.add(key);
      log(`follow: 지나간 자리에 늦게 생긴 말 건너뜀 · ${key}`);
    }
    for (const key of plan.take) st.taken.set(key, 0);
    const texts: string[] = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!st.taken.has(u.key) || st.skip.has(u.key) || st.done.has(u.key)) continue;
      const list = partsOf(u);
      // 뒤에 다른 항목이 있으면 끝났다. 쉬는 중이라 끝난 것으로 본 마지막 말은 끝으로 치지 않고 다시 본다 — 상태가 글보다 먼저 바뀌었을 수 있다
      const after = followClosed(units, i, false, stream);
      const ready = after || follow.idle ? list.length : list.length - 1;
      const from = st.taken.get(u.key) ?? 0;
      for (let k = from; k < ready; k++) {
        texts.push(list[k].text);
        st.where.push({ key: u.key, part: k });
      }
      if (ready > from) {
        st.taken.set(u.key, ready);
        st.pushed.add(u.key);
      }
      if (after) st.done.add(u.key);
    }
    if (texts.length) {
      log(`follow: 문단 ${texts.length}개 넘김 · 모두 ${st.where.length}개`);
      follow.push(texts);
    }
  }
  if (follow.index === null) return null;
  const at = st.where[follow.index];
  const unit = at ? units.find((u) => u.key === at.key) : undefined;
  return unit ? partsOf(unit)[at.part]?.block ?? null : null;
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
  target: string | ReadEl;
  hostId: string;
  kind: "turn" | "message";
  row: ReadEl;
  button: ReadEl;
  group: ReadEl | null;
  /** 소리 만드는 중 스피커 옆 빙글빙글(10-11) */
  spin: ReadEl | null;
  /** 읽기 실패 글(10-11) */
  err?: ReadEl | null;
  failure?: string;
  look?: string;
  muted?: string;
  /** 읽기 시작 때 넘긴 문단마다의 화면 문단 요소 — 재생기 문단 번호로 형광펜을 칠한다 */
  blocks?: (ReadEl | null)[];
};
type ReadHub = SharedDevice & { users: Map<object, (() => TurnReadBinding) & { csbVersion?: number }> };
/** 한 페이지·한 장치. 호스트 번호가 맞고 읽기가 켜진 연결만 자기 데몬의 TTS 를 쓴다. */
export function startTurnReadButtons(binding: () => TurnReadBinding): { refresh(): void; dispose(): void } {
  const noop = { refresh: () => {}, dispose: () => {} };
  if (!isWeb() || typeof MutationObserver === "undefined") return noop;
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_turnRead_v1 ??= { version: TURN_READ_VERSION, users: new Map(), stop: null, refresh: null }) as ReadHub;
  const token = {};
  hub.users.set(token, Object.assign(binding, { csbVersion: TURN_READ_VERSION }));
  const dispose = joinSharedDevice(hub, TURN_READ_VERSION, () => {
    const records = new Map<string | ReadEl, ReadRecord>();
    const snapshots = new Map<string | ReadEl, string[]>();
    const targetOf = (el: ReadEl): string | ReadEl => {
      const row = timelineRow(el);
      return row ? JSON.stringify([row.stream, row.id, "speech"]) : el;
    };
    let live = true;
    let queued: "frame" | "timer" | false = false;
    // 지난 검사의 말 블록·복사 단추 — 화면 변화가 이것들과 관계있을 때만 검사를 깨운다(아래 relevant)
    let watched: ReadEl[] = [];
    // 따라 읽기 진행(호스트마다) · 켜진 것이 있나 — 켜진 동안만 꺼낸 말 글 변화로도 검사를 깨운다(아래 relevant)
    const follows = new Map<string, FollowState>();
    let followOn = false;
    // 화면 탐색 실패는 그릴 때마다 되풀이된다 — 같은 이유는 한 번만 서버 기록으로 보낸다
    let lastScanError = "";
    const owner = (hostId: string) => [...hub.users.values()].map((get) => get()).find((b) => b.hostId === hostId && b.enabled);
    const bindingFor = (hostId: string) => [...hub.users.values()].map((get) => get()).find((b) => b.hostId === hostId);
    const trace = (r: ReadRecord, message: string) => (bindingFor(r.hostId) ?? [...hub.users.values()][0]?.())?.log?.(`${r.kind}: ${message}`);
    const fail = (r: ReadRecord, reason: string) => {
      r.failure = reason;
      trace(r, `중단: ${reason}`);
      bindingFor(r.hostId)?.fail?.(r.target, reason);
      hub.refresh?.();
    };
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
      `[${READ_MARK}="error"]{align-self:center;margin-left:4px;font-size:12px;color:#e5534b}` +
      `@keyframes csb-read-spin{to{transform:rotate(360deg)}}` +
      `::highlight(${READ_HIGHLIGHT}){background-color:rgba(255, 226, 0, 0.3)}` +
      // 턴 끝난 시각(10-15 리규형님 "턴이 끝나는 시점에서 시간을 적어줘"): 작업 시간 단추 바로 뒤에 "· 오후 2:17".
      // 시각을 붙인 단추는 마우스 올림(웹)·누름(폰 3초)으로 글자를 시각으로 바꾸던 동작을 막는다 — 안 막으면 "오후 2:17 · 오후 2:17"
      `[${READ_MARK}="time"]{flex-shrink:0;align-self:center;white-space:nowrap}` +
      `[role="button"][aria-label*="${ENDED_SEP}"]:has(+ [${READ_MARK}="time"]){pointer-events:none}` +
      // 내 말 보낸 시각을 늘 보인다(10-15 리규형님 결정) — Paseo 는 그 줄(시각·되감기·복사)을 마우스를 올릴 때만 보인다
      // (0.11.1 trailingRowHidden opacity 0 + pointerEvents none). 줄은 늘 보이고, 숨김 상태(react-native-web pointer-events:none
      // 묶음 r-633pao)일 때는 시각 말고 단추만 감춘다 — 단추가 보이는 때·눌리는 때는 Paseo 그대로
      `[data-testid="user-message-trailing-row"]{opacity:1!important}` +
      `[data-testid="user-message-trailing-row"].r-633pao>:not([data-testid="user-message-timestamp"]){visibility:hidden}`);
    const button = (name: string, icon: string, action: () => void, size = String((readAppFontSizes().content ?? 15) - 1)) => {
      const el = readNode("button", "button");
      el.setAttribute("type", "button");
      labelRead(el, name);
      readIcon(el, icon, size);
      // 누르는 순간 화면 선택이 풀리지 않게 — 선택한 문단부터 읽으려면 클릭 때 선택이 남아 있어야 한다(10-13)
      el.addEventListener("mousedown", (event) => event.preventDefault());
      el.addEventListener("click", (event) => { event.stopPropagation(); action(); });
      return el;
    };
    const remove = (r: ReadRecord) => {
      r.spin?.remove();
      r.err?.remove();
      r.button.remove();
      r.group?.remove();
      records.delete(r.target);
    };
    const start = (r: ReadRecord) => {
      try {
        r.failure = "";
        trace(r, "클릭");
        const b = bindingFor(r.hostId);
        if (!b) { fail(r, "이 호스트의 읽기 연결을 찾지 못했습니다"); return; }
        // 이 단추로 읽는 중(소리 만드는 중·일시정지 포함)이면 다시 누를 때 멈춘다(10-12 리규형님). 기준은 스피커 녹색과 같다(speaker)
        if (b.playing?.target === r.target) { trace(r, "다시 눌러 중지"); b.stop(); return; }
        if (!b.enabled) { b.read(r.target, ""); return; } // 키·설정의 정확한 이유는 연결 쪽에서
        const group = r.kind === "turn" ? lastSpeech(r.anchor) : speechGroup(r.anchor);
        if (!group) { fail(r, "이 턴의 화면 본문을 찾지 못했습니다. 본문을 화면에 보이게 한 뒤 다시 눌러 주세요"); return; }
        tablesSeen = 0;
        const parts = group.messages.flatMap(screenParts);
        const text = parts.map((p) => p.text).join("\n\n").trim();
        trace(r, `화면 본문 ${group.messages.length}블록·${parts.length}문단·${text.length}자·표 ${tablesSeen}개`);
        if (!text) { fail(r, "이 턴의 화면에 읽을 글이 없습니다"); return; }
        r.blocks = parts.map((p) => p.block);
        snapshots.set(r.target, parts.map((p) => p.text));
        // 이 말 안에서 글을 선택해 두고 누르면 그 문단부터(재생기 문단 번호 = parts 번호). 선택을 썼으면 푼다 — 선택 색이 형광펜을 덮지 않게
        const from = selectedPart(r.blocks);
        if (from !== null) { trace(r, `선택한 ${from + 1}번째 문단부터`); clearSelection(); }
        b.read(r.target, text, from ?? undefined);
      } catch (error) { fail(r, `읽기 시작 실패: ${String(error)}`); }
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
    // 꼬리 줄 → 끝난 시각 글자(10-15). 작업 시간 단추 바로 뒤, 스피커보다 앞
    const times = new Map<ReadEl, ReadEl>();
    /** 꼬리 줄에 끝난 시각을 붙이거나 고친다. 붙일 것이 없으면(작업 시간이나 시각 하나뿐) 걷고 false */
    const paintEnded = (row: ReadEl): boolean => {
      let label: ReadEl | null = null;
      for (let c = row.firstElementChild; c && !label; c = c.nextElementSibling) if (c.getAttribute("role") === "button" && endedTimeOf(c.getAttribute("aria-label"))) label = c;
      const time = label ? endedTimeOf(label.getAttribute("aria-label")) : null;
      let span = times.get(row);
      if (!label || !time) {
        if (span) { span.remove(); times.delete(row); }
        return false;
      }
      if (!span) { span = readNode("span", "time"); times.set(row, span); }
      const text = `· ${time}`;
      if (span.textContent !== text) span.textContent = text;
      // 색·크기·글꼴은 작업 시간 글자 그대로(Paseo labelOverlay — foregroundMuted · 13px)
      let glyph: ReadEl = label;
      while (glyph.lastElementChild) glyph = glyph.lastElementChild;
      const style = window.getComputedStyle(glyph) as unknown as Record<string, string>;
      const look = `color:${style.color};font-size:${style.fontSize};font-family:${style.fontFamily};line-height:${style.lineHeight}`;
      if (span.getAttribute("data-csb-look") !== look) { span.setAttribute("data-csb-look", look); span.style.cssText = look; }
      if (label.nextSibling !== span) row.insertBefore(span, label.nextSibling);
      return true;
    };
    const make = (anchor: ReadEl, hostId: string, kind: ReadRecord["kind"], row: ReadEl, target: string | ReadEl) => {
      const size = kind === "turn" ? anchor.querySelector("svg")?.getAttribute("width") ?? "14" : String((readAppFontSizes().content ?? 15) - 1);
      const r: ReadRecord = { anchor, target, hostId, kind, row, button: null as unknown as ReadEl, group: null, spin: null };
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
      records.set(target, r);
      return r;
    };
    // 스피커 상태만 — 읽는 중 녹색, 소리 만드는 중 옆에 빙글빙글(10-11). 이전·일시정지·중지·다음·속도는 입력창 위 한 곳(startReadDock)
    const speaker = (r: ReadRecord, b: TurnReadBinding) => {
      const playing = b.playing?.target === r.target ? b.playing : null;
      if (playing && snapshots.has(r.target)) {
        const group = r.kind === "turn" ? lastSpeech(r.anchor) : speechGroup(r.anchor);
        const parts = group?.messages.flatMap(screenParts) ?? [];
        r.blocks = snapshots.get(r.target)!.map((text, index) => parts[index]?.text === text ? parts[index].block : null);
      }
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
      // 실패하면 단추 오른쪽에 빨간 글 — 생각 상자와 같은 문구(10-11, 전엔 마우스를 올려야만 보였다)
      const error = r.failure || (!playing && b.failed?.target === r.target ? b.failed.error : playing?.error || "");
      const text = error ? (error.startsWith("소리 읽기 실패") ? error : `소리 읽기 실패: ${error}`) : "";
      if (text && !r.err) r.err = readNode("span", "error");
      if (text && r.err) {
        if (r.err.textContent !== text) r.err.textContent = text;
        const after = r.spin ?? r.button;
        if (r.err.parentElement !== r.button.parentElement || after.nextSibling !== r.err) r.button.parentElement?.insertBefore(r.err, after.nextSibling);
      }
      if (!text && r.err) { r.err.remove(); r.err = null; }
    };
    const apply = () => {
      queued = false;
      if (!live) return;
      try {
        // 한 번의 검사 안에서만 탐색 결과를 공유한다(위 inReadScan — 끝나면 버림)
        inReadScan(() => {
        const wanted = new Set<string | ReadEl>();
        const lastWithFooter = new Set<ReadEl>();
        const copies = new Set(Array.from(document.querySelectorAll('[role="button"][aria-label]') as unknown as ArrayLike<ReadEl>).filter((el) => TURN_COPY_LABELS.has(el.getAttribute("aria-label") ?? "")));
        // 복사 직후 '복사됨' 이름표여도 기존 꼬리 줄 단추는 유지한다.
        for (const r of records.values()) if (r.kind === "turn" && r.anchor.isConnected) copies.add(r.anchor);
        const timeRows = new Set<ReadEl>();
        for (const copy of copies) {
          const row = copy.parentElement;
          const hostId = footerHost(copy);
          if (!row || !hostId || !footerProps(copy) || window.getComputedStyle(row).flexDirection !== "row") continue;
          // 끝난 시각은 읽기 기능과 따로 — 읽기가 꺼진 호스트의 꼬리 줄에도 붙인다
          if (paintEnded(row)) timeRows.add(row);
          const b = owner(hostId);
          if (!b) continue;
          const last = lastSpeech(copy);
          if (last) lastWithFooter.add(last.first);
          const target = targetOf(last?.first ?? copy);
          wanted.add(target);
          let r = records.get(target);
          if (r && (r.kind !== "turn" || r.anchor !== copy || r.hostId !== hostId || r.row !== row || !r.button.isConnected)) { remove(r); r = undefined; }
          r ??= make(copy, hostId, "turn", row, target);
          paintTurn(r);
          // 작업 시간 글자 등이 뒤늦게 붙으면 다시 맨 오른쪽으로(10-11)
          if (row.lastElementChild !== r.button && row.lastElementChild !== r.spin && row.lastElementChild !== r.err) row.appendChild(r.button);
          speaker(r, b);
        }
        // 복사 직후 "복사됨" 이름표라 이번 검사에서 못 찾은 꼬리 줄도 끝난 시각 단추가 남아 있으면 그대로 둔다
        for (const row of [...times.keys()]) if (!timeRows.has(row) && (!row.isConnected || !paintEnded(row))) { times.get(row)?.remove(); times.delete(row); }
        const messages = scanMessages();
        watched = [...copies, ...messages];
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
          const target = targetOf(el);
          if (lastWithFooter.has(el)) continue;
          let r = records.get(target);
          wanted.add(target);
          if (r && (r.kind !== "message" || r.anchor !== el || r.hostId !== hostId || !r.group?.isConnected)) { remove(r); r = undefined; }
          r ??= make(el, hostId!, "message", speech.last, target);
          // 같은 말에 블록이 늘어나면,재생은 유지하고 자기 조절만 마지막으로 옮긴다.
          if (r.row !== speech.last) { r.row = speech.last; r.row.appendChild(r.group!); }
          const muted = readPalette(r.row).muted;
          if (r.muted !== muted) { r.muted = muted; r.group!.style.setProperty("color", muted); }
          const display = lastWithFooter.has(el) ? "none" : "";
          if (r.button.style.display !== display) r.button.style.display = display;
          speaker(r, b);
        }
        for (const r of records.values()) if (!wanted.has(r.target)) remove(r);
        for (const target of snapshots.keys()) if (![...hub.users.values()].some((get) => get().playing?.target === target)) snapshots.delete(target);
        // 읽는 문단 형광펜: 재생 중인 기록의 문단 번호 자리 하나만. 읽기가 끝나거나 다른 것을 읽으면 옮기거나 지운다
        let lit: ReadEl | null = null;
        for (const r of records.values()) {
          const playing = owner(r.hostId)?.playing;
          if (playing?.target === r.target && typeof playing.index === "number") lit = r.blocks?.[playing.index] ?? null;
        }
        // 따라 읽기(10-15) — 호스트마다 켜진 대화 하나. 형광펜은 턴·말 읽기가 먼저(한 호스트의 재생기는 하나라 같이 읽지 않는다)
        const followHosts = new Set<string>();
        for (const get of hub.users.values()) {
          const b = get();
          if (!b.follow || !b.hostId || followHosts.has(b.hostId)) continue;
          followHosts.add(b.hostId);
          const stream = `${b.follow.agentId}|${b.hostId}`;
          const log = (message: string) => b.log?.(message);
          let st = follows.get(b.hostId);
          if (!st || st.session !== b.follow.session) {
            const { units, boxes } = followScan(stream);
            const begin = followStart(units, b.follow.idle, stream, b.follow.from, boxes);
            st = { session: b.follow.session, skip: begin.skip, taken: begin.taken, pushed: new Set(), done: new Set(), where: [] };
            follows.set(b.hostId, st);
            // 선택을 썼으면 푼다 — 선택 색이 형광펜을 덮지 않게(말 읽기 단추와 같다)
            if (begin.picked) clearSelection();
            const reading = units.filter((u) => !begin.skip.has(u.key)).length;
            const boxesBefore = boxes.filter((box) => begin.skip.has(box.key)).length;
            log(`follow: 시작 — 화면 말 ${units.length}개 중 ${reading}개부터${boxesBefore ? ` · 생각 상자 ${boxesBefore}개 출발점 앞` : ""}${begin.picked ? ` · 선택한 ${begin.picked.unit + 1}번째 말의 ${begin.picked.part + 1}번째 문단부터` : ""}${b.follow.idle ? " · 쉬는 중" : ""}`);
          }
          const block = followStep(st, b.follow, stream, log);
          lit ??= block;
        }
        for (const host of [...follows.keys()]) if (!followHosts.has(host)) follows.delete(host);
        followOn = followHosts.size > 0;
        paintReading(lit);
        });
      } catch (error) {
        const reason = `화면 탐색 실패: ${String(error)}`;
        if (reason !== lastScanError) {
          lastScanError = reason;
          for (const get of hub.users.values()) get().log?.(reason);
        }
      }
    };
    // 대화 화면은 스트리밍 중 글자마다 바뀐다 — 바뀔 때마다 단추 붙이기(전체 찾기·fiber 오르기)를 돌리지 않고 화면을 한 번
    // 그릴 때 한 번만 돈다(Claude 10-09 검토: 처음엔 매 변경 직후 마이크로태스크였다). 화면 그리기 맞춤 함수가 없으면 예전대로
    const frame = (globalThis as { requestAnimationFrame?: (fn: () => void) => number }).requestAnimationFrame;
    // 화면이 숨으면(다른 탭·창 최소화) 브라우저가 그리기를 멈춰 위 맞춤 함수가 돌지 않는다. 따라 읽기가 켜진 동안만 그리기를 기다리지
    // 않고 다음 차례에 본다(10-15 리규형님 "숨어 있어도 계속 읽기"). 보일 때나 따라 읽기가 꺼졌을 때는 예전 그대로
    const hidden = pageHidden;
    const following = () => [...hub.users.values()].some((get) => !!get().follow);
    // 걸어 둔 예약: 그리기 대기("frame")·다음 차례 대기("timer"). 그리기 대기는 숨은 화면에서 돌지 않으므로, 숨은 화면에서 따라 읽기
    // 중이면 그리기 대기가 걸려 있어도 다음 차례 대기를 하나 더 건다 — 안 그러면 처음부터 숨어 있던 화면은 켜기 전에 걸린 그리기
    // 예약 하나에 막혀 검사가 한 번도 돌지 않는다(10-15 실측). 두 예약이 다 돌면 검사가 한 번 더 돌 뿐이다
    const refresh = () => {
      if (!live) return;
      const urgent = hidden() && following();
      if (queued === "timer" || (queued === "frame" && !urgent)) return;
      if (frame && !urgent) { queued = "frame"; frame(() => apply()); }
      else if (frame) { queued = "timer"; setTimeout(apply, 0); }
      else { queued = "timer"; void Promise.resolve().then(apply); }
    };
    const onVisibility = () => { if (live && hidden() && following()) refresh(); };
    document.addEventListener("visibilitychange", onVisibility as unknown as (e: Event) => void, false);
    // 말·복사 단추와 관계없는 화면 변화로는 검사를 깨우지 않는다(10-15 폰 실측: Paseo 의 작업 중 깜빡임 투명도·아래 창 여백이
    // 3초에 47번 깨워 말 59개에서 한 번 35ms — 조용할 때도 폰 CPU 28%). 줄 추가·삭제, 이름표 바뀜, 문서 맨 위(테마), 말·복사
    // 단추를 품거나 그 안에 있는 요소의 변화는 그대로 깨운다. 우리 단추 안 아이콘·이름표 바뀜만 뺀다(Codex 261014_214612 5.4)
    const relevant = (list: MutationLike[]) => {
      const seen = new Set<ReadEl>();
      for (const m of list) {
        const target = m.target as ReadEl;
        if (m.type === "childList") {
          if (target.closest?.(`[${READ_MARK}]`)) continue;
          return true;
        }
        if (m.attributeName === "aria-label") return true;
        const el = m.type === "characterData" ? target.parentElement : target;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (el === (document.documentElement as unknown) || el === (document.body as unknown)) return true;
        if (el.closest?.(`[${READ_MARK}]`)) continue;
        if (el.closest?.('[data-testid="assistant-message"]')) return true;
        if (followOn && el.closest?.(FOLLOW_SAID)) return true;
        for (const x of watched) if (x === el || x.contains?.(el) || el.contains?.(x)) return true;
      }
      return false;
    };
    const observer = new MutationObserver((list) => { if (relevant(list)) refresh(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "class", "style", "stroke", "width", "height"] });
    hub.refresh = refresh;
    hub.stop = () => {
      live = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility as unknown as (e: Event) => void, false);
      for (const r of records.values()) remove(r);
      for (const span of times.values()) span.remove();
      times.clear();
      follows.clear();
      paintReading(null);
      setStyleSheet(READ_SHEET, null);
    };
    apply();
  }, () => { hub.users.delete(token); return !hub.users.size; }, () => !hub.users.size);
  return { refresh: () => hub.refresh?.(), dispose };
}

// ── 직전 내 말로(10-15 리규형님 "나의 턴을 찾으려면 스크롤을 엄청 올려도 구분이 안 된다 — 바로 직전 나의 발화로 올라가는 알약") ──
// Paseo 0.11.1 의 대화 개요(ChatOutlineRail, 모듈 4955 — 대화 칸 왼쪽 가장자리 눈금)가 내 말 목록·이동 함수를 이미 가진다:
// props {prompts: [{seq, timestamp, preview}], activePrompt: {getActiveSeq()}, onJumpToPrompt(seq)}. 이동 함수는 아직 안 불러온 옛
// 기록이면 서버에서 그 구간을 가져와 옮기고, 내 말을 대화 칸 위 8px 자리에 맞춘다(10-15 실측). 목록·이동은 화면 폭과 상관없이
// 살아 있다(918px 미만이면 눈금만 숨김 → 폰에서도 쓴다). Paseo 설정 "대화 개요"가 꺼져 있거나 서버가 내 말 목록을 모르면 목록이
// 비어 있다 — 그때는 화면에 그려진 내 말 중에서만 찾는다
type JumpEl = ReadEl & { getBoundingClientRect(): { top: number }; scrollTop: number };
type JumpRail = { prompts: { seq: number }[]; activePrompt?: { getActiveSeq?: () => number | null }; onJumpToPrompt: (seq: number) => void };
/** 화면에 그려진 내 말 하나 — seq 는 Paseo 기록 번호(모르면 null), top 은 화면 위치 */
export type JumpUser = { seq: number | null; top: number };
/**
 * 누를 때마다 한 칸 더 위의 내 말(10-15 리규형님 결정). 기준은 대화 칸의 위 가장자리(top):
 *  - 머리가 그 위로 넘어간(잘렸거나 다 지나간) 내 말이 화면에 있으면 그중 가장 가까운 것
 *  - 없으면 화면에 머리가 보이는 첫 내 말의 바로 앞 내 말(방금 이동해 맨 위에 와 있으면 이것 — 한 칸 위로)
 *  - 화면에 내 말이 하나도 없으면(긴 턴 한가운데) Paseo 가 읽는 위치로 정한 내 말, 그것도 없으면 마지막 내 말
 * Paseo 의 "읽는 위치" 값은 이동 직후 한동안 옛 값이라(10-15 실측: 60번으로 옮긴 직후에도 1) 화면 위치를 먼저 본다.
 * 돌려주는 것: {seq} 그 번호로 이동 · {index} users 의 그 내 말로 스크롤(번호를 모를 때) · null 더 위에 내 말 없음
 */
export function pickJumpTarget(users: readonly JumpUser[], top: number, prompts: readonly number[], active: number | null): { seq: number } | { index: number } | null {
  const order = users.map((u, index) => ({ ...u, index })).sort((a, b) => a.top - b.top);
  const seqs = [...prompts].sort((a, b) => a - b);
  let above: (typeof order)[number] | undefined;
  for (const u of order) if (u.top < top) above = u;
  if (above) return above.seq !== null && seqs.length ? { seq: above.seq } : { index: above.index };
  if (order.length) {
    const first = order[0].seq;
    if (first === null || !seqs.length) return null;
    const before = seqs.filter((s) => s < first);
    return before.length ? { seq: before[before.length - 1] } : null;
  }
  if (!seqs.length) return null;
  return { seq: active !== null && seqs.includes(active) ? active : seqs[seqs.length - 1] };
}
/** 화면에서 이 대화의 칸(스크롤 영역)을 찾는다 — 칸이 여러 개면 대화 번호가 맞는 것 */
function chatScrollOf(agentId: string): JumpEl | null {
  const all = document.querySelectorAll('[data-testid="agent-chat-scroll"]') as unknown as ArrayLike<JumpEl>;
  for (let i = 0; i < all.length; i++) {
    if (readProps(all[i], (p) => typeof p.agentId === "string")?.agentId === agentId) return all[i];
  }
  return null;
}
/** 대화 칸 근처 fiber 에서 대화 개요 props — 스크롤 영역에서 위로 오르며 형제 쪽을 본다(실측 4칸 위) */
function outlineOf(scroll: JumpEl): JumpRail | null {
  const isRail = (p: Record<string, unknown> | undefined): p is Record<string, unknown> & JumpRail =>
    !!p && Array.isArray(p.prompts) && typeof p.onJumpToPrompt === "function";
  type Walk = ReadFiber & { child?: Walk | null; sibling?: Walk | null; return?: Walk | null };
  let f = readFiber(scroll) as Walk | null;
  for (let up = 0; f && up < 40; up++, f = f.return ?? null) {
    for (let c = f.return?.child ?? null; c; c = c.sibling ?? null) if (isRail(c.memoizedProps)) return c.memoizedProps;
  }
  return null;
}
/** 알약을 누르면 — 이 대화 칸에서 한 칸 위 내 말로. 무엇을 했는지 한 줄을 돌려준다(기록용) */
export function jumpToPreviousUserMessage(agentId: string): string {
  if (!isWeb()) return "웹 화면이 아님";
  const scroll = chatScrollOf(agentId);
  if (!scroll) return "대화 칸을 화면에서 찾지 못함";
  const top = scroll.getBoundingClientRect().top;
  const els = Array.from(scroll.querySelectorAll('[data-testid="user-message"]') as unknown as ArrayLike<JumpEl>);
  const users: JumpUser[] = els.map((el) => {
    // 내 말 행의 항목(layoutItem.item 또는 0.11.1 liveHead 의 item) 번호 — 실측 9칸 위
    const props = readProps(el, (p) => ((p.layoutItem as { item?: { kind?: string } } | undefined)?.item ?? p.item as { kind?: string } | undefined)?.kind === "user_message");
    const item = ((props?.layoutItem as { item?: unknown } | undefined)?.item ?? props?.item) as { timelineCursor?: { seq?: unknown } } | undefined;
    const seq = item?.timelineCursor?.seq;
    return { seq: typeof seq === "number" ? seq : null, top: el.getBoundingClientRect().top };
  });
  const rail = outlineOf(scroll);
  const prompts = rail ? rail.prompts.map((p) => p.seq).filter((s): s is number => typeof s === "number") : [];
  const active = rail?.activePrompt?.getActiveSeq?.() ?? null;
  const target = pickJumpTarget(users, top, prompts, typeof active === "number" ? active : null);
  if (!target) return `더 위에 내 말 없음(화면 ${users.length}개·목록 ${prompts.length}개)`;
  if ("seq" in target && rail) {
    rail.onJumpToPrompt(target.seq);
    return `대화 개요로 ${target.seq}번 내 말`;
  }
  if ("index" in target) {
    // 번호를 모르면 화면의 그 말로 직접 — 위 8px 는 Paseo 의 이동 자리(PROMPT_JUMP_TOP_INSET_PX)와 같게
    scroll.scrollTop += els[target.index].getBoundingClientRect().top - top - 8;
    return "화면의 내 말로 스크롤";
  }
  return "대화 개요를 찾지 못함";
}

/**
 * 입력창 위 읽기 컨트롤러 — 화면에 하나(10-11 리규형님 "컨트롤러를 여기로 통일 · 찾아 다니는 일도 일").
 * 턴·말·생각 상자·꺼낸 말 무엇을 읽든 같은 자리: 넓은 화면은 입력창 위 알약 줄 정가운데, 좁은 화면(폰)은 그 줄 아래 새 줄 가운데
 * (10-12 리규형님 "오른쪽은 눈이 잘 안 가" — 10-11 의 맨 오른쪽을 바꿈). 넓은 화면이라도 가운데 자리가 좌우 알약과 겹치면 아래 줄 가운데.
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
// 판이 오르면 스타일 이름도 바꾼다 — 옛 판을 정리할 때 옛 이름 스타일만 지워지게(project_paseo_client_hub_stale)
const DOCK_SHEET = "claude-state-bar-read-dock-v8";
const DOCK_VERSION = 8; // 2: 가운데 배치(10-12) · 3: 좁은 화면은 두 줄 띠의 아랫줄 남는 공간 가운데(10-18) · 4: 알약 줄 위(되돌림) · 5: 아랫줄에 작게(10-18 밤) · 6: 속도 칸 기본 모양 끔(폰 테두리 두 겹)
type DockHub = SharedDevice & { users: Map<object, (() => ReadDockState) & { csbVersion?: number }> };
export function startReadDock(state: () => ReadDockState): { refresh(): void; dispose(): void } {
  const noop = { refresh: () => {}, dispose: () => {} };
  if (!isWeb() || typeof MutationObserver === "undefined") return noop;
  const g = globalThis as Record<string, unknown>;
  const hub = (g.__claudeStateBar_readDock_v1 ??= { version: DOCK_VERSION, users: new Map(), stop: null, refresh: null }) as DockHub;
  const token = {};
  hub.users.set(token, Object.assign(state, { csbVersion: DOCK_VERSION }));
  const dispose = joinSharedDevice(hub, DOCK_VERSION, () => {
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
      // 알약 줄(Paseo 가 이미 position:relative)의 정가운데에 띄운다 — 알약 줄 흐름에 끼지 않아 다른 알약 자리를 밀지 않는다
      `[${DOCK_MARK}="dock"][data-place="center"]{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1}` +
      `[${DOCK_MARK}="dock"][data-place="below"]{align-self:center;margin-top:4px}` +
      // 좁은 화면: 두 줄 띠(RAIL_CSS data-csb-rows)의 아랫줄 맨 뒤 — 세 알약 뒤 남는 공간 가운데(10-18 리규형님). 폰 폭 390 에서 남는 폭이
      // 약 189px 인데 보통 크기(약 191px)로는 셋째 줄로 밀려(10-18 밤 폰 실기) 단추·간격·속도 글씨를 줄여 약 150px 로 넣는다
      // (알약 줄 위에 띄우는 안은 균형이 안 맞아 되돌림 — 리규형님). 가운데 기준을 12px 왼쪽으로 — 폰 앱이 화면 오른쪽 끝에 띄우는
      // 단추(새로고침·소리·전원)가 둘째 줄 오른쪽 끝도 가려서, 남는 공간에서 오른쪽 24px 를 뺀 곳의 가운데에 둔다. 그래도 모자라면 셋째 줄 가운데
      `[${DOCK_MARK}="dock"][data-place="row2"]{order:54;margin-left:auto;margin-right:auto;position:relative;left:-12px;gap:0;padding:0 2px}` +
      `[${DOCK_MARK}="dock"][data-place="row2"] [${DOCK_MARK}="button"]{width:24px;height:24px}` +
      `[${DOCK_MARK}="dock"][data-place="row2"] [${DOCK_MARK}="speed"]{height:22px;margin:0 0 0 1px;padding:0 13px 0 4px;font-size:11px;background-position:right 4px center}` +
      `[${DOCK_MARK}="button"]{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin:0;border:0;border-radius:999px;background:transparent;cursor:pointer;color:var(--colors-foreground-muted, currentColor)}` +
      `[${DOCK_MARK}="button"]:hover{background:var(--colors-surface2, rgba(127,127,127,.15))}` +
      `[${DOCK_MARK}="button"]:focus-visible{outline:2px solid currentColor;outline-offset:1px}` +
      `[${DOCK_MARK}="button"][data-tone="go"]{color:${READ_GREEN}}` +
      `[${DOCK_MARK}="button"][data-tone="stop"]{color:var(--colors-status-dot-danger, #f7796d)}` +
      `[${DOCK_MARK}="speed"]{height:24px;margin:0 0 0 2px;border:1px solid var(--colors-accent-bright, currentColor);border-radius:999px;padding:0 6px;color:var(--colors-accent-bright, currentColor);background:var(--colors-surface1, transparent);font:inherit;font-size:12px;cursor:pointer}` +
      // 폰 앱(안드로이드 웹뷰)은 선택칸에 자체 기본 모양을 한 겹 더 그려 테두리가 두 겹으로 보였다(10-18 리규형님 — PC 크롬은 우리 테두리로
      // 대체해 안 보임). 기본 모양을 끄고 같은 자리에 ∨ 화살표를 그린다. 누른 뒤 남는 포커스 테두리도 없앤다
      `[${DOCK_MARK}="speed"]{-webkit-appearance:none;appearance:none;outline:none;box-shadow:none;padding-right:16px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M1 1l3 3 3-3' fill='none' stroke='%239aa0a6' stroke-width='1.3'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 5px center}` +
      `[${DOCK_MARK}="speed"]:focus,[${DOCK_MARK}="speed"]:focus-visible{outline:none;box-shadow:none}` +
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
    type Boxed = ReadEl & { getBoundingClientRect(): { left: number; right: number; width: number } };
    const kidsOf = (el: ReadEl) => Array.from((el as unknown as { children: ArrayLike<ReadEl> }).children);
    // 알약 줄 가운데에 컨트롤러 폭만큼 빈자리가 있나 — 컨트롤러가 어디 붙어 있든 같은 계산이라(알약 줄 가운데 ± 폭) 자리를 옮겨도
    // 답이 바뀌지 않는다(옮김 → 다시 잼이 왔다 갔다 하지 않는다). 알약 감싸개는 display:contents 라 그 안쪽 단추를 잰다
    const fitsCenter = (row: ReadEl): boolean => {
      const width = (dock as Boxed).getBoundingClientRect().width;
      if (!width) return true; // 아직 안 붙었다 — 붙인 뒤 다음 차례에 다시 잰다
      const box = (row as Boxed).getBoundingClientRect();
      const left = box.left + box.width / 2 - width / 2 - 4;
      const right = left + width + 8;
      const items = kidsOf(row).flatMap((c) => c === dock ? [] : (window.getComputedStyle(c as never) as unknown as { display: string }).display === "contents" ? kidsOf(c) : [c]);
      return !items.some((c) => { const r = (c as Boxed).getBoundingClientRect(); return r.width > 0 && r.right > left && r.left < right; });
    };
    const place = (track: ReadEl) => {
      const row = track.firstElementChild;
      if (isCompactWidth() && row) {
        if (dock!.getAttribute("data-place") !== "row2") dock!.setAttribute("data-place", "row2");
        if (dock!.parentElement !== row) row.appendChild(dock!);
      } else if (row && fitsCenter(row)) {
        if (dock!.getAttribute("data-place") !== "center") dock!.setAttribute("data-place", "center");
        if (dock!.parentElement !== row) row.appendChild(dock!);
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
  }, () => { hub.users.delete(token); return !hub.users.size; }, () => !hub.users.size);
  return { refresh: () => hub.refresh?.(), dispose };
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
