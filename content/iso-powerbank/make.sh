#!/bin/bash
# 一条命令：渲染 → 门禁 → 节奏体检
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
cd "$ROOT"
echo "── 1/3 渲染（Canvas2D 直出，无浏览器）"
node render.mjs --kit iso --params content/iso-powerbank/params.json --out out/iso-powerbank.mp4
echo "── 2/3 门禁（无声素材：只跑完整性 + 空镜）"
node src/gate.mjs out/iso-powerbank.mp4 --blank
echo "── 3/3 节奏（hold 判据：落位后要停 ≥30f@30fps）"
node tools/pacing.mjs out/iso-powerbank.mp4 --params content/iso-powerbank/params.json
