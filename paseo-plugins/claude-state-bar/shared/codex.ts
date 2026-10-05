import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// codex_rescue 실행 카드. 확장 Codex 진행 패널의 카드 값(CodexRunView)에서 첫 판에 쓰는 것만.
export const runPhases = ["starting", "running", "finalizing", "done", "failed", "stopped", "stale"] as const;
export type RunPhase = (typeof runPhases)[number];

const itemSchema = z.object({
  id: z.string(),
  turn: z.number(),
  kind: z.string(),
  status: z.enum(["running", "done", "failed", "warn"]),
  label: z.string(),
  body: z.string().optional(),
  /** 명령만: 셸 래퍼까지 붙은 실제 실행 명령(줄을 펼치면 보인다) */
  raw: z.string().optional(),
  /** 처음 본 때부터 마지막 본 때까지(기록에 시각이 없어 관찰 시각으로 잰다, 확장과 같음) */
  durationMs: z.number().optional(),
});
export type RunItem = z.infer<typeof itemSchema>;

/** 여러 턴 실행의 턴 하나: 요청서(1턴은 _request_, N턴은 _followupN_) · 결과 문서 안 그 턴 표식 · 그 턴 시각 */
const turnDocSchema = z.object({
  turn: z.number(),
  requestPath: z.string().optional(),
  resultAnchor: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type TurnDoc = z.infer<typeof turnDocSchema>;

const runSchema = z.object({
  stamp: z.string(),
  slug: z.string(),
  subject: z.string().optional(),
  mode: z.string(),
  phase: z.enum(runPhases),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  staleForMs: z.number().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  totalTokens: z.number().optional(),
  turns: z.number(),
  itemCount: z.number(),
  /** 마지막 턴에서 마지막으로 한 말(말·생각·클로드 끼어듦, 확장 narrationOfTurn). 실행 중일 때만 보여 준다 */
  latest: z.string().optional(),
  /** latest 가 클로드가 끼어든 말이면 true(주황으로 칠한다) */
  latestSteer: z.boolean().optional(),
  failureMessage: z.string().optional(),
  todo: z.array(z.object({ text: z.string(), done: z.boolean() })).optional(),
  requestPath: z.string().optional(),
  resultPath: z.string().optional(),
  docsOnly: z.boolean().optional(),
  /** 두 턴 이상일 때만 있다. 한 턴 실행은 카드 위 요청서·결과 버튼을 그대로 쓴다 */
  turnDocs: z.array(turnDocSchema).optional(),
  /** Claude 가 함께 띄운 실행의 묶음 이름(codex_rescue 1.17.3+ CR_GROUP) */
  group: z.string().optional(),
  /** 묶음 이름 + 띄운 대화. 다른 대화가 같은 이름을 써도 따로 묶인다 */
  groupKey: z.string().optional(),
});
export type RunCard = z.infer<typeof runSchema>;

/** 작업 폴더의 codex_rescue 실행, 최신 것부터 */
export const codexRuns = defineRpc({
  name: "codex.runs",
  input: z.object({ cwd: z.string(), limit: z.number().optional() }),
  output: z.object({
    logDir: z.string().nullable(),
    runs: z.array(runSchema),
    /** limit 밖에 남은 실행 수 */
    older: z.number(),
  }),
});

/** 카드를 펼칠 때 받는 활동 전체 */
export const codexRunItems = defineRpc({
  name: "codex.run_items",
  input: z.object({ cwd: z.string(), stamp: z.string() }),
  output: z.object({ items: z.array(itemSchema) }),
});

/** 요청서·결과 문서 본문(카드에서 펼쳐 읽는다) */
export const codexDoc = defineRpc({
  name: "codex.doc",
  input: z.object({ cwd: z.string(), path: z.string() }),
  output: z.object({ text: z.string() }),
});

/** 이 저장소 codex_rescue 기록 용량(codex_rescue 1.17.3+ 가 .log/_usage.json 에 적은 값). 없거나 깨졌으면 ok 아님 */
export const codexUsage = defineRpc({
  name: "codex.usage",
  input: z.object({ cwd: z.string() }),
  output: z.object({
    ok: z.boolean(),
    computedAt: z.number().optional(),
    items: z.array(z.object({ key: z.enum(["scratch", "log", "trash", "codex"]), bytes: z.number(), count: z.number() })).optional(),
  }),
});

// 휴지통(확장 runDiscovery 의 Trash 부분과 같은 폴더·같은 meta.json — 확장과 서로 읽힌다).
// 정책(리규형님 08-21): 넣을 때는 안 묻고 기록+문서 통째로 · 완전 삭제·비우기 때만 "기록만 / 기록+문서" ·
// 복구는 덮어쓰지 않는다 · lock 남은 실행은 거부 · 자동 정리는 휴지통을 거치지 않는다 · 보관 무기한
const trashItemSchema = z.object({
  stamp: z.string(),
  slug: z.string(),
  subject: z.string().optional(),
  mode: z.string().optional(),
  deletedAt: z.number(),
  fileCount: z.number(),
  bytes: z.number(),
  hasLogs: z.boolean(),
  hasDocs: z.boolean(),
});
export type TrashItem = z.infer<typeof trashItemSchema>;

/** 끝난 실행 하나를 휴지통으로(기록 + 요청서·결과·되물음 문서). moved=false 면 lock 이 남았거나 파일이 없었다 */
export const codexTrashRun = defineRpc({
  name: "codex.trash_run",
  input: z.object({ cwd: z.string(), stamp: z.string(), slug: z.string(), subject: z.string().optional(), mode: z.string().optional() }),
  output: z.object({ moved: z.boolean() }),
});

export const codexTrashList = defineRpc({
  name: "codex.trash_list",
  input: z.object({ cwd: z.string() }),
  output: z.object({ items: z.array(trashItemSchema) }),
});

export const codexTrashRestore = defineRpc({
  name: "codex.trash_restore",
  input: z.object({ cwd: z.string(), stamp: z.string() }),
  output: z.object({ restored: z.number(), conflicts: z.array(z.string()), restoredLogs: z.number(), restoredDocs: z.number() }),
});

/** includeDocs=false 면 원시 기록만 지우고 문서는 휴지통에 남긴다 */
export const codexTrashPurge = defineRpc({
  name: "codex.trash_purge",
  input: z.object({ cwd: z.string(), stamp: z.string(), includeDocs: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const codexTrashEmpty = defineRpc({
  name: "codex.trash_empty",
  input: z.object({ cwd: z.string(), includeDocs: z.boolean() }),
  output: z.object({ count: z.number() }),
});

// 채팅 휴지통: 진행 휴지통과 폴더를 완전히 나눈다(docs/codex_rescue/.chat_trash/, 08-22 결정 — 같은 stamp 의 CHAT 과
// CONSULT 가 있을 수 있다). 자동 정리 없음(대화는 기록 자체라 나이로 지우지 않는다). 묻는 것은 완전 삭제·비우기뿐
const chatTrashItemSchema = z.object({
  stamp: z.string(),
  slug: z.string(),
  subject: z.string().optional(),
  deletedAt: z.number(),
  turns: z.number(),
  bytes: z.number(),
});
export type ChatTrashItem = z.infer<typeof chatTrashItemSchema>;

export const chatTrashMove = defineRpc({
  name: "chat.trash_move",
  input: z.object({ cwd: z.string(), stamp: z.string() }),
  output: z.object({ moved: z.boolean() }),
});

export const chatTrashList = defineRpc({
  name: "chat.trash_list",
  input: z.object({ cwd: z.string() }),
  output: z.object({ items: z.array(chatTrashItemSchema) }),
});

export const chatTrashRestore = defineRpc({
  name: "chat.trash_restore",
  input: z.object({ cwd: z.string(), stamp: z.string() }),
  output: z.object({ restored: z.boolean(), conflict: z.string().optional() }),
});

export const chatTrashPurge = defineRpc({
  name: "chat.trash_purge",
  input: z.object({ cwd: z.string(), stamp: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const chatTrashEmpty = defineRpc({
  name: "chat.trash_empty",
  input: z.object({ cwd: z.string() }),
  output: z.object({ count: z.number() }),
});

const chatEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), n: z.number(), time: z.string().optional(), claude: z.string(), codex: z.string() }),
  z.object({ type: z.literal("break"), kind: z.enum(["broken", "superseded"]), time: z.string().optional(), text: z.string() }),
  z.object({ type: z.literal("pending"), n: z.number(), time: z.string().optional(), claude: z.string() }),
]);

/** codex_rescue 채팅(핑퐁) 대화들, 최근 것부터 */
export const codexChats = defineRpc({
  name: "codex.chats",
  input: z.object({ cwd: z.string() }),
  output: z.object({
    chats: z.array(
      z.object({
        stamp: z.string(),
        slug: z.string(),
        subject: z.string().optional(),
        origin: z.string().optional(),
        threadId: z.string().optional(),
        lastAtMs: z.number().optional(),
        live: z.boolean(),
        /** 이번 세션 대화(진행 중이거나 열린 대화 중 가장 이른 시작 뒤에 바뀜). 아니면 "지난 대화"로 접힌다 */
        current: z.boolean(),
        entries: z.array(chatEntrySchema),
      }),
    ),
  }),
});
export type ChatCard = z.infer<typeof codexChats.output>["chats"][number];
