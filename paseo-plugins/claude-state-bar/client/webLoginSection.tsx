import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { readLocal, reloadPage, writeLocal } from "./web";

// 설정 화면 맨 위 "웹 로그인" 칸(리규형님 10-07 결정). 우리가 직접 올린 웹은 로그인 서버(web-gate)가 앞에 서 있고,
// 그 서버가 Paseo 화면 맨 앞에 guard.js 를 끼워 window.paseoGate 를 만든다 — 그게 있을 때만 이 칸이 동작한다.
// PC 앱·폰 앱에는 로그인이 없어 안내 한 줄만 보인다.
// 바꾸기는 지금 비밀번호 + OTP 를 확인하고(로그인과 같은 실패 횟수·잠금), 아이디·비밀번호가 바뀌면 다른 기기 로그인을
// 모두 끊고, 유지 시간은 다음 로그인부터 — 규칙은 서버(web-gate lib/app.mjs handleAccountUpdate)가 지킨다.
// 서버 링크(10-07 결정): 서버 3대 열쇠도 PC 링크처럼 로그인 서버에 잠가 두고 로그인 때 함께 붙인다 — 여기서 넣고 지운다.

const REGISTRY_KEY = "@paseo:daemon-registry";

type PluginTheme = PluginSurfaceProps["theme"];
type Gate = { logout(): void };
type ServerLink = { serverId: string; label: string | null };
type Account = { id: string; sessionHours: number; linkServerId: string | null; servers?: ServerLink[]; expiresAt: number; serverNow: number };
type HostEntry = { serverId: string };

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

