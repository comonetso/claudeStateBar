---
type: codex_response
mode: readonly
stamp: 260822_220007
slug: chat-session-boundary
author: codex
---

# CHAT 호출 경계 판정

## 1. 내 가설에 대한 판정

**부분 동의**다.

`--stamp` 자체가 호출 경계를 알아내 주지는 않는다. 새 `/codex_rescue` 호출에서는 새 값을 만들고, 같은 호출 안의 후속 턴에서는 직전 값을 재사용해야 한다는 판단은 여전히 Claude에게 남는다. 이 의미에서는 현재의 “첫 턴이면 `--new`를 붙인다”와 본질적으로 같다. 특히 다음 의미의 단일 `--stamp`는 추천하지 않는다.

```sh
# 위험한 다의적 계약
# 해당 stamp 문서가 있으면 resume, 없으면 새 문서 생성
send.sh --chat --stamp "$STAMP" --slug "$SLUG" "$MSG"
```

오타·값 유실·잘못 만든 새 스탬프가 모두 **조용한 새 대화 분리**로 바뀐다. 이는 이번 `$PWD` 사고와 실패 양식이 같다.

다만 스탬프를 **스크립트가 발급한 정확한 대화 핸들**로 쓰고, `새로 시작`과 `정확히 재개`를 서로 다른 명령으로 강제하면 현재 `--new`보다 실질적으로 안전해진다. 강제력은 스탬프라는 문자열에서 나오는 것이 아니라 다음 네 규칙에서 나온다.

1. 매 턴 `--start`와 `--resume-stamp <값>` 중 정확히 하나를 필수로 한다.
2. `--start`의 스탬프는 호출자가 만들지 않고 `send.sh`가 발급한다.
3. `--resume-stamp`는 정확한 파일이 없거나 닫혔거나 다른 머신 것이면 **새로 만들지 않고 오류로 중단**한다.
4. 슬러그 최신 문서 glob을 재개 경로에서 완전히 제거한다.

따라서 **“호출자가 스탬프만 일관되게 넘긴다”는 원 가설은 경계 문제를 해결하지 못하지만, “명시적 start/resume 프로토콜의 핸들로 스탬프를 쓴다”는 수정 가설은 추천**한다. 기존 문서의 파일명·`stamp`·`slug`·`thread_id`만 사용하므로 새 frontmatter 필드도 필요 없다.

현재 자동 이어받기는 `skills/codex_rescue/send.sh:189-194`의 최신 슬러그 glob과 `219-260`의 `--new` 분기에 의존하고, 호출자 지침도 슬러그를 식별자로 설명한다(`skills/codex_rescue/SKILL.md:266-289`). 이 두 곳의 계약을 함께 바꿔야 한다.

## 2. 네가 보는 근본 원인

근본 원인은 상태 저장 수단의 부족이 아니라 **관측 가능한 경계 신호의 부재**다.

같은 프로젝트·슬러그·머신에서 다음 두 상황을 생각하면 된다.

- 상황 A: 한 번의 `/codex_rescue` 호출 안에서 두 번째 Codex 턴을 보낸다.
- 상황 B: 첫 `/codex_rescue`가 끝난 직후 같은 슬러그로 새 `/codex_rescue`의 첫 턴을 보낸다.

두 번째 `send.sh` 프로세스가 보는 인자, 환경, cwd, 문서, 시간까지 같게 만들 수 있다. 관측값이 같은데 정답은 A에서는 resume, B에서는 start이므로 셸 알고리즘만으로는 둘을 항상 맞힐 수 없다. 파일에 `active=true`를 남겨도 **언제 이전 스킬 호출이 끝났는지**를 알려 주는 사건이 없으므로 문제를 옮길 뿐이다.

- **PPID·프로세스 트리:** 보통 Bash 도구 실행기나 Claude Code 프로세스의 수명이다. 스킬 호출 수명과 일치한다는 계약이 없고 PID 재사용도 있다.
- **환경변수 상속:** 자식 셸이 만든 값은 부모나 다음 Bash 호출로 역전파되지 않는다. 호스트가 넣는 세션 ID가 있어도 대개 Claude 대화 전체 범위이지 스킬 1회 범위라는 보장이 없다.
- **TTY·터미널 세션·SSH 정보:** 여러 스킬 호출 동안 동일하며, Bash 도구가 TTY 없이 실행될 수도 있다. Windows Git Bash와 Linux에서 의미도 다르다.
- **파일 lease·idle timeout:** 같은 호출 중 사람이 오래 생각한 경우와 다음 호출이 곧바로 온 경우를 구분하지 못한다. 보조 경고에는 쓸 수 있지만 식별자의 권위가 될 수 없다.
- **daemon·백그라운드 프로세스:** 상태를 오래 보존할 뿐, 호출 종료 신호가 없다는 문제는 그대로다.

