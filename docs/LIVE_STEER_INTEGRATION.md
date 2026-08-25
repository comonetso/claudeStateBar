# live-consult 를 `send.sh` 에 붙이는 계획

> 🔴 **이 문서는 계획이다. `send.sh` 는 한 글자도 고치지 않았다.**
>
> 대상: `~/.claude/skills/codex_rescue/send.sh` (2,016행 · `die` 방어 119곳 · 로컬 + 서버 4대에 배포)
> 중계기: [`tools/live-consult/`](../tools/live-consult/README.md)
> 근거: [`CODEX_MULTITURN_DELAY_RESPONSE.md`](./CODEX_MULTITURN_DELAY_RESPONSE.md) (Codex 자문) ·
> Phase 0 실측 (`%TEMP%\codex-steer-fixture\2026-08-25T12-11-27-190Z\rpc.jsonl`)
>
> 결정되지 않은 항목은 **⬜ 결정 필요** 로 표시했다. 임의로 채우지 않았다.

## 목표와 경계

CONSULT 가 도는 중에 사용자와 Claude 가 정정을 넣을 수 있게 한다. 그것만 한다.

`send.sh` 를 Node 로 다시 쓰지 않는다. 바꾸는 것은 **`codex exec` 를 부르는 그 자리가 무엇을
부르는가** 뿐이고, 그 앞뒤의 검증·감시·후처리는 전부 지금 그대로 둔다.

한 가지 전제를 먼저 밝혀 둔다. 중계기는 지금 이 저장소의 `tools/live-consult/` 에 있는데,
`send.sh` 는 스킬 자산이라 5대에 배포된다. **실제로 붙이려면 중계기도 스킬 원본 아래로 옮겨
같은 배포 절차를 타야 한다.** 그러지 않으면 서버에서 `CR_LIVE_STEER` 를 켰을 때 파일이 없다.
이 문서는 그 이동이 이뤄진 뒤를 가정하고 쓴다.

---

## a. `CR_LIVE_STEER=1` 분기를 어디에 넣는가

### 먼저 — 중계기는 파이프라인이 아니다

기존 실행부는 codex 의 stdout 을 파이프로 받아 events 파일 두 곳에 흘리는 구조다.

```bash
# 1599-1607행 — 현재
if [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
else
  "$@" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
fi
PIPE_RC=("${PIPESTATUS[@]}")
RC=${PIPE_RC[0]}
TEE_RC=${PIPE_RC[1]:-0}
```

중계기는 이 모양이 아니다. 구현된 CLI 는 **events 를 `--events-file` 에 직접 append 하고,
stdout 에는 끝날 때 `LIVE_CONSULT_RESULT` 결과 블록 하나만 낸다.** 그대로 파이프라인에 넣으면
결과 블록이 events 파일에 섞여 들어가 `feedExecLine` 이 `badLines` 로 센다.

그래서 **실행부에 분기를 하나 더 넣어야 한다.** 여기가 이 통합에서 가장 조심할 지점이다.

### 실행부 수정안

```bash
# 🔴 중계기 경로는 파이프라인이 아니다. events 를 자기가 직접 쓰므로 tee 를 타지 않는다.
#    PIPE_RC 를 분기 안에서 직접 채워 아래 두 줄(RC · TEE_RC)의 계약을 그대로 유지한다.
if [ -n "${LIVE_STEER_ON:-}" ]; then
  "$@" 2>"$ERRLOG" > "$RUN_DIR/live_result.txt"
  PIPE_RC=("$?" 0)
elif [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
  PIPE_RC=("${PIPESTATUS[@]}")
else
  "$@" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
  PIPE_RC=("${PIPESTATUS[@]}")
fi
RC=${PIPE_RC[0]}
TEE_RC=${PIPE_RC[1]:-0}
```

🔴 **`PIPE_RC` 를 채우는 줄이 분기 안으로 들어간다.** 지금은 `PIPESTATUS` 를 복사하는 줄이
파일에 하나뿐이고 그 위에 "바로 다음 명령에서 배열째 복사해야 한다"는 경고 주석이 붙어 있다.
분기가 셋이 되면 그 규칙을 **세 곳에서** 지켜야 하고, 하나만 빠져도 조용히 이전 값을 쓴다.
이 이동 자체가 이 계획에서 가장 위험한 변경이다.

중계기 경로에서 `TEE_RC` 를 0 으로 고정하는 것은 거짓말이 아니다 — `tee` 를 타지 않았으므로
"tee 가 실패하지 않았다"가 맞다. 다만 아래 1863행의 `[ "$TEE_RC" != 0 ]` 경고가 이 경로에서는
영원히 안 뜨게 된다는 뜻이기도 하다. 실시간 미러가 깨졌는지를 알려 주던 장치 하나가 이 경로에는
없어진다.

**⬜ 결정 필요 — 중계기 경로에서 미러 실패를 무엇으로 감지할지.** `TEE_RC` 자리를 비워 두는
대신 중계기의 events 쓰기 실패를 별도 신호로 받을지, 아니면 그냥 없는 채로 갈지.

### 명령 배열은 조립부에서 갈라진다

실행부 분기와 짝을 이루는 것이 **명령 배열 조립부**(1462~1488행의 `else` 블록)다.

```bash
SANDBOX="${CR_SANDBOX:-workspace-write}"
if [ -n "${CR_LIVE_STEER:-}" ] && [ "$KIND" = doc ] && [ "$MODE" != edit ]; then
  LIVE_STEER_ON=1
  set -- node "$LIVE_CONSULT" run \
    --stamp "$STAMP" --request-file "$REQ_W" --cwd "$ROOT_W" --sandbox "$SANDBOX" \
    --events-file "$LIVE_EVENTS_W" --last-message-file "$LASTMSG_W" \
    --appserver-log "$LOGD_W/${STAMP}_appserver.jsonl" \
    --steers-log "$LOGD_W/${STAMP}_steers.jsonl"
else
  set -- codex exec --skip-git-repo-check --json -s "$SANDBOX" -C "$ROOT_W" -o "$LASTMSG_W"
fi
```

`LIVE_STEER_ON` 이라는 내부 플래그를 따로 두는 이유는, `CR_LIVE_STEER` 는 사용자가 켠 **의도**이고
실행부가 알아야 하는 것은 **실제로 그 경로로 갔는지**이기 때문이다. `KIND` 나 `MODE` 조건에 걸려
기존 경로로 떨어졌는데 실행부가 중계기 모양으로 돌면 그대로 깨진다.

