import { createHash } from "node:crypto";
import type { GoogleKeysState } from "../shared/googleKeys";
import type { TargetLang } from "../shared/translate";
import { isWritableKey, readGoogleKeys, writeGoogleKeys } from "./googleKeys";
import { translateBatch } from "./translate";
import { synthesizeVoice } from "./tts";
import { KEY_FIELDS, neededKeyFields, PREVIEW_TEXT, type KeyField, type SpeechKeysState, type SpeechSettings } from "../shared/speech";

// 설정 화면 "번역·읽기" 칸의 키 저장·확인(리규형님 10-08 결정). [키 확인] = 실제로 짧게 한 번 번역하고 한 번 합성해 보고 성공/실패만.
// 🔴 키 값은 화면·로그 어디로도 내보내지 않는다. 마지막 확인 결과는 이 데몬 메모리에만 두고, 어느 키로 확인했는지는 키의 지문
// (해시)으로만 기억한다 — 키가 바뀌면 그 결과는 "아직 확인 안 함"으로 돌아간다. 플러그인이 다시 읽히면 결과도 잊는다.

type Kind = "translate" | "tts";
type LastCheck = { ok: boolean; at: number; fingerprint: string };
const lastChecks = new Map<Kind, LastCheck>();

// 확인용 짧은 글(Claude 가 고름) — 번역은 대상 언어가 아닌 글이어야 실제로 번역된다. 읽기는 그 언어 음성으로 한 단어
const SAMPLES: Record<TargetLang, { translate: string; tts: string }> = {
  ko: { translate: "Good morning.", tts: "확인" },
  en: { translate: "좋은 아침입니다.", tts: "Check" },
  ja: { translate: "Good morning.", tts: PREVIEW_TEXT.ja },
  zh: { translate: "Good morning.", tts: PREVIEW_TEXT.zh },
  es: { translate: "Good morning.", tts: PREVIEW_TEXT.es },
  fr: { translate: "Good morning.", tts: PREVIEW_TEXT.fr },
  ar: { translate: "Good morning.", tts: PREVIEW_TEXT.ar },
};

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function stateOf(kind: Kind, key: string | undefined): GoogleKeysState[Kind] {
  if (!key) return { saved: false, check: null };
  const last = lastChecks.get(kind);
  return { saved: true, check: last && last.fingerprint === fingerprint(key) ? { ok: last.ok, at: last.at } : null };
}

export function googleKeysState(): GoogleKeysState {
  const keys = readGoogleKeys();
  return { translate: stateOf("translate", keys.gemini), tts: stateOf("tts", keys.tts) };
}

/** 넣은 키만 바꾼다. 빈 칸(앞뒤 빈칸을 걷고 비면)은 그대로 둔다 */
export async function saveGoogleKeys(input: { gemini?: string; tts?: string }):
  Promise<{ ok: true; state: GoogleKeysState }
  | { ok: false; reason: "invalid" | "write"; field?: "gemini" | "tts" }> {
  const patch: { gemini?: string; tts?: string } = {};
  for (const field of ["gemini", "tts"] as const) {
    const value = input[field]?.trim();
    if (!value) continue;
    if (!isWritableKey(value)) return { ok: false, reason: "invalid", field };
    patch[field] = value;
  }
  if (patch.gemini === undefined && patch.tts === undefined) return { ok: true, state: googleKeysState() };
  try {
    await writeGoogleKeys(patch);
  } catch (error) {
    // 오류 글에는 경로만 들어 있다(키 값 없음) — 그래도 로그에는 코드만 남긴다
    console.log(`[google-keys] write failed: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    return { ok: false, reason: "write" };
  }
  console.log(`[google-keys] saved${patch.gemini !== undefined ? " gemini" : ""}${patch.tts !== undefined ? " tts" : ""}`);
  return { ok: true, state: googleKeysState() };
}

/** 저장된 키로 실제 호출 한 번씩. 키가 없는 쪽은 부르지 않는다 */
export async function checkGoogleKeys(lang: TargetLang = "ko"): Promise<GoogleKeysState> {
  const keys = readGoogleKeys();
  const sample = SAMPLES[lang];
  const jobs: Promise<void>[] = [];
  if (keys.gemini) {
    const key = keys.gemini;
    jobs.push(translateBatch([sample.translate], key, lang).then((result) => {
      const ok = !result.error && typeof result.translations[0] === "string";
      lastChecks.set("translate", { ok, at: Date.now(), fingerprint: fingerprint(key) });
    }));
  }
  if (keys.tts) {
    const key = keys.tts;
    jobs.push(synthesizeVoice(sample.tts, lang, "google", "Zephyr").then((result) => {
      lastChecks.set("tts", { ok: result.ok, at: Date.now(), fingerprint: fingerprint(key) });
    }));
  }
  await Promise.all(jobs);
  const state = googleKeysState();
  console.log(`[google-keys] check ${lang}: translate=${state.translate.check ? (state.translate.check.ok ? "ok" : "failed") : "none"} tts=${state.tts.check ? (state.tts.check.ok ? "ok" : "failed") : "none"}`);
  return state;
}

// 공급자 키 하나의 확인 결과는 수행한 번역·합성 모두 성공해야 성공이다.
const speechChecks = new Map<KeyField, LastCheck>();
export function speechKeysState(): SpeechKeysState {
  const keys = readGoogleKeys();
  return Object.fromEntries(KEY_FIELDS.map((field) => {
    const key = keys[field];
    const last = speechChecks.get(field);
    return [field, { saved: !!key, check: key && last?.fingerprint === fingerprint(key) ? { ok: last.ok, at: last.at } : null }];
  })) as SpeechKeysState;
}
export async function saveSpeechKeys(input: Partial<Record<KeyField, string>>) {
  const patch: Partial<Record<KeyField, string>> = {};
  for (const field of KEY_FIELDS) {
    const value = input[field]?.trim();
    if (!value) continue;
    if (!isWritableKey(value)) return { ok: false as const, reason: "invalid" as const, field };
    patch[field] = value;
  }
  try { if (Object.keys(patch).length) await writeGoogleKeys(patch); }
  catch { return { ok: false as const, reason: "write" as const }; }
  return { ok: true as const, state: speechKeysState() };
}
export async function checkSpeechKeys(settings: SpeechSettings): Promise<SpeechKeysState> {
  const keys = readGoogleKeys();
  const sample = SAMPLES[settings.lang];
  await Promise.all(neededKeyFields(settings).map(async (field) => {
    const key = keys[field];
    if (!key) return;
    let ok = false;
    try {
      const jobs: Promise<boolean>[] = [];
      // Google Gemini·OpenAI를 STT로만 골라도 기존처럼 짧은 번역 한 번으로 글/받아쓰기 키를 확인한다.
      // 오디오 샘플을 추가로 만드는 새 호출은 없다.
      if (field !== "tts") {
        const provider = field === "gemini" ? "google" : field;
        jobs.push(translateBatch([sample.translate], key, settings.lang, provider).then((r) => !r.error && typeof r.translations[0] === "string"));
      }
      if (field === "tts" || (field === "openai" && settings.tts === "openai")) {
        const provider = field === "tts" ? "google" : "openai";
        jobs.push(synthesizeVoice(sample.tts, settings.lang, provider, settings.voice[provider]).then((r) => r.ok));
      }
      ok = (await Promise.all(jobs)).every(Boolean);
    } catch { /* 사유 원문이나 키를 로그에 남기지 않는다 */ }
    speechChecks.set(field, { ok, at: Date.now(), fingerprint: fingerprint(key) });
  }));
  return speechKeysState();
}
