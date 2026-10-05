import { useSyncExternalStore } from "react";
import { readPanelFontPx, writePanelFontPx } from "./web";

// 패널 글자 크기 — 확장처럼 패널 안 A−/A+ 로 조절한다(확장 media/codexruns.js: 기본 15px, 한 번에 1px, 10~28px).
// 리규형님 10-05: 앱 설정을 따라가는 것보다 패널 안에서 직접, 조절하면 모든 패널·프로젝트 화면에 같이(전역).
// 호스트마다 플러그인이 따로 실려도 실행 공간은 하나라 globalThis 에 한 벌만 둔다. 값은 이 기기 앱 저장소에 남는다(PC 앱·브라우저).
export const BASE_PX = 15;
const MIN_PX = 10;
const MAX_PX = 28;

interface FontShared {
  px: number;
  listeners: Set<() => void>;
}
const KEY = "__claudeStateBar_font";

function shared(): FontShared {
  const root = globalThis as unknown as Record<string, FontShared | undefined>;
  let s = root[KEY];
  if (!s) {
    const saved = readPanelFontPx();
    s = { px: saved && saved >= MIN_PX && saved <= MAX_PX ? saved : BASE_PX, listeners: new Set() };
    root[KEY] = s;
  }
  return s;
}

const subscribe = (fn: () => void) => {
  const s = shared();
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
};

export function setPanelFontPx(px: number): void {
  const s = shared();
  const next = Math.min(MAX_PX, Math.max(MIN_PX, Math.round(px)));
  if (next === s.px) return;
  s.px = next;
  writePanelFontPx(next);
  for (const fn of s.listeners) fn();
}

export function usePanelFontPx(): number {
  return useSyncExternalStore(subscribe, () => shared().px, () => shared().px);
}

/** 패널 글자 배율(기본 15px = 1배) */
export function useFontScale(): number {
  return usePanelFontPx() / BASE_PX;
}

export const fontStep = (delta: 1 | -1) => setPanelFontPx(shared().px + delta);

/** 글자 크기·줄 높이에 배율을 곱한다(반 픽셀 단위) */
export const scaled = (px: number, scale: number) => Math.round(px * scale * 2) / 2;