호출자 협조 없이 가능한 경우는 둘뿐이다. Claude Code 호스트가 **스킬 호출마다 고유한 ID**를 각 Bash 호출에 제공하거나, 스킬 호출 전체와 수명이 정확히 같은 단일 프로세스가 모든 턴을 처리해야 한다. 현재 “턴마다 새 `send.sh` 프로세스” 계약과 제공된 자료에는 둘 다 없다. 따라서 순수 Bash만으로 엄밀한 자동 판정은 불가능하다고 본다.

시도 이력 1의 `git rev-parse --show-toplevel` 수정(`send.sh:105-137`)은 옳다. 그것은 동일 호출의 턴이 서로 다른 저장소를 보던 **위치 동일성** 문제를 해결한다. 그러나 위치가 같아졌다고 호출 경계 신호가 생기지는 않는다. 시도 2의 문서 규약과 시도 3의 EDIT 게이트가 보여 준 교훈도 같다. 모델 지침은 정책이고, 셸의 필수 인자·검증·거부가 집행 장치다.

## 3. 수정 방법 (before → after)

### Before

```sh
# --new가 없으면 최신 slug 문서를 자동 선택한다.
CH_PREV_DOC=""
for f in "$CH_DOCS"/*_chat_"${CH_SLUG}".md; do
  [ -f "$f" ] && CH_PREV_DOC="$f"
done

CH_DOC="$CH_PREV_DOC"
if [ -n "$CH_DOC" ] && [ "$CH_NEW" = 0 ]; then
  # resume
else
  # 새 stamp 생성
fi
```

### After — 추천하는 최소 계약

호출 형식을 다음처럼 바꾼다.

```sh
# 스킬 호출의 첫 Codex 턴: 항상 새 문서. stamp는 send.sh가 발급한다.
send.sh --chat --start --slug <slug> [--subject <subject>] <message>

# 같은 스킬 호출 안의 다음 Codex 턴: 첫 턴 stdout의 stamp를 정확히 전달한다.
send.sh --chat --resume-stamp <YYMMDD_HHMMSS> --slug <slug> <message>
```

인자 파서는 동작을 필수·상호 배타적으로 만든다.

```sh
CH_ACTION=""
CH_RESUME_STAMP=""

case "$1" in
  --start)
    [ -z "$CH_ACTION" ] || die "--start와 --resume-stamp는 같이 쓸 수 없다"
    CH_ACTION=start
    shift
    ;;
  --resume-stamp)
    [ -n "${2:-}" ] || die "--resume-stamp 값이 없다"
    [ -z "$CH_ACTION" ] || die "--start와 --resume-stamp는 같이 쓸 수 없다"
    CH_ACTION=resume
    CH_RESUME_STAMP="$2"
    shift 2
    ;;
  --new)
    die "--new는 호출 경계를 보장하지 못한다. 첫 턴은 --start를 써라"
    ;;
esac

[ -n "$CH_ACTION" ] || die \
  "CHAT 동작이 모호하다. 첫 턴은 --start, 후속 턴은 --resume-stamp <값>이 필요하다"

if [ "$CH_ACTION" = resume ]; then
  [[ "$CH_RESUME_STAMP" =~ ^[0-9]{6}_[0-9]{6}$ ]] \
    || die "잘못된 resume stamp: $CH_RESUME_STAMP"
fi
```

프로젝트 루트·락·기본 검증을 마친 뒤, 최신 슬러그 glob 대신 대상을 정확히 정한다.

