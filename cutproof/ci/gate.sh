#!/usr/bin/env bash
# 渲染门禁：任何一步失败即阻断。用法 ./ci/gate.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "1/5 语料自检（故障特征是否真的复现）"
python3 corpus/gen_dirty.py --verify

step "2/5 探针 + 决策 + 归一化（含 8 项规格校验）"
python3 ingest.py all
python3 - <<'PY'
import json, sys, pathlib
rows = json.loads(pathlib.Path("res/matrix.json").read_text())
bad = [r for r in rows if r["severity"] != "block" and not r["normalized_ok"]]
if bad:
    print("✗ 有语料归一化未通过校验：", [r["id"] for r in bad]); sys.exit(1)
blocked = [r for r in rows if r["severity"] == "block"]
print(f"✓ {len(rows)} 条分类正确，{len(blocked)} 条按预期拒绝入队")
PY

step "3/5 渲染（正确片 + 错片）"
python3 cutproof.py render --variant base
python3 cutproof.py render --variant fontmiss

step "4/5 证据回执：L1 结构 + L3 语义"
python3 cutproof.py receipt

step "5/5 负向测试：字体缺失的错片必须被拦"
if python3 asserts.py receipt out/render_fontmiss.mp4 \
      --font /System/Library/Fonts/Helvetica.ttc --out /tmp/neg_receipt.json >/dev/null 2>&1; then
  echo "✗ 负向测试失败：一支中文全是豆腐块的片子被放行了"
  exit 1
fi
echo "✓ 错片已被 E_FONT_MISSING 拦截（退出码 1）"

printf '\n\033[1;32m门禁全绿\033[0m\n'
