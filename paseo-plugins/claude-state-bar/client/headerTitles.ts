import type { PluginClientContext } from "@getpaseo/plugin/client";
import { headerTitleApply, headerTitlesWait } from "../shared/headerTitles";
import { norm } from "./projectsData";
import { watchCompactHeader } from "./web";

// 위쪽 제목 "카테고리 - 이름"(리규형님 10-08 결정 — 이미 붙은 작업 공간 제목도 전부 덮고, 새 작업 공간·목록 변경도 자동으로).
// 화면 플러그인은 기기마다 하나씩 올라오고(client.paseo = 그 기기), 각자 자기 기기 작업 공간만 맞춘다. 경로별 제목은 그 기기
// 플러그인 서버가 이름표 파일에서 읽어 주고(바뀌면 바로), 작업 공간 목록은 구독해 새 작업 공간·이름 바뀜을 바로 본다.
// 프로젝트 경로가 목록 경로와 정확히 같은 작업 공간만 — 앞칸(작업 공간 제목)과 뒷칸(프로젝트 이름)을 같은 글로 맞춘다.
// Paseo 는 첫 대화로 작업 공간 제목을 지을 때 이미 붙은 제목은 두므로(workspace-auto-name), 먼저 붙이면 그대로 남는다.
// 같은 것을 한 번 맞춘 뒤로는 이름표가 바뀔 때까지 다시 보내지 않는다(못 바꿨을 때 되풀이하지 않게)

/** 플러그인 서버가 아직 이 요청을 모르거나(옛 판) 끊겼을 때 다시 묻기까지 — 목록 기다리기(projectsData WAIT_RETRY_MS)와 같은 값 */
const WAIT_RETRY_MS = 30_000;

type Ws = { id: string; projectId: string; projectDisplayName: string; projectRootPath: string; name: string; archivingAt?: string | null };

// 폰(좁은 화면) 위 줄 줄이기(web.ts watchCompactHeader)는 화면에 하나만 돈다 — 기기마다 올라오는 플러그인이 같은 실행 공간
// (globalThis)을 쓰므로 기기별 "위쪽 제목 → 이름"을 거기 모은다
type CompactHub = { names: Map<object, Map<string, string>>; stop: (() => void) | null };
function compactHub(): CompactHub {
  const g = globalThis as Record<string, unknown>;
  return (g.__claudeStateBar_compactHeader_v1 ??= { names: new Map(), stop: null }) as CompactHub;
}
function shortOf(full: string): string | null {
  for (const names of compactHub().names.values()) {
    const name = names.get(full);
    if (name) return name;
  }
  return null;
}

// 작업 공간 → Paseo 프로젝트 번호(10-08 소리를 낼 화면 고르기가 쓴다). 기기마다 받은 작업 공간 목록을 globalThis 에 모은다 —
// 작업 공간 번호는 기기가 달라도 겹치지 않는다
type WorkspaceHub = Map<object, Map<string, Ws>>;
function workspaceHub(): WorkspaceHub {
  const g = globalThis as Record<string, unknown>;
  return (g.__claudeStateBar_workspaces_v1 ??= new Map()) as WorkspaceHub;
}
export function projectOfWorkspace(workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  for (const workspaces of workspaceHub().values()) {
    const ws = workspaces.get(workspaceId);
    if (ws) return ws.projectId;
  }
  return null;
}

export function startHeaderTitles(client: PluginClientContext, log: (message: string) => void): () => void {
  const owner = {};
  let stopped = false;
  let titles: Map<string, string> | null = null; // 정리한 경로 → 제목
  const workspaces = new Map<string, Ws>();
  workspaceHub().set(owner, workspaces);
  const done = new Map<string, string>(); // "workspace:<id>" · "project:<id>" → 맞춘 제목
  const busy = new Set<string>();
  const releases: (() => void)[] = [];

  const apply = (kind: "workspace" | "project", id: string, before: string, after: string) => {
    const key = `${kind}:${id}`;
    if (done.get(key) === after || busy.has(key)) return;
    busy.add(key);
    void (async () => {
      try {
        // 서버가 원래 이름을 기록하고, 프로젝트면 이름까지 바꾼다. 작업 공간 제목은 화면 쪽 Paseo 기능으로 바꾼다
        const r = await client.rpc(headerTitleApply, { kind, id, before, after });
        if (kind === "workspace" && r.ok) await client.paseo.workspaces.ref(id).setTitle(after);
        if (!r.ok) log(`header title ${kind} ${id} failed: ${r.out}`);
      } catch (error) {
        log(`header title ${kind} ${id} failed: ${String(error)}`);
      } finally {
        done.set(key, after);
        busy.delete(key);
      }
    })();
  };

  const check = () => {
    if (stopped || !titles) return;
    for (const ws of workspaces.values()) {
      if (ws.archivingAt) continue;
      const want = titles.get(norm(ws.projectRootPath));
      if (!want) continue;
      if (ws.name !== want) apply("workspace", ws.id, ws.name, want);
      if (ws.projectDisplayName !== want) apply("project", ws.projectId, ws.projectDisplayName, want);
    }
  };

  const put = (ws: Ws) => workspaces.set(ws.id, ws);

  // 이름표 — 바뀌면 바로 받는다
  void (async () => {
    let sig: string | null | undefined;
    while (!stopped) {
      let r: { sig: string | null; titles: { path: string; title: string; name: string }[] };
      try {
        r = await client.rpc(headerTitlesWait, { sig: sig ?? null });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_MS));
        continue;
      }
      if (stopped) return;
      if (sig !== undefined && r.sig === sig) continue;
      sig = r.sig;
      titles = new Map(r.titles.map((t) => [norm(t.path), t.title]));
      done.clear();
      check();
      const hub = compactHub();
      hub.names.set(owner, new Map(r.titles.map((t) => [t.title, t.name])));
      hub.stop ??= watchCompactHeader(shortOf);
    }
  })();

  // 이 기기 작업 공간 — 새로 생기거나 이름이 바뀌면 바로 알림이 온다
  void (async () => {
    try {
      const list = await client.paseo.workspaces.list({ subscribe: {}, page: { limit: 200 } });
      if (stopped) {
        void list.subscription.release();
        return;
      }
      const fill = (entries: readonly Ws[]) => {
        workspaces.clear();
        for (const ws of entries) put(ws);
        check();
      };
      fill(list.entries);
      const stop = list.subscription.subscribe({
        snapshot: (snapshot) => fill(snapshot.entries),
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") put(update.workspace);
          else if (update.kind === "remove") workspaces.delete(update.id);
          else return;
          check();
        },
      });
      releases.push(() => {
        stop();
        void list.subscription.release();
      });
    } catch (error) {
      log(`header titles: workspace list failed: ${String(error)}`);
    }
  })();

  return () => {
    stopped = true;
    for (const release of releases) release();
    workspaceHub().delete(owner);
    const hub = compactHub();
    hub.names.delete(owner);
    if (!hub.names.size) {
      hub.stop?.();
      hub.stop = null;
    }
  };
}
