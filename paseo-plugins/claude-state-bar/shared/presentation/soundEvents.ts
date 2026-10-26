import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { eventSchema } from "./soundClaim";
import { soundKinds } from "./sound";

// 화면 판정은 유지하되 번호/현재 유효성은 발생 데몬의 원본 snapshot으로 확인한다.
export const soundOriginObserve = defineRpc({
  name: "sound.origin-observe-v2", input: z.object({ agentId: z.string(), warningPercent: z.number(), dangerPercent: z.number() }), output: z.object({ ok: z.boolean() }),
});
export const soundOriginPrepare = defineRpc({
  name: "sound.origin-prepare-v2",
  input: z.object({ agentId: z.string(), kind: z.enum(soundKinds), nativeId: z.string(), warningPercent: z.number(), dangerPercent: z.number() }),
  output: z.object({ event: eventSchema.nullable() }),
});
export const soundOriginValidate = defineRpc({
  name: "sound.origin-validate-v2", input: z.object({ event: eventSchema, warningPercent: z.number(), dangerPercent: z.number() }), output: z.object({ valid: z.boolean() }),
});

// PC에 보고하지 못한 원본 이벤트는 발생 호스트에서도 폐기해 늦은 다른 화면이 부활시키지 않는다.
export const soundOriginDrop = defineRpc({
  name: "sound.origin-drop-v2", input: z.object({ eventId: z.string() }), output: z.object({ ok: z.boolean() }),
});
