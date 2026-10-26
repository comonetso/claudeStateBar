import { readGoogleKeys } from "./googleKeys";
import { readSttHints } from "./sttHints";
import { Blob } from "node:buffer";
import { LANGUAGE_NAMES } from "../../shared/presentation/speech";
import { readSpeechSettings } from "./speech";
import { openaiText } from "./openaiText";

// 폰 받아쓰기 = 받아쓰기 + Typeless 처럼 다듬기를 Gemini 한 번 부르기로(10-10 리규형님 결정).
// 모델·생각 수준은 10-10 합성 음성 두 문장 비교에서 가장 정확했던 조합(약 2.5초) — tmp/stt_gemini_test_261010.mjs
const MODEL = "gemini-3.8-flash";
const THINKING = { thinkingLevel: "low" };
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Paseo 가 받아쓰기 결과를 기다리는 최대 시간(dictation-stream-manager DICTATION_FINAL_TIMEOUT_MAX_MS)과 같게 — 그보다 오래 붙잡지 않는다
const REQUEST_TIMEOUT_MS = 5 * 60_000;
// 공식 현재 파일 받아쓰기 모델·prompt·languages 계약(2026-10-12 확인).
// https://developers.openai.com/api/docs/guides/speech-to-text
// https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
const OPENAI_STT_MODEL = "gpt-transcribe";
// 10-10 시험 지시문 그대로(플러그인 지시문은 영어로)
const INSTRUCTION =
  "You are a dictation engine. Transcribe the speech into clean written text in the language spoken " +
  "(usually Korean, often mixed with English technical terms). Remove filler words and hesitations " +
  "(such as 어, 음, 그, 저, 아, uh, um), false starts, stutters and accidental repetitions. Fix spacing and punctuation. " +
  "Keep the speaker's meaning, wording, tone and sentence endings. Do not paraphrase, summarize, translate, answer or add anything. " +
  "Write English words, product names, code identifiers and file names in their usual written form. " +
  "If there is no intelligible speech, return an empty string. Output only the text.";

export type SttResult = { ok: true; text: string } | { ok: false; status: number; error: string };

/** 소리 파일 하나를 글로. 화면·로그 어디에도 받아쓴 글은 남기지 않는다(길이만) */
export async function transcribeSpeech(audio: Buffer, mimeType: string): Promise<SttResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const settings = readSpeechSettings().settings;
    const keys = readGoogleKeys();
    const provider = settings.stt;
    const key = provider === "google" ? keys.gemini : keys.openai;
    if (!key) return { ok: false, status: 503, error: `${provider} key missing (settings > TTS, STT, Translation Provider)` };
    const hints = readSttHints();
    const instruction = INSTRUCTION.replace("(usually Korean, often mixed with English technical terms)", `(expected language: ${LANGUAGE_NAMES[settings.lang]}, possibly mixed with English technical terms)`);
    if (provider === "openai") {
      // React Native의 전역 FormData 타입 대신 실제 Node 22 FormData 계약만 선언한다.
      const Form = (globalThis as unknown as { FormData: new () => { append(name: string, value: string | Blob, filename?: string): void } }).FormData;
      const form = new Form();
      const extension = ({ "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3",
        "audio/mp4": "m4a", "audio/flac": "flac", "audio/ogg": "ogg", "audio/webm": "webm" } as Record<string, string>)[mimeType];
      if (!extension) return { ok: false, status: 400, error: "Unsupported audio format" };
      form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${extension}`);
      form.append("model", OPENAI_STT_MODEL);
      form.append("response_format", "json");
      form.append("languages[]", settings.lang);
      if (hints) form.append("prompt", hints);
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, signal: controller.signal,
        body: form as unknown as RequestInit["body"],
      });
      if (!response.ok) return { ok: false, status: 502, error: `OpenAI STT HTTP ${response.status}` };
      const data = await response.json() as { text?: unknown };
      if (typeof data.text !== "string" || data.text.includes(key)) return { ok: false, status: 502, error: "OpenAI STT response invalid" };
      if (!data.text.trim()) return { ok: true, text: "" };
      // 글 모델은 server/presentation/openaiText.ts의 공식 확인한 gpt-4.1-mini, Gemini와 같은 다듬기 기준.
      const cleaned = await openaiText(key, instruction + (hints ? ` Terms the speaker often uses (spell them this way): ${hints}.` : ""), data.text, controller.signal);
      if ("error" in cleaned) return { ok: false, status: 502, error: cleaned.error };
      return { ok: true, text: cleaned.text.trim() };
    }
    const response = await fetch(`${API_BASE}/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: hints ? `${instruction} Terms the speaker often uses (spell them this way): ${hints}.` : instruction }],
        },
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio.toString("base64") } }] }],
        generationConfig: { temperature: 0, thinkingConfig: THINKING },
      }),
    });
    if (!response.ok) return { ok: false, status: 502, error: `Gemini HTTP ${response.status}` };
    const data = await response.json() as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };
    const parts = data.candidates?.[0]?.content?.parts?.filter((part) => !part.thought);
    if (!parts?.some((part) => typeof part.text === "string")) return { ok: false, status: 502, error: "Gemini response invalid" };
    const text = parts.map((part) => part.text ?? "").join("").trim();
    if (text.includes(key)) return { ok: false, status: 502, error: "Gemini response invalid" };
    return { ok: true, text };
  } catch (error) {
    const aborted = controller.signal.aborted || (error as Error).name === "AbortError";
    return { ok: false, status: aborted ? 504 : 502, error: aborted ? "STT timed out" : "STT request, response or settings failed" };
  } finally {
    clearTimeout(timer);
  }
}
