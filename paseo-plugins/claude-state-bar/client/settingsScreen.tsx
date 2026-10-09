import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { extSettingsImport } from "../shared/extSettings";
import { googleKeysCheck, googleKeysSave, googleKeysState, type GoogleKeysState } from "../shared/googleKeys";
import { settingsSchema, soundSettings, type SoundSettings } from "../shared/settings";
import { projectsResetOrder } from "../shared/projects";
import { soundData, type SoundKind } from "../shared/sound";
import { uiLanguage } from "./appLanguage";
import { applyExtImport, extImportReport } from "./extImport";
import { announceOrders, announcePins } from "./projectsData";
import { settingsText } from "./settingsI18n";
import { emitSharedSignal } from "./sounds";
import { MainDeviceSection, VersionStatusSection } from "./versionStatus";
import { FoldTitle, SectionTitle } from "./sectionTitle";
import { playSoundUrl } from "./web";
import { hasWebGate, WebLoginSection } from "./webLoginSection";

/** Paseo 설정 안의 우리 항목 이름(10-07: "Claude 상태 소리" → 웹 로그인·소리를 칸으로 나눈 플러그인 설정 화면). */
export const SETTINGS_TITLE = "Claude State Bar";

// 화면 글자는 사전(client/settingsI18n)에서 — 한글·영어 두 벌, 언어는 Paseo 언어 설정을 따른다(리규형님 10-08 결정).
// 화면이 열릴 때 한 번 읽는다(Paseo 언어를 바꾸면 설정 화면을 다시 열 때 반영 — 같은 결정).

const ORDER: SoundKind[] = ["completion", "question", "warning", "danger", "workflow"];


type Draft = Record<SoundKind, { file: string; gain: string }> & {
  settleMs: string;
  warningPercent: string;
  dangerPercent: string;
  workflowBeep: boolean;
  syncWorkspaceOrder: boolean;
  syncLayout: boolean;
  activitySplitPercent: string;
  translateEnabled: boolean;
  ttsEnabled: boolean;
  thinkingAutoOpen: boolean;
  ttsSpeedStep: 0.1 | 0.25;
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
    activitySplitPercent: String(values.activitySplitPercent),
    translateEnabled: values.translateEnabled,
    ttsEnabled: values.ttsEnabled,
    thinkingAutoOpen: values.thinkingAutoOpen,
    ttsSpeedStep: values.ttsSpeedStep,
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
    activitySplitPercent: Number(draft.activitySplitPercent),
    translateEnabled: draft.translateEnabled,
    ttsEnabled: draft.ttsEnabled,
    thinkingAutoOpen: draft.thinkingAutoOpen,
    ttsSpeedStep: draft.ttsSpeedStep,
  });
}

