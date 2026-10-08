import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// 기본값과 범위는 확장 설정(package.json contributes.configuration)과 같다.
// 크기만 예외: 확장 정의는 50–5000 이지만 확장 코드(core/sound.ts getSoundGain)가 300 에서 자르므로,
// 실제로 들리는 소리와 같게 50–300 으로 둔다.
const sound = z.object({
  // 빈 값 = 기본 소리 파일
  file: z.string().default(""),
  gain: z.number().int().min(50).max(300).default(100),
});

export const settingsSchema = z.object({
  warning: sound.default({ file: "", gain: 100 }),
  danger: sound.default({ file: "", gain: 100 }),
  completion: sound.default({ file: "", gain: 100 }),
  question: sound.default({ file: "", gain: 100 }),
  workflow: sound.default({ file: "", gain: 100 }),
  // 끝남·질문 대기 — 확장 기본(3000)과 다르게 1000(리규형님 10-08). Paseo 는 턴이 분명히 끝나고, 소리 직전에 원본이 아직
  // 끝난 상태인지 두 번 다시 확인해(client/soundPlayback) 확장처럼 오래 기다릴 까닭이 줄었다. 3초면 답이 끝나고 소리까지 5~6초였다
  settleMs: z.number().int().min(100).max(5000).default(1000),
  warningPercent: z.number().min(1).max(100).default(50),
  dangerPercent: z.number().min(1).max(100).default(75),
  // 확장 workflowCompleteBeep 과 같다: 워크플로우·서브에이전트 묶음·백그라운드 작업이 끝나면 따르릉
  workflowBeep: z.boolean().default(true),
  // 웹·폰이 PC 앱에서 가져올 항목(리규형님 10-07 결정 — 처음 값은 모두 켬)
  syncWorkspaceOrder: z.boolean().default(true),
  syncLayout: z.boolean().default(true),
  // 작업 현황 단추로 화면을 나눌 때 왼쪽 작업 현황 칸이 차지할 몫 — 탐색기를 뺀 남은 폭의 %(리규형님 10-07 결정: 기본 40, 설정으로).
  // 10~90 은 칸이 아예 안 보이게 되는 것만 막으려고 Claude 가 정한 범위(근거 없음 — 바꿔도 된다)
  activitySplitPercent: z.number().int().min(10).max(90).default(40),
  // 번역·읽기 켜기(리규형님 10-08 결정: 설정 화면 "번역·읽기" 칸). 끄면 그 기능 버튼을 모두 숨긴다 — 번역 = 생각 상자 [번역]·[번역읽기],
  // 읽기 = 생각 상자 [읽기]·[번역읽기]·입력창 위 "선택 읽기" 알약. 처음 값은 둘 다 켬(지금 쓰는 동작이 그대로 이어지게).
  // 키 자체는 여기 두지 않는다 — 이 PC 데몬의 google.env 에만(server/googleKeys)
  translateEnabled: z.boolean().default(true),
  ttsEnabled: z.boolean().default(true),
});

export type SoundSettings = z.output<typeof settingsSchema>;

export const soundSettings = defineSettings({
  id: "sounds",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const DEFAULT_SETTINGS: SoundSettings = settingsSchema.parse({});
