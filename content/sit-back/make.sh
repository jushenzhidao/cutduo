#!/bin/bash
# 一条命令：配音 + segments → 响度归一 → 分层配乐 + 混音 → 渲染 → 门禁
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SLUG="$(basename "$PWD")"
echo "── 1/5 配音 + segments（dur 累积）"
python3 build.py
echo "── 2/5 旁白响度归一（edge-tts 原始约 -23 LUFS，必须在配音环节补）"
ffmpeg -v error -y -i audio/vo.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -ac 1 audio/vo-norm.wav
echo "── 3/5 分层配乐（chillwave 4 层）+ 混音"
cd "$ROOT"
node tools/audio-bed.mjs --slug sit-back --style chillwave
echo "── 4/5 渲染"
node render.mjs --kit science --params content/sit-back/params-abs.json \
  --audio content/sit-back/audio/mix-final.wav --out out/sit-back.mp4
echo "── 质检汇总：文案 / 分镜 / 门禁 / 案例留痕"
node "$ROOT/tools/qc.mjs" "$SLUG"
