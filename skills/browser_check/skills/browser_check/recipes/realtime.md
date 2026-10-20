# "Check realtime sync" · "Do two tabs update together"

Prerequisite: SKILL.md §0–§2. Sending, editing or deleting test messages is a **data change** — get the test account, test room and count approved.

## Steps
1. Plan and approval: which room, how many items, how to clean up (delete).
2. Two pages in one task space: `p1` from `bc.run` and `const b = await task.newPage()` → `b.goto(sameUrl)`. In a logged-in app each open is one token rotation — the other page's socket may drop briefly and reconnect. Both pages share ego's sign-in; they are not two users.
3. Watcher in page B (`b.evaluate`): a `MutationObserver` records `Date.now()` when the target (e.g. `[data-message-id]`) first appears or changes. In page A take the request start from the recorder (`diag-v2.1`, `t + performance.timeOrigin`) or `Date.now()` right before the click.
4. Act in A (click the input → `page.keyboard.insertText` → **click the send button** — Enter may insert a newline depending on the user's setting) → B's update time − A's start time. Edit and delete the same way.
5. Reconnect: get the app's socket by intercepting its getter (recorder `__diag.sockets()`) → `close(3000, 'test')` → the status banner and reconnect time. 🔴 Never use close codes the app reserves (logout, update screens).
6. Clean up: delete the test messages (within the approval) → close page B with `b.close()` once its requests are at 0 (`bc.settle(b)`); `bc.run` settles and closes the rest.

## Verdict
B updates within 1 s (Aside-era example: send 62 ms · edit 175 ms · delete 38 ms) · reconnect ≈ 1 s · 0 errors. 🔴 Polling inflates this by up to 1 s — measure with an in-page watcher and epoch times.
Limit: pages in ego's minimized window may be throttled (not measured) and always report focus the way ego sets it → behaviour tied to "the window being looked at" (read receipts) can't be verified.

## Report
Per action, a timeline `A start → B ws-recv → B screen` + reconnect table + cleanup confirmed.
