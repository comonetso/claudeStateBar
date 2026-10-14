import type { PluginTheme } from "@getpaseo/plugin";
import {
  useHosts,
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { loginCancel, loginCode, loginStart, loginWait, type LoginSnapshot } from "../shared/claudeLogin";
import { hostInfo } from "../shared/sound";
import { FoldTitle } from "./sectionTitle";
import { settingsText, type SettingsText } from "./settingsI18n";
import { buttonStyle, UiInput } from "./ui";
import { openExternal } from "./web";

// Claude 다시 로그인(shared/claudeLogin, 리규형님 10-14): 로그인이 풀린 대화 입력창 위 빨간 열쇠 알약 + 설정 화면 칸 둘 다.
// 기기마다 그 기기 플러그인이 자기 대화에 알약을 붙이고(로그인은 그 기기 데몬이 한다), 설정 화면은 PC(또는 대신 맡은 서버) 하나만
// 그리므로 기기마다 자기 로그인 기능을 화면 공용 자리(globalThis — 호스트마다 플러그인이 따로 떠도 실행 공간은 하나)에 올려 둔다.
// 로그인 뒤 끊긴 말은 다시 보내지 않는다 — 다음 말을 보내면 이어진다(리규형님 결정, Paseo 측 보고에서 자동 재시도가 문제를 키웠다).

type StartResult = { ok: boolean; url?: string; error?: string };
type HostLogin = {
  serverId: string;
  snapshot: LoginSnapshot | null;
  start: (target: string) => Promise<StartResult>;
  code: (code: string) => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<void>;
};
type Hub = { hosts: Map<string, HostLogin>; listeners: Set<() => void>; version: number };

// 판 번호를 이름에 둔다 — 플러그인을 다시 읽어도 같은 페이지에 옛 판이 남아 돈다(10-08 함정)
const HUB_KEY = "claude-state-bar:claude-login:v1";
function hub(): Hub {
  const root = globalThis as unknown as Record<string, Hub | undefined>;
  return (root[HUB_KEY] ??= { hosts: new Map(), listeners: new Set(), version: 0 });
}
function notifyHub(): void {
  const h = hub();
  h.version++;
  for (const fn of [...h.listeners]) {
    try {
      fn();
    } catch {
      /* 한 화면의 오류가 다른 화면 알림을 막지 않게 */
    }
  }
}
function subscribeHub(fn: () => void): () => void {
  const h = hub();
  h.listeners.add(fn);
  return () => {
    h.listeners.delete(fn);
  };
}
function useHub(): number {
  return useSyncExternalStore(subscribeHub, () => hub().version, () => hub().version);
}

/** 링크 받기 → 링크 열기 → 승인 코드 넣기. 알약 창과 설정 칸이 같이 쓴다 */
function LoginPanel({ host, target, label, theme, t, intro, onClose }: {
  host: HostLogin;
  target: string;
  label: string;
  theme: PluginTheme;
  t: SettingsText;
  intro?: string;
  onClose: () => void;
}) {
  useHub();
  const c = theme.colors;
  const running = host.snapshot?.running;
  // 다른 화면에서 시작한 로그인도 이어서 코드를 넣을 수 있다
  const sharedUrl = running && running.target === target ? running.url : null;
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"start" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const link = url ?? sharedUrl;
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const button = (text: string, onPress: () => void, primary = false, disabled = false) => (
    <Pressable onPress={onPress} disabled={disabled || busy !== null} style={[buttonStyle(theme, primary ? "primary" : "filled", true), { opacity: disabled || busy ? 0.6 : 1 }]}>
      <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 12, fontWeight: primary ? "600" : "400" }}>{text}</Text>
    </Pressable>
  );
  const start = async () => {
    setBusy("start");
    setError(null);
    const r = await host.start(target).catch((e: unknown): StartResult => ({ ok: false, error: String(e) }));
    setBusy(null);
    if (r.ok && r.url) setUrl(r.url);
    else setError(r.error ?? t.claudeLoginButton);
  };
  const send = async () => {
    setBusy("send");
    setError(null);
    const r = await host.code(code).catch((e: unknown) => ({ ok: false, error: String(e) }));
    setBusy(null);
    setUrl(null);
    if (r.ok) {
      setDone(true);
      setCode("");
    } else setError(r.error ?? t.claudeLoginButton);
  };
  const cancel = () => {
    if (link) void host.cancel().catch(() => {});
    setUrl(null);
    onClose();
  };
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, minWidth: 260, maxWidth: 380 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{t.claudeLoginTitle(label)}</Text>
      {intro ? <Text style={muted}>{intro}</Text> : null}
      {done ? (
        <>
          <Text style={{ color: c.statusSuccess, fontSize: 12 }}>{t.claudeLoginDone}</Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>{button(t.claudeLoginClose, onClose)}</View>
        </>
      ) : link ? (
        <>
          <Text style={muted}>{t.claudeLoginSteps}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>{button(t.claudeLoginOpen, () => void openExternal(link))}</View>
          <UiInput
            theme={theme}
            fontSize={13}
            value={code}
            onChangeText={setCode}
            placeholder={t.claudeLoginCode}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            {button(t.claudeLoginCancel, cancel)}
            {button(busy === "send" ? t.claudeLoginSending : t.claudeLoginSubmit, () => void send(), true, !code.trim())}
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          {button(t.claudeLoginCancel, cancel)}
          {button(busy === "start" ? t.claudeLoginStarting : t.claudeLoginGetLink, () => void start(), true)}
        </View>
      )}
      {error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

// ── 대화 입력창 위 알약 ──
type AgentLike = { id: string; workspaceId?: string | null; archivedAt?: string | null };
// 알약 창이 어느 기기·어느 로그인 파일인지 — 알약을 만든 이 모듈 안에서만 쓴다
const pillTargets = new Map<string, { host: HostLogin; target: string }>();

function PillIcon(props: PluginButtonIconProps) {
  return <Icon name="KeyRound" size={props.size} color={props.theme.colors.statusDanger} />;
}

function PillContent(props: PluginButtonContentProps) {
  const t = settingsText();
  const agentId = props.context === "agent" ? (props as { agentId?: string }).agentId ?? "" : "";
  const found = pillTargets.get(agentId);
  useHub();
  if (!found) return null;
  const label = found.host.snapshot?.targets.find((x) => x.id === found.target)?.label ?? found.target;
  return (
    <View style={{ padding: 4 }}>
      <LoginPanel host={found.host} target={found.target} label={label} theme={props.theme} t={t} intro={t.claudeLoginPillIntro} onClose={props.close} />
    </View>
  );
}

/** 이 기기 데몬에서 로그인 오류로 멈춘 Claude 대화마다 알약을 붙이고, 이 기기 로그인 기능을 설정 화면용 공용 자리에 올린다 */
export function createLoginPills(client: PluginClientContext, log: (message: string) => void) {
  const t = settingsText();
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, AgentLike>();
  let disposed = false;
  const mine: HostLogin = {
    serverId: "",
    snapshot: null,
    start: (target) => client.rpc(loginStart, { target }),
    code: (code) => client.rpc(loginCode, { code }),
    cancel: async () => {
      await client.rpc(loginCancel, {});
    },
  };

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    pillTargets.delete(agentId);
  };

  const sync = (agentId: string) => {
    const agent = agents.get(agentId);
    const target = mine.snapshot?.needs[agentId];
    if (!agent || agent.archivedAt || !agent.workspaceId || !target) return remove(agentId);
    pillTargets.set(agentId, { host: mine, target });
    if (pills.has(agentId)) return;
    try {
      pills.set(agentId, client.addComposerPill({
        id: "claude-login",
        workspaceId: agent.workspaceId,
        agentId,
        button: { title: t.claudeLoginPill, icon: PillIcon, label: t.claudeLoginPillLabel, behavior: { kind: "popover", Content: PillContent } },
      }));
    } catch (error) {
      log(`claude login pill ${agentId.slice(0, 8)}: ${String(error)}`);
    }
  };

  // 설정 화면 칸이 기기 이름을 찾을 수 있게 이 기기 번호로 올린다
  void client.rpc(hostInfo, {}).then((info) => {
    if (disposed || !info.serverId) return;
    mine.serverId = info.serverId;
    hub().hosts.set(info.serverId, mine);
    notifyHub();
  }, (error: unknown) => log(`claude login host: ${String(error)}`));

  void (async () => {
    let rev: number | null = null;
    let failed = false;
    while (!disposed) {
      try {
        const r: LoginSnapshot = await client.rpc(loginWait, { rev });
        if (disposed) return;
        rev = r.rev;
        mine.snapshot = r;
        failed = false;
        notifyHub();
        for (const id of agents.keys()) sync(id);
      } catch (error) {
        // 이 기능이 없는 옛 데몬이면 계속 실패한다 — 한 번만 남긴다
        if (!failed) log(`claude login wait: ${String(error)}`);
        failed = true;
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
      const h = hub();
      if (mine.serverId && h.hosts.get(mine.serverId) === mine) {
        h.hosts.delete(mine.serverId);
        notifyHub();
      }
    },
  };
}

// ── 설정 화면 칸 ──
export function ClaudeLoginSection({ theme, t }: { theme: PluginTheme; t: SettingsText }) {
  useHub();
  const hosts = useHosts();
  const c = theme.colors;
  const order = (id: string) => {
    const i = hosts.findIndex((h) => h.serverId === id);
    return i < 0 ? hosts.length : i;
  };
  const regs = [...hub().hosts.values()].filter((h) => h.snapshot?.supported).sort((a, b) => order(a.serverId) - order(b.serverId));
  const anyNeeds = regs.some((h) => Object.keys(h.snapshot?.needs ?? {}).length > 0);
  // 늘 있는 칸이라 접어 두고, 로그인이 풀린 대화가 있으면 펼친다
  const [open, setOpen] = useState(anyNeeds);
  useEffect(() => {
    if (anyNeeds) setOpen(true);
  }, [anyNeeds]);
  const [active, setActive] = useState<string | null>(null);
  if (!regs.length) return null;
  const hostName = (id: string) => hosts.find((h) => h.serverId === id)?.label || id.slice(0, 8);
  return (
    <>
      <FoldTitle icon="KeyRound" title={t.claudeLoginSection} theme={theme} open={open} onToggle={() => setOpen(!open)} labels={t.fold} />
      {open ? (
        <View style={{ gap: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{t.claudeLoginIntro}</Text>
          {regs.flatMap((h) =>
            (h.snapshot?.targets ?? []).map((target) => {
              const key = `${h.serverId}\n${target.id}`;
              const name = `${hostName(h.serverId)} · ${target.label}`;
              const stopped = Object.values(h.snapshot?.needs ?? {}).filter((x) => x === target.id).length;
              return (
                <View key={key} style={{ gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ flex: 1, color: c.foreground, fontSize: 14 }}>
                      {name}
                      {stopped ? <Text style={{ color: c.statusDanger, fontSize: 13 }}>{`  ${t.claudeLoginNeeds(stopped)}`}</Text> : null}
                    </Text>
                    {active === key ? null : (
                      <Pressable onPress={() => setActive(key)} style={buttonStyle(theme, "filled", true)}>
                        <Text style={{ color: c.foreground, fontSize: 12 }}>{t.claudeLoginButton}</Text>
                      </Pressable>
                    )}
                  </View>
                  {active === key ? <LoginPanel host={h} target={target.id} label={name} theme={theme} t={t} onClose={() => setActive(null)} /> : null}
                </View>
              );
            }),
          )}
        </View>
      ) : null}
    </>
  );
}
