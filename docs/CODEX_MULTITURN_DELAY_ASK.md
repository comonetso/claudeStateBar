# 멀티턴 자문이 너무 느리다 — 배관을 바꿀 가치가 있는가

## 무엇을 하고 있나

Claude Code용 스킬 `codex_rescue`가 있다. Claude가 막힌 문제를 요청서로 정리해
`codex exec`를 호출하고, Codex의 답을 받아 Claude가 검토한다.

2026-08-25에 **되묻기(FOLLOWUP)** 를 붙였다. 답을 받은 뒤 Claude가 반박서를 써서
`codex exec resume`으로 다시 묻는 방식이다. 턴 상한 11.

**문제: 턴이 직렬로 쌓여 시간이 폭증한다.** 1턴 끝나고 2턴, 3턴으로 넘어갈수록
전체 소요가 선형으로 늘어난다. 이걸 없애고 싶다.

---

## 실측 — 2턴 왕복 385초가 어디로 갔나

실제 실행 기록(스탬프 `260825_174748`)의 파일 mtime과 status.json으로 분해했다.

| 구간 | 소요 | 비중 |
|---|---|---|
| 1턴 Codex 실행 | 255초 | |
| Claude가 답변 검토 + 반박서 작성 | 23초 | |
| 프로세스 기동 (send.sh → codex exec resume) | 6초 | |
| 2턴 Codex 실행 | 101초 | |
| **Codex 추론 합계** | **356초** | **92.5%** |
| **턴 전환 오버헤드 합계** | **29초** | **7.5%** |

토큰 캐시도 확인했다. `turn.completed`의 usage 원문:

```
1턴  input 293,443 / cached 261,120  → 새로 처리 32,323 (11%)
2턴  input 546,777 / cached 492,288  → 새로 처리 54,489 (10%)
```

**캐시가 90%를 먹고 있어 컨텍스트 재전송은 실질 비용이 아니다.**

→ 즉 배관을 갈아엎어 프로세스 기동을 없애도 **6초**를 줄인다.
이 수치가 맞다면 배관 개편의 근거는 거의 없다.

---

## 검토 중인 해법 — `codex app-server` + `turn/steer`

`codex app-server`(JSON-RPC)에 이런 것들이 있다는 것까지 확인했다.
스키마는 `codex app-server generate-json-schema --experimental --out <DIR>` 로 뽑을 수 있다.
(codex-cli 0.145.0 기준. `--experimental` 없이 뽑은 것과 비교해 `turn/steer`가
실험 게이트 뒤가 **아님**을 확인했다.)

- `turn/start` · `turn/steer` · `turn/interrupt`
- `TurnSteerParams` 필수: `threadId` · `expectedTurnId` · `input[]`
  - `expectedTurnId` 설명: *"Required active turn id precondition.
    The request fails when it does not match the currently active turn."*
- `NonSteerableTurnKind = ["review", "compact"]` — 리뷰·컴팩션 턴에는 steer 불가
- 승인 요청(`item/commandExecution/requestApproval` 등)이 클라이언트로 온다
- `thread/status/changed`에 `waitingOnApproval | waitingOnUserInput`

**기대하는 그림**은 턴을 줄이는 게 아니라 **턴을 겹치는 것**이다.

```
지금    [1턴 255초] → 검토 → [2턴 101초]          직렬 356초
steer   [1턴 255초 ····· 도는 중에 끼어듦 ·····]    2턴이 별도로 안 생김
```

---

## 물어보고 싶은 것

### Q1. 위 지연 분해가 맞나

92.5%가 모델 추론이라면 배관 개편으로 얻는 게 7.5%뿐이다.
이 계산에 빠진 것이 있나? 표본이 하나(가벼운 배관 테스트 질문)라는 것 말고,
방법론 자체에 결함이 있나?

### Q2. 🔴 steer가 진행 중인 작업을 어떻게 다루나 — 이게 핵심이다

`turn/steer`로 메시지를 밀어 넣으면:

