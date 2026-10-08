import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** 번역 대상·읽기 음성 언어(리규형님 10-08 결정: Paseo 언어 설정을 따른다 — client/appLanguage uiLanguage). 없으면 한국어 */
export const targetLangSchema = z.enum(["ko", "en"]);
export type TargetLang = z.infer<typeof targetLangSchema>;

// 생각 상자 번역(리규형님 10-06: 상자의 [번역] 버튼을 누를 때만 · 구글 Gemini 키).
// 대화가 도는 기기의 데몬이 그 기기 키 파일로 번역한다. 문단 단위로 보내고 같은 순서로 받는다.
// 10-08: 대상 언어 lang 을 더했다(ko = 한국어로, en = 영어로). 이름(translateKo · "translate.ko")은 옛 화면·옛 데몬과 맞물리게 그대로 둔다 —
// lang 없이 오는 옛 화면 요청은 한국어로, lang 을 모르는 옛 데몬(서버에 아직 새 판이 안 간 때)은 lang 을 버리고 한국어로 답한다.
export const translateKo = defineRpc({
  name: "translate.ko",
  input: z.object({ texts: z.array(z.string()).max(20), lang: targetLangSchema.optional() }),
  // 번역하지 못한 문단은 null(원문 그대로 둔다). error 는 통째로 실패했을 때 사유(키 없음·요청 실패 등) — 화면에 짧게 보인다
  output: z.object({ translations: z.array(z.string().nullable()), error: z.string().optional() }),
});
