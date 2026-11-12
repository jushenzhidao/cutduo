#!/usr/bin/env python3
"""自动修复（一轮收敛）：逐模板实测标定 + 网格配色反向补偿。

用法：uv run --with numpy --with pillow python replicas/engine/fix.py

对每个模板：
  1. 目标锐度 = 参考片 8 个采样点的实测锐度均值（metrics-before.json）
  2. 单帧探针实测三条基线：s0(grain=0,flat=0)、sg(0.5,0)、sf(0,0.6)
     → 反解 grain 或 flat，使复刻锐度朝目标收敛（不是统一拍参数）
  3. 按参考/复刻同时间点 8×6 网格差，对 spec.segments[].grid 做单轮反向补偿
  4. 置 render.motion=true（连续动效，消除 60fps 重复帧）
原 spec 备份为 specs/<slug>.spec.before.json。
"""
import json
import pathlib
import subprocess

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
MGLAB = ROOT.parent
GAIN = 0.85
CLIP = lambda v, a, b: max(a, min(b, v))


def sharp(p):
    a = np.asarray(Image.open(p).convert("L"), dtype=np.float32)
    return float((np.abs(np.diff(a, axis=1))[:, :-1].mean()
                  + np.abs(np.diff(a, axis=0))[:-1, :].mean()) / 2)


def probe(spec_path, grain, flat, at=3.0):
    """临时注入 render 参数跑单帧探针，测完恢复原 spec（不污染其它探针）。"""
    orig = spec_path.read_text()
    s = json.loads(orig)
    s["render"] = dict(grain=grain, flat=flat, motion=True, compensated=False)
    spec_path.write_text(json.dumps(s, ensure_ascii=False))
    out = f"/tmp/fix-probe-{spec_path.stem.replace('.spec','')}-{grain}-{flat}.png"
    try:
        subprocess.run(["node", "replicas/engine/render.mjs", "--spec", str(spec_path),
                        "--probe", out, "--at", str(at)],
                       cwd=str(MGLAB), capture_output=True, text=True, check=True)
        return sharp(out)
    finally:
        spec_path.write_text(orig)


def fix_one(slug):
    sp = ROOT / "specs" / f"{slug}.spec.json"
    mf = ROOT / "out" / slug / "metrics-before.json"
    if not mf.exists():
        print(f"  SKIP {slug} (缺 before 指标)")
        return None
    spec = json.loads(sp.read_text())
    rows = json.loads(mf.read_text())["rows"]
    backup = ROOT / "specs" / f"{slug}.spec.before.json"
    if not backup.exists():
        backup.write_text(json.dumps(spec, ensure_ascii=False, indent=2))

    target = float(np.mean([r["sharp_ref"] for r in rows]))
    # 三条基线探针（临时改 spec，测完一次性写回最终版）
    s0 = probe(sp, 0.0, 0.0)
    sg = probe(sp, 0.5, 0.0)
    sf = probe(sp, 0.0, 0.6)
    kg = max(0.1, (sg - s0) / 0.5)
    kf = max(0.01, (s0 - sf) / 0.6)
    if target > s0:
        grain, flat = CLIP((target - s0) / kg, 0, 1), 0.0
    else:
        grain, flat = 0.0, CLIP((s0 - target) / kf, 0, 0.9)
    predicted = s0 + grain * kg - flat * kf

    # 网格配色补偿
    deltas = []
    for seg in spec["segments"]:
        hit = [r for r in rows if seg["t0"] <= r["t"] < seg["t1"]]
        if not hit:
            hit = [min(rows, key=lambda r: abs(r["t"] - (seg["t0"] + seg["t1"]) / 2))]
        d = np.mean([np.array(r["grid_ref"], dtype=np.float32)
                     - np.array(r["grid_our"], dtype=np.float32) for r in hit], axis=0)
        g = np.array(seg["grid"], dtype=np.float32) + GAIN * d
        seg["grid"] = [[int(round(v)) for v in np.clip(c, 0, 255)] for c in g]
        deltas.append(float(np.abs(d).mean()))

    spec["render"] = dict(grain=round(grain, 4), flat=round(flat, 4), motion=True,
                          compensated=True,
                          calibration=dict(target=round(target, 3), s0=round(s0, 3),
                                           s_grain_0_5=round(sg, 3), s_flat_0_6=round(sf, 3),
                                           predicted=round(predicted, 3)),
                          note="fix.py 逐模板探针标定 grain/flat + 网格反向补偿；单轮收敛，不迭代到过拟合。")
    sp.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 锐度 {s0:5.2f}→目标{target:5.2f} 预{predicted:5.2f} "
          f"grain={grain:.2f} flat={flat:.2f} 网格补偿 {np.mean(deltas):.2f}", flush=True)
    return dict(slug=slug, target=round(target, 3), s0=round(s0, 3),
                predicted=round(predicted, 3), grain=round(grain, 4), flat=round(flat, 4),
                segments=len(spec["segments"]),
                mean_compensation=round(float(np.mean(deltas)), 2))


def main():
    slugs = [p.stem.replace('.spec', '') for p in sorted((ROOT / "specs").glob("*.spec.json"))]
    out = [r for r in (fix_one(s) for s in slugs) if r]
    (ROOT / "fix-report.json").write_text(json.dumps(
        dict(gain=GAIN, method="逐模板 3 点探针标定 + 单轮网格补偿", count=len(out), items=out),
        ensure_ascii=False, indent=2))
    print(f"✓ {len(out)} 份 spec 已修复")


if __name__ == "__main__":
    main()
