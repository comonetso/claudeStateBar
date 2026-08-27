---
type: codex_review
mode: review
stamp: 260827_112905
slug: release-docs-audit
scope: uncommitted
scope_via: prompt
author: codex
---

# Codex 코드 리뷰 — release-docs-audit

- 대상: `uncommitted` (⚠️ 프롬프트 문장으로 지시 — codex CLI 가 스코프 플래그와 집중 지시를 함께 받지 않는다)
- 집중 지시: 이번 변경은 전부 문서다(CHANGELOG.md, README.md, README.ko.md). 커밋되지 않은 변경을 리뷰 대상으로 삼아라. VS Code 마켓플레이스에 배포될 공개 문서이므로 아래 넷을 집중해서 봐라. (1) 사실과 다른 서술: 설정 키 이름·기본값·동작 설명이 실제 코드(src/, package.json contributes.configuration)와 어긋나는 곳. 특히 claudeState.telegramNotifyOnReset 서술이 src/credentials.ts 의 실제 기본값과 맞는지. (2) 영문 README.md 와 한글 README.ko.md 가 서로 어긋나는 곳 — 한쪽에만 있는 설명, 다른 값, 다른 기본값. (3) 처음 읽는 사용자가 헷갈릴 표현·과장·모호한 문장. 실제보다 크게 말하는 곳. (4) CHANGELOG 1.14.0 에 새로 추가된 세 항목(one-second wobble / Remote-SSH home / window left closed)이 실제 코드 동작과 맞는지 — src/extension.ts 의 CODEX_RESETS_AT_TOLERANCE_MS, CODEX_CLOSED_RECOVERY_MS, detectCodexBlockClose, primeNewCodexBlock 과 src/blockPrimer.ts 의 codexBillingHazard, fireCodexPrimer 를 직접 열어 대조해라.
- 실행: `codex exec review` (read-only — Codex 는 코드를 고치지 않았다)

## Codex 원문

추가된 설정 키와 기본값 및 영문·한글 문장은 코드와 일치합니다. 다만 CHANGELOG에 절전 동작을 잘못 설명한 부분이 있고, 새 인증 실패 및 10분 복구 동작이 Marketplace README와 모순되거나 누락되어 있습니다.

Full review comments:

- [P2] 두 README에 auth.json 읽기 실패 동작을 동기화하라 — F:\workspace\EtcProject\VsCodeExtentions\claudeContextBar\CHANGELOG.md:199-199
  이 릴리스 노트는 읽을 수 없는 `auth.json`이 설정을 끄지 않는다고 설명하지만, `README.md:420`과 `README.ko.md:389`는 여전히 읽기 실패 시 자동 시작을 끈다고 서술합니다. 현재 `codexBillingHazard()`는 이를 `unreadable`로 구분하고 `handleCodexPrimerOutcome()`은 설정을 변경하지 않고 반환하므로, 마켓플레이스에 반대 동작이 안내되지 않도록 두 README를 함께 수정해야 합니다.

- [P2] 10분 복구 동작을 두 README에도 문서화하라 — F:\workspace\EtcProject\VsCodeExtentions\claudeContextBar\CHANGELOG.md:209-212
  Codex 자동 시작이 엣지 없이 10분 후 프라이머를 실행하고 닫힌 동안 10분마다 재시도하는 것은 사용자가 반복적인 `codex exec` 실행을 예상해야 하는 동작 변경이지만, 두 Marketplace README에는 기존 엣지 기반 설명만 남아 있습니다. 프로젝트 문서 규칙에 따라 이 조건, 무알림 동작, 재시도 주기를 영문과 한글 README에 함께 반영해야 합니다.

- [P2] 절전을 놓친 엣지의 예로 들지 마라 — F:\workspace\EtcProject\VsCodeExtentions\claudeContextBar\CHANGELOG.md:205-205
  창이 열린 상태로 관측된 뒤 컴퓨터가 절전된 경우에는 `codexWindowWasOpen`이 globalState에 유지되고, 깨어난 뒤 첫 새 관측에서 움직이는 `resetsAt`이 `isCloseEdge = true`를 만들어 기존 엣지 경로가 발사됩니다. 따라서 절전 자체는 엣지를 없애지 않으며, 복구가 필요한 경우는 이미 닫힘으로 기록됐거나 프라이머가 실패한 경우이므로 이 예시는 제거하거나 조건을 한정해야 합니다.

