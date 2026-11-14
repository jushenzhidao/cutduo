#!/bin/bash
# 一条命令：配音时间轴 → 响度归一 → 配乐 → 混音 → 渲染 → 门禁
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SLUG="$(basename "$PWD")"
echo "── 1/6 配音定长 + 时间轴（链式）"
node build.mjs --chain
echo "── 预检：screens 结构 + 分镜一致性"
node "$ROOT/tools/check-screens.mjs" "$SLUG"
node "$ROOT/tools/check-beats.mjs" --slug "$SLUG"
echo "── 2/6 旁白响度归一（edge-tts 原始约 -23.7 LUFS，必须在配音环节补）"
ffmpeg -v error -y -i audio/vo.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -ac 1 audio/vo-norm.wav
echo "── 3/6 分层配乐"
node bgm.mjs
echo "── 4/6 混音"
node mix.mjs
echo "── 5/6 渲染"
cd "$ROOT"
node render.mjs --kit paper --params content/collect-never/params-chain.json \
  --audio content/collect-never/audio/mix-final.wav --out out/collect-never.mp4
echo "── 质检汇总：文案 / 分镜 / 门禁 / 案例留痕"
node "$ROOT/tools/qc.mjs" "$SLUG"
