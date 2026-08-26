# [Claude 작성] 2026-08-26 세션 로그 part2 — 코덱스 리셋 신설 → 오발사 발견 → 판정 기준 전면 재설계

<!-- HANDOFF_BEGIN -->
## 이어받기 ★

- **세션 성격**: /start → 코덱스 5시간 리셋 신설(텔레그램+프라이머) → Remote Control 배너 원인 규명 →
  **실제 발사가 거짓임을 사용자가 발견** → 판정 기준이 틀렸다는 것 확인 → Codex 자문 →
  **클로드·코덱스 양쪽 판정 전면 재설계** → send.sh 샌드박스 회귀 발견·수정·서버 4대 배포 →
  플랜별 분기(5시간 한도 유무) → 미사용 코드 정리 → 진단 로그 보강
- **저장소/브랜치**: claudeStateBar / main · **기준 커밋**: `7df2f71` · **remote**: SSH 정상
- **미커밋 변경**: 없음 (이 로그 커밋 시점 기준)

**현재 상태**
- 목표: 코덱스에도 클로드와 같은 5시간 리셋 알림·자동시작을 붙이기
- 완료:
  - **코덱스 리셋 감지·텔레그램·프라이머** 신설. 설정 4개(알림/프라이머 × 클로드/코덱스)
  - 🔴 **판정 기준 전면 재설계** — 사용률 0%를 "타이머 종료"로 읽던 것이 오발사 원인.
    클로드는 `resetAt === null && percent === 0`, 코덱스는 `resetsAt 고정/이동` 으로 교체
  - **플랜 분기** — `codexHasFiveHourLimit()` 한 함수로 판정. 5시간 없으면 주간 표시 + 리셋 제외
  - **텔레그램 문구** — "지금 시작하면 5시간 풀" 제거, `주간 사용률: 43% (2일 23시간 후)`
  - **send.sh 샌드박스 회귀 수정** — 끼어들기 경로가 read-only 로 고정돼 8/25에 연 `.scratch/`
    권한이 하루 만에 닫혀 있었다. 서버 4대 배포 + 실왕복 검증
  - **Remote Control 배너** — `remoteControlAtStartup` 이 오늘 04:54에 생긴 것이 원인. 제거
  - 미사용 코드 5개 정리 · 진단 로그 3종 보강
- 미완료: **오늘 밤 20:34(코덱스)·22:00(클로드) 자동 발사 실전 확인**

**다음 한 줄 액션**
- 🔴 **`diag.log` 에서 `codex-poll` · `block-closed` · `primer-outcome` 을 읽어
  20:34/22:00 발사가 정상이었는지 확인.** 그게 이번 재설계의 유일한 실전 검증이다
- 그 뒤: 진단 로그 중 매 폴링 찍는 줄을 덜어낼지 판단 (diag.log 가 이미 17MB)

**검증 상태**
| 항목 | 문법/컴파일 | 테스트 | 실기기·실환경 | 사용자 확인 |
|---|---|---|---|---|
| 코덱스 리셋 감지(신 판정) | ✅ tsc | ❌ | ❌ **미실측** | ❌ |
| 클로드 리셋 판정(신 판정) | ✅ tsc | ✅ 로그 455건 3분류 대조 | ❌ **미실측** | ❌ |
| 플랜 분기 (5시간 유무) | ✅ tsc | — | ⚠️ **Plus 만** — Pro 미검증 | — |
| 텔레그램 문구 | ✅ | ✅ 렌더링 대조(한/영·값 유무) | ✅ 실제 발송분 확인 | ✅ |
| 코덱스 프라이머 명령 | ✅ | — | ✅ **실행 7초 exit 0 "ok"** | ✅ |
| `--ephemeral` 세션 미생성 | — | — | ✅ **rollout 0건 실측**(대조군 24h 13건) | ✅ |
| 과금 안전장치(auth.json) | ✅ | ✅ auth_mode=chatgpt 확인 | ✅ 발사 전 통과 | — |
| send.sh 샌드박스 수정 | ✅ `bash -n` | ✅ DRYRUN 3경로 | ✅ **실왕복 — 스크래치 생성·응답 직접저장** | ✅ |
| 서버 4대 배포 | — | — | ✅ **4대 SANDBOX_RAW=7 실측** | — |
| Remote Control 배너 제거 | — | — | ✅ 백업 대조로 원인 확정 | ✅ |
| 미사용 코드 정리 | ✅ tsc + 잔재 0 | — | — | ✅ |

