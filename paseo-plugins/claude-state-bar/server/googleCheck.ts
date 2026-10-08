import { createHash } from "node:crypto";
import type { GoogleKeysState } from "../shared/googleKeys";
import type { TargetLang } from "../shared/translate";
import { isWritableKey, readGoogleKeys, writeGoogleKeys } from "./googleKeys";
import { translateBatch } from "./translate";
import { synthesizeText } from "./tts";

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
export function saveGoogleKeys(input: { gemini?: string; tts?: string }):
  | { ok: true; state: GoogleKeysState }
  | { ok: false; reason: "invalid" | "write"; field?: "gemini" | "tts" } {
  const patch: { gemini?: string; tts?: string } = {};
  for (const field of ["gemini", "tts"] as const) {
    const value = input[field]?.trim();
    if (!value) continue;
    if (!isWritableKey(value)) return { ok: false, reason: "invalid", field };
    patch[field] = value;
  }
  if (patch.gemini === undefined && patch.tts === undefined) return { ok: true, state: googleKeysState() };
  try {
    writeGoogleKeys(patch);
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
    jobs.push(synthesizeText(sample.tts, lang).then((result) => {
      lastChecks.set("tts", { ok: result.ok, at: Date.now(), fingerprint: fingerprint(key) });
    }));
  }
  await Promise.all(jobs);
  const state = googleKeysState();
  console.log(`[google-keys] check ${lang}: translate=${state.translate.check ? (state.translate.check.ok ? "ok" : "failed") : "none"} tts=${state.tts.check ? (state.tts.check.ok ? "ok" : "failed") : "none"}`);
  return state;
}
