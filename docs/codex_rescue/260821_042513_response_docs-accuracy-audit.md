---
type: codex_response
mode: readonly
stamp: 260821_042513
slug: docs-accuracy-audit
author: codex
---

# 문서·실제동작 대조 감사

## 1. 내 가설에 대한 판정

**기각.** 방금 고친 세 항목이 전부는 아니다.

- `CR_WIN_SANDBOX` 추가와 `CR_TIMEOUT` 거부 설명은 `send.sh:14-24, 428-452`와 일치한다.
- Remote-SSH 패널 지원은 현재 `vscode.workspace.fs` 구현(`src/providers/codexRescue/runDiscovery.ts:9-15, 169-188`)과 `v1.9.2` 태그의 도입 이력에 부합한다.
- REVIEW `--base`/`--commit`을 미실측으로 남긴 판단도 타당하다. 플래그 조립 코드는 있지만(`send.sh:389-403`) 실제 범위가 맞았는지를 검증한 기록은 제공 자료에 없다.
- 그러나 네 문서에는 그 세 건과 별개로 확인 가능한 오류·과장·모호성이 남아 있다. 특히 REVIEW의 권한/파일 작성 주체, 완료음 조건, 1.9.3의 “전문” 표시 범위, 자동 블록 시작 시각, 네트워크 호출 설명은 사용자의 안전·기대에 직접 영향을 준다.

반대로 다음 항목은 전수 대조에서 맞는 것으로 확인했다.

- 파일 규약 `_request_` / `_response_` / `_review_`와 `.log/<stamp>_{events,status,heartbeat,last_message,stderr}` 계열은 `send.sh:74-82, 150-169, 243-275, 602-627` 및 `SKILL.md:151-164`와 맞다.
- 환경변수 5종 `CR_MODEL`, `CR_SANDBOX`, `CR_ALLOW_EDIT`, `CR_DRYRUN`, `CR_WIN_SANDBOX`와 제거된 `CR_TIMEOUT` 설명은 맞다. 단 `CR_DRYRUN`의 부수효과는 문서에 빠져 있다(아래 지적 13).
- 공개 상태 표기 `starting/running/finalizing/done/failed/stopped/no response(응답 없음)`는 내부 `stale`을 UI에서 `no response/응답 없음`으로 번역하는 구조까지 포함해 맞다(`runDiscovery.ts:43, 236-272`, `src/i18n.ts:179-185, 439-445`).
- `claudeContextBar.workflowCompleteBeep`, `claudeContextBar.codexRunAutoCleanup`, `claudeContextBar.codexRunRetentionDays`, `claudeContextBar.codexRunDeleteDocs`의 실제 키와 기본값은 `package.json:362-365, 396-411`에서 확인된다.
- 자동 정리 기본 7일, 활성화당 1회, terminal이 아니거나 lock이 남은 실행은 건드리지 않는다는 설명은 `extension.ts:690-711`, `runDiscovery.ts:470-559`와 맞다.
- live 상태/완료음 2초 폴링과 원격 이벤트 본문 최소 5초 간격은 `extension.ts:2797-2815`, `runDiscovery.ts:120-131, 177-188`과 맞다.

## 2. 사실과 어긋나는 서술

### 2-1. REVIEW까지 `workspace-write`로 실행되고 Codex가 응답 파일을 쓴다는 설명

- **위치·현재 문구**
  - `docs/codex-rescue-guide.md:39-48`: “The skill runs `codex exec` with `-s workspace-write`”, 기본 consult/review에서 Codex가 response 문서 한 개를 쓴다고 설명
  - `docs/codex-rescue-guide.ko.md:38-44`: 같은 의미
  - `README.md:169`, `README.ko.md:169`: 스킬 전체를 “write access to your workspace”로 설명
- **무엇이 틀렸나**: CONSULT/EDIT 요청서 경로만 기본 `workspace-write`다. REVIEW는 `codex exec review`이며 CLI가 read-only로 고정되고 `-s`도 받지 않는다. Codex가 review 문서를 쓰는 것도 아니다. Codex의 `-o` 결과를 받은 뒤 **`send.sh`가** `_review_*.md`를 작성한다.
- **근거**: `skills/codex_rescue/send.sh:389-406, 544-573`, `skills/codex_rescue/SKILL.md:159-161, 173-200`
- **수정 방법**: “CONSULT/EDIT는 기본 `workspace-write`; REVIEW는 CLI 고정 read-only이며 결과 문서는 send.sh가 쓴다”로 모드별 분리. README의 짧은 소개도 “request-based runs default to workspace-write”로 한정한다.
- **위험도**: **높음** — 설치 전 권한 고지와 안전 모델 자체가 다르게 전달된다.
- **확신도**: **높음** — 실행 인자와 파일 작성 코드 직접 확인.

