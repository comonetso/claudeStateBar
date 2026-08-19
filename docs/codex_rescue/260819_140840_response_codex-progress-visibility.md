---
type: codex_response
mode: readonly
stamp: 260819_140840
slug: codex-progress-visibility
author: codex-via-stdout
---

# Codex 응답 — codex-progress-visibility

> ⚠️ Codex 가 지정 경로에 직접 저장하지 못해, send.sh 가 최종 메시지를 회수해 저장했다.

## Codex 원문

---
type: codex_response
mode: readonly
stamp: 260819_140840
slug: codex-progress-visibility
author: codex
---

# Codex 응답 — codex-progress-visibility

## 1. 내 가설에 대한 판정

### 가설 A — 부분 동의

현재 `send.sh`가 만든 직접적인 깜깜이 원인은 맞다. `codex exec --json`의 stdout은 실행 중에는 무작위 `RUN_DIR/events.jsonl`에만 기록되고(`send.sh:188-201, 400-405`), 워크스페이스의 `.log`로는 종료 뒤에야 복사된다(`send.sh:494-505`). 확장이 예측 가능한 경로에서 진행 이벤트를 볼 수 없는 구조다.

다만 “rollout에도 없을 수 있으므로 stdout밖에 답이 없다”는 전제는 수정해야 한다. 로컬 `codex-cli 0.145.0`의 `exec --help`에는 `--ephemeral`이 별도 옵션으로 존재하고, 현재 `send.sh`는 이를 사용하지 않는다. 이번 요청을 처리 중인 실제 실행도 다음 rollout을 즉시 만들었다.

- `C:\Users\bluec\.codex\sessions\2026\08\19\rollout-2026-08-19T14-10-37-01a0186d-b19c-73f2-9110-c760ba233150.jsonl`
- 첫 레코드 실측: `originator: "codex_exec"`, `source: "exec"`, `cli_version: "0.145.0"`, `cwd`는 현재 프로젝트

따라서 과거 “rollout/SQLite 어디에도 없었다”는 건을 `codex exec`의 보편적 특성으로 결론 내리면 안 된다. 당시의 `CODEX_HOME`, 실행 호스트, discovery 필터, 날짜 경계, `--ephemeral`, 세션 ID 연결 여부를 다시 봐야 한다.

그래도 이 기능의 1차 입력으로는 해당 호출의 stdout을 직접 미러링하는 편이 식별이 확실하다.

### 가설 B — 동의

`RUN_DIR` 전체를 워크스페이스로 옮기면 안 된다. marker/baseline은 변경 감사의 기준이고, `last_message`는 응답 회수의 기준이므로 Codex 쓰기 범위 밖에 있어야 한다. 고정된 `last_message`가 이전 실행의 답을 재사용하는 stale 문제도 설명대로 타당하다.

추가로 현재 lock은 `docs/codex_rescue/.log` 안에 있어 Codex의 workspace-write 범위에 들어간다(`send.sh:156-178`). 즉 lock을 권위 있는 감사·동시성·생사 신호로 격상하면 Codex가 실수로 삭제하거나 수정할 수 있다.

`.log`의 미러와 상태 파일은 UI 편의를 위한 비권위 telemetry로 보고, marker/baseline과 같은 감사 기준은 계속 외부에 둬야 한다.

### 가설 C — 부분 동의, 방향은 추천

이벤트 스트림만 예측 가능한 `.log` 경로로 실시간 복제하는 것이 가장 작은 변경이고 이 케이스에 적합하다. 다만 `tee` 한 줄과 빈 lock만으로는 충분하지 않다.

1. `--json`에는 타임스탬프, 실시간 토큰량, 확정적 파일-read 이벤트, 항상 존재하는 계획이 없다.
2. `turn.completed`는 Codex turn 종료이지 `send.sh`의 변경 검사·응답 회수·로그 보존 완료가 아니다.
3. 정상 중단에는 확정적인 마지막 JSON 이벤트가 없을 수 있고, 강제 종료에는 당연히 없다.
4. `.log`는 현재 `.gitignore`에 없다. 실제 `git status`에도 `?? docs/codex_rescue/.log/`가 보인다. 이 스트림은 명령, 명령 출력, MCP 인자/결과, reasoning summary, agent message를 담을 수 있으므로 그대로 커밋·동기화되면 민감정보 위험이 있다.
5. 공식 매퍼는 지원하지 않는 내부 알림을 버린다. 따라서 현재 `send.sh`의 “Codex가 실행한 모든 동작”이라는 설명은 너무 강하다.

결론은 `live event mirror + run status sidecar + heartbeat + tolerant tail parser`다. lock 단독 판정은 권하지 않는다.

## 2. `codex exec --json` 이벤트 스키마

### 근거 범위

로컬 설치본은 `codex-cli 0.145.0`, npm 패키지도 `@openai/codex 0.145.0`임을 확인했다.

