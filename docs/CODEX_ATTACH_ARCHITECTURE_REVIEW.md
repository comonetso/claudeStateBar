# Codex Attach Architecture Review / Codex Attach 아키텍처 검토

> Date / 작성일: 2026-07-22  
> Repository / 저장소: `claudeContextBar` (`blueming.claude-state-bar`)  
> Current source version / 현재 소스 버전: `1.7.43`  
> Status / 상태: Architecture review and implementation handoff; no Codex feature code has been implemented yet.  
> Purpose / 목적: Preserve the existing Claude product and attach Codex as an independent provider instead of migrating or replacing Claude behavior.

## Quick navigation / 빠른 탐색

Claude Code가 구현을 이어받을 때는 한국어판의 다음 순서로 읽으면 된다.

1. `1. 문서 목적과 최종 결론`
2. `6. 기능 지원 매트릭스`
3. `9. 권장 내부 아키텍처`
4. `15. 구현 단계와 완료 기준`
5. `16. 필수 테스트 계획`
6. `18. 구현 시 하지 말아야 할 것`
7. `19. 다음 작업자가 먼저 해야 할 일`

For an English-first handoff, read these sections in order:

1. `21. Purpose and executive decision`
2. `26. Feature-support matrix`
3. `28. Recommended architecture`
4. `33. Implementation phases and acceptance criteria`
5. `34. Required tests`
6. `36. Explicit do-not-do list`
7. `37. Handoff checklist for the next Claude Code session`

---

# Part I. 한국어

## 1. 문서 목적과 최종 결론

이 문서는 현재 **Claude State Bar** 프로젝트의 모든 주요 기능과 결합 지점을 정리하고, Codex 지원을 다음 중 어느 방향으로 진행할지 결정하기 위한 구현 인계 문서다.

1. 기존 프로젝트에 Codex 기능을 직접 뒤섞어 추가
2. 현재 프로젝트 안에 독립 provider로 Codex를 attach
3. Codex 전용 별도 프로젝트/확장을 생성
4. 공유 core와 Claude/Codex 두 확장으로 분리

### 최종 권고

**현재는 별도 프로젝트를 만들지 말고, 이 저장소 안에서 Codex를 독립 provider로 attach한다.**

단, 이것은 Claude 코드를 Codex로 마이그레이션하거나 기존 함수에 `if (codex)` 분기를 계속 추가한다는 뜻이 아니다. 내부적으로는 다음처럼 명확히 분리해야 한다.

```text
Claude session files ─→ ClaudeProvider ─┐
                                        ├─→ NormalizedSession ─→ shared UI / alerts
Codex rollout files  ─→ CodexProvider  ─┘

Claude.ai usage API ─→ ClaudePlanUsage
Codex app-server     ─→ CodexRateLimits (optional, with fallback)
```

제품은 하나로 유지하되 데이터 수집기와 파서는 서로 독립시킨다. Codex에서 의미가 다른 기능은 Claude 기능을 억지로 복제하지 않고 Codex에 맞는 동등 기능으로 설계한다.

### 중요한 판단

- **Codex 지원은 기술적으로 가능하다.**
- **Claude 기능 전체를 Codex에 1:1로 복제하는 것은 불가능하고 필요하지도 않다.**
- 별도 저장소를 만든다고 Codex의 실시간 이벤트 접근 제약이 해결되지는 않는다.
- 지금 별도 확장을 만들면 상태바, 사운드, 설정, i18n, Remote 처리와 진단 체계가 중복된다.
- 현재 `src/extension.ts`가 약 3,278줄이므로 provider 분리 없이 attach하면 회귀 위험이 매우 크다.
- Codex rollout 포맷과 app-server는 변동 가능성이 있으므로 기능 플래그, capability 검사, fixture 테스트가 필수다.

---

## 2. 현재 제품 전체 파악

현재 확장은 단순 토큰 카운터가 아니다. 서로 다른 데이터 소스와 생명주기를 가진 네 개의 제품 기능이 한 확장 안에 결합돼 있다.

### 2.1 Claude Code 컨텍스트 모니터

주요 파일:

- [`src/extension.ts`](../src/extension.ts)
- [`src/debug.ts`](../src/debug.ts)

현재 동작:

- `~/.claude/projects/` 아래의 프로젝트 디렉터리와 JSONL 세션 파일 탐색
- 현재 workspace 또는 모든 프로젝트 범위 선택
- `/clear` 이후 토큰 사용량 재계산
- 세션 supersession/ghost 판정
- 모델별 컨텍스트 한도 적용
- 세션별 컨텍스트 퍼센트 표시
- 모델명, effort, `/fast`, thinking 상태 표시
- active/idle/hideAfter 상태 관리
- 상태바별 수동 숨김과 자동 unhide
- 경고/위험 임계값 색상 및 비프
- 응답 완료, 질문 대기, stuck tool-use 휴리스틱
- 최근 최대 5개 세션 표시

중요 결합 지점:

- `SessionInfo`: `src/extension.ts` 약 15행
- Claude 경로 해석: 약 972행
- Claude 토큰 파서: 약 1864행
- Claude 세션 탐색: 약 2073행
- 공통 상태바 렌더링과 알림: 약 2447행

### 2.2 Claude.ai 플랜 사용량 모니터

주요 파일:

- [`src/planUsage.ts`](../src/planUsage.ts)
- [`src/credentials.ts`](../src/credentials.ts)
- [`src/settingsPanel.ts`](../src/settingsPanel.ts)

현재 동작:

- Claude.ai의 비공식 usage endpoint 호출
- 5시간 session 사용량과 주간 사용량 표시
- 모델별 weekly scoped limit 동적 표시
- `limits` 배열과 legacy bucket 양쪽 대응
- Electron `net` 우선 사용으로 Cloudflare challenge 회피
- Remote/headless 환경의 Cloudflare 오류와 실제 인증 만료 구분
- Session Key와 Telegram token을 VS Code SecretStorage에 저장
- Org ID, refresh interval 등을 VS Code global settings에 저장
- 응답 스키마가 바뀌었을 때 진단 로그 출력

이 계층은 Claude 고유 기능이며 Codex 컨텍스트 모니터와 섞으면 안 된다.

### 2.3 Workflow와 Task agent 뷰어

주요 파일:

- [`src/extension.ts`](../src/extension.ts), 대략 1017~1660행
- [`src/workflowPanel.ts`](../src/workflowPanel.ts)

현재 동작:

- Claude workflow의 `journal.jsonl` 해석
- `subagents/workflows/<wfId>/` 구조 탐색
- 일반 Task agent의 `subagents/agent-*.jsonl` 및 `.meta.json` 해석
- 시간 간격에 따른 Task batch 그룹화
- running/done/stopped 판정
- `[Request interrupted]`를 이용한 중단 판정
- 짧은 최종 응답의 settle-based 완료 판정
- 역할명과 전체 작업 설명 복원
- 현재 단계 및 전체 단계 표시
- workflow 전체 완료 비프
- 완료 workflow/Task 로그 삭제 UI

이 영역은 UI는 재사용할 수 있지만 데이터 모델은 Claude 전용이다. Codex provider에는 별도 agent tree builder가 필요하다.

### 2.4 Claude 5시간 블록 자동화

주요 파일:

- [`src/blockPrimer.ts`](../src/blockPrimer.ts)
- [`src/extension.ts`](../src/extension.ts), 대략 3115행 이후
- [`src/credentials.ts`](../src/credentials.ts)

현재 동작:

- Claude 5시간 block close 감지
- reset 시 Telegram 알림
- 선택적으로 임시 디렉터리에서 `claude -p` 실행
- 다음 5시간 블록을 reset 시점에 anchor
- 여러 VS Code 창 사이 원자적 lock으로 중복 발사 방지
- API key 환경변수가 있으면 과금 위험 때문에 발사 거부
- 발사 후 `sessionResetAt ≈ now + 5h`인지 최대 약 75초 동안 검증
- 절전 해제 후 놓친 reset을 첫 poll에서 복구

이 기능은 Claude 구독 모델과 `claude -p`의 동작에 종속된다. Codex용으로 복제하지 않는다.

### 2.5 공통 UI 및 운영 기능

다음은 provider-neutral하게 재사용할 가치가 크다.

- 상태바 item 생성/갱신/폐기
- 프로젝트별 색상
- compact mode와 custom short name
- warning/danger threshold
- idle dimming과 hideAfter
- 세션 숨김/복원 QuickPick
- 사운드 재생 및 gain 조절
- 완료 알림 debounce
- WebView 설정 UI 기반
- EN/KO i18n
- Output Channel 진단
- 이전 VSIX 버전 정리와 zombie status item 대응

