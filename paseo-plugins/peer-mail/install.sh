#!/usr/bin/env bash
# peer-mail 설치 — 스크립트를 PC 와 서버의 ~/.paseo/peer-mail/ 에 둔다(덮어쓰기). 플러그인 설치·다시 읽기는 따로:
#   PC: paseo plugin install <이 폴더>   (처음 한 번)  ·  paseo plugin reload peer-mail   (스크립트를 바꾼 뒤)
# 서버에는 Paseo 플러그인을 설치하지 않는다 — PC 중계기가 SSH 로 bridge.cjs 를 띄운다.
# 사용: bash install.sh [서버 별칭 …]   (없으면 PC 의 ~/.ssh/deploy_hosts 의 서버들)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RT="$HERE/runtime"
DEST_PC="${USERPROFILE:-$HOME}/.paseo/peer-mail"
mkdir -p "$DEST_PC/lib"
cp "$RT/mail.cjs" "$RT/bridge.cjs" "$RT/router.mjs" "$DEST_PC/"
cp "$RT/lib/"*.cjs "$DEST_PC/lib/"
echo "PC: $DEST_PC"

HOSTS=("$@")
if [ ${#HOSTS[@]} -eq 0 ]; then
  while read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs)"
    [ -n "$line" ] && HOSTS+=("$line")
  done < "$HOME/.ssh/deploy_hosts"
fi
TMP="$(mktemp -d)"
mkdir -p "$TMP/peer-mail/lib"
# 서버는 LF — PC 작업 폴더의 CRLF 를 걷어 낸다
for f in mail.cjs bridge.cjs; do tr -d '\r' < "$RT/$f" > "$TMP/peer-mail/$f"; done
for f in "$RT/lib/"*.cjs; do tr -d '\r' < "$f" > "$TMP/peer-mail/lib/$(basename "$f")"; done
tar -C "$TMP" -czf "$TMP/pm.tgz" peer-mail
for H in "${HOSTS[@]}"; do
  scp -q -o BatchMode=yes "$TMP/pm.tgz" "$H:/tmp/peer-mail.tgz"
  ssh -o BatchMode=yes "$H" 'umask 077 && mkdir -p "$HOME/.paseo" && tar --no-same-owner -xzf /tmp/peer-mail.tgz -C "$HOME/.paseo" && rm -f /tmp/peer-mail.tgz && chmod 700 "$HOME/.paseo/peer-mail" && bash -lc "node \"\$HOME/.paseo/peer-mail/mail.cjs\" whoami --cwd /" | head -3 | tr -d "\n"; echo' </dev/null 2>&1 | sed "s/^/$H: /" | grep -v -i "post-quantum\|session may\|upgraded"
done
rm -rf "$TMP"
