# browser-check — 실제 브라우저에서 Claude 가 웹 페이지를 직접 보고·누르고·진단한다

서버 로그와 소스만 보고 "시험 통과"라 하지 않는다. Claude Code 가 **ego lite**(사용자 Windows PC 에 둔, 에이전트용 Chromium 브라우저)에서 페이지를 열고, 눌러 보고, 화면·콘솔·네트워크·CSS·반응형·접근성·성능을 직접 확인한다. PC 에서도, PC 의 작은 중계 프로그램을 거쳐 서버에서도(ssh) 같은 플러그인이 돈다.

- 발동: 한국어 자연어 — "화면 확인해 봐", "CSS 깨졌는지 봐", "콘솔 에러 봐", "API 실패 봐", "반응형 봐", "다크모드 확인", "접근성 점검", "성능 봐", "이 버튼 눌러 봐", "실시간 동기화 확인", "로그인 풀렸어", "전체 흐름 시험해" (STT 받아쓰기 변형 포함)
- 호출명: `browser-check:browser_check`

0.1.x 까지는 Aside 브라우저를 다뤘다. 0.2.0 부터는 ego lite 만 쓴다. Aside 는 사용자가 직접 쓰는 브라우저로 남고, "내가 Aside 에 열어 둔 탭을 봐 달라"는 Aside 안의 어시스턴트가 할 일이다.

## 점검이 도는 방식
플러그인은 PC 와 서버 어디서나 Bash 도구의 경로에 명령 하나, `browser-check` 를 올려 둔다. 흔한 점검은 대본이 필요 없다.

```
browser-check look https://example.com/
browser-check look https://example.com/search --fill "#q" "hello" --click "text=Search" --wait ".results"
browser-check look https://example.com/ --width 390 --dark --full
```

`look` 은 페이지를 열고, 준 순서대로 단계를 하고(누르기·입력·고르기·키 누르기·기다리기), 다음에 누를 곳 번호가 붙은 화면 글·캡처·콘솔과 네트워크 문제·페이지가 보낸 GET 이 아닌 요청을 모두 돌려준다. 그래서 무언가를 저장하거나 보낸 누르기는 결과에 드러난다. `browser-check api click` 은 함수가 무엇을 받는지 ego 자체 도움말로 답한다. 그 밖의 일은 짧은 대본으로 한다 — `browser-check run <대본.mjs>`, 또는 대본을 표준 입력으로 주는 `run -`.

대본은(`look` 이 만드는 대본도) ego-browser 자체의 Node 런타임 안에서, 자기 몫의 작업 공간(task space — 사용자 탭과 키보드 초점을 건드리지 않는 에이전트용 탭 묶음)에서 돈다. 플러그인은 대본 앞에 도우미(`bc.*`)를 붙인다 — 공간을 열고 반드시 다시 닫기, 닫기 전에 진행 중인 요청이 0 이 되기를 기다리기, 캡처, 콘솔·네트워크 문제 모으기, 보낸 요청 목록, 쓰기 차단, 페이지 안 점검 도구 돌리기. 그림은 파일로, 데이터는 JSON 으로 돌아온다. 아직 설정이 안 된 기기면 답에 그렇다고 하고 무엇을 돌릴지 알려 주므로, 따로 점검 단계를 먼저 밟지 않는다.

PC 에서는 대본이 `ego-browser` 로 바로 간다. 서버는 그렇게 못 한다 — ego lite 는 네트워크 포트를 열지 않고 관리자 권한으로 부르는 쪽을 거부한다("ego-browser is running as administrator"). 그런데 Windows 에서 관리자 계정의 ssh 접속은 늘 관리자 권한이다. 그래서 `relay install` 이 PC 에 중계 프로그램을 둔다. 이 프로그램은 사용자의 일반 권한 로그온 세션에서 돌고, 127.0.0.1 로만 받으며, 암호는 자기 폴더에 둔다. 서버는 ssh 로 중계의 진입 파일에 대본을 넘기고, 진입 파일이 중계에 건넨다. 결과도 같은 길로 돌아온다. ssh 연결은 2분 동안 다시 쓴다.

## 캡처
ego 는 창이 최소화돼 있으면 보통 캡처를 거부하고, X 로 닫은 창은 실제로는 숨긴 것이라 그리지 않는다. `bc.shot` 은 세 경우를 다 다룬다. 먼저 보통 캡처를 해 보고, 거부되면 화면 연속 전송(screencast — 최소화 중에도 계속 그린다. 첫 그림은 마지막 변화 전 화면일 수 있어서 받은 그림마다 답을 보내고 잠깐 기다린 뒤 마지막 그림을 쓴다)으로 받는다. 그림이 한 장도 안 오면 ego 창이 전부 X 로 닫힌 것이라 ego 를 다시 불러 숨은 창을 띄우고 곧바로 최소화한 뒤(실측 화면 노출 65~185ms) 캡처한다. 그래서 사용자는 ego 를 최소화해 두든 닫아 두든 상관없다. 페이지 전체 캡처는 ego 가 최소화돼 있지 않을 때만 되고, 그 밖에는 나눠 찍어 이어 붙인다.

