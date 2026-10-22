import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { defaultProjectAccess, FILE_MODES, fileModeLabel, OUTSIDE_MAX, TEAM_LOGS, type FileMode, type ProjectAccess, type TeamProject } from "../shared/team";
import { FIELD_WIDTH, HelpTip, lineColor, UiButton, UiInput } from "./ui";

// 팀원 프로젝트 하나의 권한 칸(10-20 리규형님 "팀원 관리 새로") — 팀원 프로젝트 관리 탭의 줄마다 "권한" 단추로 펼친다.
// 파일 권한 셋(읽기만·읽기쓰기·내가 쓴 파일만) · 프로젝트 밖 경로 두 칸(경로마다 같은 셋) · DB 접속 포트 · 서버 기록 · 비밀 파일 가리기.
// 저장하면 바로 그 팀원의 서버에 반영한다(반영할 때 그 팀원 Paseo 가 잠깐 다시 시작) — 칸마다가 아니라 "저장" 한 번에.

type Props = {
  theme: PluginTheme;
  project: TeamProject;
  /** 그 서버에 있는 기록(TEAM_LOGS 중) — null 이면 아직 읽는 중 */
  serverLogs: string[] | null;
  fontSize: (px: number) => number;
  /** 칸을 펼칠 때 한 번 — 그 서버의 기록 목록을 읽게 한다 */
  onOpen?: () => void;
  onSave: (access: ProjectAccess) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
};

type Draft = { file: FileMode; outside: { path: string; mode: FileMode }[]; ports: string; logs: string[]; hideSecrets: boolean };

const toDraft = (a: ProjectAccess): Draft => {
  const outside = a.outside.map((o) => ({ ...o }));
  while (outside.length < OUTSIDE_MAX) outside.push({ path: "", mode: "ro" });
  return { file: a.file, outside, ports: a.ports.join(", "), logs: [...a.logs], hideSecrets: a.hideSecrets };
};

/** 줄 이름 옆 짧은 글 — 지금 준 권한 */
export function accessNote(p: TeamProject): string {
  const a = p.access ?? defaultProjectAccess();
  const parts = [fileModeLabel(a.file)];
  if (a.outside.length) parts.push(`밖 경로 ${a.outside.length}`);
  if (a.ports.length) parts.push(`포트 ${a.ports.join(",")}`);
  if (a.logs.length) parts.push(`기록 ${a.logs.length}`);
  if (a.hideSecrets) parts.push("비밀 가림");
  return parts.join(" · ");
}

