/*
 * `browser-check look <url> [steps…] [options]` — the common check in one line, no script to write:
 * open the page in our own task space → do the steps in the order given → page text, a capture, problems and
 * every non-GET request the page sent → close the space (after 0 requests in flight).
 *
 * The 2026-09/10 records showed agents writing a new script file even to look at one page and digging through the
 * plugin's source for function names (152 reads). This builds the script from the command line instead and runs it
 * through the same path as `run` (prelude, PC or relay). Clicking and typing are allowed here by owner decision
 * (2026-10-21); what they sent is reported in `sent` so a save or a send cannot pass unseen.
 */
import { undoMsysPath } from './guardHints.mjs';

const STEPS = {
  '--click': { do: 'click', n: 1 },
  '--fill': { do: 'fill', n: 2 },
  '--select': { do: 'select', n: 2 },
  '--press': { do: 'press', n: 1 },
  '--wait': { do: 'wait', n: 1 },
  '--wait-ms': { do: 'sleep', n: 1 },
};
const VALUE_OPTS = ['--width', '--name', '--timeout', '--text-max', '--allow-write', '--out'];
const BOOL_OPTS = ['--dark', '--full', '--no-shot', '--guard-writes', '--no-console'];

export const LOOK_USAGE = 'look <url> [--click <selector>] [--fill <selector> <text>] [--select <selector> <value>] [--press <key>] [--wait <selector>] [--wait-ms <ms>] [--width <px>[x<height>]] [--dark] [--full] [--no-shot] [--no-console] [--name <space>] [--guard-writes [--allow-write <path>]…] [--timeout <ms>] [--text-max <chars>]';

// A ref lives until the page changes and every `look` opens the page anew, so a ref from an earlier result never
// resolves ("Unknown ref", measured 2026-11-02) — and on a page whose order changed it could reach the wrong element.
const REF = /^(@\d+|ref=\d+)$/;
const REF_ERROR = (flag, sel) => `${flag} ${sel}: a ref only lives until the page changes, and every \`look\` opens the page anew, so a ref from an earlier result cannot be used. Use the loc=… printed next to it, or text=…; a script (\`browser-check run\`) can read the page and use refs in one go`;

/** args = everything after `look`. Returns { ok, spec } or { ok: false, error }. Steps keep the order they were given in. */
export function parseLook(args) {
  // A fresh space name per run: two agents running `look` at once must not share one space (it is closed at the end).
  const spec = { url: null, steps: [], width: null, height: null, dark: false, full: false, shot: true, noConsole: false, name: 'bc-look-' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0'), guard: false, allow: [], timeout: null, textMax: 4000, out: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (STEPS[a]) {
      const s = STEPS[a]; const vals = args.slice(i + 1, i + 1 + s.n);
      if (vals.length < s.n || vals.some((v) => v === undefined)) return { ok: false, error: `${a} needs ${s.n === 2 ? 'a selector and a value' : 'a value'}` };
      const step = { do: s.do };
      if (s.do === 'click' || s.do === 'wait') step.sel = vals[0];
      else if (s.do === 'fill') { step.sel = vals[0]; step.text = vals[1]; }
      else if (s.do === 'select') { step.sel = vals[0]; step.value = vals[1]; }
      else if (s.do === 'press') step.key = vals[0];
      else if (s.do === 'sleep') { step.ms = Number(vals[0]); if (!(step.ms >= 0 && step.ms <= 60000)) return { ok: false, error: '--wait-ms takes 0-60000' }; }
      if (step.sel && REF.test(step.sel)) return { ok: false, error: REF_ERROR(a, step.sel) };
      spec.steps.push(step); i += s.n; continue;
    }
    if (VALUE_OPTS.includes(a)) {
      const v = args[i + 1]; if (v === undefined) return { ok: false, error: a + ' needs a value' }; i++;
      if (a === '--width') { const m = /^(\d{2,5})(?:x(\d{2,5}))?$/.exec(v); if (!m) return { ok: false, error: '--width takes <px> or <px>x<height>, e.g. 390 or 390x700' }; spec.width = Number(m[1]); spec.height = m[2] ? Number(m[2]) : 844; }
      else if (a === '--name') { if (!/^[\w.-]{1,40}$/.test(v)) return { ok: false, error: '--name: letters, digits, . _ - (up to 40)' }; spec.name = v; }
      else if (a === '--timeout') spec.timeout = Number(v);
      else if (a === '--text-max') spec.textMax = Math.max(200, Math.min(200000, Number(v) || 4000));
      else if (a === '--allow-write') spec.allow.push(undoMsysPath(v));   // Git Bash may have rewritten it (10-21)
      else if (a === '--out') spec.out = v;
      continue;
    }
    if (BOOL_OPTS.includes(a)) {
      if (a === '--dark') spec.dark = true; else if (a === '--full') spec.full = true; else if (a === '--no-shot') spec.shot = false; else if (a === '--guard-writes') spec.guard = true; else if (a === '--no-console') spec.noConsole = true;
      continue;
    }
    if (a.startsWith('--')) return { ok: false, error: 'unknown option ' + a };
    if (spec.url) return { ok: false, error: 'one URL only (got "' + spec.url + '" and "' + a + '")' };
    spec.url = a;
  }
  if (!spec.url) return { ok: false, error: 'no URL' };
  try { const u = new URL(spec.url); if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'only http(s) URLs' }; } catch { return { ok: false, error: 'not a URL: ' + spec.url }; }
  if (spec.allow.length && !spec.guard) return { ok: false, error: '--allow-write needs --guard-writes' };
  return { ok: true, spec };
}

