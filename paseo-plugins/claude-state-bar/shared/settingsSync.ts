import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 기기 사이 Paseo 설정 맞추기(리규형님 10-07 결정: PC 앱·웹·폰 앱이 같은 설정). 정본은 PC 데몬 파일 하나이고,
// 칸은 화면 판(화면 코드 파일 지문)마다 따로 둔다 — 판이 바뀌며 설정 모양이 바뀌어도 옛 값이 새 판에 들어가지 않게.

/** 맞추는 저장 열쇠 — 설정 화면의 설정만(리규형님 10-07 정정: 일반·모양·사이드바·채팅·단축키·알림. 탭 배치·패널 상태 같은
 *  쓰면서 바뀌는 화면 상태까지 맞추니 "모든 행동이 동기화"돼 뺐다). 연결 정보·기기 번호·캐시·쓰다 만 글·화면 상태와 새 판에서
 *  새로 생긴 열쇠는 맞추지 않는다 */
export const SYNC_KEYS: readonly string[] = ["@paseo:app-settings", "@paseo:keyboard-shortcut-overrides"];
export const APP_SETTINGS_KEY = "@paseo:app-settings";
/**
 * 앱 설정 안에서 맞추는 칸 — 설정 화면 항목별로 화면 코드(앱 0.11.0-beta.5)에서 어느 칸을 바꾸는지 확인했다. 글자 크기 3가지는
 * 기기별(리규형님 결정)이라 빼고, 터미널(스크롤 줄 수)·편집기(vim 키)·진단(옛 터미널 그리기)·PC 앱 전용(베타·안정판, 내장 데몬)과
 * 앞으로 생길 모르는 칸도 맞추지 않는다. 알림은 앱 설정이 아니라 PC 앱 전용 저장소에 있고 웹엔 그 항목이 없어 맞출 것이 없다.
 */
export const SHARED_APP_FIELDS: readonly string[] = [
  // 일반: 언어 · 보내기 동작 · 열기 위치
  "language",
  "sendBehavior",
  "serviceUrlBehavior",
  "openInSidePane",
  "pullRequestOpenLocation",
  // 모양(글자 크기 uiBaseFontSize·contentFontSize·codeFontSize 는 기기별)
  "theme",
  "pluginThemeId",
  "uiFontFamily",
  "monoFontFamily",
  "contentMaxWidth",
  "syntaxTheme",
  // 사이드바
  "workspaceTitleSource",
  "sidebarWorkspaceTrailing",
  "sidebarRowItems",
  "sidebarChecksDisplay",
  "sidebarNavItems",
  "sidebarFooterItems",
  "usage",
  // 채팅
  "autoExpandReasoning",
  "toolCallDetailLevel",
  "chatOutlineEnabled",
];

export function isSyncKey(key: string): boolean {
  return SYNC_KEYS.includes(key);
}

/** 정본에 둘 모양 — 앱 설정은 맞추는 칸만 남긴다. undefined = 맞추지 않는다(앱 설정이 JSON 이 아님) */
export function toShared(key: string, value: string | null): string | null | undefined {
  if (key !== APP_SETTINGS_KEY || value === null) return value;
  let o: unknown;
  try {
    o = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const src = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of SHARED_APP_FIELDS) if (f in src) out[f] = src[f];
  return JSON.stringify(out);
}

const entry = z.object({ v: z.string().nullable(), at: z.number() });

/** 이 판 칸이 rev 와 다르면 바로, 같으면 어느 칸이든 바뀔 때까지(데몬이 정한 시간 안에서) 기다렸다 답한다 */
export const syncWait = defineRpc({
  name: "settings-sync.wait",
  input: z.object({ slot: z.string(), rev: z.number() }),
  output: z.object({
    /** 이 판 칸의 번호. 칸이 없으면 0 */
    rev: z.number(),
    /** 이 판 칸의 값(v=null 은 지운 것). 칸이 없으면 null */
    keys: z.record(z.string(), entry).nullable(),
    /** 모든 칸의 번호와 마지막으로 바뀐 시각 — 다른 판 화면에서 바꾼 것이 있는지 알리는 데 쓴다 */
    slots: z.array(z.object({ slot: z.string(), rev: z.number(), at: z.number() })),
  }),
});

/** seed=true 는 칸이 없을 때만 그 값으로 칸을 만든다(이미 있으면 applied=false). seed=false 는 칸이 있을 때만 바꾼다 */
export const syncPut = defineRpc({
  name: "settings-sync.put",
  input: z.object({ slot: z.string(), changes: z.record(z.string(), z.string().nullable()), seed: z.boolean() }),
  output: z.object({ rev: z.number(), applied: z.boolean() }),
});
