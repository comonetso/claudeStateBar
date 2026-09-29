# "Test this feature's whole flow" · "Run it from start to finish"

Prerequisite: SKILL.md §0–§2.

## Steps
1. **Plan first**: the step list · the expected result of each step · **which steps change data** → approval (test account, test data and how to clean up included).
2. Setup: persistent session (`session/drv.py`; not on Windows — SKILL.md §3) · send `kit/head.js` as the first line (`K` stays on globalThis) · recorder v2.1 for logged-in apps · `K.prep` · `K.wake`.
3. Each step: `__diag.mark(step)` → action → a snapshot with the same options + `diff` → `dump({since})` → `K.img` if needed. Follow the input rules in action.md. **≤ 50 s per line** (a 60 s cut kills the persistent session too — session, tabs and variables are all lost).
4. Move between screens with SPA link clicks or `pushState` (no rotation). Read the URL with `K.href`.
5. Clean up: delete the data created (within the approval) · revert emulation (width/media/CPU) · `K.safeClose` · confirm 0 own tabs in `listBrowserTabs()` (count by the opened tabs' `targetId`).

## Verdict
Expected = actual at every step · 0 errors and failed requests · other tabs in sync (where it applies).

## Report
Step table (`action · expected · actual · evidence (diff · rid · capture)`) + defects found + cleanup confirmed.
