# live-consult — CONSULT 가 도는 중에 끼어들기

`codex_rescue` 의 CONSULT 1턴을 `codex exec` 대신 **`codex app-server`** 로 실행하는 중계기다.
`codex exec` 는 한 번 던지면 끝날 때까지 아무것도 넣을 수 없는 배치 프로세스다. app-server 는
JSON-RPC 양방향이라 **턴이 도는 도중에 `turn/steer` 로 입력을 더 넣을 수 있다.** 이 도구는 그
차이 하나만을 위해 존재한다.

바꾸려는 것은 속도가 아니다. Codex 가 엉뚱한 파일을 파고 있거나 틀린 전제 위에서 조사를 넓히고
있을 때, 최종 답변이 나올 때까지 몇 분을 기다렸다가 FOLLOWUP 으로 되묻는 대신 **지금 바로 고쳐
주는 것**이다. 이미 한 조사와 도구 결과는 버려지지 않고, 턴 수도 늘지 않는다.

> 🔴 **아직 `send.sh` 에 붙어 있지 않다.** 통합 계획은 [`docs/LIVE_STEER_INTEGRATION.md`](../../docs/LIVE_STEER_INTEGRATION.md)
> 에 있고, 거기에 결정되지 않은 항목이 여러 개 남아 있다. 지금은 단독으로만 돈다.

## 무엇을 하고 무엇을 안 하나

하는 것은 통신과 변환뿐이다.

- `codex app-server` 를 띄우고 WebSocket 으로 붙는다
- `initialize` / `thread/start` / `turn/start` 를 보내고 `turn/completed` 까지 기다린다
- 도착하는 알림을 **기존 `codex exec --json` 과 같은 형식**으로 바꿔 `--events-file` 에 append 한다
- 밖에서 큐에 들어온 정정을 `turn/steer` 로 현재 턴에 밀어 넣는다
- 최종 답변을 `--last-message-file` 에 쓴다 (`codex exec -o` 와 같은 자리)

하지 않는 것 — 요청서 검증, lock, heartbeat, 변경 감지, EDIT 게이트, `response_path` 검증,
응답 문서 작성, `thread_id` 심기. 이건 전부 `send.sh` 의 일이고 그대로 둔다. 2,000행에 걸쳐
쌓인 안전장치를 Node 로 옮겨 쓰는 순간 그게 곧 회귀다.

파일 구성은 이렇다. 진입점은 오케스트레이션만 하고 배관은 셋으로 나뉘어 있다.

```
live-consult.mjs    CLI 진입점 — run / steer / wait / status
lib/appserver.mjs   app-server 기동 + ws JSON-RPC 클라이언트
lib/bridge.mjs      app-server 알림 → exec 호환 events.jsonl 변환
lib/runtime.mjs     권위 runtime 상태 + steer 큐 + 경합 규칙
```

## 서브커맨드

정확한 플래그와 기본값은 `--help` 가 정본이다. 어느 서브커맨드에나 `--dry-run` 을 붙이면 codex 를
부르지 않고 조립 결과만 낸다. **먼저 이것부터 봐라.**

### `run` — 턴을 소유하고 끝까지 기다린다

```bash
node tools/live-consult/live-consult.mjs run \
  --stamp <스탬프> \
  --request-file <요청서 절대경로> \
  --cwd <Codex 작업 디렉토리> \
  --events-file <.log/<stamp>_events.jsonl> \
  --last-message-file <last_message.md> \
  --appserver-log <.log/<stamp>_appserver.jsonl> \
  --steers-log <.log/<stamp>_steers.jsonl> \
  --sandbox workspace-write
```

`--port` 를 생략하면 빈 포트를 OS 에서 받는다. `--turn-timeout-ms` 기본은 **0(무제한)** 이다 —
`send.sh` 가 2026-08-17 에 `CR_TIMEOUT` 을 제거한 결론을 여기서 뒤집지 않는다.

🔴 **stdout 은 이벤트 스트림이 아니다.** 이벤트는 `--events-file` 에 직접 쌓이고, stdout 에는
끝날 때 결과 블록 하나만 나온다.

