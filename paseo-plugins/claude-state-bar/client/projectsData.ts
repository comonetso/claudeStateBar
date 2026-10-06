import { getPaseoClient, useHosts, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { projectsManager, projectsPinOrder, projectsPinSet, projectsPins, type ProjectEntry } from "../shared/projects";

// 프로젝트 매니저 데이터 — 전체 화면(projectsScreen)과 왼쪽 목록 칸(projectsSidebar)이 같이 쓴다.
// 호스트 짝짓기: 프로젝트 매니저는 Remote-SSH 별칭("Calladmin-Gabia")을, Paseo 는 서버 번호를 쓴다. 각 호스트의 Paseo
// 프로젝트 목록에서 같은 경로를 찾아 그 호스트로 열고, 거기서 "별칭 → 호스트"를 배워 목록에 없는 항목(꺼 둔 것)에도 쓴다.

// 대소문자는 윈도우 경로(드라이브·네트워크 공유)만 무시한다 — 리눅스 서버에선 대소문자가 다르면 다른 폴더다
export const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(s) || s.startsWith("//") ? s.toLowerCase() : s;
};

export type ProjectsData = { source: string | null; entries: ProjectEntry[]; error?: string };

// 맨 위 고정(10-06) — 왼쪽 칸과 전체 화면이 같은 고정 목록을 보도록 바뀌면 서로 알린다
export const pinKey = (e: ProjectEntry) => `${e.host}|${e.path}`;
const pinListeners = new Set<(keys: string[]) => void>();
const announcePins = (keys: string[]) => {
  for (const listener of pinListeners) listener(keys);
};

export function usePins(): { pins: Set<string>; order: string[]; toggle: (key: string) => void; reorder: (keys: string[]) => void } {
  const readPins = useRpc(projectsPins);
  const writePin = useRpc(projectsPinSet);
  const writeOrder = useRpc(projectsPinOrder);
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void readPins({})
      .then((r) => {
        if (alive) setKeys(r.keys);
      })
      .catch(() => {});
    pinListeners.add(setKeys);
    return () => {
      alive = false;
      pinListeners.delete(setKeys);
    };
  }, [readPins]);
  const pins = useMemo(() => new Set(keys), [keys]);
  const toggle = useCallback(
    (key: string) => {
      const pinned = !pins.has(key);
      // 누르자마자 옮기고, 데몬 답으로 맞춘다. 실패하면 되돌린다
      announcePins(pinned ? [...keys, key] : keys.filter((k) => k !== key));
      void writePin({ key, pinned })
        .then((r) => announcePins(r.keys))
        .catch(() => announcePins(keys));
    },
    [pins, keys, writePin],
  );
  // 드래그로 바꾼 순서도 같은 방식 — 바로 옮기고 데몬 답으로 맞춘다
  const reorder = useCallback(
    (next: string[]) => {
      announcePins(next);
      void writeOrder({ keys: next })
        .then((r) => announcePins(r.keys))
        .catch(() => announcePins(keys));
    },
    [keys, writeOrder],
  );
  return { pins, order: keys, toggle, reorder };
}

// 편집 화면에서 저장하면 왼쪽 칸·전체 화면 목록이 같이 다시 읽는다(둘은 데이터를 따로 들고 있다)
const reloaders = new Set<() => void>();
export function notifyProjectsChanged(): void {
  for (const reload of reloaders) reload();
}

export function useProjectsData(): { data: ProjectsData | null; load: () => Promise<void> } {
  const fetchProjects = useRpc(projectsManager);
  const [data, setData] = useState<ProjectsData | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await fetchProjects({}));
    } catch (e) {
      setData({ source: null, entries: [], error: String(e) });
    }
  }, [fetchProjects]);
  useEffect(() => {
    void load();
    const reload = () => void load();
    reloaders.add(reload);
    return () => {
      reloaders.delete(reload);
    };
  }, [load]);
  return { data, load };
}

function useOnlineHosts(): string[] {
  const hosts = useHosts();
  return useMemo(() => hosts.filter((h) => h.status === "online").map((h) => h.serverId).sort(), [hosts]);
}

// 겹치는 경로로는 짝짓지 않는다(10-06 리규형님 결정, Codex 지적) — 같은 경로가 목록의 두 기기에 있거나(꺼 둔 SportedAWS 와
// IVR 서버의 스포티드 API) Paseo 서버 둘에 있으면, 경로만으론 어느 서버인지 모른다. 그런 경로는 서버 찾기에도 별칭 배우기에도
// 쓰지 않고 별칭으로만 찾는다. 별칭도 모르면 연결 없음(주황)으로 보인다
/** byPath: 서버 하나에만 있는 Paseo 프로젝트 경로 → 그 서버 · byAlias: 별칭 → 서버 · shared: 목록에서 두 기기 이상에 걸친 경로 */
export type HostIndex = { byPath: Map<string, string>; byAlias: Map<string, string>; shared: Set<string> };

