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
  settleMs: z.number().int().min(100).max(5000).default(3000),
  warningPercent: z.number().min(1).max(100).default(50),
  dangerPercent: z.number().min(1).max(100).default(75),
  // 확장 workflowCompleteBeep 과 같다: 워크플로우·서브에이전트 묶음·백그라운드 작업이 끝나면 따르릉
  workflowBeep: z.boolean().default(true),
});

export type SoundSettings = z.output<typeof settingsSchema>;

export const soundSettings = defineSettings({
  id: "sounds",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const DEFAULT_SETTINGS: SoundSettings = settingsSchema.parse({});
