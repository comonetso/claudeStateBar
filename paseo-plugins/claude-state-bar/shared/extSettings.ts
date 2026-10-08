import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// VS Code 확장 설정 가져오기(리규형님 10-08 결정). 설정 화면 "소리" 칸의 [VS Code 확장 설정 가져오기] 버튼이 부른다.
// 데몬이 이 기기 VS Code 사용자 설정 파일(settings.json, 주석·끝 쉼표가 섞인 JSONC)을 읽어 확장 claudeContextBar.* 값 중
// 플러그인 소리 설정에 대응하는 것만 돌려준다. 화면은 그 값으로 입력 칸만 채우고, 저장은 사용자가 [저장]을 눌러야 된다.
// 설정 화면은 소리 담당 호스트(PC) 플러그인만 붙이므로 실제로는 PC 데몬만 이 요청을 받는다(server/extSettings).

/** 채울 수 있는 플러그인 설정 칸 — 설정 화면 입력 칸과 같은 이름(소리 종류.file·gain + 위쪽 칸) */
export const extImportFields = [
  "completion.file",
  "completion.gain",
  "question.file",
  "question.gain",
  "warning.file",
  "warning.gain",
  "danger.file",
  "danger.gain",
  "workflow.file",
  "workflow.gain",
  "settleMs",
  "warningPercent",
  "dangerPercent",
  "workflowBeep",
] as const;
export type ExtImportField = (typeof extImportFields)[number];

const soundPart = z.object({ file: z.string().optional(), gain: z.number().optional() });

export const extSettingsImport = defineRpc({
  name: "ext-settings.import",
  input: z.object({}),
  output: z.object({
    /** 읽으려 한 설정 파일 경로(화면에 그대로 보인다) */
    path: z.string(),
    /** ok = 읽음 · missing = 파일 없음 · unreadable = 읽거나 해석하지 못함(원인은 error) */
    status: z.enum(["ok", "missing", "unreadable"]),
    error: z.string().optional(),
    /** 플러그인 스키마에 맞는 값만 — 없는 칸은 채우지 않는다 */
    values: z.object({
      completion: soundPart.optional(),
      question: soundPart.optional(),
      warning: soundPart.optional(),
      danger: soundPart.optional(),
      workflow: soundPart.optional(),
      settleMs: z.number().optional(),
      warningPercent: z.number().optional(),
      dangerPercent: z.number().optional(),
      workflowBeep: z.boolean().optional(),
    }),
    /** 가져오지 못한 것 — missing = VS Code 설정에 그 키가 없음(확장 기본값 사용 중) · type = 값의 형식이 다름 ·
     *  range = 플러그인이 받는 범위·형식(정수 등)에 맞지 않음. value 는 원래 값을 짧게 줄인 글(missing 이면 없음) */
    skipped: z.array(
      z.object({
        field: z.enum(extImportFields),
        reason: z.enum(["missing", "type", "range"]),
        value: z.string().optional(),
      }),
    ),
  }),
});