---

## 3. 현재 배포와 저장소 상태

검토 시점의 확인값:

- 브랜치: `main`
- HEAD: `ce1933d` (`feat(v1.7.43): ...`)
- `package.json` 버전: `1.7.43`
- 원격 추적 상태: `main...origin/main`, source commit은 동기화 상태
- 현재 가장 높은 확인 태그: `v1.7.33`
- `v*` 태그 push 시 GitHub Actions가 VSIX 생성, GitHub Release, VS Marketplace, Open VSX publish를 수행
- `AGENTS.md`는 untracked 상태였으며 이 문서 작업에서 수정하지 않음
- 자동 테스트 없음
- 런타임 테스트는 VS Code Extension Development Host(F5)가 필요
- `package.json`의 `extensionKind`는 `['ui']`

주의:

- 소스가 1.7.43이어도 tag/publish는 별개다.
- 공개 배포 전에는 반드시 현재 태그와 Marketplace 상태를 다시 확인한다.
- 사용자-facing 기능을 추가하면 `README.md`와 `README.ko.md`를 같은 변경에서 모두 갱신한다.
- 릴리스마다 `CHANGELOG.md`를 갱신한다.

---

## 4. Codex에서 실제 확인한 로컬 데이터 구조

### 4.1 Codex 상태 루트

공식 기본값은 `CODEX_HOME=~/.codex`다. 사용자는 `CODEX_HOME`을 바꿀 수 있으므로 `os.homedir() + '/.codex'`만 하드코딩하면 안 된다.

현재 머신에서 확인된 관련 항목:

```text
~/.codex/
  sessions/YYYY/MM/DD/rollout-*.jsonl
  archived_sessions/
  session_index.jsonl
  state_*.sqlite
  logs_*.sqlite
  config.toml
  auth.json
```

민감 데이터 주의:

- rollout JSONL에는 전체 사용자 메시지, 개발자/시스템 지시, assistant 출력, tool input/output가 포함될 수 있다.
- `auth.json`은 절대 직접 읽거나 진단 로그에 출력하지 않는다.
- 본 기능은 필요한 구조 필드만 읽고 사용자 텍스트를 로그에 남기지 않아야 한다.

### 4.2 rollout JSONL top-level record

현재 관찰된 주요 top-level type:

- `session_meta`
- `turn_context`
- `event_msg`
- `response_item`
- `world_state`

현재 관찰된 `event_msg.payload.type`:

- `task_started`
- `task_complete`
- `token_count`
- `thread_settings_applied`
- `user_message`
- `agent_message`
- `context_compacted`
- `turn_aborted`
- 일부 도구/patch/web 관련 완료 이벤트

현재 관찰된 `response_item.payload.type`:

- `message`
- `reasoning`
- `custom_tool_call`
- `custom_tool_call_output`

### 4.3 세션 메타데이터

`session_meta.payload`에서 확인된 주요 필드:

- `id` / `session_id`
- `timestamp`
- `cwd`
- `originator`
- `cli_version`
- `source`
- `thread_source`
- `model_provider`
- `context_window`
- `git`

`cwd`가 있으므로 Claude의 디렉터리명 역복원 휴리스틱 없이 workspace와 정확히 매칭할 수 있다.

### 4.4 모델과 effort

`turn_context.payload`에서 확인된 주요 필드:

- `turn_id`
- `cwd`
- `model`
- `effort`
- `approval_policy`
- `sandbox_policy`
- `collaboration_mode`
- `multi_agent_mode`
- `summary`

Codex는 turn마다 설정이 달라질 수 있으므로 가장 최근 `turn_context`를 사용한다. Claude처럼 전역 settings 파일만 읽는 방식으로 가정하지 않는다.

### 4.5 토큰 의미론

`event_msg.payload.type === 'token_count'`의 현재 구조:

```text
payload.info.total_token_usage
payload.info.last_token_usage
payload.info.model_context_window
payload.rate_limits
```

Codex 컨텍스트 사용률은 다음처럼 계산한다.

```text
contextUsed = last_token_usage.total_tokens
contextLimit = model_context_window
percentage = round(contextUsed / contextLimit * 100)
```

절대 하지 말아야 할 계산:

```text
total_token_usage.total_tokens / model_context_window
```

`total_token_usage`는 여러 model call의 누적 소비량이므로 컨텍스트 윈도우보다 훨씬 커질 수 있다.

또한 `input_tokens` 안에는 cached input이 포함된 형태이므로 `cached_input_tokens`를 다시 더하지 않는다. Codex token breakdown은 다음처럼 보여주는 것이 안전하다.

- Current context total: `last.totalTokens`
- Input: `last.inputTokens`
- Cached portion: `last.cachedInputTokens` (input의 부분집합으로 표시)
- Output: `last.outputTokens`
- Reasoning output: `last.reasoningOutputTokens`
- Lifetime/cumulative: `total.totalTokens` (컨텍스트와 별도 라벨)

### 4.6 active/completed 판정

파일 기반 판정의 기본 알고리즘:

1. 마지막 `task_started` 시각을 기억한다.
2. 마지막 `task_complete`, `turn_aborted`, 실패 관련 종료 시각을 기억한다.
3. `task_started`가 종료 이벤트보다 새로우면 active다.
4. 종료 이벤트가 더 새로우면 idle/completed다.
5. 파일이 쓰이는 중일 수 있으므로 마지막 malformed JSON line은 버리지 말고 다음 refresh에서 재시도한다.

현재 실제 세션에서도 새 turn의 `task_started`가 직전 `task_complete` 뒤에 추가되는 형태가 확인됐다.

완료 비프는 Claude의 `assistant.stop_reason=end_turn` 휴리스틱보다 Codex의 `task_complete`가 더 명확하다. 단, extension activation 시 이미 존재하던 완료 이벤트는 baseline으로만 기억하고 비프를 울리지 않는다.

### 4.7 compact 판정

다음 신호를 사용할 수 있다.

- `context_compacted` event
- app-server의 context compaction item/notification
- `last_token_usage.total_tokens`의 큰 폭 감소

명시적 이벤트를 우선하고 토큰 감소는 fallback 진단으로만 사용한다.

### 4.8 subagent와 thread tree

현재 생성된 app-server 타입에는 다음이 존재한다.

- `Thread.parentThreadId`
- `Thread.sessionId`
- `Thread.agentNickname`
- `Thread.agentRole`
- `source.subAgent.thread_spawn.parent_thread_id`
- subagent depth와 agent path

하지만 과거 실제 샘플 중 guardian subagent는 `source.subagent.other='guardian'`만 있고 부모 ID가 없었다. 따라서:

- 부모 ID가 명확한 최신 세션만 tree로 묶는다.
- 부모를 추측해서 잘못 연결하지 않는다.
- 연결 불가능한 agent는 별도 `Unlinked Codex agents` 그룹 또는 숨김 처리한다.

---

## 5. Codex app-server 검토

### 5.1 공식 역할

Codex app-server는 Codex VS Code 확장 같은 rich client를 위한 인터페이스다. JSON-RPC 형태로 다음을 제공한다.

- thread start/list/read/resume/fork
- turn start/steer/interrupt
- thread status notification
- token usage notification
- item started/completed
- turn started/completed
- account rate limits
- approval request
- user input request
- model/config/account 정보

스키마는 설치된 Codex 버전에 맞춰 다음 명령으로 생성할 수 있다.

```powershell
codex app-server generate-ts --out <temporary-directory>
codex app-server generate-json-schema --out <temporary-directory>
```

공식 문서도 생성물은 실행한 Codex 버전에 종속된다고 명시한다.

### 5.2 이 머신에서 확인한 결과

별도 app-server를 실행해 읽기 요청을 수행한 결과:

- `thread/list`: 현재 Codex thread, cwd, source, path 조회 성공
- `account/rateLimits/read`: 현재 plan type, 사용률, window duration, reset time 조회 성공
- 현재 VS Code에서 실제로 작업 중인 thread의 status: 별도 app-server에서는 `notLoaded`

프로세스 조사 결과 Codex 데스크톱과 각 VS Code Codex 확장은 각자 private stdio app-server를 실행하고 있었다. 별도로 실행한 app-server는 다른 프로세스에 로드된 thread의 live notification을 구독하지 못한다.

### 5.3 결론: hybrid 방식

```text
Live session/context/activity
  → rollout JSONL watcher + incremental tail parser

Account rate limits
  → optional app-server account/rateLimits/read
  → fallback: latest rate_limits observed in rollout JSONL
```

