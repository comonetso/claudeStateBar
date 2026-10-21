# browser-check — let Claude look at, click through and diagnose web pages in a real browser

Instead of declaring "tests pass" from server logs and source alone, Claude Code opens the page in **ego lite** — a Chromium browser on the user's Windows PC kept for agents — and verifies the screen, console, network, CSS, responsive layout, accessibility and performance itself. It works on the PC and, through a small relay on the PC, from servers over ssh.

- Trigger: Korean natural language such as "화면 확인해 봐" (check the screen), "CSS 깨졌는지 봐", "콘솔 에러 봐", "API 실패 봐", "반응형 봐", "접근성 점검", "성능 봐", "이 버튼 눌러 봐", "실시간 동기화 확인", "로그인 풀렸어" (STT variants included)
- Skill id: `browser-check:browser_check`

Up to version 0.1.x this plugin drove the Aside browser. From 0.2.0 it uses ego lite only: Aside stays the user's own browser, and "look at the tab I have open in Aside" is a job for the assistant inside Aside.

## How a check runs
The plugin puts one command on the Bash tool's path, `browser-check`, on the PC and on servers alike. The common check needs no script:

```
browser-check look https://example.com/
browser-check look https://example.com/search --fill "#q" "hello" --click "text=Search" --wait ".results"
browser-check look https://example.com/ --width 390 --dark --full
```

`look` opens the page, does the steps in the order given (click, fill, select, press a key, wait), and returns the page text with references Claude can click next, a capture, the console and network problems, and every request other than GET the page sent — so a click that saved or sent something is visible in the result. `browser-check api click` answers what a function takes, from ego's own help text. Anything else is a short script: `browser-check run <script.mjs>`, or `run -` with the script on stdin.

The script, and the one `look` builds, runs inside ego-browser's own Node runtime, in a task space of its own — ego's name for a set of agent tabs that never takes over the user's tabs or keyboard focus. In front of the script the plugin puts a set of helpers (`bc.*`): open the space and always close it again, wait until no request is in flight before closing, capture, collect console and network problems, list what was sent, guard writes, run the in-page kits. Images come back as files and data as JSON. If the machine is not set up yet, the answer says so and what to run, so there is no separate check step first.

On the PC the script goes straight to `ego-browser`. A server cannot do that: ego lite opens no network port and refuses any elevated caller ("ego-browser is running as administrator"), and an administrator's ssh session on Windows is always elevated. So `relay install` puts a relay on the PC that runs in the user's own, non-elevated logon session and listens on 127.0.0.1 only, with a token kept in its folder. A server sends the script over ssh to the relay's entry file, which hands it to the relay; the result comes back the same way. The ssh connection is reused for two minutes.

## Capture
ego refuses a normal screenshot while its window is minimized, and a window closed with X is only hidden — ego stops painting it. `bc.shot` handles all three states: a normal screenshot first; if refused, a screencast frame (screencast keeps painting while minimized; the plugin acks frames and takes the last one after a short wait, because the first frame can predate the latest change); if no frame comes at all, every ego window was closed with X, so it starts ego again, which shows the hidden window, and minimizes it at once (65–185 ms on screen in measurements), then captures. The user can leave ego minimized or closed. A full-page capture is only available while ego is not minimized; otherwise the page is captured in tiles and stitched.

## Write guard
`--guard-writes [--allow-write <path>]…`, or the site rule `guardWrites: true` with `writeAllow`. In the page, every fetch, XMLHttpRequest, sendBeacon and form submit that is not GET, HEAD or OPTIONS is refused unless its path is allowed, and the refusals are listed in the result. It tests itself first (a POST to a path that does not exist must be refused). WebSocket messages, requests a service worker sends by itself and top-level POST navigations without a submit event are not covered. On a logged-in site the token-refresh path has to be allowed: with the guard on, a site's refresh POST was refused and the page fell to its login screen (nothing reached the server, so the login itself survived). When the guard refuses a request whose path looks like a login or session refresh, `hints` in the result names it and the `--allow-write` that lets only that path through. It also notes writes that went out with the guard off, and an allowed path that worked but is not yet in the site rule. Refusals made before the page moved to another document (a login redirect) stay in the list. A path that Git Bash on Windows rewrote into a folder under Git (`C:/Program Files/Git/api/…`) is put back before use. Browser-level interception, which the old guard used, deadlocks in ego and is refused.

