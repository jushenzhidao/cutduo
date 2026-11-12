#!/usr/bin/env bash
# 准备 .motion 本地渲染环境：Node 22+ / Chromium / FFmpeg / ffprobe
# 全部走国内镜像，避免 npm 主源与 GitHub 二进制下载超时。
set -euo pipefail
cd "$(dirname "$0")"
REG=https://registry.npmmirror.com

echo "[1/3] npm 依赖（playwright）"
npm install --registry="$REG" --no-audit --no-fund

echo "[2/3] Chromium + headless shell"
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium

echo "[3/3] FFmpeg（平台最优：Homebrew 原生 arm64，带 VideoToolbox / NEON）"
mkdir -p bin

if command -v brew >/dev/null 2>&1; then
  BP=$(brew --prefix)
  if [ ! -x "$BP/bin/ffmpeg" ]; then
    echo "  正在安装 Homebrew ffmpeg（bottle 走 USTC 镜像）"
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 \
      HOMEBREW_BOTTLE_DOMAIN=https://mirrors.ustc.edu.cn/homebrew-bottles \
      brew install ffmpeg
  fi
  echo "  FFmpeg: $("$BP/bin/ffmpeg" -version 2>/dev/null | head -1)"
  echo "  查找顺序：FFMPEG_PATH > Homebrew > bin/（手动放置）> PATH"
  echo "  保持最新：HOMEBREW_API_DOMAIN=https://mirrors.ustc.edu.cn/homebrew-bottles/api brew update && brew upgrade ffmpeg"
  echo "  本机实测新版多线程 libx264 快于 VideoToolbox，故默认仍用软件编码。"
else
  if [ -n "${FFMPEG_PATH:-}" ] && [ -x "$FFMPEG_PATH" ]; then
    echo "  未检测到 Homebrew，使用 FFMPEG_PATH=$FFMPEG_PATH"
  else
    echo "  未检测到 Homebrew，且未设置可用的 FFMPEG_PATH。"
    echo "  请安装 Homebrew（https://brew.sh）后重跑，或自行安装 FFmpeg 并 export FFMPEG_PATH=/path/to/ffmpeg。"
    echo "  为避免重新引入已删除的旧版 4.4，脚本不再自动下载第三方旧二进制。"
    exit 1
  fi
fi

echo
echo "完成。运行 npm run doctor 检查环境，npm run render 导出视频。"
