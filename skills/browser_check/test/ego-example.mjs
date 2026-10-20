// Example for `browser-check.mjs ego test/ego-example.mjs --url https://example.com/` — a harmless public page in our
// own task space: watch → open → title → capture → problems → one kit → close (bc.run always closes the space).
const r = await bc.run('bc-example', async ({ page }) => {
  await bc.watch(page);
  await page.goto(bc.url || 'https://example.com/');
  await page.waitForLoadState();
  bc.out('TITLE', await page.title());
  bc.out('SHOT', await bc.shot(page, 'example'));
  bc.out('PROBLEMS', (await bc.problems(page)).summary);
  const wc = await bc.kit(page, 'webcheck');
  bc.out('WEBCHECK_KEYS', Object.keys(wc || {}).slice(0, 12));
});
bc.out('CLOSED', r.closed);
