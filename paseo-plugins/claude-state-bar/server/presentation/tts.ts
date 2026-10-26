import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TargetLang } from "../../shared/presentation/translate";
import { GOOGLE_LANGUAGE_CODES, GOOGLE_VOICES, OPENAI_VOICES, LANGUAGE_NAMES, PREVIEW_TEXT, type AudioProvider } from "../../shared/presentation/speech";
import { readGoogleKeys } from "./googleKeys";
import { readSpeechSettings } from "./speech";
import { makeSpokenText } from "./spokenText";
import { LEGACY_SILENT_WAV } from "./sound";

const SYNTHESIZE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
// 음성 언어 = 저장한 공통 언어. Google 기본 목소리 Zephyr는 기획서대로 유지.
// 공식 권장 TTS 모델, REST /audio/speech에서 MP3 바이너리를 받는다.
// https://developers.openai.com/api/docs/guides/text-to-speech (2026-10-12)
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const INPUT_MAX_BYTES = 5000;
const INPUT_CHUNK_BYTES = 2000; // 4981바이트 실호출이 30초를 넘겨 더 작은 문장 묶음으로 요청한다(리규형님 확인 10-06)
const REQUEST_TIMEOUT_MS = 90_000; // 여러 조각·markup 평문 재시도를 포함한 문단 전체 제한, 5000바이트 실측 51초(리규형님 확인 10-06)

type TtsResult = { ok: true; base64: string; mimeType: string } | { ok: false; error: string };
type AudioResult = { audio: Buffer } | { error: string; status?: number };

// readaloud_text.py:870–880 / tts-engines.js:542–550의 한국어 Chirp 3 HD 쉼 보정.
function pausesMarkup(text: string, lang: TargetLang): string | null {
  // 원본처럼 한국어 음성만(readaloud_text.py:875 voice_lang 조건)
  if (lang !== "ko") return null;
  if (!/,\s|\u2003/.test(text)) return null;
  return text.replace(/\[/g, "(").replace(/\]/g, ")")
    .replace(/,(?=\s)/g, ", [pause short]").replace(/\u2003/g, " [pause] ");
}

/**
 * 음성 회사로 실제로 보낸 글 — 최근 SENT_KEEP 개만 이 기기 파일에 남긴다(10-16 리규형님 "')' 를 '작은괄호 닫기'로 읽더라" — 코드로는
 * 괄호가 음성까지 가는 길을 못 찾아, 다시 들리면 그 시각의 보낸 글로 바로 찾는다). 화면에 보이던 글이라 비밀값은 아니지만 이 기기 밖으로 내보내지 않는다
 */
const SENT_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar", "tts-sent.jsonl");
const SENT_KEEP = 50;
let sentLines: string[] | null = null;
let sentWriting: Promise<void> = Promise.resolve();
function noteSent(texts: string[], lang: TargetLang, provider: AudioProvider): void {
  sentWriting = sentWriting.then(async () => {
    if (!sentLines) sentLines = (await readFile(SENT_FILE, "utf8").catch(() => "")).split("\n").filter(Boolean).slice(-SENT_KEEP);
    for (const text of texts) sentLines.push(JSON.stringify({ at: new Date().toISOString(), lang, provider, text: text.slice(0, 1200) }));
    sentLines = sentLines.slice(-SENT_KEEP);
    await mkdir(dirname(SENT_FILE), { recursive: true });
    await writeFile(SENT_FILE, sentLines.join("\n") + "\n", { mode: 0o600 });
  }).catch(() => { /* 기록 실패는 읽기에 영향 없음 */ });
}

function fits(text: string, lang: TargetLang): boolean {
  return Buffer.byteLength(pausesMarkup(text, lang) ?? text, "utf8") <= INPUT_CHUNK_BYTES;
}

/** 문장 경계를 우선하고, 한 문장도 너무 길면 공백·마지막으로 유니코드 코드 포인트 경계로 나눈다. */
function splitInput(text: string, lang: TargetLang): string[] {
  const chunks: string[] = [];
  let current = "";
  const append = (piece: string) => {
    const joined = current ? `${current} ${piece}` : piece;
    if (fits(joined, lang)) current = joined;
    else {
      if (current) chunks.push(current);
      current = piece;
    }
  };
  for (const sentence of text.split(/(?<=[.!?…。！？])[ \t\u00a0\u3000]+|[ \t]*\r?\n[ \t\r\n]*/).filter(Boolean)) {
    if (fits(sentence, lang)) { append(sentence); continue; }
    const chars = Array.from(sentence);
    let start = 0;
    while (start < chars.length) {
      let low = 1;
      let high = Math.min(INPUT_CHUNK_BYTES, chars.length - start);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(chars.slice(start, start + mid).join(""), lang)) low = mid;
        else high = mid - 1;
      }
      let piece = chars.slice(start, start + low).join("");
      if (start + low < chars.length) {
        const boundary = piece.search(/\s+\S*$/u);
        if (boundary > 0) {
          piece = piece.slice(0, boundary);
          low = Array.from(piece).length;
        }
      }
      append(piece);
      start += low;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function requestAudio(input: { text: string } | { markup: string }, key: string, signal: AbortSignal, lang: TargetLang, voice: string): Promise<AudioResult> {
  if (Buffer.byteLength("markup" in input ? input.markup : input.text, "utf8") > INPUT_MAX_BYTES) {
    return { error: "음성 입력 크기 초과" };
  }
  const response = await fetch(SYNTHESIZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal,
    body: JSON.stringify({
      input,
      voice: { languageCode: GOOGLE_LANGUAGE_CODES[lang], name: `${GOOGLE_LANGUAGE_CODES[lang]}-Chirp3-HD-${voice}` },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
    }),
  });
  if (!response.ok) return { error: `음성 합성 실패 (HTTP ${response.status})`, status: response.status };
  const data = await response.json() as { audioContent?: unknown };
  if (typeof data.audioContent !== "string" || !data.audioContent ||
      data.audioContent.includes(key) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.audioContent) || data.audioContent.length % 4) {
    return { error: "음성 응답 형식 오류" };
  }
  const audio = Buffer.from(data.audioContent, "base64");
  return audio.length ? { audio } : { error: "빈 음성 응답" };
}