```sh
ch_fm() { # $1=file, $2=key
  sed -n "1,/^---$/ s/^$2:[[:space:]]*//p" "$1" \
    | head -1 | tr -d '\r'
}

if [ "$CH_ACTION" = start ]; then
  CH_STAMP=$(date "+%y%m%d_%H%M%S") || die "스탬프 생성 실패"

  # 현재 확장도 stamp를 대화 식별에 사용하므로 같은 초 충돌을 조용히 허용하지 않는다.
  for f in "$CH_DOCS/${CH_STAMP}_chat_"*.md; do
    [ -e "$f" ] && die "대화 stamp 충돌: $CH_STAMP — 1초 뒤 다시 실행해라"
  done

  CH_DOC="$CH_DOCS/${CH_STAMP}_chat_${CH_SLUG}.md"
  CH_THREAD=""
else
  CH_STAMP="$CH_RESUME_STAMP"
  CH_DOC="$CH_DOCS/${CH_STAMP}_chat_${CH_SLUG}.md"
  [ -f "$CH_DOC" ] || die \
    "재개할 문서가 없다: ${CH_STAMP}_chat_${CH_SLUG}.md (새 문서를 만들지 않았다)"

  CH_DOC_STAMP=$(ch_fm "$CH_DOC" stamp)
  CH_DOC_SLUG=$(ch_fm "$CH_DOC" slug)
  [ "$CH_DOC_STAMP" = "$CH_STAMP" ] || die "파일명과 frontmatter stamp가 다르다"
  [ "$CH_DOC_SLUG" = "$CH_SLUG" ] || die "파일명과 frontmatter slug가 다르다"

  CH_DOC_ORIGIN=$(ch_fm "$CH_DOC" origin)
  if [ -n "$CH_DOC_ORIGIN" ] && [ "$CH_DOC_ORIGIN" != "$CH_ORIGIN" ]; then
    die "다른 머신($CH_DOC_ORIGIN)의 대화다. 자동으로 새 대화로 바꾸지 않았다; --start를 명시해라"
  fi
  [ -n "$CH_DOC_ORIGIN" ] || echo \
    "⚠️ origin 없는 구형 문서다 — 머신 일치를 확인할 수 없지만 요청한 문서만 재개한다."

  CH_THREAD=$(ch_fm "$CH_DOC" thread_id)
  [ -n "$CH_THREAD" ] || die \
    "이 대화는 닫혔거나 끊겼다. 같은 파일에 새 thread를 섞지 않았다; --start를 명시해라"
fi
```

성공 stdout에는 사람이 읽는 경로 외에 후속 호출용 값을 고정된 형식으로 낸다.

```sh
echo "대화키: $CH_STAMP"
echo "기록  : ${CH_DOC#"$CH_ROOT"/}"
```

`SKILL.md`의 첫 턴 예시는 반드시 `--start`, 후속 턴 예시는 반드시 직전 stdout의 `대화키`를 사용하도록 함께 고쳐야 한다. 새 `/codex_rescue` 호출이 시작되면 이전 키가 대화 문맥에 보여도 **첫 턴은 무조건 `--start`**다. 이 마지막 의미 판단까지 셸이 검증할 수는 없지만, 누락·오타·없는 대상·닫힌 대상·다른 origin 같은 기계적으로 검출 가능한 오류는 모두 Codex 호출 전에 중단된다.

### in-flight 복구도 exact stamp로 변경

현재 복구는 `.inflight`가 있으면 `CH_PREV_DOC`, 즉 최신 슬러그 문서를 폐기한다(`send.sh:196-217`). 호출별 문서로 바꾼 뒤 이 로직을 유지하면, 새 호출의 첫 턴이 문서 생성 전에 죽었을 때 **관계없는 과거 문서**를 닫을 수 있다. 마커가 이미 기록하는 `stamp`와 `slug`(`send.sh:305-323`)를 권위로 써야 한다.

```sh
if [ -f "$CH_INFLIGHT" ]; then
  CH_IF_STAMP=$(sed -n 's/^stamp=//p' "$CH_INFLIGHT" | head -1 | tr -d '\r')
  CH_IF_SLUG=$(sed -n 's/^slug=//p'  "$CH_INFLIGHT" | head -1 | tr -d '\r')

  [[ "$CH_IF_STAMP" =~ ^[0-9]{6}_[0-9]{6}$ ]] \
    || die "귀속할 수 없는 구형/손상 in-flight 마커다: $CH_INFLIGHT"
  [ "$CH_IF_SLUG" = "$CH_SLUG" ] \
    || die "in-flight 마커 slug가 락 대상과 다르다: $CH_INFLIGHT"

  CH_IF_DOC="$CH_DOCS/${CH_IF_STAMP}_chat_${CH_IF_SLUG}.md"
  if [ -f "$CH_IF_DOC" ]; then
    ch_discard_thread "$CH_IF_DOC" "지난 실행이 기록 전에 강제 종료됐다." \
      || die "마커가 가리킨 스레드를 폐기하지 못했다: $CH_IF_DOC"
  else
    echo "⚠️ 지난 실행은 첫 턴 기록 전에 죽었다. 과거 문서는 건드리지 않는다."
  fi

  rm -f -- "$CH_INFLIGHT" || die "in-flight 마커를 내리지 못했다: $CH_INFLIGHT"
fi
```

