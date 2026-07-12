# Claude State Bar

**Claude Code 컨텍스트 사용량 + Claude.ai 플랜 사용량(5시간 세션 & 주간)을 VS Code 상태바에서 한눈에 — 실시간 워크플로우/에이전트 뷰어 패널, 사운드 알림, Remote‑SSH 지원, 텔레그램 리셋 알림, 한/영 설정 패널 포함.**

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

---

## 🌐 Remote‑SSH 지원

**Remote‑SSH** 환경에서도 두 가지를 동시에 합니다. Claude State Bar는 **UI(로컬) 확장**으로 실행됩니다:

- **플랜 사용량**은 **로컬 PC**의 Electron 네트워크 스택으로 가져옵니다 — Cloudflare 봇 챌린지를 통과합니다. (원격/헤드리스 호스트의 순수 Node `https`는 Cloudflare `403`을 받고, AWS EC2 같은 클라우드·데이터센터 IP는 TLS 핑거프린트와 무관하게 차단됩니다.)
- **토큰 카운트**는 **원격** 호스트의 `~/.claude/projects`를 `vscode.workspace.fs`로 읽습니다. VS Code가 SSH 너머로 자동 라우팅합니다. 원격 홈은 자동 탐색(`/root`, 없으면 `/home/*`)합니다.

**로컬에 한 번 설치하면 모든 Remote‑SSH 창에 자동 적용됩니다.** `ui`-kind 확장이므로 서버마다 재설치할 필요가 없습니다.

Remote‑SSH 창에서 **원격 세션 토큰 사용량과 플랜 사용량을 한곳에서** 봅니다. 호스트가 claude.ai에 도달할 수 없으면 오해를 주는 "만료" 오류 대신 "이 환경에선 플랜 사용량 불가"라는 정직한 안내가 표시됩니다(Session Key는 정상).

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

**워크플로우 완료 비프 게이트** — 이번 세션에서 실제로 워크플로우가 실행 중 → 완료로 전환되는 것을 확인했을 때만 비프가 울립니다. VS Code 시작 전부터 이미 완료된 워크플로우는 자동으로 베이스라인 처리되어 무음입니다.

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
| `claudeState.refreshIntervalSec` | `300` | 플랜 사용량 폴링 간격(초) |

(Session Key, Bot Token, Chat ID는 settings.json이 아니라 SecretStorage에 저장됩니다.)

---

## 요구사항

- VS Code 1.74.0 이상
- [Claude Code](https://www.anthropic.com/claude-code)가 실행 중이고 `~/.claude/projects/`에 세션 로그를 기록 중
- 플랜 사용량용: claude.ai 계정 (Org ID + Session Key)

## 동작 원리

선택적 claude.ai 플랜 사용량 조회와 텔레그램을 제외하면 네트워크 호출이 없습니다. 컨텍스트 모니터링은 `vscode.workspace.fs`로 Claude Code의 JSONL 로그를 읽는 순수 디스크 작업입니다(로컬/원격). 플랜 사용량은 Electron의 Chromium 네트워크 스택으로 claude.ai usage 엔드포인트를 호출하며(Cloudflare 통과), 순수 `https` 폴백을 둡니다. 워크플로우 뷰어는 `~/.claude/projects/<slug>/<uuid>/subagents/`를 디스크에서 직접 읽습니다.

---

## 크레딧

원작 컨텍스트 모니터링 코어 by [Ed Zisk (@ezoosk)](https://github.com/ezoosk). 이 확장은 그 토대 위에 Claude.ai 플랜 사용량, Remote‑SSH 지원, 텔레그램 알림, 웹뷰 설정 패널, 워크플로우/에이전트 뷰어, 사운드 알림 등을 추가하여 **Blueming**이 유지보수합니다.

## 라이선스

MIT © 2026 Blueming. 원작 코어 © 2025 Ed Zisk.