### events 를 어디에 쓰게 할 것인가

중계기는 `--events-file` 하나만 받는데 `send.sh` 는 두 곳을 본다.

- `$LIVE_EVENTS` (`.log/<stamp>_events.jsonl`) — 확장이 **실행 중 실시간으로** 읽는 곳
- `$EVENTS` (`$RUN_DIR/events.jsonl`) — `thread_id` 를 뽑는 곳(1769행)이자 후처리의 기준(1825행)

어느 한쪽만 채우면 각각 이렇게 깨진다.

- `$EVENTS` 만 주면 — `thread_id` 는 살지만 **실행 중 진행 패널이 깜깜이가 된다.**
  1.9.x 에서 해결한 문제를 되돌리는 것이라 받아들일 수 없다
- `$LIVE_EVENTS` 만 주면 — 진행 패널은 살지만 `$EVENTS` 가 비어 **`thread_id` 추출이 실패하고
  FOLLOWUP 이 통째로 죽는다.** 1769행은 `grep ... "$EVENTS"` 다

그래서 `$LIVE_EVENTS` 를 주고, 실행 직후 한 줄을 더한다.

```bash
[ -n "${LIVE_STEER_ON:-}" ] && cp -f -- "$LIVE_EVENTS" "$EVENTS" 2>/dev/null
```

이러면 1825행의 해시 비교가 "동일 — live 미러가 곧 권위 사본이다"로 판정해 복사를 건너뛰므로
그 아래 후처리도 그대로 산다. 순서상 `RC`/`TEE_RC` 를 읽은 **뒤**, `write_status finalizing`
전후 어디든 변경 감지(1616행)보다 앞이면 된다.

### 종료 코드는 이미 갈라져 있다

구현이 `turn/start` 전후를 번호대로 나눠 놓았다. 10번대는 폴백해도 안전, 20번대는 폴백 금지다.

```
0   정상                    10  기동/initialize/thread/start/turn/start 실패
2   인자 오류                11  lib/*.mjs 로드 실패
                            20  턴 중 연결 끊김·서버 사망
                            21  turn/completed status=failed
                            22  턴 상한 초과
```

이 값이 `status.json` 의 `codex_exit` 로 그대로 실린다(1268행). **같은 필드에 의미가 다른 숫자가
들어간다** — 이전에는 codex CLI 의 종료 코드였다. 확장과 사용자가 보는 숫자의 의미가 경로에 따라
달라지므로 `transport` 표시 여부와 묶여 있다.

**⬜ 결정 필요 — `codex_exit` 를 그대로 쓸지, 중계기 경로용 필드를 따로 둘지.**

### 프롬프트 조립이 이중화된다

🔴 구현된 CLI 는 `--request-file` 을 받아 **자기가 프롬프트를 만든다**(`buildConsultPrompt`).
`send.sh` 도 1313~1430행에서 같은 일을 한다. 두 곳이 각자 프롬프트를 조립하면 경로에 따라
Codex 가 받는 지시문이 달라진다.

지금 `send.sh` 의 프롬프트에는 최근 반전된 정책(원본을 직접 열어라, `.scratch/` 를 써라,
저장 실패 시 최종 메시지로 출력해라)이 들어 있다. 중계기 쪽 조립문이 그것과 어긋나면
**CONSULT 의 품질이 경로에 따라 달라지는데 아무도 그 사실을 모르게 된다.**

두 방향이 있다.

1. **중계기에 조립된 프롬프트만 넘긴다.** 요청서 경로는 프롬프트 문자열 안에 이미 들어 있고,
   Codex 가 그걸 읽는 것은 지금과 똑같다. 중계기는 요청서라는 개념을 몰라도 된다.
   프롬프트 정본이 `send.sh` 한 곳에 남는다
2. **중계기가 계속 조립한다.** 대신 두 조립문을 **바이트 단위로 동일하게** 유지할 책임이 생긴다

1번이 낫다. 다만 그러면 프롬프트를 어떻게 넘길지가 문제가 된다(바로 아래).

**⬜ 결정 필요 — 프롬프트 정본을 어디에 둘지.**

### 프롬프트를 어떻게 넘기는가

기존 실행부는 `"$@" "$PROMPT"` 로 프롬프트를 **마지막 위치 인자**에 붙인다. 위의 수정안에서
중계기 분기는 `"$PROMPT"` 를 붙이지 않는데, 이는 중계기가 `--request-file` 로 자체 조립하기
때문이다. 프롬프트 정본을 `send.sh` 에 두기로 하면 넘길 방법이 필요하다.

- **위치 인자** — 실행부 분기에 `"$PROMPT"` 를 붙인다. Windows 인자 길이 한계가 걸릴 수 있다.
  CHAT 이 이미 이 문제로 stdin 으로 옮겼고(560~564행), 32,000바이트 성공 / 32,700바이트 실패로
  실측돼 있다. CONSULT 프롬프트는 요청서 본문을 붙이지 않아 지금은 여유가 있지만, 길어지면
  조용히 깨지는 종류의 한계다
- **stdin** — `printf '%s' "$PROMPT" | node ... run --prompt -` 형태. 안전하지만 실행부가
  또 한 겹 복잡해진다
- **파일** — `$RUN_DIR/prompt.txt` 에 쓰고 `--prompt-file` 로 넘긴다. `RUN_DIR` 은 Codex 의
  쓰기 범위 밖이라 안전하고, 인자 한계도 없다

**⬜ 결정 필요 — 위 셋 중 무엇인가.** 어느 쪽이든 CLI 에 새 옵션이 필요하다.

### stdout 결과 블록을 쓸 것인가

중계기가 내는 `LIVE_CONSULT_RESULT` 에는 `thread_id` · `turn_id` · `steer_delivered` ·
`steer_rejected` · `exit_class` 가 들어 있다. `$RUN_DIR/live_result.txt` 로 받아 두면
보고문에 "실행 중 개입 N건 전달 / M건 거부" 한 줄을 붙일 수 있다.

`thread_id` 는 **여기서 읽지 않는 편이 낫다.** 1769행이 events 에서 뽑는 경로 하나를 유지하면
두 transport 가 같은 코드를 지나가고, 중계기가 `thread.started` 를 제대로 쓰는지도 그 경로가
자동으로 검증한다. 결과 블록에서 읽으면 경로가 갈라지고 1769행은 중계기 경로에서 죽은 코드가 된다.

