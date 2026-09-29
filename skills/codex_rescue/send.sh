#!/usr/bin/env bash
# codex_rescue — Codex CLI 에 일을 넘기고, 답변과 "Codex 가 만진 것"을 회수한다.
#
#   send.sh <request 파일 경로>                      ← 상담/수정/리뷰 (요청서 기반) · 1턴
#   send.sh --followup <반박서 경로>                  ← 2턴 이후 (되묻기, resume). EDIT 건은 반박서 edit: yes 로 추가 수정
#   send.sh --review --slug <슬러그> [--subject "<한 줄>"] [옵션] [집중지시] ← 코드 리뷰 (git diff 기반)
#
#     리뷰 옵션: --uncommitted | --base <브랜치> | --commit <SHA> | --title <제목> | --subject <한 줄>
#     스코프를 안 주면 자동 판정한다 — 커밋 안 된 변경이 있으면 그것을, 없으면 기본 브랜치 대비.
#     CR_LIVE_STEER=1 이면 요청서(mode: review)를 자동으로 만들어 요청서 경로로 돈다(끼어들기·중간 저장·되묻기).
#     없으면 옛 `codex exec review` 로 돈다 (2026-09-15).
#
#   CR_LIVE_STEER=1       요청서 기반 1턴(readonly·edit·review)을 끼어들기 경로(app-server)로 돌린다
#
# Claude 는 이걸 **Bash(run_in_background: true)** 로 던진다. 명령이 끝나면 Claude Code 가
# Claude 를 자동 재호출하며 이 스크립트의 stdout 을 넘긴다. 그래서 출력은 사람용 로그가
# 아니라 **Claude 에게 주는 지시문** 형태로 쓴다. 사용자가 붙여넣거나 "다 됐다"고 알릴 필요가 없다.
#
# 환경변수
#   CR_MODEL=<모델>       Codex 모델 지정. 미설정이면 codex 자체 설정값을 쓴다
#   CR_EFFORT=<수준>      추론 수준 지정(low·medium·high 등 — 모델이 지원하는 값). 미설정이면 codex 설정값.
#                         실행 전 확인(SKILL.md § 절차 2-1)에서 사용자가 바꿨을 때만 붙인다 (2026-09-13)
#   CR_SANDBOX=<모드>     read-only | workspace-write | danger-full-access (기본 workspace-write)
#                         ★ workspace-write 는 **디스크 전체 읽기 · cwd//tmp 쓰기**를 이미 준다
#                           (2026-08-25 실측). cwd 밖 쓰기와 .git 쓰기는 여전히 막힌다.
#                         ★ read-only 로 두면 Codex 는 아무것도 못 쓰고, 이 스크립트가 -o 로 받은
#                           최종 메시지를 응답 파일로 저장한다. 감지에 의존하지 않는 예방책이다.
#                           🔴 단 read-only 는 `.scratch/` 도 함께 막아 조사가 추론으로 제한된다
#                         🔴 danger-full-access 를 쓰지 마라 — 변경 감지가 cwd 기준 `find .` 이라
#                           그 밖의 수정은 **원리적으로 못 본다.** 감시자가 눈을 감은 채
#                           "변경 없음"을 보고하는 상태가 된다(이 스크립트가 가장 나쁘다고 한 것)
#   CR_NETWORK=false      네트워크를 이 실행에서만 차단한다 (기본: 허용)
#                         ★ workspace-write 에서 실제로 막혀 있던 것은 네트워크 하나뿐이었다.
#                           2026-08-25 사용자 결정으로 기본 허용. 조회 전용이며 업로드는 금지다
#                           (프롬프트 지시 + 사후 `.log/events.jsonl` 감사)
#   CR_WIN_SANDBOX=<모드> Windows 샌드박스 구현 방식 (기본 unelevated — 아래 주석 참조)
#   CR_ALLOW_EDIT=1       **EDIT 모드 해금.** 없으면 `mode: edit` 요청서는 거부된다.
#                         사용자 승인을 받은 뒤에만 붙인다
#   CR_CONFIRMED=1        **실행 전 확인 완료 표시.** 없으면 분석·수정·리뷰·되묻기·핑퐁 첫 턴을 거부한다.
#                         codex-status.mjs 로 조회하고 사용자 답을 받은 뒤에만 붙인다 (2026-09-16)
#   CR_DRYRUN=1           codex 를 부르지 않고 조립한 명령·프롬프트만 출력
#   CR_CONSULT_MAX_TURN=<n>  CONSULT 되묻기 턴 상한 (기본 11)
#                         ★ 근거: 사용자가 Codex 와 직접 대화해 결론에 도달한 세션의
#                           실측 사용자 턴 수가 11회였다(2026-08-25). 같은 장애를
#                           CONSULT 단발로는 3회 물어도 결론이 안 났다
#   CR_CHAT_LIMIT=<초>    CHAT 시간 상한 (기본 60). --explore 를 쓰면 **명시 필수**
#   CR_CHAT_LOOK_MAX=<바이트>  CHAT --look 총 크기 상한 (기본 65536)
#   CR_KEEP_DAYS=<일>     지난 기록 보존 기간 (기본 7, 0 이면 정리하지 않는다). 발동할 때마다
#                         scripts/cleanup-logs.mjs 로 정리한다 (2026-09-19)
#
#   ⛔ CR_TIMEOUT 은 제거됐다 — Windows 에서 작동하지 않는다(실측). 쓰면 거부한다
#
# 🔴 fail-closed 원칙 — 이 스크립트는 감시자다. 감지 준비에 실패하면 "변경 없음"으로 흐르지 않고
#    반드시 중단한다. 감지 실패를 정상으로 보고하는 것이 가장 나쁜 실패 양식이다.
set -uo pipefail

die() { printf 'codex_rescue: %s\n' "$*" >&2; exit 2; }

# 🔴 실행 전 확인 게이트 (2026-09-16 사용자 결정). SKILL.md § 절차 2-1 을 건너뛰는 일이 실제로 있었다 —
#    규칙만으로는 강제력이 없어 EDIT 게이트와 같은 구조로 막는다. 붙이는 행위 자체가 "물어서 답을 받았다"는 표시다.
confirm_gate() {
  [ "${CR_CONFIRMED:-}" = 1 ] && return 0
  die "pre-run confirmation was skipped — stopping because CR_CONFIRMED=1 is not set.
  1. node $SELF_DIR/scripts/codex-status.mjs --cwd <project root>
  2. Ask the user about the recommended combination, weighing difficulty and limits together, using the question frame of SKILL.md §2-1 → references/preflight.md exactly
  3. Only after the answer, run again with CR_CONFIRMED=1 (plus CR_MODEL / CR_EFFORT if a combination other than the current settings was chosen)
  🔴 Never add it without an answer. If there is no answer or it is unclear, ask again."
}

# 스킬 폴더. 아래에서 `cd "$ROOT"` 를 하므로 그 전에 한 번만 잡는다 —
# 상대경로로 불렸을 때 cd 뒤에 계산하면 엉뚱한 곳을 가리킨다.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || die "cannot find the skill folder"

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
    cygpath -m -- "$1" || die "cygpath conversion failed: $1"
  else
    printf '%s' "$1"
  fi
}

# ── 🧹 지난 기록 정리 (2026-09-19 사용자 결정) ──────────────────
# 발동할 때마다 이 프로젝트의 지난 기록을 정리한다. 무엇을 지우고 무엇을 두는지는
# scripts/cleanup-logs.mjs 머리말에 있다. 예전엔 VS Code 확장의 자동 정리(기본 꺼짐)뿐이라
# 서버 한 프로젝트에 211MB 가 쌓였다. 부가 기능이라 실패해도 실행은 계속한다.
# 🔴 부르는 자리는 두 조건을 지킨다 —
#    ① 잠금과 trap 을 건 **뒤**: 이번 실행의 스탬프가 잠금으로 빠지고, 도중에 끊겨도 잠금이 풀린다
#    ② 변경 감시 스냅샷(BEFORE)보다 **앞**: 뒤에 돌면 정리가 지운 `.scratch/` 항목이
#       "Codex 가 지운 파일"로 보고된다
cr_cleanup() {   # $1=docs/codex_rescue 경로  $2=건너뛸 스탬프  $3=자기 잠금 파일 이름(핑퐁) — 없으면 비운다
  [ -n "${CR_DRYRUN:-}" ] && return 0
  command -v node >/dev/null 2>&1 || return 0
  local js="$SELF_DIR/scripts/cleanup-logs.mjs"
  [ -f "$js" ] || return 0
  node "$(winp "$js")" --dir "$(winp "$1")" --keep-days "${CR_KEEP_DAYS:-7}" \
    ${2:+--skip-stamp "$2"} ${3:+--skip-lock "$3"} >&2 || true
}

# ── frontmatter 헬퍼 (2026-08-25, FOLLOWUP 신설과 함께) ─────────
#
# 기존 `fm()` 은 `$REQ_ABS` 에 묶여 있어 재사용이 안 된다. 임의 파일용으로 따로 둔다.
fmf() { sed -n "1,/^---\$/ s/^$2:[[:space:]]*//p" "$1" | head -1 | tr -d '\r'; }

# 경계가 깨진 문서는 조용히 잘못 읽지 않고 거부한다(fail-closed).
# 닫는 `---` 가 없으면 sed 범위가 EOF 까지 늘어나 **본문의 `mode:` 같은 줄을 값으로 읽는다.**
fm_ok() {
  head -1 "$1" | grep -qx -- '---' || return 1
  awk 'NR>1 && /^---$/{found=1; exit} END{exit !found}' "$1"
}

# 🔴 frontmatter 의 키를 갱신하거나(있으면) 닫는 `---` 앞에 삽입한다(없으면).
#    임시파일 + mv 라 실패해도 원본이 반쯤 쓰인 상태로 남지 않는다.
#    **본문은 절대 건드리지 않는다** — "Codex 원문을 고치지 마라"를 코드로 지킨다.
fm_set() {   # $1=파일  $2=키  $3=값
  local f="$1" k="$2" v="$3" tmp="$1.fmtmp.$$"
  awk -v k="$k" -v v="$v" '
    NR==1   { if ($0 != "---") exit 1; print; next }
    fin     { print; next }
    /^---$/ { if (!seen) print k ": " v; print; fin=1; next }
    $0 ~ "^" k ":" { print k ": " v; seen=1; next }
            { print }
    END     { if (!fin) exit 1 }
  ' "$f" > "$tmp" 2>/dev/null && mv -f -- "$tmp" "$f" 2>/dev/null && return 0
  rm -f -- "$tmp" 2>/dev/null
  return 1
}

# ── 모델·추론 수준 값 검사 (2026-09-13) ─────────────────────────
# 두 값은 codex 인자로 들어가고, 끼어들기 경로에서는 따옴표 없는 확장으로 펼쳐진다.
# 공백·셸 특수문자가 섞이면 인자가 쪼개지므로 모든 모드보다 먼저 막는다.
# 허용값 목록은 모델마다 달라 두지 않는다.
for _cr_v in CR_MODEL CR_EFFORT; do
  case "${!_cr_v:-}" in
    '') ;;
    *[!A-Za-z0-9._-]*) die "$_cr_v has an invalid value: ${!_cr_v}  (letters, digits, . _ - only)" ;;
  esac
done
unset _cr_v

