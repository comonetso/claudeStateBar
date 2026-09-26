# 「성능 봐」 · 「느린지 봐」

전제: SKILL.md §0~§2. 에이전트 탭은 스로틀돼 있다 — 그리기 기반 지표는 `K.wake` 뒤에만.

## 절차
1. `openTab(url)`(콜드 값은 첫 로딩에서만 — `goto` 재로드는 캐시 적중) → 즉시 `page.evaluate(VITALS_INSTALL)`(`kit/vitals-install.js`, 조작 **전에**).
2. `performance.getEntriesByType('visibility-state')` 에 `hidden` 이 있으면 FCP·LCP 에 "무효" 표시.
3. `K.wake` → fps ≥ 30 확인(INP 측정 전제).
4. 사용자가 말한 조작(없으면 데이터 변경 없는 대표 클릭 2~3회) → `page.evaluate(VITALS_REPORT)`(`kit/vitals-report.js`: LCP·FCP·TTFB·CLS 세션 창·INP·LCP 분해·TBT·LoAF 상위) + `kit/perfdiag.js`(렌더 차단·DOM 크기·자원·Server-Timing).
5. 원인: `K.X(tab,'Profiler.enable')`·`setSamplingInterval({interval:100})`·`start` → 조작 → `stop`(함수별) · `Performance.getMetrics` · 저사양 흉내 `Emulation.setCPUThrottlingRate({rate:4})`(끝나면 1) · `performance.memory` 반복 표본(추세만).

## 판정
web-vitals 임계: LCP ≤ 2.5s · INP ≤ 200ms · CLS ≤ 0.1 · FCP ≤ 1.8s · TTFB ≤ 0.8s. 🔴 fps < 30 이었으면 INP 는 `processingEnd - processingStart` 로만 · CLS 는 숫자 하나가 아니라 **이동 목록**(`node null`/DeepL 제외).

## 보고
조건(콜드/캐시·fps·visibility·CPU 배율) + 지표·등급 + 원인(LCP 분해·LoAF 스크립트·프로파일 상위 함수). URL 은 query/hash 없이.
