# "Click this button" · "Type this in"

Prerequisite: SKILL.md §0–§2. 🔴 A click can "succeed" on a covered element — judge with checks in code.

## Steps
1. **Classify first**: does the button change data (send · save · delete · invite · pay · settings)? If so, **don't click** — report the expected result (the expected request) and get approval. Only the approved target and action. For everything else consider `--guard-writes` (on a logged-in site mind the token-refresh path — SKILL.md §1).
2. `page.snapshot()` → the target ref → check it in the page: one match · a non-empty box · `document.elementFromPoint(centre)` is it or inside it. If covered, report "the user can't click this".
3. Start any wait **before** the action: `const pop = page.waitForEvent('popup')` for a new page · `page.waitForEvent('download')` only with approval.
4. `page.click('@12', { label: 'open order details' })` (for right-click or coordinates: `page.mouse.click(x, y, { button: 'right', label: '…' })`) → wait for the expected state (`waitForURL` / `waitForSelector` / `waitForFunction`) → a new snapshot · `bc.problems(page)` · `bc.shot` if it is visual. A `receipt.dialog` must be handled: `page.dismissDialog()` unless approved.
5. Typing: the field is visible before, `document.activeElement` is the field after. 🔴 `fill` on a hidden field leaks into whichever field has focus. Never type `\n` — send with `page.press(sel, 'Enter')`, break lines with `Shift+Enter`. Read the value back after `selectOption`. `setInputFiles` takes absolute paths on the PC. Korean/CJK text: `page.keyboard.insertText(text)` (or `page.cdp('Input.imeSetComposition', …)` → `Input.insertText` for a real composition) and read the value back.

## Verdict
The expected change shows in the snapshot, the requests or the screen · 0 errors · focus is where it should be.

## Report
`element (ref · name) · covered? · screen change (snapshot excerpt) · request (method · path · status · rid) · dialog text · capture`.
