# "Check the screen" · "Take a look at this" — what a screen or element looks like right now

Prerequisite: SKILL.md §0–§2 (doctor · classification · login rules · the template).

## Steps
1. `bc.run(name, …)` → `page.goto(url)` → `page.waitForLoadState()`; for lazy content wait for the element (`page.waitForSelector`) rather than a fixed delay.
2. Find the target with `page.snapshot()` (viewport) or `page.snapshot({ scope: 'full_page' })`. Refs (`@12`) are valid until the page changes. For a frame, reuse the ref on its `iframe` line: `page.snapshot({ scope: 'subtree', root: '@12' })`.
3. Whole screen: `bc.shot(page, 'screen')`. Element photo: `page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio }; }, sel)` → shoot → crop the image at box × DPR with Pillow (a screencast frame is in device pixels).
4. Whether the user could actually click it: unique match · visible box · `document.elementFromPoint(centre)` is the element or inside it (otherwise it is covered).
5. State values from the accessibility tree: `page.cdp('Accessibility.getFullAXTree')` (expanded · checked · disabled · required).

## Verdict
The element exists (one match) · is visible (non-empty box, not covered) · its text and state.

## Report
Capture (cropped) + snapshot excerpt (ref lines) + state values.
