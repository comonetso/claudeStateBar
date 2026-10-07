import type { PluginClientContext } from "@getpaseo/plugin/client";
import { currentProjectKey, hostIndexOf, norm, type HostIndex } from "./projectsData";
import { projectsManager, projectsWait, type ProjectEntry } from "../shared/projects";
import { SOUND_PAGE_SIZE, SOUND_RETRY_MS, SOUND_USE_COALESCE_MS } from "../shared/soundClaim";
import { currentWorkspaceFromUrl, watchLocation } from "./web";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { RoutedSoundEvent, SoundScreenState } from "../shared/soundClaim";

type Hub = {
  id: string; stateSeq: number; userUseSeq: number; projectKey: string | null;
  resolve?: (serverId: string, directory: string) => string | null;
  listeners: Set<() => void>; originListeners: Set<() => void>; origins: Map<string, PluginClientContext>; reported: Set<string>;
  useTimer?: ReturnType<typeof setTimeout>; usePending?: boolean;
};
function hub(): Hub {
  const g = globalThis as Record<string, unknown>;
  return (g.__claudeStateBar_soundScreen_v2 ??= {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    stateSeq: 0, userUseSeq: 0, projectKey: null, listeners: new Set(), originListeners: new Set(), origins: new Map(), reported: new Set(),
  }) as Hub;
}
export function screenId(): string { return hub().id; }
export function screenProject(): string | null { return hub().projectKey; }
export function screenSnapshot(): SoundScreenState {
  const h = hub(); return { screenId: h.id, stateSeq: ++h.stateSeq, userUseSeq: h.userUseSeq, projectKey: h.projectKey };
}
const bumpUse = (h: Hub) => { h.userUseSeq++; for (const f of h.listeners) f(); };
/** 사람이 이 화면을 썼다 — 1초(SOUND_USE_COALESCE_MS) 안의 입력은 처음은 바로, 나머지는 1초 끝에 한 번으로 모아 알린다
 *  (타이핑마다 PC 에 요청이 몰리지 않게, 10-08 Claude). 다른 화면으로 옮겨 처음 누른 입력은 늘 바로 간다 */
export function markSoundScreenUse(): void {
  const h = hub();
  if (h.useTimer !== undefined) { h.usePending = true; return; }
  bumpUse(h);
  const flush = () => {
    h.useTimer = undefined;
    if (!h.usePending) return;
    h.usePending = false;
    bumpUse(h);
    h.useTimer = setTimeout(flush, SOUND_USE_COALESCE_MS);
  };
  h.useTimer = setTimeout(flush, SOUND_USE_COALESCE_MS);
}
export function watchSoundScreen(listener: () => void): () => void { hub().listeners.add(listener); return () => { hub().listeners.delete(listener); }; }
export function eventProject(event: RoutedSoundEvent): string | null { return hub().resolve?.(event.originHostId, event.directory) ?? null; }
export function rememberSoundReport(eventId: string): boolean { const h = hub(); if (h.reported.has(eventId)) return false; h.reported.add(eventId); return true; }
export function registerSoundOrigin(serverId: string, client: PluginClientContext): () => void {
  hub().origins.set(serverId, client);
  for (const f of hub().originListeners) f();
  return () => { if (hub().origins.get(serverId) === client) { hub().origins.delete(serverId); for (const f of hub().originListeners) f(); } };
}
export function soundOrigin(serverId: string): PluginClientContext | undefined { return hub().origins.get(serverId); }

// 목록 컴포넌트와 동일한 공개 hooks/함수를 쓴다. 제목, 목록 편집/렌더링 코드는 변경하지 않는다.
export function publishSoundProjects(entries: ProjectEntry[], index: HostIndex, current: { serverId: string; directory: string } | null): void {
  const h = hub();
  h.resolve = (serverId, directory) => currentProjectKey(entries, index, { serverId, directory });
  const key = currentProjectKey(entries, index, current);
  if (key !== h.projectKey) { h.projectKey = key; for (const f of h.listeners) f(); }
}
// 목록이 실제로 마운트되지 않은 좁은 폰/닫힌 사이드바에서도 살아 있는 서비스다.
export function startSoundProjects(client: PluginClientContext, log: (message: string) => void): () => void {
  let stopped = false, mapRevision = 0, locationRevision = 0;
  let entries: ProjectEntry[] = [];
  let paths = new Map<string, string>();
  let current: { serverId: string; directory: string } | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryResolve: (() => void) | undefined;
  const publish = () => { if (!stopped) publishSoundProjects(entries, hostIndexOf(entries, paths), current); };
  const refreshPaths = async () => {
    const version = ++mapRevision;
    const owners = new Map<string, Set<string>>();
    for (const [serverId, origin] of hub().origins) {
      try {
        const { projects } = await origin.paseo.projects.list();
        for (const p of projects) { const key = norm(p.projectRootPath); owners.set(key, (owners.get(key) ?? new Set()).add(serverId)); }
      } catch { /* 목록의 useHostIndex와 같이 미확인 호스트는 짝짓지 않는다. */ }
    }
    if (stopped || version !== mapRevision) return;
    paths = new Map([...owners].filter(([, ids]) => ids.size === 1).map(([p, ids]) => [p, [...ids][0]]));
    publish();
  };
  const loadLocation = async () => {
    const version = ++locationRevision;
    const loc = currentWorkspaceFromUrl();
    if (!loc) { current = null; publish(); return; }
    try {
      const api = getPaseoClient(loc.serverId); // 화면이 이미 가진 연결을 빌린다.
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: { entries: { id: string; workspaceDirectory: string }[]; pageInfo: { hasMore: boolean; nextCursor: string | null } } =
          await api.workspaces.list({ page: { limit: SOUND_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
        if (stopped || version !== locationRevision) return;
        const hit = page.entries.find((w) => w.id === loc.workspaceId);
        if (hit) { current = { serverId: loc.serverId, directory: hit.workspaceDirectory }; publish(); return; }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
        if (cursor && seen.has(cursor)) throw new Error("작업 공간 페이지 반복");
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (e) { if (!stopped) log("sound project lookup skipped: " + String(e)); }
    if (!stopped && version === locationRevision) { current = null; publish(); }
  };
  const loadProjects = async () => {
    try {
      const data = await client.rpc(projectsManager, {});
      if (stopped) return;
      entries = data.entries;
      await refreshPaths();
    } catch (e) { if (!stopped) { entries = []; publish(); log("sound project list skipped: " + String(e)); } }
  };
  const originsChanged = () => { void refreshPaths(); void loadLocation(); };
  hub().originListeners.add(originsChanged);
  const stopLocation = watchLocation(() => { void loadLocation(); });
  void loadLocation();
  void (async () => {
    await loadProjects();
    let known: number | null | undefined;
    while (!stopped) {
      try {
        const r = await client.rpc(projectsWait, { mtimeMs: known ?? null });
        if (stopped) return;
        if (known === undefined || r.mtimeMs !== known) await loadProjects();
        known = r.mtimeMs;
      } catch {
        await new Promise<void>((resolve) => { retryResolve = resolve; retry = setTimeout(resolve, SOUND_RETRY_MS); });
        if (!stopped) await loadProjects();
      }
    }
  })();
  return () => { stopped = true; mapRevision++; locationRevision++; stopLocation(); hub().originListeners.delete(originsChanged); if (retry) clearTimeout(retry); retryResolve?.(); };
}
