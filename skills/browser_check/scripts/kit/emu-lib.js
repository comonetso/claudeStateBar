(() => {
  // __emu: setViewportSize·emulateMedia 대체 (페이지 안 표준 JS 만). 한 번 설치, apply 여러 번, restore 로 원상복구.
  if (window.__emu) return 'exists';
  const origMM = window.matchMedia;
  const T = '(min-width: 0px)', F = '(max-width: 0px)';
  const FEAT = [['prefers-color-scheme', 'colorScheme'], ['prefers-reduced-motion', 'reducedMotion'], ['prefers-contrast', 'contrast'], ['forced-colors', 'forcedColors'], ['pointer', 'pointer'], ['any-pointer', 'pointer'], ['hover', 'hover'], ['any-hover', 'hover'], ['prefers-reduced-transparency', 'reducedTransparency'], ['inverted-colors', 'invertedColors'], ['prefers-reduced-data', 'reducedData']];
  const st = { opts: null, ev: null, ruleOrig: new Map(), attrOrig: new Map(), inline: [], mqls: [], csSaved: [] };
  const evaluator = (o) => {
    if (!st.ev) { const f = document.createElement('iframe'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.style.cssText = 'position:fixed;left:-30000px;top:0;border:0;visibility:hidden;pointer-events:none'; document.documentElement.appendChild(f); st.ev = f; }
    st.ev.style.width = (o.width || innerWidth) + 'px'; st.ev.style.height = (o.height || innerHeight) + 'px';
    void st.ev.offsetWidth; // 부모 배치 확정 → 자식 뷰포트 크기 반영
    return st.ev.contentWindow;
  };
  const subst = (q, o) => {
    let out = q.replace(/\(\s*([a-zA-Z-]+)\s*(?::\s*([a-zA-Z-]+)\s*)?\)/g, (m, name, val) => {
      const f = FEAT.find((x) => x[0] === name.toLowerCase()); if (!f || o[f[1]] === undefined) return m;
      const want = String(o[f[1]]).toLowerCase();
      if (val === undefined) return want !== 'none' && want !== 'no-preference' ? T : F;
      return val.toLowerCase() === want ? T : F;
    });
    if (o.media) {
      out = out.split(',').map((part) => {
        const p = part.trim(); const m = /^(only\s+|not\s+)?(all|screen|print|speech)\b(.*)$/i.exec(p);
        if (!m) return p;
        const neg = (m[1] || '').trim().toLowerCase() === 'not'; const type = m[2].toLowerCase();
        const typeOk = type === 'all' || type === o.media;
        let rest = m[3].trim(); if (/^and\b/i.test(rest)) rest = rest.slice(3).trim();
        if (!neg) return typeOk ? (rest || 'all') : 'not all';
        if (!typeOk) return 'all';
        return rest ? 'not all and ' + rest : 'not all';
      }).join(', ');
    }
    return out;
  };
  const decide = (q, o, ev) => ev.matchMedia(subst(q, o)).matches;
  const walk = (rules, o, ev, s) => {
    for (const r of rules) {
      if (r.type === 4 /* MEDIA */ || (r.media && r.cssRules && !r.styleSheet)) {
        if (!st.ruleOrig.has(r)) st.ruleOrig.set(r, r.media.mediaText);
        const on = decide(st.ruleOrig.get(r), o, ev); r.media.mediaText = on ? 'all' : 'not all'; s.rules++; on ? s.on++ : s.off++;
      }
      if (r.type === 3 /* IMPORT */) {
        if (r.media && r.media.mediaText) { if (!st.ruleOrig.has(r)) st.ruleOrig.set(r, r.media.mediaText); const on = decide(st.ruleOrig.get(r), o, ev); r.media.mediaText = on ? 'all' : 'not all'; s.imports++; }
        try { if (r.styleSheet) walk(r.styleSheet.cssRules, o, ev, s); } catch (e) { s.blocked.push('@import ' + r.href); }
      }
      let kids = null; try { kids = r.cssRules; } catch (e) {}
      if (kids && kids.length) walk(kids, o, ev, s);
    }
  };
  const apply = (o) => {
    st.opts = o; const ev = evaluator(o);
    const s = { evSize: [ev.innerWidth, ev.innerHeight], rules: 0, on: 0, off: 0, imports: 0, attrs: 0, blocked: [], colorScheme: null, mqlFired: 0 };
    for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (e) { if (sh.href && !st.inline.some((x) => x.href === sh.href)) s.blocked.push(sh.href); continue; } walk(rules, o, ev, s); }
    for (const el of document.querySelectorAll('link[media],style[media],source[media]')) {
      if (!st.attrOrig.has(el)) st.attrOrig.set(el, el.getAttribute('media'));
      el.setAttribute('media', decide(st.attrOrig.get(el), o, ev) ? 'all' : 'not all'); s.attrs++;
    }
    // light-dark()·UA 색: color-scheme 이 두 값(light dark)인 요소만 원하는 쪽으로 고정
    for (const [el, v] of st.csSaved) el.style.colorScheme = v; st.csSaved = [];
    if (o.colorScheme) {
      const els = [document.documentElement, ...document.querySelectorAll('body, body *')];
      for (const el of els.slice(0, 20000)) { const cs = getComputedStyle(el).colorScheme; if (/light/.test(cs) && /dark/.test(cs)) { st.csSaved.push([el, el.style.colorScheme]); el.style.colorScheme = o.colorScheme; } }
      s.colorScheme = st.csSaved.length;
    }
    for (const m of st.mqls) { const now = decide(m.q, o, ev); if (now !== m.obj.matches) { m.obj.matches = now; const e = { matches: now, media: m.q, type: 'change' }; for (const f of m.l) { try { f.call(m.obj, e); s.mqlFired++; } catch (x) {} } if (typeof m.obj.onchange === 'function') m.obj.onchange(e); } }
    window.matchMedia = function (q) {
      const obj = { media: String(q), matches: decide(String(q), st.opts, evaluator(st.opts)), onchange: null };
      const l = new Set(); obj.addListener = (f) => l.add(f); obj.removeListener = (f) => l.delete(f);
      obj.addEventListener = (t, f) => { if (t === 'change') l.add(f); }; obj.removeEventListener = (t, f) => l.delete(f); obj.dispatchEvent = () => true;
      st.mqls.push({ q: String(q), obj, l }); return obj;
    };
    return s;
  };
  // 교차 출처 시트: repl 쪽에서 받은 본문을 같은 자리에 <style> 로 복제하고 원본 link 를 끈다(url() 은 절대 주소로)
  const inline = (href, text) => {
    const link = [...document.querySelectorAll('link[rel~="stylesheet"]')].find((l) => l.href === href); if (!link) return 'no-link';
    const abs = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (/^(data:|blob:|#)/.test(u) ? m : 'url("' + new URL(u, href).href + '")'));
    const s = document.createElement('style'); s.dataset.emuInline = href; s.textContent = abs; link.after(s);
    st.inline.push({ href, link, style: s, wasDisabled: link.disabled }); link.disabled = true;
    return { rules: s.sheet ? s.sheet.cssRules.length : -1, bytes: abs.length };
  };
  const restore = () => {
    for (const [r, t] of st.ruleOrig) { try { r.media.mediaText = t; } catch (e) {} } st.ruleOrig.clear();
    for (const [el, v] of st.attrOrig) { if (v === null) el.removeAttribute('media'); else el.setAttribute('media', v); } st.attrOrig.clear();
    for (const [el, v] of st.csSaved) el.style.colorScheme = v; st.csSaved = [];
    for (const x of st.inline) { x.style.remove(); x.link.disabled = x.wasDisabled; } st.inline = [];
    window.matchMedia = origMM; st.mqls = []; st.opts = null;
    if (st.ev) { st.ev.remove(); st.ev = null; }
    return 'restored';
  };
  window.__emu = { apply, inline, restore, subst: (q, o) => subst(q, o) };
  return 'installed';
})()
