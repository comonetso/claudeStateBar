---
type: codex_request
mode: readonly
stamp: 260819_150543
slug: phase-decision-order
response_path: docs/codex_rescue/260819_150543_response_phase-decision-order.md
---

# Codex 요청 — 실행 상태 판정 함수의 분기 순서가 맞나

## 🔴 먼저 읽어라 — 이 요청은 의도적으로 아주 작다

**파일을 뒤지지 마라. 명령을 실행하지 마라. 웹을 검색하지 마라.**
판단에 필요한 코드는 아래에 전부 있다. 이 요청서 하나만 보고 답해라.
짧게 답해도 된다. **5분 안에 끝나야 하는 요청이다.**

## 답변을 남길 곳

    docs/codex_rescue/260819_150543_response_phase-decision-order.md

frontmatter를 그대로 넣어라:

    ---
    type: codex_response
    mode: readonly
    stamp: 260819_150543
    slug: phase-decision-order
    author: codex
    ---

쓰기가 막히면 같은 내용을 최종 메시지로 출력해라. 자동 회수된다.
이 파일 외에는 아무것도 만들거나 고치지 마라.

## 배경 (3줄)

VS Code 확장이 `codex exec --json` 실행의 진행 상태를 패널에 표시한다.
입력은 세 가지다 — ① `send.sh`가 쓰는 `status.json`(state 필드) ② 5초마다 갱신되는
`heartbeat` 파일의 mtime ③ 이벤트 스트림에서 관측한 terminal 이벤트.

관련 사실 (0.145.0 실측):
- `turn.completed`는 **Codex turn의 성공**일 뿐, `send.sh`의 후처리(변경 검사·응답 회수·로그 보존) 완료가 아니다.
- 강제 종료(`taskkill`)에는 terminal JSON 이벤트가 **없다**. 그래서 heartbeat가 필요하다.
- `status.json`이 아예 없는 구버전 실행 기록도 존재한다.

## 검토 대상 코드 — 이게 전부다

```typescript
type RunPhase = 'starting' | 'running' | 'finalizing' | 'done' | 'failed' | 'stopped' | 'stale';

/** heartbeat 가 이보다 오래되면 stale. send.sh 는 5초마다 갱신하므로 6배 여유다. */
const STALE_AFTER_MS = 30_000;

function decidePhase(
    status: RunStatus | null,      // status.json 파싱 결과 (없으면 null)
    events: CodexRunState,         // events.terminal: 'none' | 'completed' | 'failed'
    heartbeatMs: number | undefined,   // heartbeat 파일 mtime (없으면 undefined)
    nowMs: number
): { phase: RunPhase; staleForMs?: number } {

    const state = status?.state;

    // ① send.sh 가 끝까지 가서 판정을 남겼다 — 이게 권위다
    if (state === 'done') return { phase: 'done' };
    if (state === 'failed') return { phase: 'failed' };
    if (state === 'interrupted') return { phase: 'stopped' };

    // ② 구버전 실행: status 도 heartbeat 도 없다. 살아있다는 증거가 전무하므로
    //    이벤트 스트림으로 해소하고 절대 "진행 중"으로 남기지 않는다.
    if (!status && heartbeatMs === undefined) {
        if (events.terminal === 'completed') return { phase: 'done' };
        if (events.terminal === 'failed') return { phase: 'failed' };
        return { phase: 'stopped' };
    }

    // ③ 아직 running 을 주장한다 → heartbeat 로 생존을 교차 검증
    const age = heartbeatMs === undefined ? undefined : nowMs - heartbeatMs;
    if (age !== undefined && age > STALE_AFTER_MS) {
        return { phase: 'stale', staleForMs: age };
    }

    // ④ 세부 단계
    if (state === 'finalizing') return { phase: 'finalizing' };
    if (events.terminal !== 'none') return { phase: 'finalizing' };
    if (!events.turnStarted && !events.items.length) return { phase: 'starting' };
    return { phase: 'running' };
}
```

## 내(Claude)가 세운 가설

**가설: ①②③④ 이 순서가 옳다.** 근거는 이렇다.

- ①이 맨 앞인 이유: `send.sh`의 최종 판정은 다른 모든 신호를 이긴다. heartbeat 파일이
  늦게 지워져도 done 을 뒤집으면 안 된다.
- ③이 ④보다 앞인 이유: heartbeat 가 죽었는데 `running` 으로 계속 보여주면 **영원히 도는 것처럼**
  보인다. 죽음 판정이 세부 단계보다 우선해야 한다.
- ④에서 `turn.completed` 를 `done` 이 아니라 `finalizing` 으로 낮춘 이유: 위 배경 참조.

**이 가설이 틀렸을 수 있다. 먼저 이걸 의심해라.**

## 시도했고 확인한 것

- `state: 'failed'` 로 끝난 실제 실행에서 ①이 정상 동작함을 실측했다(`codex_exit: 1`).
- 구버전 기록(status 없음)에서 ②가 `done` 을 정확히 냈다.
- ③(stale)은 **아직 실측하지 못했다.**

## 질문 — 딱 4개다. 짧게 답해라

1. **순서에 논리적 결함이 있나?** 특히 어떤 상태 조합이 잘못된 phase 로 떨어지는지.
2. **③의 위치가 맞나?** heartbeat 검사를 `finalizing` 판정보다 **뒤**로 미뤄야 하는 경우가 있나?
   (예: 후처리가 30초 넘게 걸리는데 heartbeat 는 codex 종료 시 멈춘다 → stale 오판?)
3. `STALE_AFTER_MS = 30초`(갱신 주기 5초의 6배)가 타당한가? 문제가 있다면 왜인지만.
4. ②에서 terminal 이벤트가 없을 때 `stopped` 로 보내는 게 맞나, `failed` 가 맞나?

## 답변 형식

1. `가설 판정` — 동의 / 부분 동의 / 기각 + 한 줄 이유
2. `발견한 결함` — 없으면 "없음". 있으면 상태 조합과 결과를 구체적으로
3. `질문 2·3·4 답변`
4. `수정 제안` — 필요할 때만, 코드로 짧게
5. `확신도`

길게 쓰지 마라. 요점만.
