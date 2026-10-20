# "Check console errors" · "Check API failures" — errors, failed requests, their cause

Prerequisite: SKILL.md §0–§2. Events come two ways: CDP events (`bc.watch` → `bc.problems`) and the in-page recorder `diag-v2.1` (richer: fetch/xhr bodies' status, ws, workers, SSE, marks). Use `bc.watch` always; add the recorder when you need marks or request detail.

## Console errors
1. Inside `bc.run`: `await bc.watch(page)` **before** `goto` (events start there) → optional recorder: `page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bc.kitSource(page, 'diag-v2.1') })` → `goto` → (the action the user described) → `bc.problems(page)`; with the recorder also `page.evaluate(() => __diag.dump({ types: ['error','rejection','resource-error','resource-status','csp','ws-error','worker-error','sse-error','console'] }))`.
   🔴 The recorder's `summary().problems` is truncated — take only counts from it and the contents from `dump`.
2. Errors from browser extensions are in `problems.ext` — not page errors.
3. To raise an error on purpose use an **inline `<script>`** (rejections raised from evaluate aren't caught).
4. Mark segments: `__diag.mark('step')` before an action → `dump({ since })`.

**Verdict**: console errors, exceptions, log errors, failed requests are 0 (`problems.summary`), recorder `error`/`rejection`/`resource-*`/`csp` 0. List `console.warn` separately.
**Report** per error: `type · message · file:line:col · first stack line · step · rid if it was a request`.

## API failures
1. `bc.problems(page).http` (status ≥ 400) and `.failed` (network errors; `blockedReason`), or the recorder's `dump({ types: ['fetch','xhr','ws-close','ws-error'] })` for `phase:'failed'` · `ms` · `rid` (request-id header). A response body: `page.cdp('Network.getResponseBody', { requestId })` (redact it).
2. After the fact without events: `performance.getEntriesByType('resource')` (`responseStatus`, `duration`). 🔴 Exactly 250 entries means truncated — `performance.setResourceTimingBufferSize(10000)`, then reproduce.
3. Cause of status 0: a `csp` event at the same moment → CSP block · a page `fetch(url, { mode: 'no-cors', cache: 'no-store' })` that resolves → CORS, that rejects → network (**GET only**).
4. Match server logs by rid. If the server doesn't log 4xx, match by time and path.
5. Reproduce with **GET only**. 🔴 Never resend POST/PUT/DELETE · never call auth endpoints (`sites[].authPathPrefixes`) from `page.fetch` or `page.evaluate`.

**Verdict**: the requests answering the user's action are 2xx, told apart from intended 4xx.
**Report**: `method path · status · ms · rid · response gist (redacted) · server log line · cause (CORS/CSP/network/server)`.