## 쓰기 차단
`--guard-writes [--allow-write <경로>]…`, 또는 사이트 규칙 `guardWrites: true` 와 `writeAllow`. 페이지 안에서 GET·HEAD·OPTIONS 가 아닌 fetch·XMLHttpRequest·sendBeacon·폼 제출을 허용 경로가 아니면 막고, 막은 목록을 결과에 싣는다. 켜자마자 없는 경로로 POST 를 보내 막히는지 스스로 시험한다. 웹소켓 메시지, 서비스 워커가 스스로 보내는 요청, submit 이벤트 없는 최상위 POST 이동은 막지 못한다. 로그인 사이트에서는 토큰 갱신 경로를 허용해야 한다 — 차단을 켜자 사이트의 갱신 POST 가 막혀 페이지가 로그인 화면으로 떨어졌다(서버에는 아무것도 가지 않아 로그인 자체는 살아 있었다). 예전 차단이 쓰던 브라우저 단계 가로채기는 ego 에서 멈춤이 생겨 거부한다.

## 설치
1. Windows PC 에 ego lite 를 설치하고(https://lite.ego.app/) 첫 설정을 마친 뒤, Claude 가 점검할 사이트에 ego 에서 로그인해 둔다. ego 는 Chrome·Edge 에서만 가져오기가 된다.
2. PC 와 각 서버에서 `claude plugin install browser-check@comonetso`.
3. PC 에서 `browser-check relay install` — 중계를 `%LOCALAPPDATA%\browser-check\relay` 에 복사하고 작업 스케줄러 항목 "browser-check ego relay"를 만든다(로그온 때와 1분마다, 이미 떠 있으면 바로 끝남, 시간 제한 없음, 일반 권한). `relay status`·`relay uninstall` 로 확인·제거한다.
4. 각 서버에는 PC 로 키 로그인되는 ssh Host 가 있어야 한다. 처음 쓸 때 `setup` 이 `~/.ssh/config` 의 Host 마다 중계가 있는 PC 인지 물어본다. 하나가 답하면 설정을 쓰고, 여럿이면 어느 것인지 묻고, 없으면 무엇이 빠졌는지 알려 준다.
5. **비공개 실행 설정**은 `${CLAUDE_PLUGIN_DATA}/config.json`(권한 0600, 상위 폴더 0700 — Windows 에는 이런 권한 비트가 없어 그쪽은 검사하지 않는다). Claude Code 는 Bash 도구에 `CLAUDE_PLUGIN_DATA` 를 넘기지 않으므로, 명령이 플러그인이 설치된 위치에서 이 폴더(`<plugins>/data/browser-check-comonetso`)를 알아낸다. `BROWSER_CHECK_CONFIG` 를 주면 그쪽을 쓴다. 처음 쓸 때 `setup` 이 만들고, 넣은 값을 보여 주며, 지금 판 설정은 덮어쓰지 않는다. Aside 판 설정은 알려 주고, `setup --migrate` 가 사이트 규칙을 남긴 채 다시 쓴다(옛 파일은 백업). 사이트 규칙은 빈 채로 시작하며, 그것이 안전한 기본값이다. `config/example.json`·`config/schema.json` 참고.
6. `browser-check doctor` 가 상태를 보여 준다 — PC 에서는 ego-browser·판 번호·창 상태·중계, 서버에서는 중계의 답. Claude Code 밖(cron·맨 ssh)에서는 `node <플러그인 폴더>/scripts/browser-check.mjs` 나 `<플러그인 폴더>/bin/browser-check` 로 부른다.

## 안전 (전문: `skills/browser_check/SKILL.md` §1)
`look` 단계와 대본의 누르기·입력은 실제 사이트의 버튼을 누르므로, 저장·보내기·삭제가 되는 것은 사용자 승인을 먼저 받고, 보낸 것은 결과에 목록으로 나온다 · 자기 작업 공간만 · ego 창을 Claude 가 옮기거나 크기를 바꾸거나 최소화하지 않는다(캡처 때 닫힌 창을 최소화로 다시 띄우는 것 하나만 예외) · 로그인 사이트에서는 진행 중 요청이 0 이 된 뒤에만 공간을 닫고, 아니면 열어 둔 채 보고한다 · 데이터 변경은 그 대상에 대한 명시적 승인이 있을 때만 · 클립보드·다운로드·OS 선택 창·브라우저 단축키 금지 · 쿠키·저장소 명령, 브라우저 닫기, 창 크기, 요청 가로채기, 대상 만들기는 거부 · 비밀값은 읽지도 남기지도 않는다(중앙 가리기) · 로그인·2단계 인증·CAPTCHA 는 사용자에게 넘긴다.

## 파일 배치
```
.claude-plugin/plugin.json     매니페스트
bin/                           browser-check(sh, Bash 도구 경로에 올라감) · browser-check.cmd(PowerShell·cmd)
hooks/hooks.json               SessionStart — 파일만 본다(설정 판·ego-browser 경로, 브라우저 접촉 없음)
skills/browser_check/          SKILL.md + recipes/*.md (작업별 레시피 10개)
scripts/browser-check.mjs      입구: look · run(별칭 ego) · api · setup(첫 설정, --migrate) · doctor · relay install|status|uninstall
scripts/ego/                   prelude.mjs(bc.* 도우미) · relay.mjs(PC 중계) · entry.cmd(서버가 부르는 곳) · window.ps1(ego 창 상태, 최소화로 다시 띄우기)
scripts/lib/                   look(한 줄 점검) · api(함수 찾기) · ego(실행기) · setup · config · capabilities · relay-install · redact
scripts/kit/                   diag-v2.1.js · webcheck*.js · vitals*.js · perfdiag · emu-lib
scripts/image/stitch.py        나눠 찍은 그림 이어 붙이기(Pillow)
test/                          basic.test.mjs(가리기·설정·누출) · setup.test.mjs(첫 설정) · ego.test.mjs(실행기·도우미) · simple.test.mjs(look·api·데이터 폴더·bin) · ego-example.mjs · ego-guard.mjs(`run` 으로 돌린다)
```

`node --test test/basic.test.mjs test/setup.test.mjs test/ego.test.mjs test/simple.test.mjs` 는 브라우저 없이 돈다. 누출 검사는 패턴을 로컬 파일(`~/.claude/_private/browser_check_leak.txt` 또는 `BROWSER_CHECK_LEAK_LIST` 의 경로)에서 한 줄에 `/정규식/플래그` 하나씩 읽는다. 이 목록을 패키지에 넣으면 지키려는 값을 공개하게 되므로 밖에 둔다. 목록이 없으면 검사는 통과가 아니라 건너뛴다.

## 실행 환경
외부 패키지 없음, Node 기본 모듈만. 서버 쪽은 Node 18 이상(Node 20·22 에서 실측). 대본 자체는 ego 에 든 Node(ego lite 0.6 은 24)에서 돈다. Python 3 + Pillow 는 그림 이어 붙이기·자르기에만 쓴다(선택). doctor 가 찾은 명령을 알려 준다.

## 실측 (2026-10-21 · Windows 11 · ego lite 0.6.0.16 · Chromium 154)
PC: 열기, 스냅샷, 클릭, 입력, 첫 로딩 전 주입, 기기·미디어 흉내, CSS 규칙, 접근성 트리, 성능 수치, 3만 자 점검 도구, 콘솔·예외·404 이벤트, 작업 공간 셋 동시 실행 · 최소화 상태와 X 로 닫은 뒤의 연속 전송 캡처(빨강·초록·파랑 바탕으로 그림마다 확인) · 쓰기 차단이 fetch POST 와 폼 제출을 막고 GET 은 통과, 쿠키 읽기는 거부 · 로그인 사이트를 새 작업 공간에서 열면 로그인된 채로 뜨고, 진행 중 0 뒤에 닫힘 · ego 를 완전히 끈 뒤 다음 실행이 다시 켬. 리눅스 서버 셋에서 중계를 거쳐: setup 이 PC 를 스스로 찾음, 예제가 5.4~6.3초에 돌고 그림이 서버로 옴, ego 를 X 로 닫아 둔 상태에서 캡처가 창을 최소화로 다시 띄움, ego 가 꺼져 있을 때 중계가 먼저 최소화로 켬. PC 에서 `look`: 공개 페이지 4.5초, 캡처가 ego 를 먼저 다시 띄워야 했을 때 7.8초 · 양식을 채워 제출하니 그 POST 가 `sent` 에 나옴(차단을 켜면 막히고 `guardBlocked` 에 나옴) · 폭 390 다크 화면.

## 아직 안 잰 것 — 짐작하지 말 것
최소화된 ego 창이 타이머·애니메이션 프레임을 늦추는지(그림 기반 수치·INP). 누르기·입력은 보통 0.1~0.6초였지만 몇 번은 6~11초가 걸렸고 원인은 모른다 · 재부팅 뒤(로그온 트리거)와 며칠 동안의 중계 · PC 절전 중 중계 동작 · 실행 중에 ego 업데이트가 현재 판 링크를 옮길 때 · 실제 앱에서 레시피 처음부터 끝까지.
