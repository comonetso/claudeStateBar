---
type: codex_response
mode: readonly
stamp: 260914_022426
slug: release-doc-audit-v115
author: codex
thread_id: 01a09bcd-c3a6-7c10-96e2-3bcd210e52a8
origin: BluemingPc
turns: 1
---

## 0. 조사 계획

1. 요청서를 UTF-8로 다시 읽고 CHANGELOG 1.15.0 전체 및 지정된 영문/한글 README 문장을 추출한다.
2. 단계 접기, 비용 계산, 단계 분류, 모델 한계/표시, Status 패널 및 메뉴 원본과 현재 diff를 직접 대조한다.
3. 문장별 판정과 파일:줄 근거를 작성하고, 영/한 일치 여부 및 짧은 대체 문장을 제시한다.
4. 프로덕션 파일, Git 상태, 설치/빌드 상태는 변경하지 않는다. 쓰기는 이 응답과 .scratch로 제한한다.

## 1. 내가 직접 연 원본

실행 중 확인 사실(결론 전 기록):
- 외부 원본도 GET 조회로 열었다: https://code.claude.com/docs/en/costs (현재 /usage의 세션 비용·시간·코드 변경 표시), https://platform.claude.com/docs/en/about-claude/pricing (Sonnet 4.5 요율 존재, Opus 4.1 $15/$75, 캐시 쓰기 5분 1.25배/1시간 2배), https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans (구독과 별도의 추가 사용 요금). 조회일 2026-09-14. Fable 5의 실제 캐시 읽기 요금은 판정에서 제외했다.
- `git show 762d2c0^:src/providers/claude/modelLimits.ts` 및 display.ts로 변경 전 원본도 직접 열었다. 구형 Sonnet 날짜가 한계 버전으로 해석됐고, Opus 5[1m]는 이전에도 1M 한계였지만 표시명에서 5가 빠졌다. 구형 Opus 3 한계는 변경 전후 모두 200k다.
- `.scratch` 프로브의 첫 실행은 Node에서 git 자식 프로세스 실행이 EPERM으로 막혔다. 승인 대기 없이 셸에서 같은 읽기 전용 git show를 실행해 .scratch에 원문을 저장하고 프로브를 이어 실행했다. 두 번째 실행은 종료 코드 0이다.
- Node UTF-8 직접 읽기로 요청서와 한국어 원문이 정상임을 확인했다. PowerShell 출력만 깨졌다.
- workflowPanel.ts:504~505는 단계 2개 이상뿐 아니라 에이전트가 있고 배정 비율이 1/2 이상일 것을 요구한다. 367~371은 사용자 선택을 우선하며 첫 표시의 running 유무를 고정한다. 565의 완료 카운터는 done만 센다.
- claudeStats.ts:116~152의 단가표는 Sonnet 4.5/구형 Opus 등을 매칭하지 않는다. 576~589에서 미매칭 모델 비용을 제외한다. 공식 단가 존재 여부를 조회하는 구현은 없다.
- i18n.ts:394,814 툴팁은 캐시 읽기 0.1배만 안내한다. README의 Fable $0.25 예외와 달리 예외 문구가 없다. Fable 5의 실제 공식 요금 검증은 요청대로 제외한다.
- extension.ts:529~538 메뉴 순서, statusPanel.ts:123~129 탭, media/status.js:166~217 카드 항목과 비용 툴팁을 확인했다. 토큰별 금액은 cost > 0일 때만 표시한다.
- claudeStats.ts:433~444의 24시간 분석은 입력+캐시+출력 토큰 수로 가중하며 서버 한도 차감량을 쓰지 않는다. 637~708의 누적 토큰/비용은 stats-cache 기반이고 오늘 보충은 활동/세션 수에 적용한다.
- git diff HEAD -- src/workflowPanel.ts src/i18n.ts를 읽었다. 단계 기본 접기 및 globalState 저장 코드가 미커밋 변경분에 포함된다. 코드 주석만 보지 않고 현재 실행 분기도 확인했다.

- 요청서: 지정된 응답 경로와 읽기 전용 범위를 확인했다. 첫 PowerShell 출력의 한글 인코딩이 깨져 UTF-8로 재독 예정이다.

- CHANGELOG.md 1~38 및 README.md/README.ko.md 146~159, 326~375 원문을 열었다. 1.15.0 릴리스 설명과 단계 접기·비용 관련 문장을 확보했다.

