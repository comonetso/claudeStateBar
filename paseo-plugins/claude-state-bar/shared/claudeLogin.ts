import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Paseo 안에서 Claude 다시 로그인(리규형님 10-14). 10-14 오후 PC 개인 계정 대화 네 개가 "Failed to authenticate: OAuth session
// expired and could not be refreshed" 로 함께 끊겼는데 Paseo 에는 다시 로그인할 길이 없어 CLI 로 로그인해야 했다.
// 그 기기 데몬이 `claude auth login` 을 대신 띄워 승인 링크를 화면에 주고, 승인 페이지가 보여 주는 코드를 받아 넘긴다.
// 자리는 로그인이 풀린 대화 입력창 위 알약과 설정 화면 칸 둘 다 · PC 와 서버 3대 · 끊긴 말은 다시 보내지 않는다(리규형님 결정).

/** 로그인할 수 있는 Claude 로그인 파일 하나. id = 그 로그인 파일을 쓰는 첫 공급자 번호, label = 그 공급자들의 Paseo 이름.
 *  usage = 사용량 보기용 로그인(10-22 리규형님 — 1년 열쇠로 도는 서버 팀 공급자는 그 열쇠로 사용량을 못 읽어 PC 가 꺼지면 카드가 사라졌다.
 *  대화는 열쇠 그대로 두고 사용량 카드만 이 로그인으로 읽는다 — server/usageLogin). 이때 id = `공급자번호:usage`, loggedIn·account = 지금 로그인
 *  상태와 그 계정 메일(승인한 계정이 공급자 이름과 맞는지 눈으로 보게). 옛 서버는 보내지 않는다 */
export const loginTarget = z.object({
  id: z.string(),
  label: z.string(),
  usage: z.boolean().optional(),
  loggedIn: z.boolean().optional(),
  account: z.string().nullable().optional(),
});
export type LoginTarget = z.infer<typeof loginTarget>;

export const loginSnapshot = z.object({
  rev: z.number(),
  /** 이 기기에서 다시 로그인할 수 있는가(팀원 데몬은 false) */
  supported: z.boolean(),
  targets: z.array(loginTarget),
  /** 로그인 오류로 끝난 대화 → 다시 로그인할 대상 번호 */
  needs: z.record(z.string(), z.string()),
  /** 진행 중인 로그인 — 다른 화면에서 시작한 것도 이어서 코드를 넣을 수 있게 링크를 같이 준다 */
  running: z.object({ target: z.string(), url: z.string().nullable() }).nullable(),
});
export type LoginSnapshot = z.infer<typeof loginSnapshot>;

/** 상태가 바뀔 때까지 기다린다(길어도 25초). 지금 아는 번호와 다르면 바로 답한다 */
export const loginWait = defineRpc({
  name: "claude_login.wait",
  input: z.object({ rev: z.number().nullable() }),
  output: loginSnapshot,
});

/** 로그인을 시작하고 승인 링크를 받는다. 진행 중인 로그인이 있으면 끄고 새로 시작한다 */
export const loginStart = defineRpc({
  name: "claude_login.start",
  input: z.object({ target: z.string() }),
  output: z.object({ ok: z.boolean(), url: z.string().optional(), error: z.string().optional() }),
});

/** 승인 페이지가 보여 준 코드를 넘기고 로그인이 끝나기를 기다린다 */
export const loginCode = defineRpc({
  name: "claude_login.code",
  input: z.object({ code: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

export const loginCancel = defineRpc({
  name: "claude_login.cancel",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});
