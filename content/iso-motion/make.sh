#!/bin/bash
# 转场研究片：合成配乐 → 出片 → 门禁 → 逐帧条
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SLUG="$(basename "$PWD")"
cd "$ROOT"
BGM=assets/audio/bgm/iso-motion.m4a
P=content/iso-motion/params.json
DUR=$(node --input-type=module -e "import fs from 'node:fs';const p=JSON.parse(fs.readFileSync('$P','utf8'));console.log(p.scenes.at(-1).t1)")
if [ ! -f "$BGM" ]; then
  node tools/synth-bgm.mjs --out /tmp/iso-motion.wav --duration "$DUR" --style electrohouse --params "$P"
  ffmpeg -v error -y -i /tmp/iso-motion.wav \
    -af "acompressor=threshold=-30dB:ratio=4:attack=5:release=140,volume=14dB,alimiter=limit=0.62:level=false,loudnorm=I=-16:TP=-2.2:LRA=5" \
    -ar 48000 -ac 2 -c:a aac -b:a 160k "$BGM"
fi
node render.mjs --kit iso --params "$P" --out out/iso-motion.mp4
node src/gate.mjs out/iso-motion.mp4 --blank --require-audio
echo "── 质检汇总：文案 / 分镜 / 门禁 / 案例留痕"
node "$ROOT/tools/qc.mjs" "$SLUG"
