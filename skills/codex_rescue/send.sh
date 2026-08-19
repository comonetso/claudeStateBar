#!/usr/bin/env bash
# codex_rescue — Codex CLI 에 일을 넘기고, 답변과 "Codex 가 만진 것"을 회수한다.
#
#   send.sh <request 파일 경로>                      ← 상담/수정 (요청서 기반)
#   send.sh --review --slug <슬러그> [--subject "<한 줄>"] [옵션] [집중지시] ← 코드 리뷰 (git diff 기반)
#
#     리뷰 옵션: --uncommitted | --base <브랜치> | --commit <SHA> | --title <제목> | --subject <한 줄>
#     스코프를 안 주면 자동 판정한다 — 커밋 안 된 변경이 있으면 그것을, 없으면 기본 브랜치 대비.
#
# Claude 는 이걸 **Bash(run_in_background: true)** 로 던진다. 명령이 끝나면 Claude Code 가
# Claude 를 자동 재호출하며 이 스크립트의 stdout 을 넘긴다. 그래서 출력은 사람용 로그가
# 아니라 **Claude 에게 주는 지시문** 형태로 쓴다. 사용자가 붙여넣거나 "다 됐다"고 알릴 필요가 없다.
#
# 환경변수
#   CR_MODEL=<모델>       Codex 모델 지정. 미설정이면 codex 자체 설정값을 쓴다
#   CR_SANDBOX=<모드>     read-only | workspace-write | danger-full-access (기본 workspace-write)
#                         ★ read-only 로 두면 Codex 는 아무것도 못 쓰고, 이 스크립트가 -o 로 받은
#                           최종 메시지를 응답 파일로 저장한다. 감지에 의존하지 않는 예방책이다
#   CR_WIN_SANDBOX=<모드> Windows 샌드박스 구현 방식 (기본 unelevated — 아래 주석 참조)
#   CR_ALLOW_EDIT=1       **EDIT 모드 해금.** 없으면 `mode: edit` 요청서는 거부된다.
#                         사용자 승인을 받은 뒤에만 붙인다
#   CR_DRYRUN=1           codex 를 부르지 않고 조립한 명령·프롬프트만 출력
#
#   ⛔ CR_TIMEOUT 은 제거됐다 — Windows 에서 작동하지 않는다(실측). 쓰면 거부한다
#
# 🔴 fail-closed 원칙 — 이 스크립트는 감시자다. 감지 준비에 실패하면 "변경 없음"으로 흐르지 않고
#    반드시 중단한다. 감지 실패를 정상으로 보고하는 것이 가장 나쁜 실패 양식이다.
set -uo pipefail

die() { printf 'codex_rescue: %s\n' "$*" >&2; exit 2; }

# ── 종류 판정 ───────────────────────────────────────────────────
# KIND=doc     요청서 기반. 상담(readonly) 또는 수정(edit) — 어느 쪽인지는 frontmatter 의 mode 가 정한다
# KIND=review  `codex exec review` 기반. 요청서가 없다 — 대상이 git diff 이기 때문이다
KIND=doc
REQ=""; SLUG=""; STAMP=""; SCOPE=""; SCOPE_VAL=""; TITLE=""; FOCUS=""; SCOPE_VIA=""
# 사람이 읽는 한 줄 제목. status.json 에 실려 확장 패널의 카드 제목이 된다 — slug 는
# 영문 kebab 이라 목록에서 무슨 건인지 읽히지 않는다. `--title` 과는 다르다:
# 저쪽은 `codex exec review` 에 그대로 넘어가는 Codex 쪽 인자다.
SUBJECT=""

if [ "${1:-}" = "--review" ]; then
  KIND=review; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug)        [ -n "${2:-}" ] || die "--slug 값이 없다";   SLUG="$2";      shift 2 ;;
      --base)        [ -n "${2:-}" ] || die "--base 값이 없다";   SCOPE=base;   SCOPE_VAL="$2"; shift 2 ;;
      --commit)      [ -n "${2:-}" ] || die "--commit 값이 없다"; SCOPE=commit; SCOPE_VAL="$2"; shift 2 ;;
      --title)       [ -n "${2:-}" ] || die "--title 값이 없다";  TITLE="$2";     shift 2 ;;
      --subject)     [ -n "${2:-}" ] || die "--subject 값이 없다"; SUBJECT="$2";  shift 2 ;;
      --uncommitted) SCOPE=uncommitted; shift ;;
      --)            shift; FOCUS="$FOCUS${FOCUS:+ }$*"; break ;;
      *)             FOCUS="$FOCUS${FOCUS:+ }$1"; shift ;;
    esac
  done
  [ -n "$SLUG" ] || die "리뷰는 --slug <영문-kebab-슬러그> 가 필요하다 (응답 파일명에 쓴다)"
  case "$SLUG" in
    *[!a-zA-Z0-9-]*) die "슬러그는 영문·숫자·하이픈만 쓴다: $SLUG" ;;
  esac
  ROOT="$PWD"