async function requestOpenaiAudio(text: string, key: string, signal: AbortSignal, voice: string, lang: TargetLang): Promise<AudioResult> {
  // 기존 2000 UTF-8바이트 분할은 공식 4096문자 상한에도 들어간다. 재시도는 추가하지 않는다.
  // https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal,
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice, input: text, response_format: "mp3",
      instructions: `Read the text with ${LANGUAGE_NAMES[lang]} pronunciation. Do not translate or change the words.` }),
  });
  if (!response.ok) return { error: `OpenAI 음성 합성 실패 (HTTP ${response.status})` };
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  if (type !== "audio/mpeg" && type !== "audio/mp3" && type !== "application/octet-stream") return { error: "음성 응답 형식 오류" };
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.includes(Buffer.from(key))) return { error: "음성 응답 형식 오류" };
  return { audio };
}

/** 명시한 공급자·언어·목소리로 합성. 미리 듣기·키 확인은 저장 설정을 우회해야 한다. */
export async function synthesizeVoice(text: string, lang: TargetLang, provider: AudioProvider, voice: string): Promise<TtsResult> {
  const started = Date.now();
  let count = 0;
  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const validVoices: readonly string[] = provider === "google" ? GOOGLE_VOICES : OPENAI_VOICES;
    if (!validVoices.includes(voice)) return { ok: false, error: "지원하지 않는 목소리입니다" };
    const keys = readGoogleKeys();
    const key = provider === "google" ? keys.tts : keys.openai;
    if (!key) return { ok: false, error: `${provider} TTS 키가 없습니다` };
    const spoken = makeSpokenText(text, lang);
    // 다듬으니 빈 글(괄호·기호만 있던 문단 — 10-13 괄호 안·기호를 안 읽게 한 뒤 생긴다)은 오류 대신 아주 짧은 무음.
    // 재생기는 합성 실패에서 멈추므로, 무음이면 그 문단을 소리 없이 지나 다음 문단으로 간다
    if (!spoken) {
      ok = true;
      return { ok: true, base64: LEGACY_SILENT_WAV.slice(LEGACY_SILENT_WAV.indexOf(",") + 1), mimeType: "audio/wav" };
    }
    const chunks = splitInput(spoken, lang);
    count = chunks.length;
    noteSent(chunks.map((c) => (provider === "google" ? pausesMarkup(c, lang) ?? c : c)), lang, provider);
    const audio: Buffer[] = [];
    for (const chunk of chunks) {
      const markup = provider === "google" ? pausesMarkup(chunk, lang) : null;
      let result: AudioResult;
      if (provider === "openai") {
        result = await requestOpenaiAudio(chunk, key, controller.signal, voice, lang);
      } else if (markup) {
        result = await requestAudio({ markup }, key, controller.signal, lang, voice);
        // markup 미지원·거절(400)만 평문 재시도한다. 인증·할당량·시간 초과는 즉시 실패한다.
        if ("error" in result && result.status === 400) result = await requestAudio({ text: chunk }, key, controller.signal, lang, voice);
      } else {
        result = await requestAudio({ text: chunk }, key, controller.signal, lang, voice);
      }
      if ("error" in result) return { ok: false, error: result.error };
      audio.push(result.audio);
    }
    ok = true;
    return { ok: true, base64: Buffer.concat(audio).toString("base64"), mimeType: "audio/mpeg" };
  } catch {
    return { ok: false, error: controller.signal.aborted ? "음성 합성 시간 초과" : "음성 합성 요청 또는 응답 실패" };
  } finally {
    clearTimeout(timer);
    console.log(`[tts] ${lang} 1문단(${count}조각) · ${Date.now() - started}ms · ${ok ? "완료" : "실패"}`);
  }
}

export async function synthesizeText(text: string, lang: TargetLang = "ko"): Promise<TtsResult> {
  try {
    const settings = readSpeechSettings(lang).settings;
    return await synthesizeVoice(text, settings.lang, settings.tts, settings.voice[settings.tts]);
  } catch { return { ok: false, error: "음성 공급자 설정을 읽지 못했습니다" }; }
}
export async function previewVoice(input: { provider: AudioProvider; voice: string; lang: TargetLang }): Promise<TtsResult> {
  return synthesizeVoice(PREVIEW_TEXT[input.lang], input.lang, input.provider, input.voice);
}
