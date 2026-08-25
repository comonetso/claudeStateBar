---
type: codex_request
mode: readonly
stamp: 260826_022909
slug: heredoc-quoted-check
subject: 히어독 3개 quoted 확인
response_path: docs/codex_rescue/260826_022909_response_heredoc-quoted-check.md
---

# Codex 요청 — 히어독 3개가 전부 quoted 인지만 확인해 달라

## 이 요청의 성격 — 30초짜리 확인이다

**아주 가벼운 건이다. grep 한 번이면 끝난다. 길게 조사하지 마라.**

## 지금 바로 열 수 있는 원본

| 무엇 | 경로 |
|---|---|
| 대상 | `skills/codex_rescue/send.sh` |

이 명령 하나면 충분하다.

```bash
grep -n "read -r -d '' PROMPT <<" skills/codex_rescue/send.sh
```

🔴 **파일 전체를 읽지 마라.** 이 건은 그럴 필요가 없다.

## 묻는 것 — 하나뿐이다

`read -r -d '' PROMPT <<` 로 시작하는 히어독이 **3개** 있다 (FOLLOWUP · EDIT · CONSULT 프롬프트).

**이 셋이 전부 quoted(`<<'EOF'`)인가?** 하나라도 unquoted(`<<EOF`)면 몇 행인지 답해라.

## 답변 형식 — 세 줄이면 된다

1. `실행한 명령`
2. `결과` — 3개의 행번호와 quoted 여부
3. `판정` — 전부 quoted 면 "전부 quoted", 아니면 문제 행

🔴 **길게 쓰지 마라. 세 줄이다.**

## 작업 규칙

- **파일을 고치지 마라.** 읽기만 한다.

## 응답 저장 위치

    docs/codex_rescue/260826_022909_response_heredoc-quoted-check.md
