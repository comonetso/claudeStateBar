# browser-check — let Claude look at, click through and diagnose the user's real browser

Instead of declaring "tests pass" from server logs and source alone, Claude Code opens the user's **real browser (Aside/Chromium)** — remotely from a server or locally on the PC — and verifies the screen, console, network, CSS, responsive layout, accessibility and performance itself.

- Trigger: Korean natural language such as "화면 확인해 봐" (check the screen), "CSS 깨졌는지 봐", "콘솔 에러 봐", "API 실패 봐", "반응형 봐", "접근성 점검", "성능 봐", "이 버튼 눌러 봐", "실시간 동기화 확인", "로그인 풀렸어" (STT variants included)
- Skill id: `browser-check:browser_check`

## Three transports (a policy layer picks — never the caller)
| | What | Needs |
|---|---|---|
| **A** Aside repl (remote or local) | open tab · snapshot(ref) · click/type · screenshot · pdf | Aside CLI (+ Aside Pro remote host when driving another machine) |
| **B** raw CDP inside the repl (`page._sendToTarget`) | init-script injection · device metrics · dark/print media · CSS cascade · AX tree · profiler | same as A (private method — `typeof` check every time) |
| **C** direct CDP (local TCP, or a reverse-SSH Unix socket on a server) | console/network **events** · background targets · work longer than 60 s | browser remote-debugging port (+ tunnel on a server) |

Events never arrive through A/B — inject the in-page recorder v2.1 (`scripts/kit/diag-v2.1.js`) before first load, or use C. On C, errors thrown by browser extensions arrive with the page's; the recorder keeps them apart (`ext-exception` / `ext-console`, with the extension's name) and leaves them out of the problem list. C works in a background tab, which silently drops clicks and key presses until it has painted once, so the client takes one small capture before the first input of each document; if that capture fails, the input is refused with an error instead of being lost. C also needs Aside started with three launch flags: `--disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion --enable-features=CDPScreenshotNewSurface`. Without them, captures (and so input) stall while every Aside window is covered or while the window is minimized — measured on the PC and over the tunnel. With them, both kept working in a measured Windows run (the first two for covered windows, the third for a minimized one). On Windows, `launch-flags` checks the running Aside and adds the flags to the Aside shortcuts. A and B are not affected.

## Borrowed tabs · write guard · isolated windows (C, opt-in)
For checking screens that sit on a production API, where opening a new tab is not wanted and data must not change. All of it is off by default, so existing use is unchanged.
- **Borrow a tab** — `cdp <script> --borrow <url-pattern> [--same-window-as <url-pattern>]` attaches to a tab the user already has open (e.g. the app tab in the same window as the chat tab). It is never created, raised or closed. No match ⇒ it asks the person to open one in that window; several ⇒ it lists them and `--borrow-target` picks one. A tab is lent only when the site's config rule has `borrow`, or the user approved it for this run (`--user-approved`). In a borrowed tab `Page.navigate` is allowed, and injected UI (Aside autofill menu, DeepL) stays hidden, including what appears later. At the end the hiding, emulation (width, theme, locale) and write guard are undone and the tab is left open. Right after attaching it sends one read-only command; a tab that does not answer it (seen on a minimized window, cause not confirmed) fails with `tab-unresponsive` and its window state instead of a bare timeout, and the person is asked to restore that window and click the tab once. The tab is not woken, reloaded or raised.
- **Write guard** — `--guard-writes [--allow-write <path>]…`, or the site rule `guardWrites: true` with `writeAllow`. Every request from the borrowed tab that is not GET, HEAD or OPTIONS is failed before it leaves the browser, except the allow-list (keep-alive and token-refresh paths). Blocked and passed requests are listed in the result. Right after it is switched on it POSTs to a path that does not exist and refuses to go on unless that POST was blocked. WebSocket messages and requests a service worker sends by itself are not covered.
- **Isolated window** — `client.openIsolatedWindow(url)` in a script opens a throwaway profile in a new minimized window, so test-account logins and cookies never mix with the user's. `client.setIsolatedCookies` puts cookies into that profile only and never returns their values. The profile is deleted at the end, and also if the connection drops. Capturing a minimized window needs the third launch flag above.
- **Tab list** — `tabs [--match <pattern>] [--same-window-as <pattern>]` reads tabs and window ids only.

A URL pattern without `*` means "origin+path contains this text"; with `*` it must match all of origin+path (query and hash are never looked at). An allowed path starting with `/` matches that path on any origin, a `https://…` entry must match the origin too, and a trailing `*` makes it a prefix.

