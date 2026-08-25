# steer-fixture — `codex app-server` 끼어들기 실측 도구

`codex_rescue` 를 지금의 `codex exec`(배치)에서 `codex app-server`(JSON-RPC)로 옮길 수 있는지
판단하려고 만든 일회성 실측 도구다. 알고 싶은 건 하나다 — **Codex 가 도는 중에 말을 끼얹을 수 있는가**
(`turn/steer`), 그리고 **그렇게 만든 대화를 나중에 `codex exec resume` 으로 이어받을 수 있는가.**

추측을 코드에 남기지 않으려고 만든 도구라, 확인 못 한 항목은 `⬜` 로 남긴다. 절대 `✅` 로 올리지 않는다.

## 먼저 알아야 할 것

- **실제 Codex 세션을 만들고 토큰을 쓴다.** 1턴이 45초 이상 돌고, 그 뒤 `codex exec resume` 을
  최대 세 번 더 돈다. 다른 Codex 작업(핑퐁·CONSULT·워크플로우)이 도는 중에는 돌리지 마라.
- **이 저장소를 건드리지 않는다.** 임시 폴더 아래에 작업 디렉토리를 새로 파고 거기서만 논다.
- **`--dry-run` 은 codex 를 부르지 않는다.** 조립될 명령줄과 JSON-RPC 원문만 보여준다. 먼저 이걸 봐라.

## 돌리는 법

```bash
# 1) 아무것도 안 부르고 무엇을 보낼지만 본다
node tools/steer-fixture/steer-fixture.mjs --dry-run

# 2) 진짜로 돌린다 (기본: WebSocket 두 연결)
node tools/steer-fixture/steer-fixture.mjs

# 3) ws 리슨이 안 되면 stdio 로. 단 4번 항목은 ⬜ 로 남는다
node tools/steer-fixture/steer-fixture.mjs --transport stdio

# 4) 앞의 8개만 빨리 보고 resume(9·10)은 나중에
node tools/steer-fixture/steer-fixture.mjs --skip-resume
```

옵션 전체는 `--help` 를 봐라.

## 무엇을 판정하는가

열 가지를 순서대로 본다. 각 항목은 판정 기호 하나와 근거 줄로 남는다.

1. `initialize` 가 성공하는가 — 응답에 `result` 가 왔는지.
2. `thread/start` 가 성공하고 threadId 를 주는가 — `result.thread.id` 와 `.sessionId` 를 둘 다 기록한다.
3. 오래 걸리는 명령이 실제로 도는가 — `turn.durationMs` 가 `--busy-seconds` 이상인지.
4. 명령이 도는 중에 **두 번째 연결**에서 steer 를 보냈는가 — conn2(별도 WebSocket)에서 보냈는지.
5. 같은 `expectedTurnId` 로 수락되는가 — 응답의 `turnId` 가 기대한 값과 같은지.
6. 완료 응답이 steer 문장을 **실제로 언급하는가** — 최종 메시지에 steer 로만 전달한 토큰이 들어 있는지.
7. steer 이후 새 `turn/started` 가 안 생기는가 — conn1 기준 개수가 0인지.
8. 완료된 턴에 같은 `expectedTurnId` 로 steer 하면 거부되는가 — 재전송이 에러로 돌아오는지.
9. app-server 를 죽인 뒤 `codex exec resume` 으로 **맥락이 이어지는가** — 1턴에 심은 센티넬을 되받는지.
10. 그 resume 을 `-c sandbox_mode=read-only` 로 돌리면 권한 경계가 재현되는가 — 쓰기 프로브 파일이
    안 생기는지, 그리고 대조군에서는 생기는지.

**6번과 9번이 이 도구의 존재 이유다.**

- 6번: RPC 가 200 을 돌려주는 것과 **모델이 그 말을 실제로 듣는 것**은 다른 문제다. 그래서 steer 문장에만
  들어 있는 랜덤 토큰(`STEER-xxxxxxxx`)을 심고, 최종 메시지에 그 토큰이 있는지로 판정한다.
  토큰은 프롬프트 어디에도 없으므로 모델이 지어낼 수 없다.
