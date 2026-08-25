# [Claude 작성] 2026-08-01 세션 로그 part4 — Codex 사용량 불일치 진단 → Codex에 수정 위임 → v1.8.0/v1.8.1 마켓 릴리즈

> **작성 에이전트**: Claude Code
> **선행 로그**: part2·part3은 Codex 작성분(아이콘 교정 / 완료음·툴팁 정리). 이 로그는 그 이후 구간이다.

<!-- HANDOFF_BEGIN -->
## 이어받기 ★

- **세션 성격**: /start → Codex 표시 불일치 실측 진단 → codex_rescue 요청서(readonly→edit 전환) → Codex가 코드 수정 → **v1.8.0 마켓 릴리즈**(확장명 변경 포함) → 체인지로그 가독성 지적 → **v1.8.1 재릴리즈**
- **저장소/브랜치**: claudeStateBar / main · **이 세션 커밋**: `68a8e85`(v1.8.0 릴리즈 문서), `c060971`(v1.8.1 체인지로그) · 직전 baseline `2c1ef34` · **remote**: SSH, push 완료
- **미커밋 변경**: 없음

**현재 상태**
- 목표: 창마다 Codex 값이 다른 문제 해결 + 릴리즈
- 완료:
  - **마켓 배포 완료** — `v1.8.0` → `v1.8.1` 게시 확인. 확장명 **Claude & Codex State Bar**로 변경.
  - Codex가 P1(창 간 불일치)·P3·P4 수정. 공유 캐시(globalStorage + `wx` 잠금)로 한 창만 probe.
  - 잔여율 표시 반전, resetsAt 이중변환(`2064963d`) 수정, account-only `⬢ Codex` fallback — 전부 Codex 작업분.
  - 체인지로그·README 2종·description·키워드 정비.
- 미완료: **P2 미해결**, Open VSX 미연결
- **다중 창 실측 완료** — 사용자가 여러 창에서 확인, "모든 부분이 원하는 대로 업데이트됐다"고 확인함(2026-08-01)

**다음 한 줄 액션**
- 이 트랙은 닫혔다. 다음 작업은 미해결 항목의 별도 트랙에서 고를 것 (P2 재현 채집 / Open VSX / Codex 뷰어).

