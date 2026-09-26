// 반응형 점검 표준 절차 (한 호출, 60초 안)
const RV_URL = 'https://getbootstrap.com/';
const rvTab = await openTab(RV_URL);
const rvOut = { steps: {} };
const rvStep = async (k, fn) => { const s = Date.now(); try { rvOut.steps[k] = { ok: true, v: await fn() }; } catch (e) { rvOut.steps[k] = { ok: false, err: String(e && e.message || e).slice(0, 300) }; } rvOut.steps[k].ms = Date.now() - s; };
// iframe 안에서 돌릴 측정 함수(인자 1개, 클로저 없음)
const rvMeasure = (html) => {
  const d = html.ownerDocument, W = d.defaultView;
  html.style.scrollbarWidth = 'none';
  const cw = html.clientWidth;
  const clipped = (e) => { for (let p = e.parentElement; p && p !== d.body; p = p.parentElement) { const c = W.getComputedStyle(p); if (c.overflowX !== 'visible' || c.contain.includes('paint')) return true; } return false; };
  const over = [];
  for (const e of d.body.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width === 0 || r.right <= cw + 1) continue; const c = W.getComputedStyle(e); if (c.visibility === 'hidden' || c.display === 'none' || clipped(e)) continue; over.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList[0] ? '.' + e.classList[0] : '') + ' right=' + Math.round(r.right)); }
  // 컨테이너 쿼리 전환 시험판
  const s = d.createElement('style'); s.textContent = '.rvcq{container:rv / inline-size;width:90vw} #rvcqx{color:rgb(9,9,9)} @container rv (max-width: 400px){#rvcqx{color:rgb(1,2,3)}}'; d.head.appendChild(s);
  const b = d.createElement('div'); b.className = 'rvcq'; b.innerHTML = '<span id="rvcqx">x</span>'; d.body.appendChild(b);
  const cq = W.getComputedStyle(d.getElementById('rvcqx')).color + ' @' + Math.round(b.getBoundingClientRect().width);
  b.remove(); s.remove();
  const bp = { sm: W.matchMedia('(min-width: 576px)').matches, md: W.matchMedia('(min-width: 768px)').matches, lg: W.matchMedia('(min-width: 992px)').matches };
  return { iw: W.innerWidth, cw, sw: html.scrollWidth, hScroll: html.scrollWidth > cw, overflow: over.slice(0, 8), overflowCount: over.length, bp, darkReaderOff: !html.hasAttribute('data-darkreader-mode'), cq };
};
try {
  await rvStep('prep', () => page.evaluate(async () => {
    const m = document.createElement('meta'); m.name = 'darkreader-lock'; document.head.appendChild(m);
    for (const e of document.querySelectorAll('*')) if (e.tagName.toLowerCase().startsWith('deepl-')) e.style.setProperty('display', 'none', 'important');
    const t0 = Date.now(); while (document.documentElement.hasAttribute('data-darkreader-mode') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    return { drOff: !document.documentElement.hasAttribute('data-darkreader-mode') };
  }));
  for (const group of [[390, 768], [1024]]) {
    await page.evaluate((a) => {
      const old = document.getElementById('rvbox'); if (old) old.remove();
      const box = document.createElement('div'); box.id = 'rvbox'; box.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;background:#808080;display:flex;gap:8px;align-items:flex-start';
      for (const w of a.ws) { const f = document.createElement('iframe'); f.id = 'rv' + w; f.src = a.u + (a.u.includes('?') ? '&' : '?') + 'rv=' + w; f.style.cssText = 'flex:none;border:0;background:#fff;width:' + w + 'px;height:844px'; box.appendChild(f); }
      document.documentElement.appendChild(box);
    }, { ws: group, u: RV_URL });
    for (const w of group) await page.frameLocator('#rv' + w).locator('body').waitFor({ state: 'attached', timeout: 20000 });
    await sleep(1500); // 늦게 붙는 스크립트 UI 대기(스냅샷으로 판단하기 어려운 레이아웃 안정화)
    // iframe 안 Dark Reader 잠금(동기 삽입) → repl 쪽에서 해제 확인(locator.evaluate 는 Promise 를 안 기다린다)
    for (const w of group) await page.frameLocator('#rv' + w).locator('html').evaluate((h) => { const d = h.ownerDocument; if (!d.querySelector('meta[name="darkreader-lock"]')) { const m = d.createElement('meta'); m.name = 'darkreader-lock'; d.head.appendChild(m); } });
    for (let i = 0; i < 30; i++) { let on = 0; for (const w of group) on += await page.frameLocator('#rv' + w).locator('html').evaluate((h) => (h.hasAttribute('data-darkreader-mode') ? 1 : 0)); if (!on) break; await sleep(100); }
    for (const w of group) await rvStep('w' + w, () => page.frameLocator('#rv' + w).locator('html').evaluate(rvMeasure));
    const boxes = {}; for (const w of group) boxes[w] = await page.locator('#rv' + w).boundingBox();
    rvOut['boxes' + group[0]] = boxes;
    console.log('@@RVSHOT_' + group[0] + ' ' + Buffer.from(await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'));
  }
  await page.evaluate(() => document.getElementById('rvbox').remove());
  // main world 확인
  await page.evaluate(() => { window.__mw = 7; });
  rvOut.locReadsMain = await page.locator('body').evaluate(() => window.__mw);
  await page.locator('body').evaluate(() => { window.__mw2 = 9; });
  rvOut.locWritesMain = await page.evaluate(() => window.__mw2);
} catch (e) { rvOut.fatal = String(e && e.message || e).slice(0, 400); }
finally { console.log('@@RV ' + JSON.stringify(rvOut)); await closeTab(rvTab); console.log('@@RVEND tabs=' + tabs.length); }