### 2-2. 자동 정리 설정 키의 접두사 누락

- **위치·현재 문구**: `docs/codex-rescue-guide.md:135`, `docs/codex-rescue-guide.ko.md:127`의 ``codexRunAutoCleanup``.
- **무엇이 틀렸나**: 실제 키는 `claudeContextBar.codexRunAutoCleanup`이다.
- **근거**: `package.json:396-400`, `src/extension.ts:693-699`
- **수정 방법**: 두 가이드 모두 전체 키로 교체한다. `codexRunRetentionDays`, `codexRunDeleteDocs`도 같은 문단에서 함께 링크하거나 명시하면 정리 정책이 완결된다.
- **위험도**: **높음** — 사용자가 존재하지 않는 키를 그대로 settings.json에 넣을 수 있다.
- **확신도**: **높음**.

### 2-3. 1.9.3 패널이 메시지·명령 “전문/실제 실행형 전체”를 보여준다는 절대 표현

- **위치·현재 문구**: `README.md:175`의 “Nothing cut off for good”, “whole message”, “form that actually ran”; `README.ko.md:175`의 “말은 전문”, “명령은 실제로 실행된 형태”.
- **무엇이 틀렸나**: 펼침 UI 자체와 한 번에 한 행만 여는 아코디언은 맞다. 하지만 파서는 message/reasoning/error 본문을 최대 **4,000자**로 자르고, command raw를 최대 **600자**로 자르며 공백도 한 줄로 정규화한다. 따라서 긴 메시지·멀티라인 명령의 진짜 전문은 패널에 없다. 원본은 `_events.jsonl`에서 봐야 한다.
- **근거**: `src/providers/codexRescue/execEvents.ts:90-95, 123-129, 190-209`, `src/codexRescuePanel.ts:257-269, 430-451, 571-584`
- **수정 방법**: “잘린 한 줄을 클릭하면 패널이 보관한 전체 본문(메시지 최대 4,000자, 명령 최대 600자)을 워드랩으로 펼친다. 그 이상은 raw event log 참조”라고 쓴다. “Nothing cut off for good/전문”은 삭제한다.
- **위험도**: **중간** — 사용자가 패널을 감사용 원문으로 오해할 수 있다.
- **확신도**: **높음**.

### 2-4. 자동 블록 시작이 리셋 후 “몇 초 안”에 일어난다는 설명

- **위치·현재 문구**: `README.md:267-276`, 특히 274의 “While awake it fires within seconds of the reset”; `README.ko.md:267-276`, 특히 274의 “리셋 후 몇 초 안”.
- **무엇이 틀렸나**: 종료 감지는 plan usage를 새로 가져오는 폴링에서만 실행된다. 기본 `claudeState.refreshIntervalSec`는 **300초**이므로, 깨어 있어도 다음 성공 폴까지 최대 약 5분 지연될 수 있다. 1초 UI ticker는 API를 재조회하지 않는다.
- **근거**: `package.json:189-195`, `src/credentials.ts:34-42`, `src/extension.ts:3192-3202, 3220-3249, 3271-3303`
- **수정 방법**: “다음 성공적인 plan-usage poll에서 감지(기본 간격 5분, 설정값에 따라 달라짐)”로 고친다. 제목의 “at the reset/리셋 시각에”도 “after reset detection/리셋 감지 후”가 정확하다.
- **위험도**: **높음** — 사용자가 5시간 블록 앵커 시각을 잘못 예상할 수 있다.
- **확신도**: **높음**.

### 2-5. 네트워크 호출 예외 목록에서 Codex app-server 계정 조회 누락

- **위치·현재 문구**: `README.md:384`, `README.ko.md:383`의 “claude.ai plan usage와 Telegram 외에는 네트워크 호출 없음”.
- **무엇이 틀렸나**: 같은 문단 뒤에서 설명하듯 확장은 로컬 `codex app-server`를 띄워 `account/rateLimits/read`를 호출한다. JSON-RPC 자체는 로컬 stdio지만 app-server는 계정의 실제 rate limit을 조회하는 네트워크 경로다. 첫 문장이 이를 예외에서 빠뜨려 문단 내부도 모순이다.
- **근거**: `src/providers/codex/usageProvider.ts:1-16, 186-264`, `README.md:69-96`, `README.ko.md:69-96`
- **수정 방법**: “컨텍스트 모니터링은 네트워크를 쓰지 않는다. 선택적/별도 네트워크 경로는 Claude.ai plan usage, Telegram, Codex app-server account usage다”로 범위를 나눈다.
- **위험도**: **중간** — 개인정보·방화벽·네트워크 기대를 잘못 만든다.
- **확신도**: **높음**.

