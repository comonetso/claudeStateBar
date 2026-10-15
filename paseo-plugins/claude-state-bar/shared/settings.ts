import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// 기본값과 범위는 확장 설정(package.json contributes.configuration)과 같다.
// 크기만 예외: 확장 정의는 50–5000 이고 확장 코드(core/sound.ts getSoundGain)는 300 에서 자른다. 플러그인은 처음엔 확장과 같게
// 300 까지였다가 리규형님 10-15 "1000까지 할 수 있도록"으로 50–1000(데몬이 WAV 샘플을 키운다 — server/amplify). 300 을 넘기면
// 원래 큰 소리는 파형 끝이 잘려 찌그러질 수 있다(설정 화면 안내에 적음)
const sound = z.object({
  // 빈 값 = 기본 소리 파일
  file: z.string().default(""),
  gain: z.number().int().min(50).max(1000).default(100),
});

export const settingsSchema = z.object({
  warning: sound.default({ file: "", gain: 100 }),
  danger: sound.default({ file: "", gain: 100 }),
  completion: sound.default({ file: "", gain: 100 }),
  question: sound.default({ file: "", gain: 100 }),
  workflow: sound.default({ file: "", gain: 100 }),
  // 압축 준비(10-15) — 빈 값 = 기본(Windows 캘린더 알림, 리규형님이 고름 · 설정에서 바꿀 수 있다)
  compact: sound.default({ file: "", gain: 100 }),
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
  thinkingAutoOpen: z.boolean().default(true),
  // 생각 상자 자동 번역(리규형님 10-12 결정: 번역 스위치 아래 · 처음 값 꺼짐 · 화면의 모든 상자 · 상자 크기는 그대로).
  // 서비스가 돌려주는 생각은 요약본이라 영어로 바뀔 때가 있어 화면 쪽에서 메운다. 번역이 켜져 있고 번역 키가 있어야 돈다
  thinkingAutoTranslate: z.boolean().default(false),
  // 자동 번역 때 생각 중인 상자 펼치기(리규형님 10-12 — 열고 높이 제한까지 푼다, 최대화 단추는 그대로). 처음 값 켬(자동 번역이
  // 꺼져 있으면 아무 일도 안 한다) · 입력창 위 "모두 접기"를 눌러 둔 동안은 펼치지 않는다 · 한 번 펼친 상자는 다시 펼치지 않는다
  thinkingAutoTranslateExpand: z.boolean().default(true),
  ttsSpeedStep: z.union([z.literal(0.1), z.literal(0.25)]).default(0.25),
  // 바꾼 단축키(10-16 리규형님) — 단축키 번호 → 조합 글. 없는 번호는 기본 키(shared/shortcuts.ts)
  shortcuts: z.record(z.string(), z.string()).default({}),
});

export type SoundSettings = z.output<typeof settingsSchema>;

export const soundSettings = defineSettings({
  id: "sounds",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const DEFAULT_SETTINGS: SoundSettings = settingsSchema.parse({});
