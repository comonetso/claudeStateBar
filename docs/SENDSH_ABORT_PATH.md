# send.sh 에 중단 경로가 없다 — 원인 규명과 수정안

> 2026-08-25 18:46 에 백그라운드로 던진 CONSULT 를 18:58 에 중단시키려 했는데,
> 셸을 죽여도 `codex.exe` 가 계속 돌았고 결국 작업관리자/`Stop-Process` 로 직접 죽여야 했습니다.
> **정상적인 중단 경로가 없습니다.**
>
> 이 문서는 원인을 코드로 확정하고 수정안을 제시합니다.
> 🔴 **`send.sh` 와 `SKILL.md` 는 이번에 고치지 않았습니다.** 문서만 만들었습니다.
>
> 읽은 코드: `~/.claude/skills/codex_rescue/send.sh` (2016행) ·
> `~/.claude/skills/codex_rescue/SKILL.md` (1252행) ·
> `~/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js` (249행) ·
> `~/AppData/Roaming/npm/codex` (npm shim) ·
> 확장 쪽 `src/providers/codexRescue/runDiscovery.ts`

표기 규칙 — **[실측]** 은 이 세션에서 직접 돌려 확인한 것, **[코드]** 는 소스를 읽어 확정한 것,
**[추정]** 은 근거는 있으나 확인하지 못한 것입니다.

---

## 0. 사고 재구성 — 남은 증거가 말하는 것

휴지통에 남은 로그: `docs/codex_rescue/.trash/260825_184426/`

```json
{"stamp":"260825_184426","slug":"multiturn-card-parse","state":"failed",
 "started_at":"2026-08-25T09:46:43Z","finished_at":"2026-08-25T09:58:52Z",
 "codex_exit":127,"tee_exit":0}
```

**[코드] `state` 가 `failed` 이지 `interrupted` 가 아닙니다.**
`send.sh` 에서 `interrupted` 를 쓰는 곳은 신호 trap(1216행) 하나뿐입니다.
즉 **`send.sh` 는 신호를 받지 않았고, 2007~2014행의 정상 종료 경로로 끝났습니다.**

stderr 의 마지막 기록:

```
2026-08-25T09:58:38.883806Z ERROR codex_core::tools::router: error=Exit code: -1073741502
2026-08-25T09:58:45.704704Z ERROR codex_core::tools::router: error=Exit code: -1073741502
```

`-1073741502` = `0xC0000142` = `STATUS_DLL_INIT_FAILED`. 즉 **18:58:45 시점까지 Codex 는 살아서**
자식 프로세스(pwsh)를 계속 띄우려다 실패하고 있었습니다. events.jsonl 의 마지막 항목도
`command_execution` 이 `exit_code: -1073741502` 로 `failed` 입니다.

시간 순서를 맞추면 이렇게 됩니다.

| 시각 | 일어난 일 |
|---|---|
| 18:46:43 | `send.sh` 시작, `state: running` |
| ~18:58 | 사용자가 셸을 죽임 → **아무 일도 일어나지 않음** |
| 18:58:45 | Codex 는 여전히 살아서 자식 프로세스를 띄우는 중 |
| 18:58:4x | 사용자가 `Stop-Process -Id 56220 -Force` 로 codex.exe 직접 종료 |
| 18:58:52 | 파이프라인이 풀리고 `send.sh` 가 후처리(약 7초)를 마치고 종료 |

**결론: codex.exe 를 손으로 죽이기 전까지는 아무것도 끝나지 않았습니다.**
"셸을 죽였다"는 조작은 `send.sh` 에 도달하지 않았거나, 도달했어도 파이프라인을 풀지 못했습니다.

`codex_exit: 127` 의 정체는 **[추정]** 입니다. Windows 의 `ERROR_PROC_NOT_FOUND(127)` 이거나
shim 경유 종료 코드일 수 있으나 확정하지 못했습니다. 원인 규명에 필요하지 않아 더 파지 않았습니다.

---

## 1. 원인 ① — trap 어디에도 codex 를 죽이는 코드가 없다 [코드 확정]

`$!` 를 쓰는 곳은 파일 전체에서 **두 군데뿐**입니다.

```
668행   CH_CPID=$!      ← CHAT 전용
1572행  HB_PID=$!       ← heartbeat 자식
```

`CONSULT` · `REVIEW` · `FOLLOWUP` 이 지나가는 실행부(1599~1607행)에는 codex 의 PID 를 잡는
코드가 **아예 없습니다.**

```bash
# 1599-1603행 — 포그라운드 파이프라인
if [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
else
  "$@" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
fi
PIPE_RC=("${PIPESTATUS[@]}")     # 1605행
```

정리 코드도 heartbeat 만 봅니다.

