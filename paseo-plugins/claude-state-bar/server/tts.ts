import type { TargetLang } from "../shared/translate";
import { readGoogleKeys } from "./googleKeys";

const SYNTHESIZE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
// 언어별 음성(10-08 — 음성 언어 = 번역 대상 언어 = Paseo 언어 설정). 영어는 한국어와 같은 Chirp 3 HD 의 같은 이름 음성
// (Claude 가 고름 — 실제 호출로 확인하지 않았다)
const VOICES: Record<TargetLang, { languageCode: string; name: string }> = {
  ko: { languageCode: "ko-KR", name: "ko-KR-Chirp3-HD-Callirrhoe" },
  en: { languageCode: "en-US", name: "en-US-Chirp3-HD-Callirrhoe" },
};
// 원본 readaloud_text.py:482-485 SPOKEN_SIGNS 의 ko·en 과 같은 이름(백슬래시는 원본에 없어 추가)
const SPOKEN_SIGNS: Record<TargetLang, Record<string, string>> = {
  ko: { ".": " 쩜 ", "_": " 언더바 ", "/": " 슬래시 ", "\\": " 백슬래시 ", "-": " 대시 " },
  en: { ".": " dot ", "_": " underscore ", "/": " slash ", "\\": " backslash ", "-": " dash " },
};
const INPUT_MAX_BYTES = 5000;
const INPUT_CHUNK_BYTES = 2000; // 4981바이트 실호출이 30초를 넘겨 더 작은 문장 묶음으로 요청한다(리규형님 확인 10-06)
const REQUEST_TIMEOUT_MS = 90_000; // 여러 조각·markup 평문 재시도를 포함한 문단 전체 제한, 5000바이트 실측 51초(리규형님 확인 10-06)
const REPEATED_CHARS_MAX = 3;

type TtsResult = { ok: true; base64: string; mimeType: string } | { ok: false; error: string };
type AudioResult = { audio: Buffer } | { error: string; status?: number };

/** 화면 글은 바꾸지 않는다. 음성에만 필요한 마크다운·코드 이름 정리를 적용한다. */
function makeSpokenText(text: string, lang: TargetLang): string {
  let spoken = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s<>()]+/gi, "HTTP URL.")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/[|]/g, " ")
    .replace(/→|⇒|->|=>/g, ".\u2003")
    .replace(/([^\d\s])\1{3,}/gu, (_, char: string) => char.repeat(REPEATED_CHARS_MAX));
  const signs = SPOKEN_SIGNS[lang];
  spoken = spoken.replace(/[A-Za-z][A-Za-z0-9_]*(?:[./\\-][A-Za-z0-9_]+)*/g, (token) => {
    const named = token.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .replace(/[._/\\-]/g, (sign) => signs[sign] ?? sign);
    // 대문자 두 글자 띄어 읽기는 한국어 음성만(원본 readaloud_text.py:571 — 영어 음성은 그대로 둔다)
    return lang === "ko" ? named.replace(/\b[A-Z]{2}\b/g, (letters) => letters.split("").join(" ")) : named;
  });
  return spoken.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// readaloud_text.py:870–880 / tts-engines.js:542–550의 한국어 Chirp 3 HD 쉼 보정.
function pausesMarkup(text: string, lang: TargetLang): string | null {
  // 원본처럼 한국어 음성만(readaloud_text.py:875 voice_lang 조건)
  if (lang !== "ko") return null;
  if (!/,\s|\u2003/.test(text)) return null;
  return text.replace(/\[/g, "(").replace(/\]/g, ")")
    .replace(/,(?=\s)/g, ", [pause short]").replace(/\u2003/g, " [pause] ");
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

async function requestAudio(input: { text: string } | { markup: string }, key: string, signal: AbortSignal, lang: TargetLang): Promise<AudioResult> {
  if (Buffer.byteLength("markup" in input ? input.markup : input.text, "utf8") > INPUT_MAX_BYTES) {
    return { error: "음성 입력 크기 초과" };
  }
  const response = await fetch(SYNTHESIZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal,
    body: JSON.stringify({
      input,
      voice: VOICES[lang],
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

export async function synthesizeText(text: string, lang: TargetLang = "ko"): Promise<TtsResult> {
  const started = Date.now();
  let count = 0;
  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const key = readGoogleKeys().tts;
    if (!key) return { ok: false, error: "Google TTS 키가 없습니다" };
    const spoken = makeSpokenText(text, lang);
    if (!spoken) return { ok: false, error: "읽을 글이 없습니다" };
    const chunks = splitInput(spoken, lang);
    count = chunks.length;
    const audio: Buffer[] = [];
    for (const chunk of chunks) {
      const markup = pausesMarkup(chunk, lang);
      let result: AudioResult;
      if (markup) {
        result = await requestAudio({ markup }, key, controller.signal, lang);
        // markup 미지원·거절(400)만 평문 재시도한다. 인증·할당량·시간 초과는 즉시 실패한다.
        if ("error" in result && result.status === 400) result = await requestAudio({ text: chunk }, key, controller.signal, lang);
      } else {
        result = await requestAudio({ text: chunk }, key, controller.signal, lang);
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
