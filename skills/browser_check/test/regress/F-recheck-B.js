const R = {};
const G = async (k, fn, lim) => {
  try {
    R[k] = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj(new Error('guard ' + (lim || 8000))), lim || 8000))]);
  } catch (e) { R[k] = 'ERR ' + String((e && e.message) || e).slice(0, 240); }
};
const tB = await openTab('https://example.com/?fchk=B');
try {
  const got = [];
  tB.on('dialog', (d) => { got.push({ json: JSON.stringify(d), acceptType: typeof (d && d.accept) }); });
  await G('dialogFix', () => tB.evaluate(() => {
    document.body.innerHTML = '<button id="cf" style="position:absolute;left:20px;top:20px">c</button>';
    window.__cr = [];
    document.getElementById('cf').onclick = () => { window.__cr.push(confirm('F-정말?')); };
    return 'ok';
  }));
  await G('dialog1', async () => { await tB.locator('#cf').click(); return { handler: got.slice(), confirmReturns: await tB.evaluate(() => window.__cr.slice()) }; });
  await G('dialog2_override', async () => {
    await tB.evaluate(() => { window.confirm = (m) => { window.__lc = m; return false; }; });
    await tB.locator('#cf').click();
    return { confirmReturns: await tB.evaluate(() => window.__cr.slice()), last: await tB.evaluate(() => window.__lc) };
  });
  await G('drag', async () => {
    await tB.evaluate(() => {
      const mk = (id, x, y) => { const s = document.createElement('section'); s.id = id; s.style.cssText = 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:200px;height:60px;background:#ccc'; document.body.appendChild(s); };
      mk('dA', 300, 300); mk('dB', 300, 500);
      window.__pe = [];
      for (const t of ['pointerdown', 'pointerup']) document.addEventListener(t, (e) => window.__pe.push(t + ':' + e.target.id + ':' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true);
    });
    await tB.locator('#dA').dragTo(tB.locator('#dB'), { sourcePosition: { x: 5, y: 5 }, targetPosition: { x: 10, y: 10 } });
    return await tB.evaluate(() => window.__pe.slice());
  });
  await G('ips3', async () => {
    await installPageScript(tB, 'fk1', 'window.__ips = (window.__ips || 0) + 1');
    await installPageScript(tB, 'fk1', 'window.__ips = (window.__ips || 0) + 1');
    return await tB.evaluate(() => window.__ips);
  });
  await G('ips2', async () => { await installPageScript(tB, 'window.__ips2 = 1'); return await tB.evaluate(() => window.__ips2); });
  await G('world', async () => {
    await tB.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__mm = 42'; document.head.appendChild(s); });
    return {
      page: await tB.evaluate(() => typeof window.__mm),
      locator: await tB.locator('body').evaluate(() => typeof window.__mm),
      evalAll: await tB.locator('body').evaluateAll(() => typeof window.__mm),
      mainFrame: await tB.mainFrame().evaluate(() => typeof window.__mm),
    };
  });
  await G('locAsync', async () => JSON.stringify(await tB.locator('body').evaluate(async () => { await new Promise((r) => setTimeout(r, 100)); return 7; })));
  await G('spa', async () => {
    await tB.evaluate(() => history.pushState({}, '', '/?fchk=spa1'));
    const s = await snapshot(tB, { interactive: true });
    const mm = /https?:\/\/[^\s\])"]+/.exec(s.tree);
    return { pageUrl: await tB.url(), href: await tB.evaluate(() => location.href), snapUrl: mm && mm[0] };
  });
  await G('wfu_str_spa', async () => { await tB.waitForURL('https://example.com/?fchk=spa1', { timeout: 1500 }); return 'ok'; }, 5000);
  await G('wfu_test_spa', async () => { await tB.waitForURL({ test: (u) => u.includes('fchk=spa1') }, { timeout: 1500 }); return 'ok'; }, 5000);
  await G('nav', async () => { await tB.goto('https://example.com/?fchk=nav2'); return { pageUrl: await tB.url() }; }, 10000);
  await G('wfu_test_nav', async () => { await tB.waitForURL({ test: (u) => u.includes('fchk=nav2') }, { timeout: 1500 }); return 'ok'; }, 5000);
  await G('wfu_fn_nav', async () => { await tB.waitForURL((u) => String(u).includes('fchk=nav2'), { timeout: 1500 }); return 'ok'; }, 5000);
} finally {
  await closeTab(tB);
}
console.log('@@F ' + JSON.stringify(R));
