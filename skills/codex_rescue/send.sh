#!/usr/bin/env bash
# codex_rescue — Codex CLI 에 일을 넘기고, 답변과 "Codex 가 만진 것"을 회수한다.
#
#   send.sh <request 파일 경로>                      ← 상담/수정 (요청서 기반) · 1턴
#   send.sh --followup <반박서 경로>                  ← CONSULT 2턴 이후 (되묻기, resume)
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
#   CR_DRYRUN=1           codex 를 부르지 않고 조립한 명령·프롬프트만 출력
#   CR_CONSULT_MAX_TURN=<n>  CONSULT 되묻기 턴 상한 (기본 11)
#                         ★ 근거: 사용자가 Codex 와 직접 대화해 결론에 도달한 세션의
#                           실측 사용자 턴 수가 11회였다(2026-08-25). 같은 장애를
#                           CONSULT 단발로는 3회 물어도 결론이 안 났다
#   CR_CHAT_LIMIT=<초>    CHAT 시간 상한 (기본 60). --explore 를 쓰면 **명시 필수**
#   CR_CHAT_LOOK_MAX=<바이트>  CHAT --look 총 크기 상한 (기본 65536)
#
#   ⛔ CR_TIMEOUT 은 제거됐다 — Windows 에서 작동하지 않는다(실측). 쓰면 거부한다
#
# 🔴 fail-closed 원칙 — 이 스크립트는 감시자다. 감지 준비에 실패하면 "변경 없음"으로 흐르지 않고
#    반드시 중단한다. 감지 실패를 정상으로 보고하는 것이 가장 나쁜 실패 양식이다.
set -uo pipefail