**검증 상태**
| 항목 | 문법/컴파일 | 테스트 | 실기기·실환경 | 사용자 확인 |
|---|---|---|---|---|
| 공유 캐시(창 간 일치) | ✅ | ✅ 가짜 app-server 동시 8호출 → spawn 1회·값 8개 일치 | ✅ **다중 창 실측 완료** | ✅ |
| `\\?\` 경로 정규화 | ✅ | ✅ 6케이스(확장드라이브/확장UNC/일반UNC/`C:\`/`/`/POSIX) | — | — |
| 잔여율 표시 반전 | ✅ | — | ✅ 로컬 | ✅ 웹 "47% 남음" = 53% 사용 대조 |
| resetsAt 이중변환 수정 | ✅ | — | ✅ 로컬 | ✅ |
| account-only fallback | ✅ | — | ✅ 로컬(Sported 창) | ✅ |
| 마켓 배포 | — | — | ✅ **v1.8.1 게시 로그 확인** | ✅ 스크린샷 |
| Open VSX | — | — | ❌ 토큰 없어 미배포 | — |

**미해결 항목**
- 즉시 처리: 없음
- 검증 미완: 없음 (다중 창 실측까지 완료)
- 별도 트랙:
  - **P2 — 실행 중인 Codex 세션이 rollout·SQLite 어디에도 없던 건.** Codex도 못 밝힘(중간 확신). 재현 시 채집 항목은 §3-2.
  - **Open VSX 미연결** — 역대 릴리즈 전부 실패해왔다. 하려면 Eclipse 계정 GitHub 연결 → Publisher Agreement 서명 → namespace 생성. 사용자 판단으로 보류.
  - `npm run lint` 실행 불가 (ESLint 미설치)
  - Codex 워크플로우/서브에이전트 뷰어(`thread_spawn_edges` 0행), Codex 질문·멈춤 비프, 워크플로우 실패종료 UX

**⚠️ 다음 세션 주의**
- **`package.json`을 `JSON.stringify`로 재작성 금지** (이월 룰). 이번엔 Edit로만 만졌다.
- **`[hide]` 진단 로그 유지** (이월 룰). 숨김 이슈 미해결.
- **확장 ID(`name: claude-state-bar`)를 절대 바꾸지 마라.** displayName만 바꿨다. ID를 바꾸면 마켓에서 별개 확장이 되고 기존 112명이 업데이트를 못 받는다.
- **같은 버전 번호로는 재배포가 안 된다.** 마켓 CHANGE LOG 탭을 고치려면 버전을 올려야 한다(이번에 1.8.1을 낸 이유).
- 레포 루트에 로컬 테스트 `.vsix` 17개가 쌓여 있다(gitignore라 커밋엔 없음). 정리는 사용자 판단.

**KB 승격 후보** (위키 스킵 세션)
- ChatGPT 웹은 **"남음"**, app-server는 **"사용"** — 보수 관계. 두 세션 연속 이걸 불일치로 오인했다.
- Open VSX 첫 배포의 3중 관문 (Eclipse 계정 GitHub 연결 → Publisher Agreement → namespace)
- `continue-on-error`가 CI 실패를 은폐한다 — 워크플로우는 ✓인데 단계는 죽어 있었다
<!-- HANDOFF_END -->

---

## 1. 작업 흐름

### 1-1. Codex 표시 불일치 진단 (스크린샷 3장 → 디스크 실측)

**배경**: 사용자가 창마다 다른 값을 캡처해 왔다. 창A `⬢ 53%` / 창B `⬢ 52%`, 모델도 `G5.6s` vs `G5.5`, 한 창은 Codex가 **아예 안 보였다**.

**처리**: 추측을 끊고 디스크를 직접 팠다.
1. `~/.codex/sessions/2026/08/01/` — 오늘 rollout **1개뿐**, cwd는 claudeContextBar
2. `state_5.sqlite`의 `threads` 77행 발견 — cwd·model·reasoning_effort·tokens_used·updated_at_ms 전부 보유
3. `logs_2.sqlite`(64230행) 등 SQLite 4개 발견 → "Codex가 SQLite로 이사했다" 가설
4. `discovery.ts:182 normalisePath`에 `\\?\` 처리가 **한 줄도 없음**을 grep으로 확인

**결과**: 원인 3개 확정(창별 독립 probe / `\\?\` 미처리 / SQLite 이전 정황), P2(세션 실종)만 미규명.

### 1-2. codex_rescue — readonly로 썼다가 사용자 지시로 edit 전환

문제 7건(P1~P7)을 한 요청서에 담았다. 사용자 제안 *"클로드처럼 ChatGPT 웹 세션으로 가져오면 안 되나"* 를 메인 질문(P6)으로 올렸다.

edit 전환 시 **"조사 → 확신 서는 것만 수정 → 나머지는 보고"** 순서를 강제하고 지뢰 7건을 명시했다: `package.json` stringify 금지, `[hide]` 로그 유지, SQLite는 `?mode=ro` 필수(WAL 쓰기 락 금지), 커밋·태그·버전올림 금지, `~/.codex` 쓰기 금지, 비밀값 금지.

### 1-3. v1.8.0 릴리즈

Codex 작업분 위에 릴리즈 문서 작업을 얹었다 — 확장명 변경, description 재작성, 키워드 추가, README 2종 동기화, GitHub 스타 요청 2곳 삽입, CHANGELOG `Changed` 섹션 신설. 빌드·설치·커밋·태그·푸시까지.

### 1-4. 체인지로그 가독성 지적 → v1.8.1

사용자: *"체인지로그를 이렇게 두서없이 써놓으면 어떻게 해?"* 마켓 CHANGE LOG 탭 독자 기준으로 재작성했다. 같은 버전 재배포가 불가하므로 1.8.1 패치 릴리즈로 반영.

---

## 2. 의사결정 로그

| 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|
| **SQLite 전환 안 함** | Codex 반박: `thread/list`가 JSONL을 스캔해 DB를 복구하고, DB 스키마·파일명은 내부 구현. P2도 DB에 없었으니 전환해도 안 풀림 | ①SQLite 1차 소스 ②app-server `thread/list` ③현행 유지 | 내 가설 H1·H2가 기각됐다. rollout JSONL 유지가 맞았다 |
| **ChatGPT 웹 직접 조회 안 함** | `/backend-api/wham/usage`는 비공개 계약. app-server가 인증·refresh·정규화를 이미 감싼다 | `auth.json` 토큰 재사용 | 사용자 제안을 기각. 대신 보안 경계가 작아진다 |
| **창 간 일치를 공유 캐시로** | 원인이 저장소가 아니라 창별 타이머·메모리였다 | ①표시를 5% 단위로 뭉개기 ②polling 주기 단축 | 디스크 쓰기가 생기지만 app-server 스폰이 창N회→1회로 감소 |
| **확장 ID 유지, displayName만 변경** | ID를 바꾸면 마켓에서 별개 확장이 되어 기존 112명이 업데이트를 못 받는다 | `name`도 함께 변경 | 검색·표시는 새 이름, 내부 식별자는 옛 이름으로 갈린다 |
| **CHANGELOG 수정에 1.8.1 발행** | 같은 버전은 재배포 불가. 마켓 탭을 고치려면 버전을 올려야 한다 | 다음 기능 릴리즈까지 대기 | 코드 변경 0인데 사용자에게 업데이트 알림이 한 번 더 간다 |

---

## 3. 시행착오

### 3-1. ★ 부차적 문제를 주 작업처럼 끌고 갔다

- **잘못된 가정**: CI 로그의 빨간 exit 1을 "이번 릴리즈의 문제"로 읽었다.
- **발견 경위**: Open VSX 토큰 → Eclipse 계정 → Publisher Agreement → namespace로 사용자를 계속 끌고 다녔고, 사용자가 **"지금 뭐 하는 거야? 이해를 할 수 없어"** 로 제동을 걸었다.
- **실제**: `OVSX_PAT`는 **처음부터 등록된 적이 없었고**(`gh secret list` = `VSCE_PAT` 하나뿐), 역대 릴리즈가 전부 그 단계에서 실패해왔다. 이번 릴리즈와 무관한 기존 상태였다. 그 사이 **VS Code Marketplace 배포는 이미 성공해 있었다.**
- **교훈**: 주 목표(마켓 배포) 달성 여부를 **먼저 확정해 보고**하고, 부차적 실패는 그 다음에 "원래부터 이랬고 안 해도 된다"로 분리해 제시했어야 했다.

### 3-2. P2를 내 가설로 설명하려 했다

- **잘못된 가정**: "SQLite가 정본인데 우리가 JSONL만 읽어서 세션이 안 보인다"(H1).
- **모순**: 그 세션은 **SQLite에도 없었다.** 요청서에 이 구멍을 명시해 Codex에게 넘긴 것이 그나마 옳은 처리였다.
- **Codex 결론**: `logs_2.sqlite`는 tracing 로그일 뿐(해당 구간 26행 전부 `thread_id IS NULL`), `thread/loaded/list`는 **그 app-server 프로세스 메모리 한정**이라 다른 창의 상태를 못 본다. 다른 cwd로 만든 기존 스레드를 그 창에서 resume했을 가능성이 가장 높다(중간 확신).
- **재현 시 채집할 것**: ①OpenAI Codex Output의 thread ID와 `thread/start` vs `thread/resume` ②`state_5.sqlite`의 해당 ID·cwd·updated/recency ③rollout `session_meta.cwd`와 turn 시작 시각 ④새 스레드인지 기존 스레드를 다른 창에서 연 것인지

---

## 4. 발견한 코드베이스 함정 (위키 스킵 세션 — 전문을 여기 둔다)

### 4-1. ChatGPT 웹은 "남음", app-server는 "사용" — 보수 관계

웹 설정 화면은 **"주간 사용량 한도 47% 남음"**, app-server `account/rateLimits/read`는 `usedPercent: 53.0`. 같은 값의 앞뒤다.

직전 세션이 이걸 "app-server 52% vs 사용자 관측 48%"의 **불일치**로 기록해 최우선 조사 과제로 남겼는데, 실제로는 `52 + 48 = 100`이었다. 이번 세션에도 같은 착시가 반복될 뻔했다.

→ Codex 사용량 숫자를 다룰 땐 **어느 쪽이 "남음"인지 먼저 확정**할 것. 현재 UI는 잔여율로 표시한다(`100 - usedPercent`).

### 4-2. `\\?\` UNC 접두사는 SQLite에만 붙는다

| 소스 | cwd 표기 |
|---|---|
| `state_5.sqlite` `threads.cwd` | `\\?\F:\workspace\Etc Project\...` |
| rollout `session_meta.cwd` | `f:\workspace\Etc Project\...` |

Rust `std::fs::canonicalize`가 Windows에서 확장길이 경로를 반환하는 게 원인으로 보인다(Codex 판단, 중간 확신).

기존 `normalisePath`는 `\\?\F:\proj` → `//?/F:/proj`로 만든 뒤 `/^[a-zA-Z]:/` 검사에 실패해 **소문자화까지 건너뛰었다.** 드라이브 루트 `C:\`도 `C:`로 훼손했다.

