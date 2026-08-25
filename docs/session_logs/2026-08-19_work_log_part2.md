# [Claude 작성] 2026-08-19 세션 로그 part2 — 마켓 아이콘·검색 노출 정비 + Codex 패널 Remote-SSH 및 가독성 정리 (v1.9.1·v1.9.2 배포)

<!-- HANDOFF_BEGIN -->
## 이어받기 ★

- **세션 성격**: /start → 아이콘에 Codex 마크(v1.9.1 배포) → **마켓 검색 순위 실측 진단** → 표시명 변경 → 다른 세션의 1.9.2(Remote-SSH) 인수 → **캐시 회귀 발견·수정** → 패널 가독성 5종 → `subject` 규약 신설·서버 4대 배포 → **v1.9.2 배포**
- **저장소/브랜치**: claudeStateBar / main · **기준 커밋**: `21ef143` · **remote**: SSH 정상
- **미커밋 변경**: 없음 (작업 트리 clean). `docs/session_logs/`는 gitignore 대상이라 이 로그는 로컬에만 있다 — 강제 add 금지

**현재 상태**
- 목표: 마켓에서 찾아지게 만들고, Codex 진행 패널을 원격에서도·사람이 읽을 수 있게
- 완료:
  - **v1.9.1** — 마켓 아이콘 우하단에 OpenAI blossom 마크 배지. 마켓 실측 확인
  - **v1.9.2** — Remote-SSH 지원(인수분) + 캐시 회귀 수정 + 카드 제목(`subject`) + 날짜 + 탭/헤더 프로젝트 표시 + 명령·검색 그룹 접기 + 셸 래퍼 제거 + 표시명 변경. 마켓 실측 `1.9.2` / `Claude Code & Codex Status Bar` 확인
  - **codex_rescue 스킬** — `subject` 규약 신설(`send.sh`·`SKILL.md`), vault `74fe1aa`, **서버 4대 반영 실측 완료**
  - **`tools/check-webview.js`** 신규 — 웹뷰 스크립트 문법 검사(tsc가 못 잡는 영역)
- 미완료: 없음. 이 트랙은 닫혔다

**다음 한 줄 액션**
- 이 트랙은 닫혔다. 새 지시 대기. 굳이 이어간다면 **마켓 검색 재측정**(`F:\tmp\mkt.py` 소실됐으면 재작성) — 표시명만 바꿨으므로 순위 변화의 인과가 깨끗하다

**검증 상태**
| 항목 | 문법/컴파일 | 테스트 | 실기기·실환경 | 사용자 확인 |
|---|---|---|---|---|
| 아이콘 v1.9.1 | ✅ | — | ✅ 마켓 API 실측 | ✅ |
| Remote-SSH 원격 실동작 | ✅ tsc | — | ✅ IVR 서버 3건 표시 | ✅ |
| 로컬 회귀 | ✅ | — | ✅ 로컬 3건 표시 | ✅ |
| 캐시 회귀 수정 | ✅ | — | ✅ 서버 status/lock 실측으로 원인 확정 | ✅ |
| 셸 래퍼 제거 | ✅ | ✅ 실물 파서 + 6형태(win/linux/무래퍼) | ✅ | ✅ |
| 그룹 접기 | ✅ | ✅ 실물 57행→30행 측정 | ✅ | ✅ |
| `subject` 기록 | ✅ | ✅ 실제 `write_status` 추출 실행(유/무 양쪽) | ⚠️ **신규 실행 미실측** | — |
| 스킬 서버 4대 배포 | — | — | ✅ grep 3지점 실측 | — |
| 웹뷰 문법 검사 | ✅ | ✅ **대조군으로 탐지력 확인** | ✅ | — |
| v1.9.2 마켓 배포 | ✅ | — | ✅ API 실측 | ✅ |
| REVIEW `--subject` | ✅ 문법 | ❌ | ❌ **미실행** | — |
| `stale` 판정 | ✅ | ❌ | ❌ 이월 | — |

**미해결 항목**
- 즉시 처리: 없음
- 검증 미완:
  - **`subject`가 실제 신규 실행에서 카드에 뜨는 것을 못 봤다.** 규약·기록·표시 각각은 검증했지만 끝에서 끝까지는 아니다. 다음 codex_rescue 실행이 곧 검증이다
  - **REVIEW `--subject` 미실행.** 이번에 새로 만든 인자인데 REVIEW를 한 번도 안 돌렸다
