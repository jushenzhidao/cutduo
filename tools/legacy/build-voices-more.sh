#!/usr/bin/env bash
# 补齐剩余中文音色：云健 / 云扬 / 云夏（与已有 5 版凑齐 8 个）
set -uo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "yunjian|zh-CN-YunjianNeural|+0%"
  "yunyang|zh-CN-YunyangNeural|+0%"
  "yunxia|zh-CN-YunxiaNeural|+0%"
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r name voice rate <<< "$v"
  echo "=== ${name} · ${voice} · ${rate} ==="
  if ! python3 build-sync.py --tts edge --voice "$voice" --rate "$rate" --prefix "v5-${name}"; then
    echo "!! ${name} 合成失败，跳过"
    continue
  fi
  node motion-render.mjs render --package packages/editorial-sync.motion \
    --inputs "edits/inputs-v5-${name}.json" --audio "edits/audio-v5-${name}.m4a" \
    --out "out/editorial-cut-${name}.mp4" 2>&1 | tail -3
  sleep 1
done
echo "ALL DONE"
