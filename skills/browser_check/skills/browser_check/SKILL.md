---
name: browser_check
description: Look at, click through and diagnose the user's real browser (Aside/Chromium) on their PC, from a server or the PC — screen, CSS, console/network errors, responsive/dark mode, accessibility, performance, realtime sync, logouts, whole flows. Only when a page's real behaviour must be checked, not for source or logs alone. Korean triggers (incl. speech-to-text variants): "브라우저 체크/브라우저 첵/브라우저 책", "화면 확인해 봐/화면 좀 봐/실제 화면 봐 줘/페이지 봐 봐", "CSS 깨졌는지 봐/씨에스에스 오류/스타일 깨짐/레이아웃 이상해", "콘솔 에러 봐/컨솔 오류/자바스크립트 에러", "API 실패 봐/에이피아이 오류/요청 실패/네트워크 봐", "반응형 봐/모바일에서 어떻게 보여/좁은 화면", "다크모드 확인/테마 봐", "접근성 점검/접근성 봐", "성능 봐/느린지 봐/느려", "이 버튼 눌러 봐/클릭해 봐/눌러서 확인", "실시간 동기화 확인/두 탭 같이 바뀌나", "로그인 풀렸어/로그아웃 됐어/왜 튕겨", "전체 흐름 시험해/처음부터 끝까지 해 봐".
---

# browser_check — look at, operate and diagnose the real browser

> Why: a "tests pass" report built from server logs and source leaves the holes on screen for the user to find. Say "verified" only for what you checked **in the real browser**.
> Every rule here comes from measurement (2026-09-26: 12 remote server→PC runs plus a Codex consult). Where a manual and a measurement disagree, follow the measurement.

Language: talk to the user in the user's language, report labels in §5 included.

