// Example script for `browser-check.mjs cdp test/cdp-example.mjs --url https://example.com/`.
// Runs through the policy-gated CdpClient (transport C). No global WebSocket / fetch — works on Node 18+.
// Exercises: own background target · first-load injection · environment prep (Dark Reader / injected UI) ·
// console/exception/network events · device + media emulation · real right-click · screenshot · cleanup (the entry
// point disposes every owned target in finally).
export default async function (client, h) {
  const url = h.url || 'https://example.com/';
  const R = { browser: client.browser };
  const { targetId, sessionId } = await client.openTarget('about:blank');
  R.target = targetId;
  await client.enable(sessionId, ['Page', 'Runtime', 'Log', 'Network']);
  const rec = client.record(sessionId, { network: true });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__injected = document.readyState; console.error("first-load-inject console"); setTimeout(function(){ throw new Error("first-load-inject exception"); }, 0);' }, sessionId);
  await client.send('Page.navigate', { url }, sessionId); // allowed only because sessionId belongs to a target this run created
  await new Promise((r) => setTimeout(r, 2500));
  R.injectedAt = await client.evaluate(sessionId, 'window.__injected');
  const prep = await client.prep(sessionId); // detect → warn → lock Dark Reader / hide DeepL etc. before emulation and capture
  R.prep = { warnings: prep.warnings, darkReaderAfter: prep.after.darkReader };
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId);
  R.emulated = await client.evaluate(sessionId, 'JSON.stringify({ w: innerWidth, dark: matchMedia("(prefers-color-scheme: dark)").matches, dpr: devicePixelRatio })');
  await client.evaluate(sessionId, 'window.__ctx = 0; document.addEventListener("contextmenu", function(){ window.__ctx++; }); true');
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'right', clickCount: 1 }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 100, button: 'right', clickCount: 1 }, sessionId);
  R.rightClick = await client.evaluate(sessionId, 'window.__ctx');
  R.image = h.saveImage('example-mobile-dark.jpg', await client.screenshot(sessionId, { format: 'jpeg', quality: 50 }));
  await client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  await client.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);
  R.events = rec.summary();
  rec.stop();
  return R;
}