else
  REQ="${1:-}"
  [ -n "$REQ" ] || die "사용법: send.sh <request 파일 경로>
      또는: send.sh --review --slug <슬러그> [--subject \"<한 줄>\"] [--uncommitted|--base <브랜치>|--commit <SHA>] [집중지시]"
  [ -f "$REQ" ] || die "요청서 파일이 없다: $REQ"
  REQ_ABS="$(cd "$(dirname "$REQ")" && pwd)/$(basename "$REQ")" || die "요청서 경로 해석 실패"
  case "$REQ_ABS" in
    */docs/codex_rescue/*) ROOT="${REQ_ABS%/docs/codex_rescue/*}" ;;
    *)                     ROOT="$PWD" ;;
  esac
fi
cd "$ROOT" || die "루트로 이동 실패: $ROOT"

if [ "$KIND" = review ]; then
  # ── 리뷰: 요청서가 없다. 대상은 git diff 다 ──────────────────
  MODE=review
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "여기는 git 레포가 아니다: $ROOT
  코드 리뷰는 git diff 를 대상으로 하므로 git 레포에서만 된다.
  막힌 문제를 물어보려면 요청서 방식(--review 없이)을 써라."

  STAMP=$(date "+%y%m%d_%H%M%S") || die "스탬프 생성 실패"
  RESP_REL="docs/codex_rescue/${STAMP}_review_${SLUG}.md"

  # 스코프 자동 판정 — 플러그인(codex-plugin-cc)의 auto 규칙과 같은 기준으로 맞췄다.
  # 커밋 안 된 변경이 있으면 그게 지금 작업분이므로 우선한다. 깨끗하면 브랜치 전체를 본다.
  if [ -z "$SCOPE" ]; then
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      SCOPE=uncommitted
    else
      BB=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
      if [ -z "$BB" ]; then
        for c in main master develop; do
          git show-ref --verify --quiet "refs/heads/$c" && { BB="$c"; break; }
        done
      fi
      [ -n "$BB" ] || die "커밋 안 된 변경이 없고 기본 브랜치도 못 찾았다.
  --base <브랜치> 나 --commit <SHA> 로 리뷰 대상을 명시해라."
      CUR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      [ "$CUR" != "$BB" ] || die "리뷰할 변경이 없다 — 현재 브랜치가 기본 브랜치($BB)이고 커밋 안 된 변경도 없다.
  특정 커밋을 보려면 --commit <SHA>, 다른 기준이면 --base <브랜치> 를 써라."
      SCOPE=base; SCOPE_VAL="$BB"
    fi
  fi
else
  # ── frontmatter 파싱 ──────────────────────────────────────────
  # 닫는 `---` 가 있는지 먼저 검증한다. 없으면 sed 범위가 EOF 까지 늘어나 **본문의 `mode:` 같은
  # 줄을 값으로 읽는다.** 경계가 깨진 문서는 조용히 잘못 읽지 않고 거부한다(fail-closed).
  head -1 "$REQ_ABS" | grep -qx -- '---' || die "요청서 첫 줄이 '---' 가 아니다: $REQ_ABS"
  awk 'NR>1 && /^---$/{found=1; exit} END{exit !found}' "$REQ_ABS" \
    || die "요청서 frontmatter 의 닫는 '---' 가 없다: $REQ_ABS"

  # `q` 는 단일 주소만 받으므로 `1,/^---$/!q` 로는 못 쓴다 — 범위 + s///p 로만 짠다.
  fm() { sed -n "1,/^---$/ s/^$1:[[:space:]]*//p" "$REQ_ABS" | head -1; }
  STAMP=$(fm stamp)
  SLUG=$(fm slug)
  MODE=$(fm mode)
  RESP=$(fm response_path)
  SUBJECT=$(fm subject)   # 없어도 된다 — 구형 요청서는 카드에 slug 로 남는다

  [ -n "$STAMP" ] || die "frontmatter 에 stamp 가 없다"
  [ -n "$SLUG" ]  || die "frontmatter 에 slug 가 없다"
  [ -n "$RESP" ]  || die "frontmatter 에 response_path 가 없다"
  [ -n "$MODE" ]  || MODE=readonly

  # ── 🔴 EDIT 게이트 — 기본 차단 (2026-08-17 사용자 결정) ────────
  #
  # Codex 의 2차 검토가 지적한 것: SKILL.md 의 "확인 한 줄 받는다"는 **절차 규칙일 뿐**이고
  # 이 스크립트에는 강제 게이트가 없었다. `mode: edit` 이면 그냥 실행됐다.
  # 즉 안전장치가 **Claude 의 기억력에 달려 있었다.** Claude 는 맥락으로 모드를 판정하므로
  # 오판 여지가 있고, 그때 커밋 안 한 작업이 있으면 Codex 가 그대로 고친다.
  #
  # → 이제 스크립트가 막는다. Claude 가 규칙을 잊어도 여기서 멈춘다.
  #   환경변수를 붙이는 행위 자체가 "의식적 선택"이 되고, 실수로 만든 edit 요청서는 실행되지 않는다.
  if [ "$MODE" = "edit" ] && [ -z "${CR_ALLOW_EDIT:-}" ]; then
    die "EDIT 모드는 기본 차단이다 — Codex 가 코드를 직접 고치는 경로다.

  요청서: $REQ
  모드  : edit

  🔴 Claude 가 할 일 — 실행하지 말고 먼저 사용자에게 확인받아라:
     \"Codex 가 직접 코드를 고칩니다. 제가 모르는 변경이 생겨 맥락이 끊깁니다.
      커밋 안 한 작업이 있으면 먼저 커밋하시길 권합니다. 진행할까요?\"

  승인을 받은 뒤에만 아래처럼 다시 실행한다:
     CR_ALLOW_EDIT=1 bash \"\$0\" \"$REQ\"

  (승인 없이 이 환경변수를 붙이지 마라. 그러면 게이트를 만든 의미가 없다.)"
  fi

  # ── response_path 검증 ────────────────────────────────────────
  # 🔴 이 경로는 감시에서 **제외**된다. 검증 없이 신뢰하면 "정상 산출물 제외"가 곧 감시 우회가 된다.
  #    요청서가 실수로(혹은 악의로) 코드 파일이나 루트 밖 경로를 지정하면 그 파일 변경이 묻힌다.
  #    그래서 규약 이름과 **정확히 일치**할 때만 통과시킨다.
  RESP_REL=${RESP#./}
  EXPECT="docs/codex_rescue/${STAMP}_response_${SLUG}.md"
  [ "$RESP_REL" = "$EXPECT" ] || die "response_path 가 규약과 다르다.
  기대: $EXPECT
  실제: $RESP
  (스탬프·슬러그가 요청서와 짝을 이루어야 하고, 루트 기준 상대경로여야 한다)"
fi

LOGD="docs/codex_rescue/.log"
mkdir -p -- "$LOGD" "$(dirname -- "$RESP_REL")" || die "로그/응답 디렉토리를 만들 수 없다"

# 🔴 원시 실행 기록이 실수로 커밋되는 것을 막는다 (2026-08-19).
# `.log/` 에는 명령 출력 전문·MCP 인자/결과·에이전트 메시지가 그대로 담긴다(실측: 한 실행의
# 86% 가 명령 출력이고 파일 하나가 464KB). 프로젝트 `.gitignore` 를 손대는 것은 남의 파일을
# 고치는 일이라, 대신 이 디렉토리 안에 자기 자신을 무시하는 `.gitignore` 를 둔다.
# 요청서·응답 md 는 `docs/codex_rescue/` 에 있으므로 영향받지 않는다 — 그건 기록으로 남겨야 한다.
[ -e "$LOGD/.gitignore" ] || printf '# codex_rescue raw run logs — never commit these.\n# They contain full command output, MCP arguments/results and agent messages.\n# The request/response .md files live one level up and ARE meant to be committed.\n*\n' > "$LOGD/.gitignore" 2>/dev/null

# ── 🔴 동시 실행 차단 (2026-08-17) ─────────────────────────────
#
# Codex 의 2차 검토 지적: 스탬프가 **초 단위**라 같은 초에 두 건을 돌리면
# 응답 파일과 `.log/<스탬프>_*` 가 서로 덮어쓴다. CONSULT 는 요청서에 스탬프가 고정돼 있어
# 같은 요청서를 두 번 돌리면 초가 달라도 로그가 겹친다.
#
# `set -o noclobber` + `:>` 는 **원자적**이다 — 파일이 없을 때만 성공하므로 경합에 안전하다.
# 응답 파일 존재 검사만으로는 로그 충돌을 못 막으므로 lock 으로 통째 직렬화한다.
LOCK="$LOGD/.${STAMP}.lock"
if ! (set -o noclobber; : > "$LOCK") 2>/dev/null; then
  die "같은 스탬프($STAMP)가 이미 실행 중이다 — 동시 실행은 응답·로그를 덮어쓴다.

  lock: $LOCK

  이 중 하나다:
   ① 정말 지금 돌고 있다   → 끝날 때까지 기다려라
   ② 비정상 종료로 남았다   → lock 파일을 지우고 다시 실행해라

  판별: lock 의 mtime 을 봐라. 몇 분 이상 지났고 codex 프로세스가 없으면 ②다."
fi

# ── 실행 산출물은 Codex 의 쓰기 영역 **밖**에 만든다 ────────────
# 🔴 marker·baseline 은 감시 **기준**이다. 그걸 감시 대상(workspace) 안에 두면 피감시자가
#    지울 수 있고, 하필 그 디렉토리는 스캔에서 prune 되므로 훼손이 보고되지도 않는다.
#    → workspace 밖 임시 run 디렉토리에 둔다.
#
# 🔴 last_message 를 stamp 고정 이름으로 workspace 안에 두면 **이전 실행의 답변을 이번 응답으로
#    회수**한다. 같은 요청서를 재실행하면 실제로 재현되는 버그다. run 디렉토리는 매번 새로 만들어지므로
#    stale 재사용이 원천적으로 불가능하다.
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-rescue-${STAMP}.XXXXXX") \
  || { rm -f -- "$LOCK"; die "run 디렉토리 생성 실패"; }

# 신호를 받으면 정리하고 **즉시 종료**한다. 정리만 하고 계속 진행하면 방금 지운 marker 를
# 참조해 엉뚱한 곳에서 죽는다(2026-08-17 실측: 외부 timeout 으로 죽였을 때 발생).
# EXIT 은 정리만 담당한다. `rm -rf`·`rm -f` 는 멱등이라 두 번 불려도 무해하다.
# lock 도 여기서 푼다 — 안 풀면 다음 실행이 "이미 실행 중"으로 막힌다.
# heartbeat 자식이 남으면 고아가 되어 계속 파일을 만진다. 반드시 같이 정리한다.
# 변수들이 아직 정의되기 전에 EXIT 가 걸릴 수 있으므로 전부 `${x:-}` 로 방어한다(set -u).
cleanup() {
  [ -n "${HB_PID:-}" ] && kill "$HB_PID" 2>/dev/null
  rm -rf -- "$RUN_DIR" 2>/dev/null
  rm -f -- "$LOCK" 2>/dev/null
  [ -n "${HEARTBEAT:-}" ] && rm -f -- "$HEARTBEAT" 2>/dev/null
  return 0
}
trap cleanup EXIT
# 신호로 죽을 때 status 를 interrupted 로 남긴다 — best effort 다.
# hard kill(작업관리자 등)은 여기 못 오므로 그건 heartbeat stale 이 담당한다.
trap '[ -n "${STATUS:-}" ] && write_status interrupted "\"$(date -u "+%Y-%m-%dT%H:%M:%SZ")\"" 2>/dev/null
      cleanup; echo "codex_rescue: 중단됨(신호 수신)" >&2; exit 130' HUP INT TERM
EVENTS="$RUN_DIR/events.jsonl"
ERRLOG="$RUN_DIR/stderr.log"
LASTMSG="$RUN_DIR/last_message.md"
MARKER="$RUN_DIR/marker"
BEFORE="$RUN_DIR/before.list"

# ── 진행 상황 텔레메트리 (2026-08-19) ──────────────────────────
#
# 왜 필요한가 — Codex 가 도는 동안 무엇을 하는지 밖에서 전혀 보이지 않았다("깜깜이").
# 이벤트는 이미 `--json` 으로 실시간으로 나오고 있었지만 RUN_DIR(workspace 밖·랜덤 경로·
# 종료 시 삭제)에만 쌓여서 아무도 볼 수 없었고, `.log/` 로는 **끝난 뒤에야** 복사됐다.
# 즉 "볼 수 있게 되는 순간"이 곧 "이미 끝난 순간"이었다.
#
# 🔴 그렇다고 RUN_DIR 을 workspace 로 옮기지는 않는다. marker·baseline 은 감시 **기준**이고
#    last_message 는 응답 회수의 기준이라 피감시자(Codex)의 쓰기 범위 밖에 있어야 한다.
#    → **이벤트 스트림만** 예측 가능한 경로로 실시간 미러링한다. 이벤트는 감시 기준이 아니라
#      산출물이고, `$LOGD` 는 이미 스캔에서 prune 되므로 변경 감지에 걸리지도 않는다.
#
# 🔴 이 세 파일은 **UI 편의용 비권위 telemetry** 다. `$LOGD` 는 Codex 의 workspace-write
#    범위 안이라 Codex 가 지우거나 고칠 수 있다. 감사·동시성의 권위 기준으로 격상하지 마라.
#    (2026-08-19 Codex 2차 검토 지적)
LIVE_EVENTS="$LOGD/${STAMP}_events.jsonl"
STATUS="$LOGD/${STAMP}_status.json"
HEARTBEAT="$LOGD/${STAMP}_heartbeat"

# status 값에 들어갈 문자열을 JSON 안전하게 만든다.
# 손으로 만든 부실한 escape 대신 **위험 문자를 아예 제거**한다 — 여기 들어가는 값은
# stamp(숫자·밑줄)·slug(검증됨)·mode(고정어)·state(고정어)·브랜치/SHA 정도라 손실이 없다.
# 예외는 subject 다: 사람이 쓴 자유 문장이라 따옴표·역슬래시가 들어올 수 있고, 그건
# 소리 없이 지워진다. 제목에서 그 두 글자가 빠지는 편이 깨진 JSON 보다 낫다.
# 요청서 경로는 넣지 않는다: 규약상 `<LOGD상위>/<stamp>_request_<slug>.md` 로 재구성되므로
# 굳이 넣어 escape 위험을 만들 이유가 없다.
jsan() { printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037'; }

# status.json 을 atomic 하게 갈아끼운다. 읽는 쪽(확장)이 반쯤 쓰인 파일을 보면 안 된다.
# 같은 디렉토리 안에서의 mv 라 rename(2) 로 원자적이다.
write_status() {
  local st="$1" fin="${2:-null}" cx="${3:-null}" te="${4:-null}"
  local tmp="$STATUS.tmp.$$"
  {
    printf '{"schema":1'
    printf ',"stamp":"%s"'  "$(jsan "$STAMP")"
    printf ',"slug":"%s"'   "$(jsan "$SLUG")"
    [ -n "$SUBJECT" ] && printf ',"subject":"%s"' "$(jsan "$SUBJECT")"
    printf ',"mode":"%s"'   "$(jsan "$MODE")"
    printf ',"kind":"%s"'   "$(jsan "$KIND")"
    [ "$KIND" = review ] && printf ',"scope":"%s"' "$(jsan "$SCOPE${SCOPE_VAL:+:$SCOPE_VAL}")"
    printf ',"state":"%s"'  "$(jsan "$st")"
    printf ',"started_at":"%s"' "$STARTED_AT"
    printf ',"finished_at":%s' "$fin"
    printf ',"codex_exit":%s'  "$cx"
    printf ',"tee_exit":%s'    "$te"
    printf '}\n'
  } > "$tmp" 2>/dev/null && mv -f -- "$tmp" "$STATUS" 2>/dev/null || rm -f -- "$tmp" 2>/dev/null
}
STARTED_AT=$(date -u "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")

# ── 스캔 정의 ───────────────────────────────────────────────────
# `-name build` 등에 `-type d` 를 붙인다. 안 붙이면 같은 이름의 **일반 파일**까지 prune 된다.
# 제외 영역 안의 변경은 잡지 못한다 — 성능을 위한 의도된 절충이며, 보고에 함께 공개한다.
PRUNED=".git node_modules .venv .dart_tool .gradle build .next __pycache__ docs/codex_rescue/.log"
SCAN() {
  find . \( -type d \( -name .git -o -name node_modules -o -name .venv -o -name .dart_tool \
            -o -name .gradle -o -name build -o -name .next -o -name __pycache__ \
            -o -path ./docs/codex_rescue/.log \) -prune \) -o -type f -print
}

IS_GIT=0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && IS_GIT=1

# ── 실행 전 상태 기록 ───────────────────────────────────────────
# 응답 파일이 **실행 전에 이미 있었는지**와 그 해시를 남긴다. 이게 없으면 Codex 가 아무것도
# 쓰지 않았는데도 "응답 도착(author: codex)" 으로 성공 보고한다 — 이전 실행이 남긴 파일을
# 이번 결과로 착각하는 것이다.
hashof() { sha256sum -- "$1" 2>/dev/null | cut -d' ' -f1; }
RESP_EXISTED=0; RESP_HASH_BEFORE=""
if [ -e "$RESP_REL" ]; then
  RESP_EXISTED=1
  RESP_HASH_BEFORE=$(hashof "$RESP_REL")
fi

if [ -z "${CR_DRYRUN:-}" ]; then
  SCAN | LC_ALL=C sort > "$BEFORE" || die "실행 전 스냅샷 실패 — 감지 없이 진행하지 않는다"
  [ -s "$BEFORE" ] || die "실행 전 스냅샷이 비었다 — 스캔이 정상 동작하지 않았다"
  [ "$IS_GIT" = 1 ] && git status --porcelain > "$RUN_DIR/git_before" 2>/dev/null
  : > "$MARKER" || die "마커 생성 실패 — 감지 기준을 세울 수 없다"
fi

# ── Codex 에 넘기는 경로는 Windows 형식으로 바꾼다 ──────────────
# codex 진입점은 Node 스크립트(Windows 네이티브)다. Git Bash 의 MSYS 경로(`/d/OneDrive/...`)를
# 그대로 넘기면 디렉토리를 못 찾고, 프롬프트에 박은 요청서 경로도 읽지 못한다.
# bash 쪽 파일 조작은 계속 MSYS 경로로 하고, **codex 인자에만** 변환을 적용한다.
#
# 변환 실패를 원본으로 조용히 폴백하지 않는다 — 그러면 못 읽는 경로로 Codex 를 부르고
# "요청서를 못 읽었다" 는 답을 받는다. Windows 계열에서는 변환 성공을 요구한다.
IS_WIN=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; esac
winp() {
  if [ "$IS_WIN" = 1 ]; then
    cygpath -m -- "$1" || die "cygpath 변환 실패: $1"
  else
    printf '%s' "$1"
  fi
}
ROOT_W=$(winp "$ROOT")       || exit 2
LASTMSG_W=$(winp "$LASTMSG") || exit 2
REQ_W=""
[ "$KIND" = doc ] && { REQ_W=$(winp "$REQ_ABS") || exit 2; }

# ── Codex 에 넘길 프롬프트 ──────────────────────────────────────
# 요청서 본문을 프롬프트에 이어붙이지 않는다. 경로만 주고 Codex 가 직접 읽게 한다 —
# 긴 본문을 인자로 넘기면 따옴표·개행이 깨지고, 요청서가 정본이라는 규약도 흐려진다.
#
# `read -d ''` 는 NUL 구분자를 찾으므로 here-doc 끝에서 항상 1 을 반환한다. 값은 정상적으로
# 채워지지만, 나중에 `set -e` 가 붙으면 여기서 죽는다. 그래서 명시적으로 무시한다.
if [ "$KIND" = review ]; then
  # 🔴 codex CLI 제약 (2026-08-17 실측): `codex exec review` 는 스코프 플래그
  #    (`--uncommitted` · `--base` · `--commit`)와 `[PROMPT]` 를 **함께 쓸 수 없다.**
  #      error: the argument '--uncommitted' cannot be used with '[PROMPT]'
  #    즉 "스코프 지정"과 "집중 지시" 중 하나만 된다.
  #
  #    절충: 집중 지시가 있으면 플래그를 버리고 **스코프를 문장으로 녹여** 프롬프트에 넣는다.
  #    Codex 는 git 을 직접 볼 수 있으므로 문장 지시로도 대상을 좁힌다. 다만 플래그만큼
  #    정확하지는 않으므로 보고에 어느 방식이었는지 밝힌다.
  #
  #    응답 형식은 우리가 지정하지 않는다 — `codex exec review` 는 자체 리뷰 포맷이 있고
  #    거기에 우리 서식을 덮어씌우면 오히려 품질이 떨어진다.
  if [ -n "$FOCUS" ]; then
    case "$SCOPE" in
      uncommitted) SCOPE_HINT="커밋되지 않은 변경(staged·unstaged·untracked)을 리뷰 대상으로 삼아라." ;;
      base)        SCOPE_HINT="현재 브랜치를 '$SCOPE_VAL' 브랜치와 비교한 변경을 리뷰 대상으로 삼아라." ;;
      commit)      SCOPE_HINT="커밋 $SCOPE_VAL 이 도입한 변경을 리뷰 대상으로 삼아라." ;;
      *)           SCOPE_HINT="" ;;
    esac
    PROMPT="${SCOPE_HINT}

