const R = {};
const G = async (k, fn, lim) => {
  try {
    R[k] = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj(new Error('guard ' + (lim || 8000))), lim || 8000))]);
  } catch (e) { R[k] = 'ERR ' + String((e && e.message) || e).slice(0, 240); }
};
const tF = await openTab('https://example.com/?fchk=A');
try {
  await G('vis0', () => tF.evaluate(() => performance.getEntriesByType('visibility-state').map((e) => e.name + '@' + Math.round(e.startTime))));
  const rate = () => tF.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }));
  await G('raf_before', rate);
  await G('fixture', () => tF.evaluate(async () => {
    const m = document.createElement('meta'); m.name = 'darkreader-lock'; document.head.appendChild(m);
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:rgb(255,255,255);height:2700px';
    const mk = (id, x, y, w, h, c) => { const s = document.createElement('section'); s.id = id; s.style.cssText = 'position:absolute;opacity:1;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background:' + c; document.body.appendChild(s); };
    mk('bBlue', 0, 0, 60, 60, 'rgb(0,0,255)');
    mk('bRed', 600, 300, 60, 60, 'rgb(255,0,0)');
    mk('band1', 0, 1000, 1400, 100, 'rgb(0,200,0)');
    mk('band2', 0, 2000, 1400, 100, 'rgb(255,0,255)');
    for (const e of document.querySelectorAll('*')) if (e.tagName.toLowerCase().startsWith('deepl-')) e.style.setProperty('display', 'none', 'important');
    const t0 = Date.now();
    while (document.documentElement.hasAttribute('data-darkreader-mode') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    return { dr: document.documentElement.getAttribute('data-darkreader-mode'), dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight, sh: document.documentElement.scrollHeight };
  }));
  await G('clip', async () => (await tF.screenshot({ clip: { x: 600, y: 300, width: 60, height: 60 } })).toString('base64'));
  await G('full', async () => (await tF.screenshot({ fullPage: true, type: 'jpeg', quality: 40 })).toString('base64'), 15000);
  await G('raf_after', rate);
  await G('space', async () => {
    await tF.evaluate(() => { const i = document.createElement('input'); i.id = 'sp'; i.style.cssText = 'position:absolute;left:10px;top:120px'; window.__keys = []; i.addEventListener('keydown', (e) => window.__keys.push(JSON.stringify(e.key) + '/' + e.code)); document.body.appendChild(i); });
    await tF.locator('#sp').focus();
    await tF.keyboard.press('Space');
    await tF.keyboard.press('a');
    return await tF.evaluate(() => ({ keys: window.__keys, val: JSON.stringify(document.getElementById('sp').value) }));
  });
  await G('hiddenFill', async () => {
    await tF.evaluate(() => { const v = document.createElement('input'); v.id = 'victim'; v.style.cssText = 'position:absolute;left:10px;top:160px'; document.body.appendChild(v); const d = document.createElement('div'); d.style.display = 'none'; d.innerHTML = '<input id="hid">'; document.body.appendChild(d); v.focus(); });
    let err = null;
    try { await tF.locator('#hid').fill('LEAK'); } catch (e) { err = String(e.message).slice(0, 120); }
    return await tF.evaluate((er) => ({ err: er, victim: document.getElementById('victim').value, hid: document.getElementById('hid').value, active: document.activeElement.id }), err);
  });
  await G('cdp_type', async () => typeof tF._sendToTarget);
  await G('cdp_eval', async () => JSON.stringify(await tF._sendToTarget('Runtime.evaluate', { expression: '1+2', returnByValue: true })));
  await G('cdp_vp', async () => {
    await tF._sendToTarget('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    const a = await tF.evaluate(() => [innerWidth, innerHeight, devicePixelRatio, matchMedia('(max-width: 400px)').matches]);
    await tF._sendToTarget('Emulation.clearDeviceMetricsOverride', {});
    const b = await tF.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    return JSON.stringify({ a, b });
  });
  await G('cdp_media', async () => {
    const before = await tF.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches);
    await tF._sendToTarget('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const during = await tF.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches);
    await tF._sendToTarget('Emulation.setEmulatedMedia', { media: '', features: [] });
    const after = await tF.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches);
    return JSON.stringify({ before, during, after });
  });
  await G('cdp_css', async () => {
    await tF._sendToTarget('DOM.enable', {}); await tF._sendToTarget('CSS.enable', {});
    const d = await tF._sendToTarget('DOM.getDocument', { depth: 0 });
    const q = await tF._sendToTarget('DOM.querySelector', { nodeId: d.root.nodeId, selector: '#bRed' });
    const ms = await tF._sendToTarget('CSS.getMatchedStylesForNode', { nodeId: q.nodeId });
    const inl = ms.inlineStyle ? ms.inlineStyle.cssProperties.filter((p) => p.name === 'background-color' || p.name === 'background').map((p) => p.name + '=' + p.value) : [];
    return JSON.stringify({ rules: (ms.matchedCSSRules || []).length, inline: inl });
  });
  await G('cdp_axt', async () => {
    await tF._sendToTarget('Accessibility.enable', {});
    const t = await tF._sendToTarget('Accessibility.getFullAXTree', {});
    return (t.nodes || []).length;
  });
  await G('cdp_init', async () => {
    const r = await tF._sendToTarget('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__fEarly = { rs: document.readyState, n: document.scripts.length };' });
    await tF.reload();
    const e = await tF.evaluate(() => window.__fEarly);
    return JSON.stringify({ id: r && r.identifier, early: e });
  }, 12000);
  await G('vis1', () => tF.evaluate(() => performance.getEntriesByType('visibility-state').map((e) => e.name + '@' + Math.round(e.startTime))));
  await G('raf_afterReload', rate);
} finally {
  await closeTab(tF);
}
console.log('@@F ' + JSON.stringify(R));
