# codex_rescue 개편(2026-08-25)이 이 확장에 미치는 영향

> 스킬 쪽(`~/.claude/skills/codex_rescue/`)을 크게 고쳤습니다.
> **확장 코드를 읽고 영향을 실측 대조한 결과**를 정리합니다.
>
> 기준 확장 버전: **1.13.0** — 이 문서의 코드 인용과 행 번호는 그 시점 기준입니다.
> §2 의 항목 중 일부는 **수정 작업이 진행 중**이므로, 고치기 전에 현재 소스와 한 번 대조하십시오.
>
> 분석한 파일: `src/providers/codexRescue/runDiscovery.ts` (904행) ·
> `src/providers/codexRescue/execEvents.ts` · `src/providers/codexRescue/chatDiscovery.ts` (523행) ·
> `src/codexRescuePanel.ts` · `src/codexChatPanel.ts`

---

## 0. 스킬 쪽에서 무엇이 바뀌었나

| 변경 | 내용 |
|---|---|
| **FOLLOWUP 신설** | CONSULT 가 단발에서 **multi-turn** 이 됐다. `codex exec resume` 으로 이어간다 (턴 상한 11) |
| 새 문서 종류 | `<스탬프>_followup<N>_<슬러그>.md` — Claude 가 쓰는 **반박서** |
| 응답 문서 frontmatter | `thread_id` · `origin` · `turns` 3개 필드 추가 (send.sh 가 심는다) |
| events.jsonl | followup 턴은 **append** 된다 (`tee -a`). 덮어쓰지 않는다 |
| 턴별 로그 | `<스탬프>_t<N>_stderr.log` · `<스탬프>_t<N>_last_message.md` |
| in-flight 마커 | `.log/.consult_<스탬프>.inflight` (CONSULT 전용, 기존 `.chat_<슬러그>.inflight` 와 별개) |
| **`.scratch/` 신설** | `docs/codex_rescue/.scratch/` — Codex 의 작업 폴더. `.gitignore` 자동 생성 |
| CHAT `--look` | 파일을 프롬프트에 인라인으로 실어 보냄. 마커에 `look=` · `look_bytes=` · `explore=` 헤더 추가 |
| CHAT 상한 | 120초 → **60초** |

배경: 같은 장애를 CONSULT 로 3회 물어도 결론이 안 났는데 사용자가 Codex 와 직접 11턴 대화하니
결론이 났습니다. **차이는 모델이 아니라 턴 수였습니다.** 그래서 되묻기를 붙였습니다.

---

## 1. ✅ 저절로 되는 것 — 고치지 않아도 됩니다

### 1-1. followup 턴이 굳어 있던 카드를 다시 잡는다

`runDiscovery.ts:410-420` 의 `settled` 캐시 무효화가 **이 경우를 처리합니다.**

```ts
const cached = settled.get(cacheKey);
if (cached) {
    if (eventsStat && eventsStat.size === cached.size && eventsStat.mtime === cached.mtime) {
        runs.push(cached.run);
        continue;
    }
    // The file moved under a stamp we had already written off — a re-run.
    settled.delete(cacheKey);
    tails.delete(cacheKey);
}
```

followup 은 **같은 스탬프에 events.jsonl 을 append** 하므로 size·mtime 이 둘 다 바뀝니다.
→ 캐시가 버려지고 파서 오프셋이 0 으로 리셋되며 1턴+2턴 이벤트가 다시 파싱됩니다.
→ 카드가 목록에서 사라지지 않고 다시 잡힙니다. 여기까지는 손댈 것이 없습니다.

스탬프를 재사용한 이유가 이것입니다. 새 스탬프를 발급했다면 `<새스탬프>_request_*` 가 없어
slug 가 `(unknown)` 으로 떨어지고 결과 문서 링크도 끊겼을 겁니다.

