---
name: android_check
description: Tap, look at, read the logcat of, measure and debug a real Android device or emulator — Flutter apps and native (View/Compose) apps. Taps an element by name and in the same step captures the screen, cuts the logcat of that moment for the app process (errors and frame-skip warnings marked) and measures the response time; drives the app run itself (Flutter hot reload / native reinstall) so a fix can be checked without a human; explores multi-step flows with the ARTEMIS MCP. Use whenever the real device behaviour must be seen, not for source alone. Korean triggers (incl. speech-to-text variants): "폰 화면 봐/휴대폰 화면 봐/기기 화면 봐/에뮬레이터 화면", "눌러 봐/클릭해 봐/탭해 봐/눌러서 확인", "로그캣 봐/로그켓 봐/로켓 봐/로그 같이 봐", "반응 속도 재 봐/느린지 봐/반응 시간", "앱 테스트해/다 눌러 봐/전수 시험", "앱 디버깅해/오류 잡아/화면 틀어진 거 고쳐", "핫 리로드 해/다시 띄워/재설치", "아르테미스/알테미스로 해".
---

# android_check — tap, look, read the logcat, measure, fix, re-check

> Why: debugging only works when four links turn together — **tap → see the screen → read the logcat of that moment → fix and re-check**. A human pasting screenshots breaks the loop. Every rule below comes from measurement on a real device (2026-10-04, a Flutter app with native screens inside and a pure native Kotlin/View app, Galaxy Z Flip6 over wireless adb). Where a manual and a measurement disagree, follow the measurement.

Language: talk to the user in the user's language, report labels in §6 included.

Run the tool as `python "${CLAUDE_PLUGIN_ROOT}/scripts/android_check.py" <cmd> --data-dir "${CLAUDE_PLUGIN_DATA}"` (below: `ac <cmd>`).

