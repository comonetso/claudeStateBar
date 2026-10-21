---
name: browser_check
description: >-
  The way to use ego lite here — use this instead of the ego-browser skill (that one drives ego directly: no server relay, no write guard, no capture while minimized). Look at, click through and diagnose web pages in ego lite — a Chromium browser on the user's PC kept for agents, with the sites the user signed in to once — from the PC or from a server over ssh. One command, `browser-check look <url>`, opens a page and returns its text, a capture, errors and the requests it sent. Screen, CSS, console/network errors, responsive/dark mode, accessibility, performance, realtime sync, whole flows. Only when a page's real behaviour must be checked, not for source or logs alone. Korean triggers (incl. speech-to-text variants): "브라우저 체크/브라우저 첵/브라우저 책", "화면 확인해 봐/화면 좀 봐/실제 화면 봐 줘/페이지 봐 봐", "CSS 깨졌는지 봐/씨에스에스 오류/스타일 깨짐/레이아웃 이상해", "콘솔 에러 봐/컨솔 오류/자바스크립트 에러", "API 실패 봐/에이피아이 오류/요청 실패/네트워크 봐", "반응형 봐/모바일에서 어떻게 보여/좁은 화면", "다크모드 확인/테마 봐", "접근성 점검/접근성 봐", "성능 봐/느린지 봐/느려", "이 버튼 눌러 봐/클릭해 봐/눌러서 확인", "실시간 동기화 확인/두 탭 같이 바뀌나", "로그인 풀렸어/로그아웃 됐어/왜 튕겨", "전체 흐름 시험해/처음부터 끝까지 해 봐".
---

# browser_check — look at, operate and diagnose pages in ego lite

> Why: a "tests pass" report built from server logs and source leaves the holes on screen for the user to find. Say "verified" only for what you checked **in the browser**.

Language: talk to the user in the user's language, report labels in §5 included.

ego lite is not the user's main browser (that stays Aside) — it is kept for agents. The user signs in to the sites there once; your own task space then opens them signed in. The user's own Aside tabs are out of reach: "look at the tab I have open" is a job for the Claude inside Aside — say so.

## Quick use — usually all you need
```bash
browser-check look <url>                                       # open · page text · capture · errors · requests sent
browser-check look <url> --fill "#q" "hello" --click "text=Search" --wait ".results"   # steps run in this order
browser-check look <url> --width 390 --dark --full             # mobile width · dark scheme · whole page
browser-check look <url> --guard-writes --allow-write /api/auth/refresh   # logged-in site: writes blocked, only its login refresh passes (§1)
browser-check run - --url <url> <<'EOF'                        # anything else: a script (§2)
const r = await bc.run('my-check', async ({ page }) => { await page.goto(bc.url); /* … */ });
EOF
browser-check api click                                        # what a function takes — never read the plugin's source
```
- `browser-check` is on the Bash tool's PATH (the plugin's `bin/`) on the PC and on servers; nothing to set first. `command not found` (a session that started before an update) ⇒ `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs"` with the same arguments.
- **No check step first.** If this machine is not set up, the answer is `status: "not-ready"` with `next` — do what it says (see "First use" below) and run again.
- Steps: `--click <sel>` · `--fill <sel> <text>` · `--select <sel> <value>` · `--press <key>` · `--wait <sel>` · `--wait-ms <ms>`. Options: `--width <px>[x<h>]` · `--dark` · `--full` · `--no-shot` · `--name <space>` · `--guard-writes [--allow-write <path>]` · `--timeout <ms>` · `--text-max <chars>`. `browser-check help` prints all of it.
- Selectors: `@12` / `ref=12` from the page text · `text=…` · `loc=role:button[name='Save']` · `loc=css:…` · raw CSS — exactly one match or the step fails. Refs change after any page change: look again.
- The result (JSON): `page` (url, title, viewport) · `steps` (each `ok`/`error`, `ms`, and `sent` = what that step sent) · `text` (page text with refs; all of it in `textFile`) · `image` — **look at it with the image tool** · `problems` (console errors, exceptions, failed and 4xx/5xx requests) · `sent` (every non-GET request) · `closed` or `leftOpen` · `hints`.
- Starting other agents (workflow, subagents) for browser work: tell them "run `browser-check help`, then `browser-check look …`" — they do not need this file.