아래 계약은 OpenAI 공식 저장소의 정확한 태그 [`rust-v0.145.0/exec_events.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/exec_events.rs)와 [`event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs)를 기준으로 했다.

`--json`에는 자체 schema version 필드가 없으므로 CLI 버전이 바뀌면 재확인이 필요하다.

### 최상위 이벤트 8종

모든 줄은 독립 JSON object이며 최상위 discriminator는 문자열 `type`이다.

| `type` | 나머지 필드 | 의미/주의 |
|---|---|---|
| `thread.started` | `thread_id: string` | 첫 이벤트. 모델, cwd, CLI 버전, timestamp는 없음 |
| `turn.started` | 없음 | turn 시작 |
| `item.started` | `item: ThreadItem` | 일부 도구/plan 항목 시작 |
| `item.updated` | `item: ThreadItem` | 0.145.0 매퍼에서는 주로 `todo_list` 갱신 |
| `item.completed` | `item: ThreadItem` | 항목 종료 또는 메시지·추론 요약 |
| `turn.completed` | `usage: Usage` | 성공 terminal event |
| `turn.failed` | `error: { message: string }` | 실패 terminal event |
| `error` | `message: string` | 치명 오류 알림이지만 단독 terminal로 단정할 수 없음 |

`Usage`의 필드는 모두 정수다.

```text
input_tokens
cached_input_tokens
cache_write_input_tokens
output_tokens
reasoning_output_tokens
```

### `item.type` 목록과 payload

`item` 공통 필드는 `id: string`, `type: string`이다.

| `item.type` | 주요 필드 | 실제 노출 방식 |
|---|---|---|
| `agent_message` | `text: string` | completed만. commentary/final phase 구분은 유실됨 |
| `reasoning` | `text: string` | 완료된 reasoning summary만. delta나 비공개 chain-of-thought가 아님 |
| `command_execution` | `command`, `aggregated_output`, `exit_code`, `status` | started/completed. status는 `in_progress/completed/failed/declined` |
| `file_change` | `changes: [{path, kind}]`, `status` | `kind`은 `add/delete/update` |
| `mcp_tool_call` | `server`, `tool`, `arguments`, `result`, `error`, `status` | started/completed |
| `collab_tool_call` | tool, sender/receiver IDs, prompt, agent states, status | subagent 협업 호출 |
| `web_search` | `query`, `action`, web-search id | started/completed. action 세부 shape는 버전 의존 |
| `todo_list` | `items: [{text, completed}]` | 최초 plan은 started, 변경은 updated, turn 끝에서 completed |
| `error` | `message: string` | 경고·deprecated·비치명 오류가 completed item으로 들어올 수 있음 |

특히 `agent_message`와 `reasoning`은 `ItemStarted`에서 의도적으로 걸러지고 완료 시에만 나온다.

command의 실시간 stdout chunk나 reasoning delta도 공개 exec JSONL에는 없다. `ThreadTokenUsageUpdated`는 매퍼 내부 상태만 갱신하며 JSONL로 내보내지 않고, 마지막 `turn.completed.usage`에만 반영된다.

### 구조 예시

아래는 실행에서 복사한 표본이 아니라 0.145.0 serializer 계약으로 합성한 예시다.

```jsonl
{"type":"thread.started","thread_id":"01a0..."}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"rg -n TODO src","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"rg -n TODO src","aggregated_output":"src/a.ts:10: TODO\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"관련 코드 경로를 확인했다."}}
{"type":"item.started","item":{"id":"item_2","type":"todo_list","items":[{"text":"스키마 확인","completed":true},{"text":"확장 설계","completed":false}]}}
{"type":"item.updated","item":{"id":"item_2","type":"todo_list","items":[{"text":"스키마 확인","completed":true},{"text":"확장 설계","completed":true}]}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"분석이 끝났습니다."}}
{"type":"turn.completed","usage":{"input_tokens":1234,"cached_input_tokens":1000,"cache_write_input_tokens":0,"output_tokens":321,"reasoning_output_tokens":120}}
```

실패 예시는 다음 shape다.

```jsonl
{"type":"error","message":"..."}
{"type":"turn.failed","error":{"message":"..."}}
```

현재 실행의 실제 `events.jsonl`은 이 답변이 끝나야 `send.sh`가 `.log`로 복사하므로 지금은 볼 수 없다. 따라서 Windows 0.145.0 바이너리가 이 요청에서 실제로 낸 이벤트 종류·순서는 아직 표본 검증 전이다. 다만 위 필드 계약 자체는 정확한 0.145.0 태그 소스에서 확정했다.

## 3. 진행 표시에 쓸 수 있는 신호와 쓸 수 없는 것

### 쓸 수 있는 것

