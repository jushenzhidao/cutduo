#!/usr/bin/env python3
"""第二轮收敛：只用第一轮成片的实测中位数锐度反调 grain/flat，不再动网格配色。

用法：uv run --with numpy python replicas/engine/fix2.py
不做第三轮：多轮拟合会过拟合到内容差异（见 blockers §十四）。
"""
import json
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLIP = lambda v, a, b: max(a, min(b, v))


def one(slug):
    sp = ROOT / "specs" / f"{slug}.spec.json"
    mf = ROOT / "out" / slug / "metrics-after.json"
    if not mf.exists():
        return None
    spec = json.loads(sp.read_text())
    R = spec.get("render", {})
    cal = R.get("calibration", {})
    if not cal:
        return None
    rows = json.loads(mf.read_text())["rows"]
    cur = float(np.median([r["sharp_our"] for r in rows]))
    target = float(np.median([r["sharp_ref"] for r in rows]))
    s0, sg, sf = cal["s0"], cal["s_grain_0_5"], cal["s_flat_0_6"]
    kg = max(0.1, (sg - s0) / 0.5)
    kf = max(0.01, (s0 - sf) / 0.6)
    g, f = float(R.get("grain", 0)), float(R.get("flat", 0))
    delta = target - cur
    if delta > 0:
        g = CLIP(g + delta / kg, 0, 1)
    else:
        g = CLIP(g + delta / kg, 0, 1)
        if g == 0 and f < 0.9:
            f = CLIP(f + (-delta - (g - float(R.get("grain", 0))) * kg) / kf, 0, 0.9)
    R["grain"], R["flat"] = round(g, 4), round(f, 4)
    R["round2"] = dict(cur_median=round(cur, 3), target_median=round(target, 3),
                       delta=round(delta, 3), kg=round(kg, 3), kf=round(kf, 3))
    R["note"] = "fix.py 单轮网格补偿 + fix2.py 中位数锐度反调；共两轮，不再迭代。"
    spec["render"] = R
    sp.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 中位锐度 {cur:5.2f}→目标 {target:5.2f}  "
          f"grain {float(json.loads((ROOT/'specs'/f'{slug}.spec.before.json').read_text()).get('render',{}).get('grain',0)):.2f}→{g:.2f} "
          f"flat {f:.2f}", flush=True)
    return dict(slug=slug, cur=round(cur, 3), target=round(target, 3),
                grain=round(g, 4), flat=round(f, 4))


def main():
    slugs = [p.stem.replace('.spec', '') for p in sorted((ROOT / "specs").glob("*.spec.json"))]
    out = [r for r in (one(s) for s in slugs) if r]
    (ROOT / "fix-report-round2.json").write_text(json.dumps(
        dict(method="中位数锐度反调，仅第二轮；网格配色不再补偿", count=len(out), items=out),
        ensure_ascii=False, indent=2))
    print(f"✓ {len(out)} 份 spec 完成第二轮")


if __name__ == "__main__":
    main()
