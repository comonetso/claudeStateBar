import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { settingsSchema, soundSettings, type SoundSettings } from "../shared/settings";
import { soundData, type SoundKind } from "../shared/sound";
import { playSoundUrl } from "./web";
import { WebLoginSection } from "./webLoginSection";

/** Paseo 설정 안의 우리 항목 이름(10-07: "Claude 상태 소리" → 웹 로그인·소리를 칸으로 나눈 플러그인 설정 화면). */
export const SETTINGS_TITLE = "Claude State Bar";

const ORDER: SoundKind[] = ["completion", "question", "warning", "danger", "workflow"];

const LABELS: Record<SoundKind, { title: string; hint: string }> = {
  completion: { title: "끝남", hint: "대화가 끝났을 때" },
  question: { title: "질문", hint: "질문 창이나 계획 승인 창이 떴을 때" },
  warning: { title: "경고", hint: "컨텍스트가 경고 기준을 처음 넘을 때" },
  danger: { title: "위험", hint: "컨텍스트가 위험 기준을 처음 넘을 때" },
  workflow: { title: "따르릉", hint: "워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행이 끝났을 때" },
};

type Draft = Record<SoundKind, { file: string; gain: string }> & {
  settleMs: string;
  warningPercent: string;
  dangerPercent: string;
  workflowBeep: boolean;
  syncWorkspaceOrder: boolean;
  syncLayout: boolean;
};

function toDraft(values: SoundSettings): Draft {
  const sounds = Object.fromEntries(
    ORDER.map((kind) => [kind, { file: values[kind].file, gain: String(values[kind].gain) }]),
  ) as Record<SoundKind, { file: string; gain: string }>;
  return {
    ...sounds,
    settleMs: String(values.settleMs),
    warningPercent: String(values.warningPercent),
    dangerPercent: String(values.dangerPercent),
    workflowBeep: values.workflowBeep,
    syncWorkspaceOrder: values.syncWorkspaceOrder,
    syncLayout: values.syncLayout,
  };
}

function fromDraft(draft: Draft) {
  const sounds = Object.fromEntries(
    ORDER.map((kind) => [kind, { file: draft[kind].file.trim(), gain: Number(draft[kind].gain) }]),
  );
  return settingsSchema.safeParse({
    ...sounds,
    settleMs: Number(draft.settleMs),
    warningPercent: Number(draft.warningPercent),
    dangerPercent: Number(draft.dangerPercent),
    workflowBeep: draft.workflowBeep,
    syncWorkspaceOrder: draft.syncWorkspaceOrder,
    syncLayout: draft.syncLayout,
  });
}