```bash
# 1206-1212행
cleanup() {
  [ -n "${HB_PID:-}" ] && kill "$HB_PID" 2>/dev/null   # heartbeat 만 죽인다
  rm -rf -- "$RUN_DIR" 2>/dev/null
  rm -f -- "$LOCK" 2>/dev/null
  [ -n "${HEARTBEAT:-}" ] && rm -f -- "$HEARTBEAT" 2>/dev/null
  return 0
}
trap cleanup EXIT
# 1216-1217행
trap '[ -n "${STATUS:-}" ] && write_status interrupted ...
      cleanup; echo "codex_rescue: 중단됨(신호 수신)" >&2; exit 130' HUP INT TERM
```

**시그널이 정상적으로 도착했더라도 codex 는 살아남습니다.** 오히려 더 나쁩니다 —
`send.sh` 만 사라지고 lock 도 heartbeat 도 지워진 상태에서 codex.exe 가 고아로 남아
워크스페이스에 계속 쓸 수 있습니다.

같은 파일 1525~1534행이 이 상황을 이미 알고 있었습니다. `CR_TIMEOUT` 을 거부하면서
대안으로 제시한 것이 **"사용자가 작업관리자에서 codex.exe 를 직접 종료"** 입니다.
즉 중단 경로가 없다는 것은 이미 알려진 사실이었고, 대안이 사람 손이었을 뿐입니다.

---

## 2. 원인 ② — MSYS 의 시그널이 네이티브 프로세스에 닿지 않는다 [실측]

1516~1523행 주석이 2026-08-17 실측으로 이미 기록하고 있습니다. 이번에 **프로세스 구조를 직접 확인해**
왜 그런지까지 확정했습니다.

### 2-1. 프로세스 체인

```
bash (send.sh)
  └─ /usr/bin/sh      ← npm shim: ~/AppData/Roaming/npm/codex, `#!/bin/sh` + `exec node ...`
       └─ node.exe    ← Windows 네이티브
            └─ codex.exe   ← node 가 spawn (codex.js 195-198행, stdio:"inherit")
