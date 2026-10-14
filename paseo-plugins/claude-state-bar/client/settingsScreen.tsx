import { OFFLINE_NOTICE } from "../shared/offlineProjects";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { buttonStyle, HelpTip, UiInput, UiSelect } from "./ui";
import { SpeechProviders } from "./speechProviders";
import { settingsSchema, soundSettings, type SoundSettings } from "../shared/settings";
import { projectsResetOrder } from "../shared/projects";
import { SOUND_UPLOAD_MAX, soundData, soundList, soundUpload, type SoundKind } from "../shared/sound";
import { sttHintsGet, sttHintsSave } from "../shared/stt";
import { announceOrders, announcePins } from "./projectsData";
import { settingsText } from "./settingsI18n";
import { MainDeviceSection, VersionStatusSection } from "./versionStatus";
import { FoldTitle, SectionTitle } from "./sectionTitle";
import { playSoundUrl, readLocal, writeLocal } from "./web";
import { hasWebGate, WebLoginSection } from "./webLoginSection";
import { ClaudeLoginSection } from "./claudeLogin";

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
  thinkingAutoTranslate: boolean;
  thinkingAutoTranslateExpand: boolean;
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
    thinkingAutoTranslate: values.thinkingAutoTranslate,
    thinkingAutoTranslateExpand: values.thinkingAutoTranslateExpand,
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
    thinkingAutoTranslate: draft.thinkingAutoTranslate,
    thinkingAutoTranslateExpand: draft.thinkingAutoTranslateExpand,
    ttsSpeedStep: draft.ttsSpeedStep,
  });
}

/** 설정이 저장되거나 기본값으로 돌아가면 onSaved 를 부른다(공급자가 설정을 다시 읽게). */
const CUSTOM_SOUND = "__custom__";
const UPLOAD_SOUND = "__upload__";