## 0. Start — every time, in order
1. `ac doctor` — config, adb, device, lock screen, mirroring black-screen window, displays, adb version match, ARTEMIS, Pillow, log collector. **It changes nothing.**
   - No config ⇒ `ac setup` first. It finds adb, the ARTEMIS location (from Claude Code's MCP registration) and a Python with Pillow, writes the private config and shows what it set. It never overwrites an existing config.
   - `blocked` ⇒ relay the `→` fix lines (most are human tasks, §8) and stop.
2. Several devices ⇒ **ask the user which one** (`--serial`); don't pick.
3. A test longer than a minute or two ⇒ `ac logwatch start` first. The device keeps only 1–2 minutes of logcat — measured: a whole test's logs were gone when looked for afterwards.
4. Before tapping anything that changes data or state, know how you will put it back (§1).

## 1. 🔴 Hard rules
- **A full-screen mirroring "black screen" window steals every tap** (Samsung Flow Smart View `…galaxycontinuity…blackscreen.smartview`, Link to Windows `…mdx…blackscreen`). Symptom: capture and element reading work, taps do nothing; logcat `InputDispatcher: Delivering touch to … '<that window>'`. Only the user can fix it (§8). Do not hunt for workarounds.
- **Locked device ⇒ ARTEMIS rejects tasks** with only "Failed to enqueue … rejected or timed out". Run `mobile_diagnose` to see "Device Locked"; unlocking is human.
- **Put state back.** Toggles: tap twice. Values: change, verify, set the original back. Device settings (rotation): `ac rotate restore`. Compare an app state dump before and after; only time-like values may differ.
- **What to tap**: inside a flow the user explicitly runs with you, tap its buttons (including state-changing ones). In a plain check, name the buttons ARTEMIS must not touch — measured: after a first tap seemed to fail, it tapped the neighbouring button.
- **Do not run a second app run over the user's.** If the app is already running from someone's `flutter run`, `ac app start` refuses; ask for `r` in that window or have it closed, then `--force`.
- **Never read or print secrets.** `doctor` reports only key *names* in the ARTEMIS `.env`.
- Shell commands to the device go as **one string** (`adb shell "date '+%m-%d %H:%M'"`). Split arguments lose their spaces on the device — measured: the timestamp came back empty and every "logs since" read returned 0 lines.

## 2. Pick the layer
| Need | Layer | Cost (measured) |
|---|---|---|
| "What is on screen now?" | `ac screenshot f.png` · `ac elements` | 0.40 s · 2.4 s |
| Tap and see the result + the logcat of that moment + response time | `ac tap "<name>" --measure --log --package <pkg> --shot f.png` | 2–4 s per action |
| Judge-as-you-go multi-step flows, whole-screen sweeps | ARTEMIS `mobile_run_task` (§5) | ~7 s and ~31k Gemini tokens per item |

Never measure app response time with ARTEMIS — its own reasoning adds 1.5 s+ per step.

## 3. The debug loop (one action)
```
ac tap "<name>" --measure --log --package P --shot s.png
  → read s.png (layout, clipping, overlap) + 🔴 errors / 🟡 frame-skip warnings
  → find the code location → fix
  → ac app reload --package P   (Flutter hot reload; native: reinstall + relaunch)
  → repeat the same tap and compare
```
- Look at **both** the screen and the log. Measured: a layout broke (text pushed off-screen, a dark strip) with **0 error lines**, because the area was scrollable. And the reverse: a 1.5 s first response was explained only by `Skipped 67 frames` in the log (first open after a cold start; later opens 0.8 s, no warning).
- App run: register once — `ac app register --package P --type flutter --project-dir D --run-args "--flavor dev"` (or `--type native --install-task :app:installDebug`) — then `ac app start|reload|restart|stop|status|log`.
- Re-draw cost (measured): Flutter `app start` 25 s, hot reload 1.2 s, stop 0.26 s · native reinstall + relaunch 120 s on the first Gradle build, 22 s after. Run a native reload in the background and say it takes a while.

## 4. Request → command
| The user asks to… | Do |
|---|---|
| look at the screen | `ac screenshot` + read it; `ac elements` for names and positions |
| tap / press something | `ac tap "<name>"` (name from `elements`; `x,y` only as fallback) |
| see the logcat | `ac tap … --log --package P` for one action; `ac logwatch read --package P --errors` for a session |
| check speed | `ac tap … --measure` ×3 (first run after a cold start is slower — report it apart) |
| test everything / a whole flow | ARTEMIS Flash per area (§5), state put back, then a report |
| fix what's broken | §3 loop |
| check another orientation | `ac rotate landscape` … `ac rotate restore` (skip if the user works portrait-only) |

## 5. ARTEMIS tasks
- Before the first task: `mobile_diagnose` must say `ready` (add `verify_credentials`/`probe_device` once per session).
- Model: Flash for deterministic UI paths; Pro for long, branching, log/ADB diagnostics, checkpoints or a written report.
- Task text: target package (`locked_app_package`) · start screen · steps · **put-back rules** · **forbidden buttons by name and position** · result table (`expected_output_desc`).
- Poll `mobile_manage_task status` every minute. If turns climb without progress, `mobile_inspect_trace view_summary` and steer or stop.
- `status.result` often comes back `null` — read the `report_task_status` line in `traces/<id>/stdout.log`. Visual evidence: `view_step_screenshots` (before · red-target overlay of the tap · after).

## 6. Report format (labels in the user's language)
```
[Target] device · app package · build (debug/release) · orientation
[Conditions] mirroring off? · lock off? · log collector on? · display used
[Results] action | screen verdict (capture file) | response (sent / first change / settled) | log (🔴 errors · 🟡 warnings, lines)
[Fixes] code location · change · re-check result
[Not checked] why, and what a person must do
[Left behind] state diff before/after (only time-like values) · settings restored
```
Always say the response numbers are a **debug build** and that "first change" is an upper bound (capture interval ≈ 0.4 s).

## 7. Flutter vs native
| | Flutter | Native View | Compose |
|---|---|---|---|
| Element name | Semantics → `content-desc` | `text` · `resource-id` | `testTag` (with `testTagsAsResourceId`) · `contentDescription` |
| Log errors | `EXCEPTION CAUGHT BY` · `RenderFlex overflowed` · `Unhandled Exception` | `FATAL EXCEPTION` · `AndroidRuntime` · `ANR in` | as native |
| Re-draw after a fix | hot reload / hot restart | rebuild + reinstall + relaunch | same as native |

## 8. Only a person can do these — hand them over, don't ask twice
Unlock the device · allow USB debugging · turn off the mirroring app's screen hiding (Samsung Flow Smart View: toolbar "휴대전화 화면" on · Link to Windows: Settings → Phone screen → hide the phone screen while connected: off) · fold/unfold, cables · passwords and payments · design judgement · release decisions.
