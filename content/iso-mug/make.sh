#!/bin/bash
# 一键：合成配乐 → 出片 → 门禁 → pacing → 抽帧
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
cd "$ROOT"
BGM=assets/audio/bgm/iso-mug.m4a
P=content/iso-mug/params.json
DUR=$(node --input-type=module -e "import fs from 'node:fs';const p=JSON.parse(fs.readFileSync('$P','utf8'));console.log(p.scenes.at(-1).t1)")
if [ ! -f "$BGM" ]; then
  node tools/synth-bgm.mjs --out /tmp/iso-mug.wav --duration "$DUR" --style chillwave --params "$P"
  ffmpeg -v error -y -i /tmp/iso-mug.wav \
    -af "acompressor=threshold=-30dB:ratio=4:attack=5:release=140,volume=14dB,alimiter=limit=0.62:level=false,loudnorm=I=-16:TP=-2.2:LRA=5" \
    -ar 48000 -ac 2 -c:a aac -b:a 160k "$BGM"
fi
node render.mjs --kit iso --params "$P" --out out/iso-mug.mp4
node src/gate.mjs out/iso-mug.mp4 --blank --require-audio
node tools/pacing.mjs out/iso-mug.mp4 --params "$P"
ffmpeg -v error -y -i out/iso-mug.mp4 -vf "fps=1/2.0,scale=480:-1,tile=4x3" -frames:v 1 out/mug-sheet.png