# ═══════════════════════════════════════════════════════════════
# CHAT — 핑퐁 (2026-08-22 신설)
#
#   send.sh --chat --slug <슬러그> [--subject "<한 줄>"] [--new] <던질 말>
#
# 다른 세 모드와 **목적이 반대**라서 배관을 공유하지 않고 여기서 끝낸다.
# 저쪽은 "한 번 무겁게 던지고 오래 기다린다"이고, 이쪽은 "짧게 여러 번 주고받는다"이다.
# 그래서 아래를 전부 타지 않고 조기 종료한다:
#
#   - `.log/<stamp>_events.jsonl` · `_status.json` · `_heartbeat`
#     → 🔴 **의도적으로 안 쓴다.** 확장의 진행 패널은 이 파일들로 카드를 그리므로,
#       안 쓰면 핑퐁이 패널에 뜨지 않는다. 패널은 오래 도는 작업을 지켜보는 창이고
#       핑퐁은 채팅에서 즉시 읽는 것이라 카드가 쌓이면 방해만 된다.
#       **확장 코드를 고쳐서 거르는 방식이 아니다** — 안 쓰면 애초에 안 보인다(사용자 지시).
#   - marker·baseline·변경 감지 → read-only 로 돌아 Codex 에게 쓰기 권한이 아예 없다.
#     감지할 변경이 원리적으로 생기지 않으므로 스캔 비용(수천 파일)을 통째로 뺀다.
#   - stale 판정 → 응답 파일을 Codex 가 쓰지 않고 `-o` 회수분을 이 스크립트가 쓴다.
#     매번 새로 쓰므로 "이전 실행 결과를 이번 것으로 오인"할 여지가 없다(REVIEW 와 같은 이유).
#
# 맥락은 `codex exec resume <thread_id>` 가 잇는다. thread_id 는 대화 문서 frontmatter 에
# 박아 두고 다음 턴에 읽는다 — 그래서 Claude 는 슬러그만 기억하면 된다.
#
# 🔴 세션별 락을 건다. 같은 세션에 두 턴이 동시에 들어가면 응답 순서가 뒤섞인다
#    (Codex 자신이 이 설계에서 지적한 함정이다).
# ═══════════════════════════════════════════════════════════════
if [ "${1:-}" = "--chat" ]; then
  shift
  # 🔴 대화 경계는 **호출자가 명시**한다 (2026-08-22, Codex CONSULT 채택).
  #
  #    셸은 "지금이 새 스킬 호출인가"를 알 수 없다. 같은 호출의 두 번째 턴과 새 호출의 첫 턴은
  #    인자·환경·cwd·문서·시간까지 전부 같게 만들 수 있어서, 관측값만으로는 구별이 불가능하다
  #    (Codex 진단: "상태 저장 수단의 부족이 아니라 **관측 가능한 경계 신호의 부재**").
  #    PPID·환경변수·TTY·파일 lease·daemon 을 모두 검토했고 어느 것도 스킬 호출과 수명이
  #    일치한다는 계약이 없어 권위로 쓸 수 없다.
  #
  #    그래서 매 턴 `--start` 와 `--resume-stamp` 중 **정확히 하나를 필수**로 받는다. 강제력은
  #    스탬프라는 문자열이 아니라 *필수 인자 + 검증 + 거부* 에서 나온다 — EDIT 게이트를
  #    환경변수로 바꾼 것과 같은 구조다. 옵션을 빠뜨리면 조용히 이어 붙지 않고 **멈춘다.**
  CH_SLUG=""; CH_SUBJECT=""; CH_MSG=""; CH_STAMP=""; CH_THREAD=""; CH_DOC=""
  CH_ACTION=""; CH_RESUME_STAMP=""; CH_CLOSE_STAMP=""; CH_EXPLORE=0
  # 🔴 --look — Claude 가 "이걸 살펴봐" 하고 **직접 실어 보내는** 자료 (2026-08-25 신설)
  #
  #    실측이 전제를 바꿨다. 느려지는 원인은 "탐색 허용"이 아니라 **"대상 미지목"** 이었다:
  #      · 탐색 개방 + 가벼운 질문        =   7초 · 명령   0회   ← 개방 자체는 공짜다
  #      · 탐색 개방 + 파일명 지목        =  25초 · 명령   1회
  #      · 인라인 13KB + 탐색 차단        =   8초 · 명령   0회   ← 가장 빠르고 답도 가장 정확
  #      · 인라인 56KB + 탐색 차단        =  12초 · 명령   0회
  #      · 탐색 개방 + 대상 없는 넓은 질문 = 240초 초과 · 명령 105회  ← 16분 사례의 정체
  #
  #    그래서 "탐색을 푼다"를 **자료를 실어 주는 것**으로 구현한다. 경로만 지시하면 Codex 가
  #    그것만 볼 보장이 없지만(이 스킬은 전제를 프롬프트 준수에 맡기지 않는다), 인라인이면
  #    애초에 찾을 필요가 없어 탐색 차단 문장을 그대로 살린 채 근거 있는 답이 나온다.
  CH_NL=$'\n'
  # 🔴 --look 목록의 필드 구분자. **탭을 쓰지 마라** (2026-08-26 실측으로 잡은 버그).
  #    탭은 IFS 화이트스페이스라 `read` 가 **연속 구분자를 하나로 병합**한다. 그래서
  #    라인 범위 없이 파일 전체를 지목하면(빈 필드 2개) 표시이름이 시작줄 자리로 밀리고,
  #    `sed -n "<파일명>,p"` 가 깨져 **자료가 통째로 안 실린 채 실행됐다.**
  #    더 나쁜 건 그 상태로 "N바이트 실었다"고 **정상 보고**했다는 것이다 — 조용한 실패.
  #    US(0x1f)는 화이트스페이스가 아니라 빈 필드가 보존된다.
  CH_US=$'\037'
  CH_LOOK_SPECS=""   # 개행 구분. --look 이 준 원본 spec (경로 또는 경로:시작-끝)
  CH_LOOK_LIST=""    # 개행 구분. <절대경로>\t<시작>\t<끝>\t<표시이름>  ← cd 전에 굳힌다
  CH_LOOK_BYTES=0
  ch_one_action() {
    [ -z "$CH_ACTION" ] || die "--chat: --start, --resume-stamp and --close-stamp cannot be combined (now: $CH_ACTION)"
  }
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug)    [ -n "${2:-}" ] || die "--chat: --slug needs a value";    CH_SLUG="$2";    shift 2 ;;
      --subject) [ -n "${2:-}" ] || die "--chat: --subject needs a value"; CH_SUBJECT="$2"; shift 2 ;;
      --start)   ch_one_action; CH_ACTION=start; shift ;;
      --explore) CH_EXPLORE=1; shift ;;
      --look)
        [ -n "${2:-}" ] || die "--chat: --look needs a value — name the file to look at.
  · whole file   → --look src/main.js
  · part of it  → --look src/main.js:120-260
  Repeatable. Directories are not accepted — **you choosing the files** is the point of this option."
        CH_LOOK_SPECS="$CH_LOOK_SPECS${CH_LOOK_SPECS:+$CH_NL}$2"
        shift 2 ;;
      --resume-stamp)
        [ -n "${2:-}" ] || die "--chat: --resume-stamp needs a value (pass the conversation key from the stdout of the previous turn as is)"
        ch_one_action; CH_ACTION=resume; CH_RESUME_STAMP="$2"; shift 2 ;;
      --close-stamp)
        [ -n "${2:-}" ] || die "--chat: --close-stamp needs a value"
        ch_one_action; CH_ACTION=close; CH_CLOSE_STAMP="$2"; shift 2 ;;
      --new)
        die "--new was removed (2026-08-22) because it could not guarantee call boundaries.
  · start a new conversation       → --start
  · continue it                    → --resume-stamp <conversation key of the previous turn>
  · only close the conversation   → --close-stamp <conversation key>" ;;
      --)        shift; CH_MSG="$CH_MSG${CH_MSG:+ }$*"; break ;;
      *)         CH_MSG="$CH_MSG${CH_MSG:+ }$1"; shift ;;
    esac
  done
  [ -n "$CH_SLUG" ] || die "--chat needs --slug <english-kebab> — it names the file and the lock"
  # 🔴 동작을 안 밝히면 **추측하지 않고 멈춘다.** 예전에는 옵션이 없으면 같은 슬러그의 최신
  #    문서를 자동으로 이어받았고, 그래서 새 스킬 호출이 지난 대화에 조용히 붙었다.
  [ -n "$CH_ACTION" ] || die "--chat: ambiguous action — say --start or --resume-stamp.
  · **first turn** of this skill call  → --start            (this script issues the conversation key)
  · **next turn** of the same call     → --resume-stamp <conversation key from the stdout of the previous turn>
  Even with the same slug, a new skill call is --start. That is the only signal that splits conversations per call."
  for s in "$CH_RESUME_STAMP" "$CH_CLOSE_STAMP"; do
    case "$s" in
      "") ;;
      [0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
      *)  die "bad conversation key format: $s   (ymd_His, e.g. 260822_213131)" ;;
    esac
  done
  # 🔴 소문자만 받는다 (2026-08-22, Codex 지적). 대문자를 허용하면 Windows 에서는 `Foo` 와 `foo`
  #    가 같은 파일이고 Linux 에서는 다른 파일이라, 5대에 배포된 이 스킬에서 같은 슬러그가
  #    머신마다 다른 대화를 가리키게 된다. 문서도 처음부터 kebab-case 를 요구하고 있었다.
  case "$CH_SLUG" in
    *[!a-z0-9-]*) die "a slug uses only **lowercase** letters, digits and hyphens: $CH_SLUG
  (with uppercase allowed, the same slug would point to different files on Windows and Linux)" ;;
  esac
  if [ "$CH_ACTION" = close ]; then
    [ -z "$CH_MSG" ] || die "--close-stamp only closes the conversation — do not pass a message with it"
    [ -z "$CH_LOOK_SPECS" ] || die "--close-stamp does not call codex — do not pass --look with it"
  else
    [ -n "$CH_MSG" ] || die "--chat: no message for Codex"
  fi
  # 실행 전 확인은 핑퐁의 첫 턴에만 받는다
  [ "$CH_ACTION" = start ] && confirm_gate

  # 🔴 subject 는 frontmatter 에 그대로 들어간다. 개행이나 `---`·`thread_id:` 가 섞이면
  #    frontmatter 경계가 깨지고, 다음 턴의 thread_id 추출이 **엉뚱한 줄을 읽는다**
  #    (2026-08-22, Codex 지적). 한 줄로 눌러 붙이고 위험 문자를 뺀다.
  #    이 값은 사람이 읽는 제목일 뿐이라 글자 몇 개가 빠지는 편이 깨진 frontmatter 보다 낫다.
  if [ -n "$CH_SUBJECT" ]; then
    CH_SUBJECT=$(printf '%s' "$CH_SUBJECT" | tr '\n\r\t' '   ' | tr -d '"\\' \
                 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  fi

  # ── 🔴 --look 해석 — 반드시 `cd "$CH_ROOT"` 보다 **먼저** 한다 (2026-08-25) ──
  #
  #    아래에서 프로젝트 루트로 cd 하므로, 그 뒤에 해석하면 상대경로의 기준이 바뀐다.
  #    Claude 는 자기 cwd 기준으로 경로를 준다 — 그 기준으로 절대경로를 굳혀 둔다.
  #
  #    🔴 존재하지 않는 파일은 **조용히 빼지 않고 멈춘다.** 빼면 Codex 는 근거 없이 답하는데
  #    호출자는 자료를 준 줄 안다. 조용한 실패가 이 스킬에서 가장 나쁜 양식이다.
  CH_LOOK_MAX="${CR_CHAT_LOOK_MAX:-65536}"
  case "$CH_LOOK_MAX" in ''|*[!0-9]*) die "CR_CHAT_LOOK_MAX must be an integer number of bytes: $CH_LOOK_MAX" ;; esac

  if [ -n "$CH_LOOK_SPECS" ]; then
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      # 라인 범위 분리. 🔴 Windows 경로(`D:/foo`)에도 콜론이 있으므로 **끝에서** 본다.
      lk_path="$spec"; lk_from=""; lk_to=""
      lk_tail="${spec##*:}"
      case "$lk_tail" in
        [0-9]*-[0-9]*)
          lk_f="${lk_tail%%-*}"; lk_t="${lk_tail##*-}"
          case "$lk_f$lk_t" in
            *[!0-9]*) ;;
            *) lk_from="$lk_f"; lk_to="$lk_t"; lk_path="${spec%:*}" ;;
          esac ;;
      esac
      [ -n "$lk_path" ] || die "--look path is empty: $spec"

      [ -e "$lk_path" ] || die "--look target does not exist: $lk_path
  (paths are relative to **where this command is called from**. A typo, or it is being called from another folder)"
      [ -d "$lk_path" ] && die "--look does not accept a directory: $lk_path
  Sending a whole tree turns ping-pong into an investigation. Name the files to look at."
      [ -f "$lk_path" ] || die "--look target is not a regular file: $lk_path"
      [ -r "$lk_path" ] || die "--look target is not readable (permissions): $lk_path"
      [ -s "$lk_path" ] || die "--look target is an empty file: $lk_path"
      grep -Iq . -- "$lk_path" 2>/dev/null \
        || die "--look target is binary: $lk_path   (only text files can be sent)"

      if [ -n "$lk_from" ]; then
        [ "$lk_from" -ge 1 ] 2>/dev/null || die "--look line range must start at 1 or more: $spec"
        [ "$lk_to" -ge "$lk_from" ] 2>/dev/null || die "--look line range is reversed: $spec"
      fi

      # 절대경로로 굳힌다 (cd 이후에도 유효하게).
      case "$lk_path" in
        /*|[A-Za-z]:[/\\]*) lk_abs="$lk_path" ;;
        *) lk_dir=$(cd -- "$(dirname -- "$lk_path")" 2>/dev/null && pwd) \
             || die "cannot resolve the --look path: $lk_path"
           lk_abs="$lk_dir/$(basename -- "$lk_path")" ;;
      esac

      # 실을 크기를 미리 잰다 — 상한을 넘으면 codex 를 부르기 전에 멈춘다.
      if [ -n "$lk_from" ]; then
        lk_bytes=$(sed -n "${lk_from},${lk_to}p" -- "$lk_abs" 2>/dev/null | wc -c)
        [ "${lk_bytes:-0}" -gt 0 ] || die "--look line range is empty: $spec   (the file is shorter)"
        lk_name="$lk_path (${lk_from}-${lk_to}행)"
      else
        lk_bytes=$(wc -c < "$lk_abs" 2>/dev/null)
        lk_name="$lk_path"
      fi
      CH_LOOK_BYTES=$(( CH_LOOK_BYTES + ${lk_bytes:-0} ))

      CH_LOOK_LIST="$CH_LOOK_LIST${CH_LOOK_LIST:+$CH_NL}${lk_abs}${CH_US}${lk_from}${CH_US}${lk_to}${CH_US}${lk_name}"
    done <<EOF
$CH_LOOK_SPECS
EOF

    if [ "$CH_LOOK_BYTES" -gt "$CH_LOOK_MAX" ]; then
      die "--look material is too large: ${CH_LOOK_BYTES}B (limit ${CH_LOOK_MAX}B)

  Measured (2026-08-25): 56 KB inline got an answer in 12 s. Anything larger is not ping-pong size.
   · narrow it with a line range  → --look <path>:<start>-<end>
   · send fewer files
   · if it really must be read whole, it is **CONSULT** (request file), not CHAT.
  Adjust the limit with CR_CHAT_LOOK_MAX (bytes)."
    fi
  fi

  # 🔴 대화 문서는 **프로젝트 루트**(git 레포 루트)에 쌓는다 (2026-08-22 사용자 결정).
  #
  #    예전에는 `$PWD` 였다. 그래서 같은 슬러그로 불러도 **호출 위치가 다르면 다른 파일**이
  #    생겼고, 이어받을 이전 대화도 그 디렉토리 안에서만 찾으므로(아래 CH_PREV_DOC glob)
  #    맥락이 **조용히** 끊겼다. origin 이 다를 때는 알려 주면서 이쪽은 감지조차 안 했다.
  #
  #    실제 사고(2026-08-22, IVR 서버): 같은 슬러그 `poi-history-mismatch` 를 세 번 불렀는데
  #    `/home/<user>` · `/tmp` · `/home/<user>/gateway` 에 각각 문서가 생기고
  #    thread_id 가 셋 다 달랐다. 2차·3차 답변은 1차 대화를 **모르는 상태로** 나왔고, 사용자는
  #    첫 문서만 보고 있었으므로 "기록이 안 쌓인다"로 보였다.
  #
  #    근본 원인은 문서와 코드의 불일치다 — SKILL.md 는 슬러그를 "대화 스레드의 식별자"라고
  #    하는데 실제 식별자는 `(cwd, 슬러그)` 쌍이었다.
  CH_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$CH_ROOT" ] && [ -d "$CH_ROOT" ]; then
    # 🔴 실제로 이동한 뒤 `$PWD` 로 정규화한다. Windows 의 git 은 `F:/...` 를 주고 `$PWD` 는
    #    `/f/...` 라 형식이 섞이는데(2026-08-22 실측), 그대로 두면 아래 상대경로 출력
    #    (`${CH_DOC#"$CH_ROOT"/}`)과 `winp` 변환이 어긋난다. 이동 자체도 필요하다 —
    #    resume 호출은 `-C` 없이 **cwd 에 의존**하기 때문이다(아래 codex 호출부 참조).
    cd "$CH_ROOT" || die "cannot cd to the project root: $CH_ROOT"
    CH_ROOT="$PWD"
  else
    # 레포 밖이다. 여기서는 이어받기가 성립하지 않으므로 **조용히 넘어가지 않는다** —
    # 조용한 실패가 위 사고의 본질이었다.
    CH_ROOT="$PWD"
    echo "⚠️ running outside a git repository — the conversation is stored here: $CH_ROOT/docs/codex_rescue"
    echo "   Even with the same slug, **calling from another location does not continue the context.**"
  fi
  CH_DOCS="$CH_ROOT/docs/codex_rescue"
  CH_LOGD="$CH_DOCS/.log"
  # 이 대화가 어느 머신 것인지. 대화 문서는 git 으로 5대 사이를 오가지만 Codex 세션은 안 따라간다.
  CH_ORIGIN=$(hostname 2>/dev/null || echo unknown)
  mkdir -p "$CH_LOGD" || die "cannot create directory: $CH_LOGD"
  # 락 파일이 git 에 노출되지 않게. 기존 파일은 건드리지 않는다.
  [ -f "$CH_LOGD/.gitignore" ] || printf '*\n' > "$CH_LOGD/.gitignore" 2>/dev/null

  # 🔴 락에 **소유 토큰**을 적는다 (2026-08-22, Codex 지적 — ABA).
  #    빈 파일이면 cleanup 이 "경로가 같다"는 이유만으로 지운다. 그 사이 다른 실행이 락을 다시
  #    잡았다면 **남의 락을 풀어 주고** 세 번째 실행까지 들여보낸다. nonce 를 대조해 내 것일
  #    때만 푼다. pid·host·시각도 같이 적어 두면 stale 판정을 사람이 눈으로 할 수 있다.
  CH_LOCK="$CH_LOGD/.chat_${CH_SLUG}.lock"
  CH_NONCE="$$.$(date "+%s" 2>/dev/null || echo 0).${RANDOM:-0}"
  if ! (set -o noclobber; printf 'nonce=%s\npid=%s\nhost=%s\nstarted=%s\n' \
          "$CH_NONCE" "$$" "$(hostname 2>/dev/null || echo unknown)" \
          "$(date "+%Y-%m-%dT%H:%M:%S" 2>/dev/null)" > "$CH_LOCK") 2>/dev/null; then
    die "the same conversation ($CH_SLUG) is already running — two turns at once in one session mix up the answer order.

  lock: $CH_LOCK
$(sed 's/^/    /' "$CH_LOCK" 2>/dev/null)

  If the pid above is gone and started is long ago, it was left by an abnormal exit. Delete it and retry."
  fi

  CH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/codex-chat.XXXXXX") \
    || { rm -f -- "$CH_LOCK"; die "cannot create temp directory"; }
  # 내가 잡은 락일 때만 푼다 — 위 ABA 방어의 나머지 절반이다.
  ch_unlock() {
    [ -n "${CH_LOCK:-}" ] || return 0
    case "$(cat "$CH_LOCK" 2>/dev/null)" in
      *"nonce=${CH_NONCE:-__none__}"*) rm -f -- "$CH_LOCK" 2>/dev/null ;;
    esac
    return 0
  }
  ch_cleanup() { rm -rf -- "${CH_TMP:-}" 2>/dev/null; ch_unlock; return 0; }
  trap ch_cleanup EXIT
  trap 'ch_cleanup; echo "codex_rescue: interrupted (signal received)" >&2; exit 130' HUP INT TERM
  # CHAT 은 `.log/` 에 스탬프 파일을 안 쓴다 — 건너뛸 스탬프는 없고, 자기 잠금만 '다른 실행'에서 뺀다
  cr_cleanup "$CH_DOCS" "" "$(basename -- "$CH_LOCK")"

  # 문서의 thread_id 를 비우고 끊긴 사유를 남긴다. 실제로 비워졌을 때만 0 을 돌려준다 —
  # 실패를 성공으로 보고하면 다음 턴이 어긋난 세션을 조용히 재개한다.
  ch_discard_thread() {   # $1=문서 경로  $2=사유 한 줄
    [ -f "$1" ] || return 1
    sed -i "1,/^---$/ s|^thread_id:.*|thread_id:|" "$1" 2>/dev/null
    [ -z "$(sed -n "1,/^---\$/ s/^thread_id:[[:space:]]*//p" "$1" | head -1 | tr -d '\r')" ] || return 1
    {
      echo
      echo "## ⚠️ 스레드 끊김 · $(date "+%H:%M:%S")"
      echo
      echo "$2"
      echo "Codex 세션과 이 문서의 맥락이 어긋났을 수 있어 스레드를 폐기했다."
      echo "이 슬러그로 다시 물으면 **맥락 없는 새 대화**가 시작된다."
    } >> "$1" 2>/dev/null
    return 0
  }

  # ── 🔴 in-flight 복구 (2026-08-22, Codex 가 P0 로 꼽은 크래시 간격) ──────────
  #
  # codex 호출이 끝나는 지점과 대화 문서에 턴을 적는 지점 **사이**에 강제 종료(SIGKILL·
  # 상위 도구 타임아웃·전원 차단)가 들어오면, Codex 세션에는 이번 사용자 턴이 남는데
  # 문서에는 안 남는다. 문서의 thread_id 는 멀쩡하므로 **다음 호출이 어긋난 세션을 그대로
  # 재개한다.** 사용자는 그걸 알 방법이 없다.
  #
  # trap 은 이걸 못 막는다 — SIGKILL 에는 trap 이 안 걸린다. 그래서 "다음 실행이 흔적을 보고
  # 복구"하는 쪽으로 푼다: codex 를 부르기 **전에** 마커를 남기고, 턴을 문서에 적은 뒤에 지운다.
  # 마커가 남아 있다 = 지난 실행이 그 사이에서 죽었다.
  #
  # 🔴 폐기 대상은 **마커가 스스로 밝힌 문서**다 (2026-08-22, Codex CONSULT 채택).
  #    예전에는 "같은 슬러그의 최신 문서"를 닫았다. 대화가 호출 단위로 쪼개진 지금 그대로 두면,
  #    새 호출의 첫 턴이 문서 생성 전에 죽었을 때 **아무 상관 없는 과거 대화를 닫아 버린다.**
  #    마커가 이미 `stamp`·`slug` 를 적고 있으므로 그것을 권위로 쓴다.
  CH_INFLIGHT="$CH_LOGD/.chat_${CH_SLUG}.inflight"
  if [ -f "$CH_INFLIGHT" ]; then
    CH_IF_WHEN=$(sed -n 's/^started=//p' "$CH_INFLIGHT" 2>/dev/null | head -1)
    CH_IF_STAMP=$(sed -n 's/^stamp=//p'  "$CH_INFLIGHT" 2>/dev/null | head -1 | tr -d '\r')
    CH_IF_SLUG=$(sed -n 's/^slug=//p'    "$CH_INFLIGHT" 2>/dev/null | head -1 | tr -d '\r')
    case "$CH_IF_STAMP" in
      [0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
      *) die "in-flight marker cannot be attributed (old format or damaged): $CH_INFLIGHT
  It is unknown which conversation broke, so **no document was touched.** Check the contents and delete it." ;;
    esac
    [ "$CH_IF_SLUG" = "$CH_SLUG" ] \
      || die "in-flight marker slug differs: '$CH_IF_SLUG' ≠ '$CH_SLUG' ($CH_INFLIGHT)"
    CH_IF_DOC="$CH_DOCS/${CH_IF_STAMP}_chat_${CH_IF_SLUG}.md"
    if [ -f "$CH_IF_DOC" ]; then
      ch_discard_thread "$CH_IF_DOC" \
        "지난 실행이 codex 호출과 기록 사이에서 강제 종료됐다(마커: ${CH_IF_WHEN:-시각 불명})." \
        && echo "⚠️ the previous run had died midway — discarded the thread of that conversation ($CH_IF_STAMP)." \
        || die "could not discard the thread of the previous run: $CH_IF_DOC
  Left as is, the mismatched session would be resumed. Clear thread_id by hand and retry."
    else
      # 첫 턴이 문서 생성 전에 죽은 경우다. 닫을 문서가 없다 — 과거 대화는 건드리지 않는다.
      # orphan Codex 세션이 남을 수는 있지만, 멀쩡한 과거 기록을 깨뜨리는 것보다 낫다.
      echo "⚠️ the previous run died before recording its first turn ($CH_IF_STAMP). Earlier documents are left untouched."
    fi
    rm -f -- "$CH_INFLIGHT" 2>/dev/null
  fi

  # ── 대상 문서 결정 — glob 으로 추측하지 않고 정확히 한 파일만 가리킨다 ──────
  ch_fm() {   # $1=파일  $2=키
    sed -n "1,/^---$/ s/^$2:[[:space:]]*//p" "$1" | head -1 | tr -d '\r'
  }

  if [ "$CH_ACTION" = start ]; then
    CH_STAMP=$(date "+%y%m%d_%H%M%S") || die "cannot create a stamp"
    # 같은 초에 두 번 시작하면 기존 문서에 조용히 append 된다. 덮지 말고 실패시킨다.
    for f in "$CH_DOCS/${CH_STAMP}_chat_"*.md; do
      [ -e "$f" ] && die "conversation key collision: $CH_STAMP — retry in a second"
    done
    CH_DOC="$CH_DOCS/${CH_STAMP}_chat_${CH_SLUG}.md"
    CH_THREAD=""
  else
    # resume · close 공통. 🔴 대상이 없으면 **만들지 않고 멈춘다** — 조용한 새 대화가
    #    이번 사고의 본질이었고, 잘못된 resume 은 기록과 답변을 동시에 오염시킨다.
    [ -z "$CH_SUBJECT" ] || die "--subject is only for --start (the document already has a title)"
    CH_STAMP="${CH_RESUME_STAMP:-$CH_CLOSE_STAMP}"
    CH_DOC="$CH_DOCS/${CH_STAMP}_chat_${CH_SLUG}.md"
    [ -f "$CH_DOC" ] || die "no such conversation: ${CH_STAMP}_chat_${CH_SLUG}.md
  No new document was created. For a new conversation use --start."
    [ "$(ch_fm "$CH_DOC" stamp)" = "$CH_STAMP" ] || die "file name and frontmatter stamp differ: $CH_DOC"
    [ "$(ch_fm "$CH_DOC" slug)"  = "$CH_SLUG"  ] || die "file name and frontmatter slug differ: $CH_DOC"

    # 🔴 다른 머신의 대화는 **중단**한다 (2026-08-22 개정). 예전에는 경고 후 새 대화로
    #    바꿨는데, 그건 호출자가 요청한 것과 다른 동작이라 조용한 분리와 같다.
    CH_DOC_ORIGIN=$(ch_fm "$CH_DOC" origin)
    if [ -n "$CH_DOC_ORIGIN" ] && [ "$CH_DOC_ORIGIN" != "$CH_ORIGIN" ]; then
      die "this conversation started on another machine ($CH_DOC_ORIGIN) — it cannot be continued here ($CH_ORIGIN).
  Codex keeps sessions per machine. It was not silently switched to a new conversation — use --start for a new one."
    fi
    [ -n "$CH_DOC_ORIGIN" ] \
      || echo "⚠️ old document without origin — the machine cannot be checked, but only the requested document is resumed."
    CH_THREAD=$(ch_fm "$CH_DOC" thread_id)
  fi

  # ── --close-stamp: 대화를 닫기만 하고 끝낸다 (codex 를 부르지 않는다) ───────
  #    `--new` 를 대신한다. 예전 `--new` 는 "새로 시작"과 "옛 문서 닫기"를 한 동작에 묶었고,
  #    닫을 대상을 glob 으로 추측해서 **잘못 고른 문서를 영구히 닫을** 수 있었다.
  if [ "$CH_ACTION" = close ]; then
    [ -n "$CH_THREAD" ] || die "conversation already closed: ${CH_STAMP}_chat_${CH_SLUG}.md"
    sed -i "1,/^---$/ s|^thread_id:.*|thread_id:|" "$CH_DOC" \
      || die "could not close the conversation: $CH_DOC (check file permissions)"
    # 정말 비었는지 되읽어 확인한다. 실패를 성공으로 보고하지 않기 위해서다.
    [ -z "$(ch_fm "$CH_DOC" thread_id)" ] || die "thread_id was not cleared: $CH_DOC"
    {
      echo
      # 제목 문구는 확장 패널의 파서가 그대로 매칭한다(`⏹ 새 대화로 전환`). 바꾸지 마라.
      echo "## ⏹ 새 대화로 전환 · $(date "+%H:%M:%S")"
      echo
      echo '`--close-stamp` 로 이 대화를 닫았다. 다음 대화는 `--start` 로 새로 시작한다.'
    } >> "$CH_DOC" 2>/dev/null
    echo "── codex_rescue CHAT ──────────────────────────────────"
    echo "conversation closed: ${CH_DOC#"$CH_ROOT"/}"
    exit 0
  fi

  # 🔴 재개인데 스레드가 비어 있으면 **같은 파일에 새 스레드를 섞지 않는다.**
  if [ "$CH_ACTION" = resume ] && [ -z "$CH_THREAD" ]; then
    die "this conversation is closed or broken: ${CH_STAMP}_chat_${CH_SLUG}.md
  (the document thread_id is empty — discarded after a failure, or closed with --close-stamp)
  No new thread was mixed into the same file. To go on, start a new conversation with --start."
  fi

  CH_LAST="$CH_TMP/last.md"
  CH_LAST_W=$(winp "$CH_LAST") || exit 2
  CH_EV="$CH_TMP/events.jsonl"
  CH_ERR="$CH_TMP/stderr.log"

  # 🔴 `codex exec resume` 에는 `-s`(샌드박스)도 `-C`(작업 디렉토리)도 **없다.**
  #
  # 🔴🔴 그리고 **첫 턴의 read-only 는 상속되지 않는다** — 2026-08-22 실측으로 확인했다.
  #      resume 턴에 "파일을 써봐라"를 시켰더니 **실제로 파일이 만들어졌다.** 즉 아무 조치 없이는
  #      2턴부터 Codex 가 워크스페이스에 쓸 수 있고, CHAT 은 변경 감지를 빼 놨으므로
  #      **아무도 그걸 못 잡는다.** "Codex 는 아무것도 못 쓴다"는 전제가 통째로 깨진다.
  #
  #      `-c` 는 resume 도 받으므로 config 오버라이드로 강제한다. 같은 실측에서
  #      `-c sandbox_mode="read-only"` 를 붙이면 쓰기가 차단되는 것(파일 미생성)을 확인했다.
  #      🔴 이 오버라이드를 빼지 마라. 빼는 순간 감시 없는 쓰기 권한이 열린다.
  #
  # cwd 는 이미 CH_ROOT 다 — 위에서 프로젝트 루트로 `cd` 했기 때문이다. 그래서 resume 은
  # `-C` 없이도 맞다(`codex exec review` 와 같은 처지).
  # 🔴 위의 `cd` 를 빼지 마라. 빼면 resume 이 호출 위치에서 돌아 Codex 가 보는 트리가 달라진다.
  if [ -n "$CH_THREAD" ]; then
    set -- codex exec resume "$CH_THREAD" --skip-git-repo-check --json \
           -c sandbox_mode="read-only" -o "$CH_LAST_W"
  else
    CH_ROOT_W=$(winp "$CH_ROOT") || exit 2
    set -- codex exec --skip-git-repo-check --json -s read-only -C "$CH_ROOT_W" -o "$CH_LAST_W"
  fi
  [ -n "${CR_MODEL:-}" ] && set -- "$@" -m "$CR_MODEL"
  [ -n "${CR_EFFORT:-}" ] && set -- "$@" -c model_reasoning_effort="$CR_EFFORT"
  # Windows 샌드박스 안전망 — 아래 doc/review 경로와 같은 이유다(§ 트러블슈팅).
  if [ "$IS_WIN" = 1 ]; then
    CH_WIN_SB="${CR_WIN_SANDBOX-unelevated}"
    [ -n "$CH_WIN_SB" ] && set -- "$@" -c "windows.sandbox=$CH_WIN_SB"
  fi
  # 🔴 기본으로 **파일 탐색을 막는다** (2026-08-22 사용자 결정).
  #
  #    실측: 같은 배관에서 탐색 없는 질문은 7~15초, 탐색이 시작되면 16분을 넘겼다. CHAT 은
  #    "짧게 주고받는" 모드이므로 느려지는 원인을 스크립트가 없앤다. 예전에는 이 문장을
  #    호출자가 매번 손으로 붙여야 했고, 그래서 붙일지 말지를 매번 고민하다 빠뜨렸다.
  #    코드를 봐야만 답할 수 있는 질문이면 `--explore` 로 푼다 — 다만 그런 질문은 대개
  #    CHAT 이 아니라 CONSULT 감이다.
  #
  #    🔴 문서와 마커에는 **원문($CH_MSG)** 만 남긴다. 이 지시문은 배관이지 사용자가 한 말이
  #    아니다. codex 에 보내는 것만 $CH_SEND 로 따로 만든다.
  # ── 🔴 시간 상한 · --explore 게이트 (2026-08-25 개정) ────────────
  #
  #    🔴 프롬프트 조립보다 **먼저** 한다. 인자 검증이므로 일찍 걸러야 하고, 뒤에 두면
  #       조립 단계에서 먼저 죽어 게이트 안내가 안 나온다(2026-08-25 실측으로 잡은 순서 버그).
  #
  #    기본 60초. 실측 6조합 중 **병리 케이스 하나만 잘린다**:
  #      탐색차단+가벼움 9초 · 탐색개방+가벼움 7초 · 지목된 코드질문 25초
  #      인라인13KB 8초 · 인라인56KB 12초        ← 전부 통과
  #      탐색개방+대상없는 넓은질문 240초 초과   ← 잘려야 할 유일한 것
  #    즉 60초는 임의값이 아니라 **정상 케이스 전체와 병리 케이스 사이의 실측 경계**다.
  #
  # 🔴 --explore 는 상한을 **자동으로 올리지 않는다.** 60초로는 탐색이 거의 확실히 잘리고,
  #    잘리면 스레드까지 폐기되어 그 턴이 통째로 손실이다. 그 조용한 실패를 만들지 않으려고
  #    상한을 **함께 명시**하게 강제한다 — EDIT 게이트와 같은 "두 번의 의식적 선택" 구조다.
  if [ "$CH_EXPLORE" = 1 ] && [ -z "${CR_CHAT_LIMIT:-}" ]; then
    die "--explore needs a time limit **stated with it**.

  The default 60 s limit cuts exploration short, and a cut discards the thread too (the whole turn is lost).
  Measured (2026-08-25): opening exploration for a question with no named target means **105 commands · over 240 s**.

  Suspect this first — usually the problem is not --explore but **a missing target**:
     --look <path>              the script sends that file (measured 8–12 s, and the most accurate answer)
     --look <path>:<start>-<end>   only part of it

  If Codex still has to scan by itself, call it with a limit:
     CR_CHAT_LIMIT=180 bash \"\$0\" --chat ... --explore ...
  (ping-pong stalls for that long. Think once more whether it must — usually it is a CONSULT job.)"
  fi
  CH_LIMIT="${CR_CHAT_LIMIT:-60}"
  case "$CH_LIMIT" in
    ''|*[!0-9]*) die "CR_CHAT_LIMIT must be an integer number of seconds: $CH_LIMIT" ;;
  esac

  # 🔴 프롬프트는 **stdin 으로 넘긴다** (2026-08-25 개정).
  #    인자로 넘기면 Windows 네이티브 프로세스의 CreateProcess 제한(32,767 wide char)에 걸린다
  #    — 실측: 32,000B 성공 / 32,700B 실패. 한글은 바이트로 더 빨리 걸리고 인코딩까지 왜곡됐다.
  #    `codex exec` 와 `codex exec resume` **양쪽 다** PROMPT 자리에 `-` 를 두면 stdin 을 읽는다
  #    (2026-08-25 실측, 둘 다 rc=0 · resume 은 맥락 유지까지 확인).
  #
  # 🔴 문서와 마커에는 **원문($CH_MSG)** 만 남긴다. 자료 본문은 넣지 않는다 — 대화 문서가
  #    파일 사본으로 비대해지면 "대화 기록"이 아니게 된다. 무엇을 실었는지는 목록으로 남긴다.
  CH_PROMPT="$CH_TMP/prompt.txt"
  {
    printf '%s\n' "$CH_MSG"
    if [ -n "$CH_LOOK_LIST" ]; then
      printf '\nBelow is material for you to look at. I sent it inline myself.\n'
      while IFS="$CH_US" read -r lk_abs lk_from lk_to lk_name; do
        [ -n "$lk_abs" ] || continue
        printf '\n===== material: %s =====\n' "$lk_name"
        if [ -n "$lk_from" ]; then
          sed -n "${lk_from},${lk_to}p" -- "$lk_abs"
        else
          cat -- "$lk_abs"
        fi
      done <<EOF
$CH_LOOK_LIST
EOF
      printf '\n===== end of material =====\n'
    fi
    # 🔴 `[ -n "$x" ] && printf` 를 쓰지 마라 — 조건이 거짓이면 **블록 전체가 exit 1 이 되어**
    #    아래 `|| die "프롬프트 조립 실패"` 가 걸린다(2026-08-25 실측으로 잡은 버그).
    #    `if ... fi` 는 조건이 거짓이고 else 가 없으면 0 을 반환한다.
    if [ "$CH_EXPLORE" = 1 ]; then
      if [ -n "$CH_LOOK_LIST" ]; then
        printf '\n(Read the material above first; look for other files only if it is not enough.)\n'
      else
        printf '\n(You may look up files if needed, but keep the target narrow — do not scan the whole tree.)\n'
      fi
    elif [ -n "$CH_LOOK_LIST" ]; then
      printf '\n(Answer only from the material above and what this conversation gives you. Do not read files or directories yourself.)\n'
    else
      printf '\n(Do not read files or directories. Answer only from what this conversation gives you.)\n'
    fi
    printf '(Answer in the language of the question at the top.)\n'
  } > "$CH_PROMPT" || die "cannot assemble the prompt: $CH_PROMPT"

  # PROMPT 자리에 `-` 를 둔다. 실제 내용은 아래 실행부에서 stdin 리다이렉션으로 들어간다.
  set -- "$@" -

  if [ -n "${CR_DRYRUN:-}" ]; then
    echo "── CHAT dry-run ──"
    echo "slug   : $CH_SLUG"
    echo "action : $CH_ACTION   ·   conversation key: $CH_STAMP"
    echo "resume : ${CH_THREAD:-(new thread)}"
    echo "record : ${CH_DOC#"$CH_ROOT"/}"
    if [ -n "$CH_LOOK_LIST" ]; then
      echo "material: ${CH_LOOK_BYTES}B / limit ${CH_LOOK_MAX}B"
      while IFS="$CH_US" read -r _a _f _t lk_name; do
        [ -n "$lk_name" ] && echo "         · $lk_name"
      done <<EOF
