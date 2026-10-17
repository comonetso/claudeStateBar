#!/bin/sh
# 도구 문지기 앞단 — 무중단 등록 대화가 아니면 node 를 띄우지 않고 끝낸다(Bash·Edit 마다 도는 훅이라 다른 대화의 비용을 줄인다).
case "$PASEO_AGENT_ID" in ""|*[!0-9A-Za-z_-]*) exit 0 ;; esac
W="${PASEO_HOME:-$HOME/.paseo}/claude-work"
grep -qF "\"$PASEO_AGENT_ID\"" "$W/registry.json" 2>/dev/null || exit 0
# 이 대화의 Claude 에 훅이 걸려 있다는 표시 — 설정에 훅을 넣은 뒤 이미 떠 있던 Claude 가 읽었는지 알 수 있게(work-cli status 의 toolGateSeen)
mkdir -p "$W/gate" 2>/dev/null; touch "$W/gate/$PASEO_AGENT_ID.tool-seen" 2>/dev/null
exec node "$(dirname "$0")/tool-gate.mjs"