**⬜ 결정 필요 — 결과 블록을 보고문에 반영할지, 그냥 진단용으로만 남길지.**

### app-server stderr

🔴 app-server 자신의 stderr 를 중계기 stderr 로 흘리면 안 된다. 계정 정보가 섞여 나온다
(Phase 0 에서 779바이트). 중계기가 삼키고 바이트 수만 남긴다.

실행부의 `2>"$ERRLOG"` 는 중계기 자신의 진단만 받게 되고, 그것이 `_stderr.log` 로 보존된다.
기존 stderr 계약과 모양이 같으므로 회귀는 없다.

### codex CLI 플래그 두 줄을 어떻게 할 것인가

1489행과 1513행이 조립된 배열 **뒤에** 플래그를 덧붙인다.

```bash
[ -n "${CR_MODEL:-}" ] && set -- "$@" -m "$CR_MODEL"          # 1489행
[ -n "$WIN_SB" ] && set -- "$@" -c "windows.sandbox=$WIN_SB"  # 1513행
```

이 두 줄은 `KIND` 를 보지 않고 무조건 붙는다. 중계기는 `-m` 도 `-c` 도 모른다.

🔴 **그런데 에러가 나지 않는다. 그게 더 나쁘다.** 중계기의 인자 파서는 `--` 로 시작하는 것만
옵션으로 보고 나머지는 `rest` 로 밀어 넣는다. `-m gpt-...` 는 **조용히 무시된다.**
사용자가 `CR_MODEL` 로 지정한 모델이 안 먹는데 아무도 모르는 상태가 된다.

`-c windows.sandbox=unelevated` 도 마찬가지로 무시되는데, 이쪽은 중계기가 app-server 를 띄울 때
자기가 같은 값을 붙이므로 결과는 같다. 우연히 맞는 것이고 계약은 아니다.

세 방향이 있다.

1. **중계기가 패스스루로 받는다.** `-c` 는 app-server 기동 인자로 그대로 옮긴다. `-m` 은
   app-server 기동의 `-c model=` 로 옮기거나 `turn/start` 파라미터로 넘긴다
2. **두 줄에 `[ -z "${LIVE_STEER_ON:-}" ]` 가드를 걸고, 중계기 전용 옵션으로 따로 넘긴다.**
   `--model "$CR_MODEL"` 같은 형태
3. **최소한 중계기가 `rest` 가 비어 있지 않으면 거부한다.** 위 둘 중 무엇을 택하든
   이건 별도로 필요하다 — 모르는 인자를 조용히 삼키는 것이 fail-open 이기 때문이다

**⬜ 결정 필요 — `CR_MODEL` 을 중계기 경로에서 어떻게 전달할지.** Phase 0 은 모델을 지정하지
않고 돌렸다(`gpt-5.6-sol` 이 기본으로 잡혔다). `turn/start` 가 모델 지정을 받는지 실측한 적이 없다.

### 폴백을 어디서 하는가

구현이 종료 코드로 경계를 그어 놓았다 — 10번대면 `turn/start` 전이라 폴백해도 안전하고,
20번대면 이미 모델이 돌기 시작했으므로 폴백은 **같은 요청의 이중 실행**이다.

문제는 `send.sh` 가 그 신호를 받는 시점이다. 실행이 이미 끝난 뒤라, 그때 폴백하려면 **같은
스크립트 안에서 codex 를 한 번 더 돌려야 한다.** 세 방향이 있다.

1. **실행부에서 재시도** — `RC` 가 10번대면 `set --` 를 exec 로 다시 세우고 실행부를 한 번 더
   탄다. 실행부를 함수로 빼거나 루프로 감싸야 하고, `PIPE_RC` 세팅이 다시 복잡해진다.
   events 파일에 중계기가 쓴 몇 줄이 남아 있을 수 있으므로 비우고 시작해야 한다
2. **프리플라이트** — 실행부 앞에서 app-server 가 뜨는지만 짧게 확인하고, 실패하면 `set --` 를
   exec 로 되돌린다. 인자 조립이 `send.sh` 한 곳에 남고 실행부는 한 번만 돈다.
   대가는 app-server 를 한 번 더 띄우는 비용(Phase 0 기준 기동~`initialize` 314ms)이고,
   프리플라이트가 성공한 뒤 본 실행이 실패하는 경우는 여전히 못 막는다
3. **폴백 없음** — 10번대로 끝나면 실패로 보고하고, 사용자가 `CR_LIVE_STEER` 없이 재실행한다.
   가장 단순하고, 실패 원인이 사용자에게 그대로 보인다

**⬜ 결정 필요 — 위 셋 중 무엇인가.** `turn/start` **후**(20번대) 실패에 자동 폴백을 하지
않는다는 것만은 확정이다. 같은 요청을 조용히 두 번 실행하면 토큰도 두 배고 응답 문서도 어느 쪽
것인지 알 수 없다.

---

## b. `send.sh` 가 계속 소유해야 하는 계약 — 항목별 검토

### 요청서·frontmatter 검증 (1039~1102행)

실행부보다 **앞**이라 중계기 경로와 무관하다. 회귀 없음.

🔴 다만 조건이 하나 있다. Codex 자문의 제안 CLI 는 중계기에 `--request-file` 을 넘기게 되어
있는데, 그러면 요청서를 해석하는 주체가 둘이 된다. `send.sh` 가 검증한 요청서와 중계기가 읽은
요청서가 어긋날 수 있고, 검증을 통과하지 않은 경로로 중계기가 프롬프트를 만들 수도 있다.

현재 구현은 `--request-file` 을 받아 프롬프트를 자체 조립한다. 그러면 요청서를 해석하는 주체가
둘이 되고, 프롬프트 정본도 둘이 된다. a 항목의 "프롬프트 조립이 이중화된다"에서 다뤘고
결정 항목으로 남아 있다.

여기서 추가로 확인할 것 하나 — 중계기의 `--request-file` 존재 검사는 `send.sh` 가 이미 통과시킨
경로에 대한 **중복 검사**다. 해롭지는 않지만, 중계기가 요청서를 읽어 무언가를 판단하기 시작하면
그 순간부터 `send.sh` 의 frontmatter 검증을 우회하는 경로가 생긴다. 읽는 범위를 넓히지 않는 것이
계약이다.

### lock (1146행)

실행부보다 앞이고 `noclobber` 기반이라 그대로 산다. 회귀 없음.