/** 설정이 저장되거나 기본값으로 돌아가면 onSaved 를 부른다(공급자가 설정을 다시 읽게). */
export function createSettingsScreen(onSaved: () => void) {
  return function SoundSettingsScreen({ theme, layout }: PluginSurfaceProps) {
    const state = useSettings(soundSettings);
    const preview = useRpc(soundData);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const revision = state.status === "ready" ? state.revision : null;

    useEffect(() => {
      if (state.status === "ready") setDraft(toDraft(state.values));
      // 저장본이 바뀔 때만 다시 채운다
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revision]);

    const styles = useMemo(
      () => ({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: { padding: layout.compact ? 16 : 24, gap: layout.compact ? 12 : 16 },
        title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: "600" as const },
        section: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const, marginTop: 8 },
        muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
        text: { color: theme.colors.foreground, fontSize: 14 },
        card: {
          gap: 8,
          padding: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        row: { flexDirection: (layout.compact ? "column" : "row") as "column" | "row", gap: 8 },
        input: {
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 14,
        },
        fileInput: { flex: layout.compact ? undefined : 1 },
        smallInput: { width: layout.compact ? undefined : 90 },
        button: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.surface2 },
        buttonText: { color: theme.colors.foreground, textAlign: "center" as const },
        primary: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.colors.accent },
        primaryText: { color: theme.colors.accentForeground, textAlign: "center" as const },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        actions: { flexDirection: "row" as const, gap: 8 },
        switchRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
        switchText: { flex: 1, gap: 4 },
      }),
      [theme, layout.compact],
    );

    // 웹 로그인 칸은 소리 설정을 읽는 동안에도 보인다(로그아웃이 소리 설정에 묶이지 않게).
    const shell = (body: ReactNode) => (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>{SETTINGS_TITLE}</Text>
        <WebLoginSection theme={theme} compact={layout.compact} />
        {body}
      </ScrollView>
    );

    if (state.status === "loading" || (state.status === "ready" && !draft)) {
      return shell(<Text style={styles.muted}>동기화·소리 설정을 읽는 중입니다</Text>);
    }
    if (state.status === "error" || !draft) {
      return shell(<Text style={styles.error}>설정을 읽지 못했습니다: {state.status === "error" ? state.error : ""}</Text>);
    }

    const setSound = (kind: SoundKind, patch: Partial<{ file: string; gain: string }>) =>
      setDraft({ ...draft, [kind]: { ...draft[kind], ...patch } });

    const play = async (kind: SoundKind) => {
      setMessage(null);
      try {
        const gain = Number(draft[kind].gain);
        const { dataUrl } = await preview({
          kind,
          file: draft[kind].file.trim(),
          gain: Number.isFinite(gain) ? gain : undefined,
        });
        await playSoundUrl(dataUrl);
      } catch (error) {
        setMessage(`${LABELS[kind].title} 소리를 틀지 못했습니다: ${String(error)}`);
      }
    };

    const save = async () => {
      const parsed = fromDraft(draft);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        setMessage(`값을 확인해 주세요 (${issue?.path.join(".") ?? ""}): ${issue?.message ?? ""}`);
        return;
      }
      if (parsed.data.warningPercent >= parsed.data.dangerPercent) {
        setMessage("경고 기준은 위험 기준보다 낮아야 합니다");
        return;
      }
      if (state.status !== "ready" && state.status !== "invalid") return;
      const ok = await state.save(parsed.data, state.revision);
      setMessage(ok ? "저장했습니다" : `저장하지 못했습니다: ${state.saveError ?? ""}`);
      if (ok) onSaved();
    };

    const reset = async () => {
      const ok = await state.reset();
      setMessage(ok ? "기본값으로 되돌렸습니다" : `되돌리지 못했습니다: ${state.saveError ?? ""}`);
      if (ok) onSaved();
    };

    const syncSwitch = (key: "syncWorkspaceOrder" | "syncLayout", title: string, hint: string) => (
      <View style={[styles.card, styles.switchRow]}>
        <View style={styles.switchText}>
          <Text style={styles.text}>{title}</Text>
          <Text style={styles.muted}>{hint}</Text>
        </View>
        <Switch value={draft[key]} onValueChange={(on) => setDraft({ ...draft, [key]: on })} accessibilityLabel={`동기화 단추로 ${title} 가져오기`} />
      </View>
    );

    return shell(
      <>
        <Text style={styles.section}>동기화</Text>
        <Text style={styles.muted}>
          웹·폰 화면을 열 때마다 PC 앱에서 아래 켜 둔 항목을 가져옵니다. 머리줄 동기화 단추로 바로 다시 맞출 수도 있습니다. Paseo 설정은 이와 따로 늘 자동으로 맞춰집니다.
        </Text>
        {syncSwitch("syncWorkspaceOrder", "작업 공간 순서", "왼쪽 목록의 프로젝트·작업 공간 순서와 고정한 작업 공간")}
        {syncSwitch("syncLayout", "화면 구성", "작업 공간마다 칸 나누기·칸 크기·탭 배치·탐색기 폭·고정한 대화")}

        <Text style={styles.section}>소리</Text>
        <Text style={styles.muted}>
          이 PC 와 연결된 서버의 대화 소리가 모두 여기 설정을 따릅니다. 파일 칸을 비우면 기본 소리, 크기는 50~300% 이며
          WAV 파일만 키울 수 있습니다.
        </Text>
        {state.status === "invalid" ? <Text style={styles.error}>저장된 설정이 올바르지 않습니다: {state.error}</Text> : null}

        {ORDER.map((kind) => (
          <View key={kind} style={styles.card}>
            <Text style={styles.text}>{LABELS[kind].title}</Text>
            <Text style={styles.muted}>{LABELS[kind].hint}</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.fileInput]}
                value={draft[kind].file}
                onChangeText={(file) => setSound(kind, { file })}
                placeholder="비우면 기본 소리"
                placeholderTextColor={theme.colors.foregroundMuted}
                accessibilityLabel={`${LABELS[kind].title} 소리 파일 경로`}
              />
              <TextInput
                style={[styles.input, styles.smallInput]}
                value={draft[kind].gain}
                onChangeText={(gain) => setSound(kind, { gain })}
                keyboardType="numeric"
                accessibilityLabel={`${LABELS[kind].title} 소리 크기 퍼센트`}
              />
              <Pressable
                style={styles.button}
                onPress={() => void play(kind)}
                accessibilityRole="button"
                accessibilityLabel={`${LABELS[kind].title} 소리 미리 듣기`}
              >
                <Text style={styles.buttonText}>미리 듣기</Text>
              </Pressable>
            </View>
          </View>
        ))}

        <View style={styles.card}>
          <Text style={styles.text}>끝남·질문 대기 (밀리초, 100~5000)</Text>
          <Text style={styles.muted}>이 시간 안에 대화가 다시 움직이거나 질문에 답하면 울리지 않습니다</Text>
          <TextInput
            style={[styles.input, styles.smallInput]}
            value={draft.settleMs}
            onChangeText={(settleMs) => setDraft({ ...draft, settleMs })}
            keyboardType="numeric"
            accessibilityLabel="끝남과 질문 소리 대기 시간"
          />
          <Text style={styles.text}>경고 기준 · 위험 기준 (컨텍스트 %)</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.smallInput]}
              value={draft.warningPercent}
              onChangeText={(warningPercent) => setDraft({ ...draft, warningPercent })}
              keyboardType="numeric"
              accessibilityLabel="경고 기준 퍼센트"
            />
            <TextInput
              style={[styles.input, styles.smallInput]}
              value={draft.dangerPercent}
              onChangeText={(dangerPercent) => setDraft({ ...draft, dangerPercent })}
              keyboardType="numeric"
              accessibilityLabel="위험 기준 퍼센트"
            />
          </View>
        </View>

        <View style={[styles.card, styles.switchRow]}>
          <View style={styles.switchText}>
            <Text style={styles.text}>따르릉 울리기</Text>
            <Text style={styles.muted}>끄면 워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행이 끝나도 울리지 않습니다</Text>
          </View>
          <Switch
            value={draft.workflowBeep}
            onValueChange={(workflowBeep) => setDraft({ ...draft, workflowBeep })}
            accessibilityLabel="따르릉 울리기"
          />
        </View>

        {message ? <Text style={styles.text}>{message}</Text> : null}
        <View style={styles.actions}>
          <Pressable style={styles.primary} onPress={() => void save()} accessibilityRole="button" disabled={state.saving}>
            <Text style={styles.primaryText}>{state.saving ? "저장 중" : "저장"}</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={() => void reset()} accessibilityRole="button">
            <Text style={styles.buttonText}>기본값으로</Text>
          </Pressable>
        </View>
      </>,
    );
  };
}
