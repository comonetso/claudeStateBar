const R = {};
const G = async (k, fn, lim) => {
  try {
    R[k] = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj(new Error('guard ' + (lim || 8000))), lim || 8000))]);
  } catch (e) { R[k] = 'ERR ' + String((e && e.message) || e).slice(0, 240); }
};
const tE = await openTab('https://example.com/?fchk=E');
const X = (m, p) => tE._sendToTarget(m, p || {});
try {
  await G('fix', () => tE.evaluate(() => {
    document.body.innerHTML = '<input id="ime" style="position:absolute;left:20px;top:20px"><button id="sb" style="position:absolute;left:20px;top:80px">SB</button><section id="tz" style="position:absolute;left:300px;top:200px;width:200px;height:100px;background:#ddd"></section>';
    window.__ev = [];
    const rec = (el, types) => types.forEach((t) => el.addEventListener(t, (e) => window.__ev.push(el.id + ':' + t + ':' + (e.isTrusted ? 'T' : 'F') + (e.data !== undefined && e.data !== null ? ':' + e.data : '') + (e.key !== undefined ? ':key=' + JSON.stringify(e.key) : '') + (e.pointerType ? ':' + e.pointerType : ''))));
    rec(document.getElementById('ime'), ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown']);
    rec(document.getElementById('sb'), ['keydown', 'click']);
    rec(document.getElementById('tz'), ['touchstart', 'touchend', 'pointerdown', 'click']);
    return 'ok';
  }));
  await G('ime', async () => {
    await tE.locator('#ime').focus();
    for (const s of ['ㅎ', '하', '한']) await X('Input.imeSetComposition', { text: s, selectionStart: 1, selectionEnd: 1 });
    await X('Input.insertText', { text: '한' });
    return await tE.evaluate(() => ({ ev: window.__ev.splice(0), val: document.getElementById('ime').value }));
  });
  await G('spaceCdp', async () => {
    await tE.locator('#sb').focus();
    await X('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await X('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await sleep(200);
    return await tE.evaluate(() => window.__ev.splice(0));
  });
  await G('touch', async () => {
    const before = await tE.evaluate(() => ({ ots: 'ontouchstart' in window, mtp: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches }));
    await X('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const during = await tE.evaluate(() => ({ ots: 'ontouchstart' in window, mtp: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches }));
    await X('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 400, y: 250 }] });
    await X('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
    const ev = await tE.evaluate(() => window.__ev.splice(0));
    await X('Emulation.setTouchEmulationEnabled', { enabled: false });
    const after = await tE.evaluate(() => ({ ots: 'ontouchstart' in window, mtp: navigator.maxTouchPoints }));
    return { before, during, ev, after };
  });
} finally {
  await closeTab(tE);
}
console.log('@@F ' + JSON.stringify(R));