${FOCUS}"
    SCOPE_VIA=prompt
  else
    PROMPT=""
    SCOPE_VIA=flag
  fi
elif [ "$MODE" = "edit" ]; then
  read -r -d '' PROMPT <<EOF || :
아래 요청서 파일을 읽고, 그 안에 적힌 지시를 그대로 따라라.

요청서: $REQ_W

- 요청서에 보고서를 저장할 경로와 파일명이 명시되어 있다. 그 경로에 그 이름 그대로 저장해라.
- 요청서가 지정한 대상 파일 외에는 건드리지 마라.
- 저장이 실패하면 같은 내용을 최종 메시지로 그대로 출력해라. 자동으로 회수된다.
EOF
else
  read -r -d '' PROMPT <<EOF || :
아래 요청서 파일을 읽고, 그 안에 적힌 지시를 그대로 따라라.

요청서: $REQ_W

🔴 반드시 지켜라:
- **코드를 고치지 마라.** 너는 분석·진단과 수정 방법 제시만 한다. 실제 수정은 Claude 가 한다.
- **네가 쓸 파일은 요청서가 지정한 응답 문서 단 하나뿐이다.** 그 외 어떤 파일도 만들거나
  수정하거나 삭제하지 마라. 임시 파일·메모·테스트 파일도 금지다.
