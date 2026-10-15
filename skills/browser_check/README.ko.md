# browser-check — 사용자의 실제 브라우저를 Claude 가 직접 보고·누르고·진단한다

서버 로그와 소스만 보고 "시험 통과"라 하지 않는다. Claude Code 가 사용자 PC 의 **실제 브라우저(Aside/Chromium)** 에서 화면을 열고, 눌러 보고, 콘솔·네트워크·CSS·반응형·접근성·성능을 직접 확인한다. 서버(원격)에서도, PC 자체(로컬)에서도 같은 플러그인이 돈다.

- 발동: 한국어 자연어 — "화면 확인해 봐", "CSS 깨졌는지 봐", "콘솔 에러 봐", "API 실패 봐", "반응형 봐", "다크모드 확인", "접근성 점검", "성능 봐", "이 버튼 눌러 봐", "실시간 동기화 확인", "로그인 풀렸어", "전체 흐름 시험해" (STT 받아쓰기 변형 포함)
- 호출명: `browser-check:browser_check`

## 통로 세 개 (정책층이 고른다 — 호출자가 고르지 않는다)
| 통로 | 무엇 | 필요한 것 |
|---|---|---|
| **A** Aside 원격/로컬 repl | 탭 열기·스냅샷(ref)·클릭·입력·캡처·PDF | Aside CLI + (원격이면) Aside Pro 원격 호스트 |
| **B** repl 안 날 CDP(`page._sendToTarget`) | 첫 로딩 전 주입·기기 폭·다크/인쇄·CSS 캐스케이드·AX 트리·프로파일 | A 와 같음 (비공개 메서드 — 매번 `typeof` 확인) |
| **C** 직결 CDP(로컬 TCP 또는 서버의 역방향 SSH 유닉스 소켓) | 콘솔·네트워크 **이벤트**, 백그라운드 탭, 60초 넘는 작업 | 브라우저의 원격 디버깅 포트 + (서버면) 터널 |

이벤트는 A/B 로 오지 않는다 — 페이지 안 기록기 v2.1(`scripts/kit/diag-v2.1.js`)을 첫 로딩 전에 넣어 회수하거나 C 를 쓴다. C 에서는 브라우저 확장 프로그램이 낸 오류가 페이지 오류와 함께 오는데, 녹화기가 따로 분류해(`ext-exception`·`ext-console`, 확장 이름 포함) 문제 목록에서 뺀다. C 는 보이지 않는 탭에서 일하는데, 이런 탭은 한 번 그려지기 전까지 클릭·키 입력을 오류 없이 버린다. 그래서 클라이언트가 문서마다 첫 입력 전에 작은 캡처 1장을 찍어 깨우고, 그 캡처가 실패하면 입력을 잃는 대신 오류로 거절한다. 또 C 는 Aside 를 실행 옵션 세 개(`--disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion --enable-features=CDPScreenshotNewSurface`)로 켜야 한다. 옵션이 없으면 Aside 창이 전부 가려지는 동안이나 창이 최소화된 동안 캡처(그래서 입력도)가 멈춘다(PC·터널 모두 실측). 옵션이 있으면 Windows 실측에서 둘 다 계속됐다(앞의 두 개는 가림, 세 번째는 최소화). Windows 에서는 `launch-flags` 가 실행 중인 Aside 를 점검하고 Aside 바로가기에 옵션을 넣어 준다. A·B 는 영향이 없다.

