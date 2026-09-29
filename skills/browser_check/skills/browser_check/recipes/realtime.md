# "Check realtime sync" · "Do two tabs update together"

Prerequisite: SKILL.md §0–§2. Sending, editing or deleting test messages is a **data change** — get the test account, test room and count approved.

## Steps
1. Plan and approval: which room, how many items, how to clean up (delete).
2. Open tabs A and B in a **persistent session** (`session/drv.py`; not on Windows — SKILL.md §3). In a logged-in app each open is one rotation — the other tab's socket may drop briefly and reconnect. Recorder v2.1 in both tabs.
3. Watcher in tab B: a `MutationObserver` records `Date.now()` when the target (e.g. `[data-message-id]`) first appears or changes. In tab A, take the request start from the recorder (`t + performance.timeOrigin`).
4. Act in A (click the input → `keyboard.type` → **click the send button** — Enter may insert a newline depending on the user's setting) → B's update time − A's start time. Edit and delete the same way (read an app modal's text from a snapshot, then click its confirm button).
5. Reconnect: get the app's socket by intercepting its getter (`__diag.sockets()`) → `close(3000,'test')` → the status banner and reconnect time. 🔴 Never use close codes the app reserves (logout, update screens).
6. Clean up: delete the test messages (within the approval) → `K.safeClose` both tabs.

## Verdict
B updates within 1 s (measured example: send 62 ms · edit 175 ms · delete 38 ms) · reconnect ≈ 1 s · 0 errors. 🔴 Polling inflates this by up to 1 s — measure with an in-page watcher and epoch times.
Limit: agent tabs always report visible and focused → behaviour tied to "the window being looked at" (read receipts) can't be verified.

## Report
Per action, a timeline `A start → B ws-recv → B screen` + reconnect table + cleanup confirmed.