🔴 **단, 다시 파싱한 *결과* 는 온전하지 않습니다.** 처음 이 문서를 쓸 때 "1턴+2턴이 통째로
다시 그려진다 → 정확히 원하는 동작"이라고 적었는데 **틀렸습니다.** 재파싱은 되지만 앞 턴 활동이
덮여 사라집니다. §2 의 `P1-A` 를 보십시오.

### 1-2. `FOLLOWUP` 모드 칩이 그냥 나온다

`codexRescuePanel.ts:593` 이 임의 문자열을 그대로 렌더합니다.

```ts
(run.mode ? '<span class="mode-chip">' + esc(run.mode.toUpperCase()) + '</span>' : '')
```

send.sh 의 `write_status` 가 `"mode":"followup"` 을 싣습니다 → `FOLLOWUP` 칩. **손댈 것 없습니다.**

### 1-3. 락이 자동으로 배타를 만든다

`deleteRun` / `trashRun` 이 `.${stamp}.lock` 을 확인합니다(`:570`, `:713`).
followup 은 **원 건과 같은 스탬프로 락을 잡으므로**, 되묻기가 도는 중에는 그 카드의 삭제·휴지통이
자동으로 거부됩니다. 별도 처리가 필요 없습니다.

### 1-4. CHAT 마커의 새 헤더는 무시된다 (깨지지 않음)

`chatDiscovery.ts:232-236` 의 `pick()` 은 **찾는 키만** 뽑습니다.

```ts
const pick = (k: string): string | undefined => {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(head);
    ...
};
```

새로 추가된 `look=` · `look_bytes=` · `explore=1` 은 조회되지 않을 뿐 **파싱을 깨뜨리지 않습니다.**
헤더는 `--- msg ---` **앞**에 넣았으므로 메시지 본문 경계도 그대로입니다.

### 1-5. 토큰 사용량 덮어쓰기는 버그가 아니다

`execEvents.ts:249-261` 은 `turn.completed` 를 만날 때마다 `st.usage` 를 **통째로 교체**합니다.
턴이 여러 번이면 마지막 턴 값만 남습니다. 처음에는 이것도 손실로 의심했지만 **정상입니다.**

스탬프 `260825_174748` 의 events.jsonl 실측:

```
1턴 turn.completed  input_tokens 293,443  (cached 261,120)  output 2,446
2턴 turn.completed  input_tokens 546,777  (cached 492,288)  output 6,013
```

`codex exec resume` 은 앞 대화를 다시 실어 보내므로 **2턴 값이 이미 세션 누적입니다.**
두 턴을 더하면 오히려 앞 대화를 두 번 세게 됩니다. 마지막 값만 남기는 지금 동작이 맞습니다.

---

## 2. 🔴 고쳐야 하는 것

### P1-A. 뒤 턴 활동이 앞 턴 활동을 덮어쓴다

`codex exec resume` 은 **턴이 바뀔 때마다 item id 를 `item_0` 부터 다시 매깁니다.**
확장의 파서는 그 id 로 항목을 찾습니다 — `execEvents.ts:190-210`.

```ts
const id = typeof item?.id === 'string' && item.id ? item.id : `anon_${st.items.length}`;
...
const existing = st.items.find(i => i.id === id);
if (existing) {
    existing.kind = kind;
    existing.status = status;
    ...
```

턴 경계를 보지 않으므로 2턴의 `item_0` 이 1턴의 `item_0` 을 그대로 덮습니다.

스탬프 `260825_174748` 의 events.jsonl(37줄) 실측입니다.

```
1턴  item_0(error) item_1(agent_message) item_2(command) item_3(agent_message)
     item_4(command) item_5(file_change) item_6(command) item_7(command)
     item_8(agent_message) item_9(file_change) item_10(command) item_11(agent_message)   … 12개
2턴  item_0(error) item_1(agent_message) item_2(command) item_3(agent_message)
     item_4(command) item_5(command) item_6(command) item_7(agent_message)               … 8개
```