- 별도 트랙 (이월):
  - **Open VSX 미연결** — `OVSX_PAT` 미설정. 1.8.2부터. **CI 초록불은 VS Code 마켓만의 결과다**(해당 스텝 `continue-on-error`)
  - `stale`(무응답) 판정 미실측 · 다중 파일 EDIT 미검증
  - `npm run lint` 불가(ESLint 미설치), `vsce`는 `npx @vscode/vsce`
  - 워크플로우 실패종료 UX

**⚠️ 다음 세션 주의**
- 🔴 **웹뷰 패널 코드는 `getHtml`의 템플릿 리터럴 안이다.** 백틱 금지, 개행은 `\\n`(이중). tsc가 통과시켜도 런타임에 스크립트가 통째로 죽는다. **고친 뒤 `node tools/check-webview.js out/codexRescuePanel.js out/workflowPanel.js`를 반드시 돌려라**
- 🔴 **`settled` 캐시에서 파일 스냅샷 대조를 빼지 마라.** codex_rescue는 죽은 요청을 **같은 stamp로 재실행**한다. 대조가 없으면 창을 재시작할 때까지 옛 상태로 굳는다
- 🔴 **실패한 도구 호출은 그룹에 넣지 마라.** 접기의 전제가 "볼 필요 없는 것만 접는다"이다
- 🔴 **`send.sh` 정본은 `~/.claude/skills/`** — 레포는 사본. 고치면 양쪽 + `/skill_cp_install deploy`
- 🔴 **`RUN_DIR`을 workspace로 옮기지 마라** (이월) · **`docs/codex_rescue/.log/` 커밋 금지** (이월)
- **`package.json`을 `JSON.stringify`로 재작성 금지** (이월) · **`[hide]` 진단 로그 유지** (이월)
- **확장 ID(`claude-state-bar`) 변경 금지** — 표시명만 바꿨다. ID를 바꾸면 기존 설치가 끊긴다
- **`autoColor` 되살리지 마라** (이월) · **Codex 잔여율로 되돌리지 마라** (이월) · **같은 버전 재배포 불가** · **태그 30칸 만석**
- **`/skill_cp_install deploy`의 인자는 서버 이름이다.** 스킬 이름이 아니다(`deploy codex_rescue` → 오작동)

**메모리**: [[project-webview-template-literal-trap]] 신규 · [[project-marketplace-search-ranking]] 신규 · [[project_codex_progress_panel]] 갱신
<!-- HANDOFF_END -->

---

## 1. 작업 흐름

### 1-1. 마켓 아이콘에 Codex 마크 (v1.9.1)

**배경/요구**: "이 익스텐션이 클로드 기반이지만 Codex도 들어가 있는데 아이콘엔 없다."
사용자는 내가 이미지를 수정할 수 없다고 전제하고 물었다 — Pillow 11.3이 있어 가능했다.

**처리**: 도형 작도 → 실물 로고 교체로 방향이 두 번 바뀌었다.
1차로 `provider-icons-src/codex.svg`의 육각형을 좌표로 작도했으나 사용자 판정은 **"코덱스 냄새가 한 개도 안 난다"**.
2차로 로컬 ChatGPT VS Code 확장에서 `resources/blossom.dark.png`(OpenAI 공식 마크)를 발견해 사용.
흰 마크 + 불투명 검정 배경이라 **밝기를 알파로 돌려** 원본 안티에일리어싱을 살렸다.
원본이 한쪽 8.3% 자체 여백을 갖고 있어 잉크 경계로 crop — 이걸 안 하면 검은 패딩이 두 겹이 된다.

**결과**: 잉크 폭 46px → 65px. `images/icon-src/`에 원본 별·마크 사본·작도 스크립트를 남겨 재생성 가능.
마켓 API 실측 `1.9.1` 확인.

### 1-2. 마켓 검색 노출 진단 (v1.9.2에 포함)

**배경/요구**: "마켓플레이스에서 검색이 잘 안 된다. 해시태그 키워드를 정제해야 할 것 같다."

**처리**: 추측 대신 마켓 API로 순위를 실측했다.

