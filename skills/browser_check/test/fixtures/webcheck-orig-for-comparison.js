// webcheck — 페이지 안에서 한 번 돌려 웹 표준 점검 결과를 객체로 돌려준다(의존 0, 읽기 전용).
// 사용: const r = await page.evaluate(WEBCHECK_SOURCE)  — WEBCHECK_SOURCE 는 이 파일 전체 문자열(즉시 실행 식).
(async () => {
  const MAX = 8;
  const vw = innerWidth, vh = innerHeight;
  const out = { url: location.href, viewport: { w: vw, h: vh, dpr: devicePixelRatio } };
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const all = [...document.querySelectorAll('body *')];

  // ── 환경 오염 ──
  out.env = {
    darkReader: !!(document.querySelector('style.darkreader, meta[name="darkreader"]') || document.documentElement.hasAttribute('data-darkreader-mode') || document.documentElement.hasAttribute('data-darkreader-scheme')),
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    zoomHint: Math.round(outerWidth / innerWidth * 100) / 100,
    lang: navigator.language,
  };

  // ── 성능 ──
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const observe = (type) => new Promise((res) => {
    const got = [];
    try {
      const po = new PerformanceObserver((l) => got.push(...l.getEntries()));
      po.observe({ type, buffered: true });
      setTimeout(() => { po.disconnect(); res(got); }, 50);
    } catch { res(null); }
  });
  const lcp = await observe('largest-contentful-paint');
  const cls = await observe('layout-shift');
  const lt = await observe('longtask');
  const res = performance.getEntriesByType('resource');
  out.perf = {
    ttfb: nav ? Math.round(nav.responseStart) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    fcp: paints['first-contentful-paint'] ?? null,
    lcp: lcp && lcp.length ? { ms: Math.round(lcp[lcp.length - 1].startTime), el: describe(lcp[lcp.length - 1].element) } : null,
    cls: cls ? Math.round(cls.filter((e) => !e.hadRecentInput).reduce((s, e) => s + e.value, 0) * 1000) / 1000 : null,
    longTasks: lt ? { count: lt.length, maxMs: Math.round(Math.max(0, ...lt.map((e) => e.duration))) } : '미지원',
    resources: { count: res.length, transferKB: Math.round(res.reduce((s, e) => s + (e.transferSize || 0), 0) / 1024), failed: res.filter((e) => e.responseStatus >= 400).map((e) => e.responseStatus + ' ' + e.name.replace(location.origin, '')).slice(0, MAX) },
    slowest: res.slice().sort((a, b) => b.duration - a.duration).slice(0, 5).map((e) => Math.round(e.duration) + 'ms ' + e.name.replace(location.origin, '').slice(0, 70)),
    memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : '미지원',
    domNodes: document.getElementsByTagName('*').length,
  };

  // ── 접근성 ──
  const nameOf = (el) => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && el.getAttribute('aria-labelledby').split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ')) || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.value || '').trim();
  const imgs = [...document.images];
  const fields = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(visible);
  const unlabeled = fields.filter((f) => !(f.labels && f.labels.length) && !f.getAttribute('aria-label') && !f.getAttribute('aria-labelledby') && !f.getAttribute('title'));
  const btns = [...document.querySelectorAll('button, [role=button], a[href]')].filter(visible);
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map((h) => Number(h.tagName[1]));
  const headJumps = heads.filter((lv, i) => i > 0 && lv - heads[i - 1] > 1).length;
  const lum = (c) => { const m = c.match(/[\d.]+/g); if (!m) return null; const [r, g, b] = m.slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return { L: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] === undefined ? 1 : Number(m[3]) }; };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; const l = lum(b); if (l && l.a > 0.5) return b; } return 'rgb(255,255,255)'; };
  const lowContrast = [];
  for (const el of all) {
    if (lowContrast.length >= 40) break;
    if (!visible(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const fg = lum(cs.color), bg = lum(bgOf(el));
    if (!fg || !bg) continue;
    const ratio = (Math.max(fg.L, bg.L) + 0.05) / (Math.min(fg.L, bg.L) + 0.05);
    const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (big ? 3 : 4.5)) lowContrast.push(Math.round(ratio * 100) / 100 + ' ' + describe(el));
  }
  const focusables = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((e) => !e.disabled);
  out.a11y = {
    docLang: document.documentElement.lang || '(없음)',
    title: document.title,
    imgNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).map(describe).slice(0, MAX),
    fieldsNoLabel: unlabeled.map(describe).slice(0, MAX),
    controlsNoName: btns.filter((b) => !nameOf(b)).map(describe).slice(0, MAX),
    headings: heads.join(','),
    headingLevelJumps: headJumps,
    h1Count: heads.filter((l) => l === 1).length,
    lowContrast: { count: lowContrast.length, samples: lowContrast.slice(0, MAX) },
    focusableHidden: focusables.filter((e) => !visible(e) && e.tabIndex >= 0 && !e.closest('[aria-hidden=true],[inert]')).map(describe).slice(0, MAX),
    pointerNotButton: all.filter((e) => visible(e) && getComputedStyle(e).cursor === 'pointer' && !e.closest('a,button,[role=button],label,summary,input,select,[role=menuitem],[role=tab],[role=option],[role=link],[role=checkbox],[role=switch]')).map(describe).slice(0, MAX),
  };

  // ── CSS · 레이아웃 ──
  const de = document.documentElement;
  const overflowX = all.filter((e) => { if (!visible(e)) return false; const r = e.getBoundingClientRect(); return r.right > vw + 1 && getComputedStyle(e).position !== 'fixed'; });
  const clipped = all.filter((e) => { if (!visible(e)) return false; const cs = getComputedStyle(e); return e.scrollWidth > e.clientWidth + 1 && (cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden') && e.innerText && e.innerText.trim(); });
  const interactive = [...document.querySelectorAll('a[href], button, input, select, textarea, [role=button]')].filter(visible);
  const covered = interactive.filter((e) => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < 0 || y < 0 || x > vw || y > vh) return false; const top = document.elementFromPoint(x, y); return top && top !== e && !e.contains(top) && !top.contains(e); });
  const tiny = interactive.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; });
  const smallText = all.filter((e) => visible(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12);
  out.css = {
    pageHorizontalScroll: de.scrollWidth > de.clientWidth ? de.scrollWidth - de.clientWidth + 'px' : false,
    overflowRight: overflowX.map(describe).slice(0, MAX),
    textClipped: { count: clipped.length, samples: clipped.map(describe).slice(0, MAX) },
    coveredControls: covered.map((e) => describe(e) + ' ← ' + describe(document.elementFromPoint(e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2, e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2))).slice(0, MAX),
    smallTargets: { count: tiny.length, samples: tiny.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + describe(e); }).slice(0, MAX) },
    smallText: { count: smallText.length, samples: smallText.map((e) => getComputedStyle(e).fontSize + ' ' + describe(e)).slice(0, MAX) },
    brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map((i) => i.getAttribute('src').slice(0, 80)).slice(0, MAX),
    fonts: { status: document.fonts.status, loaded: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))].slice(0, MAX), failed: [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family) },
    zeroSizeWithText: all.filter((e) => { const r = e.getBoundingClientRect(); return (r.width === 0 || r.height === 0) && getComputedStyle(e).display !== 'none' && e.innerText && e.innerText.trim() && getComputedStyle(e).position !== 'absolute'; }).map(describe).slice(0, MAX),
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
  out.meta = { charset: document.characterSet, viewport: meta('viewport'), description: meta('description'), colorSchemeMeta: meta('color-scheme'), themeColor: meta('theme-color'), manifest: document.querySelector('link[rel=manifest]')?.href ?? null, favicon: document.querySelector('link[rel~=icon]')?.href ?? null, canonical: document.querySelector('link[rel=canonical]')?.href ?? null };
  out.security = {
    https: location.protocol === 'https:',
    mixedContent: res.filter((e) => e.name.startsWith('http:')).map((e) => e.name).slice(0, MAX),
    thirdPartyScripts: [...new Set(scripts.filter((s) => { try { return new URL(s).origin !== location.origin; } catch { return false; } }).map((s) => new URL(s).origin))],
    cspMeta: meta('Content-Security-Policy') || document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
    formsOverHttp: [...document.forms].filter((f) => f.action && f.action.startsWith('http:')).length,
    passwordAutocomplete: [...document.querySelectorAll('input[type=password]')].map((i) => i.getAttribute('autocomplete')),
  };
  out.diag = window.__diag ? (({ counts, pendingRequests, problems, failedRequests }) => ({ counts, pendingRequests, problems: problems.length, failedRequests: failedRequests.length }))(window.__diag.summary()) : '기록기 없음';
  return out;
})()
