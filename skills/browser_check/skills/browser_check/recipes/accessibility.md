# "Check accessibility"

Prerequisite: SKILL.md §0–§2.

## Steps
1. `openTab(url)` → `K.prep` (hides DeepL and locks Dark Reader so contrast and axe stay clean) → `scrollTo(0,0)`.
2. **Coordinate-based checks first** (webcheck's occlusion and contrast), then the checks that move focus (focus scrolls the page and changes the occlusion results).
3. axe: `const s = await (await fetch('https://cdn.jsdelivr.net/npm/axe-core@4.13.0/axe.min.js')).text(); await page.evaluate(s)` → `page.evaluate(() => axe.run({exclude:[['deepl-input-controller'],['deepl-page-load-popup'],['aside-inline-menu']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']},resultTypes:['violations']}))`. (evaluate bypasses the page's CSP. Arguments are capped at 128 KB, hence the fetch on the PC side.)
4. Canonical name, role and state: `K.X(tab,'Accessibility.getFullAXTree')` (includes expanded · required · invalid · describedby) — drop extension nodes. A snapshot is enough for a quick look.
5. webcheck + extra (`kit/webcheck.js`, `kit/webcheck-extra.js`): missing focus indicator (2.4.7) · obscured focus (2.4.11) · text spacing (1.4.12) · paste blocking (3.3.8) · target size (with its exceptions) · fake buttons (onclick/`__reactProps$`) · contrast including ancestor opacity.
6. Keyboard: `keyboard.press('Tab')` N times → record `document.activeElement` (order, keyboard traps — 2.1.2). For Space use `K.X(tab,'Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '})` + `keyUp` — 🔴 `keyboard.press('Space')` sends an empty key; never judge with it.

## Verdict
axe `violations` = 0 (critical and serious first) · every control can be operated and left by keyboard alone · manual-check items handed over as a list.

## Report
`WCAG criterion · rule · element · value · suggested fix`, with manual items listed separately.
