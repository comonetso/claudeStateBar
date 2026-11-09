# android-check — Claude 가 안드로이드 실기기를 직접 누르고·보고·로그 읽고·고친다

사람이 화면을 캡처해 붙여 주는 디버깅을 없앤다. Claude Code 가 실기기(또는 에뮬레이터)에서 요소를 **이름으로 찾아 누르고**, 같은 순간 **화면을 캡처**하고, **그 사이 로그캣을 그 앱 것만 잘라** 오류·성능 경고와 **터치가 앱에 닿았는지**를 표시하고, **반응 시간**을 잰다. 고친 뒤에는 **앱 실행을 직접 맡아**(Flutter hot reload · 네이티브 재설치) 같은 동작을 다시 확인한다. 화면을 판단하며 여러 단계를 눌러야 할 때는 ARTEMIS MCP 로 탐색하고, ARTEMIS 가 찾은 흐름은 저장해 두었다가 폰 하네스(phone-harness)로 **AI 없이** 다시 돌린다.

- 대상: **Flutter 앱**(Semantics → `content-desc`)과 **순수 네이티브 앱**(View `text`·`resource-id`, Compose `testTag`)
- 발동: 한국어 자연어 — "폰 화면 봐", "눌러 봐", "로그캣 봐", "반응 속도 재 봐", "앱 테스트해", "앱 디버깅해", "핫 리로드 해", "아르테미스로 해", "같은 흐름 다시 돌려" (STT 받아쓰기 변형 포함)
- 호출명: `android-check:android_check`

## 도구 네 층
| 층 | 무엇 | 언제 | 실측 |
|---|---|---|---|
| 보기 | `screenshot` · `elements` | 지금 화면 | 캡처 0.40초 · 구조 2.4초 |
| 측정·로그 | `tap "<이름>" --measure --log --package P --shot f.png` | 누르고 결과·로그·반응 시간 | 동작당 2~4초 |
| 탐색·조작 | ARTEMIS `mobile_run_task` | 판단하며 여러 단계·전수 시험 | 항목당 약 7초 · Gemini 약 3.1만 토큰 |
| 다시 돌리기 | `flow save` · `flow run` | ARTEMIS 가 이미 찾은 흐름을 다시 | 2단계 17~19초 · AI 없음 |

## 설치
1. `claude plugin install android-check@comonetso`
2. **adb**(Android platform-tools)가 있어야 한다. 반응 시간 측정에만 **Python 3 + Pillow** 가 필요하다(없으면 그 기능만 빠진다).
3. 처음 쓸 때 `android_check.py setup` 이 이 기기를 살펴 **비공개 설정** `${CLAUDE_PLUGIN_DATA}/config.json` 을 만든다 — adb 경로, ARTEMIS 위치(Claude Code 에 등록된 MCP 에서 읽음), Pillow 가 있는 파이썬. 이미 있는 파일은 덮어쓰지 않는다. 기기 시리얼·화면 번호·앱 경로 같은 개인 값은 **여기에만** 둔다(공개 저장소에 올라가지 않는다). 예시 `config/example.json`.
4. `android_check.py doctor` — 연결·잠금·**미러링 검은 화면 창**·디스플레이·adb 버전 일치·ARTEMIS·Pillow·폰 하네스·로그 수집기를 점검한다. 아무것도 바꾸지 않는다.
5. 앱 실행을 맡기려면 앱마다 한 번: `app register --package P --type flutter --project-dir D --run-args "--flavor dev"` (네이티브는 `--type native --install-task :app:installDebug`).

### ARTEMIS (선택 — 탐색·전수 시험용)
- ARTEMIS(구글 안드로이드 자동화)를 설치하고 `uv run artemis mcp --install claude` 로 등록한다. AI 키(기본 Gemini)는 ARTEMIS `.env` 에 사람이 직접 넣는다.
- **adb 를 하나로 맞춘다** — ARTEMIS `.env` 에 `ARTEMIS_ADB_PATH` 와 `ADB`(scrcpy 가 읽음)를 이 플러그인이 쓰는 adb 로. 버전이 다른 adb 끼리는 서로 서버를 껐다 켜서 연결이 끊긴다(실측: 34 / scrcpy 동봉 37 / ARTEMIS 내장 36).
- **Windows: CMD 창이 계속 뜨면** `extras/artemis_sitecustomize.py` 를 ARTEMIS 의 `.venv/Lib/site-packages/sitecustomize.py` 로 복사한다. ARTEMIS 원본은 건드리지 않고, 외부 프로그램을 창 없이 실행하게 한다. venv 를 새로 만들면 다시 넣는다.
- winget 으로 깐 scrcpy 는 ARTEMIS 가 못 찾는다 → `.env` 에 `ARTEMIS_SCRCPY_PATH`.

