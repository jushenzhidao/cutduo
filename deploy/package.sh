#!/usr/bin/env bash
# deploy/package.sh · 打包给服务器构建的代码
#
# 存在的理由：第一次部署时手工写 tar 命令，漏了仓库根的 render.mjs，
# 结果镜像里 paper/science 两支全部报「入口不存在」——容器能起、health 正常、
# 协议能握手，只有真出片时才暴露。这种漏项必须用脚本固化，不能靠记。
#
# 用法：bash deploy/package.sh [输出路径]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-/tmp/cutduo-mcp.tgz}"

tar czf "$OUT" \
  --exclude='._*' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  render.mjs \
  api \
  mcp \
  src \
  kits \
  content \
  assets \
  deploy \
  package.json \
  package-lock.json \
  .dockerignore

echo "打包完成：$OUT"
ls -lh "$OUT" | awk '{print "  体积", $5}'

# 自检：这几个文件缺任何一个，镜像起来后都会在出片时才报错
echo "关键文件自检："
for f in render.mjs api/index.mjs mcp/server.mjs src/pipeline.mjs src/root.mjs \
         kits/paper/paper.mjs kits/desk/render.mjs kits/mg/render.mjs \
         kits/editorial/canvas-editorial.mjs assets/fonts/NotoSansSC-Black.otf; do
  if tar tzf "$OUT" | grep -qx "$f"; then
    printf '  ✓ %s\n' "$f"
  else
    printf '  ✗ %s 缺失\n' "$f"
    exit 1
  fi
done