## 사용자 탭 빌리기 · 쓰기 차단 · 분리 창 (C, 켜야 동작한다)
운영 API 에 붙은 화면처럼 새 탭을 열면 안 되고 데이터도 바꾸면 안 되는 곳을 확인할 때 쓴다. 기본은 모두 꺼져 있어 기존 사용법은 그대로다.
- **탭 빌리기** — `cdp <스크립트> --borrow <주소 패턴> [--same-window-as <주소 패턴>]`. 사용자가 이미 열어 둔 탭에 붙는다(예: 잔디 탭과 같은 창에 있는 Mesa 탭). 새로 만들지도, 앞으로 띄우지도, 닫지도 않는다. 맞는 탭이 없으면 그 창에 하나 열어 달라고 안내하고, 여럿이면 후보를 보여 주며 `--borrow-target` 으로 고르게 한다. 설정의 사이트 규칙에 `borrow` 가 있거나, 그때 사용자가 승인해 `--user-approved` 를 붙였을 때만 빌린다. 빌린 탭에서는 주소 이동(`Page.navigate`)이 되고, Aside 자동 채우기 메뉴·DeepL 같은 끼워 넣은 화면은 나중에 뜬 것까지 계속 숨긴다. 끝나면 숨김·화면 흉내(폭·테마·언어)·쓰기 차단을 모두 원래대로 돌리고 탭은 그대로 둔다. 붙은 직후 읽기만 하는 명령을 하나 보내고, 거기에 답하지 않는 탭(최소화된 창에서 겪었고 원인은 아직 모른다)은 그냥 시간 초과 대신 `tab-unresponsive` 와 그 창 상태로 실패한다. 그 창을 열어 탭을 한 번 눌러 달라고 사람에게 부탁하라는 안내가 붙는다. 탭을 깨우거나 새로 고치거나 앞으로 띄우지는 않는다.
- **쓰기 차단** — `--guard-writes [--allow-write <경로>]…` 또는 사이트 규칙 `guardWrites: true` · `writeAllow`. 빌린 탭에서 GET·HEAD·OPTIONS 가 아닌 요청을 브라우저 밖으로 나가기 전에 막고, 허용 목록(로그인 유지·토큰 갱신 경로)만 통과시킨다. 막은 것과 통과시킨 것을 결과에 남긴다. 걸자마자 없는 경로로 POST 를 하나 쏘아 실제로 막히는지 스스로 시험하고, 안 막히면 진행하지 않는다. WebSocket 메시지와 서비스 워커가 스스로 보내는 요청은 못 막는다.
- **분리 창** — 스크립트에서 `client.openIsolatedWindow(주소)`. 사용자 로그인·쿠키와 섞이지 않는 임시 프로필을 최소화된 새 창으로 연다(시험 계정 확인용). 쿠키는 `client.setIsolatedCookies` 로 그 프로필에만 넣고 값은 결과에 남기지 않는다. 끝나면(연결이 끊겨도) 프로필째 지운다. 최소화 창을 캡처하려면 위의 세 번째 실행 옵션이 필요하다.
- **탭 목록** — `tabs [--match <패턴>] [--same-window-as <패턴>]`. 탭과 창 번호를 읽기만 한다.

주소 패턴은 `*` 가 없으면 "주소(쿼리 제외)에 이 글자가 들어 있음", 있으면 전체 일치다. 허용 경로는 `/`로 시작하면 어느 서버든 그 경로, `https://…` 면 서버까지 맞아야 하고, 끝의 `*` 는 앞부분 일치다.

