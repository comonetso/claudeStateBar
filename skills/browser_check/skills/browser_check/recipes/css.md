# "Check for CSS errors" — broken layout, horizontal overflow, clipping, overlap, styles not applying, CSS/font load failures, contrast

Prerequisite: SKILL.md §0–§2.

## Steps
1. Load failures from the first load: inside `bc.run`, **before** `goto`, `await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: bc.kitSource(page, 'diag-v2.1') })` and `await bc.watch(page)` → `goto` → `page.evaluate(() => __diag.dump({ types: ['resource-error', 'resource-status', 'csp'] }))` plus `bc.problems(page)` (failed and 4xx/5xx stylesheets and fonts). In a logged-in app, inject before the first navigation of the space's page — never reload to get it in.
2. Full screen `bc.shot(page, 'full')` → look at it. Long pages: scroll (`page.mouse.wheel` over the page, or `window.scrollTo` in evaluate) and shoot tiles, then `scripts/image/stitch.py`.
3. Automatic checks, in this fixed order: `__diag.dump` first → `window.scrollTo(0,0)` → `bc.kit(page, 'webcheck')` → axe (accessibility recipe) → `bc.kit(page, 'webcheck-extra')` **last** (it has side effects: moves focus, adds spacing CSS, fires a synthetic paste, sends its own HEAD/robots requests).
   Look at: `pageHorizontalScroll` · `overflowBeyondClientWidth` · inner horizontal scroll · `textClipped` · overlapping text · z-index with no effect · trapped fixed elements · sticky that doesn't stick · images without size · `font-display` · `100vh` · `lowContrast`.
4. **Find the cause** of a suspect element: `page.cdp('DOM.getDocument')` → `DOM.querySelector` → `CSS.enable` → `CSS.getMatchedStylesForNode` — the applied rules, the winning rule, `styleSheetId`, line. State styles via `CSS.forcePseudoState` (reset to `[]` afterwards). Raw CDP invalidates snapshot refs — take a new snapshot afterwards.
5. For an overflowing element: scroll it into view → box → capture → crop.

## Verdict
`scrollWidth > clientWidth` = 0 · unintended inner horizontal scroll = 0 · CSS/font 404 = 0 · contrast ≥ 4.5:1 (large text 3:1) · unintended clipping/overlap = 0. Judge colours with the light scheme `bc.prep` sets unless the request is about dark mode.

## Report
Per problem: `element · value/threshold · winning rule (sheet:line) · cropped capture · suggested fix`.

## Not verified
CSS **syntax errors** (declarations the browser dropped) don't show in the CSSOM — comparing `CSS.getStyleSheetText` with the CSSOM should find them (not measured).