새 마커에는 `action=start|resume`과 `origin`도 추가하면 복구 진단이 더 확실하다. 확장 파서는 헤더의 모르는 필드를 무시하고 이미 `stamp`로 pending 문서를 귀속한다(`src/providers/codexRescue/chatDiscovery.ts:208-245`, `296-323`). 기존 마커처럼 `stamp`가 없는 상태는 최신 슬러그 문서로 추측하지 말고 오류로 멈추는 편이 안전하다.

## 4. 대안 비교와 추천

| 대안 | 장점 | 실패 양식 | 판정 |
|---|---|---|---|
| 현행 slug + 선택적 `--new` | 호출이 짧다 | `--new` 누락 시 과거 맥락을 조용히 오염 | 기각 |
| 단일 `--stamp`의 존재 여부로 start/resume 판정 | 정확한 파일을 가리킬 수 있다 | 오타·새 값이 조용한 분리로 변함. 경계 판단은 여전히 Claude 몫 | 원안 그대로는 기각 |
| **필수 `--start` / `--resume-stamp`** | 기존 문서 호환, 구현 작음, 대부분의 오류가 호출 전 명시 실패 | Claude가 의미상 틀린 유효 동작을 고르면 막을 수 없음 | **현재 조건의 추천안** |
| 파일 lease·최근 수정 시간 | 호출자 인자 없이 근사 가능 | 긴 휴지와 즉시 재호출을 구분 못함 | 경고용만 |
| PPID·TTY·일반 세션 env | 구현은 작아 보임 | 수명 범위가 스킬 호출과 다르고 플랫폼 의존 | 권위로 사용 금지 |
| 단일 장기 프로세스/daemon | 프로세스 안에서는 상태 보존 | 종료 경계 신호가 여전히 필요하고 현행 턴별 프로세스 계약을 바꿈 | 현재는 비추천 |
| Claude Code 호스트가 발급한 invocation ID | 모델 기억 없이 엄밀한 식별 가능 | 해당 ID/수명 계약과 5대 동작을 먼저 확인해야 함 | 제공된다면 최종적으로 가장 좋음 |

애매할 때의 우선순위는 **(1) 오류로 중단 > (2) 반드시 선택해야 한다면 경고와 함께 새 대화 > (3) 과거 대화 자동 재개**다. 잘못된 resume는 이전 기록과 답변을 동시에 오염시키고 겉보기에는 자연스러워 발견이 어렵다. 잘못된 start도 맥락 손실을 일으키지만 기존 기록을 변조하지 않아 피해 범위가 작다. 그러나 위치 사고가 증명했듯 **조용한 새 대화도 허용하면 안 된다.** 그래서 추천안은 애매한 경우 새 문서조차 만들지 않고 nonzero로 끝낸다.

## 5. 함정·주의점