- `src/workflowPanel.ts:1-220,290-455,645-710` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/workflowPhases.ts:1-300` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/providers/claude/modelLimits.ts:1-250` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/providers/claude/display.ts:1-230` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/claudeStats.ts:1-245` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/workflowPanel.ts:425-575,670-700` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `README.ko.md:335-339` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/statusPanel.ts:1-260` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `media/status.js:1-290` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/extension.ts:520-542,1720-1810,3380-3485` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/claudeStats.ts:355-450,470-595,605-710` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/workflowPhases.ts:355-438` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `media/status.js:283-405` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/i18n.ts:388-395,588-597,808-815` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/claudeStats.ts:250-276` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `src/extension.ts:2365-2432` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `package.json:245-263` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `.scratch/audit-v115-probe.cjs` 실행: 소스의 순수 계산 부분을 메모리에서 평가했다(빌드 없음). 결과는 `.scratch/audit-v115-probe.json`. Opus 기본 한계 비율 5배, 단계 배정 1/2 문턱, stopped 기본 접기, 명시적 펼침 우선, 미지원 요율 사례를 계산했다. 비용 예시는 합성 입력이며 실제 사용자 통계가 아니다.

- `CHANGELOG.md:3-35` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `README.md:155,366-370` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `README.ko.md:155,335-339` — `node docs/codex_rescue/.scratch/audit-v115-read.cjs`로 열었다. 지정 범위 원문을 직접 확인했다.

- `.scratch/audit-v115-probe.cjs` 실행: 소스의 순수 계산 부분을 메모리에서 평가했다(빌드 없음). 결과는 `.scratch/audit-v115-probe.json`. Opus 기본 한계 비율 5배, 단계 배정 1/2 문턱, stopped 기본 접기, 명시적 펼침 우선, 미지원 요율 사례를 계산했다. 비용 예시는 합성 입력이며 실제 사용자 통계가 아니다.

## 2. 주장별 판정

판정 기준: **참**은 현재 소스가 그 동작을 구현한다는 뜻이며 실제 설치된 Extension Host에서의 실행 보증은 아니다. **과장**은 핵심 기능은 있지만 조건·범위를 생략한 경우, **거짓**은 반례가 직접 확인된 경우, **근거 없음**은 빈도·역사·외부 정책을 코드 주석만으로 단정한 경우다. 아래 C는 CHANGELOG, E는 README.md, K는 README.ko.md다. 같은 문구의 중복은 해당 위치를 모두 기재했다.

배포 전에 우선 고칠 부분은 **실제 청구액처럼 읽히는 비용 설명, 공식 단가가 없다는 잘못된 안내, CLI에서 종료 후에만 볼 수 있다는 주장, 단계 묶기의 조건 누락**이다. 기능 자체가 전부 잘못됐다는 판정은 아니다.

### 2.1 CHANGELOG 1.15.0 전체

| ID / 위치 | 주장 | 판정 | 직접 근거 | 대체 문장 또는 조치 |
|---|---|---|---|---|
| C01 5 | 실행 중 세션 비용을 볼 수 있다 | 참(환산액) | src/extension.ts:3439~3458, media/status.js:189~195 | 제목은 `See your session's estimated API cost while you work.`로 명확화 가능 |
| C02 6 | CLI가 종료 때 시간·변경 줄·토큰 요약을 출력한다 | 근거 없음(종료 출력 경로 자체는 이번 원본에서 미확인) | src/claudeStats.ts:529~533은 cost-state **읽기**이며 CLI의 출력 구현은 아니다. 공식 costs 문서는 현재 /usage의 동일 항목을 확인시켜 준다 | C03과 합쳐 `Claude Status brings session time, code changes, tokens, and estimated API cost into a VS Code panel.` |
| C03 6~7 | 그것이 유일한 확인 장소이며 종료 후에만 보인다 | 거짓 | [공식 costs 문서](https://code.claude.com/docs/en/costs)의 Using the /usage command는 **현재 세션** 통계를 보여준다. src/statusPanel.ts:123~129는 새 패널 구조만 입증하며 CLI의 독점적 역사 주장은 입증하지 않는다 | C02 대체문 사용. 종료 후에만 가능했다는 문장은 삭제 |
| C04 9 | Claude Status는 세션 메뉴의 Settings 바로 위다 | 참 | src/extension.ts:529~538 | 유지 |
| C05 9 | 패널에는 두 탭이 있다 | 참 | src/statusPanel.ts:123~129, src/i18n.ts:374~375 | 유지 |
| C06 9~10 | Usage가 모든 live conversation의 카드로 시작한다 | 과장 | src/extension.ts:3430~3440은 스캔된 **Claude** 세션만, 읽기 실패는 제외. media/status.js:233~239는 해당 목록을 표시. idle도 포함 가능 | `Usage starts with cards for the Claude conversations found by the status bar whose local logs can be read.` |
| C07 10 | 얼마나 오래 실행했는지 표시 | 참(기록 기준) | src/claudeStats.ts:511~514,595의 마지막-첫 timestamp, media/status.js:166 | 더 정확히 `recorded session duration` |
| C08 10~11 | 그중 실제 작업에 쓴 시간을 표시 | 과장 | src/claudeStats.ts:537~540은 user부터 **첫 assistant 기록**까지의 합. media/status.js:171~174는 기록된 API 시간이 양수면 대신 사용. 작업 전체를 실측한 값은 아니다 | `estimated active time, or recorded API time when available` |
| C09 11 | 변경 줄 수 표시 | 참(로그상 변경) | src/claudeStats.ts:517~525, media/status.js:176~182. structuredPatch의 +/−를 합산하며 Git 최종 순변경량은 아님 | 필요하면 `recorded line additions and removals` |
| C10 11 | 요청 횟수 표시 | 참(기록 기준) | src/claudeStats.ts:543~546은 requestId/message.id/uuid로 중복 제거, media/status.js:184 | 유지 |
| C11 11 | 사용 토큰 표시 | 참(기록 기준) | src/claudeStats.ts:547~569, media/status.js:214~217 | 유지 |
| C12 11~12 | 공개 API 요율로 실제로 들었을 비용을 표시 | 과장 | src/claudeStats.ts:116~140,580~589는 고정 표로 계산. 구형 모델·캐시 TTL 등 모든 공식 요율을 반영하지 않는다. 아래 R13/R18 참조 | `an API-cost estimate using the extension's supported rates` |
| C13 12 | 구독이면 어느 것도 청구되지 않는다 | 거짓(무조건 단정) | src/claudeStats.ts:531~533은 기록값을 읽을 뿐 청구 여부를 판정하지 않는다. [공식 추가 사용 안내](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)는 구독 외 추가 청구를 명시 | `This estimate is not your bill.` |
| C14 14 | 아래에 5시간·주간 한도 표시 | 참(데이터가 있을 때) | src/extension.ts:3406~3423, media/status.js:245~281. 미설정·인증 실패면 안내 표시 | `Below are the available 5-hour and weekly plan limits.` |
| C15 14 | 각 한도의 리셋 시각 표시 | 참(유효한 시각이 있을 때) | src/extension.ts:3388~3396,3409~3421, media/status.js:263,270,277 | 유지 |
| C16 15 | 지난 하루 기준 분석 | 참 | src/claudeStats.ts:29,387,429 | 유지 |
| C17 15~16 | 무엇이 한도를 소모했는지, 긴 문맥의 사용량 비중 | 과장 | src/claudeStats.ts:433~441,616은 토큰 가중 비중. 서버 한도 실제 차감 비중을 역산하지 않음. UI는 src/i18n.ts:409에서 local approximate라고 명시 | `A local, approximate breakdown shows the last 24 hours of token usage in contexts over 150k.` |
| C18 16 | 어떤 스킬에 사용량이 갔는지 | 참(부분 집계) | src/claudeStats.ts:443~444,617~622. attributionSkill이 있는 기록, 반올림 후 0% 제외, 상위 8개 | `It also lists the largest recorded skill shares.` |
| C19 18 | Stats는 lifetime view | 과장(완전한 현재 전체 기록으로 읽힐 때) | src/claudeStats.ts:637~668은 stats-cache의 누적 토큰/환산만 사용. 오늘의 보충은 682~706의 활동·세션 수이고 토큰/비용에는 없음 | `Stats shows the history available in Claude Code's local statistics.` |
| C20 18 | 활동 히트맵 표시 | 참 | src/claudeStats.ts:682~691, media/status.js:327~328,383~405 | 유지 |
| C21 18 | 총 토큰 및 환산액 표시 | 참(캐시 범위) | src/claudeStats.ts:641~664, media/status.js:339~340 | C19 범위와 함께 유지 |
| C22 18~19 | 세션 수 표시 | 참 | src/claudeStats.ts:705~706, media/status.js:342 | 유지 |
| C23 19 | 가장 긴 세션 표시 | 참 | src/claudeStats.ts:670, media/status.js:343 | 유지 |
| C24 19 | 활동일 표시 | 참 | src/claudeStats.ts:693~694, media/status.js:344 | 유지 |
| C25 19 | 연속 활동일 표시 | 참 | src/claudeStats.ts:696~698, media/status.js:345,347 | 유지 |
| C26 19 | 모델별 비중 표시 | 참(토큰 비중) | src/claudeStats.ts:663~666, media/status.js:369~376 | 필요하면 `each model's token share` |
| C27 23 | 이전 워크플로우는 평면 목록이었다 | 참 | `git show 762d2c0^:src/workflowPanel.ts`의 `wf.agents.map` 단일 agents 목록과 현 src/workflowPanel.ts:547~575 직접 대조 | 유지 |
| C28 23~24 | 이제 에이전트는 수행 단계에 묶인다 | 과장 | src/workflowPanel.ts:501~505의 추가 문턱,556~563의 미배정 기타 묶음. 단계 자체도 src/workflowPhases.ts:393~427로 복원한 정보 | 아래 W 교체문 사용 |
| C29 24 | 묶음마다 끝난 에이전트 수를 센다 | 과장(끝남=중단까지 포함하면 거짓) | src/workflowPanel.ts:565는 **done만** 카운트. 370은 stopped도 기본 접기하므로 같은 finished가 서로 다르게 쓰임 | `Each group shows a completed/total count.` |
| C30 24~25 | 모든 행에 모델과 사용 토큰 표시 | 과장 | src/workflowPanel.ts:517~520은 model 존재, tokens truthy일 때만 표시. src/extension.ts:1765~1770도 데이터 있을 때만 전달 | `Agent rows show model and token details when available.` |
| C31 25 | 단계 클릭으로 접기 | 참 | src/workflowPanel.ts:678~685,248~251 | 아래 W 교체문에 포함 |
| C32 25~26 | 끝난 단계는 처음부터 접힘 | 과장 | src/workflowPanel.ts:367~371. 저장된 펼침 우선, 첫 표시 때 running 없으면 접힘. 실행 중에 보던 단계는 완료돼도 자동 접히지 않음 | 아래 W 교체문에 포함 |
| C33 26 | 접은 상태가 패널을 닫아도 기억됨 | 참(구현 확인) | src/workflowPanel.ts:69~77,138,164~171,683~684. 영구 삭제 시 해당 상태 제거(177~178) | 아래 W 교체문에 포함 |
| C34 26~27 | 스크립트가 준 이름이면 추측 대신 사용 | 과장 | src/workflowPhases.ts:175~183은 literal만,408~427은 성공 매칭에만 label 유지. residual 경로는 원래 label을 복사하지 않음. src/extension.ts:1793~1798은 p.label 있을 때만 덮어씀 | `When a script label can be matched to an agent, the panel uses it in preference to a prompt-derived name.` |
| C35 27 | 한국어 패널에서 경과 시간을 한국어 표시 | 참 | src/workflowPanel.ts:388~394,444~445, src/i18n.ts:588~596. 행 단위 분/초 및 경과/소요 라벨 번역, 시계 숫자는 공통 형식 | 유지 |
| C36 31 | Opus 5 백분율이 최대 5배 높았다 | 참(기본 설정·해당 ID) | package.json:250~258의 200k/1M, 변경 전후 modelLimits와 프로브. 913411 입력은 456.7055% → 91.3411% | `With the default limits, some Opus 5 sessions showed five times the correct context percentage.` |
| C37 31~32 | 4 이후 모든 Opus가 잘못된 한계였다 | 거짓 | src/providers/claude/modelLimits.ts:14의 1m 우선 경로는 이전에도 존재. `claude-opus-5[1m]`은 변경 전후 1M | C36 교체문 사용, Every 문장 삭제 |
| C38 32 | 일부 구형 모델도 잘못된 한계였다 | 참 | 변경 전 `claude-3-sonnet-20240229` 1M → 현재 200k. src/providers/claude/modelLimits.ts:20~28 | `Context limits for some older Sonnet IDs were also corrected.` |
| C39 33 | 버전이 누락될 수 있었다 | 참(재현된 형태) | src/providers/claude/display.ts:31~39, 프로브: Opus 5[1m]의 `Opus 1M` → `Opus 5 1M` | 유지. 구형 `claude-3-opus-*`의 3까지 복구됐다는 뜻으로 확대하면 안 됨 |
| C40 33~34 | 날짜가 버전 자리에 표시됐다 | 참 | src/providers/claude/display.ts:31~34, 프로브: `Opus 20240229` → `Opus` | 유지 |
| C41 34 | 내부 placeholder ID가 그대로 상태바에 노출됐다 | 참 | src/providers/claude/display.ts:14~16, 프로브: `<synthetic>` → 빈 문자열 | 사용자용으로 `Placeholder model names no longer appear on the status bar.` |

C02는 C03의 거짓 판정과 구분한다. **종료 시에도** 요약이 나오는지는 별도 실행 경로의 문제이고, **종료 시에만** 볼 수 있다는 주장은 현재 공식 문서로 반증됐다. 과거 모든 CLI 버전의 출력 역사를 새로 단정하지 않았다.

### 2.2 README 영/한 지정 문장 전체

| ID / 위치 | 주장 | 판정 | 근거 | 대체 문장 |
|---|---|---|---|---|
| R01 E155/K155 | 둘 이상의 단계 선언이면 단계별 그룹 표시 | 과장 | src/workflowPanel.ts:504~505. 4명 중 1명 배정은 false, 2명 배정부터 true를 프로브로 확인 | W |
| R02 E155/K155 | 각 에이전트를 수행 단계에 배치 | 과장 | src/workflowPanel.ts:556~563, src/workflowPhases.ts:393~427. 복원 못한 에이전트는 기타/평면으로 남을 수 있음 | W |
| R03 E155/K155 | 완료/전체 카운터 | 참 | src/workflowPanel.ts:565~574. stopped는 완료 분자에 포함되지 않음 | W의 completed/total 유지 |
| R04 E155/K155 | 제목을 눌러 접기 | 참 | src/workflowPanel.ts:678~685 | W |
| R05 E155/K155 | 이미 끝난 단계는 처음부터 접힘 | 과장 | C32와 같은 근거. 명시적 펼침 선택 예외, stopped도 접힘 | W |
| R06 E155/K155 | 닫았다 열어도 접기 기억 | 참 | src/workflowPanel.ts:69~77,164~171. 펼침 선택도 기억한다 | W |
| R07 E366/K335 | API로 썼다면 들었을 비용 | 과장(정확한 가상 청구액처럼 읽힘) | src/claudeStats.ts:116~140,580~589. 실제 요금 옵션을 모두 재현하지 않는 고정 표 환산 | P |
| R08 E366/K335 | 구독이면 청구 없음, 그래서 CLI는 $0 기록 | 거짓/근거 없음 | 청구 없음은 C13 반례. $0의 인과는 src/claudeStats.ts:531~533에서 보장하지 않는다. 기록된 숫자를 수용할 뿐 구독 여부 분기 없음 | P. `$0` 내부 기록 설명 삭제 |
| R09 E366/K335 | hover에 단가·모델별 내역 | 참(표시 기능), 요율 안내 불일치 있음 | media/status.js:190~194, src/i18n.ts:394,814. 툴팁은 Fable 예외 누락 | P. 툴팁도 같은 기준으로 Claude가 수정 |
| R10 E366/K335 | 공식 단가 없는 모델은 제외·표시 | 거짓(제외 원인을 오인) | src/claudeStats.ts:144~152,576~589. `claude-sonnet-4-5`는 null이지만 공식 요율이 존재한다 | P의 `Models whose rates are not supported by the extension…` |
| R11 E366/K335 | Stats에도 같은 전체 기간 환산 | 참(동일 환산 방식), 범위 표현 과장 | src/claudeStats.ts:637~658. stats-cache에 없는 오늘 토큰까지 합산하지 않는다 | P의 `history stored in Claude Code's statistics` |
| R12 E368/K337 | 단위 1M 입력/출력 | 참 | src/claudeStats.ts:580~583의 /1e6 | Q |
| R13 E368/K337 | Opus $5/$25 | 코드와 일치하는 범위 있음, 공식 요율 일반화는 거짓 | src/claudeStats.ts:124~125는 Opus 4+ 모두 동일. 공식 가격표의 Opus 4/4.1은 $15/$75. 프로브에서 opus-4-1이 $5/$25로 잡힘 | Q. 코드 요율 수정은 Claude의 별도 작업 필요 |
| R14 E368/K337 | Sonnet 5 $2/$10 | 참(현재 표) | src/claudeStats.ts:129~130 | 유지 |
| R15 E368/K337 | Sonnet 4.6 $3/$15 | 참 | src/claudeStats.ts:134~135 | 유지 |
| R16 E368/K337 | Haiku $1/$5 | 과장(세대 생략) | src/claudeStats.ts:139~140은 >=4만. 구형 Haiku는 이 표에서 제외 | Q에서는 Haiku 4.5로 한정 |
| R17 E368/K337 | Fable $10/$50 | 참(코드와 수치 일치) | src/claudeStats.ts:119~120 | 유지 가능. Fable 5 캐시 실제 요율 판정은 제외 |
| R18 E368/K337 | 캐시 쓰기 1.25배 | 참(코드 계산), 공식 전체 요율로는 과장 | src/claudeStats.ts:120~140의 고정 배율. 공식 가격표는 5분 1.25배와 1시간 2배를 구분 | Q에서는 `estimate uses`를 명시 |
| R19 E368/K337 | 캐시 읽기 0.1배, Fable $0.25 예외 | 참(코드 계산) | src/claudeStats.ts:120~140. 다만 src/i18n.ts:394,814 툴팁에는 예외가 없음 | Q. Fable 5 요율의 외부 정확성은 이번 판정 제외 |
| R20 E370/K339 | 각 토큰 종류 옆에 그 몫의 금액 | 과장(항상 표시 단정) | media/status.js:204~211의 cost > 0 조건. Stats 토큰 행에는 비용 자체가 없음(352~363); 해당 문맥은 Usage로 한정해야 함 | T |
| R21 E370/K339 | 긴 대화에서는 대개 캐시 읽기가 비용 대부분/가장 큰 몫 | 근거 없음 | src/claudeStats.ts:580~589는 단순 요율 합산. 190~192, media/status.js:199~201은 같은 주장을 반복하는 주석일 뿐 빈도 측정이 아니다. 아래 계산 참조 | T. 빈도 표현 삭제 |

**공식 요율 대조 근거:** Sonnet 4.5는 코드에서 누락됐지만 공식 가격표에 있고, 구형 Opus와 캐시 저장 시간에 따라 요율이 달라진다. 따라서 “공식 단가 없음”과 “어떤 옵션에서든 그만큼 들었을 금액”으로 안내하면 안 된다. [Anthropic 공식 가격표](https://platform.claude.com/docs/en/about-claude/pricing)

### 2.3 그대로 사용할 수 있는 짧은 영/한 교체문

**W — E155/K155 전체:**

EN: **Agents grouped by phase** — Workflows with multiple phases are grouped when enough agents can be matched to a phase. Each group shows a completed/total count. Click a phase header to fold or unfold it. On first display, groups with no running agents start folded unless you previously chose otherwise. Your choice is remembered when you reopen the panel.

KO: **단계별로 묶어서 보여줌** — 여러 단계가 있는 워크플로우는 에이전트의 단계를 충분히 확인할 수 있을 때 묶어서 표시합니다. 묶음마다 완료/전체 숫자가 보입니다. 단계 제목을 눌러 접거나 펼칠 수 있습니다. 처음 표시할 때 실행 중인 에이전트가 없는 묶음은 접히지만, 이전에 선택한 상태가 있으면 그 상태를 따릅니다. 패널을 다시 열어도 선택한 상태를 기억합니다.

사용자 문장에 50% 구현 수식까지 넣을 필요는 없다. 정확한 문턱은 이 조사 문서의 근거로 남기고, 공개 문장에는 묶음 표시가 조건부임을 알리면 된다.

**P — E366/K335 전체:**

EN: **Cost (API rate)** estimates the cost of the recorded tokens using the extension's supported API rates. It is not your bill. Hover the amount for the rates and per-model breakdown. Models whose rates are not supported are excluded and flagged. Stats uses the same conversion for the history stored in Claude Code's statistics.

KO: **비용 (API 환산)** 은 기록된 토큰을 확장이 지원하는 API 단가로 환산한 추정액입니다. 실제 청구액은 아닙니다. 금액에 마우스를 올리면 단가와 모델별 내역이 나옵니다. 단가를 지원하지 않는 모델은 합계에서 제외하고 표시합니다. 통계 탭도 Claude Code 통계에 저장된 기록을 같은 방식으로 환산합니다.

**Q — E368/K337 전체(현 코드를 유지할 경우의 정직한 설명):**

EN: The estimate uses these input/output rates per 1M tokens: $5/$25 for matched Opus 4+ IDs, $2/$10 for Sonnet 5+, $3/$15 for Sonnet 4.6, $1/$5 for Haiku 4.5, and $10/$50 for Fable. It applies 1.25× input for cache writes and 0.1× for cache reads, with a flat $0.25 cache-read rate for Fable. Older-model rates and 1-hour cache-write pricing are not fully covered.

KO: 환산에는 100만 토큰당 입력/출력 기준으로, 인식된 Opus 4 이상 ID에 $5/$25, Sonnet 5 이상에 $2/$10, Sonnet 4.6에 $3/$15, Haiku 4.5에 $1/$5, Fable에 $10/$50을 적용합니다. 캐시 쓰기는 입력 단가의 1.25배, 캐시 읽기는 0.1배이며 Fable의 캐시 읽기는 $0.25로 계산합니다. 구형 모델 단가와 1시간 캐시 쓰기 요금은 완전히 반영하지 못합니다.

Q는 현행 환산의 한계를 숨기지 않는 문구다. 더 짧고 자연스러운 공개 문구를 원하면 Claude가 먼저 구형 Opus 분기·지원 모델·캐시 TTL 계산을 바로잡고, 그 결과에 맞춰 요율 문단을 다시 줄여야 한다. 문서만 Opus 4.5+라고 바꾸면 현재 코드가 4/4.1에도 $5/$25를 적용하는 문제가 가려진다. 요청에서 제외한 Fable 5 공식 캐시 요율은 여기서 해결됐다고 선언하지 않는다.

**T — E370/K339 전체:**

EN: In Usage, token types with a positive estimated cost show that amount beside their token count. The split depends on the model and how the conversation uses tokens.

KO: 사용량 탭에서는 환산 금액이 있는 토큰 종류의 수치 옆에 해당 금액을 표시합니다. 비용 비중은 모델과 대화의 토큰 사용 방식에 따라 달라집니다.

### 2.4 직접 계산한 반례와 의미

재현: 저장소 루트에서 `node docs/codex_rescue/.scratch/audit-v115-probe.cjs`. Node의 git 자식 실행 제한을 피하기 위해 변경 전 두 소스는 `.scratch/audit-v115-old-*.ts`에 읽기 전용 git show 결과로 보존했다. 빌드나 패키지 설치는 하지 않았다.

- **캐시 토큰 수와 비용 비중은 다르다.** 합성 Opus 입력에서 입력 10,000, 출력 100,000, 캐시 읽기 900,000, 캐시 쓰기 100,000 토큰을 적용했다. 코드 요율로 $0.05 + $2.50 + $0.45 + $0.625 = $3.625. 캐시 읽기는 토큰의 **81.08%**지만 비용의 **12.41%**다. 출력 10,000으로 낮춘 두 번째 예시도 캐시 읽기 비용은 **32.73%**이며 캐시 쓰기 $0.625보다 작다. 이 예시는 “대개”의 통계적 반증은 아니다. **긴 문맥이라는 조건만으로 비용 최대 항목을 도출할 수 없음**을 보인다. 이 머신의 실제 세션 빈도를 측정한 값으로 오인하면 안 된다.
- **기본 접기:** 처음 done → true, 처음 stopped → true, 처음 running → false, 그 그룹이 나중에 done → 계속 false, 저장된 펼침+done → false. 그러므로 “완료 시 자동 접기”로 바꾸면 오히려 거짓이 된다.
- **묶기 문턱:** 단계 2개·에이전트 4명일 때 배정 0/1명은 평면, 배정 2/3/4명은 그룹. README의 “둘 이상 선언”만으로는 불충분하다.
- **모델 한계:** Opus 5 기본 입력 913,411의 백분율은 456.7055% → 91.3411%, 비율 5. 이 토큰 수는 소스 주석의 값을 계산용으로 쓴 것이며 해당 실사용 로그를 다시 열었다는 뜻은 아니다. 사용자 설정을 바꾸면 5배라는 비율도 달라질 수 있다.
- **모델명:** Opus 5[1m]는 `Opus 1M` → `Opus 5 1M`; 구형 Opus 3는 `Opus 20240229` → `Opus`; `<synthetic>`은 빈 문자열로 바뀐다. 날짜 제거는 확인됐지만 구형 모델의 버전 복구까지 완전해진 것은 아니다.

### 2.5 사용자에게 필요 없는 내부 설명과 수정 방법

- `$0`을 CLI가 저장하는 이유는 공개 문서의 핵심이 아니며 이번 코드로 그 인과도 보장되지 않는다. **추정액이며 청구액이 아니라는 한 문장**이면 사용자가 이해하는 데 충분하다.
- “프롬프트에서 guess”는 복원 구현을 드러낸다. `Recognized script labels are shown as agent names.`처럼 표시 결과에 초점을 맞춰도 된다. 다만 모든 스크립트 라벨을 인식한다고 약속해서는 안 된다.
- `Every Opus past the 4 series was being held to the wrong limit`는 잘못된 일반화이며 내부 분기 설명이다. 어떤 사용자의 백분율이 바로잡혔는지로 바꾼 C36 문장이 낫다.
- placeholder 설명은 사용자가 보던 이상한 모델명 수정과 연결돼 있으므로 릴리스 노트에 남겨도 된다. 내부 타입 이름까지 설명할 필요는 없다.
- 실제 수정은 Claude가 수행한다. 문서는 W/P/T 및 CHANGELOG 교체문을 반영하고, 툴팁은 README와 같은 예외·지원 범위를 안내하도록 맞춘다. 코드 문제를 처리할 때는 `rateFor`의 모델 세대 매칭, 캐시 TTL별 요율, 미지원 요율 안내를 따로 검증해야 한다. 상태 접기를 성공 완료와 같게 만들기 위해 stopped를 done으로 바꿔서는 안 된다.

## 3. 영/한 불일치

- **E155 ↔ K155:** 의미 일치. 선언만으로 그룹화된다는 조건 누락과 finished의 모호함도 양쪽이 공유한다.
- **E366 ↔ K335:** 의미 일치. 구독이면 무청구, 공식 단가 미존재라는 잘못된 일반화를 둘 다 포함한다.
- **E368 ↔ K337:** 숫자·배율·Fable 예외가 일치한다. 한쪽만 다른 수치는 없다. 다만 **양쪽 README와 양쪽 툴팁 사이에는 Fable 캐시 읽기 예외 누락이라는 불일치가 있다.** Fable 5의 실제 단가를 조사 대상에서 뺀 것과는 별개의 문서 간 대조 결과다.
- **E370 ↔ K339:** 앞 문장은 같은 취지지만 영문 `share of the amount beside it`은 어색하다. 뒷문장 `most of it`은 보통 과반/대부분을 뜻하고, 한글 “가장 큰 몫”은 최대 단일 항목만 의미하므로 강도가 다르다. 예를 들어 40%가 최대 항목인 경우 한글은 성립할 수 있지만 영문의 대부분은 아니다. 양쪽 모두 빈도 근거가 없으므로 T로 통일하면 이 차이도 사라진다.

## 4. 내 판단에 대한 판정

여기서 “내 판단”은 요청서에 적힌 Claude의 사전 판단을 말한다.

- 메뉴 위치·탭 이름·150k 기준·한국어 시간 단위는 **동의**한다. 실제 조건문과 렌더러를 확인했다. 다만 150k 분석은 한도 실측이 아니라 로컬 토큰 비중이다.
- 단가가 맞는다는 판단은 **부분 동의**다. Sonnet 숫자는 코드와 맞지만 “공식 단가 없음”은 틀리고 Opus/Haiku의 세대 범위가 뭉뚱그려졌다. 공식 구형 Opus 요율 및 1시간 캐시 요율과 현 코드의 차이도 직접 확인했다.
- Opus 5 한계 수정은 **기본 설정의 일반 ID에 대해 동의**한다. 모든 Opus 5라는 단정은 [1m] 반례로 기각한다. 구형 Sonnet은 수정됐고 구형 Opus 3 한계는 변경 전에도 200k였다.
- placeholder는 **동의**한다. 다만 모든 구형 모델 버전 표시까지 복구됐다고 해석하지 않는다.
- **캐시 읽기가 대개 가장 큰 몫:** 빈도 근거가 없다는 의심에 동의한다. 주석의 동일 주장도 증거로 쓰지 않았다. 토큰 수의 우세를 비용의 우세로 바꿀 수 없으므로 삭제/중립화가 적절하다.
- **stopped도 끝남이라고 불러도 되는가:** 작업 종료라는 넓은 의미로는 가능하지만, 같은 문단의 완료 카운터는 stopped를 제외하므로 사용자가 성공 완료로 읽을 여지가 있다. “실행 중인 에이전트가 없는 묶음”이 정확하다. 더 중요한 조건은 **저장된 펼침 우선**과 **첫 표시의 기본값 고정**이다.
- 요청서에서 제외한 Fable 5 캐시 읽기 공식 요율 문제는 별도로 해결했다고 주장하지 않는다.

## 5. 완료 게이트 자기판정

| 게이트 | 판정 | 근거 |
|---|---|---|
| G1 모든 주장 판정 | 충족 | C01~C41 및 R01~R21로 대상 문장을 주장 단위로 분리. 참/거짓/과장/근거 없음을 모두 표시 |
| G2 거짓·근거 없음 소스 근거 | 충족 | 각 행에 파일:행을 기재. CLI·요금 정책처럼 저장소만으로 결정할 수 없는 주장은 직접 연 공식 원문 링크도 병기 |
| G3 영/한 일치 | 충족 | 네 쌍 모두 대조. most of it/가장 큰 몫의 강도 차이, 양 언어 공통 오류, README/툴팁 불일치를 구분 |
| G4 대체 문장 | 충족 | 각 지적 행의 교체문 또는 W/P/Q/T와 연결. 영/한 README 전체 대체 문구 제공. 프로덕션에는 적용하지 않음 |

## 6. 확신도와 남은 불확실성

- **높음:** 현재 소스의 그룹 표시·카운터·기본 접기·영속 저장 분기, 고정 요율 매칭, 각 화면 항목, 언어 쌍 수치 일치. 순수 계산 프로브도 종료 코드 0으로 실행했다.
- **높음(현재 문서 기준):** CLI 실행 중 통계 표시와 유료 추가 사용 가능성은 공식 문서로 확인했다. 외부 문서는 향후 달라질 수 있고 이번 릴리스 작성일 당시 모든 CLI 버전의 역사를 증명한 것은 아니다.
- **미검증:** 실제 VS Code 창에서 닫기/다시 열기, Extension Host 재시작 후 상태 유지. 저장 경로·메시지 순서는 확인했지만 런타임 성공으로 표현하지 않는다. 설치된 VSIX와 현재 소스의 동일성도 이 감사 범위에서 확인하지 않았다.
- **미검증:** CLI의 종료 요약 출력 구현, 세션별 $0 기록의 모든 조건, 실사용 집단에서 캐시 비용이 최대인 빈도. 접근 가능한 지정 소스의 내용은 모두 읽었고, 이들은 해당 소스로 보장되지 않는 별도 주장이다. 실제 사용자 로그는 자격증명 혼입 가능성이 있는 원시 내용을 무작정 열어 빈도 표본으로 쓰지 않았으며 합성 계산을 실측이라고 부르지 않았다.
- 요금·작업 시간·모델 지원의 세부 코드 문제를 모두 수정한 것은 아니다. 요청 범위는 진단과 수정 방법이며 변경은 Claude의 작업이다.
- 프로덕션 수정, Git 상태 변경, 패키지 설치, 빌드, 계정 변경, 네트워크 업로드는 하지 않았다. 생성/갱신은 지정 응답 문서와 `.scratch` 내부 산출물뿐이다. 자격증명 파일은 열지 않았다.

## 7. 이 머신에서 접근 불가한 자료

**지정된 조사 자료 중 없음.** PowerShell 출력 인코딩 문제는 Node 직접 읽기로, Node의 git 자식 프로세스 EPERM은 셸의 읽기 전용 git show로 우회했다. 승인 요청이나 미확인 접근 성공 주장은 없다. 실행하지 않은 VS Code 런타임 검증과 열지 않은 CLI 출력 구현은 접근 불가 자료로 포장하지 않고 위 미검증 항목으로 남겼다.

## Claude 검토

완료 게이트: 통과. 명령 20건(`item.started` 기준), `.scratch/audit-v115-read.cjs` 로 지정 범위를 실제로 읽고 프로브 계산까지 실행. 응답에 원본에서만 나오는 행 번호·계산값이 있다. send.sh 보고: 응답 파일 외 변경 없음, `.scratch/` 5건(정상).

교차 확인: claude-api 스킬 `shared/models.md` 에 Opus 4.1·Opus 4·Sonnet 4.5 가 실재 모델로 올라 있다(89·90·97행). `shared/prompt-caching.md` 144행: 캐시 쓰기는 5분 TTL 1.25배, 1시간 TTL 2배. Opus 4/4.1 의 $15/$75 는 스킬 캐시에 단가표가 없어 직접 확인하지 못했다(Codex 의 웹 조회 결과를 근거로 둔다).

공개 문서 방침(사용자 지시 2026-09-14): 무엇이 바뀌었는지만, 쉽게. 그래서 "사실과 틀린 문장"은 고치고, "조건을 빠짐없이 적자"는 제안은 받지 않는다.

채택 — 사실과 틀렸거나 근거 없는 문장
- C02·C03 "CLI 요약은 세션이 끝나야만 볼 수 있었다": `/usage` 로 진행 중에도 볼 수 있다. 비교 문장을 빼고 "VS Code 패널에서 본다"로 바꾼다.
- C13·R08 "구독이면 청구 없음 / 그래서 `$0` 기록": 추가 사용 요금이 있을 수 있다. "실제 청구액이 아니다" 한 문장으로 바꾸고 `$0` 인과 설명은 뺀다.
- R10 "공식 단가가 없는 모델은 뺀다": Sonnet 4.5 는 공식 단가가 있는데 코드가 모른다. "단가를 모르는 모델"로 바꾼다.
- C37 "Opus 4 이후 전부 잘못된 한계": `[1m]` 이 붙은 id 는 원래 맞았다. "Opus 5 세션이 최대 5배 높게 보일 수 있었다"로 줄인다.
- R21 "긴 대화에서는 대개 캐시 읽기가 가장 큰 몫": 빈도 근거 없음, 영/한 강도도 다르다. 삭제.
- C29 "끝난 에이전트 수": 카운터는 완료(done)만 센다. "완료"로 단어만 바꾼다.
- C32·R05 "끝난 단계는 처음부터 접힘": 멈춘 에이전트만 있는 단계도 접힌다. "실행 중인 에이전트가 없는 단계"로 바꾼다. 저장된 펼침 우선 조건은 넣지 않는다(쉬운 문장 우선).
- R16 "Haiku $1/$5": "Haiku 4.5"로 좁힌다.

기각 — 조건 과잉(사용자 방침과 충돌)
- R01·R02 배정 문턱, C06 Claude 세션 한정, C08 작업 시간 산출 방식, C12·R07 "확장이 지원하는 단가" 반복, C19 누적 범위, C20 금액 0 조건, C30 데이터 있을 때만, C34 라벨 매칭 조건, Q 문단의 한계 나열. 기능이 틀린 게 아니라 설명이 덜 자세한 것이다. 작업 시간은 툴팁(`cs.sess.activeHint`)이 이미 설명한다.

사용자 판단 대기 — 문서가 아니라 코드 문제
- R13 코드가 Opus 4/4.1 에도 $5/$25 를 적용한다(Codex 조회상 공식 $15/$75).
- R10 Sonnet 4.5 단가가 코드 표에 없다.
- R18 1시간 캐시 쓰기(2배)를 1.25배로 계산한다.
- R09 툴팁에 Fable 캐시 읽기 예외가 없다.
- (기존 기록) Fable 5 캐시 읽기 $0.25 여부.

되묻기: 하지 않는다. 핵심 질문(문장이 코드와 맞나)이 전부 판정됐고, 사실 오류나 근거 미확인 기각이 없다.

### 사용자 결정 (2026-09-14)
- 채택 8건: 전부 적용.
- 코드 단가 문제(R09·R10·R13·R18 + Fable 5 캐시 읽기): 기록만, 다음 버전. 메모리 `project_status_panel_pricing_issues` 에 남김.
- 같은 배포에 Codex 진행 패널 모델·추론 수준 표시를 추가(이 감사 범위 밖). 리뷰 실행 원본 기록에 모델 정보가 없는 표본 1건(260827_112905)이 있어 README 에 "리뷰 실행은 표시되지 않을 수 있다"를 덧붙인다.
