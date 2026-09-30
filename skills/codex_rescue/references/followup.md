# 11. Follow-up (FOLLOWUP) — ask Codex again about its analysis

Only when results.md §10 says so, or when the user asks ("ask again", "push back on that"), and only for a case that has a response file.

```
Bash(run_in_background: true):
  CR_CONFIRMED=1 CR_LIVE_STEER=1 bash "${CLAUDE_SKILL_DIR}/send.sh" --followup docs/codex_rescue/<stamp>_followup<N>_<slug>.md
```

- 🔴 **Never drop `CR_LIVE_STEER=1`** — same reason as turn 1: without it the old `codex exec resume` runs and nothing can be passed in mid-turn. Drop it only when the user asked for "the old way".
- Do §2-1 (preflight.md) before sending — model · reasoning · depth, every turn. Prefix `CR_MODEL` / `CR_EFFORT` only for values other than Codex's config, and put the chosen depth's section into the follow-up file (template below).
- Write the follow-up file first (template below). `turn:` is the response's `turns` + 1 — `send.sh` refuses a wrong value.
- 🔴 **Never pass the follow-up text as an argument.** Write it in the file.
- Codex only **reads** in this turn (read-only is fixed). `send.sh` appends the turn to the response document.
- 🔴 **Never run a follow-up file through the request path** (as a RESUME). Both point to the same `response_path`, so every check passes, Codex runs with workspace-write and **overwrites the whole response document** — turn 1 and your review with it, N turns of conversation at once. `send.sh` blocks it both ways, but never send it that way.
- **Exception — more edits on an EDIT case.** Only when the original request is `mode: edit` and the follow-up frontmatter has **`edit: yes`** does Codex continue the same conversation and edit code.
  - 🔴 **The EDIT gate applies every turn.** Turn 1's approval doesn't carry over — confirm with the user again and send `CR_CONFIRMED=1 CR_ALLOW_EDIT=1 CR_LIVE_STEER=1 bash … --followup <file>`. Without `CR_ALLOW_EDIT`, `send.sh` refuses
  - Under "이번 턴에 묻는 것", write **what to fix** (target files, expected behaviour)
  - Partial saves go to a per-turn edit record `docs/codex_rescue/<stamp>_edit<N>_<slug>.md`; `send.sh` still appends to the response document and moves the edit record under that turn at the end
  - Afterwards **check the actual changes yourself with `git diff`**, then review (same as a turn-1 EDIT)
  - `edit: yes` on a CONSULT or REVIEW case is refused. To have Codex apply those results, write a new EDIT request
  - This turn can be steered as well (`CR_LIVE_STEER=1`); files already changed aren't undone
- Codex **reads your previous `## Claude 검토` directly** — the follow-up is only as good as that review. **Your review is the next turn's input.**
- When the answer comes, review it as in results.md §9, re-score the gate, and go back to the end table (results.md §10) to decide whether to end or ask once more.

## Follow-up template

Write `docs/codex_rescue/<stamp>_followup<N>_<slug>.md`. 🔴 **Use the original case's stamp and slug.** `turn` = the response's `turns` + 1. Keep the template in Korean exactly as it is (same reason as request-template.md).

The `## 조사 깊이` section takes the block from request-template.md "조사 깊이 문안". A follow-up has no source table and its gate table sits above, so in **얕게** write `우선 볼 원본: <1~2개>` and `완료 게이트는 이 범위에서 …` (drop "위 표에서" and "아래").

For more edits on an EDIT case only, add one line `edit: yes` to the frontmatter, drop the sentence "너는 파일을 쓰지 않는다" from "## 이 턴의 성격", and write the **target files and expected behaviour** under "## 이번 턴에 묻는 것". Run it only after the user confirms, with `CR_ALLOW_EDIT=1`.

