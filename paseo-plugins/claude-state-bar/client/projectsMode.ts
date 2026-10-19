import { useEffect, useState } from "react";
import { listenGlobalKey, readLocal, setStyleSheet, writeLocal } from "./web";
import { shortcutMatches } from "../shared/shortcuts";
import { retainSharedStyle } from "./sharedStyle";
import { runCleanups } from "./cleanup";

// 왼쪽 목록 칸에 프로젝트 목록을 보일지 워크스페이스 목록을 보일지(리규형님 10-06 결정):
//   프로젝트 매니저는 왼쪽 목록 안 맨 위에 두고, 보이는 동안 워크스페이스 목록은 웹·데스크톱에서 가린다.
//   Ctrl+Alt+Shift+B 를 누르면 둘을 번갈아 보인다(10-06 리규형님: P 에서 B 로 — 리규형님이 Paseo 단축키를 왼쪽 칸
//   Ctrl+Alt+B · 오른쪽 탐색기 Ctrl+Alt+E 로 바꿔 쓰므로 그 짝으로. Ctrl+Alt 조합은 앱과 브라우저 양쪽에서 브라우저 단축키와 안 겹친다).
// Paseo 왼쪽 목록 자체를 여닫는 일(Paseo 설정의 왼쪽 사이드바 토글)은 건드리지 않는다. 휴대폰은 가릴 수 없어 워크스페이스 목록도 같이 보인다.

export type ProjectsMode = "projects" | "workspaces";

const MODE_KEY = "claude-state-bar:projects-mode";
const STYLE_ID = "claude-state-bar-hide-workspace-list";
const STYLE_VERSION = 1;
// Paseo 왼쪽 목록의 워크스페이스 목록 스크롤 상자(앱 sidebar 의 testID, 0.11.0-beta.4)
const HIDE_CSS = '[data-testid="sidebar-project-workspace-list-scroll"]{display:none !important}';

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
  const stopKey = listenGlobalKey((e) => shortcutMatches("projects-toggle", e), toggleProjectsMode);
  return () => {
    hub.listeners.delete(apply);
    runCleanups([stopKey, style.dispose]);
  };
}