- `thread.started`: Codex thread ID 확보. 같은 ID의 rollout과 연결하는 키로도 쓸 수 있다.
- `turn.started`: 요청 접수/turn 시작.
- `command_execution` started/completed: 현재 실행 중인 명령과 완료 결과.
- `mcp_tool_call`, `collab_tool_call`, `web_search`: 도구 이름과 시작/완료 상태.
- `file_change.changes[].path`: 실제 파일 변경 경로. read 경로와는 다르다.
- `reasoning.text`: 완료된 reasoning summary를 최근 활동 요약으로 표시.
- `agent_message.text`: 중간/최종 메시지 텍스트. 단 0.145.0에는 둘을 구분하는 phase가 없다.
- `todo_list.items`: 존재할 때만 단계 목록 및 `완료 개수/현재 총개수` 표시.
- `turn.completed` / `turn.failed`: Codex turn의 성공/실패.

### 쓸 수 없거나 휴리스틱인 것

- 읽은 파일 경로: 독립적인 `file.read` 이벤트가 없다. `rg`, `Get-Content`, `sed` 같은 command 문자열이나 MCP arguments에서 추정할 수 있을 뿐이다. “읽음”으로 확정하지 말고 “명령: …”로 표시해야 한다.
- reasoning delta/실시간 thinking: 없다. 완료된 summary만 있다.
- 실시간 token 사용량: 없다. `turn.completed.usage`는 끝에서만 온다.
- 이벤트 timestamp: 최상위 어느 이벤트에도 없다. 전체 경과 시간은 sidecar의 `started_at`으로 계산하고, 개별 이벤트 시각은 확장이 처음 관측한 로컬 시각 정도만 쓸 수 있다.
- 모델·effort·cwd·CLI 버전: `thread.started`에 없다. sidecar에 기록하거나 rollout을 thread ID로 join해야 한다.
- 전체 진행률: 일반적으로 계산 불가능하다. Codex는 미래 도구 호출 수나 남은 추론량을 미리 선언하지 않는다. `todo_list`도 선택적이고 실행 중 항목이 추가·수정될 수 있다.

계획이 있을 때 `2/5 단계`라고 표시하는 것은 가능하지만 이를 “40% 완료”라고 보장하면 안 된다. 계획이 없으면 spinner, 경과 시간, 최근 활동, 완료된 activity 수만 표시하는 것이 정직하다.

## 4. 버퍼링·`tee`·tail 관련 함정

### stdout 버퍼링

0.145.0 JSONL 매퍼는 이벤트마다 `serde_json::to_string(...)`을 `println!`으로 출력한다([소스의 `emit`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L94-L106)).

