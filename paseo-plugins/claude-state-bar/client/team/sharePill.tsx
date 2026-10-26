import {
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, useSyncExternalStore } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { SHARE_MODE_DEFAULT, SHARE_MODE_LABEL, shareModes, shareSet, shareWait, type ShareMember, type ShareMode } from "../../shared/team/share";
import { agentOf } from "../accountPill";
import { phonePillsShown, watchCompactWidth } from "../web";

// 같이 보기 — 입력창 위 "공유" 알약(10-25 리규형님 결정: 공유 켜는 자리 = 입력창 위 알약 · 대화 하나씩 · 켜진 동안 "공유 중 · 대표님").
// 누르면 볼 팀원을 고르고 켜기·바꾸기·끄기. 이 기기 플러그인이 게이트에 사본을 올린다(server/team/share.ts) — 게이트 길이 없는 기기·팀원 데몬엔 안 붙인다.
// 폰(좁은 화면)은 다른 알약처럼 아이콘만, 공유 중이면 아이콘 색으로.

type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null };
type Snapshot = { available: boolean; reason: string | null; shares: Record<string, string[]>; modes: Record<string, ShareMode>; members: ShareMember[]; errors: Record<string, string> };
const ICON_ONLY = "​";

const views = new Map<string, Snapshot>(); // 대화 → 이 기기 공유 상태(대화 번호는 기기마다 달라 섞이지 않는다)
const setters = new Map<string, (members: string[], mode: ShareMode) => Promise<{ ok: boolean; error?: string }>>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
const notify = () => { for (const fn of listeners) fn(); };
const useView = (agentId: string) => useSyncExternalStore(subscribe, () => views.get(agentId), () => views.get(agentId));
const labelsOf = (s: Snapshot, ids: string[]) => ids.map((id) => s.members.find((m) => m.id === id)?.label ?? id);

function ShareIcon(props: PluginButtonIconProps) {
  const agentId = agentOf(props as { context: "workspace" | "agent"; agentId?: string });
  const s = useView(agentId);
  const on = !!s?.shares[agentId]?.length;
  const color = s?.errors[agentId] ? props.theme.colors.statusWarning : on ? props.theme.colors.accent : props.color;
  return <Icon name="Users" size={props.size} color={color} />;
}

function ShareDetail(props: PluginButtonContentProps) {
  const { theme, close } = props;
  const c = theme.colors;
  const agentId = agentOf(props as { context: "workspace" | "agent"; agentId?: string });
  const s = useView(agentId);
  const current = s?.shares[agentId] ?? [];
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedMode, setPickedMode] = useState<ShareMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!s) return <View style={{ padding: 12, minWidth: 260 }}><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>이 대화는 공유할 수 없습니다.</Text></View>;
  const chosen = picked ?? current;
  // 팀원 답글 보내는 방식(10-25 리규형님 — 공유 버튼에서 팀원 목록과 함께, 기본 바로 보냄)
  const currentMode = s.modes[agentId] ?? SHARE_MODE_DEFAULT;
  const mode = pickedMode ?? currentMode;
  const toggle = (id: string) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const apply = async (members: string[]) => {
    const run = setters.get(agentId);
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    const r = await run(members, mode).catch((e: unknown) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) close();
    else setError(r.error ?? "바꾸지 못했습니다");
  };
  const same = chosen.length === current.length && chosen.every((id) => current.includes(id)) && mode === currentMode;
  const button = (label: string, onPress: () => void, primary: boolean, disabled = false) => (
    <Pressable onPress={onPress} disabled={busy || disabled}
      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : "transparent", opacity: busy || disabled ? 0.5 : 1 }}>
      <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 12, fontWeight: primary ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ padding: 12, gap: 8, minWidth: 260, maxWidth: 360 }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        {current.length ? `공유 중 · ${labelsOf(s, current).join(", ")}` : "이 대화를 팀원과 같이 보기"}
      </Text>
      {s.members.length ? <View style={{ gap: 6 }}>
        {s.members.map((m) => {
          const on = chosen.includes(m.id);
          return (
            <Pressable key={m.id} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: busy }} disabled={busy} onPress={() => toggle(m.id)}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderWidth: 1, borderRadius: 6, borderColor: on ? c.accent : c.border }}>
              <Icon name={on ? "SquareCheck" : "Square"} size={14} color={on ? c.accent : c.foregroundMuted} />
              <Text style={{ color: c.foreground, fontSize: 12 }}>{m.label}{m.label !== m.id ? ` (${m.id})` : ""}</Text>
            </Pressable>
          );
        })}
      </View> : <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>공유할 수 있는 팀원이 없습니다(웹 로그인 등록이 끝난 팀원만).</Text>}
      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600", marginTop: 4 }}>팀원 답글 보내는 방식</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {shareModes.map((m) => {
          const on = mode === m;
          return (
            <Pressable key={m} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: busy }} disabled={busy} onPress={() => setPickedMode(m)}
              style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderWidth: 1, borderRadius: 6, borderColor: on ? c.accent : c.border }}>
              <Icon name={on ? "CircleDot" : "Circle"} size={14} color={on ? c.accent : c.foregroundMuted} />
              <Text style={{ color: c.foreground, fontSize: 12 }}>{SHARE_MODE_LABEL[m]}{m === SHARE_MODE_DEFAULT ? " (기본)" : ""}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        팀원은 웹 화면의 "공유" 묶음에서 사람 말과 Claude 답 글만 봅니다(도구·생각은 안 보임). 팀원 답글은 이 대화 화면에 뜨고,{" "}
        {mode === "direct" ? "바로 Claude 에게 갑니다(대화가 진행 중이면 그 차례가 끝난 뒤)." : "\"대화에 넣기\"를 눌러야 Claude 에게 갑니다."}
      </Text>
      {s.errors[agentId] ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>사본을 못 올리고 있습니다 — {s.errors[agentId]}</Text> : null}
      {error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {current.length ? button("공유 끄기", () => void apply([]), false) : null}
        {button("취소", close, false)}
        {button(busy ? "바꾸는 중…" : current.length ? "바꾸기" : "공유 켜기", () => void apply(chosen), true, !chosen.length || same)}
      </View>
    </View>
  );
}

