# "Check responsive" · "How does it look on mobile" · "Check dark mode" · "Print"

Prerequisite: SKILL.md §0–§2. There is no `setViewportSize` or `emulateMedia` — CDP (B or C) comes first.

## Widths
1. `openTab(url)` → `K.prep` → `K.hasX(tab)`.
2. **First choice (CDP)**: for each width (e.g. 320 · 375 · 390 · 768 · 1024 · 1280) `K.X(tab,'Emulation.setDeviceMetricsOverride',{width:w,height:844,deviceScaleFactor:(w<768?3:1),mobile:w<768})` → `K.wake` → `page.evaluate(()=>({iw:innerWidth, cw:document.documentElement.clientWidth, sw:document.documentElement.scrollWidth}))` + the overflowing elements → `K.img`. Afterwards **always** `K.X(tab,'Emulation.clearDeviceMetricsOverride')`.
   - 🔴 With `mobile:true`, wide content makes `innerWidth` exceed the set width → **`iw > w` or `sw > cw` means horizontal overflow**.
   - No extra requests even in logged-in apps (safer than iframes).
   - Touch branches (`hover:none`, `pointer:coarse`): `Emulation.setTouchEmulationEnabled({enabled:true,maxTouchPoints:5})` → false afterwards.
3. **Second choice (no CDP)**: a same-origin iframe per width (`kit/responsive-iframe.js`; inside each iframe `scrollbarWidth:'none'` and its own Dark Reader lock). If XFO/`frame-ancestors` blocks it, use srcdoc. Save its output to a file and crop each width with `image/crop.py <file>` (it reads the `@@RVSHOT_`/`@@RV` lines). 🔴 In a logged-in app each iframe boots the app again (token rotation) — dev servers only, and remove them once requests are at 0.

## Theme and media
- CDP: `K.X(tab,'Emulation.setEmulatedMedia',{media:'print'|'', features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]})` → afterwards `{media:'',features:[]}`.
- No CDP: `kit/emu-lib.js` (`__emu` — rewrites mediaText and pins `light-dark()`/color-scheme; can't touch cross-origin sheets) — restore in `try/finally`.
- Whether the CDP route wakes `matchMedia` listeners registered at first load is **not measured**.
- Print preview: `page.pdf({paperWidth:8.27,paperHeight:11.69,printBackground:true})` (`format` is ignored) → check it on the server.

## Verdict
At every width: horizontal overflow 0 · clipping 0 · menu/sidebar switches as designed · targets ≥ 24 px · no text under 12 px · contrast holds in dark mode.

## Report
Per-width table (`iw/cw/sw · overflowing elements · branch state`) + per-width captures + revert confirmed.
