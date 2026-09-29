# "I got logged out" · "Why did it kick me out"

🔴 **Don't open a new tab on the logged-in app** — opening one rotates the token and changes the evidence. Logging back in is the human's job (autofill auto-submit risk).

## Steps
1. Server evidence: the server's session / refresh-token records for that token family — the revocation reason (e.g. `revoke_reason = 'reuse_detected'` ⇒ a lost response) · the last rotation row (e.g. `rotated_at IS NULL`) · the revocation time. 401s and socket close codes in the API logs. Our own agent activity (a tab closed at that moment · a 60 s cut · a repl fetch to an auth endpoint · an autofill menu click).
2. On the PC, `listBrowserTabs()` **list only** (don't attach) — which tabs were open.
3. Classify: ① lost response (agent tab closed early · 60 s cut · repl fetch) ② old session revoked by a new login (autofill auto-submit · another device) ③ expiry or server policy.

## Report
Timeline (rotation · revocation · tab closed) · cause · prevention (which SKILL.md §1 rule was broken) · ask the human to log in again.