/** The script `look` runs: plain browser_check script (uses bc.* from the prelude), the spec embedded as JSON. */
export function buildLookScript(spec) {
  const s = { steps: spec.steps, width: spec.width, height: spec.height, dark: spec.dark, full: spec.full, shot: spec.shot, name: spec.name, textMax: spec.textMax };
  return `// generated by \`browser-check look\`
const __look = ${JSON.stringify(s)};
const __r = await bc.run(__look.name, async ({ task, page }) => {
  await bc.watch(page);
  if (__look.width) await bc.setWidth(page, __look.width, __look.height);
  if (__look.dark) await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, { timeout: 5000 });
  try {
    await page.goto(bc.url); await page.waitForLoadState();
    // Page zoom is kept per site, so the correction is made again for the site now open.
    if (__look.width) await bc.setWidth(page, __look.width, __look.height);
    const steps = []; const known = new Set();
    for (const st of __look.steps) {
      const t0 = Date.now(); const at = await bc.mark(page); const item = { ...st };
      if (item.text !== undefined) item.text = item.text.length > 40 ? item.text.slice(0, 40) + '…' : item.text;
      try {
        if (st.do === 'click') await page.click(st.sel);
        else if (st.do === 'fill') await page.fill(st.sel, st.text, { clearFirst: true });
        else if (st.do === 'select') await page.selectOption(st.sel, st.value);
        else if (st.do === 'press') await page.keyboard.press(st.key);
        else if (st.do === 'wait') await page.waitForSelector(st.sel, { timeout: 15000 });
        else if (st.do === 'sleep') await page.waitForTimeout(st.ms);
        if (st.do !== 'wait' && st.do !== 'sleep') await page.waitForTimeout(400);
        item.ok = true;
      } catch (e) { if (e && e.code === 'BC_DEADLINE') throw e; item.ok = false; item.error = String(e && e.message || e).slice(0, 300); if (e && e.code) item.kind = e.code; }
      // A JavaScript dialog the step opened is closed with "dismiss" — accepting one is a decision for a script.
      try { const inf = await page.info(); if (inf && inf.dialog) { item.dialog = inf.dialog; item.dialogDismissed = await page.dismissDialog(); } } catch { /* no info */ }
      // A window the step opened: guarded and recorded now (the page action may already have done it from its receipt).
      await bc.popups(task);
      const opened = (await bc.otherPages(task, page)).filter((p) => !known.has(p.label));
      if (opened.length) { item.opened = opened.map((p) => p.label); for (const p of opened) known.add(p.label); }
      item.ms = Date.now() - t0; item.sent = await bc.sent(page, { since: at });
      steps.push(item);
      if (!item.ok) break;
    }
    if (__look.steps.length) await bc.settle(page, 8000);
    const inf = await page.info();
    bc.out('PAGE', { url: inf.url, title: inf.title, viewport: { w: inf.w, h: inf.h }, page: { w: inf.pw, h: inf.ph } });
    bc.out('STEPS', steps);
    const text = await page.snapshot(__look.full ? { scope: 'full_page' } : undefined);
    bc.img('text.txt', Buffer.from(String(text), 'utf8'));
    // ego 0.6.2 ends a viewport snapshot with a line saying content goes on below it — keep it even when the text is cut.
    const more = /\\[more content below the viewport[^\\]]*\\]/.exec(String(text));
    bc.out('TEXT', { chars: String(text).length, head: String(text).slice(0, __look.textMax), cut: String(text).length > __look.textMax, more: more ? more[0] : null });
    if (__look.shot) bc.out('SHOT', await bc.shot(page, 'look', { fullPage: __look.full }));
    bc.out('PROBLEMS', await bc.problems(page));
    // Every window a step opened: where it went, its text and capture, what it sent. These windows close with the space.
    await bc.popups(task);
    const windows = [];
    for (const p of await bc.otherPages(task, page)) {
      const x = { label: p.label };
      try {
        await p.waitForLoadState();
        await bc.settle(p, 8000);
        const i = await p.info(); x.url = i.url; x.title = i.title;
        bc.img('popup-' + p.label + '.txt', Buffer.from(String(await p.snapshot()), 'utf8'));
        if (__look.shot) x.shot = await bc.shot(p, 'popup-' + p.label);
        const q = await bc.problems(p); x.problems = q.summary; x.consoleState = q.consoleState;
        x.sent = await bc.sent(p);
        const early = await bc.beforeGuard(p); if (early.length) x.beforeGuard = early;
      } catch (e) { x.error = String(e && e.message || e).slice(0, 200); }
      windows.push(x);
    }
    if (windows.length) bc.out('POPUPS', windows);
    const sent = await bc.sent(page);
    for (const x of windows) for (const s of x.sent || []) sent.push({ ...s, page: x.label });
    bc.out('SENT', sent);
  } finally {
    if (__look.width) { try { await page.cdp('Emulation.clearDeviceMetricsOverride', {}, { timeout: 5000 }); } catch { /* page gone */ } }
  }
});
bc.out('CLOSED', __r.closed);
`;
}

