---
type: codex_response
mode: readonly
stamp: 260819_150543
slug: phase-decision-order
author: codex-via-stdout
---

# Codex 응답 — phase-decision-order

> ⚠️ Codex 가 지정 경로에 직접 저장하지 못해, send.sh 가 최종 메시지를 회수해 저장했다.

## Codex 원문

---
type: codex_response
mode: readonly
stamp: 260819_150543
slug: phase-decision-order
author: codex
---

## 1. 가설 판정

**부분 동의.** ①→③→④는 heartbeat가 `send.sh`의 후처리까지 계속 갱신된다는 조건에서 맞다. 다만 현재 코드는 `status`는 있지만 heartbeat가 없는 현대 실행을 처리하지 못한다.

## 2. 발견한 결함

- `status.state`가 `starting`/`running`/`finalizing`이고 `heartbeatMs === undefined`인 조합은 stale 검사를 건너뛴다. 강제 종료가 첫 heartbeat 생성 전 일어났거나 heartbeat가 유실되면 각각 `starting`/`running`/`finalizing`으로 영구 잔류할 수 있다.
- heartbeat가 Codex 종료 시 멈추고 후처리가 30초를 넘는 구조라면 `state === 'finalizing'`이어도 ③에서 `stale`로 잘못 판정한다.

## 3. 질문 2·3·4 답변

2. **현재 위치가 조건부로 맞다.** heartbeat가 `send.sh` 전체 생명주기를 덮는다면 ③을 뒤로 미루면 안 된다. 실제로 finalizing 중 강제 종료된 실행을 영구 `finalizing`으로 남기기 때문이다. 반대로 heartbeat가 Codex 프로세스까지만 덮는다면 현재 위치는 오판하므로, 순서 변경보다 heartbeat를 최종 status 기록 직전까지 갱신하는 것이 맞다.
3. **30초는 합리적인 휴리스틱이지만 절대 판정값은 아니다.** 5초 주기에서 6회 누락 여유는 충분한 편이나 시스템 절전·일시 정지, 파일시스템 지연, 시계 보정에는 정상 실행도 stale이 될 수 있다. 가능하면 프로세스 생존 확인 또는 연속 관측으로 보강해야 한다.
4. **`failed`보다 `stopped`가 맞다.** terminal 이벤트도 종료 판정도 없으므로 실패라고 단정할 근거가 없다. 의미를 엄밀히 하려면 장래에 `unknown`/`abandoned`가 더 정확하다.

## 4. 수정 제안

heartbeat의 계약을 “`send.sh` 시작부터 최종 `status.json` 기록까지 갱신”으로 고정한다. 또한 heartbeat 미생성 상태에는 `status`의 시작/갱신 시각을 이용한 별도 유예 만료가 필요하다. 현재 함수 인자만으로는 “아직 첫 heartbeat 전”과 “heartbeat 없이 죽음”을 구별할 수 없다.

## 5. 확신도

**높음.** 다만 ③의 최종 타당성은 heartbeat 갱신 프로세스가 후처리 동안 실제로 살아 있는지에 달려 있다.

---

## Claude 검토

작성: 2026-08-19 · 검토자: Claude (Opus 5)

### 판정: 두 결함 모두 **채택**. 실제 버그였다.

Codex 가 "heartbeat 가 후처리 동안 살아 있는지에 달려 있다"고 단 조건이 정확히 급소였다.
당시 `send.sh` 는 **codex 종료 직후 heartbeat 를 죽이고** `finalizing` 으로 넘어갔다.

```bash
kill "$HB_PID" 2>/dev/null; HB_PID=""      # ← 여기서 끊고
write_status finalizing null "$RC" "$TEE_RC"
# 이 아래로 전체 파일 스캔 2회 + 해시 + 로그 복사가 남아 있었다
```

즉 Codex 가 가정한 나쁜 쪽("heartbeat 가 Codex 프로세스까지만 덮는다")이 실제 구현이었고,
후처리가 30초를 넘기면 **멀쩡히 도는 실행이 `stale` 로 오판**되는 상태였다.

Codex 의 권고대로 **순서 변경이 아니라 heartbeat 수명 연장**으로 고쳤다 — 판정 로직 ①②③④ 순서는
그대로 두고, heartbeat 의 계약을 "codex 가 살아있다" → **"send.sh 가 살아있다"** 로 바꿨다.

### 적용한 수정

| # | 파일 | 내용 |
|---|---|---|
| 1 | `send.sh` | heartbeat 를 `write_status running` **이전에** 생성. "status=live 인데 heartbeat 없음"이라는 판정 불가 구간을 없앤다 |
| 2 | `send.sh` | codex 종료 시 heartbeat 를 죽이지 않는다. **최종 status 기록 직전**까지 유지 |
| 3 | `runDiscovery.ts` | 수정 1 덕분에 "status live + heartbeat 없음"이 비정상으로 확정되므로 `stale` 로 판정. 기존에는 이 조합이 stale 검사를 통과해 **영구 `running`** 으로 남았다 |

### 질문별 반영

- **Q2 (③의 위치)** — 위치는 유지. Codex 말대로 뒤로 미루면 finalizing 중 강제 종료된 실행이
  영구 `finalizing` 이 된다. 문제는 위치가 아니라 heartbeat 수명이었다.
- **Q3 (30초)** — 유지. "절대 판정값이 아니다"라는 단서는 동의하나, 임의로 값을 바꿀 근거가 없다.
  참고로 이 프로젝트의 변경 감지 스캔은 **실측 0.058초**(178파일), calltaxi 도 0.051초(829파일)라
  일반적인 로컬 디스크에서는 30초 초과가 일어나지 않는다. 그럼에도 수정 2를 넣은 이유는
  느린 네트워크 드라이브·동기화 폴더에서 보장이 없고, 수정 비용이 사실상 0이기 때문이다.
- **Q4 (`stopped` vs `failed`)** — `stopped` 유지. Codex 판단에 동의한다.
  `unknown`/`abandoned` 제안은 **보류** — 상태를 하나 더 늘릴 만큼의 이득이 지금은 없다.

### 별건 — 이 답변이 간접적으로 잡아낸 표시 버그

Codex 가 이전 응답(`260819_140840`)에서 *"`error` 는 경고·deprecated·비치명 오류가 completed item
으로 들어올 수 있다"* 고 적었는데, 나는 그 문장을 읽고도 파서에 반영하지 않고 `error` item 을
전부 `failed`(빨간 점)로 칠했다. 그 결과 정상 실행 2건이 패널 맨 위에 붉은 오류를 달고 나타났고
사용자가 "코덱스가 오류난 건가?"라고 물었다. 실제 내용은 CLI 안내였다.

```
clamping SessionEnd hook timeout to 3s in ...
Skill descriptions were shortened to fit the 2% skills context budget ...
```

→ `ItemStatus` 에 `warn` 을 추가하고 `error` item 을 그쪽으로 내렸다. 라벨도 `오류`→`알림`
(`error`→`notice`)로 바꿨다. 진짜 실패는 `turn.failed`·명령 `exit_code`·`file_change.status`
로 계속 잡힌다. 회귀 확인: 기존 3건에서 실패로 남아야 할 항목은 그대로 실패로 남았다.