die() { printf 'codex_rescue: %s\n' "$*" >&2; exit 2; }

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
  CH_LOOK_SPECS=""   # 개행 구분. --look 이 준 원본 spec (경로 또는 경로:시작-끝)
  CH_LOOK_LIST=""    # 개행 구분. <절대경로>\t<시작>\t<끝>\t<표시이름>  ← cd 전에 굳힌다
  CH_LOOK_BYTES=0
  ch_one_action() {
    [ -z "$CH_ACTION" ] || die "--chat: --start · --resume-stamp · --close-stamp 는 함께 쓸 수 없다 (지금: $CH_ACTION)"
  }
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug)    [ -n "${2:-}" ] || die "--chat: --slug 값이 없다";    CH_SLUG="$2";    shift 2 ;;
      --subject) [ -n "${2:-}" ] || die "--chat: --subject 값이 없다"; CH_SUBJECT="$2"; shift 2 ;;
      --start)   ch_one_action; CH_ACTION=start; shift ;;
      --explore) CH_EXPLORE=1; shift ;;
      --look)
        [ -n "${2:-}" ] || die "--chat: --look 값이 없다 — 살펴볼 파일을 지목해라.
  · 파일 전체   → --look src/main.js
  · 일부만      → --look src/main.js:120-260
  여러 번 쓸 수 있다. 디렉토리는 못 준다 — **볼 파일을 네가 정하는 것**이 이 옵션의 요점이다."
        CH_LOOK_SPECS="$CH_LOOK_SPECS${CH_LOOK_SPECS:+$CH_NL}$2"
        shift 2 ;;
      --resume-stamp)
        [ -n "${2:-}" ] || die "--chat: --resume-stamp 값이 없다 (직전 턴 stdout 의 '대화키' 를 그대로 넘겨라)"
        ch_one_action; CH_ACTION=resume; CH_RESUME_STAMP="$2"; shift 2 ;;
      --close-stamp)
        [ -n "${2:-}" ] || die "--chat: --close-stamp 값이 없다"
        ch_one_action; CH_ACTION=close; CH_CLOSE_STAMP="$2"; shift 2 ;;
      --new)
        die "--new 는 없어졌다 (2026-08-22). 호출 경계를 보장하지 못했기 때문이다.
  · 새 대화를 시작한다        → --start
  · 이어서 말한다             → --resume-stamp <직전 턴의 대화키>
  · 대화를 닫기만 한다        → --close-stamp <대화키>" ;;
      --)        shift; CH_MSG="$CH_MSG${CH_MSG:+ }$*"; break ;;
      *)         CH_MSG="$CH_MSG${CH_MSG:+ }$1"; shift ;;
    esac
  done
  [ -n "$CH_SLUG" ] || die "--chat 은 --slug <영문-kebab> 이 필요하다 — 파일 이름과 락의 단위다"
  # 🔴 동작을 안 밝히면 **추측하지 않고 멈춘다.** 예전에는 옵션이 없으면 같은 슬러그의 최신
  #    문서를 자동으로 이어받았고, 그래서 새 스킬 호출이 지난 대화에 조용히 붙었다.
  [ -n "$CH_ACTION" ] || die "--chat: 동작이 모호하다 — --start 인지 --resume-stamp 인지 밝혀라.
  · 이번 스킬 호출의 **첫 턴**  → --start            (대화키는 이 스크립트가 발급한다)
  · 같은 호출의 **다음 턴**     → --resume-stamp <직전 턴 stdout 의 '대화키'>
  같은 슬러그라도 새 스킬 호출이면 --start 다. 그게 대화를 호출 단위로 나누는 유일한 신호다."
  for s in "$CH_RESUME_STAMP" "$CH_CLOSE_STAMP"; do
    case "$s" in
      "") ;;
      [0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
      *)  die "대화키 형식이 틀렸다: $s   (ymd_His, 예: 260822_213131)" ;;
    esac
  done
  # 🔴 소문자만 받는다 (2026-08-22, Codex 지적). 대문자를 허용하면 Windows 에서는 `Foo` 와 `foo`
  #    가 같은 파일이고 Linux 에서는 다른 파일이라, 5대에 배포된 이 스킬에서 같은 슬러그가
  #    머신마다 다른 대화를 가리키게 된다. 문서도 처음부터 kebab-case 를 요구하고 있었다.
  case "$CH_SLUG" in
    *[!a-z0-9-]*) die "슬러그는 **소문자** 영문·숫자·하이픈만 쓴다: $CH_SLUG
  (대문자를 허용하면 Windows/Linux 에서 같은 슬러그가 다른 파일을 가리킨다)" ;;
  esac
  if [ "$CH_ACTION" = close ]; then
    [ -z "$CH_MSG" ] || die "--close-stamp 는 대화를 닫기만 한다 — 던질 말을 함께 주지 마라"
    [ -z "$CH_LOOK_SPECS" ] || die "--close-stamp 는 codex 를 부르지 않는다 — --look 을 함께 주지 마라"
  else
    [ -n "$CH_MSG" ] || die "--chat: Codex 에게 던질 말이 없다"
  fi

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
  case "$CH_LOOK_MAX" in ''|*[!0-9]*) die "CR_CHAT_LOOK_MAX 는 바이트 단위 정수여야 한다: $CH_LOOK_MAX" ;; esac

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
      [ -n "$lk_path" ] || die "--look 경로가 비었다: $spec"

      [ -e "$lk_path" ] || die "--look 이 지목한 것이 없다: $lk_path
  (경로는 **이 명령을 부르는 위치** 기준이다. 오타이거나 다른 폴더에서 부르고 있다)"
      [ -d "$lk_path" ] && die "--look 에 디렉토리는 못 준다: $lk_path
  통째로 실으면 핑퐁이 아니라 조사가 된다. 볼 파일을 지목해라."
      [ -f "$lk_path" ] || die "--look 대상이 일반 파일이 아니다: $lk_path"
      [ -r "$lk_path" ] || die "--look 대상을 읽을 수 없다(권한): $lk_path"
      [ -s "$lk_path" ] || die "--look 대상이 빈 파일이다: $lk_path"
      grep -Iq . -- "$lk_path" 2>/dev/null \
        || die "--look 대상이 바이너리다: $lk_path   (텍스트 파일만 실을 수 있다)"

      if [ -n "$lk_from" ]; then
        [ "$lk_from" -ge 1 ] 2>/dev/null || die "--look 라인 범위의 시작은 1 이상이어야 한다: $spec"
        [ "$lk_to" -ge "$lk_from" ] 2>/dev/null || die "--look 라인 범위가 거꾸로다: $spec"
      fi

      # 절대경로로 굳힌다 (cd 이후에도 유효하게).
      case "$lk_path" in
        /*|[A-Za-z]:[/\\]*) lk_abs="$lk_path" ;;
        *) lk_dir=$(cd -- "$(dirname -- "$lk_path")" 2>/dev/null && pwd) \
             || die "--look 경로를 해석하지 못했다: $lk_path"
           lk_abs="$lk_dir/$(basename -- "$lk_path")" ;;
      esac

      # 실을 크기를 미리 잰다 — 상한을 넘으면 codex 를 부르기 전에 멈춘다.
      if [ -n "$lk_from" ]; then
        lk_bytes=$(sed -n "${lk_from},${lk_to}p" -- "$lk_abs" 2>/dev/null | wc -c)
        [ "${lk_bytes:-0}" -gt 0 ] || die "--look 라인 범위에 내용이 없다: $spec   (파일이 그보다 짧다)"
        lk_name="$lk_path (${lk_from}-${lk_to}행)"
      else
        lk_bytes=$(wc -c < "$lk_abs" 2>/dev/null)
        lk_name="$lk_path"
      fi
      CH_LOOK_BYTES=$(( CH_LOOK_BYTES + ${lk_bytes:-0} ))

      CH_LOOK_LIST="$CH_LOOK_LIST${CH_LOOK_LIST:+$CH_NL}${lk_abs}	${lk_from}	${lk_to}	${lk_name}"
    done <<EOF
$CH_LOOK_SPECS
EOF

    if [ "$CH_LOOK_BYTES" -gt "$CH_LOOK_MAX" ]; then
      die "--look 자료가 너무 크다: ${CH_LOOK_BYTES}B (상한 ${CH_LOOK_MAX}B)

  실측(2026-08-25): 56KB 인라인은 12초에 답이 왔다. 그보다 크면 핑퐁의 크기가 아니다.
   · 라인 범위로 좁혀라  → --look <경로>:<시작>-<끝>
   · 파일 수를 줄여라
   · 정말 통째로 봐야 하면 CHAT 이 아니라 **CONSULT**(요청서 방식)다.
  상한은 CR_CHAT_LOOK_MAX 로 조정한다(바이트)."
    fi
  fi

  # 🔴 대화 문서는 **프로젝트 루트**(git 레포 루트)에 쌓는다 (2026-08-22 사용자 결정).
  #
  #    예전에는 `$PWD` 였다. 그래서 같은 슬러그로 불러도 **호출 위치가 다르면 다른 파일**이
  #    생겼고, 이어받을 이전 대화도 그 디렉토리 안에서만 찾으므로(아래 CH_PREV_DOC glob)
  #    맥락이 **조용히** 끊겼다. origin 이 다를 때는 알려 주면서 이쪽은 감지조차 안 했다.
  #
  #    실제 사고(2026-08-22, IVR 서버): 같은 슬러그 `poi-history-mismatch` 를 세 번 불렀는데
  #    `/home/yeogi_callcrew` · `/tmp` · `/home/yeogi_callcrew/gateway` 에 각각 문서가 생기고
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
    cd "$CH_ROOT" || die "프로젝트 루트로 이동하지 못했다: $CH_ROOT"
    CH_ROOT="$PWD"
  else
    # 레포 밖이다. 여기서는 이어받기가 성립하지 않으므로 **조용히 넘어가지 않는다** —
    # 조용한 실패가 위 사고의 본질이었다.
    CH_ROOT="$PWD"
    echo "⚠️ git 레포 밖에서 실행됐다 — 대화는 여기에 쌓인다: $CH_ROOT/docs/codex_rescue"
    echo "   같은 슬러그라도 **다른 위치에서 부르면 맥락이 이어지지 않는다.**"
  fi
  CH_DOCS="$CH_ROOT/docs/codex_rescue"
  CH_LOGD="$CH_DOCS/.log"
  # 이 대화가 어느 머신 것인지. 대화 문서는 git 으로 5대 사이를 오가지만 Codex 세션은 안 따라간다.
  CH_ORIGIN=$(hostname 2>/dev/null || echo unknown)
  mkdir -p "$CH_LOGD" || die "디렉토리 생성 실패: $CH_LOGD"
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
    die "같은 대화($CH_SLUG)가 이미 돌고 있다 — 한 세션에 두 턴을 동시에 던지면 응답 순서가 뒤섞인다.

  lock: $CH_LOCK
$(sed 's/^/    /' "$CH_LOCK" 2>/dev/null)

  위 pid 의 프로세스가 없고 started 가 한참 전이면 비정상 종료로 남은 것이다. 지우고 다시 해라."
  fi

  CH_TMP=$(mktemp -d "${TMPDIR:-/tmp}/codex-chat.XXXXXX") \
    || { rm -f -- "$CH_LOCK"; die "임시 디렉토리 생성 실패"; }
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
  trap 'ch_cleanup; echo "codex_rescue: 중단됨(신호 수신)" >&2; exit 130' HUP INT TERM

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
      *) die "귀속할 수 없는 in-flight 마커다(구형이거나 손상됨): $CH_INFLIGHT
  어느 대화가 끊겼는지 알 수 없어 **아무 문서도 건드리지 않았다.** 내용을 확인하고 지워라." ;;
    esac
    [ "$CH_IF_SLUG" = "$CH_SLUG" ] \
      || die "in-flight 마커의 slug 가 다르다: '$CH_IF_SLUG' ≠ '$CH_SLUG' ($CH_INFLIGHT)"
    CH_IF_DOC="$CH_DOCS/${CH_IF_STAMP}_chat_${CH_IF_SLUG}.md"
    if [ -f "$CH_IF_DOC" ]; then
      ch_discard_thread "$CH_IF_DOC" \
        "지난 실행이 codex 호출과 기록 사이에서 강제 종료됐다(마커: ${CH_IF_WHEN:-시각 불명})." \
        && echo "⚠️ 지난 실행이 중간에 죽어 있었다 — 그 대화($CH_IF_STAMP)의 스레드를 폐기했다." \
        || die "지난 실행의 스레드를 폐기하지 못했다: $CH_IF_DOC
  그대로 두면 어긋난 세션을 재개한다. 손으로 thread_id 를 비우고 다시 해라."
    else
      # 첫 턴이 문서 생성 전에 죽은 경우다. 닫을 문서가 없다 — 과거 대화는 건드리지 않는다.
      # orphan Codex 세션이 남을 수는 있지만, 멀쩡한 과거 기록을 깨뜨리는 것보다 낫다.
      echo "⚠️ 지난 실행은 첫 턴을 기록하기 전에 죽었다($CH_IF_STAMP). 과거 문서는 건드리지 않는다."
    fi
    rm -f -- "$CH_INFLIGHT" 2>/dev/null
  fi

  # ── 대상 문서 결정 — glob 으로 추측하지 않고 정확히 한 파일만 가리킨다 ──────
  ch_fm() {   # $1=파일  $2=키
    sed -n "1,/^---$/ s/^$2:[[:space:]]*//p" "$1" | head -1 | tr -d '\r'
  }

  if [ "$CH_ACTION" = start ]; then
    CH_STAMP=$(date "+%y%m%d_%H%M%S") || die "스탬프 생성 실패"
    # 같은 초에 두 번 시작하면 기존 문서에 조용히 append 된다. 덮지 말고 실패시킨다.
    for f in "$CH_DOCS/${CH_STAMP}_chat_"*.md; do
      [ -e "$f" ] && die "대화키가 겹친다: $CH_STAMP — 1초 뒤에 다시 해라"
    done
    CH_DOC="$CH_DOCS/${CH_STAMP}_chat_${CH_SLUG}.md"
    CH_THREAD=""
  else
    # resume · close 공통. 🔴 대상이 없으면 **만들지 않고 멈춘다** — 조용한 새 대화가
    #    이번 사고의 본질이었고, 잘못된 resume 은 기록과 답변을 동시에 오염시킨다.
    [ -z "$CH_SUBJECT" ] || die "--subject 는 --start 에서만 쓴다 (제목은 문서가 이미 갖고 있다)"
    CH_STAMP="${CH_RESUME_STAMP:-$CH_CLOSE_STAMP}"
    CH_DOC="$CH_DOCS/${CH_STAMP}_chat_${CH_SLUG}.md"
    [ -f "$CH_DOC" ] || die "그 대화가 없다: ${CH_STAMP}_chat_${CH_SLUG}.md
  새 문서를 만들지 않았다. 새 대화를 원하면 --start 를 써라."
    [ "$(ch_fm "$CH_DOC" stamp)" = "$CH_STAMP" ] || die "파일명과 frontmatter 의 stamp 가 어긋난다: $CH_DOC"
    [ "$(ch_fm "$CH_DOC" slug)"  = "$CH_SLUG"  ] || die "파일명과 frontmatter 의 slug 가 어긋난다: $CH_DOC"

    # 🔴 다른 머신의 대화는 **중단**한다 (2026-08-22 개정). 예전에는 경고 후 새 대화로
    #    바꿨는데, 그건 호출자가 요청한 것과 다른 동작이라 조용한 분리와 같다.
    CH_DOC_ORIGIN=$(ch_fm "$CH_DOC" origin)
    if [ -n "$CH_DOC_ORIGIN" ] && [ "$CH_DOC_ORIGIN" != "$CH_ORIGIN" ]; then
      die "이 대화는 다른 머신($CH_DOC_ORIGIN)에서 시작됐다 — 여기($CH_ORIGIN)선 이어받을 수 없다.
  Codex 세션 저장소는 머신마다 따로다. 조용히 새 대화로 바꾸지 않았다 — 새로 하려면 --start 를 써라."
    fi
    [ -n "$CH_DOC_ORIGIN" ] \
      || echo "⚠️ origin 이 없는 구형 문서다 — 머신 일치를 확인할 수 없지만 요청한 그 문서만 재개한다."
    CH_THREAD=$(ch_fm "$CH_DOC" thread_id)
  fi

  # ── --close-stamp: 대화를 닫기만 하고 끝낸다 (codex 를 부르지 않는다) ───────
  #    `--new` 를 대신한다. 예전 `--new` 는 "새로 시작"과 "옛 문서 닫기"를 한 동작에 묶었고,
  #    닫을 대상을 glob 으로 추측해서 **잘못 고른 문서를 영구히 닫을** 수 있었다.
  if [ "$CH_ACTION" = close ]; then
    [ -n "$CH_THREAD" ] || die "이미 닫힌 대화다: ${CH_STAMP}_chat_${CH_SLUG}.md"
    sed -i "1,/^---$/ s|^thread_id:.*|thread_id:|" "$CH_DOC" \
      || die "대화를 닫지 못했다: $CH_DOC (파일 권한을 확인해라)"
    # 정말 비었는지 되읽어 확인한다. 실패를 성공으로 보고하지 않기 위해서다.
    [ -z "$(ch_fm "$CH_DOC" thread_id)" ] || die "thread_id 가 지워지지 않았다: $CH_DOC"
    {
      echo
      # 제목 문구는 확장 패널의 파서가 그대로 매칭한다(`⏹ 새 대화로 전환`). 바꾸지 마라.
      echo "## ⏹ 새 대화로 전환 · $(date "+%H:%M:%S")"
      echo
      echo '`--close-stamp` 로 이 대화를 닫았다. 다음 대화는 `--start` 로 새로 시작한다.'
    } >> "$CH_DOC" 2>/dev/null
    echo "── codex_rescue CHAT ──────────────────────────────────"
    echo "대화를 닫았다: ${CH_DOC#"$CH_ROOT"/}"
    exit 0
  fi

  # 🔴 재개인데 스레드가 비어 있으면 **같은 파일에 새 스레드를 섞지 않는다.**
  if [ "$CH_ACTION" = resume ] && [ -z "$CH_THREAD" ]; then
    die "이 대화는 닫혔거나 끊겼다: ${CH_STAMP}_chat_${CH_SLUG}.md
  (문서의 thread_id 가 비어 있다 — 실패로 폐기됐거나 --close-stamp 로 닫았다)
  같은 파일에 새 스레드를 섞지 않았다. 이어서 하려면 --start 로 새 대화를 시작해라."
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
    die "--explore 는 시간 상한을 **함께 명시**해야 한다.

  기본 상한 60초로는 탐색이 잘리고, 잘리면 스레드까지 폐기된다(턴이 통째로 손실).
  실측(2026-08-25): 대상을 지목하지 않은 질문에 탐색을 열면 **명령 105회 · 240초 초과**다.

  먼저 이걸 의심해라 — 대개 --explore 가 아니라 **지목이 빠진 것**이 문제다:
     --look <경로>              그 파일을 스크립트가 실어 보낸다 (실측 8~12초, 답도 가장 정확)
     --look <경로>:<시작>-<끝>   일부만

  그래도 Codex 가 직접 훑어야 하면 상한을 대고 불러라:
     CR_CHAT_LIMIT=180 bash \"\$0\" --chat ... --explore ...
  (그 시간만큼 핑퐁이 멈춘다. 정말 그래야 하는지 한 번 더 생각해라 — 대개 CONSULT 감이다.)"
  fi
  CH_LIMIT="${CR_CHAT_LIMIT:-60}"
  case "$CH_LIMIT" in
    ''|*[!0-9]*) die "CR_CHAT_LIMIT 은 초 단위 정수여야 한다: $CH_LIMIT" ;;
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
      printf '\n아래는 네가 살펴볼 자료다. 내가 직접 실어 보낸 것이다.\n'
      while IFS="	" read -r lk_abs lk_from lk_to lk_name; do
        [ -n "$lk_abs" ] || continue
        printf '\n===== 자료: %s =====\n' "$lk_name"
        if [ -n "$lk_from" ]; then
          sed -n "${lk_from},${lk_to}p" -- "$lk_abs"
        else
          cat -- "$lk_abs"
        fi
      done <<EOF
