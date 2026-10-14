import {
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { accountSwitch, accountsWait, type AccountKind } from "../shared/account";
import { contextUsedTokens } from "./contextPill";

// 입력창 위 "Claude 공급자 바꾸기" 알약(리규형님 10-14 결정): 알약 줄에 두고 모든 화면에서 화살표 아이콘만 보인다. 처음 연 공급자와
// 다르게 바꿨을 때는 아이콘 색(주황)으로만 구분한다(리규형님 "화살표 쪽은 색깔만"). 이름은 "팀·개인"이 아니라 이 기기 Paseo 공급자
// 이름 그대로 — 확인 창과 마우스 도움말에 나온다(리규형님 "다른 사람들을 생각하면 프로바이더 이름을 그대로").
// 문구도 "계정"이 아니라 "공급자를 바꾼다"로 쓴다(리규형님 10-14 — 개인 계정 여러 개를 공급자로 따로 등록하는 사람도 있다).
// 누르면 한 번 더 묻는다 — 다시 뜬 뒤 첫 답에서 대화 전체를 그 계정으로 다시 읽어 한도를 쓰기 때문. 바꾸면 기록만 남기고,
// 실행기가 Claude 를 끈 뒤 다음 말 때 새 계정으로 다시 띄운다(화면 기록은 건드리지 않는다 — 새로 고침은 폰을 멈추게 했다).
// 위쪽 공급자 이름 칸은 건드리지 않는다(리규형님 "빨간 칸은 신경 쓰지 마"). 자동 넘김은 없다(10-10 결정) — 누를 때만 바뀐다.
// 기기마다 그 기기 플러그인이 자기 대화에 붙인다(바꾸기·다시 띄우기는 그 기기 데몬이 한다 — server/account).

const TEAM_PROVIDER = "claude-yeogiaen";
const PERSONAL_PROVIDER = "claude";
type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null; provider?: string | null };
type Names = { team: string; personal: string };
type Info = { base: AccountKind; current: AccountKind; names: Names };

// 옛 서버(이름을 보내지 않음)일 때만 쓰는 이름 — 공급자 번호 그대로
const FALLBACK_NAMES: Names = { team: TEAM_PROVIDER, personal: "Claude" };
const baseOf = (provider: string | null | undefined): AccountKind | null =>
  provider === TEAM_PROVIDER ? "team" : provider === PERSONAL_PROVIDER ? "personal" : null;
// 알약 글자는 폭 없는 공백 한 글자 — Paseo 는 빈 글자 알약을 거절한다(thinkingFoldPill 과 같다). 화면엔 아이콘만 남는다
const ICON_ONLY = "​";

// 아이콘·확인 창이 읽는 대화별 계정 상태(대화 번호가 기기마다 달라 한곳에 둬도 섞이지 않는다)
const infos = new Map<string, Info>();
const switchers = new Map<string, (to: AccountKind) => Promise<{ ok: boolean; error?: string }>>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const notify = () => {
  for (const fn of listeners) fn();
};
const agentOf = (props: { context: "workspace" | "agent"; agentId?: string }) => (props.context === "agent" ? (props.agentId ?? "") : "");
function useInfo(agentId: string) {
  return useSyncExternalStore(subscribe, () => infos.get(agentId), () => infos.get(agentId));
}

function AccountIcon(props: PluginButtonIconProps) {
  const info = useInfo(agentOf(props as { context: "workspace" | "agent"; agentId?: string }));
  const changed = !!info && info.current !== info.base;
  return <Icon name="ArrowLeftRight" size={props.size} color={changed ? props.theme.colors.statusWarning : props.color} />;
}

