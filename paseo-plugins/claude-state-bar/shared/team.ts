import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 팀원 관리(10-11 시험판) — 리규형님: 팀원을 추가할 때 서버(다중)·프로젝트(다중)를 고르고, 그 직원에게 맞는 스킬·명령어를
// 글로벌 것에서 골라 프로젝트 스킬·명령어로 넣는다. 지금은 화면 시험판이라 저장·배치는 아직 없고, 고를 목록만 데몬에서 읽는다.

const item = z.object({ kind: z.enum(["skill", "command"]), name: z.string(), description: z.string() });

/** 이 기기(PC) 글로벌 스킬(~/.claude/skills/<이름>/SKILL.md)과 명령어(~/.claude/commands/<이름>.md) — "이 서버에만" 표시용 비교 */
export const teamSkills = defineRpc({
  name: "team.skills",
  input: z.object({}),
  output: z.object({ skills: z.array(item) }),
});

/** 서버 한 대(SSH 별칭)의 글로벌 스킬·명령어 — 직원에게 줄 것은 그 서버에서 고르고 그 서버에서 복사한다 */
export const teamServerSkills = defineRpc({
  name: "team.server_skills",
  input: z.object({ host: z.string() }),
  output: z.object({ skills: z.array(item), error: z.string().nullable() }),
});
