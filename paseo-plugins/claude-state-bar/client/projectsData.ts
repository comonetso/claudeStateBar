import { getPaseoClient, useHosts, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { projectsManager, projectsOrder, projectsOrderSet, projectsPinOrder, projectsPinSet, projectsPins, projectsWait, type ProjectEntry } from "../shared/projects";
import { agentBucket, mostUrgent, type StatusBucket } from "./statusIndicator";
import { canOpenWorkspaceFile, currentWorkspaceFromUrl, markWorkspaceInteraction, openWorkspaceFile, watchLocation } from "./web";

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
export const announcePins = (keys: string[]) => {
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

// 묶음 안 순서(10-07) — 고정과 같은 방식. 왼쪽 칸과 전체 화면이 같은 순서를 보도록 바뀌면 서로 알린다
type GroupOrders = Record<string, string[]>;
const orderListeners = new Set<(groups: GroupOrders) => void>();
export const announceOrders = (groups: GroupOrders) => {
  for (const listener of orderListeners) listener(groups);
};

export function useGroupOrders(): { orders: GroupOrders; setOrder: (group: string, keys: string[]) => void } {
  const readOrders = useRpc(projectsOrder);
  const writeOrder = useRpc(projectsOrderSet);
  const [orders, setOrders] = useState<GroupOrders>({});
  useEffect(() => {
    let alive = true;
    void readOrders({})
      .then((r) => {
        if (alive) setOrders(r.groups);
      })
      .catch(() => {});
    orderListeners.add(setOrders);
    return () => {
      alive = false;
      orderListeners.delete(setOrders);
    };
  }, [readOrders]);
  // 바로 옮기고 데몬 답으로 맞춘다. 실패하면 되돌린다
  const setOrder = useCallback(
    (group: string, keys: string[]) => {
      announceOrders({ ...orders, [group]: keys });
      void writeOrder({ group, keys })
        .then((r) => announceOrders(r.groups))
        .catch(() => announceOrders(orders));
    },
    [orders, writeOrder],
  );
  return { orders, setOrder };
}

/**
 * 끌어 놓은 뒤의 저장 순서. 화면에 보이는 줄(visible, 지금 순서)에서 from 을 to 의 위(after=false)·아래로 옮기고,
 * 저장돼 있던 순서(saved)에서 보이는 줄이 차지하던 자리를 새 순서로 채운다 — 지금 안 보이는 줄(활성에서 빠진 것)은
 * 제자리에 남아 다시 들어오면 그 자리로 간다. 저장된 적 없던 줄은 뒤에 붙는다
 */
export function reorderKeys(saved: string[], visible: string[], from: string, to: string, after: boolean): string[] | null {
  const moved = visible.filter((k) => k !== from);
  const at = moved.indexOf(to);
  if (at < 0 || !visible.includes(from)) return null;
  moved.splice(after ? at + 1 : at, 0, from);
  const shown = new Set(visible);
  const queue = [...moved];
  const out = saved.map((k) => (shown.has(k) ? queue.shift()! : k)).filter((k) => k !== undefined);
  return [...out, ...queue];
}

// 편집 화면에서 저장하면 왼쪽 칸·전체 화면 목록이 같이 다시 읽는다(둘은 데이터를 따로 들고 있다)
const reloaders = new Set<() => void>();
export function notifyProjectsChanged(): void {
  for (const reload of reloaders) reload();
}

// 목록 파일 저장 알림을 못 받았을 때 다시 묻기까지 — 설정 맞추기(client/settingsSync RETRY_MS)와 같은 값
const WAIT_RETRY_MS = 30_000;

export function useProjectsData(): { data: ProjectsData | null; load: () => Promise<void> } {
  const fetchProjects = useRpc(projectsManager);
  const waitChange = useRpc(projectsWait);
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
  // Paseo 편집기에서 목록 파일을 저장하면 바로 다시 읽는다(10-07) — 데몬이 파일이 바뀔 때까지 기다렸다 답한다
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let known: number | null | undefined;
      while (!stopped) {
        let r: { mtimeMs: number | null };
        try {
          r = await waitChange({ mtimeMs: known ?? null });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_MS));
          continue;
        }
        if (stopped) return;
        if (known !== undefined && r.mtimeMs !== known) void load();
        known = r.mtimeMs;
      }
    })();
    return () => {
      stopped = true;
    };
  }, [waitChange, load]);
  return { data, load };
}