## 0. Start — every time, in order
1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor --json` — reads the config and transports (A/B/C). **Do not change the config or start the browser/Aside.** If no transport is usable, report the table as is and stop (remote `disabled`/`offline` ⇒ the user must enable it on the PC).
   - **No config (`config file not found`) ⇒ run `setup --json` first.** It inspects this machine (Aside CLI · the running Aside's port · tunnel socket · `aside host list`), writes the config and returns what it set (`notes`). **Show those values to the user** before going on. It never touches an existing config.
   - `choose-host` ⇒ show `candidates` (remote PCs) and run `setup --remote-host "<name>"` with the name the user picks. Don't pick for them.
   - `not-ready` ⇒ relay `todo` as is (install/log in to Aside, open the tunnel, start the Aside browser — human tasks) and stop.
   - `launchFlags.missing` non-empty (Windows: the running Aside lacks C's launch flags — doctor/setup also print a `!` line) ⇒ tell the user that C stops capturing while every Aside window is covered or the window is minimized, and **only with their OK** run `launch-flags --apply` (adds the flags to the Aside shortcuts — taskbar, Start menu, desktop; old arguments saved, `launch-flags --undo` puts them back). **Never restart Aside yourself** — the user may be working in it; tell them the flags apply once Aside is fully closed and started again from a shortcut. Aside's own Start-menu shortcuts are write-protected for the user (and recreated on Aside updates), so they come back in `failed` — relay that as is; the taskbar-pinned or user-made shortcut is the one that takes the flags, so suggest starting Aside from it.
2. Classify the target: URL (dev/prod) · **logged-in site?** (config `sites[].login`) · does it change data? · which recipe.
3. Logged-in site ⇒ read the token rules in §1 first. Data change ⇒ **show a plan first (what · where · how to clean up) and get approval.**

## 1. 🔴 Hard safety rules — breaking one damages the user's work (each comes from a real incident or measurement)
- **Own tabs only**: use only tabs opened with `openTab`. Never `attachBrowserTab`/`attachActiveBrowserTab` (the user's tabs). Close with `closeTab(tab)`, not `page.close()`. **The one exception is a lent tab on C** (§2b): the site's config rule has `borrow`, or the user approved this tab for this run (then pass `--user-approved` — never add it without that approval).
- **Close a logged-in site's tab only after confirming 0 in-flight requests** (`K.safeClose`). Closing mid-request loses the refresh response; the server reads it as token theft and **logs the user out of the whole session family** (real incident). Reload, a new tab and a same-origin iframe all rotate the token — move between screens by SPA navigation, emulate widths with CDP.
- **≤ 50 s per call · ≤ 25 s per evaluate** (the remote limit is about 60 s — past it all output is lost and a persistent session dies whole). Guard every step with `K.G`.
- **Never click Aside's autofill menu (`aside-inline-menu`)** — after filling it **presses the login button itself** and revokes the existing session. Logins and passwords are the human's job.
- **No data changes** (send · save · delete · invite · pay · settings) — only the approved target and action. Automation traps: `trial:true` really clicks · a covered element "succeeds" through a synthetic click · **`fill` on a hidden input types into whichever field has focus (a chat box), and Enter sends it** · `type('…\n')` sends · a repl `fetch` POST really sends · `selectOption` with a missing value picks the first option. Check `K.canAct` before input and `document.activeElement` after; send or break lines explicitly with `keyboard.press('Enter'|'Shift+Enter')`.
- **Aside always answers "OK" to a native `confirm`** — call `K.denyConfirm` right before a destructive button (navigation clears it).
- **Forbidden input**: Ctrl+V / Shift+Insert (pastes the user's real clipboard) · Ctrl+C / clipboard API · browser shortcuts (F5 · F11 · F12 · Ctrl+W …) · **clicking** `<select>`, date, color or file inputs (OS dialogs) · dragging draggable elements with `mouse.*` (OS drag) · download tests (the file stays in the user's download folder and can't be removed).
- **Forbidden CDP**: `fromSurface:false` (captures the user's screen — this happened) · `Target.*` (on C only the three own-target calls, plus read-only `Target.getTargets`) · `Browser.*` (on C only read-only `Browser.getWindowForTarget`) · cookies/storage · `Fetch.*` · `Debugger.pause` · `Page.navigate/close` (C: allowed on own tabs; navigate also on a borrowed tab). `bringToFront`/`activateTarget`/close are refused on a borrowed tab and an isolated window. The write guard, isolated profiles and their cookies exist only as client methods (§2b) — scripts can't send those commands directly. `K.X` enforces an allow-list.
- **Never read or keep secrets**: no password values (length only) · all output goes through the central redactor · never record Aside memory, settings values or auth file contents.
- **Concurrency 1**: several servers and agents share one PC browser. At most 2 own tabs at once; when done, confirm 0 own tabs in the list — count by `tab.targetId`, not URL (the user may have the same URL open). On `Too many Remote Control RPCs`, retry once after a few seconds.

## 2. Environment prep — before any verdict
- `K.prep(tab, {darkReader: site.darkReader})`: **detect before changing** → warn → lock Dark Reader and hide injected UI in your own tab only. On `@@WARN DARK_READER_ON`, **always tell the user** — with it on, colour and capture verdicts can't be trusted (which is why it is often kept off on sites under development). On transport C (`browser-check.mjs cdp`) use `client.prep(sessionId, {darkReader})` — same order; relay its `warnings` the same way.
- Hide DeepL/Aside injected elements (`deepl-*`, `aside-inline-menu`, `bro-*`) and record them as `detected`. Pass them to axe as `exclude`.
- In C recordings (`client.record`), **errors raised by browser extensions** are kept apart as `ext-exception`/`ext-console` (with the extension name) and left out of `summary().problems`. Don't report them as page errors (example.com: 2 of 3 exceptions came from DeepL).
- C's own tab is a hidden tab: a document that was never painted **drops clicks and keys without an error** (measured: 0 left/right clicks before one capture). The client wakes each document with one capture before its first `Input.dispatch*` (70–550 ms; again after navigation). If waking fails it sends nothing and raises `input not sent` — retry.
- 🔴 **C needs Aside started with three launch flags, or it stalls when the PC's Aside windows are covered or minimized** (`cdp timeout Page.captureScreenshot` / `input not sent`, on the PC and over the tunnel). Measured on Windows 2026-10-14 with a colour change before each capture so a stale frame could not pass: without flags C stops once **every** Aside window is covered (one visible Aside window was enough) and whenever the window is minimized · `--disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion` keep captures going with every Aside window covered (the page stays `visible`) but not when minimized · `--enable-features=CDPScreenshotNewSurface` (Chromium's screenshot path that copies a fresh surface instead of waiting for the next presented frame) made captures and real clicks/keys go through while minimized (isolated test browser; `--disable-renderer-backgrounding` did not help). A locked screen did not stall C even without flags. On those errors suspect this first: run `launch-flags` (§0) — if the running Aside lacks a flag, that is the cause; otherwise ask the user to restore the Aside window. macOS not measured. A/B (Aside) are unaffected.
- Before measurements, colours or animation, `K.wake` (agent tabs are throttled to 2–4 fps — one capture lifts it; navigation brings it back).
- Pick the transport from the doctor result: snapshot/interaction = A · imperative CDP (first-load injection, device width, dark mode, CSS cascade, AX tree) = B (check `K.hasX`) · events, background tabs, long jobs = C. Report the choice and the fallback. **Never auto-retry the same action on another transport.**

## 2b. C opt-ins — a lent tab, a write guard, an isolated window (all off unless asked for)
Use them when the owner wants an existing tab reused (no new tab), nothing brought to the front, or production data left untouched.
- `browser-check.mjs tabs [--match <p>] [--same-window-as <p>]` — read-only list of tabs and window ids. Look before borrowing.
- `browser-check.mjs cdp <script.mjs> --borrow <p> [--same-window-as <p>] [--borrow-target <id>] [--user-approved] [--no-prep]` — `helpers.borrowed = { targetId, sessionId, windowId, url, injected }`. Patterns: no `*` = "origin+path contains"; with `*` = glob over origin+path. `sameWindowAs` defaults to the site rule's `borrow.sameWindowAs`. Errors: `no-tab`/`no-anchor` ⇒ ask the person to open the tab in that window (never open one yourself) · `several` ⇒ show the candidates and let the person pick, then `--borrow-target` · `not-lent` ⇒ ask the user · `tab-unresponsive` (the tab did not answer a read-only first command; the error names its window state) ⇒ ask the person to restore that window and click the tab once, then run again — never reload, raise or retry it in a loop (seen 2026-10-15 on a minimized window; the cause is not confirmed, and a page frozen with `Page.setWebLifecycleState` still answers in tests). Prep (default) keeps Aside autofill menus, DeepL and password icons hidden for the whole run and after navigation — this is what stopped the 2026-10-15 near-miss where an autofill menu over a radio label filled an e-mail field. On the borrowed session `Page.navigate` works; on sites with rotating refresh tokens still prefer SPA navigation (§1). Release is automatic: emulation, prep and guard are undone, the tab is detached, never closed; `out.borrowed.released.undone` lists what was undone.
- `--guard-writes [--allow-write <path>]…` (or site rule `guardWrites: true` + `writeAllow`) — `helpers.guard`: non-GET/HEAD/OPTIONS requests of the borrowed tab are failed in the browser, allowed paths pass; `out.borrowed.guard` has `blocked`, `passed` and the entries. It self-tests first (POST to a non-existent path must be blocked) and throws `guard-self-test` otherwise — then stop and report. **Not covered: WebSocket messages and requests a service/shared worker sends itself** — say so whenever a guarded check touches realtime features. For an own or isolated tab, call `client.guardWrites(sessionId, { allow })` in the script.
- `client.openIsolatedWindow(url)` → `{ targetId, sessionId, browserContextId, windowState }` — a throwaway profile in a new minimized window for test accounts. Logging in is the person's job, or `client.setIsolatedCookies(browserContextId, cookies)` (that profile only; values are never returned — don't print them either). Deleted on `closeIsolatedWindow`/dispose or when the connection drops. Capturing it while minimized needs `CDPScreenshotNewSurface` (§2).
- From a shell that is not this plugin's (workflow agent, cron, ssh), `doctor` says `Config INVALID` because `CLAUDE_PLUGIN_DATA` is missing — pass `CLAUDE_PLUGIN_DATA=<claude config dir>/plugins/data/browser-check-comonetso`.

## 3. Request → recipe
| The user asks to… | Recipe |
|---|---|
| look at a screen or an element | `screen.md` |
| check broken CSS · layout · overflow · clipping | `css.md` |
| check console errors · API failures · network | `console-network.md` |
| check responsive · mobile · dark mode · print | `responsive-theme.md` |
| check accessibility | `accessibility.md` |
| check performance · slowness | `performance.md` |
| click or type something | `action.md` |
| check realtime sync · two tabs | `realtime.md` |
| find out why they got logged out | `login-incident.md` (🔴 don't open a new tab — it changes the evidence) |
| test a whole flow | `flow.md` |

Recipes are in `${CLAUDE_PLUGIN_ROOT}/skills/browser_check/recipes/`. In them, `kit/`, `image/` and `session/` mean `${CLAUDE_PLUGIN_ROOT}/scripts/kit/` and so on.

How to run code:
- One-shot: `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" run <body.js> --url <url>` (adds the common head, 50 s guard, lock, `@@IMG` saving, redaction). 🔴 On Windows the code travels as one command-line argument (limit about 32,767 characters) and the head plus the v2.1 recorder already exceed it — for work that injects the recorder, use C (`cdp`), which loads scripts from files.
- Several steps / logged-in apps: the persistent session driver `session/drv.py` (one line = one run, each line ≤ 50 s; `ASIDE_BIN`/`ASIDE_HOST` come from the config). 🔴 `drv.py` does not run on Windows (Python `select()` fails on pipes) — on a Windows host use C, or report that a persistent session isn't available there.
- Python scripts (`session/drv.py`, `image/*.py`) run with the command doctor found (`pythonCmd` — e.g. `python3`, or `py -3` on Windows). Without one, only those features are missing.

