# CHAT (ping-pong) — "코덱스와 대화해"

For when you and the user want **another view once**, asked and answered on the spot. 🔴 **Only when the user explicitly asks for it** — "분석해줘", "코덱스한테 물어봐" stay CONSULT.

🔴 **A new `/codex_rescue` call always starts with `--start`.** Even if an earlier conversation key is visible in this window, don't reuse it. **This is the one judgement the script can't check** — every other mistake (missing option, typo, unknown or closed key, another machine) is stopped before Codex is called.

1. **Pick a slug** — English kebab-case, 2–4 words; the unit of file names and locks. 🔴 **The slug is not the conversation id.** The id is the **conversation key** (`ymd_His`) that `send.sh` issues; the slug is only the topic name on the file. The same slug in **a new skill call is a new conversation.** A new topic gets a new slug.

2. **Keep the question short and name what to look at.** 🔴 That is the whole mode. What makes it slow is not allowing exploration but **not naming a target** — measured on a real 320-file repo: exploration allowed + a light question 7 s (0 commands) · a file named 25 s (1 command) · `--look` inline 10 KB 8 s, 56 KB 9 s · **no target, a broad design question: over 240 s and 105 commands.**
   - **If code must be seen, name it with `--look <path>`.** The script puts the file **straight into the prompt**, so Codex needn't search, exploration stays blocked, and the answer is grounded. Part of a file: `--look <path>:<start>-<end>`. Repeatable. No directories — **choosing the files is the point.** Over 64 KB in total is refused (`CR_CHAT_LOOK_MAX`); anything bigger isn't ping-pong
   - **One question at a time.** Not enough? Throw one more line — that is ping-pong
   - **The script stops at 60 s** (`CR_CHAT_LIMIT`). Of the measurements above only the last one hits it — **hitting it means the target is missing.** Split the question or add `--look`
   - State the answer length too — "within 3 lines", "one line, plus one line of reason"
   - If **you** don't know where to look either, it isn't CHAT but CONSULT

   Exploration policy:

   | | What Codex can see | Limit |
   |---|---|---|
   | default (no option) | only what is in this conversation | 60 s |
   | **`--look <path>`** | the conversation + **what you inlined** (exploration still blocked) | 60 s |
   | `--explore` | Codex walks the tree itself | **`CR_CHAT_LIMIT` required** |

   - `--look` and `--explore` combine into "look at this first, search if it's not enough" — less exploration than `--explore` alone.
   - 🔴 **`--explore` alone is refused**; set `CR_CHAT_LIMIT` with it. At 60 s an exploration is almost surely cut, and a cut **discards the thread** — the whole turn is lost. Two deliberate choices are required so it can't fail silently (the same structure as the EDIT gate).
   - **Suspect `--look` first.** `--explore` is rarely really needed.