/** What a reader of this result must not miss. */
export function lookHints({ steps = [], windows = [], text = null, shot = null } = {}) {
  const hints = [];
  const failed = steps.findIndex((s) => s && s.ok === false);
  if (failed >= 0) {
    const s = steps[failed];
    const err = String(s.error || '');
    const fix = /matched 0 elements/.test(err) ? ' — nothing matches that selector: if the element appears late put --wait <selector> before this step (ego stops waiting early on an idle page), and compare it with the page text'
      : /matched [2-9]\d* elements|matched \d\d+ elements/.test(err) ? ' — a selector must match exactly one element: narrow it, use text="exact words", or add >> nth=0'
        : '';
    hints.push(`step ${failed + 1} (--${s.do === 'sleep' ? 'wait-ms' : s.do}${s.sel ? ' ' + s.sel : ''}) failed: ${err}${fix}. The steps after it did not run; the page text and capture show where it stopped`);
  }
  for (const x of windows) {
    hints.push(`a step opened a new window (${x.label}${x.url ? ' ' + x.url : ''}): see popups[] for its text, capture, problems and sent. page, text and image are still the first page; to act inside the window use a script — task.page('${x.label}')`);
    if (x.beforeGuard && x.beforeGuard.length) hints.push(`the write guard reached window ${x.label} only after it had started loading: ${x.beforeGuard.length} request(s) went out first and may have written (the page's record has no method) — ${x.beforeGuard.slice(0, 3).join(', ')}${x.beforeGuard.length > 3 ? ' …' : ''}. Report this; they were not blocked`);
  }
  if (text && text.more) hints.push(`the page continues below the viewport ${text.more} — add --full to read all of it`);
  const full = shot && shot.fullPage;
  if (full && full.note) hints.push('--full: ' + full.note);
  else if (full && full.whole === false) hints.push(`--full: the capture stops at ${full.height} of ${full.pageHeight} CSS px`);
  return hints;
}

/** Shape the runner's result for reading: one object per kind instead of the raw @@OUT arrays. */
export function shapeLook(res) {
  const one = (k) => (res.outs && res.outs[k] ? res.outs[k][res.outs[k].length - 1] : null);
  const images = res.images || [];
  const text = one('TEXT');
  const p = one('PROBLEMS');
  const steps = one('STEPS') || [];
  const shot = one('SHOT');
  const file = (re) => images.find((f) => re.test(f)) || null;
  const windows = (one('POPUPS') || []).map((x) => ({ ...x, textFile: file(new RegExp(`popup-${x.label}\\.txt$`)), image: file(new RegExp(`popup-${x.label}\\.png$`)) }));
  return {
    // A step that failed is not an "ok" run: agents read the status and the exit code before the steps.
    status: res.status === 'ok' && steps.some((s) => s && s.ok === false) ? 'step-failed' : res.status,
    where: res.where, ms: res.ms,
    page: one('PAGE'),
    steps,
    text: text ? text.head : null,
    textCut: text ? text.cut : null,
    textMore: (text && text.more) || undefined,
    textFile: file(/[\\/]text\.txt$|^text\.txt$/),
    shot,
    image: file(/[\\/]look\.png$|^look\.png$/),
    problems: p ? { summary: p.summary, consoleState: p.consoleState, console: p.console, exceptions: p.exceptions, log: p.log, failed: p.failed, http: p.http } : null,
    popups: windows.length ? windows : undefined,
    sent: one('SENT') || [],
    closed: one('CLOSED'), leftOpen: res.leftOpen, guard: res.guard, guardBlocked: one('GUARD_BLOCKED'),
    hints: [...(res.hints || []), ...lookHints({ steps, windows, text, shot })], out: res.out,
    tail: res.status === 'ok' ? undefined : res.tail,
  };
}
