#!/usr/bin/env python3
"""v2 成片的视频一一对比：与 compare.py 完全相同的口径，只换复刻片与输出目录。

保留 v1 的全部产物不动；v2 输出到 vcompare2/ 与 compare-v2.mp4，便于并列审查。
用法：uv run --with numpy --with pillow python replicas/engine/compare2.py
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import compare as C   # 复用同一套 label / grid / sharp / patch，保证口径一致

ROOT = pathlib.Path(__file__).resolve().parents[1]
FFMPEG = C.FFMPEG
DUR, FPS = C.DUR, C.FPS


def one(slug):
    ref = ROOT / "reference" / f"{slug}.mp4"
    rep = ROOT / "out" / slug / "replica-v2.mp4"
    spec = json.loads((ROOT / "specs" / f"{slug}.spec.json").read_text())
    duration = spec["meta"]["duration"]
    outdir = ROOT / "out" / slug / "vcompare2"
    for p in (outdir, outdir / "mid", outdir / "labels"):
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)
    ts = [duration * (i + 0.5) / 8 for i in range(8)]
    rows, lines = [], []
    for i, t in enumerate(ts):
        start = max(0.0, min(duration - DUR, t - DUR / 2))
        cr, co = outdir / f"clip-ref-{i:02d}.mp4", outdir / f"clip-our-{i:02d}.mp4"
        common = ["-an", "-vf", f"fps={FPS},scale={C.SIDE_W}:{C.SIDE_H}:flags=lanczos,setsar=1",
                  "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                  "-r", str(FPS), "-y"]
        C.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", str(DUR),
               "-i", str(ref), *common, str(cr)])
        C.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", str(DUR),
               "-i", str(rep), *common, str(co)])
        mr, mo = outdir / "mid" / f"ref-{i:02d}.png", outdir / "mid" / f"our-{i:02d}.png"
        C.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}",
               "-i", str(ref), "-frames:v", "1", "-y", str(mr)])
        C.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}",
               "-i", str(rep), "-frames:v", "1", "-y", str(mo)])
        a = np.asarray(Image.open(mr).convert("RGB"), dtype=np.float32)
        b = np.asarray(Image.open(mo).convert("RGB"), dtype=np.float32)
        gr, go = C.grid(a), C.grid(b)
        gd = float(np.abs(gr - go).mean())
        pd = float(np.mean([np.abs(C.patch(a, *xy) - C.patch(b, *xy)).mean()
                            for xy in C.SAMPLES.values()]))
        sr, so = C.sharp(a), C.sharp(b)
        ratio = so / max(sr, 1e-6)
        mad = float(np.abs(a - b).mean())
        lab = outdir / "labels" / f"label-{i:02d}.png"
        C.label(lab, slug, i + 1, t, gd, ratio)
        pair = outdir / f"pair-{i:02d}.mp4"
        C.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(cr), "-i", str(co),
               "-loop", "1", "-i", str(lab), "-filter_complex",
               f"[0:v][1:v]hstack=inputs=2[hs];[hs]pad={C.SIDE_W*2}:{C.SIDE_H+C.LABEL_H}:0:{C.LABEL_H}:black[pd];"
               f"[pd][2:v]overlay=0:0:shortest=1[v]", "-map", "[v]", "-t", str(DUR), "-r", str(FPS),
               "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
               "-y", str(pair)])
        lines.append(f"file '{pair}'")
        rows.append(dict(i=i + 1, t=round(t, 3), grid_diff=round(gd, 2),
                         point_diff=round(pd, 2), sharp_ref=round(sr, 3),
                         sharp_our=round(so, 3), sharp_ratio=round(ratio, 3),
                         mad=round(mad, 2)))
    (outdir / "concat.txt").write_text("\n".join(lines) + "\n")
    summary = ROOT / "out" / slug / "compare-v2.mp4"
    C.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
           "-i", str(outdir / "concat.txt"), "-c", "copy", "-y", str(summary)])
    means = {k: round(sum(r[k] for r in rows) / len(rows), 3)
             for k in ("grid_diff", "point_diff", "sharp_ratio", "mad")}
    report = dict(tag="v2", slug=slug, reference=str(ref.relative_to(ROOT)),
                  replica=str(rep.relative_to(ROOT)), duration=round(duration, 3),
                  method="与 compare.py 同口径：8 个均匀时间点各裁 2.0s 并排；指标帧为两侧精确时间点无损 PNG。",
                  means=means, rows=rows, compare_video=str(summary.relative_to(ROOT)))
    (ROOT / "out" / slug / "metrics-v2.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 网格 {means['grid_diff']:6.2f}  固定点 {means['point_diff']:6.2f}  "
          f"MAD {means['mad']:6.2f}  锐度比 {means['sharp_ratio']:5.3f}", flush=True)
    return report


def main():
    slugs = sorted(p.stem.replace('.spec', '') for p in (ROOT / "specs").glob("*.spec.json"))
    out = [one(s) for s in slugs if (ROOT / "out" / s / "replica-v2.mp4").exists()]
    (ROOT / "metrics-all-v2.json").write_text(json.dumps(
        dict(tag="v2", count=len(out),
             items=[dict(slug=r["slug"], means=r["means"]) for r in out]),
        ensure_ascii=False, indent=2))
    print(f"✓ v2 对比完成 {len(out)} 个模板")


if __name__ == "__main__":
    main()
