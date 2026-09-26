/* webcheck-extra: webcheck.js 보강(R4 제안). 사용: await page.evaluate(EXTRA_SRC). 즉시 실행 async 식. */
/* 부작용: focus 이동(끝나면 원래 포커스·스크롤 복원) · 간격 CSS 잠깐 적용 후 제거 · 합성 paste 이벤트(텍스트는 안 들어감) · 같은 출처 HEAD·robots.txt GET. 데이터 변경 없음. */
(async () => {
  const MAX = 6;
  const out = {};
  const de = document.documentElement;
  const vw = innerWidth, vh = innerHeight, cw = de.clientWidth;
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el && el.nodeName);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const sample = (arr, f) => ({ count: arr.length, samples: arr.slice(0, MAX).map(f || describe) });
  const obs = (type, extra) => new Promise((res) => {
    const got = [];
    try {
      const po = new PerformanceObserver((l) => got.push(...l.getEntries()));
      po.observe(Object.assign({ type, buffered: true }, extra || {}));
      setTimeout(() => { po.disconnect(); res(got); }, 60);
    } catch (e) { res(null); }
  });
  const rate = (v, t) => (v == null ? null : v <= t[0] ? 'good' : v <= t[1] ? 'needs-improvement' : 'poor');
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  /* 0. 확장 프로그램 오염: 페이지가 정의하지 않은 커스텀 태그(확장 content script 는 격리 세계라 customElements 에 안 잡힌다) */
  const foreign = [...document.querySelectorAll('*')].filter((e) => e.tagName.includes('-') && !customElements.get(e.tagName.toLowerCase()));
  const foreignRoots = foreign.filter((e) => !foreign.some((f) => f !== e && f.contains(e)));
  const inForeign = (el) => foreignRoots.some((f) => f.contains(el));
  const all = [...document.querySelectorAll('body *')].filter((e) => !inForeign(e));
  out.env2 = {
    undefinedCustomTags: [...new Set(foreign.map((e) => e.tagName.toLowerCase()))].slice(0, 10),
    htmlExtraChildren: [...de.children].filter((e) => !/^(HEAD|BODY)$/.test(e.tagName)).map((e) => e.tagName.toLowerCase()),
    googleTranslate: de.classList.contains('translated-ltr') || de.classList.contains('translated-rtl'),
    grammarly: !!document.querySelector('[data-gr-ext-installed],[data-new-gr-c-s-check-loaded],grammarly-desktop-integration'),
    rafNote: 'Aside 탭은 rAF 가 ~1초 간격으로 스로틀될 수 있다 — 이 스크립트는 rAF 를 기다리지 않고 강제 레이아웃으로 잰다',
  };

  /* 1. Web Vitals — web-vitals 6.2.2 규칙 재현 */
  const nav = performance.getEntriesByType('navigation')[0];
  const act = nav ? nav.activationStart || 0 : 0;
  const visE = performance.getEntriesByType('visibility-state');
  const hiddenE = visE.find((e) => e.name === 'hidden' && e.startTime >= act);
  const firstHidden = hiddenE ? hiddenE.startTime : document.visibilityState === 'hidden' ? 0 : Infinity;
  const fcpE = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  const fcp = fcpE && fcpE.startTime < firstHidden ? Math.max(fcpE.startTime - act, 0) : null;
  const lcpL = (await obs('largest-contentful-paint')) || [];
  const lcpE = lcpL.length ? lcpL[lcpL.length - 1] : null;
  const lcp = lcpE && lcpE.startTime < firstHidden ? Math.max(lcpE.startTime - act, 0) : null;
  const ttfb = nav && nav.responseStart > 0 && nav.responseStart < performance.now() ? Math.max(nav.responseStart - act, 0) : null;
  let lcpBreakdown = null;
  if (lcpE && lcp != null && ttfb != null) {
    const r = lcpE.url ? performance.getEntriesByType('resource').find((x) => x.name === lcpE.url) : null;
    const reqStart = Math.max(ttfb, r ? (r.requestStart || r.startTime) - act : 0);
    const respEnd = Math.min(lcp, Math.max(reqStart, r ? r.responseEnd - act : 0));
    lcpBreakdown = { ttfb: Math.round(ttfb), loadDelay: Math.round(reqStart - ttfb), loadTime: Math.round(respEnd - reqStart), renderDelay: Math.round(lcp - respEnd) };
  }
  const lcpEl = lcpE && lcpE.element;
  const lsL = ((await obs('layout-shift')) || []).filter((e) => !e.hadRecentInput);
  const isUnattributed = (e) => e.sources.length > 0 && e.sources.every((s) => !s.node || inForeign(s.node));
  const clsOf = (list) => {
    let cur = 0, curE = [], best = 0, bestE = [];
    for (const e of list) {
      const first = curE[0], last = curE[curE.length - 1];
      if (cur && e.startTime - last.startTime < 1000 && e.startTime - first.startTime < 5000) { cur += e.value; curE.push(e); } else { cur = e.value; curE = [e]; }
      if (cur > best) { best = cur; bestE = curE.slice(); }
    }
    return { value: Math.round(best * 1000) / 1000, entries: bestE };
  };
  const clsAll = clsOf(lsL);
  const clsPage = clsOf(lsL.filter((e) => !isUnattributed(e)));
  const biggest = clsPage.entries.slice().sort((a, b) => b.value - a.value)[0];
  const shiftSources = biggest ? biggest.sources.map((s) => (s.node && s.node.nodeType === 1 ? describe(s.node) : s.node ? '#text in ' + describe(s.node.parentElement) : '(node null)') + ' y' + Math.round(s.previousRect.y) + '->' + Math.round(s.currentRect.y)) : [];
  const evL = (await obs('event', { durationThreshold: 16 })) || [];
  const byId = new Map();
  for (const e of evL) {
    if (!e.interactionId) continue;
    const g = byId.get(e.interactionId);
    if (!g || e.duration > g.duration) byId.set(e.interactionId, e);
  }
  const top = [...byId.values()].sort((a, b) => b.duration - a.duration).slice(0, 10);
  const inpE = top.length ? top[Math.min(top.length - 1, Math.floor((performance.interactionCount || 0) / 50))] : null;
  const ltL = (await obs('longtask')) || [];
  const tbtStart = fcpE ? fcpE.startTime : 0, tbtEnd = performance.now();
  const tbt = ltL.reduce((s, e) => { const a = Math.max(e.startTime, tbtStart), b = Math.min(e.startTime + e.duration, tbtEnd); return s + Math.max(0, b - a - 50); }, 0);
  const loafL = (await obs('long-animation-frame')) || [];
  out.vitals = {
    visibility: visE.map((e) => e.name + '@' + Math.round(e.startTime)),
    hiddenBeforePaint: firstHidden !== Infinity,
    ttfb: ttfb == null ? null : Math.round(ttfb), fcp: fcp == null ? null : Math.round(fcp),
    lcp: lcp == null ? null : { ms: Math.round(lcp), el: describe(lcpEl), url: lcpE.url ? lcpE.url.slice(0, 80) : '', lazy: !!(lcpEl && lcpEl.loading === 'lazy'), fetchpriority: lcpEl ? lcpEl.getAttribute('fetchpriority') : null, breakdown: lcpBreakdown },
    cls: { webVitals: clsAll.value, excludingUnattributed: clsPage.value, largestShift: shiftSources.slice(0, MAX) },
    inp: inpE ? { ms: inpE.duration, event: inpE.name, target: describe(inpE.target), inputDelay: Math.round(inpE.processingStart - inpE.startTime), processing: Math.round(inpE.processingEnd - inpE.processingStart), presentation: Math.round(inpE.startTime + inpE.duration - inpE.processingEnd), note: '사후 관찰은 104ms 이상만 · Aside 탭은 표시 지연이 부풀려짐 → processing 을 믿어라' } : null,
    interactionCount: performance.interactionCount,
    tbtApprox: Math.round(tbt), longTasks: ltL.length,
    loafTop: loafL.slice().sort((a, b) => b.blockingDuration - a.blockingDuration).slice(0, 3).map((f) => ({ ms: Math.round(f.duration), blocking: Math.round(f.blockingDuration), scripts: (f.scripts || []).slice(0, 3).map((s) => (s.invoker || '') + ' ' + (s.sourceURL || '').replace(location.origin, '').slice(0, 60) + (s.sourceFunctionName ? ' ' + s.sourceFunctionName : '') + ' ' + Math.round(s.duration) + 'ms') })),
  };
  out.vitals.rating = { ttfb: rate(out.vitals.ttfb, [800, 1800]), fcp: rate(out.vitals.fcp, [1800, 3000]), lcp: rate(out.vitals.lcp && out.vitals.lcp.ms, [2500, 4000]), cls: rate(clsPage.value, [0.1, 0.25]), inp: rate(inpE && inpE.duration, [200, 500]), tbt: rate(out.vitals.tbtApprox, [200, 600]) };

  /* 2. 성능 진단(Lighthouse 진단·인사이트 대응) */
  const res = performance.getEntriesByType('resource');
  const byOrigin = {};
  for (const r of res) { let o; try { o = new URL(r.name).origin; } catch (e) { continue; } if (o === location.origin) continue; const b = byOrigin[o] || (byOrigin[o] = { n: 0, kb: 0 }); b.n++; b.kb += (r.transferSize || 0) / 1024; }
  let depth = 0, maxKids = 0;
  for (const e of document.getElementsByTagName('*')) { let d = 0; for (let p = e; p; p = p.parentElement) d++; if (d > depth) depth = d; if (e.childElementCount > maxKids) maxKids = e.childElementCount; }
  const dpr = devicePixelRatio >= 2 ? 2 : devicePixelRatio >= 1.5 ? 1.5 : 1;
  const imgs = [...document.images].filter((i) => !inForeign(i));
  const shownImgs = imgs.filter((i) => i.naturalWidth && visible(i));
  const rasterImgs = shownImgs.filter((i) => !/^data:image\/svg|\.svg(\?|#|$)/i.test(i.currentSrc || i.src));
  const animProps = (a) => { try { return [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)); } catch (e) { return []; } };
  const anims = document.getAnimations ? document.getAnimations() : [];
  out.perf2 = {
    renderBlocking: sample(res.filter((r) => r.renderBlockingStatus === 'blocking'), (r) => r.name.replace(location.origin, '').slice(0, 80)),
    protocols: res.reduce((m, r) => { const k = r.nextHopProtocol || '(교차출처 비공개)'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    uncompressed: sample(res.filter((r) => /script|css|link|fetch|xmlhttprequest/.test(r.initiatorType) && r.encodedBodySize > 1400 && r.encodedBodySize === r.decodedBodySize), (r) => Math.round(r.decodedBodySize / 1024) + 'KB ' + r.name.replace(location.origin, '').slice(0, 70)),
    document: nav ? { status: nav.responseStatus, protocol: nav.nextHopProtocol, redirects: nav.redirectCount, serverMs: Math.round(nav.responseStart - nav.requestStart), compressed: nav.encodedBodySize < nav.decodedBodySize, kb: Math.round(nav.decodedBodySize / 1024) } : null,
    cacheHits: res.filter((r) => r.transferSize === 0 && r.decodedBodySize > 0).length,
    thirdParty: Object.entries(byOrigin).sort((a, b) => b[1].kb - a[1].kb).slice(0, MAX).map(([o, v]) => o + ' ' + v.n + '건 ' + Math.round(v.kb) + 'KB'),
    dom: { nodes: document.getElementsByTagName('*').length, maxDepth: depth, maxChildren: maxKids, lighthouseWarn: '노드 >1400 · 깊이 >32 · 자식 >60' },
    unsizedImages: sample(imgs.filter((i) => { const cs = getComputedStyle(i); if (cs.position === 'fixed' || cs.position === 'absolute') return false; const r = i.getBoundingClientRect(); if (!r.width && !r.height) return false; if (/^data:image\/svg/.test(i.src)) return false; const w = i.hasAttribute('width') || !!i.style.width, h = i.hasAttribute('height') || !!i.style.height, ar = cs.aspectRatio && cs.aspectRatio !== 'auto'; return !((w && h) || (w && ar) || (h && ar)); })),
    oversizedImages: sample(rasterImgs.filter((i) => { const r = i.getBoundingClientRect(); const d = devicePixelRatio; return i.naturalWidth * i.naturalHeight > (r.width * d * 1.5) * (r.height * d * 1.5) && i.naturalWidth > 200; }), (i) => i.naturalWidth + 'x' + i.naturalHeight + '→' + Math.round(i.getBoundingClientRect().width) + 'x' + Math.round(i.getBoundingClientRect().height) + ' ' + describe(i)),
    blurryImages: sample(rasterImgs.filter((i) => { const r = i.getBoundingClientRect(); const f = r.width > 64 || r.height > 64 ? 0.75 : 1; return i.naturalWidth < Math.ceil(f * dpr * r.width) || i.naturalHeight < Math.ceil(f * dpr * r.height); }), (i) => i.naturalWidth + 'x' + i.naturalHeight + ' < ' + Math.round(i.getBoundingClientRect().width * dpr) + 'x' + Math.round(i.getBoundingClientRect().height * dpr) + ' ' + describe(i)),
    lazyAboveFold: sample(imgs.filter((i) => i.loading === 'lazy' && i.getBoundingClientRect().top < vh)),
    nonCompositedAnimations: sample(anims.filter((a) => a.effect && a.effect.target && animProps(a).some((p) => !['transform', 'opacity', 'filter', 'translate', 'scale', 'rotate'].includes(p))), (a) => describe(a.effect.target) + ' [' + animProps(a).join(',') + ']'),
    userTimings: performance.getEntriesByType('mark').length + ' marks / ' + performance.getEntriesByType('measure').length + ' measures',
  };

  /* 3. CSS 결함 */
  const rules = [], blockedSheets = [];
  const walk = (list, media) => { for (const r of list) { if (r.cssRules && !(r instanceof CSSStyleRule)) walk(r.cssRules, r.conditionText || media); if (r.style) rules.push({ r, media }); } };
  for (const s of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) { try { walk(s.cssRules, ''); } catch (e) { blockedSheets.push(s.href); } }
  const vhRules = [];
  for (const { r } of rules) for (const p of ['height', 'min-height', 'max-height']) { const v = r.style.getPropertyValue(p); if (/\b100vh\b/.test(v) && r.selectorText) { let n = 0; try { n = document.querySelectorAll(r.selectorText).length; } catch (e) {} vhRules.push(r.selectorText.slice(0, 50) + ' {' + p + ':' + v + '} 적용 ' + n); } }
  for (const e of document.querySelectorAll('[style*="100vh"]')) vhRules.push('inline ' + describe(e));
  const fontFaces = rules.filter(({ r }) => r instanceof CSSFontFaceRule).map(({ r }) => r.style.getPropertyValue('font-family').replace(/["']/g, '') + ' display=' + (r.style.getPropertyValue('font-display') || 'auto'));
  const reducedMotionCss = rules.some(({ media }) => /prefers-reduced-motion/.test(media || ''));
  const modalOpen = [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]')].some(visible);
  const lockedBy = [de, document.body].filter((e) => /hidden|clip/.test(getComputedStyle(e).overflowY) || getComputedStyle(e).position === 'fixed').map((e) => e.tagName.toLowerCase());
  const stackingAncestor = (el) => { for (let p = el.parentElement; p && p !== de; p = p.parentElement) { const c = getComputedStyle(p); if (c.transform !== 'none' || c.filter !== 'none' || c.perspective !== 'none' || c.backdropFilter !== 'none' || /paint|layout|strict|content/.test(c.contain) || /transform|filter|perspective/.test(c.willChange) || (c.containerType && c.containerType !== 'normal')) return p; } return null; };
  const scrollParent = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== de; p = p.parentElement) { if (getComputedStyle(p).overflowY !== 'visible' || getComputedStyle(p).overflowX !== 'visible') return p; } return null; };
  const textLeaves = all.filter((e) => hasOwnText(e) && visible(e)).slice(0, 600);
  const clipRect = (el) => { let r = el.getBoundingClientRect(); let L0 = r.left, T0 = r.top, R0 = r.right, B0 = r.bottom; for (let p = el.parentElement; p && p !== de; p = p.parentElement) { const c = getComputedStyle(p); if (c.overflowX !== 'visible' || c.overflowY !== 'visible') { const q = p.getBoundingClientRect(); L0 = Math.max(L0, q.left); T0 = Math.max(T0, q.top); R0 = Math.min(R0, q.right); B0 = Math.min(B0, q.bottom); } if (c.position === 'fixed') break; } return { left: L0, top: T0, right: R0, bottom: B0, width: Math.max(0, R0 - L0), height: Math.max(0, B0 - T0) }; };
  const overlaps = [];
  for (let i = 0; i < textLeaves.length && overlaps.length < 20; i++) {
    const a = textLeaves[i], ra = clipRect(a);
    if (!ra.width || !ra.height) continue;
    for (let j = i + 1; j < textLeaves.length; j++) {
      const b = textLeaves[j];
      if (a.contains(b) || b.contains(a)) continue;
      const rb = clipRect(b);
      if (!rb.width || !rb.height) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2 && w * h > 0.3 * Math.min(ra.width * ra.height, rb.width * rb.height)) overlaps.push(describe(a) + ' ⨯ ' + describe(b));
    }
  }
  const clippedSet = () => new Set(textLeaves.filter((e) => { const c = getComputedStyle(e); return (e.scrollHeight > e.clientHeight + 1 && /hidden|clip/.test(c.overflowY)) || (e.scrollWidth > e.clientWidth + 1 && /hidden|clip/.test(c.overflowX)); }));
  out.css2 = {
    blockedSheets: blockedSheets.map((h) => String(h).slice(0, 80)),
    vh100: vhRules.slice(0, MAX),
    fontFaces: fontFaces.slice(0, MAX),
    fontFoitRisk: fontFaces.filter((f) => /display=(auto|block)$/.test(f)).length,
    reducedMotionCss,
    scrollLockWithoutModal: lockedBy.length && !modalOpen && de.scrollHeight > de.clientHeight ? lockedBy : false,
    overflowBeyondClientWidth: sample(all.filter((e) => { if (!visible(e)) return false; const r = e.getBoundingClientRect(); return r.right > cw + 1 && getComputedStyle(e).position !== 'fixed'; })),
    textSpillsOut: sample(textLeaves.filter((e) => { const c = getComputedStyle(e); return c.display !== 'inline' && e.clientWidth > 0 && c.overflowX === 'visible' && e.scrollWidth > e.clientWidth + 1; }), (e) => describe(e) + ' +' + (e.scrollWidth - e.clientWidth) + 'px'),
    textOverlap: { count: overlaps.length, samples: overlaps.slice(0, MAX) },
    zIndexNoEffect: sample(all.filter((e) => { const c = getComputedStyle(e); if (c.zIndex === 'auto' || c.position !== 'static') return false; const pd = e.parentElement ? getComputedStyle(e.parentElement).display : ''; return !/flex|grid/.test(pd); }), (e) => 'z=' + getComputedStyle(e).zIndex + ' ' + describe(e)),
    fixedTrappedByAncestor: sample(all.filter((e) => getComputedStyle(e).position === 'fixed' && stackingAncestor(e)), (e) => describe(e) + ' ← ' + describe(stackingAncestor(e))),
    stickyBroken: sample(all.filter((e) => { const c = getComputedStyle(e); if (c.position !== 'sticky') return false; if (c.top === 'auto' && c.bottom === 'auto' && c.left === 'auto' && c.right === 'auto') return true; const sp = scrollParent(e); return !!sp && sp.scrollHeight <= sp.clientHeight + 1 && sp.scrollWidth <= sp.clientWidth + 1; })),
    distortedImages: sample(shownImgs.filter((i) => { if (getComputedStyle(i).objectFit !== 'fill') return false; const r = i.getBoundingClientRect(); const want = i.naturalWidth / i.naturalHeight; return Math.abs(r.height * want - r.width) >= 2 && Math.abs(r.width / want - r.height) >= 2; }), (i) => 'natural ' + i.naturalWidth + 'x' + i.naturalHeight + ' shown ' + Math.round(i.getBoundingClientRect().width) + 'x' + Math.round(i.getBoundingClientRect().height) + ' ' + describe(i)),
    infiniteAnimations: sample(anims.filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity && a.effect.target && visible(a.effect.target)), (a) => describe(a.effect.target)),
    duplicateIds: (() => { const m = {}; for (const e of document.querySelectorAll('[id]')) m[e.id] = (m[e.id] || 0) + 1; return Object.entries(m).filter(([, n]) => n > 1).slice(0, MAX).map(([k, n]) => k + ' x' + n); })(),
    scrollContainers: all.filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).length,
  };
  /* 3-b. 포커스 표시(2.4.7)·포커스 가림(2.4.11) — 실제로 focus 해 본다, 끝나면 복원 */
  const prevFocus = document.activeElement, sx = scrollX, sy = scrollY;
  const snapStyle = (e) => { const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.borderBottomWidth, c.backgroundColor, c.color, c.textDecorationLine].join('|'); };
  const focusables = all.filter((e) => e.matches('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"])') && !e.disabled && visible(e)).slice(0, 60);
  const noIndicator = [], obscured = [];
  let focusVisibleMatched = 0;
  for (const e of focusables) {
    const before = snapStyle(e);
    e.focus({ preventScroll: false });
    if (document.activeElement !== e) continue;
    if (e.matches(':focus-visible')) focusVisibleMatched++;
    if (snapStyle(e) === before) noIndicator.push(e);
    const r = e.getBoundingClientRect();
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]].filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < vh);
    if (pts.length && pts.every(([x, y]) => { const t = document.elementFromPoint(x, y); return t && t !== e && !e.contains(t) && !t.contains(e) && !(t.closest('label') && t.closest('label').contains(e)); })) obscured.push(e);
    e.blur();
  }
  if (prevFocus && prevFocus !== document.body && prevFocus.focus) prevFocus.focus({ preventScroll: true });
  scrollTo(sx, sy);
  out.css2.focus = { tested: focusables.length, focusVisibleMatched, noIndicator: sample(noIndicator), obscured: sample(obscured) };
  /* 3-c. 텍스트 간격(1.4.12) — 간격 CSS 를 잠깐 적용하고 새로 잘리는 요소를 센다 */
  try {
    const before = clippedSet();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}');
    const prevSheets = [...document.adoptedStyleSheets]; /* 살아있는 배열이라 복사해야 복원된다 */
    document.adoptedStyleSheets = [...prevSheets, sheet];
    const after = clippedSet();
    document.adoptedStyleSheets = prevSheets;
    out.css2.textSpacingNewlyClipped = sample([...after].filter((e) => !before.has(e)));
  } catch (e) { out.css2.textSpacingNewlyClipped = '오류 ' + e.message; }

  /* 4. SEO */
  const meta = (n) => { const m = document.querySelector('meta[name="' + n + '" i]'); return m ? m.content : null; };
  const lang = (de.lang || navigator.language || 'en').slice(0, 2);
  const BAD_LINK = { en: ['click here', 'click this', 'go', 'here', 'information', 'learn more', 'more', 'more info', 'more information', 'right here', 'read more', 'see more', 'start', 'this'], ko: ['여기', '여기를 클릭', '클릭', '링크', '자세히', '자세히 보기', '계속', '이동', '전체 보기'] };
  const badSet = new Set([...(BAD_LINK[lang] || []), ...BAD_LINK.en, ...BAD_LINK.ko]);
  const anchors = [...document.querySelectorAll('a')].filter((a) => !inForeign(a));
  const uncrawlable = anchors.filter((a) => { const raw = (a.getAttribute('href') || '').replace(/\s/g, ''); if (a.getAttribute('role')) return false; if (raw.startsWith('mailto:')) return false; if (raw === '' && a.id) return false; if (raw.startsWith('file:')) return true; if (a.getAttribute('name')) return false; if (!a.hasAttribute('href')) return !!a.onclick; return raw === '' || /javascript:void(\(|)0(\)|)/.test(raw); });
  let robots = null;
  try { const rt = await fetch('/robots.txt', { cache: 'no-store' }); const txt = rt.ok ? await rt.text() : ''; robots = { status: rt.status, disallowAll: /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(txt) }; } catch (e) { robots = '오류'; }
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { const j = JSON.parse(s.textContent); return 'ok ' + [].concat(j).map((x) => x && x['@type']).join(','); } catch (e) { return 'JSON 오류'; } });
  const hreflangs = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => l.hreflang);
  const canon = [...document.querySelectorAll('link[rel="canonical"]')];
  out.seo = {
    httpStatus: nav ? nav.responseStatus : null,
    titleLength: document.title.length,
    metaDescription: meta('description') ? meta('description').length + '자' : '(없음)',
    robotsMeta: meta('robots'),
    noindex: /noindex/i.test(meta('robots') || ''),
    canonical: canon.length === 0 ? '(없음)' : canon.length > 1 ? '여러 개 ' + canon.length : canon[0].href + (canon[0].getAttribute('href').startsWith('http') ? '' : ' (상대경로)'),
    hreflangInvalid: hreflangs.filter((h) => !/^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*|x-default)$/i.test(h)),
    vagueLinkText: sample(anchors.filter((a) => a.hasAttribute('href') && badSet.has((a.innerText || '').trim().toLowerCase()))),
    uncrawlableAnchors: sample(uncrawlable),
    robotsTxt: robots,
    structuredData: ld,
    ogTags: ['og:title', 'og:description', 'og:image'].filter((p) => !document.querySelector('meta[property="' + p + '"]')).map((p) => p + ' 없음'),
  };

  /* 5. 모범 사례 */
  const pasteBlocked = [];
  for (const i of [...document.querySelectorAll('input:not([type=hidden]):not([readonly]), textarea')].filter((x) => !inForeign(x) && !x.disabled).slice(0, 30)) {
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    i.dispatchEvent(ev);
    if (ev.defaultPrevented) pasteBlocked.push(i);
  }
  out.bestPractices = {
    doctype: document.doctype ? document.doctype.name + (document.doctype.publicId ? ' (public ' + document.doctype.publicId.slice(0, 30) + ')' : '') : '(없음)',
    compatMode: document.compatMode,
    charset: document.characterSet,
    pasteBlockedInputs: sample(pasteBlocked, (e) => describe(e) + ' type=' + e.type),
    passwordAutocompleteOff: [...document.querySelectorAll('input[type=password]')].filter((i) => i.autocomplete === 'off').length,
    libraries: [window.jQuery && window.jQuery.fn ? 'jQuery ' + window.jQuery.fn.jquery : null, document.querySelector('[data-reactroot]') || [...document.querySelectorAll('body, body > *')].some((e) => Object.keys(e).some((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'))) ? 'React' : null, window.__VUE__ || document.querySelector('[data-v-app]') ? 'Vue' : null, document.querySelector('[ng-version]') ? 'Angular ' + document.querySelector('[ng-version]').getAttribute('ng-version') : null, window.__NEXT_DATA__ ? 'Next.js' : null, document.querySelector('script[src*="/@vite/client"]') ? 'Vite dev' : null].filter(Boolean),
    permissions: await (async () => { const o = {}; for (const n of ['geolocation', 'notifications']) { try { o[n] = (await navigator.permissions.query({ name: n })).state; } catch (e) { o[n] = '조회 불가'; } } return o; })(),
  };

  /* 6. 보안 */
  let headers = null;
  try {
    const h = await fetch(location.href, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
    const g = (k) => h.headers.get(k);
    const csp = g('content-security-policy') || '';
    const scriptSrc = (csp.match(/script-src[^;]*/) || csp.match(/default-src[^;]*/) || [''])[0];
    const hsts = g('strict-transport-security') || '';
    const maxAge = Number((hsts.match(/max-age=(\d+)/) || [0, 0])[1]);
    headers = {
      status: h.status,
      csp: csp ? { present: true, unsafeInline: /'unsafe-inline'/.test(scriptSrc) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(scriptSrc), unsafeEval: /'unsafe-eval'/.test(scriptSrc), objectSrcNone: /object-src\s+'none'/.test(csp), baseUri: /base-uri/.test(csp), frameAncestors: (csp.match(/frame-ancestors[^;]*/) || [null])[0] } : '(없음)',
      cspReportOnly: !!g('content-security-policy-report-only'),
      hsts: hsts ? { maxAge, oneYear: maxAge >= 31536000, includeSubDomains: /includesubdomains/i.test(hsts), preload: /preload/i.test(hsts) } : '(없음)',
      xFrameOptions: g('x-frame-options'),
      clickjackingProtected: !!g('x-frame-options') || /frame-ancestors/.test(csp),
      xContentTypeOptions: g('x-content-type-options'),
      referrerPolicy: g('referrer-policy'),
      permissionsPolicy: g('permissions-policy') ? 'present' : '(없음)',
      coop: g('cross-origin-opener-policy'),
      corp: g('cross-origin-resource-policy'),
      xRobotsTag: g('x-robots-tag'),
      serverBanner: [g('server'), g('x-powered-by')].filter(Boolean).join(' / '),
    };
  } catch (e) { headers = '오류 ' + e.message; }
  const httpAttr = [...document.querySelectorAll('[src^="http:"],[href^="http:"],[srcset*="http:"],[data^="http:"],[poster^="http:"],form[action^="http:"]')].filter((e) => !inForeign(e) && !(e.tagName === 'A'));
  const cssHttp = rules.filter(({ r }) => /url\(\s*["']?http:/.test(r.cssText || '')).map(({ r }) => (r.selectorText || '@font-face').slice(0, 40));
  let cookies = '미지원';
  try { cookies = (await cookieStore.getAll()).map((c) => c.name + (c.secure ? '' : ' [secure 없음]') + (c.sameSite === 'none' && !c.secure ? ' [SameSite=None 인데 secure 없음]' : '') + ' sameSite=' + c.sameSite); } catch (e) {}
  out.security2 = {
    headers,
    mixedContentDom: sample(httpAttr, (e) => describe(e) + ' ' + (e.getAttribute('src') || e.getAttribute('href') || e.getAttribute('action') || '').slice(0, 60)),
    mixedContentCss: cssHttp.slice(0, MAX),
    crossOriginNoSri: sample([...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')].filter((e) => { try { return new URL(e.src || e.href).origin !== location.origin && !e.integrity; } catch (x) { return false; } }), (e) => (e.src || e.href).slice(0, 80)),
    targetBlankNoRel: anchors.filter((a) => a.target === '_blank' && !/noopener|noreferrer/.test(a.rel)).length,
    crossOriginIframesNoSandbox: [...document.querySelectorAll('iframe[src]')].filter((f) => { try { return new URL(f.src).origin !== location.origin && !f.hasAttribute('sandbox'); } catch (x) { return false; } }).length,
    inlineEventHandlers: all.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
    cookiesVisibleToJs: cookies,
  };
  return out;
})()
