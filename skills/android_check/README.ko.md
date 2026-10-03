# android-check — Claude 가 안드로이드 실기기를 직접 누르고·보고·로그 읽고·고친다

사람이 화면을 캡처해 붙여 주는 디버깅을 없앤다. Claude Code 가 실기기(또는 에뮬레이터)에서 요소를 **이름으로 찾아 누르고**, 같은 순간 **화면을 캡처**하고, **그 사이 로그캣을 그 앱 것만 잘라** 오류·성능 경고와 **터치가 앱에 닿았는지**를 표시하고, **반응 시간**을 잰다. 고친 뒤에는 **앱 실행을 직접 맡아**(Flutter hot reload · 네이티브 재설치) 같은 동작을 다시 확인한다. 화면을 판단하며 여러 단계를 눌러야 할 때는 ARTEMIS MCP 로 탐색한다.

- 대상: **Flutter 앱**(Semantics → `content-desc`)과 **순수 네이티브 앱**(View `text`·`resource-id`, Compose `testTag`)
- 발동: 한국어 자연어 — "폰 화면 봐", "눌러 봐", "로그캣 봐", "반응 속도 재 봐", "앱 테스트해", "앱 디버깅해", "핫 리로드 해", "아르테미스로 해" (STT 받아쓰기 변형 포함)
- 호출명: `android-check:android_check`

## 도구 세 층
| 층 | 무엇 | 언제 | 실측 |
|---|---|---|---|
| 보기 | `screenshot` · `elements` | 지금 화면 | 캡처 0.40초 · 구조 2.4초 |
| 측정·로그 | `tap "<이름>" --measure --log --package P --shot f.png` | 누르고 결과·로그·반응 시간 | 동작당 2~4초 |
| 탐색·조작 | ARTEMIS `mobile_run_task` | 판단하며 여러 단계·전수 시험 | 항목당 약 7초 · Gemini 약 3.1만 토큰 |

## 설치
1. `claude plugin install android-check@comonetso`
2. **adb**(Android platform-tools)가 있어야 한다. 반응 시간 측정에만 **Python 3 + Pillow** 가 필요하다(없으면 그 기능만 빠진다).
3. 처음 쓸 때 `android_check.py setup` 이 이 기기를 살펴 **비공개 설정** `${CLAUDE_PLUGIN_DATA}/config.json` 을 만든다 — adb 경로, ARTEMIS 위치(Claude Code 에 등록된 MCP 에서 읽음), Pillow 가 있는 파이썬. 이미 있는 파일은 덮어쓰지 않는다. 기기 시리얼·화면 번호·앱 경로 같은 개인 값은 **여기에만** 둔다(공개 저장소에 올라가지 않는다). 예시 `config/example.json`.
4. `android_check.py doctor` — 연결·잠금·**미러링 검은 화면 창**·디스플레이·adb 버전 일치·ARTEMIS·Pillow·로그 수집기를 점검한다. 아무것도 바꾸지 않는다.
5. 앱 실행을 맡기려면 앱마다 한 번: `app register --package P --type flutter --project-dir D --run-args "--flavor dev"` (네이티브는 `--type native --install-task :app:installDebug`).

### ARTEMIS (선택 — 탐색·전수 시험용)
- ARTEMIS(구글 안드로이드 자동화)를 설치하고 `uv run artemis mcp --install claude` 로 등록한다. AI 키(기본 Gemini)는 ARTEMIS `.env` 에 사람이 직접 넣는다.
- **adb 를 하나로 맞춘다** — ARTEMIS `.env` 에 `ARTEMIS_ADB_PATH` 와 `ADB`(scrcpy 가 읽음)를 이 플러그인이 쓰는 adb 로. 버전이 다른 adb 끼리는 서로 서버를 껐다 켜서 연결이 끊긴다(실측: 34 / scrcpy 동봉 37 / ARTEMIS 내장 36).
- **Windows: CMD 창이 계속 뜨면** `extras/artemis_sitecustomize.py` 를 ARTEMIS 의 `.venv/Lib/site-packages/sitecustomize.py` 로 복사한다. ARTEMIS 원본은 건드리지 않고, 외부 프로그램을 창 없이 실행하게 한다. venv 를 새로 만들면 다시 넣는다.
- winget 으로 깐 scrcpy 는 ARTEMIS 가 못 찾는다 → `.env` 에 `ARTEMIS_SCRCPY_PATH`.

## 🔴 꼭 알아야 할 것 (전문은 `skills/android_check/SKILL.md`)
- **화면 미러링이 탭을 전부 가져간다** — Samsung Flow Smart View·휴대폰과 연결이 폰 위에 검은 화면 창을 띄우면 캡처는 되는데 탭만 안 먹는다. Smart View 는 도구 모음 "휴대전화 화면" 켜짐, 휴대폰과 연결은 설정 → 휴대폰 화면 → "연결된 동안 휴대폰 화면 숨기기" 끔. `tap --log` 가 "터치가 앱에 안 닿음"으로 바로 알려 준다.
- 폰이 잠기면 ARTEMIS 가 작업을 거부한다 · 기기 로그는 1~2분이면 밀려나니 긴 시험 전 `logwatch start` · 바꾼 상태는 원래대로(토글 두 번, 값은 되돌리기, 회전은 `rotate restore`) · 이미 사람이 띄운 `flutter run` 위에 겹쳐 띄우지 않는다.

## 구조
```
.claude-plugin/plugin.json        매니페스트
hooks/hooks.json                  SessionStart — 파일 존재만 확인(기기·네트워크 접촉 없음)
skills/android_check/SKILL.md     발동·규칙·디버깅 루프·보고 형식
scripts/android_check.py          진입점: setup · doctor · elements · tap · back · rotate · screenshot · logwatch · app · (runner)
config/example.json               비공개 설정 예시
extras/artemis_sitecustomize.py   Windows 에서 ARTEMIS 의 CMD 창 숨기기
test/test_android_check.py        기기 없이 도는 단위 시험(요소 해석·오류/경고 패턴·로그 거르기·터치 판정·비밀 값 비보관)
```
`python -m unittest discover -s test` — 외부 패키지 없이 돈다.

## 실측 (2026-10-04 · Galaxy Z Flip6 · Android 16 · 무선 adb · Flutter 디버그 빌드)
명령 도착 0.15초 · 화면 첫 반응 0.61초 이내(측정 간격 0.4초라 상한값) · 애니메이션 끝 1.41초 · 서버 왕복은 앱 로그 기준 67ms · 앱이 새로 뜬 뒤 첫 메뉴 열기만 1.5초(로그에 `Skipped 67 frames`, 이후 0.8초) · 네이티브 화면(홈 런처·날씨 위젯)에서 `text`·`resource-id` 로 찾아 누르기 확인 · 로그 오류 0줄인데 화면이 틀어진 경우(스크롤 영역)를 캡처로 잡음 · ARTEMIS 로 메뉴 23항목 전수 166초.

## 아직 실측되지 않은 것 (짐작하지 말 것)
`app start/reload` 로 Flutter 실행을 맡는 경로(`flutter run --machine`)와 네이티브 재설치 경로의 실기기 왕복 · Compose 앱 · 에뮬레이터 · macOS/Linux 호스트 · 정밀 반응 측정(`screenrecord` + 터치 표시). 근거 문서: 실측 기록과 표준안(별도 보관).