🔴 새로 생기는 문제는 **lock 이 보호하지 않는 자원**이다. ws 포트는 스탬프 단위가 아니라 머신
단위 자원이다. 다른 스탬프의 CONSULT 두 건이 동시에 돌면 lock 은 둘 다 통과시킨다.

구현은 `--port` 를 생략하면 빈 포트를 미리 찾아 명시적으로 지정한다. 실용적으로는 충돌 확률이
낮지만 **경합 자체가 사라진 것은 아니다** — 포트를 찾은 시점과 app-server 가 bind 하는 시점
사이가 열려 있다. 이 창은 아무 lock 도 막지 못한다.

**⬜ 결정 필요 — 포트 경합을 어디까지 방어할지.** 지금처럼 두고 실패 시 재실행에 맡길지,
bind 실패를 재시도로 흡수할지. 재시도를 넣으려면 몇 번·몇 ms 인지가 또 근거 없는 값이 된다.

`--listen ws://127.0.0.1:0` 로 OS 에 맡기는 방식은 **실측한 적이 없다.** 포트 번호를 어디로
알려 주는지도 모른다. 그래서 구현이 그 길을 택하지 않았다.

### heartbeat · status (1564~1572, 1613, 2011~2014행)

heartbeat 자식은 `send.sh` 자신의 PID 생존을 폴링한다(`kill -0 "$PARENT_PID"`). 중계기가
파이프라인 안에서 도는 동안 `send.sh` 는 계속 살아 있으므로 회귀 없음.

`write_status finalizing`(1613) → 후처리 → `write_status "$FINAL_STATE"`(2014) 순서도 그대로다.
확장이 "진짜 끝"으로 보는 신호가 `turn.completed` 가 아니라 이 마지막 status 라는 계약도 유지된다.

### 실행 전후 변경 감지 (1300~1304, 1616~1651행)

`MARKER` mtime + before/after 목록 차집합. 중계기가 만드는 파일이 감시 범위에 들어가는지가 관건이다.

- 권위 runtime 상태를 `RUN_DIR` 에 두면 cwd 밖이라 스캔에 안 걸린다. **여기 둬야 한다.**
- `.log/` 아래에 쓰는 것(`_events.jsonl`, 새로 만들 `_steers.jsonl`, `_appserver.jsonl`)은
  `PRUNED` 에 `docs/codex_rescue/.log` 가 있으므로 스캔 제외다. 안전하다.
- app-server 가 `~/.codex/sessions/...` 에 rollout 을 쓰는 것은 cwd 밖이고 `codex exec` 도
  똑같이 하던 일이다. 회귀 없음.

🔴 **`.log/` 는 Codex 가 쓸 수 있는 비권위 영역이라고 코드 주석이 못박은 곳이다**(1236~1238행).
steer 제어에 필요한 endpoint · nonce · PID 를 거기 두면 그 원칙이 무너진다. 권위값은 `RUN_DIR`,
UI 표시용 사본만 `.log/` 라는 분리를 지켜야 한다.

### EDIT 게이트 (1080행)

`mode: edit` 이면서 `CR_ALLOW_EDIT` 가 없으면 실행 전에 `die` 한다. 실행부보다 앞이라 회귀 없음.

🔴 **분기 조건에 `[ "$MODE" != edit ]` 를 반드시 넣는다.** 넣지 않으면 EDIT 요청이 중계기
경로로 흘러가고, 그 경로의 샌드박스·승인 매핑은 아직 검증된 적이 없다. 게이트를 통과한 EDIT 도
검증되지 않은 transport 로 돌리면 안 된다.

### `response_path` 검증 (1096~1102행)

규약 경로와 완전 일치하는지만 본다. 실행부 앞. 회귀 없음.

### stdout 최종 메시지 폴백 (1737~1755행)

🔴 **여기가 가장 조용히 깨질 지점이다.**

`codex exec -o "$LASTMSG_W"` 가 최종 메시지를 파일로 떨어뜨려 주는 것에 세 경로가 의존한다 —
`[ -s "$LASTMSG" ]` 판정(1737), FOLLOWUP 의 턴 append(1662), REVIEW 저장(1703).

중계기는 `--last-message-file` 로 `-o` 를 대신한다. 같은 경로(`$LASTMSG`)를 주면 위 세 경로가
그대로 산다. 문제는 **"최종 메시지"를 스스로 정의해야 한다**는 것이다. Phase 0 이 이 정의를
확정해 줬다.

- `agentMessage` item 은 중간에도 나온다. `phase: "commentary"` 다
- 최종 답변은 `phase: "final_answer"` 다
- fixture 에서 `commentary` 2건 → `final_answer` 1건 순으로 나왔다

`phase` 로 가리지 않고 "마지막 agentMessage" 로 잡으면 대개는 맞지만, 최종 답변 뒤에
commentary 가 하나 더 붙는 경우 조용히 틀린다. **`phase: "final_answer"` 를 기준으로 한다.**

폴백이 필요한 경우도 정의해야 한다 — `final_answer` 가 하나도 안 온 채 턴이 끝나면 빈 파일을
쓸 것인지, 마지막 `commentary` 라도 쓸 것인지. 빈 파일이면 `AUTHOR=none` 이 되어 실패로 보고된다.

**⬜ 결정 필요 — `final_answer` 부재 시 폴백.** 빈 파일(실패로 보고) / 마지막 commentary 사용 /
전체 agentMessage 이어붙이기 중 무엇인가.

### `thread_id` · `origin` · `turns` 기록 (1758~1809행)

```bash
NEW_THREAD=$(grep -o '"thread_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$EVENTS" 2>/dev/null \
             | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
```

**이벤트 스트림에서 정규식으로 뽑는다.** 중계기가 여기 맞춰 줘야 FOLLOWUP 이 산다.

지켜야 할 계약:

- `{"type":"thread.started","thread_id":"<threadId>"}` 를 **스트림에 낸다.** `execEvents.ts` 도
  같은 형태를 읽는다(292~294행)
- `head -1` 이므로 **그 줄이 파일에서 `thread_id` 문자열이 처음 나오는 줄이어야 한다.**
  다른 이벤트에 `thread_id` 를 섞어 먼저 내보내면 엉뚱한 값이 심긴다
- `threadId` 를 쓴다. Phase 0 에서 `threadId` 와 `sessionId` 가 같은 값이었지만 같다는 보장은
  없고, `codex exec resume` 이 실제로 받아들인 값이 `threadId` 다(Phase 0 9번)

