// claude-work-supervisor — 리규형님 전용 비공개 서버 플러그인(10-16 "Mesa 를 쉬지 않게" · docs/paseo-plugin-tools/NONSTOP_IMPL_SPEC.md §5).
// 등록한 대화(claude-work/registry.json)가 할 일이 남았는데 멈추면 기록하고 폰으로 알린다. 자동 깨우기는 리규형님 확인 뒤 켠다(registry autoSend).
// 판단은 server/supervisor.mjs, 상태 파일은 server/workstate.mjs(🔴 claude-rc-relay/workstate.mjs 의 사본 — 배포 때 복사, 직접 고치지 마라).
// 공개 플러그인 claude-state-bar 와 나눈 이유: 좌석 교대·자동 깨우기는 리규형님 운영 정책이라 공개판에 넣지 않는다(기획 §5).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
// @ts-ignore — 같은 폴더의 JS 모듈(esbuild 가 묶는다)
import { createSupervisor } from "./server/supervisor.mjs";
// @ts-ignore
import { createPush } from "./server/push.mjs";
// @ts-ignore
import { isStaffDaemon, paseoHome, workRoot } from "./server/workstate.mjs";

type Snap = { status: string; activeTurn: unknown; pendingPermissions: unknown[]; archivedAt: string | null; workspaceId: string | null; cwd: string };

export default function contribute(server: PluginServerContext) {
  // 직원 데몬(울타리 안 팀원)은 하지 않는다 — claude-state-bar sound.ts isTeamDaemon 과 같은 판정(정본 workstate.mjs isStaffDaemon)
  if (isStaffDaemon(process.env)) return () => {};
  const home = paseoHome(process.env);
  const log = (message: string) => console.log(`[supervisor] ${message}`);
  // 플러그인 프로세스에 하나뿐인 Paseo 연결 — 훅마다 같은 것이 온다(서버 plugin-process.js). 첫 훅에서 받아 둔다
  let paseo: any = null;
  const keep = (context: any) => { if (context?.paseo) paseo = context.paseo; };
  // 아직 훅이 한 번도 안 왔을 때(플러그인이 막 다시 뜸) 상태는 paseo 명령으로 읽는다
  const cli = () => { const beside = join(dirname(process.execPath), "paseo"); return existsSync(beside) ? beside : "paseo"; };
  const inspect = (id: string) => new Promise<Snap | null>((resolve) => {
    execFile(cli(), ["inspect", id, "--json"], { timeout: 20_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const j = JSON.parse(String(stdout));
        resolve({ status: String(j.Status ?? "").toLowerCase(), activeTurn: null, pendingPermissions: Array.isArray(j.PendingPermissions) ? j.PendingPermissions : [],
          archivedAt: j.ArchivedAt ?? null, workspaceId: null, cwd: String(j.Cwd ?? "") });
      } catch { resolve(null); }
    });
  });
  const api = {
    async snapshot(id: string): Promise<Snap | null> {
      if (!paseo) return inspect(id);
      const handle = paseo.agents.ref(id);
      await handle.refresh();
      const s = handle.current();
      return s ? { status: s.status, activeTurn: s.activeTurn ?? null, pendingPermissions: s.pendingPermissions ?? [], archivedAt: s.archivedAt ?? null,
        workspaceId: s.workspaceId ?? null, cwd: s.cwd ?? "" } : null;
    },
    async timeline(id: string): Promise<unknown[]> {
      if (!paseo) return [];
      const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 60, projection: "canonical" });
      return Array.isArray(page?.entries) ? page.entries.map((e: any) => e?.item).filter(Boolean) : [];
    },
    async send(id: string, text: string, options: Record<string, unknown>) {
      if (!paseo) throw new Error("no paseo connection yet"); // 결과 모름으로 남고 다시 보내지 않는다
      await paseo.agents.ref(id).send(text, options);
    },
    // 권한 창·질문지 자동 거절(5분 무응답 — 리규형님 10-16) — 이유는 Claude 에게 간다. paseo 명령으로 한다(플러그인 연결이 없어도 된다)
    deny: (id: string, requestId: string, message: string) => new Promise<void>((resolve, reject) => {
      execFile(cli(), ["permit", "deny", id, requestId, "--message", message], { timeout: 20_000, windowsHide: true },
        (error) => (error ? reject(error) : resolve()));
    }),
  };
  const supervisor = createSupervisor({ root: workRoot(), api, push: createPush({ home, log }), log });
  const guard = (work: () => unknown) => {
    try { void Promise.resolve(work()).catch((error: unknown) => log(`hook failed: ${String(error)}`)); }
    catch (error) { log(`hook failed: ${String(error)}`); }
  };
  const stops = [
    server.on("agent.turn_started", (event, context) => { keep(context); guard(() => supervisor.onTurnStarted(event)); }),
    server.on("agent.turn_ended", (event, context) => { keep(context); guard(() => supervisor.onTurnEnded(event)); }),
    server.on("agent.permission_requested", (event, context) => { keep(context); guard(() => supervisor.onPermission(event)); }),
    server.on("agent.permission_resolved", (event, context) => { keep(context); guard(() => supervisor.onPermission(event)); }),
    server.on("agent.archived", (event, context) => { keep(context); guard(() => supervisor.onArchived(event)); }),
  ];
  supervisor.start();
  log("started");
  return () => {
    for (const stop of stops) stop();
    supervisor.stop();
    paseo = null;
  };
}
