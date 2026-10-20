# "Check responsive" · "How does it look on mobile" · "Check dark mode" · "Print"

Prerequisite: SKILL.md §0–§2. Everything here is CDP emulation through `page.cdp` — no extra requests, also safe on logged-in apps. Revert it in a `finally` inside the run.

## Widths
1. For each width (e.g. 320 · 375 · 390 · 768 · 1024 · 1280): `page.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 844, deviceScaleFactor: w < 768 ? 3 : 1, mobile: w < 768 })` → wait a frame (`page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => r(true))))`) → `page.evaluate(() => ({ iw: innerWidth, cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }))` + the overflowing elements → `bc.shot(page, 'w' + w)`. Afterwards **always** `page.cdp('Emulation.clearDeviceMetricsOverride')`.
   - 🔴 With `mobile: true`, wide content makes `innerWidth` exceed the set width → **`iw > w` or `sw > cw` means horizontal overflow**.
   - Touch branches (`hover:none`, `pointer:coarse`): `Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 })` → `false` afterwards.

## Theme and media
- `page.cdp('Emulation.setEmulatedMedia', { media: 'print' | '', features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })` → afterwards back to `{ media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] }` (what `bc.prep` set).
- Without CDP media (a page that reads its own toggle): `bc.kit(page, 'emu-lib')` (`__emu` — rewrites mediaText and pins `light-dark()`/color-scheme; can't touch cross-origin sheets) — restore in `try/finally`.
- Whether CDP media wakes `matchMedia` listeners registered at first load is **not measured**.
- Print preview: `const r = await page.cdp('Page.printToPDF', { printBackground: true, paperWidth: 8.27, paperHeight: 11.69 })` → `bc.img('print.pdf', Buffer.from(r.data, 'base64'))` → look at it.

## Verdict
At every width: horizontal overflow 0 · clipping 0 · menu/sidebar switches as designed · targets ≥ 24 px · no text under 12 px · contrast holds in dark mode.

## Report
Per-width table (`iw/cw/sw · overflowing elements · branch state`) + per-width captures + revert confirmed.
