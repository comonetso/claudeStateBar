---
type: codex_request
mode: readonly
stamp: 260826_160143
slug: reset-detect-false-fire
subject: 리셋 오발사 판정 기준
response_path: docs/codex_rescue/260826_160143_response_reset-detect-false-fire.md
---

# Codex 요청 — 5시간 타이머 "종료" 판정이 오발사를 낸다. 새 판정 기준이 견고한가

## 이 요청의 성격 — 독립 조사 위임

나(Claude)는 이 문제에서 막혔다. 너에게 **이 사건을 직접 조사해 달라**고 부탁한다.

이 문서는 사건 개요서지 정답의 범위가 아니다. 내가 정리한 자료 안에서만 답을 찾을 이유가 없다 —
**나는 이미 그 안에서 답을 못 찾았고, 오늘 하루에만 판정 기준을 두 번 틀렸다.**
아래에 원본 경로를 적어 두었으니 **직접 열어서 네 방법으로 다시 봐라.**

- **원본이 내 요약과 충돌하면 원본이 이긴다.**
- 내 가설은 검토 대상일 뿐 **분석의 출발점도 경계도 아니다.**
- 필요한 계산·정렬·파싱은 직접 실행해라. 산출물은 `docs/codex_rescue/.scratch/` 에
  마음껏 만들어라 — 개수·크기 제한 없고 지우지 않아도 된다.

## 이 기능이 무엇이고 왜 정확해야 하나

VS Code 확장(claudeStateBar)이 Claude(claude.ai usage API)와 Codex(codex app-server
`account/rateLimits/read`)의 **5시간 사용 한도 타이머**를 폴링한다.

타이머의 성질이 이 기능의 전부다:

- 타이머는 **첫 요청을 보낸 시점부터** 5시간이다. 고정 시간표로 자동 순환하지 **않는다.**
- 5시간이 지나면 사용량이 0%로 초기화되고, **다음 요청을 보낼 때까지 멈춰 있다.**
- 멈춰 있는 동안 흐른 시간은 **버려진다.** 새벽 4시에 끝나고 아침 9시에 앉으면 그 5시간은 사라진다.

그래서 확장은 **타이머가 멈춘 순간을 감지해서** ① 텔레그램 알림을 보내고 ② 더미 프롬프트
(`claude -p` / `codex exec`)를 발사해 다음 타이머를 즉시 시작시킨다. 자는 동안 타이머가 돌게 해서
하루에 쓸 수 있는 타이머 개수를 늘리는 것이 목적이다.

**따라서 "지금 타이머가 멈춰 있는가"를 틀리면 기능 전체가 무의미해진다.**
멈춘 걸 못 잡으면 5시간이 통째로 날아가고, 안 멈췄는데 발사하면 거짓 알림 + 헛프롬프트다.

## 사용자가 직접 관측한 것 ← 코드·로그 어디에도 없다

아래는 **사용자가 자기 눈으로 화면을 보고 말한 것**을 원문 그대로 옮긴 것이다.
내 해석도 가설도 섞이지 않았다.

> "지금 Claude 같은 경우는 텔레그램이 발송되는 순간 1시간 몇 분이 남았고 거의 3시간 몇 분이
> 지났단 말이야. 그럼 이미 서버 쪽에서 Claude Pro로 발송이 돼서 타이머가 리셋되고 다시
> 돌아갔다는 의미인데, 그렇다면 텔레그램을 쏘면 안 되지."

> "실제 사용량이나 지금 현재 어떤 상태인지를 제대로 알고 쏴야 하는데, 지금 이 확장
> 프로그램에서는 그렇지 않고 그냥 무조건 쏴버리는 것 같아."

> "내가 원하는 거는 실제로 현재 Claude하고 코덱스 상태를 확인해서 쏴야 되는 상황인지 아닌지를
> 정확하게 파악하는 거야. 그걸 파악한 후에 쏘고 리셋, 그러니까 텔레그램도 쏘고 커맨드도
> 날려야 된다는 이야기지."

> "아까는 텔레그램만 발사가 되고 커맨드가 발사가 안 되니까 시작이 안 됐던 거잖아."

- 관측 조건: 2026-08-26 15:03경, 로컬 PC(Windows 11)가 절전에서 깨어난 직후.
  텔레그램 알림과 VS Code 상태바 툴팁을 같은 시각에 대조해서 확인.
- 🔴 **사용자가 이미 확인해 준 사실:** 이 계정은 **서버 4대에서도 `claude -p` 가 크론으로 돈다.**
  즉 로컬이 자는 동안 **다른 머신이 Claude 타이머를 켤 수 있다.** Codex 는 그런 스케줄이 없다.
