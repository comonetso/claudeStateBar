---
name: codex_rescue
description: Get a second view from the Codex CLI (OpenAI) in a fully automatic round trip — no pasting, no "done" notices. Picks the mode by meaning — CONSULT (default; Codex independently investigates a problem you're stuck on from a request file; follow-ups possible), REVIEW (Codex reviews the git diff by its official rubric), EDIT (Codex edits code after confirmation), CHAT (short ping-pong, only when explicitly asked), HELP, or RESUME (a request/response path). Codex is an adviser; send.sh measures and reports any file changed besides the response. Korean triggers: "리뷰시켜", "리뷰해줘", "바뀐 코드 봐줘", "커밋 전에 훑어줘", "검토요청해", "분석해줘", "분석요청해", "검토및 수정요청해", "분석하고 수정시켜", "수정시켜", "고쳐줘", "코덱스에 물어봐", "코덱스 질문지", "codex_rescue", "코덱스 사용법". Ping-pong only when explicit — "코덱스와 대화해", "핑퐁으로 물어봐"; every other phrase above stays CONSULT.
---

# codex_rescue — automatic round trip to Codex for a second view

Language: talk to the user in the user's language. Script and tool output is in English. The request and response document templates, and the headings and labels the scripts write into documents, stay in Korean exactly as they are — the scripts write and refer to those strings.

## 0. Intent — decide this before anything else

Read the argument **in context** and pick one mode. 🔴 **Never match keywords mechanically** — users phrase the same thing differently every time (speech-to-text included). The examples show the criteria, not a fixed list.

| The user wants | Mode | Sounds like |
|---|---|---|
| usage | **HELP** | `help` · `--help` · `-h` · `?` · `사용법` |
| rerun something already made | **RESUME** | only when the **whole** argument is one `.md` path |
| **ask again about the last analysis** | **FOLLOWUP** | "다시 물어봐" · "되물어" · "그거 반박해봐" — or **your own call** (results.md §10) |
| **a short back-and-forth** | **CHAT** | "코덱스와 대화해" · "핑퐁으로 물어봐" — **only when explicit** |
| **review the changed code** | **REVIEW** | "리뷰시켜" · "리뷰해줘" · "바뀐 거 검토해" · "커밋 전에 훑어줘" |
| **look and fix it** | **EDIT** | "검토및 수정요청해" · "분석하고 수정시켜" · "수정시켜" · "고쳐줘" · "네가 고쳐" |
| look at what I'm stuck on | **CONSULT** (default) | "검토요청해" · "분석해줘" · "분석요청해" · problem text · **no argument** |

Two axes: **what is the target** (the whole change set vs one stuck problem) and **should Codex fix it** (opinion vs direct edit). Changed code, no fix ⇒ REVIEW · stuck problem, no fix ⇒ CONSULT · stuck problem, fix ⇒ EDIT · short repeated exchange ⇒ CHAT.

- **"분석" (analyze)** is CONSULT by default; if the target is a work product ("analyze this code") it is REVIEW; with a fix added (`분석하고 수정시켜`) it is EDIT.
- 🔴 **CHAT only when the user says so** (user decision; it overrides Codex's own advice to default to the light mode). "코덱스한테 물어봐", "분석해줘" stay CONSULT.
- REVIEW vs CONSULT: both read-only, a wrong pick costs little — don't ask; decide from context (you were just editing code ⇒ REVIEW, stuck on a problem ⇒ CONSULT).
- **Unclear whether EDIT is meant ⇒ always confirm in one line.** It really changes code and is costly to undo.
- Mode words used **descriptively** ("the login review doesn't work", "the fix doesn't take") are **problem text** ⇒ CONSULT.
- "Review it and fix it" ⇒ REVIEW, then **you** fix it (Codex can't fix in a review).
- A `.md` inside problem text doesn't make it RESUME.
- The old English flags (`--readonly` · `--edit` · `--review`) are still accepted for compatibility but not recommended.

RESUME goes by file name:

| Argument file | What to do |
|---|---|
| `<stamp>_request_<slug>.md` | response exists ⇒ review it; else **rerun** it (results.md "RESUME") |
| `<stamp>_followup<N>_<slug>.md` | **run it with `--followup`**; if it already ran (response `turns` ≥ N), review that turn instead |
| `<stamp>_response_<slug>.md` | read and review it, and **decide whether to follow up** (results.md §10) |

🔴 **Never run a follow-up file through the request path** — it would overwrite the whole response document (followup.md).

## 1. Hard rules — they hold even when nothing else has been read

- **You and the user do the work; Codex is an adviser.** A request is an analysis for Codex to refute and add angles to, not a work order. Codex doesn't change production code (EDIT is the only exception); it writes only the response document and `docs/codex_rescue/.scratch/` (its workbench, free to use). Its disk reading and network are open.
- **Pre-run gate** — before CONSULT · EDIT · REVIEW · FOLLOWUP · RESUME and a CHAT `--start`, ask per §2-1 and add `CR_CONFIRMED=1` **only after the user answered.**
- **EDIT gate** — `CR_ALLOW_EDIT=1` **only after explicit approval**, and again on **every** EDIT follow-up turn.
- **Changes outside the response file** (🔴 in `send.sh`'s report) go to the user **before anything else. Never revert them yourself.**
- **Live steering is always on** — add `CR_LIVE_STEER=1` to CONSULT · EDIT · REVIEW · FOLLOWUP runs; drop it only when the user asks for "the old way". It can't be switched on after the start, and nobody knows at the start whether it will be needed. CHAT can't be steered. Under workspace-write it also opens the network (`CR_NETWORK=false` turns that off).
- **Runs started together share a group name** — when you start two or more runs at once, put the same `CR_GROUP="<short name>"` on every one of them (a few words naming the batch, in the user's language, e.g. the cycle or step). The progress panel shows them as one group card. Never set it for a single run; a follow-up keeps its run's group by itself.
- Never use `CR_SANDBOX=danger-full-access` (change detection can't see outside the cwd and would falsely report "no changes").
- Stamps come only from running `date "+%y%m%d_%H%M%S"`. Every request carries its complete `response_path`.
- **Never edit Codex's text**; your review goes below it as `## Claude 검토`. "Arrived" isn't "succeeded" — read the content.
- **Always say which mode you picked** — it was judged from meaning and may be wrong.

## 2. Read the file for the mode before acting

Paths are `${CLAUDE_SKILL_DIR}/references/<file>`. Read the whole file.

| Mode / moment | Read |
|---|---|
| HELP | `help.md` |
| CONSULT · EDIT | `preflight.md` → `consult.md` → `request-template.md` |
| REVIEW | `preflight.md` → `review.md` |
| CHAT | `chat.md` (+ `preflight.md` before `--start`) |
| FOLLOWUP | `preflight.md` → `followup.md` |
| RESUME | `results.md` ("RESUME") |
| a run finished (the watcher printed `send.sh`'s report) | `results.md` |
| the user speaks while a run is going | `steer.md` |
| errors, `stale`, `STALE` from the watcher, a launcher refusal, re-arming after a reload, `codex-via-stdout`, Windows sandbox trouble | `troubleshooting.md` |

After a context compaction, re-read the file for the current step — the details don't survive it.

### 2-1. Pre-run confirmation

Query Codex's limits and settings, then ask model · reasoning (Codex's config first) and depth (shallow / normal / deep) in one go and apply the answer — `preflight.md`. `send.sh` refuses to run without `CR_CONFIRMED=1`.

## 3. Output after sending

CONSULT, EDIT, REVIEW, FOLLOWUP and RESUME always run **detached** from your command, in two steps:

1. **Launch — synchronous Bash**, the `CR_*` variables in front: `node "${CLAUDE_SKILL_DIR}/scripts/launch.mjs" --bash "$BASH" <the send.sh arguments>`. It returns within seconds and prints the stamp and **a watch command**. If `send.sh` refused before starting (no `CR_CONFIRMED`, the EDIT gate, a bad argument), the launcher prints that refusal and exits with `send.sh`'s code — nothing is running; handle it as you would a `send.sh` refusal.
2. **Watch — `Bash(run_in_background: true, timeout: 7200000)`** with that exact watch command. It ends with `send.sh`'s report → `results.md`. Before your command's 2-hour maximum it ends by itself with `⏳ still running — re-arm: <command>` — run the same watch command again. **Never launch the run again.**

The run doesn't depend on the watcher: Claude's command time limit (30 minutes by default, 2 hours at most) and a window reload end only the watcher. After a reload, resume or compaction the plugin's session-start hook lists this conversation's runs whose result you haven't received, each with its watch command — re-arm them. CHAT stays synchronous (chat.md).

After launching, post only this (in the user's language):

1. **Mode** — e.g. `mode: consult (Codex only analyzes)` / `mode: code review (git diff, Codex only analyzes)` / `mode: edit (Codex edits directly)`
2. **Target** — CONSULT · EDIT: which problem (always say it if you picked it yourself); REVIEW: the scope (`uncommitted changes` / `against main` / `commit abc123`)
3. The path of the file created (the request, or where the review result will appear)
4. "Handed to Codex. I'll pick it up and review it automatically when it's done — feel free to give me other work meanwhile."

Don't dump the request into the chat — the file is canonical. After the review, report adopt / hold / reject and the plan.
