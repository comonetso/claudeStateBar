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

// 끝남 소리 직전에 묻는다 — 방금 끝난 차례가 슬래시 명령만으로 끝났으면(모델 답 없음) 울리지 않는다(리규형님 10-06 결정)
export const lastTurnCheck = defineRpc({
  name: "chime.last-turn",
  input: z.object({ sessionId: z.string() }),
  output: z.object({ commandOnly: z.boolean() }),
});

export const chimeForget = defineRpc({
  name: "chime.forget",
  input: z.object({ clientId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// v2는 개수가 아니라 완료한 실제 항목 번호를 보존한다. 옛 check 출력은 그대로 둔다.
export const chimeCheckV2 = defineRpc({
  name: "chime.check-v2",
  input: z.object({ clientId: z.string(), sessionId: z.string(), cwd: z.string().optional(), baseline: z.boolean().optional() }),
  output: z.object({ events: z.array(z.string()), found: z.boolean(), recheckAfterMs: z.number().optional() }),
});
