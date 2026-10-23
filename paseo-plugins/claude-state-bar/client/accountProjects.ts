import { getPaseoClient } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { isTeamUsageSource, TEAM_USAGE_SOURCE_ID } from "../shared/account";
import { alertNameOfWorkspace } from "./headerTitles";
import { useOnlineHosts } from "./projectsData";

// 사용량 칸 카드 이름 옆 숫자(10-23 리규형님 "현재 몇 개의 플젝에서 현재 계정을 사용하고 있는지 · 마우스를 오버하면
// Admin DEV, CrewPhoneApp 처럼 현재 사용하고 있는 플젝을 표시"). 붙어 있는 기기마다 대화 목록을 구독해, 보관 안 된 대화의
// 공급자·작업 공간·폴더만 들고 있다가 카드마다 그 계정을 쓰는 프로젝트 이름을 센다.
// 기준은 왼쪽 프로젝트 목록의 대화 수와 같다(보관 안 된 대화 — 지금 도는지는 보지 않는다). 기기는 화면에 붙은 것을 모두 합친다 —
// 계정 한도는 어느 기기에서 쓰든 같이 준다. 카드 표(usageFooter UsageRows)를 펼쳤을 때만 구독한다

/** 사용량 카드 원천 번호 → 그 계정을 쓰는 대화의 Paseo 공급자 이름. 짝을 모르면 null(숫자 칸을 그리지 않는다).
 *  팀 카드 "claude-state-bar-team-<공급자>" 는 끝칸 · 개인 카드(내장 "claude")는 기기마다 이름 없는 기본 Claude 공급자 ·
 *  Codex 카드(내장 "codex")는 Codex 공급자 */
export function agentProviderOfSource(sourceId: string): string | null {
  if (isTeamUsageSource(sourceId)) return sourceId.slice(TEAM_USAGE_SOURCE_ID.length + 1) || null;
  return sourceId === "claude" || sourceId === "codex" ? sourceId : null;
}

export type OpenAgent = { provider: string; workspaceId: string | null; cwd: string };

/** 대화의 공급자 칸은 "claude-hrg" 처럼 공급자만 온다. 모델이 붙은 "claude-hrg/claude-opus-5-5" 모양(CLI 목록)이 와도 앞칸만 본다 */
const providerOf = (raw: unknown): string => String(raw ?? "").split("/")[0];

/** 프로젝트 이름 — 폰·PC 알림 제목과 같은 "이름 - 카테고리"(headerTitles alertNameOfWorkspace). 모르면 폴더 끝 이름 */
export function projectNameOf(agent: OpenAgent, nameOf: (workspaceId: string) => string | null = alertNameOfWorkspace): string {
  const named = agent.workspaceId ? nameOf(agent.workspaceId) : null;
  if (named) return named;
  const parts = agent.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || agent.cwd;
}

/** 그 공급자를 쓰는 열린 대화들의 프로젝트 이름 — 같은 이름은 하나로, 가나다순 */
export function projectsOfProvider(agents: Iterable<OpenAgent>, provider: string, nameOf?: (workspaceId: string) => string | null): string[] {
  const names = new Set<string>();
  for (const a of agents) if (a.provider === provider) names.add(projectNameOf(a, nameOf));
  return [...names].sort((x, y) => x.localeCompare(y));
}

type AgentLike = { id: string; provider?: unknown; cwd?: string | null; workspaceId?: string | null; archivedAt?: string | null };

export function putOpenAgent(agents: Map<string, OpenAgent>, agent: AgentLike): void {
  if (agent.archivedAt || !agent.cwd) agents.delete(agent.id);
  else agents.set(agent.id, { provider: providerOf(agent.provider), workspaceId: agent.workspaceId ?? null, cwd: agent.cwd });
}

const signatureOf = (byHost: Map<string, Map<string, OpenAgent>>): string =>
  [...byHost]
    .flatMap(([host, agents]) => [...agents].map(([id, a]) => `${host}|${id}|${a.provider}|${a.workspaceId ?? ""}|${a.cwd}`))
    .sort()
    .join("\n");

/** 붙어 있는 기기 전부의 열린 대화. 대화가 도는 동안 잦은 상태 알림은 공급자·작업 공간·폴더가 그대로면 다시 그리지 않는다 */
export function useOpenAgents(): OpenAgent[] {
  const online = useOnlineHosts();
  const [agents, setAgents] = useState<OpenAgent[]>([]);
  useEffect(() => {
    let disposed = false;
    const byHost = new Map<string, Map<string, OpenAgent>>();
    const releases: (() => void)[] = [];
    let shown = "";
    const publish = () => {
      if (disposed) return;
      const signature = signatureOf(byHost);
      if (signature === shown) return;
      shown = signature;
      setAgents([...byHost.values()].flatMap((m) => [...m.values()]));
    };
    for (const serverId of online) {
      const agentsOfHost = new Map<string, OpenAgent>();
      byHost.set(serverId, agentsOfHost);
      const fill = (entries: { agent: AgentLike }[]) => {
        agentsOfHost.clear();
        for (const { agent } of entries) putOpenAgent(agentsOfHost, agent);
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
              if (update.kind === "upsert") putOpenAgent(agentsOfHost, update.agent);
              else if (update.kind === "remove") agentsOfHost.delete(update.agentId);
              else return;
              publish();
            },
          });
          releases.push(() => {
            stop();
            void list.subscription.release();
          });
        } catch {
          /* 그 기기는 숫자에서 빠진다 */
        }
      })();
    }
    return () => {
      disposed = true;
      for (const release of releases) release();
    };
  }, [online.join(",")]);
  return agents;
}