function failText(status: number, json: Record<string, unknown>): string {
  if (status === 423) {
    const mins = Math.max(1, Math.ceil((Number(json.until) - Number(json.serverNow)) / 60000));
    return `너무 많이 틀려 잠겼습니다. 약 ${mins}분 뒤에 다시 하세요.`;
  }
  if (status === 401 && json.error === "invalid") return `비밀번호나 OTP 가 맞지 않습니다. 남은 시도 ${String(json.remaining)}번.`;
  if (status === 401) return "로그인이 끝났습니다. 화면을 새로 고쳐 다시 로그인하세요.";
  if (typeof json.message === "string") return json.message;
  return `처리하지 못했습니다(${status}).`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function left(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}시간 ${mins % 60}분` : `${mins}분`;
}

const FIELD_NAMES: Record<string, string> = { id: "아이디", password: "비밀번호", sessionHours: "유지 시간", link: "PC 링크", servers: "서버 링크" };

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

export function WebLoginSection({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const g = gate();
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
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
      } else setLoadError(failText(r.status, r.json));
    } catch (error) {
      setLoadError(`계정 정보를 읽지 못했습니다: ${String(error)}`);
    }
  }, []);

  useEffect(() => {
    if (g) void load();
  }, [g, load]);

  if (!g) {
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>웹 로그인</Text>
        <Text style={styles.muted}>
          로그인 서버가 앞에 선 웹 주소에 로그인한 브라우저에서만 보입니다. 거기서 로그아웃과 아이디·비밀번호·유지 시간·PC 링크·서버 링크 바꾸기를 합니다.
        </Text>
      </View>
    );
  }

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const submit = async () => {
    setMessage(null);
    const change: Record<string, unknown> = {};
    if (form.id.trim()) change.id = form.id.trim();
    if (form.newPassword || form.newPassword2) {
      if (form.newPassword !== form.newPassword2) {
        setMessage({ text: "새 비밀번호 두 칸이 다릅니다.", bad: true });
        return;
      }
      change.newPassword = form.newPassword;
    }
    if (form.hours.trim()) change.sessionHours = Number(form.hours.trim());
    if (form.link.trim()) change.link = form.link.trim();
    if (form.serverLink.trim()) change.addServer = { link: form.serverLink.trim(), label: form.serverLabel.trim() };
    if (removeIds.length) change.removeServers = removeIds;
    if (!Object.keys(change).length) {
      setMessage({ text: "바꿀 칸을 하나 이상 채우세요.", bad: true });
      return;
    }
    setBusy(true);
    try {
      const r = await call("/__gate/account", { password: form.password, otp: form.otp, change });
      setForm({ ...form, password: "", otp: "" });
      if (r.status !== 200) {
        setMessage({ text: failText(r.status, r.json), bad: true });
        return;
      }
      const fields = (r.json.fields as string[]).map((f) => FIELD_NAMES[f] ?? f).join("·");
      const ended = Number(r.json.endedSessions);
      const parts = [`바꿨습니다: ${fields}.`];
      if (ended > 0) parts.push(`다른 기기 ${ended}곳은 로그아웃됐습니다.`);
      if (change.sessionHours !== undefined) parts.push("유지 시간은 다음 로그인부터 적용됩니다.");
      if (change.newPassword !== undefined && r.json.linkKept === false) parts.push("잠가 둔 PC 링크를 다시 잠그지 못해 지웠습니다 — 다음 로그인 때 다시 붙이세요.");
      setForm(EMPTY);
      setRemoveIds([]);
      setMessage({ text: parts.join(" "), bad: false });
      const host = r.json.host as HostEntry | null;
      const added = r.json.addedServer as HostEntry | null;
      const removed = (r.json.removedServers as string[] | undefined) ?? [];
      if (host || added || removed.length) {
        updateRegistry([host ? account?.linkServerId ?? null : null, ...removed], [host, added].filter((h): h is HostEntry => !!h));
        setNeedReload(true);
        setMessage({ text: `${parts.join(" ")} 바뀐 링크는 화면을 다시 열어야 붙고 떨어집니다.`, bad: false });
      }
      void load();
    } catch (error) {
      setMessage({ text: `서버에 닿지 않습니다: ${String(error)}`, bad: true });
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
    <View style={styles.card}>
      <Text style={styles.heading}>웹 로그인</Text>
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {account ? (
        <>
          <Text style={styles.text}>
            {account.id} 로 로그인 · {clock(Date.now() + (account.expiresAt - account.serverNow))} 에 끝남 (남은 {left(account.expiresAt - account.serverNow)})
          </Text>
          <Text style={styles.muted}>
            세션 유지 시간 {account.sessionHours}시간 · PC 링크 {account.linkServerId ? `저장됨(${account.linkServerId})` : "없음"}
          </Text>
          <Text style={styles.muted}>서버 링크 {account.servers?.length ? `${account.servers.length}개 — 로그인할 때 함께 붙습니다` : "없음 — 아래 바꾸기에서 넣으면 로그인할 때 서버도 붙습니다"}</Text>
          {(account.servers ?? []).map((sv) => {
            const marked = removeIds.includes(sv.serverId);
            return (
              <View key={sv.serverId} style={styles.actions}>
                <Text style={[marked ? styles.error : styles.text, { flex: 1 }]}>
                  {sv.label ?? sv.serverId} ({sv.serverId}){marked ? " — 바꾸기 누르면 지움" : ""}
                </Text>
                <Pressable
                  style={styles.button}
                  onPress={() => {
                    setOpen(true);
                    setRemoveIds(marked ? removeIds.filter((x) => x !== sv.serverId) : [...removeIds, sv.serverId]);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${sv.label ?? sv.serverId} 서버 링크 지우기`}
                >
                  <Text style={styles.buttonText}>{marked ? "지우기 취소" : "지우기"}</Text>
                </Pressable>
              </View>
            );
          })}
        </>
      ) : !loadError ? (
        <Text style={styles.muted}>읽는 중…</Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={() => g.logout()} accessibilityRole="button" accessibilityLabel="로그아웃">
          <Text style={styles.buttonText}>로그아웃</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => setOpen(!open)} accessibilityRole="button">
          <Text style={styles.buttonText}>{open ? "바꾸기 닫기" : "아이디·비밀번호·유지 시간·링크 바꾸기"}</Text>
        </Pressable>
      </View>

      {open ? (
        <>
          <Text style={styles.muted}>바꿀 칸만 채우세요. 비운 칸은 그대로 둡니다.</Text>
          {input("id", "새 아이디")}
          <View style={styles.row}>
            {input("newPassword", "새 비밀번호(8자 이상)", { secret: true })}
            {input("newPassword2", "새 비밀번호 한 번 더", { secret: true })}
          </View>
          {input("hours", "세션 유지 시간(시간, 다음 로그인부터)", { numeric: true })}
          {input("link", "새 PC 연결 링크(PC Paseo 앱 → 호스트 설정 → 기기 페어링)", { multiline: true })}
          <View style={styles.row}>
            {input("serverLabel", "추가할 서버 이름(비우면 서버 번호)")}
            {input("serverLink", "서버 연결 링크(그 서버 호스트 설정 → 기기 페어링, 또는 서버에서 paseo daemon pair)", { multiline: true })}
          </View>
          <Text style={styles.muted}>
            확인 — 지금 비밀번호와 OTP 6자리. 방금 로그인에 쓴 숫자는 다시 못 쓰니 새 숫자가 뜨면 넣으세요. 아이디·비밀번호를 바꾸면 다른
            기기 로그인은 모두 끊깁니다.
          </Text>
          <View style={styles.row}>
            {input("password", "지금 비밀번호", { secret: true })}
            {input("otp", "OTP 6자리", { numeric: true })}
          </View>
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={() => void submit()} disabled={busy} accessibilityRole="button">
              <Text style={styles.primaryText}>{busy ? "확인 중" : "바꾸기"}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {message ? <Text style={message.bad ? styles.error : styles.text}>{message.text}</Text> : null}
      {needReload ? (
        <View style={styles.actions}>
          <Pressable style={styles.primary} onPress={reloadPage} accessibilityRole="button">
            <Text style={styles.primaryText}>화면 다시 열기</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