$CH_LOOK_LIST
EOF
      printf '\n===== 자료 끝 =====\n'
    fi
    # 🔴 `[ -n "$x" ] && printf` 를 쓰지 마라 — 조건이 거짓이면 **블록 전체가 exit 1 이 되어**
    #    아래 `|| die "프롬프트 조립 실패"` 가 걸린다(2026-08-25 실측으로 잡은 버그).
    #    `if ... fi` 는 조건이 거짓이고 else 가 없으면 0 을 반환한다.
    if [ "$CH_EXPLORE" = 1 ]; then
      if [ -n "$CH_LOOK_LIST" ]; then
        printf '\n(위 자료를 먼저 보고, 그것으로 부족할 때만 다른 파일을 찾아봐라.)\n'
      else
        printf '\n(필요하면 파일을 찾아봐도 된다. 다만 대상을 좁혀서 봐라 — 트리 전체를 훑지 마라.)\n'
      fi
    elif [ -n "$CH_LOOK_LIST" ]; then
      printf '\n(위 자료와 이 대화에 주어진 것만으로 답해라. 파일이나 디렉토리를 직접 읽지 마라.)\n'
    else
      printf '\n(파일이나 디렉토리를 읽지 마라. 지금 이 대화에 주어진 것만으로 답해라.)\n'
    fi
  } > "$CH_PROMPT" || die "프롬프트 조립 실패: $CH_PROMPT"

  # PROMPT 자리에 `-` 를 둔다. 실제 내용은 아래 실행부에서 stdin 리다이렉션으로 들어간다.
  set -- "$@" -

  if [ -n "${CR_DRYRUN:-}" ]; then
    echo "── CHAT dry-run ──"
    echo "슬러그 : $CH_SLUG"
    echo "동작   : $CH_ACTION   ·   대화키: $CH_STAMP"
    echo "이어받기: ${CH_THREAD:-(새 스레드)}"
    echo "기록   : ${CH_DOC#"$CH_ROOT"/}"
    if [ -n "$CH_LOOK_LIST" ]; then
      echo "자료   : ${CH_LOOK_BYTES}B / 상한 ${CH_LOOK_MAX}B"
      while IFS="	" read -r _a _f _t lk_name; do
        [ -n "$lk_name" ] && echo "         · $lk_name"
      done <<EOF
