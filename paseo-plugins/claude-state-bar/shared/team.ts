import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { projectEntrySchema, projectsEditOpSchema } from "./projects";

// 팀원 관리(10-11) — 리규형님: 팀원을 추가할 때 서버(다중)를 고르고, 그 직원에게 맞는 스킬·명령어를 글로벌 것에서 골라
// 프로젝트 스킬·명령어로 넣는다. 프로젝트는 리규형님 목록에서 고르지 않고 팀원 전용 프로젝트로 따로 둔다(10-11 오후 리규형님:
// 직원 → 그 직원의 카테고리 → 프로젝트). 팀원 목록·팀원 프로젝트는 PC 데몬에 저장만 하고, 서버에 직원을 만드는 일은 아직 없다.

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
  /** logs = 그 서버에 있는 기록(TEAM_LOGS 경로 중 실제로 있는 것) — 화면은 있는 것만 고르게 한다 */
  output: z.object({ skills: z.array(item), logs: z.array(z.string()).optional(), error: z.string().nullable() }),
});

/** 서버 한 대에서 이 팀원에게 주는 권한 — 모양·기본값·기록 목록은 shared/teamAccess.ts */
export const accessSchema = z.object({
  writable: z.array(z.string()),
  addOnly: z.array(z.string()).optional(),
  ports: z.array(z.number()),
  logs: z.array(z.string()),
  hideSecrets: z.boolean(),
});
export { defaultAccess, TEAM_LOGS, AFTER_MAX, AFTER_LEN, type TeamAccess, type AfterResult } from "./teamAccess";
const afterResultSchema = z.object({ command: z.string(), ok: z.boolean(), code: z.number().nullable(), out: z.string(), at: z.number() });

const memberSchema = z.object({
  /** 로그인 아이디 — 서버 직원 도구(team-daemon policy.py NAME)와 같은 규칙 */
  id: z.string(),
  servers: z.array(z.string()),
  /** "서버|skill:이름"·"서버|command:이름" — 서버가 달라도, 같은 이름이어도 안 섞이게 */
  skills: z.array(z.string()),
  /** 이 직원의 카테고리 순서(끌어 놓은 순서 = 번호). 끌어 놓은 적 없는 카테고리는 프로젝트에 처음 나오는 순서로 뒤에 */
  categoryOrder: z.array(z.string()),
  /** 팀원 전용 프로젝트 — 기기는 이 직원에게 고른 서버만 */
  projects: z.array(projectEntrySchema),
  /** 서버 → 그 서버에서 주는 권한(10-11 저녁에 더함 — 그 전 기록에는 없고, 없으면 기본값 defaultAccess) */
  access: z.record(z.string(), accessSchema).optional(),
  /** 서버 → 계정을 만든 뒤 그 서버에서 관리자 권한으로 한 번 실행할 명령(10-12, 최대 AFTER_MAX) */
  after: z.record(z.string(), z.array(z.string())).optional(),
  /** 서버 → 실행한 명령마다 마지막 결과 — 성공한 명령은 다시 실행하지 않는다 */
  afterRan: z.record(z.string(), z.array(afterResultSchema)).optional(),
  /** 서버에 직원 Paseo 를 만든 서버들(서버에 반영 작업이 끝난 것) */
  applied: z.array(z.string()),
  /** 서버 → 로그인 서버에 등록한 직원용 연결 이름 */
  links: z.record(z.string(), z.string()),
  /** 로그인 서버에 직원 계정을 만들었는가(비밀번호·OTP 는 콜어드민 터미널에서 따로) */
  loginAdded: z.boolean(),
  /** 마지막 서버 반영 뒤 바뀐 것이 있다 */
  dirty: z.boolean(),
  /** 바뀔 때마다 1씩 — 반영 작업 중에 또 바뀌었는지 가린다 */
  rev: z.number(),
});
export type TeamMember = z.infer<typeof memberSchema>;
/**
 * remove-keep = 홈 디렉터리 유지 · remove-purge = 완전 삭제(10-11 리규형님: 삭제를 누를 때 둘 중 하나를 고른다) ·
 * invite = 초대 키 다시 발급(등록을 아직 안 마친 직원 — 잃어버렸거나 24시간이 지났을 때)
 */