$CH_LOOK_LIST
EOF
    fi
    echo "explore: $([ "$CH_EXPLORE" = 1 ] && echo 'open (--explore)' || echo 'blocked')"
    echo "limit  : ${CH_LIMIT} s"
    printf 'command:'; printf ' %q' "$@"; printf '\n'
    echo "── prompt (stdin) ──"
    cat "$CH_PROMPT"
    exit 0
  fi

  # 🔴 codex 를 부르기 **전에** 마커를 남긴다 — 위 in-flight 복구의 나머지 절반이다.
  #    이 지점부터 문서 기록이 끝나는 지점까지가 크래시에 취약한 구간이고, 마커가 그 구간을
  #    표시한다. 강제 종료로 여기서 죽으면 다음 실행이 마커를 보고 스레드를 폐기한다.
  #
  #    마커에는 **이번에 던진 질문 원문까지** 담는다 (2026-08-22). 대화 문서는 codex 가 답을
  #    준 뒤에야 턴 하나를 통째로 적으므로, 그 전까지 채팅 패널에는 보여 줄 것이 아무것도 없다 —
  #    7~13초 동안 질문조차 안 보여서 멈춘 것처럼 읽힌다. 패널은 이 마커를 읽어 "답변 대기 중"
  #    턴을 먼저 그린다. 문서를 미리 건드리지 않는 쪽을 고른 이유는, 실패했을 때 반쪽짜리 턴이
  #    기록에 남지 않게 하기 위해서다 — 문서는 끝까지 **확정된 것만** 담는다.
  #    헤더 줄은 `키=값` 이고 본문은 `--- msg ---` 뒤로 원문 그대로다. 기존 파서(`started=` 를
  #    `head -1` 로 집는 위 복구 코드)는 헤더가 먼저 나오므로 그대로 동작한다.
  {
    printf 'started=%s\npid=%s\nthread=%s\n' \
      "$(date "+%Y-%m-%dT%H:%M:%S" 2>/dev/null)" "$$" "${CH_THREAD:-(new)}"
    printf 'stamp=%s\nslug=%s\naction=%s\norigin=%s\n' "$CH_STAMP" "$CH_SLUG" "$CH_ACTION" "$CH_ORIGIN"
    if [ -n "$CH_SUBJECT" ]; then printf 'subject=%s\n' "$CH_SUBJECT"; fi
    # 실어 보낸 자료 — 본문이 아니라 **목록만**. 패널이 "무엇을 보고 답하는 중인지" 그릴 수 있다.
    # 헤더는 `--- msg ---` 앞에 둔다. 기존 파서(`sed -n 's/^started=//p' | head -1`)는 영향받지 않고,
    # 조건부 헤더(subject=)라는 선례가 이미 있다.
    if [ -n "$CH_LOOK_LIST" ]; then
      printf 'look_bytes=%s\n' "$CH_LOOK_BYTES"
      while IFS="$CH_US" read -r _a _f _t lk_name; do
        [ -n "$lk_name" ] && printf 'look=%s\n' "$lk_name"
      done <<EOF
$CH_LOOK_LIST
EOF
    fi
    [ "$CH_EXPLORE" = 1 ] && printf 'explore=1\n'
    printf -- '--- msg ---\n'
    printf '%s\n' "$CH_MSG"
  } > "$CH_INFLIGHT" 2>/dev/null

  # ⛔ `timeout` 명령은 쓰지 않는다 — Windows 에서 작동하지 않아 예전 `CR_TIMEOUT` 이
  #    통째로 제거된 이력이 있다. 대신 백그라운드로 띄우고 1초 폴링으로 직접 죽인다.
  #    TERM 을 먼저 주고 2초 뒤에도 살아 있으면 KILL 한다.
  #    (상한 $CH_LIMIT 은 위 --explore 게이트와 함께 이미 결정됐다)
  CH_TIMEDOUT=0
  # 🔴 stdin 리다이렉션을 빼지 마라 — PROMPT 자리에 `-` 를 주고 stdin 을 안 주면 codex 가
  #    상속된 stdin 을 기다리며 멈춘다. 백그라운드라 그대로 상한까지 갔다가 죽는데,
  #    원인을 알기 어려운 실패가 된다. `$!` 는 리다이렉션이 붙어도 codex 의 PID 다.
  "$@" < "$CH_PROMPT" > "$CH_EV" 2>"$CH_ERR" &
  CH_CPID=$!
  CH_WAITED=0
  while kill -0 "$CH_CPID" 2>/dev/null; do
    if [ "$CH_WAITED" -ge "$CH_LIMIT" ]; then
      CH_TIMEDOUT=1
      kill "$CH_CPID" 2>/dev/null
      sleep 2
      kill -9 "$CH_CPID" 2>/dev/null
      break
    fi
    sleep 1
    CH_WAITED=$((CH_WAITED + 1))
  done
  wait "$CH_CPID" 2>/dev/null
  CH_RC=$?
  # 죽인 경우 종료 코드가 신호에 따라 제각각이라 timeout(1) 관례값으로 고정한다.
  [ "$CH_TIMEDOUT" = 1 ] && CH_RC=124

  # 첫 턴이면 이번 실행에서 만들어진 스레드 id 를 회수한다. 다음 턴이 이걸로 이어붙는다.
  # 🔴 공백을 허용하는 패턴을 쓴다 (2026-08-22, Codex 지적). 예전에는 `"thread_id":"..."` 라는
  #    **공백 없는 정확한 모양**만 인정해서, CLI 가 JSON 서식을 바꾸기만 해도 이어받기가
  #    조용히 끊길 수 있었다.
  CH_NEW_THREAD=""
  if [ -z "$CH_THREAD" ]; then
    CH_THREAD=$(grep -o '"thread_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$CH_EV" 2>/dev/null \
                | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
    CH_NEW_THREAD="$CH_THREAD"
  fi

  # 🔴 실패 판정은 **종료 코드와 응답 유무를 함께** 본다 (2026-08-22, Codex 지적).
  #    예전에는 `-s "$CH_LAST"` 하나로만 갈랐다. 그러면 CLI 가 비정상 종료했는데 출력이 일부
  #    남은 경우를 **성공으로 승격**해 문서에 박고 `exit 0` 으로 보고했다. 텍스트가 있다는 것이
  #    턴이 온전했다는 뜻은 아니다.
  if [ ! -s "$CH_LAST" ] || [ "$CH_RC" != 0 ]; then
    # 실패하면 스레드를 폐기한다.
    #
    # 실패 시점에 따라 **Codex 세션 쪽에는 이 턴의 사용자 메시지가 남는다.** 문서에는 답이
    # 없으니 그대로 같은 thread_id 를 재개하면 세션과 문서의 맥락이 어긋난 채로 대화가 이어진다.
    # thread_id 를 비워 다음 턴이 새 스레드로 시작하게 하는 것이 일치를 보장하는 유일한 방법이다.
    # 다만 문서에는 끊긴 흔적을 남긴다 — 없으면 나중에 읽을 때 스레드가 왜 바뀌었는지 알 수 없다.
    #
    # 🔴 폐기가 **실제로 됐는지 되읽어 확인**한다. 예전에는 `sed -i` 실패를 버리고도
    #    "스레드를 폐기했다"고 보고했다 — 그러면 다음 턴이 어긋난 세션을 조용히 재개한다.
    CH_DISCARDED=0
    ch_discard_thread "$CH_DOC" "codex 실행이 실패했다(exit: $CH_RC)." && CH_DISCARDED=1
    # 이 경로는 실패를 **인지하고** 처리했으므로 마커를 남길 이유가 없다. 남기면 다음 실행이
    # 이미 끝난 일을 "죽은 실행"으로 또 처리한다.
    rm -f -- "$CH_INFLIGHT" 2>/dev/null
    if [ "$CH_TIMEDOUT" = 1 ]; then
      echo "⏱ stopped after exceeding ${CH_LIMIT} s — this was turning into an investigation, not ping-pong."
      echo
      echo "   Measurements (2026-08-25) nearly settle the cause. **Not because exploration was on,"
      echo "   but because no target was named**:"
      echo "     · exploration + light question            =   7 s · 0 commands"
      echo "     · exploration + question naming a file    =  25 s · 1 command"
      echo "     · inline material 13 KB / 56 KB          = 8 s / 12 s · 0 commands"
      echo "     · exploration + broad untargeted question = over 240 s · 105 commands  ← this one"
      echo
      echo "   Try in this order:"
      echo "   ① **Name what to look at** — the first remedy. Fastest, and the most accurate answer."
      echo "        --look <path>              the script sends that file"
      echo "        --look <path>:<start>-<end>   only part of it (repeatable)"
      echo "   ② Split the question — ping-pong asks one thing at a time."
      echo "   ③ If **even Claude does not know** where to look, it is **CONSULT**, not CHAT."
      echo "        (a request file; it runs in the background, so a long run does not block the conversation)"
      echo
      echo "   If Codex really has to scan by itself, give a limit with it:"
      echo "     CR_CHAT_LIMIT=180 ... --explore     (ping-pong stalls for that long)"
      echo
    fi
    echo "🔴 the Codex turn failed (codex exit: $CH_RC, answer $([ -s "$CH_LAST" ] && echo 'partial' || echo 'none'))"
    echo
    if [ -s "$CH_LAST" ]; then
      echo "--- received output (not trustworthy — the exit code is not 0) ---"
      cat "$CH_LAST"
      echo
    fi
    echo "--- last 20 lines of stderr ---"
    tail -20 "$CH_ERR" 2>/dev/null
    echo "-------------------------"
    echo "The failed turn was not recorded in the conversation document — a broken turn would pollute the context of the next turn."
    if [ -f "$CH_DOC" ] && [ "$CH_DISCARDED" = 1 ]; then
      echo "Thread discarded: asking again with the same slug starts a new conversation."
    elif [ -f "$CH_DOC" ]; then
      echo "🔴 discarding the thread **failed** — thread_id in $CH_DOC is unchanged."
      echo "   Left as is, the next turn resumes a mismatched session. Close it with --close-stamp or clear thread_id by hand."
    fi
    exit 1
  fi

  CH_TIME=$(date "+%H:%M:%S")
  if [ ! -f "$CH_DOC" ]; then
    {
      echo '---'
      echo 'type: codex_chat'
      echo "stamp: $CH_STAMP"
      echo "slug: $CH_SLUG"
      [ -n "$CH_SUBJECT" ] && echo "subject: $CH_SUBJECT"
      # 🔴 이 대화가 **어느 머신에서** 시작됐는지 (2026-08-22, Codex 지적).
      #    `docs/codex_rescue/` 는 git 에 커밋되므로 이 문서가 다른 PC·서버로 건너간다. 그런데
      #    Codex 의 세션 저장소는 머신마다 따로다 — 남의 thread_id 로 resume 하면 실패한다.
      #    origin 이 다르면 아래에서 이어받기를 포기하고 새 대화로 시작한다.
      echo "origin: $CH_ORIGIN"
      echo "thread_id: $CH_THREAD"
      echo '---'
      echo
      echo "# Codex 핑퐁 — ${CH_SUBJECT:-$CH_SLUG}"
      echo
      echo '> 짧은 턴으로 주고받은 대화 기록이다. 이 문서는 `send.sh` 가 쓴다.'
      echo '> Codex 는 read-only 로 돌았다 — 첫 턴은 `-s read-only`, 이어받기는'
      echo '> `-c sandbox_mode=read-only`(resume 은 첫 턴 설정을 상속하지 않는다. 2026-08-22 실측).'
    } > "$CH_DOC" || die "cannot create the conversation document: $CH_DOC"
    CH_TURN=1
  else
    # 🔴 턴 수는 **대화 본문이 흉내낼 수 없는 마커**로 센다 (2026-08-22, Codex 지적).
    #    예전에는 `^## [0-9]*턴 ` 을 셌는데, 질문이나 Codex 답변에 같은 모양의 마크다운 제목이
    #    들어가기만 해도 번호가 틀어졌다. 코드 얘기를 하다 보면 충분히 생긴다.
    CH_TURN=$(grep -c '^<!-- codex_rescue:turn ' "$CH_DOC" 2>/dev/null || true)
    CH_TURN=$(( ${CH_TURN:-0} + 1 ))
  fi

  {
    echo
    echo "<!-- codex_rescue:turn ${CH_TURN} -->"
    echo "## ${CH_TURN}턴 · ${CH_TIME}"
    echo
    # 이모지는 채팅창 표기와 맞춘 것이다 — 주황이 Claude, 푸른색이 Codex(상태바 아이콘 색).
    # 같은 대화인데 화면과 기록의 표기가 다르면 나중에 읽을 때 누가 말했는지 눈에 안 들어온다.
    echo '✳️ **클로드**'
    echo
    printf '%s\n' "$CH_MSG"
    # 🔴 무엇을 실어 보냈는지 남긴다. 없으면 나중에 읽을 때 "Codex 가 무엇을 보고 답했는지"를
    #    알 수 없어 기록이 재현 불가능해진다. **본문은 넣지 않는다** — 목록만이다.
    if [ -n "$CH_LOOK_LIST" ]; then
      echo
      echo "📎 살펴본 자료 (${CH_LOOK_BYTES}B)"
      while IFS="$CH_US" read -r _a _f _t lk_name; do
        [ -n "$lk_name" ] && echo "- \`$lk_name\`"
      done <<EOF
$CH_LOOK_LIST
EOF
    fi
    [ "$CH_EXPLORE" = 1 ] && { echo; echo "🔎 탐색 개방(\`--explore\`, 상한 ${CH_LIMIT}초)"; }
    echo
    echo '🔷 **코덱스**'
    echo
    cat "$CH_LAST"
    echo
  } >> "$CH_DOC" || die "cannot write to the conversation document: $CH_DOC"

  # 🔴 턴이 문서에 안전하게 들어갔다 — 취약 구간이 닫혔으므로 마커를 내린다.
  #    이 줄이 in-flight 복구의 마지막 조각이다. 여기 도달하지 못하고 죽으면 마커가 남고,
  #    다음 실행이 그걸 보고 스레드를 폐기한다.
  rm -f -- "$CH_INFLIGHT" 2>/dev/null

  # 이번 실행이 새 대화를 열었으면 이름을 붙인다 (2026-09-17). 이어받은 턴은 첫 턴의 이름을 그대로 둔다.
  # 부가 기능이라 결과를 보지 않는다 — 실패 사유는 set-thread-name.mjs 가 stderr 에 남긴다.
  if [ -n "$CH_NEW_THREAD" ] && command -v node >/dev/null 2>&1; then
    node "$SELF_DIR/scripts/set-thread-name.mjs" --thread "$CH_NEW_THREAD" --mode chat \
      --subject "${CH_SUBJECT:-}" --slug "$CH_SLUG" || true
  fi

  echo "── codex_rescue CHAT ──────────────────────────────────"
  echo "slug: $CH_SLUG   ·   turn ${CH_TURN}   ·   codex exit: $CH_RC"
  # 🔴 다음 턴이 이 값을 그대로 `--resume-stamp` 로 넘긴다. 형식을 바꾸지 마라 — 호출자가
  #    읽는 계약이다. 이 줄이 없으면 이어서 말할 방법이 없다.
  echo "conversation key: $CH_STAMP   ← next turn of the same call: --resume-stamp $CH_STAMP"
  echo "record: ${CH_DOC#"$CH_ROOT"/}"
  echo "thread: ${CH_THREAD:-(unknown)}"
  echo
  echo "↓ Codex answer, verbatim. Relay it to the user **as is**, prefixed with the Codex label from references/chat.md — no summarizing or polishing."
  echo "───────────────────────────────────────────────────────"
  cat "$CH_LAST"
  echo
  echo "───────────────────────────────────────────────────────"
  [ -z "$CH_THREAD" ] && echo "⚠️ thread_id was not captured — the next turn starts fresh without context"
  exit 0
fi

# ── 종류 판정 ───────────────────────────────────────────────────
# KIND=doc     요청서 기반. 상담(readonly) 또는 수정(edit) — 어느 쪽인지는 frontmatter 의 mode 가 정한다
# KIND=review  `codex exec review` 기반. 요청서가 없다 — 대상이 git diff 이기 때문이다
KIND=doc
REQ=""; SLUG=""; STAMP=""; SCOPE=""; SCOPE_VAL=""; TITLE=""; FOCUS=""; SCOPE_VIA=""
# 사람이 읽는 한 줄 제목. status.json 에 실려 확장 패널의 카드 제목이 된다 — slug 는
# 영문 kebab 이라 목록에서 무슨 건인지 읽히지 않는다. `--title` 과는 다르다:
# 저쪽은 `codex exec review` 에 그대로 넘어가는 Codex 쪽 인자다.
SUBJECT=""
# ── FOLLOWUP 전용 (2026-08-25 신설) ────────────────────────────
FUP=""; FUP_ABS=""; FUP_TURN=""; PARENT_MODE=""; THREAD=""; PREV_TURNS=0; RESP_DOC_ORIGIN=""
FUP_DISCARDED=0; THREAD_SAVED=""; THREAD_WHY=""
# ── EDIT 되묻기 · 끼어들기 리뷰 전용 (2026-09-15 신설) ─────────
FUP_EDIT=0; EDITLOG_REL=""; REVIEW_REQ_AUTO=0; SCOPE_HINT=""; SCOPE_CMD=""

# 분석·수정·리뷰·되묻기·재실행은 매번 확인한다. 인자가 없으면 아래 사용법 안내가 먼저 나가게 둔다.
[ -n "${1:-}" ] && confirm_gate

if [ "${1:-}" = "--followup" ]; then
  # ── FOLLOWUP — 1턴 CONSULT 를 `codex exec resume` 으로 잇는다 ──
  #
  # 🔴 되묻는 말을 **인자로 받지 않는다.** 이 모드가 되던지는 것은 "채택/보류/기각과 그 근거"
  #    라서 길고 개행이 있다. 요청서를 파일로 주는 것과 같은 이유다.
  KIND=followup; shift
  FUP="${1:-}"
  [ -n "$FUP" ] || die "usage: send.sh --followup <follow-up file path>
  The follow-up file is docs/codex_rescue/<original stamp>_followup<N>_<slug>.md.
  🔴 Not the original request path — passing that reruns turn 1 entirely."
  [ $# -le 1 ] || die "--followup takes **exactly one** follow-up file path.
  Write the follow-up inside the follow-up file (as an argument, quotes and newlines break)."
  [ -f "$FUP" ] || die "follow-up file not found: $FUP"
  FUP_ABS="$(cd "$(dirname "$FUP")" && pwd)/$(basename "$FUP")" || die "cannot resolve the follow-up path"
  case "$FUP_ABS" in
    */docs/codex_rescue/*) ROOT="${FUP_ABS%/docs/codex_rescue/*}" ;;
    *) die "the follow-up file must be under docs/codex_rescue/: $FUP
  (it must share the directory of the original request and response for the stamps to pair)" ;;
  esac

elif [ "${1:-}" = "--review" ]; then
  KIND=review; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug)        [ -n "${2:-}" ] || die "--slug needs a value";   SLUG="$2";      shift 2 ;;
      --base)        [ -n "${2:-}" ] || die "--base needs a value";   SCOPE=base;   SCOPE_VAL="$2"; shift 2 ;;
      --commit)      [ -n "${2:-}" ] || die "--commit needs a value"; SCOPE=commit; SCOPE_VAL="$2"; shift 2 ;;
      --title)       [ -n "${2:-}" ] || die "--title needs a value";  TITLE="$2";     shift 2 ;;
      --subject)     [ -n "${2:-}" ] || die "--subject needs a value"; SUBJECT="$2";  shift 2 ;;
      --uncommitted) SCOPE=uncommitted; shift ;;
      --)            shift; FOCUS="$FOCUS${FOCUS:+ }$*"; break ;;
      *)             FOCUS="$FOCUS${FOCUS:+ }$1"; shift ;;
    esac
  done
  [ -n "$SLUG" ] || die "a review needs --slug <english-kebab-slug> (used in the response file name)"
  case "$SLUG" in
    *[!a-zA-Z0-9-]*) die "a slug uses only letters, digits and hyphens: $SLUG" ;;
  esac
  ROOT="$PWD"
else
  REQ="${1:-}"
  [ -n "$REQ" ] || die "usage: send.sh <request file path>
         or: send.sh --review --slug <slug> [--subject \"<one line>\"] [--uncommitted|--base <branch>|--commit <SHA>] [focus]
         or: send.sh --followup <follow-up file path>   ← CONSULT turn 2 and later (follow-up)"
  [ -f "$REQ" ] || die "request file not found: $REQ"
  REQ_ABS="$(cd "$(dirname "$REQ")" && pwd)/$(basename "$REQ")" || die "cannot resolve the request path"
  case "$REQ_ABS" in
    */docs/codex_rescue/*) ROOT="${REQ_ABS%/docs/codex_rescue/*}" ;;
    *)                     ROOT="$PWD" ;;
  esac
fi
cd "$ROOT" || die "cannot cd to the root: $ROOT"

if [ "$KIND" = review ]; then
  # ── 리뷰: 요청서가 없다. 대상은 git diff 다 ──────────────────
  MODE=review
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository: $ROOT
  Code review works on git diff, so only in a git repository.
  To ask about a stuck problem, use a request file (without --review)."

  STAMP=$(date "+%y%m%d_%H%M%S") || die "cannot create a stamp"
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
      [ -n "$BB" ] || die "no uncommitted changes, and the default branch was not found.
  Name the review target with --base <branch> or --commit <SHA>."
      CUR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      [ "$CUR" != "$BB" ] || die "nothing to review — the current branch is the default branch ($BB) and there are no uncommitted changes.
  For a specific commit use --commit <SHA>; against another base use --base <branch>."
      SCOPE=base; SCOPE_VAL="$BB"
    fi
  fi

  # ── 🟢 끼어들기 경로 리뷰 — 요청서를 자동으로 만들어 요청서 경로로 돌린다 (2026-09-15 사용자 결정) ──
  #
  # `codex exec review` 는 전용 리뷰 서브에이전트라 서버가 steer 를 원리적으로 거부한다
  # (codex-rs core `TaskKind::Review` → `ActiveTurnNotSteerable`). 게다가 결과를 최종 메시지로만
  # 받아서 한도로 끊기면 통째로 사라지고, 요청서가 없어 되묻기도 안 됐다.
  # 그래서 일반 턴으로 돌리고 판정 기준은 Codex 공식 rubric 을 프롬프트에 싣는다.
  # 요청서 경로를 타므로 중간 저장·되묻기·끼어들기가 CONSULT 와 같이 따라온다.
  #
  # 옛 경로(`codex exec review`)는 CR_LIVE_STEER 가 1 이 아닐 때 — "예전 방식으로" — 만 탄다.
  # Node 에 WebSocket 이 없어 끼어들기가 안 되는 머신도 이 경로를 탄다(끼어들기만 빠진다).
  if [ "${CR_LIVE_STEER:-}" = "1" ]; then
    case "$SCOPE" in
      uncommitted) SCOPE_HINT="커밋되지 않은 변경(staged·unstaged·untracked) 전체"
                   SCOPE_CMD="git status --porcelain · git diff · git diff --cached · untracked 파일은 직접 열어 읽는다" ;;
      base)        SCOPE_HINT="현재 브랜치를 '$SCOPE_VAL' 브랜치와 비교한 변경 (merge-base 기준)"
                   SCOPE_CMD="git diff $SCOPE_VAL...HEAD · git log --oneline $SCOPE_VAL..HEAD" ;;
      commit)      SCOPE_HINT="커밋 $SCOPE_VAL 이 도입한 변경"
                   SCOPE_CMD="git show $SCOPE_VAL" ;;
    esac
    [ -n "$SUBJECT" ] || SUBJECT="$TITLE"
    # 요청서에 적는 루트는 Windows 형식으로 바꾼다 (2026-09-15 실측: MSYS 경로 `/tmp/...` 가 그대로 적혔다).
    # Codex 는 Windows 네이티브라 `/tmp` 를 `C:\tmp` 로 읽는다.
    ROOT_FOR_REQ=$(winp "$ROOT") || exit 2
    REQ="docs/codex_rescue/${STAMP}_request_${SLUG}.md"
    RESP="docs/codex_rescue/${STAMP}_response_${SLUG}.md"
    mkdir -p -- docs/codex_rescue || die "cannot create the request directory: docs/codex_rescue"
    [ -e "$REQ" ] && die "a request with the same stamp already exists: $REQ (retry in a second)"
    {
      echo '---'
      echo 'type: codex_request'
      echo 'mode: review'
      echo "stamp: $STAMP"
      echo "slug: $SLUG"
      [ -n "$SUBJECT" ] && echo "subject: $SUBJECT"
      echo "response_path: $RESP"
      echo "scope: $SCOPE${SCOPE_VAL:+:$SCOPE_VAL}"
      echo 'author: send.sh'
      echo '---'
      echo
      echo "# Codex 코드 리뷰 요청 — ${SUBJECT:-$SLUG}"
      echo
      echo '> send.sh 가 `--review` 호출에서 자동으로 만든 요청서다.'
      echo
      echo '## 리뷰 대상'
      echo
      echo "$SCOPE_HINT"
      echo
      echo "- 확인 명령: $SCOPE_CMD"
      echo "- 저장소 루트: $ROOT_FOR_REQ"
      # 2026-09-15 실측: 이 도구의 기록 파일이 untracked 로 잡혀 리뷰 계획에 섞였다.
      echo '- `docs/codex_rescue/` 는 이 리뷰 도구의 기록(요청서·응답·로그)이다. **리뷰 대상이 아니다** — 변경 목록에 보여도 건너뛴다.'
      echo
      echo '## 집중 지시'
      echo
      if [ -n "$FOCUS" ]; then echo "$FOCUS"; else echo '없음 — 변경 전체를 리뷰 기준대로 본다.'; fi
      echo
      echo '## 응답 저장 위치'
      echo
      echo "    $RESP"
    } > "$REQ" || die "cannot create the review request: $REQ"
    REQ_ABS="$ROOT/$REQ"
    RESP_REL="$RESP"          # `_review_` 가 아니라 `_response_` 규약 — 되묻기가 이 이름을 요구한다
    REVIEW_REQ_AUTO=1
    SCOPE_VIA=request
    KIND=doc
  fi
elif [ "$KIND" = followup ]; then
  # ── FOLLOWUP 검증 — 대화의 생명줄을 확인한다 ──────────────────
  MODE=followup
  fm_ok "$FUP_ABS" || die "follow-up frontmatter is broken (no '---' first line or no closing '---'): $FUP_ABS"

  # 🔴 양방향 잠금 ①: followup 파일은 --followup 로만 들어온다.
  #    이 검사가 없으면 반박서를 요청서로 실행할 수 있고, response_path 가 같으므로
  #    **Codex 가 1턴 원문과 Claude 검토가 담긴 응답 문서를 통째로 덮어쓴다.**
  [ "$(fmf "$FUP_ABS" type)" = "codex_followup" ] \
    || die "this is not a follow-up file (type is not codex_followup): $FUP_ABS"
  [ "$(fmf "$FUP_ABS" mode)" = "followup" ] \
    || die "the follow-up file mode must be followup: $FUP_ABS
  🔴 a follow-up file with mode: edit is refused — followup is fixed to read-only (EDIT gate integrity)."

  STAMP=$(fmf "$FUP_ABS" stamp)
  SLUG=$(fmf "$FUP_ABS" slug)
  FUP_TURN=$(fmf "$FUP_ABS" turn)
  RESP=$(fmf "$FUP_ABS" response_path)
  [ -n "$STAMP" ] && [ -n "$SLUG" ] && [ -n "$FUP_TURN" ] && [ -n "$RESP" ] \
    || die "the follow-up frontmatter needs all of stamp, slug, turn and response_path: $FUP_ABS"
  case "$STAMP" in
    [0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "bad stamp format: $STAMP (ymd_His)" ;;
  esac
  case "$FUP_TURN" in ''|*[!0-9]*) die "turn must be an integer: $FUP_TURN" ;; esac
  [ "$FUP_TURN" -ge 2 ] || die "turn must be 2 or more (turn 1 runs from the CONSULT request): $FUP_TURN"

  # 파일명과 frontmatter 를 대조한다 — 한쪽만 고친 반박서를 걸러낸다.
  EXPECT_FUP="${STAMP}_followup${FUP_TURN}_${SLUG}.md"
  [ "$(basename "$FUP_ABS")" = "$EXPECT_FUP" ] || die "the follow-up file name breaks the convention.
  expected: $EXPECT_FUP
  actual:   $(basename "$FUP_ABS")"

  # 🔴 응답 경로는 원 건 것과 **완전히 같아야** 한다. 감시 제외 대상이므로 검증 없이 신뢰하면
  #    "정상 산출물 제외"가 곧 감시 우회가 된다 (1턴 CONSULT 와 같은 이유).
  RESP_REL=${RESP#./}
  EXPECT="docs/codex_rescue/${STAMP}_response_${SLUG}.md"
  [ "$RESP_REL" = "$EXPECT" ] || die "response_path breaks the convention.
  expected: $EXPECT
  actual:   $RESP"

  # 원 요청서 — 있어야 한다. 확장 카드의 근거이자 1턴의 정본이다.
  PARENT_REQ="docs/codex_rescue/${STAMP}_request_${SLUG}.md"
  [ -f "$PARENT_REQ" ] || die "original request not found: $PARENT_REQ
  A followup attaches only to a case whose turn 1 actually ran."
  fm_ok "$PARENT_REQ" || die "original request frontmatter is broken: $PARENT_REQ"
  PARENT_MODE=$(fmf "$PARENT_REQ" mode); [ -n "$PARENT_MODE" ] || PARENT_MODE=readonly
  SUBJECT=$(fmf "$PARENT_REQ" subject)   # 카드 제목은 원 건 것을 그대로 이어 쓴다

  # ── 🟢 EDIT 되묻기로 추가 수정 (2026-09-15 사용자 결정) ────────
  #
  # 되묻기는 원래 read-only 고정이다. EDIT 건에서만, 반박서에 `edit: yes` 를 **명시**했을 때만 푼다.
  # 부모가 edit 가 아니면 거부한다 — CONSULT 결과를 받고 되묻기로 코드를 고치게 되면
  # "Codex 는 고치지 않는다"는 CONSULT 의 전제가 되묻기에서 조용히 무너진다.
  # 턴마다 EDIT 게이트(CR_ALLOW_EDIT)를 다시 거친다 — 1턴 승인이 다음 턴까지 이어지지 않는다.
  FUP_EDIT_RAW=$(fmf "$FUP_ABS" edit)
  case "$FUP_EDIT_RAW" in
    ''|no|false) FUP_EDIT=0 ;;
    yes|true)    FUP_EDIT=1 ;;
    *) die "invalid edit value in the follow-up file: '$FUP_EDIT_RAW' (yes, or leave it out)" ;;
  esac
  if [ "$FUP_EDIT" = 1 ]; then
    [ "$PARENT_MODE" = edit ] || die "edit: yes is only for follow-ups of an EDIT case — original request mode: $PARENT_MODE
  To have code fixed after a CONSULT or REVIEW result, write a new EDIT request."
    [ -n "${CR_ALLOW_EDIT:-}" ] || die "an EDIT follow-up (turn ${FUP_TURN}) is blocked by default — it is the path where Codex keeps editing code.

  follow-up: $FUP

  🔴 What Claude does — do not run; first get the user to confirm:
     \"Codex will continue the same conversation and edit more code. If you have uncommitted work, committing it first is recommended. Go ahead?\" (ask in the language of the user)

  Only after approval, run it again like this:
     CR_ALLOW_EDIT=1 bash \"\$0\" --followup \"$FUP\"

  (approval for turn 1 does not carry over to this turn. Ask every turn.)"
    EDITLOG_REL="docs/codex_rescue/${STAMP}_edit${FUP_TURN}_${SLUG}.md"
    [ -e "$EDITLOG_REL" ] && die "the edit log for this turn already exists: $EDITLOG_REL
  If this reruns the same turn, first check what is left (the last run may have half-edited the code)."
  fi

  # ── 응답 문서 = 대화의 생명줄 ────────────────────────────────
  [ -f "$RESP_REL" ] || die "turn-1 response document not found: $RESP_REL
  No conversation to continue — start again from CONSULT turn 1."
  fm_ok "$RESP_REL" || die "response document frontmatter is broken: $RESP_REL
  🔴 thread_id cannot be read safely, so **nothing was done.** Check it by hand."

  THREAD=$(fmf "$RESP_REL" thread_id)
  [ -n "$THREAD" ] || die "this case cannot be continued: thread_id in $RESP_REL is empty.
  One of these:
   ① turn 1 ran on a version before thread_id was recorded (old response document)
   ② the last followup failed and the thread was discarded (look for '⚠️ 스레드 끊김' in the document)
   ③ the next run discarded it while recovering from a killed run
  🔴 No new thread was mixed into the same document. To ask further, start over from CONSULT turn 1."

  # 🔴 머신 대조 — Codex 세션 저장소는 머신마다 따로인데 docs/ 는 git 으로 5대를 오간다.
  #    CHAT 과 같은 이유이고, 같은 이유로 **조용히 새 대화로 바꾸지 않고 중단**한다.
  RESP_DOC_ORIGIN=$(fmf "$RESP_REL" origin)
  MY_ORIGIN=$(hostname 2>/dev/null || echo unknown)
  if [ -n "$RESP_DOC_ORIGIN" ] && [ "$RESP_DOC_ORIGIN" != "$MY_ORIGIN" ]; then
    die "this case started on another machine ($RESP_DOC_ORIGIN) — it cannot be continued here ($MY_ORIGIN).
  Codex keeps sessions per machine. Continue on that machine, or start a new CONSULT here."
  fi
  [ -n "$RESP_DOC_ORIGIN" ] \
    || echo "⚠️ old response document without origin — the machine cannot be checked. If resume fails, this may be why."

  # 🔴 턴 번호는 **문서가 권위**다. Claude 가 세는 것을 믿지 않는다.
  PREV_TURNS=$(fmf "$RESP_REL" turns); PREV_TURNS=${PREV_TURNS:-1}
  case "$PREV_TURNS" in ''|*[!0-9]*) die "turns in the response document is not an integer: '$PREV_TURNS' ($RESP_REL)" ;; esac
  [ "$FUP_TURN" -eq $((PREV_TURNS + 1)) ] || die "turn number mismatch.
  turns in the response document: $PREV_TURNS  →  this follow-up must be turn: $((PREV_TURNS + 1))
  turn claimed by the follow-up: $FUP_TURN
  (skipping or going back puts the conversation record and the Codex session out of step)"

  # ── 턴 상한 = 11 (2026-08-25 사용자 결정) ────────────────────
  #    근거: 사용자가 Codex 와 직접 대화해 결론에 도달한 세션의 **실측 사용자 턴 수가 11회**였다.
  #    같은 장애를 CONSULT(1턴 단발)로는 3회 물어도 결론이 안 났다. 그 실측을 상한으로 삼는다.
  CONSULT_MAX="${CR_CONSULT_MAX_TURN:-11}"
  case "$CONSULT_MAX" in
    ''|*[!0-9]*) die "CR_CONSULT_MAX_TURN must be an integer: $CONSULT_MAX" ;;
  esac
  [ "$FUP_TURN" -le "$CONSULT_MAX" ] || die "turn limit ($CONSULT_MAX) exceeded — turn ${FUP_TURN} is not run.
  🔴 If the completion gate is still not met at this point, **calling Codex more is not the answer.**
     Bring the remaining gate items and the disagreements still open at the last turn to the user and get a decision."

else
  # ── frontmatter 파싱 ──────────────────────────────────────────
  # 닫는 `---` 가 있는지 먼저 검증한다. 없으면 sed 범위가 EOF 까지 늘어나 **본문의 `mode:` 같은
  # 줄을 값으로 읽는다.** 경계가 깨진 문서는 조용히 잘못 읽지 않고 거부한다(fail-closed).
  head -1 "$REQ_ABS" | grep -qx -- '---' || die "the first line of the request is not '---': $REQ_ABS"
  awk 'NR>1 && /^---$/{found=1; exit} END{exit !found}' "$REQ_ABS" \
    || die "the request frontmatter has no closing '---': $REQ_ABS"

  # `q` 는 단일 주소만 받으므로 `1,/^---$/!q` 로는 못 쓴다 — 범위 + s///p 로만 짠다.
  fm() { sed -n "1,/^---$/ s/^$1:[[:space:]]*//p" "$REQ_ABS" | head -1; }
  STAMP=$(fm stamp)
  SLUG=$(fm slug)
  MODE=$(fm mode)
  RESP=$(fm response_path)
  SUBJECT=$(fm subject)   # 없어도 된다 — 구형 요청서는 카드에 slug 로 남는다

  [ -n "$STAMP" ] || die "no stamp in the frontmatter"
  [ -n "$SLUG" ]  || die "no slug in the frontmatter"
  [ -n "$RESP" ]  || die "no response_path in the frontmatter"
  [ -n "$MODE" ]  || MODE=readonly

  # ── 🔴 양방향 잠금 ② — 반박서가 요청서 경로로 들어오는 것을 막는다 (2026-08-25) ──
  #
  #    반박서와 원 요청서는 **같은 response_path** 를 가리킨다. 그래서 반박서를 이 경로로
  #    실행하면 규약 검증을 전부 통과하고, Codex 가 workspace-write 로 돌면서
  #    **1턴 원문과 `## Claude 검토` 가 담긴 응답 문서를 통째로 덮어쓴다.**
  #    N턴 대화가 한 번에 날아가는 경로다 — 실측으로 구멍을 확인하고 막았다.
  REQ_TYPE=$(fm type)
  case "$REQ_TYPE" in
    codex_followup) die "this is a follow-up file. Do not run it through the request path: $REQ
  🔴 Run like this, Codex would **overwrite the response document holding the turn-1 text and the Claude review.**
     ($RESP — the follow-up and the original request point to the same response document)

  Follow up like this:
     bash \"\$0\" --followup $REQ" ;;
  esac
  case "$MODE" in
    followup) die "mode: followup cannot run as a request: $REQ
  🔴 Same reason as above — call it with \`--followup\`." ;;
    readonly|edit) ;;
    # 끼어들기 리뷰가 자동으로 만든 요청서를 다시 돌리는 경우(RESUME)다. 대상이 git diff 라 레포여야 한다.
    review)
      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "a review request runs only in a git repository: $ROOT" ;;
    *) die "unknown mode in the request: '$MODE' ($REQ)
  It must be one of readonly, edit, review." ;;
  esac

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
    die "EDIT mode is blocked by default — it is the path where Codex edits code directly.

  request: $REQ
  mode   : edit

  🔴 What Claude does — do not run; first get the user to confirm:
     \"Codex will edit the code directly. Changes I do not know about will appear and break my context.
      If you have uncommitted work, committing it first is recommended. Go ahead?\" (ask in the language of the user)

  Only after approval, run it again like this:
     CR_ALLOW_EDIT=1 bash \"\$0\" \"$REQ\"

  (never add this variable without approval — that would defeat the gate.)"
  fi

  # ── response_path 검증 ────────────────────────────────────────
  # 🔴 이 경로는 감시에서 **제외**된다. 검증 없이 신뢰하면 "정상 산출물 제외"가 곧 감시 우회가 된다.
  #    요청서가 실수로(혹은 악의로) 코드 파일이나 루트 밖 경로를 지정하면 그 파일 변경이 묻힌다.
  #    그래서 규약 이름과 **정확히 일치**할 때만 통과시킨다.
  RESP_REL=${RESP#./}
  EXPECT="docs/codex_rescue/${STAMP}_response_${SLUG}.md"
  [ "$RESP_REL" = "$EXPECT" ] || die "response_path breaks the convention.
  expected: $EXPECT
  actual:   $RESP
  (stamp and slug must pair with the request, and the path must be relative to the root)"
fi

LOGD="docs/codex_rescue/.log"
mkdir -p -- "$LOGD" "$(dirname -- "$RESP_REL")" || die "cannot create the log/response directories"

# 🔴 원시 실행 기록이 실수로 커밋되는 것을 막는다 (2026-08-19).
# `.log/` 에는 명령 출력 전문·MCP 인자/결과·에이전트 메시지가 그대로 담긴다(실측: 한 실행의
# 86% 가 명령 출력이고 파일 하나가 464KB). 프로젝트 `.gitignore` 를 손대는 것은 남의 파일을
# 고치는 일이라, 대신 이 디렉토리 안에 자기 자신을 무시하는 `.gitignore` 를 둔다.
# 요청서·응답 md 는 `docs/codex_rescue/` 에 있으므로 영향받지 않는다 — 그건 기록으로 남겨야 한다.
[ -e "$LOGD/.gitignore" ] || printf '# codex_rescue raw run logs — never commit these.\n# They contain full command output, MCP arguments/results and agent messages.\n# The request/response .md files live one level up and ARE meant to be committed.\n*\n' > "$LOGD/.gitignore" 2>/dev/null

# ── 🟢 Codex 작업 폴더 `.scratch/` (2026-08-25 사용자 결정) ──────
#
# 왜 필요한가 — 예전 프롬프트는 "임시 파일·메모·테스트 파일도 금지"였다. 그런데 실측해 보니
# workspace-write 는 **cwd 와 /tmp 쓰기를 이미 허용**하고 있었다. 즉 권한이 막은 게 아니라
# **프롬프트가 스스로 족쇄를 채우고** 있었다. 그 결과 Codex 는 파형 정렬이나 로그 재집계 같은
# "파일이 필요한 계산"을 아예 시작하지 못하고 추론만 하다 결론에 못 갔다(2026-08-25 확인).
#
# 🔴 /tmp 가 아니라 여기로 유도하는 이유는 **기록 보존**이다. /tmp 는 사라져서 나중에
#    "무엇을 근거로 그렇게 판단했나"를 따질 수 없다. 여기 두면 남고, 커밋은 안 된다.
#
# 🔴 BEFORE 스냅샷보다 **먼저** 만들어야 한다. 나중에 만들면 이 디렉토리 생성 자체가
#    "Codex 가 만진 것"으로 보고된다.
#
# 🔴 여기에 **권위 데이터를 두지 마라.** marker·baseline·last_message 는 RUN_DIR(workspace 밖)에
#    그대로 둔다. `.log/` 를 "비권위 telemetry" 로 못박은 것과 같은 이유다 — 피감시자가 쓸 수 있는
#    곳에 감시 기준을 두면 안 된다.
SCRATCH_REL="docs/codex_rescue/.scratch"
mkdir -p -- "$SCRATCH_REL" || die "cannot create the scratch directory: $SCRATCH_REL"
[ -e "$SCRATCH_REL/.gitignore" ] || printf '# codex_rescue scratch — Codex 가 조사 중 만든 임시 산출물.\n# 판단 근거로 남기되 커밋하지는 않는다.\n# 요청/응답 .md 는 한 단계 위에 있고 그건 커밋 대상이다.\n*\n' > "$SCRATCH_REL/.gitignore" 2>/dev/null

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
  die "the same stamp ($STAMP) is already running — concurrent runs overwrite the response and logs.

  lock: $LOCK

  One of these:
   ① it really is running now      → wait until it ends
   ② left over from an abnormal exit → delete the lock file and run again

  To tell: look at the mtime of the lock. If it is minutes old and no codex process exists, it is ②."
fi

# ── 🔴 in-flight 복구 — FOLLOWUP 전용 (CHAT 과 같은 이유) ────────
#
# 1턴 CONSULT 는 Codex 가 응답 파일을 직접 써서 이 구간이 없었다. followup 은 **스크립트가**
# 문서에 append 하므로, codex 호출과 append 사이에 SIGKILL 이 들어오면 세션만 전진하고
# 문서는 옛 turns/thread_id 를 그대로 갖는다. 그대로 두면 다음 턴이 어긋난 세션을 재개한다.
# trap 으로는 못 막는다(SIGKILL 에 trap 이 안 걸린다) — 다음 실행이 흔적을 보고 복구한다.
INFLIGHT="$LOGD/.consult_${STAMP}.inflight"
if [ "$KIND" = followup ] && [ -f "$INFLIGHT" ]; then
  IF_WHEN=$(sed -n 's/^started=//p' "$INFLIGHT" 2>/dev/null | head -1)
  IF_TURN=$(sed -n 's/^turn=//p'    "$INFLIGHT" 2>/dev/null | head -1 | tr -d '\r')
  IF_RESP=$(sed -n 's/^resp=//p'    "$INFLIGHT" 2>/dev/null | head -1 | tr -d '\r')
  { [ -n "$IF_RESP" ] && [ -f "$IF_RESP" ]; } || die "in-flight marker cannot be attributed: $INFLIGHT
  It is unknown which document broke, so **nothing was touched.** Check the contents and delete it."
  if fm_set "$IF_RESP" thread_id "" && [ -z "$(fmf "$IF_RESP" thread_id)" ]; then
    {
      echo
      echo "## ⚠️ 스레드 끊김 · $(date '+%Y-%m-%d %H:%M:%S')"
      echo
      echo "지난 followup(${IF_TURN:-?}턴)이 codex 호출과 기록 사이에서 강제 종료됐다(마커: ${IF_WHEN:-시각 불명})."
      echo "Codex 세션에는 그 턴이 남았는데 이 문서에는 안 남아 맥락이 어긋났다 — 스레드를 폐기했다."
      echo "이 건은 더 이어붙일 수 없다. 새 CONSULT 로 시작해라."
    } >> "$IF_RESP"
    echo "⚠️ the last followup had died midway — thread discarded: $IF_RESP"
  else
    die "could not discard the thread of the previous run: $IF_RESP
  Left as is, the mismatched session would be resumed. Clear thread_id by hand."
  fi
  rm -f -- "$INFLIGHT" 2>/dev/null
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
  || { rm -f -- "$LOCK"; die "cannot create the run directory"; }

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
      cleanup; echo "codex_rescue: interrupted (signal received)" >&2; exit 130' HUP INT TERM
cr_cleanup "docs/codex_rescue" "$STAMP"   # 잠금·trap 뒤, 스냅샷 앞 — cr_cleanup 주석 참조
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
    { [ "$KIND" = review ] || [ "$MODE" = review ]; } && [ -n "$SCOPE" ] && printf ',"scope":"%s"' "$(jsan "$SCOPE${SCOPE_VAL:+:$SCOPE_VAL}")"
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
  SCAN | LC_ALL=C sort > "$BEFORE" || die "pre-run snapshot failed — not proceeding without change detection"
  [ -s "$BEFORE" ] || die "pre-run snapshot is empty — the scan did not work"
  [ "$IS_GIT" = 1 ] && git status --porcelain > "$RUN_DIR/git_before" 2>/dev/null
  : > "$MARKER" || die "cannot create the marker — no baseline for change detection"
fi

# ── Codex 에 넘기는 경로는 Windows 형식으로 바꾼다 ──────────────
# `winp` 와 `IS_WIN` 은 파일 상단에 정의돼 있다 — CHAT 경로가 그보다 먼저 쓰기 때문이다.
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
      uncommitted) SCOPE_HINT="Review the uncommitted changes (staged, unstaged, untracked)." ;;
      base)        SCOPE_HINT="Review the changes of the current branch against the '$SCOPE_VAL' branch." ;;
      commit)      SCOPE_HINT="Review the changes introduced by commit $SCOPE_VAL." ;;
      *)           SCOPE_HINT="" ;;
    esac
    PROMPT="${SCOPE_HINT}${SCOPE_HINT:+ }Answer in the language of the focus instruction below.

${FOCUS}"
    SCOPE_VIA=prompt
  else
    PROMPT=""
    SCOPE_VIA=flag
  fi
elif [ "$KIND" = followup ]; then
  FUP_W=$(winp "$FUP_ABS")         || exit 2
  RESP_W=$(winp "$ROOT/$RESP_REL") || exit 2
  # 🔴 quoted heredoc 이다 — 이유는 아래 CONSULT 쪽 주석과 같다 (2026-08-26).
  #    이 본문은 원래 백틱을 `\`` 로 이스케이프해서 버티고 있었다. 그 방식은 한 줄만
  #    놓쳐도 조용히 터지고, 실제로 CONSULT 히어독에서 **같은 히어독 안 16줄 차이로**
  #    한 줄은 지키고 한 줄은 놓쳐 자격증명 금지 문구가 통째로 날아갔다.
  #    여기서 날아가면 "## Claude 검토 를 읽어라"가 사라진다 — 되묻기의 작동 원리 자체다.
  read -r -d '' PROMPT <<'EOF' || :