→ **JSONL만 쓰는 동안엔 안 터진다.** SQLite 값을 쓰는 순간 전 창에서 세션 0건이 된다. 지금은 수정됐다(6케이스 검증).

### 4-3. `thread/loaded/list`는 머신 전체가 아니라 그 프로세스 메모리다

새로 띄운 app-server에서 `thread/loaded/list` = 0건, 같은 스레드 `status` = `notLoaded`. **다른 VS Code 창의 app-server가 들고 있는 live 상태를 별도 프로세스가 관측할 수 없다.**

→ "지금 이 webview가 어떤 스레드를 열고 있나"는 OpenAI 확장이 공개 API를 주기 전엔 정확히 알 수 없다. P2가 안 풀리는 근본 이유다.

### 4-4. `logs_2.sqlite`는 세션 정본이 아니다

스키마: `id, ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid, estimated_bytes`.

`thread_id`가 nullable이고 app-server 초기화·config·HTTP·telemetry 같은 threadless 로그가 대부분이다. 문제 구간 26행이 **전부 `thread_id IS NULL`**이었다.

→ 이 파일의 mtime이 최신이라고 해서 "세션이 여기 기록 중"이 아니다. **우리 확장의 rate-limit probe 자체가 이 로그를 만든다.**

### 4-5. `continue-on-error`가 CI 실패를 은폐한다