```

`codex.js` 는 시그널 전달을 **제대로 만들어 두었습니다**:

```js
// 195-198행
const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit", env });
// 213-226행
const forwardSignal = (signal) => { if (child.killed) return; try { child.kill(signal); } catch {} };
["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => { process.on(sig, () => forwardSignal(sig)); });
```

문제는 **그 시그널이 MSYS bash 에서 네이티브 node 에게 도달하지 않는다**는 것입니다.

### 2-2. [실측] MSYS 는 네이티브 exe 를 exec 해도 stub 을 남긴다

shim 과 같은 구조(shebang 스크립트가 네이티브 exe 를 `exec`)를 재현했습니다.

```bash
printf '#!/bin/sh\nexec /c/WINDOWS/system32/ping.exe -n 6 127.0.0.1\n' > cr_probe.sh
./cr_probe.sh > /dev/null 2>&1 &
p=$!    # → 718
```

결과:

```
$!                        = 718
/proc/718/winexename      = C:\Program Files\Git\bin\..\usr\bin\bash.exe
/proc/718/winpid          = 33500

ps 출력:
   721   718   716   55100  /c/WINDOWS/system32/ping     ← 실제 네이티브는 별도 프로세스
   718   716   716   33500  /usr/bin/bash                ← $! 가 가리키는 것은 이 stub
```

**`$!` 가 가리키는 것은 bash stub 이고, 네이티브 프로그램은 그 자식입니다.**
codex 의 경우 그 아래로 node.exe 가 있고, 다시 그 아래에 codex.exe 가 있습니다.

### 2-3. [실측] node 가 spawn 한 손자는 MSYS 프로세스 테이블에 없다

node 가 `child_process.spawn` 으로 네이티브 exe 를 띄우면, 그 자식은 MSYS 를 거치지 않으므로
`ps`(MSYS) 에 나타나지 않습니다. 실측에서 node.exe 는 Windows 쪽 `Get-CimInstance Win32_Process`
로는 보였지만 MSYS `ps` 목록에는 없었습니다.

→ **`kill` 로는 codex.exe 를 조준할 수단이 애초에 없습니다.**
MSYS 의 `kill` 은 자기 프로세스 테이블에 있는 것만 대상으로 하고,
네이티브 프로세스에 대해서는 SIGKILL 을 `TerminateProcess` 로 흉내낼 뿐이라
**핸들러가 돌지 않습니다** — 즉 `codex.js` 의 `forwardSignal` 이 실행될 기회가 없습니다.

---

## 3. 원인 ③ — 파이프가 대기를 연장한다 [코드 + 정황]

`codex.js` 196행이 `stdio: "inherit"` 이므로 **codex.exe 가 파이프의 write end 를 상속합니다.**

```bash
"$@" "$PROMPT" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
```

node 를 죽여도 codex.exe 가 write end 를 쥐고 있으면 `tee` 가 EOF 를 못 받습니다.
파이프라인이 끝나지 않으므로 1605행 `PIPESTATUS` 까지 도달하지 못하고, `send.sh` 는 계속 멈춰 있습니다.

이번 사고의 시각이 이 설명과 일치합니다 — codex.exe 를 죽인 직후(18:58:45)
7초 만에 `send.sh` 가 끝났습니다(18:58:52).

**세 원인의 관계**: ①이 근본이고(죽이는 코드 자체가 없다), ②는 ①을 고칠 때 순진한 방법
(`kill $!`)이 통하지 않는 이유이며, ③은 ②가 실패했을 때 스크립트까지 함께 묶여 버리는 이유입니다.

---

## 4. 🔴 CHAT 경로 판정 — SKILL.md 의 주장은 성립하기 어렵다

### 4-1. 문제의 문장

`SKILL.md` 1249~1250행:

> CHAT 의 상한이 되살아난 것은 `timeout` 명령을 쓰지 않고 백그라운드 + 1초 폴링으로 직접 죽이기
> 때문이다(TERM → 2초 → KILL). **Windows 에서 실제로 프로세스가 사라지는 것을 실측했다.**

이 문장은 `send.sh` 1516~1523행의 실측 기록("MSYS 의 시그널은 Windows 프로세스에 제대로 전달되지
않는다")과 정면으로 충돌합니다.

### 4-2. 코드로 판정한 결과 — **SKILL.md 쪽이 틀렸습니다**

CHAT 의 실행부(667~681행):

```bash
"$@" < "$CH_PROMPT" > "$CH_EV" 2>"$CH_ERR" &
CH_CPID=$!
while kill -0 "$CH_CPID" 2>/dev/null; do
  if [ "$CH_WAITED" -ge "$CH_LIMIT" ]; then
    CH_TIMEDOUT=1
    kill "$CH_CPID" 2>/dev/null      # TERM
    sleep 2
    kill -9 "$CH_CPID" 2>/dev/null   # KILL
    break
  fi
  sleep 1; CH_WAITED=$((CH_WAITED + 1))
done
wait "$CH_CPID" 2>/dev/null
```

666행 주석은 `$!` 를 **"리다이렉션이 붙어도 codex 의 PID 다"** 라고 단언합니다.
2-2 의 실측이 이 단언을 반증합니다 — `$!` 는 **MSYS 최상단 프로세스**이지 codex.exe 가 아닙니다.

세 단계로 나눠 보면 이렇습니다.

| 대상 | `kill` (TERM) | `kill -9` (KILL) |
|---|---|---|
| MSYS stub (= `$CH_CPID`) | 죽는다 | 죽는다 |
| node.exe (그 자식) | 닿지 않는다 (핸들러 없음) | MSYS 테이블에 없어 조준 불가 |
| codex.exe (손자) | 닿지 않는다 | 조준 불가 |

**그렇다면 왜 "사라지는 것을 실측했다"고 적혔는가** — [추정]이지만 설명이 하나 있습니다.
CHAT 은 파이프라인이 아니라 **파일 리다이렉션**(`> "$CH_EV"`)입니다. 그래서 원인 ③(파이프 EOF 대기)이
없고, stub 이 죽으면 `wait` 가 **즉시 풀립니다.** 스크립트가 상한에서 정상적으로 빠져나오는 것은 사실이고,
그것을 "프로세스가 사라졌다"로 읽었을 개연성이 큽니다.

### 4-3. 그래서 실제로 무슨 일이 벌어지는가

- **[코드] CHAT 도 고아 codex.exe 를 남깁니다.** 다만 CONSULT 와 달리 스크립트는 풀려납니다.
- **[추정]** 고아가 `$CH_TMP`(mktemp -d) 안의 `events.jsonl` · `last.md` 에 계속 쓰려 하는데,
  `ch_cleanup`(358행)의 `rm -rf "$CH_TMP"` 는 Windows 에서 열린 파일 때문에 부분 실패할 수 있습니다.
- **[코드]** 고아가 살아 있는 동안 그 Codex 세션은 서버 쪽에서 계속 진행됩니다. 상한 60초로 끊었다고
  믿는 동안에도 토큰은 계속 소모될 수 있습니다.
- **[코드]** 실패 경로(699~753행)가 `CH_RC=124` 로 스레드를 폐기하므로 **문서 무결성은 지켜집니다.**
  깨지는 것은 "프로세스가 정리됐다"는 전제 하나입니다.

### 4-4. 보고

🔴 **`SKILL.md` 1249~1250행의 "Windows 에서 실제로 프로세스가 사라지는 것을 실측했다" 는 문장은
코드 구조상 성립하기 어렵습니다.** 지시대로 이번 범위가 아니므로 **고치지 않았습니다.**
고칠 때 제안하는 문구는 6-6 에 적어 두었습니다.

---

## 5. 수정안

### 5-0. 설계 원칙 세 줄

1. **PID 를 잡되, 밖에 노출하지 않는다.** 노출하면 조작된 PID 로 남의 프로세스를 죽이게 됩니다.
2. **중단해도 후처리를 건너뛰지 않는다.** Codex 가 중단 전에 만진 파일은 그대로 감지·보고돼야 합니다.
   즉 trap 으로 즉시 `exit` 하지 않고, codex 만 죽이고 **정상 흐름으로 되돌립니다.**
3. **Windows 와 Linux 를 갈라 처리한다.** 서버 4대는 stub 문제가 없어 기존 방식이 통합니다.

### 5-1. codex PID 포착 — 포그라운드 파이프라인을 유지한 채로 [실측 검증됨]

`${PIPESTATUS[@]}` 처리를 깨지 않는 방법이 있습니다. 파이프라인의 첫 구성요소를 브레이스 그룹으로
감싸고, `$BASHPID` 를 기록한 뒤 `exec` 으로 그 자리에 codex 를 올립니다.

```diff
@@ 1599-1607행 @@
+CODEX_PIDFILE="$RUN_DIR/codex.pid"
 if [ -n "$PROMPT" ]; then
-  "$@" "$PROMPT" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
+  { echo "$BASHPID" > "$CODEX_PIDFILE"; exec "$@" "$PROMPT"; } 2>"$ERRLOG" \
+    | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
 else
-  "$@" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
+  { echo "$BASHPID" > "$CODEX_PIDFILE"; exec "$@"; } 2>"$ERRLOG" \
+    | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
 fi
 PIPE_RC=("${PIPESTATUS[@]}")
 RC=${PIPE_RC[0]}
 TEE_RC=${PIPE_RC[1]:-0}
+# 🔴 정상 종료했으면 PID 파일을 즉시 지운다. 남겨 두면 cleanup 이 **재사용된 PID** 를 죽인다.
+rm -f -- "$CODEX_PIDFILE" 2>/dev/null
```

**[실측] `PIPESTATUS` 가 보존됩니다.**

```bash
{ echo $BASHPID > /tmp/cr_pid; exec sh -c 'echo hello; exit 42'; } 2>/tmp/cr_err \
  | tee -- /tmp/cr_live > /tmp/cr_ev
# → PIPESTATUS[0]=42   PIPESTATUS[1]=0   포착 PID=871   events=hello   live=hello
```

주의할 점:

- `echo` 의 출력은 **반드시 파일로** 보내야 합니다. 파이프로 새면 이벤트 스트림 첫 줄이 오염됩니다.
- `exec` 은 그 서브셸을 대체하므로 PID 가 유지됩니다.
  **[실측]** 네이티브를 직접 exec 하면 그 PID 가 곧 네이티브가 됩니다
  (`/proc/861/winexename` = `\\?\C:\WINDOWS\system32\ping.exe`).
  shim(shebang 스크립트) 경유일 때는 stub 이 남을 수 있습니다(2-2). **어느 쪽이든 그 PID 는
  체인의 뿌리**이므로 트리 킬의 시작점으로 쓸 수 있습니다.
- `$BASHPID` 는 bash 4 이상이 필요합니다. 로컬은 5.3.9 **[실측]**, 서버 4대는 확인이 필요합니다(7-2).

### 5-2. PID 를 어디에 기록할 것인가

요구가 서로 충돌합니다 — **`.log/` 는 Codex 가 쓸 수 있는 비권위 영역**이고(1236~1238행 주석),
`RUN_DIR` 은 랜덤 경로라 밖에서 찾을 수 없습니다.

**제안: PID 는 `RUN_DIR` 에만 둡니다. 밖으로 내보내지 않습니다.**

근거는 비대칭적인 위험입니다.

| 배치 | 조작됐을 때 최악 |
|---|---|
| `.log/` 에 PID 를 두고 그것으로 kill | **무관한 프로세스가 죽는다** — 되돌릴 수 없음 |
| `.log/` 에 stop 신호만 두고, PID 는 내부 보관 | 이 실행 하나가 중단된다 — DoS 이며 복구 가능 |

즉 **제어면을 뒤집습니다.** 밖에서는 "멈춰라"만 말할 수 있고, "무엇을 죽일지"는 `send.sh` 자신만 압니다.
이는 파일 상단이 못박은 원칙("피감시자가 쓸 수 있는 곳에 감시 기준을 두면 안 된다")과 같은 논리입니다.

> **판단 필요(8-4)**: 사람이 최후 수단으로 손으로 죽일 때 PID 가 있으면 편합니다.
> `.log/<stamp>_status.json` 에 `codex_winpid` 를 **진단 표시용으로만** 싣고
> 자동 kill 에는 절대 쓰지 않는 절충이 가능합니다. 채택 여부는 사용자 결정입니다.

### 5-3. 프로세스 트리를 죽이는 함수

`cleanup()` 정의(1206행) **앞에** 둡니다. cleanup 이 이 함수를 부르기 때문입니다.

```bash
# ── 🔴 codex 프로세스 트리 종료 (2026-08-25 신설) ────────────────
#
# 인자는 **이 스크립트가 직접 포착한 PID 만** 받는다. 외부 파일에서 읽은 PID 로 프로세스를
# 죽이지 않는다 — 조작되면 무관한 프로세스를 죽인다.
#
# Windows: MSYS 의 kill 은 손자(codex.exe)에 닿지 않는다(2026-08-25 실측). node 가 CreateProcess 로
#   띄운 프로세스는 MSYS 프로세스 테이블에 없어서 조준 자체가 불가능하다. 그래서 winpid 로 갈아타
#   `taskkill /T` 에 트리를 맡긴다. 🔴 뿌리가 **살아 있는 동안** 불러야 자식을 찾는다.
# Linux: stub 문제가 없다. TERM 을 주면 codex.js(213-226행)가 손자에게 전달한다.
cr_kill_tree() {
  local p="${1:-}"
  case "$p" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$p" 2>/dev/null || return 0
  if [ "$IS_WIN" = 1 ]; then
    local wp; wp=$(cat "/proc/$p/winpid" 2>/dev/null)
    case "$wp" in
      ''|*[!0-9]*) ;;
      *) MSYS_NO_PATHCONV=1 taskkill /PID "$wp" /T /F >/dev/null 2>&1 ;;
    esac
  fi
  kill -TERM "$p" 2>/dev/null
  sleep 2
  kill -KILL "$p" 2>/dev/null
  return 0
}
```

**[실측] `/proc/<pid>/winpid` 가 존재합니다** — Git Bash 에서 확인했습니다.
`taskkill` 과 `tasklist` 도 `C:\WINDOWS\system32` 에 있습니다.

**[미검증]** `taskkill /T` 가 손자(3대)까지 재귀로 잡는지는 이 환경에서 확인하지 못했습니다.
문서상으로는 "그 프로세스가 시작한 모든 자식 프로세스"를 종료한다고 되어 있습니다.
7-1 의 스텁 검증에서 반드시 확인해야 합니다.

**Job Object 는 검토했으나 제외했습니다.** Windows 에서 트리를 확실히 죽이는 정석이지만
bash 에서 직접 만들 수 없고, 별도 실행 파일이나 PowerShell 래퍼가 필요합니다.
`send.sh` 가 셸 스크립트 한 장으로 5대에 배포되는 구조를 깹니다.
게다가 이번 사고 당시 시스템은 **새 프로세스 생성 자체가 실패**하는 상태였습니다
(`0xC0000142` 반복). 그런 상황에서는 pwsh 를 띄우는 방식이 함께 실패합니다 —
`taskkill.exe` 가 더 가볍습니다.

### 5-4. 중단 제어면 — `.log/<stamp>.stop` 파일

heartbeat 루프가 이미 부모 생존을 폴링하고 있으므로(1571행), 거기에 stop 감시를 얹습니다.
새 프로세스를 만들지 않습니다.

```diff
@@ 1564-1572행 @@
 PARENT_PID=$$