- 요청서에 응답을 저장할 경로와 파일명이 명시되어 있다. 그 경로에 그 이름 그대로 저장해라.
- 저장이 실패하면 같은 내용을 최종 메시지로 그대로 출력해라. 자동으로 회수된다.
EOF
fi

if [ "$KIND" = review ]; then
  # 🔴 `codex exec review` 에는 `-s`(샌드박스)도 `-C`(작업 디렉토리)도 **없다.**
  #    항상 read-only 이고 cwd 를 기준으로 돈다. 이미 ROOT 로 cd 했으므로 cwd 가 맞다.
  #    `-c` · `--json` · `-o` 는 지원하므로 기존 배관(샌드박스 우회·이벤트 로그·응답 회수)이 그대로 산다.
  SANDBOX="read-only (review 고정)"
  set -- codex exec review --skip-git-repo-check --json -o "$LASTMSG_W"
  # 스코프 플래그는 프롬프트가 없을 때만 붙인다 (위 주석의 CLI 제약).
  if [ "$SCOPE_VIA" = flag ]; then
    case "$SCOPE" in
      uncommitted) set -- "$@" --uncommitted ;;
      base)        set -- "$@" --base "$SCOPE_VAL" ;;
      commit)      set -- "$@" --commit "$SCOPE_VAL" ;;
    esac
    [ -n "$TITLE" ] && set -- "$@" --title "$TITLE"
  fi
