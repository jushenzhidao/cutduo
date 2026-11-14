#!/bin/bash
# 一条命令：合成配乐 → 母带 → 两版配色出片 → 门禁 → 节奏
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SLUG="$(basename "$PWD")"
cd "$ROOT"

BGM=assets/audio/bgm/iso-iphone.m4a
P=content/iso-iphone/params.json
DUR=$(node -e "const p=require('./$P'.replace(/\\.json$/,'.json'));" 2>/dev/null || true)
DUR=$(node --input-type=module -e "import fs from 'node:fs';const p=JSON.parse(fs.readFileSync('$P','utf8'));console.log(p.scenes.at(-1).t1)")

if [ ! -f "$BGM" ]; then
  echo "── 0/5 代码合成配乐（零素材；122 BPM，drop 自动落在信息最满的那一段 = 爆炸开头）"
  node tools/synth-bgm.mjs --out /tmp/iso-bgm.wav --duration "$DUR" --style electrohouse --params "$P"
  # 母带：先压缩把 crest 压到能同时满足 -16 LUFS 与 -0.5 dBTP，再归一
  ffmpeg -v error -y -i /tmp/iso-bgm.wav \
    -af "acompressor=threshold=-30dB:ratio=4:attack=5:release=140,volume=14dB,alimiter=limit=0.62:level=false,loudnorm=I=-16:TP=-2.2:LRA=5" \
    -ar 48000 -ac 2 -c:a aac -b:a 160k "$BGM"
fi

echo "── 1/5 深色柔光版（默认 look）"
node render.mjs --kit iso --params "$P" --out out/iso-iphone.mp4
echo "── 2/5 橙色桌面版（同一套动画，只换配色）"
ISO_LOOK=split node render.mjs --kit iso --params "$P" --out out/iso-iphone-split.mp4
echo "── 3/5 门禁（完整性 + 空镜 + 响度 + 配乐间隙）"
node src/gate.mjs out/iso-iphone.mp4 out/iso-iphone-split.mp4 --blank --require-audio
echo "── 4/5 节奏（hold 判据：落位后要停 ≥30f@30fps）"
node tools/pacing.mjs out/iso-iphone.mp4 --params "$P"
echo "── 5/5 抽帧拼图"
ffmpeg -v error -y -i out/iso-iphone.mp4 -vf "fps=1/2.3,scale=480:-1,tile=4x3" -frames:v 1 out/iso-iphone-sheet.png
echo "── 质检汇总：文案 / 分镜 / 门禁 / 案例留痕"
node "$ROOT/tools/qc.mjs" "$SLUG"