+# 중단 신호. 외부(사용자·확장·Claude)가 이 파일을 만들면 codex 를 죽인다.
+# 🔴 `.log/` 는 비권위 영역이지만, 여기에는 **"멈춰라"라는 사실만** 있고 PID 는 없다.
+#    조작의 최악은 이 실행 하나가 중단되는 것이고, 그건 되돌릴 수 있다(5-2).
+STOPFILE="$LOGD/${STAMP}.stop"
+STOPPED_FLAG="$RUN_DIR/stopped"
+rm -f -- "$STOPFILE" 2>/dev/null   # 🔴 지난 실행이 남긴 신호로 즉사하지 않게
 : > "$HEARTBEAT" 2>/dev/null
 write_status running
-( while kill -0 "$PARENT_PID" 2>/dev/null; do : > "$HEARTBEAT" 2>/dev/null; sleep 5; done ) &
+# 🔴 죽인 뒤에도 heartbeat 를 계속 뛰게 한다. 여기서 멈추면 남은 후처리(스캔 2회 + 해시 + 복사)가
+#    확장의 stale 판정(30초)에 걸려 "응답 없음"으로 오표시된다.
+( killed=0
+  while kill -0 "$PARENT_PID" 2>/dev/null; do
+    : > "$HEARTBEAT" 2>/dev/null
+    if [ "$killed" = 0 ] && [ -e "$STOPFILE" ]; then
+      killed=1
+      : > "$STOPPED_FLAG" 2>/dev/null
+      cr_kill_tree "$(cat "$CODEX_PIDFILE" 2>/dev/null)"
+    fi
+    sleep 5
+  done ) &
 HB_PID=$!
