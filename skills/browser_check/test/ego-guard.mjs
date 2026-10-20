// `browser-check run test/ego-guard.mjs --guard-writes` — the write guard and the refused CDP commands, on a
// harmless public page: a POST must be refused in the page, a GET must pass, cookie reads must be refused.
const r = await bc.run('bc-guard-test', async ({ page }) => {
  await page.goto('https://example.com/');
  await page.waitForLoadState();
  bc.out('POST', await page.evaluate(async () => { try { await fetch('/__bc_try_post', { method: 'POST', body: 'x' }); return 'sent'; } catch (e) { return String(e.message); } }));
  bc.out('GET', await page.evaluate(async () => { try { const x = await fetch('/', { method: 'GET' }); return 'ok ' + x.status; } catch (e) { return String(e.message); } }));
  // A refused form submit does not navigate; the guard report below must list it.
  bc.out('FORM', await page.evaluate(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '/__bc_try_form'; document.body.appendChild(f); f.requestSubmit(); f.remove(); return 'still on ' + location.pathname; }));
  await page.waitForTimeout(500);
  bc.out('AFTER_FORM', new URL(await page.url()).pathname);
  bc.out('REPORT', await bc.guardReport(page));
  let denied; try { await page.cdp('Network.getAllCookies'); denied = 'not refused'; } catch (e) { denied = String(e.message); }
  bc.out('DENY', denied);
});
bc.out('CLOSED', r.closed);