## Install
1. Install ego lite on the Windows PC (https://lite.ego.app/), finish its first-run setup, and sign in there to the sites Claude should check. ego can import from Chrome or Edge only.
2. `claude plugin install browser-check@comonetso` on the PC and on each server.
3. On the PC: `browser-check relay install` — copies the relay to `%LOCALAPPDATA%\browser-check\relay` and adds the Task Scheduler entry "browser-check ego relay" (at logon and every minute, a second copy exits at once, no time limit, not elevated). `relay status` and `relay uninstall` check and remove it.
4. Each server needs an ssh Host for the PC with key login. On first use `setup` asks every Host in `~/.ssh/config` whether it is a PC with the relay; with one answer it writes the config, with several it asks which, with none it says what is missing.
5. **Private runtime config** at `${CLAUDE_PLUGIN_DATA}/config.json` (mode 0600, parent 0700; Windows has no such mode bits, so the check is skipped there). Claude Code does not pass `CLAUDE_PLUGIN_DATA` to the Bash tool, so the command works the folder out from where the plugin is installed (`<plugins>/data/browser-check-comonetso`); `BROWSER_CHECK_CONFIG` overrides it. `setup` writes it on first use, shows what it put in and never overwrites a current file. A config from the Aside versions is reported, and `setup --migrate` rewrites it — the site rules are kept and the old file is backed up. Site rules start empty, which means the safe defaults. See `config/example.json` and `config/schema.json`.
6. `browser-check doctor` prints the state: on the PC ego-browser, its version, its windows and the relay; on a server the relay's answer. Outside Claude Code (cron, plain ssh) call `node <plugin folder>/scripts/browser-check.mjs` or `<plugin folder>/bin/browser-check`.

## Safety (full text: `skills/browser_check/SKILL.md` §1)
Clicks and typing, in `look` steps and in scripts, press the real site's buttons, so anything that saves, sends or deletes needs the user's approval first, and the result lists what was sent · own task space only · ego's windows are never moved, resized or minimized by Claude (the one exception is reopening a closed one minimized for a capture) · on logged-in sites a space is closed only after in-flight requests reach 0, otherwise it is left open and reported · data changes only with explicit approval for that exact target · no clipboard, downloads, native pickers or browser shortcuts · cookie and storage commands, browser close, window bounds, request interception and target creation are refused · secrets are neither read nor stored (central redactor) · logins, 2FA and CAPTCHA are handed to the user.

## Layout
```
.claude-plugin/plugin.json     manifest
bin/                           browser-check (sh, on the Bash tool's path) · browser-check.cmd (PowerShell, cmd)
hooks/hooks.json               SessionStart — stat-only (config layout and the ego-browser path; no browser contact)
skills/browser_check/          SKILL.md + recipes/*.md (10 task recipes)
scripts/browser-check.mjs      entry point: look · run (alias ego) · api · setup (first-run config, --migrate) · doctor · relay install|status|uninstall
scripts/ego/                   prelude.mjs (bc.* helpers) · relay.mjs (PC relay) · entry.cmd (what a server calls) · window.ps1 (ego window state, reopen minimized)
scripts/lib/                   look (one-line check) · api (function lookup) · ego (runner) · setup · config · capabilities · relay-install · redact
scripts/kit/                   diag-v2.1.js · webcheck*.js · vitals*.js · perfdiag · emu-lib
scripts/image/stitch.py        tile stitching (Pillow)
test/                          basic.test.mjs (redaction/config/leak) · setup.test.mjs (first-run config) · ego.test.mjs (runner, prelude) · simple.test.mjs (look, api, data folder, bin) · ego-example.mjs · ego-guard.mjs (run them with `run`)
```

`node --test test/basic.test.mjs test/setup.test.mjs test/ego.test.mjs test/simple.test.mjs` needs no browser. The leak check reads its patterns from a local file (`~/.claude/_private/browser_check_leak.txt`, or the path in `BROWSER_CHECK_LEAK_LIST`), one `/regex/flags` per line. The list is kept out of this package because it would publish the very values it guards; without it the check is skipped, not passed.

## Runtime
Zero external packages; Node core modules only, Node 18+ on the server side (measured on Node 20 and 22). The script itself runs on ego's bundled Node (24 in ego lite 0.6). Python 3 + Pillow only for stitching and cropping images (optional); doctor reports the command it found.

## Measured (2026-10-21 · Windows 11 · ego lite 0.6.0.16 · Chromium 154)
On the PC: open, snapshot, click, fill, first-load injection, device and media emulation, CSS rules, the accessibility tree, performance metrics, a 30,000-character kit, console/exception/404 events, three task spaces at once · capture through the screencast while minimized and after the window was closed with X (red, green and blue backgrounds checked frame by frame) · the write guard refused a fetch POST and a form submit and let a GET through; cookie reads were refused · a logged-in site opened signed in from a fresh task space and closed after 0 in flight · ego quit entirely and started again by the next run. From three Linux servers through the relay: setup found the PC by itself, the example ran in 5.4–6.3 s with its image copied back; with ego closed with X the capture reopened the window minimized; with ego not running the relay started it minimized first. `look` on the PC: a public page in 4.5 s, 7.8 s when the capture had to reopen ego first; a form filled and submitted with its POST listed under `sent` (and, with the guard on, refused and listed under `guardBlocked`); a 390-pixel dark view.

## Not measured yet — do not assume
Whether a minimized ego window throttles timers and animation frames (paint-based metrics and INP); clicks and fills usually took 0.1–0.6 s, but a few took 6–11 s and the cause is not known · the relay after a reboot (the logon trigger) and over days · relay behaviour while the PC is asleep · ego updates moving the active-version link while a run is going · recipes run end to end on a real app.