```

여기서 codex 가 죽으면 파이프가 닫히고 → `tee` 가 EOF 를 받고 → 1605행으로 흘러가
**변경 감지·응답 회수·로그 보존이 전부 정상 수행됩니다.** 원칙 2 를 만족합니다.

`CODEX_PIDFILE` 은 1599행 앞에서 정의되므로, heartbeat 가 먼저 뜨는 이 순서에서는
아직 없을 수 있습니다. `cat` 이 빈 문자열을 주고 `cr_kill_tree` 가 조용히 무시하므로 안전합니다.
다음 폴링에서 다시 시도하게 하려면 `killed=1` 을 **kill 성공 시에만** 세우는 편이 낫습니다.

### 5-5. cleanup 보강 — 스크립트가 죽을 때 codex 를 데려간다

```diff
 cleanup() {
   [ -n "${HB_PID:-}" ] && kill "$HB_PID" 2>/dev/null
+  # 🔴 codex 를 먼저 데려간다. 안 그러면 send.sh 만 사라지고 codex.exe 가 고아로 남아
+  #    lock·heartbeat 가 지워진 상태에서 워크스페이스에 계속 쓴다.
+  #    정상 종료 경로는 1607행에서 PID 파일을 이미 지웠으므로 여기 걸리지 않는다.
+  if [ -n "${CODEX_PIDFILE:-}" ] && [ -f "$CODEX_PIDFILE" ]; then
+    cr_kill_tree "$(cat "$CODEX_PIDFILE" 2>/dev/null)"
+  fi
   rm -rf -- "$RUN_DIR" 2>/dev/null
   rm -f -- "$LOCK" 2>/dev/null
   [ -n "${HEARTBEAT:-}" ] && rm -f -- "$HEARTBEAT" 2>/dev/null
+  [ -n "${STOPFILE:-}" ] && rm -f -- "$STOPFILE" 2>/dev/null
   return 0
 }