### 2-6. request/response 문서가 자동으로 커밋되는 것처럼 읽히는 문장

- **위치·현재 문구**: `docs/codex-rescue-guide.md:118-124`의 “because the files are committed”; `docs/codex-rescue-guide.ko.md:110-116`의 “git에도 올라가니”.
- **무엇이 틀렸나**: 스킬은 `.log/`만 내부 `.gitignore`로 제외한다. request/response/review 문서는 **커밋 대상으로 남겨 둘 뿐**, `send.sh`가 commit하지 않는다.
- **근거**: `send.sh:165-170`, `SKILL.md:151-164`
- **수정 방법**: “커밋해서 남기면 다음 세션에서 이어받을 수 있다 / meant to be committed”로 조건형으로 고친다. README의 `meant to be committed` 표현은 이미 정확하다.
- **위험도**: **중간** — 사용자가 기록이 Git에 보존됐다고 잘못 믿을 수 있다.
- **확신도**: **높음**.

### 2-7. Remote-SSH에서 “서버에 설치할 것이 없다”는 무제한 표현

- **위치·현재 문구**: `docs/codex-rescue-guide.md:166-169`, `.ko.md:156-159`, `README.md:192`, `README.ko.md:192`.
- **무엇이 틀렸나**: **VS Code 확장**은 UI-kind라 서버에 설치할 필요가 없다. 그러나 서버에서 run을 실제로 시작하려면 그 실행 환경에 Codex CLI와 `codex_rescue` 스킬/`send.sh`가 있어야 한다. 현재 문장은 후자까지 불필요한 것으로 읽힌다.
- **근거**: `package.json:5-6`, `send.sh:389-408, 499-503`; 가이드 자체의 요구사항 `docs/codex-rescue-guide.md:16-32`, `.ko.md:16-32`
- **수정 방법**: “서버에 VS Code 확장을 설치할 필요는 없다. 단 서버에서 실행하려면 서버 쪽 Claude Code 환경에 Codex CLI와 스킬이 필요하다”로 한정한다.
- **위험도**: **높음** — 원격에서 실행이 안 되는 직접 원인이 된다.
- **확신도**: **높음**.

### 2-8. 원격 패널이 비면 원인이 반드시 1.9.2 미만이라는 트러블슈팅

- **위치·현재 문구**: `docs/codex-rescue-guide.md:237-239`, `.ko.md:225-227`의 “Your extension is older than 1.9.2 / 확장이 1.9.2보다 낮은 것”.
- **무엇이 틀렸나**: 1.9.3에서도 해당 원격 workspace에 `docs/codex_rescue/.log/`가 없거나, `*_events.jsonl`가 없거나, 원격 FS 읽기가 실패하면 빈 목록이다. 구버전은 가능한 원인 중 하나다.
- **근거**: `runDiscovery.ts:291-334, 336-342`
- **수정 방법**: “원격에 실행 기록이 분명히 있는데 비어 있고 확장이 1.9.2 미만이면 업데이트. 그 외에는 원격 `docs/codex_rescue/.log/`와 events 파일/권한 확인”으로 조건화한다.
- **위험도**: **중간**.
- **확신도**: **높음**.

### 2-9. 완료음이 모든 종료에서 자동으로 울리는 것처럼 설명

- **위치·현재 문구**: `docs/codex-rescue-guide.md:164`, `.ko.md:154`; `README.md:179`, `.ko.md:179`.
- **무엇이 틀렸나**: 확장이 이번 활성화 중 해당 stamp를 live로 관측했고, 직전 poll이 비terminal이며, 다음 poll이 `done/failed/stopped`일 때만 울린다. 확장 시작 전에 이미 끝난 실행은 무음으로 baseline 처리된다. `stale/no response`도 terminal이 아니므로 울리지 않는다.
- **근거**: `src/extension.ts:2633-2640, 2770-2789`, `runDiscovery.ts:465-468`
- **수정 방법**: “확장이 live 상태부터 관측한 실행이 terminal로 전이할 때 완료음”이라고 쓴다.
- **위험도**: **중간** — 누락된 완료음을 버그로 오진하게 한다.
- **확신도**: **높음**.

