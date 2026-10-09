import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { FoldTitle, SectionTitle } from "./sectionTitle";
import type { SettingsText } from "./settingsI18n";
import { readLocal, reloadPage, writeLocal } from "./web";

// 설정 화면 맨 위 "웹 로그인" 칸(리규형님 10-07 결정). 우리가 직접 올린 웹은 로그인 서버(web-gate)가 앞에 서 있고,
// 그 서버가 Paseo 화면 맨 앞에 guard.js 를 끼워 window.paseoGate 를 만든다 — 그게 있을 때만 이 칸이 동작한다.
// PC 앱·폰 앱에는 로그인이 없어 안내 한 줄만 보인다.
// 바꾸기는 지금 비밀번호 + OTP 를 확인하고(로그인과 같은 실패 횟수·잠금), 아이디·비밀번호가 바뀌면 다른 기기 로그인을
// 모두 끊고, 유지 시간은 다음 로그인부터 — 규칙은 서버(web-gate lib/app.mjs handleAccountUpdate)가 지킨다.
// 서버 링크(10-07 결정): 서버 3대 열쇠도 PC 링크처럼 로그인 서버에 잠가 두고 로그인 때 함께 붙인다 — 여기서 넣고 지운다.
// 글자는 설정 화면 사전(client/settingsI18n — 10-08 한글·영어)에서 받는다. 로그인 서버가 보낸 message 는 그대로 보인다.

const REGISTRY_KEY = "@paseo:daemon-registry";

type PluginTheme = PluginSurfaceProps["theme"];
type Gate = { logout(): void };
type ServerLink = { serverId: string; label: string | null };
type Account = { id: string; sessionHours: number; linkServerId: string | null; servers?: ServerLink[]; expiresAt: number; serverNow: number };
type HostEntry = { serverId: string };

/** 우리 로그인 서버를 거쳐 열린 화면인가 — 설정 화면이 이 칸을 맨 위에 둘지 정한다(PC 앱은 거치지 않아 안내만 보인다) */
export function hasWebGate(): boolean {
  return gate() !== null;
}
function gate(): Gate | null {
  const g = (globalThis as { paseoGate?: Gate }).paseoGate;
  return g && typeof g.logout === "function" ? g : null;
}

async function call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function failText(status: number, json: Record<string, unknown>, t: SettingsText): string {
  if (status === 423) {
    const mins = Math.max(1, Math.ceil((Number(json.until) - Number(json.serverNow)) / 60000));
    return t.loginLocked(mins);
  }
  if (status === 401 && json.error === "invalid") return t.loginInvalid(String(json.remaining));
  if (status === 401) return t.loginExpired;
  if (typeof json.message === "string") return json.message;
  return t.loginFailedStatus(status);
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function left(ms: number, t: SettingsText): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  return h ? t.durationHM(h, mins % 60) : t.durationM(mins);
}

/** 바꾼 링크를 이 브라우저의 연결 목록에도 반영한다(뺄 서버 번호를 빼고 새 항목을 넣는다). Paseo 는 다시 열어야 새 목록을 읽는다. */
function updateRegistry(remove: (string | null)[], add: HostEntry[]): void {
  let list: HostEntry[] = [];
  try {
    const parsed = JSON.parse(readLocal(REGISTRY_KEY) ?? "[]");
    if (Array.isArray(parsed)) list = parsed as HostEntry[];
  } catch {}
  const drop = new Set([...remove, ...add.map((h) => h.serverId)]);
  list = list.filter((h) => h && !drop.has(h.serverId));
  list.push(...add);
  writeLocal(REGISTRY_KEY, JSON.stringify(list));
}

