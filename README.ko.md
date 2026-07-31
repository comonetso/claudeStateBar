# Claude State Bar

**Claude Code 컨텍스트 사용량 + Claude.ai 플랜 사용량(5시간 세션 & 주간) — 이제 OpenAI Codex 세션까지 — 를 VS Code 상태바에서 한눈에. 실시간 워크플로우/에이전트 뷰어 패널, 사운드 알림, Remote‑SSH 지원, 텔레그램 리셋 알림, 한/영 설정 패널 포함.**

🇬🇧 English: [README.md](README.md)

---

## 상태바 안의 두 계층

Claude State Bar는 서로 보완되는 두 가지를 보여주며, 하나의 호버 툴팁 안에서 섹션으로 명확히 구분됩니다.

### 🧠 claudeContext — Claude Code 컨텍스트 모니터
Claude Code의 세션 로그(`~/.claude/projects/*.jsonl`)를 읽어 활성 세션별로 표시:
- **실시간 컨텍스트 사용량 %** (사용 토큰 vs 모델 한도)
- **세션별 모니터링** — Claude Code 세션마다 독립 상태바 아이템
- **모델 인식 한도** — Opus 4.x, Fable/Mythos, Sonnet 4.6+/5+, ID에 `1m`이 포함된 모델 → 1,000,000 토큰, 그 외(Sonnet 4.5 이하, Haiku 등) → 200,000 (설정 가능)
- **모델 + Effort + 속도** — 예: `Opus 4.7 · xHigh⁺ · ⚡fast` ([Effort 표시](#️-effort-레벨-표시) 참조)
- **색상 경고** — 정상 / 경고(≥50%) / 위험(≥75%) 배경색
- **2단계 idle** — `idleTimeout`(기본 180초) 후 흐려지고, `hideAfter` 후 완전히 숨김
- **유령 세션 감지** — `/clear`나 탭 종료 후 오래된 세션 숨김, 새 활동 시 자동 복원
- **컴팩트 모드 & 커스텀 약칭** — `my-cool-project → MCP`, `typescript → Tscript`
- **실시간 활동 표시** — Claude 사고(🤔) 또는 응답 중 경과초 표시

### 📊 claudeState — Claude.ai 플랜 사용량
계정 전역 플랜 사용량을 claude.ai에서 직접 가져옵니다(SDK·별도 서비스 없음):
- **5시간 세션 한도 %** + 리셋 카운트다운 (첫 세션 아이템에 합쳐 표시)
- **주간 사용량 %**, 툴팁에 모델별 분해 (**Fable / Opus / Sonnet** — claude.ai가 현재 내려주는 모델을 그대로 표시)
- **세션 리셋 감지** → 5시간 창이 리셋되면 선택적 **텔레그램** 알림
- 자격증명(Session Key, Bot Token)은 VS Code SecretStorage로 **암호화** 저장

이 두 계층은 모두 **Claude** 세션 이야기이며, 상태바에서 **✳** 접두사로 표시됩니다. Codex 세션은 **⬢** 접두사입니다 — [OpenAI Codex 세션 모니터링](#-openai-codex-세션-모니터링-phase-1) 참조.

---

## ⬢ OpenAI Codex 세션 모니터링 (Phase 1)

이제 상태바에 **Claude 세션과 OpenAI Codex 세션이 동시에** 표시됩니다. 구분은 아이콘 접두사로 합니다:

- **✳** — Claude 세션
- **⬢** — Codex 세션

Codex **컨텍스트** 데이터의 출처는 파일뿐입니다: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — 로컬 머신, 또는 Remote‑SSH 창에서는 원격 호스트의 파일입니다. 네트워크 호출이 없습니다. **계정 사용량**은 경로가 다릅니다 — Codex app‑server에서 실시간으로 조회합니다(아래 참조).

### Codex 아이템에 표시되는 것

- **컨텍스트 사용률 %** — 최신 `last_token_usage.total_tokens` ÷ `model_context_window`
- **모델명** — 예: `gpt-5.6-sol` → `GPT-5.6 Sol` (컴팩트 모드에서는 `G5.6s`)
- **Effort** — Low / Medium / High / xHigh 등
- **idle 흐림 & `hideAfter` 숨김** — Claude와 완전히 동일한 규칙
- **완료 비프** — Codex의 `task_complete` 이벤트 기반. Claude의 완료 비프와 **동일한 사운드·임계값 설정을 공유**합니다 — Codex 전용 사운드 설정은 없습니다.
- **툴팁** — Codex 계정 사용량(Primary/Secondary 한도, 갱신 시각, 플랜 종류) + 컨텍스트 토큰 내역 + 실행 주체

### Codex 계정 사용량 (rate limit)

**Codex app‑server에서 실시간으로** 읽습니다. 확장이 `codex app-server` 프로세스를 잠깐 띄워 JSON‑RPC로 `account/rateLimits/read`를 요청합니다 — 실측 왕복 시간 약 **0.6~0.9초**.

이 조회는 **세션 갱신(30초)과 분리된 별도의 느린 타이머**로 돕니다. `claudeState.refreshIntervalSec` 값을 공유하되 **최소 60초**로 제한되므로, 매 30초 폴링마다 프로세스를 띄우지 않습니다. Claude가 claude.ai 사용량 API를 주기적으로 호출하는 것과 정확히 대칭인 구조입니다.

**왜 로그가 아니라 실시간인가?** Codex 한도는 **7일 롤링 윈도우**라서, Codex를 쓰지 않아도 실제 값이 스스로 내려갑니다. 로그 스냅샷만 읽으면 Codex를 며칠 안 쓸 때 값이 그대로 굳어버립니다.

**폴백 순서:**

1. app‑server 실시간 조회
2. 실패하면 해당 세션 rollout 로그의 `rate_limits` 스냅샷
3. 그것도 없으면 마지막 성공값에 **"오래된 값"** 표시
4. 전부 없으면 사용량을 표시하지 않음

툴팁에는 **관측 시각 옆에 출처가 함께** 표시됩니다 — `실시간`, 또는 `세션 로그`.

> 기존의 "Codex가 실제로 작업 중일 때만 갱신된다"는 단서는 이제 **폴백(2단계)에만** 해당합니다. rollout 스냅샷은 Codex가 작업할 때 기록되므로, idle 세션의 스냅샷은 오래된 값이 됩니다.

Codex 계정 사용량은 Claude의 5시간 / 주간 플랜 사용량과는 **별개 개념**입니다. 각 provider의 사용량은 자기 provider의 첫 세션 아이템에만 병합되어 표시됩니다.

### Codex 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.codex.enabled` | `true` | Codex 세션 표시 on/off. Codex 미설치 시 즉시 no‑op이라 비용이 없습니다. |
| `claudeContextBar.codex.home` | `""` | Codex 상태 디렉터리. 비우면 자동 탐지(`$CODEX_HOME` → `~/.codex`). **명시했는데 경로가 없으면 자동 폴백하지 않고 아무것도 표시하지 않으며, 이유를 로그에 남깁니다.** |
| `claudeContextBar.codex.scanDays` | `3` | `sessions/YYYY/MM/DD` 중 최근 며칠치 폴더만 스캔할지. 전체 히스토리는 절대 재귀 스캔하지 않습니다. |

그 밖의 설정은 **Claude와 Codex가 공유**합니다 — 경고/위험 임계값, 사운드, `compactMode`, `idleTimeout`, `hideAfter`, `scope` 등. Codex 전용 임계값·사운드 설정은 없습니다.

### 알려진 한계 (Phase 1)

- **각 창은 자기 호스트의 Codex 세션만 봅니다** — Remote‑SSH 창에는 **원격 호스트의** Codex 세션만 표시되고, 로컬 PC에서 돌린 Codex는 보이지 않습니다(반대로 로컬 창에는 로컬 Codex만). **Claude도 정확히 동일하게 동작하므로 일관적입니다.** Remote‑SSH 자체는 지원합니다 — 아래 Remote‑SSH 지원 섹션 참조.
- **워크플로우 / 서브에이전트 뷰어 없음** — Codex에는 Claude의 워크플로우 저널에 해당하는 구조가 아직 없어서, Codex 세션을 클릭해도 워크플로우 메뉴가 나오지 않습니다.
- **Codex 서브에이전트 세션은 표시되지 않음** — `source`가 subagent인 rollout은 제외됩니다.
- **질문 대기 비프 / 멈춤 감지 없음** — Codex에는 해당 신호가 없습니다.
- **Codex 로그 삭제 기능 없음.**
- **계정 사용량은 Remote‑SSH 창에서도 *로컬*의 `codex`로 조회합니다** — 실시간 조회는 **로컬** `codex` 실행 파일을 실행하므로, 원격 창에서도 로컬 계정 기준 값이 나옵니다. 같은 ChatGPT 계정이면 값이 동일하지만, 다른 계정이면 다를 수 있습니다. (컨텍스트 모니터링은 원격 파일을 정확히 읽으므로 이와 무관합니다.)
- **`codex` 실행 파일이 없거나 app‑server 조회가 실패해도 컨텍스트 모니터는 정상 동작합니다** — 사용량만 로그 스냅샷으로 폴백합니다. 조회에는 **15초 타임아웃**이 있고, 조회용 프로세스는 매번 정리됩니다(프로세스 누수 없음을 실측 확인).

### 개인정보

Codex rollout 로그에는 대화 원문 전체가 들어 있지만, 이 확장은 **구조적 필드(토큰 수, 타임스탬프, 모델명)만** 읽습니다. 메시지 본문은 읽지도, 저장하지도, 로그에 남기지도 않습니다. `auth.json`은 절대 접근하지 않습니다.

---

## 🌐 Remote‑SSH 지원

**Remote‑SSH** 환경에서도 두 가지를 동시에 합니다. Claude State Bar는 **UI(로컬) 확장**으로 실행됩니다:

- **플랜 사용량**은 **로컬 PC**의 Electron 네트워크 스택으로 가져옵니다 — Cloudflare 봇 챌린지를 통과합니다. (원격/헤드리스 호스트의 순수 Node `https`는 Cloudflare `403`을 받고, AWS EC2 같은 클라우드·데이터센터 IP는 TLS 핑거프린트와 무관하게 차단됩니다.)
- **토큰 카운트**는 **원격** 호스트의 `~/.claude/projects`를 `vscode.workspace.fs`로 읽습니다. VS Code가 SSH 너머로 자동 라우팅합니다. 원격 홈은 자동 탐색(`/root`, 없으면 `/home/*`)합니다.

**로컬에 한 번 설치하면 모든 Remote‑SSH 창에 자동 적용됩니다.** `ui`-kind 확장이므로 서버마다 재설치할 필요가 없습니다.

Remote‑SSH 창에서 **원격 세션 토큰 사용량과 플랜 사용량을 한곳에서** 봅니다. 호스트가 claude.ai에 도달할 수 없으면 오해를 주는 "만료" 오류 대신 "이 환경에선 플랜 사용량 불가"라는 정직한 안내가 표시됩니다(Session Key는 정상).

### Remote‑SSH에서의 Codex

**Codex도 지원합니다 — Claude와 동일한 방식입니다.** 확장은 여전히 로컬에서 실행되지만, `vscode.workspace.fs`로 **원격** 호스트의 파일을 읽고 VS Code가 SSH 연결 너머로 라우팅합니다. 원격 홈은 `/root`와 `/home/*` 아래에서 `.codex/sessions`가 실제로 존재하는 곳을 탐색해 찾습니다 — `.claude/projects`를 찾는 방식과 동일합니다. 파일 감시자도 원격에서 동작하므로 원격 Codex 세션 역시 수초 내에 갱신됩니다.

**읽기 방식의 차이 한 가지(성능 참고):** 로컬에서는 파일의 필요한 구간만(byte‑range) 읽어서 14.1MB짜리 rollout도 수 밀리초면 끝납니다. Remote‑SSH에서는 VS Code 파일 API에 구간 읽기가 없어 **파일 전체**를 읽습니다. 이는 Claude가 원격에서 이미 하고 있는 것과 동일한 방식이며(이 개발 머신의 Claude 세션 파일 최대 크기는 9.2MB), 여기에 더해 Codex에는 Claude에 없는 최적화가 있습니다 — **rollout의 mtime과 크기가 그대로면 읽기를 아예 건너뜁니다**. 안전장치로, 원격에서 **32MB를 넘는** rollout 파일은 건너뛰고 로그에 남깁니다.

로컬 경로와 원격 경로가 동일한 결과를 내는지 검증했습니다 — 같은 rollout 데이터에 대해 5개 세션 × 12개 필드 전부 일치했습니다.

⚠️ 단, 원격 창에는 **원격 호스트의** Codex 세션만, 로컬 창에는 로컬 세션만 표시됩니다. 이 점도 Claude와 동일합니다.

⚠️ **계정 사용량만 예외입니다:** 실시간 rate limit 조회는 **로컬**의 `codex`를 실행하므로, 원격 창에서도 사용량 수치는 **로컬** 계정 기준입니다. 같은 ChatGPT 계정이면 값이 동일하고, 다른 계정이면 다를 수 있습니다. 컨텍스트 모니터링은 이와 무관합니다.

---

## 🎬 워크플로우 & Task 에이전트 뷰어 패널

세션 QuickPick 메뉴에서 **워크플로우 뷰어**를 열면 활성 Claude Code 워크플로우와 Task(Agent 도구) 서브에이전트를 실시간으로 보여주는 WebView 패널이 열립니다:

- **워크플로우 진행 상황** — 각 워크플로우가 카드로 표시되며 페이즈, 실행 중/완료 에이전트, 에이전트별 요약, 경과 시간, 실시간 활동이 보임
- **결과 전체 펼치기** — 긴 최종 보고서는 `▶ 요약` 토글로 접혀 있어 필요할 때 전체를 읽을 수 있음
- **역할 라벨** — 각 에이전트의 역할이 프롬프트 헤더에서 자동 추출됨. "에이전트-1" 대신 의미 있는 이름으로 표시
- **Task(Agent 도구) 서브에이전트** — Agent 도구로 실행된 서브에이전트를 **시작 시각 기준 배치로 묶어** 별도 표시 (5분 이상 간격이면 새 배치)
- **배치별 🗑 정리** — 특정 배치의 완료된 Task 에이전트 로그만 삭제, 실행 중인 에이전트는 보존
- **Details 열림 유지** — 실시간 재렌더 중에도 펼쳐진 `<details>` 패널 상태 유지
- **글꼴 크기 조절** — `A−` / `A+` 버튼으로 패널 글자 크기 조절
- **한/영 UI** — 설정 패널과 동일한 EN / 한국어 전체 토글

---

## 🎚️ Effort 레벨 표시

상태바와 툴팁에 Claude Code의 현재 effort 레벨이 표시됩니다:

| `effortLevel` 값 | 상태바 표시 | 의미 |
|---|---|---|
| `xhigh` | `xHigh⁺` | xhigh가 디스크에 영속. `/ultracode` 활성화 시 dynamic workflows는 런타임 전용이라 순수 xhigh와 구분 불가 — `⁺`가 이 근사를 표시. |
| `ultracode` / `ultra` | `🚀 Ultra` | 세션 스코프 ultracode 플래그가 런타임에 감지될 때 표시. |
| `high` / `medium` / `low` / `max` | 그대로 표시 | 표준 effort 레벨 |

추가 속도 표시:
- **⚡** — `/fast` 모드 활성화
- **💭** — 최근 응답에 `thinking` 블록 포함 (확장 사고)

---

## 🔔 사운드 알림

Claude State Bar는 주요 이벤트에 설정 가능한 WAV 사운드를 재생합니다:

| 이벤트 | 기본 사운드 | 관련 설정 |
|---|---|---|
| 컨텍스트가 경고 임계값 도달 | `Ring01.wav` | `soundWarning` / `soundWarningGain` |
| 컨텍스트가 위험 임계값 도달 | `Ring02.wav` | `soundDanger` / `soundDangerGain` |
| Claude가 응답 완료 (`end_turn`) | `tada.wav` | `soundCompletion` / `soundCompletionGain` |
| Claude가 질문하려고 멈춤 | `Speech On.wav` | `soundQuestion` / `soundQuestionGain` |
| 워크플로우/Task 에이전트 전체 완료 | `Ring06.wav` | `soundWorkflow` / `soundWorkflowGain` / `workflowCompleteBeep` |

모든 사운드 경로를 자신의 WAV 파일로 교체할 수 있습니다. 게인은 50%~5000% 조절 가능(~300% 초과 시 왜곡 가능). 명령 팔레트의 **`Claude State Bar: Test Beep Sound`**로 미리 듣기 가능.

**Codex도 이 사운드를 공유합니다.** Codex 세션의 완료 비프(`task_complete` 이벤트 기반)는 Claude와 동일한 `soundCompletion` 설정과 동일한 임계값을 씁니다 — Codex 전용 사운드 설정은 없습니다. Codex에는 질문 대기 비프와 멈춤 감지 비프가 없습니다.

**워크플로우 완료 비프 게이트** — 이번 세션에서 실제로 워크플로우가 실행 중 → 완료로 전환되는 것을 확인했을 때만 비프가 울립니다. 실제 워크플로우(`wf_*`)는 여기에 더해 스크립트 전체가 진짜 끝났는지(실행 완료 기록 `workflows/<wfId>.json`의 `status: "completed"`)까지 기다리므로, 에이전트를 **순차 배치로 나눠 실행**하는 워크플로우도 배치마다가 아니라 **맨 끝에 딱 한 번** 울립니다. 실패·중단된 실행은 울리지 않습니다. VS Code 시작 전부터 이미 완료된 워크플로우는 자동으로 베이스라인 처리되어 무음입니다.

---

## 🖱️ 통합 툴팁

세션 아이템에 마우스를 올리면, 색 구분선과 라벨로 나뉜 두 섹션이 한 툴팁에 보입니다:

```
my-project (a1b2c3d4)
──────── claudeState ────────
📊 세션: 30% — 오후 5:40 (3시간 27분 후)
📅 주간: 20% — 오후 3:00 (토)
Fable: 12%  Opus: 4%
──────── claudeContext ────────
🤖 Model: claude-opus-4-7
🎚️ Effort: xHigh⁺
📊 Context Usage: 4%
| Cache Read | 8K |  | Cache Creation | 28K |  | Total | 37K / 1.0M |
🕐 Last updated: 오후 2:10:58
Click for menu (hide / restore / settings)
```

---

## ⚙️ 설정 패널 (웹뷰, 한/영)

명령 팔레트에서 **`Claude State Bar: Open Settings Panel`**를 열면, 런타임 **English / 한국어** 토글이 있는 단일 패널이 뜹니다. Org ID, Session Key, 새로고침 간격, 텔레그램 Bot Token(Chat ID 자동 감지), 사운드 설정(미리듣기 포함), 컨텍스트 모니터 옵션을 한 곳에서 입력합니다. 민감 값은 암호화 SecretStorage로, 나머지는 표준 VS Code 설정과 동기화됩니다.

### 자격증명 얻는 법
- **Org ID** — claude.ai → 개발자도구 → Network → `/api/organizations/{UUID}/…` 요청
- **Session Key** — claude.ai → 개발자도구 → Application → Cookies → `sessionKey`

---

## 🔔 텔레그램 세션 리셋 알림 (선택)

설정에서 Bot Token을 넣고, 봇에게 아무 메시지나 보낸 뒤 **"내 텔레그램과 연결"**을 누르면(Chat ID 자동 감지) — Claude 5시간 세션 창이 리셋될 때마다 알림이 옵니다.

---

## 🚀 리셋 시각에 다음 블록 자동 시작 (선택, 기본 꺼짐)

5시간 블록은 **앵커 모델**입니다. **첫 메시지 시각**부터 시작해 정확히 5시간 뒤에 리셋되며, 고정된 시간표로 자동 순환하지 **않습니다.** 그래서 자리를 비운 사이 블록이 리셋되면, 다음에 입력하기 전까지는 아무것도 열리지 않습니다.

**`claudeState.autoStartBlockOnReset`** 를 켜면, 확장이 **블록이 닫히는 순간**(세션 사용량이 0%로 떨어질 때) 더미 `claude -p` 프롬프트를 발사해 다음 블록을 대신 열어줍니다. 발사는 전용 임시 디렉토리에서 이뤄지며, 이 더미 세션은 상태바에서 자동으로 걸러집니다.

- **리셋당 한 번만** 발사합니다 — VS Code 창이 여러 개거나 절전 해제 순간에 몰려도 — 원자적 10분 이벤트 락으로 보장합니다.
- **절전 해제 발사:** 절전 중에 리셋이 지나갔으면, 깨어난 뒤 첫 폴링에서 발사합니다. 그래서 **일어나면 이미 시작된 블록**이 기다립니다. 깨어 있을 때는 리셋 후 몇 초 안에 발사되어, 새 블록이 사실상 리셋 시각에 앵커됩니다.
- ⚠️ 새 창은 **즉시 카운트다운을 시작합니다 — 자는 동안에도요.** 이게 이 기능의 목적이지만, 알고 켜세요.
- `claude` CLI가 PATH에 있어야 하고 VS Code가 켜져 있어야 합니다. 컴퓨터가 완전히 절전이면 폴링이 멈추므로, 발사는 **깨어날 때** 일어나지 리셋 정각은 아닙니다. 정각 발사를 원하면 OS 스케줄러가 필요합니다.

이 기능과 텔레그램 리셋 알림은 **설정 패널**(텔레그램 섹션)에서 켜고 끕니다.

### 과금 안전장치

이 기능은 headless `claude -p` 실행이 **구독**으로 처리될 때만 의미가 있습니다. Anthropic이 이를 **API 과금**으로 돌리겠다고 예고한 적이 있어서:

- **발사 거부** — 환경에 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 이 있으면 아예 쏘지 않고(그 호출은 구독이 아니라 API로 나갑니다), 경고와 함께 설정을 끕니다.
- **사후 검증** — 발사 후 `sessionResetAt` 이 약 5시간 뒤로 이동했는지 확인해 블록이 실제로 열렸는지 봅니다. 작은 더미 프롬프트는 세션 %를 움직이지 않으므로 resetAt이 진짜 신호입니다. API 키가 없으면 과금 위험이 없으므로, 검증 실패는 기록만 하고 기능을 끄지는 **않습니다.**

---

## 🧹 좀비 상태바 항목 정리

VS Code가 창이 열린 상태에서 확장을 업데이트하면, 이전 인스턴스의 상태바 아이템이 클릭에 반응하지 않는 "좀비" 픽셀로 남을 수 있습니다. Claude State Bar는 두 가지 방법으로 처리합니다:

1. **버전 변경 감지** — 활성화 시 마지막 실행 버전이 바뀌었으면 "창 다시 로드해서 오래된 항목 정리?" 알림을 1회 표시합니다.
2. **QuickPick 정리** — 세션 메뉴에 항상 **🗑 오래된/좀비 항목 정리 (창 다시 로드)** 항목이 있습니다.

---

## 설정 항목

모든 키는 `claudeContextBar.*` 또는 `claudeState.*` 접두사를 씁니다.

### 핵심 표시 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.autoColor` | `true` | 프로젝트별 고유 파스텔 색 |
| `claudeContextBar.baseColor` | `White` | 자동 색상 끌 때 기본 색 |
| `claudeContextBar.contextLimitDefault` | `200000` | 표준 모델 컨텍스트 한도 |
| `claudeContextBar.contextLimitOpus` | `1000000` | 1M 컨텍스트 모델 한도 (Opus 4.x, Fable/Mythos, Sonnet 4.6+/5+) |
| `claudeContextBar.warningThreshold` | `50` | 노란 경고 배경 % |
| `claudeContextBar.dangerThreshold` | `75` | 빨간 위험 배경 % |
| `claudeContextBar.refreshInterval` | `30` | 새로고침 간격(초) |
| `claudeContextBar.idleTimeout` | `180` | 세션이 **흐려지는** 시간(초) |
| `claudeContextBar.hideAfter` | `86400` | 세션이 **숨겨지는** 시간(초, ≥ idleTimeout) |
| `claudeContextBar.scope` | `workspace` | `workspace`(현재 폴더만) 또는 `all` |
| `claudeContextBar.showModel` | `true` | 퍼센트 옆에 모델명 표시 |
| `claudeContextBar.compactMode` | `false` | 프로젝트 이름 축약 |
| `claudeContextBar.shortNames` | `{}` | 커스텀 약칭, 예: `{"my-project":"MP"}` |
| `claudeContextBar.autoCleanupOldVersions` | `true` | 활성화 시 이전 버전 자동 정리 |

### 사운드 알림

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.soundWarning` | `""` | 경고 임계값 알림 WAV 경로 (비우면 기본음) |
| `claudeContextBar.soundWarningGain` | `100` | 경고음 게인 % (50–5000) |
| `claudeContextBar.soundDanger` | `""` | 위험 임계값 알림 WAV 경로 |
| `claudeContextBar.soundDangerGain` | `100` | 위험음 게인 % |
| `claudeContextBar.soundCompletion` | `""` | 응답 완료(`end_turn`) 비프 WAV 경로 |
| `claudeContextBar.soundCompletionGain` | `100` | 완료음 게인 % |
| `claudeContextBar.completionBeepSettleMs` | `3000` | 완료 비프 발동 전 안정 대기 시간(ms) |
| `claudeContextBar.soundQuestion` | `""` | 질문 일시정지 비프 WAV 경로 |
| `claudeContextBar.soundQuestionGain` | `100` | 질문음 게인 % |
| `claudeContextBar.soundWorkflow` | `""` | 워크플로우/에이전트 전체 완료 비프 WAV 경로 |
| `claudeContextBar.soundWorkflowGain` | `100` | 워크플로우 완료음 게인 % |
| `claudeContextBar.workflowCompleteBeep` | `true` | 워크플로우/Task 에이전트 전체 완료 시 비프 |
| `claudeContextBar.detectStuckToolUse` | `false` | 휴리스틱: tool_use 이후 일정 시간 무활동 시 질문 비프 |
| `claudeContextBar.stuckToolUseThresholdSec` | `90` | stuck-tool 휴리스틱 발동 임계 시간(초) |

### 플랜 사용량

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeState.orgId` | `""` | claude.ai Organization ID |
| `claudeState.language` | `en` | 설정 패널 언어(`en` / `ko`) |
| `claudeState.refreshIntervalSec` | `300` | 플랜 사용량 폴링 간격(초). Codex 계정 사용량 조회에도 함께 쓰이며, 최소 60초로 제한됩니다. |

(Session Key, Bot Token, Chat ID는 settings.json이 아니라 SecretStorage에 저장됩니다.)

### Codex

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.codex.enabled` | `true` | Codex 세션 표시 on/off (Codex 미설치 시 즉시 no‑op) |
| `claudeContextBar.codex.home` | `""` | Codex 상태 디렉터리. 비우면 자동 탐지(`$CODEX_HOME` → `~/.codex`). 명시한 경로가 없으면 폴백 없이 아무것도 표시하지 않고 이유를 로그에 남김 |
| `claudeContextBar.codex.scanDays` | `3` | `sessions/YYYY/MM/DD` 중 최근 며칠치만 스캔(전체 히스토리는 절대 재귀 스캔 안 함) |

그 밖의 설정 — 임계값, 사운드, `compactMode`, `idleTimeout`, `hideAfter`, `scope` — 은 Claude와 Codex가 공유합니다.

---

## 요구사항

- VS Code 1.74.0 이상
- [Claude Code](https://www.anthropic.com/claude-code)가 실행 중이고 `~/.claude/projects/`에 세션 로그를 기록 중
- 플랜 사용량용: claude.ai 계정 (Org ID + Session Key)
- Codex 세션용(선택): OpenAI Codex가 `~/.codex/sessions/`에 rollout 로그를 기록 중 — **로컬** 머신, 또는 Remote‑SSH 창에서는 **원격 호스트**

## 동작 원리

선택적 claude.ai 플랜 사용량 조회와 텔레그램을 제외하면 네트워크 호출이 없습니다. 컨텍스트 모니터링은 `vscode.workspace.fs`로 Claude Code의 JSONL 로그를 읽는 순수 디스크 작업입니다(로컬/원격). 플랜 사용량은 Electron의 Chromium 네트워크 스택으로 claude.ai usage 엔드포인트를 호출하며(Cloudflare 통과), 순수 `https` 폴백을 둡니다. 워크플로우 뷰어는 `~/.claude/projects/<slug>/<uuid>/subagents/`를 디스크에서 직접 읽습니다. Codex **컨텍스트** 모니터링도 마찬가지로 `vscode.workspace.fs`로 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`을 읽는 순수 디스크 작업이며(로컬/원격), 네트워크 호출 없이 구조적 필드(토큰 수, 타임스탬프, 모델명)만 파싱합니다. Codex **계정 사용량**은 짧게 실행되는 로컬 `codex app-server` 프로세스에 JSON‑RPC로 실시간 조회하며(자체 타이머, 최소 60초), 실패 시 rollout 로그의 `rate_limits` 스냅샷으로 폴백합니다.

---

## 크레딧

원작 컨텍스트 모니터링 코어 by [Ed Zisk (@ezoosk)](https://github.com/ezoosk). 이 확장은 그 토대 위에 Claude.ai 플랜 사용량, Remote‑SSH 지원, 텔레그램 알림, 웹뷰 설정 패널, 워크플로우/에이전트 뷰어, 사운드 알림 등을 추가하여 **Blueming**이 유지보수합니다.

## 라이선스

MIT © 2026 Blueming. 원작 코어 © 2025 Ed Zisk.
