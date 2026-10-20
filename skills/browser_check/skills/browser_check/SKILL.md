---
name: browser_check
description: Look at, click through and diagnose web pages in ego lite — a Chromium browser on the user's PC kept for agents, with the sites the user signed in to once — from the PC or from a server over ssh. Screen, CSS, console/network errors, responsive/dark mode, accessibility, performance, realtime sync, whole flows. Only when a page's real behaviour must be checked, not for source or logs alone. Korean triggers (incl. speech-to-text variants): "브라우저 체크/브라우저 첵/브라우저 책", "화면 확인해 봐/화면 좀 봐/실제 화면 봐 줘/페이지 봐 봐", "CSS 깨졌는지 봐/씨에스에스 오류/스타일 깨짐/레이아웃 이상해", "콘솔 에러 봐/컨솔 오류/자바스크립트 에러", "API 실패 봐/에이피아이 오류/요청 실패/네트워크 봐", "반응형 봐/모바일에서 어떻게 보여/좁은 화면", "다크모드 확인/테마 봐", "접근성 점검/접근성 봐", "성능 봐/느린지 봐/느려", "이 버튼 눌러 봐/클릭해 봐/눌러서 확인", "실시간 동기화 확인/두 탭 같이 바뀌나", "로그인 풀렸어/로그아웃 됐어/왜 튕겨", "전체 흐름 시험해/처음부터 끝까지 해 봐".
---

# browser_check — look at, operate and diagnose pages in ego lite

> Why: a "tests pass" report built from server logs and source leaves the holes on screen for the user to find. Say "verified" only for what you checked **in the browser**.
> Every rule here comes from a measurement or an incident (ego lite 0.6, 2026-10-21; the older ones from the Aside era, 2026-09/10). Where a manual and a measurement disagree, follow the measurement.

Language: talk to the user in the user's language, report labels in §5 included.

ego lite is not the user's main browser (that stays Aside) — it is kept for agents. The user signs in to the sites there once; your task space then opens them signed in. The user's own Aside tabs are out of reach: "look at the tab I have open" is a job for the Claude inside Aside — say so (§6).