`publish.yml`의 마켓 배포 두 단계에 `continue-on-error: true`가 걸려 있다. Open VSX가 죽어도 **워크플로우는 `✓ success`**로 뜨고 `gh run list`에도 성공으로 보인다. annotation의 exit 1만이 유일한 흔적이다.

→ 릴리즈 후엔 워크플로우 성공 여부가 아니라 **단계별 로그에서 `Published ...` 문자열**을 확인할 것.

### 4-6. Open VSX 첫 배포는 관문이 3중이다

1. **Eclipse 계정에 GitHub 연결** — 프로필의 `GitHub Username` 칸은 비활성이라 직접 못 쓴다. `Link GitHub Account` 페이지에서 OAuth로 붙여야 채워진다.
2. **Publisher Agreement 서명** — 없으면 Access Token 생성 자체가 막힌다.
3. **namespace 생성** — `ovsx create-namespace blueming` 최초 1회. 워크플로우에 없는 단계다.

### 4-7. 빌드 도구가 devDependencies에 없다

`devDependencies`는 `@types/node`, `@types/vscode`, `typescript` 셋뿐이다.
- `npm run package`(=`vsce package`)는 **실패한다.** `npx --yes @vscode/vsce package`를 써야 한다. (part3에서 Codex도 같은 곳에 걸렸다)
- `npm run lint`(=`eslint`)는 **실행 자체가 불가**하다. lint 실패가 아니라 도구 부재다.

---

## 5. 사용자 핵심 발언

- > "지금 1.8.0이 마켓플레이스에 올라갔어? 지금 뭐 하는 건지 난 이해를 할 수 없어. 지금 뭐 하는 거야?"

  — Open VSX 미로에 빠져 있을 때. **주 목표 달성 여부를 먼저 확정 보고하지 않으면, 부차 작업이 아무리 정당해도 사용자에겐 길을 잃은 것으로 보인다.** 적용 범위: 릴리즈·배포처럼 "됐나 안 됐나"가 명확한 작업 전반.

- > "체인지로그를 이렇게 두서없이 써놓으면 어떻게 해? 사람들이 보기 좋게 써줘야지"

  — 마켓 CHANGE LOG는 **최종 사용자가 읽는 문서**다. 구현 세부(토큰 계산식, 내부 필드명, 잠금 방식)는 빼고 "무엇이 어떻게 달라졌나"만 남긴다. 적용 범위: CHANGELOG·README 등 배포물에 포함되는 모든 문서.

- > "리드미에 레포지토리 별 좀 달라고 강조 좀 해줘. 갖다 쓴 사람은 엄청 많은데 별을 하나도 안 주네."

  — README 상단 배지+박스, 하단 전용 섹션 두 곳에 삽입. 영문·한글 양쪽.

---

## 8. 변경 파일 인벤토리

```
# 68a8e85 — v1.8.0 릴리즈 문서
M package.json    [displayName→"Claude & Codex State Bar", description 재작성,
                   keywords에 codex/openai/chatgpt 추가, 명령 title 접두사 통일]
M README.md       [제목·태그라인, 스타 요청 2곳, 공유 캐시 동작 서술, 명령 표기 정정]
M README.ko.md    [영문과 1:1 동기화 — 헤딩 32개, 줄 번호까지 일치]
M CHANGELOG.md    [1.8.0에 Changed 섹션 신설]

# c060971 — v1.8.1 체인지로그 가독성
M package.json    [version 1.8.0 → 1.8.1]
M CHANGELOG.md    [1.8.0 블록 전면 재작성(소제목 그룹핑·항목당 1줄·내부구현 제거) + 1.8.1 항목]
```

Codex의 코드 수정분 상세는 응답 문서 [260801_045234_response_codex-usage-source-of-truth.md](../codex_rescue/260801_045234_response_codex-usage-source-of-truth.md) §5~§7 참조.
