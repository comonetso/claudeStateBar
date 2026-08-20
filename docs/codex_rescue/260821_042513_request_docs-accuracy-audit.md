---
type: codex_request
mode: readonly
stamp: 260821_042513
slug: docs-accuracy-audit
subject: 문서·실제동작 대조 감사
response_path: docs/codex_rescue/260821_042513_response_docs-accuracy-audit.md
---

# Codex 요청 — 공개 문서가 실제 동작과 어긋나는 곳을 전수로 찾아줘

## 이 요청의 성격

나(Claude)는 이 저장소의 공개 문서 4종을 방금 손봤다. 낡은 서술 세 건을 찾아 고쳤는데,
**내가 찾은 게 전부라는 보장이 없다.** 너에게 **다른 시선의 전수 감사**를 받고 싶다.

**코드는 절대 수정하지 마라.** 네가 쓸 파일은 아래 지정한 응답 문서 하나뿐이다.

## 답변을 남길 곳  ← 먼저 읽어라

분석이 끝나면 아래 경로에 **그 이름 그대로** 파일을 만들어 저장해라.

    docs/codex_rescue/260821_042513_response_docs-accuracy-audit.md

- 경로·파일명을 바꾸지 마라. 스탬프와 슬러그는 이 요청서와 짝을 이룬다.
- 파일 첫머리에 아래 frontmatter를 그대로 넣어라:

      ---
      type: codex_response
      mode: readonly
      stamp: 260821_042513
      slug: docs-accuracy-audit
      author: codex
      ---

- **쓰기가 막히면 거기서 멈추지 말고, 같은 내용을 최종 메시지로 그대로 출력해라.** 자동으로 회수해 저장한다. 저장 실패를 이유로 분석을 생략하지 마라.
- **이 파일 외에는 아무것도 만들거나 수정하거나 삭제하지 마라.** 임시 파일·메모·테스트 파일도 금지다.
  (변경 여부는 파일시스템으로 실측 검증되며, 응답 파일 외의 변경은 전부 보고된다.)

## 환경

- VS Code 확장. TypeScript, `tsc -p ./` → `out/`. 현재 버전 **1.9.3** (마켓 게시 완료)
- 확장 코드: `src/` (진입점 `src/extension.ts`, Codex 진행 패널은 `src/codexRescuePanel.ts`,
  파서·스캐너는 `src/providers/codexRescue/execEvents.ts` · `runDiscovery.ts`)
- 짝이 되는 Claude Code 스킬: `skills/codex_rescue/SKILL.md` · `skills/codex_rescue/send.sh`
  (이 저장소의 사본이며, 사용자 홈의 정본 `~/.claude/skills/codex_rescue/` 와 **바이트 단위로 동일함을 방금 확인했다.**
  정본은 워크스페이스 밖이라 네가 못 읽을 수 있으니 **레포 사본을 읽어라**)
- Codex CLI `0.145.0`

## 감사 대상 문서 (이 4개가 전부다)

1. `docs/codex-rescue-guide.md` (영문)
2. `docs/codex-rescue-guide.ko.md` (한글)
3. `README.md` (영문)
4. `README.ko.md` (한글)

`CHANGELOG.md` 는 과거 릴리스의 기록이므로 **감사 대상이 아니다** — 그 시점의 서술이 지금과 달라도 정상이다.

## 대조 기준 — 무엇을 진실로 볼 것인가

문서의 주장을 아래 **실제 소스**와 대조해라. 문서끼리만 비교하지 마라.

- 스킬 동작·플래그·환경변수·파일명 규약 → `skills/codex_rescue/send.sh`
- 스킬 사용 규약·모드 판정 → `skills/codex_rescue/SKILL.md`
- 확장 동작(패널 표시, 설정 키, 정리 정책, 원격 지원) → `src/` 및 `package.json` 의 `contributes.configuration`

## 내(Claude)가 세운 가설과 근거  ← 반드시 반박해봐

**가설: 낡은 서술은 아래 세 건이 전부였고, 방금 고쳤으므로 이제 문서는 정확하다.**

내가 고친 것 (양쪽 언어 모두):

1. `Linux 서버에서 실제 실행 ❌ 설치·문법만 확인` → **✅ 실측**으로 변경
   - 근거: 원격 서버(`/home/yeogi_callcrew`)의 `docs/codex_rescue/.log/` 에서 실측.
     `260821_020714_status.json` = `mode:review, scope:uncommitted, state:done, codex_exit:0`,
     `260821_035253_status.json` = `mode:readonly, kind:doc, state:done, codex_exit:0`
2. `Remote-SSH 워크스페이스의 진행 패널 ❌ 미지원 (확장이 로컬 파일만 읽습니다)` → **✅ 실측, 1.9.2 이상 필요**로 변경
   - 근거: 1.9.2 에서 `vscode.workspace.fs` 로 전환. 원격 창에서 실제로 목록이 뜨는 것을 사용자가 확인