This continues the same problem. Claude has reviewed your analysis from the previous turn and is asking back.

Follow-up file: __CR_FUP_W__
Conversation so far (your text + Claude's reviews): __CR_RESP_W__

Read both files first — especially the `## Claude 검토` sections of the response document.
**That is where you see how your analysis was read.**

🔴 Must follow:
- **Do not create, modify or delete any file. Only read.**
  This turn runs read-only, and your answer is collected automatically from your final message.
  Do not try to write the response document yourself — the script appends it for you.
- **If Claude's reading differs from what you meant, correct that first.** That is why this turn exists.
  Say it explicitly: "you read X, but I meant Y".
- **Re-judge rejected points on their grounds.** If you accept, say so; if the grounds are wrong,
  explain why. Neither back down nor dig in — decide by the evidence.
- For each item of the completion gate in the follow-up file, **judge met / not met yourself.**
  This conversation ends not "when there is nothing more to ask" but **"when the core symptom is explained."**
- Answer in the language the follow-up file itself is written in (not that of any quoted code or logs).
EOF
  # ── EDIT 되묻기(`edit: yes`)는 위 read-only 프롬프트를 통째로 갈아끼운다 (2026-09-15) ──
  #    "아무 파일도 고치지 마라"가 남은 채 수정 지시를 덧붙이면 Codex 가 둘 중 하나를 버린다.
  #    응답 문서는 여전히 스크립트가 이어 붙인다 — 1턴 원문과 Claude 검토를 Codex 가 덮지 못하게.
  #    그래서 중간 저장은 턴별 수정 기록 파일로 받는다.
  if [ "$FUP_EDIT" = 1 ]; then
    EDITLOG_W=$(winp "$ROOT/$EDITLOG_REL") || exit 2
    read -r -d '' PROMPT <<'EOF' || :
This continues the same case. You edited code in the previous turn; Claude reviewed it and asks for **further edits**.

Follow-up file: __CR_FUP_W__
Conversation so far (your text + Claude's reviews): __CR_RESP_W__

Read both files first — especially the `## Claude 검토` sections of the response document.
**That is where you see how your edits were read.**

🔴 This turn edits code. The boundaries:
- **Make only the edits the follow-up file asks for.** Do not touch production files outside that target.
- **Do not write the response document yourself.** The script appends your final message.
- Investigation and verification are free — read the disk, query the network, run commands (network is read-only).
  Put temporary files for reproduction and verification inside __CR_SCRATCH_REL__/. That is your workbench.
  🔴 **Do not scatter backups or test files next to the files you edit** — all of them are reported as unauthorized changes.
- 🔴 **Each time you edit a file, write it down right away in the edit log below.** This run can be cut off midway by the usage limit.
  Written only once at the end, nobody knows what you changed when it is cut — the code is left half-changed.
  Create that file before editing, write `## 변경한 파일·라인` first, then append on every edit.
    Edit log: __CR_EDITLOG_W__
- **If Claude's reading differs from what you meant, correct that first.**
- If you are not sure, **do not edit** — write down why you are not sure.
  Nobody is here to press approve in this run (approval_policy=never) — "ask first" is not possible.

When done, report in your final message in this order, keeping these labels exactly as written and writing the rest
in the language the follow-up file itself is written in (not that of any quoted code or logs):
1. 변경한 파일·라인
2. 무엇을 왜 바꿨나 (before → after)
3. 빌드·검증 방법과 실제로 돌려 본 결과
4. 남은 리스크·확신도
EOF
    PROMPT=${PROMPT//__CR_EDITLOG_W__/"$EDITLOG_W"}
    PROMPT=${PROMPT//__CR_SCRATCH_REL__/"$SCRATCH_REL"}
  fi
  PROMPT=${PROMPT//__CR_FUP_W__/"$FUP_W"}
  PROMPT=${PROMPT//__CR_RESP_W__/"$RESP_W"}

elif [ "$MODE" = "review" ]; then
  # ── 🟢 끼어들기 리뷰 프롬프트 (2026-09-15) ──────────────────────
  #    판정 기준은 Codex 공식 rubric 원문(prompts/review_rubric.md)을 그대로 싣는다.
  #    출력 형식만 우리 것이다 — 원본은 끝에 JSON 한 덩어리를 내라고 하는데, 그러면
  #    한도로 끊길 때 아무것도 안 남는다. 발견할 때마다 응답 문서에 적게 한다.
  #    경계는 CONSULT 와 같다: 코드 수정 금지, 쓸 곳은 응답 문서와 작업대 두 곳.
  RUBRIC_FILE="$SELF_DIR/prompts/review_rubric.md"
  [ -s "$RUBRIC_FILE" ] || die "review rubric file not found: $RUBRIC_FILE
  Reinstall the skill (the prompts/ directory comes with it)."
  RUBRIC=$(cat "$RUBRIC_FILE") || die "cannot read the review rubric file: $RUBRIC_FILE"
  read -r -d '' PROMPT <<'EOF' || :
Read the request file below and code-review the target it names.

Request: __CR_REQ_W__

You are an **independent reviewer** of a change another engineer made. The criteria are the `Review guidelines` at the end of this prompt.
Pull the change yourself with the request's "확인 명령" (check commands), and open the source files the changed code reaches.
Do not judge from diff fragments alone — "provable impact" needs the callers and callees opened.

🔴 There is **one** line to hold — do not modify production files.

- **Do not edit code.** You give findings and evidence only. Claude does the actual fixing.
- You may write in **exactly two places**:
    ① the response document the request names
    ② __CR_SCRATCH_REL__/    ← your workbench
  Do not create, modify or delete files outside these two. Commands that change repository state are forbidden too
  (git commit, checkout, stash, reset, add, package installs, commands that leave build output in the workspace).
- You may run tests and reproduction scripts on the workbench. If a finding can be **confirmed by running it**, do so.
- **You may use the network** — to check library docs, issues and release notes. **Read-only** (no POST/PUT, git push, publish).
  🔴 **You may read credentials, but never copy their values.** Connecting to a DB or service with the settings in `.env` and the like is allowed.
     But never leave passwords, tokens or key values in the response document, the workbench or command output (the response document goes to a remote via git).
     Do not use commands that print values (`cat .env` etc.); if unavoidable, mask them.
- Nobody is here to press approve in this run (approval_policy=never). If blocked, work around it with the allowed means,
  and whatever you still could not see, **say you could not see it.** Never pretend to have checked what you did not.

- 🔴 **Create the response document when you start the review, and fill it as you go.** This run can be cut off midway by the usage limit.
  Written only once at the end, the whole review vanishes the moment it is cut.
  ① Before opening any code, save the frontmatter (type: codex_response / mode: review / stamp / slug / author: codex) and
     `## 0. 리뷰 계획` (the list of changed files and the order you will read them in) first
  ② Each time a finding is settled, append it right away under `## 1. 지적`. Format:
       ### [P0~P3] <title within 80 characters>
       - 위치: <file>:<start line>-<end line>   (the shortest range overlapping the diff)
       - 확신도: <0.0~1.0>
       <one paragraph — why it is a bug, which input or environment triggers it, what the severity depends on>
  ③ After reading everything, write `## 2. 전체 판정` last —
     `patch is correct` or `patch is incorrect` · 1–3 sentences of grounds · confidence (0.0~1.0)
  If there are no findings, write "없음" under `## 1. 지적`. Do not invent any.
- Keep the section headings and field labels above exactly as written; write everything else in the language the request itself is written in (not that of any quoted code or logs).
- If saving fails, print the same content as your final message. It is collected automatically.

────────────────────────────────────────────────────────────
__CR_RUBRIC__
EOF
  PROMPT=${PROMPT//__CR_REQ_W__/"$REQ_W"}
  PROMPT=${PROMPT//__CR_SCRATCH_REL__/"$SCRATCH_REL"}
  PROMPT=${PROMPT//__CR_RUBRIC__/"$RUBRIC"}

elif [ "$MODE" = "edit" ]; then
  # 🔴 quoted heredoc 이다 (2026-08-26). 지금 이 본문에는 백틱이 없어 사고가 안 났을 뿐,
  #    구조는 CONSULT 히어독과 똑같다. **EDIT 은 Codex 가 실제로 코드를 고치는 모드**라,
  #    "대상 파일 외에는 건드리지 마라" 같은 제약 문장이 조용히 비면 손실이 파일 단위다.
  #    마크다운 한 줄을 더 쓰는 순간 터지는 자리라 미리 막는다.
  read -r -d '' PROMPT <<'EOF' || :
Read the request file below and follow the instructions in it exactly.

Request: __CR_REQ_W__

- The request names the path and file name for your report. Save it at that path under that exact name.
- Do not touch files other than the targets the request names.
- But **investigation and verification are free** — read the disk, query the network, run commands (network is read-only).
  Put temporary files for reproduction and verification inside __CR_SCRATCH_REL__/. That is your workbench.
  🔴 **Do not scatter backups or test files next to the files you edit** — all of them are reported as unauthorized changes.
- If saving fails, print the same content as your final message. It is collected automatically.
- 🔴 **Each time you edit a file, write it down in the report right away.** This run can be cut off midway by the usage limit.
  Written only once at the end, nobody knows what you changed when it is cut — the code is left half-changed.
  Before editing, create the report frontmatter and `## 1. 변경한 파일·라인` first, then append on every edit.
- Keep the section headings the request asks for exactly as written; write everything else in the language the request itself is written in (not that of any quoted code or logs).
EOF
  PROMPT=${PROMPT//__CR_REQ_W__/"$REQ_W"}
  PROMPT=${PROMPT//__CR_SCRATCH_REL__/"$SCRATCH_REL"}
else
  # ── 🔴 quoted heredoc 이다 — 백틱을 셸이 삼키지 않게 (2026-08-26) ─────────
  #
  # 예전에는 `<<EOF`(따옴표 없음) 였다. 그래서 본문의 **마크다운 백틱이 명령 치환으로
  # 해석**됐고, 자격증명 금지 목록(.env·credentials·auth.json)이 프롬프트에서 통째로
  # 사라진 채 Codex 에게 갔다. 실행 로그에 `.env: command not found` 로 찍혀 있었는데
  # 아무도 안 봤다. **보안 지시문이 조용히 비어 나가고 있었다.**
  #
  # 🔴 백틱만 이스케이프하는 방식으로 고치지 마라. 다음에 마크다운을 한 줄 더 쓰는 순간
  #    같은 사고가 다시 난다. **본문은 리터럴로 두고 변수만 아래에서 후주입한다.**
  read -r -d '' PROMPT <<'EOF' || :
Read the request file below and follow the instructions in it exactly.

Request: __CR_REQ_W__

You are the **independent investigator** of this case. The request is a starting point, not a boundary.
Claude already failed to find the answer with the material in it. Reading the same material the same way gives the same conclusion.

🔴 There is **one** line to hold — do not modify production files.

- **Do not edit code.** You only analyze, diagnose and propose fixes. Claude does the actual fixing.
- You may write in **exactly two places**:
    ① the response document the request names
    ② __CR_SCRATCH_REL__/    ← your workbench
  Do not create, modify or delete files outside these two. Commands that change repository state are forbidden too
  (git commit, checkout, stash, reset, package installs, builds).

Any other investigation is **not restricted. Dig to the end.**
- **Open the sources yourself.** You may read anywhere on disk — reading outside the workspace is allowed too.
  Do not trust only the excerpts quoted in the request. **When a summary and the source disagree, the source wins.**
- **Run the calculations, sorting, parsing and re-aggregation yourself.** You may write and run scripts. Do not guess numbers — extract them.
  Put their outputs (scripts, intermediate data, notes) on the workbench above **freely** — there is no limit on count or size,
  and you do not need to delete them. Leaving them lets Claude reproduce your calculations, which is better.
- **You may use the network** — search docs, issues and release notes and check them yourself.
  But it is **read-only.** Never upload data anywhere (no POST/PUT, git push, publish).
  🔴 **You may read credentials when the investigation needs them. But never copy their values.** (user decision, 2026-09-16)
     Connecting to a DB with the settings in `.env` and the like to query the source is allowed — prefer the commands the request gives
     (ways that load values without showing them, like `node -r dotenv/config`).
     Never leave passwords, tokens or key values **in the response document, the workbench or command output.** The response document goes to a remote via git.
     Do not use commands that print values (`cat .env`, `echo $DB_PASSWORD` etc.); if unavoidable, mask them.
- Claude's hypotheses are reference material. **Drop them if wrong.** Do not spend all your time verifying them —
  a hypothesis may be meaningless altogether. If the source points elsewhere, follow it there.
- "The existing analysis method failed" **does not mean "do not look at that data again."**
  Analyzing the same source a different way is always allowed, and usually that is the answer.

🔴 **Do not give up when blocked.** Nobody is here to press approve in this run (approval_policy=never).
   If it looks like you need permission, do not wait — work around it with the allowed means above and finish the investigation.
   If you still cannot, state in the response **what was blocked and what you could not confirm.**
   Never pretend to have checked what you did not.

🔴 **Do not end with "please send more material" while material you can open now is left unopened.**
   Anything with a path in the request, or findable in the workspace, you open yourself.
   Only listing with `ls` or `find` is not opening — it counts as opened once you have read the content and done the calculations.

- The request names the path and file name for the response. Save it at that path under that exact name.
- If saving fails, print the same content as your final message. It is collected automatically.
- 🔴 **Create the response document when you start the investigation, and fill it as you go.** This run can be cut off midway by the usage limit.
  Written only once at the end, the whole investigation vanishes the moment it is cut.
  ① Before opening any source, save the frontmatter and `## 0. 조사 계획` (what you will open, in what order) first
  ② Each time you open and check a source, append the confirmed facts right away under `## 1. 내가 직접 연 원본`
  ③ Write the remaining sections (the conclusions: cause, verdict, fix and so on) last, after the investigation.
     Do not write conclusions before the facts — a conclusion written first drags the investigation along.
- Keep the section headings the request asks for exactly as written; write everything else in the language the request itself is written in (not that of any quoted code or logs).
EOF
  # 🔴 위 히어독이 quoted 라 변수가 확장되지 않는다. 여기서 넣는다.
  #    값이 셸 코드로 재해석되지 않으므로 경로에 백틱·`$`·공백이 있어도 안전하다.
  #    (백슬래시를 그대로 담는 Windows 경로가 들어오는 자리라 이 성질이 필요하다)
  PROMPT=${PROMPT//__CR_REQ_W__/"$REQ_W"}
  PROMPT=${PROMPT//__CR_SCRATCH_REL__/"$SCRATCH_REL"}
fi

if [ "$KIND" = review ]; then
  # 🔴 `codex exec review` 에는 `-s`(샌드박스)도 `-C`(작업 디렉토리)도 **없다.**
  #    항상 read-only 이고 cwd 를 기준으로 돈다. 이미 ROOT 로 cd 했으므로 cwd 가 맞다.
  #    `-c` · `--json` · `-o` 는 지원하므로 기존 배관(샌드박스 우회·이벤트 로그·응답 회수)이 그대로 산다.
  SANDBOX="read-only (fixed for review)"
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
elif [ "$KIND" = followup ]; then
  # 🔴 `codex exec resume` 에는 `-s`(샌드박스)도 `-C`(작업 디렉토리)도 **없고**,
  #    첫 턴의 샌드박스를 **상속하지도 않는다**(2026-08-22 CHAT 에서 실측 — 실제로 쓰기가 뚫렸다).
  #    `-c` 는 resume 도 받으므로 config 오버라이드로 강제한다.
  #
  # 🔴 이 오버라이드를 빼지 마라. 빼면 이 건이 각 머신 config.toml 기본값으로 떨어지고,
  #    mode:readonly 요청의 followup 이 CR_ALLOW_EDIT 게이트를 우회한다.
  #
  # 2턴부터 Codex 가 파일을 쓸 이유가 없다 — 응답 문서는 **스크립트가** `-o` 회수분으로
  # 이어 붙인다. 그래서 read-only 고정이 가능하고, 동시에 1턴 원문이 훼손될 수 없다.
  # cwd 는 이미 ROOT 다(위 `cd "$ROOT"`) — 그래서 `-C` 없이도 맞다.
  if [ "$FUP_EDIT" = 1 ]; then
    # EDIT 되묻기(`edit: yes` + CR_ALLOW_EDIT) 만 쓰기를 푼다 (2026-09-15). 위 검증을 통과해야 여기 온다.
    # 네트워크는 1턴 EDIT 와 같은 규칙이다(CR_NETWORK=false 로 끈다).
    SANDBOX_RAW=workspace-write
    SANDBOX="workspace-write (EDIT follow-up · -c sandbox_mode)"
    set -- codex exec resume "$THREAD" --skip-git-repo-check --json \
           -c sandbox_mode="workspace-write" -o "$LASTMSG_W"
    if [ "${CR_NETWORK:-true}" != "false" ]; then
      set -- "$@" -c "sandbox_workspace_write.network_access=true"
      SANDBOX="$SANDBOX +net"
    fi
  else
    SANDBOX="read-only (fixed for followup · -c sandbox_mode)"
    set -- codex exec resume "$THREAD" --skip-git-repo-check --json \
           -c sandbox_mode="read-only" -o "$LASTMSG_W"
  fi

else
  # 🔴 `$SANDBOX` 는 아래에서 " +net" 이 덧붙어 **표시용 문자열**이 된다. 그래서 실제 인자로
  #    넘길 순수 값을 따로 보존한다 — 끼어들기 경로(§ CR_LIVE_STEER)의 `--sandbox` 가 이 값을
  #    쓴다. `$SANDBOX` 를 그대로 넘기면 `workspace-write +net` 이 가서 중계기가 거부한다.
  SANDBOX_RAW="${CR_SANDBOX:-workspace-write}"
  SANDBOX="$SANDBOX_RAW"
  set -- codex exec --skip-git-repo-check --json -s "$SANDBOX_RAW" -C "$ROOT_W" -o "$LASTMSG_W"

  # ── 🟢 네트워크 해금 (2026-08-25 사용자 결정) ────────────────────
  #
  # 실측(2026-08-25): workspace-write 가 실제로 막고 있던 것은 **네트워크 하나뿐**이었다.
  # 디스크 전체 읽기(`:root` read)와 cwd·/tmp 쓰기는 이미 열려 있었다.
  #   · read  outside cwd : 허용 (C:\Windows\win.ini 읽기 성공)
  #   · write outside cwd : 거부      · <cwd>/.git 쓰기 : 거부
  #   · network           : 거부 (127.0.0.1:9 proxy 로 막힌다)  ← 이것만 열면 된다
  #
  # 🔴 exec 에서는 approval_policy 가 never 로 **고정**된다(실측: -c approval_policy=on-request
  #    를 줘도 rollout 은 never). 막혔을 때 승인을 눌러 줄 사람이 없어 Codex 는 그냥 포기한다.
  #    그래서 필요한 권한은 미리 준다 — 이게 CONSULT 가 결론에 못 간 구조적 이유의 일부다.
  #
  # 🔴 read-only 에는 붙이지 않는다. `sandbox_workspace_write.*` 는 거기서 아무 효력이 없고,
  #    보고문에 "네트워크 허용"이라는 거짓 인상만 남긴다.
  #
  # ⚠️ 위험: 디스크 전체 읽기가 이미 열려 있으므로, 네트워크가 열리면 **읽기와 전송이 결합**된다.
  #    프롬프트로 "조회 전용·업로드 금지"를 지시하지만 그건 준수에 의존하는 층이다.
  #    실효 방어는 `.log/<스탬프>_events.jsonl` 사후 감사다. 끄려면 CR_NETWORK=false.
  if [ "$SANDBOX" != "read-only" ] && [ "${CR_NETWORK:-true}" != "false" ]; then
    set -- "$@" -c "sandbox_workspace_write.network_access=true"
    SANDBOX="$SANDBOX +net"
  fi
fi
[ -n "${CR_MODEL:-}" ] && set -- "$@" -m "$CR_MODEL"
[ -n "${CR_EFFORT:-}" ] && set -- "$@" -c model_reasoning_effort="$CR_EFFORT"

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
  die "CR_TIMEOUT was removed — measured not to work on Windows (2026-08-17).

  Do this instead:
   · Claude runs this script in the background, so a long run does not block the conversation
   · if it really must stop, the user ends the codex process directly
     Windows: codex.exe in Task Manager   ·   Linux: pkill -f 'codex exec'

  Remove CR_TIMEOUT and run again."
fi

# ── 🔴 표시용 샌드박스 — 끼어들기 경로도 exec 와 같은 권한으로 돈다 (2026-08-26 개정) ──
#
# 예전에는 아래 실행부(§ CR_LIVE_STEER)가 중계기에 `--sandbox read-only` 를 **고정**으로
# 넘겼다. 그런데 끼어들기가 CONSULT 의 기본값이 되면서(2026-08-26), 그 고정이
# **2026-08-25 에 의도적으로 연 `.scratch/` 작업 권한을 하루 만에 도로 닫아 버렸다.**
# CONSULT 3회 실패의 원인이 "조사 권한 부족"이라고 결론 내고 연 것인데, 같은 제약이
# 조용히 되살아난 것이다 — 실제로 Codex 가 "샌드박스가 쓰기를 차단해 거부됐다"고 보고했다.
#
# 그래서 exec 경로와 같은 값(`$SANDBOX_RAW`)을 넘긴다. 중계기는 `read-only` 와
# `workspace-write` 를 모두 받는다(live-consult.mjs:469-472 → thread/start 의 sandbox).
#
# 🔴 `$SANDBOX` 를 그대로 넘기지 마라. 아래 네트워크 블록에서 " +net" 이 덧붙어
#    표시용 문자열이 되므로 중계기가 USAGE 로 거부한다. 순수 값은 `$SANDBOX_RAW` 다.
#
# 🔴 `$SANDBOX` 자체는 건드리지 않는다. 경고 출력·검증 로직이 그 값을 쓰고 있고,
#    여기서 바꾸면 그쪽 판정까지 흔든다. **표시만 가른다.**
# ── 🔴 전역 WebSocket 능력 판정 (2026-08-26) ──────────────────────────────
#
# 중계기는 Node 의 **전역 WebSocket** 을 쓴다 (`ws` npm 모듈은 번들하지 않는다).
# 실측한 지형은 이렇다:
#
#   Node 22 · 24    기본 제공                        → 플래그 불필요
#   Node 20.18/20.19  --experimental-websocket 로 열림 → 플래그 필요
#   Node 18.20      플래그 자체가 없다 (bad option)    → 이 경로를 못 쓴다
#
# 🔴 **버전 문자열로 판정하지 마라. 능력을 직접 재라.** 배포판마다 백포트가 다르고,
#    버전 비교는 20.9 / 20.10 같은 경계에서 조용히 틀린다. 두 번 재는 비용은 수십 ms 다.
#
# 🔴 이 판정을 빼면 Node 20 서버에서 **CONSULT 자체가 죽는다.** 끼어들기가 기본 ON 이라
#    중계기가 항상 호출되는데, 거기서 나는 실패는 종료 코드 10 이고 10 은 자동 폴백 금지다.
#    (2026-08-26 서버 4대 중 3대가 이 상태였다 — 배포 후에야 발견했다)
NODE_WS_FLAG=""
NODE_WS_OK=0
if command -v node >/dev/null 2>&1; then
  if node -e 'process.exit(typeof WebSocket === "undefined" ? 1 : 0)' 2>/dev/null; then
    NODE_WS_OK=1
  elif node --experimental-websocket -e 'process.exit(typeof WebSocket === "undefined" ? 1 : 0)' 2>/dev/null; then
    NODE_WS_OK=1
    NODE_WS_FLAG="--experimental-websocket"
  fi
fi

# 끼어들기 경로에 태우는 모드 (2026-09-15 확장: CONSULT 만 → CONSULT · EDIT · REVIEW).
# 2026-09-17: FOLLOWUP(되묻기)도 탄다 — 중계기가 `thread/resume` 으로 같은 대화를 잇는다.
#   무거운 모델로 되묻다 한도에 걸리기 전에 "지금까지로 마무리해라"를 넣을 길이 없었다.
# CHAT 은 여전히 `codex exec resume` 경로라 여기 들어오지 않는다.
LIVE_MODE_OK=0
[ "$KIND" = doc ] && case "$MODE" in readonly|edit|review) LIVE_MODE_OK=1 ;; esac
[ "$KIND" = followup ] && LIVE_MODE_OK=1

LIVE_STEER_ON=0
if [ "${CR_LIVE_STEER:-}" = "1" ] && [ "$LIVE_MODE_OK" = 1 ] && [ "$NODE_WS_OK" = 1 ]; then
  LIVE_STEER_ON=1
fi

# 끼어들기 경로의 네트워크 — exec 경로와 같은 규칙이다 (2026-09-15).
# 예전에는 이 경로에만 네트워크 인자가 안 넘어가서, 프롬프트는 "네트워크 써도 된다"는데 실제로는 막혀 있었다.
LIVE_NET=0
[ "$LIVE_STEER_ON" = 1 ] && [ "${SANDBOX_RAW:-read-only}" = workspace-write ] \
  && [ "${CR_NETWORK:-true}" != "false" ] && LIVE_NET=1

# 🔴 못 쓰는 이유를 반드시 말한다. 조용히 옛 경로로 떨어지면, 사용자는 도중에 말을 걸었다가
#    전달이 안 되는 것을 그때서야 알게 된다. 그 시점엔 이미 늦다.
if [ "$LIVE_STEER_ON" != 1 ] && [ "${CR_LIVE_STEER:-}" = "1" ] && [ "$LIVE_MODE_OK" = 1 ]; then
  if [ "$NODE_WS_OK" != 1 ]; then
    echo "⚠️  live steering is not available for this run — this Node has no global WebSocket." >&2
    echo "    Use Node 22+, or Node 20.10+ with --experimental-websocket." >&2
    echo "    now: $(node -v 2>/dev/null || echo 'no node') · running on the old exec path." >&2
  fi
fi
if [ "$LIVE_STEER_ON" = 1 ]; then
  if [ "$LIVE_NET" = 1 ]; then
    SANDBOX_SHOWN="${SANDBOX_RAW} +net (live-steer path · turn/start sandboxPolicy)"
  else
    SANDBOX_SHOWN="${SANDBOX_RAW:-read-only} (live-steer path · no network)"
  fi
else
  SANDBOX_SHOWN="$SANDBOX"
fi

# 끼어들기 경로에서만 프롬프트 끝에 붙는 안내. 예전에는 중계기 내장 CONSULT 프롬프트 끝에 있었다 —
# 프롬프트를 send.sh 한 곳에서 만들게 되면서 여기로 옮겼다(2026-09-15). 문구는 그대로다.
LIVE_NOTE="── note for this run only ─────────────────────────────────────
Extra instructions may arrive while this turn runs (the user is watching).
When one arrives, **do not restart the command you were running** — carry on and apply it."

if [ -n "${CR_DRYRUN:-}" ]; then
  echo "── DRYRUN — not running ──"
  echo "kind     : $KIND"
  echo "root     : $ROOT"
  echo "mode     : $MODE / sandbox: $SANDBOX_SHOWN"
  echo "model    : ${CR_MODEL:-(codex config)} / reasoning: ${CR_EFFORT:-(codex config)}"
  { [ "$KIND" = review ] || [ "$MODE" = review ]; } && echo "review target: $SCOPE ${SCOPE_VAL:+($SCOPE_VAL)} — given by: $SCOPE_VIA"
  echo "response : $RESP_REL (existed before the run: $RESP_EXISTED)"
  [ -n "$EDITLOG_REL" ] && echo "edit log : $EDITLOG_REL   (EDIT follow-up — Codex writes it on every edit)"
  echo "run dir  : $RUN_DIR"
  if [ "$LIVE_STEER_ON" = 1 ]; then
    echo "path     : live steer (app-server) — the prompt below goes to the bridge via --prompt-file"
    echo "bridge   : --sandbox ${SANDBOX_RAW:-read-only}$([ "$LIVE_NET" = 1 ] && printf ' --network')${CR_MODEL:+ --model $CR_MODEL}${CR_EFFORT:+ --effort $CR_EFFORT}"
    [ "$KIND" = followup ] && echo "resume   : --resume-thread $THREAD --turn-seq $FUP_TURN   (original request: $PARENT_REQ)"
    printf '(on the old path): '; printf '%q ' "$@"; echo
  else
    echo "path     : codex exec"
    printf 'command  : '; printf '%q ' "$@"; echo
  fi
  echo "── prompt ──"; printf '%s\n' "${PROMPT:-(none — codex default review)}"
  [ "$LIVE_STEER_ON" = 1 ] && printf '\n%s\n' "$LIVE_NOTE"
  if [ "$REVIEW_REQ_AUTO" = 1 ]; then
    echo "── auto-generated request ($REQ) — shown and deleted because of DRYRUN ──"
    cat -- "$REQ_ABS"
    rm -f -- "$REQ_ABS"
  fi
  exit 0
fi

if [ "$KIND" = review ]; then
  echo "→ Codex reviewing… (target: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL})" >&2
else
  echo "→ Codex running… (request: $REQ / sandbox: $SANDBOX_SHOWN)" >&2
  [ -n "${CR_MODEL:-}${CR_EFFORT:-}" ] && echo "   model: ${CR_MODEL:-(config)} / reasoning: ${CR_EFFORT:-(config)}" >&2
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
# 🔴 followup 은 로그를 **덮지 않고 이어 붙인다.** 확장(claudeStateBar)은 events.jsonl 의
#    size/mtime 변화를 "re-run" 으로 보고 캐시를 버린 뒤 처음부터 다시 파싱한다 — 그래서
#    append 하면 카드 하나가 대화 전체를 담는다. 덮어쓰면 **1턴 이벤트가 사라지는데**,
#    그건 STRAY 가 잡혔을 때 "Codex 가 실제로 뭘 했나"를 대조하는 유일한 근거다.
#    stderr·last_message 는 턴별로 나눈다(어느 턴의 실패인지 구분해야 한다).
if [ "$KIND" = followup ]; then
  TEE_MODE=-a
  ERR_DEST="$LOGD/${STAMP}_t${FUP_TURN}_stderr.log"
  LAST_DEST="$LOGD/${STAMP}_t${FUP_TURN}_last_message.md"
  # 🔴 codex 를 부르기 **전에** 마커를 남긴다 — 위 in-flight 복구의 나머지 절반이다.
  { printf 'started=%s\npid=%s\nturn=%s\nthread=%s\nresp=%s\n' \
      "$(date '+%Y-%m-%dT%H:%M:%S')" "$$" "$FUP_TURN" "$THREAD" "$ROOT/$RESP_REL"; } \
    > "$INFLIGHT" 2>/dev/null
else
  TEE_MODE=""
  ERR_DEST="$LOGD/${STAMP}_stderr.log"
  LAST_DEST="$LOGD/${STAMP}_last_message.md"
fi

# ── 🔴 실행 중 끼어들기 경로 (CR_LIVE_STEER=1 — CONSULT·EDIT·REVIEW 1턴 + FOLLOWUP) ────────
#
# (범위 변천: 08-25 CONSULT 1턴 → 09-15 EDIT·REVIEW → 09-17 FOLLOWUP. 아래 첫 문단은 처음 좁힌 이유다.)
#
# `codex exec` 에는 도는 중인 턴에 말을 넣을 방법이 없다. `codex app-server` 의 `turn/steer`
# 가 그것을 하며, 하던 작업을 버리지 않고 다음 모델 경계에서 반영한다(2026-08-25 실측 3회).
#
# 🔴 범위를 CONSULT 1턴으로 좁힌 것은 의도다. FOLLOWUP·REVIEW·EDIT·CHAT 은 각자 검증된
#    배관이 있고, 그것까지 한 번에 갈아타면 회귀 범위가 통째로 열린다.
#    (Codex 자문 2026-08-25: "첫 구현은 CONSULT 1턴에만 feature flag 로")
#
# 🔴 중계기는 **transport 만** 한다. 요청서 검증·lock·heartbeat·status·변경 감지·EDIT 게이트·
#    응답 회수·in-flight 복구는 전부 이 스크립트에 그대로 남는다. 중계기에 `--log-dir` 을
#    주지 않는 이유가 그것이다 — status/heartbeat 를 두 곳에서 쓰면 서로 덮는다.
#
# 응답 문서는 Codex 가 아니라 이 스크립트가 만든다. 중계기가 최종 메시지를 `$LASTMSG` 에
# 남기면 아래 회수 구간이 REVIEW·FOLLOWUP 과 같은 경로로 처리한다. 그래서 read-only 로 돈다.
LIVE_BRIDGE=""
# 🔴 판정은 위에서 한 번 한 `LIVE_STEER_ON` 하나로 한다 (2026-08-26).
#    예전에는 같은 조건식이 여기에만 있고 표시부는 `$SANDBOX` 를 그냥 찍어서,
#    **보고문이 실제 샌드박스와 어긋나도 아무도 몰랐다.** 조건을 두 군데 두지 마라.
if [ "$LIVE_STEER_ON" = 1 ]; then
  _SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  LIVE_BRIDGE="$_SELF_DIR/scripts/live-consult.mjs"
  [ -f "$LIVE_BRIDGE" ] || die "CR_LIVE_STEER=1 but the bridge is missing: $LIVE_BRIDGE
  Reinstall the skill (the scripts/ directory comes with it)."
  command -v node >/dev/null 2>&1 || die "CR_LIVE_STEER=1 needs node."
fi

if [ -n "$LIVE_BRIDGE" ]; then
  echo "→ running on the live-steer path (app-server) — conversation key: $STAMP" >&2
  # 🔴 `$LIVE_EVENTS` 에 직접 쓰고 끝나서 `$EVENTS` 로 복사한다. tee 파이프라인을 흉내내는
  #    것인데, 파이프가 아니라 단일 프로세스라 PIPESTATUS 가 성립하지 않기 때문이다.
  # $NODE_WS_FLAG 는 따옴표 없이 편다 — 빈 값일 때 빈 인자가 생기면 안 된다.
  # 값은 위에서 이 스크립트가 정한 리터럴 하나뿐이라 분할 위험이 없다.
  # 프롬프트는 여기서 만든 것을 파일로 넘긴다(2026-09-15) — 모드별 프롬프트를 send.sh 한 곳에서 관리한다.
  # RUN_DIR 은 workspace 밖이라 Codex 가 고칠 수 없다. 긴 한글을 argv 로 넘기지 않는 이유는 중계기 steer 와 같다.
  LIVE_PROMPT="$RUN_DIR/prompt.txt"
  printf '%s\n\n%s\n' "$PROMPT" "$LIVE_NOTE" > "$LIVE_PROMPT" || die "cannot write the prompt file: $LIVE_PROMPT"
  # 되묻기(2026-09-17) — 새 대화 대신 응답 문서의 thread_id 를 잇는다. 턴 번호는 진행 패널 항목 id 용이다.
  # 되묻기에는 요청서가 없다(`$REQ_ABS` 가 비어 있다). 중계기는 요청서에서 카드 제목(subject·slug)만 읽으므로
  # 원 요청서를 준다 — 위 검증에서 존재를 확인했다.
  LIVE_EXTRA=()
  LIVE_REQ="${REQ_ABS:-}"   # set -u — 되묻기에서는 정의되지 않는다
  if [ "$KIND" = followup ]; then
    LIVE_EXTRA=(--resume-thread "$THREAD" --turn-seq "$FUP_TURN")
    LIVE_REQ="$ROOT/$PARENT_REQ"
  fi
  # shellcheck disable=SC2086
  node $NODE_WS_FLAG "$LIVE_BRIDGE" run \
    --prompt-file "$LIVE_PROMPT" \
    $([ "$LIVE_NET" = 1 ] && printf -- '--network') \
    "${LIVE_EXTRA[@]}" \
    --request-file "$LIVE_REQ" \
    --events-file "$LIVE_EVENTS" \
    --last-message-file "$LASTMSG" \
    --appserver-log "$LOGD/${STAMP}_appserver.jsonl" \
    --steers-log "$LOGD/${STAMP}_steers.jsonl" \
    --stamp "$STAMP" \
    --cwd "$ROOT" \
    --sandbox "${SANDBOX_RAW:-read-only}" \
    ${CR_MODEL:+--model "$CR_MODEL"} \
    ${CR_EFFORT:+--effort "$CR_EFFORT"} \
    2>"$ERRLOG"
  RC=$?
  TEE_RC=0
  cp -f -- "$LIVE_EVENTS" "$EVENTS" 2>/dev/null || :
elif [ -n "$PROMPT" ]; then
  "$@" "$PROMPT" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
  # 🔴 PIPESTATUS 는 **바로 다음 명령**에서 배열째 복사해야 한다. 다른 명령이 하나라도 끼면 덮인다.
  PIPE_RC=("${PIPESTATUS[@]}")
  RC=${PIPE_RC[0]}
  TEE_RC=${PIPE_RC[1]:-0}
else
  "$@" 2>"$ERRLOG" | tee $TEE_MODE -- "$LIVE_EVENTS" > "$EVENTS"
  PIPE_RC=("${PIPESTATUS[@]}")
  RC=${PIPE_RC[0]}
  TEE_RC=${PIPE_RC[1]:-0}
fi

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
  || die "post-run scan failed — changes cannot be judged. Codex already ran, so check $RUN_DIR directly"
TOUCHED=$(printf '%s\n' "$TOUCHED" | LC_ALL=C sort | sed 's|^\./||')

AFTER="$RUN_DIR/after.list"
SCAN | LC_ALL=C sort > "$AFTER" || die "post-run listing snapshot failed — deletions cannot be judged"
DELETED=$(LC_ALL=C comm -23 "$BEFORE" "$AFTER" | sed 's|^\./||' \
          | grep -v '^docs/codex_rescue/\.scratch/' || true)

# 🔴 추가된 경로는 **경로 목록 차집합으로도** 잡는다 (Codex 2차 검토 지적).
#    mtime 만 믿으면, 새 파일이 marker 보다 오래된 mtime 으로 만들어질 때 놓친다
#    (`cp -p`, `touch -r`, hard link, 압축 해제의 타임스탬프 보존). before/after 목록이
#    이미 있으므로 비용은 0 이다.
ADDED=$(LC_ALL=C comm -13 "$BEFORE" "$AFTER" | sed 's|^\./||')

# 정상 산출물(검증된 응답 경로 + Codex 작업 폴더)을 제외한다. 남은 것이 전제를 깬 변경이다.
# `--` 로 선행 `-` 경로에도 안전하게.
#
# 🔴 `.scratch/` 제외는 반드시 **앵커드 접두**(`^...`)로 한다 (2026-08-25).
#    `grep -v scratch` 같은 부분 일치로 쓰면 `src/scratchpad.js`·`lib/scratch_util.py` 가
#    통째로 묻힌다. `response_path` 를 완전 일치로 검증하는 것과 같은 논리다 —
#    **제외 규칙이 넓어지는 순간 그게 곧 감시 우회 통로가 된다.**
#
# 🔴 `.scratch/` 를 prune(스캔 제외)에 넣지 않은 것은 의도적이다. 스캔은 하되 경보에서만 뺀다.
#    prune 하면 Codex 가 무엇을 계산했는지 보고에서 사라진다 — 그 흔적이 조사 재현의 근거다.
# EDIT 되묻기의 수정 기록 파일도 정상 산출물이다(2026-09-15). 응답 경로와 같이 **완전 일치**로만 뺀다.
STRAY=$(printf '%s\n%s\n' "$TOUCHED" "$ADDED" | grep -v '^[[:space:]]*$' \
        | LC_ALL=C sort -u | grep -Fvx -- "$RESP_REL" \
        | { if [ -n "$EDITLOG_REL" ]; then grep -Fvx -- "$EDITLOG_REL"; else cat; fi; } \
        | grep -v '^docs/codex_rescue/\.scratch/' || true)

# Codex 가 작업 폴더에 남긴 것 — 위반이 아니라 조사의 흔적이다. 따로 세어 보고한다.
SCRATCH_MADE=$(printf '%s\n%s\n' "$TOUCHED" "$ADDED" | grep -v '^[[:space:]]*$' \
        | LC_ALL=C sort -u | grep '^docs/codex_rescue/\.scratch/' \
        | grep -v '^docs/codex_rescue/\.scratch/\.gitignore$' || true)

# ── 응답 회수 및 판정 ───────────────────────────────────────────
# 파일 존재만으로 성공 판정하지 않는다. 실행 전 해시와 비교해 **이번 실행의 산물인지** 가린다.
AUTHOR=none
RESP_HASH_AFTER=""
[ -e "$RESP_REL" ] && RESP_HASH_AFTER=$(hashof "$RESP_REL")

if [ "$KIND" = followup ]; then
  # 🔴 Codex 가 파일을 쓰지 않는다(read-only). `-o` 회수분을 **스크립트가** 이어 붙인다.
  #    그래서 stale 판정이 필요 없고(REVIEW 와 같은 이유), 1턴 원문이 훼손될 수 없다.
  if [ -s "$LASTMSG" ] && [ "$RC" = 0 ]; then
    {
      echo
      echo "<!-- codex_rescue:consult-turn ${FUP_TURN} -->"
      echo "## 🔁 ${FUP_TURN}턴 — Claude 반박 · $(date '+%Y-%m-%d %H:%M:%S')"
      echo
      echo "> 반박서 원문: [\`$(basename "$FUP_ABS")\`](./$(basename "$FUP_ABS"))"
      echo
      # 반박서 본문(frontmatter 제외)을 그대로 박는다 — 대화 기록이 자체완결이어야 한다.
      awk 'NR==1 && /^---$/ {fm=1; next} fm && /^---$/ {fm=0; next} !fm' "$FUP_ABS"
      echo
      echo "## 🔷 ${FUP_TURN}턴 — Codex 재답변"
      echo
      cat "$LASTMSG"
      echo
      # EDIT 되묻기면 Codex 가 고칠 때마다 적은 기록을 그 턴 아래에 옮겨 담는다 (2026-09-15).
      if [ -n "$EDITLOG_REL" ] && [ -s "$EDITLOG_REL" ]; then
        echo "### ${FUP_TURN}턴 수정 기록 — Codex 가 고칠 때마다 적은 것"
        echo
        echo "> 원본: [\`$(basename "$EDITLOG_REL")\`](./$(basename "$EDITLOG_REL"))"
        echo
        cat "$EDITLOG_REL"
        echo
      fi
    } >> "$RESP_REL" || die "cannot record the turn: $RESP_REL
  🔴 The Codex session has this turn but the document does not. Clear thread_id by hand."
    fm_set "$RESP_REL" turns "$FUP_TURN" && [ "$(fmf "$RESP_REL" turns)" = "$FUP_TURN" ] \
      || die "cannot update turns: $RESP_REL — the next turn number check will be off. Fix it by hand."
    AUTHOR=codex
    rm -f -- "$INFLIGHT" 2>/dev/null   # 취약 구간이 닫혔다
  else
    # 🔴 실패한 턴은 기록하지 않고 스레드를 폐기한다 (CHAT 과 같은 논거).
    #    Codex 세션에는 이 사용자 턴이 남았는데 문서에는 답이 없다. 그대로 재개하면 어긋난다.
    AUTHOR=none
    if fm_set "$RESP_REL" thread_id "" && [ -z "$(fmf "$RESP_REL" thread_id)" ]; then
      FUP_DISCARDED=1
    fi
    {
      echo
      echo "## ⚠️ 스레드 끊김 · $(date '+%Y-%m-%d %H:%M:%S')"
      echo
      echo "${FUP_TURN}턴 codex 호출이 실패했다(exit: $RC). 온전하지 않은 턴은 기록하지 않았다."
      echo "스레드를 폐기했다 — 이 건은 더 이어붙일 수 없다."
      # EDIT 되묻기는 끊겨도 코드가 이미 바뀌었을 수 있다. 무엇을 고쳤는지 기록만은 남긴다 (2026-09-15).
      if [ -n "$EDITLOG_REL" ]; then
        echo
        echo "🔴 EDIT 되묻기였다 — **코드가 반쯤 바뀐 상태일 수 있다.** 아래 수정 기록과 git diff 로 대조해라."
        echo
        if [ -s "$EDITLOG_REL" ]; then cat "$EDITLOG_REL"; else echo "(수정 기록이 비었거나 없다 — git diff 가 유일한 근거다)"; fi
      fi
    } >> "$RESP_REL" 2>/dev/null
    rm -f -- "$INFLIGHT" 2>/dev/null
  fi

elif [ "$KIND" = review ]; then
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
    } > "$RESP_REL" || die "cannot save the review result: $RESP_REL"
  fi
  # 옛 리뷰가 연 대화에도 이름을 붙인다 (2026-09-17). 요청서가 없어 --subject/슬러그로 만든다.
  REVIEW_THREAD=$(grep -o '"thread_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$EVENTS" 2>/dev/null \
                  | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
  if [ -n "$REVIEW_THREAD" ] && command -v node >/dev/null 2>&1; then
    node "$SELF_DIR/scripts/set-thread-name.mjs" --thread "$REVIEW_THREAD" --mode review \
      --subject "${SUBJECT:-}" --slug "$SLUG" || true
  fi
elif [ -n "$RESP_HASH_AFTER" ]; then
  if [ "$RESP_EXISTED" = 0 ] || [ "$RESP_HASH_AFTER" != "$RESP_HASH_BEFORE" ]; then
    # 파일이 바뀌었어도 codex 가 비정상 종료했으면 완성본이 아니다 (2026-09-13).
    # 요청서가 "조사하면서 적어라"를 시키므로 한도로 끊겨도 파일은 이미 바뀌어 있다.
    # 여기서 codex 로 판정하면 미완성 초안이 "✅ 응답 도착"으로 보고된다.
    if [ "$RC" != 0 ]; then
      AUTHOR=partial            # 도중에 끝났다 — 조사하면서 적어 둔 중간 저장본이다
    else
      AUTHOR=codex              # Codex 가 새로 쓰거나 갱신했다
    fi
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
  } > "$RESP_REL" || die "cannot save the response file: $RESP_REL"
fi

# ── 🔴 multi-turn 준비: 1턴의 thread_id 를 응답 문서에 심는다 (2026-08-25) ──
#
# 왜 여기인가 — stale 판정(해시 비교)과 변경 감지가 **끝난 뒤**여야 한다. 먼저 쓰면
# 내가 만든 변경을 "Codex 가 갱신했다"로 오판하고, marker 보다 새로운 mtime 이라 STRAY 로도 잡힌다.
#
# 🔴 `.log/` 에 두지 않는다. 거긴 코드 주석이 스스로 "비권위 telemetry" 라고 못박은 곳이고
#    Codex 의 쓰기 범위 안이다. thread_id 는 대화의 생명줄이라 권위값이다 — 자기모순이 된다.
#
# 심지 못해도 **die 하지 않는다.** 1턴 분석은 이미 성공했고 본체는 응답 문서다.
# 잃는 것은 "이어서 되물을 수 있는 능력" 뿐이므로 보고만 하고 정상 종료한다.
#
# 중간 저장본(partial)에도 심는다 (2026-09-13). 한도가 풀린 뒤 되묻기로 남은 조사를 이어가게 한다.
# FOLLOWUP 실패 때 스레드를 버리는 것과 이유가 다르다 — 거기는 세션에 턴이 남았는데 문서엔 답이 없어
# 어긋나지만, 여기는 Codex 가 적어 둔 만큼이 문서에 있어 둘이 같은 지점에서 멈춰 있다.
if [ "$KIND" = doc ] && { [ "$AUTHOR" = codex ] || [ "$AUTHOR" = codex-via-stdout ] || [ "$AUTHOR" = partial ]; }; then
  NEW_THREAD=$(grep -o '"thread_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$EVENTS" 2>/dev/null \
               | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
  # 🔴 Codex 가 frontmatter 를 빼먹으면 **여기서 만들어 붙인다** (2026-08-25 실측으로 추가).
  #
  #    스모크 테스트에서 실제로 났다 — 요청서가 "그 외는 쓰지 마라"라고 하자 Codex 가
  #    frontmatter 까지 생략했다. 그러면 thread_id 를 심을 자리가 없어 **multi-turn 이 통째로 죽는다.**
  #    응답 문서 규약은 frontmatter 를 요구하고, `codex-via-stdout` 경로에서는 이미 스크립트가
  #    직접 쓰고 있다. 여기서 붙이는 것도 같은 성격이다 — **본문 앞에 추가할 뿐 원문은 손대지 않는다.**
  if [ -n "$NEW_THREAD" ] && [ -e "$RESP_REL" ] && ! fm_ok "$RESP_REL"; then
    FM_TMP="$RESP_REL.fmadd.$$"
    {
      echo '---'
      echo 'type: codex_response'
      echo "mode: $MODE"
      echo "stamp: $STAMP"
      echo "slug: $SLUG"
      echo "author: $AUTHOR"
      echo '---'
      echo
      echo '> ⚠️ Codex 가 frontmatter 없이 저장해 send.sh 가 규약 헤더를 붙였다. 아래는 원문 그대로다.'
      echo
      cat "$RESP_REL"
    } > "$FM_TMP" 2>/dev/null && mv -f -- "$FM_TMP" "$RESP_REL" 2>/dev/null \
      && echo "⚠️ the response document had no frontmatter, so the standard header was added (text preserved)." \
      || rm -f -- "$FM_TMP" 2>/dev/null
  fi

  if [ -z "$NEW_THREAD" ]; then
    THREAD_WHY="no thread_id in the event stream"
  elif ! fm_ok "$RESP_REL"; then
    # 위에서 붙이는 것도 실패했다면 손대지 않는다.
    THREAD_WHY="the response frontmatter boundary is broken and adding the header failed too"
  elif fm_set "$RESP_REL" thread_id "$NEW_THREAD" \
       && fm_set "$RESP_REL" origin "$(hostname 2>/dev/null || echo unknown)" \
       && fm_set "$RESP_REL" turns 1 \
       && [ "$(fmf "$RESP_REL" thread_id)" = "$NEW_THREAD" ]; then
    THREAD_SAVED="$NEW_THREAD"
  else
    THREAD_WHY="could not write to the frontmatter (check permissions and disk)"
  fi

  # 옛 경로가 연 대화에 이름을 붙인다 (2026-09-17). 끼어들기 경로는 live-consult.mjs 가 대화를 만들 때
  # 이미 붙였다. 부가 기능이라 결과를 보지 않는다.
  if [ -n "$NEW_THREAD" ] && [ "${LIVE_STEER_ON:-0}" != 1 ] && [ -n "$REQ_W" ] && command -v node >/dev/null 2>&1; then
    node "$SELF_DIR/scripts/set-thread-name.mjs" --thread "$NEW_THREAD" --request-file "$REQ_W" || true
  fi
fi

# 중간 저장본 표시 — 위에서 헤더를 붙인 뒤여야 frontmatter 가 있다 (2026-09-13).
# 종료 코드에서 나온 판정이라 스크립트가 심는다. Codex 원문 본문은 건드리지 않는다.
LIMIT_HIT=0
STOP_REASON=""
if [ "$KIND" = doc ] && [ "$AUTHOR" = partial ]; then
  # 한도 흔적은 조사 내용이 섞이지 않는 곳에서만 찾는다 (2026-09-14).
  # 로그 전체를 grep 하면 Codex 가 조사하며 읽은 파일 내용(명령 출력)이 섞여 오탐한다 —
  # 정상 종료한 09-13 실행의 app-server 로그에서 usageLimitExceeded 74건, rateLimitReachedType:null 14건이 걸렸다.
  _lim='usageLimitExceeded|usage_limit_exceeded|usage limit|rate_limit_reached|credits_depleted|usage_limit_reached'
  # ① rollout 원본의 한도 도달 필드 — 값이 있을 때만 (평소엔 null)
  if [ -n "${NEW_THREAD:-}" ]; then
    _ro=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -name "rollout-*${NEW_THREAD}.jsonl" 2>/dev/null | head -1)
    [ -n "$_ro" ] && grep -qE '"rate_limit_reached_type":"[a-z_]+"' "$_ro" 2>/dev/null && LIMIT_HIT=1
  fi
  # ② 턴 실패·오류 이벤트 줄에서만 (exec 호환 events)
  if [ "$LIMIT_HIT" = 0 ] && [ -f "$EVENTS" ]; then
    grep -E '"type":"(turn\.failed|error)"' "$EVENTS" 2>/dev/null | grep -qiE "$_lim" && LIMIT_HIT=1
  fi
  # ③ app-server 원문의 턴 종료·오류·한도 갱신 알림 줄에서만
  _as="$LOGD/${STAMP}_appserver.jsonl"
  if [ "$LIMIT_HIT" = 0 ] && [ -f "$_as" ]; then
    grep -E 'method[\\"]*:[\\"]*(turn/completed|error)[\\"]' "$_as" 2>/dev/null | grep -qiE "$_lim" && LIMIT_HIT=1
    [ "$LIMIT_HIT" = 0 ] && grep -E 'method[\\"]*:[\\"]*account/rateLimits/updated' "$_as" 2>/dev/null \
      | grep -qE 'rateLimitReachedType[\\"]*:[\\"]*(rate_limit_reached|workspace_[a-z_]+)' && LIMIT_HIT=1
  fi
  # ④ stderr — codex 자체 오류 출력이라 조사 내용이 섞이지 않는다
  if [ "$LIMIT_HIT" = 0 ] && [ -f "$ERRLOG" ]; then
    grep -qiE "$_lim" "$ERRLOG" 2>/dev/null && LIMIT_HIT=1
  fi
  if [ "$LIMIT_HIT" = 1 ]; then STOP_REASON=limit
  elif [ "$RC" = 130 ]; then STOP_REASON=interrupted
  else
    STOP_REASON=other
    # 사람이 멈춘 끼어들기 턴은 exit 21 이라 RC 로는 못 가른다 (2026-09-14 실측 — turn/interrupt 로 멈춘 턴이 other 로 나왔다).
    # rollout 의 마지막 턴 종료 이벤트가 turn_aborted·interrupted 인지 본다. "마지막"을 보는 이유는 되묻기로 턴이 이어 붙은
    # 대화에서 앞 턴의 중단 기록을 읽지 않기 위해서다. 같은 문자열이 조사 출력에도 섞이므로 grep 이 아니라 JSON 으로 이벤트 줄만 읽는다.
    if [ -n "${_ro:-}" ] && command -v node >/dev/null 2>&1; then
      _rw=$(winp "$_ro" 2>/dev/null) || _rw=""
      [ -n "$_rw" ] && node -e '
        const fs = require("fs"); let last = "";
        for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
          if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
          if (j.type !== "event_msg") continue;
          const p = j.payload || {};
          if (p.type === "turn_aborted") last = "aborted:" + (p.reason || "");
          else if (p.type === "task_complete") last = "complete";
        }
        process.exit(last === "aborted:interrupted" ? 0 : 1);' "$_rw" 2>/dev/null && STOP_REASON=interrupted
    fi
  fi
  unset _lim _ro _as _rw
  { fm_ok "$RESP_REL" && fm_set "$RESP_REL" status partial && fm_set "$RESP_REL" stopped "exit $RC" \
      && fm_set "$RESP_REL" stop_reason "$STOP_REASON"; } \
    || echo "⚠️ could not mark the partial save (status: partial) in the frontmatter — do not mistake the document for a finished one."
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
if [ "$KIND" = followup ]; then
  # 🔴 `tee -a` 로 이미 이어 붙었다. 여기서 덮으면 EVENTS 에는 이번 턴만 있으므로
  #    **앞 턴 이벤트가 통째로 사라진다** — 감사 근거를 지우면서 굴러가게 된다.
  :
elif [ "$(hashof "$EVENTS")" = "$(hashof "$LIVE_EVENTS")" ]; then
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
cp -f -- "$ERRLOG" "$ERR_DEST"   2>/dev/null || LOGCOPY_FAIL="$LOGCOPY_FAIL stderr.log"
if [ -s "$LASTMSG" ]; then
  cp -f -- "$LASTMSG" "$LAST_DEST" 2>/dev/null \
    || LOGCOPY_FAIL="$LOGCOPY_FAIL last_message.md"
fi

# ── Claude 에게 보고 ────────────────────────────────────────────
echo
echo "════════ codex_rescue done ════════"
if [ "$KIND" = review ]; then
  if [ "$SCOPE_VIA" = flag ]; then
    echo "review target: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL}   (given by CLI flag — exact)"
  else
    echo "review target: $SCOPE ${SCOPE_VAL:+$SCOPE_VAL}   (⚠️ given as a prompt sentence — the codex CLI"
    echo "           does not take a scope flag and a focus instruction together. Whether that scope was really covered,"
    echo "           check in the review text)"
  fi
  [ -n "$FOCUS" ] && echo "focus    : $FOCUS"
elif [ "$KIND" = followup ]; then
  echo "followup : turn ${FUP_TURN}   (follow-up file: $FUP)$([ "$FUP_EDIT" = 1 ] && printf '   · 🔧 further edits (edit: yes)')"
  echo "thread   : $RESP_REL   ·   id: $THREAD"
  [ -n "$EDITLOG_REL" ] && echo "edit log : $EDITLOG_REL"
else
  echo "request  : $REQ$([ "$REVIEW_REQ_AUTO" = 1 ] && printf '   (written by send.sh)')"
  if [ "$MODE" = review ]; then
    echo "review target: ${SCOPE:-(see request)} ${SCOPE_VAL:+$SCOPE_VAL}   (live-steer review — normal turn + official Codex rubric)"
    [ -n "$FOCUS" ] && echo "focus    : $FOCUS"
  fi
fi
echo "mode     : $MODE / sandbox: $SANDBOX_SHOWN / codex exit: $RC"
echo "model    : ${CR_MODEL:-(codex config)} / reasoning: ${CR_EFFORT:-(codex config)}"
echo "events   : $LOGD/${STAMP}_events.jsonl   (live record while running — the progress panel reads it)"
echo "status   : $STATUS"
if [ "$TEE_RC" != 0 ]; then
  echo "⚠️  the live mirror (tee) failed (exit $TEE_RC) — the progress display may have been incomplete."
  echo "    The analysis itself is unaffected (the response is collected separately). Check disk and permissions."
fi
if [ -n "$LOGCOPY_FAIL" ]; then
  echo "⚠️  copying the run logs failed:$LOGCOPY_FAIL"
  echo "    The originals were in the run directory, already cleaned up — those records are gone. Check disk and permissions."
fi
echo

case "$AUTHOR" in
  codex)
    if [ "$KIND" = review ]; then
      echo "✅ review arrived: $RESP_REL   (read-only run — Codex did not edit code)"
    else
      echo "✅ response arrived: $RESP_REL   (saved by Codex)"
    fi
    ;;
  codex-via-stdout)
    echo "✅ response arrived: $RESP_REL   (⚠️ Codex failed to save → saved from its final message instead. author: codex-via-stdout)"
    echo "   See $LOGD/${STAMP}_stderr.log for why it could not write."
    ;;
  stale)
    echo "🔴 the response file was **not updated** — same content as before the run (hash match)."
    echo "   $RESP_REL is **the output of an earlier run**. Do not take it for this response."
    echo "   Codex wrote nothing this time. Read $LOGD/${STAMP}_stderr.log and report the cause."
    [ -s "$LASTMSG" ] && echo "   The final message of this run is in $LOGD/${STAMP}_last_message.md — compare it with the existing file."
    echo "   🔴 Do not overwrite or delete the existing response file on your own. Get the user to decide."
    ;;
  partial)
    echo "⚠️ partial save arrived: $RESP_REL   (Codex stopped midway — codex exit: $RC)"
    case "${STOP_REASON:-other}" in
      limit)       echo "   cause: looks like the usage limit was hit (limit traces in the logs)." ;;
      interrupted) echo "   cause: interrupted (exit 130 signal or a turn-interrupt event) — a person stopped it or the process ended." ;;
      *)           echo "   cause: no limit trace and no interrupt signal — check $LOGD/${STAMP}_stderr.log and events." ;;
    esac
    echo "   This document is **not finished.** status: partial · stop_reason: ${STOP_REASON:-other} was set in its frontmatter."
    ;;
  none)
    echo "❌ no response file, and the final message is empty: $RESP_REL"
    echo "   Read $LOGD/${STAMP}_events.jsonl and ${STAMP}_stderr.log and report the cause to the user."
    ;;
esac

echo
if [ -n "$STRAY" ] || [ -n "$DELETED" ]; then
  echo "🔴🔴 changes other than the response file detected — you must report them to the user"
  [ -n "$STRAY" ]   && { echo "   [created / modified]"; printf '%s\n' "$STRAY"   | sed 's/^/     /'; }
  [ -n "$DELETED" ] && { echo "   [deleted]";      printf '%s\n' "$DELETED" | sed 's/^/     /'; }
  echo
  echo "   This skill assumes 'Codex does not edit code'. The changes above may break that assumption."
  echo "   ⚠️ But this detection only says 'the final state differed between scans'. It may be OneDrive sync or"
  echo "      another process, so **do not conclude that Codex did it.**"
  echo "      Check against what Codex actually ran in $LOGD/${STAMP}_events.jsonl."
  if [ "$IS_GIT" = 1 ]; then
    echo "   → check the actual content with git diff, then report to the user."
  else
    echo "   → Read each file to see what changed, then report (not a git repository, so no diff)."
  fi
  echo "   🔴 **Do not revert on your own.** Whether to revert or keep is the decision of the user."
else
  echo "✅ no changes besides the response file in the watched area."
fi
if [ -n "$SCRATCH_MADE" ]; then
  echo
  echo "🧪 $(printf '%s\n' "$SCRATCH_MADE" | wc -l | tr -d ' ') item(s) left in the Codex workbench — **this is normal.**"
  echo "   Investigation traces in $SCRATCH_REL/ (calculation scripts, intermediate data). Not a violation."
  echo "   Open it when checking how the numbers in the response came out. It is not committed to git."
  printf '%s\n' "$SCRATCH_MADE" | sed 's/^/     /'
fi
echo "   (not watched: $PRUNED — changes inside it, and create-then-delete or restored mtimes, are not caught)"
case "$SANDBOX" in
  *danger-full-access*)
    echo
    echo "   🔴 this run was danger-full-access — **files outside the cwd could be changed, and the detection above"
    echo "      cannot see that in principle** (it is a \`find .\` from the cwd)."
    echo "      Do not read 'no changes' above as 'outside the cwd is safe' — it means nothing was checked there."
    echo "      Go through the shell and apply_patch arguments in $LOGD/${STAMP}_events.jsonl yourself." ;;
esac

echo
echo "🔴 What Claude does next:"
if [ "$KIND" = followup ] && [ "$AUTHOR" = codex ]; then
  if [ "$FUP_EDIT" = 1 ]; then
    echo "   0. 🔧 **This was an EDIT follow-up — Codex edited code.** The 'changes other than the response file' list above is this edit"
    echo "      **Check the actual changes yourself** $([ "$IS_GIT" = 1 ] && printf 'with git diff' || printf 'by reading each file'),"
    echo "      compare them with the '변경한 파일·라인' section of the reply and the edit log ($EDITLOG_REL), then review"
  fi
  echo "   1. Read $RESP_REL — the '## 🔷 ${FUP_TURN}턴 — Codex 재답변' section at the bottom is this answer"
  echo "   2. 🔴 **First see whether Codex corrected your reading.** That is why this mode exists."
  echo "      If it says 'you read X but I meant Y', accept the correction and judge again"
  echo "   3. Append '## Claude 검토 (${FUP_TURN}턴)' below it — adopt / hold / reject + reasons"
  echo "   4. **Go down the stop table (references/results.md §10) from the top.** Stop at the first row that matches"
  echo "      · no new information (the same points reshuffled) → **stop.** Asking more will not produce it"
  echo "      · one of the 3 follow-up reasons applies → next follow-up file (limit ${CONSULT_MAX} turns):"
  echo "          docs/codex_rescue/${STAMP}_followup$((FUP_TURN + 1))_${SLUG}.md   (turn: $((FUP_TURN + 1)))"
  echo "          bash \$0 --followup <that path>   ← run_in_background: true"
  echo "      · everything else → **stop.** Move on to adopt / hold / reject"
  echo "   🔴 **The default is to stop.** Round trips are not the goal — **new information**, not turns, makes the answer"
elif [ "$KIND" = followup ]; then
  echo "   1. turn ${FUP_TURN} failed — read $ERR_DEST and report the cause to the user"
  if [ "$FUP_EDIT" = 1 ]; then
    echo "   🔴 the EDIT follow-up ended midway — **the code may be half-changed.** Report this first"
    echo "      Compare the 'changes other than the response file' list above, git diff and the edit log ($EDITLOG_REL). Do not revert"
  fi
  if [ "$FUP_DISCARDED" = 1 ]; then
    echo "   2. 🔴 the thread was discarded. No more followups can be added to this case"
    echo "      To ask further, write a **new CONSULT request** from the conversation so far"
  else
    echo "   2. 🔴 discarding the thread **failed** — thread_id in $RESP_REL is unchanged"
    echo "      Left as is, the next turn resumes a mismatched session. Clear thread_id by hand"
  fi
elif { [ "$KIND" = review ] || [ "$MODE" = review ]; } && [ "$AUTHOR" = codex ]; then
  echo "   1. Read $RESP_REL — the findings of the Codex review"
  echo "   2. **Do not edit the Codex text.** Append a '## Claude 검토' section at the end of the file"
  echo "      — adopt / hold / reject per finding + reason. If you judge one a false positive, write how the code disproves it"
  echo "   3. Report only what you adopt to the user and let them decide whether to apply it"
  echo "   🔴 **Do not fix every review finding automatically.** Reviews mix in false positives and matters of taste."
  echo "      What to fix is the decision of the user"
elif [ "$AUTHOR" = partial ]; then
  echo "   1. Read $RESP_REL — **it is a partial save.** Work out how far the investigation plan got"
  echo "   2. **Do not edit the Codex text.** Append '## Claude 검토' at the end, with '미완성 — exit $RC' as its first line"
  echo "   3. Report to the user — why it stopped, what was confirmed, what is left"
  case "${STOP_REASON:-other}" in
    limit)       echo "      · limit hit — check the reset time with codex-status.mjs and include it" ;;
    interrupted) echo "      · interrupted by a signal — first check whether the user stopped it. Do not assume a limit problem" ;;
    *)           echo "      · cause unknown — relay the failure reason found in the logs as is. Do not assume a limit problem" ;;
  esac
  if [ "$MODE" = edit ]; then
    echo "   🔴 the EDIT ended midway — **the code may be half-changed.** Compare the change record in the report"
    echo "      with the actual changes (change detection, git diff) and report to the user first. Do not revert"
  else
    echo "   4. **The user decides** whether to continue. If so, after the limit resets, send a follow-up (--followup) asking to continue the remaining items"
    echo "      ⚠️ follow-ups are read-only, so that turn gets no partial save · continuing a turn cut by the limit has not been measured yet"
    [ -z "$THREAD_SAVED" ] && echo "      🔴 no thread id was recorded for this case (${THREAD_WHY:-reason unknown}) — it cannot be continued with a follow-up"
  fi