- **(a)** Codex가 하던 추론·도구 호출을 **이어가면서** 새 입력을 반영하나?
- **(b)** 아니면 현재 작업을 **버리고** 새 입력부터 다시 시작하나?
- 현재 도구 호출(예: 30초짜리 명령)이 실행 중이면 그게 끝난 뒤 반영되나, 즉시인가?

**(b)라면 "턴 겹치기"는 환상이고 오히려 손해다.** 255초 중 200초를 버리는 셈이다.
그러면 배관 개편의 마지막 근거가 사라진다.

이걸 스키마로는 판정하지 못했다. 실제 동작을 아는가?

### Q3. 정말 시간이 줄어드나

Q2가 (a)라 해도, 끼어든 입력을 처리하려면 Codex는 추가로 생각해야 한다.
결국 총 추론 시간은 비슷하고 **벽시계 시간만 겹치는 것** 아닌가?
그렇다면 이득은 "대기가 겹친다"뿐인데, 그게 실제로 유의미한 크기인가?

### Q4. 더 나은 접근이 있나

지연을 줄이는 방법으로 배관 교체 말고 다른 길이 있나?
예를 들어 1턴 요청서를 개선해 되묻기 횟수 자체를 줄이는 쪽,
또는 여러 각도를 병렬 스레드로 동시에 묻는 쪽 등.

---

## 전면 개편의 비용 (판단 재료)

- `send.sh` 2016행. `die` 방어 119곳. lock·heartbeat·변경감지 참조 28곳
- JSON-RPC 양방향(서버→클라이언트 요청 포함)은 bash로 불가 → **node/python 재작성**
- 안전장치 50여 개가 각각 실제 사고에서 나온 것이라 하나씩 다시 세워야 함
  (변경 감지 · EDIT 게이트 · in-flight 복구 · 양방향 잠금 · response_path 검증 등)
- VS Code 확장이 `events.jsonl`(exec `--json` 포맷)을 직접 파싱 중이라
  알림 형식이 바뀌면 진행 패널이 깨진다. 새 파서 모듈이 필요
- 확장은 `extensionKind: "ui"`라 로컬에서만 돈다.
  Remote-SSH 워크스페이스에서는 원격 app-server 소켓에 닿을 수 없다

---

## 직접 열어볼 수 있는 원본

| 무엇 | 경로 |
|---|---|
| 실측한 2턴 이벤트 스트림 (37행) | `D:\OneDrive\바탕 화면\docs\codex_rescue\.log\260825_174748_events.jsonl` |
| 그 실행의 status | `D:\OneDrive\바탕 화면\docs\codex_rescue\.log\260825_174748_status.json` |
| 응답 문서 (frontmatter에 thread_id·turns) | `D:\OneDrive\바탕 화면\docs\codex_rescue\260825_174748_response_thread-smoke.md` |
| 반박서 | `D:\OneDrive\바탕 화면\docs\codex_rescue\260825_174748_followup2_thread-smoke.md` |
| 현재 배관 (2016행) | `C:\Users\bluec\.claude\skills\codex_rescue\send.sh` |
| 스킬 설계·검증 상태표 | `C:\Users\bluec\.claude\skills\codex_rescue\SKILL.md` |
| 확장의 이벤트 파서 | `f:\workspace\Etc Project\VsCode Extentions\claudeContextBar\src\providers\codexRescue\execEvents.ts` |
| 확장의 app-server 사용 예 (이미 동작 중) | `f:\workspace\Etc Project\VsCode Extentions\claudeContextBar\src\providers\codex\usageProvider.ts` |

---

## 참고 — 조사 중 확인된 사실

- `turn/steer`는 실험 기능이 아니다(stable 스키마에 포함)
- app-server 기동·핸드셰이크는 위 `usageProvider.ts`에 이미 구현돼 있고 마켓에서 동작 중
  (`spawn(codex, ['app-server'])` + 줄바꿈 구분 JSON, `Content-Length` 헤더 없음)
- `item/started`·`item/completed` 알림에 `turnId`가 실려 온다
  (exec `--json`에는 없다. 지금 확장은 이것 때문에 멀티턴에서 활동 항목이 덮이는 버그가 있다)
- `codex exec`는 `approval_policy`를 override해도 `never`로 고정된다(실측)