- [P3] 65에 초 단위를 붙여라 — F:\workspace\EtcProject\VsCodeExtentions\claudeContextBar\CHANGELOG.md:179-179
  임계값 설명의 `sixty-five`에는 단위가 없습니다. 코드와 실측값은 65,000ms, 즉 65초이므로 밀리초·초·분 중 무엇인지 모호하지 않게 `sixty-five seconds`로 써야 합니다.

## Claude 검토

**4건 전부 채택.** 오탐 없음. 각각 코드·문서로 대조해 확인했다.

### [P2] auth.json 읽기 실패 동작 — ✅ 채택 (가장 중요)

확인: `README.md:420` = *"When it refuses, the setting is turned off"* ·
`README.ko.md:389` = *"거부하면 설정을 끄고 이유를 알려줍니다"*.

코드는 오늘 정반대로 바뀌었다 — `blockPrimer.ts` 의 `codexBillingHazard()` 가
`{kind:'hazard'|'unreadable'}` 로 나뉘고, `unreadable` 은 `auth-unreadable` outcome 으로 가서
`handleCodexPrimerOutcome()` 이 **설정을 건드리지 않고 return** 한다.

🔴 **마켓플레이스에 나가면 거짓 안내가 된다.** 이 지적이 이번 리뷰의 최대 수확이다.
내가 "오늘 것은 순수 버그 수정이라 README 갱신 불필요"로 판단한 것이 틀렸다 —
**동작이 바뀌면 그 동작을 서술한 기존 문장이 거짓이 된다.** 버그 수정이냐 기능 추가냐가
기준이 아니라, **기존 서술이 여전히 참인가**가 기준이어야 했다.

### [P2] 10분 복구를 README에 — ✅ 채택

`CODEX_CLOSED_RECOVERY_MS = 10 * 60 * 1000` 은 사용자가 관측할 수 있는 **동작 변경**이다.
창이 닫힌 채면 10분마다 `codex exec` 가 실제로 실행된다. 알림이 없으므로 문서에 없으면
사용자는 그 실행을 예상할 방법이 아예 없다. 프로젝트 규칙(CLAUDE.md)도 사용자 인지 모델이
바뀌면 두 README 를 함께 고치라고 못박고 있다.

### [P2] 절전 예시 — ✅ 채택

코드로 반증 시도했으나 지적이 맞았다.

- `credentials.ts:220` — `wasOpen` 은 `ctx.globalState` 에서 읽는다. 절전·재시작을 넘어 유지된다
- `extension.ts:3448` — `isCloseEdge = wasOpen && !isOpen`

즉 **열린 상태로 절전에 들어가면** 깨어난 첫 관측에서 `wasOpen=Y, isOpen=N` 이 되어
**엣지가 정상 발생한다.** 절전은 엣지를 없애지 않는다.

같은 원리가 이미 이 CHANGELOG 안에 클로드 쪽으로 적혀 있었다 —
*"The previous verdict is remembered across the sleep gap"*. 내가 코덱스 쪽 문장을 쓰면서
그 사실과 모순되게 썼다.

실제로 복구가 필요했던 2026-08-27 01:36 사례도 **닫힌 뒤 방치**였지 절전이 원인이 아니었다
(절전 구간은 02:56~05:35 로 그보다 뒤였고, 그때는 이미 `wasOpen=N` 이었다).

### [P3] 단위 누락 — ✅ 채택

`sixty-five` → `sixty-five seconds`. 실측값 65,000ms 기준.

### 적용

네 건 모두 반영한다. P2 세 건은 마켓 배포 **전에 반드시** 고쳐야 하는 것이고,
P3 은 같은 문단이라 함께 고친다.