### 2-10. 실행당 300KB·86%를 일반적인 고정 비율처럼 서술

- **위치·현재 문구**: 두 가이드 `md:123,128` / `ko.md:115,120`; 두 README `md:188,359` / `ko.md:188,359`.
- **무엇이 틀렸나**: 105줄/409KB 표본은 소스 주석으로 확인된다. 그러나 현재 소스에는 실제 events 파일들이 **394KB~750KB**였다는 다른 측정도 있고, 86%는 `send.sh` 주석의 특정 464KB 표본에 대한 값이다. “각 run 약 300KB, 그중 86%”라는 일반화는 현재 근거보다 강하다. run 성격에 따라 편차가 매우 크다.
- **근거**: `execEvents.ts:7-10, 24-28`, `runDiscovery.ts:120-129`, `send.sh:165-169`
- **수정 방법**: “크기는 작업에 따라 크게 달라진다. 보존된 측정 예: 105줄/409KB; 다른 live events 표본은 394~750KB. 한 표본에서 command output 계열이 86%”처럼 표본임을 명시한다.
- **위험도**: **낮음** — 저장공간 예상의 정확도 문제.
- **확신도**: **높음**(일반화 문제), 86%의 원 측정 방법은 **중간**.

### 2-11. EDIT 검증 범위를 “단일 파일 소규모 수정”으로 넓힌 표현

- **위치·현재 문구**: `docs/codex-rescue-guide.md:219`, `.ko.md:207`.
- **무엇이 틀렸나**: 실제 검증 표는 폐기용 fixture의 **명백한 버그 1줄 수정**만 검증했다고 한정한다. “소규모 수정”은 여러 줄·여러 종류의 단일 파일 수정을 검증한 것처럼 범위를 넓힌다.
- **근거**: `SKILL.md:525-540`, 특히 538.
- **수정 방법**: 원래의 “single-line fix / 명백한 1줄 수정 fixture”로 되돌리고 대상 외 파일 보호 등 확인된 범위를 필요하면 덧붙인다.
- **위험도**: **중간** — EDIT 신뢰 범위를 과장한다.
- **확신도**: **높음**.

### 2-12. 서로 다른 두 `stale` 판정을 한 이름으로 사용

- **위치·현재 문구**: 가이드 검증 표 `md:224` / `ko.md:212`의 unresponsive(`stale`)와 트러블슈팅 `md:235` / `ko.md:223`의 response가 이전과 같을 때 `stale`.
- **무엇이 틀렸나**: 둘은 별개다.
  1. `send.sh`의 response-stale: 실행 전후 response SHA-256이 동일함(`send.sh:538-580`). 이는 SKILL 검증 표에서 실측 완료(`SKILL.md:532-535`).
  2. 패널의 heartbeat-stale: heartbeat 없음 또는 30초 초과(`runDiscovery.ts:115-118, 256-267`). 이번 문서에서 ❌로 남긴 것은 이것이다.
  또한 동일 hash는 “최종 내용이 갱신되지 않음”을 증명할 뿐, 같은 내용을 다시 썼는지까지 증명하지는 못한다.
- **수정 방법**: 각각 “response unchanged (hash-stale)”와 “no heartbeat / no response phase”로 이름을 분리한다. “Codex wrote nothing”은 “response content was not updated”로 낮춘다.
- **위험도**: **중간** — 한쪽은 실측, 다른 쪽은 미실측인데 같은 기능처럼 읽힌다.
- **확신도**: **높음**.

### 2-13. `CR_DRYRUN=1`이 완전 무변경 미리보기처럼 읽히는 표현

- **위치·현재 문구**: 가이드 환경변수 표 `md:251`, `ko.md:239`의 “without running it / 실행하지 않고”.
- **무엇이 틀렸나**: Codex 프로세스는 실행하지 않는 것이 맞다. 다만 dry-run 판정 전에 `docs/codex_rescue/.log/`, response 상위 디렉터리, `.log/.gitignore`, 임시 run dir와 lock을 준비한다. 종료 trap이 임시 dir/lock은 지우지만 새 `.log/`와 `.gitignore`는 남을 수 있다.
- **근거**: `send.sh:162-170, 172-217, 455-465`
- **수정 방법**: “Codex를 실행하지 않고 명령을 출력한다(로그 디렉터리와 `.gitignore`는 준비될 수 있음)”로 쓴다.
- **위험도**: **낮음**.
- **확신도**: **높음**.

