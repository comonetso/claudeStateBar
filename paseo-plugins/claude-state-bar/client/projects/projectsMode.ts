import { useEffect, useState } from "react";
import { listenGlobalKey, readLocal, setStyleSheet, writeLocal } from "../web";
import { shortcutMatches } from "../../shared/shortcuts";
import { retainSharedStyle } from "../sharedStyle";
import { runCleanups } from "../cleanup";
import { uiLanguage } from "../appLanguage";

// 왼쪽 목록 칸에 프로젝트 목록을 보일지 워크스페이스 목록을 보일지(리규형님 10-06 결정):
//   프로젝트 매니저는 왼쪽 목록 안 맨 위에 두고, 보이는 동안 워크스페이스 목록은 웹·데스크톱에서 가린다.
//   Ctrl+Alt+Shift+B 를 누르면 둘을 번갈아 보인다(10-06 리규형님: P 에서 B 로 — 리규형님이 Paseo 단축키를 왼쪽 칸
//   Ctrl+Alt+B · 오른쪽 탐색기 Ctrl+Alt+E 로 바꿔 쓰므로 그 짝으로. Ctrl+Alt 조합은 앱과 브라우저 양쪽에서 브라우저 단축키와 안 겹친다).
// Paseo 왼쪽 목록 자체를 여닫는 일(Paseo 설정의 왼쪽 사이드바 토글)은 건드리지 않는다. 휴대폰은 가릴 수 없어 워크스페이스 목록도 같이 보인다.

export type ProjectsMode = "projects" | "workspaces";

const MODE_KEY = "claude-state-bar:projects-mode";
const STYLE_ID = "claude-state-bar-hide-workspace-list";
// 2 = 10-27 담당이 내려갈 때 목록 자리 붙잡기(아래 HOLD) — 옛 판과 섞이면 높은 판의 시트가 이긴다
const STYLE_VERSION = 2;
// Paseo 왼쪽 목록의 워크스페이스 목록 스크롤 상자(앱 sidebar 의 testID, 0.11.0-beta.4)
const HIDE_CSS = '[data-testid="sidebar-project-workspace-list-scroll"]{display:none !important}';

// 담당이 내려가도 워크스페이스 목록을 바로 드러내지 않는다(10-27 리규형님 버튼 "왼쪽 목록 자리만 잠깐 비워 두기").
// 화면 잠금은 모든 호스트 중계를 끊어 이 담당까지 내려가고, 풀면 서버 대체 역할이나 PC 가 다시 붙을 때까지 1~6초가 걸린다
// (ego 재현: 풀기 0.8초 뒤 막이 걷히고 1.8초 동안 워크스페이스 목록이 보였다가 프로젝트 목록으로 돌아왔다).
// 프로젝트 모드였으면 그동안 목록 내용을 숨기고 "다시 연결 중" 한 줄만 둔다. 다시 붙으면(startProjectsMode) 걷는다.
// 잠금 막이 덮인 동안은 기다림을 늘리고, 막 없이 HOLD_MS 가 지나도 안 붙으면(플러그인을 껐을 때 등) 원래 목록을 보인다.
// 옛 판 모듈과 섞여도 같은 칸을 쓰도록 상태는 페이지 공용(globalThis)에 둔다.
const HOLD_ID = "claude-state-bar-hold-workspace-list";
const HOLD_MS = 30_000;
const HOLD_CHECK_MS = 1_000;
type Hold = { timer: ReturnType<typeof setInterval> | null; deadline: number };
const SCROLL = '[data-testid="sidebar-project-workspace-list-scroll"]';
function holdCss(): string {
  const text = uiLanguage() === "ko" ? "다시 연결 중…" : "Reconnecting…";
  return `${SCROLL}>*{display:none !important}${SCROLL}::before{content:"${text}";display:block;padding:10px 16px;font-size:13px;opacity:.6}`;
}
// 게이트 guard.js 의 잠금 막 — /__gate/lock 을 띄운 iframe(10-27 막 방식)
function lockCoverShown(): boolean {
  const doc = (globalThis as { document?: { querySelector(selector: string): unknown } }).document;
  return Boolean(doc?.querySelector('iframe[src*="/__gate/lock"]'));
}
function holdState(): Hold {
  return (g.__claudeStateBar_projectsHold_v1 ??= { timer: null, deadline: 0 }) as Hold;
}
function endHold(): void {
  const h = holdState();
  if (h.timer) clearInterval(h.timer);
  h.timer = null;
  setStyleSheet(HOLD_ID, null);
}
function startHold(): void {
  const h = holdState();
  h.deadline = Date.now() + HOLD_MS;
  setStyleSheet(HOLD_ID, holdCss());
  if (h.timer) return;
  h.timer = setInterval(() => {
    if (lockCoverShown()) h.deadline = Date.now() + HOLD_MS;
    else if (Date.now() > h.deadline) endHold();
  }, HOLD_CHECK_MS);
}

type ModeHub = { mode: ProjectsMode; listeners: Set<(m: ProjectsMode) => void> };
const g = globalThis as Record<string, unknown>;
const hub = (g.__claudeStateBar_projectsMode_v1 ??= {
  mode: readLocal(MODE_KEY) === "workspaces" ? "workspaces" : "projects",
  listeners: new Set(),
}) as ModeHub;

export function setProjectsMode(next: ProjectsMode): void {
  if (next === hub.mode) return;
  hub.mode = next;
  writeLocal(MODE_KEY, next);
  for (const l of hub.listeners) l(next);
}

export function toggleProjectsMode(): void {
  setProjectsMode(hub.mode === "projects" ? "workspaces" : "projects");
}

export function useProjectsMode(): ProjectsMode {
  const [m, setM] = useState(hub.mode);
  useEffect(() => {
    hub.listeners.add(setM);
    setM(hub.mode);
    return () => {
      hub.listeners.delete(setM);
    };
  }, []);
  return m;
}

/** 플러그인이 켜질 때 한 번 — 가리기를 지금 모드에 맞추고 단축키를 단다. 끌 때 가리기를 걷는다 */
export function startProjectsMode(): () => void {
  // 처음 배포 중 옛 판 모듈이 저장한 값도 담당을 넘겨받을 때 읽는다.
  const saved = readLocal(MODE_KEY);
  if (saved === "workspaces" || saved === "projects") setProjectsMode(saved);
  const style = retainSharedStyle(STYLE_ID, STYLE_VERSION, setStyleSheet);
  const apply = () => style.set(hub.mode === "projects" ? HIDE_CSS : "");
  hub.listeners.add(apply);
  apply();
  endHold();
  const stopKey = listenGlobalKey((e) => shortcutMatches("projects-toggle", e), toggleProjectsMode);
  return () => {
    hub.listeners.delete(apply);
    // 가리기를 걷기 전에 붙잡아 둔다 — 역할이 넘어가면 다음 담당이 같은 차례 안에서 바로 걷는다
    if (hub.mode === "projects") startHold();
    runCleanups([stopKey, style.dispose]);
  };
}