- 아직 확인하지 못한 것: 서버 크론의 정확한 실행 시각표.

## 계측치와의 대조

- 계측(확장이 본 값): `session=0%` → 코드는 이것을 "타이머가 멈췄다"로 판정하고 발사했다.
- 실제 상태: 타이머는 **12:00~17:00으로 돌고 있었다.** 3시간 3분 경과, 1시간 57분 남음.
- 🔴 **어긋난 이유는 명백해 보인다** — 타이머가 돌고 있어도 아무도 안 쓰면 사용률은 0%다.
  `0%` 는 "멈춤"과 "돌지만 미사용"을 구분하지 못한다.
  다만 **내가 이 결론에 이르는 과정에서 같은 종류의 오독을 두 번 했으므로**(아래 실패 이력),
  이번 결론도 검증 없이 믿지 말아 달라.

## 대표 사례와 대조군

전부 `diag.log` 에 있다. 타임스탬프는 **UTC**이고 KST는 +9다.

**문제 사례(오발사) — 2026-08-26T06:03Z (KST 15:03)**

```
06:03:40.886Z codex-block-closed prevPct=0 curPct=0 woke=true event=w1787742219000 autoStart=false
06:03:52.258Z poll resetAt=2026-08-26T08:00:00.099609+00:00 future=Y session=0%
06:03:52.260Z block-closed prevPct=8 curPct=0 woke=true event=2979540 autoStart=true
06:04:03.685Z primer-outcome=fired detail=claude -p exited 0, replied: ok
06:04:19.052Z poll resetAt=2026-08-26T07:59:59.874697+00:00 future=Y session=1%
06:04:19.068Z primer-verified resetAt=2026-08-26T07:59:59.874697+00:00 (block open ~5h)
```

- Claude: `resetAt` 이 **null 이 아니라 08:00Z(KST 17:00)를 가리키고 있었다.** 그런데 발사됐다.
- Codex: `prevPct=0 curPct=0` — **아무 변화가 없는데** `woke=true` 만으로 발사됐다.
- `primer-verified` 가 통과했지만, 프라이머 발사 전후로 `resetAt` 이 **08:00Z 그대로다.**
  새 타이머를 연 게 아니라 이미 도는 타이머에 프롬프트를 하나 던진 것이다.

**정상 대조군(진짜 종료) — 2026-08-25T14:19~14:20Z (KST 23:19~23:20)**

```
14:19:56.930Z poll resetAt=2026-08-25T14:19:59.854575+00:00 future=Y session=87%
14:20:01.966Z poll resetAt=null                              future=N session=0%
14:20:01.967Z block-closed prevPct=87 curPct=0 woke=false event=2979446 autoStart=true
14:20:06.155Z primer-outcome=fired detail=claude -p exited 0, replied: ok
14:20:20.796Z poll resetAt=2026-08-25T19:19:59.712428+00:00 future=Y session=0%
14:20:21.485Z primer-verified resetAt=2026-08-25T19:20:00.398144+00:00 (block open ~5h)
```

- 진짜 종료 순간에는 **`resetAt=null` 이 한 번 찍힌다.**
- 발사 후 `resetAt` 이 19:19Z(정확히 5시간 뒤)로 **점프**했다. 이게 진짜로 열린 경우다.

두 사례를 대조하면 **`session=0%` 는 양쪽에 다 있고, `resetAt=null` 은 진짜 종료에만 있다.**

## 지금 바로 열 수 있는 원본 ← 요구하지 말고 열어라

아래는 **지금 이 순간 실재하는 파일이다.** 읽기 전용으로 직접 열어서 조사해라.

| 무엇 | 절대경로 / 접근 명령 | 왜 중요한가 |
|---|---|---|
| 진단 로그 (17MB, 약 18만 줄) | `C:\Users\bluec\AppData\Local\Temp\claudeStateBar-primer\diag.log` | **모든 폴링 결과와 발사 기록의 원본.** 며칠치가 쌓여 있다 |
| 감지·발사·검증 본체 | `src/extension.ts` | `detectBlockClose` · `detectCodexBlockClose` · `refreshPlanUsage` · `refreshCodexUsage` · `handlePrimerOutcome` · `handleCodexPrimerOutcome` |
| Claude usage 정규화 | `src/planUsage.ts` | `sessionResetAt` 이 **어떤 경로로 null 이 되는가** — 3번 질문의 핵심 |
| Codex 한도 조회 | `src/providers/codex/usageProvider.ts` | `readAppServerWindow` · `readCachedWindow` · `fetchSharedCodexRateLimits` 의 캐시 |
| 발사·락 | `src/blockPrimer.ts` | `firePrimer` · `fireCodexPrimer` · `claimResetEvent` · `sweepStaleLocks` |
| 이벤트 락 잔해 | `C:\Users\bluec\AppData\Local\Temp\claudeStateBar-primer\*.lock` | 실제로 몇 번 claim 됐는지 |

