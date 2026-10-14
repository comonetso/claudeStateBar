import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 같은 창에서 계정 바꾸기(리규형님 10-14 — 팀 계정이 5시간 한도에 걸려 대화가 멈췄을 때 창을 새로 열지 않고 개인 계정으로 이어 가려고).
// Paseo 는 대화의 공급자를 바꾸지 못하게 막아 두었다(다시 띄울 때 공급자만 원래 값으로 되돌린다 — agent-manager reloadAgentSessionInternal).
// 그래서 공급자는 그대로 두고, 대화를 다시 띄울 때 Claude 가 쓰는 계정 값(PC 는 계정 폴더, 서버는 팀 토큰)만 플러그인이 바꿔 넣는다.
// 같은 Claude 대화 기록을 그대로 이어 쓰므로 맥락이 유지된다(10-14 실측). Codex 같은 다른 공급자로는 못 넘긴다(기록 형식이 다르다).

/** 팀 공급자 한도 원천 번호(server/teamUsage) — 사용량 칸이 이 카드는 이름을 줄이지 않는다 */
export const TEAM_USAGE_SOURCE_ID = "claude-state-bar-team";
export const accountKind = z.enum(["team", "personal"]);
export type AccountKind = z.infer<typeof accountKind>;

/** 이 기기에서 계정을 바꾼 대화 목록이 바뀔 때까지 기다린다(길어도 25초). 지금 아는 번호를 보내면, 다르면 바로 답한다.
 *  supported = 이 기기 Paseo 설정에 팀 공급자가 있어 계정을 바꿀 수 있는가(팀원 데몬은 늘 false).
 *  names = 화면에 보일 계정 이름 — 이 기기 Paseo 공급자 이름 그대로(리규형님 10-14: "팀·개인"은 내 방식일 뿐, 다른 사람을 생각하면
 *  공급자 이름을 그대로). 옛 서버는 보내지 않는다 */
export const accountsWait = defineRpc({
  name: "account.wait",
  input: z.object({ rev: z.number().nullable() }),
  output: z.object({
    rev: z.number(),
    supported: z.boolean(),
    accounts: z.record(z.string(), accountKind),
    names: z.object({ team: z.string(), personal: z.string() }).optional(),
  }),
});

/** 대화의 계정을 바꾸고 다시 띄운다. 원래 계정으로 바꾸면 기억을 지운다(공급자 기본으로 돌아감) */
export const accountSwitch = defineRpc({
  name: "account.switch",
  input: z.object({ agentId: z.string(), to: accountKind }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});
