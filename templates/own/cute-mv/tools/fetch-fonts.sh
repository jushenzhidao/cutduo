#!/usr/bin/env bash
# 取本模板用的两款 OFL 字体。字体不进包、不进 git，换机器先跑一次。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$ROOT/assets/fonts"
mkdir -p "$DIR"

fetch() {
  local out="$1" url="$2"
  if [ -s "$DIR/$out" ]; then echo "✓ $out 已存在"; return; fi
  echo "下载 $out …"
  curl -sSL --http1.1 --retry 3 --max-time 600 -o "$DIR/$out" "$url"
  ls -lh "$DIR/$out"
}

fetch LXGWWenKai-Regular.ttf \
  "https://github.com/lxgw/LxgwWenKai/releases/download/v1.520/LXGWWenKai-Regular.ttf"
fetch ZCOOLKuaiLe-Regular.ttf \
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf"