3. **Run synchronously.** 🔴 **Never `run_in_background`** — the opposite of the other modes; the point is to put the answer straight into the chat.
   Before the first `--start` turn, do §2-1 (preflight.md). Not for `--resume-stamp` turns.
   🔴 **Every turn takes exactly one of `--start` / `--resume-stamp`.** Without it the script refuses — it is the only signal that splits conversations per skill call.

   ```
   # first turn of this call — always a new document; send.sh issues the key
   Bash(timeout: 180000):
     CR_CONFIRMED=1 bash "${CLAUDE_SKILL_DIR}/send.sh" --chat --start --slug <slug> [--subject "<one line>"] "<question>"

   # next turn of the same call — pass the previous stdout's `conversation key:` value as is
   Bash(timeout: 180000):
     bash "${CLAUDE_SKILL_DIR}/send.sh" --chat --resume-stamp <key> --slug <slug> "<question>"

   # ★ a question that needs code — name it (likely the most common form)
   Bash(timeout: 180000):
     CR_CONFIRMED=1 bash "${CLAUDE_SKILL_DIR}/send.sh" --chat --start --slug <slug> \
       --look src/main.js --look src/db.js:40-120 "<question>"
   ```

   - `--subject` is the document title, **`--start` only** (CHAT isn't shown in the progress panel, so it is no card title).
   - To only close a conversation: `--close-stamp <key>` (Codex isn't called). `--new` no longer exists.

4. **Put both sides in the chat** — the user needs to see the exchange to judge; that is why this mode exists.

   ```
   ✳️ **클로드:** <what you asked>          ← before running
   🔷 **코덱스:** <the answer as is>         ← after
   ```

   🔴 **Never change these two emoji** — they match the status-bar provider colours (Claude orange, Codex blue), and `send.sh` writes the same marks into the document. (The real status-bar glyphs are private-use font characters and show as boxes in chat; codicon syntax doesn't work there either.)
   🔴 **Never summarize or polish Codex's answer.** Copy it verbatim — the user sees Codex's words, not your reading of them. Your view goes **separately** below.

5. **Add your judgement** — agree or push back in a line or two. Without it this is dictation, not ping-pong.

6. **Link the conversation document once, when the ping-pong ends.** 🔴 **Not every turn** — a link between turns breaks the flow. When you stop asking Codex and hand back to the user, add one last line (in the user's language):

   ```
   → record: [260822_141436_chat_joke-pingpong.md](docs/codex_rescue/260822_141436_chat_joke-pingpong.md) · 2 turns
   ```

   The chat scatters turns between other messages; the document shows the whole conversation at once, so it is useful at the end, not midway. If the user later says "ask once more", that is a new end point — link again then. Take the path **as is** from the `record:` line of `send.sh`'s stdout; don't guess it (the stamp and the file depend on resume vs new thread). A Markdown link is enough.

## Where CHAT differs

| | CONSULT · REVIEW · EDIT | CHAT |
|---|---|---|
| call | `run_in_background: true` | **synchronous** |
| request | CONSULT · EDIT need one | none — the question is the argument |
| progress panel | shown as a card | **not shown** (writes no events to `.log/`) |
| permission | workspace-write | **read-only, fixed** |
| change detection | scanned | **none** — nothing can be written |
| where the user reads | document / panel | **the chat** |

The conversation document is **`<project root>/`**`docs/codex_rescue/<stamp>_chat_<slug>.md`, written by `send.sh` (turns are appended as `✳️ **클로드**` / `🔷 **코덱스**`). The root comes from `git rev-parse --show-toplevel`, so calls from subfolders continue the same file; outside a repo it warns and writes under `$PWD` (resuming won't work then). Frontmatter `thread_id` lets the next turn resume — **the conversation's lifeline; never edit it by hand.** The stamp in the file name is the **conversation key** passed as `--resume-stamp`.

- **A failure discards the thread.** Codex keeps an unanswered turn that the document doesn't, so resuming would put them out of sync. The document gets `⚠️ 스레드 끊김` and the next turn starts a new conversation. **Never force a broken thread back together.** Failure = exit code and answer checked together — partial output with a non-zero exit is a failure.
- **A killed run is recovered by the next run.** Dying between the Codex call and the document write (SIGKILL, timeout) leaves the session advanced and the document on the old `thread_id`. The `.log/.chat_<slug>.inflight` marker flags that window; the next run finds it and discards the thread. 🔴 **Never delete the marker by hand** — you would resume a desynced session. (The marker also carries the question text, stamp, slug and subject, which the Claude State Bar chat panel reads to draw the "waiting for the answer" turn; the document only ever holds confirmed turns.)
- **A conversation started on another machine doesn't continue.** Documents travel via git but Codex sessions are per machine; a different `origin` gives up resuming and starts a new conversation.
- **`--close-stamp` only closes** (no Codex call): it clears the target document's `thread_id` and leaves `⏹ 새 대화로 전환`. The target must be named explicitly (the old `--new` guessed it with a glob and could close the wrong document for good).
- **Session lock**: two turns at once on the same slug are refused (answers would interleave). The lock records nonce, pid, host and time and is released **only by its own nonce**.
- ⚠️ **A Bash timeout (3 min) doesn't mean it failed** — measured: the answer arrived and the document was written just before the cut. **Check the conversation document first.** The lock was released normally even then.
- CHAT can't be steered (`codex exec resume` path; `CR_LIVE_STEER` is ignored). Never promise it.