3. 환경변수 표에 `CR_WIN_SANDBOX` 누락 → 추가
   - 근거: `send.sh` 가 실제로 읽는 변수는 `CR_MODEL`·`CR_SANDBOX`·`CR_ALLOW_EDIT`·`CR_DRYRUN`·`CR_WIN_SANDBOX` 5종.
     `CR_TIMEOUT` 은 제거돼 쓰면 스크립트가 거부한다(이건 §8 함정 표에 새로 넣었다)

그리고 **일부러 ❌ 로 남긴 것**이 있다. 이것도 맞는 판단인지 봐줘.

- `REVIEW --base` / `--commit` → ❌ 유지.
  근거: 로컬·원격을 통틀어 남아 있는 모든 `status.json` 의 `scope` 가 `uncommitted` 뿐이었다.
  즉 실제로 돌려본 적이 없다
- `stale`(무응답) 판정 → ❌ 로 새로 명시

**이 가설 자체가 틀렸을 수 있다. 먼저 이걸 의심해줘.**
내가 "고쳤다"고 한 것 중에 근거가 부족한 게 있는지, 그리고 **내가 아예 쳐다보지도 않은 서술 중에
지금 코드와 어긋나는 게 있는지**가 핵심이다.

## 시도했고 실패한 것 / 확인의 한계

1. `grep` 으로 `Remote-SSH|미지원|unsupported|dry-run` 등 **낡을 만한 단어를 찍어서** 훑었다
   → 단어를 안 쓰고 낡은 서술은 이 방법으로 안 걸린다. 그래서 너에게 전수를 맡긴다
2. 서버 4대 중 나머지 3대(`Calladmin-Gabia`·`DBServer-Gabia`·`SportedAWS`)에는 실행 기록이 없었다
   → "Linux 에서 된다"의 근거는 **서버 1대·2건**뿐이다. 이 근거로 ✅ 라고 쓴 게 과한지 판단해줘
3. EDIT(수정 모드) 실행 기록은 로컬·원격 어디에도 남아 있지 않았다
   → 문서는 "단일 파일 소규모 수정까지만 검증"이라고 적고 있는데, 이 서술의 근거를 지금 파일로는 확인할 수 없었다.
     `SKILL.md` 의 검증 상태 표에는 "1줄만" 이라고 적혀 있다 — 가이드와 표현이 어긋나는지 봐줘

## 요청 — 다른 시선을 원한다

1. **위 가설을 먼저 반박해봐.** 내가 "이제 정확하다"고 한 판단이 성급한가?
2. 문서 4종을 소스와 대조해 **사실과 어긋나는 서술을 전부** 찾아줘. 특히:
   - 존재하지 않는 설정 키·명령 ID·환경변수·플래그를 언급하는가
   - 파일명 규약(`_request_` · `_response_` · `_review_` · `.log/` 산출물)이 `send.sh` 실제와 맞는가
   - 확장 설정 이름(예: `codexRunAutoCleanup`, `claudeContextBar.workflowCompleteBeep`)이
     `package.json` 의 실제 키와 맞는가 — **접두사까지** 정확한지 봐줘
   - 상태 이름(`starting/running/finalizing/done/failed/stopped/unresponsive`)이 코드와 맞는가
   - 수치 주장(300KB·86%·105줄/409KB·20분→1분25초·7일 보관·2초/5초 갱신)이 소스나 기록으로 뒷받침되는가
3. **한/영 문서 간 불일치**를 찾아줘. 한쪽에만 있는 문단·표 행·경고, 뜻이 달라진 번역
4. 1.9.3 에서 바뀐 패널 동작이 문서에 빠져 있는지 봐줘.
   (잘린 줄을 클릭하면 전문이 워드랩으로 펼쳐지고, 한 번에 한 줄만 열리는 아코디언이며,
   기존의 "전문 보기" 별도 줄은 없앴다. `src/codexRescuePanel.ts` 참조)
5. 지적마다 **위험도**를 매겨줘 — 사용자가 실제로 헛수고할 수 있는 것(높음) vs 표현 문제(낮음)
6. **확신도**를 밝혀줘. 파일을 읽고 확인한 것과 추측한 것을 구분해서.

## 답변 형식 — 이 답변은 Claude가 읽고 바로 적용 판단한다

응답 문서에 아래 순서로 써라.

1. `내 가설에 대한 판정` — 동의 / 부분 동의 / 기각 + 이유
2. `사실과 어긋나는 서술` — 파일·줄 번호·현재 문구·무엇이 틀렸는지·근거 소스·위험도
3. `한·영 불일치` — 같은 형식으로
4. `빠진 내용` — 코드에는 있는데 문서에 없는 것 (1.9.3 변경 포함)
5. `내가 ❌ 로 남긴 판단에 대한 의견` — 과한가, 모자란가
6. `확신도와 남은 불확실성`
7. `추가로 필요한 자료` — 없으면 "없음"

## 추가 제공 가능

필요하면 `src/` 의 특정 파일 전문, 원격 서버의 실행 기록, `package.json` 전체를 더 줄 수 있다.
무엇이 더 필요한지 7번에 적어줘.