`diag.log` 유용한 조회 예시(직접 더 좋은 걸 짜도 된다):

```bash
# 발사 기록만
grep -n "block-closed\|primer-outcome\|primer-verified\|primer-unverified" \
  "/c/Users/bluec/AppData/Local/Temp/claudeStateBar-primer/diag.log"

# resetAt=null 이 찍힌 지점 전부 — 진짜 종료가 몇 번 있었나
grep -n "resetAt=null" "/c/Users/bluec/AppData/Local/Temp/claudeStateBar-primer/diag.log"

# 특정 발사 전후 맥락
sed -n '176650,176680p' "/c/Users/bluec/AppData/Local/Temp/claudeStateBar-primer/diag.log"
```

- 🔴 **위 표에 있는 것을 "제공해 달라"고 답변에 적지 마라.** 이미 열 수 있다.
- 🔴 **`ls`·`find` 로 목록만 확인한 것은 연 것이 아니다.**
- 계산·집계가 필요하면 직접 해라. `.scratch/` 안에서 자유롭게.

## 먼저 할 것 — 추론보다 관측이 앞선다

1. 위 표의 원본을 **실제로 열어라.** 특히 `diag.log` 에서 `resetAt=null` 의 출현 패턴과
   `block-closed` 발사 지점을 **전부** 뽑아 대조해라. 며칠치가 있으니 표본이 충분하다.
2. 문제 사례와 정상 대조군을 **같은 방법으로** 대조해라.
3. 🔴 **`사용자가 직접 관측한 것` 이 설명되기 전에는 수정안을 쓰지 마라.**

## 환경

- TypeScript / VS Code Extension API. `tsc -p ./` → `out/`. 테스트 코드 없음.
- Windows 11, Node 22. 확장 버전 1.14.0.
- Claude usage: claude.ai 내부 API(세션키 인증). 폴링 주기 `claudeState.refreshIntervalSec` = **30초**.
- Codex usage: `codex app-server` 를 spawn 해서 `account/rateLimits/read` JSON-RPC.
  폴링 주기는 `Math.max(60, refreshIntervalSec)` = **60초**. 여러 창이 공유하는 파일 캐시가 있다.
- **여러 VS Code 창이 동시에 뜬다** (사용자는 상시 여러 창 사용). globalState 는 머신 전역 공유.
- 로컬 PC는 자주 절전/복귀한다.

## 문제 — 증상

1. **거짓 발사** — 타이머가 돌고 있는데 "종료됐다"고 판정해 텔레그램 + 헛프롬프트를 냈다.
2. **검증 무력화** — `primer-verified` 가 아무것도 검증하지 못하고 통과했다.
3. Codex 쪽은 `prevPct=0 curPct=0`, 즉 **관측값에 아무 변화가 없는데도** 발사됐다.

## 현재 코드

`src/extension.ts` — Claude 측 (오늘 오발사를 낸 그대로. 아직 안 고쳤다)

```ts
async function detectBlockClose(n: NormalizedUsage) {
    const now = Date.now();
    const gap = lastBlockPollAt ? now - lastBlockPollAt : 0;
    const wokeGapMs = Math.max(WAKE_GAP_MS, creds.getRefreshIntervalSec() * 3 * 1000);
    const wokeFromSleep = lastBlockPollAt !== 0 && gap > wokeGapMs;
    lastBlockPollAt = now;

    const prevPct = creds.getLastSessionPercent();
    const curPct = n.sessionPercent;

    const justClosed = prevPct != null && prevPct > 0 && curPct === 0;
    const wokeClosed = wokeFromSleep && curPct === 0;

    if (justClosed || wokeClosed) {
        const eventKey = String(Math.floor(now / (10 * 60 * 1000)));
        if (blockPrimer.claimResetEvent(eventKey, log)) {
            /* 텔레그램 + primeNewBlock() */
        }
    }
    await creds.setLastSessionPercent(curPct);
}
```

같은 파일의 검증부:

```ts
const BLOCK_OPEN_MAX_MS = 6 * 60 * 60 * 1000;
// ...
if (Number.isFinite(afterMs) && afterMs > Date.now() && afterMs <= Date.now() + BLOCK_OPEN_MAX_MS) {
    blockPrimer.appendDiag(`primer-verified resetAt=${after} (block open ~5h)`);
    return;
}
```