$CH_LOOK_LIST
EOF
    fi
    echo "탐색   : $([ "$CH_EXPLORE" = 1 ] && echo '개방(--explore)' || echo '차단')"
    echo "상한   : ${CH_LIMIT}초"
    printf '명령   :'; printf ' %q' "$@"; printf '\n'
    echo "── 프롬프트(stdin) ──"
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
      while IFS="	" read -r _a _f _t lk_name; do
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
  if [ -z "$CH_THREAD" ]; then
    CH_THREAD=$(grep -o '"thread_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$CH_EV" 2>/dev/null \
                | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
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
      echo "⏱ ${CH_LIMIT}초를 넘겨 중단했다 — 핑퐁이 아니라 조사가 되고 있었다."
      echo
      echo "   실측(2026-08-25)으로 원인은 거의 정해져 있다. **탐색을 켜서가 아니라"
      echo "   대상을 지목하지 않아서**다:"
      echo "     · 탐색 개방 + 가벼운 질문         =   7초 · 명령   0회"
      echo "     · 탐색 개방 + 파일명을 지목한 질문 =  25초 · 명령   1회"
      echo "     · 자료 인라인 13KB / 56KB         = 8초 / 12초 · 명령 0회"
      echo "     · 탐색 개방 + 대상 없는 넓은 질문  = 240초 초과 · 명령 105회  ← 지금 이것"
      echo
      echo "   순서대로 시도해라:"
      echo "   ① **볼 것을 지목해라** — 첫 처방이다. 가장 빠르고 답도 가장 정확하다."
      echo "        --look <경로>              그 파일을 스크립트가 실어 보낸다"
      echo "        --look <경로>:<시작>-<끝>   일부만 (여러 번 쓸 수 있다)"
      echo "   ② 질문을 하나로 쪼개라 — 한 번에 하나만 묻는 것이 핑퐁이다."
      echo "   ③ 어디를 볼지 **Claude 도 모르는** 질문이면 그건 CHAT 이 아니라 **CONSULT** 다."
      echo "        (요청서 방식. 오래 걸려도 백그라운드라 대화가 막히지 않는다)"
      echo
      echo "   Codex 가 직접 훑는 것이 정말 필요하면 상한을 함께 대라:"
      echo "     CR_CHAT_LIMIT=180 ... --explore     (그 시간만큼 핑퐁이 멈춘다)"
      echo
    fi
    echo "🔴 코덱스 턴이 실패했다 (codex exit: $CH_RC, 응답 $([ -s "$CH_LAST" ] && echo '일부 있음' || echo '없음'))"
    echo
    if [ -s "$CH_LAST" ]; then
      echo "--- 받은 출력(신뢰할 수 없다 — 종료 코드가 0이 아니다) ---"
      cat "$CH_LAST"
      echo
    fi
    echo "--- stderr 마지막 20줄 ---"
    tail -20 "$CH_ERR" 2>/dev/null
    echo "-------------------------"
    echo "실패한 턴은 대화 문서에 기록하지 않았다 — 온전하지 않은 턴이 다음 턴의 맥락을 오염시킨다."
    if [ -f "$CH_DOC" ] && [ "$CH_DISCARDED" = 1 ]; then
      echo "스레드를 폐기했다: 같은 슬러그로 다시 물으면 새 대화로 시작한다."
    elif [ -f "$CH_DOC" ]; then
      echo "🔴 스레드 폐기에 **실패했다** — $CH_DOC 의 thread_id 가 그대로다."
      echo "   그대로 두면 다음 턴이 어긋난 세션을 재개한다. --close-stamp 로 닫거나 손으로 thread_id 를 비워라."
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
    } > "$CH_DOC" || die "대화 문서 생성 실패: $CH_DOC"
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
      while IFS="	" read -r _a _f _t lk_name; do
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
  } >> "$CH_DOC" || die "대화 문서 기록 실패: $CH_DOC"

  # 🔴 턴이 문서에 안전하게 들어갔다 — 취약 구간이 닫혔으므로 마커를 내린다.
  #    이 줄이 in-flight 복구의 마지막 조각이다. 여기 도달하지 못하고 죽으면 마커가 남고,
  #    다음 실행이 그걸 보고 스레드를 폐기한다.
  rm -f -- "$CH_INFLIGHT" 2>/dev/null

  echo "── codex_rescue CHAT ──────────────────────────────────"
  echo "슬러그: $CH_SLUG   ·   ${CH_TURN}턴   ·   codex exit: $CH_RC"
  # 🔴 다음 턴이 이 값을 그대로 `--resume-stamp` 로 넘긴다. 형식을 바꾸지 마라 — 호출자가
  #    읽는 계약이다. 이 줄이 없으면 이어서 말할 방법이 없다.
  echo "대화키: $CH_STAMP        ← 같은 호출의 다음 턴: --resume-stamp $CH_STAMP"
  echo "기록  : ${CH_DOC#"$CH_ROOT"/}"
  echo "스레드: ${CH_THREAD:-(미확인)}"
  echo
  echo "↓ 코덱스 답변 원문. 사용자에게 '코덱스:' 를 달아 **그대로** 전해라 — 요약·윤색 금지."
  echo "───────────────────────────────────────────────────────"
  cat "$CH_LAST"
  echo
  echo "───────────────────────────────────────────────────────"
  [ -z "$CH_THREAD" ] && echo "⚠️ thread_id 를 잡지 못했다 — 다음 턴은 맥락 없이 새로 시작된다"
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