설치된 Node 진입점은 native `codex.exe`를 `stdio: "inherit"`로 spawn하므로 Node가 stdout을 모아두지 않는다(`C:\Users\bluec\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js:195-198`). 현재 Rust stdout 구현도 내부적으로 `LineWriter`를 쓴다([Rust stdio 소스](https://github.com/rust-lang/rust/blob/main/library/std/src/io/stdio.rs)).

따라서 `| tee`를 붙였다고 수 KB가 찰 때까지 묶일 가능성은 낮고, 0.145.0에서는 줄 단위 실시간 미러가 될 가능성이 높다.

다만 Codex 소스가 매 줄 `flush()`를 명시한 것은 아니므로 장래 버전까지 보장하는 공개 계약이라고 표현하면 안 된다. 구현 후 Windows에서 첫 `thread.started`/`turn.started`가 프로세스 종료 전에 보이는지 한 번 실측해야 한다.

### `tee`와 셸

현재는 `set -uo pipefail`이고 `-e`가 없으므로 pipeline 실패 뒤에도 `PIPESTATUS`를 읽을 수 있다.

- `PIPESTATUS`는 바로 다음 명령에서 배열 전체를 복사해야 한다. 다른 명령이 먼저 실행되면 덮인다.
- Codex exit와 `tee` exit를 둘 다 저장해야 한다. Codex가 0이어도 `tee`가 disk-full/permission 오류면 live log는 불완전하다.
- 나중에 `set -e`가 추가되면 nonzero pipeline에서 캡처 전에 셸이 끝날 수 있다. pipeline 구간을 errexit에서 보호해야 한다.
- `tee`가 먼저 죽으면 Codex/Node가 broken pipe로 비정상 종료할 수 있다.
- 느린 디스크·OneDrive 동기화는 `tee`에 backpressure를 걸어 Codex를 늦출 수 있다.
- 현재 신호 전달은 이미 MSYS Bash → Node → Windows native 손자라는 약점이 있다(`send.sh:360-377`). pipeline에 `tee`가 추가되면 trap과 lock 삭제를 더 신뢰하기 어렵다.
- stderr는 계속 외부 `ERRLOG`에만 있으므로 JSON 한 줄도 나오기 전 실패하면 패널은 heartbeat 외에는 이유를 모른다. stderr까지 process substitution으로 live tee하는 것은 wait/exit-code/신호 복잡도를 늘리므로 1차 범위에서는 미루는 편이 낫다.

현재처럼 실행 종료 뒤 `cp -f "$EVENTS" "$LOGD/..._events.jsonl"`를 바로 수행하면 live 파일이 truncate 후 재작성되어 tail parser가 shrink/rewrite로 볼 수 있다.

최종 외부 `$EVENTS`를 권위 있는 사본으로 유지하려면 다음 둘 중 하나가 필요하다.

1. live 사본과 외부 사본의 크기/hash가 같으면 그대로 둔다.
2. 다르거나 live 사본이 사라졌다면 외부 사본을 `.log` 내 임시 이름에 복사한 뒤 atomic rename으로 최종 경로를 교체한다.

직접 `cp -f`로 열린 live 파일을 덮어쓰는 방식은 피해야 한다.

### tail과 partial line

writer가 한 JSON object를 serialize한 뒤 newline을 쓰더라도 reader는 OS write 중간을 볼 수 있다. 마지막 newline이 오기 전 조각은 `JSON.parse`하지 말고 다음 poll까지 carry해야 한다.

- local: byte offset부터 증가분만 읽고 마지막 `\n` 뒤 raw bytes를 carry한다. UTF-8 문자가 read 경계에서 갈릴 수 있으므로 `StringDecoder` 또는 byte-level split을 쓴다.
- remote: range read가 없으므로 mtime+size가 바뀔 때만 whole-file read하고 마지막 불완전 줄을 버린다. 다음 poll에서 다시 읽는다.
- file shrink/replacement: parser state를 버리고 처음부터 다시 읽는다.
- 일시적 open/read 실패: 이전 화면을 유지하고 다음 poll에서 재시도한다. 곧바로 “죽음”으로 판정하지 않는다.
- Windows: `tee`가 명시적 lock을 걸지 않으므로 일반적으로 동시 read가 가능하다. 백신·동기화·파일 교체의 순간 실패는 retry가 필요하다.
- watcher 이벤트는 coalesce될 수 있으므로 짧은 poll도 유지한다.

기존 `src/providers/codex/tailReader.ts`의 설계 패턴은 재사용할 수 있지만 `readSession() → CodexAccumulator`를 그대로 호출하면 안 된다. 그것은 top-level `{timestamp,type,payload}`인 rollout 전용 파서다(`rolloutParser.ts:1-15`). exec JSONL은 top-level `{type,...}`이고 별도 accumulator/state machine이 필요하다.

새 reader는 현재 reader의 `offset + carry` 패턴(`tailReader.ts:158-170`)을 가져오되 UTF-8 경계는 더 엄격하게 처리해야 한다.

## 5. 실행 중/죽음 판정 방법

### lock 단독은 불충분

빈 lock은 다음을 구분하지 못한다.

- 실제 실행 중
- Codex turn은 끝났지만 `send.sh`가 변경 검사·응답 회수 중
- Bash/PC 강제 종료로 남은 stale lock
- workspace-write Codex나 다른 프로세스가 lock을 삭제·변조한 경우

이벤트 파일 mtime 정지도 죽음 증거가 아니다. 모델이 오래 추론하는 동안 공개 JSONL이 한 줄도 나오지 않을 수 있다.

### 권장 상태 머신

`send.sh`가 `.log/<stamp>_status.json`과 `.log/<stamp>_heartbeat`를 UI용으로 관리한다.

| UI 상태 | 판정 |
|---|---|
| `starting` | status는 running인데 아직 `thread.started` 없음 |
| `running` | terminal event 없음 + heartbeat가 신선함 |
| `finalizing` | `turn.completed` 또는 `turn.failed`를 봤지만 send.sh terminal status는 없음 |
| `done` | 모든 후처리 완료 후 `state=succeeded`, `codex_exit=0`, `tee_exit=0` |
| `failed` | `turn.failed`, nonzero Codex exit, tee 실패 또는 후처리 실패 |
| `stopped` | signal trap이 `interrupted`를 기록하거나 exit 130 등 명시적 중단 |
| `unknown/stale` | status는 running인데 heartbeat가 임계시간을 넘김. done으로 승격하지 않음 |

terminal 신호의 의미도 구분해야 한다.

- `turn.completed`: Codex turn 성공은 확정하지만 `send.sh` 전체 성공은 아니다.
- `turn.failed`: Codex turn 실패.
- top-level `error`: 0.145.0 매퍼는 이를 내보낸 뒤에도 상태를 Running으로 유지한다. 단독 terminal로 취급하지 않는다.
- `TurnStatus::Interrupted`: 0.145.0 매퍼는 `turn.failed`나 별도 `turn.interrupted`를 내보내지 않고 shutdown만 시작한다([해당 분기](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L505-L531)).

즉 중단·강제 종료 판정에는 process exit/status/heartbeat가 필요하다.

PID 직접 조회는 보조 수단만 권한다. Git Bash/MSYS PID, Node PID, native `codex.exe` PID가 서로 다른 계층이고 재사용도 가능해 VS Code 확장이 하나의 PID만 보고 확정하기 어렵다.

heartbeat는 Bash가 살아 있는 동안 3~5초 간격으로 갱신하고, Bash가 hard-kill되면 보조 heartbeat 프로세스도 부모 생존 확인 후 멈추게 하면 된다. stale 임계값은 heartbeat 주기의 3배 이상으로 둔다.

보안상 중요한 판단이라면 status/heartbeat/lock도 워크스페이스 밖의 고정 registry로 옮겨야 한다. `.log` 안 신호는 사용자 편의 UI용이다.

## 6. 수정 방법 (before → after)

### `send.sh`

#### before

```bash
if [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" > "$EVENTS" 2>"$ERRLOG"
else
  "$@" > "$EVENTS" 2>"$ERRLOG"
fi
RC=$?

# ... 실행 종료 뒤 ...
cp -f -- "$EVENTS" "$LOGD/${STAMP}_events.jsonl"
```

#### after — 권장 구조

```bash
LIVE_EVENTS="$LOGD/${STAMP}_events.jsonl"
RUN_STATUS="$LOGD/${STAMP}_status.json"
HEARTBEAT="$LOGD/${STAMP}_heartbeat"

# 1) schema/stamp/slug/mode/started_at/state=running을 atomic replace로 기록
# 2) 부모 Bash 생존을 확인하며 HEARTBEAT mtime을 3~5초마다 갱신

if [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" 2>"$ERRLOG" | tee -- "$LIVE_EVENTS" > "$EVENTS"
else
  "$@" 2>"$ERRLOG" | tee -- "$LIVE_EVENTS" > "$EVENTS"
fi
PIPE_RC=("${PIPESTATUS[@]}")   # 반드시 pipeline 직후
RC=${PIPE_RC[0]}
TEE_RC=${PIPE_RC[1]}

# 3) heartbeat 정지
# 4) 기존 변경 검사·응답 회수 수행
# 5) 외부 EVENTS와 live 파일을 검증하고 필요 시 atomic replace
# 6) 가장 마지막에 state/finished_at/codex_exit/tee_exit/postprocess 결과 기록
```

status 예시는 다음 정도면 충분하다. JSON escape를 손으로 부실하게 구현하지 말고 확실한 JSON writer를 사용하거나 값 범위를 엄격히 제한해야 한다.

```json
{
  "schema": 1,
  "stamp": "260819_140840",
  "slug": "codex-progress-visibility",
  "mode": "readonly",
  "state": "running",
  "started_at": "2026-08-19T05:10:36Z",
  "finished_at": null,
  "codex_exit": null,
  "tee_exit": null
}
```

추가 필수 사항:

- signal trap은 가능한 경우 terminal status를 `interrupted`로 best-effort 기록한 뒤 cleanup한다. hard kill은 heartbeat stale이 담당한다.
- `tee` 실패를 `LOGCOPY_FAIL`과 별개로 보고한다.
- `.gitignore`에 `docs/codex_rescue/.log/`를 추가한다. 현재 실제로 untracked로 노출된다.
- raw events는 민감할 수 있으므로 retention 정책을 둔다. 자동 삭제 범위·기간은 사용자 정책을 먼저 정해야 한다.
- marker, before/after 목록, last_message는 지금처럼 외부 `RUN_DIR`에 둔다.

### 확장

1. 별도 exec-event parser를 만든다. `thread.started/turn.started/item.*/turn.*/error`를 tolerant union으로 읽고 모르는 type·필드는 무시하거나 진단 count만 남긴다.
2. 별도 tail state를 만든다. 기존 `tailReader.ts`의 offset/carry/cache 아이디어만 공통 유틸로 추출하거나 복제한다.
3. 각 workspace folder의 `docs/codex_rescue/.log`에서 status/events/heartbeat를 stamp로 묶는다.
4. watcher + 짧은 active poll을 함께 쓴다. `.log` watcher가 즉시 refresh하고, 패널이 열려 있거나 running run이 있을 때만 1~2초 poll한다. 현재 기본 30초 poll(`extension.ts:705-708`)만으로는 실시간이 아니다.
5. Workflow 모델에 `kind`를 추가한다. 예: `claude-workflow | claude-task-batch | codex-rescue`, 그리고 `deletable`, `terminalKind`를 둔다.
6. 기존 완료 비프/삭제 경로와 분리한다. 현재 non-`wf_` pseudo-workflow는 all-done 비프 경로를 타며(`extension.ts:2368-2458`), 삭제 callback은 `tasks:`가 아니면 Claude workflow 디렉터리 삭제를 시도한다(`extension.ts:509-535`).
7. 최근 command/tool/web search/reasoning summary, 경과 시간, activity 수, 선택적 todo `n/m`를 표시한다.
8. `aggregated_output`, MCP result, collab prompt, agent message 전문은 기본 접힘+길이 제한을 적용한다.
9. `workflowsSignature`에 run state, todo, 최근 activity를 포함한다. 경과 시간은 현재 웹뷰 ticker처럼 클라이언트에서 계산해 매초 전체 DOM을 재구성하지 않는다.
10. 사용자 기능이므로 `README.md`, `README.ko.md`, `CHANGELOG.md`도 함께 갱신한다.

권장 UI 매핑:

- 카드 제목: `Codex Rescue · <slug>`
- 점 상태: starting/running/finalizing/done/failed/stopped/stale 구분
- 요약: 마지막 의미 있는 item의 안전한 preview
- 단계: 최신 `todo_list`가 있을 때만 표시
- 계획이 없으면 `활동 N건 · 경과 …`
- full details: chronological event list. raw JSON은 escape/sanitize

## 7. 대안 비교와 추천

| 대안 | 장점 | 단점 | 판정 |
|---|---|---|---|
| `.log` live `tee` + status/heartbeat | 호출과 stamp 연결이 확실, 구현 작음 | workspace telemetry라 변조 가능, privacy/retention 필요 | 추천 |
| rollout 직접 tail | 기존 parser 존재, timestamp와 더 풍부한 상태 | stamp 연결이 어렵고 이전 discovery 미해결 | 보조/enrichment |
| stdout `thread_id`로 rollout join | 직접 호출 식별 + rollout 정보 결합 | 두 schema/state를 합쳐 복잡 | 2단계로 유용 |
| app-server/SDK가 실행을 직접 소유 | 구조적인 lifecycle 제어 | codex_rescue 실행·sandbox·회수 구조를 크게 재작성 | 과함 |
| named pipe/socket | 디스크 partial/commit 위험 감소 | 재연결, Remote-SSH, crash recovery가 복잡 | 비추천 |
| workspace 밖 고정 registry | Codex 변조 저항 | host/Remote-SSH/권한 설계 필요 | 보안 요구 시 |

추천 순서:

1. live `tee` + status/heartbeat + 전용 tolerant parser + 패널 kind 분리.
2. `thread.started.thread_id`로 rollout을 join해 모델·timestamp 등을 선택적으로 보강.
3. 감사 무결성이 필요하면 status/lock registry를 워크스페이스 밖으로 이동.

rollout-only를 1차로 선택하지 않는 이유는 현재 호출을 해당 stamp 카드로 확실히 묶는 것이 stdout 미러에서 가장 쉽기 때문이다.

반대로 stdout 미러만으로 모든 내부 행동·실시간 토큰·정확한 파일 read를 복원할 수 있다고 기대해서도 안 된다.

## 8. 확신도와 남은 불확실성

### 높은 확신

- 0.145.0의 최상위 8개 이벤트와 item payload: 정확한 태그 소스로 확인.
- timestamp/model/cwd/CLI version이 exec JSONL에 없다는 점.
- live token update가 노출되지 않고 `turn.completed.usage`만 있다는 점.
- reasoning delta가 없고 completed summary만 있다는 점.
- `TurnStatus::Interrupted`에 JSON terminal event가 없다는 점.
- 현재 `send.sh` 실행이 rollout을 실제 생성했다는 점.
- 현재 `.log`가 `.gitignore`되지 않았다는 점.

### 중간~높은 확신

- Windows 0.145.0에서 `tee`가 줄 단위로 충분히 실시간일 것: `println!`, Rust `LineWriter`, Node `stdio: inherit` 근거가 있다. 다만 이 정확한 pipeline으로 timing 실측은 하지 않았다.
- writer 중 파일을 Node/VS Code가 읽을 수 있다는 점: 일반 동작은 가능하나 백신·OneDrive·Remote-SSH별 순간 실패는 retry로 흡수해야 한다.

### 남은 불확실성/추가 확인 항목

1. 실제 `260819_140840_events.jsonl`에서 이 환경의 code-mode tool 호출이 어떤 item으로 나오는지 확인할 것.
2. pipeline 적용 후 첫 이벤트 도착 지연을 Windows에서 측정할 것.
3. 과거 “rollout이 없었다” 실행의 `CODEX_HOME`, 프로세스 인자, host, discovery 필터를 재현할 것.
4. `.log` raw data의 보존 기간과 민감정보 정책을 결정할 것.
5. 서로 다른 stamp의 병렬 실행을 UI가 지원할지 결정할 것.

## 9. 추가로 필요한 자료

차단되는 자료는 없음. 관련 `send.sh`의 실행·cleanup·copy 구간과 확장의 `workflowPanel.ts`, `tailReader.ts`, `extension.ts`를 직접 확인했다.

다만 이 답변 반환 직후 현재 `send.sh`가 아래 실제 표본을 복사할 예정이므로, Claude는 구현 전에 반드시 읽어 0.145.0 Windows fixture로 검증해야 한다.

- `docs/codex_rescue/.log/260819_140840_events.jsonl`
- `docs/codex_rescue/.log/260819_140840_stderr.log`

그 표본이 태그 계약과 다르면 표본을 우선하되, 차이를 현재 바이너리/기능 플래그에서 관측된 확장으로 기록하고 parser는 unknown-tolerant하게 유지해야 한다.

## 저장 및 변경 검증

지정 응답 파일 생성은 허용된 `apply_patch` 도구에서 세 차례 모두 거부되어 저장하지 못했다. 셸 쓰기 우회는 하지 않았으며, 응답 파일은 최종 검증 시 존재하지 않았다.

제가 만든 파일이나 코드 변경은 없다. 조사 시작 시에는 request 파일과 `.log/.260819_140840.lock`만 untracked였으나, 마지막 검증에서 `docs/mockup_codex_panel.html`이 추가로 나타났다. 이 파일은 제가 만들거나 수정하지 않았으며 동시 실행 중인 외부 작업의 변경으로 보이므로 그대로 보존했다.

---

## Claude 검토

작성: 2026-08-19 · 검토자: Claude (Opus 5)

### 0. 변경 감지 건 — 해명

`docs/mockup_codex_panel.html` 은 **Claude 가 만든 것이다.** Codex 실행 중에 UI 시안을 Write 했고
그것이 감시 스캔에 잡혔다. Codex 의 판정("내가 만들지 않았다 / 외부 작업의 변경으로 보인다")이 정확하다.
오탐이 아니라 **감시가 정상 작동한 정탐**이며 원인이 Codex 가 아닐 뿐이다. 되돌리지 않는다.

### 1. 실측 대조 — 이 답변의 계약 vs 실제 표본

Codex 가 9번에서 요구한 대로 `.log/260819_140840_events.jsonl`(105줄, 409KB)로 검증했다.

| 항목 | Codex 계약 | 실측 | 판정 |
|---|---|---|---|
| 최상위 이벤트 | 8종 | `thread.started` 1 · `turn.started` 1 · `item.started` 45 · `item.completed` 57 · `turn.completed` 1 | ✅ 모순 없음 (나머지 3종은 이번에 미발생) |
| `item.type` | 9종 | `command_execution` 46 · `web_search` 38 · `agent_message` 11 · `file_change` 6 · `error` 1 | ✅ 모순 없음 |
| `turn.completed.usage` 5필드 | `input/cached_input/cache_write_input/output/reasoning_output` | 5필드 정확히 일치 (`input 5,746,358` 등) | ✅ **확정** |
| `agent_message`·`reasoning` 은 completed 만 | 주장 | `started` 45 vs `completed` 57, 차 12 = `agent_message` 11 + `error` 1 | ✅ **산술로 확정** |
| `web_search.action` shape 는 버전 의존 | 주장 | 실물이 `{"type":"other"}` 30건 / `{"type":"search"}` 8건 — 내용 없음 | ✅ 확인. **표시 재료로 못 쓴다** |

⚠️ 검토 중 Claude 의 초기 집계가 `search`·`other` 를 최상위 `item.type` 으로 오독했는데,
이는 grep 이 중첩 필드까지 잡은 탓이다. **Codex 계약이 옳았다.**

### 2. Claude 가 틀렸던 것 — 정정

**버퍼링 우려는 근거가 부실했다.** Claude 는 "Rust 는 stdout 이 파이프면 블록 버퍼링이므로
`| tee` 를 붙이면 실시간성이 죽는다"고 사용자에게 선제 고지했다. Codex 가 소스로 반박했고 그쪽이 맞다 —
Rust std 의 stdout 은 **`LineWriter`(줄 버퍼링)** 이고, Node 진입점은 native `codex.exe` 를
`stdio: "inherit"` 로 spawn 하므로 Node 가 따로 모으지도 않는다. C stdio 의 관례를 Rust 에 잘못 적용했다.

단 Codex 자신도 "매 줄 `flush()` 를 명시한 것은 아니므로 공개 계약이라 부를 수 없다"고 단서를 달았다.
→ **구현 후 Windows 에서 첫 이벤트 도착 지연을 1회 실측한다.** 실측 전까지 "실시간"이라 단정하지 않는다.

### 3. 채택

| 지적 | 채택 이유 |
|---|---|
| **lock 단독 생사 판정 금지** | lock 이 `.log/` 안 = **Codex 의 workspace-write 범위**다. 피감시자가 지울 수 있는 것을 권위 신호로 쓸 수 없다. Claude 가 놓친 지점 |
| **status sidecar + heartbeat** | "Codex turn 종료"와 "send.sh 후처리 완료"가 다르다는 구분이 정확하다. `turn.completed` 만 보면 변경 검사·응답 회수 중인 구간이 `done` 으로 잘못 뜬다 |
| **`turn.completed`/`turn.failed` 만 terminal, top-level `error` 는 아님** | 0.145.0 매퍼가 `error` 후에도 Running 을 유지한다는 소스 근거가 있다 |
| **`TurnStatus::Interrupted` 에 JSON terminal 이 없음** | 중단 판정을 이벤트로 할 수 없다는 뜻. heartbeat 가 필수인 진짜 이유다 |
| **`cp -f` 로 live 파일 덮어쓰기 금지** | tail parser 가 truncate 를 shrink/rewrite 로 본다. atomic rename 필요 |
| **`tailReader.readSession()` 직접 재사용 불가** | rollout 은 `{timestamp,type,payload}`, exec JSONL 은 `{type,...}` — 스키마가 다르다. offset+carry 패턴만 가져온다 |
| **`aggregated_output` 접기·길이 제한** | 실측 최장 줄이 **63KB**, 105줄에 409KB다. 그대로 렌더하면 패널이 죽는다 |
| **진행률 계산 불가 → 정직하게 표시** | 미래 도구 호출 수를 선언하지 않으므로 원리적으로 불가. `활동 N건 · 경과 …` 가 옳다 |
| **`.gitignore` 에 `.log/` 추가** | 명령·출력·MCP 인자가 담긴다. 실제로 untracked 노출 중이다 |
| **Workflow 모델에 `kind` 추가, 비프·삭제 경로 분리** | 기존 non-`wf_` pseudo-workflow 가 all-done 비프와 Claude 워크플로우 삭제 경로를 탄다. 그대로 두면 오작동한다 |

### 4. 실측으로 추가 확인한 것 — P2 미해결 건 해소

Codex 가 가설 A 에서 "rollout 이 실제로 생성됐다"고 지적한 것을 직접 확인했다.

```
~/.codex/sessions/2026/08/19/rollout-2026-08-19T14-10-37-01a0186d-b19c-73f2-9110-c760ba233150.jsonl
session_id = 01a0186d-b19c-73f2-9110-c760ba233150  ← thread.started.thread_id 와 완전 일치
originator: "codex_exec" · source: "exec" · cwd: 이 프로젝트 · timestamp 있음
```

→ **2026-08-03 세션부터 이월돼 온 P2("실행 중인 Codex 세션이 rollout·SQLite 어디에도 없었다")를
`codex exec` 의 보편적 특성으로 결론 내리면 안 된다.** 그 건은 다른 원인이며 재조사 대상이다.
그리고 `thread_id` join 이 실제로 성립하므로, exec JSONL 에 없는 **timestamp·모델·cwd** 를
rollout 에서 보강하는 2단계가 실현 가능하다.

### 5. 보류

- **heartbeat 보조 프로세스** — 방향은 채택하되 구현 형태는 보류. 백그라운드 갱신 루프는
  trap·고아 프로세스 문제를 새로 만든다. 1차에서는 **live events 파일의 mtime 을 heartbeat 로 대용**하는
  더 단순한 안을 먼저 검토한다(이벤트가 안 나오는 긴 추론 구간을 stale 로 오판하지 않도록 임계값을 크게).
- **`todo_list` 표시** — 이번 실행에 미발생. 나올 때만 `n/m` 을 그리고, 없으면 활동 수로 대체한다.
- **retention 정책 / 병렬 stamp UI 지원** — 근거 있는 값이 없다. **사용자 결정 사항**이므로 임의로 정하지 않는다.
- **status/lock registry 를 워크스페이스 밖으로** — 보안 요구가 생기면. 지금은 UI 편의용 telemetry 로 충분하다.

### 6. 수정 채택 — 확장 쪽 10번 항목

Codex 는 "사용자 기능이므로 `README.md`·`README.ko.md`·`CHANGELOG.md` 를 함께 갱신하라"고 했다.
**부분 기각한다.** 사용자 결정으로 이 기능은 **워크스페이스에 `docs/codex_rescue/` 가 있을 때만
노출**되며 일반 사용자에게는 존재 자체가 보이지 않는다. 일반 사용자의 멘탈 모델이 바뀌지 않으므로
README 2종은 갱신 대상이 아니다. **`CHANGELOG.md` 는 갱신한다.**

### 7. 적용 계획

1. `send.sh` — live events 미러(`tee` + `PIPESTATUS` 즉시 캡처) · status sidecar · atomic rename ·
   `.gitignore` 추가. 수정 후 `/skill_cp_install push codex_rescue` 배포 필요
2. 확장 — exec 전용 tolerant parser + 전용 tail state(offset/carry) + `docs/codex_rescue/.log` watcher
   + 패널 분리(워크스페이스 자동 감지로 노출 제어)
3. 첫 이벤트 도착 지연 Windows 실측 → 실시간성 확정
4. 이 fixture(`260819_140840_events.jsonl`, 105줄/409KB)를 파서 검증용 표본으로 보존