else
  SANDBOX="${CR_SANDBOX:-workspace-write}"
  set -- codex exec --skip-git-repo-check --json -s "$SANDBOX" -C "$ROOT_W" -o "$LASTMSG_W"
fi
[ -n "${CR_MODEL:-}" ] && set -- "$@" -m "$CR_MODEL"

# ── Windows: 샌드박스 구현 방식을 unelevated 로 못박는다 (중복 안전망) ───
#
# 배경 — `[windows] sandbox = "elevated"` 모드는 `CodexSandboxOffline`/`CodexSandboxOnline`
# 두 **로컬 계정**으로 권한을 격리한다. 그 계정이 사라지면 SID 조회가 영구 실패한다
# (에러 1332 = ERROR_NONE_MAPPED):
#
#   windows sandbox: helper_sid_resolve_failed: resolve SID for offline user
#   CodexSandboxOffline failed: LookupAccountNameW failed ...: 1332
#
# `.sandbox/setup_marker.json` 이 "셋업 완료"를 주장하고 있어 Codex 는 계정을 재생성하지 않는다.
# 그 상태에서는 **`-s` 를 무엇으로 줘도 파일 읽기조차 안 된다** — 읽기도 헬퍼를 통과하기 때문이다.
# 계정 재생성은 관리자 권한이 필요하고, 마커를 치워도 Codex 는 계정을 만들지 않는다(2026-08-17 실측).
#
# 🟢 2026-08-17: 사용자 지시로 **전역 `~/.codex/config.toml` 을 `unelevated` 로 수리했다.**
#    (백업: `~/.codex/_backup_20260817_repair/`) 그래서 이 오버라이드는 이제 **중복**이다.
#    그럼에도 남겨둔다 — 값이 같아 부작용이 없고, 전역 설정이 되돌아가거나 다른 머신에서
#    실행될 때 이 스킬만은 계속 동작하는 안전망이 된다.
#
# `windows.sandbox` 키는 Windows 전용이므로 Git Bash 계열에서만 붙인다.
# CR_WIN_SANDBOX= (빈 값) 으로 두면 오버라이드를 생략하고 config.toml 값을 그대로 쓴다.
if [ "$IS_WIN" = 1 ]; then
  WIN_SB="${CR_WIN_SANDBOX-unelevated}"
  [ -n "$WIN_SB" ] && set -- "$@" -c "windows.sandbox=$WIN_SB"
fi

# ── 🔴 CR_TIMEOUT 제거됨 (2026-08-17) ──────────────────────────
#
# 실측 결과 **작동하지 않았다.** `timeout` 이 codex(node)를 죽여도 Windows 네이티브 손자
# 프로세스(codex.exe)가 살아남아 대기가 풀리지 않았다. MSYS 의 시그널은 Windows 프로세스에
# 제대로 전달되지 않는다. 게다가 신호로 죽으면 trap 이 marker 를 지운 뒤 스크립트가 계속 진행해
# 엉뚱한 곳에서 죽는 2차 문제까지 있었다.
#
# "있는데 안 되는 옵션"이 가장 나쁘다 — 믿고 EDIT 나 장기 작업에 걸면 고아 프로세스가 남는다.
# 그래서 조용히 무시하지 않고 **명시적으로 거부**한다.
if [ -n "${CR_TIMEOUT:-}" ]; then
  die "CR_TIMEOUT 은 제거됐다 — Windows 에서 작동하지 않는 것이 실측으로 확인됐다(2026-08-17).

  대신 이렇게 한다:
   · Claude 는 이 스크립트를 백그라운드로 던지므로 오래 걸려도 대화가 막히지 않는다
   · 정말 멈춰야 하면 사용자가 codex 프로세스를 직접 종료한다
     Windows: 작업관리자에서 codex.exe   ·   Linux: pkill -f 'codex exec'

  CR_TIMEOUT 을 지우고 다시 실행해라."
fi