- 9번: 1턴에서 `MEMO-xxxxxxxx` 를 외우게 하고, app-server 를 **죽인 뒤** `codex exec resume` 으로
  "아까 그 메모 단어가 뭐였나" 만 묻는다. resume 프롬프트에는 센티넬 값을 넣지 않는다.
  🔴 **9번이 ❌ 면 "기존 FOLLOWUP 을 그대로 둔다"는 설계 전체가 무너진다.**
  이 경우 `threadId` 로 실패했을 때 `sessionId` 로도 한 번 더 시도하고, 둘 다의 결과를 남긴다.

10번은 **대조군까지 돈다.** `read-only` 에서 파일이 안 생긴 것만 보면 "권한이 막았다"인지
"모델이 시도를 안 했다"인지 못 가린다. 그래서 같은 요청을 `workspace-write` 로 한 번 더 돌려
그때는 파일이 생기는지 본다. 대조군이 없으면 10번은 `⬜` 로 남는다(`--no-control` 로 끌 수 있다).

## 나오는 것

전부 `<out>` 아래에 쌓인다. 기본 위치는 임시 폴더(`%TEMP%\codex-steer-fixture\<시각>`)이고,
`--out` 으로 옮길 수 있다. **자동으로 지우지 않는다** — 나중에 대조해야 하기 때문이다.

```
report.txt        사람이 읽는 판정표 + 타임라인 (화면에도 같은 내용이 나온다)
verdict.json      기계 판독용 판정 + 옵션 + 타임라인
rpc.jsonl         JSON-RPC 송수신 **원문** 전부 (방향·연결·경과 ms 포함)
timeline.jsonl    단계별 타임스탬프
resume-*-last.txt / resume-*-events.jsonl   exec resume 의 최종 메시지와 이벤트 스트림
work/             codex 의 cwd. 쓰기 프로브 파일(probe-*.txt)이 여기 생긴다
```

기록되는 타임스탬프: `initialize` 전송/응답 · `thread/start` 전송/응답 · `turn/start` 전송/응답 ·
`turn/started` 알림 · 첫 item 알림 · 명령 item 시작/완료 · steer 전송/응답 · `turn/completed` ·
app-server 종료 · resume 시작/종료.

### 🔴 특히 봐야 할 기록: `turn/start` 응답이 언제 오는가

스키마만으로는 `turn/start` 응답이 **턴 시작 즉시** 오는지 **끝난 뒤** 오는지 알 수 없다.
그래서 이 도구는 turnId 를 `turn/started` 알림에서 잡되, **응답과 알림 중 어느 쪽이 먼저 왔는지**를
3번 항목의 근거 줄에 그대로 적는다. app-server 로 갈아탈 때 이 순서가 설계를 가른다.

## 전제와 한계 — 돌리기 전에 읽어라

- **`--transport ws` 는 아직 실측된 적이 없다.** `codex app-server --listen ws://IP:PORT` 는
  `--help` 에 있는 옵션이고, `--ws-auth` 설명이 "non-loopback listeners" 라고 못박으므로
  127.0.0.1 리슨은 무인증일 것으로 **보인다**. 실제로 열리는지는 돌려 봐야 안다.
  안 열리면 스크립트가 "ws 리슨에 붙지 못했다 … `--transport stdio` 로 다시 돌려라" 하고 멈춘다.
  자동으로 stdio 로 갈아타지 않는다 — 조용한 폴백은 실측 결과를 흐린다.
- **stdio 로 돌리면 4번은 `⬜` 다.** 연결이 하나뿐이라 "두 번째 연결" 자체가 성립하지 않는다.
  같은 연결에서 turn 이 도는 중에 steer 를 보내는 것까지는 검증된다.
- **별도 연결이 그 스레드를 모를 수 있다.** 그럴 때만 `thread/resume` 으로 rejoin 한 뒤 steer 를
  다시 쏘고, "바로 됐는지 / rejoin 이 필요했는지"를 4번 근거에 남긴다. 이건 폴백이 아니라 실측 항목이다.
