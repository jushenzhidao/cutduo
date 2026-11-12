#!/usr/bin/env python3
"""成片级闭环反馈：先实测「加 grain → 编码后锐度」的真实斜率，再按残差校正曲线。

用法：uv run --with numpy --with pillow python replicas/engine/optimize2.py

为什么需要：optimize.py 用无损 probe PNG 标定，但成片经过 JPEG 输入 + H.264 编码，
细噪点会被压掉一部分；模型预测误差 0.063–0.297 不足以解释成片残差。
本脚本用一次真实出片测出 kg_eff，再按 measured(ref-our) 反推 grain 增量。
"""
import copy
import json
import pathlib
import subprocess

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
MGLAB = ROOT.parent
FFMPEG = "/opt/homebrew/bin/ffmpeg"
CALIB_SLUG = "motiongit-promo-blueprint"
TARGETS = ["motiongit-promo-blueprint", "motiongit-promo-keynote", "motiongit-promo-velocity"]
DELTA_G = 0.12
CLIP = lambda v, a, b: max(a, min(b, v))


def sharp(p):
    a = np.asarray(Image.open(p).convert("L"), dtype=np.float32)
    return float((np.abs(np.diff(a, axis=1))[:, :-1].mean()
                  + np.abs(np.diff(a, axis=0))[:-1, :].mean()) / 2)


def sample_sharp(video, duration, out_prefix):
    vals = []
    for i in range(8):
        t = duration * (i + 0.5) / 8
        p = f"/tmp/{out_prefix}-{i}.png"
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}",
                        "-i", str(video), "-frames:v", "1", "-y", p], check=True, capture_output=True)
        vals.append(sharp(p))
    return np.array(vals)


def calibrate_encoded():
    """把标定模板的 curve.grain 统一 +DELTA_G 重出片，测编码后的真实斜率。"""
    sp = ROOT / "specs" / f"{CALIB_SLUG}.spec.json"
    orig = sp.read_text()
    s = json.loads(orig)
    for c in s["render"]["curve"]:
        c["grain"] = CLIP(c["grain"] + DELTA_G, 0, 1)
    sp.write_text(json.dumps(s, ensure_ascii=False))
    calib_video = ROOT / "out" / CALIB_SLUG / "calib-grain.mp4"
    try:
        subprocess.run(["node", "replicas/engine/render.mjs", "--spec", str(sp),
                        "--out", str(calib_video), "--workers", "8"],
                       cwd=str(MGLAB), capture_output=True, text=True, check=True)
        duration = json.loads((ROOT / "specs" / f"{CALIB_SLUG}.spec.json").read_text())["meta"]["duration"]
        new = sample_sharp(calib_video, duration, "calib-new")
        base = np.array([r["sharp_our"] for r in json.loads(
            (ROOT / "out" / CALIB_SLUG / "metrics-after.json").read_text())["rows"]])
        slopes = (new - base) / DELTA_G
        kg = float(np.median(slopes))
        print(f"  成片级标定 kg_eff={kg:.2f}/grain（逐点 {np.round(slopes,1)}）", flush=True)
        return kg, float(np.median(new - base))
    finally:
        sp.write_text(orig)   # 标定 spec 必须还原


def one(slug, kg):
    sp = ROOT / "specs" / f"{slug}.spec.json"
    spec = json.loads(sp.read_text())
    rows = json.loads((ROOT / "out" / slug / "metrics-after.json").read_text())["rows"]
    curve = spec["render"]["curve"]
    changes = []
    for c in curve:
        r = min(rows, key=lambda x: abs(x["t"] - c["t"]))
        delta = r["sharp_ref"] - r["sharp_our"]
        before = c["grain"]
        c["grain"] = round(CLIP(c["grain"] + delta / max(kg, 0.5), 0, 1), 4)
        c["feedback"] = dict(before_grain=round(before, 4), residual=round(delta, 3),
                             encoded_kg=round(kg, 2))
        changes.append(delta)
    spec["render"]["note"] = "optimize.py 曲线 + optimize2.py 成片实测斜率闭环反馈校正。"
    spec["render"]["feedback_calibration"] = dict(encoded_kg=round(kg, 2),
                                                  mean_residual=round(float(np.mean(changes)), 3))
    sp.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 曲线 {len(curve)} 点 平均残差 {np.mean(changes):+.3f} → "
          f"grain {min(c['grain'] for c in curve):.3f}–{max(c['grain'] for c in curve):.3f}", flush=True)
    return dict(slug=slug, points=len(curve), mean_residual=round(float(np.mean(changes)), 3),
                grain_range=[min(c["grain"] for c in curve), max(c["grain"] for c in curve)])


def main():
    kg, delta = calibrate_encoded()
    out = [one(s, kg) for s in TARGETS]
    (ROOT / "optimize-report2.json").write_text(json.dumps(
        dict(method="成片级 grain 斜率标定 + 逐点残差反馈", delta_grain=DELTA_G,
             encoded_kg=round(kg, 2), median_gain=round(delta, 3), count=len(out), items=out),
        ensure_ascii=False, indent=2))
    print(f"✓ {len(out)} 份曲线完成闭环校正")


if __name__ == "__main__":
    main()
