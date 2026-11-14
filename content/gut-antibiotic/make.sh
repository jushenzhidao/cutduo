#!/bin/bash
# 一条命令：配音 + segments → 响度归一 → 分层配乐 + 混音 → 渲染 → 门禁
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
echo "── 1/5 配音 + segments（dur 累积）"
python3 build.py
echo "── 2/5 旁白响度归一（edge-tts 原始约 -23 LUFS，必须在配音环节补）"
ffmpeg -v error -y -i audio/vo.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -ac 1 audio/vo-norm.wav
echo "── 3/5 分层配乐（chillwave 4 层）+ 混音"
cd "$ROOT"
node tools/audio-bed.mjs --slug gut-antibiotic --style chillwave
echo "── 4/5 渲染"
node render.mjs --kit science --params content/gut-antibiotic/params-abs.json \
  --audio content/gut-antibiotic/audio/mix-final.wav --out out/gut-antibiotic.mp4
echo "── 5/5 门禁"
node src/gate.mjs out/gut-antibiotic.mp4 \
  $([ -s content/gut-antibiotic/facts.md ] && echo "--facts content/gut-antibiotic/facts.md") \
  --require-loudness --require-bgm --blank 2>&1 | grep -E "PASS|FAIL|LUFS|台账|空镜|BGM"
