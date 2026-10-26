import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { targetLangSchema } from "./translate";

// 생각 상자 소리 읽기(리규형님 10-06: [읽기]·[번역읽기] 버튼 · 웹·데스크톱만, 폰 앱은 소리 없이 번역만).
// 대화가 도는 기기의 데몬이 speech.json의 공급자·목소리·언어와 그 기기 키 파일로 합성한다. 문단 하나씩 요청한다.
export const ttsSynthesize = defineRpc({
  name: "tts.synthesize",
  // 화면에 보이는 문단 글 그대로 보낸다 — 읽기용 정리(마크다운 기호 빼기 등)는 데몬이 한다.
  // lang(10-08) = 음성 언어. 번역 대상 언어와 같다(Paseo 언어 설정). 없으면 한국어 음성 — 옛 화면·옛 데몬과 맞물린다
  input: z.object({ text: z.string(), lang: targetLangSchema.optional() }),
  output: z.union([
    z.object({ ok: z.literal(true), base64: z.string(), mimeType: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

// 선택한 번역·읽기 공급자의 키가 있는가 — 옛 RPC 이름은 유지한다.
export const googleStatus = defineRpc({
  name: "google.status",
  input: z.object({}),
  output: z.object({ translate: z.boolean(), tts: z.boolean() }),
});
