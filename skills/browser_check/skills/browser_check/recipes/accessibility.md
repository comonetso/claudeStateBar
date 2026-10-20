# "Check accessibility"

Prerequisite: SKILL.md §0–§2.

## Steps
1. Inside `bc.run`: `goto` → `window.scrollTo(0,0)`.
2. **Coordinate-based checks first** (webcheck's occlusion and contrast), then the checks that move focus (focus scrolls the page and changes the occlusion results).
3. axe: fetch it on the PC side in the script — `const axe = await (await fetch('https://cdn.jsdelivr.net/npm/axe-core@4.13.0/axe.min.js')).text(); await page.evaluate(axe)` → `page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa','wcag22aa'] }, resultTypes: ['violations'] }))`. (evaluate bypasses the page's CSP.)
4. Canonical name, role and state: `page.cdp('Accessibility.getFullAXTree')` (expanded · required · invalid · describedby). A snapshot is enough for a quick look — its node names are accessibility roles.
5. `bc.kit(page, 'webcheck')` then `bc.kit(page, 'webcheck-extra')`: missing focus indicator (2.4.7) · obscured focus (2.4.11) · text spacing (1.4.12) · paste blocking (3.3.8) · target size (with its exceptions) · fake buttons (onclick/`__reactProps$`) · contrast including ancestor opacity.
6. Keyboard: `page.press('body', 'Tab')` N times → record `document.activeElement` (order, keyboard traps — 2.1.2). For Space send `page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })` + `keyUp` and check the result — don't judge Space from a single unverified key call.

## Verdict
axe `violations` = 0 (critical and serious first) · every control can be operated and left by keyboard alone · manual-check items handed over as a list.

## Report
`WCAG criterion · rule · element · value · suggested fix`, with manual items listed separately.
