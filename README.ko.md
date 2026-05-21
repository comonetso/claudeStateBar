# claudeStateBar

**Claude Code 컨텍스트 사용량 + Claude.ai 플랜 사용량(5시간 세션 & 주간)을 VS Code 상태바에서 한눈에 — Remote‑SSH 지원, 텔레그램 리셋 알림, 한/영 설정 패널 포함.**

🇬🇧 English: [README.md](README.md)

> **포크 안내.** 이 확장은 **Ed Zisk([@ezoosk](https://github.com/ezoosk))** 님의 [**claude-context-bar**](https://marketplace.visualstudio.com/items?itemName=ezoosk.claude-context-bar)를 **포크**한 것입니다. 원작은 컨텍스트 모니터링 코어를 제공합니다. 여기에 **Blueming**이 Claude.ai 플랜 사용량, Remote‑SSH 지원, 텔레그램 알림, 웹뷰 설정 패널을 추가·유지보수합니다. 마켓 식별자(`ezoosk.claude-context-bar`)와 `claudeContextBar.*` 설정 키는 업데이트 호환을 위해 그대로 둡니다.

---

## 상태바 안의 두 계층

claudeStateBar는 서로 보완되는 두 가지를 보여주며, 하나의 호버 툴팁 안에서 섹션으로 명확히 구분됩니다.

### 🧠 claudeContext — Claude Code 컨텍스트 모니터
Claude Code의 세션 로그(`~/.claude/projects/*.jsonl`)를 읽어 활성 탭별로 표시:
- **실시간 컨텍스트 사용량 %** (사용 토큰 vs 모델 한도)
- **탭별 모니터링** — Claude Code 세션마다 독립 상태바 아이템
- **모델 인식 한도** — Sonnet 4.5 **1M** → 1,000,000 토큰, 그 외 → 200,000 (설정 가능)
- **모델 + Effort + 속도** — 예: `Opus 4.7 · High · ⚡fast`
- **색상 경고** — 정상 / 경고(≥50%) / 위험(≥75%) 배경색
- **2단계 idle** — `idleTimeout`(기본 180초) 후 흐려지고, `hideAfter` 후 완전히 숨김
- **유령 세션 감지** — `/clear`나 탭 종료 후 오래된 세션 숨김, 새 활동 시 자동 복원
- **컴팩트 모드 & 커스텀 약칭** — `my-cool-project → MCP`, `typescript → Tscript`

### 📊 claudeState — Claude.ai 플랜 사용량
계정 전역 플랜 사용량을 claude.ai에서 직접 가져옵니다(SDK·별도 서비스 없음):
- **5시간 세션 한도 %** + 리셋 카운트다운 (첫 세션 아이템에 합쳐 표시)
- **주간 사용량 %**, 툴팁에 **Sonnet / Opus** 모델별 분해
- **세션 리셋 감지** → 5시간 창이 리셋되면 선택적 **텔레그램** 알림
- 자격증명(Session Key, Bot Token)은 VS Code SecretStorage로 **암호화** 저장

---

## 🌐 Remote‑SSH 지원 (v1.7.0)

**Remote‑SSH** 환경에서도 두 가지를 동시에 합니다. claudeStateBar는 **UI(로컬) 확장**으로 실행됩니다:

- **플랜 사용량**은 **로컬 PC**의 Electron 네트워크 스택으로 가져옵니다 — 이게 Cloudflare 봇 챌린지를 통과합니다. (원격/헤드리스 호스트의 순수 Node `https`는 Cloudflare `403`을 받고, AWS EC2 같은 클라우드·데이터센터 IP는 TLS 핑거프린트와 무관하게 차단됩니다. 그래서 로컬에서 가져오는 것이 확실한 길입니다.)
- **토큰 카운트**는 **원격** 호스트의 `~/.claude/projects`를 `vscode.workspace.fs`로 읽습니다. VS Code가 이 읽기를 SSH 너머로 자동 라우팅합니다. 원격 홈은 자동 탐색(`/root`, 없으면 `/home/*`)합니다.

결과적으로 Remote‑SSH 창에서 **원격 세션 토큰 사용량과 플랜 사용량을 한곳에서** 봅니다. 만약 어떤 호스트가 정말 claude.ai에 도달할 수 없으면, 오해를 주는 "만료" 오류 대신 "이 환경에선 플랜 사용량 불가"라는 정직한 안내가 뜹니다(Session Key는 정상).

---

## 🖱️ 통합 툴팁

세션 아이템에 마우스를 올리면, 색 구분선과 라벨로 나뉜 두 섹션이 한 툴팁에 보입니다:

```
sported_new (379508f7)
──────── claudeState ────────      ← 플랜 사용량 (파란 구분선)
📊 세션: 30% — 오후 5:40 (3시간 27분 후)
📅 주간: 20% — 오후 3:00 (토)
Sonnet: 4%  Opus: —%
──────── claudeContext ────────    ← 컨텍스트 사용량 (초록 구분선)
🤖 Model: claude-opus-4-7
🎚️ Effort: High
📊 Context Usage: 4%
| Cache Read | 8K |  | Cache Creation | 28K |  | Total | 37K / 1.0M |
🕐 Last updated: 오후 2:10:58
Click for menu (hide / restore / settings)
```

---

## ⚙️ 설정 패널 (웹뷰, 한/영)

명령 팔레트에서 **`claudeStateBar: Open Settings`**를 열면, 런타임 **English / 한국어** 토글이 있는 단일 패널이 뜹니다. Org ID, Session Key, 새로고침 간격, 텔레그램 Bot Token(Chat ID 자동 감지), 컨텍스트 모니터 옵션을 한 곳에서 입력합니다. 민감 값은 암호화 SecretStorage로, 나머지는 표준 VS Code 설정과 동기화됩니다.

### 자격증명 얻는 법
- **Org ID** — claude.ai → 개발자도구 → Network → `/api/organizations/{UUID}/…` 요청
- **Session Key** — claude.ai → 개발자도구 → Application → Cookies → `sessionKey`

---

## 🔔 텔레그램 세션 리셋 알림 (선택)

설정에서 Bot Token을 넣고, 봇에게 아무 메시지나 보낸 뒤 **"내 텔레그램과 연결"**을 누르면(Chat ID 자동 감지) — Claude 5시간 세션 창이 리셋될 때마다 알림이 옵니다. 풀 할당량으로 다시 시작하기 좋습니다.

---

## 설정 항목

모든 키는 `claudeContextBar.*`(호환 유지) 또는 `claudeState.*` 접두사를 씁니다.

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `claudeContextBar.autoColor` | `true` | 프로젝트별 고유 파스텔 색 |
| `claudeContextBar.baseColor` | `White` | 자동 색상 끌 때 기본 색 |
| `claudeContextBar.contextLimitDefault` | `200000` | 표준 모델 컨텍스트 한도 |
| `claudeContextBar.contextLimitOpus` | `1000000` | 1M 컨텍스트 모델 한도 |
| `claudeContextBar.warningThreshold` | `50` | 노란 경고 배경 % |
| `claudeContextBar.dangerThreshold` | `75` | 빨간 위험 배경 % |
| `claudeContextBar.refreshInterval` | `30` | 새로고침 간격(초) |
| `claudeContextBar.idleTimeout` | `180` | 세션이 **흐려지는** 시간(초) |
| `claudeContextBar.hideAfter` | `3600` | 세션이 **숨겨지는** 시간(초) |
| `claudeContextBar.scope` | `workspace` | `workspace`(현재 폴더만) 또는 `all` |
| `claudeContextBar.showModel` | `true` | 퍼센트 옆에 모델명 표시 |
| `claudeContextBar.compactMode` | `false` | 프로젝트 이름 축약 |
| `claudeContextBar.shortNames` | `{}` | 커스텀 약칭, 예: `{"my-project":"MP"}` |
| `claudeState.orgId` | `""` | claude.ai Organization ID |
| `claudeState.language` | `en` | 설정 패널 언어(`en` / `ko`) |
| `claudeState.refreshInterval` | `300` | 플랜 사용량 폴링 간격(초) |

(Session Key, Bot Token, Chat ID는 settings.json이 아니라 SecretStorage에 저장됩니다.)

## 요구사항

- VS Code 1.74.0 이상
- [Claude Code](https://www.anthropic.com/claude-code)가 실행 중이고 `~/.claude/projects/`에 세션 로그를 기록 중
- 플랜 사용량용: claude.ai 계정 (Org ID + Session Key)

## 동작 원리

선택적 claude.ai 플랜 사용량 조회와 텔레그램을 제외하면 네트워크 호출이 없습니다. 컨텍스트 모니터링은 `vscode.workspace.fs`로 Claude Code의 JSONL 로그를 읽는 순수 디스크 작업입니다(로컬/원격). 플랜 사용량은 Electron의 Chromium 네트워크 스택으로 claude.ai usage 엔드포인트를 호출하며(Cloudflare 통과), 순수 `https` 폴백을 둡니다.

## 크레딧 & 포크

- 원작 **claude-context-bar** 코어 © [Ed Zisk (@ezoosk)](https://github.com/ezoosk) — 이 확장이 기반하는 컨텍스트 모니터링 토대.
- 이 포크 — 플랜 사용량, Remote‑SSH 지원, 텔레그램, 웹뷰 설정 — by **Blueming**.

## 라이선스

MIT. 원작 © 2025 [Ed Zisk](https://github.com/ezoosk); 포크 추가분 © 2026 Blueming.