1. **`--new` tombstone은 추천안에서 제거한다.** 정확한 핸들만 resume할 수 있으면 새 호출을 시작하기 위해 과거 문서의 `thread_id`를 지울 이유가 없다. 현재 `send.sh:239-259`처럼 최신 슬러그 문서를 미리 변조하는 것은 오히려 잘못 선택한 문서를 영구히 닫을 수 있다. 닫기 기능이 꼭 필요하면 `--close-stamp <정확한 값>`이라는 별도 명령으로 분리해야 한다.
2. **레거시 자동 경로를 남기지 않는다.** 옵션 없는 `--chat --slug ...`를 “호환성” 명목으로 최신 문서 resume하게 두면 새 계약을 우회한다. 배포 시 5대의 `send.sh`와 `SKILL.md`를 함께 갱신하고, 구형 호출은 큰 오류로 드러나게 해야 한다. 기존 **문서** 호환과 기존의 모호한 **CLI 동작** 호환은 별개다.
3. **resume 실패를 start로 폴백하지 않는다.** 파일 없음, 빈 `thread_id`, origin 불일치, `codex resume` 실패 모두 같은 파일에 새 thread를 섞거나 새 문서를 조용히 만들지 말고 중단해야 한다.
4. **in-flight의 귀속 키는 slug가 아니라 `(stamp, slug)`다.** 마커 경로를 계속 `.chat_<slug>.inflight`로 둘 수는 있지만, 그러려면 현재처럼 락도 slug 전체를 직렬화해야 한다. 락만 stamp별로 바꾸면 같은 marker를 두 실행이 덮어쓴다.
5. **첫 턴 크래시는 과거 문서를 tombstone하지 않는다.** 해당 stamp 문서가 아직 없다면 orphan Codex 세션이 생길 수는 있어도, 과거 정상 문서를 깨뜨리는 것보다 안전하다.
6. **origin 불일치는 명시 오류다.** 현재 `send.sh:223-232`는 경고 후 새 대화로 바꾼다. exact resume 계약에서는 호출자의 요청과 다른 동작이므로 중단하고 `--start` 재호출을 요구해야 한다. origin 없는 구형 문서만 호환 정책에 따라 경고 후 시도할 수 있다.
7. **스탬프 충돌을 확인한다.** 초 단위 값은 같은 초의 두 start나 시계 역행에서 겹칠 수 있다. 최소한 기존 파일을 덮거나 append하지 말고 실패시켜야 한다. 서로 다른 슬러그의 동시 start도 지원하려면 프로젝트 전체 stamp 발급용 noclobber 예약 파일이 필요하다.
8. **resume의 subject는 원문을 따른다.** 후속 호출에서 다른 `--subject`를 받아 marker에만 다른 제목을 넣지 말고, 금지하거나 기존 문서 subject와 일치하는지 검증한다.
9. **유효하지만 잘못 선택한 과거 핸들은 셸도 구분하지 못한다.** 이것이 호출자 협조 방식의 남는 한계다. strict 보장이 필요하면 호스트 invocation ID 또는 호출 종료 hook으로 핸들을 폐기해야 한다. TTL은 이 문제의 증명이 아니라 휴리스틱일 뿐이다.
10. **Git 루트 수정은 유지한다.** 이번 위치 사고의 원인은 확정됐고 `send.sh:118-132`의 변경은 호출 경계 수정과 독립적으로 필요하다.

## 6. 확신도와 남은 불확실성

- **높음 — 코드와 정보만으로 확정:** 현재 입력만 보는 새 셸 프로세스는 스킬 호출 경계를 엄밀히 판정할 수 없다. `--stamp` 하나만으로는 이 한계가 사라지지 않는다. 최신 슬러그 자동 선택과 선택적 `--new`는 요구사항을 집행하지 못한다.
- **높음 — 추천 설계:** 필수·상호 배타적 start/resume, exact 파일 선택, 불일치 시 중단이 현재 조건에서 가장 작은 안전한 변경이다. 기존 대화 문서에는 이미 필요한 키가 있어 새 필드가 필요 없다.
- **높음 — 상호작용 결함:** 호출별 문서로 바꾸면서 현재 in-flight 복구의 `CH_PREV_DOC` 선택을 남기면 관계없는 과거 문서를 폐기할 수 있다. marker의 exact stamp를 써야 한다.
- **중간:** Claude Code가 모든 대상 버전·플랫폼에서 실제 스킬 호출 단위 ID나 호출 시작/종료 hook을 제공하는지는 이번 자료로 확인하지 않았다. 그런 계약이 확인되면 모델이 핸들을 기억하는 추천안을 호스트 발급 ID로 대체할 수 있다.
- **낮음/추측으로 채택하지 않음:** PPID, TTY, 특정 환경변수가 우연히 현재 5대에서 호출 경계와 맞을 가능성. 공식 수명 계약과 교차 실측 없이는 안전장치로 쓰면 안 된다.

전체 판정 확신도는 **높음**이다. “순수 셸의 자동 판정 불가”와 “명시적 프로토콜은 오류를 조용히 통과시키지 않아야 한다”는 결론은 런타임 추측에 의존하지 않는다.

## 7. 추가로 필요한 자료

추천안 적용 판단에는 **없음**. 현재 `send.sh`, `SKILL.md`, marker 파서로 충분하다.