if [ -n "${CR_DRYRUN:-}" ]; then
  echo "── DRYRUN — 실행하지 않는다 ──"
  echo "종류     : $KIND"
  echo "루트     : $ROOT"
  echo "모드     : $MODE / 샌드박스: $SANDBOX"
  [ "$KIND" = review ] && echo "리뷰 대상: $SCOPE ${SCOPE_VAL:+($SCOPE_VAL)} — 지정 방식: $SCOPE_VIA"
  echo "응답 경로: $RESP_REL (실행 전 존재: $RESP_EXISTED)"
  echo "run 디렉토리: $RUN_DIR"
  printf '명령     : '; printf '%q ' "$@"; echo
  echo "── 프롬프트 ──"; printf '%s\n' "${PROMPT:-(없음 — codex 기본 리뷰)}"
  exit 0
fi

if [ "$KIND" = review ]; then
  echo "→ Codex 리뷰 중… (대상: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL})" >&2
else
  echo "→ Codex 실행 중… (요청서: $REQ / 샌드박스: $SANDBOX)" >&2
fi

# ── 진행 상황을 밖에서 볼 수 있게 준비한다 ──────────────────────
#
# 🔴 heartbeat 가 필요한 이유 — "이벤트가 안 나온다"는 죽음의 증거가 아니다. 모델이 오래
#    추론하는 동안 JSONL 이 한 줄도 안 나올 수 있다. 반대로 강제 종료(작업관리자로 codex.exe
#    kill)에는 확정적인 마지막 JSON 이벤트가 **없다** — 0.145.0 매퍼는 TurnStatus::Interrupted
#    에서 turn.failed 를 내보내지 않고 그냥 shutdown 한다. 그래서 생사는 프로세스 생존으로만
#    알 수 있고, 그걸 파일 mtime 으로 밖에 알린다. (2026-08-19 Codex 2차 검토)
#
# 부모가 hard-kill 되면 `kill -0` 이 실패해 루프가 스스로 끝난다 → 고아가 남지 않는다.
PARENT_PID=$$
# 🔴 heartbeat 를 status 보다 **먼저** 만든다. 순서가 반대면 "status=running 인데 heartbeat 없음"
#    이라는 찰나가 생기고, 하필 그때 죽으면 판독기가 생사를 영영 판정하지 못한다
#    (살아있다는 증거도, 죽었다는 증거도 없어 영구 "진행 중"으로 남는다).
#    이 순서를 지키면 "status 는 live 인데 heartbeat 가 없다" = 비정상 이라고 단정할 수 있다.
: > "$HEARTBEAT" 2>/dev/null
write_status running
( while kill -0 "$PARENT_PID" 2>/dev/null; do : > "$HEARTBEAT" 2>/dev/null; sleep 5; done ) &
HB_PID=$!

