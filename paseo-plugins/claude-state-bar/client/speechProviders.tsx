import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { neededKeyFields, speechGet, speechSave, speechPreview, speechKeysState, speechKeysSave, speechKeysCheck,
  speechLangSchema, speechSchema, voiceOptions, type KeyField, type SpeechKeysState, type SpeechSettings } from "../shared/speech";
import { uiLanguage } from "./appLanguage";
import type { SettingsText } from "./settingsI18n";
import { emitSharedSignal } from "./sounds";
import { UiSelect, UiInput, UiButton, HelpTip } from "./ui";
import { createThinkingAudio } from "./web";
import { thinkingController } from "./thinking";
import { previewId, VoicePreviewPlayer, type PreviewState } from "./voicePreview";

const TRANSLATE_PROVIDERS = [{ value: "google", label: "Google (Gemini)" }, { value: "openai", label: "OpenAI (ChatGPT)" }, { value: "anthropic", label: "Anthropic (Claude)" }];
const AUDIO_PROVIDERS = TRANSLATE_PROVIDERS.slice(0, 2);
/** 접어도 컴포넌트는 살아 있어 같은 설정 화면의 미리 듣기 보관을 유지한다. */
export function SpeechProviders({ theme, t, visible, readOnly = false }: { theme: PluginTheme; t: SettingsText; visible: boolean; readOnly?: boolean }) {
  const get = useRpc(speechGet);
  const save = useRpc(speechSave);
  const keysGet = useRpc(speechKeysState);
  const keysSave = useRpc(speechKeysSave);
  const keysCheck = useRpc(speechKeysCheck);
  const previewRpc = useRpc(speechPreview);
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [saved, setSaved] = useState<SpeechSettings | null>(null);
  const [keys, setKeys] = useState<SpeechKeysState | null>(null);
  const [inputs, setInputs] = useState({ gemini: "", tts: "", openai: "", anthropic: "" });
  const [busy, setBusy] = useState<"save" | "keys" | "check" | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ id: "", status: "idle" });
  const player = useMemo(() => new VoicePreviewPlayer(createThinkingAudio(), previewRpc, setPreview), [previewRpc]);
  useEffect(() => () => player.dispose(), [player]);
  useEffect(() => { if (!visible) player.stop(); }, [visible, player]);
  useEffect(() => {
    let live = true;
    void Promise.all([get({ lang: uiLanguage() }), keysGet({})]).then(([speech, keyState]) => {
      if (!live) return;
      setSettings(speech.settings); setSaved(speech.settings); setKeys(keyState);
    }, () => { if (live) setMessage({ text: t.speechRequestFailed, bad: true }); });
    return () => { live = false; };
  }, [get, keysGet, t]);
  if (!visible) return null;
  const c = theme.colors;
  const textStyle = { color: c.foreground, fontSize: 14 };
  const muted = { color: c.foregroundMuted, fontSize: 13 };
  const errorStyle = { color: c.statusDanger, fontSize: 13 };
  if (!settings) return <Text style={message?.bad ? errorStyle : muted}>{message?.text ?? t.loading}</Text>;
  const fields = neededKeyFields(settings);
  const names: Record<KeyField, string> = { gemini: t.geminiKeyName, tts: t.ttsKeyName, openai: t.openaiKeyName, anthropic: t.anthropicKeyName };
  const change = (input: unknown) => {
    if (busy || readOnly) return;
    const next = speechSchema.safeParse(input);
    if (!next.success) return;
    player.stop(); setMessage(null);
    if (next.data.tts !== settings.tts) setVoiceOpen(false);
    setSettings(next.data);
    // 숨긴 공급자의 미저장 키를 나중에 함께 저장하지 않는다.
    const shown = neededKeyFields(next.data);
    setInputs((current) => Object.fromEntries(Object.entries(current).map(([field, value]) => [field, shown.includes(field as KeyField) ? value : ""])) as typeof current);
  };
  const clock = (at: number) => {
    const date = new Date(at);
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  };
  const saveSettings = async () => {
    if (busy || readOnly) return;
    player.stop(); setBusy("save"); setMessage(null);
    try {
      const result = await save(settings);
      if (!result.ok) { setMessage({ text: t.speechWriteFailed, bad: true }); return; }
      setSaved(result.settings); setSettings(result.settings);
      const hosts = result.hosts.map((h) => `${h.host}: ${h.ok ? t.speechHostOk : t.speechHostFailed}`).join(" · ");
      setMessage({ text: t.speechSaved + (hosts ? " · " + hosts : ""), bad: result.hosts.some((h) => !h.ok) });
      emitSharedSignal("googleKeys");
    } catch { setMessage({ text: t.speechRequestFailed, bad: true }); }
    finally { setBusy(null); }
  };
  const saveKeys = async () => {
    if (busy || readOnly) return;
    const input = Object.fromEntries(fields.filter((f) => inputs[f].trim()).map((f) => [f, inputs[f].trim()]));
    if (!Object.keys(input).length) { setMessage({ text: t.keysNothing, bad: true }); return; }
    setBusy("keys"); setMessage(null);
    try {
      const result = await keysSave(input);
      if (!result.ok) { setMessage({ text: result.reason === "invalid" ? t.keysInvalid(names[result.field ?? "gemini"]) : t.keysWriteFailed, bad: true }); return; }
      setKeys(result.state); setInputs({ gemini: "", tts: "", openai: "", anthropic: "" });
      setMessage({ text: t.keysSaved, bad: false }); emitSharedSignal("googleKeys");
    } catch { setMessage({ text: t.speechRequestFailed, bad: true }); }
    finally { setBusy(null); }
  };
  const checkKeys = async () => {
    if (busy || readOnly) return;
    setBusy("check"); setMessage(null);
    try {
      const next = await keysCheck(settings);
      setKeys(next);
      setMessage({ text: fields.some((f) => next[f].saved) ? t.keysChecked : t.keysCheckNone, bad: fields.some((f) => next[f].check?.ok === false) });
      emitSharedSignal("googleKeys");
    } catch { setMessage({ text: t.speechRequestFailed, bad: true }); }
    finally { setBusy(null); }
  };
  const selectedVoice = settings.voice[settings.tts];
  const select = (label: string, value: string, options: { value: string; label: string }[], onChange: (value: string) => void) => (
    <View style={{ gap: 4 }}>
      <Text style={textStyle}>{label}</Text>
      <UiSelect theme={theme} value={value} options={options} onChange={onChange} fontSize={14} disabled={readOnly} dim={readOnly || busy !== null} />
    </View>
  );
  return <View style={{ gap: 10 }}>
    {select(t.speechLanguage, settings.lang, speechLangSchema.options.map((value) => ({ value, label: t.speechLanguages[value] })), (lang) => change({ ...settings, lang }))}
    {select(t.speechTranslateProvider, settings.translate, TRANSLATE_PROVIDERS, (translate) => change({ ...settings, translate }))}
    {select(t.speechTtsProvider, settings.tts, AUDIO_PROVIDERS, (tts) => change({ ...settings, tts }))}
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <UiButton theme={theme} label={t.speechVoice + ": " + selectedVoice + (voiceOpen ? " ▴" : " ▾")} fontSize={14}
          onPress={() => { player.stop(); setVoiceOpen(!voiceOpen); }} disabled={readOnly || busy !== null} />
        <HelpTip theme={theme} text={t.speechVoiceHint} fontSize={14} />
      </View>
      {voiceOpen ? voiceOptions(settings.tts, selectedVoice).map((voice) => {
        const input = { provider: settings.tts, voice, lang: settings.lang };
        const active = preview.id === previewId(input);
        return <View key={voice} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <UiButton theme={theme} label={voice} fontSize={14} style={{ flex: 1 }} on={voice === selectedVoice} disabled={readOnly || busy !== null}
            onPress={() => { change({ ...settings, voice: { ...settings.voice, [settings.tts]: voice } }); setVoiceOpen(false); }} />
          <UiButton theme={theme} fontSize={14} disabled={readOnly || busy !== null}
            label={active ? preview.status === "loading" ? t.speechPreviewLoading : t.speechPreviewStop : t.speechPreview}
            onPress={() => { thinkingController.stop(); void player.toggle(input); }} />
        </View>;
      }) : null}
      {preview.status === "idle" && preview.error ? <Text style={errorStyle}>{preview.error}</Text> : null}
    </View>
    {select(t.speechSttProvider, settings.stt, AUDIO_PROVIDERS, (stt) => change({ ...settings, stt }))}
    {JSON.stringify(settings) !== JSON.stringify(saved) ? <Text style={muted}>{t.speechUnsaved}</Text> : null}
    <UiButton theme={theme} fontSize={14} variant="filled" label={busy === "save" ? t.saving : t.speechSave} onPress={() => void saveSettings()} disabled={readOnly || busy !== null} />
    {fields.map((field) => {
      const state = keys?.[field];
      return <View key={field} style={{ gap: 5 }}>
        <Text style={state?.check?.ok === false ? errorStyle : textStyle}>
          {state ? t.keyLine(names[field], state.saved, state.check ? state.check.ok ? t.keyCheckOk(clock(state.check.at)) : t.keyCheckFailed(clock(state.check.at)) : t.keyCheckNever) : names[field]}
        </Text>
        <UiInput theme={theme} fontSize={14} compact={false} value={inputs[field]}
          onChangeText={(value) => setInputs((current) => ({ ...current, [field]: value }))} editable={!readOnly && busy === null}
          placeholder={state?.saved ? t.keyPlaceholderSaved : t.keyPlaceholderMissing} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" accessibilityLabel={t.keyInputLabel(names[field])} />
      </View>;
    })}
    {fields.some((f) => inputs[f].trim()) ? <Text style={muted}>{t.keysUnsaved}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <UiButton theme={theme} fontSize={14} variant="filled" label={busy === "keys" ? t.keysSaving : t.keysSave} onPress={() => void saveKeys()} disabled={readOnly || busy !== null} />
      <UiButton theme={theme} fontSize={14} variant="filled" label={busy === "check" ? t.keysChecking : t.keysCheck} onPress={() => void checkKeys()} disabled={readOnly || busy !== null} />
      <HelpTip theme={theme} text={`${t.speechKeysIntro}\n\n${t.keysCheckHint}`} fontSize={14} />
    </View>
    {message ? <Text style={message.bad ? errorStyle : textStyle}>{message.text}</Text> : null}
  </View>;
}