주의:

- app-server 자체가 아직 experimental로 표시된다.
- 별도 app-server를 30초마다 시작하면 안 된다.
- 사용한다면 activation 시 capability probe 후 장시간 연결 또는 plan interval의 저빈도 조회를 검토한다.
- 별도 app-server가 현재 VS Code Codex thread를 live로 관찰한다고 가정하지 않는다.
- 향후 공식 passive subscription 또는 daemon/proxy 지원이 Windows에 제공되면 구조를 재검토한다.

---

## 6. 기능 지원 매트릭스

| 현재 기능 | Claude 현재 구현 | Codex 지원 | Codex 구현 판단 |
|---|---|---:|---|
| workspace별 세션 탐색 | encoded project directory | 가능 | `session_meta.cwd` 사용 |
| 모든 프로젝트 세션 | `~/.claude/projects` 스캔 | 가능 | 최근 date directory와 index/cache 사용 |
| 컨텍스트 % | Claude usage fields 합산 | 가능 | `last_token_usage.total_tokens / model_context_window` |
| 모델명 | assistant message model | 가능 | 최신 `turn_context.model` |
| effort | Claude settings/global signal | 가능 | 최신 `turn_context.effort` |
| speed `/fast` | Claude speed field | 직접 대응 없음 | 명확한 Codex 필드가 있을 때만 표시 |
| thinking 표시 | thinking block | 부분 가능 | reasoning/item 흐름으로 표시, 정확도 라벨 필요 |
| active elapsed | 최근 Claude activity | 가능 | 최신 task/item 상태 기반 |
| idle/hideAfter | mtime + activity | 가능 | 동일 UX 재사용 |
| warning/danger | context % threshold | 가능 | 공통 alert engine |
| response completion beep | `end_turn` + debounce | 가능 | `task_complete` + baseline gate |
| deliberate question beep | AskUserQuestion/ExitPlanMode | 부분 가능 | `request_user_input` raw signal 또는 hook 필요 |
| permission wait beep | pending tool-use heuristic | 제한적 | 별도 app-server는 live tap 불가; hook bridge 없이는 best-effort |
| stuck tool heuristic | unanswered tool_use | 부분 가능 | tool call/output pairing으로 구현 가능하나 false positive 위험 |
| Workflow viewer | Claude journal 구조 | 직접 재사용 불가 | Codex thread tree builder 별도 구현 |
| subagent completion beep | workflow agents all done | 부분 가능 | parent linkage가 있는 최신 thread만 정확 |
| workflow log delete | Claude 전용 디렉터리 삭제 | 지원하지 않음 | Codex 파일 삭제 UI를 만들지 않음 |
| Claude.ai 5h/weekly | 비공식 Claude API | 해당 없음 | Codex rate limit을 별도 섹션으로 표시 |
| Telegram reset alert | Claude block close | 의미 변경 필요 | Codex rate-limit reset/threshold 알림은 별도 기능으로 검토 |
| auto-start primer | `claude -p` | 지원하지 않음 | Codex로 복제 금지 |
| Remote-SSH | local UI + remote workspace.fs | 검증 필요 | remote `CODEX_HOME` 실기기 확인 필요 |
| compact mode/colors/hide | 공통 UI | 가능 | 그대로 재사용 |
| settings/i18n | EN/KO WebView | 가능 | provider 섹션 추가 |

---

## 7. 왜 지금 별도 프로젝트가 아닌가

### 7.1 별도 프로젝트가 해결하지 못하는 문제

- 기존 Codex VS Code app-server의 live event를 볼 수 없는 문제
- rollout JSONL 스키마 drift
- Remote‑SSH에서 실제 Codex state 위치를 확인해야 하는 문제
- 질문/승인 대기 신호의 정확도
- subagent 구버전 parent linkage 부족

이 문제들은 repository나 Marketplace extension을 분리해도 그대로다.

### 7.2 별도 프로젝트에서 중복되는 자산

- status bar item lifecycle
- colors and thresholds
- hide/restore menu
- sound engine and gain
- completion debounce
- WebView settings panel
- EN/KO i18n
- Remote filesystem handling
- output diagnostics
- zombie/old version cleanup
- CI, packaging, release documentation

공통 core 없이 별도 확장을 만들면 두 프로젝트에서 같은 버그를 따로 고쳐야 한다.

### 7.3 현재 프로젝트 attach의 장점

- Claude와 Codex를 동시에 쓰는 사용자가 한 상태바에서 비교 가능
- 같은 프로젝트의 Claude/Codex 세션을 provider badge로 구분 가능
- 사운드와 threshold 설정을 공유하거나 provider별 override 가능
- 기존 안정화 경험을 재사용 가능
- Codex 기능을 off-by-default beta로 격리 가능
- 별도 Marketplace listing 이전에 실제 사용 가치 검증 가능

---

## 8. 언제 별도 프로젝트/확장으로 분리해야 하는가

다음 중 하나가 확인되면 분리를 다시 검토한다.

1. Codex가 persistent app-server/daemon 또는 전용 background process를 필수로 요구한다.
2. 정확한 approval/user-input 알림을 위해 Codex hook을 설치하고 관리해야 한다.
3. Claude는 local UI host, Codex는 remote workspace host에서 반드시 실행해야 해 하나의 extension host로 감당할 수 없다.
4. Codex release/schema 변경 주기가 Claude 안정 릴리스를 반복해서 깨뜨린다.
5. Marketplace에서 Codex-only 사용자를 위한 별도 브랜드가 제품 목표가 된다.
6. Codex provider 코드가 공통 core보다 커져 독립적인 로드/설정/문서가 더 단순해진다.
7. 사용자들이 Claude credential UI가 포함된 Codex 제품을 명확히 거부한다.

그 시점의 권장 구조는 코드 복제가 아니라 다음이다.

```text
packages/shared-core
extensions/claude-state-bar
extensions/codex-state-bar
```

두 VSIX가 공통 package를 사용하고 별도 Marketplace listing과 release cadence를 갖게 한다.

---

## 9. 권장 내부 아키텍처

### 9.1 목표 디렉터리 구조 예시

```text
src/
  providers/
    types.ts
    claude/
      sessionProvider.ts
      tokenParser.ts
      workflowProvider.ts
    codex/
      sessionProvider.ts
      rolloutParser.ts
      discovery.ts
      usageProvider.ts
      agentTree.ts
  core/
    sessionRegistry.ts
    sessionRenderer.ts
    alertCoordinator.ts
    fileTailCache.ts
  claude/
    planUsage.ts
    blockPrimer.ts
  ui/
    settingsPanel.ts
    workflowPanel.ts
  extension.ts
```

실제 리팩터링 파일명은 달라도 되지만 provider-specific parsing과 shared rendering의 경계는 유지한다.

### 9.2 공통 모델 예시

```ts
type ProviderId = 'claude' | 'codex';

interface ProviderCapabilities {
  workflows: boolean;
  deleteWorkflowLogs: boolean;
  exactCompletionSignal: boolean;
  exactQuestionSignal: boolean;
  exactApprovalSignal: boolean;
  accountUsage: boolean;
  blockPrimer: boolean;
}

interface NormalizedTokenUsage {
  contextUsed: number;
  contextLimit: number;
  percentage: number;
  input?: number;
  cachedInput?: number;
  output?: number;
  reasoningOutput?: number;
  cumulative?: number;
}

interface NormalizedSession {
  provider: ProviderId;
  providerLabel: string;
  capabilities: ProviderCapabilities;
  projectName: string;
  projectPath: string;
  sessionId: string;
  sessionFile: string;
  model: string;
  effort: string;
  tokens: NormalizedTokenUsage;
  state: 'active' | 'waiting-user' | 'waiting-approval' | 'completed' | 'idle' | 'failed' | 'unknown';
  createdAt: Date | null;
  lastActivityAt: Date | null;
  completedAt: Date | null;
  isIdle: boolean;
}

interface SessionProvider {
  readonly id: ProviderId;
  discover(scope: DiscoveryScope): Promise<NormalizedSession[]>;
  watch(onChange: () => void): vscode.Disposable;
  getWorkflows?(session: NormalizedSession): Promise<NormalizedWorkflow[]>;
}
```

### 9.3 key와 UI 구분

현재 `statusBarItems` key는 `sessionFile`이다. provider를 붙일 때는 충돌 방지를 위해 다음과 같이 한다.

```text
sessionKey = `${provider}:${normalizedAbsoluteSessionPath}`
```

같은 workspace에서 Claude와 Codex 세션이 동시에 보일 수 있으므로 텍스트나 tooltip에 provider 표식이 필요하다.