function AccountDetail(props: PluginButtonContentProps) {
  const { theme, close } = props;
  const c = theme.colors;
  const agentId = agentOf(props as { context: "workspace" | "agent"; agentId?: string });
  const info = useInfo(agentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info) {
    return (
      <View style={{ padding: 12, minWidth: 240 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>이 대화는 Claude 공급자를 바꿀 수 없습니다.</Text>
      </View>
    );
  }
  const { names } = info;
  const to: AccountKind = info.current === "team" ? "personal" : "team";
  const tokens = contextUsedTokens(agentId);
  const press = async () => {
    const run = switchers.get(agentId);
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    const r = await run(to).catch((e: unknown) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) close();
    else setError(r.error ?? "바꾸지 못했습니다");
  };
  const button = (label: string, onPress: () => void, primary: boolean) => (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : "transparent",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 12, fontWeight: primary ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ padding: 12, gap: 8, minWidth: 240, maxWidth: 340 }}>
      {/* 폰은 이 위에 알약 이름("Claude 공급자")을 창 제목으로 한 줄 그린다 — 그 아래 어디서 어디로만(리규형님 10-15) */}
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        {names[info.current]} → {names[to]}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        이 대화의 Claude 를 끄고, 다음 말을 보낼 때 {names[to]} 공급자로 같은 대화를 이어 띄웁니다. 화면 기록은 그대로입니다. 그 첫 답에서 대화 전체
        {tokens !== undefined ? `(약 ${tokens.toLocaleString()} 토큰)` : ""}를 그 공급자로 다시 읽어 그 공급자 계정의 한도를 씁니다. 진행 중인 답변이 있으면 끊깁니다.
      </Text>
      {/* Paseo 는 쉬던 Claude 가 꺼지면 이유와 상관없이 실패 알림을 띄운다(claude/agent.js handleRuntimeExit — 종료 코드를 바꿔도 같다).
          막을 수 없어 미리 알린다(리규형님 10-14 "확인 창 문구만") */}
      <Text style={{ color: c.statusWarning, fontSize: 12 }}>
        바꾸면 "Claude가 예기치 않게 멈췄다(Claude stopped unexpectedly)"는 오류가 한 번 뜹니다. 공급자를 바꾸느라 끈 것이라 정상입니다.
      </Text>
      {error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
        {button("취소", close, false)}
        {button(busy ? "바꾸는 중…" : `${names[to]} 공급자로 바꾸기`, () => void press(), true)}
      </View>
    </View>
  );
}

/** 대화 목록 구독에서 넘어오는 Claude 대화마다 알약을 붙인다. 이 기기에 팀 공급자 설정이 없거나 팀원 데몬이면 붙이지 않는다 */
export function createAccountPills(client: PluginClientContext, log: (message: string) => void) {
  const pills = new Map<string, { reg: PluginButtonRegistration; title: string }>();
  const agents = new Map<string, AgentLike>();
  let supported = false;
  let accounts: Record<string, AccountKind> = {};
  let names: Names = FALLBACK_NAMES;
  let rev: number | null = null;
  let disposed = false;

  const remove = (agentId: string) => {
    pills.get(agentId)?.reg.remove();
    pills.delete(agentId);
    switchers.delete(agentId);
    if (infos.delete(agentId)) notify();
  };

  const sync = (agentId: string) => {
    const agent = agents.get(agentId);
    const base = baseOf(agent?.provider);
    if (!agent || agent.archivedAt || !agent.workspaceId || !base || !supported) return remove(agentId);
    const current = accounts[agentId] ?? base;
    const prev = infos.get(agentId);
    if (prev?.base !== base || prev?.current !== current || prev?.names !== names) {
      infos.set(agentId, { base, current, names });
      notify();
    }
    // 알약 이름 = PC 마우스 도움말 · 폰 아래 창 제목(한 줄로 잘린다). 어디서 어디로는 창 첫 줄에 쓴다 — "원래 ~" 는 빼라(리규형님 10-15
    // "'Claude 공급자' 하고 밑으로 'Claude → Claude'")
    const title = "Claude 공급자";
    const known = pills.get(agentId);
    if (known) {
      if (known.title !== title) {
        known.title = title;
        known.reg.update({ title, label: ICON_ONLY });
      }
      return;
    }
    try {
      const reg = client.addComposerPill({
        id: "account",
        workspaceId: agent.workspaceId,
        agentId,
        button: { title, icon: AccountIcon, label: ICON_ONLY, behavior: { kind: "popover", Content: AccountDetail } },
      });
      pills.set(agentId, { reg, title });
      switchers.set(agentId, async (to) => {
        const r = await client.rpc(accountSwitch, { agentId, to });
        log(`account ${agentId.slice(0, 8)} → ${to}: ${r.ok ? "ok" : r.error}`);
        return r;
      });
    } catch (error) {
      log(`account pill ${agentId.slice(0, 8)}: ${String(error)}`);
    }
  };

  // 이 기기에서 계정을 바꾼 대화 목록을 따라간다(다른 화면에서 바꿔도 여기 알약이 맞춰진다)
  void (async () => {
    while (!disposed) {
      try {
        const r: { rev: number; supported: boolean; accounts: Record<string, AccountKind>; names?: Names } = await client.rpc(accountsWait, { rev });
        if (disposed) return;
        rev = r.rev;
        supported = r.supported;
        accounts = r.accounts;
        // 이름이 그대로면 같은 객체를 둔다 — 대화마다 다시 그리지 않게
        if (r.names && (r.names.team !== names.team || r.names.personal !== names.personal)) names = r.names;
        for (const id of agents.keys()) sync(id);
      } catch (error) {
        log(`account wait: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();

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
      for (const id of [...pills.keys()]) remove(id);
      agents.clear();
    },
  };
}
