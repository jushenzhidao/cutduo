#!/usr/bin/env python3
"""按镜头时间点自适应锐度：逐采样点实测标定 grain/flat 曲线。

用法：uv run --with numpy --with pillow python replicas/engine/optimize.py

背景：全局 grain 让复刻锐度恒定，而参考片各镜头纹理复杂度差 3–10×，
逐点比值不可能同时落进 0.93–1.05。改为对每个 compare 采样点反解参数，
渲染器按 t 线性插值，做到「参考片细 → 复刻也细；参考片平 → 复刻也平」。
"""
import copy
import json
import pathlib
import subprocess
import tempfile

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
MGLAB = ROOT.parent
TARGETS = ["motiongit-promo-blueprint", "motiongit-promo-keynote",
           "motiongit-promo-pixel", "motiongit-promo-velocity"]
CLIP = lambda v, a, b: max(a, min(b, v))


def sharp(p):
    a = np.asarray(Image.open(p).convert("L"), dtype=np.float32)
    return float((np.abs(np.diff(a, axis=1))[:, :-1].mean()
                  + np.abs(np.diff(a, axis=0))[:-1, :].mean()) / 2)


def probe(base, slug, t, g, f):
    """用不含 curve 的临时 spec 标定，避免自干扰。"""
    s = copy.deepcopy(base)
    s["render"] = dict(grain=g, flat=f, motion=True, compensated=True)
    tmp = pathlib.Path(tempfile.gettempdir()) / f"opt-{slug}-{t:.3f}-{g}-{f}.spec.json"
    tmp.write_text(json.dumps(s, ensure_ascii=False))
    out = pathlib.Path(tempfile.gettempdir()) / f"opt-{slug}-{t:.3f}-{g}-{f}.png"
    subprocess.run(["node", "replicas/engine/render.mjs", "--spec", str(tmp),
                    "--probe", str(out), "--at", f"{t:.3f}"],
                   cwd=str(MGLAB), capture_output=True, text=True, check=True)
    return sharp(out)


def one(slug):
    sp = ROOT / "specs" / f"{slug}.spec.json"
    spec = json.loads(sp.read_text())
    rows = json.loads((ROOT / "out" / slug / "metrics-after.json").read_text())["rows"]
    base = copy.deepcopy(spec)
    base["render"] = dict(grain=0, flat=0, motion=True, compensated=True)
    curve = []
    for r in rows:
        t, target = r["t"], r["sharp_ref"]
        s0 = probe(base, slug, t, 0.0, 0.0)
        sg = probe(base, slug, t, 0.4, 0.0)
        sf = probe(base, slug, t, 0.0, 0.6)
        kg = max(0.1, (sg - s0) / 0.4)
        kf = max(0.01, (s0 - sf) / 0.6)
        if target > s0:
            g, f = CLIP((target - s0) / kg, 0, 1), 0.0
        else:
            g, f = 0.0, CLIP((s0 - target) / kf, 0, 0.9)
        predicted = s0 + g * kg - f * kf
        curve.append(dict(t=t, grain=round(g, 4), flat=round(f, 4),
                          s0=round(s0, 3), target=round(target, 3),
                          predicted=round(predicted, 3)))
    R = spec.get("render", {})
    R.update(dict(grain=0, flat=0, motion=True, compensated=True,
                  curve=curve,
                  note="optimize.py 逐采样点实测标定 grain/flat 曲线；渲染器按 t 线性插值。"))
    R["curve_calibration"] = dict(points=len(curve),
                                  mean_predict_err=round(float(np.mean([abs(c["predicted"] - c["target"]) for c in curve])), 3))
    spec["render"] = R
    sp.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    err = R["curve_calibration"]["mean_predict_err"]
    print(f"  {slug:<28} 曲线 {len(curve)} 点  平均预测误差 {err:.3f}  "
          f"grain {min(c['grain'] for c in curve):.2f}–{max(c['grain'] for c in curve):.2f}  "
          f"flat {min(c['flat'] for c in curve):.2f}–{max(c['flat'] for c in curve):.2f}", flush=True)
    return dict(slug=slug, points=len(curve), mean_predict_err=err,
                grain_range=[min(c["grain"] for c in curve), max(c["grain"] for c in curve)],
                flat_range=[min(c["flat"] for c in curve), max(c["flat"] for c in curve)],
                curve=curve)


def main():
    out = [one(s) for s in TARGETS]
    (ROOT / "optimize-report.json").write_text(json.dumps(
        dict(method="逐 compare 采样点 3 探针标定 + 渲染器按 t 线性插值", count=len(out), items=out),
        ensure_ascii=False, indent=2))
    print(f"✓ {len(out)} 份曲线已写入 spec")


if __name__ == "__main__":
    main()
