---
type: codex_request
mode: readonly
stamp: 260819_140840
slug: codex-progress-visibility
response_path: docs/codex_rescue/260819_140840_response_codex-progress-visibility.md
---

# Codex 요청 — codex exec 진행 상황을 VS Code 패널에 실시간 표시하기

## 이 요청의 성격
나(Claude)가 이 문제에서 막혔다. 너에게 **다른 시선의 분석**을 받고 싶다.
**코드는 절대 수정하지 마라.** 네가 쓸 파일은 아래 지정한 응답 문서 하나뿐이다.

## 답변을 남길 곳  ← 먼저 읽어라
분석이 끝나면 아래 경로에 **그 이름 그대로** 파일을 만들어 저장해라.

    docs/codex_rescue/260819_140840_response_codex-progress-visibility.md

- 경로·파일명을 바꾸지 마라. 스탬프와 슬러그는 이 요청서와 짝을 이룬다.
- 파일 첫머리에 아래 frontmatter를 그대로 넣어라:

      ---
      type: codex_response
      mode: readonly
      stamp: 260819_140840
      slug: codex-progress-visibility
      author: codex
      ---

- **쓰기가 막히면 거기서 멈추지 말고, 같은 내용을 최종 메시지로 그대로 출력해라.** 자동으로 회수해 저장한다. 저장 실패를 이유로 분석을 생략하지 마라.
- **이 파일 외에는 아무것도 만들거나 수정하거나 삭제하지 마라.** 임시 파일·메모·테스트 파일도 금지다.
  (변경 여부는 파일시스템으로 실측 검증되며, 응답 파일 외의 변경은 전부 보고된다.)

## 환경

- **OS**: Windows 11 Pro (10.0.26200), 셸은 Git Bash (MSYS)
- **codex CLI**: `codex-cli 0.145.0` (`C:\Users\bluec\AppData\Roaming\npm\codex`)
- **대상 프로젝트**: VS Code 확장 `claude-state-bar` (TypeScript, `npm run compile` → `out/`)
  - 이 확장은 Claude Code / Codex 세션 로그를 디스크에서 읽어 상태바와 웹뷰 패널에 표시한다.
  - 네트워크 호출 없음, SDK 없음 — 순수 디스크 읽기다.
- **워크스페이스 루트**: 이 요청서가 있는 프로젝트 루트 (`docs/codex_rescue/`의 상위)
- ⚠️ **`send.sh`는 워크스페이스 밖에 있다** (`~/.claude/skills/codex_rescue/send.sh`).
  네가 못 읽을 수 있으므로 아래에 핵심 부분을 그대로 인용했다.

## 문제

`codex_rescue` 스킬(지금 너를 부른 그 스킬이다)을 발동하면, **Codex가 도는 동안 무슨 일이 일어나는지
전혀 보이지 않는다.** 사용자 표현으로 "깜깜이"다. 몇 분씩 걸리는데 진행률도, 지금 무슨 파일을 읽는지도,
멈춘 건지 도는 건지도 알 수 없다. 끝나야만 결과가 나온다.

이 확장에는 이미 **Claude 워크플로우 패널**이 있다. 서브에이전트별로 running/done/stopped 점,
경과 시간, 요약을 실시간으로 보여준다. **같은 것을 Codex 실행에 대해서도 만들고 싶다.**

## 현재 코드

### (1) `send.sh` — codex 호출부 (워크스페이스 밖 파일이라 인용한다)