elif [ "$AUTHOR" = codex ] || [ "$AUTHOR" = codex-via-stdout ]; then
  echo "   1. Read $RESP_REL. **First check that the content is a real analysis** —"
  echo "      it may be a failure report such as 'could not read the request'. Then there is nothing to review"
  echo "   2. **Do not edit the Codex text.** Append a '## Claude 검토' section at the end of the file"
  echo "      — adopt / hold / reject with reasons, a code re-check if your hypothesis was rejected, and the plan to apply"
  echo "   3. Report the review to the user and let them decide whether to apply it"
else
  echo "   1. Find the failure cause in the logs and report it to the user"
  echo "   2. Do not rewrite the request; fix the cause and rerun with the same request"
fi

# ── 🔁 1턴 CONSULT 뒤: 되묻기 안내 (2026-08-25) ─────────────────
# EDIT 도 되묻는다 (2026-09-15) — 읽기 전용 되묻기는 그대로 되고, 반박서에 `edit: yes` 를 적으면 추가 수정까지 한다.
if [ "$KIND" = doc ] && [ "$AUTHOR" != partial ]; then
  if [ -n "$THREAD_SAVED" ]; then
    echo
    echo "🔁 **Follow-up possible** — this case is ready to continue the conversation."
    if [ "$MODE" = edit ]; then
      echo "   🔧 an EDIT case — to have Codex edit further, put **edit: yes** in the follow-up frontmatter,"
      echo "      confirm with the user again, then send it with **CR_ALLOW_EDIT=1**. Confirm every turn. Without it the turn is read-only."
    fi
    echo "   Measured (2026-08-25): asking about the same failure in **3** single CONSULTs reached no conclusion;"
    echo "   the user talking with Codex for **11 turns** did. Same model, same effort."
    echo "   **The difference was the number of turns.** Do not conclude alone from one answer."
    echo
    echo "   🔴 **A follow-up is the exception. The default is to stop here.** There are only three reasons:"
    echo "     · **the core symptom is not explained** ← the reason for asking is unresolved"
    echo "     · **you rejected a Codex point but could not confirm the grounds in code or logs**"
    echo "       (your rejection may be wrong, and Codex does not know it was rejected)"
    echo "     · **the response has an obvious factual error**"
    echo "   ⚠️ 'Codex agreed with my hypothesis' is not a reason. A second follow-up or more **only with new information.**"
    echo "   ⚠️ If Codex just did not open a source you can open yourself — **do not follow up; open it yourself.** That is faster."
    echo
    echo "   How:"
    echo "     1. Write docs/codex_rescue/${STAMP}_followup2_${SLUG}.md (turn: 2)"
    echo "     2. bash \$0 --followup <that path>   ← run_in_background: true"
  elif [ -n "$THREAD_WHY" ]; then
    echo
    echo "⚠️ this case **cannot be followed up** — $THREAD_WHY"
    echo "   The turn-1 analysis itself is fine. To ask more, write a new CONSULT request."
  fi
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
