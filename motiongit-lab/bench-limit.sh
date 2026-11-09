#!/usr/bin/env bash
# 极限压测：Skia 1/2/4/8/12/16 worker + Chromium 8 路，记录耗时与峰值内存
set -uo pipefail
cd "$(dirname "$0")"

OUTCSV=/tmp/limit.csv
echo "mode,workers,wall_s,peak_rss_mb,procs" > "$OUTCSV"

run() {
  local mode=$1 workers=$2; shift 2
  local log="/tmp/limit-${mode}-${workers}.log"
  "$@" >"$log" 2>&1 &
  local pid=$!
  local mem
  mem=$(python3 mem-monitor.py --pid "$pid" --timeout 300)
  wait "$pid"
  local wall rss procs
  wall=$(grep -oE '[0-9]+\.[0-9]+s' "$log" | tail -1 | tr -d s)
  rss=$(echo "$mem" | sed -E 's/.*PEAK_RSS_MB=([0-9]+).*/\1/')
  procs=$(echo "$mem" | sed -E 's/.*MAX_PROCS=([0-9]+).*/\1/')
  echo "${mode} ${workers} work	 wall=${wall}s rss=${rss}MB procs=${procs}"
  echo "${mode},${workers},${wall},${rss},${procs}" >> "$OUTCSV"
}

for n in 1 2 4 8 12 16; do
  run skia "$n" node canvas-editorial.mjs \
    --inputs edits/inputs-v6.json --out "out/skia-w${n}.mp4" \
    --audio edits/audio-v6.m4a --workers "$n"
done

run chromium 8 node motion-render.mjs render \
  --package packages/editorial-sync.motion --inputs edits/inputs-v6.json \
  --audio edits/audio-v6.m4a --out out/mem-chromium-j8.mp4 --jobs 8

echo "---"
column -t -s, "$OUTCSV"
echo "DONE"