```

**🔴 `STOPFILE` 정리는 선택이 아니라 필수입니다.** CONSULT 의 스탬프는 요청서 frontmatter 에
고정되어 있어(1037행) 같은 요청서를 재실행하면 파일명이 같습니다. 안 지우면 **재실행이 시작하자마자
중단됩니다.** 5-4 의 시작 시점 `rm -f` 와 함께 양쪽에서 지웁니다.

**🔴 PID 재사용 위험**: MSYS PID 는 짧은 주기로 재사용됩니다(실측 중 500~900번대 순환).
정상 종료 경로에서 PID 파일을 즉시 지우면(5-1) 창이 크게 좁아지지만 **원리적으로 없어지지는 않습니다.**
`exec` 이후에는 winpid 가 바뀌므로 사전 기록값으로 대조할 수도 없습니다. 8-6 의 판단 사항입니다.

### 5-6. 중단을 "실패"가 아니라 "중단"으로 표시한다

```diff
@@ 2007-2010행 @@
 FINAL_STATE=done
 [ "$RC" != 0 ]     && FINAL_STATE=failed
 [ "$TEE_RC" != 0 ] && FINAL_STATE=failed
 case "$AUTHOR" in none|stale) FINAL_STATE=failed ;; esac
+# 🔴 사용자가 중단시킨 것은 실패가 아니다. 위 판정들을 **마지막에 덮는다** —
+#    중단이면 RC != 0 이고 AUTHOR=none 이라 위 세 줄에 반드시 걸리기 때문이다.
+[ -e "${STOPPED_FLAG:-/nonexistent}" ] && FINAL_STATE=interrupted
```

확장은 이 값을 이미 이해합니다 — `runDiscovery.ts:250` 이
`state === 'interrupted'` → `phase: 'stopped'` 로 매핑하고,
`i18n.ts:575` 에 `'cx.phase.stopped': '중단됨'` 이 있습니다. **확장 수정 없이 바로 그려집니다.**

### 5-7. CHAT 도 같은 함수를 쓴다

```diff
@@ 671-676행 @@
     if [ "$CH_WAITED" -ge "$CH_LIMIT" ]; then
       CH_TIMEDOUT=1
-      kill "$CH_CPID" 2>/dev/null
-      sleep 2
-      kill -9 "$CH_CPID" 2>/dev/null
+      cr_kill_tree "$CH_CPID"
       break
     fi
```

CHAT 은 파이프라인이 아니므로 `$!` 가 곧 체인의 뿌리입니다. 그대로 넘길 수 있습니다.
`ch_cleanup`(358행)에도 같은 호출을 넣어야 신호로 죽을 때 고아가 남지 않습니다.

🔴 다만 `cr_kill_tree` 는 현재 CHAT 블록(120~836행)보다 **뒤에** 정의될 위치입니다.
CHAT 이 스크립트 맨 앞에서 갈라져 조기 종료하는 구조이므로, 함수 정의를 `winp`/`IS_WIN`
과 같은 자리(파일 상단 49~64행 부근)로 올려야 합니다.

### 5-8. 사용자에게 중단 방법을 알린다

지금은 어디에도 안내가 없습니다. 두 곳을 고칩니다.

```diff
@@ 1549-1553행 (시작 로그) @@
 if [ "$KIND" = review ]; then
   echo "→ Codex 리뷰 중… (대상: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL})" >&2
 else
   echo "→ Codex 실행 중… (요청서: $REQ / 샌드박스: $SANDBOX)" >&2
 fi