export function TeamAccessPanel({ theme, project, serverLogs, fontSize: fs, onOpen, onSave, onClose }: Props) {
  const c = theme.colors;
  useEffect(() => onOpen?.(), []);
  const [d, setD] = useState<Draft>(() => toDraft(project.access ?? defaultProjectAccess()));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const setOutside = (i: number, patch: Partial<Draft["outside"][number]>) =>
    setD((cur) => ({ ...cur, outside: cur.outside.map((o, n) => (n === i ? { ...o, ...patch } : o)) }));

  const label = (text: string, help?: string) => (
    <View style={{ width: fs(11) * 6.5, flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 4 }}>
      <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{text}</Text>
      {help ? <HelpTip theme={theme} text={help} fontSize={fs(11)} /> : null}
    </View>
  );
  const row = (left: ReactNode, right: ReactNode) => (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      {left}
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>{right}</View>
    </View>
  );
  const modes = (value: FileMode, pick: (m: FileMode) => void, key: string) =>
    FILE_MODES.map((x) => (
      <UiButton key={`${key}-${x.mode}`} theme={theme} label={x.label} fontSize={fs(11)} on={value === x.mode} hint={x.note} disabled={busy} onPress={() => pick(x.mode)} />
    ));
  const check = (key: string, on: boolean, text: string, onPress: () => void, sub?: string) => (
    <Pressable key={key} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={text} disabled={busy} onPress={onPress} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 }}>
      <View style={{ width: 14, height: 14, marginTop: 2, borderRadius: 3, borderWidth: 1.5, borderColor: on ? c.accent : lineColor(theme), backgroundColor: on ? c.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {on ? <Text style={{ color: c.surface0, fontSize: 10, fontWeight: "700", lineHeight: 12 }}>✓</Text> : null}
      </View>
      <View style={{ flexShrink: 1 }}>
        <Text style={{ fontSize: fs(11), color: c.foreground }}>{text}</Text>
        {sub ? <Text style={{ fontSize: fs(10), color: c.foregroundMuted }}>{sub}</Text> : null}
      </View>
    </Pressable>
  );

  // 그 서버에 있는 기록 + 이미 고른 것(서버에서 사라졌어도 보여서 뺄 수 있게)
  const logs = TEAM_LOGS.filter((l) => serverLogs?.includes(l.path) || d.logs.includes(l.path));
  const save = async () => {
    const words = d.ports.split(/[\s,]+/).filter(Boolean);
    const bad = words.find((w) => !/^\d+$/.test(w));
    if (bad) return setMessage({ text: `포트 "${bad}" — 숫자만 넣어 주세요(여러 개는 쉼표로)`, bad: true });
    setBusy(true);
    setMessage(null);
    try {
      const r = await onSave({
        file: d.file,
        outside: d.outside.filter((o) => o.path.trim()).map((o) => ({ path: o.path.trim(), mode: o.mode })),
        ports: words.map(Number),
        logs: d.logs,
        hideSecrets: d.hideSecrets,
      });
      if (!r.ok) return setMessage({ text: r.error ?? "저장하지 못했습니다", bad: true });
      onClose();
    } catch (err) {
      setMessage({ text: `저장하지 못했습니다: ${String(err instanceof Error ? err.message : err)}`, bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 8, marginTop: 4, marginRight: 4, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface1 }}>
      <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>{`권한 — ${project.name}`}</Text>
      {row(label("파일", "이 프로젝트 폴더 안에서 할 수 있는 것. 읽기쓰기를 받아야 원래 있던 파일을 고치고 git 커밋·배포를 할 수 있습니다. 내가 쓴 파일만은 모두 읽고 자기가 새로 만든 파일만 고칩니다(검토만 맡길 때)"), modes(d.file, (m) => set({ file: m }), "file"))}
      {d.outside.map((o, i) =>
        row(
          label(i === 0 ? "밖 경로" : "", i === 0 ? `프로젝트 밖에서 열어 줄 폴더(${OUTSIDE_MAX}개까지, 경로마다 권한을 고릅니다). 예: 개발 폴더를 고쳐 운영 폴더로 배포할 때 운영 폴더를 읽기쓰기로. 비우면 밖은 보이지 않습니다. 관리자 폴더(/root)와 시스템 폴더(/etc·/usr·/var·/opt 등)는 넣을 수 없습니다(저장할 때 알려 드립니다). 다른 팀원 홈은 서버가 거절합니다` : undefined),
          [
            <UiInput key={`op-${i}`} theme={theme} fontSize={fs(12)} value={o.path} onChangeText={(v) => setOutside(i, { path: v })} placeholder="비우면 막힘" autoCapitalize="none" autoCorrect={false} editable={!busy} style={{ width: FIELD_WIDTH }} />,
            ...modes(o.mode, (m) => setOutside(i, { mode: m }), `out-${i}`),
          ],
        ),
      )}
      {row(
        label("DB 접속", "이 서버 안에서 팀원이 붙을 수 있는 포트(쉼표로 여러 개, 예: 3306). 비우면 서버 안은 모두 막힙니다. 열어도 접속 정보가 있어야 쓸 수 있고, 프로젝트 설정의 접속 정보를 쓰면 그 계정 권한 그대로입니다"),
        <UiInput theme={theme} fontSize={fs(12)} value={d.ports} onChangeText={(v) => set({ ports: v })} placeholder="예: 3306" autoCapitalize="none" autoCorrect={false} editable={!busy} style={{ width: FIELD_WIDTH / 2 }} />,
      )}
      {row(
        label("서버 기록", "읽기만 붙입니다"),
        <View style={{ gap: 2 }}>
          {serverLogs === null && logs.length === 0 ? <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>서버에서 읽는 중…</Text> : null}
          {serverLogs !== null && logs.length === 0 ? <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>이 서버에는 붙일 수 있는 기록이 없습니다</Text> : null}
          {logs.map((l) => check(`log-${l.path}`, d.logs.includes(l.path), l.label, () => set({ logs: d.logs.includes(l.path) ? d.logs.filter((x) => x !== l.path) : [...d.logs, l.path] }), `${l.path} · ${l.note}`))}
        </View>,
      )}
      {row(
        label("비밀 파일", "켜면 열어 준 폴더 안 .env·.env.*(DB 비밀번호·API 키)를 팀원 Claude 가 빈 파일로 봅니다. 반영할 때 이름으로 찾아 막으므로 그 뒤 새로 생긴 파일은 다음 반영 때 가려집니다. 켜면 열어 준 DB 포트도 그 접속 정보로는 못 씁니다"),
        check("hide", d.hideSecrets, "가리기", () => set({ hideSecrets: !d.hideSecrets })),
      )}
      <Text style={{ fontSize: fs(10), color: c.foregroundMuted }}>DB 접속·서버 기록·비밀 가리기는 이 팀원이 이 서버에서 가진 모든 프로젝트에 함께 적용됩니다(팀원 Paseo 가 서버마다 하나라서).</Text>
      {message ? <Text style={{ fontSize: fs(11), color: message.bad ? c.statusDanger : c.statusSuccess }}>{message.text}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <UiButton theme={theme} label="저장하고 반영" tone="accent" fontSize={fs(11)} disabled={busy} hint="저장하면 그 팀원의 서버에 바로 반영합니다(그 팀원 Paseo 가 잠깐 다시 시작)" onPress={() => void save()} />
        <UiButton theme={theme} label="닫기" fontSize={fs(11)} disabled={busy} onPress={onClose} />
      </View>
    </View>
  );
}