`origin` 은 `hostname`, `turns` 는 `1` 고정이라 중계기와 무관하다. **steer 를 몇 번 하든
`turns` 는 1 이다** — steer 는 같은 턴 안의 입력이지 새 턴이 아니다.

### in-flight 복구 (1159~1187, 1589~1592행)

FOLLOWUP 전용이다. 중계기 경로는 CONSULT 1턴만이므로 마커를 만들지도 읽지도 않는다. 회귀 없음.

🔴 다만 **1턴에도 같은 성격의 취약 구간이 생긴다.** app-server 가 thread 를 만든 뒤 `send.sh` 가
죽으면, Codex 세션에는 대화가 남았는데 응답 문서에는 `thread_id` 가 없다. 기존 `codex exec` 도
똑같은 상황이라 **회귀는 아니지만**, 고아로 남는 프로세스가 codex.exe 하나에서 app-server + 그
자식으로 늘어난다. 아래 SENDSH_ABORT_PATH 항목과 묶어서 봐야 한다.

### FOLLOWUP 종료 판정 (1936~1947, 1975~1999행)

중계기가 `turns: 1` 과 `thread_id` 를 정상적으로 심으면 FOLLOWUP 은 기존 `codex exec resume`
경로를 그대로 탄다. Phase 0 9번이 "app-server 로 만든 스레드를 exec resume 이 이어받는다"를
실측했으므로 성립한다.

🔴 **다만 Phase 0 은 fixture 스레드로 확인한 것이다.** `send.sh` 배관을 통과한 실제 CONSULT
스레드로는 아직 해 본 적이 없다. 이것이 검증 계획의 핵심이다(아래 e-6).

---

## c. 어느 모드에만 적용하는가

### CONSULT 1턴만 (`KIND=doc` && `MODE != edit`)

분기 조건을 이 둘로 못박는다.

### FOLLOWUP 을 제외하는 이유

`codex exec resume` 은 **첫 턴의 샌드박스를 상속하지 않는다**(2026-08-22 실측 — 실제로 쓰기가
뚫렸다). 그래서 `-c sandbox_mode="read-only"` 로 강제하고 있고, 그 오버라이드가 `mode: readonly`
요청의 FOLLOWUP 이 EDIT 게이트를 우회하지 못하게 막는 유일한 장치다(1452~1453행 주석).

app-server 의 `thread/resume` 이 같은 경계를 재현하는지는 확인된 바 없다. **Phase 0 10번이 바로
그 질문이었고 `⬜` 로 남았다** — 대조군에서도 프로브 파일이 안 생겨 "권한이 막았는지 모델이 시도를
안 했는지" 가릴 수 없었다. 여기를 지금 바꾸면 검증되지 않은 권한 경계 위에 게이트를 얹는 것이 된다.

### REVIEW 를 제외하는 이유

두 가지다. `codex exec review` 는 자체 리뷰 포맷과 스코프 플래그(`--uncommitted` / `--base` /
`--commit`)를 갖는 별도 서브커맨드이고, app-server 에 대응 API 가 있는지 확인된 바 없다.

그리고 **리뷰 턴은 애초에 steer 가 안 된다.** `NonSteerableTurnKind = ["review", "compact"]` 다.
transport 를 바꿔도 얻을 것이 하나도 없다.

### EDIT 을 제외하는 이유

`CR_ALLOW_EDIT` 게이트 뒤에서 `workspace-write` 로 실제 코드를 고친다. transport 를 바꾸면
샌드박스·승인 매핑을 처음부터 다시 검증해야 하는데, Phase 0 은 `read-only` 로만 돌았다.
EDIT 검증표의 7항목(대상 외 파일 보호, 커밋 안 한 작업 보존 등)이 전부 재실측 대상이 된다.

### CHAT 을 제외하는 이유

배관 자체가 다르다. 파일 앞쪽(120~836행)에서 갈라져 조기 종료하고, 파이프라인이 아니라 파일
리다이렉션 + 백그라운드 + 폴링 상한 구조다. 실행부를 공유하지 않으므로 이 분기와 만나지 않는다.

### 넓히면 무엇이 위험한가

**검증표가 통째로 무효가 된다.** SKILL.md 1104~1134행의 검증표는 "실측 8회+", "7항목 검증",
"6경로 확인" 같은 누적된 근거로 각 기능을 ✅ 로 올려 놓았다. 그 실측은 전부 `codex exec` 경로에서
얻은 것이다. transport 를 바꾸는 순간 그 항목들은 "다른 배관에서 확인한 결과"가 되어 근거로서의
효력을 잃는다.

CONSULT 1턴만 바꾸면 무효화되는 범위가 CONSULT 행 하나로 국한된다. FOLLOWUP·CHAT·EDIT 행의
실측은 그대로 살아 있다. 이것이 범위를 좁히는 진짜 이유다.

---

## d. Phase 0 제약이 설계에 미치는 영향

### 알림은 턴을 시작한 연결에만 간다

steer 를 보낸 두 번째 연결은 `turn/started` 를 0개 받았다. `item/*` · `turn/completed` ·
`hook/*` · 토큰 사용량 · MCP 기동 상태도 마찬가지다. 예외는 `thread/status/changed` 와
`remoteControl/status/changed` 둘뿐이고, 이건 두 번째 연결에도 왔다.

**귀결 1 — 이벤트 변환은 `run` 연결이 독점한다.** `run` 이 죽으면 그 턴의 진행은 아무도 볼 수 없다.

**귀결 2 — `steer` · `wait` · `status` 는 파일을 읽는다.** 소켓으로 진행 상황을 얻는 설계는
Windows 에서 성립하지 않는다. `wait` 가 감시하는 것은 `run` 이 써 둔 events 파일이다.

**귀결 3 — 별도 연결로도 "지금 active 인가" 는 알 수 있다.** `thread/status/changed` 가 오기
때문이다. 하지만 연결 이후의 전이만 보이므로 권위로 삼으면 안 된다. 권위는 `run` 이 쓴 runtime
상태 파일이다.

### 완료 후 steer 는 거부된다

`{"code":-32600,"message":"no active turn to steer"}`. Phase 0 에서 `turn/completed` 알림과
재전송 사이가 57ms 였다. 이 경합은 **막아 주는 것이 맞고**, 중계기가 성공으로 위장하면 안 된다.

`send.sh` 관점에서 중요한 것 하나 — **steer 실패는 CONSULT 실패가 아니다.** `steer` 는 별도
프로세스이고 `run` 의 종료 코드와 무관하다. 거부돼도 `run` 은 정상적으로 `turn/completed` 를
기다렸다가 0 으로 끝나야 하고, `send.sh` 는 `state: done` 으로 마무리해야 한다.