| 검색어 | 우리 순위 | 전체 |
|---|---|---|
| `claude` | 520위 | 3,117 |
| `codex` | 156위 | 899 |
| `claude code` | **347위** | 36,922 |
| `claude token` | 36위 | — |
| `codex usage` | 25위 | — |

`claude code` 100위권에 **설치 3건짜리(37위)**, 24건(42위), 27건(38위)이 있었다.
우리는 302건인데 347위 → **인기도 랭킹이 아니다.**
상위권 공통점은 `displayName`/확장 ID에 `claude code`가 **연속된 구**로 들어 있다는 것뿐이었다.
`description` 첫 문장에 이미 그 구가 있는데도 347위 → description 가중치는 낮다.

**결과**: `displayName`을 `Claude & Codex State Bar` → **`Claude Code & Codex Status Bar`**.
keywords(30/30)는 **일부러 손대지 않았다** — 롱테일은 이미 작동 중이고, 동시에 바꾸면 인과를 못 가린다.

### 1-3. 캐시 회귀 — 재실행 갱신 불가 (미배포 상태에서 발견)

**배경/요구**: "Codex가 죽었는데 Claude가 다시 실행했을 때 갱신이 안 되는 것 같다. 삭제도 안 된다."

**처리**: 서버에 직접 접속해 실측했다.

```
패널 표시 : 중단됨 · 19:19:14 · 소요 00:28
서버 실제 : state=done, started_at=19:28:58, finished_at=19:35:26, codex_exit=0
```

`runDiscovery.ts:336`이 캐시 히트 시 **파일을 아예 확인하지 않았다**. `isTerminalPhase`에 `stopped`가 포함되므로
죽은 실행이 캐시에 얼고, 같은 stamp로 재실행해도 옛 결과가 그대로 나온다.
`git show HEAD:...runDiscovery.ts | grep -c settled` → **0**. 1.9.2에서 새로 들어온 **미배포 회귀**였다.

삭제 실패는 별개였다 — `deleteRun`이 lock 존재 시 거부하는 **정상 동작**이고,
그 시각 서버에 `.260819_191705.lock`이 실제로 있었다. 1번 때문에 죽은 줄 알고 지우려 한 것이 원인.

**결과**: 캐시에 `size`·`mtime` 스냅샷을 함께 저장하고 히트마다 `stat`으로 대조. 불일치 시 `settled`·`tails` 동시 무효화.

### 1-4. 패널 가독성 5종

**배경/요구**: 사용자가 화면을 보며 순차적으로 지적했다. 각각이 독립된 요구였다.

| 요구 | 처리 |
|---|---|
| "오전 것이 보여서 이전 것인지 헷갈린다" | 카드 시각에 날짜 추가 → 이후 "연도·초 빼라" → `08/19 15:56` |
| "어떤 프로젝트 것인지 표시해야겠다" | 카드 칩 설계 중 **사용자가 스스로 뒤집음**(§3-2) → 탭 제목 + 헤더 경로 |
| "제목이 slug라 영어고 상징성만 있다" | 요청서 파싱 검토 → **사용자 제안으로 `subject` 규약 신설**(§2) |
| "명령은 내가 볼 일이 없다" | 연속 성공 명령 그룹 접기 + 셸 래퍼 제거 |
| "검색도 접자" | 그룹 대상에 `web_search` 추가, 종류가 바뀌면 묶음 종료 |

**결과**: 실물 측정 — `codex-progress-visibility` 실행 57행 → **30행**.
묶음 구성: 명령 2 · 검색 5 · 검색 6 · 명령 10 · 검색 6 · 명령 2 · 검색 2 · 명령 2.

### 1-5. `subject` 규약 신설 및 서버 4대 배포

**처리**: `send.sh`에 `SUBJECT=""` 초기화(`set -uo pipefail`이라 REVIEW 경로에서 미정의면 죽는다),
front matter 파싱, REVIEW용 `--subject` 인자, `write_status`에 조건부 필드.
`SKILL.md`에 규약(한국어·20자 이내·선택)과 **`--title`과의 차이**를 명시 — 후자는 `codex exec review`에 넘어가는 Codex 인자다.

