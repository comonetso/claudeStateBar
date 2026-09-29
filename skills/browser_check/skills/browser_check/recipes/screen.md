# "Check the screen" · "Take a look at this" — what a screen or element looks like right now

Prerequisite: SKILL.md §0–§2 (doctor · classification · `K.prep` · login rules).

## Steps
1. `openTab(url)` → `K.prep(tab, {darkReader: site.darkReader})` → `K.wake(tab)` if there is animation or lazy loading.
2. Find the target ref with `snapshot(page, {interactive: true})`.
   - 🔴 If the document was scrolled, `scrollTo(0,0)` first — **inputs, images and iframes scrolled past above drop out of the snapshot** (only what is below and to the right is included). For scroll boxes (chat timelines) use `showHidden: true`.
   - On a large page, outline with `maxDepth: 2`, then narrow with `selector` (first match only) · `ref`.
3. For a numbered picture: `annotatedScreenshot(page)` → `@@IMG` (number N = ref `eN`).
4. Element photo: `page.locator('eN').scrollIntoViewIfNeeded()` → `boundingBox()` → a full `page.screenshot()` → crop it on the server at box × DPR (e.g. Pillow `Image.crop`; `image/crop.py` only handles `responsive-iframe.js` output). 🔴 `clip`, `locator.screenshot()` and `fullPage` are broken.
5. Whether the user can actually click it: `K.canAct(tab, loc)` — unique · visible · not covered.
6. SPA URL: `K.href(tab)`.
7. Logged-in site ⇒ `K.safeClose(tab)`, otherwise `closeTab(tab)`.

## Verdict
The element exists (count ≥ 1) · is visible (has a boundingBox and isn't covered) · its text and state (expanded · checked · disabled from the AX tree — `K.X(tab,'Accessibility.getFullAXTree')`).

## Report
Element capture + snapshot excerpt (ref lines) + state values. Any Dark Reader warning goes first.