/** 설정이 저장되거나 기본값으로 돌아가면 onSaved 를 부른다(공급자가 설정을 다시 읽게). */
export function createSettingsScreen(onSaved: () => void) {
  return function SoundSettingsScreen({ theme, layout }: PluginSurfaceProps) {
    // 열릴 때 한 번 — 이 화면이 떠 있는 동안 언어는 바뀌지 않는다
    const t = useMemo(() => settingsText(), []);
    const state = useSettings(soundSettings);
    const preview = useRpc(soundData);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    // 프로젝트 목록 순서·고정 초기화(10-07 리규형님 결정: 설정 화면 안, 확인 한 번 더) — 누르면 확인 줄이 뜨고 거기서 한 번 더
    const resetOrder = useRpc(projectsResetOrder);
    const [confirmReset, setConfirmReset] = useState(false);
    const [resetMessage, setResetMessage] = useState<string | null>(null);
    // "소리" 칸 접기(10-08) — 처음엔 접힘, 웹·PC 앱은 이 기기 저장소에 기억
    // 항목이 여럿인 칸은 설정 화면을 열 때마다 접힌 채로 시작한다(10-09 리규형님 "너무 길어서 헷갈려"). 소리 칸의
    // "펼친 상태 기억"(10-08 결정)도 이 지시로 바꿨다 — 기억하지 않는다
    const [soundOpen, setSoundOpen] = useState(false);
    const [syncOpen, setSyncOpen] = useState(false);
    const [speechOpen, setSpeechOpen] = useState(false);
    // VS Code 확장 설정 가져오기(10-08) — 데몬(PC)이 VS Code 사용자 설정을 읽어 주면 입력 칸만 채운다
    const importExt = useRpc(extSettingsImport);
    const [importing, setImporting] = useState(false);
    const [importReport, setImportReport] = useState<{ text: string; bad: boolean; details: string[] } | null>(null);
    // 번역·읽기 키(10-08) — 이 PC 데몬의 키 파일에만 저장. 데몬은 키 값을 돌려주지 않는다(있음/없음·마지막 확인 결과만).
    // 입력 칸 글은 저장하면 바로 비운다
    const lang = useMemo(() => uiLanguage(), []);
    const keysStateRpc = useRpc(googleKeysState);
    const keysSaveRpc = useRpc(googleKeysSave);
    const keysCheckRpc = useRpc(googleKeysCheck);
    const [keysState, setKeysState] = useState<GoogleKeysState | null>(null);
    const [keysStateError, setKeysStateError] = useState<string | null>(null);
    const [keyInputs, setKeyInputs] = useState({ gemini: "", tts: "" });
    const [keysBusy, setKeysBusy] = useState<"save" | "check" | null>(null);
    const [keysMessage, setKeysMessage] = useState<{ text: string; bad: boolean } | null>(null);
    useEffect(() => {
      let live = true;
      keysStateRpc({}).then(
        (next) => {
          if (live) setKeysState(next);
        },
        (error: unknown) => {
          if (live) setKeysStateError(t.keysStateFailed(String(error)));
        },
      );
      return () => {
        live = false;
      };
    }, [keysStateRpc, t]);
    const doReset = async () => {
      setConfirmReset(false);
      try {
        await resetOrder({});
        announcePins([]);
        announceOrders({});
        setResetMessage(t.resetOrderDone);
      } catch (error) {
        setResetMessage(t.resetOrderFailed(String(error)));
      }
    };
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
    const webGate = hasWebGate();
    const shell = (body: ReactNode) => (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>{SETTINGS_TITLE}</Text>
        {/* 로그인·계정은 맨 위(10-09 리규형님) — 우리 로그인 서버를 거친 화면만. PC 앱처럼 안 거치면 "로그인 서버 없음" 안내라 원래 자리에 */}
        {webGate ? <WebLoginSection theme={theme} compact={layout.compact} t={t} /> : null}
        <MainDeviceSection theme={theme} t={t} />
        <VersionStatusSection theme={theme} t={t} />
        {webGate ? null : <WebLoginSection theme={theme} compact={layout.compact} t={t} />}
        {body}
      </ScrollView>
    );

    if (state.status === "loading" || (state.status === "ready" && !draft)) {
      return shell(<Text style={styles.muted}>{t.loading}</Text>);
    }
    if (state.status === "error" || !draft) {
      return shell(<Text style={styles.error}>{t.readFailed(state.status === "error" ? state.error : "")}</Text>);
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
        setMessage(t.playFailed(t.sounds[kind].title, String(error)));
      }
    };

    const save = async () => {
      const parsed = fromDraft(draft);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        setMessage(t.checkValue(issue?.path.join(".") ?? "", issue?.message ?? ""));
        return;
      }
      if (parsed.data.warningPercent >= parsed.data.dangerPercent) {
        setMessage(t.warningBelowDanger);
        return;
      }
      if (state.status !== "ready" && state.status !== "invalid") return;
      const ok = await state.save(parsed.data, state.revision);
      setMessage(ok ? t.saved : t.saveFailed(state.saveError ?? ""));
      if (ok) {
        // 가져온 값을 저장했으면 "[저장]을 눌러야" 안내는 더 맞지 않는다
        setImportReport(null);
        onSaved();
      }
    };

    const reset = async () => {
      const ok = await state.reset();
      setMessage(ok ? t.resetDone : t.resetFailed(state.saveError ?? ""));
      if (ok) {
        setImportReport(null);
        onSaved();
      }
    };

    const toggleSound = () => {
      setSoundOpen(!soundOpen);
    };

    const runImport = async () => {
      setImportReport(null);
      setImporting(true);
      try {
        const result = await importExt({});
        // 입력 칸만 채운다 — 저장은 사용자가 [저장]을 눌러야 된다(10-08 결정). 그사이 바뀐 칸을 덮지 않게 지금 칸 위에 얹는다
        if (result.status === "ok") setDraft((current) => (current ? applyExtImport(current, result.values) : current));
        setImportReport(extImportReport(t, result));
      } catch (error) {
        setImportReport({ text: t.importFailed(String(error)), bad: true, details: [] });
      } finally {
        setImporting(false);
      }
    };

    const syncSwitch = (key: "syncWorkspaceOrder" | "syncLayout", title: string, hint: string) => (
      <View style={[styles.card, styles.switchRow]}>
        <View style={styles.switchText}>
          <Text style={styles.text}>{title}</Text>
          <Text style={styles.muted}>{hint}</Text>
        </View>
        <Switch value={draft[key]} onValueChange={(on) => setDraft({ ...draft, [key]: on })} accessibilityLabel={t.syncSwitchLabel(title)} />
      </View>
    );

    const speechSwitch = (key: "translateEnabled" | "ttsEnabled" | "thinkingAutoOpen", title: string, hint: string) => (
      <View style={[styles.card, styles.switchRow]}>
        <View style={styles.switchText}>
          <Text style={styles.text}>{title}</Text>
          <Text style={styles.muted}>{hint}</Text>
        </View>
        <Switch value={draft[key]} onValueChange={(on) => setDraft({ ...draft, [key]: on })} accessibilityLabel={title} />
      </View>
    );

    // 마지막 확인 시각은 시:분만(데몬이 다시 읽히면 확인 결과를 잊으므로 대개 오늘 것이다)
    const clock = (at: number) => {
      const d = new Date(at);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    const keyField = (field: "gemini" | "tts", name: string, state: GoogleKeysState["translate"] | undefined) => (
      <View style={{ gap: 6 }}>
        {state ? (
          <Text style={state.check && !state.check.ok ? styles.error : styles.text}>
            {t.keyLine(name, state.saved, state.check ? (state.check.ok ? t.keyCheckOk(clock(state.check.at)) : t.keyCheckFailed(clock(state.check.at))) : t.keyCheckNever)}
          </Text>
        ) : (
          <Text style={styles.text}>{name}</Text>
        )}
        <TextInput
          style={styles.input}
          value={keyInputs[field]}
          onChangeText={(value) => setKeyInputs((current) => ({ ...current, [field]: value }))}
          placeholder={state?.saved ? t.keyPlaceholderSaved : t.keyPlaceholderMissing}
          placeholderTextColor={theme.colors.foregroundMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          accessibilityLabel={t.keyInputLabel(name)}
        />
      </View>
    );

    const saveKeys = async () => {
      const gemini = keyInputs.gemini.trim();
      const tts = keyInputs.tts.trim();
      if (!gemini && !tts) {
        setKeysMessage({ text: t.keysNothing, bad: true });
        return;
      }
      setKeysBusy("save");
      setKeysMessage(null);
      try {
        const result = await keysSaveRpc({ ...(gemini ? { gemini } : {}), ...(tts ? { tts } : {}) });
        if (result.ok) {
          setKeysState(result.state);
          setKeysStateError(null);
          setKeyInputs({ gemini: "", tts: "" });
          setKeysMessage({ text: t.keysSaved, bad: false });
          // 생각 상자·턴·말 읽기 단추가 키 있음을 다시 묻게(thinking.tsx 호스트별 키 확인 기억 비우기)
          emitSharedSignal("googleKeys");
        } else {
          setKeysMessage({
            text: result.reason === "invalid" ? t.keysInvalid(result.field === "tts" ? t.ttsKeyName : t.geminiKeyName) : t.keysWriteFailed,
            bad: true,
          });
        }
      } catch (error) {
        setKeysMessage({ text: t.keysSaveFailed(String(error)), bad: true });
      } finally {
        setKeysBusy(null);
      }
    };

    const checkKeys = async () => {
      setKeysBusy("check");
      setKeysMessage(null);
      try {
        const next = await keysCheckRpc({ lang });
        setKeysState(next);
        setKeysStateError(null);
        setKeysMessage({ text: next.translate.saved || next.tts.saved ? t.keysChecked : t.keysCheckNone, bad: false });
        emitSharedSignal("googleKeys");
      } catch (error) {
        setKeysMessage({ text: t.keysCheckFailed(String(error)), bad: true });
      } finally {
        setKeysBusy(null);
      }
    };

    return shell(
      <>
        <FoldTitle icon="RefreshCw" title={t.syncSection} theme={theme} open={syncOpen} onToggle={() => setSyncOpen(!syncOpen)} labels={t.fold} />
        {syncOpen ? (
          <>
            <Text style={styles.muted}>{t.syncIntro}</Text>
            {syncSwitch("syncWorkspaceOrder", t.syncWorkspaceOrder, t.syncWorkspaceOrderHint)}
            {syncSwitch("syncLayout", t.syncLayout, t.syncLayoutHint)}
          </>
        ) : null}

        <SectionTitle icon="Activity" title={t.activitySection} theme={theme} />
        <View style={styles.card}>
          <Text style={styles.text}>{t.activitySplitTitle}</Text>
          <Text style={styles.muted}>{t.activitySplitHint}</Text>
          <TextInput
            style={[styles.input, styles.smallInput]}
            value={draft.activitySplitPercent}
            onChangeText={(activitySplitPercent) => setDraft({ ...draft, activitySplitPercent })}
            keyboardType="numeric"
            accessibilityLabel={t.activitySplitLabel}
          />
        </View>

        <SectionTitle icon="Folder" title={t.projectsSection} theme={theme} />
        <View style={styles.card}>
          <Text style={styles.text}>{t.resetOrderTitle}</Text>
          <Text style={styles.muted}>{t.resetOrderHint}</Text>
          {confirmReset ? (
            <View style={styles.row}>
              <Text style={styles.error}>{t.resetOrderConfirm}</Text>
              <Pressable style={styles.button} onPress={() => void doReset()} accessibilityRole="button" accessibilityLabel={t.resetOrderDoLabel}>
                <Text style={[styles.buttonText, { color: theme.colors.statusDanger }]}>{t.resetOrderDo}</Text>
              </Pressable>
              <Pressable style={styles.button} onPress={() => setConfirmReset(false)} accessibilityRole="button" accessibilityLabel={t.resetOrderCancelLabel}>
                <Text style={styles.buttonText}>{t.cancel}</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.button}
              onPress={() => {
                setResetMessage(null);
                setConfirmReset(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={t.resetOrderButtonLabel}
            >
              <Text style={styles.buttonText}>{t.resetOrderButton}</Text>
            </Pressable>
          )}
          {resetMessage ? <Text style={styles.muted}>{resetMessage}</Text> : null}
        </View>

        {/* 번역·읽기(10-08) — 켜기·끄기는 아래 [저장]으로 플러그인 설정에, 키는 [키 저장]으로 이 PC 키 파일에 */}
        <FoldTitle icon="Languages" title={t.speechSection} theme={theme} open={speechOpen} onToggle={() => setSpeechOpen(!speechOpen)} labels={t.fold} />
        {speechOpen ? (
        <>
        <Text style={styles.muted}>{t.speechIntro}</Text>
        {speechSwitch("translateEnabled", t.translateTitle, t.translateHint)}
        {speechSwitch("ttsEnabled", t.ttsTitle, t.ttsHint)}
        {speechSwitch("thinkingAutoOpen", t.autoOpenTitle, t.autoOpenHint)}
        <View style={styles.card}>
          <SettingsSelect label={t.speedStepTitle} hint={t.speedStepHint} value={String(draft.ttsSpeedStep)}
            options={[{ label: "0.1x", value: "0.1" }, { label: "0.25x", value: "0.25" }]}
            onValueChange={(value) => setDraft({ ...draft, ttsSpeedStep: value === "0.1" ? 0.1 : 0.25 })} />
          <Text style={styles.text}>{t.speedShortcuts}</Text>
          <Text style={styles.muted}>{t.speedShortcutsHint}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.muted}>{t.speechKeysIntro}</Text>
          {keyField("gemini", t.geminiKeyName, keysState?.translate)}
          {keyField("tts", t.ttsKeyName, keysState?.tts)}
          {!keysState ? <Text style={keysStateError ? styles.error : styles.muted}>{keysStateError ?? t.keysReading}</Text> : null}
          {keyInputs.gemini.trim() || keyInputs.tts.trim() ? <Text style={styles.muted}>{t.keysUnsaved}</Text> : null}
          <View style={styles.actions}>
            <Pressable style={styles.button} onPress={() => void saveKeys()} disabled={keysBusy !== null} accessibilityRole="button" accessibilityLabel={t.keysSave}>
              <Text style={styles.buttonText}>{keysBusy === "save" ? t.keysSaving : t.keysSave}</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => void checkKeys()} disabled={keysBusy !== null} accessibilityRole="button" accessibilityLabel={t.keysCheck}>
              <Text style={styles.buttonText}>{keysBusy === "check" ? t.keysChecking : t.keysCheck}</Text>
            </Pressable>
          </View>
          <Text style={styles.muted}>{t.keysCheckHint}</Text>
          {keysMessage ? <Text style={keysMessage.bad ? styles.error : styles.text}>{keysMessage.text}</Text> : null}
        </View>
        </>
        ) : null}

        {/* "소리" 제목을 누르면 아래 소리 항목 전부가 접히고 펼쳐진다(10-08). 삼각형은 다른 패널 접기와 같은 모양 */}
        <FoldTitle icon="Volume2" title={t.soundSection} theme={theme} open={soundOpen} onToggle={toggleSound} labels={t.fold} />
        {/* 저장본이 깨졌다는 알림은 소리만의 일이 아니라 접혀 있어도 보인다 */}
        {state.status === "invalid" ? <Text style={styles.error}>{t.invalidStored(state.error)}</Text> : null}

        {soundOpen ? (
          <>
            <Text style={styles.muted}>{t.soundIntro}</Text>

            <View style={styles.card}>
              <Text style={styles.text}>{t.importTitle}</Text>
              <Text style={styles.muted}>{t.importHint}</Text>
              <View style={styles.actions}>
                <Pressable
                  style={styles.button}
                  onPress={() => void runImport()}
                  disabled={importing}
                  accessibilityRole="button"
                  accessibilityLabel={t.importButton}
                >
                  <Text style={styles.buttonText}>{importing ? t.importing : t.importButton}</Text>
                </Pressable>
              </View>
              {importReport ? (
                <>
                  <Text style={importReport.bad ? styles.error : styles.text}>{importReport.text}</Text>
                  {importReport.details.length ? <Text style={styles.text}>{t.importSkippedHead}</Text> : null}
                  {importReport.details.map((line) => (
                    <Text key={line} style={styles.muted}>
                      · {line}
                    </Text>
                  ))}
                </>
              ) : null}
            </View>

            {ORDER.map((kind) => (
              <View key={kind} style={styles.card}>
                <Text style={styles.text}>{t.sounds[kind].title}</Text>
                <Text style={styles.muted}>{t.sounds[kind].hint}</Text>
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.fileInput]}
                    value={draft[kind].file}
                    onChangeText={(file) => setSound(kind, { file })}
                    placeholder={t.filePlaceholder}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    accessibilityLabel={t.fileLabel(t.sounds[kind].title)}
                  />
                  <TextInput
                    style={[styles.input, styles.smallInput]}
                    value={draft[kind].gain}
                    onChangeText={(gain) => setSound(kind, { gain })}
                    keyboardType="numeric"
                    accessibilityLabel={t.gainLabel(t.sounds[kind].title)}
                  />
                  <Pressable
                    style={styles.button}
                    onPress={() => void play(kind)}
                    accessibilityRole="button"
                    accessibilityLabel={t.previewLabel(t.sounds[kind].title)}
                  >
                    <Text style={styles.buttonText}>{t.preview}</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            <View style={styles.card}>
              <Text style={styles.text}>{t.settleTitle}</Text>
              <Text style={styles.muted}>{t.settleHint}</Text>
              <TextInput
                style={[styles.input, styles.smallInput]}
                value={draft.settleMs}
                onChangeText={(settleMs) => setDraft({ ...draft, settleMs })}
                keyboardType="numeric"
                accessibilityLabel={t.settleLabel}
              />
              <Text style={styles.text}>{t.thresholdsTitle}</Text>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.smallInput]}
                  value={draft.warningPercent}
                  onChangeText={(warningPercent) => setDraft({ ...draft, warningPercent })}
                  keyboardType="numeric"
                  accessibilityLabel={t.warningLabel}
                />
                <TextInput
                  style={[styles.input, styles.smallInput]}
                  value={draft.dangerPercent}
                  onChangeText={(dangerPercent) => setDraft({ ...draft, dangerPercent })}
                  keyboardType="numeric"
                  accessibilityLabel={t.dangerLabel}
                />
              </View>
            </View>

            <View style={[styles.card, styles.switchRow]}>
              <View style={styles.switchText}>
                <Text style={styles.text}>{t.workflowBeepTitle}</Text>
                <Text style={styles.muted}>{t.workflowBeepHint}</Text>
              </View>
              <Switch
                value={draft.workflowBeep}
                onValueChange={(workflowBeep) => setDraft({ ...draft, workflowBeep })}
                accessibilityLabel={t.workflowBeepTitle}
              />
            </View>
          </>
        ) : null}

        {message ? <Text style={styles.text}>{message}</Text> : null}
        <View style={styles.actions}>
          <Pressable style={styles.primary} onPress={() => void save()} accessibilityRole="button" disabled={state.saving}>
            <Text style={styles.primaryText}>{state.saving ? t.saving : t.save}</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={() => void reset()} accessibilityRole="button">
            <Text style={styles.buttonText}>{t.resetDefaults}</Text>
          </Pressable>
        </View>
      </>,
    );
  };
}