**결과**: 실제 `write_status` 함수를 스크립트에서 추출해 실행 검증.
```
subject 있음: ..."slug":"subject-smoke","subject":"출발지·도착지가 뒤바뀜","mode":...
subject 없음: ..."slug":"subject-smoke","mode":...
```
vault `74fe1aa` → 서버 4대에 grep 3지점(파싱·옵션·기록)으로 반영 실측.

---

## 2. 의사결정 로그

| 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|
| 아이콘에 **실제 OpenAI 마크** 사용 | 육각형은 "Codex 냄새가 안 난다"는 실사용 판정. 사용자가 로고 이미지를 두 번 제시 | 내부 육각형 심볼 / 청록색(#10a37f)만 | 상표 오인 리스크. 두 번 고지했고 사용자가 재확인 |
| `displayName`만 바꾸고 keywords 유지 | 롱테일이 이미 작동(36·25·35위). 동시 변경 시 인과 판별 불가 | keywords 재설계 병행 | 개선폭이 작을 수 있으나 다음 측정이 깨끗하다 |
| 프로젝트를 **탭/헤더**에, 카드 칩 아님 | `.log`가 워크스페이스 폴더 한정이라 단일 폴더에선 모든 칩이 동일 — 정보량 0 | 카드마다 칩 / 멀티루트일 때만 칩 | 멀티루트에서 카드별 구분은 여전히 없음 |
| `subject`를 **status.json**에 실음 | 요청서(13~20KB)를 안 읽어도 됨. status는 이미 2초마다 읽는 220B | 요청서 H1 파싱 후 캐시 | 스킬 배포가 선행돼야 함(서버 포함) |
| 그룹은 **종류별로 분리** | 섞어 묶으면 "도구 8건"이 되어 그 실행이 뭘 했는지 사라짐 | 종류 무관 일괄 묶음 | 묶음 수가 늘어 행 감소폭이 작아짐 |
| **실패는 절대 접지 않음** | 접기의 전제가 "볼 필요 없는 것만" | 실패 포함 전량 접기 / 상단 토글 | 실패가 많은 런은 덜 줄어듦 |
| 캐시 제거 대신 **stat 대조** | 원격에서 완료 런 재전송(수백 KB) 회피가 캐시의 존재 이유 | 캐시 삭제 / TTL | mtime 초 단위면 같은 초 재실행은 못 잡음(size 병행으로 완화) |

---

## 3. 시행착오

### 3-1. 웹뷰가 통째로 죽었다 — tsc는 통과했다

- **잘못된 가정**: 웹뷰 스크립트도 TypeScript가 검사해 준다고 여겼다.
- **한 일**: 카드 제목 툴팁을 두 줄로 만들려고 `'\n'`을 썼다. 이 코드는 `getHtml`의 **템플릿 리터럴 안**이라
  백슬래시 하나가 실제 개행이 되어 생성된 JS 문자열을 두 동강 냈다.
- **발견 경위**: 사용자가 "오류 나는 것 같아"와 함께 붙여넣은 텍스트가 **영어였고 카드가 한 장도 없었다.**
  i18n 치환도 렌더링도 스크립트가 하는 일이라, 둘 다 죽었다는 것이 곧 스크립트 사망의 증거였다.
- **2차 실수**: 고치면서 경위를 적은 주석에 백틱을 썼다 → 템플릿 리터럴 조기 종료. 이건 tsc가 잡았다.
- **복구**: `\\n`(이중), 주석에서 백틱 제거. 그리고 **`tools/check-webview.js`를 만들었다** —
  HTML을 실제로 평가해 `<script>`를 꺼내 파싱한다. **탐지력을 대조군으로 확인**했다(고친 이스케이프를 되돌리니 SYNTAX ERROR + exit 1).
- **교훈**: 템플릿 리터럴 안의 코드는 컴파일러의 사각지대다. 검사를 만들었으면 **일부러 깨뜨려 탐지되는지 보라.**

### 3-2. 프로젝트 칩 — 사용자가 내 설계를 뒤집었다

- **잘못된 가정**: 멀티루트에서 여러 프로젝트가 섞이니 카드마다 칩이 필요하다.
- **발견 경위**: 구현 도중 사용자가 **".log를 읽으니까 다른 플젝 거는 안 보이잖아.. 아닌가?"**
  코드가 그 말을 뒷받침했다 — `collectCodexRuns`는 열린 워크스페이스 폴더만 순회한다.
  단일 폴더 창에서는 모든 카드가 같은 프로젝트라 칩이 같은 글자의 반복이 된다.
- **복구**: 이미 넣은 `CodexRunView.project`/`projectPath`를 되돌리고 탭 제목 + 헤더로 재설계.
- **교훈**: 구현 전에 "이 정보가 행마다 달라지는가"를 물었어야 했다.

### 3-3. 원격 경로를 URI 그대로 찍었다

- `f.uri.toString(true)`가 `vscode-remote://ssh-remote+7b22686f...227d/home/yeogi_callcrew`를 냈다.
  hex 68자는 화면에서 난수다.
- **원인**: VS Code가 SSH 대상을 hex 인코딩된 JSON(`{"hostName":"AI_IVR_Server-Gabia"}`)으로 authority에 넣는다.
- **복구**: `+` 뒤를 hex로 판정되면 디코딩해 `hostName`을 꺼내 `호스트: 경로`로 표시. 실패 시 원래 값으로 흘림.

### 3-4. 접기 효과를 미리보기에서 과장했다

- 선택지 preview에 "20줄 → 7줄"이라 적었으나 실측은 **23 → 17**이었다. 성공 명령이 연속되지 않아 묶음이 끊긴 탓이다.
- 그대로 보고했고, 이후 검색까지 포함하자 57 → 30이 되어 사용자가 만족했다.
- **교훈**: 효과 수치를 미리보기에 넣을 거면 실데이터로 먼저 재라.

### 3-5. `/skill_cp_install deploy`에 스킬 이름을 넘겼다

- `deploy codex_rescue`로 호출했으나 **`deploy`의 인자는 서버 이름**이다(SKILL.md 명시).
- 인자 없이 `deploy`하면 "바뀐 것만" 자동 반영된다. `--dry-run`으로 먼저 확인 후 실행했다.

---

## 4. 발견한 코드베이스 함정

### 4-1. 🔴 웹뷰 스크립트는 템플릿 리터럴 안이라 컴파일러가 검사하지 않는다

`codexRescuePanel.ts` / `workflowPanel.ts`의 `getHtml`은 `` return /* html */ `...` `` 형태다.
그 안의 `<script>` 본문은 **TypeScript에게는 그냥 문자열**이다. 결과:

- **백틱을 쓰면** 템플릿이 그 자리에서 끝난다. (이건 tsc가 뒤늦게 이상한 오류로 잡는다 — `TS1443: Module declaration names may only use ' or " quoted strings`)
- **`'\n'`을 쓰면** 실제 개행이 되어 JS 문자열이 끊긴다. **tsc는 아무 말도 하지 않는다.**
- 정규식도 이중 이스케이프가 필요하다. 기존 코드의 관례가 증거다 — `v.replace(/\\{(\\d+)\\}/g, ...)`.

증상은 "패널이 정적 HTML만 그리고 아무것도 동작하지 않음"이다. i18n이 안 먹어 **영어로 보이고 카드가 안 나온다.**

방어: `node tools/check-webview.js out/codexRescuePanel.js out/workflowPanel.js`.
HTML을 평가해 `<script>`를 꺼내 `new Function()`으로 파싱한다.

### 4-2. codex_rescue는 죽은 요청을 같은 stamp로 재실행한다

스탬프는 요청서 front matter에 박혀 있으므로, 실패한 건을 다시 돌리면 **같은 stamp로 `events.jsonl`이 새로 쓰인다.**
`status.json`의 `started_at`도 갱신되지만 stamp는 그대로다.

→ stamp를 키로 삼는 캐시는 반드시 파일 변화를 확인해야 한다. `runDiscovery.ts`의 `settled`가 그래서 스냅샷을 든다.
→ 진단 시 `stamp`와 `started_at`이 크게 벌어져 있으면 **재실행 흔적**이다(실측: 19:17:05 vs 19:28:58).

### 4-3. Codex의 `command_execution`은 항상 셸로 감싸여 온다

- Windows: `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "…"` — 48자
- Linux: `/bin/bash -lc "…"` — 15자

`item.command`를 그대로 쓰면 매 행이 같은 접두사로 시작해 실제 명령이 잘린다.
`execEvents.ts`의 `stripShellWrapper`가 표시용으로만 벗기고 원문은 `raw`로 보존한다.
**래퍼가 없는 명령(`npm run build`)은 건드리지 않는 것까지 확인**했다.

### 4-4. `send.sh --dry-run`은 `status.json`을 만들지 않는다

`CR_DRYRUN=1`은 `write_status` 호출 전에 빠진다. status 관련 검증에는 쓸 수 없다.
대신 스크립트에서 함수 정의만 추출해 실행하는 방법이 통한다(`jsan`은 한 줄 함수라 범위 추출이 `write_status`까지 삼키니 따로 뽑아야 한다).

### 4-5. `deploy`의 인자는 서버 이름이다

`/skill_cp_install deploy <이름>`의 `<이름>`은 **스킬이 아니라 배포 대상 서버**다.
스킬 하나만 올리려면 인자 없이 `deploy`(바뀐 것만 자동 반영)하거나 `push <스킬명>`.

---

## 5. 사용자 핵심 발언

- > "코덱스 냄새가 한 개도 안 나" — 육각형 심볼 배지에 대한 판정.
  적용: 브랜드 인지가 목적인 UI에서 **추상 도형은 실물 로고를 대체하지 못한다.**

- > ".log를 읽으니까,, 다른 플젝거는 안보이쟎아.. 아닌가?" — 내가 카드 칩을 구현하던 중.
  적용: 사용자가 스스로 전제를 의심할 때는 **코드로 확인하고 설계를 접는다.** 이 지적이 맞았다.

- > "아니면 codex_rescue를 수리해서 명시적으로 축약된것을 subject 섹션에 넣게 하는건 아때?"
  적용: **더 나은 설계였다.** 나는 요청서 파일을 읽을 궁리를 하고 있었고, 사용자 안은 전송 비용을 0으로 만들었다.
  사용자가 시스템 전체 구조(스킬+확장)를 보고 있다는 신호다.

- > "명령접는거 안쪽으로 들여쓰기 하지말고, 네모친데다가 화살펴등으로 명시적으로 펼칠수 있다는 표시하는게 UX적으로 좋을듯"
  적용: 접기 UI는 **어디를 누르면 되는지가 보여야 한다.** 왼쪽 마커는 목록 정렬만 깨뜨렸다.

- > "일단 오늘 목표는 달성했어. 버전 하나 올리고, 그다음 버전 로그 잘 작성해서 배포해."
  적용: 1.9.2가 미배포였으므로 번호를 또 올리지 않고 그대로 배포한다고 **먼저 알리고** 진행했다.

---

## 8. 변경 파일 인벤토리

```
# v1.9.1 (35872a5)
M  images/icon.png                          [Claude 별 84% + OpenAI blossom 배지]
A  images/icon-src/icon-star.png            [별 원본 — 재생성 소스]
A  images/icon-src/codex-blossom.png        [OpenAI 마크 사본 — 타 확장 참조 시 업데이트에 깨짐]
A  images/icon-src/make-icon.py             [작도 스크립트, 상수로 파라미터화]
M  .vscodeignore                            [images/icon-src/** 제외]

# v1.9.2 (21ef143)
M  src/providers/codexRescue/runDiscovery.ts [workspace.fs 전환(인수분) + settled 스냅샷 대조]
M  src/providers/codexRescue/execEvents.ts   [stripShellWrapper 신설, raw 보존]
M  src/codexRescuePanel.ts                   [subject 제목·날짜·워크스페이스 라벨·그룹 접기]
M  src/extension.ts                          [async 전파(인수분) + subject/raw 전달]
M  src/i18n.ts                               [cx.cmdGroup·searchGroup·expand·collapse]
M  package.json                              [1.9.2 + displayName 변경]
M  README.md / README.ko.md                  [Remote-SSH 문장 교체(인수분) + 표시명 10곳 + 카드 설명 2줄]
M  CHANGELOG.md                              [1.9.2 — 요약 인용 + 섹션 7개]
M  skills/codex_rescue/send.sh               [subject 파싱·--subject·status 기록]
M  skills/codex_rescue/SKILL.md              [subject 규약·템플릿 2곳·사용법 3곳]
A  tools/check-webview.js                    [웹뷰 스크립트 문법 검사 — tsc 사각지대]
M  .vscodeignore                             [tools/** 제외, __pycache__ gitignore]
```