### 2-14. “No Codex log deletion”의 범위가 모호함

- **위치·현재 문구**: `README.md:114`, `README.ko.md:114`.
- **무엇이 틀렸나**: 이 문장은 Codex **rollout/session log** 삭제가 없다는 뜻이면 맞다. 하지만 뒤의 Codex progress panel은 `codex_rescue` raw log를 수동·자동 삭제한다. 현재 표현만 보면 같은 README 안에서 모순처럼 보인다.
- **근거**: `runDiscovery.ts:470-559`, `extension.ts:622-645, 690-711`
- **수정 방법**: “No deletion of Codex rollout/session logs”로 대상을 명시한다.
- **위험도**: **낮음** — 표현 범위 문제.
- **확신도**: **높음**.

## 3. 한·영 불일치

### 3-1. `scope: all` 안전 폴백 설명이 영어에만 있음

- **위치·현재 문구**: `README.md:117` 마지막 문장 “`scope: all` intentionally remains a recent-session list.” 대응 문장이 `README.ko.md:117`에 없다.
- **차이**: 로그 형식 변경 시 sidebar-only `workspace` 모드는 account-only로 내려가지만, `scope: all`은 recent-session list로 남는다는 중요한 우회 경로가 영어에만 있다.
- **근거**: `package.json:265-273, 389-394`; current-thread 선택 실패와 `scope: all` discovery는 별 경로다.
- **수정 방법**: 한국어에 “`scope: all`은 의도대로 최근 세션 목록으로 계속 동작합니다”를 추가한다.
- **위험도**: **낮음~중간**.
- **확신도**: **높음**.

그 외 네 문서의 대응 섹션·표 행은 의미상 맞춰져 있었다. 특히 이번에 고친 Linux/Remote-SSH/`CR_WIN_SANDBOX` 및 새로 추가한 heartbeat-stale 행은 양 언어에 모두 존재한다.

## 4. 빠진 내용

### 4-1. 1.9.3 행 클릭/아코디언 동작이 두 가이드에는 없음

- README 양쪽 `:175`에는 들어갔고, 별도의 옛 “전문 보기” 행을 남긴 문구도 없다.
- 그러나 `docs/codex-rescue-guide.md`와 `.ko.md`의 “What you see/보이는 것” 표에는 1.9.3 변경이 전혀 없다.
- 코드상 정확한 동작은 **실제로 폭 때문에 잘렸거나 parser가 축약한 행만 클릭 가능**, 클릭 시 그 자리에서 wrap, text row는 패널 전체에서 한 번에 하나만 open, command group은 아코디언 제외다(`codexRescuePanel.ts:257-269, 535-589`).
- **권고**: 두 가이드 §5에도 한 행을 추가하되, 2-3의 4,000/600자 상한을 함께 적는다.
- **위험도**: **중간**, **확신도 높음**.

### 4-2. 패널 표시 한도: workspace folder당 최신 20건

- `discoverRuns` 기본 limit가 20이고 events stamp를 정렬한 뒤 자른다(`runDiscovery.ts:327-342`). cleanup은 별도로 무제한 스캔하므로 오래된 run이 삭제 대상에서는 보이지만 패널에서는 안 보일 수 있다(`runDiscovery.ts:550-559`).
- 네 문서 어디에도 이 상한이 없다. README의 “Each run is one card/실행 한 건이 카드 하나”는 모든 누적 run을 보여주는 것으로 읽힐 수 있다.
- **권고**: “각 workspace folder의 최신 20건 표시”를 패널/정리 설명에 추가한다.
- **위험도**: **중간**, **확신도 높음**.

### 4-3. `no response`의 실제 기준

- 내부 기준은 heartbeat가 없거나 마지막 mtime이 30초를 넘은 경우다. 프로세스를 직접 조회하지 않으며, 절전·FS 지연·시계 보정도 오판 원인이 될 수 있다(`runDiscovery.ts:115-118, 256-267`; 패널 문구도 “may have been killed”).
- 현재 문서는 “프로세스가 강제 종료된 정황”까지만 말한다. **30초 heartbeat 휴리스틱**임을 적으면 사용자가 상태의 확실성을 정확히 이해한다.
- **위험도**: **중간**, **확신도 높음**.

### 4-4. 그 밖의 낮은 위험도 UI 누락

