# "Check console errors" · "Check API failures" — errors, failed requests, their cause

Prerequisite: SKILL.md §0–§2. Events (console, requests) **don't arrive over A/B** — only through the in-page recorder (v2.1) or over C. `DIAG_V21` below is the contents of `kit/diag-v2.1.js` (on Windows inject it over C — SKILL.md §3).

## Console errors
1. **Site without login**: `openTab` → `K.X(tab,'Page.addScriptToEvaluateOnNewDocument',{source: DIAG_V21})` → `reload()` → (the action the user described) → `page.evaluate(() => __diag.dump({types:['error','rejection','resource-error','resource-status','csp','ws-error','worker-error','sse-error','console']}))`.
   🔴 `summary().problems` is truncated — take only the counts from it (`problemCount`, `truncated`) and the contents from `dump`.
2. **Logged-in app**: if the dev server already injects the v2.1 recorder from first load (config `sites[].diag: "vite-v2.1"`, e.g. through a Vite plugin), open the tab and `dump`. Otherwise (assembled, not measured) open a same-origin URL without the app first → inject → `goto(app)`, so a single rotation covers the first load. Over C, receive `Runtime.consoleAPICalled`/`exceptionThrown` events directly. Output from browser extensions arrives separately as `ext-console`/`ext-exception` — not page errors.
3. **Production (no recorder)**: collect after the fact — `new ReportingObserver(cb,{buffered:true})` (deprecations, CSP) + resource failures; for later actions wrap console/error/unhandledrejection with `page.evaluate`.
4. To raise an error on purpose use an **inline `<script>`** (rejections raised from evaluate aren't caught).
5. Mark segments: `__diag.mark('step')` before an action → `dump({since})`.

**Verdict**: `error`, `rejection` (excluding v2.1 `handledLater`), `resource-error/status` and `csp` are all 0. List `console.warn` separately.
**Report** per error: `type · message · file:line:col · first stack line · step · rid if it was a request`.

## API failures
1. With the recorder: `dump({types:['fetch','xhr','ws-close','ws-error']})` → `status ≥ 400` · `phase:'failed'` (`aborted` is an intended cancel) · `ms` · `rid` (request-id header).
2. Without it, after the fact: fetch/xhr `responseStatus` and `duration` from `performance.getEntriesByType('resource')`. 🔴 Exactly 250 entries means it was truncated — `performance.setResourceTimingBufferSize(10000)`, then reproduce.
3. Cause of status 0: a `csp` event at the same moment → CSP block · a page `fetch(url,{mode:'no-cors',cache:'no-store'})` that resolves → CORS, that rejects → network (**GET only**) · for XHR read `reason` (timeout/error/abort).
4. Match server logs by rid with grep. If the server doesn't log 4xx, match by time and path.
5. Reproduce with **GET only**. 🔴 Never resend POST/PUT/DELETE · never call auth endpoints (`sites[].authPathPrefixes`) with a repl `fetch`.

**Verdict**: the requests answering the user's action are 2xx, told apart from intended 4xx.
**Report**: `method path · status · ms · rid · response gist (redacted) · server log line · cause (CORS/CSP/network/server)`.
