import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { targetLangSchema } from "./translate";

// 설정 화면 "번역·읽기" 칸의 키 넣기·확인(리규형님 10-08 결정). 키는 지금처럼 이 데몬의 ~/.paseo/claude-state-bar/google.env 에만
// 둔다(server/googleKeys). 설정 화면은 소리 담당 호스트(PC) 플러그인만 붙이므로 실제로는 PC 데몬만 이 요청을 받는다.
// 🔴 데몬은 키 값을 화면에 절대 돌려보내지 않는다 — 있음/없음과 마지막 확인 결과(성공/실패·시각)만.

/** 키 하나의 상태. check = 지금 저장된 그 키로 마지막에 확인한 결과(키가 바뀌었거나 아직 확인 안 했으면 null) */
const keyStateSchema = z.object({
  saved: z.boolean(),
  check: z.object({ ok: z.boolean(), at: z.number() }).nullable(),
});
export const googleKeysStateSchema = z.object({ translate: keyStateSchema, tts: keyStateSchema });
export type GoogleKeysState = z.infer<typeof googleKeysStateSchema>;

export const googleKeysState = defineRpc({
  name: "google.keys-state",
  input: z.object({}),
  output: googleKeysStateSchema,
});

/** 넣은 키만 바꾼다(빈 칸·없는 칸은 그대로). 파일의 다른 줄은 그대로 둔다 */
export const googleKeysSave = defineRpc({
  name: "google.keys-save",
  input: z.object({ gemini: z.string().optional(), tts: z.string().optional() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), state: googleKeysStateSchema }),
    // invalid = 키 글에 빈칸·따옴표·# 같은, 키 파일 한 줄을 깨는 글자가 있다 · write = 파일을 쓰지 못함
    z.object({ ok: z.literal(false), reason: z.enum(["invalid", "write"]), field: z.enum(["gemini", "tts"]).optional() }),
  ]),
});

/** 저장된 키로 실제로 짧게 한 번 번역하고 한 번 합성해 본다. lang = 지금 화면 언어(번역 대상·음성 언어) */
export const googleKeysCheck = defineRpc({
  name: "google.keys-check",
  input: z.object({ lang: targetLangSchema.optional() }),
  output: googleKeysStateSchema,
});