```bash
# 실행 산출물은 Codex 의 쓰기 영역 **밖**에 만든다
# 🔴 marker·baseline 은 감시 **기준**이다. 그걸 감시 대상(workspace) 안에 두면 피감시자가
#    지울 수 있고, 하필 그 디렉토리는 스캔에서 prune 되므로 훼손이 보고되지도 않는다.
#    → workspace 밖 임시 run 디렉토리에 둔다.
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-rescue-${STAMP}.XXXXXX") \
  || { rm -f -- "$LOCK"; die "run 디렉토리 생성 실패"; }

cleanup() { rm -rf -- "$RUN_DIR" 2>/dev/null; rm -f -- "$LOCK" 2>/dev/null; }
trap cleanup EXIT
trap 'cleanup; echo "codex_rescue: 중단됨(신호 수신)" >&2; exit 130' HUP INT TERM

EVENTS="$RUN_DIR/events.jsonl"
ERRLOG="$RUN_DIR/stderr.log"
LASTMSG="$RUN_DIR/last_message.md"
MARKER="$RUN_DIR/marker"

# ...

# 명령 조립 (CONSULT 경로)
set -- codex exec --skip-git-repo-check --json -s "$SANDBOX" -C "$ROOT_W" -o "$LASTMSG_W"
[ -n "${CR_MODEL:-}" ] && set -- "$@" -m "$CR_MODEL"
if [ "$IS_WIN" = 1 ]; then
  WIN_SB="${CR_WIN_SANDBOX-unelevated}"
  [ -n "$WIN_SB" ] && set -- "$@" -c "windows.sandbox=$WIN_SB"
fi

# ★ 실제 실행 — 여기서 이벤트가 실시간으로 쌓인다
if [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" > "$EVENTS" 2>"$ERRLOG"
else
  "$@" > "$EVENTS" 2>"$ERRLOG"
fi
RC=$?

# ... 변경 감지 ...

# ★ 실행이 **끝난 뒤에야** workspace 로 복사된다
LOGD="docs/codex_rescue/.log"
cp -f -- "$EVENTS" "$LOGD/${STAMP}_events.jsonl" 2>/dev/null || LOGCOPY_FAIL="..."
cp -f -- "$ERRLOG" "$LOGD/${STAMP}_stderr.log"   2>/dev/null || LOGCOPY_FAIL="..."
```

동시 실행 차단용 lock (실행 중 신호로 쓸 수 있을지 검토 중):

```bash
LOCK="$LOGD/.${STAMP}.lock"
if ! (set -o noclobber; : > "$LOCK") 2>/dev/null; then
  die "같은 스탬프($STAMP)가 이미 실행 중이다 — ..."
fi
```

변경 감지의 prune 목록 (`docs/codex_rescue/.log` 가 이미 제외 대상이다):

```bash
PRUNED=".git node_modules .venv .dart_tool .gradle build .next __pycache__ docs/codex_rescue/.log"
SCAN() {
  find . \( -type d \( -name .git -o -name node_modules -o ... \
            -o -path ./docs/codex_rescue/.log \) -prune \) -o -type f -print
}
```

### (2) 확장의 기존 워크플로우 패널 데이터 모델 (`src/workflowPanel.ts`)

이 모양에 Codex 진행 상황을 태우는 것을 검토 중이다.

```typescript
// A workflow agent's live state, mirrored from journal.jsonl (started/result records).
export interface WorkflowAgentView {
    agentId: string;
    status: 'running' | 'done' | 'stopped';  // stopped = killed/interrupted
    summary: string;        // 160-char preview
    fullSummary?: string;   // untruncated full text
    durationMs: number;
    name?: string;          // display label
    fullName?: string;
}

export interface WorkflowView {
    wfId: string;
    name: string;
    description: string;
    phases: string[];
    agents: WorkflowAgentView[];
    startedAt?: number;  // epoch ms
    endedAt?: number;    // epoch ms
}
```

패널은 폴링으로 데이터를 다시 읽고, 내용 시그니처가 바뀐 경우에만 웹뷰에 push 한다
(안 바뀌면 재렌더 안 함 → 사용자가 펼쳐 둔 카드가 접히지 않는다).

### (3) 이미 있는 JSONL 증분 리더 (`src/providers/codex/tailReader.ts`)