export function useHostIndex(entries: ProjectEntry[]): HostIndex {
  const online = useOnlineHosts();
  const [paths, setPaths] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      const owners = new Map<string, Set<string>>();
      for (const serverId of online) {
        try {
          const { projects } = await getPaseoClient(serverId).projects.list();
          for (const p of projects) {
            const key = norm(p.projectRootPath);
            owners.set(key, (owners.get(key) ?? new Set()).add(serverId));
          }
        } catch {
          /* 그 호스트는 건너뛴다 */
        }
      }
      const next = new Map<string, string>();
      for (const [key, servers] of owners) if (servers.size === 1) next.set(key, [...servers][0]);
      if (alive) setPaths(next);
    })();
    return () => {
      alive = false;
    };
  }, [online.join(",")]);
  return useMemo(() => {
    const hostsOf = new Map<string, Set<string>>();
    for (const e of entries) {
      const key = norm(e.path);
      hostsOf.set(key, (hostsOf.get(key) ?? new Set()).add(e.host));
    }
    const shared = new Set([...hostsOf].filter(([, hosts]) => hosts.size > 1).map(([key]) => key));
    const byAlias = new Map<string, string>();
    for (const e of entries) {
      const key = norm(e.path);
      if (shared.has(key)) continue;
      const serverId = paths.get(key);
      if (serverId && !byAlias.has(e.host)) byAlias.set(e.host, serverId);
    }
    return { byPath: paths, byAlias, shared };
  }, [paths, entries]);
}

export function serverOf(e: ProjectEntry, index: HostIndex): string | undefined {
  const key = norm(e.path);
  return (index.shared.has(key) ? undefined : index.byPath.get(key)) ?? index.byAlias.get(e.host);
}

// 살아 있는 세션 — 프로젝트 폴더(또는 그 아래)에서 보관 안 된 Paseo 대화. 열린 대화는 Claude 가 늘 떠 있다(rcSync, 10-06 결정)
/** latest: 그 폴더(정확히 같은 경로)에서 가장 최근에 움직인 대화 — 누르면 데몬에 다시 묻지 않고 바로 연다(10-06 리규형님 결정) */
export type Live = { open: number; running: number; latest?: { agentId: string; at: string } };
const LIVE_POLL_MS = 30_000; // 플러그인의 다른 목록과 같은 쉬는 주기(확장 상태바 기본 새로고침 30초)

export function useLiveSessions(): Map<string, Live> {
  const online = useOnlineHosts();
  const [live, setLive] = useState<Map<string, Live>>(new Map());
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const next = new Map<string, Live>();
      for (const serverId of online) {
        try {
          const { entries } = await getPaseoClient(serverId).agents.list({ page: { limit: 200 } });
          for (const { agent } of entries) {
            if (agent.archivedAt || !agent.cwd) continue;
            const key = `${serverId}|${norm(agent.cwd)}`;
            const cur: Live = next.get(key) ?? { open: 0, running: 0 };
            cur.open += 1;
            if (agent.status === "running") cur.running += 1;
            // openProjectOn 과 같은 기준(보관 안 된 것 중 updatedAt 가장 늦은 것). 이미 읽는 목록이라 추가로 묻는 것은 없다
            if (!cur.latest || agent.updatedAt > cur.latest.at) cur.latest = { agentId: agent.id, at: agent.updatedAt };
            next.set(key, cur);
          }
        } catch {
          /* 그 호스트는 이번 차례 건너뛴다 */
        }
      }
      if (alive) setLive(next);
    };
    void read();
    const timer = setInterval(() => void read(), LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [online.join(",")]);
  return live;
}

/** 프로젝트 폴더와 그 아래 폴더에서 도는 대화를 합친다 */
export function liveOf(e: ProjectEntry, serverId: string | undefined, live: Map<string, Live>): Live | null {
  if (!serverId) return null;
  const base = `${serverId}|${norm(e.path)}`;
  let open = 0;
  let running = 0;
  for (const [key, v] of live) {
    if (key === base || key.startsWith(base + "/")) {
      open += v.open;
      running += v.running;
    }
  }
  // 바로 열 대화는 프로젝트 폴더 자체의 것만(데몬에 묻는 openProjectOn 도 그 폴더 작업 공간의 대화만 고른다)
  const latest = live.get(base)?.latest;
  return open ? { open, running, ...(latest ? { latest } : {}) } : null;
}

type Navigation = {
  openAgent(input: { agentId: string; serverId?: string }): void;
  openWorkspace(input: { workspaceId: string; serverId?: string }): void;
};

/** 누르면 바로 대화로(리규형님 10-05): 그 작업 공간의 가장 최근 대화를 연다. 대화가 하나도 없으면 작업 공간 첫 화면 */
export async function openProjectOn(serverId: string, path: string, navigation: Navigation): Promise<void> {
  const api = getPaseoClient(serverId);
  const ws = await api.workspaces.open(path);
  const { entries } = await api.agents.list({ sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 200 } });
  const agent = entries.map((x) => x.agent).find((a) => a.workspaceId === ws.id && !a.archivedAt);
  if (agent) navigation.openAgent({ agentId: agent.id, serverId });
  else navigation.openWorkspace({ workspaceId: ws.id, serverId });
}