예시:

```text
[Claude] project: Opus 4.7 - High (41%)
[Codex]  project: GPT-5.6 - High (38%)
```

compact mode에서는 짧은 badge를 사용할 수 있다.

```text
C·Project 41%
X·Project 38%
```

아이콘과 표기 방식은 구현 전에 UX 확인을 받는다.

### 9.4 capability 기반 메뉴

UI에서 provider별 `if`를 반복하지 말고 capability로 메뉴를 구성한다.

- `workflows=false`: workflow 메뉴 숨김
- `deleteWorkflowLogs=false`: 삭제 버튼 숨김
- `blockPrimer=false`: primer 관련 설정/상태 숨김
- `accountUsage=true`: 해당 provider usage section 표시
- 정확하지 않은 상태는 확정 표현 대신 `possible`, `best effort`를 사용

---

## 10. Codex discovery와 parser 설계

### 10.1 초기 탐색

Codex는 `sessions/YYYY/MM/DD` 구조이므로 전체 history를 매 30초마다 재귀 스캔하지 않는다.

권장:

1. `CODEX_HOME` resolve
2. `sessions/` 존재 확인
3. 현재 날짜와 최근 N일 directory만 초기 탐색
4. file mtime이 `hideAfter`보다 오래된 파일은 header만 읽거나 건너뜀
5. `session_meta.cwd`로 workspace scope 필터
6. active/recent 파일만 parser cache에 등록
7. watcher가 새 날짜 directory/file을 발견하면 cache 추가

`session_index.jsonl`은 현재 관찰된 구조에서 `id`, `thread_name`, `updated_at`만 제공하고 cwd/path가 없으므로 단독 discovery source로 부족했다.

app-server `thread/list`는 cwd/path를 제공하므로 저빈도 초기 catalog 보조 수단으로 사용할 수 있다. 단, app-server가 없거나 실패해도 JSONL discovery가 동작해야 한다.

### 10.2 incremental tail

Codex rollout 파일은 수백 KB~수 MB로 커질 수 있다. 매 refresh마다 전체 파일을 `readTextFile()`로 읽지 않는다.

파일별 cache:

```ts
interface TailState {
  uri: vscode.Uri;
  byteOffset: number;
  carry: string;
  lastSize: number;
  parsed: CodexSessionAccumulator;
}
```

처리:

- 파일 크기가 증가하면 `[byteOffset, end)`만 읽는다.
- 완성되지 않은 마지막 줄은 `carry`에 보관한다.
- 파일이 truncate되면 offset을 0으로 초기화한다.
- parser exception은 해당 record만 무시하고 diagnostic counter를 올린다.
- user/developer message content는 parsing에 필요하지 않으면 materialize하지 않는다.

`vscode.workspace.fs.readFile`은 range read를 직접 제공하지 않으므로 구현 시 선택지가 있다.

- local file에서는 Node `fs.open/read`
- remote URI에서는 전체 read 또는 VS Code filesystem provider 제약 고려
- 최근 active file 수를 제한해 remote 전체 read 비용 완화
- 필요하면 provider별 local/remote reader abstraction 생성

이 부분은 Remote‑SSH PoC에서 먼저 성능을 측정해야 한다.

### 10.3 schema tolerance

파서는 exact full schema validation으로 실패시키지 않는다.

- 알려진 type만 처리
- 모르는 type은 무시하고 count만 기록
- 필드가 없으면 capability/unknown으로 degrade
- token count가 없으면 context 표시를 `—`로 둠
- model context window가 0/null이면 percentage 계산 금지
- duplicate `session_meta`는 최신 또는 최초 stable metadata를 안전하게 merge

---

## 11. Codex account usage 설계

### 11.1 표시 의미

Claude의 `5h session / weekly`와 Codex의 `primary / secondary rate-limit window`는 같은 개념으로 가정하지 않는다.

Codex tooltip 예시:

```text
──────── Codex Usage ────────
Primary: 4% used
Window: 7 days
Resets: 2026-07-28 ...
Plan: Plus
Credits: none
Last checked: ...
```

실제 응답에 secondary window가 있을 때만 표시한다.

### 11.2 조회 우선순위

1. app-server `account/rateLimits/read`
2. 활성 rollout의 최신 `payload.rate_limits`
3. 이전 성공값 + `stale` 표기
4. 모두 없으면 unavailable

JSONL의 rate limit은 Codex 작업이 수행될 때만 갱신될 수 있어 idle 중에는 stale할 수 있다. 실제 검토에서도 JSONL 관측값과 직접 app-server 조회값 사이에 시차가 있었다.

### 11.3 프로세스 정책

- app-server 실행 실패가 extension activation 실패로 이어지면 안 된다.
- `codex` executable 탐색 실패 시 context monitor는 계속 동작한다.
- child process command line에 token/secret을 넣지 않는다.
- stdout은 JSON record 단위로 읽는다.
- stderr는 debug mode에서만 redacted logging한다.
- timeout, shutdown, orphan process 정리를 구현한다.
- 30초 session refresh와 5분 account refresh를 분리한다.

---

## 12. Remote‑SSH와 extension host

현재 확장은 `extensionKind: ['ui']`이므로 로컬 UI extension host에서 실행된다. Claude remote 로그는 `vscode.workspace.fs`가 `vscode-remote://` URI를 원격 host로 라우팅하는 방식을 사용한다.

Codex attach에서 검증할 조합:

| 환경 | 예상 state 위치 | 검증 항목 |
|---|---|---|
| local workspace + Codex VS Code | local `~/.codex` | 기본 MVP |
| local workspace + Codex CLI | local `~/.codex` | source=`cli` 처리 |
| Remote‑SSH + remote Codex CLI | remote `~/.codex` | remote URI discovery/watcher |
| Remote‑SSH + local Codex UI | local 또는 remote 가능 | 실제 process와 cwd 확인 |
| custom `CODEX_HOME` | configured location | 환경변수/설정 우선순위 |
| WSL/dev container | 해당 host의 home | URI scheme와 path normalization |

경로 비교 시 Windows case-insensitive, slash normalization, drive letter case를 처리한다. `session_meta.cwd`가 실제 workspace URI의 `fsPath`와 동일하지 않은 remote 케이스도 있으므로 provider-specific path matcher가 필요하다.

별도 Codex extension을 만들어도 `extensionKind` 선택 문제가 자동으로 사라지지 않는다. 필요 시 장기적으로 local UI companion + remote workspace scanner 구조를 검토할 수 있지만 MVP에서는 과설계다.

---

## 13. 개인정보와 보안

### 필수 원칙

- rollout의 메시지 본문을 status bar 진단 로그에 출력하지 않는다.
- first prompt preview를 기본적으로 표시하지 않는다.
- tool input/output 원문을 저장하거나 telemetry로 보내지 않는다.
- `auth.json`, access token, cookie를 읽지 않는다.
- account usage는 기존 로그인 상태를 app-server가 처리하도록 하고 자격증명을 extension이 복사하지 않는다.
- diagnostic command에는 schema keys, file counts, timestamps, provider state만 표시한다.
- error message에 전체 JSON line을 포함하지 않는다.

### destructive action

현재 Claude workflow panel에는 로그 삭제 기능이 있다. Codex provider에서는 별도 승인을 받은 기능 설계 전까지 session/rollout 삭제를 지원하지 않는다.

---

## 14. 설정과 호환성

### 기존 key 유지

다음 key를 rename하지 않는다.

- `claudeContextBar.*`
- `claudeState.*`
- 기존 command ID `claudeContextBar.*`
- Marketplace extension ID `blueming.claude-state-bar`

rename은 기존 사용자 설정과 command binding을 깨뜨린다.

### 신규 설정 예시

초기에는 기존 namespace 아래 opt-in beta로 두는 것이 가장 작은 변경이다.

```text
claudeContextBar.codex.enabled = false
claudeContextBar.codex.showAccountUsage = true
claudeContextBar.codex.home = ""          # auto when empty
claudeContextBar.codex.includeSubagents = false
```

장기적으로 product-neutral namespace를 만들더라도 기존 key는 alias로 계속 지원한다.

### 설정 패널

권장 section 순서:

```text
General Display & Sounds
Claude Context
Claude Plan & Telegram
Codex Context (Beta)
Codex Usage (Beta)
Diagnostics
```

현재 Claude credential 입력을 Codex 사용자에게 필수처럼 보이게 하지 않는다.

---

## 15. 구현 단계와 완료 기준

### Phase 0 — behavior-preserving refactor

목표:

