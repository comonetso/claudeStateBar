import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const speechLangSchema = z.enum(["ko", "en", "ja", "zh", "es", "fr", "ar"]);
export type SpeechLang = z.infer<typeof speechLangSchema>;
export const translateProviderSchema = z.enum(["google", "openai", "anthropic"]);
export type TranslateProvider = z.infer<typeof translateProviderSchema>;
export const audioProviderSchema = z.enum(["google", "openai"]);
export type AudioProvider = z.infer<typeof audioProviderSchema>;
export const LANGUAGE_NAMES: Record<SpeechLang, string> = {
  ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese", es: "Spanish", fr: "French", ar: "Arabic",
};
export const GOOGLE_LANGUAGE_CODES: Record<SpeechLang, string> = {
  ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "cmn-CN", es: "es-ES", fr: "fr-FR", ar: "ar-XA",
};
// 전체 지원 목록으로 옛 저장 값을 검증한다. 추천 목록 밖의 값도 몰래 바꾸지 않는다.
// Google: 기획서의 10-12 실측 30개, https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
export const GOOGLE_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe",
  "Charon", "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia",
  "Leda", "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar",
  "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;
// 2026-10-12 공식 TTS 가이드의 Voice options. 성별 값은 저장·표시하지 않는다.
// https://developers.openai.com/api/docs/guides/text-to-speech
export const OPENAI_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar",
] as const;
// 10-12 리규형님 "인기 있는 모델로, 여성으로만, 각각 6개를 검색해서 골라" — 처음 기획(공식 근거만, Google 3·OpenAI 5)을 바꿨다.
// 공개된 인기 순위는 없어 검색에서 많이 언급·추천되는 여성 목소리를 골랐다. 순서 = 맨 위 고정 하나 + 나머지 A→Z.
// Google: 성별은 Google 공식 값(voices.list ssmlGender = FEMALE, 10-12 실측). Zephyr 는 지금 기본값(10-09)이라 맨 위.
//   Kore — 공식 FAQ 사용 예·비교 글에서 가장 많이 언급 / Aoede·Leda·Despina — 비교 글·서드파티 목록에서 자주 추천 /
//   Callirrhoe — 10-09 까지 쓰던 목소리. 출처: https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd ·
//   https://note.com/tsukubalab/n/n0f143277b947 · https://geminitts.org/gemini-tts-voices
export const FEATURED_GOOGLE_VOICES = ["Zephyr", "Aoede", "Callirrhoe", "Despina", "Kore", "Leda"] as const;
// OpenAI: 공식 성별 표기가 없다 — 사용자 사이에서 여성 목소리로 통하는 것. marin 은 공식 품질 추천("For best quality, we recommend
//   using marin or cedar" — cedar 는 남성이라 뺐다)이라 맨 위, nova 는 가장 인기 많다는 평, shimmer·coral·sage 는 여성 목소리 설명이
//   흔하고 alloy 는 중성적이라는 평도 있다. 출처: https://developers.openai.com/api/docs/guides/text-to-speech ·
//   https://www.greaterwrong.com/posts/KL2BqiRv2MsZLihE3/going-nova/comment/6tWvqDRvW76BdBGJF ·
//   https://blog.picassoia.com/openai-tts-voices-samples-options-and-which-to-pick
export const FEATURED_OPENAI_VOICES = ["marin", "alloy", "coral", "nova", "sage", "shimmer"] as const;
export function voiceOptions(provider: AudioProvider, saved: string): string[] {
  const list: readonly string[] = provider === "google" ? FEATURED_GOOGLE_VOICES : FEATURED_OPENAI_VOICES;
  return list.includes(saved) ? [...list] : [saved, ...list];
}
export const speechSchema = z.object({
  v: z.literal(1),
  lang: speechLangSchema,
  translate: translateProviderSchema,
  tts: audioProviderSchema,
  stt: audioProviderSchema,
  voice: z.object({ google: z.enum(GOOGLE_VOICES), openai: z.enum(OPENAI_VOICES) }),
});
export type SpeechSettings = z.infer<typeof speechSchema>;
export function defaultSpeechSettings(lang: SpeechLang = "ko"): SpeechSettings {
  return { v: 1, lang, translate: "google", tts: "google", stt: "google", voice: { google: "Zephyr", openai: "marin" } };
}
export const PREVIEW_TEXT: Record<SpeechLang, string> = {
  ko: "안녕하세요. 이 목소리로 글을 읽어 드립니다.",
  en: "Hello. This is the voice that will read your text.",
  ja: "こんにちは。この声で文章を読み上げます。",
  zh: "您好。我会用这个声音朗读文字。",
  es: "Hola. Esta es la voz que leerá su texto.",
  fr: "Bonjour. Voici la voix qui lira votre texte.",
  ar: "مرحبًا. هذا هو الصوت الذي سيقرأ النص.",
};
const hostsSchema = z.array(z.object({ host: z.string(), ok: z.boolean() }));
export const speechGet = defineRpc({
  name: "speech.get", input: z.object({ lang: speechLangSchema.optional() }),
  output: z.object({ settings: speechSchema, configured: z.boolean() }),
});
export const speechSave = defineRpc({
  name: "speech.save", input: speechSchema,
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), settings: speechSchema, hosts: hostsSchema }),
    z.object({ ok: z.literal(false), reason: z.literal("write") }),
  ]),
});
export const speechPreview = defineRpc({
  name: "speech.preview",
  input: z.object({ provider: audioProviderSchema, voice: z.string(), lang: speechLangSchema }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), base64: z.string(), mimeType: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});
export const KEY_FIELDS = ["gemini", "tts", "openai", "anthropic"] as const;
export type KeyField = typeof KEY_FIELDS[number];
export function neededKeyFields(s: SpeechSettings): KeyField[] {
  return KEY_FIELDS.filter((field) =>
    field === "gemini" ? s.translate === "google" || s.stt === "google" :
    field === "tts" ? s.tts === "google" :
    field === "openai" ? s.translate === "openai" || s.tts === "openai" || s.stt === "openai" :
    s.translate === "anthropic");
}
const keyStateSchema = z.object({ saved: z.boolean(), check: z.object({ ok: z.boolean(), at: z.number() }).nullable() });
export const speechKeysStateSchema = z.object({
  gemini: keyStateSchema, tts: keyStateSchema, openai: keyStateSchema, anthropic: keyStateSchema,
});
export type SpeechKeysState = z.infer<typeof speechKeysStateSchema>;
export const speechKeysState = defineRpc({
  name: "speech.keys-state", input: z.object({}), output: speechKeysStateSchema,
});
export const speechKeysSave = defineRpc({
  name: "speech.keys-save",
  input: z.object({ gemini: z.string().optional(), tts: z.string().optional(), openai: z.string().optional(), anthropic: z.string().optional() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), state: speechKeysStateSchema }),
    z.object({ ok: z.literal(false), reason: z.enum(["invalid", "write"]), field: z.enum(KEY_FIELDS).optional() }),
  ]),
});
export const speechKeysCheck = defineRpc({
  name: "speech.keys-check", input: speechSchema, output: speechKeysStateSchema,
});