**활동은 20개인데 화면에는 12개만 남습니다.** 겹치는 `item_0`~`item_7` 여덟 개가 2턴 것으로
바뀌고, 1턴에만 있던 `item_8`~`item_11` 네 개는 살아남습니다.
→ **소실이 무작위입니다.** 사용자는 무엇이 사라졌는지 알 수 없습니다.

더 나쁜 건 **kind 까지 덮인다**는 점입니다. `item_5` 는 1턴에 `file_change` 였는데 2턴에
`command_execution` 으로 바뀝니다. 아이콘과 라벨이 통째로 다른 것이 되므로,
사라진 게 아니라 **다른 활동으로 둔갑해서 남습니다.**

`existing.kind = kind` 뒤의 `if (label)` · `if (body)` · `if (raw)` 가 조건부라 더 어긋납니다.
2턴 항목에 `raw`(명령 문자열)가 없으면 **1턴의 명령이 2턴 라벨 아래 그대로 붙어 있습니다.**

턴을 구분해 id 를 유일하게 만드는 것이 정공법입니다(`turn.started` 를 셈해 `t<N>:item_0` 처럼).
⬜ **다만 어떤 키로 나눌지, 기존에 굳어 있던 카드와의 호환을 어떻게 볼지는 결정이 필요합니다.**
저는 임의로 정하지 않았습니다.

### P1-B. 되묻기가 끝나도 `마무리 중`에서 안 내려온다

`turn.completed` 가 `terminal` 을 세우는데(`execEvents.ts:250`) **`turn.started` 가 리셋하지
않습니다**(`:237-239`).

```ts
case 'turn.started':
    st.turnStarted = true;
    return;
```

그래서 1턴이 끝나며 `terminal = 'completed'` 가 박히고, 2턴이 시작돼도 그대로 남습니다.
`decidePhase` 의 이 분기에 걸립니다 — `runDiscovery.ts:276`.

```ts
if (events.terminal !== 'none') return { phase: 'finalizing' };
```

status.json 의 `state` 가 아직 `running` 인데도 카드는 **2턴 내내 `마무리 중`** 으로 보입니다.
진행 중인 활동이 계속 늘어나는데 상태만 "곧 끝남"이라 표시가 서로 모순됩니다.

`turn.started` 에서 `st.terminal = 'none'` 으로 되돌리면 해소됩니다. 다만 **1턴짜리 실행의
동작이 달라지지 않는지** 확인이 필요합니다 — 그쪽은 `turn.started` 가 한 번뿐이라 영향이
없어야 하지만, `decidePhase` 가 status 보다 이벤트를 먼저 보는 경로가 있는지 대조해야 합니다.

### P1-C. 삭제·휴지통이 followup 문서를 남긴다

`runDiscovery.ts:578` (`deleteRun`) 과 `:736` (`trashRun`) 이 **세 종류만** 처리합니다.

```ts
for (const kind of ['request', 'response', 'review']) {
    await unlinkCounting(vscode.Uri.joinPath(docsDir, `${stamp}_${kind}_${slug}.md`), res);
}
```

`<스탬프>_followup2_<슬러그>.md`, `followup3_`, … 이 **영구히 남습니다.**

⚠️ 단순히 배열에 `'followup'` 을 넣는 것으로는 안 됩니다 — **파일명에 턴 번호가 붙습니다.**
디렉토리를 스캔해서 패턴으로 잡아야 합니다.

```ts
// 제안: deleteRun / trashRun 양쪽에서
const docNames = (await listNames(docsDir)) ?? [];
const fupRe = new RegExp(`^${stamp}_followup\\d+_${escapeRe(slug)}\\.md$`);
for (const n of docNames) {
    if (fupRe.test(n)) await unlinkCounting(vscode.Uri.joinPath(docsDir, n), res);
}
```

