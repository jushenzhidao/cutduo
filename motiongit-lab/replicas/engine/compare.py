#!/usr/bin/env python3
"""8 个模板的视频一一对比：等时长参考片 ↔ 复刻片，8 个时间点并排片段 + 实算指标。

用法：uv run --with numpy --with pillow python replicas/engine/compare.py [--tag before|after]
指标帧两侧均从原始视频按精确时间点抽无损 PNG，编码条件一致（§36 的方法论）。
"""
import json
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
FFMPEG = "/opt/homebrew/bin/ffmpeg"
TAG = sys.argv[sys.argv.index('--tag') + 1] if '--tag' in sys.argv else 'before'
DUR = 2.0
FPS = 60
SIDE_W, SIDE_H = 640, 360
LABEL_H = 60
GW, GH = 8, 6

SAMPLES = {
    "menuBar": (0.49, 0.012), "wallLeft": (0.05, 0.48), "wallTop": (0.49, 0.074),
    "wallRight": (0.96, 0.48), "wallLowL": (0.08, 0.83), "wallLowR": (0.90, 0.83),
    "dock": (0.35, 0.95),
}


def run(args):
    subprocess.run(args, check=True, capture_output=True)


def grid(a):
    h, w, _ = a.shape
    return np.array([a[gy*h//GH:(gy+1)*h//GH, gx*w//GW:(gx+1)*w//GW].reshape(-1, 3).mean(axis=0)
                     for gy in range(GH) for gx in range(GW)], dtype=np.float32)


def sharp(a):
    g = np.asarray(Image.fromarray(a.astype(np.uint8)).convert("L"), dtype=np.float32)
    return float((np.abs(np.diff(g, axis=1))[:, :-1].mean()
                  + np.abs(np.diff(g, axis=0))[:-1, :].mean()) / 2)


def patch(a, fx, fy, r=8):
    h, w, _ = a.shape
    x, y = int(fx * w), int(fy * h)
    return a[max(0, y-r):y+r, max(0, x-r):x+r].reshape(-1, 3).mean(axis=0)


def load_font(size):
    """本机 /System/Library/Fonts/PingFang.ttc 不存在；静默回退 default 会让中文变成方块。"""
    for p in ("/System/Library/Fonts/STHeiti Medium.ttc",
              "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
              "/Library/Fonts/Arial Unicode.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def label(path, slug, idx, t, gd, sr):
    im = Image.new("RGB", (SIDE_W * 2, LABEL_H), (16, 18, 23))
    d = ImageDraw.Draw(im)
    f, fs = load_font(20), load_font(14)
    # 标签严格对齐画面：左半只写官方侧，右半只写复刻侧与指标
    d.text((16, 12), f"{idx:02d}", font=f, fill=(245, 179, 33))
    d.text((58, 12), slug.replace('motiongit-promo-', ''), font=f, fill=(233, 235, 239))
    d.text((58, 38), f"官方原片 OFFICIAL   t={t:.1f}s", font=fs, fill=(154, 162, 175))
    d.text((SIDE_W + 16, 12), f"元素级复刻 REPLICA   t={t:.1f}s", font=fs, fill=(233, 235, 239))
    d.text((SIDE_W + 16, 36), f"该组指标  网格色差 {gd:.1f} / 锐度比 {sr:.2f}",
           font=fs, fill=(154, 206, 106))
    d.line([(SIDE_W, 0), (SIDE_W, LABEL_H)], fill=(80, 88, 100), width=2)
    im.save(path)


def one(slug):
    ref = ROOT / "reference" / f"{slug}.mp4"
    rep = ROOT / "out" / slug / ("replica-fixed.mp4" if TAG == 'after'
                                 else "replica.mp4")
    if not rep.exists():
        rep = ROOT / "out" / slug / "replica.mp4"
    spec = json.loads((ROOT / "specs" / f"{slug}.spec.json").read_text())
    duration = spec["meta"]["duration"]
    outdir = ROOT / "out" / slug / "vcompare"
    for p in (outdir, outdir / "mid", outdir / "labels"):
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)

    ts = [duration * (i + 0.5) / 8 for i in range(8)]
    rows, lines = [], []
    for i, t in enumerate(ts):
        start = max(0.0, min(duration - DUR, t - DUR / 2))
        cr = outdir / f"clip-ref-{i:02d}.mp4"
        co = outdir / f"clip-our-{i:02d}.mp4"
        common = ["-an", "-vf", f"fps={FPS},scale={SIDE_W}:{SIDE_H}:flags=lanczos,setsar=1",
                  "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                  "-r", str(FPS), "-y"]
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{DUR}",
             "-i", str(ref), *common, str(cr)])
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{DUR}",
             "-i", str(rep), *common, str(co)])

        mr = outdir / "mid" / f"ref-{i:02d}.png"
        mo = outdir / "mid" / f"our-{i:02d}.png"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}",
             "-i", str(ref), "-frames:v", "1", "-y", str(mr)])
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}",
             "-i", str(rep), "-frames:v", "1", "-y", str(mo)])
        a = np.asarray(Image.open(mr).convert("RGB"), dtype=np.float32)
        b = np.asarray(Image.open(mo).convert("RGB"), dtype=np.float32)
        gr, go = grid(a), grid(b)
        gd = float(np.abs(gr - go).mean())
        pd = float(np.mean([np.abs(patch(a, *xy) - patch(b, *xy)).mean() for xy in SAMPLES.values()]))
        sr, so = sharp(a), sharp(b)
        ratio = so / max(sr, 1e-6)
        mad = float(np.abs(a - b).mean())
        lab = outdir / "labels" / f"label-{i:02d}.png"
        label(lab, slug, i + 1, t, gd, ratio)
        pair = outdir / f"pair-{i:02d}.mp4"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(cr), "-i", str(co),
             "-loop", "1", "-i", str(lab), "-filter_complex",
             f"[0:v][1:v]hstack=inputs=2[hs];[hs]pad={SIDE_W*2}:{SIDE_H+LABEL_H}:0:{LABEL_H}:black[pd];"
             f"[pd][2:v]overlay=0:0:shortest=1[v]", "-map", "[v]", "-t", f"{DUR}", "-r", str(FPS),
             "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
             "-y", str(pair)])
        lines.append(f"file '{pair}'")
        rows.append(dict(i=i + 1, t=round(t, 3), grid_diff=round(gd, 2),
                         point_diff=round(pd, 2), sharp_ref=round(sr, 3),
                         sharp_our=round(so, 3), sharp_ratio=round(ratio, 3),
                         mad=round(mad, 2),
                         grid_ref=[[int(round(v)) for v in c] for c in gr],
                         grid_our=[[int(round(v)) for v in c] for c in go]))

    concat = outdir / "concat.txt"
    concat.write_text("\n".join(lines) + "\n")
    summary = ROOT / "out" / slug / "compare.mp4"
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(concat), "-c", "copy", "-y", str(summary)])
    means = {k: round(sum(r[k] for r in rows) / len(rows), 3)
             for k in ("grid_diff", "point_diff", "sharp_ratio", "mad")}
    report = dict(tag=TAG, slug=slug, reference=str(ref.relative_to(ROOT)),
                  replica=str(rep.relative_to(ROOT)), duration=round(duration, 3),
                  method="等时长等画幅；8 个均匀时间点各裁 2.0s 并排片段；指标帧为两侧精确时间点无损 PNG。",
                  means=means, rows=rows, compare_video=str(summary.relative_to(ROOT)))
    (ROOT / "out" / slug / f"metrics-{TAG}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 网格 {means['grid_diff']:6.2f}  固定点 {means['point_diff']:6.2f}  "
          f"锐度比 {means['sharp_ratio']:5.3f}  MAD {means['mad']:6.2f}", flush=True)
    return report


def main():
    slugs = [p.stem.replace('.spec', '') for p in sorted((ROOT / "specs").glob("*.spec.json"))]
    out = []
    for s in slugs:
        if not (ROOT / "out" / s / "replica.mp4").exists():
            print(f"  SKIP {s} (复刻片尚未出)", flush=True)
            continue
        out.append(one(s))
    (ROOT / f"metrics-all-{TAG}.json").write_text(json.dumps(
        dict(tag=TAG, count=len(out), items=[dict(slug=r["slug"], means=r["means"]) for r in out]),
        ensure_ascii=False, indent=2))
    print(f"✓ {TAG}: {len(out)} 个模板对比完成")


if __name__ == "__main__":
    main()
