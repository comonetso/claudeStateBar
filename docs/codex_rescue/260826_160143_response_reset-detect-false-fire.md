---
type: codex_response
mode: readonly
stamp: 260826_160143
slug: reset-detect-false-fire
author: codex-via-stdout
thread_id: 01a03ce2-0d18-7ef0-8953-b8775c4bba57
origin: BluemingPc
turns: 1
---

# Codex 응답 — reset-detect-false-fire

> ⚠️ Codex 가 지정 경로에 직접 저장하지 못해, send.sh 가 최종 메시지를 회수해 저장했다.

## Codex 원문

Q1. **안전하지 않다. 정상 종료 외에도 null이 된다.**

- 필드 누락/null: `readBucket()`이 `resets_at` 누락·null·빈 값을 null로 만든다 (`src/planUsage.ts:203-207`).
- 타입 불일치나 session bucket 부재 시 fallback도 null이 된다 (`src/planUsage.ts:249-266`).
- `/usage` 실패 후 usage 스키마가 없는 JSON endpoint도 성공으로 수락해 null로 정규화한다 (`src/planUsage.ts:293-307`).
- 단, 모든 endpoint의 네트워크·HTTP·JSON 파싱이 실패하면 throw되므로 null 판정까지 가지 않는다 (`src/planUsage.ts:95-109, 301-313`).

따라서 **“값→null이면 종료” 단독 판정은 오탐 가능**하다.

Q2. **안전하지 않다. 캐시 때문에 고정으로 오판한다.**

- 캐시 age가 TTL 이하이면 같은 snapshot을 즉시 반환한다 (`src/providers/codex/usageProvider.ts:81-99, 139-140`).
- 락 대기 중과 락 획득 후에도 같은 캐시를 다시 반환할 수 있다 (`src/providers/codex/usageProvider.ts:162-173`).
- TTL과 poll이 모두 60초여도 타이머 오차와 여러 창의 동시 poll 때문에 cache age가 60초 이하일 수 있다. 따라서 동일 `observedAt/resetsAt`이 반복되어 `cur===prev`가 참이 될 수 있다.

확신도: **높음.** 같은 `observedAt` 캐시는 비교에서 제외해야 한다.

## Claude 검토

두 지적 모두 **채택**. 코드로 직접 확인했고 반박할 지점이 없다.

### Q1 — 채택 (확인 완료)

`src/planUsage.ts:206` 이 결정적이다.

```ts
resetAt: (bucket && bucket.resets_at) || null
```

`resets_at` 누락·빈 문자열이 전부 null 로 접힌다. `fromLimit()` 의 `l?.resets_at ?? null`(261행)도
같다. 그리고 `pick()` 은 **percent 기준으로만** bucket 을 고르므로(263-266행),
**percent 는 정상인데 resetAt 만 null** 인 조합이 성립한다.

→ 내가 세운 "값 → null 전이 = 타이머 종료"는 그 조합을 종료로 오인한다.
오늘 고친 오발사와 **다른 종류의 오발사를 새로 만들 뻔했다.**

### Q2 — 채택 (확인 완료, 이미 배포된 코드의 실제 결함)

`src/providers/codex/usageProvider.ts:139-140` 이 캐시 히트 시 같은 스냅샷을 그대로 반환한다.
락 대기 중(162-163)·락 획득 직후(172-173)에도 같은 경로가 있다.

`refreshCodexUsage()` 가 넘기는 `codexUsageCacheMaxAgeMs` 는 `codexUsageSec * 1000` 이고
폴링 주기도 같은 값(60초)이라, 타이머 오차·여러 창 동시 폴링이면 캐시 히트가 난다.

→ `detectCodexBlockClose()` 의 `cur === prev` 판정이 **캐시가 준 같은 값**을 "고정 = 도는 중"
으로 읽는다. 오판 방향은 **종료를 놓치는 쪽**이라 거짓 발사보다는 낫지만, 발사가 안 나가면
이 기능의 목적(타이머 종료 즉시 다음 타이머 시작) 자체가 무산된다.

→ Codex 권고대로 **같은 `observedAt` 은 비교에서 제외**한다. `CodexUsageSnapshot.observedAt`
이 이미 있으므로 그 값을 globalState 에 함께 저장하고, 직전과 동일하면 판정 없이 반환한다.

### 적용 계획

1. **Codex (즉시)** — `observedAt` 중복 관측 제외. 같은 관측은 새 정보가 아니므로 판정을 건너뛴다.
2. **Claude (설계 재검토)** — `resetAt === null` 단독 판정은 폐기. 응답 자체의 정상성을 함께
   봐야 한다(예: weekly 등 다른 필드가 살아 있는데 session resetAt 만 null 인가). 확정 전에
   실제 데이터로 확인이 필요하다.

### 이번 왕복에 대한 기록

요청서를 과하게 무겁게 썼다. 17MB 전수 대조 요구·엣지 5개·게이트 G1~G6·답변 형식 8항목을
한 번에 얹어 20분/명령 54건/5시간 한도 38%p 를 태웠다. 실제로 결론을 낸 것은 **파일 두 개를
읽고 답한 Q1·Q2 두 문항**이다. 끼어들기로 범위를 줄인 뒤 곧바로 결론이 나왔다.
다음부터 CONSULT 는 **핵심 질문 1~2개 + 지목된 파일**로 던진다.
