# "Test this feature's whole flow" · "Run it from start to finish"

Prerequisite: SKILL.md §0–§2.

## Steps
1. **Plan first**: the step list · the expected result of each step · **which steps change data** → approval (test account, test data and how to clean up included).
2. One task space for the whole flow, resumed by name across runs (`taskSpace('flow-orders')` — tabs and pages survive between runs, variables don't). For a long flow use `bc.run` in the final run only; in the earlier runs call `bc.prep(page)` once and end each run with a snapshot so the next run starts from it.
3. Each step: `__diag.mark(step)` (recorder injected before the first `goto`) → action → wait for its expected state → a new snapshot → `bc.problems(page)` / `dump({ since })` → `bc.shot` if needed. Follow the input rules in action.md. A run may take minutes (default limit 300 s, `--timeout` for more), but keep each `page.evaluate` bounded.
4. Move between screens with SPA link clicks or `pushState` (no token rotation). Read the URL with `page.evaluate(() => location.href)`.
5. Clean up: delete the data created (within the approval) · revert emulation (width/media/CPU) · the final `bc.run`/`bc.finish` settles and closes the space — confirm `CLOSED` in the result, or report `leftOpen`.

## Verdict
Expected = actual at every step · 0 errors and failed requests · other pages in sync (where it applies).

## Report
Step table (`action · expected · actual · evidence (snapshot · rid · capture)`) + defects found + cleanup confirmed.