단, 호출자 협조가 전혀 없는 완전 자동화를 계속 검토한다면 다음 자료가 필요하다.

- 같은 `/codex_rescue` 호출 안의 Bash 2회와 다음 `/codex_rescue` 첫 Bash 1회에서 수집한 환경변수·PPID·프로세스 트리 비교
- Claude Code가 제공하는 per-skill-invocation ID 또는 호출 시작/종료 hook의 공식 수명 계약

그 자료에서도 호출마다 달라지고 같은 호출의 턴마다 유지되는 호스트 값이 없으면, 자동 판정안은 종료하고 명시적 start/resume 프로토콜을 채택하는 것이 맞다.

## Claude 검토

원문 인용을 코드로 대조했다. `send.sh:189-194`(슬러그 glob), 마커 기록부, `chatDiscovery.ts` 의
파서 위치 모두 정확했고, shebang 이 `#!/usr/bin/env bash`(이미 `[[ ]]` 10군데 사용)라 제안 코드의
`[[ =~ ]]` 도 방언에 맞는다.

### 채택 — 근거가 코드로 확인된 것

1. **`--start` / `--resume-stamp` 필수·상호배타.** 내 가설의 약점을 정확히 짚었다 — `--stamp`
   하나로는 "새 호출인가"를 여전히 모델이 판단하므로 `--new` 와 본질이 같다. 강제력이 문자열이
   아니라 *필수 인자 + 검증 + 거부*에서 나온다는 지적이 맞다. EDIT 게이트를 환경변수로 바꾼 것과
   같은 구조다.
2. **`--start` 의 stamp 를 `send.sh` 가 발급.** 호출자가 만들면 오타·충돌이 조용한 분리로 바뀐다.
3. **resume 대상이 없거나 닫혔거나 origin 이 다르면 중단.** 폴백으로 새 문서를 만들지 않는다.
   위치 사고의 본질이 "조용히 새 대화로 시작"이었으므로 일관된다.
4. **슬러그 glob 을 재개 경로에서 제거.**
5. 🔴 **in-flight 복구를 exact stamp 로 바꾸기 — 내가 놓친 결함이다.** 현재 복구는 마커가 있으면
   `CH_PREV_DOC`(최신 슬러그 문서)을 폐기한다. 호출별 문서로 바꾸면 새 호출의 첫 턴이 문서 생성
   전에 죽었을 때 **무관한 과거 대화를 닫는다.** 오늘 마커에 `stamp`·`slug` 를 넣어 둔 것이 마침
   여기서 권위로 쓰인다.
6. **stamp 충돌 검사** — 같은 초에 두 번 start 하면 기존 문서에 append 될 수 있다.

### 사용자 컨펌이 필요한 것 (기존 동작을 없애는 결정)

- **`--new` tombstone 제거.** 정확한 핸들만 재개할 수 있으면 과거 문서의 `thread_id` 를 미리
  비울 이유가 없다는 논리는 성립한다. 다만 `--new` 는 오늘 실측으로 검증한 기존 기능이고,
  없애면 "이 대화 닫기"를 별도 명령(`--close-stamp`)으로 분리해야 한다.
- **레거시 자동 경로 제거** (옵션 없는 `--chat --slug ...` 를 오류로). 새 계약을 우회하지 못하게
  하려면 맞지만, **다른 프로젝트에서 진행 중이던 대화가 그 시점에 끊긴다.** 5대 동시 배포라
  스크립트와 지침은 함께 나가지만, 이미 열려 있던 대화는 `--resume-stamp` 로 다시 잡아야 한다.

### 남는 한계 (Codex 도 인정한 것)

Claude 가 **새 호출인데 옛 핸들을 재사용**하면 셸은 막지 못한다. 유효한 값이기 때문이다.
Codex 의 확신도 표기대로, Claude Code 가 스킬 호출 단위 ID 를 제공하는지는 이 자료로 확인되지
않았다 — 그게 있으면 모델 기억을 아예 빼는 설계가 가능하다. 지금은 확인되지 않았으므로
"기계적으로 검출 가능한 오류는 전부 호출 전에 막고, 의미 판단만 모델에 남긴다"가 도달 가능한
최선으로 보인다.

### 이 검토에서 다루지 않은 것

CHAT 이 16분간 무한정 도는 문제(사용자 지적)는 이 요청서의 범위 밖이다. 별도로 다룬다.