+echo "   중단하려면: touch '$LOGD/${STAMP}.stop'   (최대 5초 안에 codex 를 종료한다)" >&2
```

```diff
@@ 1525-1534행 (CR_TIMEOUT 거부 메시지) @@
-   · 정말 멈춰야 하면 사용자가 codex 프로세스를 직접 종료한다
-     Windows: 작업관리자에서 codex.exe   ·   Linux: pkill -f 'codex exec'
+   · 정말 멈춰야 하면 중단 신호 파일을 만들어라 (전 플랫폼 공통)
+       touch docs/codex_rescue/.log/<스탬프>.stop
+     최대 5초 안에 codex 프로세스 트리를 종료하고, 변경 감지와 로그 보존은 정상 수행한다.
```

### 5-9. 확장 쪽(선택 · 별도 트랙)

진행 패널에 "중지" 버튼을 붙이면 `.log/<stamp>.stop` 을 만드는 것으로 끝납니다.
기존 메시지 처리(`codexRescuePanel.ts:163-180`)에 `stop` 케이스를 하나 더 다는 형태이고,
`delete`/`restore` 와 완전히 같은 모양입니다. **이번 범위 밖이라 설계만 적어 둡니다.**

---

## 6. 기존 안전장치를 깨지 않는지 검토

| 안전장치 | 영향 | 판정 |
|---|---|---|
| **lock 해제** (1146·1209행) | stop 은 메인 스크립트를 죽이지 않는다. cleanup 이 그대로 해제한다 | 영향 없음 |
| **heartbeat 정리** (1571·2013행) | 감시자가 kill 후에도 계속 뛰어야 한다. `break` 하면 후처리 중 stale(30초) 오표시 | 5-4 에 반영 |
| **`write_status interrupted` 순서** (1216행) | 기존 trap 순서(write_status → cleanup → exit 130) 유지. stop 경로는 trap 을 타지 않고 2014행에서 같은 값을 쓴다 | 두 경로가 같은 값 → 표시 일관 |
| **변경 감지** (1616~1651행) | stop 으로 죽여도 그대로 수행된다. **중단 전 Codex 가 만진 파일이 보고된다** | 오히려 개선 |
| **fail-closed 원칙** (43~44행) | kill 실패를 조용히 넘기면 안 된다. `cr_kill_tree` 결과를 보고에 한 줄 남길 것 | 6-5 참조 |
| **in-flight 마커** (followup, 1165행) | 중단 시 `RC != 0` → 1684~1698행 실패 분기 → 스레드 폐기 + 마커 제거 | 동작함. 단 정책 판단 필요(8-3) |
| **EDIT 게이트** (1080행) | 무관 | 영향 없음 |
| **stale 재사용 방어** (1731~1736행) | 중단 시 `AUTHOR=stale` 이 될 수 있다(응답 파일이 실행 전과 동일). 5-6 이 마지막에 `interrupted` 로 덮으므로 표시는 맞다 | 순서 주의 |

### 6-5. fail-closed 를 지키려면

`cr_kill_tree` 가 실패해도 스크립트는 계속 멈춰 있게 됩니다(파이프가 안 풀림).
사용자는 "stop 을 눌렀는데 안 멈춘다"만 보게 되므로, **kill 시도 결과를 남겨야 합니다.**

```bash
# cr_kill_tree 안, taskkill 직후
*) if MSYS_NO_PATHCONV=1 taskkill /PID "$wp" /T /F >/dev/null 2>&1; then
     printf 'killed winpid=%s at %s\n' "$wp" "$(date '+%H:%M:%S')" >> "$LOGD/${STAMP}_stop.log"
   else
     printf 'FAILED winpid=%s at %s\n' "$wp" "$(date '+%H:%M:%S')" >> "$LOGD/${STAMP}_stop.log"
   fi ;;
```

이 로그 파일 이름은 `.log/` 정리 규칙(1116행의 `.gitignore`)에 자동으로 포함됩니다.

---

## 7. 검증 방법

### 7-1. 🔴 실제 codex 를 부르지 않고 검증한다

가짜 codex 를 PATH 앞에 두어 **체인 구조만 동일하게** 재현합니다.
실제 Codex 를 돌리면 토큰이 소모되고 다른 세션과 충돌합니다.

```bash
mkdir -p /tmp/fakebin
cat > /tmp/fakebin/codex <<'EOF'
#!/bin/sh
# 실제 shim 과 같은 구조: shebang 스크립트 → exec node → node 가 손자 spawn
exec node -e '
  const {spawn}=require("child_process");
  const c=spawn(process.platform==="win32"?"C:\\WINDOWS\\system32\\ping.exe":"sleep",
                process.platform==="win32"?["-n","300","127.0.0.1"]:["300"],
                {stdio:"inherit"});
  setInterval(()=>console.log(JSON.stringify({type:"item.started",t:Date.now()})),1000);
