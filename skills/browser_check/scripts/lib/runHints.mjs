// Result hints about the run itself: an ego update, a stop ego asked for, a limit reached, errors that could not be seen.
// ego's error codes are its durable contract — its messages can change between builds (ego-errors.ts) — so codes are
// what is matched here. Hints are the part of a result that gets read, so each one says what to do next.

const CODE_HINTS = [
  ['EGO_TASK_SPACE_USER_IN_CONTROL', 'the user has taken this task space over — stop here and report; do not retry and do not claim it back (EGO_TASK_SPACE_USER_IN_CONTROL)'],
  ['EGO_TASK_SPACE_INACTIVE', 'this task space has ended, through task.finish() or by the user — a hard stop: do not retry and do not take it back (EGO_TASK_SPACE_INACTIVE)'],
  ['EGO_PAGE_UNRESPONSIVE', "the page did not answer: a navigation that never committed, or a hung tab (EGO_PAGE_UNRESPONSIVE) — try page.cdp('Page.stopLoading') or task.newPage() in the same space, not a new space"],
  ['EGO_PAGE_DIALOG_OPENED', 'a JavaScript dialog is blocking the page (EGO_PAGE_DIALOG_OPENED) — page.dismissDialog(); page.acceptDialog() only if accepting was approved'],
  ['EGO_PAGE_BUDGET_REACHED', 'this task space has reached its page limit (EGO_PAGE_BUDGET_REACHED) — close pages you no longer need with page.close()'],
  ['EGO_FILE_CHOOSER_OPENED', 'a click opened a file chooser, which ego cancelled (EGO_FILE_CHOOSER_OPENED) — use setInputFiles, or page.waitForFileChooser() before the click when the input is created on the fly'],
];

/**
 * text    everything the run printed, plus the step errors
 * status  ok · script-error · timeout · transport-error
 * outs    the script's outputs (PROBLEMS)
 */
export function runHints({ text = '', status = 'ok', outs = {} } = {}) {
  const hints = [];
  if (/\[ego-browser:notice\]/.test(text)) hints.push('an ego lite update is available — tell the user; run `ego-browser upgrade` only with their approval');
  for (const [code, hint] of CODE_HINTS) if (text.includes(code)) hints.push(hint);
  if (text.includes('BC_DEADLINE')) hints.push('the run reached its time limit and stopped itself before its next browser call — give it more with --timeout (up to 30 min) or split the work');
  if (status === 'timeout') hints.push('the caller gave up at the time limit, but ego keeps a script running after its caller has gone (all scripts share one process inside ego): it stops itself at its next browser call, so do not assume it has already stopped, and a space it held may still be open');
  const states = new Set((Array.isArray(outs.PROBLEMS) ? outs.PROBLEMS : []).flat().map((p) => p && p.consoleState));
  if (states.has('blind')) hints.push('console messages are not reaching this tool in this ego, so console errors and exceptions are NOT known (null in summary, not 0) — do not report the page as free of them; failed requests and 4xx/5xx are still real');
  if (states.has('hidden')) hints.push('--no-console: console errors and exceptions were not collected (null in summary, not 0)');
  return hints;
}

/** "ego-browser 0.6.1.13" and the version folders next to it → the newest folder above the running version, or null. */
export function newerVersion(versionLine, folders) {
  const m = /(\d+(?:\.\d+)+)/.exec(String(versionLine || ''));
  if (!m) return null;
  const parse = (v) => v.split('.').map(Number);
  const above = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0; } return false; };
  const cur = parse(m[1]);
  let best = null;
  for (const f of folders || []) if (/^\d+(\.\d+)+$/.test(f) && above(parse(f), best ? parse(best) : cur)) best = f;
  return best;
}
