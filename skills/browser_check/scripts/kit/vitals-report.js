(async () => {
  const V = window.__t2v; if (!V) return { error: 'not installed' };
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const act = nav.activationStart || 0;
  const hid = V.hiddenAt;
  const rate = (v, g, p) => (v == null ? null : v <= g ? 'good' : v <= p ? 'needs-improvement' : 'poor');
  const ttfb = nav.responseStart > 0 ? Math.max(nav.responseStart - act, 0) : null;
  const fcpE = performance.getEntriesByName('first-contentful-paint')[0];
  const fcp = fcpE && fcpE.startTime < hid ? Math.max(fcpE.startTime - act, 0) : null;
  const lcpList = V.lcp.filter((e) => e.t < hid);
  const lcpE = lcpList[lcpList.length - 1];
  const lcp = lcpE ? Math.max(lcpE.t - act, 0) : null;
  let lcpParts = null;
  if (lcpE && ttfb != null) {
    const r = lcpE.url ? performance.getEntriesByType('resource').find((x) => x.name === lcpE.url) : null;
    const reqStart = r ? Math.max(ttfb, (r.requestStart || r.startTime) - act) : ttfb;
    const resEnd = r ? Math.max(reqStart, r.responseEnd - act) : ttfb;
    lcpParts = { ttfb: Math.round(ttfb), loadDelay: Math.round(reqStart - ttfb), loadTime: Math.round(resEnd - reqStart), renderDelay: Math.round(lcp - resEnd), el: lcpE.el, url: lcpE.url ? lcpE.url.slice(-60) : '' };
  }
  const isExt = (s) => s.node === null || /^(deepl-|grammarly-)/.test(String(s.node));
  const sessions = (list) => { let best = 0, cur = 0, first = 0, prev = 0; for (const e of list) { if (cur && e.t - prev < 1000 && e.t - first < 5000) { cur += e.v; } else { cur = e.v; first = e.t; } prev = e.t; best = Math.max(best, cur); } return best; };
  const shifts = V.cls.filter((e) => !e.input);
  const clsAll = sessions(shifts);
  const clsOwn = sessions(shifts.filter((e) => !(e.src.length && e.src.every(isExt))));
  const byId = new Map();
  for (const e of V.ev) { if (!e.id) continue; const o = byId.get(e.id); if (!o || e.d > o.d) byId.set(e.id, e); }
  const inter = [...byId.values()].sort((a, b) => b.d - a.d);
  const cnt = performance.interactionCount || inter.length;
  const inpE = inter.length ? inter[Math.min(inter.length - 1, Math.floor(cnt / 50))] : null;
  const detail = (e) => e && { name: e.n, tg: e.tg, duration: e.d, inputDelay: Math.round(e.ps - e.t), processing: Math.round(e.pe - e.ps), presentation: Math.round(e.t + e.d - e.pe) };
  const procMax = inter.reduce((m, e) => Math.max(m, e.pe - e.ps), 0);
  const tbt = V.lt.reduce((s, e) => { const st = Math.max(e.t, fcp || 0); const en = e.t + e.d; return s + Math.max(0, en - st - 50); }, 0);
  const raf = await new Promise((res) => { const t = []; let last = performance.now(); const f = (n) => { t.push(Math.round(n - last)); last = n; if (t.length < 6) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); setTimeout(() => res(t), 2500); });
  const mem = performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null;
  return {
    url: location.href, deliveryType: nav.deliveryType, navType: nav.type,
    visibility: performance.getEntriesByType('visibility-state').map((e) => e.name + '@' + Math.round(e.startTime)), hiddenAt: isFinite(hid) ? Math.round(hid) : null,
    ttfb: ttfb != null ? Math.round(ttfb) : null, fcp: fcp != null ? Math.round(fcp) : null, lcp: lcp != null ? Math.round(lcp) : null, lcpParts,
    cls: +clsAll.toFixed(4), clsExcludingExtensions: +clsOwn.toFixed(4), shifts: shifts.length,
    inp: inpE ? inpE.d : null, inpDetail: detail(inpE), interactions: inter.length, interactionCount: performance.interactionCount, processingMax: Math.round(procMax),
    rating: { ttfb: rate(ttfb, 800, 1800), fcp: rate(fcp, 1800, 3000), lcp: rate(lcp, 2500, 4000), cls: rate(clsOwn, 0.1, 0.25), inp: rate(inpE && inpE.d, 200, 500), inpByProcessing: rate(procMax, 200, 500) },
    longTasks: V.lt.length, tbtApprox: Math.round(tbt), loafTop: V.loaf.sort((a, b) => b.blocking - a.blocking).slice(0, 3).map((l) => ({ d: Math.round(l.d), blocking: Math.round(l.blocking), scripts: l.scripts.slice(0, 2) })),
    observers: V.ok, rafIntervals: raf, memory: mem,
  };
})()
