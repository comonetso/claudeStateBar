# "Click this button" · "Type this in"

Prerequisite: SKILL.md §0–§2. 🔴 Automation "succeeds" on covered elements and `trial` really clicks — judge with checks in code.

## Steps
1. **Classify first**: does the button change data (send · save · delete · invite · pay · settings)? If so, **don't click** — report the expected result (the expected request) and get approval. Only the approved target and action.
2. `snapshot(page,{interactive:true})` → target ref → `K.canAct(tab, loc)` (unique · visible · not covered). If it is covered, report "the user can't click this" (automation would pass through a synthetic click).
3. If a confirm dialog may appear, call `K.denyConfirm(tab)` **right before**.
4. `__diag.mark('click')` → `page.locator(ref).click()` (for right-click, coordinates or a delay: `boundingBox` + `page.mouse.click(x,y,{button,delay})`) → a new snapshot with the same options, `diff`, `dump({since})` and `K.img`.
5. Typing: `isVisible` before, `document.activeElement === target` after. 🔴 `fill` on a hidden field leaks into whichever other field has focus. Never type `\n` — send with `keyboard.press('Enter')`, break lines with `Shift+Enter`. Compare `selectOption`'s return value with the requested value (a missing value picks the first option). `setInputFiles` always takes an array. Korean/CJK text: `keyboard.type` (composed characters), or real IME composition via `K.X(tab,'Input.imeSetComposition',…)` → `Input.insertText`.
6. `isTrusted === false` on the resulting event is a sign the element was covered.

## Verdict
The expected change shows in the diff, the requests or the screen · 0 errors · focus is where it should be.

## Report
`element clicked (ref · name) · covered? · screen change (diff excerpt) · request (method · path · status · rid) · confirm text (__lastConfirm) · capture`.
