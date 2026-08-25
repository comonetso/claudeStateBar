# Claude Code & Codex Status Bar

**Claude Code와 OpenAI Codex를 VS Code 상태바에 나란히** — 세션별 컨텍스트 사용량, 모델·Effort, 작업 완료 비프, 그리고 계정 한도(Claude.ai 5시간 세션 & 주간, Codex 5시간 & 주간 사용량)까지. 실시간 워크플로우/에이전트 뷰어 패널, Remote‑SSH 지원, 텔레그램 리셋 알림, 한/영 설정 패널 포함.

[![GitHub stars](https://img.shields.io/github/stars/comonetso/claudeStateBar?style=social)](https://github.com/comonetso/claudeStateBar)

> ### ⭐ 저장소에 별 하나만 눌러주세요
> 설치해서 쓰는 분은 많은데, 별을 눌러주는 분은 거의 없습니다.
> 별은 "이걸 실제로 쓰는 사람이 있다"는 걸 알 수 있는 **유일한 신호**이고, 계속 만들지 말지를 정하는 기준이기도 합니다.
> 2초면 됩니다: **[github.com/comonetso/claudeStateBar](https://github.com/comonetso/claudeStateBar)**

🇬🇧 English: [README.md](README.md)

---

## 상태바 안의 두 계층

Claude Code & Codex Status Bar는 서로 보완되는 두 가지를 보여주며, 하나의 호버 툴팁 안에서 섹션으로 명확히 구분됩니다.

### 🧠 claudeContext — Claude Code 컨텍스트 모니터
Claude Code의 세션 로그(`~/.claude/projects/*.jsonl`)를 읽어 활성 세션별로 표시:
- **실시간 컨텍스트 사용량 %** (사용 토큰 vs 모델 한도)
- **세션별 모니터링** — Claude Code 세션마다 독립 상태바 아이템
- **모델 인식 한도** — Opus 4.x, Fable/Mythos, Sonnet 4.6+/5+, ID에 `1m`이 포함된 모델 → 1,000,000 토큰, 그 외(Sonnet 4.5 이하, Haiku 등) → 200,000 (설정 가능)
- **모델 + Effort + 속도** — 예: `Opus 4.7 · xHigh⁺ · ⚡fast` ([Effort 표시](#️-effort-레벨-표시) 참조)
- **색상 경고** — 정상 / 경고(≥50%) / 위험(≥75%) 배경색
- **2단계 idle** — `idleTimeout`(기본 180초) 후 흐려지고, `hideAfter` 후 완전히 숨김
- **유령 세션 감지** — `/clear`나 탭 종료 후 오래된 세션 숨김, 새 활동 시 자동 복원
- **컴팩트 모드 & 커스텀 약칭** — 프로젝트명은 `my-cool-project → MCP`처럼 줄이며, Codex 모델명은 항상 알아볼 수 있는 전체 표기로 유지
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

기본 `scope: workspace`에서 Codex는 **이 VS Code 창이 마지막으로 선택한 대화 UUID 하나만** 보여줍니다. 먼저 활성 Codex 에디터 탭의 안정적인 URI를 읽고, 탭이 없는 사이드바 대화는 이 창의 OpenAI `Codex.log`에 기록된 구조적 `conversationId` 표식을 사용합니다. 다른 창으로 포커스가 이동하거나 VS Code를 재로드해도 이 창의 UUID를 지우지 않습니다. 대화를 다른 프로젝트에서 만들었거나 Remote‑SSH 창에서 다시 열었더라도 그 ID의 rollout 하나만 직접 엽니다. UUID를 얻지 못하면 계정 사용량 항목만 표시합니다. 머신/호스트의 최근 세션을 최대 5개까지 보려면 `scope: all`을 명시적으로 선택하세요.

**Codex는 대화 목록을 프로젝트가 아니라 디바이스 단위로 관리합니다.** VS Code를 다시 열면 마지막에 보던 대화가 복원되는데, 그게 다른 저장소에서 만든 대화인 경우가 흔합니다. 상태바는 그 대화를 그대로 표시합니다 — 실제로 이 창이 열고 있는 대화가 맞기 때문입니다. 다만 그 숫자가 현재 폴더의 컨텍스트로 오해되지 않도록, `cwd`가 이 창에 열린 폴더와 다르면 표시를 남깁니다. **`⬢` 아이콘이 경고색으로 바뀌고**, 프로젝트 이름 뒤에 **`↗`**가 붙으며, 툴팁에 그 대화의 전체 경로를 명시합니다. 새 대화를 시작하면 표시는 사라집니다.

컨텍스트 바 그룹 안에서는 **항상 Claude 세션이 왼쪽, Codex 세션이 오른쪽**에 표시됩니다. 최근 활동 시각이 바뀌어도 두 제공자의 좌우 위치는 바뀌지 않습니다.

제공자 아이콘은 현재 모양을 유지한 더 큰 VS Code 기본 크기 아이콘으로 표시됩니다. **Claude의 `✳`는 주황색, Codex의 `⬢`는 파란색**이며, 아이콘용 색상 영역은 사용량 텍스트에 촘촘하게 붙습니다. 아이콘이 자기 색상 영역을 따로 갖기 때문에, 텍스트는 상태바 공간을 더 쓰지 않고도 사용량 경고를 색으로 알릴 수 있습니다. 아이콘 색이 바뀌는 경우는 딱 하나 — 위에서 설명한 다른 프로젝트의 Codex 대화일 때입니다.

### Codex 아이템에 표시되는 것

- **컨텍스트 사용률 %** — 최신 `last_token_usage.total_tokens` ÷ `model_context_window`
- **모델명** — 예: `gpt-5.6-sol` → `gpt 5.6 sol`; 구분자만 읽기 쉽게 바꾸며, 컴팩트 모드에서도 Codex 모델명은 줄이지 않음
- **Effort** — Low / Medium / High / xHigh 등
- **idle 흐림 & `hideAfter` 숨김** — Claude와 완전히 동일한 규칙
- **완료 비프** — Codex의 `task_complete` 이벤트 기반. Claude의 완료 비프와 **동일한 사운드·임계값 설정을 공유**합니다 — Codex 전용 사운드 설정은 없습니다.
- **툴팁** — Codex 5시간·주간 한도(사용 비율, 갱신 시각, 플랜 종류) + 컨텍스트 토큰 내역 + 세션 누적 처리량

### Codex 계정 사용량 (rate limit)

**Codex app‑server에서 실시간으로** 읽습니다. 확장이 `codex app-server` 프로세스를 잠깐 띄워 JSON‑RPC로 `account/rateLimits/read`를 요청합니다 — 실측 왕복 시간 약 **0.6~0.9초**.

app-server 원본은 소진 비율인 `usedPercent`를 반환하며, 상태바와 툴팁은 이 **소진 비율을 그대로** 보여줍니다. 바로 옆 Claude 플랜 표시와 방향이 같아서, 숫자가 클수록 한도에 가깝다는 뜻으로 일관되게 읽힙니다. 다만 ChatGPT 공식 사용량 화면은 남은 양을 표기하므로, 거기서 **42% 남음**인 상태가 여기서는 **58%** 사용으로 나옵니다.

툴팁의 **세션 누적 처리량**은 rollout의 `total_token_usage.total_tokens`입니다. 이 대화에서 여러 모델 호출이 처리한 토큰의 누적합(캐시 입력 포함)이며, 현재 컨텍스트 크기도 계정의 주간 한도 사용량도 아닙니다.

이 조회는 **세션 갱신(30초)과 분리된 별도의 느린 타이머**로 돕니다. `claudeState.refreshIntervalSec` 값을 공유하되 **최소 60초**로 제한되므로, 매 30초 폴링마다 프로세스를 띄우지 않습니다. Claude가 claude.ai 사용량 API를 주기적으로 호출하는 것과 정확히 대칭인 구조입니다.

**왜 로그가 아니라 실시간인가?** Codex 한도는 **7일 롤링 윈도우**라서, Codex를 쓰지 않아도 실제 값이 스스로 내려갑니다. 로그 스냅샷만 읽으면 Codex를 며칠 안 쓸 때 값이 그대로 굳어버립니다.

**폴백 순서:**

1. 창 간 공유 캐시로 조정되는 app‑server 실시간 조회
2. 실시간/공유 값이 한 번도 성공하지 못했으면, 현재 보이는 rollout 로그 중 최신 `rate_limits` 스냅샷
3. 이전 공유 실시간 값이 있으면 계속 사용하되, 오래되면 **"오래된 값"** 표시
4. 전부 없으면 사용량을 표시하지 않음

툴팁에는 **관측 시각 옆에 출처가 함께** 표시됩니다 — `실시간`, 또는 `세션 로그`.

> 기존의 "Codex가 실제로 작업 중일 때만 갱신된다"는 단서는 이제 **폴백(2단계)에만** 해당합니다. rollout 스냅샷은 Codex가 작업할 때 기록되므로, idle 세션의 스냅샷은 오래된 값이 됩니다.

같은 로컬 VS Code 프로필의 모든 창은 확장 `globalStorage`에 있는 비밀값 없는 작은 파일 하나를 공유합니다. 원자적 `wx` 잠금으로 한 창만 `account/rateLimits/read`를 실행하고, 나머지 창은 원자적으로 교체된 캐시를 읽고 변경을 감시합니다. 이로써 창마다 app-server를 하나씩 띄우는 일을 막고, 시각만 더 최신인 오래된 rollout 스냅샷이 계정 기준 실시간 값을 덮어쓰지 못하게 합니다.

현재 창에 기록된 Codex 대화 UUID가 없거나 해당 rollout을 찾을 수 없어도 계정 사용량은 독립된 **`⬢ Codex`** 항목으로 계속 표시됩니다. 이 항목은 의도적으로 계정 정보만 보여줍니다. 다른 창의 모델·컨텍스트 수치를 추측해서 붙이지 않습니다. UUID 하나가 확인되면 독립 항목은 그 대화의 정상 세션 항목으로 자동 대체됩니다.

Codex 계정 사용량은 Claude의 5시간 / 주간 플랜 사용량과는 **별개 개념**입니다. 각 provider의 사용량은 자기 provider의 첫 세션 아이템에만 병합되어 표시됩니다.

### Codex 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.codex.enabled` | `true` | Codex 세션 표시 on/off. Codex 미설치 시 즉시 no‑op이라 비용이 없습니다. |
| `claudeContextBar.codex.home` | `""` | Codex 상태 디렉터리. 비우면 자동 탐지(`$CODEX_HOME` → `~/.codex`). **명시했는데 경로가 없으면 자동 폴백하지 않고 아무것도 표시하지 않으며, 이유를 로그에 남깁니다.** |
| `claudeContextBar.codex.scanDays` | `3` | `scope: all`에서 `sessions/YYYY/MM/DD` 중 최근 며칠치 폴더만 스캔할지. 현재 대화 모드는 오래전에 만든 대화도 선택 UUID로 직접 찾습니다. |

그 밖의 설정은 **Claude와 Codex가 공유**합니다 — 경고/위험 임계값, 사운드, `compactMode`, `idleTimeout`, `hideAfter`, `scope` 등. Codex 전용 임계값·사운드 설정은 없습니다.

### 알려진 한계 (Phase 1)

- **현재 대화 모드는 호스트 소유권이 아니라 Codex UI를 따릅니다.** Remote‑SSH 창에서도 Codex webview가 로컬 UI 호스트에서 실행되면 선택 대화가 로컬 `CODEX_HOME`에 있을 수 있고, 설정된 원격 Codex 홈의 rollout을 가리킬 수도 있습니다. 정확한 선택 UUID를 설정된 호스트에서 먼저 찾고, 명시적인 `codex.home` 설정이 없을 때만 로컬 UI 홈을 폴백으로 확인합니다.
- **이 확장에는 Codex 워크플로우 / 서브에이전트 뷰어가 없음** — Codex 세션을 클릭해도 Claude 워크플로우 메뉴가 나오지 않습니다. 명시적인 spawned-agent 연결 정보는 전체 완료음 판정에만 읽으며, 개별 thread 확인·열기는 Codex 자체 background-agent 패널을 사용합니다.
- **Codex 서브에이전트 세션은 상태 표시줄에 개별 표시되지 않음** — spawned-agent rollout은 전체 완료음을 위해 부모 턴 아래로 집계하고, 내부 guardian rollout은 계속 제외합니다.
- **Codex 질문 대기 비프 / 멈춤 감지는 아직 없음.**
- **Codex rollout·세션 로그는 지우지 않습니다.** (Codex 진행 패널이 `codex_rescue` 실행 기록을 지우기는 하지만, 사용자가 지시할 때만입니다 — 해당 절 참조)
- **계정 사용량은 Remote‑SSH 창에서도 *로컬*의 `codex`로 조회합니다** — 실시간 조회는 **로컬** `codex` 실행 파일을 실행하므로, 원격 창에서도 로컬 계정 기준 값이 나옵니다. 같은 ChatGPT 계정이면 값이 동일하지만, 다른 계정이면 다를 수 있습니다. (컨텍스트 모니터링은 원격 파일을 정확히 읽으므로 이와 무관합니다.)
- **`codex` 실행 파일이 없거나 app‑server 조회가 실패해도 컨텍스트 모니터는 정상 동작합니다** — 사용량만 로그 스냅샷으로 폴백합니다. 조회에는 **15초 타임아웃**이 있고, 조회용 프로세스는 매번 정리됩니다(프로세스 누수 없음을 실측 확인).
- **사이드바 선택은 OpenAI 내부 로그 표식을 호환성 폴백으로 사용합니다.** Codex 에디터 탭은 안정적인 VS Code 탭 URI를 사용합니다. `active=false`는 단순 창 포커스 이탈 때도 발생하므로 가장 최근의 `active=true` UUID를 창별로 유지합니다. Remote‑SSH에서는 프로세스 ID로 로컬 창과 원격 OpenAI 확장 호스트 로그를 연결하고, 불가능할 때만 활성화 시각을 제한적 폴백으로 사용합니다. 향후 OpenAI 로그 형식이 바뀌면 사이드바 전용 창은 계정 사용량 항목으로 안전하게 내려갑니다. `scope: all`은 그때도 의도대로 최근 세션 목록으로 계속 동작합니다.

### 개인정보

Codex rollout 로그에는 대화 원문 전체가 들어 있지만 rollout 파서는 **구조적 필드(토큰/사용량 수치, 타임스탬프, 모델/effort, `cwd`, 작업 생명주기, 명시적인 spawned-agent 부모/thread ID)만** 추출합니다. 사이드바 대화를 식별할 때는 일치하는 로컬 또는 원격 OpenAI `Codex.log`에서 정확한 `thread_stream_view_activity_changed` 표식, 불리언 값, UUID만 찾고 나머지 로그 텍스트는 즉시 버립니다. 메시지 본문을 저장하거나 이 확장의 로그에 남기지 않습니다. `auth.json`은 절대 접근하지 않습니다.

---

## 🌐 Remote‑SSH 지원

**Remote‑SSH** 환경에서도 두 가지를 동시에 합니다. Claude Code & Codex Status Bar는 **UI(로컬) 확장**으로 실행됩니다:

- **플랜 사용량**은 **로컬 PC**의 Electron 네트워크 스택으로 가져옵니다 — Cloudflare 봇 챌린지를 통과합니다. (원격/헤드리스 호스트의 순수 Node `https`는 Cloudflare `403`을 받고, AWS EC2 같은 클라우드·데이터센터 IP는 TLS 핑거프린트와 무관하게 차단됩니다.)
- **토큰 카운트**는 **원격** 호스트의 `~/.claude/projects`를 `vscode.workspace.fs`로 읽습니다. VS Code가 SSH 너머로 자동 라우팅합니다. 원격 홈은 자동 탐색(`/root`, 없으면 `/home/*`)합니다.

**로컬에 한 번 설치하면 모든 Remote‑SSH 창에 자동 적용됩니다.** `ui`-kind 확장이므로 서버마다 재설치할 필요가 없습니다.

Remote‑SSH 창에서 **원격 세션 토큰 사용량과 플랜 사용량을 한곳에서** 봅니다. 호스트가 claude.ai에 도달할 수 없으면 오해를 주는 "만료" 오류 대신 "이 환경에선 플랜 사용량 불가"라는 정직한 안내가 표시됩니다(Session Key는 정상).

### Remote‑SSH에서의 Codex

**Codex도 지원합니다.** `scope: all`에서는 `vscode.workspace.fs`로 **원격** 호스트의 최근 rollout을 읽고, `/root`와 `/home/*` 아래에서 `.codex/sessions`가 실제로 존재하는 홈을 찾습니다. 기본 `scope: workspace`에서는 먼저 이 VS Code 창에 표시된 정확한 대화 UUID를 구한 뒤 원격 호스트에서 찾습니다. 명시적인 `codex.home` 설정이 없으면 Remote‑SSH 창 안에서도 Codex webview가 로컬 대화를 소유할 수 있으므로 로컬 UI 호스트의 Codex 홈도 이어서 확인합니다.

**읽기 방식의 차이 한 가지(성능 참고):** 로컬에서는 파일의 필요한 구간만(byte‑range) 읽어서 14.1MB짜리 rollout도 수 밀리초면 끝납니다. Remote‑SSH에서는 VS Code 파일 API에 구간 읽기가 없어 **파일 전체**를 읽습니다. 이는 Claude가 원격에서 이미 하고 있는 것과 동일한 방식이며(이 개발 머신의 Claude 세션 파일 최대 크기는 9.2MB), 여기에 더해 Codex에는 Claude에 없는 최적화가 있습니다 — **rollout의 mtime과 크기가 그대로면 읽기를 아예 건너뜁니다**. 안전장치로, 원격에서 **32MB를 넘는** rollout 파일은 건너뛰고 로그에 남깁니다.

로컬 경로와 원격 경로가 동일한 파싱 결과를 내는지 검증했습니다 — 같은 rollout 데이터에 대해 5개 세션 × 12개 필드 전부 일치했습니다.

⚠️ 명시한 `codex.home`은 항상 우선하며 다른 위치로 폴백하지 않습니다. `scope: all`에서는 원격 창에 원격 호스트의 최근 Codex 세션만 표시되고, 로컬 UI 폴백은 기본 현재-대화 모드에서 정확히 선택된 대화 하나에만 적용됩니다.

⚠️ **계정 사용량만 예외입니다:** 실시간 rate limit 조회는 **로컬**의 `codex`를 실행하므로, 원격 창에서도 사용량 수치는 **로컬** 계정 기준입니다. 같은 ChatGPT 계정이면 값이 동일하고, 다른 계정이면 다를 수 있습니다. 컨텍스트 모니터링은 이와 무관합니다.

---

## 🎬 워크플로우 & Task 에이전트 뷰어 패널

세션 QuickPick 메뉴에서 **워크플로우 뷰어**를 열면 활성 Claude Code 워크플로우와 Task(Agent 도구) 서브에이전트를 실시간으로 보여주는 WebView 패널이 열립니다:

- **워크플로우 진행 상황** — 각 워크플로우가 카드로 표시되며 페이즈, 실행 중/완료 에이전트, 에이전트별 요약, 경과 시간, 실시간 활동이 보임
- **결과 전체 펼치기** — 긴 최종 보고서는 `▶ 요약` 토글로 접혀 있어 필요할 때 전체를 읽을 수 있음
- **역할 라벨** — 각 에이전트의 역할이 프롬프트 헤더에서 자동 추출됨. "에이전트-1" 대신 의미 있는 이름으로 표시
- **Task(Agent 도구) 서브에이전트** — Agent 도구로 실행된 서브에이전트를 **시작 시각 기준 배치로 묶어** 별도 표시 (5분 이상 간격이면 새 배치)
- **배치별 🗑 정리** — 특정 배치의 완료된 Task 에이전트 로그만 삭제, 실행 중인 에이전트는 보존
- **휴지통** — 워크플로우를 지우면 없어지는 게 아니라 확인창 없이 옆으로 치워집니다. 패널 상단의 🗑를 열어 되살리거나 완전히 지웁니다. 그 사이 같은 id의 워크플로우가 새로 생겼으면 복구는 거부됩니다
- **Details 열림 유지** — 실시간 재렌더 중에도 펼쳐진 `<details>` 패널 상태 유지
- **글꼴 크기 조절** — `A−` / `A+` 버튼으로 패널 글자 크기 조절
- **한/영 UI** — 설정 패널과 동일한 EN / 한국어 전체 토글

---

## 🔶 Codex 진행 상황 패널 (선택)

Claude Code가 막힌 문제를 Codex에 넘겨 2차 의견을 받는 동안, Codex는 몇 분씩 아무 표시 없이 돕니다. 끝나야만 결과가 나오고, 그때까지는 도는 중인지 멈춘 건지도 알 수 없습니다. 이 패널이 그 시간을 들여다봅니다.

동작하려면 Claude Code용 [`codex_rescue`](skills/codex_rescue/) 스킬이 필요합니다. 확장에는 포함돼 있지 않습니다 — 워크스페이스에 쓰기 권한을 가진 `codex exec`를 실행하는 도구라, 상태바 확장을 깔았다고 따라와서는 안 되는 물건입니다. 설치 방법과 사용법은 [가이드](docs/codex-rescue-guide.ko.md)([English](docs/codex-rescue-guide.md))에 있습니다.

스킬이 설치돼 있으면 상태바 메뉴와 `claudeStateBar: Show Codex Runs`로 열립니다. 실행 한 건이 카드 하나입니다:

- **Codex가 방금 한 말** — "이제 뭘 하겠다"는 자기 서술. 스피너보다 훨씬 쓸모 있습니다
- **명령 · 검색 · 파일 변경 · MCP 호출** — 종류별 색으로 구분, 명령은 종료 코드까지. 연달아 성공한 명령이나 검색은 한 줄로 접히며 펼쳐 볼 수 있습니다. **실패한 것은 접지 않으므로** 그대로 보입니다
- **잘린 줄은 눌러서 봅니다** — 패널 폭을 넘어간 줄은 클릭하면 그 자리에서 워드랩으로 펼쳐집니다. 한 번에 한 줄만 열립니다. 보이는 건 패널이 보관한 만큼입니다 — 말은 4,000자, 명령은 감싸인 형태로 600자까지. 그보다 길면 원시 이벤트 로그를 봐야 합니다
- **기록 없이 문서만 있는 실행도 보입니다** — `문서만` 표시가 붙고, 활동 목록은 없지만 요청서·응답 열기는 그대로 됩니다. 원시 기록을 지운 실행이나, 동료가 커밋한 문서를 git으로 받아온 경우가 여기 해당합니다
- **읽을 수 있는 제목** — 영문 슬러그 대신 요청서의 `subject`가 카드 제목이 됩니다. 2026-08-19 이후 버전의 `codex_rescue`가 필요하며, 그 전 실행은 슬러그로 표시됩니다
- **계획** — Codex가 계획을 세운 경우에만 `2/5` 형태로
- **경과 시간과 활동 수** — 진행률(%)은 표시하지 않습니다. Codex는 앞으로 도구를 몇 번 부를지 미리 알리지 않으므로 진행률 막대는 지어낸 숫자가 됩니다
- **완료음** — 확장이 진행 중인 상태부터 지켜본 실행이 끝날 때 울리며, 워크플로우 완료와 같은 `claudeContextBar.workflowCompleteBeep` 설정을 씁니다. 확장을 켜기 전에 이미 끝나 있던 실행은 조용히 올라옵니다

상태는 `시작 중 → 진행 중 → 마무리 중 → 완료 / 실패 / 중단 / 응답 없음`으로 바뀝니다. `마무리 중`이 따로 있는 이유는, Codex의 턴이 끝나도 스킬은 변경 검사와 응답 회수를 더 하기 때문입니다. 그 구간을 완료로 표시하면 아직 안 끝난 것을 끝났다고 하는 셈입니다. 강제 종료된 실행은 완료로 승격되지 않고 `응답 없음`으로 남습니다.

### 도는 도중에 끼어들기 (1.14.0)

Codex가 몇 분씩 도는 동안 잘못된 방향으로 가고 있어도, 예전에는 끝날 때까지 지켜보고 처음부터 다시 묻는 수밖에 없었습니다. 이제 **진행 중인 작업에 말을 얹을 수 있습니다.** 하던 일을 버리지 않고 이어가면서 새 지시를 반영합니다.

끼어든 말은 활동 목록에 **`클로드` 칩**으로 남고, 채팅 패널에서 클로드에게 쓰는 것과 같은 주황색에 왼쪽 세로선이 붙습니다. Codex CLI가 턴마다 뱉는 안내(`clamping SessionEnd hook timeout to 3s` 같은)와 헷갈리지 않게 하려는 것입니다 — 실제로 헷갈렸습니다.

이 기능은 스킬 쪽 배관(`tools/live-consult/`)이 함께 있어야 동작합니다.

### 되묻기를 하면 턴이 나뉘어 보입니다 (1.14.0)

같은 건을 이어서 물으면 한 카드에 여러 턴이 쌓입니다. 이제 **턴이 바뀌는 자리에 `1턴` · `2턴` 머리표**가 들어가고, 턴마다 그 턴의 말 상자를 따로 갖습니다. 턴이 끝나도 그 상자는 남아서, 다 끝난 대화도 순서대로 읽힙니다. 그 턴의 마지막 발언이 끼어들기였다면 그것이 표시되며 테두리가 주황으로 바뀝니다.

**단일 턴 실행의 화면은 그대로입니다.** 머리표는 되묻기가 실제로 있었던 카드에만 나타납니다.

같은 판에서 고친 것이 하나 더 있습니다. `codex exec resume`은 턴마다 활동 번호를 `item_0`부터 다시 매기는데, 패널이 그 번호만으로 항목을 구분하고 있었습니다. 그래서 2턴 활동이 1턴 활동을 덮었습니다 — 실제 2턴 실행에서 활동 20개가 12개로 줄었고, 사라진 것이 뒤쪽 여덟 개가 아니라 번호가 겹친 것들이라 목록 곳곳에 구멍이 났습니다. 1턴에 **파일 변경**이던 줄이 2턴 **명령**으로 바뀌어 그 자리에 남기도 했습니다. 활동이 사라진 게 아니라 다른 활동으로 둔갑한 것입니다.

### 프로젝트에 생기는 파일

스킬을 처음 실행하면 프로젝트 안에 `docs/codex_rescue/`가 만들어집니다. 패널은 이 디렉터리만 읽습니다 — 네트워크 호출은 없습니다.

- `<스탬프>_request_*.md` · `<스탬프>_response_*.md` — 무엇을 묻고 Codex가 무엇을 답했는지. **커밋해서 남기는 기록**입니다. 다음 세션이 이걸 그대로 이어받습니다
- `.log/` — 원시 실행 기록. 명령 출력 전문이 담겨 크기가 실행마다 크게 다릅니다(측정된 표본: 한 실행 409KB, 다른 표본들 394~750KB). 스킬이 이 디렉터리에 자체 `.gitignore`를 넣어 **git에서 제외**합니다

로그는 기본적으로 지워지지 않습니다. 패널 카드의 🗑(문서까지 통째로 휴지통으로 보냅니다)이나 자동 정리 설정으로 관리합니다 — [설정 항목](#codex-실행-기록-codex_rescue) 참조.

### 휴지통

카드에서 지운다고 사라지지 않습니다. 기록과 문서가 함께 **휴지통**으로 옮겨지고, 패널 상단의 🗑로 열 수 있습니다. 비울 때까지 그대로 남습니다 — 시간이 지나 저절로 없어지지 않습니다.

고르는 건 마지막 단계입니다. **완전 삭제**를 누르면 원시 기록만 지울지 문서까지 지울지 물어보고, 버튼 색이 무엇이 걸려 있는지 미리 알려줍니다 — 문서만 남았으면 빨강, 기록을 먼저 버릴 여지가 있으면 주황, 기록만 남았으면 기본색. 문서를 남기면 그 문서만 휴지통에 홀로 남는데 의도된 것입니다. 기록은 부피고, 문서는 무엇을 묻고 무엇을 답했는지의 내용입니다.

세 가지 더 있습니다.

- **자동 정리는 휴지통을 거치지 않습니다.** 디스크를 되찾는 게 목적인데 지운 만큼 휴지통이 차면 의미가 없습니다.
- **복구는 덮어쓰지 않습니다.** codex_rescue는 죽은 요청을 같은 스탬프로 재실행하므로, 휴지통 속 파일이 원하는 이름이 새 작업의 것일 수 있습니다. 그런 파일은 휴지통에 남기고 몇 개인지 알려줍니다.
- **lock이 남은 실행은 거부합니다** — `send.sh`가 아직 쓰는 중일 수 있고, 그 밑에서 파일을 빼면 보존이 아니라 훼손입니다.

파일은 복사가 아니라 이동이라 Remote-SSH에서도 추가 비용이 없습니다. 휴지통은 스킬이 `.log/`에 하듯 자체 `.gitignore`를 만들어 두므로, 지운 문서가 커밋 후보로 뜨지 않습니다.

Remote‑SSH에서도 동작합니다. 실행 기록은 `vscode.workspace.fs`로 원격 워크스페이스에서 읽습니다 — Claude·Codex 세션 파일에 이미 쓰고 있는 것과 같은 경로라, 확장 자체는 서버에 깔지 않아도 됩니다. 서버에서 실행을 시작하는 건 별개라, 그건 서버에 Codex CLI와 `codex_rescue` 스킬이 있어야 합니다. 차이가 하나 있습니다. VS Code 파일 API에는 구간 읽기가 없어서 진행 중인 실행의 이벤트 파일을 증분이 아니라 통째로 가져옵니다. 상태와 완료음은 그대로 2초마다 갱신되고, 활동 목록만 최대 5초 간격으로 갱신해 대부분의 틱에서 수백 KB 전송을 아낍니다.

## 💬 Codex 채팅 패널 (선택)

`codex_rescue`에는 짧게 주고받는 **핑퐁** 모드가 있습니다. 요청서를 쓰고 몇 분을 기다리는 위쪽 방식과 달리, 대화 도중에 "코덱스, 넌 어떻게 생각해?"를 던지고 10초 안팎에 답을 받습니다. 그 답은 Claude Code 채팅창에 바로 뜨지만, 대화가 길어지면 턴이 다른 말들 사이에 흩어집니다. 이 패널은 그 대화를 **한 화면에 모아** 다시 읽는 곳입니다.

진행 상황 패널 바로 아래에 있습니다. 대화 하나가 카드 하나이고, 가장 최근 대화가 펼쳐진 채로 열립니다 — 다시 읽는 건 대개 방금 그것이기 때문입니다.

- **누가 말했는지 색으로 먼저 읽힙니다** — 클로드는 주황, 코덱스는 파랑. 상태바 제공자 아이콘과 같은 색입니다
- **턴 수와 시작한 머신** — 대화 문서는 git으로 오가지만 Codex 세션은 따라가지 않습니다. 다른 PC에서 시작한 대화는 이어받을 수 없으므로 그 머신 이름을 카드에 적어 둡니다
- **끊긴 자리도 그대로 보입니다** — 실행이 죽어 스레드가 폐기됐거나 새 대화로 갈아탄 지점이 표시됩니다. 없으면 왜 갑자기 맥락이 바뀌었는지 알 수 없습니다
- **질문이 먼저 보입니다** — 핑퐁이 도는 7~13초 동안 던진 말이 곧바로 카드에 올라오고, 코덱스 자리에는 답을 기다리는 중이라고 표시됩니다. 답이 도착하면 그 자리가 채워집니다. 대화의 첫 턴이라 문서가 아직 없을 때도 카드가 만들어집니다
- **새 턴을 따라 내려갑니다** — 맨 아래를 보고 있으면 화면이 자동으로 따라갑니다. 위로 올려 옛 턴을 읽는 중이라면 화면을 건드리지 않고, 대신 오른쪽 아래에 "새 답변 ↓" 버튼이 뜹니다. 읽던 자리를 뺏기지 않으면서 새 답이 왔다는 것만 알 수 있습니다
- **한 번에 한 턴만 펼쳐집니다** — 나머지는 질문 첫 줄만 남기고 접힙니다. 어느 턴이 열리는지는 무엇 때문에 보는지에 따라 갈립니다. 패널을 열거나 이번에 처음 여는 대화는 **첫 턴**이 열립니다. 지난 대화는 처음부터 읽는 것이기 때문입니다. 반대로 보고 있던 대화에 새 턴이 도착하면 그 **마지막 턴**이 열립니다. 직접 펼치거나 접어 둔 턴은 그대로 둡니다
- 문서명을 누르면 원문이 에디터로 열립니다

핑퐁은 진행 상황 패널에 카드를 만들지 않습니다. 저쪽은 몇 분씩 도는 작업을 지켜보는 창이고, 10초짜리 대화가 쌓이면 방해만 되기 때문입니다.

### 휴지통은 따로입니다

진행 상황 패널의 휴지통과 **완전히 분리된 디렉터리**를 씁니다. 두 패널이 서로의 항목을 보거나 지우는 일이 없고, 대화와 실행이 같은 스탬프를 갖더라도 부딪히지 않습니다.

카드에서 지우면 묻지 않고 휴지통으로 갑니다 — 되돌릴 수 있으니 여기서 묻는 건 방해일 뿐입니다. **완전 삭제와 비우기에서만** 확인창이 뜹니다. 되돌릴 수 없는 지점이 거기 하나뿐이기 때문입니다.

**자동 정리는 없습니다.** 실행 기록은 부피라서 오래되면 지울 이유가 있지만, 대화는 그 자체가 기록입니다. 시간이 지났다는 게 지울 근거가 되지 않습니다.

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

Claude Code & Codex Status Bar는 주요 이벤트에 설정 가능한 WAV 사운드를 재생합니다:

| 이벤트 | 기본 사운드 | 관련 설정 |
|---|---|---|
| 컨텍스트가 경고 임계값 도달 | `Ring01.wav` | `soundWarning` / `soundWarningGain` |
| 컨텍스트가 위험 임계값 도달 | `Ring02.wav` | `soundDanger` / `soundDangerGain` |
| Claude가 응답 완료 (`end_turn`) | `tada.wav` | `soundCompletion` / `soundCompletionGain` |
| Claude가 질문하려고 멈춤 | `Speech On.wav` | `soundQuestion` / `soundQuestionGain` |
| Claude 워크플로우/Task 에이전트 또는 Codex spawned-agent 전체 완료 | `Ring06.wav` | `soundWorkflow` / `soundWorkflowGain` / `workflowCompleteBeep` |

모든 사운드 경로를 자신의 WAV 파일로 교체할 수 있습니다. 게인은 50%~5000% 조절 가능(~300% 초과 시 왜곡 가능). 명령 팔레트의 **`claudeStateBar: Test Beep Sound`**로 미리 듣기 가능.

**Codex도 이 사운드를 공유합니다.** 일반 Codex 턴의 완료 비프(`task_complete` 기반)는 `soundCompletion`을 씁니다. 해당 부모 턴이 에이전트를 생성했다면 최종 전체 완료는 대신 `soundWorkflow`로 보내므로 일반 완료음과 워크플로 완료음이 중복해서 울리지 않습니다. Codex 전용 사운드 설정은 없습니다. Codex 질문 대기 비프와 멈춤 감지 비프는 아직 구현하지 않았습니다.

**워크플로우 완료 비프 게이트** — 이번 세션에서 실제로 워크플로우가 실행 중 → 완료로 전환되는 것을 확인했을 때만 비프가 울립니다. Claude 워크플로우(`wf_*`)는 실행 완료 기록(`workflows/<wfId>.json`의 `status: "completed"`)까지 기다립니다. Codex는 최신 부모 `task_started` 이후의 명시적인 `source.subagent.thread_spawn.parent_thread_id` 연결을 중첩 자손까지 따라가고, 연결된 spawned-agent rollout이 전부 끝난 뒤 부모 `task_complete`까지 확인합니다. 즉 `agent-turn-complete`와 같은 최종 경계입니다. 그래서 **순차 배치**도 중간 공백에는 울리지 않고 **맨 끝에 딱 한 번** 울립니다. 실패·중단된 실행은 워크플로 성공음을 울리지 않으며, VS Code 시작 전부터 이미 완료된 작업은 베이스라인 처리되어 무음입니다.

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
📊 컨텍스트 37K / 1.0M (4%)
| Cache Read | 8K |  | Cache Creation | 28K |
🕐 Last updated: 오후 2:10:58
Click for menu (hide / restore / settings)
```

---

## ⚙️ 설정 패널 (웹뷰, 한/영)

명령 팔레트에서 **`claudeStateBar: Open Settings Panel`**를 열면, 런타임 **English / 한국어** 토글이 있는 단일 패널이 뜹니다. Org ID, Session Key, 새로고침 간격, 텔레그램 Bot Token(Chat ID 자동 감지), 사운드 설정(미리듣기 포함), 컨텍스트 모니터 옵션을 한 곳에서 입력합니다. 민감 값은 암호화 SecretStorage로, 나머지는 표준 VS Code 설정과 동기화됩니다.

### 자격증명 얻는 법
- **Org ID** — claude.ai → 개발자도구 → Network → `/api/organizations/{UUID}/…` 요청
- **Session Key** — claude.ai → 개발자도구 → Application → Cookies → `sessionKey`

---

## 🔔 텔레그램 세션 리셋 알림 (선택)

설정에서 Bot Token을 넣고, 봇에게 아무 메시지나 보낸 뒤 **"내 텔레그램과 연결"**을 누르면(Chat ID 자동 감지) — Claude 5시간 세션 창이 리셋될 때마다 알림이 옵니다.

---

## 🚀 리셋을 감지하면 다음 블록 자동 시작 (선택, 기본 꺼짐)

5시간 블록은 **앵커 모델**입니다. **첫 메시지 시각**부터 시작해 정확히 5시간 뒤에 리셋되며, 고정된 시간표로 자동 순환하지 **않습니다.** 그래서 자리를 비운 사이 블록이 리셋되면, 다음에 입력하기 전까지는 아무것도 열리지 않습니다.

**`claudeState.autoStartBlockOnReset`** 를 켜면, 확장이 **블록이 닫히는 순간**(세션 사용량이 0%로 떨어질 때) 더미 `claude -p` 프롬프트를 발사해 다음 블록을 대신 열어줍니다. 발사는 전용 임시 디렉토리에서 이뤄지며, 이 더미 세션은 상태바에서 자동으로 걸러집니다.

- **리셋당 한 번만** 발사합니다 — VS Code 창이 여러 개거나 절전 해제 순간에 몰려도 — 원자적 10분 이벤트 락으로 보장합니다.
- **절전 해제 발사:** 절전 중에 리셋이 지나갔으면, 깨어난 뒤 첫 폴링에서 발사합니다. 그래서 **일어나면 이미 시작된 블록**이 기다립니다. 깨어 있을 때는 **블록이 닫힌 뒤 첫 성공 폴링에서** 발사됩니다 — 기본 5분 간격(`claudeState.refreshIntervalSec`)이라, 새 블록은 리셋 정각이 아니라 **감지 시점**에 앵커됩니다.
- ⚠️ 새 창은 **즉시 카운트다운을 시작합니다 — 자는 동안에도요.** 이게 이 기능의 목적이지만, 알고 켜세요.
- `claude` CLI가 PATH에 있어야 하고 VS Code가 켜져 있어야 합니다. 컴퓨터가 완전히 절전이면 폴링이 멈추므로, 발사는 **깨어날 때** 일어나지 리셋 정각은 아닙니다. 정각 발사를 원하면 OS 스케줄러가 필요합니다.

이 기능과 텔레그램 리셋 알림은 **설정 패널**(텔레그램 섹션)에서 켜고 끕니다.

### 과금 안전장치

이 기능은 headless `claude -p` 실행이 **구독**으로 처리될 때만 의미가 있습니다. Anthropic이 이를 **API 과금**으로 돌리겠다고 예고한 적이 있어서:

- **발사 거부** — 환경에 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 이 있으면 아예 쏘지 않고(그 호출은 구독이 아니라 API로 나갑니다), 경고와 함께 설정을 끕니다.
- **사후 검증** — 발사 후 `sessionResetAt` 이 약 5시간 뒤로 이동했는지 확인해 블록이 실제로 열렸는지 봅니다. 작은 더미 프롬프트는 세션 %를 움직이지 않으므로 resetAt이 진짜 신호입니다. API 키가 없으면 과금 위험이 없으므로, 검증 실패는 기록만 하고 기능을 끄지는 **않습니다.**

---

## 🧹 좀비 상태바 항목 정리

VS Code가 창이 열린 상태에서 확장을 업데이트하면, 이전 인스턴스의 상태바 아이템이 클릭에 반응하지 않는 "좀비" 픽셀로 남을 수 있습니다. Claude Code & Codex Status Bar는 두 가지 방법으로 처리합니다:

1. **버전 변경 감지** — 활성화 시 마지막 실행 버전이 바뀌었으면 "창 다시 로드해서 오래된 항목 정리?" 알림을 1회 표시합니다.
2. **QuickPick 정리** — 세션 메뉴에 항상 **🗑 오래된/좀비 항목 정리 (창 다시 로드)** 항목이 있습니다.

---

## 설정 항목

모든 키는 `claudeContextBar.*` 또는 `claudeState.*` 접두사를 씁니다.

### 핵심 표시 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.baseColor` | `White` | 모든 세션이 공유하는 평상시 글자색. 그 외 색 변화는 사용량 경고만 뜻함 |
| `claudeContextBar.contextLimitDefault` | `200000` | 표준 모델 컨텍스트 한도 |
| `claudeContextBar.contextLimitOpus` | `1000000` | 1M 컨텍스트 모델 한도 (Opus 4.x, Fable/Mythos, Sonnet 4.6+/5+) |
| `claudeContextBar.warningThreshold` | `50` | 노란 경고 배경 % |
| `claudeContextBar.dangerThreshold` | `75` | 빨간 위험 배경 % |
| `claudeContextBar.refreshInterval` | `30` | 새로고침 간격(초) |
| `claudeContextBar.idleTimeout` | `180` | 세션이 **흐려지는** 시간(초) |
| `claudeContextBar.hideAfter` | `86400` | 세션이 **숨겨지는** 시간(초, ≥ idleTimeout) |
| `claudeContextBar.scope` | `workspace` | `workspace`: Claude는 현재 폴더, Codex는 이 창의 마지막 선택 UUID; `all`: 프로젝트·창 전체의 최근 세션 |
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
| `claudeContextBar.soundWorkflow` | `""` | Claude 워크플로우/Task 또는 Codex spawned-agent 전체 완료 비프 WAV 경로 |
| `claudeContextBar.soundWorkflowGain` | `100` | 워크플로우 완료음 게인 % |
| `claudeContextBar.workflowCompleteBeep` | `true` | Claude 워크플로우/Task 또는 Codex spawned-agent 전체 완료 시 워크플로 음 재생 |
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
| `claudeContextBar.codex.scanDays` | `3` | `scope: all`에서 최근 날짜 폴더를 스캔할 범위. 현재 대화 모드는 선택 UUID를 직접 찾음 |

### Codex 실행 기록 (codex_rescue)

실행 기록은 크기 편차가 큽니다 — 측정된 표본은 **한 번에 409KB~750KB**였고, 한 464KB 표본에서는
86% 정도가 명령 실행 결과 전문이었습니다. 켜지 않는 한 자동으로 지워지지 않습니다.

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.codexRunAutoCleanup` | `false` | 확장이 켜질 때 오래된 실행 기록을 1회 정리. 파일을 지우는 동작이라 기본은 꺼짐. 진행 중이거나 lock이 남은 실행은 절대 건드리지 않습니다 |
| `claudeContextBar.codexRunRetentionDays` | `7` | 자동 정리를 켰을 때 보관할 기간(일) |
| `claudeContextBar.codexRunDeleteDocs` | `false` | **자동** 정리가 요청서·응답·리뷰 `.md` 문서까지 지울지. 기본은 꺼짐 — 그 문서는 무엇을 묻고 무엇을 답했는지의 기록이며 보통 커밋해서 남깁니다. 수동 삭제는 이 값과 무관하게 문서까지 가져가지만, 가는 곳은 휴지통까지입니다 |

패널에서 🗑로 지우면 **묻지 않고 문서까지 통째로** 휴지통으로 들어가며, 버튼은 끝난 실행에만
나타납니다. 묻는 건 되돌릴 수 없는 쪽에 있습니다 — 휴지통에서 완전 삭제하거나 비울 때입니다.
바로 지우는 경로는 자동 정리뿐이고, 위 설정이 관장하는 것도 그쪽입니다.

그 밖의 설정 — 임계값, 사운드, `compactMode`, `idleTimeout`, `hideAfter`, `scope` — 은 Claude와 Codex가 공유합니다.

---

## 요구사항

- VS Code 1.74.0 이상
- [Claude Code](https://www.anthropic.com/claude-code)가 실행 중이고 `~/.claude/projects/`에 세션 로그를 기록 중
- 플랜 사용량용: claude.ai 계정 (Org ID + Session Key)
- Codex 세션용(선택): OpenAI Codex가 `~/.codex/sessions/`에 rollout 로그를 기록 중 — **로컬** 머신, 또는 Remote‑SSH 창에서는 **원격 호스트**

## 동작 원리

컨텍스트 모니터링은 네트워크를 전혀 쓰지 않습니다. 네트워크를 타는 경로는 전부 선택적이고 별개입니다 — claude.ai 플랜 사용량 조회, 텔레그램, 그리고 아래에 설명하는 Codex 계정 사용량 조회. 컨텍스트 모니터링은 `vscode.workspace.fs`로 Claude Code의 JSONL 로그를 읽는 순수 디스크 작업입니다(로컬/원격). 플랜 사용량은 Electron의 Chromium 네트워크 스택으로 claude.ai usage 엔드포인트를 호출하며(Cloudflare 통과), 순수 `https` 폴백을 둡니다. 워크플로우 뷰어는 `~/.claude/projects/<slug>/<uuid>/subagents/`를 디스크에서 직접 읽습니다. Codex **컨텍스트와 spawned-agent 완료** 모니터링도 마찬가지로 `vscode.workspace.fs`로 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`을 읽는 순수 디스크 작업이며(로컬/원격), 네트워크 호출 없이 구조적 필드만 파싱합니다. Codex **계정 사용량**은 짧게 실행되는 로컬 `codex app-server` 프로세스에 JSON‑RPC로 실시간 조회하며(자체 타이머, 최소 60초), 실패 시 rollout 로그의 `rate_limits` 스냅샷으로 폴백합니다. VS Code 창이 여러 개 열려 있어도 그중 **한 창만** 조회를 실행합니다. 결과는 확장의 `globalStorage`에 있는 비밀값 없는 캐시에 원자적 교체로 저장되고(프로세스 간 잠금으로 보호), 나머지 창은 그 값을 읽고 감시합니다. 그래서 모든 창이 항상 같은 숫자를 보여줍니다.

---

## ⭐ 도움이 되셨나요?

**저장소에 별 하나만 눌러주세요.** 부탁은 이것뿐입니다.

다운로드 수는 그냥 숫자입니다. 별은 사람입니다. 이 확장 덕분에 컨텍스트 한도나 주간 한도를 한 번이라도 덜 날리셨다면, 2초만 써주세요.

**→ [github.com/comonetso/claudeStateBar](https://github.com/comonetso/claudeStateBar)**

버그 제보와 기능 제안은 [Issues](https://github.com/comonetso/claudeStateBar/issues)에서 환영합니다.

---

## 크레딧

원작 컨텍스트 모니터링 코어 by [Ed Zisk (@ezoosk)](https://github.com/ezoosk). 이 확장은 그 토대 위에 Claude.ai 플랜 사용량, Remote‑SSH 지원, 텔레그램 알림, 웹뷰 설정 패널, 워크플로우/에이전트 뷰어, 사운드 알림 등을 추가하여 **Blueming**이 유지보수합니다.

## 라이선스

MIT © 2026 Blueming. 원작 코어 © 2025 Ed Zisk.
