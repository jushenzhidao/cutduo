#!/usr/bin/env bash
# 一条命令：剪辑稿 → MotionGit 模板成片
#
# 前置：build-sync.py 已经生成
#   edits/inputs-<前缀>.json   （时间轴 + 分镜 + 字幕）
#   edits/audio-<前缀>.m4a     （配音 + 背景音）
#   edits/assets/avatar.png    （口播头像，可选）
#
# 用法：
#   ./make-tpl.sh <前缀> [并发数] [口播标签]
#   ./make-tpl.sh v7 2 "晓晓 · 口播"
#
# 说明：脚本内部会调用 gen-tpl-params.py（写 /tmp 并创建模板实例）与
# render-batch.py（并发出片），因此需要在非沙箱环境运行。
set -euo pipefail

P="${1:?用法: make-tpl.sh <前缀> [并发数] [口播标签]}"
J="${2:-2}"
LABEL="${3:-口播}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

WORK="$(python3 gen-tpl-params.py \
  --inputs "edits/inputs-$P.json" --audio "edits/audio-$P.m4a" \
  --voice-label "$LABEL" --work "/tmp/tpl-$P" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['instance'])")"

echo "实例: $WORK"
python3 render-batch.py --jobs "$J" --out-dir "out/tpl" "$WORK"