- 모든 Codex run 카드는 기본 접힘(`codexRescuePanel.ts:355-360`).
- 패널에는 workspace 이름/경로, A−/A+ 글꼴 조절, request/result 열기 링크, 완료 후 token 수가 있다(`codexRescuePanel.ts:61-101, 275-283, 494-525`). README의 워크플로 패널 글꼴 설명은 Codex 패널 설명이 아니다.
- `collab_tool_call`도 `collab` activity로 렌더되지만 네 문서의 activity 목록에는 없다(`execEvents.ts:156-159`, `src/i18n.ts:186-194, 446-454`).
- 전부 정확성 오류라기보다 공개 기능 누락이다. 문서를 간결하게 유지하려면 20건 상한과 1.9.3 동작만 필수로 추가하고 나머지는 선택 사항이다.

## 5. 내가 ❌로 남긴 판단에 대한 의견

### REVIEW `--base` / `--commit`: ❌ 유지가 맞다

- 코드가 올바른 플래그를 조립하는 것은 확인됐다(`send.sh:337-363, 389-403`).
- 그러나 `CR_DRYRUN`은 조립 결과만 보여 줄 뿐 Codex가 실제로 원하는 diff 범위를 리뷰했는지 검증하지 않는다.
- 제공 설명대로 실제 status의 scope가 모두 `uncommitted`뿐이라면 `base/commit`을 ✅로 올릴 근거가 없다.
- **판정: 적절함. 확신도 높음.**

### heartbeat `stale` / no response: ❌ 유지가 맞다

- 실제 hard-kill 후 30초 경과, live→stale 표시, terminal로 오승격하지 않음, 완료음 무발생까지 연속 관측한 기록이 없다.
- 다만 SKILL의 “stale 실측”은 response hash-stale이므로 여기와 분리해야 한다.
- **판정: 적절함. 명칭만 수정 필요. 확신도 높음.**

### Linux 서버 실행: 조건부 ✅ 가능

- 네가 인용한 두 status가 실제 파일이고 각각 `review/uncommitted/done/exit 0`, `readonly/doc/done/exit 0`라면 “한 Linux 호스트에서 review 1건 + analysis 1건의 프로세스 왕복 성공”은 실측이라고 해도 된다.
- 현재 가이드가 “one server/서버 한 대”로 표본 범위를 밝혀 둔 점도 좋다. 서버 4대 일반화나 모든 배포판 호환을 주장하지는 않는다.
- 그러나 정본 사본인 `SKILL.md:540`은 여전히 “서버 실제 왕복 ❌ DRYRUN만”이라고 적혀 있어 저장소 자체가 모순이다. 외부 증거를 채택한다면 가이드뿐 아니라 SKILL 검증 표도 같은 좁은 문구로 갱신해야 한다.
- status만으로는 답변 내용이 유효한 분석이었는지까지 증명하지 않는다. “정상 종료”를 프로세스 의미로만 쓸지, 결과 품질까지 뜻할지 구분해야 한다.
- **판정: 현재 가이드 문구는 조건부 수용, SKILL 동기화 필수. 확신도 중간**(원격 원본 미열람).

### Remote-SSH 패널: ✅가 맞다

- 현재 구현 전체가 `vscode.workspace.fs`/URI 기반이고 remote 본문 5초 throttle도 구현돼 있다.
- Git 이력에서도 `v1.9.2`가 이 전환 커밋을 가리킨다. 사용자 실측까지 있었다면 현재 문구의 버전 하한은 충분하다.
- 단 2-7처럼 “서버에 확장 설치 불필요”와 “서버 실행 도구 불필요”를 구분해야 한다.
- **판정: 적절함. 확신도 높음.**

### EDIT 검증: ✅는 유지하되 문구를 좁혀야 한다

- 게이트·실제 수정·대상 외 파일 보호·사후 diff 확인은 실측 표가 있다.
- 검증 범위는 “단일 파일 소규모”가 아니라 “폐기 fixture의 명백한 1줄 수정”이다.
- **판정: 기능 자체 ✅, 범위 표현은 과함. 확신도 높음.**

## 6. 확신도와 남은 불확실성

### 확신도 높음 — 현재 파일을 직접 읽어 확정

- REVIEW/CONSULT/EDIT 실행 인자와 sandbox 차이
- 파일명 규약, response_path 검증, lock과 `.log` 산출물
- 환경변수 및 `CR_TIMEOUT` 거부
- 설정 키·기본값과 자동정리 조건
- 상태 전이, 30초 heartbeat stale, 2초/5초 갱신
- 1.9.3 클릭·워드랩·아코디언 구현과 4,000/600자 상한
- 자동 블록 시작이 기본 300초 plan poll에 종속됨
- Codex account usage가 app-server 조회 경로를 사용함

