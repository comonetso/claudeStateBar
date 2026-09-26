// ===== browser-check kit head v2 (from aside-kit head v1, 2026-09-26; Codex D4 fix: detect → warn → lock) =====
// One-shot call: prepend this file to the body.  Persistent session: send once, it stays as globalThis.K.
// 🔴 Never write the shapes "import" / "require" followed by an opening parenthesis anywhere in this file
//    (comments included) — the repl rejects the whole code before running it.
const K = globalThis.K || (globalThis.K = {});
K.R = {};
K.VERSION = 2;
// Step guard — one stuck step must not take the other results down with the ~60 s remote cut.
K.G = async (k, fn, lim = 8000) => {
  try { K.R[k] = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj(new Error('guard ' + lim)), lim))]); }
  catch (e) { K.R[k] = 'ERR ' + String((e && e.message) || e).slice(0, 300); }
  return K.R[k];
};
K.out = (tag, v) => console.log('@@' + tag + ' ' + JSON.stringify(v));
// Raw CDP inside the repl (commands/responses only, no events). Private method — always check first.
K.hasX = (tab) => typeof tab._sendToTarget === 'function';
// 🔴 Method allow-list (policy profile safe-v1). Anything else throws — the broker, not the prompt, is the gate.
K.X_ALLOW = /^(Runtime\.evaluate|Runtime\.enable|Runtime\.getHeapUsage|Page\.enable|Page\.addScriptToEvaluateOnNewDocument|Page\.removeScriptToEvaluateOnNewDocument|Page\.captureScreenshot|Page\.getResourceTree|Page\.getResourceContent|DOM\.enable|DOM\.getDocument|DOM\.querySelector|DOM\.querySelectorAll|DOM\.getBoxModel|DOMDebugger\.getEventListeners|CSS\.enable|CSS\.getMatchedStylesForNode|CSS\.getComputedStyleForNode|CSS\.forcePseudoState|CSS\.getStyleSheetText|CSS\.startRuleUsageTracking|CSS\.stopRuleUsageTracking|Accessibility\.enable|Accessibility\.getFullAXTree|Accessibility\.getPartialAXTree|Emulation\.setDeviceMetricsOverride|Emulation\.clearDeviceMetricsOverride|Emulation\.setEmulatedMedia|Emulation\.setTouchEmulationEnabled|Emulation\.setCPUThrottlingRate|Emulation\.setEmulatedVisionDeficiency|Emulation\.setLocaleOverride|Emulation\.setTimezoneOverride|Network\.enable|Network\.emulateNetworkConditions|Network\.setBlockedURLs|Network\.setExtraHTTPHeaders|Network\.setCacheDisabled|Performance\.enable|Performance\.getMetrics|Profiler\.enable|Profiler\.setSamplingInterval|Profiler\.start|Profiler\.stop|Profiler\.startPreciseCoverage|Profiler\.takePreciseCoverage|Profiler\.stopPreciseCoverage|Input\.dispatchKeyEvent|Input\.dispatchMouseEvent|Input\.dispatchTouchEvent|Input\.imeSetComposition|Input\.insertText)$/;
K.X = (tab, m, p) => {
  if (!K.X_ALLOW.test(m)) throw new Error('CDP method not allowed by safe-v1: ' + m);
  p = p || {};
  if (m === 'Page.captureScreenshot' && p.fromSurface === false) throw new Error('fromSurface:false is forbidden (captures the user screen)');
  return tab._sendToTarget(m, p);
};
// Frame rate (rAF per second) · wake the throttled agent tab (one capture, up to 3 tries).
K.fps = (tab) => tab.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }));
K.wake = async (tab) => { let f = await K.fps(tab); for (let i = 0; f < 30 && i < 3; i++) { await tab.screenshot({ type: 'jpeg', quality: 10 }); f = await K.fps(tab); } return f; };
// Environment scan BEFORE touching anything — Dark Reader on/off, DeepL / Aside injected elements, viewport.
K.scan = (tab) => tab.evaluate(() => {
  const inj = [];
  for (const e of document.querySelectorAll('*')) {
    const t = e.tagName.toLowerCase();
    if (t.startsWith('deepl-') || t === 'aside-inline-menu' || (e.classList && e.classList.contains('bro-field-icon'))) inj.push(t);
  }
  return {
    darkReader: document.documentElement.hasAttribute('data-darkreader-mode') || !!document.querySelector('style.darkreader'),
    injected: Array.from(new Set(inj)),
    vis: performance.getEntriesByType('visibility-state').map((x) => x.name + '@' + Math.round(x.startTime)),
    dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight, cw: document.documentElement.clientWidth, href: location.href,
  };
});
// 🔴 Prep order fixed by the owner's policy: DETECT → WARN → (only then) lock Dark Reader in OUR tab and hide injected UI.
//    Returns { before, after, warnings[] }. `opts.darkReader`: 'must-be-off-warn' (default) | 'tolerate' | 'lock-silently'.
K.prep = async (tab, opts) => {
  opts = opts || {};
  const before = await K.scan(tab);
  const warnings = [];
  if (before.darkReader && (opts.darkReader || 'must-be-off-warn') === 'must-be-off-warn') {
    warnings.push('DARK_READER_ON: Dark Reader is active on this site — colours and captures are altered. The owner keeps it OFF on sites under development; report this before trusting any colour/contrast result.');
  }
  if (before.injected.length) warnings.push('INJECTED_UI: ' + before.injected.join(',') + ' (hidden for capture; excluded from axe)');
  if ((opts.darkReader || 'must-be-off-warn') !== 'tolerate') {
    await tab.evaluate(async () => {
      if (!document.querySelector('meta[name="darkreader-lock"]')) { const m = document.createElement('meta'); m.name = 'darkreader-lock'; document.head.appendChild(m); }
      for (const e of document.querySelectorAll('*')) {
        const t = e.tagName.toLowerCase();
        if (t.startsWith('deepl-') || t === 'aside-inline-menu' || (e.classList && e.classList.contains('bro-field-icon'))) e.style.setProperty('display', 'none', 'important');
      }
      const t0 = Date.now();
      while (document.documentElement.hasAttribute('data-darkreader-mode') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    });
  }
  const after = await K.scan(tab);
  const res = { before, after, warnings };
  for (const w of warnings) console.log('@@WARN ' + w);
  return res;
};
// Capture to the server side (image/decode.py turns @@IMG lines into files).
K.img = async (tab, name, opt) => console.log('@@IMG ' + name + ' ' + (await tab.screenshot(opt || {})).toString('base64'));
// In-flight request counter for tabs without the recorder (apps that call globalThis.fetch at call time).
K.inflightHook = (tab) => tab.evaluate(() => { const w = window; if (w.__inflightHooked) return 'already'; w.__inflightHooked = 1; w.__inflight = 0; const of = w.fetch; w.fetch = function () { w.__inflight++; return of.apply(this, arguments).finally(() => { w.__inflight--; }); }; return 'hooked'; });
// 🔴 Safe close for logged-in sites: in-flight 0 + (recorder v1: dropped 0) + resource count stable, 5 consecutive checks 500 ms apart.
//    Closing a tab mid-request lost a refresh-token response and revoked the owner's whole session family (real incident).
K.safeClose = async (tab, maxMs = 15000) => {
  const t0 = Date.now(); let z = 0, lastN = -1, s = null;
  while (Date.now() - t0 < maxMs) {
    s = await tab.evaluate(() => {
      const d = window.__diag; const n = performance.getEntriesByType('resource').length;
      if (d && typeof d.summary === 'function') { const m = d.summary(); return { p: m.pendingRequests, dropped: (d.version || 1) >= 2 ? 0 : (m.dropped || 0), n, via: 'diag v' + (d.version || 1) }; }
      return { p: typeof window.__inflight === 'number' ? window.__inflight : null, dropped: 0, n, via: 'inflightHook' };
    });
    const ok = s.p === 0 && s.dropped === 0 && s.n === lastN; lastN = s.n;
    if (ok) { if (++z >= 5) { await closeTab(tab); return { closed: true, s }; } } else z = 0;
    await sleep(500);
  }
  return { closed: false, s };   // 🔴 NOT closed — persistent session: retry next line; one-shot: report to a human, never force it
};
// Refuse the native confirm() right before a destructive click (Aside auto-accepts it; navigation resets this).
K.denyConfirm = (tab) => tab.evaluate(() => { window.__lastConfirm = null; window.confirm = (m) => { window.__lastConfirm = m; return false; }; });
// SPA-aware URL (page.url() does not reflect pushState).
K.href = (tab) => tab.evaluate(() => location.href);
// Pre-action checks: exactly one match, visible, not covered — Asidewright would "succeed" on hidden/covered targets.
K.canAct = async (tab, loc) => {
  const n = await loc.count(); if (n !== 1) return { ok: false, why: 'matches=' + n };
  if (!(await loc.isVisible())) return { ok: false, why: 'not visible' };
  const bb = await loc.boundingBox(); if (!bb) return { ok: false, why: 'no box' };
  const covered = await loc.evaluate((el, c) => { const t = document.elementFromPoint(c.x, c.y); return !(t === el || el.contains(t) || (t && t.contains(el))); }, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
  return covered ? { ok: false, why: 'covered' } : { ok: true, bb };
};
// ===== head end =====