# 프롬프트가 비었으면 빈 인자를 넘기지 않는다 — codex 가 빈 프롬프트를 어떻게 볼지 보장이 없다.
#
# ★ `| tee` 로 workspace 의 LIVE_EVENTS 에 실시간 미러링한다. 이게 깜깜이를 푸는 한 줄이다.
#   버퍼링 걱정은 근거가 약하다 — 0.145.0 매퍼는 이벤트마다 `println!` 이고 Rust 의 stdout 은
#   LineWriter(줄 버퍼링)이며, Node 진입점은 native codex.exe 를 `stdio: "inherit"` 로 띄워
#   따로 모으지 않는다. 다만 매 줄 flush 가 공개 계약은 아니므로 "실시간"을 단정하지 않는다.
if [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" 2>"$ERRLOG" | tee -- "$LIVE_EVENTS" > "$EVENTS"
else
  "$@" 2>"$ERRLOG" | tee -- "$LIVE_EVENTS" > "$EVENTS"
fi
# 🔴 PIPESTATUS 는 **바로 다음 명령**에서 배열째 복사해야 한다. 다른 명령이 하나라도 끼면 덮인다.
PIPE_RC=("${PIPESTATUS[@]}")
RC=${PIPE_RC[0]}
TEE_RC=${PIPE_RC[1]:-0}

# 🔴 heartbeat 를 여기서 멈추지 않는다. heartbeat 의 계약은 "codex 가 살아있다"가 아니라
#    **"send.sh 가 살아있다"** 다. 여기서 끊으면 아래 후처리(전체 파일 스캔 2회 + 해시 + 로그
#    복사)가 길어질 때 판독기가 멀쩡히 도는 실행을 stale 로 오판한다. 느린 디스크·네트워크
#    드라이브·동기화 폴더에서 실제로 30초를 넘길 수 있다. (2026-08-19 Codex 2차 검토 지적)
write_status finalizing null "$RC" "$TEE_RC"

# ── 변경 감지 (로그를 workspace 로 복사하기 **전에** 한다) ──────
TOUCHED=$(find . \( -type d \( -name .git -o -name node_modules -o -name .venv -o -name .dart_tool \
                   -o -name .gradle -o -name build -o -name .next -o -name __pycache__ \
                   -o -path ./docs/codex_rescue/.log \) -prune \) -o \
                -type f -newer "$MARKER" -print) \
  || die "실행 후 스캔 실패 — 변경 여부를 판정할 수 없다. Codex 는 이미 실행됐으므로 $RUN_DIR 를 직접 확인해라"
TOUCHED=$(printf '%s\n' "$TOUCHED" | LC_ALL=C sort | sed 's|^\./||')

AFTER="$RUN_DIR/after.list"
SCAN | LC_ALL=C sort > "$AFTER" || die "실행 후 목록 스냅샷 실패 — 삭제 여부를 판정할 수 없다"
DELETED=$(LC_ALL=C comm -23 "$BEFORE" "$AFTER" | sed 's|^\./||')

# 🔴 추가된 경로는 **경로 목록 차집합으로도** 잡는다 (Codex 2차 검토 지적).
#    mtime 만 믿으면, 새 파일이 marker 보다 오래된 mtime 으로 만들어질 때 놓친다
#    (`cp -p`, `touch -r`, hard link, 압축 해제의 타임스탬프 보존). before/after 목록이
#    이미 있으므로 비용은 0 이다.
ADDED=$(LC_ALL=C comm -13 "$BEFORE" "$AFTER" | sed 's|^\./||')

# 정상 산출물(검증된 응답 경로)만 제외한다. 남은 것이 전제를 깬 변경이다.
# `--` 로 선행 `-` 경로에도 안전하게.
STRAY=$(printf '%s\n%s\n' "$TOUCHED" "$ADDED" | grep -v '^[[:space:]]*$' \
        | LC_ALL=C sort -u | grep -Fvx -- "$RESP_REL" || true)

# ── 응답 회수 및 판정 ───────────────────────────────────────────
# 파일 존재만으로 성공 판정하지 않는다. 실행 전 해시와 비교해 **이번 실행의 산물인지** 가린다.
AUTHOR=none
RESP_HASH_AFTER=""
[ -e "$RESP_REL" ] && RESP_HASH_AFTER=$(hashof "$RESP_REL")

if [ "$KIND" = review ]; then
  # 리뷰는 Codex 가 파일을 쓰지 않는다 — `codex exec review` 는 read-only 고정이다.
  # `-o` 로 받은 결과를 이 스크립트가 규약 형식으로 저장한다. 그래서 stale 판정이 필요 없다.
  if [ -s "$LASTMSG" ]; then
    AUTHOR=codex
    {
      echo '---'
      echo 'type: codex_review'
      echo 'mode: review'
      echo "stamp: $STAMP"
      echo "slug: $SLUG"
      echo "scope: $SCOPE${SCOPE_VAL:+:$SCOPE_VAL}"
      echo "scope_via: $SCOPE_VIA"
      echo 'author: codex'
      echo '---'
      echo
      echo "# Codex 코드 리뷰 — $SLUG"
      echo
      if [ "$SCOPE_VIA" = flag ]; then
        echo "- 대상: \`$SCOPE${SCOPE_VAL:+ $SCOPE_VAL}\` (CLI 플래그로 지정 — 정확)"
      else
        echo "- 대상: \`$SCOPE${SCOPE_VAL:+ $SCOPE_VAL}\` (⚠️ 프롬프트 문장으로 지시 — codex CLI 가 스코프 플래그와 집중 지시를 함께 받지 않는다)"
      fi
      [ -n "$FOCUS" ] && echo "- 집중 지시: $FOCUS"
      echo "- 실행: \`codex exec review\` (read-only — Codex 는 코드를 고치지 않았다)"
      echo
      echo '## Codex 원문'
      echo
      cat "$LASTMSG"
    } > "$RESP_REL" || die "리뷰 결과 저장 실패: $RESP_REL"
  fi
elif [ -n "$RESP_HASH_AFTER" ]; then
  if [ "$RESP_EXISTED" = 0 ] || [ "$RESP_HASH_AFTER" != "$RESP_HASH_BEFORE" ]; then
    AUTHOR=codex                # Codex 가 새로 쓰거나 갱신했다
  else
    AUTHOR=stale                # 🔴 내용이 실행 전과 동일 — Codex 가 갱신하지 않았다
  fi
elif [ -s "$LASTMSG" ]; then
  AUTHOR=codex-via-stdout       # Codex 가 못 썼지만 최종 메시지로 회수했다
  {
    echo '---'
    echo 'type: codex_response'
    echo "mode: $MODE"
    echo "stamp: $STAMP"
    echo "slug: $SLUG"
    echo "author: $AUTHOR"
    echo '---'
    echo
    echo "# Codex 응답 — $SLUG"
    echo
    echo '> ⚠️ Codex 가 지정 경로에 직접 저장하지 못해, send.sh 가 최종 메시지를 회수해 저장했다.'
    echo
    echo '## Codex 원문'
    echo
    cat "$LASTMSG"
  } > "$RESP_REL" || die "응답 파일 저장 실패: $RESP_REL"
fi

# ── 실행 기록을 workspace 로 보존 ───────────────────────────────
# 감지가 끝난 뒤에 복사한다. 먼저 복사하면 내 로그가 "변경"으로 잡힌다.
# 🔴 복사 실패를 조용히 넘기지 않는다 (2026-08-17). 예전에는 `2>/dev/null` 로 묻었다 —
#    감시자가 자기 기록을 잃은 것을 아무도 모르는 상태였다. 내가 "fail-closed" 라고 부른 것은
#    스냅샷 경로에만 해당했고 이 경로는 fail-open 이었다. 이제 실패하면 보고한다.
#    (여기서 die 하지는 않는다 — 분석은 이미 끝났고 응답 파일이 본체다. 기록만 일부 잃는다.)
LOGCOPY_FAIL=""
# 🔴 events 는 이미 tee 로 LIVE_EVENTS 에 실시간 기록됐다. 여기서 `cp -f` 로 덮어쓰면
#    파일이 truncate 후 재작성되어, 읽고 있던 tail parser 가 그걸 shrink/rewrite 로 본다.
#    → 내용이 같으면 **손대지 않고**, 다를 때만 임시파일 + atomic rename 으로 교체한다.
if [ "$(hashof "$EVENTS")" = "$(hashof "$LIVE_EVENTS")" ]; then
  :   # 동일 — live 미러가 곧 권위 사본이다. 건드리지 않는다
else
  if cp -f -- "$EVENTS" "$LIVE_EVENTS.tmp.$$" 2>/dev/null \
     && mv -f -- "$LIVE_EVENTS.tmp.$$" "$LIVE_EVENTS" 2>/dev/null; then
    :
  else
    rm -f -- "$LIVE_EVENTS.tmp.$$" 2>/dev/null
    LOGCOPY_FAIL="$LOGCOPY_FAIL events.jsonl"
  fi
fi
cp -f -- "$ERRLOG" "$LOGD/${STAMP}_stderr.log"   2>/dev/null || LOGCOPY_FAIL="$LOGCOPY_FAIL stderr.log"
if [ -s "$LASTMSG" ]; then
  cp -f -- "$LASTMSG" "$LOGD/${STAMP}_last_message.md" 2>/dev/null \
    || LOGCOPY_FAIL="$LOGCOPY_FAIL last_message.md"
fi

# ── Claude 에게 보고 ────────────────────────────────────────────
echo
echo "════════ codex_rescue 완료 ════════"
if [ "$KIND" = review ]; then
  if [ "$SCOPE_VIA" = flag ]; then
    echo "리뷰 대상: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL}   (CLI 플래그로 지정 — 정확)"
  else
    echo "리뷰 대상: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL}   (⚠️ 프롬프트 문장으로 지시 — codex CLI 가"
    echo "           스코프 플래그와 집중 지시를 함께 받지 않아서다. 실제로 그 범위를 봤는지는"
    echo "           리뷰 본문에서 확인해라)"
  fi
  [ -n "$FOCUS" ] && echo "집중 지시: $FOCUS"
else
  echo "요청서   : $REQ"
fi
echo "모드     : $MODE / 샌드박스: $SANDBOX / codex exit: $RC"
echo "이벤트   : $LOGD/${STAMP}_events.jsonl   (실행 중 실시간 기록 — 진행 패널이 이걸 읽는다)"
echo "상태     : $STATUS"
if [ "$TEE_RC" != 0 ]; then
  echo "⚠️  실시간 미러(tee) 가 실패했다 (exit $TEE_RC) — 진행 표시가 불완전했을 수 있다."
  echo "    분석 결과 자체는 영향받지 않는다(응답은 별도 경로로 회수된다). 디스크·권한을 확인해라."
fi
if [ -n "$LOGCOPY_FAIL" ]; then
  echo "⚠️  실행 기록 복사 실패:$LOGCOPY_FAIL"
  echo "    원본은 이미 정리된 run 디렉토리에 있었다 — 그 기록은 없다. 디스크·권한을 확인해라."
fi
echo

case "$AUTHOR" in
  codex)
    if [ "$KIND" = review ]; then
      echo "✅ 리뷰 도착: $RESP_REL   (read-only 실행 — Codex 는 코드를 고치지 않았다)"
    else
      echo "✅ 응답 도착: $RESP_REL   (Codex 가 직접 저장)"
    fi
    ;;
  codex-via-stdout)
    echo "✅ 응답 도착: $RESP_REL   (⚠️ Codex 저장 실패 → 최종 메시지로 대체 저장. author: codex-via-stdout)"
    echo "   왜 못 썼는지 $LOGD/${STAMP}_stderr.log 를 확인해라."
    ;;
  stale)
    echo "🔴 응답 파일이 **갱신되지 않았다** — 내용이 실행 전과 동일하다(해시 일치)."
    echo "   $RESP_REL 은 **이전 실행의 결과물**이다. 이번 응답으로 오해하지 마라."
    echo "   Codex 는 이번에 아무것도 쓰지 못했다. $LOGD/${STAMP}_stderr.log 를 읽고 원인을 보고해라."
    [ -s "$LASTMSG" ] && echo "   이번 실행의 최종 메시지는 $LOGD/${STAMP}_last_message.md 에 있다 — 기존 파일과 비교해라."
    echo "   🔴 기존 응답 파일을 임의로 덮어쓰거나 지우지 마라. 사용자 판단을 받아라."
    ;;
  none)
    echo "❌ 응답 파일이 없고 최종 메시지도 비어 있다: $RESP_REL"
    echo "   $LOGD/${STAMP}_events.jsonl 과 ${STAMP}_stderr.log 를 읽고 원인을 사용자에게 보고해라."
    ;;
