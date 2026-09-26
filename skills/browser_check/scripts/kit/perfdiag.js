(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const origin = location.origin;
  const by = (arr, f) => arr.reduce((m, e) => { const k = f(e); m[k] = (m[k] || 0) + 1; return m; }, {});
  const opaque = res.filter((e) => e.responseStatus === 0 && e.transferSize === 0 && e.encodedBodySize === 0);
  const uncompressed = res.filter((e) => e.encodedBodySize > 1024 && e.encodedBodySize === e.decodedBodySize && /text|javascript|json|css|svg|html/.test(e.contentType || ''));
  let maxDepth = 0, maxKids = 0, maxKidsEl = '';
  const walk = (el, d) => { if (d > maxDepth) maxDepth = d; if (el.children.length > maxKids) { maxKids = el.children.length; maxKidsEl = el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''); } for (const c of el.children) walk(c, d + 1); };
  walk(document.documentElement, 1);
  const thirdParty = {};
  for (const e of res) { let o; try { o = new URL(e.name).origin; } catch (x) { continue; } if (o === origin) continue; const t = thirdParty[o] || (thirdParty[o] = { n: 0, bytes: 0, dur: 0 }); t.n++; t.bytes += e.transferSize; t.dur += e.duration; }
  return {
    nav: { redirectCount: nav.redirectCount, ttfb: Math.round(nav.responseStart), serverTime: Math.round(nav.responseStart - nav.requestStart), proto: nav.nextHopProtocol, transferSize: nav.transferSize, encoded: nav.encodedBodySize, decoded: nav.decodedBodySize, deliveryType: nav.deliveryType, serverTiming: (nav.serverTiming || []).map((s) => s.name + ':' + s.duration) },
    resources: res.length, bufferNote: res.length === 250 ? 'exactly 250 — buffer likely full' : '',
    renderBlocking: res.filter((e) => e.renderBlockingStatus === 'blocking').map((e) => e.name.split('?')[0].slice(-60)),
    protocols: by(res, (e) => e.nextHopProtocol || '(hidden)'),
    initiators: by(res, (e) => e.initiatorType),
    deliveryTypes: by(res, (e) => e.deliveryType || '(network)'),
    failed: res.filter((e) => e.responseStatus >= 400).map((e) => e.responseStatus + ' ' + e.name.slice(-60)),
    opaqueNoTAO: opaque.length,
    uncompressed: uncompressed.map((e) => e.encodedBodySize + 'B ' + e.name.split('?')[0].slice(-50)),
    largest: res.slice().sort((a, b) => b.transferSize - a.transferSize).slice(0, 5).map((e) => e.transferSize + 'B ' + e.name.split('?')[0].slice(-50)),
    slowest: res.slice().sort((a, b) => b.duration - a.duration).slice(0, 5).map((e) => Math.round(e.duration) + 'ms ' + e.name.split('?')[0].slice(-50)),
    thirdParty: Object.entries(thirdParty).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6).map(([o, t]) => o + ' n=' + t.n + ' ' + t.bytes + 'B'),
    dom: { nodes: document.getElementsByTagName('*').length, maxDepth, maxKids, maxKidsEl },
  };
})()
