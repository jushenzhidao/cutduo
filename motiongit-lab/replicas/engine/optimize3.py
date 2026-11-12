#!/usr/bin/env python3
"""定点收尾：blueprint 的 flat 压制过头，按实测比值做比例反馈。

用法：uv run --with numpy python replicas/engine/optimize3.py
只改 render.curve[].flat（改 grain 无效：低的 5 组都带 flat>0.47），
flat=0 且比值已达标的三组保持不动。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SLUG = "motiongit-promo-blueprint"
CLIP = lambda v, a, b: max(a, min(b, v))


def main():
    sp = ROOT / "specs" / f"{SLUG}.spec.json"
    spec = json.loads(sp.read_text())
    rows = json.loads((ROOT / "out" / SLUG / "metrics-after.json").read_text())["rows"]
    changes = []
    for c in spec["render"]["curve"]:
        r = min(rows, key=lambda x: abs(x["t"] - c["t"]))
        old = c["flat"]
        if old <= 0.05:                       # 已达标组不动
            c["flat_feedback"] = dict(before=round(old, 4), ratio=r["sharp_ratio"], skipped=True)
            continue
        ratio = r["sharp_our"] / max(r["sharp_ref"], 1e-6)   # <1 说明 our 偏低
        c["flat"] = round(CLIP(old * ratio, 0, 0.9), 4)       # 减小 flat → 锐度回升
        c["flat_feedback"] = dict(before=round(old, 4), after=c["flat"],
                                  ratio=round(r["sharp_ratio"], 3))
        changes.append((old, c["flat"]))
    spec["render"]["note"] = "optimize.py 曲线 + optimize2.py grain 反馈 + optimize3.py flat 比例反馈（定点收尾）。"
    spec["render"]["final_feedback"] = dict(flat_points=len(changes),
                                            mean_flat_before=round(sum(a for a, b in changes) / max(len(changes), 1), 4),
                                            mean_flat_after=round(sum(b for a, b in changes) / max(len(changes), 1), 4))
    sp.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    print(f"  {SLUG}: {len(changes)} 个 flat 点  {spec['render']['final_feedback']['mean_flat_before']} → "
          f"{spec['render']['final_feedback']['mean_flat_after']}")


if __name__ == "__main__":
    main()
