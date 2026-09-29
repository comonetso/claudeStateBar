# "Check for CSS errors" — broken layout, horizontal overflow, clipping, overlap, styles not applying, CSS/font load failures, contrast

Prerequisite: SKILL.md §0–§2. `DIAG`, `WEBCHECK` and `WEBCHECK_EXTRA` below are the contents of `kit/diag-v2.1.js`, `kit/webcheck.js` and `kit/webcheck-extra.js`.

## Steps
1. `openTab(url)` → `K.prep` → `K.wake`.
2. **Load failures (first load)**: on a site without login, inject recorder v2.1 with `K.X(tab,'Page.addScriptToEvaluateOnNewDocument',{source: DIAG})` → `reload()` → `__diag.dump({types:['resource-error','resource-status','csp']})`. 🔴 In a logged-in app a reload rotates the token — if the dev server already injects v2.1 (`sites[].diag: "vite-v2.1"`) use that; otherwise inject into a new target **before its first navigation**. On Windows inject over C (SKILL.md §3).
3. Full screen `K.img(tab,'full')` → look at it on the server. Long pages: scrolled tiles + `image/stitch.py`.
4. Automatic checks, in this fixed order: `__diag.dump` first → `scrollTo(0,0)` → `page.evaluate(WEBCHECK)` → axe (accessibility recipe) → `__diag.mark('extra')` → `page.evaluate(WEBCHECK_EXTRA)` **last** (it has side effects: moves focus, adds spacing CSS, fires a synthetic paste, sends its own HEAD/robots requests).
   Look at: `pageHorizontalScroll` · `overflowBeyondClientWidth` · inner horizontal scroll · `textClipped` (line-clamp included) · overlapping text · z-index with no effect · trapped fixed elements · sticky that doesn't stick · images without size · `font-display` · `100vh` · `lowContrast` (fragments, ancestor opacity included).
5. **Find the cause**: for a suspect element, `K.X` `DOM.getDocument` → `DOM.querySelector` → `CSS.getMatchedStylesForNode` — the applied rules, the winning rule, `styleSheetId`, line. State styles via `CSS.forcePseudoState` (reset to `[]` afterwards).
6. For an overflowing element: `scrollIntoViewIfNeeded` → `boundingBox` → full capture → crop on the server.

## Verdict
`scrollWidth > clientWidth` = 0 · unintended inner horizontal scroll = 0 · CSS/font 404 = 0 · contrast ≥ 4.5:1 (large text 3:1) · unintended clipping/overlap = 0. 🔴 Judge colours only with `darkReader:false`.

## Report
Per problem: `element · value/threshold · winning rule (sheet:line) · cropped capture · suggested fix`.

## Not verified
CSS **syntax errors** (declarations the browser dropped) don't show in the CSSOM — comparing the `CSS.getStyleSheetText` source with the CSSOM should find them (not measured).
