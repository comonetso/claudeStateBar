---
type: codex_followup
mode: followup
stamp: 260826_022909
slug: heredoc-quoted-check
turn: 2
response_path: docs/codex_rescue/260826_022909_response_heredoc-quoted-check.md
---

# 되묻기 2턴 — 나머지 히어독은 왜 안 바꿔도 되나

## 이 턴의 성격

**한 줄 확인이다. 조사하지 마라.**

## 이번 턴에 묻는 것

`send.sh` 에는 `done <<EOF` 형태의 unquoted 히어독이 5개 더 있다 (280 · 581 · 615 · 650 · 804행대).
본문이 `$CH_LOOK_LIST` 같은 **변수 한 줄**뿐이고 산문이 아니다.

**Q. 이 다섯은 안 바꿔도 되나?** 내 근거는 "히어독의 확장은 1회라, 변수 값 안에 백틱이
들어와도 재파싱되지 않는다" 인데 맞나?

**두세 줄로 답해라. 파일을 다시 열 필요도 없다.**

## 답변 형식

1. `Q 답` — 맞다/틀리다 + 이유 한 줄
2. `확신도`