- 기존 Claude 동작을 바꾸지 않고 parser/discovery/rendering 경계 분리
- 공통 `NormalizedSession`과 provider interface 도입
- `extension.ts`의 크기와 책임 축소

완료 기준:

- `npm run compile` 통과
- 현재 Claude 상태바 text/tooltip 변화 없음
- 기존 완료/질문/workflow 비프 변화 없음
- Remote‑SSH Claude 기능 변화 없음
- 기존 settings와 commands 호환
- README 변경 불필요할 수 있으나 CHANGELOG에는 refactor 성격 기록 검토

### Phase 1 — Codex local context MVP

범위:

- opt-in `codex.enabled`
- local `CODEX_HOME` discovery
- workspace scope와 all scope
- context percentage
- model and effort
- active/idle/hideAfter
- provider badge
- completion beep
- basic diagnostic output

제외:

- rate limit
- approval/question beep
- subagent viewer
- Remote‑SSH 보장
- Codex file deletion

완료 기준:

- Claude-only 사용 시 기존 동작과 성능 유지
- Codex를 켜면 현재 thread가 1분 이내가 아니라 watcher 기반으로 수초 안에 갱신
- cumulative token을 context로 잘못 표시하지 않음
- extension reload 시 과거 completion beep가 울리지 않음
- malformed partial line에서도 extension이 죽지 않음
- 동일 workspace의 Claude/Codex session이 명확히 구분됨

### Phase 2 — Codex usage and activity

범위:

- app-server capability probe
- account rate-limit read
- JSONL fallback과 stale timestamp
- thinking/tool/activity stage
- compact event handling
- provider-specific tooltip

완료 기준:

- `codex` executable이 없어도 context monitor 정상
- app-server timeout이 UI refresh를 block하지 않음
- account usage와 context usage가 명확히 분리됨
- plan/rate-limit 의미를 Claude와 혼동하지 않음

### Phase 3 — Remote‑SSH

범위:

- remote Codex state discovery
- local/remote provider location diagnosis
- watcher reliability
- large rollout performance measurement
- sound remains local

완료 기준:

- 최소 한 개 실제 Remote‑SSH host에서 검증
- remote home auto-detection 실패 시 명확한 setting override 제공
- remote file scan이 UI를 멈추지 않음

### Phase 4 — Codex agent viewer

범위:

- parentThreadId가 명확한 thread tree
- role/nickname 표시
- running/completed/interrupted
- 전체 agent completion beep

제외:

- 부모가 없는 agent를 추측 연결
- Codex rollout 삭제
- 승인 없이 hook 설치

완료 기준:

- root/child 관계가 있는 fixture 통과
- legacy unlinked agent 처리 정의
- running→done transition을 실제 관찰한 경우만 비프

### Phase 5 — public release decision

검토:

- 제품명과 Marketplace description
- README.md와 README.ko.md 전체 동기화
- CHANGELOG
- version bump
- local VSIX install
- F5 runtime test
- Windows/local/Remote matrix
- tag push 전 사용자 명시 승인

---

## 16. 필수 테스트 계획

현재 자동 테스트가 없지만 Codex provider에는 pure parser 테스트를 추가하는 것이 사실상 필수다.

### fixture 종류

1. 최소 Codex session_meta + one turn
2. active turn: task_started only
3. completed turn
4. interrupted/aborted turn
5. multiple token_count records
6. context compact 전후
7. cached token 포함
8. duplicate session_meta
9. unknown record type
10. malformed final line
11. root + thread_spawn subagent
12. legacy guardian without parent
13. no token_count
14. null model_context_window
15. large file incremental append

### regression assertions

- cached token double counting 금지
- cumulative/context 혼동 금지
- first scan completion beep 금지
- workspace path normalization
- hidden session activity 후 auto-unhide
- idle threshold before hideAfter
- provider key collision 방지
- Claude session output unchanged

### privacy requirement for fixtures

- 실제 대화 텍스트 제거
- file paths 익명화
- token/credential 제거
- tool content 최소화
- 구조와 timestamp 관계만 유지

---

## 17. 위험 등록부

| 위험 | 영향 | 대응 |
|---|---|---|
| rollout schema drift | Codex 표시 중단 | tolerant parser, fixtures, diagnostics, feature flag |
| app-server experimental change | rate-limit 조회 실패 | optional integration, JSONL fallback |
| full-file polling | CPU/I/O 증가 | incremental cache, active files 제한 |
| Remote URI mismatch | 세션 누락 | provider path matcher, explicit home override |
| private message leakage | 심각한 개인정보 문제 | minimal field parser, redacted diagnostics |
| completion false beep | UX 신뢰도 하락 | first-scan baseline, task lifecycle gate |
| duplicate items across providers | 혼란 | provider-qualified key and badge |
| old Codex sessions lacking parent ID | agent tree 오표시 | do not infer; unlinked group |
| Codex process unavailable | usage 기능 실패 | context JSONL path independent from app-server |
| one provider crash affects all | Claude 회귀 | provider error isolation and timeout |
| UI namespace remains Claude-specific | product confusion | retain IDs for compatibility; display sections neutral over time |
| public release too early | Marketplace regression | opt-in beta and no tag until validation |

---

## 18. 구현 시 하지 말아야 할 것

1. `findActiveSessions()` 안에 Codex 전체 로직을 추가하지 않는다.
2. `getLatestTokenCount()`를 provider 공통 파서처럼 억지로 확장하지 않는다.
3. `total_token_usage`를 context percentage에 사용하지 않는다.
4. cached input token을 input token에 다시 더하지 않는다.
5. 30초마다 `~/.codex/sessions` 전체를 재귀 스캔하지 않는다.
6. JSONL 메시지 본문을 diagnostic log에 출력하지 않는다.
7. app-server를 기존 VS Code thread의 live tap으로 가정하지 않는다.
8. Codex 기능 때문에 Claude settings key를 rename하지 않는다.
9. Claude primer를 Codex에 복제하지 않는다.
10. Codex session 파일 삭제 기능을 초기 scope에 넣지 않는다.
11. Remote‑SSH를 로컬 동작만 보고 지원 완료로 표시하지 않는다.
12. README 한 언어만 수정하지 않는다.
13. 실제 검증 전에 `v*` tag를 push하지 않는다.

---

## 19. 다음 작업자가 먼저 해야 할 일

Claude Code 또는 다음 구현 에이전트는 다음 순서를 따른다.

1. 이 문서를 전체 정독한다.
2. `git status`, `git log -5`, 현재 tag를 다시 확인한다.
3. 최신 `src/extension.ts`, `package.json`, 양쪽 README를 확인한다.
4. 소스 수정 전에 Phase 0의 정확한 파일 이동/분리 계획을 사용자에게 제시한다.
5. 사용자 승인 후 behavior-preserving refactor부터 진행한다.
6. 리팩터링과 Codex 신규 기능을 가능하면 별도 commit으로 분리한다.
7. Codex parser는 VS Code API에 묶이지 않은 pure module로 작성한다.
8. fixture 테스트를 먼저 만들고 실제 rollout으로 수동 교차 확인한다.
9. local MVP 검증 전 Remote/agent/approval 기능을 동시에 확장하지 않는다.
10. 기능 추가 시 README.md, README.ko.md, CHANGELOG.md를 함께 갱신한다.

### 구현 시작 전 사용자에게 확인할 최소 결정

- Codex beta의 기본값: off 권장
- 상태바 provider 표기 방식
- Claude와 Codex threshold를 공유할지 별도 설정할지
- Codex completion sound를 Claude와 공유할지 별도 sound로 둘지
- Codex-only 사용자까지 공개 대상으로 삼을지

---

## 20. 조사 근거와 참고 링크

Repository evidence:

- [`README.md`](../README.md)
- [`README.ko.md`](../README.ko.md)
- [`CHANGELOG.md`](../CHANGELOG.md)
- [`package.json`](../package.json)
- [`src/extension.ts`](../src/extension.ts)
- [`src/planUsage.ts`](../src/planUsage.ts)
- [`src/credentials.ts`](../src/credentials.ts)
- [`src/blockPrimer.ts`](../src/blockPrimer.ts)
- [`src/workflowPanel.ts`](../src/workflowPanel.ts)
- [`src/settingsPanel.ts`](../src/settingsPanel.ts)

Official references:

- Codex App Server: <https://developers.openai.com/codex/app-server/>
- Codex environment variables and `CODEX_HOME`: <https://learn.chatgpt.com/docs/config-file/environment-variables>
- VS Code Remote Extensions: <https://code.visualstudio.com/api/advanced-topics/remote-extensions>
- VS Code Extension Host: <https://code.visualstudio.com/api/advanced-topics/extension-host>
- VS Code Extension Manifest: <https://code.visualstudio.com/api/references/extension-manifest>

