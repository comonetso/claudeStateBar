import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 생각 상자 영어 → 한국어 번역(리규형님 10-06: 상자의 [번역] 버튼을 누를 때만 · 구글 Gemini 키).
// 대화가 도는 기기의 데몬이 그 기기 키 파일로 번역한다. 문단 단위로 보내고 같은 순서로 받는다.
export const translateKo = defineRpc({
  name: "translate.ko",
  input: z.object({ texts: z.array(z.string()).max(20) }),
  // 번역하지 못한 문단은 null(영어 그대로 둔다). error 는 통째로 실패했을 때 사유(키 없음·요청 실패 등) — 화면에 짧게 보인다
  output: z.object({ translations: z.array(z.string().nullable()), error: z.string().optional() }),
});