`trashRun` 쪽은 `move(...)` 로, `TrashEntry.d` 는 `'.'` 로 넣으면 됩니다.
`restoreTrashed` 는 `meta.entries` 를 그대로 되돌리므로 **자동으로 복구됩니다.**

🔴 `slug` 를 정규식에 넣을 때 이스케이프가 필요합니다. slug 는 소문자·숫자·하이픈만 허용되지만
(send.sh 가 검증), `deleteRun` 은 외부에서 slug 를 받으므로 방어하는 편이 안전합니다.

### P1-D. 턴별 로그 파일이 정리에서 빠진다

같은 두 함수의 로그 목록(`:572`, `:731`)이 고정 5개입니다.

```ts
[`${stamp}_events.jsonl`, `${stamp}_status.json`, `${stamp}_stderr.log`,
 `${stamp}_last_message.md`, `${stamp}_heartbeat`]
```

followup 은 여기에 더해 `<스탬프>_t2_stderr.log` · `<스탬프>_t2_last_message.md` (턴마다) 를 만듭니다.
→ **11턴까지 가면 최대 20개가 남습니다.**

```ts
// 제안: 로그 디렉토리도 패턴 스캔으로
const logRe = new RegExp(`^${stamp}_t\\d+_(?:stderr\\.log|last_message\\.md)$`);
for (const n of logNames) {
    if (logRe.test(n)) await unlinkCounting(vscode.Uri.joinPath(logDir, n), res);
}
```

### P2-E. in-flight 마커가 정리 대상에 없다

`.log/.consult_<스탬프>.inflight` 가 새로 생깁니다. 정상 종료 시 send.sh 가 지우지만,
**강제 종료되면 남습니다** (그게 이 마커의 존재 이유입니다).

기존 `.chat_<슬러그>.inflight` 도 같은 이유로 정리 대상이 아니었습니다. 일관성 문제라
**같이 처리할지, 둘 다 두고 볼지 결정이 필요합니다.**

🔴 **주의: 함부로 지우면 안 됩니다.** 이 마커는 "지난 실행이 중간에 죽었다"는 **복구 신호**입니다.
확장이 지우면 다음 실행이 어긋난 세션을 조용히 재개합니다.
정리한다면 **해당 스탬프의 run 을 통째로 삭제할 때만** 지워야 합니다.

### P2-F. `.scratch/` 를 어떻게 다룰지 미정

`docs/codex_rescue/.scratch/` 에 Codex 의 조사 산출물이 쌓입니다(스크립트·중간 데이터).
`.gitignore` 는 자동 생성되므로 커밋 오염은 없습니다.

문제는 **어느 run 의 것인지 구분이 안 된다**는 점입니다. 파일명에 스탬프가 없습니다.
→ run 삭제 시 같이 지울 수가 없습니다.

선택지:
1. **그대로 둔다** — 사용자가 직접 정리. 가장 안전
2. 자동 정리(`cleanupOldRuns`)에 `.scratch/` 의 **오래된 파일** 정리를 추가 — 스탬프 무관, mtime 기준
3. 스킬 쪽에서 `.scratch/<스탬프>/` 로 나누게 요청 — **스킬 수정이 필요**

⬜ **판단이 필요합니다.** 저는 임의로 정하지 않았습니다.

### P2-G. `docOnlyStamps` 가 followup 문서를 못 본다

`runDiscovery.ts:360` 의 정규식이 세 종류만 봅니다.

```ts
const m = /^(\d{6}_\d{6})_(?:request|response|review)_(.+)\.md$/.exec(n);
```

로그가 purge 되고 followup 문서만 남는 상황에서는 카드가 안 뜹니다.
다만 실전에서는 `_response_` 문서가 반드시 함께 있으므로 **실제 영향은 낮습니다.**
`:453` 의 slug 복구 정규식도 같습니다(이쪽은 status.json 이 우선이라 더 안전).

---

## 3. 💡 개선 기회 (필수는 아님)

