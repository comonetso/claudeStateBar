import type { PluginClientContext } from "@getpaseo/plugin/client";
import { chimeCheckV2, chimeForget } from "../shared/chime";

// Claude 대화가 움직일 때마다 데몬에 "새로 끝난 묶음이 있나"를 묻는다. 정해진 주기는 없다.
// 백그라운드 작업이나 워크플로우가 끝나면 Claude Code 가 대화를 깨우므로 그때 움직임이 생기고,
// 서브에이전트가 4초 정착을 기다리는 중이면 데몬이 알려 준 남은 시간 뒤에 한 번 더 묻는다.
// 같은 대화에 묻는 중이면 겹쳐 묻지 않고, 끝난 뒤 한 번만 다시 묻는다.
export interface ChimeWatcher {
  poke(sessionId: string, cwd?: string, initial?: boolean): void;
  remove(sessionId: string): void;
  dispose(): void;
}

export function createChimeWatcher(
  client: PluginClientContext,
  onChime: (sessionId: string, events: string[]) => void,
  log: (message: string) => void,
): ChimeWatcher {
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const busy = new Set<string>();
  const again = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cwds = new Map<string, string>();
  const versions = new Map<string, number>();
  const baselines = new Set<string>();
  let disposed = false;

  const run = async (sessionId: string) => {
    const version = versions.get(sessionId) ?? 0;
    const baseline = baselines.delete(sessionId);
    busy.add(sessionId);
    try {
      const cwd = cwds.get(sessionId);
      const result = await client.rpc(chimeCheckV2, { clientId, sessionId, baseline, ...(cwd ? { cwd } : {}) });
      if (disposed || version !== (versions.get(sessionId) ?? 0)) return;
      if (result.events.length > 0) onChime(sessionId, result.events);
      if (result.recheckAfterMs !== undefined) {
        const existing = timers.get(sessionId);
        if (existing) clearTimeout(existing);
        timers.set(
          sessionId,
          setTimeout(() => {
            timers.delete(sessionId);
            poke(sessionId);
          }, result.recheckAfterMs),
        );
      }
    } catch (error) {
      log(`chime check ${sessionId} failed: ${String(error)}`);
    } finally {
      busy.delete(sessionId);
      if (again.delete(sessionId) && !disposed) void run(sessionId);
    }
  };

  const poke = (sessionId: string, cwd?: string, initial = false) => {
    if (disposed) return;
    if (initial) { versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1); baselines.add(sessionId); }
    if (cwd) cwds.set(sessionId, cwd);
    if (busy.has(sessionId)) {
      again.add(sessionId);
      return;
    }
    void run(sessionId);
  };

  return {
    poke,
    remove(sessionId) {
      versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
      const timer = timers.get(sessionId); if (timer) clearTimeout(timer);
      timers.delete(sessionId); cwds.delete(sessionId); again.delete(sessionId); baselines.delete(sessionId);
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      void client.rpc(chimeForget, { clientId }).catch(() => {});
    },
  };
}