### `review` · `compact` 턴은 steer 불가

c 항목의 REVIEW 제외 근거다. 그리고 나중에 범위를 넓힐 때도 이 두 종류는 영구히 제외다.

### Windows 에서 ws 가 다중 연결의 유일한 경로

`unix://` 는 안 되고 `stdio://` 로는 두 번째 연결이 성립하지 않는다.

이 사실이 Codex 자문의 IPC 설계를 하나 무효화한다. 자문은 "Windows: named pipe, Linux: Unix
domain socket" 을 제안했는데, **그건 app-server 에 붙는 경로로는 쓸 수 없다.** named pipe 는
`steer` CLI 와 중계기 사이의 자체 제어면에나 쓸 수 있다.

두 가지 아키텍처가 가능했다.

1. **`steer` 가 app-server 에 직접 붙는다.** Phase 0 이 실제로 돌린 모양(conn2)이다.
   구조가 가장 단순하고 실측된 경로다. 대가는 **노출면**이다 — 루프백 ws 리스너가 무인증이라면
   같은 머신의 다른 프로세스가 포트를 찍어 남의 턴에 steer 할 수 있다. `--ws-auth` 설명이
   "non-loopback listeners" 라고 못박으므로 무인증일 것으로 **보이지만** 실측된 바 없다
2. **`steer` 가 파일 큐에 넣고 `run` 이 대신 쏜다.** 큐 직렬화와 seq 보존이 한 곳에 모이고,
   app-server 에 붙는 프로세스가 `run` 하나뿐이라 노출면이 늘지 않는다

**구현은 2번으로 갔다.** `steer` 는 `runtime.enqueueSteer()` 로 큐에 넣고, `run` 이 1초마다
폴링해 자기 연결로 쏜 뒤 결과를 파일에 남긴다. `steer` 는 그 결과를 기다렸다가 보고한다.

그 대가로 값 두 개가 생겼다. 둘 다 근거 없는 잠정치다.

- 큐 폴링 간격 1초 — 짧으면 반응이 빠르고 디스크를 더 긁는다
- 전달 확인 상한 60초 — 이 안에 확인이 안 오면 종료 코드 32(전달 여부 불명)로 끝난다

**⬜ 결정 필요 — 위 두 값.** 그리고 종료 코드 32(불명) 상태에서 **같은 문장을 다시 보낼지**도
정해야 한다. 큐에는 들어갔으므로 재전송하면 같은 정정이 두 번 갈 수 있다.

### Remote-SSH

제어는 항상 **Codex 를 실제로 실행한 호스트**에서 일어나야 한다. 확장은 `extensionKind: ["ui"]`
라서 로컬에서 돌고, 원격 소켓에 닿을 수 없다. 확장은 지금처럼 `workspace.fs` 로 파일만 읽는다.

`origin` 대조가 이미 있으므로(FOLLOWUP 이 쓰는 것과 같은 장치) live runtime 에도 그대로 적용한다.
docs 파일은 여러 머신으로 동기화될 수 있지만 active turn 과 ws 포트는 머신을 건너지 않는다.

---

## e. 검증 계획

### 1. 회귀부터 — `CR_LIVE_STEER` 없이

분기를 넣었는데 기본 경로가 달라지면 그게 최악이다. **중계기를 붙이기 전에** 이것부터 통과해야 한다.

- `CR_DRYRUN=1` 로 조립된 명령줄이 이전과 **한 글자도 다르지 않은지** 대조
- 🔴 `PIPE_RC` 를 채우는 줄이 **세 분기 전부에** 들어갔는지 눈으로 확인.
  하나만 빠져도 조용히 이전 값을 쓴다
- 실패하는 CONSULT 를 일부러 만들어 `codex_exit` 가 0 이 아닌 값으로 실리는지
  (`PIPESTATUS` 복사가 살아 있다는 증거다)
- `tee` 를 일부러 실패시켜 `tee_exit` 경고가 뜨는지
- 실제 CONSULT 1건 → `state: done` · `codex_exit: 0` · 응답 문서 · STRAY 없음
- 그 건으로 FOLLOWUP 1턴 → `turns: 2`
- REVIEW 1건 · CHAT 1턴 — 실행부를 공유하거나 인접한 경로가 안 다쳤는지

### 2. 중계기 단독 — send.sh 없이

먼저 `--dry-run` 으로 조립 결과와 경로를 전부 확인한다. 그다음 실제로 한 번 돌려
**`--events-file` 에 쌓인 내용**이 확장 파서를 그대로 통과하는지 본다. `execEvents.ts` 는
순수 모듈이라 `node -e` 로 직접 먹여 볼 수 있다.

- `thread.started` 가 첫 줄이고 `thread_id` 를 갖는지
- `send.sh` 의 `grep -o '"thread_id"...' | head -1` 이 뽑는 값이 threadId 와 같은지.
  **다른 줄에 `thread_id` 문자열이 먼저 나오면 안 된다**
- `turn.completed` 의 `usage` 키가 **snake_case** 인지 (`input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`)
- item 의 `type` 이 snake_case 인지 (`agent_message`, `command_execution`, …).
  app-server 원문은 camelCase 이므로 변환이 필요하다
- `badLines` · `unknownTypes` 가 0 인지
- `--last-message-file` 에 `final_answer` 하나만 담기는지
- stdout 에 `LIVE_CONSULT_RESULT` 블록만 나오는지 (이벤트가 섞여 나오면 파이프 설계가 어긋난다)
- `-m foo` 처럼 모르는 인자를 붙였을 때 조용히 무시하지 않는지

### 3. 중계기 + send.sh — 짧은 CONSULT 1건

- `codex_exit: 0` · `state: done` · `tee_exit: 0`
- `$EVENTS` 와 `$LIVE_EVENTS` 가 **둘 다 채워졌는지** (하나만 차면 thread_id 또는 진행 패널이 죽는다)
- 응답 문서에 `thread_id` · `origin` · `turns: 1`
- STRAY 없음 (중계기가 cwd 에 아무것도 안 남기는지)
- `.log/` 에 `_appserver.jsonl` · `_steers.jsonl` 이 생겼고 스캔에 안 잡히는지
- 확장 진행 카드가 **실행 중에** 갱신되는지 (끝난 뒤에만 보이면 실시간 미러가 죽은 것이다)

### 4. steer 경로

