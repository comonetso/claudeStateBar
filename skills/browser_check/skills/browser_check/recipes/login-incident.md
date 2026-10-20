# "I got logged out" · "Why did it kick me out"

The user's own browser is Aside, which browser_check cannot reach: what their tabs showed is for the Claude inside Aside (or the user's own screenshot). browser_check works from server evidence, and from ego only when the logout happened in ego.

## Steps
1. Server evidence: the server's session / refresh-token records for that token family — the revocation reason (e.g. `revoke_reason = 'reuse_detected'` ⇒ a lost response) · the last rotation row (e.g. `rotated_at IS NULL`) · the revocation time. 401s and socket close codes in the API logs. Our own agent activity at that moment (a task space closed with requests in flight · a run cut by its timeout · a `page.fetch` to an auth endpoint · a write guard that refused the refresh POST).
2. If it was ego: 🔴 don't open the logged-in app again first — a new page rotates the token and changes the evidence. Read the space list only (`listTaskSpaces()`, `task.tabs()` of our own spaces).
3. Classify: ① lost response (a space closed early · a cut run) ② old session revoked by a new login (another device) ③ refresh refused by our guard (the page shows the login screen, the server saw nothing) ④ expiry or server policy.

## Report
Timeline (rotation · revocation · space closed) · cause · prevention (which SKILL.md §1 rule was broken) · ask the user to sign in again in ego if it was ego's session.
