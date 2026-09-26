(() => {
  if (window.__t2v) return 'already';
  const V = window.__t2v = { lcp: [], cls: [], ev: [], fi: [], lt: [], loaf: [], installedAt: performance.now(), hiddenAt: Infinity, raf: [] };
  const hv = performance.getEntriesByType('visibility-state').find((e) => e.name === 'hidden');
  V.hiddenAt = hv ? hv.startTime : (document.visibilityState === 'hidden' ? 0 : Infinity);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') V.hiddenAt = Math.min(V.hiddenAt, performance.now()); }, true);
  const nm = (n) => { if (!n || n.nodeType !== 1) return n ? n.nodeName : null; return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList && n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : ''); };
  const rect = (r) => r ? [r.x, r.y, r.width, r.height].map(Math.round) : null;
  const po = (type, cb, extra) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe(Object.assign({ type, buffered: true }, extra || {})); return true; } catch (e) { return false; } };
  V.ok = {
    lcp: po('largest-contentful-paint', (e) => V.lcp.push({ t: e.startTime, render: e.renderTime, load: e.loadTime, size: e.size, url: e.url, el: nm(e.element) })),
    cls: po('layout-shift', (e) => V.cls.push({ t: e.startTime, v: e.value, input: e.hadRecentInput, src: (e.sources || []).map((s) => ({ node: nm(s.node), prev: rect(s.previousRect), cur: rect(s.currentRect) })) })),
    ev: po('event', (e) => V.ev.push({ n: e.name, id: e.interactionId, t: e.startTime, d: e.duration, ps: e.processingStart, pe: e.processingEnd, tg: nm(e.target) }), { durationThreshold: 16 }),
    fi: po('first-input', (e) => V.fi.push({ n: e.name, t: e.startTime, delay: e.processingStart - e.startTime })),
    lt: po('longtask', (e) => V.lt.push({ t: e.startTime, d: e.duration })),
    loaf: po('long-animation-frame', (e) => V.loaf.push({ t: e.startTime, d: e.duration, blocking: e.blockingDuration, scripts: (e.scripts || []).map((s) => ({ src: s.sourceURL, fn: s.sourceFunctionName, inv: s.invoker, d: Math.round(s.duration) })) })),
  };
  return 'installed';
})()