긴 CONSULT 를 띄우고 `steer` 로 정정한다. 판정은 Phase 0 6번과 같은 방식 — **정정 문장에만 있는
랜덤 토큰**을 심고 최종 답변에 그것이 나오는지 본다. RPC 수락만으로는 판정하지 않는다.

- 같은 `turnId` 로 수락되는지
- 이벤트 스트림에 `userMessage` item 으로 나타나는지
- 최종 답변이 토큰을 포함하는지
- `turns` 가 여전히 1 인지

### 5. 경합

- 완료 직후 steer → 거부 → 문장이 보존되는지
- 거부돼도 `send.sh` 가 `state: done` 으로 끝나는지
- steer 를 3개 연속 → 순서가 보존되는지 (Phase 0 은 1회만 했다)

### 6. 🔴 FOLLOWUP 회귀 — 여기가 관문

3번이 만든 실제 thread_id 로 `--followup` 을 건다. SKILL.md 검증표의 FOLLOWUP 행에 적힌
항목을 그대로 다시 돌린다.

- 1턴 `thread_id` 심기 · `origin` · `turns: 1`
- 기존 `codex exec resume` 으로 **맥락이 이어지는지** (1턴 답변 내용을 재현하는지)
- 2턴 read-only 강제 — scratch 쓰기 프로브가 막히는지
- 반박서를 요청서로 실행 시 거부
- 턴 번호 어긋남 거부
- `thread_id` 없음 거부
- 실패 시 thread_id 폐기
- 응답 문서 append · `turns: 2`
- events.jsonl append 후 확장 카드가 두 턴을 다 그리는지

**여기서 한 항목이라도 달라지면 중단한다.** 넓히지도 배포하지도 않는다.

### 7. 실패 경계

- 포트를 미리 점유해 두고 실행 → `turn/start` 전 실패 → 결정된 폴백 정책대로 도는지
- `turn/start` 후 중계기를 강제 종료 → **이중 실행이 없는지** · app-server 고아가 안 남는지
- app-server 가 승인 요청을 보내는 상황 (오면 안 되는 물건이지만) → 무한 대기하지 않는지

### 8. Linux 서버 1대

로컬 검증이 전부 끝난 뒤에만. `taskkill` 이 없고 ws 리슨 동작이 다를 수 있다.

### 배포 순서

1~7 을 로컬에서 전부 통과 → 8 → 그 뒤에야 `/skill_cp_install push codex_rescue`.
2,016행에 `die` 방어가 119곳 있고 5대에 배포된다. 순서를 건너뛰면 전 머신의 Codex 경로가 함께 멈춘다.

---

## SENDSH_ABORT_PATH 와의 충돌 검토

[`SENDSH_ABORT_PATH.md`](./SENDSH_ABORT_PATH.md) 가 **같은 파일의 같은 구역**을 고치는 계획을
갖고 있어 대조가 필요하다.

### 🔴 겹친다 — 실행부 같은 자리다

ABORT_PATH 5-1 은 실행부(1599~1607행)를 이렇게 바꾼다.

```bash
{ echo "$BASHPID" > "$CODEX_PIDFILE"; exec "$@" "$PROMPT"; } 2>"$ERRLOG" \
  | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
```

이 계획도 같은 자리에 분기를 하나 더 넣는다. **두 변경이 같은 아홉 줄을 고친다.**

합쳐 놓으면 이런 모양이 된다. 중계기 분기에도 PID 포착이 필요하다 — 중단 신호가 왔을 때 죽여야
할 뿌리가 codex 가 아니라 node 로 바뀔 뿐이다.

```bash
if [ -n "${LIVE_STEER_ON:-}" ]; then
  { echo "$BASHPID" > "$CODEX_PIDFILE"; exec "$@"; } 2>"$ERRLOG" > "$RUN_DIR/live_result.txt"
  PIPE_RC=("$?" 0)
elif [ -n "$PROMPT" ]; then
  { echo "$BASHPID" > "$CODEX_PIDFILE"; exec "$@" "$PROMPT"; } 2>"$ERRLOG" \
    | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
  PIPE_RC=("${PIPESTATUS[@]}")
else
  { echo "$BASHPID" > "$CODEX_PIDFILE"; exec "$@"; } 2>"$ERRLOG" \
    | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
  PIPE_RC=("${PIPESTATUS[@]}")
fi
```

🔴 중계기 분기의 `{ ...; exec ...; }` 는 파이프라인이 아니라 **단순 리다이렉션**이므로 서브셸이
생기지 않을 수 있다. 그러면 `exec` 이 `send.sh` 자신을 대체해 버린다. 브레이스 그룹이 아니라
서브셸 `( ... )` 을 써야 하고, 그러면 `$BASHPID` 와 `exec` 의 관계도 다시 확인해야 한다.
**ABORT_PATH 5-1 의 실측(`PIPESTATUS` 보존 확인)은 파이프라인 형태에서만 검증된 것이다.**

**⬜ 결정 필요 — 중계기 분기에서 PID 를 어떻게 잡을지.** 파이프라인이 아닌 형태에서 같은 기법이
성립하는지 별도 실측이 필요하다. 아니면 중계기 경로만 백그라운드 + `wait` 로 돌리는 다른 모양을
택할 수도 있다.

### 겹치는 만큼 서로를 돕기도 한다

ABORT_PATH 의 `cr_kill_tree` 는 `$BASHPID` → `exec` 로 잡은 PID 를 트리 킬의 시작점으로 쓴다.
중계기 경로에서 그 뿌리는 **node 프로세스**다. 중계기는 app-server 의 PID 를 직접 알고 있으므로,
SIGTERM 을 받아 자기가 app-server 를 정리하는 편이 `codex exec` 보다 오히려 깨끗하다.

다만 `taskkill /T /F` 는 강제 종료라 핸들러를 돌리지 않는다. 그러면 app-server 정리는 `/T` 의
재귀에 맡겨진다 — **ABORT_PATH 7-1(c) 에 미검증으로 남아 있는 바로 그 항목이다.**
중계기가 붙으면 프로세스 층이 하나 더 깊어지므로(bash → node 중계기 → app-server → codex 자식)
그 항목의 중요도가 올라간다.

### 적용 순서 권고

**ABORT_PATH 를 먼저 넣는다.** 중단 경로가 없는 상태로 중계기를 붙이면 고아가 codex.exe 하나에서
app-server + 그 자식으로 늘어난다. 지금도 손으로 죽여야 하는데 죽일 대상이 늘어나는 것이다.