## 1. 🔴 Safety rules — breaking one damages the user's work
- **Clicks and typing are real.** `look` steps and scripts press the real buttons of the real site. Anything that saves, sends, deletes, invites, pays or changes settings needs the user's approval first — show the plan (what · where · how to clean up). Afterwards read `sent`: it lists every non-GET request the steps caused, so an unexpected save is visible — report it.
- **Your own task space only.** `look` uses a fresh space each run (`bc-look-<random>`, or `--name`); scripts use `bc.run('<short-task-name>', …)`. Never `claimTaskSpace`, `takeOverTaskSpace` or `adopt` a user tab unless the user asked for exactly that. `EGO_TASK_SPACE_NAME_IN_USE` means the name is the user's — pick another.
- **Leave ego's windows alone.** Never move, resize, raise, restore or minimize them — `Browser.setWindowBounds` is refused (a call meant for our space's window once minimized the user's window). Captures work while ego is minimized; when every window was closed with X, the capture reopens one minimized (about 0.1–0.2 s on screen — owner decision). Nothing else.
- **Logged-in site: close only after 0 requests in flight** — `look` and `bc.run` wait for it. `leftOpen` in the result ⇒ report it and leave it; never force-close (a cut token-refresh response logs the whole session family out — a real incident). Avoid `reload()`.
- **The write guard also stops a site's login refresh — allow that one path and keep the guard on.** With `--guard-writes` on a logged-in site (Mesa, measured) the page's refresh POST is refused and the page falls to its login screen (nothing reached the server). The fix: `--allow-write <that path>` — only that path passes, every other write stays blocked (e.g. `--guard-writes --allow-write /api/auth/refresh`; Mesa measured 10-21: still logged in, only its two refresh POSTs went out). `guardBlocked` lists what was refused, and `hints` names a refused request that looks like a login refresh with the exact `--allow-write` to add. Take the path from `guardBlocked` or from the user — never guess one. To stop passing it every run, ask the user to put it in this site's `sites[].writeAllow`. **"Ask the user" means: don't guess the path — it does not mean: turn the guard off.** Look without the guard only when the user agrees, and then press nothing that writes (`hints` reports writes that went out unguarded).
- **Dialogs:** a JavaScript dialog a `look` step opens is dismissed and reported in that step; in scripts handle `page.info().dialog` yourself (`page.dismissDialog()` unless accepting was approved).
- **Forbidden input:** `keyboard.paste` (the user's real clipboard) · Ctrl+C/V/X · browser shortcuts (F5 · F11 · F12 · Ctrl+W …) · clicking `<select>`, date, colour or file inputs (OS dialogs) — use `--select`/`selectOption`/`setInputFiles` · downloads unless approved. `fill` on a hidden field types into whatever has focus (a chat box); `\n` in typed text and POST `page.fetch` really send.
- **Refused CDP** (scripts throw on them): cookies and storage — read or clear · `Browser.close`/`setWindowBounds` · `Fetch.*` (deadlocks in ego) · `Target.createTarget`/`closeTarget` · `Page.close`. Don't route around a refusal.
- **Never read or keep secrets:** no password values (length only) · results go through the redactor · never print cookies, tokens or the relay token.
- **Logins, 2FA, CAPTCHA, permission prompts are the human's job:** in a script `await task.handOff()`, end the run, tell the user what to do in ego (open ego, go to the space named …); resume with `takeOverTaskSpace(<id>)` after they confirm.
- **ego update notice** in `hints` ⇒ tell the user; `ego-browser upgrade` only with their approval.

## 2. Scripts — `browser-check run <file.mjs>` or `run -` with a quoted heredoc (`<<'EOF'`)
The script runs **inside ego-browser's own Node on the PC**: top-level `await` works · Node built-ins only by `await import('node:fs')` · the server's files and environment are not there — put every input in the script; `bc.url` is `--url` · page code goes in `page.evaluate`. Every run is a new process: spaces persist by name, variables don't. Default limit 300 s (`--timeout` up to 30 min).
```js
const r = await bc.run('check-orders-page', async ({ task, page }) => {
  await bc.watch(page);                          // record console, exceptions, network from here on
  await page.goto(bc.url); await page.waitForLoadState();
  console.log(await page.snapshot());            // page text with refs (@12)
  bc.out('SHOT', await bc.shot(page, 'orders')); // capture (works while ego is minimized)
  bc.out('PROBLEMS', await bc.problems(page));
  bc.out('SENT', await bc.sent(page));           // non-GET requests the page sent
});
bc.out('CLOSED', r.closed);
```
Result: `status` · `images` (files) · `outs` (every `bc.out(tag, value)`, by tag) · `leftOpen` · `guard` · `hints` · `tail` (other output).
Helpers: `bc.run` · `bc.shot` · `bc.watch` · `bc.problems` · `bc.sent` / `bc.mark` · `bc.events` (never `page.events()` — it empties the buffer) · `bc.settle` · `bc.guardWrites` / `bc.guardReport` · `bc.kit(page, '<kit>')` · `bc.out` · `bc.img` · `bc.url`. ego's own: `page.goto/click/fill/press(selector, key)/keyboard.press(key)/selectOption/waitForSelector/evaluate/snapshot({scope:'full_page'})/info/screenshot/cdp`, `task.newPage()`. **For any signature: `browser-check api <part of a name>`** (it asks ego's own help, so it is always current).