### 3-A. 카드에 "몇 턴째인지" 표시

지금은 followup 이 돌아도 카드가 **1턴짜리와 구분되지 않습니다.**
`CodexRun` 에 턴 정보가 없고, `status.json` 에도 없습니다.

→ 표시하려면 **스킬 쪽 `write_status` 에 `turn` 필드를 추가**해야 합니다.
필요하다고 판단하시면 스킬 쪽에 요청해 주십시오. **확장만으로는 못 합니다.**

대안: 응답 문서 frontmatter 의 `turns` 를 읽는 방법도 있지만, 그러면 카드마다 문서를
한 번 더 읽어야 해서 원격 워크스페이스에서 비쌉니다(이 파일이 피하려고 애쓴 바로 그 비용).

### 3-B. CHAT 카드에서 자료 목록이 질문에 섞인다

새 CHAT 문서는 클로드 발언 뒤에 이런 블록이 붙습니다.

```
✳️ **클로드**

<질문>

📎 살펴본 자료 (13284B)
- `src/main.js`
- `src/db.js (40-120행)`

🔷 **코덱스**
```

`chatDiscovery.ts:174` 이 두 화자 사이를 통째로 `claude` 에 넣으므로,
**`📎 살펴본 자료` 목록이 질문 원문에 섞여 표시됩니다.**

```ts
claude = text.slice(c.at + c.len, x.at).trim();
```

깨지지는 않지만, 접힌 카드의 미리보기(`firstLine(e.claude)`, `codexChatPanel.ts:390`)는
질문 첫 줄이라 영향이 없고, 펼치면 목록이 함께 보입니다.

분리해서 별도 뱃지(`📎 2개 파일`)로 보여주면 읽기 좋아집니다. `ChatTurn` 에 `looked?: string[]` 를
추가하고 `parseEntries` 에서 `📎 살펴본 자료` 이후를 잘라내면 됩니다.

### 3-C. pending 턴에도 자료 표시 가능

`.chat_<슬러그>.inflight` 마커에 `look=<이름>` 이 줄마다 들어갑니다.
`parseInflight` 에서 `look` 을 **여러 줄** 수집하면(현재 `pick()` 은 첫 줄만) pending 카드에도
"📎 2개 파일 보는 중" 을 띄울 수 있습니다.

---

## 4. 낡은 주석 하나

`chatDiscovery.ts:32` 의 `ChatBreak` 주석:

```ts
 *   superseded — `--new` closed this generation on purpose
```

**`--new` 는 2026-08-22 에 제거됐습니다** (`--close-stamp` 로 대체). 동작은 `⏹ 새 대화로 전환`
문자열로 매칭하므로 **정상이고**, 주석만 낡았습니다.

---

## 5. 우선순위 요약

| 순위 | 항목 | 이유 |
|---|---|---|
| **P1** | 뒤 턴 활동이 앞 턴을 덮어씀 (`P1-A`) | 화면에 보이는 것이 틀린다. 실측 20개 중 12개만 남고 kind 까지 바뀐다 |
| **P1** | 되묻기 중 `마무리 중` 고착 (`P1-B`) | 진행 중인데 끝나간다고 표시한다. 상태와 활동이 서로 모순 |
| **P1** | followup 문서 삭제/휴지통 누락 (`P1-C`) | 파일이 영구히 쌓인다. 사용자가 지웠다고 생각하는데 남는다 |
| **P1** | 턴별 로그(`_t<N>_`) 정리 누락 (`P1-D`) | 11턴이면 20개까지 |
| P2 | `.consult_*.inflight` 정리 (`P2-E`) | 🔴 **함부로 지우면 복구 신호가 사라진다.** run 삭제 시에만 |
| P2 | `.scratch/` 정책 (`P2-F`) | ⬜ 결정 필요 |
| P2 | `docOnlyStamps` 패턴 (`P2-G`) | 실제 영향 낮음 |
| P3 | 턴 수 표시 | 스킬 쪽 `status.json` 수정이 선행돼야 함 |
| P3 | CHAT 자료 목록 분리 | 표시 품질 |