### 수치 주장 판정

| 주장 | 판정 | 근거/한계 |
|---|---|---|
| 105줄 / 409KB | **확인됨** | `execEvents.ts:7-10, 24-28`의 보존 표본 |
| 실행당 약 300KB | **일반화 불가** | 소스의 다른 실측은 events만 394~750KB (`runDiscovery.ts:120-129`) |
| 86% command output | **특정 표본 주장만 존재** | `send.sh:165-169`의 464KB 표본 주석; 모든 run 비율 아님 |
| 20분 → 1분 25초, 36 → 4 | **현재 저장소에서 검증 불가** | 네 공개 가이드 외 원 실행 기록·측정표가 검색되지 않음 |
| 기본 7일 보관 | **확인됨** | `package.json:401-406`, `extension.ts:693-705` |
| live 2초 / remote body 5초 | **확인됨** | `extension.ts:2797-2815`, `runDiscovery.ts:120-131` |
| 보통 1~3분 | **경험적 표현, 저장소 근거 없음** | run 복잡도에 따라 20분 사례도 문서 자체에 존재 |

### 남은 불확실성

- 원격 `/home/yeogi_callcrew`의 두 status와 대응 response/review 원문을 직접 읽지 못했다.
- “20분/1분25초, 36/4”, “86%”의 원 측정 절차가 저장소에 없어서 재계산 방법을 확정하지 못했다.
- Linux 표본은 한 호스트·두 실행이므로 다른 셸/배포판/권한 구성까지 일반화할 수 없다.
- Remote-SSH 패널은 소스와 사용자 실측 진술이 일치하지만, 이번 감사에서 원격 창을 직접 조작해 재현하지는 않았다.

## 7. 추가로 필요한 자료

문서 수정을 적용하는 데는 추가 자료가 없어도 된다. 다만 아래 **실측 문구를 계속 유지하려면** 자료가 필요하다.

1. Linux ✅ 근거: `260821_020714_status.json`, `260821_035253_status.json` 원문과 대응 `_review_*.md` / `_response_*.md`, 가능하면 stderr 끝부분. 계정·프롬프트 등 민감 내용은 제거해도 된다.
2. 성능 비교 근거: 20분 run과 1분25초 run의 시작/종료 시각, command event 수를 산출한 원 events 파일 또는 집계표.
3. 300KB/86%를 유지하려면 표본 수, “run size”에 포함한 파일 범위(events만인지 stderr/last_message/status 포함인지), command output 비율 계산식을 적은 짧은 측정 메모.

그 자료가 없으면 숫자를 삭제할 필요까지는 없지만, 모두 “한 표본에서/과거 한 측정에서”로 낮추는 것이 정확하다.

---

## Claude 검토 (2026-08-21)

**총평: 가설 기각을 수용한다.** 지적 14건 + 한·영 불일치 1건 + 누락 4건 중 **17건 채택, 2건 보류, 0건 기각.**
채택 전에 다음을 코드로 직접 재확인했다 — 지적이 전부 사실이었다.

- `send.sh:389-393` — `codex exec review` 는 `-s` 를 붙이지 않고 주석에 "샌드박스도 작업 디렉토리도 없다"고 명시. **2-1 사실**
- `package.json:396-411` — 실제 키는 `claudeContextBar.codexRun*`. 가이드는 접두사 없이 적고 있었다. **2-2 사실**
- `package.json:189-192` + `extension.ts:3277` — `detectBlockClose()` 는 plan usage 폴 결과로만 호출되고 기본 간격은 300초. "리셋 후 몇 초 안"은 성립하지 않는다. **2-4 사실**
- `runDiscovery.ts:327,342` — `discoverRuns(..., limit = 20)` + `.slice(0, limit)`. **4-2 사실**

### 채택 — 고친 것

