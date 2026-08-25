# 답변 — 기존 FOLLOWUP을 보존하면서 CONSULT 도중 자유롭게 끼어들 수 있는가

> 질문 문서: [`CODEX_MULTITURN_DELAY_ASK.md`](./CODEX_MULTITURN_DELAY_ASK.md)
>
> 검토 기준: Codex CLI 0.145.0 · 2026-08-25
>
> 결론의 초점: **시간 단축이 아니라, 실행 중인 CONSULT에 사용자와 Claude가 개입할 수 있는가**

## 결론

**가능하다.** Codex App Server의 `turn/steer`를 사용하면 실행 중인 일반 turn에 사용자 입력을
추가할 수 있다. 현재 작업을 취소하거나 새 turn을 만들지 않고, 동일한 `turnId` 안에서 다음
모델 실행 경계에 새 입력을 반영한다.

다만 현재 `codex_rescue`가 사용하는 `codex exec` 프로세스에는 실행 중 입력을 밀어 넣는 제어
채널이 없다. 따라서 기존 FOLLOWUP을 없애거나 다시 설계할 필요는 없지만, **1턴 CONSULT를
실행하는 가장 아래쪽 transport에 App Server 중계층을 추가해야 한다.**

원하는 최종 구조는 다음과 같다.

```text
                                     ┌─ 사용자 정정 ───────────────┐
                                     │                            ▼
요청서 ─► CONSULT 1턴(App Server) ────┼──────────────► Codex 최종 답변
                 ▲                   │                            │
                 │                   └─ Claude 판단 ─ turn/steer ─┘
                 │
                 └──── 진행 이벤트를 Claude가 선택적으로 관찰

Codex 최종 답변
    └─► 기존 response 문서
          └─► 기존 Claude 검토
                └─► 필요할 때만 기존 FOLLOWUP(`codex exec resume`)
```

즉 두 기능의 책임이 다르다.

| 기능 | 시점 | 역할 | turn 수 |
|---|---|---|---:|
| **Live steer** | Codex가 아직 작업 중 | 새 증거·정정·방향 교정을 현재 작업에 합류 | 증가하지 않음 |
| **기존 FOLLOWUP** | Codex 최종 답변이 끝난 뒤 | 완성된 답을 Claude가 검토하고 재반박 | 증가함 |

**Live steer는 FOLLOWUP의 대체물이 아니라 앞단에 추가되는 자유 대화 채널이다.** 기존 멀티턴은
최종 답변 이후의 심층 반박 수단으로 그대로 남겨야 한다.

---

## 증거 수준 — 확정과 미검증을 섞지 않는다

| 판단 | 상태 | 근거 또는 남은 검증 |
|---|---|---|
| active turn에 `turn/steer`로 입력을 추가할 수 있음 | **확정** | OpenAI Docs의 공개 App Server 계약 |
| steer가 새 turn을 만들지 않고 같은 turnId를 반환 | **확정** | OpenAI Docs와 0.145.0 protocol·통합 테스트 |
| 현재 작업을 폐기하지 않고 pending input으로 보관 | **확정** | 0.145.0 `session/mod.rs`·`input_queue.rs` |
| 현재 모델/일반 명령 경계 뒤에 반영 | **코드로 확정** | 0.145.0 `session/turn.rs`; 실제 30초 명령 반증 테스트는 아직 필요 |
| 현재 `codex exec` 실행에 외부에서 steer 가능 | **불가능** | 해당 프로세스에 inbound 제어 채널이 없음 |
| App Server thread를 종료 후 기존 `codex exec resume`이 그대로 이어받음 | **미검증** | 기존 FOLLOWUP 무수정의 핵심 전제이므로 Phase 0에서 반드시 실측 |
| background waiter 종료가 현재 Claude를 원하는 시점에 다시 깨움 | **미검증** | 현재 completion 재호출 계약을 중간 waiter에 적용해 실측 필요 |
| App Server의 sandbox·approval이 기존 exec와 완전히 동일 | **미검증** | Windows·Linux에서 실제 파일 쓰기·승인 요청으로 대조 필요 |
| Remote-SSH에서 원격 bridge·소켓·Codex 조합 | **미검증** | 제어 프로세스를 원격에 놓은 실제 왕복 필요 |

특히 다섯 번째 줄과 여섯 번째 줄을 혼동하면 안 된다. 현재 exec 프로세스에 App Server를 별도로
띄워 붙는 방식은 성립하지 않는다. **처음부터 그 turn을 App Server가 소유해야 steer할 수 있다.**
반대로 App Server가 만든 완료 thread를 기존 exec가 재개할 수 있는지는 개연성만으로 확정하지 말고
실제 sentinel 대화로 증명해야 한다.

---

## 이번 결정에서 바꾸지 않는 것

