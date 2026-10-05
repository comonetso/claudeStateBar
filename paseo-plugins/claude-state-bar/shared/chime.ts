import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 대화 하나에 새로 끝난 묶음(워크플로우·서브에이전트 묶음·백그라운드 작업·codex_rescue 실행)이 있는지 데몬에 묻는다.
// clientId 는 앱마다 따로 센다(휴대폰 앱이 PC 앱의 소리를 가로채지 않게).
export const chimeCheck = defineRpc({
  name: "chime.check",
  input: z.object({ clientId: z.string(), sessionId: z.string(), cwd: z.string().optional() }),
  output: z.object({
    chimes: z.number(),
    found: z.boolean(),
    recheckAfterMs: z.number().optional(),
  }),
});

export const chimeForget = defineRpc({
  name: "chime.forget",
  input: z.object({ clientId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
