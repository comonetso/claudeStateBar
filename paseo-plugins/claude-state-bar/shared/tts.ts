import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 생각 상자 소리 읽기(리규형님 10-06: [읽기]·[번역읽기] 버튼 · 웹·데스크톱만, 폰 앱은 소리 없이 번역만).
// 대화가 도는 기기의 데몬이 그 기기 키 파일로 구글 음성 합성을 부른다. 문단 하나씩 요청한다.
export const ttsSynthesize = defineRpc({
  name: "tts.synthesize",
  // 화면에 보이는 문단 글 그대로 보낸다 — 읽기용 정리(마크다운 기호 빼기 등)는 데몬이 한다
  input: z.object({ text: z.string() }),
  output: z.union([
    z.object({ ok: z.literal(true), base64: z.string(), mimeType: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

// 이 기기에 키가 있는가 — 없는 쪽 버튼은 숨긴다(번역 = Gemini 키, 소리 = 음성 합성 키)
export const googleStatus = defineRpc({
  name: "google.status",
  input: z.object({}),
  output: z.object({ translate: z.boolean(), tts: z.boolean() }),
});