if [ "${1:-}" = "--followup" ]; then
  # ── FOLLOWUP — 1턴 CONSULT 를 `codex exec resume` 으로 잇는다 ──
  #
  # 🔴 되묻는 말을 **인자로 받지 않는다.** 이 모드가 되던지는 것은 "채택/보류/기각과 그 근거"
  #    라서 길고 개행이 있다. 요청서를 파일로 주는 것과 같은 이유다.
  KIND=followup; shift
  FUP="${1:-}"
  [ -n "$FUP" ] || die "사용법: send.sh --followup <반박서 경로>
  반박서는 docs/codex_rescue/<원건스탬프>_followup<N>_<슬러그>.md 다.
  🔴 원 요청서 경로가 아니다 — 그걸 넘기면 1턴이 통째로 다시 돈다."
  [ $# -le 1 ] || die "--followup 은 반박서 경로 **하나만** 받는다.
  되묻는 말은 반박서 파일 안에 써라 (인자로 넘기면 따옴표·개행이 깨진다)."
  [ -f "$FUP" ] || die "반박서 파일이 없다: $FUP"
  FUP_ABS="$(cd "$(dirname "$FUP")" && pwd)/$(basename "$FUP")" || die "반박서 경로 해석 실패"
  case "$FUP_ABS" in
    */docs/codex_rescue/*) ROOT="${FUP_ABS%/docs/codex_rescue/*}" ;;
    *) die "반박서는 docs/codex_rescue/ 아래에 있어야 한다: $FUP
  (원 건의 요청서·응답 문서와 같은 디렉토리여야 스탬프 짝이 성립한다)" ;;
  esac

elif [ "${1:-}" = "--review" ]; then
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
      또는: send.sh --review --slug <슬러그> [--subject \"<한 줄>\"] [--uncommitted|--base <브랜치>|--commit <SHA>] [집중지시]
      또는: send.sh --followup <반박서 경로>          ← CONSULT 2턴 이후 (되묻기)"
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
elif [ "$KIND" = followup ]; then
  # ── FOLLOWUP 검증 — 대화의 생명줄을 확인한다 ──────────────────
  MODE=followup
  fm_ok "$FUP_ABS" || die "반박서 frontmatter 가 깨졌다(첫 줄 '---' 또는 닫는 '---' 없음): $FUP_ABS"

  # 🔴 양방향 잠금 ①: followup 파일은 --followup 로만 들어온다.
  #    이 검사가 없으면 반박서를 요청서로 실행할 수 있고, response_path 가 같으므로
  #    **Codex 가 1턴 원문과 Claude 검토가 담긴 응답 문서를 통째로 덮어쓴다.**
  [ "$(fmf "$FUP_ABS" type)" = "codex_followup" ] \
    || die "이 파일은 반박서가 아니다(type: codex_followup 이 아니다): $FUP_ABS"
  [ "$(fmf "$FUP_ABS" mode)" = "followup" ] \
    || die "반박서의 mode 는 followup 이어야 한다: $FUP_ABS
  🔴 mode: edit 인 반박서는 받지 않는다 — followup 은 read-only 고정이다(EDIT 게이트 무결성)."

  STAMP=$(fmf "$FUP_ABS" stamp)
  SLUG=$(fmf "$FUP_ABS" slug)
  FUP_TURN=$(fmf "$FUP_ABS" turn)
  RESP=$(fmf "$FUP_ABS" response_path)
  [ -n "$STAMP" ] && [ -n "$SLUG" ] && [ -n "$FUP_TURN" ] && [ -n "$RESP" ] \
    || die "반박서 frontmatter 에 stamp·slug·turn·response_path 가 모두 있어야 한다: $FUP_ABS"
  case "$STAMP" in
    [0-9][0-9][0-9][0-9][0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "stamp 형식이 틀렸다: $STAMP (ymd_His)" ;;
  esac
  case "$FUP_TURN" in ''|*[!0-9]*) die "turn 은 정수여야 한다: $FUP_TURN" ;; esac
  [ "$FUP_TURN" -ge 2 ] || die "turn 은 2 이상이다 (1턴은 CONSULT 요청서로 돈다): $FUP_TURN"

  # 파일명과 frontmatter 를 대조한다 — 한쪽만 고친 반박서를 걸러낸다.
  EXPECT_FUP="${STAMP}_followup${FUP_TURN}_${SLUG}.md"
  [ "$(basename "$FUP_ABS")" = "$EXPECT_FUP" ] || die "반박서 파일명이 규약과 다르다.
  기대: $EXPECT_FUP
  실제: $(basename "$FUP_ABS")"

  # 🔴 응답 경로는 원 건 것과 **완전히 같아야** 한다. 감시 제외 대상이므로 검증 없이 신뢰하면
  #    "정상 산출물 제외"가 곧 감시 우회가 된다 (1턴 CONSULT 와 같은 이유).
  RESP_REL=${RESP#./}
  EXPECT="docs/codex_rescue/${STAMP}_response_${SLUG}.md"
  [ "$RESP_REL" = "$EXPECT" ] || die "response_path 가 규약과 다르다.
  기대: $EXPECT
  실제: $RESP"

  # 원 요청서 — 있어야 한다. 확장 카드의 근거이자 1턴의 정본이다.
  PARENT_REQ="docs/codex_rescue/${STAMP}_request_${SLUG}.md"
  [ -f "$PARENT_REQ" ] || die "원 요청서가 없다: $PARENT_REQ
  followup 은 1턴이 실제로 돈 건에만 붙는다."
  fm_ok "$PARENT_REQ" || die "원 요청서 frontmatter 가 깨졌다: $PARENT_REQ"
  PARENT_MODE=$(fmf "$PARENT_REQ" mode); [ -n "$PARENT_MODE" ] || PARENT_MODE=readonly
  SUBJECT=$(fmf "$PARENT_REQ" subject)   # 카드 제목은 원 건 것을 그대로 이어 쓴다

  # ── 응답 문서 = 대화의 생명줄 ────────────────────────────────
  [ -f "$RESP_REL" ] || die "1턴 응답 문서가 없다: $RESP_REL
  이어붙일 대화가 없다 — CONSULT 1턴부터 다시 해라."
  fm_ok "$RESP_REL" || die "응답 문서 frontmatter 가 깨졌다: $RESP_REL
  🔴 thread_id 를 안전하게 읽을 수 없어 **아무것도 하지 않았다.** 손으로 확인해라."

  THREAD=$(fmf "$RESP_REL" thread_id)
  [ -n "$THREAD" ] || die "이 건은 이어받을 수 없다: $RESP_REL 의 thread_id 가 비어 있다.
  다음 중 하나다:
   ① 1턴이 thread_id 를 심기 전 버전으로 돌았다 (구형 응답 문서)
   ② 지난 followup 이 실패해 스레드가 폐기됐다 (문서에 '⚠️ 스레드 끊김' 이 있는지 봐라)
   ③ 강제 종료된 실행을 다음 실행이 복구하며 폐기했다
  🔴 같은 문서에 새 스레드를 섞지 않았다. 이어서 물으려면 CONSULT 1턴부터 새로 해라."

  # 🔴 머신 대조 — Codex 세션 저장소는 머신마다 따로인데 docs/ 는 git 으로 5대를 오간다.
  #    CHAT 과 같은 이유이고, 같은 이유로 **조용히 새 대화로 바꾸지 않고 중단**한다.
  RESP_DOC_ORIGIN=$(fmf "$RESP_REL" origin)
  MY_ORIGIN=$(hostname 2>/dev/null || echo unknown)
  if [ -n "$RESP_DOC_ORIGIN" ] && [ "$RESP_DOC_ORIGIN" != "$MY_ORIGIN" ]; then
    die "이 건은 다른 머신($RESP_DOC_ORIGIN)에서 시작됐다 — 여기($MY_ORIGIN)선 이어받을 수 없다.
  Codex 세션 저장소는 머신마다 따로다. 그 머신에서 이어가거나, 여기서 새 CONSULT 를 시작해라."
  fi
  [ -n "$RESP_DOC_ORIGIN" ] \
    || echo "⚠️ origin 이 없는 구형 응답 문서다 — 머신 일치를 확인할 수 없다. resume 이 실패하면 그 이유일 수 있다."

  # 🔴 턴 번호는 **문서가 권위**다. Claude 가 세는 것을 믿지 않는다.
  PREV_TURNS=$(fmf "$RESP_REL" turns); PREV_TURNS=${PREV_TURNS:-1}
  case "$PREV_TURNS" in ''|*[!0-9]*) die "응답 문서의 turns 가 정수가 아니다: '$PREV_TURNS' ($RESP_REL)" ;; esac
  [ "$FUP_TURN" -eq $((PREV_TURNS + 1)) ] || die "턴 번호가 어긋난다.
  응답 문서에 쌓인 턴: $PREV_TURNS  →  이번 반박서는 turn: $((PREV_TURNS + 1)) 이어야 한다
  반박서가 주장하는 turn: $FUP_TURN
  (건너뛰거나 되돌아가면 대화 기록과 Codex 세션의 맥락이 어긋난다)"

  # ── 턴 상한 = 11 (2026-08-25 사용자 결정) ────────────────────
  #    근거: 사용자가 Codex 와 직접 대화해 결론에 도달한 세션의 **실측 사용자 턴 수가 11회**였다.
  #    같은 장애를 CONSULT(1턴 단발)로는 3회 물어도 결론이 안 났다. 그 실측을 상한으로 삼는다.
  CONSULT_MAX="${CR_CONSULT_MAX_TURN:-11}"
  case "$CONSULT_MAX" in
    ''|*[!0-9]*) die "CR_CONSULT_MAX_TURN 은 정수여야 한다: $CONSULT_MAX" ;;
  esac
  [ "$FUP_TURN" -le "$CONSULT_MAX" ] || die "턴 상한($CONSULT_MAX)을 넘었다 — ${FUP_TURN}턴은 돌리지 않는다.
  🔴 여기까지 왔는데 완료 게이트가 안 채워졌다면 **Codex 를 더 부를 문제가 아니다.**
     남은 게이트 항목과 마지막 턴까지의 대립점을 사용자에게 올리고 판단을 받아라."

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

  # ── 🔴 양방향 잠금 ② — 반박서가 요청서 경로로 들어오는 것을 막는다 (2026-08-25) ──
  #
  #    반박서와 원 요청서는 **같은 response_path** 를 가리킨다. 그래서 반박서를 이 경로로
  #    실행하면 규약 검증을 전부 통과하고, Codex 가 workspace-write 로 돌면서
  #    **1턴 원문과 `## Claude 검토` 가 담긴 응답 문서를 통째로 덮어쓴다.**
  #    N턴 대화가 한 번에 날아가는 경로다 — 실측으로 구멍을 확인하고 막았다.
  REQ_TYPE=$(fm type)
  case "$REQ_TYPE" in
    codex_followup) die "이건 반박서다. 요청서 경로로 실행하지 마라: $REQ
  🔴 이대로 돌면 Codex 가 **1턴 원문과 Claude 검토가 담긴 응답 문서를 덮어쓴다.**
     ($RESP — 반박서와 원 요청서는 같은 응답 문서를 가리킨다)

  되묻기는 이렇게 한다:
     bash \"\$0\" --followup $REQ" ;;
  esac
  case "$MODE" in
    followup) die "mode: followup 은 요청서로 실행할 수 없다: $REQ
  🔴 위와 같은 이유다 — \`--followup\` 으로 불러라." ;;
    readonly|edit) ;;
    *) die "요청서의 mode 가 알 수 없는 값이다: '$MODE' ($REQ)
  readonly 또는 edit 이어야 한다." ;;
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
mkdir -p -- "$SCRATCH_REL" || die "scratch 디렉토리를 만들 수 없다: $SCRATCH_REL"
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
  die "같은 스탬프($STAMP)가 이미 실행 중이다 — 동시 실행은 응답·로그를 덮어쓴다.

  lock: $LOCK

  이 중 하나다:
   ① 정말 지금 돌고 있다   → 끝날 때까지 기다려라
   ② 비정상 종료로 남았다   → lock 파일을 지우고 다시 실행해라

  판별: lock 의 mtime 을 봐라. 몇 분 이상 지났고 codex 프로세스가 없으면 ②다."
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
  { [ -n "$IF_RESP" ] && [ -f "$IF_RESP" ]; } || die "귀속할 수 없는 in-flight 마커다: $INFLIGHT
  어느 문서가 끊겼는지 알 수 없어 **아무것도 건드리지 않았다.** 내용을 확인하고 지워라."
  if fm_set "$IF_RESP" thread_id "" && [ -z "$(fmf "$IF_RESP" thread_id)" ]; then
    {
      echo
      echo "## ⚠️ 스레드 끊김 · $(date '+%Y-%m-%d %H:%M:%S')"
      echo
      echo "지난 followup(${IF_TURN:-?}턴)이 codex 호출과 기록 사이에서 강제 종료됐다(마커: ${IF_WHEN:-시각 불명})."
      echo "Codex 세션에는 그 턴이 남았는데 이 문서에는 안 남아 맥락이 어긋났다 — 스레드를 폐기했다."
      echo "이 건은 더 이어붙일 수 없다. 새 CONSULT 로 시작해라."
    } >> "$IF_RESP"
    echo "⚠️ 지난 followup 이 중간에 죽어 있었다 — 스레드를 폐기했다: $IF_RESP"
  else
    die "지난 실행의 스레드를 폐기하지 못했다: $IF_RESP
  그대로 두면 어긋난 세션을 재개한다. 손으로 thread_id 를 비워라."
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
elif [ "$KIND" = followup ]; then
  FUP_W=$(winp "$FUP_ABS")         || exit 2
  RESP_W=$(winp "$ROOT/$RESP_REL") || exit 2
  # 🔴 quoted heredoc 이다 — 이유는 아래 CONSULT 쪽 주석과 같다 (2026-08-26).
  #    이 본문은 원래 백틱을 `\`` 로 이스케이프해서 버티고 있었다. 그 방식은 한 줄만
  #    놓쳐도 조용히 터지고, 실제로 CONSULT 히어독에서 **같은 히어독 안 16줄 차이로**
  #    한 줄은 지키고 한 줄은 놓쳐 자격증명 금지 문구가 통째로 날아갔다.
  #    여기서 날아가면 "## Claude 검토 를 읽어라"가 사라진다 — 되묻기의 작동 원리 자체다.
  read -r -d '' PROMPT <<'EOF' || :
같은 문제를 이어서 논의한다. 앞 턴에서 네가 한 분석에 대해, Claude 가 검토하고 되묻는다.

반박서: __CR_FUP_W__
직전까지의 대화 기록(네 원문 + Claude 의 검토): __CR_RESP_W__

먼저 위 두 파일을 읽어라. 특히 응답 문서의 `## Claude 검토` 섹션들 —
**네 분석이 어떻게 해석됐는지가 거기 있다.**

🔴 반드시 지켜라:
- **아무 파일도 만들거나 수정하거나 삭제하지 마라. 읽기만 해라.**
  이번 턴은 read-only 로 돌고 있고, 네 답변은 최종 메시지로 자동 회수된다.
  응답 문서에 직접 쓰려고 하지 마라 — 스크립트가 대신 이어 붙인다.
- **Claude 의 해석이 네 뜻과 다르면 그것부터 바로잡아라.** 이 턴의 존재 이유다.
  "너는 X 라고 읽었지만 나는 Y 를 뜻했다" 를 명시적으로 써라.
- **기각당한 지적은 근거를 보고 다시 판단해라.** 수용이면 수용이라고, 근거가 틀렸으면
  왜 틀렸는지 반박해라. 물러서지도, 고집하지도 마라 — 근거로 판단해라.
- 반박서의 완료 게이트 각 항목에 대해 **충족/미충족을 네가 직접 판정**해라.
  이 대화는 "더 물을 게 없을 때"가 아니라 **"핵심 증상이 설명됐을 때"** 끝난다.
EOF
  PROMPT=${PROMPT//__CR_FUP_W__/"$FUP_W"}
  PROMPT=${PROMPT//__CR_RESP_W__/"$RESP_W"}

elif [ "$MODE" = "edit" ]; then
  # 🔴 quoted heredoc 이다 (2026-08-26). 지금 이 본문에는 백틱이 없어 사고가 안 났을 뿐,
  #    구조는 CONSULT 히어독과 똑같다. **EDIT 은 Codex 가 실제로 코드를 고치는 모드**라,
  #    "대상 파일 외에는 건드리지 마라" 같은 제약 문장이 조용히 비면 손실이 파일 단위다.
  #    마크다운 한 줄을 더 쓰는 순간 터지는 자리라 미리 막는다.
  read -r -d '' PROMPT <<'EOF' || :
아래 요청서 파일을 읽고, 그 안에 적힌 지시를 그대로 따라라.

요청서: __CR_REQ_W__

- 요청서에 보고서를 저장할 경로와 파일명이 명시되어 있다. 그 경로에 그 이름 그대로 저장해라.
- 요청서가 지정한 대상 파일 외에는 건드리지 마라.
- 단 **조사·검증은 자유다** — 디스크 읽기·네트워크 조회·명령 실행을 써라(네트워크는 조회 전용).
  재현·검증용 임시 파일은 __CR_SCRATCH_REL__/ 안에 만들어라. 거긴 네 작업대다.
  🔴 **수정 대상 옆에 백업본·테스트 파일을 흩뿌리지 마라** — 전부 무단 변경으로 보고된다.
- 저장이 실패하면 같은 내용을 최종 메시지로 그대로 출력해라. 자동으로 회수된다.
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
아래 요청서 파일을 읽고, 그 안에 적힌 지시를 그대로 따라라.

요청서: __CR_REQ_W__

너는 이 사건의 **독립 조사자**다. 요청서는 출발점이지 경계가 아니다.
Claude 는 이미 그 안의 자료로 답을 못 찾았다. 같은 자료를 같은 방식으로 읽으면 같은 결론이 나온다.

🔴 지켜야 할 선은 **하나**다 — 프로덕션 파일을 고치지 마라.

- **코드를 고치지 마라.** 너는 분석·진단과 수정 방법 제시만 한다. 실제 수정은 Claude 가 한다.
- 네가 쓸 수 있는 곳은 **정확히 두 곳**이다:
    ① 요청서가 지정한 응답 문서
    ② __CR_SCRATCH_REL__/    ← 네 작업대다
  이 둘 밖의 파일은 만들거나 고치거나 지우지 마라. 저장소 상태를 바꾸는 명령도 금지다
  (git commit·checkout·stash·reset, 패키지 설치, 빌드).

그 밖의 조사는 **막지 않는다. 끝까지 파라.**
- **원본을 직접 열어라.** 디스크 어디든 읽어도 된다 — 워크스페이스 밖도 읽기는 허용돼 있다.
  요청서에 인용된 조각만 믿지 마라. **요약과 원본이 어긋나면 원본이 이긴다.**
- **계산·정렬·파싱·재집계를 직접 실행해라.** 스크립트를 짜서 돌려도 된다. 수치를 추측하지 말고 뽑아라.
  그 산출물(스크립트·중간 데이터·메모)은 위 작업대에 **마음껏** 만들어라 — 개수·크기 제한이 없고
  지우지 않아도 된다. 남겨 두면 Claude 가 네 계산을 재현할 수 있어 오히려 낫다.
- **네트워크를 써도 된다** — 문서·이슈·릴리스노트를 검색하고 직접 확인해라.
  단 **조회 전용**이다. 어디에도 데이터를 올리지 마라(POST/PUT·git push·publish 금지).
  🔴 **자격증명을 읽지 마라.** SSH 키·`.env`·`credentials`·`auth.json`·토큰·비밀번호가 든 파일은
     조사에 필요하더라도 **내용을 열지 마라.** 존재 여부와 경로까지만 확인해라.
     네트워크가 열려 있으므로 **읽는 순간 나갈 수 있는 상태**가 된다 — 그래서 읽기 쪽을 막는다.
     그런 값이 원인 규명에 꼭 필요하면 **"무엇이 왜 필요한지"만 응답에 적어라.** Claude 가 판단한다.
- Claude 의 가설은 참고 자료다. **틀렸으면 버려라.** 그걸 검증하는 데 시간을 다 쓰지 마라 —
  가설이 통째로 무의미할 수 있다. 원본이 다른 곳을 가리키면 그쪽을 쫓아가라.
- "기존 분석법이 실패했다"는 **"그 데이터를 다시 보지 마라"는 뜻이 아니다.**
  같은 원본을 다른 방법으로 분석하는 것은 언제나 허용이고, 대개 그게 정답이다.

🔴 **막혔다고 포기하지 마라.** 이 실행에는 승인을 눌러 줄 사람이 없다(approval_policy=never).
   권한이 필요해 보이면 기다리지 말고 위에 허용된 수단으로 우회해 조사를 끝내라.
   그래도 못 하면 **무엇이 막혀 무엇을 확인하지 못했는지**를 응답에 명시해라.
   확인 못 한 것을 확인한 척하지 마라.

🔴 **지금 열 수 있는 자료를 남겨 둔 채 "자료를 더 달라"로 끝내지 마라.**
   요청서에 경로가 있거나 워크스페이스에서 찾을 수 있는 것은 네가 직접 연다.
   `ls`·`find` 로 목록만 본 것은 연 것이 아니다 — 내용을 읽고 계산까지 해야 연 것이다.

- 요청서에 응답을 저장할 경로와 파일명이 명시되어 있다. 그 경로에 그 이름 그대로 저장해라.
- 저장이 실패하면 같은 내용을 최종 메시지로 그대로 출력해라. 자동으로 회수된다.
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
  SANDBOX="read-only (followup 고정 · -c sandbox_mode)"
  set -- codex exec resume "$THREAD" --skip-git-repo-check --json \
         -c sandbox_mode="read-only" -o "$LASTMSG_W"

else
  SANDBOX="${CR_SANDBOX:-workspace-write}"
  set -- codex exec --skip-git-repo-check --json -s "$SANDBOX" -C "$ROOT_W" -o "$LASTMSG_W"

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

# ── 🔴 표시용 샌드박스 — 끼어들기 경로는 read-only 로 돈다 (2026-08-26) ──────
#
# 아래 실행부(§ CR_LIVE_STEER)는 중계기에 `--sandbox read-only` 를 **고정으로** 넘긴다.
# 그런데 보고문은 `$SANDBOX`(exec 경로용 값)를 그대로 찍고 있어서, live steer 로 돌면
# `workspace-write +net` 이라고 **거짓 보고**했다 (2026-08-26 실측).
# 실제로는 read-only 라 Codex 가 응답 파일을 못 쓰고 `-o` 폴백으로 저장되는데,
# 보고만 읽으면 "쓰기 권한이 있는데 왜 못 썼나"로 원인을 엉뚱한 데서 찾게 된다.
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

LIVE_STEER_ON=0
if [ "${CR_LIVE_STEER:-}" = "1" ] && [ "$KIND" = doc ] && [ "$MODE" = readonly ] && [ "$NODE_WS_OK" = 1 ]; then
  LIVE_STEER_ON=1
fi

# 🔴 못 쓰는 이유를 반드시 말한다. 조용히 옛 경로로 떨어지면, 사용자는 도중에 말을 걸었다가
#    전달이 안 되는 것을 그때서야 알게 된다. 그 시점엔 이미 늦다.
if [ "$LIVE_STEER_ON" != 1 ] && [ "${CR_LIVE_STEER:-}" = "1" ] \
   && [ "$KIND" = doc ] && [ "$MODE" = readonly ]; then
  if [ "$NODE_WS_OK" != 1 ]; then
    echo "⚠️  이번 실행에는 끼어들 수 없다 — 이 Node 에 전역 WebSocket 이 없다." >&2
    echo "    Node 22+ 를 쓰거나, Node 20.10+ 라면 --experimental-websocket 이 있어야 한다." >&2
    echo "    현재: $(node -v 2>/dev/null || echo 'node 없음') · 옛 exec 경로로 돈다." >&2
  fi
fi
if [ "$LIVE_STEER_ON" = 1 ]; then
  SANDBOX_SHOWN="read-only (끼어들기 경로 고정)"
else
  SANDBOX_SHOWN="$SANDBOX"
fi

if [ -n "${CR_DRYRUN:-}" ]; then
  echo "── DRYRUN — 실행하지 않는다 ──"
  echo "종류     : $KIND"
  echo "루트     : $ROOT"
  echo "모드     : $MODE / 샌드박스: $SANDBOX_SHOWN"
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
  echo "→ Codex 실행 중… (요청서: $REQ / 샌드박스: $SANDBOX_SHOWN)" >&2
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

# ── 🔴 실행 중 끼어들기 경로 (CR_LIVE_STEER=1, CONSULT 1턴 전용) ────────
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
  [ -f "$LIVE_BRIDGE" ] || die "CR_LIVE_STEER=1 인데 중계기가 없다: $LIVE_BRIDGE
  스킬을 다시 받아라 (scripts/ 디렉토리가 함께 온다)."
  command -v node >/dev/null 2>&1 || die "CR_LIVE_STEER=1 에는 node 가 필요하다."
fi

if [ -n "$LIVE_BRIDGE" ]; then
  echo "→ 실행 중 끼어들기 경로(app-server) 로 돈다 — 대화키: $STAMP" >&2
  # 🔴 `$LIVE_EVENTS` 에 직접 쓰고 끝나서 `$EVENTS` 로 복사한다. tee 파이프라인을 흉내내는
  #    것인데, 파이프가 아니라 단일 프로세스라 PIPESTATUS 가 성립하지 않기 때문이다.
  # $NODE_WS_FLAG 는 따옴표 없이 편다 — 빈 값일 때 빈 인자가 생기면 안 된다.
  # 값은 위에서 이 스크립트가 정한 리터럴 하나뿐이라 분할 위험이 없다.
  # shellcheck disable=SC2086
  node $NODE_WS_FLAG "$LIVE_BRIDGE" run \
    --request-file "$REQ_ABS" \
    --events-file "$LIVE_EVENTS" \
    --last-message-file "$LASTMSG" \
    --appserver-log "$LOGD/${STAMP}_appserver.jsonl" \
    --steers-log "$LOGD/${STAMP}_steers.jsonl" \
    --stamp "$STAMP" \
    --cwd "$ROOT" \
    --sandbox read-only \
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
  || die "실행 후 스캔 실패 — 변경 여부를 판정할 수 없다. Codex 는 이미 실행됐으므로 $RUN_DIR 를 직접 확인해라"
TOUCHED=$(printf '%s\n' "$TOUCHED" | LC_ALL=C sort | sed 's|^\./||')

AFTER="$RUN_DIR/after.list"
SCAN | LC_ALL=C sort > "$AFTER" || die "실행 후 목록 스냅샷 실패 — 삭제 여부를 판정할 수 없다"
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
STRAY=$(printf '%s\n%s\n' "$TOUCHED" "$ADDED" | grep -v '^[[:space:]]*$' \
        | LC_ALL=C sort -u | grep -Fvx -- "$RESP_REL" \
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
    } >> "$RESP_REL" || die "턴 기록 실패: $RESP_REL
  🔴 Codex 세션에는 이 턴이 남았는데 문서에는 안 남았다. thread_id 를 손으로 비워라."
    fm_set "$RESP_REL" turns "$FUP_TURN" && [ "$(fmf "$RESP_REL" turns)" = "$FUP_TURN" ] \
      || die "turns 갱신 실패: $RESP_REL — 다음 턴의 번호 검증이 어긋난다. 손으로 고쳐라."
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
if [ "$KIND" = doc ] && { [ "$AUTHOR" = codex ] || [ "$AUTHOR" = codex-via-stdout ]; }; then
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
      && echo "⚠️ 응답 문서에 frontmatter 가 없어 규약 헤더를 붙였다(원문은 보존)." \
      || rm -f -- "$FM_TMP" 2>/dev/null
  fi

  if [ -z "$NEW_THREAD" ]; then
    THREAD_WHY="이벤트 스트림에 thread_id 가 없다"
  elif ! fm_ok "$RESP_REL"; then
    # 위에서 붙이는 것도 실패했다면 손대지 않는다.
    THREAD_WHY="응답 문서의 frontmatter 경계가 깨져 있고 헤더 삽입도 실패했다"
  elif fm_set "$RESP_REL" thread_id "$NEW_THREAD" \
       && fm_set "$RESP_REL" origin "$(hostname 2>/dev/null || echo unknown)" \
       && fm_set "$RESP_REL" turns 1 \
       && [ "$(fmf "$RESP_REL" thread_id)" = "$NEW_THREAD" ]; then
    THREAD_SAVED="$NEW_THREAD"
  else
    THREAD_WHY="frontmatter 에 쓰지 못했다(권한·디스크를 확인해라)"
  fi
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
elif [ "$KIND" = followup ]; then
  echo "되묻기   : ${FUP_TURN}턴   (반박서: $FUP)"
  echo "대화     : $RESP_REL   ·   스레드: $THREAD"
else
  echo "요청서   : $REQ"
fi
echo "모드     : $MODE / 샌드박스: $SANDBOX_SHOWN / codex exit: $RC"
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
if [ -n "$SCRATCH_MADE" ]; then
  echo
  echo "🧪 Codex 작업 폴더에 $(printf '%s\n' "$SCRATCH_MADE" | wc -l | tr -d ' ')건이 남았다 — **정상이다.**"
  echo "   $SCRATCH_REL/ 에 있는 조사 흔적(계산 스크립트·중간 데이터)이다. 위반이 아니다."
  echo "   응답의 수치가 어떻게 나왔는지 따질 때 여기를 열어라. git 에는 올라가지 않는다."
  printf '%s\n' "$SCRATCH_MADE" | sed 's/^/     /'
fi
echo "   (감시 제외 영역: $PRUNED — 이 안의 변경과, 생성 후 삭제·mtime 원복은 잡지 못한다)"
case "$SANDBOX" in
  *danger-full-access*)
    echo
    echo "   🔴 이 실행은 danger-full-access 였다 — **cwd 밖 파일 수정이 가능했고, 위 감지는"
    echo "      그것을 원리적으로 못 본다**(감지는 cwd 기준 \`find .\` 이다)."
    echo "      위의 '변경 없음'을 'cwd 밖도 안전하다'로 읽지 마라 — 확인된 바가 없다는 뜻이다."
    echo "      $LOGD/${STAMP}_events.jsonl 의 shell·apply_patch 인자를 직접 훑어 대조해라." ;;
esac

echo
echo "🔴 Claude 가 이어서 할 일:"
if [ "$KIND" = followup ] && [ "$AUTHOR" = codex ]; then
  echo "   1. $RESP_REL 를 Read 한다 — 맨 아래 '## 🔷 ${FUP_TURN}턴 — Codex 재답변' 이 이번 답이다"
  echo "   2. 🔴 **Codex 가 네 해석을 교정했는지부터 봐라.** 이 모드의 존재 이유다."
  echo "      '너는 X 라고 읽었지만 나는 Y 를 뜻했다' 가 있으면 그 교정을 받아들이고 다시 판단해라"
  echo "   3. 그 아래에 '## Claude 검토 (${FUP_TURN}턴)' 을 덧붙인다 — 채택/보류/기각 + 근거"
  echo "   4. **§ 절차 10 종료 판정표를 위에서부터 훑는다.** 처음 걸리는 줄에서 멈춘다"
  echo "      · 새 정보가 없다(같은 말의 재배열) → **종료.** 더 물어도 안 나온다"
  echo "      · 되묻기 사유 3개 중 하나에 해당 → 다음 반박서 (상한 ${CONSULT_MAX}턴):"
  echo "          docs/codex_rescue/${STAMP}_followup$((FUP_TURN + 1))_${SLUG}.md   (turn: $((FUP_TURN + 1)))"
  echo "          bash \$0 --followup 그 경로   ← run_in_background: true"
  echo "      · 그 외 전부 → **종료.** 채택/보류/기각 판단으로"
  echo "   🔴 **기본은 종료다.** 왕복 자체가 목적이 아니다 — 턴이 아니라 **새 정보**가 답을 만든다"
elif [ "$KIND" = followup ]; then
  echo "   1. ${FUP_TURN}턴이 실패했다 — $ERR_DEST 를 읽어 원인을 사용자에게 보고한다"
  if [ "$FUP_DISCARDED" = 1 ]; then
    echo "   2. 🔴 스레드가 폐기됐다. 같은 건에 followup 을 더 붙일 수 없다"
    echo "      이어서 물으려면 지금까지의 대화를 재료로 **새 CONSULT 요청서**를 써라"
  else
    echo "   2. 🔴 스레드 폐기에 **실패했다** — $RESP_REL 의 thread_id 가 그대로다"
    echo "      그대로 두면 다음 턴이 어긋난 세션을 재개한다. 손으로 thread_id 를 비워라"
  fi
elif [ "$KIND" = review ] && [ "$AUTHOR" = codex ]; then
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

# ── 🔁 1턴 CONSULT 뒤: 되묻기 안내 (2026-08-25) ─────────────────
if [ "$KIND" = doc ] && [ "$MODE" != "edit" ]; then
  if [ -n "$THREAD_SAVED" ]; then
    echo
    echo "🔁 **되물을 수 있다** — 이 건은 이어서 대화할 수 있게 준비됐다."
    echo "   실측(2026-08-25): 같은 장애를 CONSULT 단발로 **3회** 물어도 결론이 안 났고,"
    echo "   사용자가 Codex 와 **11턴** 대화하니 났다. 같은 모델·같은 effort 였다."
    echo "   **차이는 턴 수다.** 한 번 받고 혼자 해석해 결론 내지 마라."
    echo
    echo "   🔴 **되묻기는 예외다. 기본은 여기서 끝내는 것이다.** 사유는 셋뿐이다:"
    echo "     · **핵심 증상이 설명되지 않았다** ← 물어본 이유 자체가 안 풀렸다"
    echo "     · **Codex 지적을 기각했는데 그 근거를 코드·로그로 확인 못 했다**"
    echo "       (내 기각이 틀렸을 수 있고, Codex 는 자기가 기각당한 줄 모른다)"
    echo "     · **응답에 명백한 사실 오류가 있다**"
    echo "   ⚠️ 'Codex 가 내 가설에 동의했다' 는 사유가 아니다. 되묻기 2회 이상은 **새 정보가 있을 때만.**"
    echo "   ⚠️ 원본을 안 열었을 뿐이고 내가 직접 열 수 있으면 — **되묻지 말고 내가 연다.** 그게 빠르다."
    echo
    echo "   방법:"
    echo "     1. docs/codex_rescue/${STAMP}_followup2_${SLUG}.md 를 쓴다 (turn: 2)"
    echo "     2. bash \$0 --followup 그 경로   ← run_in_background: true"
  elif [ -n "$THREAD_WHY" ]; then
    echo
    echo "⚠️ 이 건은 **되물을 수 없다** — $THREAD_WHY"
    echo "   1턴 분석 자체는 정상이다. 더 물어야 하면 새 CONSULT 요청서를 써라."
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
