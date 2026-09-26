// webcheck (R5 수정안) — 페이지 안에서 한 번 돌려 웹 표준 점검 결과를 객체로 돌려준다(의존 0, 읽기 전용).
// 사용: const r = await page.evaluate(WEBCHECK_SOURCE)
// R5 수정 요지: 보임 판정(checkVisibility·조상 opacity·1px sr-only) · 렌더 안 되는 요소 제외(display:none 조상·option·display:contents)
//   · 대비는 canvas 로 색을 sRGB 로 환산(color-mix·oklch·color()) + 반투명 합성 + 배경 없을 때 color-scheme 캔버스 색 + 가상 요소
//   · 스크롤/클립 상자 안 넘침·가림 제외 + 안쪽 가로 스크롤 목록 추가 · line-clamp 세로 잘림 · CLS 는 세션 창 방식
//   · 이름 계산에 자손 img alt·aria-label·svg title 포함(정본은 Aside snapshot) · zoomHint 해석 제거(원값만)
(async () => {
  const MAX = 8;
  const vw = innerWidth, vh = innerHeight;
  const de = document.documentElement;
  const out = { url: location.href.replace(/[?#].*$/, ''), viewport: { w: vw, h: vh, dpr: devicePixelRatio } };
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  // 렌더되는가(상자가 있는가) — display:none 조상·option·display:contents 는 false
  const rendered = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  // 사람 눈에 보이는가 — 조상 opacity·visibility·content-visibility + 2px 미만(sr-only) + clip rect(0 0 0 0)
  const visible = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) <= 0.05) return false;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return false;
    return true;
  };
  // 넘침을 가두는 조상(스크롤·클립 상자)
  const clipAncestor = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== de; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return p; } return null; };
  const pointClipped = (el, x, y) => { for (let p = el.parentElement; p && p !== de; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue; const r = p.getBoundingClientRect(); if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true; } return false; };
  const inFixed = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true; return false; };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const all = [...document.querySelectorAll('body *')];

  // ── 환경 오염 ──
  const drOn = !!(document.querySelector('style.darkreader, meta[name="darkreader"]') || de.hasAttribute('data-darkreader-mode') || de.hasAttribute('data-darkreader-scheme'));
  out.env = {
    darkReader: drOn,
    darkReaderHint: drOn ? '색·대비 결과 무효 — 자기 탭에 <meta name="darkreader-lock"> 를 넣고 다시 돌려라' : undefined,
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    window: { outerW: outerWidth, innerW: innerWidth, screenW: screen.width }, // 🔴 배율로 해석하지 마라(R5 D1)
    lang: navigator.language,
  };

  // ── 성능 ──
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const observe = (type) => new Promise((res) => {
    const got = [];
    try { const po = new PerformanceObserver((l) => got.push(...l.getEntries())); po.observe({ type, buffered: true }); setTimeout(() => { po.disconnect(); res(got); }, 50); } catch { res(null); }
  });
  const lcp = await observe('largest-contentful-paint');
  const shifts = await observe('layout-shift');
  const lt = await observe('longtask');
  const res = performance.getEntriesByType('resource');
  const clsOf = (list) => { let max = 0, cur = 0, start = 0, prevT = 0; for (const e of list) { if (e.hadRecentInput) continue; if (cur && e.startTime - prevT < 1000 && e.startTime - start < 5000) cur += e.value; else { cur = e.value; start = e.startTime; } prevT = e.startTime; max = Math.max(max, cur); } return Math.round(max * 1000) / 1000; };
  out.perf = {
    ttfb: nav ? Math.round(nav.responseStart) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    fcp: paints['first-contentful-paint'] ?? null,
    lcp: lcp && lcp.length ? { ms: Math.round(lcp[lcp.length - 1].startTime), el: describe(lcp[lcp.length - 1].element) } : null,
    cls: shifts ? clsOf(shifts) : null,
    longTasks: lt ? { count: lt.length, maxMs: Math.round(Math.max(0, ...lt.map((e) => e.duration))) } : '미지원',
    resources: {
      count: res.length,
      bufferFull: res.length === 250 ? '🔴 기본 상한 250 에 닿았다 — 이후 요청은 안 보인다(기록기가 setResourceTimingBufferSize 를 올려야 함)' : undefined,
      transferKB: Math.round(res.reduce((s, e) => s + (e.transferSize || 0), 0) / 1024),
      failed: res.filter((e) => e.responseStatus >= 400).map((e) => e.responseStatus + ' ' + e.initiatorType + ' ' + e.name.replace(location.origin, '')).slice(0, MAX),
    },
    slowest: res.slice().sort((a, b) => b.duration - a.duration).slice(0, 5).map((e) => Math.round(e.duration) + 'ms ' + e.name.replace(location.origin, '').slice(0, 70)),
    memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : '미지원',
    domNodes: document.getElementsByTagName('*').length,
  };

  // ── 색: canvas 로 어떤 CSS 색이든 sRGB 로 ──
  const cctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = 'rgba(0,0,0,0)'; cctx.fillStyle = c; cctx.fillRect(0, 0, 1, 1); const d = cctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lumOf = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const schemeDecl = (() => { const cs = getComputedStyle(de).colorScheme; const m = document.querySelector('meta[name="color-scheme"]'); return cs && cs !== 'normal' ? cs : (m ? m.content : 'normal'); })();
  const canvasDark = /dark/.test(schemeDecl) && (!/light/.test(schemeDecl) || matchMedia('(prefers-color-scheme: dark)').matches);
  const CANVAS = canvasDark ? [18, 18, 18, 1] : [255, 255, 255, 1];
  const bgOf = (el) => { const layers = []; let img = false; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage !== 'none') img = true; const c = rgba(cs.backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; } } let bg = CANVAS; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg); return { bg, img }; };
  const ratioOf = (fgColor, el) => { const f = rgba(fgColor); if (f[3] === 0) return null; const { bg, img } = bgOf(el); const fg = f[3] < 1 ? over(f, bg) : f; const a = lumOf(fg), b = lumOf(bg); return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), img }; };
  const bigText = (cs) => parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);

  // ── 접근성 ──
  const nameOf = (el) => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && el.getAttribute('aria-labelledby').split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ')) || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.value || el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt') || el.querySelector('[aria-label]')?.getAttribute('aria-label') || el.querySelector('svg title')?.textContent || '').trim();
  const imgs = [...document.images];
  const fields = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(visible);
  const unlabeled = fields.filter((f) => !(f.labels && f.labels.length) && !f.getAttribute('aria-label') && !f.getAttribute('aria-labelledby') && !f.getAttribute('title'));
  const btns = [...document.querySelectorAll('button, [role=button], a[href]')].filter(visible);
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map((h) => Number(h.tagName[1]));
  const lowContrast = []; let lowCount = 0; const onImage = [];
  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const checks = [];
    if (hasOwnText(el)) checks.push([cs.color, cs, '']);
    for (const pe of ['::before', '::after']) { const ps = getComputedStyle(el, pe); if (/^["']./.test(ps.content)) checks.push([ps.color, ps, pe]); }
    for (const [color, s, pe] of checks) {
      const r = ratioOf(color, el); if (!r) continue;
      if (r.ratio < (bigText(s) ? 3 : 4.5)) { if (r.img) { if (onImage.length < MAX) onImage.push(Math.round(r.ratio * 100) / 100 + ' ' + describe(el) + pe); continue; } lowCount++; if (lowContrast.length < 40) lowContrast.push(Math.round(r.ratio * 100) / 100 + ' ' + describe(el) + pe); }
    }
  }
  const focusables = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true], summary')].filter((e) => !e.disabled && e.tabIndex >= 0);
  out.a11y = {
    docLang: de.lang || '(없음)',
    title: document.title,
    imgNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).map(describe).slice(0, MAX),
    fieldsNoLabel: unlabeled.map(describe).slice(0, MAX),
    controlsNoName: btns.filter((b) => !nameOf(b)).map(describe).slice(0, MAX),
    controlsNoNameNote: '정본은 Aside snapshot(접근성 트리) — 여기 목록은 후보',
    headings: heads.join(','),
    headingLevelJumps: heads.filter((lv, i) => i > 0 && lv - heads[i - 1] > 1).length,
    h1Count: heads.filter((l) => l === 1).length,
    lowContrast: { count: lowCount, samples: lowContrast.slice(0, MAX), onBackgroundImage: onImage, canvas: canvasDark ? 'dark' : 'light' },
    // Tab 으로 실제로 갈 수 있는데(렌더됨) 눈에는 안 보이는 것 — display:none 조상 안 요소는 Tab 불가라 제외
    focusableHidden: focusables.filter((e) => rendered(e) && !visible(e) && !e.closest('[aria-hidden=true],[inert]')).map((e) => describe(e) + (e.matches('a[href^="#"]') ? ' (건너뛰기 링크일 수 있음)' : '')).slice(0, MAX),
    pointerNotButton: all.filter((e) => visible(e) && getComputedStyle(e).cursor === 'pointer' && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer') && !e.closest('a,button,[role=button],label,summary,input,select,[role=menuitem],[role=tab],[role=option],[role=link],[role=checkbox],[role=switch]')).map(describe).slice(0, MAX),
  };

  // ── CSS · 레이아웃 ──
  const se = document.scrollingElement || de;
  const overflowX = all.filter((e) => { if (!visible(e)) return false; const r = e.getBoundingClientRect(); if (r.right <= vw + 1) return false; const cs = getComputedStyle(e); if (cs.position === 'fixed' || inFixed(e)) return false; return !clipAncestor(e); });
  const innerHScroll = all.filter((e) => { if (!visible(e)) return false; const o = getComputedStyle(e).overflowX; return (o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth + 1; });
  const clipped = all.filter((e) => { if (!visible(e) || !e.innerText || !e.innerText.trim()) return false; const cs = getComputedStyle(e); const h = e.scrollWidth > e.clientWidth + 1 && (cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden'); const v = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && e.scrollHeight > e.clientHeight + 1; return h || v; });
  const interactive = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button]')].filter(visible);
  const covered = [];
  for (const e of interactive) { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < 0 || y < 0 || x > vw || y > vh) continue; if (pointClipped(e, x, y)) continue; const top = document.elementFromPoint(x, y); if (top && top !== e && !e.contains(top) && !top.contains(e) && !(e.labels && [...e.labels].some((l) => l.contains(top)))) covered.push(describe(e) + ' ← ' + describe(top)); }
  const tiny = interactive.filter((e) => { const r = e.getBoundingClientRect(); if (r.width >= 24 && r.height >= 24) return false; return !(e.matches('a') && e.parentElement && /^(P|LI|TD|SPAN)$/.test(e.parentElement.tagName) && getComputedStyle(e).display === 'inline'); });
  const smallText = all.filter((e) => visible(e) && hasOwnText(e) && parseFloat(getComputedStyle(e).fontSize) < 12);
  out.css = {
    pageHorizontalScroll: se.scrollWidth > se.clientWidth ? se.scrollWidth - se.clientWidth + 'px' : false,
    overflowRight: overflowX.map(describe).slice(0, MAX),
    innerHorizontalScroll: innerHScroll.map((e) => (e.scrollWidth - e.clientWidth) + 'px ' + describe(e)).slice(0, MAX),
    textClipped: { count: clipped.length, samples: clipped.map(describe).slice(0, MAX) },
    coveredControls: covered.slice(0, MAX),
    smallTargets: { count: tiny.length, samples: tiny.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + describe(e); }).slice(0, MAX) },
    smallText: { count: smallText.length, samples: smallText.map((e) => getComputedStyle(e).fontSize + ' ' + describe(e)).slice(0, MAX) },
    brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map((i) => i.getAttribute('src').slice(0, 80)).slice(0, MAX),
    fonts: { status: document.fonts.status, loaded: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))].slice(0, MAX), failed: [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family) },
    // 렌더되는데 크기 0 — display:none 조상·option·display:contents 는 제외
    zeroSizeWithText: all.filter((e) => { if (!rendered(e) || /^(OPTION|OPTGROUP)$/.test(e.tagName)) return false; const cs = getComputedStyle(e); if (cs.display === 'contents' || cs.position === 'absolute' || cs.position === 'fixed') return false; const r = e.getBoundingClientRect(); return (r.width === 0 || r.height === 0) && e.innerText && e.innerText.trim(); }).map(describe).slice(0, MAX),
  };

  // ── 저장소 ──
  const size = (s) => Object.keys(s).reduce((n, k) => n + k.length + (s.getItem(k) || '').length, 0);
  let idb = '미지원';
  try { idb = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : '미지원'; } catch (e) { idb = '오류 ' + e.message; }
  let sw = '미지원';
  try { sw = navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope) : '미지원'; } catch (e) { sw = '오류'; }
  let cacheKeys = '미지원';
  try { cacheKeys = self.caches ? await caches.keys() : '미지원'; } catch (e) { cacheKeys = '오류'; }
  out.storage = { localKeys: Object.keys(localStorage), localBytes: size(localStorage), sessionKeys: Object.keys(sessionStorage), cookieNames: document.cookie ? document.cookie.split(';').map((c) => c.split('=')[0].trim()) : [], indexedDB: idb, serviceWorkers: sw, cacheStorage: cacheKeys };

  // ── 메타 · 보안 ──
  const meta = (n) => document.querySelector('meta[name="' + n + '"]')?.content ?? null;
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
  out.meta = { charset: document.characterSet, viewport: meta('viewport'), description: meta('description'), colorSchemeMeta: meta('color-scheme'), colorSchemeUsed: schemeDecl, themeColor: meta('theme-color'), manifest: document.querySelector('link[rel=manifest]')?.href ?? null, favicon: document.querySelector('link[rel~=icon]')?.href ?? null, canonical: document.querySelector('link[rel=canonical]')?.href ?? null };
  out.security = {
    https: location.protocol === 'https:',
    mixedContent: res.filter((e) => e.name.startsWith('http:')).map((e) => e.name).slice(0, MAX),
    thirdPartyScripts: [...new Set(scripts.filter((s) => { try { return new URL(s).origin !== location.origin; } catch { return false; } }).map((s) => new URL(s).origin))],
    cspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
    cspNote: '응답 헤더 CSP 는 여기서 안 보인다 — 필요하면 repl 의 fetch(location.href,{method:"HEAD"}) 헤더로',
    formsOverHttp: [...document.forms].filter((f) => f.action && f.action.startsWith('http:')).length,
    passwordAutocomplete: [...document.querySelectorAll('input[type=password]')].map((i) => i.getAttribute('autocomplete')),
  };
  out.diag = window.__diag && window.__diag.summary ? (({ counts, pendingRequests, problems, failedRequests, firstProblems }) => ({ counts, pendingRequests, problems: problems.length, firstProblems: firstProblems ? firstProblems.length : '(v1)', failedRequests: failedRequests.length }))(window.__diag.summary()) : '기록기 없음';
  return out;
})()