## 4. Asidewright traps — before believing "it works"
No auto-wait (fails in 1 ms when absent; `waitFor` defaults to 3 s) · no strict mode (several matches ⇒ the first) · `page.url()` misses SPA navigation (use `K.href`) · `reload()` returns before load · `waitForLoadState` doesn't guarantee 0 requests · `clip` ignores the origin, `fullPage` repeats the first screen, `locator.screenshot` is unavailable (take a full capture and crop it on the server; stitch scrolled tiles with `image/stitch.py`) · regex arguments silently match nothing · `keyboard.press('Space')` sends an empty key (use CDP `Input.dispatchKeyEvent`) · `locator.hover` doesn't move the mouse · `dragTo` drops twice · right-click is `page.mouse.click(x,y,{button:'right'})` · only `page.evaluate` runs in the main world (`locator.evaluate` is isolated) · Resource Timing stops at 250 entries (`setResourceTimingBufferSize`) · code containing an `import(` or `require(` shape anywhere is rejected before it runs.

## 5. Report format (write the labels in the user's language)
```
[Target] real URL (K.href) · dev/prod · logged in? · transport (A/B/C and why)
[Conditions] window size · DPR · fps (after wake) · Dark Reader detected/locked · injected UI · visibility · cache · emulation used (width/media/CPU) — reverted?
[Results] item | verdict (✅/❌/partial) | value · threshold | evidence (capture file · dump line · rid · sheet:line)
[Not checked] why, and what a person must do
[Left behind] 0 open tabs confirmed · data created (approval) · cleanup done
```

## 6. Only a person can do these — hand them over, don't ask for them
Whether agent tabs pop up in front of the user's screen · the cause of frame throttling · the real clipboard · OS file/date/colour pickers, the native context menu, permission prompts · real mouse drags · logging in or back in · approving data changes · real devices (mobile Safari etc.) · the final check of OS IME behaviour · PC settings (enabling remote, extensions, updates) · opening tunnels · cleaning the download folder · design judgement.
