// 복사본: VS Code 확장 src/claudeStats.ts 의 API 단가표(RATES · HAIKU_3_5 · rateFor · cacheWriteCost, 2026-10-08 기준 93~163줄).
// 확장 쪽 단가를 고치면 여기도 같이 고친다(새 모델이 나오면 공식 가격표를 확인해 두 곳에 한 줄씩).
//
// 100만 토큰당 달러, Anthropic 공식 가격표(platform.claude.com/docs/en/about-claude/pricing, 확장이 2026-09-30 읽음) 그대로.
// 구독이면 실제로 청구되는 금액은 없다 — "API 로 썼다면 들었을 금액" 환산이다.
//
// 리규형님 09-30 결정(다시 묻지 않는다):
//   · 알려진 모델만 금액을 낸다. 표에 없는 모델(새 모델 포함)은 "단가 모름"으로 합계에서 뺀다.
//     "Opus 4 이후는 전부 $5" 같은 "이후 판도 같은 값" 가정이 Opus 5.5 오계산의 원인이었다.
//   · 통계 탭은 캐시 쓰기를 전부 1시간(입력의 2배) 단가로 계산한다 — Claude Code 요약 파일(stats-cache.json)엔 5분/1시간
//     구분이 없다. 근거: 이 PC 최근 30일 캐시 쓰기의 99.76% 가 1시간(09-30 실측).
// 캐시 읽기는 입력의 0.1배, 단 Fable·Mythos 5.1 은 0.025배, Opus 5.5 는 0.05배.

export interface ModelRate {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** 인자는 가격표 열 순서: 입력 · 5분 쓰기 · 1시간 쓰기 · 캐시 읽기 · 출력 */
const R = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): ModelRate => ({
  input,
  output,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
});

/** 계열 → "주.부" 판 → 단가. claude-opus-4-20250514 는 Opus 4.0(출시 날짜는 판 번호가 아니다) */
const RATES: Record<string, Record<string, ModelRate>> = {
  fable: { "5.1": R(10, 12.5, 20, 0.25, 50), "5.0": R(10, 12.5, 20, 1, 50) },
  mythos: { "5.1": R(10, 12.5, 20, 0.25, 50), "5.0": R(10, 12.5, 20, 1, 50) },
  opus: {
    "5.5": R(4, 5, 8, 0.2, 20),
    "5.0": R(5, 6.25, 10, 0.5, 25),
    "4.8": R(5, 6.25, 10, 0.5, 25),
    "4.7": R(5, 6.25, 10, 0.5, 25),
    "4.6": R(5, 6.25, 10, 0.5, 25),
    "4.5": R(5, 6.25, 10, 0.5, 25),
    "4.1": R(15, 18.75, 30, 1.5, 75),
    "4.0": R(15, 18.75, 30, 1.5, 75),
  },
  sonnet: {
    "5.5": R(2, 2.5, 4, 0.2, 10),
    "5.0": R(2, 2.5, 4, 0.2, 10),
    "4.6": R(3, 3.75, 6, 0.3, 15),
    "4.5": R(3, 3.75, 6, 0.3, 15),
    "4.0": R(3, 3.75, 6, 0.3, 15),
  },
  haiku: { "4.5": R(1, 1.25, 2, 0.1, 5) },
};
/** Haiku 3.5 는 계열이 앞에 오는 이름 이전 모델이다(claude-3-5-haiku-20241022) */
const HAIKU_3_5 = R(0.8, 1, 1.6, 0.08, 4);

/** 단가표에 없으면 null — 추측하지 않는다 */
export function rateFor(model: string): ModelRate | null {
  const m = (model || "").toLowerCase();
  if (!m) return null;
  if (/claude[-_]3[-_]5[-_]haiku/.test(m)) return HAIKU_3_5;
  for (const family of Object.keys(RATES)) {
    // 각 자리는 두 자리 이하 숫자 뒤에 숫자가 아닌 것 — 끝의 출시 날짜(claude-sonnet-4-5-20250929)를 부 판으로 읽지 않는다
    const v = m.match(new RegExp(family + "[-_](\\d{1,2})(?!\\d)(?:[-_](\\d{1,2})(?!\\d))?"));
    if (!v) continue;
    return RATES[family][parseInt(v[1], 10) + "." + (v[2] ? parseInt(v[2], 10) : 0)] || null;
  }
  return null;
}

/** total 토큰 중 fiveMin 은 5분 캐시, 나머지는 1시간 캐시로 계산한 캐시 쓰기 금액 */
export function cacheWriteCost(total: number, fiveMin: number, rate: ModelRate): number {
  const m5 = Math.min(Math.max(fiveMin, 0), total);
  return (m5 / 1e6) * rate.cacheWrite5m + ((total - m5) / 1e6) * rate.cacheWrite1h;
}