### 폰 하네스 (선택 — 찾은 흐름을 AI 없이 다시 돌리기)
- `uv tool install --python 3.12 phone-harness` 뒤 `phone-harness config set telemetry false`. 사용 기록을 기본으로 보내고, `false`·`0` 만 먹는다(`off`·`no` 는 무시된다). 꺼졌는지는 `doctor` 가 보여 준다.
- ARTEMIS 작업이 성공하면 `flow save <이름> --session <trace_id>` 가 화면을 바꾼 단계만 남기고(다시 시도·헛누름은 빼고, 셸 명령은 옮기지 않는다), `flow run <이름>` 이 그 단계를 정확한 이름으로 찾아 다시 누른다. 이름이 화면에 없으면 아무것도 누르지 않고 그 단계에서 멈춰 어디서 막혔는지 알려 주니, 그 자리부터 ARTEMIS 에 맡기면 된다.
- 성공 완료한 실행만 저장하며 미지원 단계나 모호한 전경 기록이 있으면 거부한다. `--package`로 근거 누락을 덮을 수는 없다. 셸 명령은 뺀 단계로 알린다. 앱 실행은 기록의 실제 전경 패키지를 쓰고, 입력은 대상과 `clear_exist`(기본 true)를 보존한다. `--force`는 이전 파일을 `.bak`(이후 `.bak.1` 등)으로 남긴다.
- 재생은 기기에 닿기 전에 전체 단계와 `--from-step`을 검증한다. 기록된 시작 앱(activity가 있으면 함께)과 각 동작 직전 전경 패키지를 확인하며, 불일치하거나 비공개 설정의 `deny_packages` 목록에 든 앱이 전경이면 입력 전에 종료 3으로 멈춘다. 목록 기본값은 비어 있다. 이 기록이 없는 옛 flow는 다시 저장해야 한다. 같은 앱 안의 서로 다른 화면까지 구별하지는 않는다.
- 입력은 포커스를 확인할 수 있는 칸에서만 하고, 지운 결과와 입력값을 다시 읽는다. 설치된 Android `type_text`는 `adb input text`를 쓰므로 전달을 보장할 수 없는 한글 등 비ASCII 입력은 명시적으로 멈춘다. 마지막 `wait_stable`을 확인하지 못하면 일반 출력과 `--json`(`final_stable: false`, 상태 `unverified`)에 알리며 종료 코드는 0을 유지한다. 어느 결과도 최종 목표 달성을 검사하지는 않는다.
- 화면 캡처는 이 플러그인의 `screenshot` 으로 한다. 폰 하네스의 캡처는 접는 폰에서 깨진다(Galaxy Z Flip6 실측).

## 🔴 꼭 알아야 할 것 (전문은 `skills/android_check/SKILL.md`)
- **화면 미러링이 탭을 전부 가져간다** — Samsung Flow Smart View·휴대폰과 연결이 폰 위에 검은 화면 창을 띄우면 캡처는 되는데 탭만 안 먹는다. Smart View 는 도구 모음 "휴대전화 화면" 켜짐, 휴대폰과 연결은 설정 → 휴대폰 화면 → "연결된 동안 휴대폰 화면 숨기기" 끔. `tap --log` 가 "터치가 앱에 안 닿음"으로 바로 알려 준다.
- 폰이 잠기면 ARTEMIS 가 작업을 거부한다 · 기기 로그는 1~2분이면 밀려나니 긴 시험 전 `logwatch start` · 바꾼 상태는 원래대로(토글 두 번, 값은 되돌리기, 회전은 `rotate restore`) · 이미 사람이 띄운 `flutter run` 위에 겹쳐 띄우지 않는다.

## 구조
```
.claude-plugin/plugin.json        매니페스트
hooks/hooks.json                  SessionStart — 파일 존재만 확인(기기·네트워크 접촉 없음)
skills/android_check/SKILL.md     발동·규칙·디버깅 루프·보고 형식
scripts/android_check.py          진입점: setup · doctor · elements · tap · back · rotate · screenshot · logwatch · app · flow · (runner)
config/example.json               비공개 설정 예시
extras/artemis_sitecustomize.py   Windows 에서 ARTEMIS 의 CMD 창 숨기기
test/test_android_check.py        기기 없이 도는 단위 시험(요소 해석·오류/경고 패턴·로그 거르기·터치 판정·비밀 값 비보관·ARTEMIS 기록 → 흐름 단계)
```
`python -m unittest discover -s test` — 외부 패키지 없이 돈다.

## 실측 (2026-10-04 · Galaxy Z Flip6 · Android 16 · 무선 adb · 디버그 빌드)
명령 도착 0.15초 · 화면 첫 반응 0.61초 이내(측정 간격 0.4초라 상한값) · 애니메이션 끝 1.41초 · 서버 왕복은 앱 로그 기준 67ms · 앱이 새로 뜬 뒤 첫 메뉴 열기만 1.5초(로그에 `Skipped 67 frames`, 이후 0.8초) · 로그 오류 0줄인데 화면이 틀어진 경우(스크롤 영역)를 캡처로 잡음 · ARTEMIS 로 메뉴 23항목 전수 166초.

- **Flutter 앱 실행 맡기**(`flutter run --machine`): `app start` 앱이 뜰 때까지 25초 · `app reload`(hot reload) 1.2초 · `app stop` 0.26초.
- **순수 네이티브 앱**(Kotlin, View): `text` 로 찾아 누르고 앱 자체 로그로 터치 도착 확인, 첫 반응 0.76~0.88초, 오류 0줄 · `app reload`(Gradle 설치 + 재실행) 첫 빌드 120초, 이후 22초. Flutter 앱 안의 네이티브 화면(홈 런처·날씨 위젯)도 `text`·`resource-id` 로 눌렀다.
- **한 번 찾고 다시 돌리기**(2026-11-10, Paseo 앱에서 옆 메뉴 열고 닫기): Claude Sonnet 5.5 로 돈 ARTEMIS 가 29초·모델 호출 5번에 길을 찾았고, `flow run` 이 AI 없이 17~19초에 같은 길을 되풀이했다(두 번 다 이름으로 찾아 누름). 다른 화면에서 시작하자 없는 단계에서 아무것도 누르지 않고 멈췄다.

## 아직 실측되지 않은 것 (짐작하지 말 것)
Compose 앱 · 에뮬레이터 · macOS/Linux 호스트 · 정밀 반응 측정(`screenrecord` + 터치 표시). 근거 문서: 실측 기록과 표준안(별도 보관).