사용자는 품질을 위해 필요한 사고 시간을 억제하지 않기로 했다. 따라서 아래는 해결책이 아니다.

- 모델 reasoning effort 하향
- 강제 실행 시간 제한
- 답변 길이 또는 조사 범위의 인위적 축소
- FOLLOWUP 턴 상한 축소
- 기존 종료 판정표 제거
- 여러 번 생각해야 하는 문제를 억지로 1턴에 끝내도록 강제

App Server 전환의 근거도 “프로세스 기동 몇 초를 줄인다”가 아니다. 근거는 **Codex가 잘못된
방향으로 들어갔을 때 최종 답변까지 기다리지 않고 바로 교정할 수 있어야 한다**는 상호작용
요구사항이다.

---

## Q1. 기존 지연 분해는 맞는가

방법론에 결함이 있다. 다만 이 결함은 이번 기능의 채택 여부를 결정하지 않는다.

기존 표는 `codex exec` 프로세스의 바깥 실행 시간을 거의 전부 “Codex 추론”으로 묶었다.
실제 rollout의 `task_started`·`task_complete`를 대조하면 다음과 같다.

| 구간 | 기존 분류 | 실제 확인 |
|---|---:|---:|
| 1턴 전체 실행 | 255초 | active task 약 **74.6초** |
| 2턴 전체 실행 | 101초 | active task 약 **95.3초** |
| active task 합계 | “추론 356초”에 포함 | 약 **169.9초** |
| 1턴 active task 시작 전 | 별도 분류 없음 | 약 **170초** |

1턴에서 약 170초 동안은 Codex turn 자체가 시작되지 않았다. 턴 시작 시점에 Expo MCP 인증 오류가
기록됐고 `node_repl` MCP에는 120초 startup timeout이 설정돼 있었지만, 이것만으로 170초의 원인을
MCP라고 확정할 수는 없다. 확정할 수 있는 것은 **그 구간이 모델 추론은 아니라는 것**이다.

또한 `turn.completed.usage`의 `input_tokens`와 `cached_input_tokens`는 한 turn 안의 여러 모델 호출에서
누적된 사용량이다. 캐시 비율 90%를 보고 “컨텍스트 비용과 지연은 사실상 0”이라고 결론 내릴 수는
없다. 캐시 적중은 재전송·과금·처리 특성을 바꾸지만, 전체 벽시계 시간을 직접 분해한 계측값은 아니다.

향후 성능을 따로 조사한다면 아래 시점을 각각 기록해야 한다.

```text
send.sh 시작
app-server 프로세스 시작
initialize 응답
thread/start 응답
turn/start 응답
turn/started 알림
첫 item 알림
turn/completed 알림
app-server 종료
send.sh 후처리 종료
```

그러나 이 계측 결과가 어떻든 **실행 중 자유 대화 요구는 남는다.** 따라서 성능 조사는 transport
설계의 부가 검증이지, `turn/steer` 채택 여부의 선행 게이트가 아니다.

---

## Q2. `turn/steer`는 진행 중인 작업을 어떻게 다루는가

### 공식 계약

