# android-check — Claude taps, looks at, reads the logcat of, and fixes a real Android device

No more debugging by pasted screenshots. Claude Code finds an element on a real device (or emulator) **by name and taps it**, **captures the screen** at the same moment, **cuts the logcat of that moment for that app only** — marking errors, frame-skip warnings and **whether the touch reached the app** — and **measures the response time**. After a fix it **drives the app run itself** (Flutter hot reload · native reinstall) and repeats the same action. When a flow needs judgement over several steps, it explores with the ARTEMIS MCP.

- Targets: **Flutter apps** (Semantics → `content-desc`) and **native apps** (View `text`·`resource-id`, Compose `testTag`)
- Trigger: Korean natural language — "폰 화면 봐", "눌러 봐", "로그캣 봐", "반응 속도 재 봐", "앱 테스트해", "앱 디버깅해", "핫 리로드 해", "아르테미스로 해" (speech-to-text variants included)
- Invocation name: `android-check:android_check`

## Three layers
| Layer | What | When | Measured |
|---|---|---|---|
| Look | `screenshot` · `elements` | the screen now | capture 0.40 s · hierarchy 2.4 s |
| Measure + log | `tap "<name>" --measure --log --package P --shot f.png` | tap and see result, log, response | 2–4 s per action |
| Explore + operate | ARTEMIS `mobile_run_task` | multi-step judgement, whole-screen sweeps | ~7 s and ~31k Gemini tokens per item |

## Install
1. `claude plugin install android-check@comonetso`
2. **adb** (Android platform-tools) is required. Only response-time measurement needs **Python 3 + Pillow** (without it, just that feature is missing).
3. On first use `android_check.py setup` inspects this machine and writes the **private config** `${CLAUDE_PLUGIN_DATA}/config.json` — adb path, ARTEMIS location (read from the MCP registered in Claude Code), a Python with Pillow. It never overwrites an existing file. Personal values such as device serials, display ids and app paths live **only there** (never in the public repository). Example: `config/example.json`.
4. `android_check.py doctor` — checks connection, lock screen, **mirroring black-screen window**, displays, adb version match, ARTEMIS, Pillow and the log collector. It changes nothing.
5. To let it drive an app run, register each app once: `app register --package P --type flutter --project-dir D --run-args "--flavor dev"` (native: `--type native --install-task :app:installDebug`).

### ARTEMIS (optional — exploration and sweeps)
- Install ARTEMIS (Google's Android automation) and register it with `uv run artemis mcp --install claude`. The AI key (Gemini by default) goes into ARTEMIS's `.env` by hand.
- **Use one adb** — set `ARTEMIS_ADB_PATH` and `ADB` (read by scrcpy) in ARTEMIS's `.env` to the adb this plugin uses. adb binaries of different versions restart each other's server and drop connections (measured: 34 / scrcpy-bundled 37 / ARTEMIS-bundled 36).
- **Windows: if CMD windows keep flashing**, copy `extras/artemis_sitecustomize.py` to ARTEMIS's `.venv/Lib/site-packages/sitecustomize.py`. It leaves ARTEMIS untouched and runs external programs without a console window. Put it back if the venv is recreated.
- ARTEMIS can't find a winget-installed scrcpy → set `ARTEMIS_SCRCPY_PATH` in `.env`.

## 🔴 Must know (full text in `skills/android_check/SKILL.md`)
- **Screen mirroring steals every tap** — when Samsung Flow Smart View or Link to Windows lays a black-screen window over the phone, capture works but taps do nothing. Smart View: toolbar "휴대전화 화면" (phone screen) on; Link to Windows: Settings → Phone screen → hide the phone screen while connected: off. `tap --log` reports "touch did not reach the app" right away.
- A locked phone makes ARTEMIS reject tasks · the device keeps only 1–2 minutes of logcat, so `logwatch start` before long tests · put state back (toggle twice, restore values, `rotate restore`) · never run a second app run over someone's `flutter run`.

## Layout
```
.claude-plugin/plugin.json        manifest
hooks/hooks.json                  SessionStart — file existence only (no device or network contact)
skills/android_check/SKILL.md     triggers · rules · debug loop · report format
scripts/android_check.py          entry: setup · doctor · elements · tap · back · rotate · screenshot · logwatch · app · (runner)
config/example.json               private config example
extras/artemis_sitecustomize.py   hide ARTEMIS's CMD windows on Windows
test/test_android_check.py        device-free unit tests (element parsing · error/warning patterns · log filtering · touch verdict · secrets never kept)
```
`python -m unittest discover -s test` — no external packages.

## Measured (2026-10-04 · Galaxy Z Flip6 · Android 16 · wireless adb · debug builds)
Command arrival 0.15 s · first screen change within 0.61 s (an upper bound at a 0.4 s capture interval) · animation settled 1.41 s · server round trip 67 ms from the app log · only the first menu open after a cold start took 1.5 s (`Skipped 67 frames` in the log, 0.8 s afterwards) · caught a broken layout with 0 log errors (scrollable area) from the capture · ARTEMIS swept 23 menu items in 166 s.

- **Flutter app run** (`flutter run --machine`): `app start` 25 s until the app is up · `app reload` (hot reload) 1.2 s · `app stop` 0.26 s.
- **Pure native app** (Kotlin, View): found and tapped by `text` with the touch confirmed in the app's own log, first change 0.76–0.88 s, 0 error lines · `app reload` (Gradle install + relaunch) 120 s on the first build, 22 s after. Native screens inside the Flutter app (home launcher, weather widget) were tapped by `text`/`resource-id` as well.

## Not measured yet (don't assume)
Compose apps · emulators · macOS/Linux hosts · precise response timing (`screenrecord` + show-touches). Background: the measurement log and the standard (kept separately).