## 0. Start — every time, in order
1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor --json` — reads the config and checks ego (on the PC) or the PC relay (on a server). **Do not change the config or start anything yourself.** `ready: false` ⇒ report what doctor said and stop.
   - **No config (`config file not found`) ⇒ `setup --json` first.** It looks this machine over (ego-browser on the PC; on a server it asks every ssh Host whether it is a PC with the relay), writes the config and returns what it set (`notes`). **Show those values to the user** before going on. It never touches a current config.
   - **Old Aside config (`schemaVersion 1`) ⇒ `setup --migrate --json`.** It keeps the site rules, backs the old file up and says so — show the user.
   - `choose-host` ⇒ show `candidates` and run `setup --remote-host "<name>"` with the one the user picks. Don't pick for them.
   - `not-ready` ⇒ relay `todo` as is (install ego lite and sign in · `relay install` on the PC · an ssh Host for the PC — human tasks) and stop.
   - A shell outside the plugin (workflow agent, cron, plain ssh) has no `CLAUDE_PLUGIN_DATA` — pass `CLAUDE_PLUGIN_DATA=<claude config dir>/plugins/data/browser-check-comonetso`.
2. Classify the target: URL (dev/prod) · **logged-in site?** (config `sites[].login`) · does it change data? · which recipe.
3. Logged-in site ⇒ read §1 on closing and the guard first. Data change ⇒ **show a plan first (what · where · how to clean up) and get approval.**

## 1. 🔴 Hard safety rules — breaking one damages the user's work
- **Your own task space only.** Work inside `bc.run('<short-task-name>', …)`. Never `claimTaskSpace`, `takeOverTaskSpace` or `adopt` a user tab unless the user asked for exactly that. Space names are unique: `EGO_TASK_SPACE_NAME_IN_USE` means the name is the user's — pick another.
- **Leave ego's windows alone.** Never move, resize, raise, restore or minimize them yourself — `Browser.setWindowBounds` is refused (on 2026-10-21 a call meant for our space's window minimized the user's window: the space's tab belongs to it). Captures work while ego is minimized; when every ego window was closed with X, `bc.shot` reopens one and minimizes it at once (about 0.1–0.2 s on screen — owner decision). Don't do it any other way.
- **Logged-in site: close only after 0 requests in flight.** `bc.run`/`bc.finish` wait for it (an in-page fetch/XHR counter plus a stable resource count, 5 checks 500 ms apart). If the result has `leftOpen`, report it and leave it — never force-close (a cut token-refresh response logs the whole session family out — a real incident). Move between screens by SPA navigation; avoid `reload()`.
- **The write guard also stops a site's token refresh.** With `--guard-writes` on Mesa the refresh POST was refused and the page fell to its login screen (nothing reached the server; the login survived). On a logged-in site the refresh path must be in `sites[].writeAllow` — ask the user, never guess it — or check without the guard and don't act. `outs.GUARD_BLOCKED` lists what it refused.
- **No data changes** (send · save · delete · invite · pay · settings) — only the approved target and action. Traps: `fill` on a hidden field types into whichever field has focus (a chat box), and Enter sends it · `keyboard.type('…\n')` sends · `page.fetch` with POST really sends · `selectOption` with a missing value is not an error you can rely on — check the result. Check `document.activeElement` after typing; send or break lines explicitly with `page.press(selector, 'Enter'|'Shift+Enter')`.
- **Dialogs:** ego never answers them for you — a `receipt.dialog` or `page.info()` dialog must be handled: `page.dismissDialog()` unless the action was approved.
- **Forbidden input:** `keyboard.paste` (it goes through the user's real clipboard) · Ctrl+C/V/X · browser shortcuts (F5 · F11 · F12 · Ctrl+W …) · clicking `<select>`, date, colour or file inputs (OS dialogs) — use `selectOption`/`setInputFiles` · downloads unless approved (then `download.saveAs` into the run's out dir only).
- **Refused CDP** (the prelude throws on them): cookies and storage — read or clear (they reach the whole ego profile) · `Browser.close`/`setWindowBounds` · `Fetch.*` (deadlocks in ego: the paused request waits on a page command queued behind it — measured) · `Target.createTarget`/`closeTarget` · `Page.close`. Don't route around a refusal.
- **Never read or keep secrets:** no password values (length only) · results go through the central redactor · never print cookies, tokens or the relay token.
- **Logins, 2FA, CAPTCHA, permission prompts are the human's job:** `await task.handOff()`, end the run, tell the user what to do in ego (open ego, go to the space named …). After they confirm, resume with `takeOverTaskSpace(<id>)` in the next run.
- **ego update notice** (`hints` mentions it) ⇒ tell the user; run `ego-browser upgrade` only with their approval.

## 2. How to run
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" ego <script.mjs> [--url <url>] [--guard-writes [--allow-write <path>]…] [--timeout <ms>]
```
Write the script to a UTF-8 file in your temp folder (a new file per round). It runs **inside ego-browser's Node on the PC**: top-level `await` works · Node built-ins only by dynamic `await import('node:fs')` · the server's files and environment are not there — put every input in the script; `bc.url` carries `--url` · page code goes inside `page.evaluate`. Every run is a new process: task spaces and their tabs persist by name, variables don't.

The template — use it for every check:
```js
const r = await bc.run('check-orders-page', async ({ task, page }) => {
  await bc.watch(page);                          // console, exceptions, log, network from here on
  await page.goto(bc.url); await page.waitForLoadState();
  console.log(await page.snapshot());            // text view with refs (@12) for actions
  bc.out('SHOT', await bc.shot(page, 'orders')); // a capture that also works while ego is minimized
  bc.out('PROBLEMS', await bc.problems(page));   // errors, failed and 4xx/5xx requests; extension noise in .ext
});
bc.out('CLOSED', r.closed);                      // closed after 0 in flight, or leftOpen reported
```
The command prints JSON: `status` · `images` (files — look at them with the image tool) · `outs` (every `bc.out(tag, value)`, by tag) · `leftOpen` · `guard` · `hints` · `tail` (other output, redacted).

