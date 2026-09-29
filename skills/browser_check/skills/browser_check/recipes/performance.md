# "Check performance" · "Is it slow"

Prerequisite: SKILL.md §0–§2. Agent tabs are throttled — paint-based metrics only after `K.wake`.

## Steps
1. `openTab(url)` (cold values come only from the first load — a `goto` reload hits the cache) → immediately `page.evaluate(VITALS_INSTALL)` (contents of `kit/vitals-install.js`, **before** any action).
2. If `performance.getEntriesByType('visibility-state')` contains `hidden`, mark FCP/LCP "invalid".
3. `K.wake` → confirm fps ≥ 30 (required for INP).
4. The user's action (if none, 2–3 representative clicks that change no data) → `page.evaluate(VITALS_REPORT)` (`kit/vitals-report.js`: LCP · FCP · TTFB · CLS session window · INP · LCP breakdown · TBT · top LoAF) + `kit/perfdiag.js` (render-blocking · DOM size · resources · Server-Timing).
5. Cause: `K.X(tab,'Profiler.enable')` · `setSamplingInterval({interval:100})` · `start` → action → `stop` (per function) · `Performance.getMetrics` · low-end emulation `Emulation.setCPUThrottlingRate({rate:4})` (back to 1 afterwards) · repeated `performance.memory` samples (trend only).

## Verdict
web-vitals thresholds: LCP ≤ 2.5 s · INP ≤ 200 ms · CLS ≤ 0.1 · FCP ≤ 1.8 s · TTFB ≤ 0.8 s. 🔴 If fps was below 30, judge INP only by `processingEnd - processingStart` · report CLS as a **list of shifts**, not one number (drop `node null` and DeepL).

## Report
Conditions (cold/cached · fps · visibility · CPU rate) + metrics and ratings + cause (LCP breakdown · LoAF scripts · top profiled functions). URLs without query or hash.
