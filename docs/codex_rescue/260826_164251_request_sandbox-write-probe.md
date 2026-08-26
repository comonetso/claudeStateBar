---
type: codex_request
mode: readonly
stamp: 260826_164251
slug: sandbox-write-probe
subject: 스크래치 쓰기 권한 확인
response_path: docs/codex_rescue/260826_164251_response_sandbox-write-probe.md
---

# 권한 확인 — 조사하지 마라, 딱 세 가지만 해라

이건 분석 요청이 아니다. **방금 고친 배관이 동작하는지 보는 점검**이다.
탐색·조사·추론을 하지 마라. 아래 셋만 실행하고 끝내라. 10초 안에 끝나야 정상이다.

## 1. 스크래치에 파일을 만들어라

```
docs/codex_rescue/.scratch/probe_260826_164251.txt
```

내용은 아무거나 한 줄이면 된다. 성공했는지 실패했는지만 확인하면 된다.

## 2. 응답 문서를 직접 저장해라

아래 경로에 그 이름 그대로 저장해라.

    docs/codex_rescue/260826_164251_response_sandbox-write-probe.md

frontmatter 를 그대로 넣어라:

    ---
    type: codex_response
    mode: readonly
    stamp: 260826_164251
    slug: sandbox-write-probe
    author: codex
    ---

**이게 성공하면 `author: codex` 로 남고, 실패하면 스크립트가 회수해 `codex-via-stdout` 이 된다.**
그 차이가 이 점검의 핵심이다.

## 3. 결과를 세 줄로 적어라

- 1번 파일 생성: 성공 / 실패 (실패면 에러 메시지 그대로)
- 2번 응답 저장: 성공 / 실패
- 네가 인식한 샌드박스 모드: (아는 대로. 모르면 "모름")

## 하지 말 것

- 다른 파일을 읽지 마라. 소스도 로그도 열지 마라.
- 원인을 분석하지 마라. 개선안을 쓰지 마라.
- 명령을 여러 개 돌리지 마라 — 파일 쓰기 두 번이면 충분하다.

쓰기가 막히면 같은 내용을 최종 메시지로 출력해라. 자동 회수된다.