```
LIVE_CONSULT_RESULT
thread_id=...
turn_id=...
status=completed
steer_delivered=1
steer_rejected=0
last_message=...
events=...
runtime=...
exit_class=...
END_LIVE_CONSULT_RESULT
```

`send.sh` 에 붙일 때 이 점이 중요하다. 기존 실행부는 codex 의 stdout 을 `| tee` 로 받아
events 파일로 흘리는 파이프라인인데, 중계기는 그 모양이 아니다. 통합 계획의 a 항목이 이걸 다룬다.

app-server 의 stderr 는 **통째로 버린다.** 계정 정보가 섞여 나온다(Phase 0 에서 779바이트
나왔고 내용은 보지 않고 폐기했다). 몇 바이트였는지만 진단에 남긴다.

턴이 끝나면 app-server 를 트리째 종료한다. Windows 에서는 `taskkill /T /F` 다 — MSYS `kill` 은
node 가 `CreateProcess` 로 띄운 손자에 닿지 않는다.

### `steer` — 도는 중인 턴에 말을 얹는다

```bash
node tools/live-consult/live-consult.mjs steer \
  --stamp <스탬프> \
  --input-file <정정 내용을 담은 파일|->
```

`--source` 는 `user-via-claude`(기본) 또는 `claude-monitor` 다. 사용자가 한 말인지 Claude 가
스스로 판단한 것인지 기록에 남기기 위한 구분이다.

긴 한글을 argv 로 넘기지 않는다. 요청서·반박서가 파일인 것과 같은 이유이고, Windows 의 인자 길이
한계(실측 32,000바이트 성공 / 32,700바이트 실패, 한글은 UTF-8 3바이트라 더 빨리 걸린다)를 피하기
위해서다. `-` 를 주면 stdin 을 읽는다.

동작은 **큐 방식**이다. `steer` 는 app-server 에 직접 붙지 않는다. 큐에 넣으면 `run` 이 폴링해서
자기 연결로 `turn/steer` 를 쏘고, 응답을 결과 파일에 남긴다. `steer` 는 그 결과를 기다렸다가
보고하고 끝난다.

🔴 **큐에 들어간 것은 전달이 아니다.** 서버가 같은 `turnId` 를 응답으로 돌려줘야 비로소 전달된
것이고, 그때만 "전달됨"이라고 말한다. 거부되면 서버가 준 사유를 그대로 낸다.

거부는 정상 동작이다. 가장 흔한 것이 **완료 직전 경합**이다 — 상태를 읽은 직후 턴이 끝나면
`{"code":-32600,"message":"no active turn to steer"}` 가 온다. 이때 문장을 삼키지 말고 그대로
보존해 FOLLOWUP 후보로 넘긴다.

### `wait` — 다음 고신호가 올 때까지 한 번 기다린다

```bash
node tools/live-consult/live-consult.mjs wait --stamp <스탬프> --after <마지막 seq>
```

Claude 가 스스로 개입 여부를 판단하려면 진행 상황을 봐야 하는데, `run_in_background` 는 프로세스가
**끝날 때만** Claude 를 깨운다. 중간 이벤트마다 깨우는 경로가 없다. 그래서 "다음 볼 만한 일이
생길 때까지 기다렸다가 짧게 요약하고 종료하는" 프로세스를 background 로 하나 걸어 두고, 그 종료가
Claude 를 깨우는 방식을 쓴다. 깨어난 Claude 는 개입하거나 통과하고, 턴이 아직 살아 있으면
다음 seq 로 `wait` 를 다시 건다.

지금 고신호로 보는 것은 여덟 가지다.

- `plan` — 조사 계획이 나왔다
- `command-started` — 새 명령 실행 시작. 명령문과 cwd 를 함께 낸다
- `file-change` — 파일 변경 시도. CONSULT 는 원래 고치면 안 된다
- `blocked` — "자료가 없다 / 확인할 수 없다" 류 문구가 최종 아닌 메시지에 나왔다
- `finalizing` — 최종 답변(`phase=final_answer`)을 쓰기 시작했다
- `waiting-approval` — 승인 대기로 보이는 상태. 이 실행에는 승인할 사람이 없다
- `server-request` — 서버가 클라이언트에 요청을 보냈다 (거부하고 기록했다)
- `turn-ended` — 턴 종료(`turn/completed`). `status=` 로 완료인지 실패인지 함께 낸다

