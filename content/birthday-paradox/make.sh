#!/bin/bash
# 改完 script.json 后一条命令出片：配音 → 时间轴（链式）→ 配乐 → 混音 → 渲染 → 门禁
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SLUG="$(basename "$PWD")"
echo "── 1/5 重算时间轴（链式）"
python3 build.py --chain
echo "── 预检：screens 结构 + 分镜一致性"
node "$ROOT/tools/check-screens.mjs" "$SLUG"
node "$ROOT/tools/check-beats.mjs" --slug "$SLUG"
echo "── 2/5 旁白响度归一"
ffmpeg -v error -y -i audio/vo.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -ac 1 audio/vo-norm.wav
echo "── 3/5 分层配乐"
python3 bgm.py
echo "── 4/5 混音"
node mix.mjs
echo "── 5/5 渲染 + 门禁"
cd "$ROOT"
node render.mjs --kit paper --params content/birthday-paradox/params-chain.json \
  --audio content/birthday-paradox/audio/mix-final.wav --out out/birthday-paradox.mp4
echo "── 质检汇总：文案 / 分镜 / 门禁 / 案例留痕"
node "$ROOT/tools/qc.mjs" "$SLUG"
