#!/bin/bash
# 사용: run.sh <세션폴더> <js파일>  — 큐에 넣고 결과가 나올 때까지 기다려 출력
S="$1"; J="$2"
n=$(date +%s%N)
name="$(printf '%s' "$n")-$(basename "$J" .js)"
cp "$J" "$S/q/$name.js"
for i in $(seq 1 160); do
  if [ -f "$S/o/$name.txt" ]; then cat "$S/o/$name.txt"; exit 0; fi
  if [ -f "$S/dead" ]; then echo "<<SESSION DEAD $(cat $S/dead)>>"; tail -5 "$S/drv.log"; exit 2; fi
  sleep 0.5
done
echo "<<WAIT TIMEOUT>>"; exit 3