Codex rollout 파일을 tail 방식으로 증분 파싱하는 코드가 이미 있다.
`readSession(file) → CodexAccumulator`, 내부에 `feedHead`/`feedTail`/`readRange`/`splitLines`.
커지는 JSONL 을 매번 통째로 안 읽고 증가분만 읽는다. 이걸 재사용할 생각이다.

## 내(Claude)가 세운 가설과 근거     ← 반드시 포함

**가설 A — 깜깜이의 원인은 이벤트가 확장이 볼 수 없는 곳에 있기 때문이다.**

근거: `codex exec --json` 은 이미 이벤트를 실시간으로 뱉고 있다. 그런데 그 출력이
`mktemp -d` 로 만든 `/tmp/codex-rescue-<스탬프>.XXXXXX/events.jsonl` 로 들어간다.
세 겹으로 막혀 있다 — ① workspace 밖 ② 랜덤 접미사라 경로 예측 불가 ③ 종료 시 `rm -rf`.
그리고 workspace 의 `.log/` 로는 **codex 가 완전히 끝난 뒤에** 복사된다.
즉 "볼 수 있게 되는 순간"이 곧 "이미 끝난 순간"이다.

**가설 B — RUN_DIR 자체를 workspace 로 옮기면 안 된다.**

근거: 주석에 명시된 두 가지 이유가 타당해 보인다. ① marker·baseline 은 감시 *기준*인데
감시 대상 안에 두면 피감시자(Codex)가 지울 수 있고, 그 경로는 prune 되므로 훼손조차 안 잡힌다.
② `last_message` 를 고정 이름으로 workspace 에 두면 이전 실행의 답변을 이번 응답으로 회수하는
stale 버그가 재현된다.

**가설 C — 그래서 이벤트 스트림만 실시간 복제하면 된다.**

이벤트 로그는 감시 *기준*이 아니라 *산출물*이고, `docs/codex_rescue/.log` 는 이미 prune 대상이라
변경 감지에 걸리지 않는다. 그래서 이렇게 바꾸려 한다:

```bash
"$@" "$PROMPT" 2>"$ERRLOG" | tee "$LOGD/${STAMP}_events.jsonl" > "$EVENTS"
RC=${PIPESTATUS[0]}    # tee 가 아니라 codex 의 종료코드를 잡아야 한다
```

그리고 확장이 `docs/codex_rescue/.log/*_events.jsonl` 을 tail 로 읽어 패널에 그린다.
"실행 중" 판정은 lock 파일(`.log/.<스탬프>.lock`) 존재 여부로 한다.

**이 가설들 자체가 틀렸을 수 있다. 먼저 이걸 의심해줘.**

## 조사했고 배제하거나 실패한 것     ← 반드시 포함

정직하게 밝힌다. 아직 코드를 고쳐서 시도한 것은 없다. 조사 단계에서 배제한 것들이다.

1) **`.log/` 의 기존 이벤트 샘플을 찾아 포맷을 파악하려 했다 → 실패.**
   이 프로젝트와 다른 프로젝트(calltaxi, 3건) 어디에도 `.log/` 디렉토리가 없다.
   `.log/` 저장 기능은 2026-08-17 개정에서 들어갔고 **그 이후 한 번도 실행된 적이 없다.**
   → 그래서 나는 `codex exec --json` 의 실제 이벤트 스키마를 **본 적이 없다.** 이게 가장 큰 공백이다.

2) **Codex rollout 파일(`~/.codex/sessions/...`)로 진행을 감지하는 경로 → 보류.**
   이 확장에는 이미 rollout 파서가 있다. 그런데 별도 세션에서 **"실행 중인 Codex 세션이
   rollout 에도 SQLite 에도 없었다"** 는 미해결 건이 있다. `codex exec` 비대화형이
   rollout 을 안 남기는 것이 원인일 수 있다고 의심하지만 **확인하지 못했다.**

3) **RUN_DIR 을 workspace 로 이전 → 배제.** 위 가설 B 의 이유로 안전 설계를 깬다.

## 요청 — 다른 시선을 원한다