const PROJECT_LIST_TITLE = "프로젝트 목록";

/** 목록 파일을 열 수 없는 이유(열 수 있으면 null) — 왼쪽 칸이 화면으로 넘기기 전에도 같은 글로 알린다 */
export function projectsFileProblem(serverId: string | undefined, source: string | null): string | null {
  if (!source) return "목록 파일 위치를 아직 모릅니다";
  if (!serverId) return "이 PC 의 Paseo 연결을 아직 찾지 못했습니다";
  return null;
}

/**
 * 목록 파일을 Paseo 편집기 탭으로 연다(10-07 리규형님 결정: 별도 편집 화면 대신 편집기, 전용 폴더를 "프로젝트 목록" 작업 공간으로).
 * 목록 폴더를 작업 공간으로 연 뒤, Paseo 정상 이동에 파일 target을 명시한다. 첫 열기·재열기 모두 파일을 선택하고
 * 중간 화면·주소 열기 지시·가짜 popstate·문서 새로고침을 거치지 않는다. 지원하지 않는 앱 판은 이유를 알린다.
 */
export async function openProjectsFile(
  serverId: string | undefined,
  source: string | null,
): Promise<string | null> {
  const problem = projectsFileProblem(serverId, source);
  if (problem || !serverId || !source) return problem;
  if (!canOpenWorkspaceFile()) return "이 Paseo 화면 판에서는 새로고침 없이 편집기로 열 수 없습니다";
  markWorkspaceInteraction();
  const cut = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  const dir = source.slice(0, cut);
  const file = source.slice(cut + 1);
  try {
    const ws = await getPaseoClient(serverId).workspaces.open(dir);
    if (ws.name !== PROJECT_LIST_TITLE) await ws.setTitle(PROJECT_LIST_TITLE);
    return openWorkspaceFile(serverId, ws.id, file) ? null : "이 Paseo 화면 판에서는 새로고침 없이 편집기로 열 수 없습니다";
  } catch (error) {
    return `목록 파일을 열지 못했습니다: ${String(error)}`;
  }
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
  return useMemo(() => hostIndexOf(entries, paths), [paths, entries]);
}

/** 소리의 상시 게시자와 목록이 같은 호스트 짝짓기 계산을 쓴다. */
export function hostIndexOf(entries: ProjectEntry[], paths: Map<string, string>): HostIndex {
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
}

export function serverOf(e: ProjectEntry, index: HostIndex): string | undefined {
  const key = norm(e.path);
  return (index.shared.has(key) ? undefined : index.byPath.get(key)) ?? index.byAlias.get(e.host);
}

// 살아 있는 세션 — 프로젝트 폴더(또는 그 아래)에서 보관 안 된 Paseo 대화(Claude 가 지금 떠 있는지는 보지 않는다)
/** latest: 그 폴더(정확히 같은 경로)에서 가장 최근에 움직인 대화 — 누르면 데몬에 다시 묻지 않고 바로 연다(10-06 리규형님 결정) */
/** bucket: 그 폴더 대화들 중 가장 급한 상태(Paseo 워크스페이스 목록과 같은 표시, statusIndicator) */
/** asking: 질문을 올려 답을 기다리는 대화 수(10-09) */
export type Live = { open: number; running: number; asking: number; bucket: StatusBucket; latest?: { agentId: string; at: string } };

