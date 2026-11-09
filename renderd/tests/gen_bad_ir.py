#!/usr/bin/env python3
"""生成一支「必然缺字」的请求体，用于负向测试。

用法：python3 tests/gen_bad_ir.py "<asset-uri>" > /tmp/bad.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from renderd.service import Service


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: gen_bad_ir.py <asset-uri>", file=sys.stderr)
        return 2
    svc = Service()
    ir, _ = svc.resolve_ir({
        "template_id": "hook_vertical_6s",
        "variables": {"clip": "a1", "hook": "中文缺字"},
        "assets": [{"id": "a1", "uri": sys.argv[1]}],
    })
    for st in ir["styles"].values():
        st["font_family"] = "Helvetica"          # 拉丁字体没有 CJK 字形
    print(json.dumps({"ir": ir, "idempotency_key": "api-neg-font-0001"},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