'
EOF
chmod +x /tmp/fakebin/codex
PATH=/tmp/fakebin:$PATH  bash send.sh <요청서>   # 별도 셸에서
```

확인 항목:

| # | 확인할 것 | 방법 |
|---|---|---|
| a | `PIPESTATUS` 보존 | **완료** — 5-1 실측(42) |
| b | PID 파일이 체인 뿌리를 가리키는가 | `ps` 와 `cat $RUN_DIR/codex.pid` 대조 |
| c | **`taskkill /T` 가 손자까지 잡는가** | `touch .log/<stamp>.stop` → `tasklist /FI "IMAGENAME eq ping.exe"` 가 비는지 |
| d | 몇 초 만에 반응하는가 | stop 생성 시각과 status `finished_at` 차이 |
| e | 후처리가 정상 수행되는가 | 변경 감지 출력·`_events.jsonl`·`_stderr.log` 존재 |
| f | `state` 가 `interrupted` 인가 | `status.json` |
| g | 확장이 "중단됨"으로 그리는가 | 진행 패널 육안 |
| h | 잔여물이 없는가 | `.log/*.lock` · `*_heartbeat` · `*.stop` · `$RUN_DIR` 전부 삭제됐는지 |
| i | **정상 경로 회귀** | 가짜 codex 를 빨리 끝나게 바꿔 `state: done` 확인 |
| j | 재실행이 즉사하지 않는가 | 같은 요청서를 두 번 연속 실행 |

### 7-2. Linux 서버 검증

`/proc/<pid>/winpid` 도 `taskkill` 도 없으므로 `IS_WIN` 분기로 갈립니다.
서버 1대에서 최소한 이것만은 확인해야 합니다.

- `bash --version` 이 4 이상인가 (`$BASHPID` 필요)
- `cr_kill_tree` 의 TERM 이 `codex.js` 를 거쳐 손자까지 닿는가
- 정상 경로가 그대로 도는가 (`state: done`)

### 7-3. 배포 순서

1. 로컬에서 7-1 a~j 전부 통과
2. 실제 CONSULT 1건을 정상 완료시켜 회귀 없음 확인
3. 실제 CONSULT 1건을 stop 으로 중단시켜 실측
4. 서버 1대에 먼저 올려 7-2 확인
5. 그 뒤에야 `/skill_cp_install push codex_rescue`

🔴 **`send.sh` 는 2016행에 119곳의 `die` 방어가 있고 5대에 배포됩니다.**
2~4 를 건너뛰고 배포하면 전 머신의 Codex 경로가 함께 멈춥니다.

---

## 8. 판단이 필요한 지점 — 임의로 정하지 않았습니다

| # | 항목 | 선택지 |
|---|---|---|
| 8-1 | heartbeat 폴링 주기 | 현행 5초 유지(중단 반응 최대 5초) vs 1초로 단축(파일 touch 5배) |
| 8-2 | 중단 시 상태값 | `interrupted`(확장이 "중단됨") vs `failed` 유지 |
| 8-3 | 중단 시 followup 스레드 | 현행대로 폐기 vs 의도적 중단은 살려서 이어가기 허용 |
| 8-4 | PID 진단 노출 | `status.json` 에 `codex_winpid` 표시(자동 kill 엔 불사용) vs 전혀 노출 안 함 |
| 8-5 | stop 파일 위치·이름 | `.log/<stamp>.stop` vs 다른 형태 |
| 8-6 | PID 재사용 방어 수준 | 현 수준(정상 경로 즉시 삭제)으로 수용 vs 추가 대조 로직 |
| 8-7 | TERM 후 유예 | CHAT 이 쓰는 2초를 그대로 vs 다른 값 (**현행 2초의 근거는 코드·문서 어디에도 없습니다**) |
| 8-8 | CHAT 도 같이 고칠지 | 5-7 을 함께 적용 vs CONSULT 계열만 먼저 |
| 8-9 | 확장 중지 버튼 | 이번에 함께 vs 별도 트랙 |

---

## 9. 이번에 확인하지 못한 것

- **`taskkill /T` 의 재귀 깊이** — 손자(3대)까지 잡는지 실측하지 않았습니다. 7-1(c) 가 이것을 봅니다.
- **`codex_exit: 127` 의 정체** — 원인 규명에 필요하지 않아 확정하지 않았습니다.
- **고아 codex 가 `$CH_TMP` 삭제를 막는지** — CHAT 의 `rm -rf` 부분 실패 여부는 [추정]입니다.
- **서버 4대의 bash 버전** — `$BASHPID` 가용성을 확인하지 않았습니다.
- **`exec` 도입이 stdin 상속에 미치는 영향** — CONSULT 계열은 프롬프트를 인자로 넘기므로(1600행)
  stdin 을 쓰지 않아 문제가 없을 것으로 봅니다만 **[추정]** 입니다.
  (참고: CHAT 은 32,767 wide char 제한 때문에 stdin 방식으로 이미 옮겼습니다 — 560~564행.
  CONSULT 는 아직 인자 방식이고, 이건 별개 사안입니다.)