**미해결 항목**
- 즉시 처리: 없음
- 검증 미완:
  - 🔴 **오늘 밤 자동 발사** — 코덱스 20:34, 클로드 22:00. 재설계 전체가 여기서 처음 실전을 탄다
  - **Pro 플랜에서 `primary` 가 어떻게 오는지** — null 인지 값이 있는지 확인 못 함(계정 없음)
  - 코덱스 프라이머가 **실제로 새 타이머를 여는지** — 명령 동작만 확인했고, 닫힌 상태에서 쏜 적 없다
- 별도 트랙:
  - 🔴 SKILL.md 요청서 템플릿의 `.scratch/` 문구 — 이제 권한이 맞지만, 끼어들기 경로에서
    **네트워크는 여전히 안 열린다**(exec 전용 `-c` 인자라 중계기에 안 넘어감). 문구에 반영 안 됨
  - 진단 로그 감량 (diag.log 17MB)
  - 패널 게이트가 로컬 홈만 봄 · `send.sh` 중단 경로 부재 · 워크플로우 휴지통 미검증
  - ⏳ Open VSX 네임스페이스 인증 대기 (이슈 #12692)
- **다른 프로젝트 전달**: `F:\workspace\Etc Project\Electron Project\claudeState` 작업자에게
  플랜 분기 규칙 문서를 채팅으로 전달함(파일로는 안 남김)

**⚠️ 다음 세션 주의**
- 🔴 **`resetsAt`/`resetAt` 의 시각을 눈으로 비교할 때 "지금"을 반드시 같이 찍어라.**
  05:28에 `resetsAt=10:13` 을 보고 **과거로 오독**했다(미래였다). 그 위에 락 설계를 세워
  중복 방지가 통째로 무효였다. 같은 종류 오독을 하루에 두 번 했다
- 🔴 **CONSULT 요청서를 무겁게 쓰지 마라.** "전수 대조"·엣지 5개·게이트 G1~G6·답변형식 8항목을
  얹어 20분·명령 54건·**5시간 한도 41%p** 를 태웠다. 결론을 낸 것은 **파일 2개 읽고 답한 2문항**이다.
  끼어들기로 범위를 줄이자 즉시 결론이 나왔다. **핵심 질문 1~2개 + 지목된 파일**로 던져라
- 🔴 **사용률 0%는 "타이머 종료"가 아니다.** 도는 타이머도 안 쓰면 0%다. 이게 이번 사고의 뿌리
- 🔴 **코드 주석을 근거로 삼기 전에 로그로 대조해라.** `sessionResetAt is NOT usable` 주석이
  실측과 반대였고, 그걸 믿어서 처음부터 틀린 자리에서 출발했다
- 🔴 **변수 이름만 나열하고 판단을 요구하지 마라.** 사용자가 "좀 쉽게 설명해야지 내가
  어울려 하든지 말든지 하지"라고 지적했다. 무엇이었고 왜 안 쓰는지부터 말해라
- 🔴 **Codex 를 부르기 전에 허락 + 한도 상황.** 이번엔 지켰다
- 이월 계약: 매 턴 `--start`/`--resume-stamp` · `send.sh` 정본은 `~/.claude/skills/` ·
  웹뷰 파일 백틱 금지 + `node tools/check-webview.js` · `vsce`·`eslint` 전역 미설치(`npx`)

**메모리**: [[project_codex_claude_reset_detection]] 신규 · [[feedback_ask_before_codex]] 갱신 ·
[[project_codex_usage_limit_labels]] 갱신
<!-- HANDOFF_END -->

---

## 1. 작업 흐름

### 1-1. 코덱스 5시간 리셋 신설 (요구의 출발점)

**배경/요구**: 사용자가 "코덱스도 5시간 리셋이 도입됐으니 클로드와 같이 텔레그램 보내고
커맨드로 리셋해야 한다"고 지시. 클로드 쪽은 이미 `autoStartBlockOnReset` + 텔레그램이 있었다.

**요구가 바뀐 지점**: 처음엔 "알림 + 프라이머"였는데, 실제로 발사된 뒤 사용자가 화면을 보고
**"이건 쏘면 안 되는 상황이었다"**를 발견하면서 요구가 **"실제 상태를 정확히 파악한 뒤에 쏴라"**로
바뀌었다. 이게 이 세션의 실질적 주제가 됐다.

### 1-2. 오발사 발견 — 사용자가 화면으로 잡았다

15:03 절전 복귀 직후 텔레그램 2건(클로드·코덱스)이 왔다. 사용자가 상태바와 대조해
**"1시간 몇 분 남았고 3시간 지났는데 왜 리셋이라고 하냐"**를 지적했다.

로그로 확인한 실제 상태:
```
06:03:40Z codex-block-closed prevPct=0 curPct=0 woke=true   ← 아무 변화 없음
06:03:52Z poll resetAt=2026-08-26T08:00:00Z future=Y session=0%
06:03:52Z block-closed prevPct=8 curPct=0 woke=true
```
클로드는 12:00~17:00 타이머가 돌고 있었고(서버 크론이 켜둠) 1h57m 남아 있었다.
코덱스는 `0% → 0%`, 즉 관측값에 변화가 없는데 절전 복귀만으로 발사됐다.

**결과**: 거짓 알림 + 헛 `claude -p`(이미 도는 타이머에 프롬프트 하나 던짐) +
`primer-verified` 가 그것마저 성공으로 기록.

### 1-3. Codex 자문 — 내 새 판정 두 개가 모두 안전하지 않다는 답

`260826_160143_request_reset-detect-false-fire.md` (CONSULT, 끼어들기 2회).

Q1(클로드 `resetAt===null`) — 안전하지 않다. `planUsage.ts:206` 의
`(bucket && bucket.resets_at) || null` 이 **필드 누락·빈 값을 전부 null 로 접는다.**
`pick()` 은 percent 기준으로만 bucket 을 고르므로 **percent 정상 + resetAt null** 조합이 성립.

Q2(코덱스 `resetsAt` 고정) — 안전하지 않다. 공유 캐시가 TTL 이내면 **같은 스냅샷을 반환**하고
TTL·폴링이 둘 다 60초라 겹친다. 반복된 값이 "고정"으로 읽혀 **종료를 영영 놓친다.**

둘 다 코드로 확인했고 채택. Q2 는 **이미 설치된 코드의 실제 결함**이었다.

### 1-4. send.sh 샌드박스 회귀

Codex 가 "샌드박스가 쓰기를 차단해 거부됐다"고 보고 → 사용자가 "원래 temp 는 쓰기 됐는데"라고 지적.

원인: `send.sh:1729` 가 중계기에 `--sandbox read-only` 를 **리터럴로 고정**. 끼어들기가
2026-08-26 에 CONSULT 기본값이 되면서, **2026-08-25 에 CONSULT 3회 실패를 겪고 의도적으로 연
`.scratch/` 권한이 하루 만에 도로 닫혔다.**

중계기는 `read-only`/`workspace-write` 둘 다 받는다(`live-consult.mjs:469-472`) — 기술 제약이 아니었다.

---

## 2. 의사결정 로그

| 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|
| 클로드 판정 = `resetAt===null && percent===0`, percent null 이면 skip | 로그 455건 3분류 실측 | `null` 단독 / percent 단독 | 두 필드가 다 필요해 조건이 늘어남 |
| `wokeClosed`(절전 특례) 제거 | globalState 가 이전 판정을 이월하므로 특례 없이도 절전 케이스가 잡힘. 오늘 클로드 발사도 `justClosed` 로 잡혔다 | 특례 유지 + 조건 강화 | 없음 — 특례가 거짓 발사만 만들었다 |
| 코덱스 판정 = `resetsAt` 고정/이동 | 열림·닫힘 양쪽 실측 | 사용률 / `windowMinutes` 잔여시간 임계값 | 임계값을 안 쓰는 대신 직전 관측값 저장 필요 |
| 같은 `observedAt` 은 비교 전 폐기 | Codex 지적 + 캐시 코드 확인 | 캐시 TTL 을 폴링보다 짧게 | globalState 키 하나 추가 |
| 플랜 분기를 **`primary` 유무**로 (이름 아님) | 사용자 지시 "바뀔 수 있으니 쉽게 변경 가능하게". Pro 도 5시간 도입 예고 | `planType==='pro'` 문자열 매칭 | Pro 에서 primary 가 유효값으로 오면 실패 — 미검증 |
| send.sh 에 `SANDBOX_RAW` 신설 | `$SANDBOX` 는 `+net` 이 붙는 표시용이라 그대로 못 넘김 | `$SANDBOX` 를 순수 값으로 바꾸기 | 기존 경고·검증 로직이 `$SANDBOX` 를 쓰므로 건드리면 그쪽이 흔들림 |
| 코덱스 프라이머 기본 ON 으로 전환 | 사용자 지시. 커맨드가 나가야 타이머가 시작되고, 그게 기능의 목적 | 기본 OFF 유지 | 한도를 실제로 소모(발사당 약 2%p) |

---

## 3. 시행착오

- **잘못된 가정**: "코덱스는 타이머가 멈추면 `resetsAt` 이 과거에 남는다"
  **발견 경위**: 05:28에 `resetsAt=10:13` 을 보고 과거로 판단 — 당시 시각이 05:28이니 **미래**였다.
  15:03/15:16 재관측에서 값이 계속 따라오는 것을 보고 오독을 인지.
  **복구**: 락 키를 `resetsAt` 기반 → 시계 버킷으로 되돌림. README 영·한과 CHANGELOG 의 거짓 서술 삭제.
  **교훈**: **타임스탬프를 눈으로 볼 때 "지금"을 같이 찍어라.** 하루에 두 번 같은 오독을 했다.

- **잘못된 가정**: "요청서를 충실히 쓸수록 좋은 답이 온다"
  **발견 경위**: 사용자가 "20분째 토큰 녹이고 있다"고 지적. 실측 명령 54건·한도 41%p.
  **복구**: 끼어들기로 범위를 2문항으로 축소 → 즉시 결론.
  **교훈**: 결론을 낸 것은 **파일 2개 읽은 2문항**이었다. "전수 대조" 같은 표현 하나가 명령 수십 건을 만든다.

- **잘못된 가정**: "`$SANDBOX` 를 그대로 중계기에 넘기면 된다"
  **발견 경위**: 수정 직전 `grep` 으로 `SANDBOX="$SANDBOX +net"` 발견.
  **복구**: `SANDBOX_RAW` 신설.
  **교훈**: 표시용 문자열과 인자용 값이 같은 변수에 섞여 있을 수 있다. 고치기 전에 대입 지점을 전부 훑어라.

---

## 4. 발견한 코드베이스 함정

### 4-1. 🔴 클로드 `sessionResetAt` 이 null 이 되는 경로는 셋이다 (판정에 결정적)

`diag.log` 에서 `resetAt=null` 455건을 전수 분류한 결과:

| 형태 | 건수 | 의미 |
|---|---|---|
| `session=null%` | 212 | **응답 자체가 깨짐.** 판정하면 안 된다 |
| `session=1~12%` | 6 | **`resets_at` 필드만 누락.** 타이머는 도는 중 |
| `session=0%` | 237 | 진짜 종료 |

원인 코드 `src/planUsage.ts:206`:
```ts
resetAt: (bucket && bucket.resets_at) || null   // 누락·빈 문자열이 전부 null 로 접힌다
```
`fromLimit()` 의 `l?.resets_at ?? null` 도 같고, `pick()` 은 **percent 기준으로만** bucket 을
고르므로 **percent 정상 + resetAt null** 조합이 성립한다.

→ **어느 한 필드로도 판정할 수 없다.** `resetAt===null && percent===0`, percent 가 null 이면 skip.

### 4-2. 🔴 코덱스 `resetsAt` 은 클로드와 정반대로 거동한다

| 상태 | `resetsAt` |
|---|---|
| 타이머 **도는 중** | **고정** (열린 시각 + 5시간). 45초 간격 2회 관측에서 이동폭 0초 |
| 타이머 **멈춤** | **매 폴링 "지금 + 300분"** (15:03→20:03, 15:16→20:16, 15:16:08→20:16:08) |

`null` 은 오지 않는다. 그래서 종료 신호는 **"고정돼 있던 값이 움직이기 시작하는 것"**이다.

🔴 **이 값을 이벤트 락 키로 쓰면 안 된다.** 멈춘 상태에서는 폴링마다 값이 달라져 매번 새 키가 된다.

### 4-3. 🔴 코덱스 공유 캐시가 "값 고정"을 위조한다

`src/providers/codex/usageProvider.ts:139-140`(캐시 히트 즉시 반환) · `162-163`(락 대기 중) ·
`172-173`(락 획득 직후). `refreshCodexUsage()` 가 넘기는 TTL 은 `codexUsageSec * 1000`
= 폴링 주기와 **같은 60초**. 타이머 오차나 여러 VS Code 창이면 캐시 히트가 난다.

→ 같은 스냅샷이 반복되면 `cur === prev` 가 참이 되어 **"타이머 도는 중"으로 오판, 종료를 놓친다.**
각 스냅샷의 `observedAt` 을 저장하고 **직전과 같으면 비교 전에 버려야 한다.**

### 4-4. 🔴 `send.sh` 의 `$SANDBOX` 는 인자용이 아니라 표시용이다

```bash
SANDBOX="${CR_SANDBOX:-workspace-write}"        # 여기까진 순수 값
set -- codex exec ... -s "$SANDBOX" ...          # 이때 넘어감
if [ ... network ... ]; then
  SANDBOX="$SANDBOX +net"                        # ← 여기서 표시용으로 오염
fi
```
`review`·`followup` 경로에서는 `"read-only (review 고정)"` 처럼 **괄호 설명까지 들어간다.**

→ 중계기에 넘길 순수 값은 별도 변수(`SANDBOX_RAW`)로 보존해야 한다. `$SANDBOX` 를 그대로
넘기면 중계기가 `USAGE` 로 거부한다(`read-only`/`workspace-write` 만 허용).

### 4-5. 끼어들기 경로에서는 네트워크가 열리지 않는다

네트워크 해금은 `-c sandbox_workspace_write.network_access=true` 로 **exec 에만** 붙는다.
중계기에는 그 인자가 넘어가지 않으므로 `workspace-write` 여도 네트워크는 차단이다.
보고문에 `+net` 을 붙이지 않도록 표시를 분리했다. **SKILL.md 문구는 아직 이걸 반영 안 함.**

### 4-6. Claude Code `remoteControlAtStartup` — 오늘 새로 생긴 설정

`~/.claude/settings.json` 백업 대조(8/25 17:06 vs 현재)로 확정:
```
391  "agentPushNotifEnabled": true → false
402  "remoteControlAtStartup": true      ← 새로 추가됨
```
확장 2.1.245 업데이트(8/25 18:36) 후 04:54에 두 값이 함께 바뀌었다 — `/config` 화면을 거친 흔적.
이 키가 생기면서 매 세션 Remote Control 브리지 자동 시작을 시도하고, 실패해 배너가 떴다.
스키마 정의: `"Start Remote Control bridge automatically each session"`.

---

## 5. 사용자 핵심 발언

- > "실제 사용량이나 지금 현재 어떤 상태인지를 제대로 알고 쏴야 하는데, 지금 이 확장
  > 프로그램에서는 그렇지 않고 그냥 무조건 쏴버리는 것 같아."
  — 오발사 지적. 이 세션의 방향을 바꾼 발언. **간접 신호로 짐작하지 말고 실제 상태를 확인하라.**

- > "1. 5시간 제한이 있으면 ㄱ. 5시간 텔레그램/리셋한다 ㄴ. StatusBar에 5시간 제한을 표시한다
  > 2. 5시간 제한이 없으면 ㄱ. 5시간 텔레그램/리셋하지 않는다 ㄴ. StatusBar에 주간 제한을 표시한다"
  — 플랜 분기 규칙. **플랜 이름이 아니라 "제한 유무"가 기준**이라는 점이 핵심.

- > "이게 바뀔수 있으니 비교적 쉽게 변경가능하게 해놔"
  — Pro 에도 5시간이 도입될 예정. 판정을 한 함수(`codexHasFiveHourLimit`)로 모은 근거.

- > "좀 쉽게 설명해야지 내가 어울려 하든지 말든지 하지"
  — 변수 이름만 나열하고 삭제 여부를 물었을 때. **판단을 요구하려면 판단 재료를 먼저 줘라.**

- > "지금 이 일을 왜 하는지 너는 의미를 모르겠어?"
  — 프라이머를 기본 OFF 로 두고 "켤까요?"만 반복했을 때. 기능의 목적(자는 동안 타이머를 돌려
  하루에 쓸 수 있는 타이머를 늘리는 것)을 놓치고 절차만 밟았다.

---

## 8. 변경 파일 인벤토리

```
M src/extension.ts        [클로드·코덱스 판정 전면 교체 / 플랜 분기 3함수 / 진단 로그 3종 / 미사용 3개 제거]
M src/credentials.ts      [상태 키 4개 신설(코덱스 resetsAt·observedAt·창상태, 클로드 정지여부) / 사용률 키 제거]
M src/blockPrimer.ts      [fireCodexPrimer · codexBillingHazard · claimResetEvent provider 인자 · sweep 이동]
M src/i18n.ts             [텔레그램 문구 축약 / 코덱스 키 3종 신설(en·ko)]
M src/settingsPanel.ts    [코덱스 설정 2개 수집·저장·체크박스]
M media/settings.js       [코덱스 체크박스 2개 바인딩]
M package.json            [claudeState.codexAutoStartBlockOnReset · codexTelegramNotifyOnReset]
M skills/codex_rescue/send.sh [SANDBOX_RAW 신설 / 중계기에 전달 / 표시 분리 — 저장소 사본]
M CHANGELOG.md            [1.14.0 에 코덱스 리셋·판정 재설계·플랜 분기·문구 4개 절 추가]
M README.md / README.ko.md [코덱스 5시간 리셋 절 + 플랜 분기 + 문구 변경]
A docs/codex_rescue/260826_160143_{request,response}_reset-detect-false-fire.md  [CONSULT 왕복 + Claude 검토]
A docs/codex_rescue/260826_164251_{request,response}_sandbox-write-probe.md      [권한 복구 실왕복 검증]
```

저장소 밖 변경(커밋 대상 아님):
```
~/.claude/skills/codex_rescue/send.sh   [정본. GitHub 푸시 + 서버 4대 배포 완료]
~/.claude/settings.json                 [remoteControlAtStartup 제거]
%APPDATA%/Code/User/settings.json       [claudeState.codexAutoStartBlockOnReset: true 추가]
```
