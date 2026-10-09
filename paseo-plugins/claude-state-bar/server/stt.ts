import { readGoogleKeys } from "./googleKeys";
import { readSttHints } from "./sttHints";

// 폰 받아쓰기 = 받아쓰기 + Typeless 처럼 다듬기를 Gemini 한 번 부르기로(10-10 리규형님 결정).
// 모델·생각 수준은 10-10 합성 음성 두 문장 비교에서 가장 정확했던 조합(약 2.5초) — tmp/stt_gemini_test_261010.mjs
const MODEL = "gemini-3.8-flash";
const THINKING = { thinkingLevel: "low" };
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Paseo 가 받아쓰기 결과를 기다리는 최대 시간(dictation-stream-manager DICTATION_FINAL_TIMEOUT_MAX_MS)과 같게 — 그보다 오래 붙잡지 않는다
const REQUEST_TIMEOUT_MS = 5 * 60_000;
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
  const key = readGoogleKeys().gemini;
  if (!key) return { ok: false, status: 503, error: "Gemini key missing (settings > translation & reading)" };
  const hints = readSttHints();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: hints ? `${INSTRUCTION} Terms the speaker often uses (spell them this way): ${hints}.` : INSTRUCTION }],
        },
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio.toString("base64") } }] }],
        generationConfig: { temperature: 0, thinkingConfig: THINKING },
      }),
    });
    if (!response.ok) return { ok: false, status: 502, error: `Gemini HTTP ${response.status}` };
    const data = await response.json() as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.filter((part) => !part.thought)
      .map((part) => part.text ?? "").join("").trim() ?? "";
    return { ok: true, text };
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    return { ok: false, status: aborted ? 504 : 502, error: aborted ? "Gemini timed out" : `Gemini request failed: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