Local verification performed during this review:

- inspected recent `~/.codex/sessions/**/rollout-*.jsonl` structure without reproducing message contents
- generated installed-version app-server TypeScript schemas in a temporary directory
- queried `thread/list` and `account/rateLimits/read`
- verified a separate app-server reports the currently active VS Code thread as `notLoaded`
- inspected active Codex app-server process topology
- confirmed project source version, Git branch, tags, release workflow, source layout, and absence of automated tests

---

# Part II. English

## 21. Purpose and executive decision

This document captures the current **Claude State Bar** product, the observed Codex runtime and storage model, and the decision between:

1. mixing Codex logic directly into the current code,
2. attaching Codex as an isolated provider inside this repository,
3. creating a separate Codex project/extension now, or
4. eventually publishing two extensions backed by a shared core.

### Final recommendation

**Do not create a separate project yet. Attach Codex inside this repository as an isolated provider.**

This does not mean migrating Claude behavior to Codex or adding `if (codex)` branches throughout the existing monolith. The intended architecture is:

```text
Claude session files ─→ ClaudeProvider ─┐
                                        ├─→ NormalizedSession ─→ shared UI / alerts
Codex rollout files  ─→ CodexProvider  ─┘

Claude.ai usage API ─→ ClaudePlanUsage
Codex app-server     ─→ CodexRateLimits (optional, with fallback)
```

The product can remain unified while provider-specific discovery, parsing, lifecycle inference, and capabilities remain isolated.

### Core findings

- Codex support is technically feasible.
- Full one-to-one feature parity with Claude is neither feasible nor desirable.
- A separate repository does not remove the Codex live-event access limitation.
- A second extension would initially duplicate the status bar, sound, settings, localization, Remote handling, diagnostics, packaging, and release work.
- `src/extension.ts` is currently about 3,278 lines; attaching another provider without refactoring would create substantial regression risk.
- Codex rollout records and app-server schemas may change, so capability probing, tolerant parsing, fixture tests, and an opt-in beta gate are required.

---

## 22. Complete current-product inventory

The extension is not only a token counter. It combines four subsystems with different data sources and lifecycle rules.

### 22.1 Claude Code context monitor

Primary files:

- [`src/extension.ts`](../src/extension.ts)
- [`src/debug.ts`](../src/debug.ts)

Current responsibilities:

- discover project directories and JSONL sessions under `~/.claude/projects/`
- filter to the current workspace or include all projects
- recalculate usage after `/clear`
- suppress superseded or ghost sessions
- select context limits by Claude model family
- show per-session context percentage
- show model, effort, `/fast`, and thinking activity
- implement active, idle, dim, and hide-after states
- support manual hide and activity-based auto-unhide
- apply warning and danger thresholds with sound alerts
- detect response completion, explicit questions, and optional stuck tool use
- display up to five recent sessions

Important coupling points:

- `SessionInfo`: around line 15 of `src/extension.ts`
- Claude home resolution: around line 972
- Claude token parsing: around line 1864
- Claude session discovery: around line 2073
- shared rendering and alerts: around line 2447

### 22.2 Claude.ai plan usage

Primary files:

- [`src/planUsage.ts`](../src/planUsage.ts)
- [`src/credentials.ts`](../src/credentials.ts)
- [`src/settingsPanel.ts`](../src/settingsPanel.ts)

Current responsibilities:

- call unofficial Claude.ai usage endpoints
- show five-hour session and weekly utilization
- dynamically render model-scoped weekly limits
- support both the newer `limits` array and legacy buckets
- prefer Electron `net` to pass Cloudflare TLS fingerprinting
- distinguish Cloudflare blocking from actual credential expiry
- store session keys and Telegram tokens in VS Code SecretStorage
- store non-sensitive configuration in global VS Code settings
- log schema keys when the unofficial API changes

This is Claude-specific and must remain separate from Codex context monitoring.

### 22.3 Workflow and Task-agent viewer

Primary files:

- the workflow parsing region of [`src/extension.ts`](../src/extension.ts)
- [`src/workflowPanel.ts`](../src/workflowPanel.ts)

Current responsibilities:

- parse Claude workflow `journal.jsonl` files
- scan `subagents/workflows/<wfId>/`
- parse flat Task-agent logs and metadata
- group Task agents into time-based batches
- classify agents as running, done, or stopped
- detect `[Request interrupted]`
- recognize short final answers with settle-based completion
- reconstruct role labels and full task descriptions
- show current and complete step histories
- play a workflow-completion sound
- delete completed Claude workflow or Task logs from the UI

The panel can be reused, but the data model and parser are Claude-specific. Codex needs its own thread-tree builder.

### 22.4 Claude five-hour block automation

Primary files:

- [`src/blockPrimer.ts`](../src/blockPrimer.ts)
- the plan/reset section of [`src/extension.ts`](../src/extension.ts)
- [`src/credentials.ts`](../src/credentials.ts)

Current responsibilities:

- detect a Claude five-hour block closing
- send Telegram reset notifications
- optionally run `claude -p` in a dedicated temporary directory
- anchor the next five-hour block near the reset time
- prevent duplicate firing across multiple VS Code windows with an atomic lock
- refuse to fire when Anthropic API-key environment variables create billing risk
- verify the result through `sessionResetAt ≈ now + 5h`
- catch an overnight reset on the first poll after waking

This subsystem depends on Claude subscription semantics and must not be cloned for Codex.

### 22.5 Shared product infrastructure

The following should become provider-neutral reusable infrastructure:

- status-bar item lifecycle
- project colors
- compact mode and custom short names
- warning and danger thresholds
- idle dimming and hide-after behavior
- hide/restore QuickPick actions
- audio playback and gain control
- completion debounce and first-scan baselining
- WebView settings infrastructure
- English/Korean localization
- Output Channel diagnostics
- old-extension cleanup and zombie status-item recovery

---

## 23. Repository and release state

Verified at review time:

- branch: `main`
- HEAD: `ce1933d`
- source version: `1.7.43`
- tracked branch synchronized with `origin/main`
- highest observed tag: `v1.7.33`
- any pushed `v*` tag triggers packaging, GitHub Release creation, VS Marketplace publishing, and Open VSX publishing
- `AGENTS.md` was untracked and was not modified by this documentation task
- there are no automated tests
- runtime validation uses a VS Code Extension Development Host (F5)
- the extension is forced to the UI extension host with `extensionKind: ['ui']`

Operational rules:

- source version and published tag state are separate facts
- re-check tags and Marketplace state before any release
- every user-visible behavior change must update both `README.md` and `README.ko.md`
- every release must update `CHANGELOG.md`
- never push a release tag without explicit approval and completed validation

---

## 24. Observed Codex local-state model

### 24.1 State root

The official default is `CODEX_HOME=~/.codex`, but users can override it. Do not hardcode only `os.homedir()/.codex`.

Relevant local structure observed during this review:

```text
~/.codex/
  sessions/YYYY/MM/DD/rollout-*.jsonl
  archived_sessions/
  session_index.jsonl
  state_*.sqlite
  logs_*.sqlite
  config.toml
  auth.json
```

Privacy boundary:

- rollout JSONL can contain full prompts, developer instructions, assistant output, and tool input/output
- never read or log `auth.json`
- parse only the fields required for the feature
- do not log user text or raw JSON records

### 24.2 Rollout record categories

Observed top-level record types:

- `session_meta`
- `turn_context`
- `event_msg`
- `response_item`
- `world_state`

Observed `event_msg.payload.type` values include:

- `task_started`
- `task_complete`
- `token_count`
- `thread_settings_applied`
- `user_message`
- `agent_message`
- `context_compacted`
- `turn_aborted`
- several patch, tool, and web completion events

Observed `response_item.payload.type` values include:

- `message`
- `reasoning`
- `custom_tool_call`
- `custom_tool_call_output`

### 24.3 Session metadata

Useful `session_meta.payload` fields:

- `id` / `session_id`
- `timestamp`
- `cwd`
- `originator`
- `cli_version`
- `source`
- `thread_source`
- `model_provider`
- `context_window`
- `git`

Because `cwd` is explicit, Codex workspace matching does not require Claude's encoded-directory path reconstruction heuristic.

### 24.4 Model and effort

Useful `turn_context.payload` fields:

- `turn_id`
- `cwd`
- `model`
- `effort`
- `approval_policy`
- `sandbox_policy`
- `collaboration_mode`
- `multi_agent_mode`
- `summary`