🔴 **코드 주석에 이렇게 적혀 있는데 실측과 반대다** — 이게 내가 오늘 판정을 두 번 틀린 뿌리다:

```ts
// Detect a block CLOSE — active session usage falling to 0%. That is the only reliable signal that
// the 5-hour block ended and a fresh one can be opened. sessionResetAt is NOT usable: it stays in
// the future even when the block is closed (it points at midnight/next-day when idle), which is why
// the old reset-time detection never actually primed.
```

**이 주석이 옳은가, 내 실측이 옳은가.** `diag.log` 로 판정해 달라. 주석이 옳다면 내 새 기준은
통째로 무너진다. 주석이 특정 조건에서만 옳다면 그 조건이 무엇인지가 핵심이다.

Codex 측은 내가 이미 아래로 고쳤다(`src/extension.ts`, 컴파일만 통과. 실전 미검증):

```ts
async function detectCodexBlockClose(snap: CodexUsageSnapshot) {
    const primary = snap.primary;
    if (!primary || primary.resetsAt == null) return;

    const cur = primary.resetsAt;
    const prev = creds.getLastCodexResetsAt();
    await creds.setLastCodexResetsAt(cur);
    if (prev == null) return;

    const isOpen = cur === prev;
    const wasOpen = creds.getCodexWindowWasOpen();
    await creds.setCodexWindowWasOpen(isOpen);

    if (!wasOpen || isOpen) return;   // 도는중 → 멈춤 전이에서만

    const eventKey = String(Math.floor(Date.now() / (10 * 60 * 1000)));
    if (!blockPrimer.claimResetEvent(eventKey, log, 'codex')) return;
    /* 텔레그램 + primeNewCodexBlock() */
}
```

## 내(Claude)가 세운 가설 ← 증거가 아니다. 검토 대상일 뿐이다

**Claude**: 타이머가 멈추면 `sessionResetAt` 이 `null` 이 된다. 그러니
"값이 있다가 null 이 되는 전이"로 판정하면 된다. 사용률은 보지 않는다.

**Codex**: `null` 이 오지 않는다. 대신 멈춤이면 `resetsAt` 이 매 폴링 "지금+300분"으로 따라오고
(15:03→20:03, 15:16→20:16), 돌고 있으면 고정된다(15:35:35→20:34:34, 15:36:21→20:34:34, 이동폭 0초).
그러니 "직전 관측값과 같으면 도는 중"으로 판정한다.

🔴 **이건 증거가 아니라 해석이다. 틀렸으면 버려라.**
특히 **Codex 쪽 관측은 표본이 너무 적다** — 멈춤 2점, 도는중 2점이 전부이고, 도는중 2점은
45초 간격이다. 45초 동안 안 움직였다고 "고정"이라 단정할 근거가 되는지 나는 확신이 없다.

## 실패 이력 — 무엇이 죽었고 무엇이 살아 있나

| 분류 | 내용 | 그 원본을 다시 봐도 되나 |
|---|---|---|
| ① 가설이 반증됨 | "사용률 0% = 타이머 멈춤" | 오늘 오발사로 반증. **반복 금지** |
| ① 가설이 반증됨 | 🔴 **"Codex 는 멈추면 resetsAt 이 과거에 남는다"** — 내가 05:28에 관측한 `resetsAt=10:13` 을 **과거로 잘못 읽었다.** 당시 시각이 05:28이니 미래였다. 이 오독 위에 "resetsAt 을 이벤트 락 키로 쓰면 중복 발사가 막힌다"는 설계를 세웠고, 값이 매 폴링 바뀌므로 **락이 통째로 무효**였다 | — 폐기. **다만 내가 같은 종류의 시각 오독을 반복했다는 사실 자체를 감안해서 봐라** |
| ② 데이터는 유효한데 분석법이 실패 | `diag.log` 를 `tail`·부분 `sed` 로만 봤다. 며칠치 전수 대조를 안 했다 | ✅ **로그는 살아 있다. 전수로 다시 분석해라** |
| ③ 자료 부족 | Codex 의 "도는 중" 상태 표본이 45초 간격 2점뿐 | ✅ 더 나은 판별법이 있으면 제시해라 |

## 완료 게이트 — 무엇이 설명돼야 "풀렸다"고 할 수 있나

