#!/usr/bin/env bash
# tools/smoke.sh · 五套版式各出一帧
#
# 存在的理由：2026-11-13 的目录重构把 skia-kit 从 motiongit-lab/ 拆成 src/ + kits/，
# 四个 kit 原先都用 `dirname(..)` 猜仓库根，深度一变全错。语法检查发现不了这类问题
# （import 路径合法，运行时才 404），只有真渲染一帧才知道。
#
# 判据：能出 PNG 且体积 > 5KB（空帧 / 纯色帧通常只有几百字节）。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

OUT=out/smoke
mkdir -p "$OUT"
fail=0

probe() {
  local name=$1; shift
  if node "$@" >"/tmp/smoke-$name.log" 2>&1; then
    local size
    size=$(stat -f%z "$OUT/$name.png" 2>/dev/null || echo 0)
    if [ "$size" -gt 5000 ]; then
      printf 'PASS  %-10s %8s bytes\n' "$name" "$size"
    else
      printf 'FAIL  %-10s 帧过小 %s bytes（疑似空白）\n' "$name" "$size"
      fail=1
    fi
  else
    printf 'FAIL  %-10s\n' "$name"
    tail -4 "/tmp/smoke-$name.log" | sed 's/^/        /'
    fail=1
  fi
}

probe paper     render.mjs --kit paper --params kits/paper/presets/v8t.json --probe "$OUT/paper.png" --at 3
probe science   render.mjs --kit science --params kits/science/template/presets/demo.json --probe "$OUT/science.png" --at 3
probe desk      kits/desk/render.mjs --params content/demo.json --probe "$OUT/desk.png"
probe editorial kits/editorial/canvas-editorial.mjs --inputs content/inputs-v6.json --probe "$OUT/editorial.png"
probe mg        kits/mg/render.mjs --params kits/mg/params.json --probe "$OUT/mg.png" --at 3

# API 契约层：五支都要能被 api.probe 调度（走子进程 + 契约校验）
echo
echo "── API 契约 ──"
if [ "$(node api/cli.mjs capabilities --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).kits.length))' 2>/dev/null)" = "5" ]; then
  printf 'PASS  %-10s 5 支能力可枚举\n' capabilities
else
  printf 'FAIL  %-10s 能力清单不是 5 支\n' capabilities
  fail=1
fi
for k in paper science desk editorial mg; do
  if node api/cli.mjs probe --kit "$k" --out "$OUT/api-$k.mp4" --at 3 >/dev/null 2>&1; then
    printf 'PASS  %-10s api.probe\n' "api:$k"
  else
    printf 'FAIL  %-10s api.probe\n' "api:$k"
    fail=1
  fi
done

echo
if [ "$fail" -ne 0 ]; then
  echo "有版式未通过 —— 不要提交"
  exit 1
fi
echo "五套版式全部出帧正常"
