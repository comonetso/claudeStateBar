import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { projectEntrySchema, projectsEditOpSchema } from "../projects";

// 팀원 관리(10-11 → 10-20 리규형님 "새로 만들자") — 팀원을 추가할 때는 아이디와 그 직원에게 맞는 스킬·명령어만 고른다
// (서버마다 그 서버의 글로벌 것에서). 서버는 따로 고르지 않는다 — 팀원 프로젝트에 서버가 들어 있어 팀원 프로젝트가 있는 서버에만
// 그 팀원의 Paseo 를 만든다. 권한은 "팀원 프로젝트 관리" 탭에서 프로젝트마다 준다(shared/team/teamAccess.ts). 리규형님 프로젝트 목록과는 따로다.

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

const fileMode = z.enum(["ro", "rw"]);
/** 팀원 프로젝트 하나의 권한 — 모양·기본값·검사는 shared/team/teamAccess.ts */
export const projectAccessSchema = z.object({
  file: fileMode,
  outside: z.array(z.object({ path: z.string(), mode: fileMode })),
  ports: z.array(z.number()),
  logs: z.array(z.string()),
  hideSecrets: z.boolean(),
});
export {
  combineAccess,
  defaultProjectAccess,
  fileModeLabel,
  FILE_MODES,
  OUTSIDE_MAX,
  TEAM_LOGS,
  type FileMode,
  type OutsidePath,
  type ProjectAccess,
} from "./teamAccess";

/** 팀원 프로젝트 — 프로젝트 관리 화면의 항목 + 권한(10-20, 없으면 읽기만) */
const teamProjectSchema = projectEntrySchema.extend({ access: projectAccessSchema.optional() });
export type TeamProject = z.infer<typeof teamProjectSchema>;

const memberSchema = z.object({
  /** 로그인 아이디 — 서버 직원 도구(team-daemon policy.py NAME)와 같은 규칙 */
  id: z.string(),
  /** 팀원 프로젝트가 있는 서버(저장할 때마다 프로젝트에서 다시 셈 — 10-20 부터 고르지 않는다) */
  servers: z.array(z.string()),
  /** "서버|skill:이름"·"서버|command:이름" — 서버가 달라도, 같은 이름이어도 안 섞이게. 그 서버에 팀원 프로젝트가 생길 때 복사한다 */
  skills: z.array(z.string()),
  /** 이 직원의 카테고리 순서(끌어 놓은 순서 = 번호). 끌어 놓은 적 없는 카테고리는 프로젝트에 처음 나오는 순서로 뒤에 */
  categoryOrder: z.array(z.string()),
  /** 팀원 전용 프로젝트와 프로젝트마다 준 권한 */
  projects: z.array(teamProjectSchema),
  /**
   * 팀원 Claude 계정(10-21 리규형님) — false = 회사 공용(서버 리규형님 Paseo 의 회사 팀 공급자 토큰을 같이 쓴다, 기본) ·
   * true = 본인 로그인(토큰을 넣지 않아 팀원이 자기 화면의 Claude 로그인 칸에서 서버마다 로그인한다. 풀려도 회사 공용으로 대신 돌리지 않는다)
   */
  ownClaude: z.boolean(),
  /**
   * 팀원 Claude 가 팀원을 부르는 이름(10-21 리규형님 — 팀원 표준판의 호칭 자리). "" = 아이디 + "님".
   * 서버 팀원 도구가 표준판을 팀원 홈에 **처음 넣을 때만** 채운다 — 이미 넣은 표준판은 바꾸지 않는다
   */
  callName: z.string(),
  /** 서버에 직원 Paseo 를 만든 서버들(서버에 반영 작업이 끝난 것) */
  applied: z.array(z.string()),
  /** 서버 → 로그인 서버에 등록한 직원용 연결 이름 */
  links: z.record(z.string(), z.string()),
  /** 로그인 서버에 직원 계정을 만들었는가(비밀번호·OTP 는 팀원이 초대 키로 직접) */
  loginAdded: z.boolean(),
  /** 마지막 서버 반영 뒤 바뀐 것이 있다 */
  dirty: z.boolean(),
  /** 바뀔 때마다 1씩 — 반영 작업 중에 또 바뀌었는지 가린다 */
  rev: z.number(),
});
export type TeamMember = z.infer<typeof memberSchema>;
/**
 * remove-keep = 홈 디렉터리 유지 · remove-purge = 완전 삭제(10-11 리규형님: 삭제를 누를 때 둘 중 하나를 고른다) ·
 * invite = 초대 키 다시 발급(등록을 아직 안 마친 직원 — 잃어버렸거나 24시간이 지났을 때) ·
 * reset = 등록 초기화(10-12 리규형님: 비밀번호·OTP 를 지우고 등록 대기로 되돌린 뒤 초대 키까지 한 번에 — 인계·폰 바꿈)
 */
export const TEAM_JOB_ACTIONS = ["apply", "skills", "remove-keep", "remove-purge", "invite", "reset"] as const;
export type TeamJobAction = (typeof TEAM_JOB_ACTIONS)[number];

// notice = 저장은 됐지만 알릴 것(10-25 — 아이디를 확인하지 못한 서버가 있으면 그 서버에 처음 만들 때 서버가 다시 확인한다)
const teamResult = z.object({ ok: z.boolean(), error: z.string().optional(), notice: z.string().optional(), members: z.array(memberSchema) });

export const teamState = defineRpc({
  name: "team.state",
  input: z.object({}),
  output: teamResult,
});

/** 팀원 추가·고치기 — 아이디와 스킬·명령어만(10-20). previousId 가 있으면 그 팀원을 고친다(팀원 프로젝트는 그대로 따라간다) */
export const teamMemberSave = defineRpc({
  name: "team.member_save",
  input: z.object({
    previousId: z.string().nullable(),
    id: z.string(),
    skills: z.array(z.string()),
    /** 부를 이름(10-21) — 없으면 그대로 둔다(옛 화면) */
    callName: z.string().optional(),
  }),
  output: teamResult,
});
// 표준판 이름·부를 이름 검사는 shared/team/teamStandard.ts(10-21 — 아무것도 가져오지 않는 파일)

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

/** 팀원 프로젝트 하나의 권한 바꾸기(10-20) — key = "<서버>|<경로>". 같은 서버의 다른 프로젝트와 겹치면 저장하지 않고 이유를 돌려준다 */
export const teamProjectAccess = defineRpc({
  name: "team.project_access",
  input: z.object({ member: z.string(), key: z.string(), access: projectAccessSchema }),
  output: teamResult,
});

/** 팀원 Claude 계정 바꾸기(10-21) — own = 본인 로그인. 서버에 반영해야 그 팀원 Paseo 에 먹는다 */
export const teamMemberClaude = defineRpc({
  name: "team.member_claude",
  input: z.object({ member: z.string(), own: z.boolean() }),
  output: teamResult,
});

/**
 * 서버 작업 시작(10-11) — apply: 팀원 프로젝트가 있는 서버마다 직원 Paseo 만들기·고치기 + 로그인 서버 연결·계정, 프로젝트가 없어진 서버에서는 지우기 ·
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
