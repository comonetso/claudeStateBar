import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { projectsFileRead, projectsFileWrite, projectsTextProblem } from "../shared/projectsFile";
import { scaled, useFontScale } from "./fontScale";
import { notifyProjectsChanged } from "./projectsData";

// 프로젝트 매니저 목록 파일(projects.json) 편집 — 프로젝트 화면의 편집 상태(리규형님 10-06 결정: Paseo 안에서, VS Code 없이).
// 저장 전에 화면에서 한 번, 데몬에서 한 번 같은 검사(projectsTextProblem)를 하고, 저장하면 목록이 바로 다시 읽힌다.

type Note = { kind: "ok" | "warn" | "error"; text: string } | null;

export function ProjectsEditor({ theme, onClose }: { theme: PluginTheme; onClose: () => void }) {
  const readFile = useRpc(projectsFileRead);
  const writeFile = useRpc(projectsFileWrite);
  const scale = useFontScale();
  const c = theme.colors;
  const [file, setFile] = useState<string | null>(null);
  const [base, setBase] = useState<{ text: string; mtimeMs: number | null } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  // 저장 안 한 채 닫으려 하면 한 번은 막고 알린다
  const [closeArmed, setCloseArmed] = useState(false);
  const dirty = base !== null && text !== base.text;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await readFile({});
      setFile(r.file);
      setBase({ text: r.text, mtimeMs: r.mtimeMs });
      setText(r.text);
      setNote(r.error ? { kind: "error", text: r.error } : null);
      setCloseArmed(false);
    } catch (e) {
      setNote({ kind: "error", text: `읽지 못했습니다: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [readFile]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!base) return;
    const problem = projectsTextProblem(text);
    if (problem) {
      setNote({ kind: "error", text: `저장하지 않았습니다 — ${problem}` });
      return;
    }
    setBusy(true);
    try {
      const r = await writeFile({ text, baseMtimeMs: base.mtimeMs });
      if (!r.ok) {
        setNote({ kind: "error", text: `저장하지 않았습니다 — ${r.error ?? "이유를 모릅니다"}` });
        return;
      }
      setBase({ text, mtimeMs: r.mtimeMs ?? null });
      setCloseArmed(false);
      setNote({ kind: "ok", text: `저장했습니다 (${new Date().toLocaleTimeString("ko-KR")}) — 직전 내용은 projects.json.bak` });
      notifyProjectsChanged();
    } catch (e) {
      setNote({ kind: "error", text: `저장하지 못했습니다: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (dirty && !closeArmed) {
      setCloseArmed(true);
      setNote({ kind: "warn", text: "저장하지 않은 변경이 있습니다. 버리고 닫으려면 [닫기]를 한 번 더 누르세요" });
      return;
    }
    onClose();
  };

  const fs = (px: number) => scaled(px + 1, scale);
  const btn = (primary: boolean) =>
    ({
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: primary ? c.accent : c.surface2,
      opacity: busy ? 0.5 : 1,
    }) as const;
  const noteColor = note?.kind === "ok" ? c.statusSuccess : note?.kind === "warn" ? c.statusWarning : c.statusDanger;

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="닫기" onPress={close} style={btn(false)}>
          <Icon name="X" size={fs(12)} color={c.foreground} />
          <Text style={{ color: c.foreground, fontSize: fs(12) }}>닫기</Text>
        </Pressable>
        <Text style={{ color: c.foreground, fontSize: fs(14), fontWeight: "600" }}>프로젝트 목록 편집{dirty ? " ●" : ""}</Text>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="다시 읽기" disabled={busy} onPress={() => void load()} style={btn(false)}>
          <Icon name="RefreshCw" size={fs(11)} color={c.foreground} />
          <Text style={{ color: c.foreground, fontSize: fs(12) }}>다시 읽기</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="저장" disabled={busy || !dirty} onPress={() => void save()} style={[btn(true), !dirty && { opacity: 0.5 }]}>
          <Icon name="Save" size={fs(11)} color={c.accentForeground} />
          <Text style={{ color: c.accentForeground, fontSize: fs(12), fontWeight: "600" }}>저장</Text>
        </Pressable>
      </View>
      {file ? (
        <Text style={{ color: c.foregroundMuted, fontSize: fs(11) }} numberOfLines={1}>
          {file}
        </Text>
      ) : null}
      {note ? <Text style={{ color: noteColor, fontSize: fs(12) }}>{note.text}</Text> : null}
      <TextInput
        value={text}
        onChangeText={(next) => {
          setText(next);
          if (closeArmed) setCloseArmed(false);
        }}
        multiline
        editable={!busy && base !== null}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textAlignVertical="top"
        style={{
          flex: 1,
          minHeight: 240,
          color: c.foreground,
          backgroundColor: c.surface1,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 6,
          padding: 10,
          fontSize: fs(12),
          fontFamily: Platform.OS === "web" ? "monospace" : Platform.OS === "ios" ? "Menlo" : "monospace",
        }}
      />
    </View>
  );
}