export function WebLoginSection({ theme, compact, t }: { theme: PluginTheme; compact: boolean; t: SettingsText }) {
  const g = gate();
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // 칸 접기(10-09 리규형님 "항목이 2개 이상인 것은 접힌 상태로") — 위 open 은 계정 바꾸기 입력 칸이고 이것은 칸 전체
  const [shown, setShown] = useState(false);
  const EMPTY = { id: "", newPassword: "", newPassword2: "", hours: "", link: "", serverLabel: "", serverLink: "", password: "", otp: "" };
  const [form, setForm] = useState(EMPTY);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [needReload, setNeedReload] = useState(false);

  const styles = useMemo(
    () => ({
      card: { gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
      heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      row: { flexDirection: (compact ? "column" : "row") as "column" | "row", gap: 8 },
      input: {
        flex: compact ? undefined : 1,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      buttonText: { color: theme.colors.foreground, textAlign: "center" as const },
      primary: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.accent },
      primaryText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, compact],
  );

  const load = useCallback(async () => {
    try {
      const r = await call("/__gate/account");
      if (r.status === 200) {
        setAccount(r.json as unknown as Account);
        setLoadError(null);
      } else setLoadError(failText(r.status, r.json, t));
    } catch (error) {
      setLoadError(t.loginAccountFailed(String(error)));
    }
  }, [t]);

  useEffect(() => {
    if (g) void load();
  }, [g, load]);

  if (!g) {
    // 제목은 다른 칸처럼 박스 밖에(10-09 리규형님 — 박스 안에 있어 위 칸의 하위 항목처럼 보였다)
    return (
      <>
        <SectionTitle icon="KeyRound" title={t.loginHeading} theme={theme} />
        <View style={styles.card}>
          <Text style={styles.muted}>{t.loginNoGate}</Text>
        </View>
      </>
    );
  }

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const submit = async () => {
    setMessage(null);
    const change: Record<string, unknown> = {};
    if (form.id.trim()) change.id = form.id.trim();
    if (form.newPassword || form.newPassword2) {
      if (form.newPassword !== form.newPassword2) {
        setMessage({ text: t.loginPasswordMismatch, bad: true });
        return;
      }
      change.newPassword = form.newPassword;
    }
    if (form.hours.trim()) change.sessionHours = Number(form.hours.trim());
    if (form.link.trim()) change.link = form.link.trim();
    if (form.serverLink.trim()) change.addServer = { link: form.serverLink.trim(), label: form.serverLabel.trim() };
    if (removeIds.length) change.removeServers = removeIds;
    if (!Object.keys(change).length) {
      setMessage({ text: t.loginNothingToChange, bad: true });
      return;
    }
    setBusy(true);
    try {
      const r = await call("/__gate/account", { password: form.password, otp: form.otp, change });
      setForm({ ...form, password: "", otp: "" });
      if (r.status !== 200) {
        setMessage({ text: failText(r.status, r.json, t), bad: true });
        return;
      }
      const fields = (r.json.fields as string[]).map((f) => t.loginFieldNames[f] ?? f).join(t.loginFieldJoin);
      const ended = Number(r.json.endedSessions);
      const parts = [t.loginChanged(fields)];
      if (ended > 0) parts.push(t.loginOthersEnded(ended));
      if (change.sessionHours !== undefined) parts.push(t.loginHoursNext);
      if (change.newPassword !== undefined && r.json.linkKept === false) parts.push(t.loginLinkDropped);
      setForm(EMPTY);
      setRemoveIds([]);
      setMessage({ text: parts.join(" "), bad: false });
      const host = r.json.host as HostEntry | null;
      const added = r.json.addedServer as HostEntry | null;
      const removed = (r.json.removedServers as string[] | undefined) ?? [];
      if (host || added || removed.length) {
        updateRegistry([host ? account?.linkServerId ?? null : null, ...removed], [host, added].filter((h): h is HostEntry => !!h));
        setNeedReload(true);
        setMessage({ text: `${parts.join(" ")} ${t.loginLinksReopen}`, bad: false });
      }
      void load();
    } catch (error) {
      setMessage({ text: t.loginUnreachable(String(error)), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const input = (key: keyof typeof form, placeholder: string, opts: { secret?: boolean; numeric?: boolean; multiline?: boolean } = {}) => (
    <TextInput
      style={styles.input}
      value={form[key]}
      onChangeText={(v) => set({ [key]: v })}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      secureTextEntry={opts.secret}
      keyboardType={opts.numeric ? "numeric" : "default"}
      multiline={opts.multiline}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      accessibilityLabel={placeholder}
    />
  );

  return (
    <>
    {/* 설정 화면 맨 위(10-09 리규형님 "로그인 및 계정 관련은 최상단으로"). 로그인 상태 한 줄과 로그아웃·바꾸기 단추는 접어 둬도 늘 보이고,
        접기는 자세한 내용(세션 유지 시간·서버 링크 목록)에만 건다 — "항목이 2개 이상인 칸은 접힌 채로"(10-09)와 함께 */}
    <FoldTitle icon="KeyRound" title={t.loginHeading} theme={theme} open={shown} onToggle={() => setShown(!shown)} labels={t.fold} />
    <View style={styles.card}>
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {account ? (
        <Text style={styles.text}>
          {t.loginAs(account.id, clock(Date.now() + (account.expiresAt - account.serverNow)), left(account.expiresAt - account.serverNow, t))}
        </Text>
      ) : !loadError ? (
        <Text style={styles.muted}>{t.loginReading}</Text>
      ) : null}
      {account && shown ? (
        <>
          <Text style={styles.muted}>{t.loginSessionLine(account.sessionHours, account.linkServerId)}</Text>
          <Text style={styles.muted}>{t.loginServersLine(account.servers?.length ?? 0)}</Text>
          {(account.servers ?? []).map((sv) => {
            const marked = removeIds.includes(sv.serverId);
            return (
              <View key={sv.serverId} style={styles.actions}>
                <Text style={[marked ? styles.error : styles.text, { flex: 1 }]}>
                  {sv.label ?? sv.serverId} ({sv.serverId}){marked ? t.loginServerMarked : ""}
                </Text>
                <Pressable
                  style={styles.button}
                  onPress={() => {
                    setOpen(true);
                    setRemoveIds(marked ? removeIds.filter((x) => x !== sv.serverId) : [...removeIds, sv.serverId]);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t.loginServerRemoveLabel(sv.label ?? sv.serverId)}
                >
                  <Text style={styles.buttonText}>{marked ? t.loginServerRemoveCancel : t.loginServerRemove}</Text>
                </Pressable>
              </View>
            );
          })}
        </>
      ) : null}

      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={() => g.logout()} accessibilityRole="button" accessibilityLabel={t.loginLogout}>
          <Text style={styles.buttonText}>{t.loginLogout}</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => setOpen(!open)} accessibilityRole="button">
          <Text style={styles.buttonText}>{open ? t.loginCloseChange : t.loginOpenChange}</Text>
        </Pressable>
      </View>

      {open ? (
        <>
          <Text style={styles.muted}>{t.loginChangeIntro}</Text>
          {input("id", t.loginNewId)}
          <View style={styles.row}>
            {input("newPassword", t.loginNewPassword, { secret: true })}
            {input("newPassword2", t.loginNewPassword2, { secret: true })}
          </View>
          {input("hours", t.loginHours, { numeric: true })}
          {input("link", t.loginPcLink, { multiline: true })}
          <View style={styles.row}>
            {input("serverLabel", t.loginServerLabel)}
            {input("serverLink", t.loginServerLink, { multiline: true })}
          </View>
          <Text style={styles.muted}>{t.loginConfirmHint}</Text>
          <View style={styles.row}>
            {input("password", t.loginCurrentPassword, { secret: true })}
            {input("otp", t.loginOtp, { numeric: true })}
          </View>
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={() => void submit()} disabled={busy} accessibilityRole="button">
              <Text style={styles.primaryText}>{busy ? t.loginChecking : t.loginSubmit}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {message ? <Text style={message.bad ? styles.error : styles.text}>{message.text}</Text> : null}
      {needReload ? (
        <View style={styles.actions}>
          <Pressable style={styles.primary} onPress={reloadPage} accessibilityRole="button">
            <Text style={styles.primaryText}>{t.loginReopen}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
    </>
  );
}