Use the latest turn context. Unlike the current Claude implementation, do not assume that effort is a single global setting shared by every session.

### 24.5 Token semantics

The observed token-count structure is:

```text
payload.info.total_token_usage
payload.info.last_token_usage
payload.info.model_context_window
payload.rate_limits
```

Correct context calculation:

```text
contextUsed = last_token_usage.total_tokens
contextLimit = model_context_window
percentage = round(contextUsed / contextLimit * 100)
```

Incorrect calculation:

```text
total_token_usage.total_tokens / model_context_window
```

`total_token_usage` is cumulative across calls and can greatly exceed the model context window. Also, cached input is already represented within input usage semantics; do not add `cached_input_tokens` to `input_tokens` again.

Recommended tooltip semantics:

- Current context total: `last.totalTokens`
- Input: `last.inputTokens`
- Cached portion: `last.cachedInputTokens`
- Output: `last.outputTokens`
- Reasoning output: `last.reasoningOutputTokens`
- Cumulative usage: `total.totalTokens`, clearly separated from context occupancy

### 24.6 Active and completed states

Recommended file-based algorithm:

1. Track the newest `task_started` timestamp.
2. Track the newest terminal event such as `task_complete`, `turn_aborted`, or a failure.
3. If task start is newer, the session is active.
4. If a terminal event is newer, it is completed or idle.
5. Treat a malformed final line as an incomplete concurrent write and retry it on the next refresh.

Codex `task_complete` provides a more direct completion signal than Claude's `assistant.stop_reason=end_turn` heuristic. Existing completions must still be silently baselined on extension activation.

### 24.7 Compaction

Prefer explicit compaction records such as `context_compacted`. A sharp drop in latest context usage may be used as a diagnostic fallback but should not override explicit lifecycle events.

### 24.8 Subagents

Generated app-server types expose:

- `Thread.parentThreadId`
- `Thread.sessionId`
- `Thread.agentNickname`
- `Thread.agentRole`
- thread-spawn parent ID, depth, and agent path

However, an older observed guardian session only exposed an unlinked `other='guardian'` source. Therefore:

- build trees only when parent relationships are explicit
- never infer a parent from timestamps or cwd alone
- show unlinked agents separately or omit them until a safe UX is defined

---

## 25. Codex app-server findings

### 25.1 Available protocol surface

The app-server exposes JSON-RPC methods and notifications for threads, turns, token usage, account rate limits, item lifecycle, approvals, user-input requests, configuration, and account state.

Generate bindings for the installed version with:

```powershell
codex app-server generate-ts --out <temporary-directory>
codex app-server generate-json-schema --out <temporary-directory>
```

The generated schema is version-specific.

### 25.2 Local verification

A read-only app-server probe confirmed:

- `thread/list` returns thread metadata, cwd, source, and rollout path
- `account/rateLimits/read` returns plan and rate-limit windows
- a thread actively running in the existing Codex VS Code extension appears as `notLoaded` to a separately launched app-server

Process inspection showed separate private stdio app-server processes for Codex desktop and individual Codex VS Code extension instances. A new process is not a passive event tap into those existing clients.

### 25.3 Recommended hybrid

```text
Live session/context/activity
  → rollout JSONL watcher and incremental parser

Account rate limits
  → optional app-server account/rateLimits/read
  → fallback to the latest rate-limit snapshot observed in rollout JSONL
```

Do not launch app-server every 30 seconds. Keep app-server optional, isolated by timeout, and incapable of breaking JSONL context monitoring.

---

## 26. Feature-support matrix

| Existing feature | Codex feasibility | Recommended implementation |
|---|---:|---|
| workspace session discovery | High | match `session_meta.cwd` |
| all-project discovery | High | recent date directories plus cache/index |
| context percentage | High | latest usage divided by model context window |
| model | High | latest turn context |
| reasoning effort | High | latest turn context |
| `/fast` speed | No proven direct equivalent | display only if an explicit field is discovered |
| thinking indicator | Medium | reasoning/item flow, labeled as best effort where needed |
| active elapsed time | High | task/item lifecycle |
| idle/hide-after | High | reuse shared behavior |
| threshold alerts | High | reuse shared alert coordinator |
| completion sound | High | `task_complete` plus first-scan baseline |
| explicit question sound | Medium | request-user-input record or optional hook bridge |
| approval wait sound | Limited | exact only inside the owning app-server client |
| stuck tool heuristic | Medium | unmatched call/output with false-positive warning |
| workflow viewer | Requires new provider | build a Codex thread tree |
| agent completion sound | Medium | only for explicit parent-linked agents |
| workflow log deletion | Not recommended | do not expose for Codex initially |
| Claude plan usage | Not applicable | separate Codex rate-limit section |
| Telegram reset alert | Different semantics | design separately around Codex windows/thresholds |
| automatic block primer | Not applicable | do not clone |
| Remote-SSH | Plausible, unverified | real-host validation required |
| compact mode/colors/hide | High | reuse shared UI |
| settings and localization | High | add provider-specific sections |

---

## 27. Product-boundary decision

### Why not a separate extension now

A second extension does not solve:

- inability to subscribe to another Codex client's private app-server stream
- rollout schema drift
- Remote state-location uncertainty
- imperfect approval and question signals
- missing legacy parent relationships

It would duplicate:

- status-bar lifecycle
- sound and gain logic
- colors and thresholds
- hide and restore flows
- settings WebView
- localization
- Remote filesystem support
- diagnostics
- packaging and release maintenance

### Why an isolated provider in the current extension is preferable

- unified view for users who run both Claude and Codex
- immediate reuse of mature UI and alert behavior
- provider badges can distinguish sessions from the same repository
- the Codex beta can remain disabled by default
- failure can be contained within the Codex provider
- real product value can be validated before creating another Marketplace listing

### When to split later

Reconsider a separate extension when:

1. Codex requires a persistent daemon or background companion.
2. Exact waits require managed Codex hook installation.
3. Claude and Codex require incompatible extension-host placement.
4. Codex schema churn repeatedly threatens Claude stability.
5. a distinct Codex-only Marketplace audience becomes a product objective.
6. provider-specific code outgrows the shared core.
7. users reject a combined settings and credential surface.

The future split should use a shared package rather than copied code:

```text
packages/shared-core
extensions/claude-state-bar
extensions/codex-state-bar
```

---

## 28. Recommended architecture

Suggested logical modules:

```text
src/providers/types.ts
src/providers/claude/sessionProvider.ts
src/providers/claude/workflowProvider.ts
src/providers/codex/sessionProvider.ts
src/providers/codex/rolloutParser.ts
src/providers/codex/usageProvider.ts
src/providers/codex/agentTree.ts
src/core/sessionRegistry.ts
src/core/sessionRenderer.ts
src/core/alertCoordinator.ts
src/core/fileTailCache.ts
```

Required shared concepts:

- provider-qualified session keys
- normalized token usage
- normalized lifecycle state
- provider capabilities
- provider-specific worktree/workspace path matching
- error isolation and timeouts

Build menus from capabilities rather than repeated provider conditionals. A Codex session must never expose Claude workflow deletion or block-primer actions.

---

## 29. Discovery, performance, and parsing

### Initial discovery

- resolve `CODEX_HOME`
- scan only recent date directories initially
- use file age and hide-after to avoid old rollouts
- parse `session_meta.cwd` before reading the full active file
- register only active/recent files in the parser cache
- add files through watchers as new dates and sessions appear

`session_index.jsonl` did not contain enough cwd/path information in the observed version to serve as the only discovery source. app-server `thread/list` can assist initial discovery but must remain optional.

### Incremental parsing

- cache a byte offset and incomplete-line carry per file
- parse only appended records where possible
- reset the cache if a file shrinks
- ignore unknown records
- retry an incomplete final record later
- avoid materializing message bodies
- limit full remote reads to a small set of active files

Because `vscode.workspace.fs` does not offer a generic byte-range API, use a reader abstraction and measure local versus Remote performance before claiming Remote support.

### Failure behavior

- one malformed file must not fail the refresh
- one provider failure must not remove the other provider's items
- app-server failure must not disable file-based context monitoring
- missing context limits should show an unavailable state, not zero percent

---

## 30. Remote-SSH

The current extension uses `extensionKind: ['ui']`, runs in the local UI extension host, and reads remote Claude files through `vscode.workspace.fs` and a `vscode-remote://` URI.

Codex validation matrix:

