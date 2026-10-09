import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 폰 받아쓰기(10-10 리규형님 결정) — Paseo 마이크 단추는 그대로 두고, Paseo 의 OpenAI 받아쓰기 칸 주소를 이 플러그인의
// 받는 곳(server/sttServer)으로 돌려 Gemini 로 받아쓰고 다듬는다. 이름 힌트 = "Paseo" 같은 이름을 맞게 적도록 알려 주는 목록.
// 설정 화면 칸에서 고치고(PC 데몬에 저장), PC 데몬이 서버들에도 같은 파일을 보낸다.

/** 힌트 파일이 아직 없을 때의 처음 내용(10-10 시험에 쓴 목록 — 리규형님 결정) */
export const DEFAULT_STT_HINTS = "Paseo, Claude, Codex, Gemini, config.json";

export const sttHintsGet = defineRpc({
  name: "stt.hints-get",
  input: z.object({}),
  output: z.object({ hints: z.string() }),
});

/** 저장하고 서버들에 보낸 결과. hosts = 보낸 서버마다 성공 여부(목록이 없는 데몬이면 빈 배열) */
export const sttHintsSave = defineRpc({
  name: "stt.hints-save",
  input: z.object({ hints: z.string() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), hosts: z.array(z.object({ host: z.string(), ok: z.boolean() })) }),
    z.object({ ok: z.literal(false), reason: z.literal("write") }),
  ]),
});