esac

echo
if [ -n "$STRAY" ] || [ -n "$DELETED" ]; then
  echo "🔴🔴 응답 파일 외의 변경이 감지됐다 — 반드시 사용자에게 보고해라"
  [ -n "$STRAY" ]   && { echo "   [생성·수정]"; printf '%s\n' "$STRAY"   | sed 's/^/     /'; }
  [ -n "$DELETED" ] && { echo "   [삭제]";      printf '%s\n' "$DELETED" | sed 's/^/     /'; }
  echo
  echo "   이 스킬의 전제는 'Codex 는 코드를 고치지 않는다' 다. 위 변경은 그 전제를 깬 것일 수 있다."
  echo "   ⚠️ 단 이 감지는 '스캔 사이에 최종 차이가 났다'는 사실만 말한다. OneDrive 동기화나 다른"
  echo "      프로세스의 변경일 수도 있으므로 **Codex 가 했다고 단정하지 마라.**"
  echo "      $LOGD/${STAMP}_events.jsonl 에서 Codex 가 실제로 실행한 동작을 대조해라."
  if [ "$IS_GIT" = 1 ]; then
    echo "   → git diff 로 실제 내용을 확인한 뒤 사용자에게 보고해라."
  else
    echo "   → 각 파일을 Read 해서 무엇이 바뀌었는지 확인한 뒤 보고해라 (git 레포가 아니라 diff 불가)."
  fi
  echo "   🔴 **임의로 되돌리지 마라.** 되돌릴지 살릴지는 사용자 판단이다."
else
  echo "✅ 감시 범위에서 응답 파일 외 변경 없음."
fi
echo "   (감시 제외 영역: $PRUNED — 이 안의 변경과, 생성 후 삭제·mtime 원복은 잡지 못한다)"

echo
echo "🔴 Claude 가 이어서 할 일:"
if [ "$KIND" = review ] && [ "$AUTHOR" = codex ]; then
  echo "   1. $RESP_REL 를 Read 한다 — Codex 가 낸 리뷰 지적이다"
  echo "   2. **Codex 원문을 고치지 마라.** 파일 끝에 '## Claude 검토' 섹션을 덧붙인다"
  echo "      — 지적별로 채택 / 보류 / 기각 + 이유. 오탐이라 판단하면 코드로 반증한 결과를 적는다"
  echo "   3. 채택할 것만 골라 사용자에게 보고하고 적용 여부 판단을 받는다"
  echo "   🔴 **리뷰 지적을 자동으로 전부 고치지 마라.** 리뷰에는 오탐과 취향 문제가 섞인다."
  echo "      무엇을 고칠지는 사용자 판단이다"
elif [ "$AUTHOR" = codex ] || [ "$AUTHOR" = codex-via-stdout ]; then
  echo "   1. $RESP_REL 를 Read 한다. **내용이 실제 분석인지 먼저 확인해라** —"
  echo "      '요청서를 읽지 못했다' 류의 실패 보고일 수 있다. 그러면 검토할 것이 없다"
  echo "   2. **Codex 원문을 고치지 마라.** 파일 끝에 '## Claude 검토' 섹션을 덧붙인다"
  echo "      — 채택 / 보류 / 기각 + 각각의 이유, 내 가설이 기각됐다면 코드로 재확인한 결과, 적용 계획"
  echo "   3. 검토 결과를 사용자에게 보고하고 적용 여부 판단을 받는다"
else
  echo "   1. 실패 원인을 로그에서 확인해 사용자에게 보고한다"
  echo "   2. 요청서를 다시 만들지 말고, 원인을 고친 뒤 같은 요청서로 재실행한다"
fi

# ── 최종 상태 기록 — 확장이 "진짜 끝"으로 보는 신호는 이것 하나다 ──
#
# 🔴 `turn.completed`(Codex turn 성공)를 완료로 쓰면 안 된다. 그 뒤에도 변경 감지·응답 회수·
#    로그 보존이 남아 있어서, 그 구간이 통째로 "완료"로 잘못 표시된다. 여기까지 와야 진짜 끝이다.
#    확장의 완료음도 이 전이(→ done/failed)에 걸어야 한 번만 정확히 울린다.
FINAL_STATE=done
[ "$RC" != 0 ]     && FINAL_STATE=failed
[ "$TEE_RC" != 0 ] && FINAL_STATE=failed
case "$AUTHOR" in none|stale) FINAL_STATE=failed ;; esac
# 후처리까지 전부 끝난 지금이 진짜 종료 시점이다 — 여기서 heartbeat 를 멈추고,
# 그다음 최종 status 를 쓴다. 순서가 반대면 판독기가 "terminal 인데 heartbeat 가 계속 뛴다"를 본다.
kill "${HB_PID:-}" 2>/dev/null; HB_PID=""
write_status "$FINAL_STATE" "\"$(date -u "+%Y-%m-%dT%H:%M:%SZ")\"" "$RC" "$TEE_RC"

exit $RC