- G1 오발사의 **인과 경로** — 어떤 값이 어떤 분기를 타서 발사에 이르렀는지 코드로 이어지는가
- G2 **조건 특이성** — 왜 15:03에는 났고 어제 23:20에는 정상이었나
- G3 **과거 실패의 설명** — 코드 주석("sessionResetAt은 못 쓴다")이 왜 쓰여졌는지,
  그 저자가 본 현상이 무엇이었는지 같은 원인으로 설명되는가.
  **null 이 안 오는 조건이 실재한다면 내 새 기준은 그 조건에서 죽는다**
- G4 **반증 가능한 예측** — 로그에서 확인 가능한 형태로
- G5 수정안이 인과의 **어느 고리를 끊는지** 명시
- G6 남은 불확실성 열거

🔴 **특히 아래가 반드시 설명돼야 한다:**
- 15:03 발사에서 `resetAt` 이 살아 있었는데도 발사된 경로
- `primer-verified` 가 아무 변화 없이 통과한 경로
- Codex 의 `prevPct=0 curPct=0` 발사 경로

**G3 가 핵심 판별식이다.**

## 되물을 수 있다 — 이건 단발이 아니다

네 답변을 내가 검토한 뒤 다시 물을 수 있다. 확신이 없는 부분을 감추지 마라.

## 요청 — 조사를 부탁한다

1. **원본부터 직접 열어봐.** 특히 `diag.log` 전수 대조.
2. **질문 1** — 내 두 판정 기준(Claude=null 전이, Codex=값 고정 여부)이 견고한가.
   `diag.log` 에서 각각의 반례를 찾아봐라.
3. **질문 2** — 놓친 엣지 케이스. 최소 이것들:
   - 여러 VS Code 창이 30초/60초로 동시 폴링. globalState 공유. 경쟁 상태.
   - **절전 중 다른 머신(서버 크론)이 Claude 타이머를 켰다.** 깨어나면 어떻게 보이나.
   - **API 일시 실패·필드 누락으로 null 이 오는 경우** — 진짜 종료와 구분 가능한가.
     이게 내 Claude 기준의 가장 큰 약점이라고 스스로 의심한다.
   - Codex: 폴링(60초)보다 짧은 시간에 타이머가 끝나고 새로 시작되면.
   - Codex: `fetchSharedCodexRateLimits` 의 파일 캐시가 같은 스냅샷을 반복해 주면
     "값이 고정"으로 오판하지 않나. **이건 캐시 코드를 직접 읽고 판단해 달라.**
4. **질문 3** — `planUsage.ts` 에서 `sessionResetAt` 이 null 이 되는 **모든 경로**를 열거해라.
   정상 종료 외에 파싱 실패·필드명 변경·타입 불일치로도 null 이 되나.
5. **질문 4** — 발사 판정과 프라이머 성공 검증에 각각 어떤 신호를 쓰는 게 맞나.
   특히 검증: Claude 는 `resetAt` 이 null→미래로 점프하는 것으로 되는가.
   Codex 는 무엇으로 하나(값 고정 확인이 유일한가, 더 나은 게 있나).
6. 수정 방법을 before/after 로. 적용은 내가 한다.
7. **확신도** — 추측과 확인을 구분해서.

## 답변 형식

1. `내가 직접 연 원본` — 어떤 파일을 **어떤 명령으로** 열었고 무엇이 나왔나. 비워두지 마라.
2. `사용자 관측 증상에 대한 설명` — 위 관측 각 항목이 설명되나.
3. `네가 보는 근본 원인`
4. `내 가설에 대한 판정` — 두 기준 각각 동의/부분동의/기각 + 이유. **짧게.**
5. `수정 방법 (before → after)` · `대안 비교와 추천` · `함정·주의점`
6. `완료 게이트 자기판정` — G1~G6 각각 충족/미충족 + 한 줄 근거
7. `확신도와 남은 불확실성`
8. `이 머신에서 접근 불가한 자료` — 없으면 "없음"

## 작업 규칙

- **프로덕션 파일을 고치지 마라.** 소스·설정은 읽기만.
- 쓸 수 있는 곳은 응답 문서와 `docs/codex_rescue/.scratch/` 둘뿐이다.
- 디스크 읽기는 자유. 네트워크는 조회 전용.

## 응답 저장 위치

아래 경로에 그 이름 그대로 저장해라.

    docs/codex_rescue/260826_160143_response_reset-detect-false-fire.md

frontmatter를 그대로 넣어라:

    ---
    type: codex_response
    mode: readonly
    stamp: 260826_160143
    slug: reset-detect-false-fire
    author: codex
    ---

쓰기가 막히면 같은 내용을 최종 메시지로 그대로 출력해라. 자동 회수된다.
