#!/usr/bin/env python3
"""定点修复：只处理统一判据后仍锐度未达标的模板，有明确目标、不做全局第三轮迭代。

用法：uv run --with numpy python replicas/engine/fix3.py
对每个目标：用 8 组实测中位数锐度反推 grain/flat；参数已到上限者标记 unfixable，如实保留。
"""
import json
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLIP = lambda v, a, b: max(a, min(b, v))
TARGETS = ["motiongit-promo-blueprint", "motiongit-promo-keynote",
           "motiongit-promo-pixel", "motiongit-promo-velocity"]


def one(slug):
    sp = ROOT / "specs" / f"{slug}.spec.json"
    mf = ROOT / "out" / slug / "metrics-after.json"
    spec = json.loads(sp.read_text())
    rows = json.loads(mf.read_text())["rows"]
    R = spec["render"]
    cal = R["calibration"]
    kg = max(0.1, (cal["s_grain_0_5"] - cal["s0"]) / 0.5)
    kf = max(0.01, (cal["s0"] - cal["s_flat_0_6"]) / 0.6)
    cur = float(np.median([r["sharp_our"] for r in rows]))
    ref = float(np.median([r["sharp_ref"] for r in rows]))
    ratio = float(np.median([r["sharp_ratio"] for r in rows]))
    delta = ref - cur
    g, f = float(R.get("grain", 0)), float(R.get("flat", 0))
    before = (round(g, 4), round(f, 4))
    if delta > 0:
        g = CLIP(g + delta / kg, 0, 1)
    else:
        cut = min(g, -delta / kg)
        g = CLIP(g - cut, 0, 1)
        rest = -delta - cut * kg
        if rest > 0:
            f = CLIP(f + rest / kf, 0, 0.9)
    R["grain"], R["flat"] = round(g, 4), round(f, 4)
    # 参数到上限且仍偏离 → 真实边界，不再假装能修
    R["unfixable"] = bool((delta < 0 and g == 0 and f >= 0.9) or (delta > 0 and g >= 1))
    R["fix3"] = dict(median_cur=round(cur, 3), median_ref=round(ref, 3),
                     median_ratio=round(ratio, 3), delta=round(delta, 3),
                     params_before=list(before))
    R["note"] = "fix.py 单轮网格补偿 + fix2.py 中位数反调 + fix3.py 定点补差；共三轮，第三轮仅限 4 个未达标模板。"
    spec["render"] = R
    sp.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 中位比值 {ratio:5.3f} cur {cur:5.2f}→ref {ref:5.2f} "
          f"grain {before[0]:.2f}→{g:.2f} flat {before[1]:.2f}→{f:.2f} "
          f"{'不可修(参数上限)' if R['unfixable'] else ''}", flush=True)
    return dict(slug=slug, ratio=round(ratio, 3), grain=round(g, 4), flat=round(f, 4),
                unfixable=R["unfixable"])


def main():
    out = [one(s) for s in TARGETS]
    (ROOT / "fix-report-round3.json").write_text(json.dumps(
        dict(method="定点修复 4 个锐度未达标模板；参数到上限者如实标记", count=len(out), items=out),
        ensure_ascii=False, indent=2))
    print(f"✓ {len(out)} 份定点修复，其中不可修 {sum(1 for r in out if r['unfixable'])}")


if __name__ == "__main__":
    main()