[OpenAI Docs의 App Server 문서](https://learn.chatgpt.com/docs/app-server)는 `turn/steer`를
“현재 실행 중인 turn에 사용자 입력을 추가하며 새 turn을 만들지 않는 호출”로 설명한다.

공식 문서에서 확인되는 계약은 다음과 같다.

- `threadId`, `input[]`, `expectedTurnId`를 보낸다.
- `expectedTurnId`는 현재 active turn의 ID와 일치해야 한다.
- active turn이 없으면 실패한다.
- 성공 응답은 수락된 동일 `turnId`를 돌려준다.
- 새 `turn/started` 알림을 발생시키지 않는다.
- `model`, `cwd`, `sandboxPolicy`, `outputSchema` 같은 turn-level 설정 변경은 받지 않는다.
- `turn/interrupt`는 별도 API이며, 이것은 현재 turn을 취소하고 상태를 `interrupted`로 끝낸다.

호출 예시는 다음 형태다.

```json
{
  "id": 32,
  "method": "turn/steer",
  "params": {
    "threadId": "thr_123",
    "input": [
      {
        "type": "text",
        "text": "방금 전제는 사실과 다릅니다. 이 로그를 먼저 확인하세요."
      }
    ],
    "expectedTurnId": "turn_456"
  }
}
```

성공 응답:

```json
{
  "id": 32,
  "result": {
    "turnId": "turn_456"
  }
}
```

### 0.145.0 실제 구현

스키마만이 아니라 `openai/codex`의 `rust-v0.145.0` 구현도 대조했다.

| 파일 | 확인한 동작 |
|---|---|
| `codex-rs/app-server-protocol/src/protocol/v2/turn.rs:175-203` | `TurnSteerParams`와 동일 turn ID 응답 계약 |
| `codex-rs/app-server/src/request_processors/turn_processor.rs:919-1020` | thread 로드, 입력 검증, active turn 오류 매핑 |
| `codex-rs/core/src/session/mod.rs:3833-3912` | 새 입력을 active turn의 pending input queue에 넣음 |
| `codex-rs/core/src/session/input_queue.rs:172-183` | queue 확장 후 steer activity 신호 발생 |
| `codex-rs/core/src/session/turn.rs:219-322` | 다음 모델 요청을 만들기 전에 pending input을 history로 가져옴 |
| `codex-rs/app-server/tests/suite/v2/turn_steer.rs:235-385` | 실행 중 명령이 있는 turn에 steer하고 같은 turn ID로 수락되는 통합 테스트 |

따라서 질문 문서의 선택지에서는 **(a)에 가깝다.** 현재 작업을 버리고 새 입력부터 다시 시작하지
않는다. 정확한 표현은 다음과 같다.

```text
steer 도착
  → active turn의 pending input queue에 저장
  → 현재 진행 중인 모델 응답·일반 도구 호출은 계속
  → 다음 모델 실행 경계에서 pending input을 대화 history에 기록
  → 같은 turnId로 후속 추론
```

### 30초짜리 명령이 실행 중이면

일반 command execution을 `turn/steer`가 강제 취소하지 않는다. 보통은 현재 명령이 끝나고 도구
결과가 돌아온 뒤, 다음 모델 실행에서 새 입력을 읽는다. 일부 대기형 내부 도구는 steer activity를
감지해 일찍 깨어날 수 있지만, 이를 모든 명령의 공개 계약으로 가정하면 안 된다.

“즉시 멈춰라”가 필요하면 `turn/steer`가 아니라 `turn/interrupt`다. 그러나 자동
`turn/interrupt`는 기존 결과·문서·턴 번호 계약을 복잡하게 만들므로 **초기 구현 범위에서 제외**하는
것이 맞다. 정상적인 방향 교정은 비파괴적인 `turn/steer`만 사용한다.

---

## Q3. 시간이 줄어드는가

이 질문은 아키텍처 결정의 중심이 아니다.

`turn/steer`가 현재 모델 호출과 다음 모델 호출을 동시에 실행하는 것은 아니다. 현재 실행이 다음
경계에 도달한 뒤 새 입력을 반영해 추가로 생각하므로 총 추론량이 반드시 줄어드는 것도 아니다.

그럼에도 기능의 가치가 있는 이유는 다음과 같다.

- 사용자가 최종 답변까지 기다리지 않고 사실 오류를 바로잡을 수 있다.
- Claude가 Codex의 잘못된 파일 선택이나 전제를 발견했을 때 후속 탐색 전에 교정할 수 있다.
- 이미 한 조사와 도구 결과는 버리지 않은 채 같은 turn에서 방향을 바꿀 수 있다.
- 늦게 도착한 정정은 기존 FOLLOWUP으로 자연스럽게 넘길 수 있다.
- 사용자는 CONSULT가 진행 중이어도 현재 Claude 대화처럼 자유롭게 발언할 수 있다.

결국 목표 지표는 “몇 초 줄었나”보다 아래에 가깝다.

- 잘못된 방향을 최종 답변 전 교정할 수 있는가
- 사용자 정정이 유실되지 않는가
- Claude와 Codex의 견해 충돌이 투명하게 기록되는가
- steer 이후 Codex가 실제로 정정을 반영했는지 검증 가능한가
- 기존 FOLLOWUP 품질과 안전장치가 회귀하지 않는가

---

## Q4. 권장 아키텍처

### 핵심 원칙: 전면 재작성하지 않는다

`send.sh`의 앞뒤를 보존하고, `codex exec`를 실행하는 가운데 transport 부분만 Node 중계기로
교체할 수 있게 만든다.

```text
send.sh가 계속 소유하는 것
  - 요청서·frontmatter 검증
  - lock
  - heartbeat·status
  - 실행 전후 파일 변경 감지
  - EDIT 게이트
  - response_path 검증
  - stdout 최종 메시지 폴백
  - thread_id·origin·turns 기록
  - in-flight 복구
  - FOLLOWUP 종료 판정과 문서 append

Node 중계기가 새로 소유하는 것
  - codex app-server 프로세스
  - initialize / initialized
  - thread/start / turn/start
  - 양방향 JSON-RPC
  - active threadId·turnId
  - turn/steer
  - 서버 요청의 fail-closed 응답
  - App Server 알림 → 기존 events.jsonl 호환 이벤트 변환
  - turn/completed까지 대기 후 final message 반환
```

이렇게 하면 2,016행의 안전장치를 Node로 그대로 다시 쓰는 일을 피할 수 있다. Node는 통신만
담당하고, 검증·감시·후처리의 권위는 계속 `send.sh`에 둔다.

### transport 선택

초기에는 기능 플래그로 분리한다.

```text
CR_LIVE_STEER=1  → CONSULT 1턴만 App Server transport
미설정 또는 중계기 시작 전 실패 → 기존 codex exec transport
```

중요한 실패 경계:

- **turn/start 전 실패**: 기존 `codex exec`로 안전하게 fallback 가능
- **turn/start 후 실패**: 자동 fallback 금지. 같은 요청을 두 번 실행할 수 있으므로 실패로 보고
- **steer 실패**: 새 turn을 자동 생성하지 말고 Claude에게 정확한 거부 사유 반환
- **turn 완료와 steer 경합**: `no active turn`이면 “전달되지 않음”으로 기록하고 기존 FOLLOWUP 후보로 넘김

### 왜 CONSULT 1턴부터 시작하는가

사용자의 요구사항은 기존 FOLLOWUP을 건드리지 않는 것이다. 가장 좁은 1차 구현은 다음과 같다.

1. CONSULT 첫 turn만 App Server로 실행한다.
2. 실행 중에는 `turn/steer`를 허용한다.
3. turn이 끝나면 App Server를 종료하고 thread를 정상적으로 영속화한다.
4. response frontmatter에 기존처럼 `thread_id`, `origin`, `turns: 1`을 기록한다.
5. 이후 FOLLOWUP은 현재 코드의 `codex exec resume` 경로를 그대로 사용한다.

이 구조가 실제로 검증된 뒤에만 FOLLOWUP 실행 중에도 live steer를 열지 판단한다. 처음부터
FOLLOWUP transport까지 바꾸면 “기존 멀티턴을 건드리지 않는다”는 경계가 무너지고 회귀 범위가
급격히 커진다.

---

## 자유 대화가 실제로 흐르는 방식

### 1. 사용자 → Claude → Codex

Codex CONSULT가 active인 동안에도 사용자는 Claude에게 평소처럼 말한다. 별도의 `/steer` 명령을
외우게 하지 않는다.

Claude의 의미 판정 기준:

| 사용자 발언 | Claude 동작 |
|---|---|
| 현재 CONSULT의 사실 정정·추가 증거·방향 변경 | Codex에 steer하고 수락 결과 보고 |
| “진행 상황 알려줘” | 이벤트를 읽어 Claude가 설명, Codex에는 보내지 않음 |
| 현재 CONSULT와 무관한 새 작업 | Claude가 별도 처리, Codex에는 보내지 않음 |
| 현재 turn을 그만두라는 명시적 요청 | 자동 steer가 아니라 취소 의도 확인 후 별도 cancel 경로 |
| 관련 여부가 불명확 | 임의 전달하지 말고 맥락으로 판단하거나 짧게 확인 |

Codex에 보내는 입력에는 출처를 명확히 표시한다.

```text
[실행 중 사용자 정정 · Claude 중계]
사용자가 방금 다음 사실을 바로잡았습니다.

<사용자 발언 원문>

앞선 조사 결과를 버리지 말고, 이 정정을 반영해 현재 가설과 다음 조사 방향을 다시 판단하십시오.
```

Claude는 App Server가 동일 `turnId`를 응답한 뒤에만 “전달했다”고 말한다. 소켓에 쓰기만 성공한
상태를 전달 완료로 간주하면 안 된다.

### 2. Claude 자율 모니터링 → Codex

App Server가 이벤트를 보낸다고 해서 Claude가 자동으로 깨어나는 것은 아니다. 현재
`run_in_background`는 프로세스 종료 시 Claude를 깨우지만, 중간 이벤트마다 Claude를 호출하지 않는다.

따라서 자율 개입에는 별도의 **event-driven waiter**가 필요하다.

권장 방식:

```text
1. CONSULT 시작
2. Claude가 `live-bridge wait --stamp <stamp> --after <seq>`를 background로 등록
3. bridge는 다음 고신호 이벤트가 올 때까지 대기
4. 이벤트가 오면 짧은 요약을 stdout으로 내고 종료
5. background 완료 알림으로 Claude가 깨어남
6. Claude가 개입 여부를 판단
7. 필요하면 steer, 아니면 통과
8. turn이 active면 다음 waiter를 다시 등록
```

이 방식은 Claude가 몇 초마다 파일을 polling하는 구조보다 낫다. 다만 모든 토큰 delta마다 깨우면
또 다른 소모전이 되므로, waiter가 깨울 이벤트를 제한해야 한다.

초기 고신호 이벤트 후보:

- Codex가 처음 밝힌 조사 계획 또는 방향
- 새 command execution의 대상 경로·명령
- Codex가 “자료가 없다”, “확인할 수 없다”, “추가 정보가 필요하다”고 판단한 메시지
- `thread/status/changed`의 `waitingOnApproval`
- 요청서가 지정한 핵심 원본을 건너뛴 채 최종화하려는 신호
- turn 종료

Claude가 자동 steer하는 기준도 좁혀야 한다.

- 사용자 관측과 명백히 충돌하는 전제를 발견함
- 요청서에 적힌 원본 경로를 Codex가 없다고 오판함
- Claude가 직접 확인한 새 증거가 현재 가설을 뒤집음
- Codex가 대상과 무관한 트리로 조사를 확장함
- 권한·경로·환경에 대한 오해로 조사를 포기하려 함

단순히 Claude와 관점이 다르다는 이유만으로 steer하지 않는다. 독립적인 두 시선의 차이는 이 기능이
보존해야 할 가치다. 개입은 **새 사실이나 명백한 범위 오류가 있을 때** 한다.

---

## 중계기 인터페이스 제안

Node 스크립트는 스킬 중앙 원본 아래에 두는 것이 맞다.

```text
F:\Obsidian\global_dir\skills\codex_rescue\
  SKILL.md
  send.sh
  scripts\
    live-consult.mjs
```

현재 설치본과 중앙 원본의 `SKILL.md`·`send.sh` SHA-256은 각각 일치한다. 구현은 중앙 원본을
수정하고 기존 배포 절차로 설치본과 서버에 동기화해야 한다.

제안 CLI:

```bash
# send.sh 내부에서 호출 — turn 완료까지 대기하고 기존 호환 결과를 남김
node scripts/live-consult.mjs run \
  --request-file <절대경로> \
  --runtime-dir <권위 상태 디렉토리> \
  --events-file <기존 events.jsonl> \
  --last-message-file <기존 last_message.md>

# Claude가 실행 중 새 입력을 전달
node scripts/live-consult.mjs steer \
  --stamp <스탬프> \
  --input-file <메시지 파일> \
  --source user-via-claude

# Claude 자율 모니터를 위한 1회성 대기
node scripts/live-consult.mjs wait \
  --stamp <스탬프> \
  --after <마지막 이벤트 seq>
```

긴 한글 입력을 argv로 직접 넘기지 않는다. 현재 요청서·반박서가 파일을 사용하는 것과 같은 이유로
`--input-file` 또는 stdin을 사용한다.

### 권위 상태와 UI 상태를 분리한다

`docs/codex_rescue/.log/`는 Codex의 workspace-write 범위 안이며 현재 스킬도 이를 비권위 telemetry로
규정한다. 따라서 steer 제어에 필요한 소켓 주소·nonce·PID의 권위 원본을 `.log`에만 두면 안 된다.

권위 runtime 상태 예시:

```json
{
  "schema": 1,
  "stamp": "260825_174748",
  "nonce": "128-bit-random-value",
  "host": "BluemingPc",
  "pid": 12345,
  "threadId": "thr_123",
  "activeTurnId": "turn_456",
  "phase": "active",
  "steerSeq": 2,
  "endpoint": "local IPC endpoint"
}
```

이 파일은 OS 임시 디렉토리 아래의 실행별 디렉토리처럼 Codex workspace 밖에 두고 소유자만 읽을
수 있게 한다. `.log/<stamp>_live.json`에는 UI에 필요한 비민감 필드만 복제한다.

```json
{
  "schema": 1,
  "transport": "app-server",
  "active": true,
  "turnId": "turn_456",
  "steerCount": 2,
  "lastSteerAt": "2026-08-25T09:12:34Z"
}
```

### IPC

외부 네트워크 포트를 열 필요가 없다.

- Windows: named pipe
- Linux/macOS·Remote-SSH: Unix domain socket
- 인증: 실행별 무작위 nonce와 stamp·host 대조
- 권한: 같은 사용자 프로세스만 연결
- 수신한 메시지의 최대 크기 제한
- 동일 steer의 재전송을 막는 로컬 seq/nonce

기존 OpenAI Codex Claude 플러그인의 broker 구현은 named pipe/Unix socket 패턴을 참고할 수 있지만
그대로 재사용할 수는 없다. 현재 설치된 1.0.6 broker는 active stream 중 다른 연결에서
`turn/interrupt`만 예외적으로 허용하고, `turn/steer`는 busy로 거부한다. protocol type map에도
`turn/steer`가 없다. 참고 구현이지 drop-in transport가 아니다.

---

## 이벤트·진행 패널 호환

App Server 알림 형식과 `codex exec --json` 형식은 같지 않다. 확장이 현재
`docs/codex_rescue/.log/<stamp>_events.jsonl`의 exec 형식을 읽으므로, 초기 구현에서는 확장을
동시에 갈아엎지 말고 Node 중계기가 호환 이벤트를 써 주는 편이 안전하다.

권장 파일 분리:

```text
.log/<stamp>_appserver.jsonl   App Server 원문 — 감사·디버깅
.log/<stamp>_events.jsonl      기존 exec 호환 이벤트 — 현재 확장 소비
.log/<stamp>_steers.jsonl      사용자/Claude 개입과 RPC 수락·거부 기록
```

최소 변환표:

| App Server | 기존 호환 이벤트 |
|---|---|
| `thread/start` 응답 | `thread.started` |
| `turn/started` | `turn.started` |
| `item/started` | `item.started` |
| `item/completed` | `item.completed` |
| `turn/completed status=completed` | `turn.completed` |
| `turn/completed status=failed` | `turn.failed` |
| steer 수락 | 별도 `steer.accepted` 또는 agent message 형태의 표시 이벤트 |
| steer 거부 | 별도 `steer.rejected` 경고 이벤트 |

현재 `execEvents.ts`는 item을 `item.id` 하나로 upsert한다. 여러 `codex exec resume` 결과를 같은
events 파일에 append하면 각 프로세스의 `item_0`, `item_1`이 충돌할 수 있다. App Server 원문에는
`turnId`가 있으므로 호환 이벤트를 만들 때 item ID를 다음처럼 합성하는 것이 안전하다.

```text
<turnId>:<itemId>
```

또는 `turn_id`를 추가하고 확장 파서를 `(turnId, itemId)` 복합키로 바꾼다. 전자가 초기 호환층의
범위를 더 작게 만든다.

중요한 경계: **확장은 App Server 제어 주체가 되어서는 안 된다.** `extensionKind: ["ui"]`이므로
Remote-SSH에서 원격 App Server 소켓에 직접 닿지 못한다. 제어 중계기는 `send.sh`와 같은 실행
호스트에서 돌고, 확장은 지금처럼 workspace 파일만 수동적으로 읽어야 한다.

---

## Remote-SSH

Remote-SSH가 이 설계를 막지는 않는다. 단, 프로세스 위치를 잘못 잡으면 막힌다.

```text
로컬 VS Code UI extension
    └─ workspace.fs로 원격 .log 파일 읽기만 함

원격 Claude Code / send.sh
    ├─ 원격 Node live-consult.mjs
    ├─ 원격 codex app-server
    └─ 원격 Unix socket
```

steer 제어는 항상 **Codex를 실제 실행한 호스트**에서 일어나야 한다. docs 파일은 여러 머신으로
동기화될 수 있지만 active turn과 IPC endpoint는 머신을 건너지 않는다. 기존 `origin` 검증을
live runtime에도 그대로 적용해야 한다.

---

## 승인 요청과 샌드박스

App Server는 양방향 프로토콜이므로 서버가 다음과 같은 요청을 클라이언트에 보낼 수 있다.

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- MCP elicitation 요청

기존 CONSULT는 실측상 `approval_policy: never`로 실행된다. 동작 보존을 위해 App Server turn에도
기존 sandbox·network·approval 정책을 명시적으로 매핑해야 한다.

그래도 중계기는 서버 요청을 처리할 수 있어야 한다.

- 알 수 없는 서버 요청: 자동 승인 금지, fail-closed 응답 후 기록
- approval이 `never`: 명시적 거부 또는 프로토콜이 요구하는 오류 응답
- 사용자 승인이 필요한 새 정책: Claude가 아니라 기존 사용자 승인 경계를 통과한 뒤만 허용
- 요청을 무시해 turn을 영구 대기 상태로 만들지 않음

`thread/status/changed`의 `waitingOnApproval`은 Claude monitor를 깨우는 고신호 이벤트로 사용한다.

---

## 개입 기록과 기존 문서의 관계

steer는 같은 turn 안의 사용자 입력이므로 response frontmatter의 `turns`를 증가시키면 안 된다.

권장 규칙:

- 최초 CONSULT + steer 0회: `turns: 1`
- 최초 CONSULT + steer 5회: 여전히 `turns: 1`
- 최종 답변 후 기존 FOLLOWUP 1회: `turns: 2`

실행 중에는 `.log/<stamp>_steers.jsonl`에 append한다.

```json
{"seq":1,"at":"...","source":"user-via-claude","expectedTurnId":"turn_456","result":"accepted","text":"..."}
{"seq":2,"at":"...","source":"claude-monitor","expectedTurnId":"turn_456","result":"rejected:no-active-turn","text":"..."}
```

turn 완료 후에는 response 문서에서 Codex 원문을 수정하지 말고, Claude 검토 전에 별도 섹션으로
붙이는 방식을 권한다.

```markdown
## 실행 중 개입 기록

### 1. 사용자 → Claude → Codex

> 사용자 원문 …

- 전달 결과: 같은 turn에 수락됨
- 수락 turnId: `turn_456`

### 2. Claude 자율 교정

> 새로 확인한 증거 …

- 전달 결과: turn 완료 경합으로 거부됨
- 처리: 기존 FOLLOWUP 후보로 이관
```

이 기록은 다음 FOLLOWUP에서 “Codex가 이미 무엇을 들었는가”를 Claude가 오판하지 않게 해 준다.
단, 기존 `## Claude 검토`와 `## 🔁 N턴` 구조의 순서·의미는 유지한다.

---

## 경합과 실패 규칙

### 완료 직전 steer

가장 흔한 경합이다.

1. Claude가 active 상태를 읽는다.
2. 그 직후 Codex turn이 완료된다.
3. Claude가 옛 `expectedTurnId`로 steer한다.
4. 서버가 `no active turn` 또는 ID mismatch로 거부한다.

이것은 정상적인 보호다. 중계기는 성공으로 위장하지 말고 원문을 보존해 기존 FOLLOWUP 후보로
넘긴다.

### stale run 오염

stamp만 믿지 않는다. 최소한 아래를 모두 맞춘다.

- stamp
- host/origin
- 실행 nonce
- threadId
- expectedTurnId
- bridge PID 생존
- phase가 `active`

### 중계기 크래시

- app-server 자식까지 종료
- 권위 runtime 상태를 `failed`로 전환
- heartbeat를 멈추지 말고 `send.sh` 후처리까지 이어감
- steer 수락 여부가 불명확하면 `unknown`으로 기록
- turn이 시작된 뒤에는 기존 exec로 자동 재실행하지 않음

### 여러 steer 동시 도착

- bridge 단일 큐에서 seq 순으로 직렬 전송
- 각 요청마다 별도 RPC id
- 동일 input-file/nonce 재전송 방지
- 수락 응답의 turnId를 매번 대조
- 입력 순서를 `.log/<stamp>_steers.jsonl`에 보존

---

## 구현 순서

### Phase 0 — 폐기 가능한 fixture

프로덕션 `send.sh`를 건드리기 전에 별도 임시 프로젝트에서 다음만 증명한다.

1. app-server initialize
2. thread/start
3. turn/start로 30초 이상 실행되는 command 유도
4. command 실행 중 두 번째 클라이언트로 turn/steer
5. 같은 turnId 수락 확인
6. command 완료 뒤 Codex가 steer 문장을 실제로 언급하는지 확인
7. 새 `turn/started`가 생기지 않는지 확인
8. turn 완료 뒤 같은 expectedTurnId steer가 거부되는지 확인
9. App Server 종료 후 `codex exec resume <threadId>`로 sentinel 맥락을 정확히 재현하는지 확인
10. 위 resume을 `-c sandbox_mode="read-only"`로 돌려 기존 FOLLOWUP 권한 경계를 재현하는지 확인

이 단계의 완료 조건은 단순 RPC 성공이 아니라 **최종 답변 내용이 중간 정정을 반영하는 것**이다.
그리고 9번이 실패하면 “기존 FOLLOWUP을 그대로 둔다”는 설계가 성립하지 않는다. 그 경우
FOLLOWUP transport까지 App Server로 바꾸지 말고 먼저 사용자에게 설계 충돌을 보고해야 한다.

### Phase 1 — CONSULT 1턴 transport만 추가

- `scripts/live-consult.mjs` 추가
- `CR_LIVE_STEER=1`일 때만 사용
- send.sh의 검증·lock·baseline·후처리는 그대로
- 사용자 → Claude → Codex steer 구현
- App Server 원문과 exec 호환 로그 동시 기록
- turn 완료 후 기존 response/frontmatter 생성
- App Server 시작 전 실패만 기존 exec fallback

### Phase 2 — 기존 FOLLOWUP 회귀 검증

현재 검증표의 FOLLOWUP 경로를 그대로 다시 실행한다.

- 1턴 thread_id 심기
- `origin`, `turns: 1`
- 기존 `codex exec resume`
- 2턴 read-only 강제
- 반박서 잘못된 진입점 거부
- 턴 번호 어긋남 거부
- 실패 시 thread_id 폐기
- in-flight 복구
- 응답 문서 append

여기서 한 항목이라도 달라지면 live steer를 기본값으로 올리지 않는다.

### Phase 3 — Claude event-driven monitor

- `wait --after <seq>` 구현
- 고신호 이벤트만 Claude를 깨움
- Claude가 통과/steer 판단 후 waiter 재등록
- turn 완료 시 waiter 정상 종료
- 사용자 새 메시지가 오면 monitor와 경합 없이 동일 steer queue 사용

### Phase 4 — 확장·Remote-SSH

- 기존 `events.jsonl` 파서 회귀 확인
- composite item ID로 덮어쓰기 방지
- status에 `transport`, `activeTurnId`, `steerCount` 표시 여부 결정
- Remote-SSH에서 bridge와 app-server가 원격에서 도는지 확인
- 로컬 UI extension은 소켓에 연결하지 않는지 확인

---

## 필수 검증표

| 항목 | 기대 결과 |
|---|---|
| active turn에 올바른 expectedTurnId | 동일 turnId로 수락 |
| expectedTurnId 불일치 | 명시적 거부, 다른 turn 오염 없음 |
| active turn 없음 | 거부 후 기존 FOLLOWUP 후보로 보존 |
| 빈 입력 | 거부 |
| review/compact turn | steer 거부 |
| 일반 command 실행 중 steer | command 강제 취소 없음, 다음 모델 경계에서 반영 |
| steer 3개 연속 | 순서 보존, turn 수 증가 없음 |
| 사용자 자연어 정정 | Claude가 관련성을 판정해 전달, 수락 후 보고 |
| Claude 자율 개입 | 새 증거가 있을 때만 전달, 관점 차이만으로 개입하지 않음 |
| bridge 시작 전 실패 | 기존 exec fallback |
| turn/start 후 bridge 실패 | 이중 실행 없이 실패 보고 |
| App Server 서버 요청 | 자동 승인 없음, 무한 대기 없음 |
| response 저장 실패 | 기존 last-message 폴백 유지 |
| 변경 감지 | 기존 생산 영역 위반 탐지 유지 |
| EDIT 게이트 | 기존 승인 없이는 여전히 차단 |
| 기존 FOLLOWUP | 문서·턴 번호·read-only·복구 전부 동일 |
| events 호환 | 기존 진행 카드가 깨지지 않음 |
| Remote-SSH | 원격 bridge/소켓, 로컬 확장은 파일 읽기만 |

---

## 완료 기준

다음이 모두 충족돼야 “자유 대화가 구현됐다”고 판단할 수 있다.

1. CONSULT 실행 중 사용자가 Claude에게 평범한 자연어로 정정할 수 있다.
2. Claude가 그 정정을 현재 active turn에 전달하고, 동일 turnId 수락을 확인한다.
3. Codex 최종 답변이 정정 내용을 실제로 반영한다.
4. steer는 새 turn을 만들지 않고 response의 `turns`도 증가시키지 않는다.
5. turn 완료 경합으로 전달되지 못한 문장은 유실되지 않고 기존 FOLLOWUP 후보가 된다.
6. Claude가 진행 이벤트를 보고 새 사실이 있을 때 자율적으로 steer할 수 있다.
7. 기존 요청서·응답서·Claude 검토·FOLLOWUP 문서 구조가 유지된다.
8. 기존 lock·heartbeat·변경 감지·EDIT 게이트·in-flight 복구가 유지된다.
9. App Server가 실패해도 같은 CONSULT를 조용히 두 번 실행하지 않는다.
10. 확장이 기존 진행 카드와 완료 알림을 계속 표시한다.
11. Remote-SSH에서도 제어 프로세스가 Codex와 같은 원격 호스트에서 실행된다.
12. reasoning effort, 시간, 조사 범위를 품질 저하 방식으로 제한하지 않는다.

---

## 최종 권고

배관을 바꾸는 이유를 “385초를 줄이기 위해서”라고 정의하면 투자 근거가 약해진다. 그러나 요구사항을
정확히 정의하면 결론이 달라진다.

> **CONSULT는 긴 요청서를 던지고 기다리는 단방향 작업이 아니라, Codex가 조사하는 동안 사용자와
> Claude가 사실·증거·교정을 계속 공급할 수 있는 열린 대화여야 한다.**

이 요구는 현재 `codex exec`로는 충족할 수 없고, App Server의 `turn/steer`가 정확히 제공하는
기능이다. 따라서 **App Server transport를 추가할 가치는 있다.**

다만 안전한 구현 경계는 명확하다.

- 기존 FOLLOWUP을 제거하거나 대체하지 않는다.
- 기존 2,016행 `send.sh`를 Node로 전면 재작성하지 않는다.
- Node는 active turn 통신과 이벤트 변환만 맡는다.
- `send.sh`의 검증·감시·후처리 계약은 그대로 둔다.
- 첫 구현은 CONSULT 1턴에만 feature flag로 적용한다.
- user relay를 먼저 완성하고, Claude 자율 monitor는 event-driven waiter로 추가한다.
- 정상 개입은 `turn/steer`만 사용하며 자동 `turn/interrupt`는 넣지 않는다.
- 성능이 아니라 **교정 가능성·메시지 무손실·기존 멀티턴 무회귀**로 성공을 판정한다.

이 순서라면 현재 멀티턴의 품질과 축적된 안전장치를 보존하면서, 사용자가 원한 “지금 이 대화처럼
진행 중에도 자유롭게 끼어들 수 있는 CONSULT”를 추가할 수 있다.