🔴 **이 목록은 잠정치다.** 사용자가 정한 정책이 아니라 Codex 자문이 제시한 후보를 전부 구현하고
애매하면 깨우는 쪽으로 기울인 것이다. 무엇을 깨울 만한 일로 볼지는 아직 결정되지 않았다.

### `status` — 지금 무슨 상태인지 한 번 읽는다

```bash
node tools/live-consult/live-consult.mjs status --stamp <스탬프>
```

권위 runtime 상태를 읽어 phase · threadId · activeTurnId · steer 횟수를 낸다. `--json` 을 붙이면
원본 JSON 을 그대로 낸다.

🔴 **`status` 와 `steer` 는 소켓으로 진행 상황을 볼 수 없다.** 알림이 턴을 시작한 연결에만 가기
때문이다(아래 Phase 0 제약). 진행 상황의 출처는 언제나 `run` 이 써 둔 파일이다.

## 종료 코드 — 실패 경계가 여기 들어 있다

`turn/start` **전**과 **후**는 되돌릴 수 있는지가 다르다. 전이면 Codex 가 아직 아무 일도 안
했으니 `codex exec` 로 돌아가도 되고, 후면 이미 모델이 돌기 시작했으므로 폴백은 **같은 요청의
이중 실행**이다. 호출자가 종료 코드만 보고 판단할 수 있게 번호대를 갈라 놓았다.

```
0    정상
2    인자 오류 (아무것도 실행하지 않았다)

10번대 — turn/start 이전에 끝났다 → codex exec 로 fallback 해도 안전
10   서버 기동 / initialize / thread/start / turn/start 실패
11   lib/*.mjs 를 싣지 못했다

20번대 — turn/start 이후에 끝났다 → 🔴 자동 fallback 금지
20   턴이 도는 중 연결이 끊기거나 서버가 죽었다
21   turn/completed 가 status=failed 로 왔다
22   --turn-timeout-ms 상한에 걸렸다

30번대 — steer
30   turn/steer 가 거부됐다 (사유를 그대로 출력한다)
31   해당 stamp 의 실행이 없거나 이미 끝났다
32   큐에 넣었지만 전달 확인을 못 받았다

40번대 — wait
40   고신호 없이 상한에 도달했다
```

## 🔴 근거 없이 넣은 잠정치

동작시키려면 뭐라도 필요해서 넣은 값들이다. **사용자가 정한 정책이 아니다.** 코드 곳곳에 흩어
두면 나중에 근거 있는 값처럼 보이므로 한곳(`PENDING_DECISION`)에 모아 두었고, 전부 CLI 옵션으로
덮을 수 있다.

- steer 큐 확인 간격 1초
- steer 전달 확인 상한 60초
- `wait` 상한 30분
- 결과 파일 폴링 간격 0.5초 (Windows 에서 `fs.watch` 누락이 보고돼 있어 폴링으로 간다)
- 턴 상한 0 = 무제한 — 이것만은 근거가 있다. `CR_TIMEOUT` 제거 결론을 보존한 값이다

## Phase 0 실측 결과

2026-08-25 에 [`tools/steer-fixture`](../steer-fixture/README.md) 로 실제 Codex 를 돌려 얻은
결과다. 10항목 중 9개가 통과했다. 원문 로그는
`%TEMP%\codex-steer-fixture\2026-08-25T12-11-27-190Z\rpc.jsonl` 에 있다.

### 확인된 것

**끼어들기가 실제로 통한다.** 45초짜리 명령이 도는 중(10.7초 시점)에 별도 WebSocket 연결에서
`turn/steer` 를 보냈고, 같은 `turnId` 로 2ms 만에 수락됐다. 새 `turn/started` 는 생기지 않았다.

**모델이 그 말을 실제로 들었다.** RPC 가 200 을 돌려주는 것과 모델이 반영하는 것은 다른 문제라,
steer 문장에만 있는 랜덤 토큰을 심고 최종 답변에 그것이 나오는지로 판정했다. 나왔다.