## Install
1. `claude plugin install browser-check@comonetso`
2. **Private runtime config** at `${CLAUDE_PLUGIN_DATA}/config.json` (mode 0600, parent 0700; Windows has no such mode bits, so the check is skipped there). It is written on first use by `browser-check.mjs setup`, which looks the machine over (Aside CLI, the running Aside's own ports, the tunnel socket, `aside host list`), shows what it put in and never overwrites an existing file. If Aside lists several remote PCs it asks which one; if nothing usable is found it writes nothing and says what a person has to do. Site rules start empty, which means the safe defaults. To write it by hand, see `config/example.json` and `config/schema.json`. Host names, absolute CLI paths, socket paths and per-site login classes live **only** there; nothing private is in this public package.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor` prints the config/capability table. Shells outside the plugin (workflow agents, cron, plain ssh) have no `CLAUDE_PLUGIN_DATA`, so the config is not found (`Config INVALID`); pass `CLAUDE_PLUGIN_DATA=<claude config dir>/plugins/data/browser-check-comonetso` (or `BROWSER_CHECK_CONFIG=<that dir>/config.json`). Apart from writing its own config on first use, the plugin never enables remote control, edits settings or opens tabs to "fix" a missing transport — a human does that.
4. For C from a server without Aside Pro: on the PC run one single-owner `ssh -NT -R <server-unix-socket>:127.0.0.1:<debug-port> …` per server. With Windows Task Scheduler, use a logon trigger plus a trigger repeating every minute and "do not start a new instance": the "restart on failure" setting does not fire once the task is wrapped to hide its window (measured). Server sshd needs `AllowStreamLocalForwarding yes` and `StreamLocalBindUnlink yes`. 🔴 CDP has no authentication — never expose it on a TCP port.

## Safety (full text: `skills/browser_check/SKILL.md` §1)
Own tabs only (except a tab lent by config or the user's approval — see above) · on logged-in sites close a tab **only after in-flight requests reach 0** (closing mid-request revoked the owner's whole session family in a real incident) · one call ≤ 50 s · never touch the Aside autofill menu (it presses the login button by itself) · data mutation only with explicit approval for that exact target · no clipboard, downloads, native pickers, browser shortcuts · never `fromSurface:false` (captures the user's screen) · secrets are neither read nor stored (central redactor) · concurrency 1.

## Layout
```
.claude-plugin/plugin.json     manifest (version required)
hooks/hooks.json               SessionStart — stat-only (config + socket permissions; no browser contact)
skills/browser_check/          SKILL.md + recipes/*.md (10 task recipes)
scripts/browser-check.mjs      entry point: setup (first-run config) · doctor · cdp (optional --borrow · --guard-writes) · tabs (tabs and window ids, read-only) · run (one-shot repl, 50 s guard, lock, @@IMG → files, redaction) · unlock · launch-flags (Windows: does the running Aside have the three flags C needs while its windows are covered or minimized? --apply adds them to the Aside shortcuts, --undo reverts)
scripts/lib/                   setup · config · capabilities (probe order) · policy (5 task classes, CDP allow/deny) · redact · lock
scripts/kit/                   head.js · diag-v2.1.js · webcheck*.js · vitals*.js · perfdiag · emu-lib · responsive-iframe
scripts/image/                 decode · crop · stitch (Pillow optional)
scripts/session/               persistent-session driver · MCP shim
test/                          basic.test.mjs (redaction/policy/config/leak) · cdp-unit.test.mjs (WebSocket framing, CDP client) · setup.test.mjs (first-run config) · launch-flags.test.mjs (Aside launch flags) · borrow.test.mjs (borrowed tabs, write guard, isolated windows) · regress/ (rerun after Aside updates) · unix-bridge.mjs (test-only TCP→socket bridge)
```

`node --test test/basic.test.mjs test/cdp-unit.test.mjs test/setup.test.mjs test/launch-flags.test.mjs test/borrow.test.mjs` needs no browser. The leak check reads its patterns from a local file (`~/.claude/_private/browser_check_leak.txt`, or the path in `BROWSER_CHECK_LEAK_LIST`), one `/regex/flags` per line. The list is kept out of this package because it would publish the very values it guards; without it the check is skipped, not passed.

## Runtime — same features on older Node
- **Zero external packages** (no package.json); Node core modules only. No Node-22-only APIs (global `WebSocket`/`fetch`) — the WebSocket over a Unix socket is implemented in `lib/cdp-ws.mjs` with `net` + `crypto`.
- **Node 18+** (`node:test` needs 18.1+ for the tests only). Measured on **Node 18.20.8, 20.18.0 and 22.22.0**: all unit tests, doctor, run (Aside remote) and cdp (TCP and Unix socket) work (2026-09-26).
- Python 3 + Pillow only for image crop/stitch (optional). doctor reports the command it found — `python3`, `python` or `py -3` — and that is the one to run the scripts with.

## Measured on a Windows PC (2026-09-26 · Aside 1.26.916 · Chrome 153 · Node 22.17)
A and B locally, without Aside Pro: own tab, snapshot refs, click and Korean typing, safe close, first-load injection, CSS rules, device and media emulation undone afterwards · C over loopback TCP: background target, console/network events, command timeout, no tab left behind, right-click after the automatic wake · the daemon refuses a wrong Host header (403), and probing changes no settings · paths with spaces and Korean · doctor without Python · Dark Reader on (warned, then locked in the plugin's tab) and switched off for the site (no warning) · with DeepL's icons turned off, `deepl-*` elements still sit in the page; they are hidden and reported.

## Measured over a real PC → server tunnel (2026-09-26)
C over the reverse-forwarded Unix socket (root, 0600): the example script end to end in about 3 s, right-click included, while the PC's Aside window was on screen · the tunnel, kept by Task Scheduler, came back 54 s after it was cut, with one ssh at a time and no CPU to speak of · `setup` on four Linux servers: a config where Aside and the tunnel are present, `not-ready` with the steps to take where they are not.

## Borrowed tabs, write guard and isolated windows, measured (2026-10-15 · Windows · test Aside profile · Chrome 153)
In a test browser with an anchor tab and an app tab in one window and the same app in another window: refused with no config lending and no approval · attached to the one app tab in the anchor's window · account-creating POST and a beacon blocked, token-refresh POST and GET passed, and the only write that reached the test server was the allowed one · an autofill menu added one second later was hidden, and so was the one on the next page after navigation · close, raise and direct `Fetch` refused · the isolated window opened minimized, could be captured, and only it saw its cookie · afterwards all three tabs were open, width emulation and hiding marks were gone, and no throwaway profile was left.

## Not measured yet — do not assume
Whether an isolated window or a borrowed tab takes focus on the user's real screen (a person has to look) · borrowing over a server tunnel · the tunnel after a reboot (the logon trigger) and over days · lifetime of `_sendToTarget` across Aside updates · recorder v2.1 regression on a real app · recipes run end to end.
