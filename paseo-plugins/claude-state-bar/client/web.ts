import { Linking, Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: { open(url: string, target: string, features: string): unknown };
declare class Audio {
  constructor(src?: string);
  play(): Promise<void>;
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

declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined;

function storage() {
  return Platform.OS === "web" && typeof localStorage !== "undefined" ? localStorage : null;
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
declare const document: {
  getElementById(id: string): { contains(node: unknown): boolean } | null;
  addEventListener(type: string, fn: (e: KeyEventLike) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (e: KeyEventLike) => void, capture: boolean): void;
};
type KeyEventLike = { key?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: unknown; preventDefault(): void; stopPropagation(): void };
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