```markdown
---
type: codex_followup
mode: followup
stamp: <260825_143012>
slug: <fcm-token-null>
turn: 2
response_path: docs/codex_rescue/<260825_143012>_response_<fcm-token-null>.md
---

# 되묻기 <N>턴 — <한 줄 제목>

## 이 턴의 성격
네 앞 턴 분석을 내가 검토했다. **내가 좁게 읽었을 수 있다.**
아래는 내가 무엇을 어떻게 판단했는지이고, 틀린 곳이 있으면 **그것부터 바로잡아 달라.**
너는 파일을 쓰지 않는다 — 읽고 답만 하면 된다. 답은 자동 회수돼 대화 문서에 이어 붙는다.

## 내가 네 분석을 이렇게 읽었다     ← 오해가 있으면 여기서 잡아라
- 너는 원인을 <X> 라고 했고, 나는 그것을 <이렇게> 이해했다.
- 네가 제시한 수정안 <Y> 를 나는 <이런 뜻> 으로 받았다.
- ⚠️ 내가 자신 없는 해석: <...>

## 항목별 판정과 근거
| 네 지적 | 내 판정 | 근거 (실측·코드·로그) |
|---|---|---|
| <지적 1> | 채택 | <...> |
| <지적 2> | **기각** | <파일:라인 / 로그 / 실험 결과> |
| <지적 3> | 보류 | <무엇이 확인 안 됐는지> |

🔴 기각한 것은 **근거를 보고 다시 판단해 달라.** 내 근거가 틀렸으면 왜 틀렸는지 반박해라.

## 내가 실제로 검증한 것과 결과
1. <네 가설대로 확인해 봤다> → <나온 값>

## 1턴 이후 새로 얻은 정보
- <로그 / 코드 / 재현 조건 / 버전 / **사용자가 새로 말해 준 관측** — 앞 턴에 없던 것만>

## 🔴 아직 설명되지 않은 증상     ← 이게 이 대화가 안 끝난 이유다
- <증상 A>: <왜 지금 가설로 설명이 안 되는지>

## 완료 게이트 현황 — 각 항목을 네가 직접 판정해라
| # | 게이트 | 내 판정 | 근거 |
|---|---|---|---|
| G1 | 증상이 **인과 경로**로 설명되는가 | ⬜ | |
| G2 | **왜 이 조건에서만** 나는가 | ⬜ | |
| G3 | **이미 실패한 시도들이 왜 안 먹혔는지** 같은 원인으로 설명되는가 | ⬜ | |
| G4 | **반증 가능한 예측**이 하나 이상 있는가 | ⬜ | |
| G5 | 수정안이 인과의 **어느 고리를 끊는지** 명시됐는가 | ⬜ | |
| G6 | 남은 불확실성이 **열거**됐는가 | ⬜ | |

G3 가 핵심 판별식이다 — 원인 가설이 맞으면 **과거의 실패도 설명해야 한다.**

## 이번 턴에 묻는 것
1. <구체적 질문 1>

## 조사 깊이 — <얕게|보통|깊게>     ← 이번 턴 실행 전 확인(§ 2-1)에서 고른 깊이의 문안 하나 (request-template.md "조사 깊이 문안")

## 답변 형식 — 이 순서로 답해라
1. `내 해석 교정` — 내가 네 말을 잘못 읽은 곳. 없으면 "없음"
2. `기각당한 지적에 대한 재판단` — 수용 / 재반박(+근거)
3. `아직 설명 안 된 증상에 대한 설명` — 못 하면 "못 한다 + 무엇이 있어야 하는지"
4. `완료 게이트 자기판정` — G1~G6 각각 **충족 / 미충족 + 한 줄 근거**
5. `수정된 근본 원인` — 앞 턴에서 바뀌었으면 무엇이 왜 바뀌었는지
6. `다음 턴에 필요한 자료` — 없으면 "없음"
7. `지금 종료해도 되는가` — **예/아니오 + 이유.** '더 물을 게 없다'가 아니라
   **'핵심 증상이 설명됐다'** 를 기준으로 판단해라
```