**명령이 끝나기를 기다리지 않았다.** steer 도착 10.5초 뒤(21.2초), 명령이 아직 도는 중에
이벤트 스트림에 `userMessage` item 으로 나타났고 곧이어 "추가 지시를 반영했습니다"라는 중간
메시지가 나왔다. 명령은 56초에 끝났다. 반영 시점은 명령 경계가 아니라 **다음 모델 실행 경계**다.

**app-server 로 만든 스레드를 `codex exec resume` 이 그대로 이어받았다.** 1턴에 외우게 한 센티넬을
app-server 를 죽인 뒤 resume 으로 물었더니 정확히 되받았다. 이게 실패했다면 "기존 FOLLOWUP 을
그대로 둔다"는 설계 전체가 무너졌을 것이다.

프로토콜 세부는 이렇게 확정됐다.

- 기동: `codex app-server --listen ws://127.0.0.1:<port> -c windows.sandbox=unelevated`
- 전송은 **NDJSON**. LSP 식 `Content-Length` 헤더가 없다
- 핸드셰이크는 `initialize` → 응답 → `initialized`(id 없는 알림) → 그 뒤 요청
- `thread/start` 응답 약 760ms. `threadId` 와 `sessionId` 가 **같은 값**이었다
- `turn/start` 응답이 **턴 시작 즉시** 온다(왕복 3ms, `status: "inProgress"`).
  `turn/started` 알림(1213ms)보다 먼저 왔으므로 turnId 는 응답에서 바로 잡으면 된다
- 최종 답변은 `agentMessage` item 의 **`phase: "final_answer"`** 로 가린다.
  중간 서술도 같은 `agentMessage` 타입으로 오는데 그건 `phase: "commentary"` 다
- `turn/completed` 의 `turn.status` 가 `completed` / `failed` 를 가른다.
  **`turn.failed` 라는 별도 메서드는 없다**
- `turn/steer` 는 experimental 게이트 밖이다. `capabilities.experimentalApi` 가 필요 없다

### 제약 — 설계를 가르는 것들

**알림은 턴을 시작한 연결에만 간다.** steer 를 보낸 두 번째 연결은 `turn/started` 를 **0개**
받았다. `item/*`, `turn/completed`, `hook/*`, 토큰 사용량, MCP 기동 상태도 마찬가지다.
예외는 `thread/status/changed` 와 `remoteControl/status/changed` 둘로, 이건 두 번째 연결에도 왔다.
그래서 "지금 active 인가" 정도는 별도 연결로도 알 수 있지만 **진행 내용은 볼 수 없다.**
`wait` 와 `status` 가 소켓이 아니라 파일을 읽는 이유가 이것이고, steer 를 큐 방식으로 만든
이유이기도 하다 — 어차피 `run` 만이 그 턴을 볼 수 있다.

**턴이 끝난 뒤의 steer 는 거부된다.** 같은 `expectedTurnId` 로 다시 보내면
`{"code":-32600,"message":"no active turn to steer"}` 다. 완료 알림과 재전송 사이가 57ms 였다 —
정상 경합이고, 막아 주는 것이 맞다.

**`review` · `compact` 턴은 steer 가 안 된다.** 스키마의 `NonSteerableTurnKind` 가 그 둘이다.
REVIEW 모드를 이 경로로 옮겨도 얻을 것이 없다는 뜻이다.

**Windows 에서는 ws 가 다중 연결의 유일한 경로다.** `unix://` 는 안 되고 `stdio://` 로는 두 번째
연결 자체가 성립하지 않는다. named pipe 로 app-server 에 붙는 선택지는 없다.

### 미확인으로 남은 것

**resume 의 read-only 경계**(Phase 0 10번)가 `⬜` 다. `-c sandbox_mode=read-only` 로 돌린 resume 에서
쓰기 프로브 파일이 안 생겼는데, **대조군(`workspace-write`)에서도 안 생겼다.** 권한이 막은 것인지
모델이 시도를 안 한 것인지 가릴 수 없다. FOLLOWUP transport 를 건드리지 않는 판단의 근거 중 하나다.