**⬜ 결정 필요 — 두 변경을 한 번에 넣을지 나눠 넣을지.** 나눠 넣으면 회귀 원인을 가리기 쉽고,
한 번에 넣으면 검증을 한 번만 돌리면 된다.

---

## f. 결정이 필요한 지점 — 모아 놓은 것

임의로 정하지 않았다. 전부 사용자 판단이 필요하다. 중계기 쪽에 이미 들어간 값도 "동작시키려면
뭐라도 필요해서" 넣은 잠정치이지 결정된 정책이 아니다.

### 실패와 폴백

- **⬜ 폴백 정책** — 실행부에서 재시도 / 프리플라이트 / 폴백 없음.
  (`turn/start` 후 자동 폴백 금지만은 확정)
- **⬜ `codex_exit` 필드** — 중계기 종료 코드를 그대로 실을지, 별도 필드를 둘지.
  같은 필드에 의미가 다른 숫자가 들어간다
- **⬜ `final_answer` 부재 시 최종 메시지 폴백** — 빈 파일(실패로 보고) / 마지막 commentary /
  전체 이어붙이기
- **⬜ 중계기 경로에서 미러 실패를 무엇으로 감지할지** — `TEE_RC` 경고가 이 경로에서는 안 뜬다
- **⬜ 종료 코드 32(전달 불명)에서 재전송할지** — 큐에는 들어갔으므로 같은 정정이 두 번 갈 수 있다

### 실행부와 인자

- **⬜ 프롬프트 정본을 어디에 둘지** — `send.sh` 조립문을 넘길지, 중계기가 계속 `--request-file`
  로 자체 조립할지. 후자면 두 조립문을 동일하게 유지할 책임이 생긴다
- **⬜ 프롬프트 전달 방식** — 위치 인자 / stdin / `RUN_DIR` 파일. 어느 쪽이든 CLI 옵션이 필요하다
- **⬜ `CR_MODEL` 전달 방식** — 패스스루 / 중계기 전용 옵션 / 가드.
  지금은 `-m` 이 **조용히 무시된다**
- **⬜ 모르는 인자를 거부할지** — 위와 별개로 필요하다. 조용히 삼키는 것이 fail-open 이다
- **⬜ stdout 결과 블록을 보고문에 반영할지** — "개입 N건 전달 / M건 거부" 한 줄

### 잠정치 (근거 없이 들어간 숫자들)

- **⬜ steer 큐 폴링 간격** — 지금 1초
- **⬜ steer 전달 확인 상한** — 지금 60초
- **⬜ `wait` 상한** — 지금 30분
- **⬜ 결과 파일 폴링 간격** — 지금 0.5초
- **⬜ ws 포트 경합 방어** — 지금은 빈 포트를 미리 찾을 뿐 bind 까지의 창이 열려 있다.
  재시도를 넣으면 횟수·간격이 또 근거 없는 값이 된다
- **⬜ 루프백 ws 무인증 노출 수용 여부** — 큐 방식이라 `run` 만 붙지만, 포트 자체는 열려 있다.
  무인증인지 자체가 아직 미실측이다

### 고신호와 이벤트

- **⬜ 고신호 목록** — 지금 일곱 가지(`plan` · `command-started` · `file-change` · `blocked` ·
  `finalizing` · `waiting-approval` · `server-request`). 자문의 후보를 전부 넣고 애매하면 깨우는
  쪽으로 기울인 잠정치다. 무엇을 깨울 만한 일로 볼지는 정해진 바 없다
- **⬜ `blocked` 판정 문구 목록** — "자료가 없다 / 확인할 수 없다" 류를 어떻게 잡을지.
  지금은 흔한 표현을 모아 둔 것이지 사용자가 정한 것이 아니다
- **⬜ events 파일명** — 기존 `_events.jsonl` 을 그대로 쓸지, `_events.v2.jsonl` 로 나눌지.
  같은 이름을 쓰면 확장 수정 없이 카드가 그려지지만, 형식이 어긋났을 때 원인을 가리기 어렵다.
  나누면 확장을 함께 고쳐야 한다
- **⬜ item id 합성이 필요한지** — 파서는 이미 턴 경계(`turn.completed` → 다음 활동)에서
  `t<N>:` 접두를 붙여 FOLLOWUP 의 `item_0` 충돌을 막는다. **중계기가 `turn.completed` 를
  제대로 내면 추가 합성이 필요 없다.** 다만 app-server 의 item id 는 `msg_...`·`exec-...`
  처럼 이미 고유해 보이므로, 그대로 흘릴지 `<turnId>:<itemId>` 로 감쌀지는 확인이 필요하다
- **⬜ `item/agentMessage/delta` 처리** — 버릴지, `item.updated` 로 흘릴지.
  Phase 0 59초 실행에서 57개가 나왔다. 흘리면 파일이 커지고 확장이 매번 다시 파싱한다
- **⬜ `_appserver.jsonl` 보관 정책** — 감사에는 유용하지만 Phase 0 기준 59초에 52KB다.
  `.log/` 정리 규칙에 어떻게 얹을지

### 표시

- **⬜ 확장에 `transport` · `steerCount` 를 표시할지** — 표시하면 `status.json` 스키마가 늘고
  확장을 함께 고쳐야 한다. 안 하면 `codex_exit` 숫자의 의미가 경로에 따라 달라지는 것을
  사용자가 알 방법이 없다
- **⬜ 실행 중 개입을 응답 문서에 남길지** — Codex 자문은 `## 실행 중 개입 기록` 섹션을 제안했다.
  기존 `## Claude 검토` · `## 🔁 N턴` 구조와의 순서를 정해야 한다

### 범위와 순서

- **⬜ ABORT_PATH 와 함께 넣을지 나눠 넣을지**
- **⬜ 기본값으로 올릴 시점** — 언제까지 `CR_LIVE_STEER` 플래그 뒤에 둘지.
  개입이 없는 평범한 CONSULT 도 중계기로 돌릴지
- **⬜ 중계기의 배포 위치** — 지금은 이 저장소의 `tools/live-consult/` 에 있다.
  `send.sh` 는 5대에 배포되는 스킬 자산이므로, 붙이려면 스킬 원본
  (`F:\Obsidian\global_dir\skills\codex_rescue\`) 아래로 옮기고 배포 절차를 타야 한다.
  옮길지, 옮긴다면 어느 경로인지, `send.sh` 가 `$LIVE_CONSULT` 를 어떻게 찾을지
