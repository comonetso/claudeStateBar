const R = {};
const G = async (k, fn, lim) => {
  try {
    R[k] = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj(new Error('guard ' + (lim || 8000))), lim || 8000))]);
  } catch (e) { R[k] = 'ERR ' + String((e && e.message) || e).slice(0, 240); }
};
const tD = await openTab('https://example.com/?fchk=D');
try {
  await G('fix', () => tD.evaluate(() => {
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;height:5000px';
    const grp = (tag, y) => {
      const s = document.createElement('section'); s.style.cssText = 'position:absolute;left:20px;top:' + y + 'px';
      s.innerHTML = '<button>Btn' + tag + '</button> <input placeholder="Inp' + tag + '"> <a href="#' + tag + '">Lnk' + tag + '</a>';
      document.body.appendChild(s);
    };
    grp('Top', 100); grp('Low', 3000);
    return 'ok';
  }));
  const count = (tree) => ({ textbox: (tree.match(/textbox/g) || []).length, button: (tree.match(/button "/g) || []).length, link: (tree.match(/link "/g) || []).length, hasInpTop: tree.includes('InpTop'), hasBtnTop: tree.includes('BtnTop') });
  await G('s0', async () => count((await snapshot(tD, { interactive: true })).tree));
  await G('s2800', async () => { await tD.evaluate(() => scrollTo(0, 2800)); return count((await snapshot(tD, { interactive: true })).tree); });
  await G('s2800_hidden', async () => count((await snapshot(tD, { interactive: true, showHidden: true })).tree));
  await G('sBack', async () => { await tD.evaluate(() => scrollTo(0, 0)); return count((await snapshot(tD, { interactive: true })).tree); });
  await G('selFirst', async () => count((await snapshot(tD, { selector: 'section' })).tree));
  await G('isVisibleMissing', async () => { try { return String(await tD.locator('#nope').isVisible()); } catch (e) { return 'THROW ' + String(e.message).slice(0, 80); } });
  await G('countMissing', async () => tD.locator('#nope').count());
} finally {
  await closeTab(tD);
}
console.log('@@F ' + JSON.stringify(R));