## 설치 (서버·PC 공통)
1. `claude plugin install browser-check@comonetso`
2. **비공개 설정** — `${CLAUDE_PLUGIN_DATA}/config.json` (0600, 부모 0700. Windows 에는 이런 권한 숫자가 없어 이 검사를 하지 않는다). 처음 쓸 때 `browser-check.mjs setup` 이 이 기기를 살펴(Aside CLI · 실행 중인 Aside 의 포트 · 터널 소켓 · `aside host list`) 만들고, 넣은 값을 보여 준다. 이미 있는 파일은 덮어쓰지 않는다. Aside 에 원격 PC 가 여럿이면 어느 것인지 묻고, 쓸 수 있는 통로가 없으면 아무것도 쓰지 않고 사람이 할 일을 알려 준다. 사이트별 규칙은 비워 두며, 그러면 안전한 기본값으로 돈다. 직접 쓰려면 예시 `config/example.json`, 스키마 `config/schema.json`. 호스트 이름·CLI 절대경로·소켓 경로·사이트별 로그인 분류는 **여기에만** 둔다(공개 저장소에 올라가지 않는다).
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor` — 설정·통로 표. 워크플로우 에이전트·크론·그냥 ssh 처럼 플러그인 밖 셸에는 `CLAUDE_PLUGIN_DATA` 가 없어 설정을 못 찾는다(`Config INVALID`). 그때는 `CLAUDE_PLUGIN_DATA=<Claude 설정 폴더>/plugins/data/browser-check-comonetso`(또는 `BROWSER_CHECK_CONFIG=<그 폴더>/config.json`)를 붙여 부른다. 통로가 없으면 표를 보고 사람이 켠다(처음 쓸 때 자기 설정 파일을 만드는 것 말고는, 플러그인은 설정·PC 상태를 바꾸지 않는다).
4. 원격 서버 + Pro 없이 C 를 쓰려면: PC 에서 서버별 단일 소유 `ssh -NT -R <서버 유닉스 소켓>:127.0.0.1:<디버깅 포트> …`. Windows 작업 스케줄러라면 로그온 트리거 + 1분마다 반복하는 트리거 + "새 인스턴스 시작 안 함" 으로 둔다 — 창을 숨기려고 감싸면 "실패 시 다시 시작" 이 동작하지 않는다(실측). 서버 sshd 는 `AllowStreamLocalForwarding yes` + `StreamLocalBindUnlink yes` 필요. 🔴 CDP 는 인증이 없다 — TCP 포트로 열지 말 것.

## 🔴 안전 규칙 요약 (전문은 `skills/browser_check/SKILL.md` §1)
자기 탭만(예외: 설정이나 그때의 승인으로 빌려 준 탭 — 위 절) · 로그인 사이트 탭은 **진행 중 요청 0 확인 뒤 닫기**(안 지키면 사용자 로그인 전체가 끊긴 실사고) · 한 호출 50초 · Aside 채우기 메뉴 금지(로그인 버튼을 스스로 누른다) · 데이터 변경은 승인된 것만 · 클립보드·다운로드·OS 창·브라우저 단축키 금지 · `fromSurface:false` 금지(사용자 화면이 찍힌다) · 비밀은 읽지도 남기지도 않는다(중앙 redactor) · 동시성 1.

## 구조
```
.claude-plugin/plugin.json      매니페스트(version 필수)
hooks/hooks.json                SessionStart — stat-only(설정·소켓 권한만, 브라우저 접촉 없음)
skills/browser_check/SKILL.md   발동·안전 규칙·라우팅   recipes/*.md  지시별 절차 10개
scripts/browser-check.mjs       진입점: setup(처음 설정) · doctor · cdp(--borrow · --guard-writes 선택) · tabs(탭·창 번호 읽기) · run(1회성 repl, 50초 가드, 잠금, @@IMG 저장, 가림) · unlock · launch-flags(Windows: 창이 가려지거나 최소화돼도 C 가 돌게 하는 실행 옵션 세 개가 Aside 에 붙어 있는지 · --apply 는 Aside 바로가기에 넣기 · --undo 는 되돌리기)
scripts/lib/                    setup · config · capabilities(감지 순서) · policy(작업 5분류·CDP allow/deny) · redact · lock
scripts/kit/                    head.js(공통 머리) · diag-v2.1.js(기록기) · webcheck*.js · vitals*.js · perfdiag · emu-lib · responsive-iframe
scripts/image/                  decode · crop · stitch (Pillow 선택)
scripts/session/                영구 세션 구동기(drv.py/run.sh) · MCP 중계기(aside_mcp_shim.py)
test/                           basic.test.mjs(가림·정책·설정·누출 검사) · cdp-unit.test.mjs(WebSocket 프레임·CDP 클라이언트) · setup.test.mjs(처음 설정) · launch-flags.test.mjs(Aside 실행 옵션) · borrow.test.mjs(탭 빌리기·쓰기 차단·분리 창) · regress/(Aside 업데이트 뒤 회귀) · unix-bridge.mjs(TCP→소켓 다리, 시험 전용)
```

`node --test test/basic.test.mjs test/cdp-unit.test.mjs test/setup.test.mjs test/launch-flags.test.mjs test/borrow.test.mjs` 는 브라우저 없이 돈다. 누출 검사는 막을 값 목록을 로컬 파일(`~/.claude/_private/browser_check_leak.txt`, 또는 `BROWSER_CHECK_LEAK_LIST` 에 적은 경로)에서 한 줄에 `/정규식/플래그` 하나씩 읽는다. 목록을 이 패키지에 넣으면 막으려는 값이 그대로 공개되므로 밖에 둔다. 목록이 없으면 이 검사는 통과가 아니라 건너뜀으로 나온다.

## 실행 환경 — 낮은 Node 에서도 같은 기능
- **외부 패키지 0**(package.json 없음). Node 코어 모듈만 쓴다. Node 22 전용 기능(전역 `WebSocket`·`fetch`)은 쓰지 않는다 — 유닉스 소켓 위 WebSocket 은 `lib/cdp-ws.mjs` 가 `net`+`crypto` 로 직접 구현.
- **Node 18 이상**(`node:test` 때문에 시험만 18.1+). 실측: **Node 18.20.8 · 20.18.0 · 22.22.0** 세 버전에서 단위 시험 전부 통과 · doctor · run(Aside 원격) · cdp(TCP·유닉스 소켓) 동작 확인(2026-09-26).
- Python 3 + Pillow 는 이미지 자르기·이어붙이기에만 필요(없으면 그 기능만 빠진다). doctor 가 찾은 명령(`python3`·`python`·`py -3`)을 표시하고, 스크립트는 그 명령으로 실행한다.

## Windows PC 에서 실측한 것 (2026-09-26 · Aside 1.26.916 · Chrome 153 · Node 22.17)
Aside Pro 없이 로컬 A·B: 자기 탭 · 스냅샷 ref · 클릭과 한글 입력 · 안전 닫기 · 첫 로딩 주입 · CSS 규칙 · 기기 폭·미디어 흉내와 되돌림 · 루프백 TCP 로 C: 백그라운드 탭 · 콘솔·네트워크 이벤트 · 명령 시간 초과 · 남는 탭 0 · 자동 깨우기 뒤 오른쪽 클릭 · 데몬은 틀린 Host 헤더를 거절(403)하고, 감지는 설정을 바꾸지 않는다 · 공백·한글 경로 · Python 없는 doctor · Dark Reader 켜짐(경고 뒤 플러그인 탭에서 잠금)과 사이트별 꺼짐(경고 없음) · DeepL 아이콘을 꺼도 `deepl-*` 요소는 페이지에 남는다 — 숨기고 알린다.

## 실제 PC → 서버 터널에서 실측한 것 (2026-09-26)
역방향 유닉스 소켓(root, 0600) 위 C: 예시 스크립트 전체가 약 3초, 오른쪽 클릭 포함(PC 의 Aside 창이 화면에 보이는 동안) · 작업 스케줄러가 맡은 터널은 끊긴 뒤 54초 만에 다시 붙었고, ssh 는 늘 하나, CPU 는 거의 쓰지 않았다 · 리눅스 서버 4대에서 `setup`: Aside·터널이 있는 곳은 설정을 만들고, 없는 곳은 `not-ready` 와 할 일을 알렸다.

## 탭 빌리기·쓰기 차단·분리 창 실측 (2026-10-15 · Windows · Aside 시험 프로필 · Chrome 153)
같은 창에 기준 탭과 앱 탭, 다른 창에 같은 앱 탭을 둔 시험 브라우저에서: 설정에 빌려 주기가 없고 승인도 없으면 거절 · 같은 창의 앱 탭 하나만 골라 붙음 · 계정 만들기 POST 와 비콘은 막히고 토큰 갱신 POST 와 GET 은 통과, 시험 서버에 실제로 닿은 쓰기는 허용한 것 하나뿐 · 1초 뒤에 생긴 자동 채우기 메뉴도 숨김, 주소 이동 뒤 새 페이지에서도 숨김 · 닫기·앞으로 띄우기·`Fetch` 직접 호출은 거절 · 분리 창은 최소화로 열려 캡처되고 쿠키는 그 창에만 보임 · 끝난 뒤 탭 셋 그대로, 화면 폭 흉내·숨김 표식 원복, 임시 프로필 0.

## 아직 실측되지 않은 것 (짐작하지 말 것)
분리 창이나 빌린 탭이 실제 사용자 화면에서 포커스를 가져가는지(사람이 봐야 한다) · 서버 터널 위의 탭 빌리기 ·
재부팅 뒤(로그온 트리거)와 며칠에 걸친 터널 · `_sendToTarget` 의 Aside 업데이트 뒤 수명 · 기록기 v2.1 의 실제 앱 회귀 · 레시피를 통째로 돌린 것. 근거 문서: 조사·실측 결과 12편 + Codex 컨설팅(별도 보관).