- local workspace with Codex VS Code
- local workspace with Codex CLI
- Remote-SSH with remote Codex CLI
- Remote-SSH with local Codex UI
- custom `CODEX_HOME`
- WSL or dev containers

Path matching must normalize Windows drive-letter case, slashes, and URI differences. Remote support is not complete until verified against a real Remote-SSH host.

---

## 31. Privacy and security requirements

- never log rollout message content
- do not show first-prompt previews by default
- never copy or inspect Codex credentials
- do not read `auth.json`
- do not emit raw JSON records in errors
- keep diagnostics structural and redacted
- do not delete Codex sessions or rollouts in the initial implementation
- let app-server use the existing Codex login rather than handling access tokens in this extension

---

## 32. Compatibility and settings

Keep all existing identifiers:

- `claudeContextBar.*`
- `claudeState.*`
- existing `claudeContextBar.*` command IDs
- Marketplace ID `blueming.claude-state-bar`

Possible beta settings:

```text
claudeContextBar.codex.enabled = false
claudeContextBar.codex.showAccountUsage = true
claudeContextBar.codex.home = ""
claudeContextBar.codex.includeSubagents = false
```

Suggested settings-panel organization:

```text
General Display & Sounds
Claude Context
Claude Plan & Telegram
Codex Context (Beta)
Codex Usage (Beta)
Diagnostics
```

Claude credentials must not appear to be required for Codex-only monitoring.

---

## 33. Implementation phases and acceptance criteria

### Phase 0: behavior-preserving refactor

- extract provider interfaces and a normalized session model
- isolate current Claude discovery and parsing
- isolate shared rendering and alert coordination
- preserve all existing behavior and settings

Acceptance:

- compilation succeeds
- Claude UI and alert behavior remain unchanged
- Remote Claude support remains unchanged
- existing commands and settings remain compatible

### Phase 1: local Codex context MVP

Include:

- opt-in enablement
- local Codex discovery
- workspace and all-project scope
- context percentage
- model and effort
- active, idle, and hide-after states
- provider badge
- completion sound
- structural diagnostics

Exclude:

- account rate limits
- approval/question sounds
- subagent viewer
- guaranteed Remote support
- Codex file deletion

Acceptance:

- Claude-only performance and behavior do not regress
- active Codex updates appear promptly through the watcher
- cumulative usage is never shown as context occupancy
- reload does not play sounds for historical completions
- incomplete JSON writes do not crash the extension

### Phase 2: Codex usage and richer activity

- app-server capability probe
- account rate-limit query
- JSONL fallback and stale timestamps
- reasoning/tool activity display
- explicit compaction handling

Acceptance:

- missing Codex executable does not break context monitoring
- app-server timeout never blocks the UI refresh loop
- account usage and context occupancy are visibly separate

### Phase 3: Remote-SSH

- remote state discovery
- local versus remote host diagnosis
- watcher reliability and large-rollout performance tests
- local audio verification

Acceptance:

- verified on at least one real Remote-SSH host
- explicit home override for failed auto-detection
- no UI stalls during remote scans

### Phase 4: Codex agent viewer

- explicit parent-linked tree only
- roles, nicknames, and lifecycle state
- transition-based all-agent completion sound
- safe handling of unlinked legacy agents

### Phase 5: public-release decision

- decide combined branding versus later split
- update both READMEs and CHANGELOG
- bump version
- package and install local VSIX
- run F5 and platform tests
- obtain explicit approval before pushing a release tag

---

## 34. Required tests

Add pure parser fixtures for:

1. minimal session metadata and one turn
2. active task
3. completed task
4. interrupted/aborted task
5. multiple token-count records
6. context compaction
7. cached input
8. duplicate metadata records
9. unknown record types
10. malformed final line
11. root and linked subagent
12. unlinked legacy guardian
13. no token-count record
14. null context window
15. large incremental append

Regression assertions:

- no cached-token double counting
- no cumulative/context confusion
- no historical completion beep on activation
- correct path normalization
- correct auto-unhide behavior
- idle always precedes full hiding
- no provider key collision
- no Claude output regression

All fixtures must remove real conversation text, credentials, and identifying paths.

---

## 35. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| rollout schema drift | Codex display failure | tolerant parser, fixtures, diagnostics, feature flag |
| experimental app-server changes | usage failure | optional integration and JSONL fallback |
| full-file polling | CPU and I/O growth | incremental cache and active-file limits |
| Remote URI mismatch | missing sessions | provider matcher and explicit home override |
| message leakage | severe privacy issue | minimal parsing and redacted diagnostics |
| false completion sounds | loss of trust | lifecycle gate and first-scan baseline |
| provider item collision | confusing UI | provider-qualified keys and badges |
| missing legacy parent link | incorrect agent tree | never infer; separate unlinked agents |
| missing Codex executable | usage unavailable | keep JSONL context path independent |
| one provider crashes all | Claude regression | provider error isolation |
| Claude-specific branding | product confusion | preserve IDs, gradually neutralize display sections |
| early release | Marketplace regression | opt-in beta, complete validation, no tag push |

---

## 36. Explicit do-not-do list

1. Do not place all Codex logic inside `findActiveSessions()`.
2. Do not turn `getLatestTokenCount()` into a provider-switching parser.
3. Do not use cumulative token usage as context occupancy.
4. Do not add cached tokens to input tokens a second time.
5. Do not recursively rescan all Codex sessions every refresh.
6. Do not log rollout message bodies.
7. Do not treat a new app-server as a live observer of existing Codex VS Code processes.
8. Do not rename existing Claude settings or command IDs.
9. Do not clone the Claude block primer for Codex.
10. Do not add Codex session deletion to the first implementation.
11. Do not claim Remote support after local-only testing.
12. Do not update only one README language.
13. Do not push a `v*` tag before explicit release approval.

---

## 37. Handoff checklist for the next Claude Code session

1. Read this document in full.
2. Re-check Git status, recent commits, and tags.
3. Re-read the current `extension.ts`, `package.json`, and both READMEs before editing.
4. Present the exact Phase 0 extraction scope to the user before modifying source.
5. Begin with behavior-preserving refactoring only after approval.
6. Keep refactoring and new Codex behavior in separate commits when possible.
7. Make the Codex parser a pure module independent of VS Code APIs.
8. Add sanitized fixtures before relying on manual rollout inspection.
9. Validate the local MVP before expanding into Remote, agents, or approvals.
10. Update both READMEs and CHANGELOG for every user-visible feature.

Minimum user decisions before implementation:

- whether Codex beta defaults to off (recommended)
- provider badge format
- shared versus provider-specific thresholds
- shared versus provider-specific completion sound
- whether the public target includes Codex-only Marketplace users

---

## 38. Evidence and references

Repository evidence:

- [`README.md`](../README.md)
- [`README.ko.md`](../README.ko.md)
- [`CHANGELOG.md`](../CHANGELOG.md)
- [`package.json`](../package.json)
- [`src/extension.ts`](../src/extension.ts)
- [`src/planUsage.ts`](../src/planUsage.ts)
- [`src/credentials.ts`](../src/credentials.ts)
- [`src/blockPrimer.ts`](../src/blockPrimer.ts)
- [`src/workflowPanel.ts`](../src/workflowPanel.ts)
- [`src/settingsPanel.ts`](../src/settingsPanel.ts)

Official references:

- Codex App Server: <https://developers.openai.com/codex/app-server/>
- Codex environment variables and `CODEX_HOME`: <https://learn.chatgpt.com/docs/config-file/environment-variables>
- VS Code Remote Extensions: <https://code.visualstudio.com/api/advanced-topics/remote-extensions>
- VS Code Extension Host: <https://code.visualstudio.com/api/advanced-topics/extension-host>
- VS Code Extension Manifest: <https://code.visualstudio.com/api/references/extension-manifest>

Local checks performed for this review:

- inspected the structure of recent rollout JSONL files without reproducing message content
- generated TypeScript app-server schemas for the installed Codex version in a temporary directory
- queried `thread/list` and `account/rateLimits/read`
- verified that a separate app-server sees the currently active VS Code thread as `notLoaded`
- inspected active app-server process topology
- verified source version, branch, tags, release workflow, source layout, and the current lack of automated tests

---

## 39. Final decision statement

Proceed in this repository, not in a new project, but treat Codex as a separately owned provider with its own parser, lifecycle rules, usage semantics, capability flags, diagnostics, and tests.

The goal is not “port every Claude feature to Codex.” The goal is “connect the equivalent signals Codex actually exposes to the mature shared UI without weakening the existing Claude product.”

Revisit a separate Codex extension only after the local attach proves useful and one of the explicit split conditions in this document becomes true.
