---
name: browser_check
description: 사용자 PC 의 실제 웹 브라우저(Aside/Chromium) 화면을 직접 열어 보고·눌러 보고·진단한다 — 서버에서든 PC 자체에서든. "브라우저 체크/브라우저 첵/브라우저 책", "화면 확인해 봐/화면 좀 봐/실제 화면 봐 줘/페이지 봐 봐", "CSS 깨졌는지 봐/씨에스에스 오류/스타일 깨짐/레이아웃 이상해", "콘솔 에러 봐/컨솔 오류/자바스크립트 에러", "API 실패 봐/에이피아이 오류/요청 실패/네트워크 봐", "반응형 봐/모바일에서 어떻게 보여/좁은 화면", "다크모드 확인/테마 봐", "접근성 점검/접근성 봐", "성능 봐/느린지 봐/느려", "이 버튼 눌러 봐/클릭해 봐/눌러서 확인", "실시간 동기화 확인/두 탭 같이 바뀌나", "로그인 풀렸어/로그아웃 됐어/왜 튕겨", "전체 흐름 시험해/처음부터 끝까지 해 봐" 같은 한국어 자연어(STT 받아쓰기 변형 포함)에 발동한다. 웹 페이지·화면·브라우저의 실제 동작을 보라는 뜻일 때만 — 소스나 서버 로그만 보는 코드 리뷰, 일반 질문에는 발동하지 않는다.
---

# browser_check — 실제 브라우저를 직접 보고 누르고 진단한다

> 이 스킬의 이유: 서버 로그와 소스만 보고 "시험 통과"라고 보고하면 화면의 구멍은 사용자가 찾게 된다. 사용자 대신 **실제 브라우저에서 직접 확인**한 것만 "확인했다"고 말한다.
> 근거는 전부 실측이다(2026-09-26, 서버→PC 원격 12마리 전수 시험 + Codex 컨설팅). 매뉴얼과 실측이 다르면 실측을 따른다.

## 0. 시작 — 매번, 순서대로
1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/browser-check.mjs" doctor --json` — 설정·통로(A/B/C)를 읽는다. **설정을 바꾸거나 브라우저·Aside 를 켜지 않는다.** 통로가 없으면 표를 그대로 보고하고 멈춘다(원격이 `disabled`·`offline` 이면 사용자가 PC 에서 켜야 한다).
2. 대상을 분류한다: 주소(개발/운영) · **로그인된 사이트인가**(설정 `sites[].login`) · 데이터를 바꾸는 일인가 · 어느 레시피인가.
3. 로그인 사이트면 §1 의 토큰 규칙을 먼저 읽는다. 데이터 변경이면 **먼저 계획(무엇을·어디에·정리 방법)을 보이고 승인**을 받는다.

## 1. 🔴 절대 안전 규칙 — 어기면 사용자 작업이 망가진다(전부 실사고·실측 근거)
- **자기 탭만**: `openTab` 으로 연 탭만 쓴다. `attachBrowserTab`·`attachActiveBrowserTab` 금지(사용자 탭). `page.close()` 대신 `closeTab(tab)`.
- **로그인 사이트 탭은 진행 중 요청 0 을 확인한 뒤에만 닫는다**(`K.safeClose`). 탭을 요청 도중 닫아 refresh 응답이 유실되면 서버가 도난으로 보고 **사용자 로그인 전체를 끊는다**(실사고). 새로고침·새 탭·같은 출처 iframe 은 전부 토큰 회전을 부른다 — 화면 이동은 SPA 이동으로, 반응형은 CDP 에뮬레이션으로.
- **한 호출 50초 · evaluate 25초 이내**(원격 한도 약 60초 — 넘기면 출력 전부 유실, 영구 세션은 통째로 죽음). 단계마다 `K.G` 시간 가드.
- **Aside 채우기 메뉴(`aside-inline-menu`)를 누르지 마라** — 채운 뒤 로그인 버튼을 **스스로 눌러** 기존 세션을 회수한다. 로그인·비밀번호는 사람이.
- **데이터 변경 금지**(보내기·저장·삭제·초대·결제·설정) — 승인받은 그 대상·그 동작만. 자동화 함정: `trial:true` 가 실제로 누름 · 가려진 요소도 합성 클릭으로 "성공" · **숨은 입력칸에 fill 하면 초점 있는 다른 칸(채팅 입력기)에 글자가 들어가고 Enter 면 전송** · `type('…\n')` 이 전송 · repl `fetch` POST 가 실제 전송 · 없는 값 `selectOption` 이 첫 항목 선택. 입력 전 `K.canAct`, 입력 뒤 `document.activeElement` 확인, 전송/줄바꿈은 `keyboard.press('Enter'|'Shift+Enter')` 로 명시.
- **브라우저 기본 confirm 은 Aside 가 무조건 "확인"** — 파괴 버튼은 누르기 직전 `K.denyConfirm`(이동하면 풀림).
- **금지 입력**: Ctrl+V·Shift+Insert(사용자 실제 클립보드가 붙음) · Ctrl+C·clipboard API · 브라우저 단축키(F5·F11·F12·Ctrl+W…) · `<select>`·date·color·파일 input **클릭**(OS 창) · draggable 요소를 `mouse.*` 로 끌기(OS 끌기) · 다운로드 시험(사용자 다운로드 폴더에 남고 지울 수 없음).
- **금지 CDP**: `fromSurface:false`(사용자 화면이 찍힘 — 실제 발생) · `Target.*`(C 에서 자기 target 세 동작만 예외) · `Browser.*` · 쿠키/스토리지 · `Fetch.enable` · `Debugger.pause` · `Page.navigate/close`. `K.X` 가 allow-list 로 막는다.
- **비밀은 읽지도 남기지도 않는다**: 비밀번호 값 금지(길이만) · 모든 출력은 중앙 redactor 를 거친다 · Aside 메모리·설정값·auth 파일 내용 기록 금지.
- **동시성 1**: 같은 PC 브라우저를 여러 서버·에이전트가 나눠 쓴다. 자기 탭 동시 2개 이하, 끝나면 목록에서 자기 탭 0 확인. `Too many Remote Control RPCs` 면 몇 초 뒤 1회만 재시도.