- **알림이 연결마다 브로드캐스트되는지도 미확인.** conn2 가 받은 `turn/started` 는 **집계에서 뺀다**
  (안 그러면 7번이 두 배로 세어져 그냥 오판한다). 대신 몇 개 받았는지는 근거에 남긴다.
- **리뷰·컴팩션 턴은 steer 가 안 된다** — 스키마의 `NonSteerableTurnKind = ["review", "compact"]`.
  이 도구는 일반 턴만 본다.
- 승인 요청(`ExecCommandApproval` 등)이 오면 **응답하지 않고 기록만 한다.** `approvalPolicy=never`
  로 시작하므로 오면 안 되는 물건이고, 온다면 그 자체가 발견이다.
- **stderr 는 통째로 버린다.** 계정 정보가 섞일 수 있어서다(`usageProvider.ts` 와 같은 원칙).
  바이트 수만 세어 근거에 남긴다.

## 기본값이 어디서 왔는지

지어낸 값이 아니라는 걸 밝혀 둔다. 전부 옵션으로 바꿀 수 있다.

- `--busy-seconds 45` — Phase 0 요구가 "30초 이상"이라 여유를 둔 값.
- `--sandbox read-only` — `send.sh` 가 CONSULT 첫 턴에 쓰는 값과 같게 맞췄다.
- `--approval never` — 사람이 없는 자동 픽스처다. 승인 요청이 오면 그대로 멈춘다.
- `--win-sandbox unelevated` (win32 전용) — `send.sh` 의 `CR_WIN_SANDBOX` 기본값과 동일.
- `--port 45871` — 그냥 안 쓰는 루프백 포트. 충돌하면 바꿔라.
- `--turn-timeout 300` / `--resume-timeout 300` — 45초 명령에 모델 사고 시간을 얹은 상한.
- `--steer-after-max-ms 20000` — **임의 상한이다.** 명령 item 알림이 이 안에 안 오면 그냥 steer 를
  쏘고, "실행 중이었는지 불확실하다"고 근거에 적는다. reasoning 이 길어 자주 걸리면 늘려라.

`codex exec resume` 인자 조합은 `skills/codex_rescue/send.sh` 359~369행을 그대로 따랐다.
`resume` 에는 `-s` 도 `-C` 도 없어서 cwd 에 의존하므로, 이 도구는 작업 디렉토리를 cwd 로 잡고 부른다.
프롬프트는 위치 인자가 아니라 `-` 로 **stdin** 에 넣는다 — Windows 에서 `shell:true` 로 띄우면
공백·개행이 든 인자가 깨지기 때문이다.

## 프로세스 정리

Windows 에서는 `taskkill /PID <pid> /T /F` 로 트리째 죽인다. `shell:true` 로 띄우면 `child.pid` 는
`cmd.exe` 의 것이라 그냥 `kill` 하면 진짜 codex 가 살아남는다(MSYS `kill` 은 네이티브 손자에 안 닿는다).
정상 종료·예외·Ctrl+C 어느 쪽으로 끝나도 정리 훅이 돈다. 그래도 돌린 뒤에 한 번 확인해라:

```bash
tasklist | grep -i codex          # Windows
```

## 돌린 다음

`report.txt` 를 그대로 가져와서 판단 근거로 쓰면 된다. 특히:

- **6번이 ❌ 인데 5번이 ✅ 라면** — RPC 는 받아 주는데 모델에는 안 닿는다는 뜻이다.
  `turn/steer` 를 "끼어들기"로 쓸 수 없다는 결론이 된다.
- **9번이 ❌ 라면** — app-server 로 시작한 스레드를 `codex exec resume` 이 못 이어받는다는 뜻이고,
  기존 CONSULT/FOLLOWUP 배관을 그대로 두는 설계가 성립하지 않는다. `rpc.jsonl` 과
  `resume-ask-*-events.jsonl` 을 같이 봐라 (`thread_id` 가 무엇으로 찍혔는지).