## 3. Request → recipe (`${CLAUDE_PLUGIN_ROOT}/skills/browser_check/recipes/`) — read one only when `look` is not enough
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

## 4. ego traps — measured 2026-10-21
- `page.screenshot` is refused while ego is minimized and times out in a window closed with X — use `bc.shot` (`look` does). Full-page capture works only through `page.screenshot`; when refused, scroll and shoot tiles, then `scripts/image/stitch.py`.
- A click or fill usually takes 0.1–0.6 s; a few took 6–11 s (2026-10-21, cause not found — ego waits until the element is usable, and a minimized window paints slowly). `steps[].ms` shows it; don't add your own sleeps for it.
- The page text is the viewport only unless `--full` / `snapshot({ scope: 'full_page' })`.
- ego's theme can be dark; `look`/`bc.run` force the light scheme unless `--dark`.
- Extensions in ego (e.g. McAfee WebAdvisor) can throw — `problems` keeps `chrome-extension://` errors out of the page errors.
- From a server a run is ~1–1.5 s slower (ssh + PC relay). When ego was not running the relay starts it minimized first (~25 s once). The PC must be awake and logged in; a server cannot wake it.

## 5. Report format (labels in the user's language)
```
[Target] real URL · dev/prod · logged in? · where (PC / server → PC)
[Conditions] viewport · emulation (width/dark) · guard on/off · capture via screenshot/screencast
[Results] item | verdict (✅/❌/partial) | value · threshold | evidence (image file · problems entry · request)
[Sent] non-GET requests the steps caused (none expected for a read-only check)
[Not checked] why, and what a person must do
[Left behind] task space closed (or leftOpen) · data created (approval) · cleanup done
```

## 6. Only a person can do these — hand them over
Signing in to a site in ego · 2FA/CAPTCHA · permission prompts · approving data changes · the real clipboard · OS pickers · real devices · installing or updating ego lite · `browser-check relay install` on the PC · design judgement · anything in the user's own Aside tabs (the Claude inside Aside does that).

## First use on a machine (only when an answer says `not-ready`)
- `config file not found` ⇒ `browser-check setup`. It looks the machine over (ego-browser on the PC; on a server it asks each ssh Host whether it is a PC with the relay), writes the config and lists what it set — **show those values to the user**. It never touches a current config.
- Old Aside config ⇒ `browser-check setup --migrate` (site rules kept, old file backed up) — show the user.
- `choose-host` ⇒ show the candidates and run `browser-check setup --remote-host "<name>"` with the one the user picks.
- Anything else ⇒ `browser-check doctor` and relay its `todo` (install ego lite and sign in · `relay install` on the PC · an ssh Host for the PC — human tasks).