그 밖에 확인되지 않은 것들:

- 루프백 ws 리스너가 정말 무인증인지 — `--ws-auth` 설명이 "non-loopback listeners"라고 못박으므로
  그럴 것으로 **보이지만** 실측한 적은 없다
- `--listen ws://127.0.0.1:0` 로 OS 가 포트를 골라 주는지, 골라 줬다면 그 번호를 어디로 알려
  주는지 — 이 CLI 는 미리 빈 포트를 찾아 명시적으로 지정하는 쪽을 택했다
- app-server 의 승인 요청(`item/*/requestApproval`) 실제 동작 — `approvalPolicy: never` 로 돌아서
  한 번도 오지 않았다. 오면 안 되는 물건이라 오는 것 자체가 발견이다
- Remote-SSH 왕복 — 중계기와 app-server 를 원격에 두고 돌린 적이 없다
- Linux 서버에서의 동작 — 전부 Windows 로컬 실측이다
- 여러 steer 를 연속으로 보냈을 때의 순서 보존 — Phase 0 은 1회만 보냈다

## 트러블슈팅

**먼저 `--dry-run`.** codex 를 부르지 않고 조립될 명령줄, 포트, runtime 디렉토리, 각 산출물의
실제 경로를 그대로 보여준다. 경로가 어긋난 문제는 대부분 여기서 끝난다.

**ws 포트에 못 붙는다.** 다른 실행이 그 포트를 쥐고 있거나 app-server 가 기동 중 죽은 것이다.
app-server 의 stderr 는 버려지므로 원인이 로그에 남지 않는다 — `--port` 를 바꿔 다시 돌려 보는
것이 가장 빠르다. 종료 코드가 10 이면 아직 아무 일도 안 일어난 상태이므로 그냥 다시 돌려도 된다.

**steer 를 보냈는데 `no active turn to steer` 가 온다.** 턴이 이미 끝났다. 정상이다.
문장을 버리지 말고 FOLLOWUP 반박서로 옮겨라. 종료 코드 30 이다.

**steer 가 종료 코드 31 로 끝난다.** 그 스탬프의 실행이 없거나 이미 끝났다. `status` 로 확인해라.

**steer 가 종료 코드 32 로 끝난다.** 큐에는 들어갔는데 전달 확인이 안 왔다. `run` 이 폴링을 못
하고 있거나(1초 간격) 그 사이에 죽었다. **전달됐는지 안 됐는지 모르는 상태**이므로 같은 문장을
다시 보내기 전에 이벤트 스트림에 `userMessage` 로 나타났는지부터 확인해라.

**steer 는 수락됐는데 답변에 반영이 안 보인다.** 다음 모델 실행 경계까지는 시간이 걸린다.
Phase 0 에서는 10.5초였다. 이벤트 스트림에 `userMessage` item 이 나타났는지부터 확인해라 —
그게 나타났으면 모델의 대화 기록에는 들어간 것이다.

**진행 이벤트가 하나도 안 보인다.** `steer` 나 `status` 프로세스로 보고 있는 것이 아닌지 확인해라.
알림은 `run` 연결에만 간다. 진행 상황은 `run` 이 쓴 events 파일에서만 읽을 수 있다.

**턴이 끝났는데 codex 프로세스가 남아 있다.** Windows 에서 `kill` 로는 손자에 닿지 않는다.
`tasklist | grep -i codex` 로 확인하고 `taskkill /PID <pid> /T /F` 로 트리째 정리해라.

**확장 진행 카드가 안 뜨거나 항목이 겹친다.** 이벤트 변환 쪽 문제다. 파서는 `item.id` 하나로
upsert 하므로 서로 다른 턴의 item 이 같은 id 를 가지면 덮어쓴다. 파서가 턴 경계에서 접두를
붙여 이걸 막는데, 그 경계 신호가 `turn.completed` 다 — 그게 안 나가면 접두도 안 붙는다.
`unknownTypes` 나 `badLines` 가 올라가면 변환 형식이 어긋난 것이다 — item 타입이 snake_case 로
나가는지부터 봐라.
