import type { PluginClientContext } from "@getpaseo/plugin/client";
import { pushCompactWait } from "../shared/presentation/push";
import { hostInfo } from "../shared/presentation/sound";

// 압축 준비 아이콘(10-15 리규형님 "프로젝트 매니저에 질문지 올라올 때 ? 넣듯이") — 데몬마다 압축 명령어를 기다리는 대화를
// 그 데몬의 푸시 판정(server/presentation/push.ts)에서 받는다. 플러그인 RPC 는 자기 데몬에만 닿아서, 호스트마다 도는 인스턴스가 받아
// 화면 공용 게시판에 올리고 프로젝트 목록(projectsData useLiveSessions)이 읽는다 — claudeLogin.tsx 의 hub 와 같은 방식
type Hub = { hosts: Map<string, { owner: object; ids: Set<string> }>; listeners: Set<() => void> };

function hub(): Hub {
  const g = globalThis as { __claudeStateBar_compactReady_v1?: Hub };
  return (g.__claudeStateBar_compactReady_v1 ??= { hosts: new Map(), listeners: new Set() });
}

const notify = () => {
  for (const listener of hub().listeners) listener();
};

/** 압축 명령어를 기다리는 대화인가 */
export function isCompactReady(serverId: string, agentId: string): boolean {
  return hub().hosts.get(serverId)?.ids.has(agentId) === true;
}

export function onCompactReady(listener: () => void): () => void {
  hub().listeners.add(listener);
  return () => hub().listeners.delete(listener);
}

/** onQuestionRepeat = 답하지 않은 질문을 다시 울릴 때(10-24 리규형님 "5분마다, 누를 때까지") — 같은 대기 요청에 실려 온다.
 *  화면을 막 열었을 때 받은 목록은 기준선이다(그때 떠 있던 회차는 울리지 않고 다음 회차부터) — 질문 소리 판정(judge.ts)의 처음 관찰과 같은 뜻 */
export function startCompactReady(client: PluginClientContext, log: (message: string) => void, onQuestionRepeat?: (agentId: string, nativeId: string) => void): () => void {
  let disposed = false;
  let serverId = "";
  const owner = {};
  let rung: Set<string> | null = null;
  void (async () => {
    try {
      serverId = (await client.rpc(hostInfo, {})).serverId ?? "";
    } catch (error) {
      log(`compact ready host: ${String(error)}`);
    }
    if (disposed || !serverId) return;
    let rev: number | null = null;
    let failed = false;
    while (!disposed) {
      try {
        const r: { rev: number; agentIds: string[]; questionRepeats?: { agentId: string; nativeId: string }[] } = await client.rpc(pushCompactWait, { rev });
        if (disposed) return;
        rev = r.rev;
        failed = false;
        const before = hub().hosts.get(serverId)?.ids;
        const ids = new Set(r.agentIds);
        hub().hosts.set(serverId, { owner, ids });
        if (!before || before.size !== ids.size || [...ids].some((id) => !before.has(id))) notify();
        const now = new Set((r.questionRepeats ?? []).map((q) => `${q.agentId} ${q.nativeId}`));
        if (rung && onQuestionRepeat) {
          for (const q of r.questionRepeats ?? []) {
            if (rung.has(`${q.agentId} ${q.nativeId}`)) continue;
            log(`question repeat ${q.agentId.slice(0, 8)} ${q.nativeId}`);
            onQuestionRepeat(q.agentId, q.nativeId);
          }
        }
        rung = now;
      } catch (error) {
        // 이 기능이 없는 옛 데몬이면 계속 실패한다 — 한 번만 남긴다(claudeLogin.tsx 와 같이 5초 뒤 다시)
        if (!failed) log(`compact ready wait: ${String(error)}`);
        failed = true;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();
  return () => {
    disposed = true;
    if (serverId && hub().hosts.get(serverId)?.owner === owner) {
      hub().hosts.delete(serverId);
      notify();
    }
  };
}
