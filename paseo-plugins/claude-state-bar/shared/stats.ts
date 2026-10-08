import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 작업 현황 "통계" 탭(리규형님 10-08 결정) — VS Code 확장 Claude Status 패널의 통계 탭(확장 media/status.js renderStats ·
// src/claudeStats.ts collectClaudeStats 의 lifetime 부분)과 같은 내용. 그 작업 공간이 있는 호스트의 데몬이 자기
// ~/.claude(Claude Code 가 정리해 둔 stats-cache.json + 오늘 대화 기록)를 읽어 계산한다 — 작업 폴더와 상관없이 그 기기 전체.
// 확장은 UI 확장이라 늘 이 PC 기록만 읽지만, 플러그인은 서버 작업 공간이면 그 서버 기록을 읽는다.

const modelShareSchema = z.object({
  /** 대화 기록에 적힌 모델 이름 그대로(claude-opus-5-5 …) */
  model: z.string(),
  /** 보이는 이름(Opus 5.5) — 확장 getShortModelName */
  label: z.string(),
  tokens: z.number(),
  /** 전체 토큰 중 이 모델 몫(반올림 %) */
  percent: z.number(),
  /** 공식 단가로 환산한 금액(달러). 단가를 모르면 0 이고 unknownRate */
  costUSD: z.number(),
  /** 공식 가격표에 없는 모델 — 금액을 내지 않고 합계에서 뺀다(확장 09-30 결정 "알려진 모델만") */
  unknownRate: z.boolean(),
});
export type ModelShare = z.infer<typeof modelShareSchema>;

const heatDaySchema = z.object({
  /** YYYY-MM-DD — 데몬이 도는 기기의 시간대 기준 */
  date: z.string(),
  /** 그날 메시지 수 */
  count: z.number(),
  /** 0~4 색 단계(분위수, 확장 heatLevels) */
  level: z.number(),
});
export type HeatDay = z.infer<typeof heatDaySchema>;

const statsSchema = z.object({
  /** stats-cache.json 이 있고 토큰이나 활동이 하나라도 있다. 아니면 "아직 통계가 없습니다" */
  available: z.boolean(),
  totalTokens: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** 대화 수(캐시 누적 + 캐시에 아직 없는 오늘 대화) */
  sessions: z.number(),
  activeDays: z.number(),
  windowDays: z.number(),
  longestSessionMs: z.number(),
  longestStreak: z.number(),
  currentStreak: z.number(),
  /** 메시지가 가장 많았던 날 YYYY-MM-DD(없으면 빈 글자) — 화면이 "8월 19일"로 쓴다 */
  mostActiveDay: z.string(),
  favoriteModelLabel: z.string(),
  byModel: z.array(modelShareSchema),
  daily: z.array(heatDaySchema),
  /** 단가를 아는 모델만 더한 환산 금액(달러) */
  costUSD: z.number(),
  hasUnknownRate: z.boolean(),
  /** Claude Code 가 stats-cache.json 을 마지막으로 정리한 날(그날까지가 누적에 들어 있다). 없으면 빈 글자 */
  lastComputedDate: z.string(),
  /** 데몬 기준 오늘 YYYY-MM-DD */
  today: z.string(),
});
export type ClaudeStatsView = z.infer<typeof statsSchema>;

/** force: 새로고침 단추 — 데몬 캐시를 건너뛰고 다시 읽는다(확장 onRefreshRequested 의 forceScan) */
export const claudeStats = defineRpc({
  name: "stats.claude",
  input: z.object({ force: z.boolean().optional() }),
  output: z.object({ computedAt: z.number(), stats: statsSchema }),
});