## 2. 환경 준비 — 모든 판정 앞에
- `K.prep(tab, {darkReader: site.darkReader})`: **변경 전에 감지** → 경고 → 자기 탭에만 Dark Reader 잠금·주입 UI 숨김. `@@WARN DARK_READER_ON` 이 나오면 **반드시 사용자에게 알린다** — 사용자는 개발 사이트에선 일부러 꺼 두므로 켜져 있으면 색·캡처 판정을 믿을 수 없다.
- DeepL·Aside 주입 요소(`deepl-*`, `aside-inline-menu`, `bro-*`)는 숨기고 결과에 `detected` 로 남긴다. axe 는 `exclude`.
- 측정·색·애니메이션을 볼 때는 `K.wake`(에이전트 탭은 초당 2~4프레임으로 스로틀 — 캡처 1장이 풀고, 이동하면 다시 걸림).
- 통로는 doctor 결과대로 자동 선택 — snapshot/조작=A · 명령형 CDP(첫 로딩 주입·기기 폭·다크모드·CSS 캐스케이드·AX 트리)=B(`K.hasX` 확인) · 이벤트·백그라운드 탭·긴 작업=C. 선택 이유와 fallback 을 보고한다. **같은 조작을 두 통로로 자동 재시도하지 않는다.**

## 3. 지시 → 레시피 (`recipes/`)
| 사용자 말 | 레시피 |
|---|---|
| 화면 확인해 봐 · 어디 봐 봐 | `screen.md` |
| CSS 깨졌는지 · 레이아웃 · 넘침 · 잘림 | `css.md` |
| 콘솔 에러 · API 실패 · 네트워크 | `console-network.md` |
| 반응형 · 모바일 · 다크모드 · 인쇄 | `responsive-theme.md` |
| 접근성 | `accessibility.md` |
| 성능 · 느린지 | `performance.md` |
| 이 버튼 눌러 봐 · 입력해 봐 | `action.md` |
| 실시간 동기화 · 두 탭 | `realtime.md` |
| 로그인 풀렸어 | `login-incident.md`(🔴 새 탭을 열지 마라 — 증거가 바뀐다) |
| 전체 흐름 시험 | `flow.md` |
호출 형태: 1회성은 `scripts/browser-check.mjs run <본문.js> --url <주소>`(공통 머리 자동 결합·50초 가드·잠금·@@IMG 저장·가림). 여러 단계·로그인 앱은 영구 세션 구동기 `scripts/session/drv.py`(한 줄 = 한 실행, 줄마다 50초 이내, `ASIDE_BIN`·`ASIDE_HOST` 환경변수는 설정에서).

## 4. Asidewright 함정 — "된다"고 믿기 전에
자동 대기 없음(없으면 1ms 에 실패, `waitFor` 기본 3초) · strict 없음(여러 개면 첫 것) · `page.url()` 은 SPA 이동 미반영(`K.href`) · `reload()` 는 load 전 반환 · `waitForLoadState` 는 요청 0 을 보장 못 함 · `clip` 원점 무시·`fullPage` 첫 화면 반복·`locator.screenshot` 불가(전체 캡처 후 서버 `image/crop.py`·`stitch.py`) · 정규식 인자는 오류 없이 0건 · `keyboard.press('Space')` 는 key 빈 문자열(CDP `Input.dispatchKeyEvent`) · `locator.hover` 는 mouse 위치를 안 옮김 · `dragTo` 는 drop 2번 · 오른쪽 클릭 정석 `page.mouse.click(x,y,{button:'right'})` · `page.evaluate` 만 main world(locator.evaluate 는 격리 세계) · Resource Timing 250 상한(`setResourceTimingBufferSize`) · 코드 어디든 `import(`·`require(` 모양이 있으면 실행 전 거절.

## 5. 공통 보고 형식
```
[대상] 실제 주소(K.href) · 개발/운영 · 로그인 여부 · 통로(A/B/C 와 이유)
[조건] 창 크기·DPR · fps(깨운 뒤) · Dark Reader 감지/잠금 · 주입 UI · visibility · 캐시 · 쓴 흉내(폭/미디어/CPU) — 되돌림 여부
[결과] 항목 | 판정(✅/❌/부분) | 값·기준 | 증거(캡처 파일 · dump 줄 · rid · 시트:줄)
[못 본 것] 이유와 사람이 할 일
[남긴 것] 연 탭 0 확인 · 만든 데이터(승인 근거) · 정리 완료
```

## 6. 사람만 할 수 있는 것 — 요청하지 말고 넘긴다
에이전트 탭이 사용자 화면 앞에 뜨는지 · 프레임 스로틀 원인 · 실제 클립보드 · OS 파일/날짜/색 창·기본 오른쪽 클릭 메뉴·권한 팝업 · 실제 마우스 끌기 · 로그인/재로그인 · 데이터 변경 승인 · 실기기(모바일 Safari 등) · OS IME 고유 동작 최종 확인 · PC 설정(원격 켜기·확장·업데이트) · 터널 열기 · 다운로드 폴더 정리 · 디자인 판단.
