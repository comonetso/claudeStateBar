import {
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { currentSettings } from "./sounds";
import { isCompactWidth, watchCompactWidth } from "./web";

// 대화마다 입력창 위 알약 줄(할 일·서브에이전트 단추 옆)에 "컨텍스트 N%"를 늘 보인다(리규형님 10-05: 컨텍스트 사용량을 숫자로
// 바로 보고 싶다 — 확장 상태바의 % 자리). 값은 Paseo 가 대화마다 주는 lastUsage 그대로다 — 경고·위험 소리(judge.ts)와 같은
// 숫자라 알약이 기준을 넘는 순간과 소리가 어긋나지 않는다. 기준(경고·위험 %)도 소리 설정 값을 같이 쓴다.

type Usage = { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null | undefined;
type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null; model?: string | null; lastUsage?: Usage };

// 플러그인용 대화 정보(useAgent)에는 사용량이 없어, 대화 목록 구독에서 받은 값을 여기 두고 알약 아이콘·자세히가 읽는다
const latest = new Map<string, { usage: Usage; model: string | null }>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
function useLatest(agentId: string) {
  return useSyncExternalStore(subscribe, () => latest.get(agentId), () => latest.get(agentId));
}
const agentOf = (props: { context: "workspace" | "agent"; agentId?: string }) => (props.context === "agent" ? (props.agentId ?? "") : "");

function percentOf(usage: Usage): number | undefined {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (typeof used !== "number" || typeof max !== "number" || max <= 0) return undefined;
  return (used / max) * 100;
}

const levelColor = (pct: number | undefined, theme: PluginButtonIconProps["theme"], fallback: string) => {
  if (pct === undefined) return fallback;
  const s = currentSettings();
  return pct >= s.dangerPercent ? theme.colors.statusDanger : pct >= s.warningPercent ? theme.colors.statusWarning : fallback;
};

function ContextIcon(props: PluginButtonIconProps) {
  const now = useLatest(agentOf(props as { context: "workspace" | "agent"; agentId?: string }));
  return <Icon name="Gauge" size={props.size} color={levelColor(percentOf(now?.usage), props.theme, props.color)} />;
}

function ContextDetail(props: PluginButtonContentProps) {
  const { theme } = props;
  const now = useLatest(agentOf(props as { context: "workspace" | "agent"; agentId?: string }));
  const usage = now?.usage;
  const model = now?.model ?? null;
  const pct = percentOf(usage);
  const c = theme.colors;
  const s = currentSettings();
  const fmt = (n: number | undefined) => (typeof n === "number" ? n.toLocaleString() : "—");
  return (
    <View style={{ padding: 12, gap: 6, minWidth: 220 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>컨텍스트 {pct === undefined ? "—" : `${pct.toFixed(1)}%`}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {fmt(usage?.contextWindowUsedTokens)} / {fmt(usage?.contextWindowMaxTokens)} 토큰{model ? ` · ${model}` : ""}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        경고 {s.warningPercent}% · 위험 {s.dangerPercent}% (소리 설정과 같은 기준)
      </Text>
    </View>
  );
}

const pctText = (pct: number) => (pct < 1 ? "<1" : String(Math.round(pct)));

/** 대화 목록 구독에서 넘어오는 대화마다 알약을 붙이고 숫자를 고친다. 사용량이 아직 없는 대화(첫 응답 전)는 붙이지 않는다 */
export function createContextPills(client: PluginClientContext, log: (message: string) => void) {
  const pills = new Map<string, { reg: PluginButtonRegistration; label: string }>();
  // 좁은 화면(폰 모양)은 아이콘 옆에 숫자만 "59%"(10-08 리규형님 "모바일에는 아이콘만" → "컨텍스트는 아이콘 옆에 %만"),
  // 넓은 화면은 "컨텍스트 59%". 알약에는 숫자 글자(pctText)를 기억해 두고 화면 폭이 바뀌면 다시 그린다
  const shown = (pct: string) => (isCompactWidth() ? `${pct}%` : `컨텍스트 ${pct}%`);
  const stopWidth = watchCompactWidth(() => {
    for (const p of pills.values()) p.reg.update({ label: shown(p.label) });
  });
  // 진단: 대화마다 한 번만 "붙였다/왜 건너뛰었다"를 남긴다(10-05 알약이 안 보인다는 보고 — 원인 확인용)
  const told = new Set<string>();
  const tell = (agentId: string, why: string) => {
    if (told.has(`${agentId}|${why}`)) return;
    told.add(`${agentId}|${why}`);
    log(`context pill ${agentId.slice(0, 8)}: ${why}`);
  };

  const drop = (agentId: string) => {
    pills.get(agentId)?.reg.remove();
    pills.delete(agentId);
    if (latest.delete(agentId)) for (const fn of listeners) fn();
  };

  const observe = (agent: AgentLike) => {
    if (agent.archivedAt) return drop(agent.id);
    const pct = percentOf(agent.lastUsage);
    if (pct === undefined) return tell(agent.id, `no usage yet (used=${agent.lastUsage?.contextWindowUsedTokens ?? "-"} max=${agent.lastUsage?.contextWindowMaxTokens ?? "-"})`);
    if (!agent.workspaceId) return tell(agent.id, "no workspaceId");
    const prev = latest.get(agent.id);
    if (prev?.usage?.contextWindowUsedTokens !== agent.lastUsage?.contextWindowUsedTokens || prev?.usage?.contextWindowMaxTokens !== agent.lastUsage?.contextWindowMaxTokens || prev?.model !== (agent.model ?? null)) {
      latest.set(agent.id, { usage: agent.lastUsage, model: agent.model ?? null });
      for (const fn of listeners) fn();
    }
    const label = pctText(pct);
    const title = `컨텍스트 사용량 ${pct.toFixed(1)}%`;
    const known = pills.get(agent.id);
    if (known) {
      if (known.label !== label) {
        known.label = label;
        known.reg.update({ label: shown(label), title });
      }
      return;
    }
    try {
      const reg = client.addComposerPill({
        id: "context",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { title, icon: ContextIcon, label: shown(label), behavior: { kind: "popover", Content: ContextDetail } },
      });
      pills.set(agent.id, { reg, label });
      tell(agent.id, `added ws=${agent.workspaceId} ${shown(label)}`);
    } catch (error) {
      log(`context pill ${agent.id}: ${String(error)}`);
    }
  };

  return {
    observe,
    remove: drop,
    dispose: () => {
      stopWidth();
      for (const id of [...pills.keys()]) drop(id);
    },
  };
}
