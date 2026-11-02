// Real check of the 2026-11-02 fixes in ego itself. Writes nothing to any site except one POST to example.org, sent on
// purpose from a window with the guard on (it must be refused, so it never leaves the page).
//   browser-check run test/ego-real-261102.mjs --timeout 180000 --guard-writes
// A plain line for each check: bc.out('CHECK', { name, ok, ... }). Pass `--url simulate` to switch ego's console hiding on
// by hand first, which is what a browser with SDK v2.2 does by itself (it lets an older ego show the new behaviour).
const simulate = bc.url === 'simulate';
const check = (name, ok, extra) => bc.out('CHECK', { name, ok: !!ok, ...(extra || {}) });
const maybeHide = async (page) => { if (simulate) await page.cdp('egoAutomated.enable'); };

// 1. Console, exceptions and the guard's record across a move, with the hiding on when this ego (or `simulate`) has it.
let r = await bc.run('bc-real-console', async ({ page }) => {
  await maybeHide(page);
  await bc.watch(page);
  await page.goto('https://example.com'); await page.waitForLoadState();
  await page.evaluate(() => {
    console.error('BC_REAL_console_error');
    setTimeout(() => { throw new Error('BC_REAL_uncaught'); }, 0);
    fetch('/__bc_real_blocked', { method: 'POST', body: 'x' }).catch(() => {});
    fetch('/__bc_real_404').catch(() => {});
  });
  await page.waitForTimeout(800);
  await page.goto('https://example.com/__bc_real_moved'); await page.waitForLoadState();
  await page.evaluate(() => { console.error('BC_REAL_after_move'); });
  await page.waitForTimeout(300);
  const p = await bc.problems(page);
  const rep = await bc.guardReport(page);
  check('console state is on', p.consoleState === 'on', { state: p.consoleState });
  check('console error caught', p.console.some((x) => /BC_REAL_console_error/.test(x.text)), { n: p.summary.console });
  check('console error caught after a move', p.console.some((x) => /BC_REAL_after_move/.test(x.text)));
  check('exception caught', p.exceptions.some((x) => /BC_REAL_uncaught/.test(x.text)), { n: p.summary.exceptions });
  check('404 caught', p.http.some((x) => /__bc_real_404/.test(x.url)));
  check('guard record survives a move', !!(rep && rep.blocked.some((b) => /__bc_real_blocked/.test(b.url))));
});
check('space closed (console)', r.closed.closed, r.closed);

// 2. --no-console's mode: nothing is claimed.
bc.__console = {};
r = await bc.run('bc-real-noconsole', async ({ page }) => {
  await maybeHide(page);
  await bc.watch(page, { console: false });
  await page.goto('https://example.com'); await page.waitForLoadState();
  const p = await bc.problems(page);
  check('console: false gives state hidden and no false 0', p.consoleState === 'hidden' && p.summary.console === null, { state: p.consoleState, n: p.summary.console });
});
check('space closed (no console)', r.closed.closed);

// 3. Widths on two sites.
r = await bc.run('bc-real-width', async ({ page }) => {
  for (const url of ['https://example.com', 'https://lite.ego.app/ko']) {
    await page.goto(url); await page.waitForLoadState();
    for (const w of [390, 768, 1024, 1280]) { const g = await bc.setWidth(page, w, 800); check(`width ${w} on ${new URL(url).host}`, g.width === w, g); }
    await page.cdp('Emulation.clearDeviceMetricsOverride', {}, { timeout: 5000 });
  }
});
check('space closed (width)', r.closed.closed);

// 4. Full page on screencast, the bottom mark must fit in the frame's height; the size is put back.
r = await bc.run('bc-real-full', async ({ page }) => {
  await page.goto('https://example.com'); await page.waitForLoadState();
  // example.com centres itself in a 100vh layout that grows with the viewport, so the result reports how far it got
  // (whole: false, height of pageHeight) rather than whole: true.
  await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'height:5000px;background:linear-gradient(#ffb3b3,#b3b3ff);position:relative'; const m = document.createElement('div'); m.textContent = 'BOTTOM-MARK'; m.style.cssText = 'position:absolute;bottom:10px;left:10px;font:40px sans-serif;background:#fff'; d.appendChild(m); document.body.appendChild(d); });
  const before = await page.evaluate(() => innerWidth);
  const s = await bc.shot(page, 'real_full', { fullPage: true });
  const after = await page.evaluate(() => innerWidth);
  check('full capture ok', s.ok, s);
  check('full capture says how far it got', s.via === 'screenshot' || (s.fullPage && s.fullPage.height > 5000 && typeof s.fullPage.whole === 'boolean'), { fullPage: s.fullPage });
  check('size put back', before === after, { before, after });
});
check('space closed (full)', r.closed.closed);

// 5. A window a click opens: guard on it, record on it, reported, and closed with the space.
r = await bc.run('bc-real-popup', async ({ task, page }) => {
  await bc.watch(page);
  await page.goto('https://example.com'); await page.waitForLoadState();
  await page.evaluate(() => { const a = document.createElement('a'); a.id = 'bcp'; a.target = '_blank'; a.href = 'https://example.org/'; a.textContent = 'open'; document.body.appendChild(a); });
  const rec = await page.click('#bcp');
  check('receipt names the window', !!(rec && rec.popups && rec.popups.length), { rec });
  await page.waitForTimeout(800);
  const others = await bc.otherPages(task, page);
  check('one window opened', others.length === 1, { n: others.length });
  const pop = others[0];
  await pop.waitForLoadState();
  const hook = await pop.evaluate(() => ({ url: location.href, hooked: !!window.__bcHooked, guard: !!window.__bcGuard }));
  check('window has the hook', hook.hooked, hook);
  if (__bcCfg.guard) {
    check('window has the guard', hook.guard, hook);
    const post = await pop.evaluate(async () => { try { const x = await fetch('/__bc_real_popup', { method: 'POST', body: 'x' }); return 'SENT ' + x.status; } catch (e) { return String(e.message); } });
    check('a write from the window is refused', /bc-guard: blocked/.test(post), { post });
    const rep = await bc.guardReport(pop);
    check('the refusal is on record', !!(rep && rep.blocked.some((b) => /__bc_real_popup/.test(b.url))));
  }
  const shotOfFirst = await bc.shot(page, 'real_first_with_window_open');
  check('first page still captures behind the window', shotOfFirst.ok, shotOfFirst);
  const shotOfWindow = await bc.shot(pop, 'real_window');
  check('window captures', shotOfWindow.ok, shotOfWindow);
});
check('space closed with its window', r.closed.closed, r.closed);

// A closed space can stay on the list for a moment after task.finish() has returned.
let left = [];
for (let i = 0; i < 20; i++) { left = (await listTaskSpaces()).filter((s) => /^bc-real-/.test(s.name || '')); if (!left.length) break; await new Promise((res) => setTimeout(res, 250)); }
check('no space left behind', left.length === 0, { left: left.map((s) => s.name) });
