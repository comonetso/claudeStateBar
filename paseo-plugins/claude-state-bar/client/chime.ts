import type { PluginClientContext } from "@getpaseo/plugin/client";
import { chimeCheck, chimeForget } from "../shared/chime";

// Claude 대화가 움직일 때마다 데몬에 "새로 끝난 묶음이 있나"를 묻는다. 정해진 주기는 없다.
// 백그라운드 작업이나 워크플로우가 끝나면 Claude Code 가 대화를 깨우므로 그때 움직임이 생기고,
// 서브에이전트가 4초 정착을 기다리는 중이면 데몬이 알려 준 남은 시간 뒤에 한 번 더 묻는다.
// 같은 대화에 묻는 중이면 겹쳐 묻지 않고, 끝난 뒤 한 번만 다시 묻는다.
export interface ChimeWatcher {
  poke(sessionId: string, cwd?: string): void;
  dispose(): void;
}

export function createChimeWatcher(
  client: PluginClientContext,
  onChime: (sessionId: string, count: number) => void,
  log: (message: string) => void,
): ChimeWatcher {
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const busy = new Set<string>();
  const again = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cwds = new Map<string, string>();
  let disposed = false;

  const run = async (sessionId: string) => {
    busy.add(sessionId);
    try {
      const cwd = cwds.get(sessionId);
      const result = await client.rpc(chimeCheck, { clientId, sessionId, ...(cwd ? { cwd } : {}) });
      if (disposed) return;
      if (result.chimes > 0) onChime(sessionId, result.chimes);
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

  const poke = (sessionId: string, cwd?: string) => {
    if (disposed) return;
    if (cwd) cwds.set(sessionId, cwd);
    if (busy.has(sessionId)) {
      again.add(sessionId);
      return;
    }
    void run(sessionId);
  };

  return {
    poke,
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      void client.rpc(chimeForget, { clientId }).catch(() => {});
    },
  };
}
