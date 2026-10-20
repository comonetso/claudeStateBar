# "Check performance" · "Is it slow"

Prerequisite: SKILL.md §0–§2. 🔴 Not measured in ego yet: whether a minimized or hidden ego window throttles timers and animation frames (Chromium does for background tabs). Until it is, treat paint-based metrics and INP from a minimized window as unreliable and say so — or ask the user to restore the ego window for the measurement.

## Steps
1. Cold values come only from the first load. Inside `bc.run`, before `goto`: `page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bc.kitSource(page, 'vitals-install') })` → `goto`.
2. If `performance.getEntriesByType('visibility-state')` contains `hidden`, mark FCP/LCP "invalid".
3. Frame rate: count `requestAnimationFrame` callbacks for 1 s in `page.evaluate` — below 30 fps the window is being throttled (step 0).
4. The user's action (if none, 2–3 representative clicks that change no data) → `bc.kit(page, 'vitals-report')` (LCP · FCP · TTFB · CLS session window · INP · LCP breakdown · TBT · top LoAF) + `bc.kit(page, 'perfdiag')` (render-blocking · DOM size · resources · Server-Timing).
5. Cause: `page.cdp('Profiler.enable')` · `Profiler.setSamplingInterval({ interval: 100 })` · `Profiler.start` → action → `Profiler.stop` (per function) · `Performance.enable` + `Performance.getMetrics` · low-end emulation `Emulation.setCPUThrottlingRate({ rate: 4 })` (back to 1 afterwards) · repeated `performance.memory` samples (trend only).

## Verdict
web-vitals thresholds: LCP ≤ 2.5 s · INP ≤ 200 ms · CLS ≤ 0.1 · FCP ≤ 1.8 s · TTFB ≤ 0.8 s. 🔴 If fps was below 30, judge INP only by `processingEnd - processingStart` · report CLS as a **list of shifts**, not one number (drop `node null`).

## Report
Conditions (cold/cached · fps · window visible or minimized · CPU rate) + metrics and ratings + cause (LCP breakdown · LoAF scripts · top profiled functions). URLs without query or hash.