| 지적 | 조치 |
|---|---|
| 2-1 REVIEW 권한 | 가이드 §0 을 모드별로 분리(분석·수정=workspace-write / 리뷰=CLI 고정 read-only, 결과 파일은 `send.sh` 가 씀). README 소개문도 한정 |
| 2-2 설정 키 접두사 | `claudeContextBar.` 를 붙이고 `codexRunRetentionDays`·`codexRunDeleteDocs` 도 함께 명시 |
| 2-3 1.9.3 "전문" 과장 | README 양쪽에서 "Nothing cut off for good / 전문" 삭제, 4,000자·600자 상한 명시 |
| 2-4 자동 블록 시각 | "첫 성공 폴링에서 발사(기본 5분)"로 정정, 절 제목도 "리셋 감지" 기준으로 |
| 2-5 네트워크 예외 목록 | Codex app-server 계정 조회를 예외에 포함하고 "컨텍스트 모니터링은 네트워크 없음"과 분리 |
| 2-6 자동 커밋 오해 | "커밋해서 남기라고 만든 기록이며 스킬이 대신 커밋하지 않는다"로 조건형 |
| 2-7 서버 설치 | "확장은 서버에 불필요 / 단 서버에서 실행하려면 Codex CLI·스킬 필요"로 분리. 가이드 §5 + README 양쪽 |
| 2-8 원격 빈 패널 | 1.9.2 미만은 원인 중 하나로 조건화하고 events 파일·권한 확인을 덧붙임 |
| 2-9 완료음 조건 | "확장이 live 부터 지켜본 실행만" 으로. 가이드 §5 + README 양쪽 |
| 2-10 300KB·86% | 표본 값(409KB / 394~750KB / 464KB 표본의 86%)으로 낮추고 평균이 아님을 명시. 가이드 + README 설정 절 |
| 2-11 EDIT 범위 | **내가 넓힌 것이 맞다.** "단일 파일 소규모" → "버그가 명백한 1줄 수정 한 건" 으로 원복 |
| 2-12 stale 이름 충돌 | 표에서 "패널의 응답 없음(heartbeat 30초)"과 "`send.sh` 의 `stale`(응답 파일 해시 동일)"을 분리. §8 문구도 "Codex가 아무것도 못 씀" → "응답 파일이 갱신되지 않음" 으로 낮춤 |
| 2-13 `CR_DRYRUN` 부수효과 | 로그 디렉터리·`.gitignore` 가 만들어질 수 있음을 표에 명시 |
| 2-14 "No Codex log deletion" | "rollout·세션 로그"로 대상 한정 + 패널의 실행 기록 삭제는 별개임을 괄호로 |
| 3-1 `scope: all` | 한국어 README 에 누락 문장 추가 |
| 4-1 1.9.3 동작 누락 | 두 가이드 §5 에 클릭 펼침·아코디언·상한을 한 항목으로 추가 |
| 4-2 20건 상한 | 두 가이드 §5 에 "워크스페이스 폴더당 최신 20건" 추가 |
| 4-3 `no response` 기준 | "heartbeat 30초 무갱신, 프로세스를 조회하지 않음"까지 명시 |

추가로 지적 대상은 아니었으나 같은 성격이라 함께 낮춘 것: "보통 1~3분"(→ 작은 요청 1~3분, 넓으면 20분),
"실측으로 확인된 차이"(→ 각각 한 번씩 잰 두 사례).

### 채택 — 저장소 모순 (5절 지적)

`SKILL.md` 검증 표의 `서버에서 실제 Codex 왕복 ❌ DRYRUN 만` 을 갱신했다. 가이드와 같은 좁은 문구로
맞추고, **정상 종료는 프로세스 성공이지 답변 품질 보증이 아니다**라는 단서를 넣었다 — 이건 네가 5절에서
구분하라고 한 지점이다. 홈의 정본과 레포 사본 양쪽에 적용했고 두 파일이 바이트 동일함을 확인했다.

### 보류

- **4-4 낮은 위험 UI 누락**(카드 기본 접힘 · A−/A+ · `collab_tool_call` 활동 종류) — 네가 "선택 사항"이라
  적은 것에 동의한다. 활동 종류 표는 대표 예시를 보이는 자리이지 전수 목록이 아니다. 문서를 짧게 유지한다
- **`20분 → 1분 25초, 36 → 4` 의 원 측정 기록** — 저장소에 남아 있지 않다는 판정에 동의한다. 다만 숫자를
  지우지는 않고 "각각 한 번씩 잰 두 사례"로 낮췄다. 7절에서 네가 제시한 대안과 같다

### 검증하지 못한 것

네가 남긴 불확실성 중 **원격 `/home/yeogi_callcrew` 의 응답 원문 확인**은 하지 않았다. `status.json` 두 건의
`codex_exit: 0` 까지가 근거이고, 그래서 문서 문구도 "프로세스가 정상 종료했다"까지만 주장하도록 두었다.
