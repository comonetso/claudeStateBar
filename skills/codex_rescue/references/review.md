# REVIEW — "리뷰시켜" (review the changed code)

1. **Check it is a git repository.** If not, don't run — review works on a git diff, so only inside a repository (`send.sh` refuses too, but say so first). If they meant a problem they're stuck on, point them to CONSULT.

2. **Pick a slug** — English kebab-case, 2–4 words saying what is reviewed (`auth-refactor`, `mms-sender-fix`). `send.sh` makes the stamp.

3. **Take the scope from context:**
   - "against main" · "the whole branch" → `--base main`
   - "just this commit" · a SHA is mentioned → `--commit <SHA>`
   - "my current work" · "before committing" → `--uncommitted`
   - nothing said → **pass nothing**; `send.sh` decides (the uncommitted changes if any, otherwise against the default branch)

4. **Do §2-1 (preflight.md), then run in the background.** Append the line for the chosen depth to the focus instruction (with no focus, the line alone is the focus):
   - 얕게: `변경분 안에서 눈에 띄는 결함만 빠르게 짚어라. 변경분 밖 호출부는 따라가지 마라.`
   - 보통: `변경분과 직접 닿는 호출부까지 읽고, 지적마다 파일 경로와 줄 번호를 적어라.`
   - 깊게: `변경분이 닿는 호출 관계와 엣지 케이스까지 따라가고, 지적마다 스스로 반증해 본 뒤 남은 것만 적어라.`

   ```
   Bash(run_in_background: true):
     CR_CONFIRMED=1 CR_LIVE_STEER=1 bash "${CLAUDE_SKILL_DIR}/send.sh" --review --slug <slug> --subject "<one-line title, about 20 characters>" [--base X|--commit Y] [focus]
   ```

   - 🔴 **Never drop `CR_LIVE_STEER=1`.** With it, `send.sh` **generates** the request `<stamp>_request_<slug>.md` (`mode: review`) and runs it through the request path — steering (steer.md), partial saves and follow-ups (followup.md) work exactly as in CONSULT. You don't write the request.
   - Without it, the old dedicated review (`codex exec review`) runs — **only when the user asked for "the old way"**. That path can't be steered, loses everything if a limit cuts it, and can't be followed up.
   - The verdict criteria are Codex's official review rubric (`prompts/review_rubric.md`), put into the prompt. Scope and focus **can be combined** (the CLI limit below applies to the old path only).
   - `--subject` is the progress-card title; **don't confuse it with `--title`**, which goes to `codex exec review` as is.

5. **Automatic wake-up → review.** The result is saved to `docs/codex_rescue/<stamp>_response_<slug>.md` (old path: `<stamp>_review_<slug>.md`).
   1. Read it — `## 1. 지적` (priority [P0]–[P3] · location · confidence) and `## 2. 전체 판정`
   2. **Never edit Codex's text.** Append `## Claude 검토` — adopt / hold / reject for each point, with reasons
   3. 🔴 **Never fix every point automatically.** Reviews mix false positives and matters of taste. If you judge a point false, write the code-based counter-evidence. What to fix is the user's call
   4. If you couldn't confirm a rejection with code, follow up (results.md §10, followup.md) — the same rule as CONSULT

REVIEW needs no EDIT-style confirmation (it is read-only), but §2-1 still applies.
"Review it and fix it" ⇒ run REVIEW, then **you** fix it — Codex doesn't fix in a review, and you are the one doing the work.

## Old dedicated review only — scope and focus can't be combined

`codex exec review` treats the scope flags and `[PROMPT]` as mutually exclusive:

```
error: the argument '--uncommitted' cannot be used with '[PROMPT]'
```

`--base` and `--commit` behave the same. So `send.sh`:

- **no focus** → uses the scope flag (exact)
- **focus given** → drops the flag and **writes the scope into the prompt as a sentence**

The second is less exact. The `send.sh` report says which way it went, and the result frontmatter records `scope_via: flag|prompt`. **With `prompt`, check that the review really covered that scope**; if not, rerun without the focus (flag mode).
