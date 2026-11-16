#!/usr/bin/env bash
# 批量生成多音色版本：每个音色独立重算时间轴、字幕、SRT、音轨并渲染
set -uo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "xiaoxiao|zh-CN-XiaoxiaoNeural|+0%"
  "xiaoyi|zh-CN-XiaoyiNeural|+0%"
  "xiaobei|zh-CN-liaoning-XiaobeiNeural|+0%"
  "xiaoni|zh-CN-shaanxi-XiaoniNeural|+0%"
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