// 처음엔 30초마다 목록을 다시 물어 초록 점이 최대 30초 늦었다(리규형님 10-07 "너무 늦게 바뀜"). 이제 호스트마다 대화 목록을
// 구독해, 대화 상태가 바뀔 때마다 오는 알림(agent_update: 바뀐 대화 통째 또는 지운 대화 id)으로 바로 고친다.
// 다시 연결되면 구독이 새 목록(스냅샷)을 주므로 그걸로 통째로 맞춘다
type AgentLike = {
  id: string;
  cwd: string;
  status: string;
  updatedAt: string;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
};
type AgentState = { cwd: string; running: boolean; bucket: StatusBucket; updatedAt: string; asking: boolean };

/**
 * Claude 가 질문을 올려 답을 기다리는가(10-09 리규형님 "질문이 올라온 세션을 활성 줄에 질문 아이콘으로").
 * Paseo 는 Claude 의 AskUserQuestion 을 권한 대기의 한 종류(kind "question", @getpaseo/protocol AgentPermissionRequestKind ·
 * 데몬 providers/claude/agent.js)로 올린다 — 권한 승인 대기(tool 등)와 갈라 본다
 */
function isAsking(agent: AgentLike): boolean {
  return (agent.pendingPermissions ?? []).some((p) => (p as { kind?: unknown } | null)?.kind === "question");
}

function putAgent(agents: Map<string, AgentState>, agent: AgentLike): void {
  if (agent.archivedAt || !agent.cwd) agents.delete(agent.id);
  else agents.set(agent.id, { cwd: agent.cwd, running: agent.status === "running", bucket: agentBucket(agent), updatedAt: agent.updatedAt, asking: isAsking(agent) });
}

function liveFrom(byHost: Map<string, Map<string, AgentState>>): Map<string, Live> {
  const next = new Map<string, Live>();
  for (const [serverId, agents] of byHost) {
    for (const [agentId, agent] of agents) {
      const key = `${serverId}|${norm(agent.cwd)}`;
      const cur: Live = next.get(key) ?? { open: 0, running: 0, asking: 0, bucket: "done" };
      cur.open += 1;
      if (agent.running) cur.running += 1;
      if (agent.asking) cur.asking += 1;
      cur.bucket = mostUrgent(cur.bucket, agent.bucket);
      // openProjectOn 과 같은 기준(보관 안 된 것 중 updatedAt 가장 늦은 것). 이미 받은 목록이라 추가로 묻는 것은 없다
      if (!cur.latest || agent.updatedAt > cur.latest.at) cur.latest = { agentId, at: agent.updatedAt };
      next.set(key, cur);
    }
  }
  return next;
}

/** 화면에 보이는 것(점 색·대화 수·바로 열 대화)이 같으면 다시 그리지 않는다 — 대화가 도는 동안 알림이 잦다 */
function liveSignature(live: Map<string, Live>): string {
  return [...live].map(([k, v]) => `${k}:${v.open}:${v.running}:${v.asking}:${v.bucket}:${v.latest?.agentId ?? ""}`).sort().join("\n");
}

export function useLiveSessions(): Map<string, Live> {
  const online = useOnlineHosts();
  const [live, setLive] = useState<Map<string, Live>>(new Map());
  useEffect(() => {
    let disposed = false;
    const byHost = new Map<string, Map<string, AgentState>>();
    const releases: (() => void)[] = [];
    let shown = "";
    const publish = () => {
      if (disposed) return;
      const next = liveFrom(byHost);
      const signature = liveSignature(next);
      if (signature === shown) return;
      shown = signature;
      setLive(next);
    };
    for (const serverId of online) {
      const agents = new Map<string, AgentState>();
      byHost.set(serverId, agents);
      const fill = (entries: { agent: AgentLike }[]) => {
        agents.clear();
        for (const { agent } of entries) putAgent(agents, agent);
        publish();
      };
      void (async () => {
        try {
          const list = await getPaseoClient(serverId).agents.list({ subscribe: {}, page: { limit: 200 } });
          if (disposed) {
            void list.subscription.release();
            return;
          }
          fill(list.entries);
          const stop = list.subscription.subscribe({
            snapshot: (snapshot) => fill(snapshot.entries),
            update: (message) => {
              if (message.type !== "agent_update") return;
              const update = message.payload;
              if (update.kind === "upsert") putAgent(agents, update.agent);
              else if (update.kind === "remove") agents.delete(update.agentId);
              else return;
              publish();
            },
          });
          releases.push(() => {
            stop();
            void list.subscription.release();
          });
        } catch {
          /* 그 호스트는 점 없이 둔다 */
        }
      })();
    }
    return () => {
      disposed = true;
      for (const release of releases) release();
    };
  }, [online.join(",")]);
  return live;
}

