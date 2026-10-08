import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Codex 진행 탭 용량 줄의 [정리](리규형님 10-08 결정: 확장과 같게). 확장 src/codexCleanNow.ts 의 흐름을 옮겼다:
//   항목 고르기(처음엔 아무것도 체크 안 함) → 미리보기 → 확인 단추를 한 번 더 → codex_rescue 정리 명령 실행.
// 실행은 그 작업 공간의 데몬이 한다(서버 작업 공간이면 그 서버가 그 서버의 스크립트를). 지우는 것은 플러그인 스크립트다 —
// 여기서는 무엇도 직접 지우지 않는다(확장과 같음). 스크립트가 끝나며 _usage.json 을 새로 쓰고, 화면은 용량 줄을 다시 읽는다.
// 정리 명령: node <clean.script> --dir <clean.dir> --now "<항목>" [--yes] --lang ko — --yes 없으면 미리보기만(consult.md "Run logs").

export const cleanItems = ["scratch", "log", "trash", "codex"] as const;
export type CleanItemKey = (typeof cleanItems)[number];

/** 고르기 전에 먼저 거절하는 사정(확장과 같은 순서: 기록 없음 → 플러그인 스크립트 아님 → 다른 폴더 → 스크립트 없음) */
export const cleanRefusals = ["noUsage", "notPluginScript", "dirMismatch", "noScript"] as const;
export type CleanRefusal = (typeof cleanRefusals)[number];

const runningSchema = z.object({ jobId: z.string(), items: z.array(z.enum(cleanItems)) });

/** [정리]를 누를 때 새로 읽는다(화면의 용량 줄은 한 차례 늦을 수 있고 플러그인이 그사이 업데이트됐을 수 있다 — 확장 주석) */
export const codexCleanCheck = defineRpc({
  name: "codex.clean_check",
  input: z.object({ cwd: z.string() }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      /** 저장소 폴더 이름(확장 folder.name 자리) */
      project: z.string(),
      computedAt: z.number(),
      items: z.array(z.object({ key: z.enum(cleanItems), bytes: z.number(), count: z.number() })),
      /** 이 폴더에서 지우는 정리가 지금 돌고 있으면 그것(다른 화면이 시작했거나 패널을 닫았다 연 경우) */
      running: runningSchema.optional(),
    }),
    z.object({ ok: z.literal(false), reason: z.enum(cleanRefusals), path: z.string().optional() }),
  ]),
});

/** 정리 명령을 띄우고 바로 돌아온다(지우는 데 몇 분 걸릴 수 있어 플러그인 요청 30초 제한 안에 못 끝난다). 결과는 codex.clean_wait 로 */
export const codexCleanStart = defineRpc({
  name: "codex.clean_start",
  input: z.object({ cwd: z.string(), items: z.array(z.enum(cleanItems)).min(1), yes: z.boolean() }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), jobId: z.string() }),
    z.object({
      ok: z.literal(false),
      /** busy = 이 폴더에서 지우는 정리가 이미 돈다(jobId 가 그것) */
      reason: z.enum([...cleanRefusals, "busy"]),
      path: z.string().optional(),
      jobId: z.string().optional(),
      items: z.array(z.enum(cleanItems)).optional(),
    }),
  ]),
});

/** 출력이 seen 글자보다 늘거나 끝날 때까지 기다렸다 답한다(최대 25초). lost = 데몬 쪽 플러그인이 다시 읽혀 그 작업을 모른다 */
export const codexCleanWait = defineRpc({
  name: "codex.clean_wait",
  input: z.object({ jobId: z.string(), seen: z.number() }),
  output: z.object({
    state: z.enum(["running", "done", "lost"]),
    /** 스크립트 표준 출력과 오류 출력을 온 순서대로 이어 붙인 것(사람이 읽는 글) */
    output: z.string(),
    /** 끝났을 때만. 0 이 아니면 인자 오류 등 */
    exitCode: z.number().nullable().optional(),
    /** 띄우기 자체가 실패했을 때(실행 파일 없음 등) */
    error: z.string().optional(),
  }),
});
