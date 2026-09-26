(() => {
  // T3 제안 조각 — webcheck 미탐 보완. 즉시 실행 식. 읽기 전용(부작용 없음).
  const out = {};
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' + (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20) + '"';
  const rendered = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const skipExt = (el) => { for (let e = el; e; e = e.parentElement) { const t = e.tagName.toLowerCase(); if (t.includes('-') && !customElements.get(t)) return true; } return false; };

  // ── (1) 조상 opacity 를 반영한 대비(S13·S14) ─────────────────────────────
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, a, bottom) => top.map((v, i) => v * a + bottom[i] * (1 - a));
  const canvasColor = () => (matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).colorScheme.includes('dark') ? [18, 18, 18] : [255, 255, 255]);
  // el 아래(자기 포함 안 함)로 보이는 불투명 배경 — 반투명 배경층은 합성한다. opacity 는 여기서 무시(아래에서 층별로 처리).
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
    let col = canvasColor();
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i].slice(0, 3), layers[i][3], col);
    return col;
  };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // 실효 색: 글자·배경을 먼저 자기 그룹 안에서 만들고, 안쪽 opacity 조상부터 바깥쪽으로 "그 조상 뒤 배경" 위에 합성
  const effective = (el) => {
    const cs = getComputedStyle(el);
    const fgc = rgba(cs.color);
    let bg = backdrop(el);
    let fg = over(fgc.slice(0, 3), fgc[3], bg);
    let minOp = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const op = Number(getComputedStyle(e).opacity);
      if (op < 1) { const behind = backdrop(e.parentElement); fg = over(fg, op, behind); bg = over(bg, op, behind); minOp *= op; }
    }
    return { fg, bg, ratio: Math.round(cr(fg, bg) * 100) / 100, opacity: Math.round(minOp * 1000) / 1000 };
  };
  const low = [];
  for (const el of document.querySelectorAll('body *')) {
    if (skipExt(el) || !rendered(el)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    const e = effective(el);
    if (e.ratio < (big ? 3 : 4.5)) low.push(e.ratio + (e.opacity < 1 ? ' (투명도 ' + e.opacity + ')' : '') + ' ' + describe(el) + ' fg=' + e.fg.map(Math.round) + ' bg=' + e.bg.map(Math.round));
  }
  out.lowContrastEffective = low;

  // ── (2) 클릭 핸들러로 가짜 버튼 찾기(S35·S36 — 커서와 무관) ─────────────────
  const NATIVE = 'a[href],button,input,select,textarea,summary,label,details,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],[role=radio],[contenteditable=""],[contenteditable=true]';
  const clickOf = (el) => {
    if (typeof el.onclick === 'function') return 'onclick';
    for (const k in el) if (k.startsWith('__reactProps$') && el[k] && typeof el[k].onClick === 'function') return 'react onClick';
    if (window.__diag && window.__diag.clickTargets && window.__diag.clickTargets.has(el)) return 'addEventListener(click)';
    return null;
  };
  out.fakeButtons = [...document.querySelectorAll('body *')].filter((el) => !skipExt(el) && rendered(el) && !el.matches(NATIVE) && !el.closest(NATIVE) && clickOf(el)).map((el) => describe(el) + ' ← ' + clickOf(el) + (el.tabIndex >= 0 ? ' · 포커스 가능' : ' · 🔴 키보드로 못 감') + (getComputedStyle(el).cursor === 'pointer' ? '' : ' · 커서 표시 없음'));

  // ── (3) 목표 크기 24px — WCAG 2.5.8 예외(문장 안 인라인·간격) 반영(S27·S28·S29) ──
  const targets = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab]')].filter((el) => !skipExt(el) && rendered(el));
  const rects = targets.map((el) => el.getBoundingClientRect());
  const inText = (el) => { const cs = getComputedStyle(el); if (!cs.display.startsWith('inline') || cs.display === 'inline-block') return false; const p = el.parentElement; return !!p && [...p.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()); };
  const distToRect = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  out.smallTargetsWcag = targets.map((el, i) => {
    const r = rects[i];
    if (r.width >= 24 && r.height >= 24) return null;
    if (inText(el)) return null;
    const cx0 = r.left + r.width / 2, cy0 = r.top + r.height / 2;
    const hit = targets.find((o, j) => { if (j === i) return false; const q = rects[j]; if (distToRect(cx0, cy0, q) < 12) return true; const small = q.width < 24 || q.height < 24; return small && Math.hypot(cx0 - (q.left + q.width / 2), cy0 - (q.top + q.height / 2)) < 24; });
    return hit ? Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + describe(el) + ' ↔ ' + describe(hit) : null;
  }).filter(Boolean);

  // ── (4) 실패 자원 — 개수 + 전부(상한 올린 뒤) ─────────────────────────────
  const fails = performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400);
  out.resourcesFailed = { count: fails.length, list: fails.map((e) => e.responseStatus + ' ' + e.initiatorType + ' ' + e.name.replace(location.origin, '')) };
  return out;
})()
