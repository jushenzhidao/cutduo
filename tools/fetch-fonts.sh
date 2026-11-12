#!/usr/bin/env bash
# 拉取纸面皮肤所需的 Noto Sans SC 字重（OFL）。字体不进 git，换机器先跑一次。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/assets/fonts"
mkdir -p "$DIR"
BASE="https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC"
for w in Black Medium Regular; do
  f="NotoSansSC-$w.otf"
  if [ -s "$DIR/$f" ]; then echo "✓ $f 已存在"; continue; fi
  echo "下载 $f …"
  curl -sSL --http1.1 --retry 3 -o "$DIR/$f" "$BASE/$f"
done
ls -lh "$DIR"
