import { getPaseoClient } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { accountsWait, isTeamUsageSource, TEAM_USAGE_SOURCE_ID } from "../shared/account";
import { alertNameOfWorkspace } from "./projects/headerTitles";
import { useOnlineHosts } from "./projects/projectsData";
import { soundOrigin, watchSoundOrigins } from "./presentation/soundScreen";

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

/**
 * 기기별 대화 목록에 계정 전환을 입힌다(10-24 리규형님 — Mesa 하위 둘을 알약으로 hhs·hyj 로 바꿨는데 숫자는 como 에 셌다).
 * 알약으로 바꾼 계정은 Paseo 대화의 공급자 칸이 아니라 그 기기 플러그인 기록(server/account accounts.json)에만 남는다 — 알약과 같은 기준.
 * 값은 서버가 이미 공급자 이름으로 바꿔 준다(옛 값 이행 normalizeProvider · 원래 공급자로 되돌린 대화는 빠진다)
 */
export function withSwitched(byHost: Map<string, Map<string, OpenAgent>>, switched: Map<string, Record<string, string>>): OpenAgent[] {
  return [...byHost].flatMap(([host, agents]) => {
    const to = switched.get(host) ?? {};
    return [...agents].map(([id, a]) => (to[id] ? { ...a, provider: to[id] } : a));
  });
}

const signatureOf = (byHost: Map<string, Map<string, OpenAgent>>, switched: Map<string, Record<string, string>>): string =>
  [...byHost]
    .flatMap(([host, agents]) => [...agents].map(([id, a]) => `${host}|${id}|${switched.get(host)?.[id] ?? a.provider}|${a.workspaceId ?? ""}|${a.cwd}`))
    .sort()
    .join("\n");

/** 계정 전환 기록을 못 받은 기기(옛 판 플러그인·잠깐 끊김)를 다시 묻는 간격 */
const SWITCH_RETRY_MS = 30_000;

/** 붙어 있는 기기 전부의 열린 대화. 대화가 도는 동안 잦은 상태 알림은 공급자·작업 공간·폴더가 그대로면 다시 그리지 않는다 */
export function useOpenAgents(): OpenAgent[] {
  const online = useOnlineHosts();
  const [agents, setAgents] = useState<OpenAgent[]>([]);
  useEffect(() => {
    let disposed = false;
    const byHost = new Map<string, Map<string, OpenAgent>>();
    // 기기별 계정 전환 기록(대화 번호 → 바꾼 계정)
    const switched = new Map<string, Record<string, string>>();
    const releases: (() => void)[] = [];
    let shown = "";
    const publish = () => {
      if (disposed) return;
      const signature = signatureOf(byHost, switched);
      if (signature === shown) return;
      shown = signature;
      setAgents(withSwitched(byHost, switched));
    };
    for (const serverId of online) {
      // 그 기기의 계정 전환 기록 — 바뀔 때까지 기다렸다 답이 온다(길어도 25초, 알약과 같은 요청). 플러그인 연결이 아직이면 붙기를 기다린다
      void (async () => {
        let rev: number | null = null;
        while (!disposed) {
          const origin = soundOrigin(serverId);
          if (!origin) {
            await new Promise<void>((resolve) => {
              let finished = false;
              let stop: (() => void) | null = null;
              const done = () => {
                if (finished) return;
                finished = true;
                stop?.();
                resolve();
              };
              stop = watchSoundOrigins(() => {
                if (disposed || soundOrigin(serverId)) done();
              });
              if (soundOrigin(serverId)) done();
              releases.push(done);
            });
            continue;
          }
          try {
            const r: { rev: number; accounts: Record<string, string> } = await origin.rpc(accountsWait, { rev });
            if (disposed) return;
            rev = r.rev;
            switched.set(serverId, r.accounts);
            publish();
          } catch {
            await new Promise((resolve) => setTimeout(resolve, SWITCH_RETRY_MS));
          }
        }
      })();
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