`bc` helpers: `run(name, fn)` (prep → fn → settle → close, also when fn throws) · `prep(page)` (in-flight counter, light colour scheme) · `settle(page)` · `finish(task, page)` · `shot(page, name)` · `watch(page)` · `events(page)` (use instead of `page.events()`, which empties ego's buffer) · `problems(page)` · `guardWrites(page, {allow})` / `guardReport(page)` · `kit(page, name)` / `kitSource(page, name)` (scripts/kit — `webcheck`, `webcheck-extra`, `webcheck-t3-snippets`, `diag-v2.1`, `diag-t3-snippets`, `vitals-install`, `vitals-report`, `perfdiag`, `emu-lib`; only kits named this way travel with the script) · `out(tag, v)` · `img(name, buffer)` · `url`.

ego's own API (not Playwright — `help("page.click")` inside a script prints a signature): `page.goto/reload/url/title/info/snapshot({scope:'full_page'})/waitForURL/waitForSelector/waitForFunction/waitForLoadState/waitForEvent('popup'|'download')/click/dblclick/hover/fill/selectOption/focus/press(selector, chord)/setInputFiles/evaluate(fn, arg)/fetch/cdp(method, params, {timeout})/close` · `page.mouse.*` · `page.keyboard.*` · `task.newPage()` (`task.page('p2')` only refers to an existing page) · `task.tabs()` · `task.cdp('Target.getTargets'|'Browser.getWindowForTarget')` read-only. Selectors: `@12`/`ref=12` from a snapshot, `text=…`, `loc=role:button[name='Save']`, `loc=css:…`, raw CSS; exactly one match or it fails.

No 50 s limit any more: the default is 300 s per run (`--timeout` up to 30 min). Keep each `page.evaluate` bounded.

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
| find out why they got logged out | `login-incident.md` |
| test a whole flow | `flow.md` |

Recipes are in `${CLAUDE_PLUGIN_ROOT}/skills/browser_check/recipes/`.

## 4. ego traps — measured 2026-10-21, before believing "it works"
- `page.screenshot` is refused by the browser while the window is minimized and times out in a window closed with X — use `bc.shot` (screencast fallback, reopen-minimized as the last step). Full-page capture only works through `page.screenshot`; when it is refused, scroll and shoot tiles, then `scripts/image/stitch.py`.
- The first screencast frame can be the one painted before your last change — `bc.shot` acks frames and takes the last one after a short wait. Don't hand-roll screencast.
- `page.press` takes a selector first: `page.press('body', 'Escape')`.
- `page.events()` empties the buffer; one stray call starves `bc.problems`. Use `bc.events`.
- A snapshot is the viewport only — `page.snapshot({ scope: 'full_page' })` for the rest; refs change after any page change: take a new snapshot.
- ego's own theme can be dark, so pages render dark — `bc.prep` forces `prefers-color-scheme: light` (config `ego.light: false` keeps ego's).
- Extensions installed in ego (e.g. McAfee WebAdvisor) can throw — `bc.problems` keeps `chrome-extension://` errors in `.ext`; don't report them as page errors.
- A server run is ~1–1.5 s slower than on the PC (ssh + relay; the ssh connection is reused for 2 minutes). When ego was not running the relay starts it minimized first (seen: ~25 s for that one run).
- The PC must be awake and logged in; a server cannot wake it. doctor says when the relay does not answer.

## 5. Report format (write the labels in the user's language)
```
[Target] real URL · dev/prod · logged in? · where (PC / server → PC)
[Conditions] viewport · DPR · emulation used (width/media/CPU) — reverted? · guard on/off · capture via screenshot/screencast
[Results] item | verdict (✅/❌/partial) | value · threshold | evidence (image file · problems entry · request)
[Not checked] why, and what a person must do
[Left behind] task space closed (or leftOpen) · data created (approval) · cleanup done
```

## 6. Only a person can do these — hand them over, don't ask for them
Logging in or back in to a site in ego · 2FA/CAPTCHA · permission prompts · approving data changes · the real clipboard · OS file/date/colour pickers · real devices (mobile Safari etc.) · the final check of OS IME behaviour · installing or updating ego lite · `relay install` on the PC · design judgement · **anything in the user's own Aside tabs** (what they see right now, why their session logged out): that is for the Claude inside Aside — browser_check can only reproduce it in ego.
