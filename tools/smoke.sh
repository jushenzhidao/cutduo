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
probe clay      render.mjs --kit clay --params kits/clay/presets/default.json --probe "$OUT/clay.png" --at 3
probe collage   render.mjs --kit collage --params kits/collage/presets/demo.json --probe "$OUT/collage.png" --at 30
probe editorial kits/editorial/canvas-editorial.mjs --inputs content/inputs-v6.json --probe "$OUT/editorial.png"
probe mg        kits/mg/render.mjs --params kits/mg/params.json --probe "$OUT/mg.png" --at 3
probe night-card render.mjs --kit night-card --params templates/own/night-card/presets/default.json --probe "$OUT/night-card.png" --at 4

# API 契约层：每支 kit 都要能被 api.probe 调度（子进程 + 契约校验）
# 断言写成「能力清单 == kits/ 目录集合」，而不是写死数量 ——
# 否则每加一支版式就要回来改这行，且改了也不知道漏没漏。
echo
echo "── API 契约 ──"
CAPS=$(node api/cli.mjs capabilities --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kits.map(k=>k.id).sort().join(","))}catch{console.log("")}})' 2>/dev/null)
# 判据不是「清单 == 目录集合」：templates/own/ 下的模板也可以接 API（night-card 就是），
# 那种情况下清单会多于 kits/。真正要保证的是「kits/ 里不许有目录没接 API」——
# 目录布局不是契约，能力清单才是。
MISSING=""
for d in kits/*/; do
  id=$(basename "$d")
  case ",$CAPS," in *",$id,"*) ;; *) MISSING="$MISSING $id" ;; esac
done
if [ -n "$CAPS" ] && [ -z "$MISSING" ]; then
  printf 'PASS  %-10s kits/ 全部接入（清单共 %s 支）\n' capabilities "$(echo "$CAPS" | tr ',' '\n' | wc -l | tr -d ' ')"
else
  printf 'FAIL  %-10s 未接入：%s\n' capabilities "${MISSING:-<清单为空>}"
  fail=1
fi
for k in paper science desk clay editorial mg collage night-card; do
  if node api/cli.mjs probe --kit "$k" --out "$OUT/api-$k.mp4" --at 3 >/dev/null 2>&1; then
    printf 'PASS  %-10s api.probe\n' "api:$k"
  else
    printf 'FAIL  %-10s api.probe\n' "api:$k"
    fail=1
  fi
done

# 能力清单与代码一致：这份文件是给 agent 读的，漂移过（入库只到 5 支，缺 clay/collage/night-card）
if node tools/gen-capabilities.mjs --check >/dev/null 2>&1; then
  printf 'PASS  %-10s capabilities.json 与代码一致\n' "api"
else
  printf 'FAIL  %-10s capabilities.json 已过期（跑 node tools/gen-capabilities.mjs）\n' "api"
  fail=1
fi

# 标定断言：calibration.json 里的锚点能不能对上真实渲染（片级档案不许回写）
if node tools/verify-calibration.mjs --params kits/science/template/presets/demo.vo.json --json >/tmp/cal.json 2>/dev/null; then
  P=$(node -e 'const d=require("/tmp/cal.json");process.stdout.write(`${d.pass} 条可断言 / 只供参考 ${d.referenceOnly}`)')
  printf 'PASS  %-10s calibration %s\n' "science" "$P"
elif [ -f /tmp/cal.json ]; then
  printf 'FAIL  %-10s calibration 有超差（见 node tools/verify-calibration.mjs --params ...）\n' "science"
  fail=1
else
  printf 'FAIL  %-10s calibration 验证器跑不起来\n' "science"
  fail=1
fi

# 素材引用与来源：P0（路径失效）会阻断出片，P1（来源缺失）是规范问题。
# period 的两条历史素材在 content/_note 里没有来源说明，故意保持 unknown（W 待确认），
# 所以这里用 --strict 但 W 不阻断——真正拦住的是 P0/P1。
echo
echo "── 素材审计 ──"
if python3 tools/asset-audit.py --strict >/tmp/smoke-assets.log 2>&1; then
  printf 'PASS  %-10s %s\n' assets "$(tail -2 /tmp/smoke-assets.log | head -1)"
else
  printf 'FAIL  %-10s 素材路径或来源有问题\n' assets
  tail -6 /tmp/smoke-assets.log | sed 's/^/        /'
  fail=1
fi

# 异步任务：submit → 立即 cancel，只验证状态机能走完（不等整片，否则冒烟要几分钟）
JOB=$(echo "{\"kit\":\"mg\",\"preset\":\"default\",\"out\":\"$OUT/job-smoke.mp4\"}" \
  | node api/cli.mjs render --stdin --async --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).jobId||"")}catch{console.log("")}})')
if [ -n "$JOB" ] && node api/cli.mjs cancel --id "$JOB" >/dev/null 2>&1; then
  printf 'PASS  %-10s submit → cancel\n' job
else
  printf 'FAIL  %-10s submit → cancel\n' job
  fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "有版式未通过 —— 不要提交"
  exit 1
fi
echo "全部版式出帧正常"