---

## 6. 검증 방법

실제 데이터가 이미 있습니다. 아래에서 확인하실 수 있습니다.

- **multi-turn 실증 문서**: `D:\OneDrive\바탕 화면\docs\codex_rescue\260825_174748_response_thread-smoke.md`
  - frontmatter 에 `thread_id` · `origin` · `turns: 2` 가 들어 있습니다
  - 본문에 `## 🔁 2턴 — Claude 반박` / `## 🔷 2턴 — Codex 재답변` 구조
- **반박서 예시**: 같은 디렉토리의 `260825_174748_followup2_thread-smoke.md`
- **events.jsonl append 결과**: `D:\OneDrive\바탕 화면\docs\codex_rescue\.log\260825_174748_events.jsonl`
  - 1턴+2턴이 한 파일에 이어져 있습니다. 카드 재파싱이 실제로 되는지 여기서 확인 가능합니다

이 워크스페이스를 VS Code 로 열면 진행 패널에 그 카드가 뜹니다.
**먼저 현재 코드로 열어 보시고, 무엇이 어떻게 보이는지 확인한 뒤 고치시는 걸 권합니다.**

---

## 7. "180초 사고" — 실측으로 밝혀진 것

되묻기 2턴 왕복이 385초 걸린 것을 두고 배관이 무겁다는 의심이 있었습니다.
스탬프 `260825_174748` 을 Codex 의 rollout 원본으로 분해했더니 **배관 문제가 아니었습니다.**

근거 파일입니다.

- `C:\Users\bluec\.codex\sessions\2026\08\25\rollout-2026-08-25T17-47-54-01a0381a-*.jsonl`
- `C:\Users\bluec\.codex\sessions\2026\08\25\rollout-2026-08-25T17-50-44-01a0381d-*.jsonl`

시간을 이렇게 나눌 수 있습니다(스탬프 `17:47:48` 시작, `status.json` 의 `finished_at` 은 `17:54:13`).

```
17:47:54.8 ~ 17:49:37.2   102초   1차 시도 (rollout 01a0381a)  ← 통째로 버려짐
17:49:37.2 ~ 17:50:44.9    68초   재실행 판정과 재기동          ← 통째로 버려짐
17:50:44.9 ~ 17:51:59      74초   재실행 1턴 (rollout 01a0381d)
17:51:59   ~ 17:52:34      35초   반박서 작성·2턴 기동
17:52:34   ~ 17:54:09.8    95초   재실행 2턴 (같은 rollout)
                          ─────
                           385초
```

**실제 모델 추론은 169초(1턴 74초 + 2턴 95초)입니다.** 그리고 앞의 177초는 **같은 요청을 두 번
실행한 값**입니다. 재실행이 없었다면 왕복은 208초였고 그중 배관 오버헤드는 39초 — **19%** 입니다.

### 1차 시도는 왜 버려졌나

여기서 처음 세운 가설("Codex 가 명령을 한 건도 안 돌리고 됐다고 답했다")은 **rollout 과 맞지
않았습니다.** 1차 시도는 shell 명령 5건과 패치 2건을 실제로 실행했고, 응답 문서와 `probe.txt`
를 만든 뒤 스스로 확인까지 했습니다.

```
ResponseExists    : True
ResponseLineCount : 3
ResponseText      : 1. 읽었음 | 2. 됐음 | 3. 열림
ProbeExists       : True
ProbeText         : thread-smoke probe
```

요청서가 "1·2·3 에 각각 한 줄씩, 그 외는 쓰지 마라"였으니 형식도 어긋나지 않았습니다.
그런데도 이 시도는 버려졌고, 재실행에서 답이 `2. 됐음` 에서 `2. 생성됨` 으로 바뀌었습니다.