1. **위 가설 A·B·C 를 먼저 반박해봐.** 내가 놓친 전제나 잘못 읽은 지점이 있나?

2. ★ **가장 중요 — `codex exec --json` 이 실제로 내보내는 이벤트 스키마를 알려줘.**
   너는 codex CLI 자신이므로 이걸 가장 잘 안다. 구체적으로:
   - 한 줄(JSONL)의 실제 구조는? 최상위 필드 이름과 타입, 이벤트 종류(type/kind) 목록
   - **진행 표시에 쓸 수 있는 것**: 도구 호출 시작/종료, 읽은 파일 경로, 실행한 명령,
     추론(reasoning) 델타, 토큰 사용량, 단계·턴 구분, 타임스탬프가 이벤트에 들어 있나?
   - 전체 진행률(예: 3/7 단계)을 계산할 근거가 이벤트에 있나, 아니면 원리적으로 불가능한가?
   - 버전 0.145.0 기준으로 답해줘. 스키마가 버전에 따라 바뀌면 그 점도 밝혀줘.
   - ⚠️ **확실치 않으면 지어내지 말고 "모른다"고 해라.** 이건 파서를 짜는 근거가 되므로
     틀린 스키마는 아무 정보도 없는 것보다 나쁘다.

3. `codex exec --json` 의 **stdout 버퍼링** 은 어떤가? 파이프(`| tee`)로 리다이렉트하면
   블록 버퍼링이 걸려 실시간성이 죽지 않나? 줄 단위로 즉시 flush 되나?
   Windows(Node 진입점 + 네이티브 codex.exe)에서 특히 다른 점이 있나?

4. `tee` 로 바꿀 때 놓치기 쉬운 함정을 짚어줘. `PIPESTATUS` 외에 `set -uo pipefail` 과의
   상호작용, 신호 처리(trap), 부분 쓰기(partial line) 문제 등.

5. **확장이 tail 로 읽을 때의 문제** — codex 가 쓰는 도중의 파일을 다른 프로세스가 읽으면
   마지막 줄이 잘린 채로 읽힐 수 있다. 이걸 어떻게 다뤄야 하나?
   (Windows 파일 잠금 이슈도 있나?)

6. **"실행 중"과 "죽었다"를 어떻게 구분해야 하나?** lock 파일 존재로 판정하려는데,
   비정상 종료(작업관리자로 codex.exe 강제 종료 등)면 lock 이 남아 영원히 "실행 중"으로 보인다.
   더 나은 신호가 있나? codex 가 종료 시 남기는 확정적인 마지막 이벤트가 있나?

7. 대안이 여럿이면 장단점 비교 + 이 케이스 추천.

8. **확신도**를 밝혀줘. 추측인 부분과 확실한 부분을 구분해서.

## 답변 형식 — 이 답변은 Claude가 읽고 바로 적용 판단한다

응답 문서에 아래 순서로 써라.

1. `내 가설에 대한 판정` — 가설 A·B·C 각각 동의 / 부분 동의 / 기각 + 이유
2. `codex exec --json 이벤트 스키마` — ★ 가능한 한 구체적으로. 실제 예시 줄을 보여줄 수 있으면 보여줘.
   모르는 부분은 명확히 "모른다"고 표시
3. `진행 표시에 쓸 수 있는 신호와 쓸 수 없는 것`
4. `버퍼링·tee·tail 관련 함정`
5. `실행 중/죽음 판정 방법`
6. `수정 방법 (before → after)` — send.sh 쪽과 확장 쪽 각각
7. `대안 비교와 추천`
8. `확신도와 남은 불확실성` — 내가 추가로 확인해야 할 것
9. `추가로 필요한 자료` — 없으면 "없음"

## 추가 제공 가능

필요하면 `send.sh` 전문(약 600줄), `src/workflowPanel.ts` 전문,
`src/providers/codex/tailReader.ts` 전문을 더 줄 수 있다. 무엇이 더 필요한지 9번에 적어줘.