export const TEAM_JOB_ACTIONS = ["apply", "skills", "remove-keep", "remove-purge", "invite"] as const;
export type TeamJobAction = (typeof TEAM_JOB_ACTIONS)[number];

const teamResult = z.object({ ok: z.boolean(), error: z.string().optional(), members: z.array(memberSchema) });

export const teamState = defineRpc({
  name: "team.state",
  input: z.object({}),
  output: teamResult,
});

/** 팀원 추가·고치기 — previousId 가 있으면 그 팀원을 고친다(팀원 프로젝트는 그대로 따라간다) */
export const teamMemberSave = defineRpc({
  name: "team.member_save",
  input: z.object({
    previousId: z.string().nullable(),
    id: z.string(),
    servers: z.array(z.string()),
    skills: z.array(z.string()),
    access: z.record(z.string(), accessSchema).optional(),
    after: z.record(z.string(), z.array(z.string())).optional(),
  }),
  output: teamResult,
});

/** 팀원 삭제 — 그 직원의 팀원 프로젝트 목록도 함께 지운다(서버 폴더는 건드리지 않는다) */
export const teamMemberRemove = defineRpc({
  name: "team.member_remove",
  input: z.object({ id: z.string() }),
  output: teamResult,
});

/** 팀원 프로젝트 고치기 — 프로젝트 관리 화면과 같은 고치기를 그 직원의 목록에 */
export const teamProjectEdit = defineRpc({
  name: "team.project_edit",
  input: z.object({ member: z.string(), op: projectsEditOpSchema }),
  output: teamResult,
});

/**
 * 서버 작업 시작(10-11) — apply: 고른 서버마다 직원 Paseo 만들기·고치기 + 로그인 서버 연결·계정, 뺀 서버에서는 지우기 ·
 * skills: 스킬·명령어를 서버 원본으로 다시 복사 · remove-keep·remove-purge: 모든 서버와 로그인 서버에서 지우고
 * 팀원 목록에서도 지운다(홈 /home/<아이디> 를 남기거나 함께 지운다 — 어느 쪽이든 같은 아이디로 다시 만들 수 있다).
 * 서버 작업은 1분 넘게 걸릴 수 있어(Paseo 요청 한도 30초) 시작하고 기다리기를 되풀이한다
 */
export const teamJobStart = defineRpc({
  name: "team.job_start",
  input: z.object({ member: z.string(), action: z.enum(TEAM_JOB_ACTIONS) }),
  output: z.object({ ok: z.boolean(), error: z.string().optional(), jobId: z.string().optional() }),
});

/**
 * 작업 진행 — seen 줄 수보다 늘거나 끝날 때까지 기다렸다 답한다(최대 25초). lost = 데몬 쪽 플러그인이 다시 읽혀 그 작업을 모른다.
 * invite = 이 작업이 발급한 초대 키(진행 줄에는 넣지 않는다 · 화면이 한 번 보여 주고 저장하지 않는다) · link = 키를 넣어 둔 로그인 페이지 주소
 */
export const teamJobWait = defineRpc({
  name: "team.job_wait",
  input: z.object({ jobId: z.string(), seen: z.number() }),
  output: z.object({
    lines: z.array(z.string()),
    done: z.boolean(),
    ok: z.boolean(),
    lost: z.boolean(),
    invite: z.object({ member: z.string(), key: z.string(), expiresAt: z.number(), link: z.string() }).optional(),
  }),
});

/** 그 직원의 카테고리 순서(끌어서 옮긴 결과 — 전체 순서) */
export const teamCategoryOrder = defineRpc({
  name: "team.category_order",
  input: z.object({ member: z.string(), names: z.array(z.string()) }),
  output: teamResult,
});