🔴 **버려진 이유는 디스크에 남은 기록으로 확정할 수 없습니다.** 재실행이 같은 스탬프의 로그를
덮어썼기 때문입니다. `260825_174748_events.jsonl` 의 `thread.started` 두 개가 **둘 다
`01a0381d`**(재실행 쪽 thread_id)이고, `stderr.log` 도 `08:50:44` 부터 시작합니다.
1차 시도의 흔적은 rollout 원본에만 남아 있습니다.

### 확장에 주는 함의

이건 스킬 쪽 이야기지만 **패널 표시에도 영향이 있습니다.**

- 재실행이 일어나면 앞 시도의 events·stderr·status 가 사라지므로, 카드가 보여주는 활동과
  경과 시간은 **마지막 시도의 것만** 반영합니다. 사용자가 체감한 385초와 카드의 값이 어긋납니다.
- 되묻기가 느려 보인다는 신고가 오면 **먼저 rollout 을 봐야 합니다.** 카드만 봐서는
  버려진 시도가 있었는지 알 수 없습니다.

⬜ 카드에 재실행 이력을 남길지는 **결정이 필요합니다.** 지금 구조로는 스킬 쪽이 로그를
덮어쓰지 않아야 가능한 일이라 확장만으로는 못 합니다.

---

## 8. 이 저장소에서 함께 갱신한 것 / 안 한 것

**갱신했습니다** (문서만):

| 파일 | 무엇을 |
|---|---|
| `docs/codex-rescue-guide.ko.md` | §1 표에 되묻기 · **§2-2 되묻기 신설** · §2-1 자료 지목/60초 · §3 원본 우선 · §4 `.scratch`·followup 문서 · §5 되묻기 후 카드 동작 · §6 경계선 재정의 · §7 검증 상태 · §9 환경변수 4개 |
| `docs/codex-rescue-guide.md` | 위와 동일 (영문판) |

2026-08-25 2차로 두 가이드의 **§5 "되묻기를 하면"** 을 고쳤습니다. 원래 "1턴+2턴 활동을 통째로
다시 그린다"고 적혀 있었는데 사실이 아니었습니다(§2 `P1-A`). 활동이 덮여 사라지는 것과 상태가
`마무리 중`에 고착되는 것을 적고, **§7 검증 상태 표**의 되묻기 항목도 그에 맞게 나눴습니다.

**안 했습니다:**

- **`README.ko.md` / `README.md`** — codex_rescue 언급이 9곳씩 있지만 전부 **확장 기능 설명**입니다.
  §2 의 수정이 배포되기 전에 README 를 고치면 **없는 기능을 있다고 쓰는 셈**이 됩니다.
  위 §2 를 구현하신 뒤에 함께 갱신하시는 게 맞습니다.
- **`CHANGELOG.md`** — 같은 이유입니다. 배포되지 않은 변경에는 릴리스 항목을 달지 않습니다.
- **확장 소스** — 이 문서를 쓰면서는 한 줄도 안 고쳤습니다. §2 의 구현은 별도 작업입니다.

---

## 9. 스킬 쪽 참고 문서

- `~/.claude/skills/codex_rescue/SKILL.md` — § 모드 표 · § 절차 10~11(되묻기) · § 검증 상태
- `~/.claude/skills/codex_rescue/send.sh` — `--followup` 분기 · `--look` 분기
- 개편 전 원본: `~/.claude/skills/codex_rescue/_backup_260825_165204/`

배포는 아직 안 했습니다(2026-08-25 기준 로컬 PC 만 반영). 서버 4대는 구버전이므로
**그쪽에서 만든 문서에는 `thread_id`·`turns` 가 없습니다.** 확장이 그 경우에도 깨지지 않아야 합니다
— 현재 코드는 frontmatter 를 안 읽으므로 문제없지만, 3-A 를 구현한다면 **없을 때를 반드시 처리**해 주십시오.
