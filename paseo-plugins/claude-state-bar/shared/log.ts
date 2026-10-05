import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 앱 화면 쪽 기록을 데몬 플러그인 로그(`paseo plugin logs`)로 보낸다
export const clientLog = defineRpc({
  name: "client.log",
  input: z.object({ message: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
