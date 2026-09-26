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

Events never arrive through A/B — inject the in-page recorder v2.1 (`scripts/kit/diag-v2.1.js`) before first load, or use C. On C, errors thrown by browser extensions arrive with the page's; the recorder keeps them apart (`ext-exception` / `ext-console`, with the extension's name) and leaves them out of the problem list. C works in a background tab, which silently drops clicks and key presses until it has painted once, so the client takes one small capture before the first input of each document; if that capture fails, the input is refused with an error instead of being lost. C also needs the PC's Aside window on screen: while other windows cover it the browser stops painting, and captures (and so input) stall — measured on the PC and over the tunnel. A and B are not affected.

## Install
1. `claude plugin install browser-check@comonetso`
2. **Private runtime config** at `${CLAUDE_PLUGIN_DATA}/config.json` (mode 0600, parent 0700; Windows has no such mode bits, so the check is skipped there). It is written on first use by `browser-check.mjs setup`, which looks the machine over (Aside CLI, the running Aside's own ports, the tunnel socket, `aside host list`), shows what it put in and never overwrites an existing file. If Aside lists several remote PCs it asks which one; if nothing usable is found it writes nothing and says what a person has to do. Site rules start empty, which means the safe defaults. To write it by hand, see `config/example.json` and `config/schema.json`. Host names, absolute CLI paths, socket paths and per-site login classes live **only** there; nothing private is in this public package.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor` prints the config/capability table. Apart from writing its own config on first use, the plugin never enables remote control, edits settings or opens tabs to "fix" a missing transport — a human does that.
4. For C from a server without Aside Pro: on the PC run one single-owner `ssh -NT -R <server-unix-socket>:127.0.0.1:<debug-port> …` per server. With Windows Task Scheduler, use a logon trigger plus a trigger repeating every minute and "do not start a new instance": the "restart on failure" setting does not fire once the task is wrapped to hide its window (measured). Server sshd needs `AllowStreamLocalForwarding yes` and `StreamLocalBindUnlink yes`. 🔴 CDP has no authentication — never expose it on a TCP port.

## Safety (full text: `skills/browser_check/SKILL.md` §1)
Own tabs only · on logged-in sites close a tab **only after in-flight requests reach 0** (closing mid-request revoked the owner's whole session family in a real incident) · one call ≤ 50 s · never touch the Aside autofill menu (it presses the login button by itself) · data mutation only with explicit approval for that exact target · no clipboard, downloads, native pickers, browser shortcuts · never `fromSurface:false` (captures the user's screen) · secrets are neither read nor stored (central redactor) · concurrency 1.

## Layout
```
.claude-plugin/plugin.json     manifest (version required)
hooks/hooks.json               SessionStart — stat-only (config + socket permissions; no browser contact)
skills/browser_check/          SKILL.md + recipes/*.md (10 task recipes)
scripts/browser-check.mjs      entry point: setup (first-run config) · doctor · cdp · run (one-shot repl, 50 s guard, lock, @@IMG → files, redaction) · unlock
scripts/lib/                   setup · config · capabilities (probe order) · policy (5 task classes, CDP allow/deny) · redact · lock
scripts/kit/                   head.js · diag-v2.1.js · webcheck*.js · vitals*.js · perfdiag · emu-lib · responsive-iframe
scripts/image/                 decode · crop · stitch (Pillow optional)
scripts/session/               persistent-session driver · MCP shim
test/                          basic.test.mjs (redaction/policy/config/leak) · cdp-unit.test.mjs (WebSocket framing, CDP client) · setup.test.mjs (first-run config) · regress/ (rerun after Aside updates) · unix-bridge.mjs (test-only TCP→socket bridge)
```

`node --test test/basic.test.mjs test/cdp-unit.test.mjs test/setup.test.mjs` needs no browser. The leak check reads its patterns from a local file (`~/.claude/_private/browser_check_leak.txt`, or the path in `BROWSER_CHECK_LEAK_LIST`), one `/regex/flags` per line. The list is kept out of this package because it would publish the very values it guards; without it the check is skipped, not passed.

## Runtime — same features on older Node
- **Zero external packages** (no package.json); Node core modules only. No Node-22-only APIs (global `WebSocket`/`fetch`) — the WebSocket over a Unix socket is implemented in `lib/cdp-ws.mjs` with `net` + `crypto`.
- **Node 18+** (`node:test` needs 18.1+ for the tests only). Measured on **Node 18.20.8, 20.18.0 and 22.22.0**: all unit tests, doctor, run (Aside remote) and cdp (TCP and Unix socket) work (2026-09-26).
- Python 3 + Pillow only for image crop/stitch (optional). doctor reports the command it found — `python3`, `python` or `py -3` — and that is the one to run the scripts with.

## Measured on a Windows PC (2026-09-26 · Aside 1.26.916 · Chrome 153 · Node 22.17)
A and B locally, without Aside Pro: own tab, snapshot refs, click and Korean typing, safe close, first-load injection, CSS rules, device and media emulation undone afterwards · C over loopback TCP: background target, console/network events, command timeout, no tab left behind, right-click after the automatic wake · the daemon refuses a wrong Host header (403), and probing changes no settings · paths with spaces and Korean · doctor without Python · Dark Reader on (warned, then locked in the plugin's tab) and switched off for the site (no warning) · with DeepL's icons turned off, `deepl-*` elements still sit in the page; they are hidden and reported.

## Measured over a real PC → server tunnel (2026-09-26)
C over the reverse-forwarded Unix socket (root, 0600): the example script end to end in about 3 s, right-click included, while the PC's Aside window was on screen · the tunnel, kept by Task Scheduler, came back 54 s after it was cut, with one ssh at a time and no CPU to speak of · `setup` on four Linux servers: a config where Aside and the tunnel are present, `not-ready` with the steps to take where they are not.

## Not measured yet — do not assume
The tunnel after a reboot (the logon trigger) and over days · lifetime of `_sendToTarget` across Aside updates · recorder v2.1 regression on a real app · recipes run end to end.
