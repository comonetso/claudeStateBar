import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 화면 ↔ 데몬 약속. 장부의 정본은 장부 명령(~/.work-ledger/app/ledger.mjs) 하나 — 데몬은 그 명령을 부를 뿐이다.
// 🔴 RPC 이름에 대문자를 쓰면 플러그인 전체가 안 뜬다(10-14 실측)

export const STATES = ["제안", "할 일", "진행 중", "끝냄", "확인됨", "보류", "버림"] as const;

const LogEntry = z.object({ at: z.string(), who: z.string(), kind: z.string(), text: z.string() });
export const LedgerItem = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  state: z.string(),
  created: z.string(),
  updated: z.string(),
  log: z.array(LogEntry),
  /** 이 항목이 세부면 큰 작업 번호(전체 id) — 없으면 큰 작업 */
  parent: z.string().nullable().optional(),
  /** ? 를 누르면 보이는 자세한 설명(여러 줄) */
  desc: z.string().optional(),
  /** 사람만 쓰는 큰 작업 메모 */
  memo: z.string().optional(),
  /** 대작업(오래 가는 줄기) — 상태 없이 아래 중작업 요약만 보인다(10-26 리규형님 대작업 > 중작업 > 세부) */
  area: z.boolean().optional(),
  /** 처음 진행 중이 된 때 · 마지막 끝냄 시각(다시 진행 중이면 빈 값) */
  started: z.string().optional(),
  finished: z.string().optional(),
  /** 대작업만 — 하위 전체의 첫 진행(label "시작"), 없으면 첫 등록(label "기록 시작"). 장부 명령이 계산해 넘긴다 */
  since: z.object({ at: z.string(), label: z.string() }).nullable().optional(),
  /** 끝냄의 검증 범위 — ai = AI 가 전부 검증(확인 대기에서 빠짐) · ask = 사람만 볼 것(그 질문) */
  verify: z.object({ ai: z.boolean().optional(), ask: z.string().optional() }).nullable().optional(),
  /** 대작업 현황 — 지금 되는 것·남은 것·다음 후보(마지막 것) */
  summary: z.object({ text: z.string(), at: z.string() }).nullable().optional(),
});
export type LedgerItem = z.infer<typeof LedgerItem>;

export const LedgerView = z.object({
  project: z.string(),
  enabled: z.boolean(),
  owner: z.string(),
  behind: z.number(),
  builtAt: z.string(),
  error: z.string().nullable(),
  items: z.array(LedgerItem),
  /** 사람만 쓰는 프로젝트 메모 */
  projectMemo: z.string().optional(),
  /** 프로젝트 현황 — 장부 탭 첫 화면 "지금 어디까지"(10-27 리규형님) */
  projectSummary: z.object({ text: z.string(), at: z.string() }).nullable().optional(),
});
export type LedgerView = z.infer<typeof LedgerView>;

/** 작업 공간 폴더의 프로젝트 장부 전체 */
export const viewLedger = defineRpc({
  name: "ledger.view",
  input: z.object({ directory: z.string() }),
  output: LedgerView,
});

/** 사람 메모 저장 — id 가 있으면 그 큰 작업, 없으면 이 작업 공간 폴더의 프로젝트. 빈 글이면 지움 */
export const saveMemo = defineRpc({
  name: "ledger.memo",
  input: z.object({ directory: z.string(), id: z.string().nullable(), text: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** 사람이 "확인됨"을 찍는다(화면의 확인 단추) */
export const confirmItem = defineRpc({
  name: "ledger.confirm",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
