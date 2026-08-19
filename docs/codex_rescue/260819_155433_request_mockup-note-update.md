---
type: codex_request
mode: edit
stamp: 260819_155433
slug: mockup-note-update
response_path: docs/codex_rescue/260819_155433_response_mockup-note-update.md
---

# Codex 작업 지시 — 시안 문서의 낡은 문단 한 개 갱신

## 🔴 이 작업은 의도적으로 아주 작다

**딱 한 파일의 한 문단만 고친다.** 조사하지 마라. 다른 파일을 읽거나 고치지 마라.
웹 검색하지 마라. 필요한 정보는 아래에 전부 있다. **5분 안에 끝나야 한다.**

## 환경

- Windows 11, VS Code 확장 프로젝트 (TypeScript)
- 대상 파일은 구현 전에 만든 **UI 시안(mockup) HTML** 이다. 실제 동작 코드가 아니다.

## 대상 파일 — 이것 하나뿐이다

    docs/mockup_codex_panel.html

## 문제

이 시안은 구현 **전**에 작성됐고, 문서 끝의 설계 메모에 "아직 확정 못 한 것" 항목이 있다.
그런데 그 부분은 이미 구현·확정되어 **지금은 사실과 어긋난다.**

현재 그 파일 186~188행은 이렇게 되어 있다:

```html
    <b>⑤ 아직 확정 못 한 것</b> — 실패한 아이템을 빨간 점으로 둘지, 카드 전체를 실패로 볼지.
    위 시안에서는 "파일 저장 1회 실패 후 재시도"라 카드는 진행 중으로 뒀습니다.
    Codex 응답에서 종료·실패 판정 신호를 확인한 뒤 확정할 부분입니다.
```

## 확정된 사실 — 이 내용으로 바꿔라

1. **아이템 등급이 셋으로 갈렸다**: `done`(초록) · `failed`(빨강) · `warn`(노랑).
   `error` 타입 아이템은 **빨강이 아니라 노랑(warn)** 이다. Codex CLI 가 단순 안내
   ("clamping SessionEnd hook timeout to 3s" 등)를 같은 `error` 채널로 보내기 때문이다.
   진짜 실패는 `turn.failed`, 명령의 non-zero `exit_code`, `file_change.status = failed`
   로만 판정한다.
2. **카드 전체 상태는 아이템이 아니라 `send.sh` 가 쓰는 `status.json` 이 정한다.**
   `starting → running → finalizing → done / failed / stopped / stale` 로 전이한다.
   아이템 하나가 실패해도 카드가 실패가 되지는 않는다.
3. **`finalizing` 을 따로 둔 이유**: Codex 의 `turn.completed` 는 "Codex 턴 성공"일 뿐이고,
   그 뒤에도 `send.sh` 가 변경 감지·응답 회수·로그 보존을 더 한다. 그 구간을 완료로
   표시하면 안 끝난 것을 끝났다고 하는 셈이다.

## 작업 — 직접 수정할 것

1. 위 186~188행의 `⑤ 아직 확정 못 한 것` 문단을 **`⑤ 확정된 표시 규칙`** 으로 바꾸고,
   내용을 위 세 가지 확정 사실로 교체해라.
2. **주변 HTML 구조·스타일·다른 문단을 건드리지 마라.** `<b>...</b>` 로 시작해
   `<br><br>` 로 끝나는 기존 문단 형식을 그대로 따른다.
3. 한국어로 쓴다. 문서의 기존 어투(간결한 설명체)를 유지한다.
4. **이 파일 외에는 어떤 파일도 만들거나 수정하거나 삭제하지 마라.**
5. 확신이 안 서면 고치기 전에 물어봐라.

## 보고 — 아래 경로에 저장할 것

    docs/codex_rescue/260819_155433_response_mockup-note-update.md

frontmatter 를 그대로 넣어라:

    ---
    type: codex_response
    mode: edit
    stamp: 260819_155433
    slug: mockup-note-update
    author: codex
    ---

보고 내용은 짧게:

1. 바꾼 파일·라인
2. before → after (해당 문단만)
3. 남은 리스크·확신도

쓰기가 막히면 같은 내용을 최종 메시지로 그대로 출력해라. 자동으로 회수된다.