/** 내 파일 고르기(10-12) — 브라우저 파일 선택 창. 고르지 않으면 null. 웹이 아니면(파일 창 없음) null */
function pickAudioFile(): Promise<{ name: string; size: number; base64: string } | null> {
  type FileLike = { name: string; size: number };
  type InputLike = { type: string; accept: string; files: FileLike[] | null; onchange: (() => void) | null; click: () => void };
  type ReaderLike = { result: unknown; onload: (() => void) | null; onerror: (() => void) | null; readAsDataURL: (file: FileLike) => void };
  const g = globalThis as unknown as { document?: { createElement: (tag: string) => InputLike }; FileReader?: new () => ReaderLike };
  const doc = g.document;
  const FileReader = g.FileReader;
  if (!doc || !FileReader) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = ".wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, size: file.size, base64: String(reader.result).replace(/^data:[^,]*,/, "") });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/** 고른 내 파일은 데몬의 sounds 폴더에 <종류>--<이름>.<확장자> 로 저장된다 — 그 이름을 선택 상자에 보인다 */
function uploadedName(path: string): string | null {
  const m = /[\\/]claude-state-bar[\\/]sounds[\\/][a-z]+--([^\\/]+)$/.exec(path);
  return m ? m[1] : null;
}

export function createSettingsScreen(onSaved: () => void, readOnly = false) {
  return function SoundSettingsScreen({ theme, layout }: PluginSurfaceProps) {
    // 열릴 때 한 번 — 이 화면이 떠 있는 동안 언어는 바뀌지 않는다
    const t = useMemo(() => settingsText(), []);
    const state = useSettings(soundSettings);
    const preview = useRpc(soundData);
    // 소리 파일은 선택 상자로 고른다(10-12 리규형님 — 경로를 직접 쓰는 칸은 바꾸는 법을 알 수 없었다): 기본 소리 · 이 기기
    // 시스템 소리 · 직접 경로 입력. 목록에 없는 경로가 저장돼 있으면 "직접 경로 입력"으로 보이고 칸이 열린다
    const listSounds = useRpc(soundList);
    const uploadSound = useRpc(soundUpload);
    const [systemSounds, setSystemSounds] = useState<{ path: string; name: string }[]>([]);
    const [customKinds, setCustomKinds] = useState<ReadonlySet<SoundKind>>(() => new Set());
    useEffect(() => {
      let alive = true;
      listSounds({}).then(
        ({ files }) => alive && setSystemSounds(files),
        () => undefined,
      );
      return () => {
        alive = false;
      };
    }, [listSounds]);
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
    const [speechOpen, setSpeechOpen] = useState(() => readLocal("claude-state-bar:speech-providers-open") === "1");
    // 받아쓰기 이름 힌트(10-10) — 이 PC 데몬 파일에 저장하고 데몬이 서버들에도 보낸다. saved = 마지막으로 읽거나 저장한 내용
    const hintsGetRpc = useRpc(sttHintsGet);
    const hintsSaveRpc = useRpc(sttHintsSave);
    const [hintsSaved, setHintsSaved] = useState<string | null>(null);
    const [hintsDraft, setHintsDraft] = useState("");
    const [hintsBusy, setHintsBusy] = useState(false);
    const [hintsMessage, setHintsMessage] = useState<{ text: string; bad: boolean } | null>(null);
    useEffect(() => {
      let live = true;
      hintsGetRpc({}).then(
        ({ hints }) => {
          if (!live) return;
          setHintsSaved(hints);
          setHintsDraft(hints);
        },
        (error: unknown) => {
          if (live) setHintsMessage({ text: t.sttHintsReadFailed(String(error)), bad: true });
        },
      );
      return () => {
        live = false;
      };
    }, [hintsGetRpc, t]);
    const doReset = async () => {
      if (readOnly) return;
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
        fileInput: { flex: layout.compact ? undefined : 1 },
        smallInput: { width: layout.compact ? undefined : 90 },
        button: buttonStyle(theme, "filled"),
        buttonText: { color: theme.colors.foreground, textAlign: "center" as const },
        primary: buttonStyle(theme, "primary"),
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
        {readOnly ? <Text style={{ color: theme.colors.statusWarning, fontSize: 14 }}>{OFFLINE_NOTICE}</Text> : null}
        <Text style={styles.title}>{SETTINGS_TITLE}</Text>
        {/* 로그인·계정은 맨 위(10-09 리규형님) — 우리 로그인 서버를 거친 화면만. PC 앱처럼 안 거치면 "로그인 서버 없음" 안내라 원래 자리에 */}
        {webGate ? <WebLoginSection readOnly={readOnly} theme={theme} compact={layout.compact} t={t} /> : null}
        {/* Claude 다시 로그인(10-14) — 기기마다 그 기기 데몬이 로그인한다. 대신 맡은 서버 화면에서도 서버 로그인은 된다 */}
        <ClaudeLoginSection theme={theme} t={t} />
        {readOnly ? null : <MainDeviceSection theme={theme} t={t} />}
        <VersionStatusSection theme={theme} t={t} />
        {webGate ? null : <WebLoginSection readOnly={readOnly} theme={theme} compact={layout.compact} t={t} />}
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
      if (readOnly) return;
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
      if (readOnly) return;
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
        onSaved();
      }
    };

    const reset = async () => {
      if (readOnly) return;
      const ok = await state.reset();
      setMessage(ok ? t.resetDone : t.resetFailed(state.saveError ?? ""));
      if (ok) {
        onSaved();
      }
    };

    const toggleSound = () => {
      setSoundOpen(!soundOpen);
    };

    const syncSwitch = (key: "syncWorkspaceOrder" | "syncLayout", title: string, hint: string) => (
      <View style={[styles.card, styles.switchRow]}>
        <View style={styles.switchText}>
          <Text style={styles.text}>{title}</Text>
          <Text style={styles.muted}>{hint}</Text>
        </View>
        <Switch disabled={readOnly} value={draft[key]} onValueChange={(on) => setDraft({ ...draft, [key]: on })} accessibilityLabel={t.syncSwitchLabel(title)} />
      </View>
    );

    // 제목 + "?" 도움말 한 줄(10-12 리규형님 — 설명 글을 늘어놓지 않고 "?"를 눌러 패널로 본다)
    const titled = (title: string, hint: string) => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, zIndex: 10 }}>
        <Text style={[styles.text, { flexShrink: 1 }]}>{title}</Text>
        <HelpTip theme={theme} text={hint} fontSize={13} />
      </View>
    );

    // off = 위 스위치가 꺼져 있어 쓸 수 없는 하위 스위치(10-12 자동 펼침 — 자동 번역이 꺼져 있으면 흐리게·못 누름)
    const speechSwitch = (key: "translateEnabled" | "thinkingAutoTranslate" | "thinkingAutoTranslateExpand" | "ttsEnabled" | "thinkingAutoOpen", title: string, hint: string, off = false) => (
      <View style={[styles.card, styles.switchRow, off ? { opacity: 0.5 } : null]}>
        <View style={styles.switchText}>{titled(title, hint)}</View>
        <Switch disabled={readOnly || off} value={draft[key]} onValueChange={(on) => setDraft({ ...draft, [key]: on })} accessibilityLabel={title} />
      </View>
    );

    const saveHints = async () => {
      if (readOnly) return;
      setHintsBusy(true);
      setHintsMessage(null);
      try {
        const result = await hintsSaveRpc({ hints: hintsDraft });
        if (result.ok) {
          const saved = hintsDraft.replace(/\s+/g, " ").trim();
          setHintsSaved(saved);
          setHintsDraft(saved);
          const failed = result.hosts.filter((h) => !h.ok).map((h) => h.host);
          setHintsMessage({ text: t.sttHintsSaved(result.hosts.length - failed.length, result.hosts.length, failed.join(", ")), bad: failed.length > 0 });
        } else {
          setHintsMessage({ text: t.sttHintsWriteFailed, bad: true });
        }
      } catch (error) {
        setHintsMessage({ text: t.sttHintsSaveFailed(String(error)), bad: true });
      } finally {
        setHintsBusy(false);
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
          {titled(t.activitySplitTitle, t.activitySplitHint)}
          <UiInput editable={!readOnly}
            theme={theme}
            fontSize={14}
            compact={false}
            style={styles.smallInput}
            value={draft.activitySplitPercent}
            onChangeText={(activitySplitPercent) => setDraft({ ...draft, activitySplitPercent })}
            keyboardType="numeric"
            accessibilityLabel={t.activitySplitLabel}
          />
        </View>

        <SectionTitle icon="Folder" title={t.projectsSection} theme={theme} />
        <View style={styles.card}>
          {titled(t.resetOrderTitle, t.resetOrderHint)}
          {confirmReset ? (
            <View style={styles.row}>
              <Text style={styles.error}>{t.resetOrderConfirm}</Text>
              <Pressable style={styles.button} onPress={() => void doReset()} disabled={readOnly} accessibilityRole="button" accessibilityLabel={t.resetOrderDoLabel}>
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
                if (readOnly) return;
                setResetMessage(null);
                setConfirmReset(true);
              }}
              accessibilityRole="button"
              disabled={readOnly}
              accessibilityLabel={t.resetOrderButtonLabel}
            >
              <Text style={styles.buttonText}>{t.resetOrderButton}</Text>
            </Pressable>
          )}
          {resetMessage ? <Text style={styles.muted}>{resetMessage}</Text> : null}
        </View>

        {/* 번역·읽기(10-08) — 켜기·끄기는 아래 [저장]으로 플러그인 설정에, 키는 [키 저장]으로 이 PC 키 파일에 */}
        <FoldTitle icon="Languages" title={t.speechSection} theme={theme} open={speechOpen} onToggle={() => {
          const open = !speechOpen;
          writeLocal("claude-state-bar:speech-providers-open", open ? "1" : "0");
          setSpeechOpen(open);
        }} labels={t.fold} help={t.speechIntro} />
        <SpeechProviders readOnly={readOnly} theme={theme} t={t} visible={speechOpen} />
        {speechOpen ? (
        <>
        {speechSwitch("translateEnabled", t.translateTitle, t.translateHint)}
        {speechSwitch("thinkingAutoTranslate", t.autoTranslateTitle, t.autoTranslateHint)}
        {speechSwitch("thinkingAutoTranslateExpand", t.autoExpandTitle, t.autoExpandHint, !draft.thinkingAutoTranslate)}
        {speechSwitch("ttsEnabled", t.ttsTitle, t.ttsHint)}
        {speechSwitch("thinkingAutoOpen", t.autoOpenTitle, t.autoOpenHint)}
        <View style={styles.card}>
          <SettingsSelect disabled={readOnly} label={t.speedStepTitle} hint={t.speedStepHint} value={String(draft.ttsSpeedStep)}
            options={[{ label: "0.1x", value: "0.1" }, { label: "0.25x", value: "0.25" }]}
            onValueChange={(value) => setDraft({ ...draft, ttsSpeedStep: value === "0.1" ? 0.1 : 0.25 })} />
          {titled(t.speedShortcuts, t.speedShortcutsHint)}
        </View>
        {/* 받아쓰기 이름 힌트(10-10) — [이름 저장]으로 이 PC 데몬에 저장하고 서버들에도 보낸다 */}
        <View style={styles.card}>
          {titled(t.sttHintsTitle, t.sttHintsHint)}
          <UiInput
            theme={theme}
            fontSize={14}
            compact={false}
            value={hintsDraft}
            onChangeText={setHintsDraft}
            placeholder={t.sttHintsPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!readOnly && hintsSaved !== null}
            accessibilityLabel={t.sttHintsTitle}
          />
          {hintsSaved === null && !hintsMessage ? <Text style={styles.muted}>{t.sttHintsReading}</Text> : null}
          {hintsSaved !== null && hintsDraft.replace(/\s+/g, " ").trim() !== hintsSaved ? <Text style={styles.muted}>{t.sttHintsUnsaved}</Text> : null}
          <View style={styles.actions}>
            <Pressable style={styles.button} onPress={() => void saveHints()} disabled={readOnly || hintsBusy || hintsSaved === null} accessibilityRole="button" accessibilityLabel={t.sttHintsSave}>
              <Text style={styles.buttonText}>{hintsBusy ? t.sttHintsSaving : t.sttHintsSave}</Text>
            </Pressable>
          </View>
          {hintsMessage ? <Text style={hintsMessage.bad ? styles.error : styles.text}>{hintsMessage.text}</Text> : null}
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

            {ORDER.map((kind) => (
              <View key={kind} style={styles.card}>
                <Text style={styles.text}>{t.sounds[kind].title}</Text>
                <Text style={styles.muted}>{t.sounds[kind].hint}</Text>
                <View style={styles.row}>
                  {(() => {
                    const file = draft[kind].file.trim();
                    const known = systemSounds.some((x) => x.path.toLowerCase() === file.toLowerCase());
                    const mine = uploadedName(file);
                    const custom = customKinds.has(kind) || (file !== "" && !known && !mine);
                    const value = custom ? CUSTOM_SOUND : file === "" ? "" : mine ? file : systemSounds.find((x) => x.path.toLowerCase() === file.toLowerCase())!.path;
                    return (
                      <UiSelect
                        theme={theme}
                        fontSize={14}
                        value={value}
                        options={[
                          { value: "", label: t.soundDefault },
                          ...(mine ? [{ value: file, label: t.soundMine(mine) }] : []),
                          ...systemSounds.map((x) => ({ value: x.path, label: x.name })),
                          { value: UPLOAD_SOUND, label: t.soundUpload },
                          { value: CUSTOM_SOUND, label: t.soundCustom },
                        ]}
                        disabled={readOnly}
                        dim={readOnly}
                        onChange={(v) => {
                          if (readOnly) return;
                          if (v === UPLOAD_SOUND) {
                            void (async () => {
                              setMessage(null);
                              const picked = await pickAudioFile();
                              if (!picked || readOnly) return;
                              if (picked.size > SOUND_UPLOAD_MAX) return setMessage(t.soundUploadFailed("size"));
                              const r = await uploadSound({ kind, name: picked.name, base64: picked.base64 }).catch(() => null);
                              if (!r?.ok) return setMessage(t.soundUploadFailed(r && !r.ok ? r.reason : "write"));
                              const next = new Set(customKinds);
                              next.delete(kind);
                              setCustomKinds(next);
                              setSound(kind, { file: r.path });
                              setMessage(t.soundUploaded(t.sounds[kind].title));
                            })();
                            return;
                          }
                          const next = new Set(customKinds);
                          if (v === CUSTOM_SOUND) next.add(kind);
                          else {
                            next.delete(kind);
                            setSound(kind, { file: v });
                          }
                          setCustomKinds(next);
                        }}
                      />
                    );
                  })()}
                  {customKinds.has(kind) || (draft[kind].file.trim() !== "" && !uploadedName(draft[kind].file.trim()) && !systemSounds.some((x) => x.path.toLowerCase() === draft[kind].file.trim().toLowerCase())) ? (
                    <UiInput editable={!readOnly}
                      theme={theme}
                      fontSize={14}
                      compact={false}
                      style={styles.fileInput}
                      value={draft[kind].file}
                      onChangeText={(file) => setSound(kind, { file })}
                      placeholder={t.filePlaceholder}
                      placeholderTextColor={theme.colors.foregroundMuted}
                      accessibilityLabel={t.fileLabel(t.sounds[kind].title)}
                    />
                  ) : null}
                  <UiInput editable={!readOnly}
                    theme={theme}
                    fontSize={14}
                    compact={false}
                    style={styles.smallInput}
                    value={draft[kind].gain}
                    onChangeText={(gain) => setSound(kind, { gain })}
                    keyboardType="numeric"
                    accessibilityLabel={t.gainLabel(t.sounds[kind].title)}
                  />
                  <Pressable
                    style={styles.button}
                    disabled={readOnly}
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
              <UiInput editable={!readOnly}
                theme={theme}
                fontSize={14}
                compact={false}
                style={styles.smallInput}
                value={draft.settleMs}
                onChangeText={(settleMs) => setDraft({ ...draft, settleMs })}
                keyboardType="numeric"
                accessibilityLabel={t.settleLabel}
              />
              <Text style={styles.text}>{t.thresholdsTitle}</Text>
              <View style={styles.row}>
                <UiInput editable={!readOnly}
                  theme={theme}
                  fontSize={14}
                  compact={false}
                  style={styles.smallInput}
                  value={draft.warningPercent}
                  onChangeText={(warningPercent) => setDraft({ ...draft, warningPercent })}
                  keyboardType="numeric"
                  accessibilityLabel={t.warningLabel}
                />
                <UiInput editable={!readOnly}
                  theme={theme}
                  fontSize={14}
                  compact={false}
                  style={styles.smallInput}
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
              <Switch disabled={readOnly}
                value={draft.workflowBeep}
                onValueChange={(workflowBeep) => setDraft({ ...draft, workflowBeep })}
                accessibilityLabel={t.workflowBeepTitle}
              />
            </View>
          </>
        ) : null}

        {message ? <Text style={styles.text}>{message}</Text> : null}
        <View style={styles.actions}>
          <Pressable style={styles.primary} onPress={() => void save()} accessibilityRole="button" disabled={readOnly || state.saving}>
            <Text style={styles.primaryText}>{state.saving ? t.saving : t.save}</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={() => void reset()} disabled={readOnly} accessibilityRole="button">
            <Text style={styles.buttonText}>{t.resetDefaults}</Text>
          </Pressable>
        </View>
      </>,
    );
  };
}