/** 대화마다 "공유" 알약. 이 기기에 게이트 길(열쇠 push-central.json)이 없으면 붙이지 않는다 — 팀원 데몬도 열쇠가 있으면 붙는다(10-25 명시 지시 5) */
export function createSharePills(client: PluginClientContext, log: (message: string) => void) {
  const pills = new Map<string, { reg: PluginButtonRegistration; title: string; label: string }>();
  const agents = new Map<string, AgentLike>();
  let compact = phonePillsShown();
  let snap: Snapshot = { available: false, reason: null, shares: {}, modes: {}, members: [], errors: {} };
  let rev: number | null = null;
  let disposed = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.reg.remove();
    pills.delete(agentId);
    setters.delete(agentId);
    if (views.delete(agentId)) notify();
  };
  const sync = (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent || agent.archivedAt || !agent.workspaceId || !snap.available) return remove(agentId);
    if (views.get(agentId) !== snap) {
      views.set(agentId, snap);
      notify();
    }
    const ids = snap.shares[agentId] ?? [];
    const names = labelsOf(snap, ids).join(", ");
    const title = ids.length ? `공유 중: ${names}` : "공유 — 팀원이 이 대화를 보게";
    const label = compact ? ICON_ONLY : ids.length ? `공유 중 · ${names}` : "공유";
    const known = pills.get(agentId);
    if (known) {
      if (known.title !== title || known.label !== label) {
        known.title = title;
        known.label = label;
        known.reg.update({ title, label });
      }
      return;
    }
    try {
      const reg = client.addComposerPill({
        id: "share",
        workspaceId: agent.workspaceId,
        agentId,
        button: { title, icon: ShareIcon, label, behavior: { kind: "popover", Content: ShareDetail } },
      } as Parameters<PluginClientContext["addComposerPill"]>[0]);
      pills.set(agentId, { reg, title, label });
      setters.set(agentId, async (members, mode) => {
        const r = await client.rpc(shareSet, { agentId, members, mode });
        log(`share ${agentId.slice(0, 8)} → [${members.join(",")}] ${mode}: ${r.ok ? "ok" : r.error}`);
        return r;
      });
    } catch (error) {
      log(`share pill ${agentId.slice(0, 8)}: ${String(error)}`);
    }
  };

  void (async () => {
    let failed = false;
    while (!disposed) {
      try {
        const r: Snapshot & { rev: number } = await client.rpc(shareWait, { rev });
        if (disposed) return;
        rev = r.rev;
        failed = false;
        snap = { available: r.available, reason: r.reason, shares: r.shares, modes: r.modes ?? {}, members: r.members, errors: r.errors };
        for (const id of agents.keys()) sync(id);
      } catch (error) {
        // 이 기능이 없는 옛 데몬이면 계속 실패한다 — 한 번만 남긴다
        if (!failed) log(`share wait: ${String(error)}`);
        failed = true;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();

  const stopWidth = Platform.OS === "web" ? watchCompactWidth((next) => {
    if (next === compact) return;
    compact = next;
    for (const id of [...agents.keys()]) sync(id);
  }) : () => {};

  return {
    observe(agent: AgentLike) {
      agents.set(agent.id, agent);
      sync(agent.id);
    },
    remove(agentId: string) {
      agents.delete(agentId);
      remove(agentId);
    },
    dispose() {
      disposed = true;
      stopWidth();
      for (const id of [...pills.keys()]) remove(id);
      agents.clear();
    },
  };
}
