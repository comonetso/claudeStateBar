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

이벤트는 A/B 로 오지 않는다 — 페이지 안 기록기 v2.1(`scripts/kit/diag-v2.1.js`)을 첫 로딩 전에 넣어 회수하거나 C 를 쓴다. C 에서는 브라우저 확장 프로그램이 낸 오류가 페이지 오류와 함께 오는데, 녹화기가 따로 분류해(`ext-exception`·`ext-console`, 확장 이름 포함) 문제 목록에서 뺀다. C 는 보이지 않는 탭에서 일하는데, 이런 탭은 한 번 그려지기 전까지 클릭·키 입력을 오류 없이 버린다. 그래서 클라이언트가 문서마다 첫 입력 전에 작은 캡처 1장을 찍어 깨우고, 그 캡처가 실패하면 입력을 잃는 대신 오류로 거절한다.

## 설치 (서버·PC 공통)
1. `claude plugin install browser-check@comonetso`
2. **비공개 설정** — `${CLAUDE_PLUGIN_DATA}/config.json` (0600, 부모 0700. Windows 에는 이런 권한 숫자가 없어 이 검사를 하지 않는다). 예시 `config/example.json`, 스키마 `config/schema.json`. 호스트 이름·CLI 절대경로·소켓 경로·사이트별 로그인 분류는 **여기에만** 둔다(공개 저장소에 올라가지 않는다).
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor` — 설정·통로 표. 통로가 없으면 표를 보고 사람이 켠다(플러그인은 설정·PC 상태를 바꾸지 않는다).
4. 원격 서버 + Pro 없이 C 를 쓰려면: PC 에서 서버별 단일 소유 `ssh -NT -R <서버 유닉스 소켓>:127.0.0.1:<디버깅 포트> …`(Windows 작업 스케줄러 권장). 서버 sshd 는 `AllowStreamLocalForwarding yes` + `StreamLocalBindUnlink yes` 필요. 🔴 CDP 는 인증이 없다 — TCP 포트로 열지 말 것.

## 🔴 안전 규칙 요약 (전문은 `skills/browser_check/SKILL.md` §1)
자기 탭만 · 로그인 사이트 탭은 **진행 중 요청 0 확인 뒤 닫기**(안 지키면 사용자 로그인 전체가 끊긴 실사고) · 한 호출 50초 · Aside 채우기 메뉴 금지(로그인 버튼을 스스로 누른다) · 데이터 변경은 승인된 것만 · 클립보드·다운로드·OS 창·브라우저 단축키 금지 · `fromSurface:false` 금지(사용자 화면이 찍힌다) · 비밀은 읽지도 남기지도 않는다(중앙 redactor) · 동시성 1.

## 구조
```
.claude-plugin/plugin.json      매니페스트(version 필수)
hooks/hooks.json                SessionStart — stat-only(설정·소켓 권한만, 브라우저 접촉 없음)
skills/browser_check/SKILL.md   발동·안전 규칙·라우팅   recipes/*.md  지시별 절차 10개
scripts/browser-check.mjs       진입점: doctor · run(1회성 repl, 50초 가드, 잠금, @@IMG 저장, 가림) · unlock
scripts/lib/                    config · capabilities(감지 순서) · policy(작업 5분류·CDP allow/deny) · redact · lock
scripts/kit/                    head.js(공통 머리) · diag-v2.1.js(기록기) · webcheck*.js · vitals*.js · perfdiag · emu-lib · responsive-iframe
scripts/image/                  decode · crop · stitch (Pillow 선택)
scripts/session/                영구 세션 구동기(drv.py/run.sh) · MCP 중계기(aside_mcp_shim.py)
test/                           basic.test.mjs(가림·정책·설정·누출 검사) · cdp-unit.test.mjs(WebSocket 프레임·CDP 클라이언트) · regress/(Aside 업데이트 뒤 회귀) · unix-bridge.mjs(TCP→소켓 다리, 시험 전용)
```

`node --test test/basic.test.mjs test/cdp-unit.test.mjs` 는 브라우저 없이 돈다. 누출 검사는 막을 값 목록을 로컬 파일(`~/.claude/_private/browser_check_leak.txt`, 또는 `BROWSER_CHECK_LEAK_LIST` 에 적은 경로)에서 한 줄에 `/정규식/플래그` 하나씩 읽는다. 목록을 이 패키지에 넣으면 막으려는 값이 그대로 공개되므로 밖에 둔다. 목록이 없으면 이 검사는 통과가 아니라 건너뜀으로 나온다.

## 실행 환경 — 낮은 Node 에서도 같은 기능
- **외부 패키지 0**(package.json 없음). Node 코어 모듈만 쓴다. Node 22 전용 기능(전역 `WebSocket`·`fetch`)은 쓰지 않는다 — 유닉스 소켓 위 WebSocket 은 `lib/cdp-ws.mjs` 가 `net`+`crypto` 로 직접 구현.
- **Node 18 이상**(`node:test` 때문에 시험만 18.1+). 실측: **Node 18.20.8 · 20.18.0 · 22.22.0** 세 버전에서 단위 시험 전부 통과 · doctor · run(Aside 원격) · cdp(TCP·유닉스 소켓) 동작 확인(2026-09-26).
- Python 3 + Pillow 는 이미지 자르기·이어붙이기에만 필요(없으면 그 기능만 빠진다). doctor 가 찾은 명령(`python3`·`python`·`py -3`)을 표시하고, 스크립트는 그 명령으로 실행한다.

## Windows PC 에서 실측한 것 (2026-09-26 · Aside 1.26.916 · Chrome 153 · Node 22.17)
Aside Pro 없이 로컬 A·B: 자기 탭 · 스냅샷 ref · 클릭과 한글 입력 · 안전 닫기 · 첫 로딩 주입 · CSS 규칙 · 기기 폭·미디어 흉내와 되돌림 · 루프백 TCP 로 C: 백그라운드 탭 · 콘솔·네트워크 이벤트 · 명령 시간 초과 · 남는 탭 0 · 자동 깨우기 뒤 오른쪽 클릭 · 데몬은 틀린 Host 헤더를 거절(403)하고, 감지는 설정을 바꾸지 않는다 · 공백·한글 경로 · Python 없는 doctor · Dark Reader 켜짐(경고 뒤 플러그인 탭에서 잠금)과 사이트별 꺼짐(경고 없음) · DeepL 아이콘을 꺼도 `deepl-*` 요소는 페이지에 남는다 — 숨기고 알린다.

## 아직 실측되지 않은 것 (짐작하지 말 것)
**실제 SSH 터널** 위 유닉스 소켓(코드는 TCP→소켓 다리로 실측: `test/unix-bridge.mjs`) · 터널 상시 운영(Windows 작업 스케줄러·재연결·stale 소켓) · `_sendToTarget` 의 Aside 업데이트 뒤 수명 · 기록기 v2.1 의 실제 앱 회귀 · 레시피를 통째로 돌린 것. 근거 문서: 조사·실측 결과 12편 + Codex 컨설팅(별도 보관).