/**
 * 이 화면(브라우저 탭)이 지금 보고 있는 작업 공간의 폴더(10-07 리규형님: 탭을 나눠 여러 프로젝트를 볼 때 지금 탭의 프로젝트를
 * 목록에서 녹색으로). 주소의 작업 공간 id 로 그 서버에 한 번 묻고, 주소가 바뀔 때만 다시 묻는다. 폰 앱은 null
 */
export function useCurrentWorkspaceDir(): { serverId: string; directory: string } | null {
  const [loc, setLoc] = useState(currentWorkspaceFromUrl);
  useEffect(() => watchLocation(() => setLoc(currentWorkspaceFromUrl())), []);
  const [dir, setDir] = useState<{ serverId: string; directory: string } | null>(null);
  const serverId = loc?.serverId;
  const workspaceId = loc?.workspaceId;
  useEffect(() => {
    if (!serverId || !workspaceId) {
      setDir(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const api = getPaseoClient(serverId);
        let cursor: string | null = null;
        do {
          const page: { entries: { id: string; workspaceDirectory: string }[]; pageInfo: { nextCursor: string | null; hasMore: boolean } } =
            await api.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
          const hit = page.entries.find((w) => w.id === workspaceId);
          if (hit) {
            if (alive) setDir({ serverId, directory: hit.workspaceDirectory });
            return;
          }
          cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
        } while (cursor && alive);
        if (alive) setDir(null);
      } catch {
        if (alive) setDir(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [serverId, workspaceId]);
  return dir;
}

/**
 * 지금 작업 공간 폴더에 해당하는 프로젝트 키 하나 — 그 폴더와 같거나 그 폴더를 품은 프로젝트 중 경로가 가장 긴 것
 * (프로젝트 안에 하위 프로젝트가 있으면 더 가까운 쪽만 녹색)
 */
export function currentProjectKey(entries: ProjectEntry[], index: HostIndex, current: { serverId: string; directory: string } | null): string | null {
  if (!current) return null;
  const dir = norm(current.directory);
  let best: ProjectEntry | null = null;
  for (const e of entries) {
    if (serverOf(e, index) !== current.serverId) continue;
    const p = norm(e.path);
    if ((dir === p || dir.startsWith(p + "/")) && (!best || p.length > norm(best.path).length)) best = e;
  }
  return best ? pinKey(best) : null;
}

/** 프로젝트 폴더와 그 아래 폴더에서 도는 대화를 합친다 */
export function liveOf(e: ProjectEntry, serverId: string | undefined, live: Map<string, Live>): Live | null {
  if (!serverId) return null;
  const base = `${serverId}|${norm(e.path)}`;
  let open = 0;
  let running = 0;
  let asking = 0;
  let bucket: StatusBucket = "done";
  for (const [key, v] of live) {
    if (key === base || key.startsWith(base + "/")) {
      open += v.open;
      running += v.running;
      asking += v.asking;
      bucket = mostUrgent(bucket, v.bucket);
    }
  }
  // 바로 열 대화는 프로젝트 폴더 자체의 것만(데몬에 묻는 openProjectOn 도 그 폴더 작업 공간의 대화만 고른다)
  const latest = live.get(base)?.latest;
  return open ? { open, running, asking, bucket, ...(latest ? { latest } : {}) } : null;
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
