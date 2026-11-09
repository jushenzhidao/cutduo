#!/usr/bin/env bash
# 实战对比：同一份剪辑稿，串行 / 4 路 / 8 路各导一版
set -uo pipefail
cd "$(dirname "$0")"

for j in 1 4 8; do
  echo "=== jobs=$j ==="
  node motion-render.mjs render --package packages/editorial-sync.motion \
    --inputs edits/inputs-v6.json --audio edits/audio-v6.m4a \
    --out "out/bench-j${j}.mp4" --jobs "$j" 2>&1 | grep -E '导出完成|帧数校验|ffprobe'
done
echo "BENCH DONE"
