#!/bin/bash
# 改完 script.json 后一条命令出片：配音 → 时间轴（链式）→ 配乐 → 混音 → 渲染 → 门禁
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
echo "── 1/5 重算时间轴（链式）"
python3 build.py --chain
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
node src/gate.mjs out/birthday-paradox.mp4 --facts content/birthday-paradox/facts.md --require-loudness --require-bgm 2>&1 | grep -E "PASS|FAIL|LUFS|台账"
