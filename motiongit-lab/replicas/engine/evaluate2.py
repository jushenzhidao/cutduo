#!/usr/bin/env python3
"""v1 → v2 视觉还原度量化：同口径（8 个精确时间点、两侧无损 PNG）比较。

输出 replicas/v2-eval.json，所有数字从 metrics-after.json 与 metrics-v2.json 实算。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
KEYS = ("grid_diff", "point_diff", "mad", "sharp_ratio")


def main():
    slugs = sorted(p.stem.replace('.spec', '') for p in (ROOT / "specs").glob("*.spec.json"))
    rows = []
    for s in slugs:
        p1 = ROOT / "out" / s / "metrics-after.json"
        p2 = ROOT / "out" / s / "metrics-v2.json"
        if not (p1.exists() and p2.exists()):
            continue
        a = json.loads(p1.read_text())["means"]
        b = json.loads(p2.read_text())["means"]
        rows.append(dict(slug=s, v1=a, v2=b,
                         delta={k: round(b[k] - a[k], 3) for k in KEYS},
                         improvement_mad=round((a["mad"] - b["mad"]) / max(a["mad"], 1e-6) * 100, 1),
                         improvement_grid=round((a["grid_diff"] - b["grid_diff"]) /
                                                max(a["grid_diff"], 1e-6) * 100, 1)))
    means = {}
    for k in KEYS:
        x = sum(r["v1"][k] for r in rows) / len(rows)
        y = sum(r["v2"][k] for r in rows) / len(rows)
        means[k] = dict(v1=round(x, 3), v2=round(y, 3), delta=round(y - x, 3))
    out = dict(method="v1（骨架渲染器）与 v2（160×90 颜色场 + OCR 文字层）在同一 compare 口径下的 8 点均值；"
                      "两侧均从原视频按精确时间点抽无损 PNG，编码条件一致。",
               note="MAD / 色差越低越好；锐度比接近 1.0 表示纹理复杂度匹配。"
                    "v2 的锐度比不作为优化目标（颜色场本身平滑），仅留痕。",
               count=len(rows), means=means, rows=rows)
    (ROOT / "v2-eval.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"{'模板':<12}{'MAD v1':>9}{'MAD v2':>9}{'降幅':>9}{'网格 v1':>10}{'网格 v2':>10}")
    for r in rows:
        print(f"{r['slug'].replace('motiongit-promo-',''):<12}"
              f"{r['v1']['mad']:>9.2f}{r['v2']['mad']:>9.2f}{r['improvement_mad']:>8.1f}%"
              f"{r['v1']['grid_diff']:>10.2f}{r['v2']['grid_diff']:>10.2f}")
    print(f"{'平均':<12}{means['mad']['v1']:>9.2f}{means['mad']['v2']:>9.2f}"
          f"{(means['mad']['v1']-means['mad']['v2'])/means['mad']['v1']*100:>8.1f}%"
          f"{means['grid_diff']['v1']:>10.2f}{means['grid_diff']['v2']:>10.2f}")


if __name__ == "__main__":
    main()
