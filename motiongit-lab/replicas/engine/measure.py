#!/usr/bin/env python3
"""元素级自动测量：官方参考片 → spec.json（不读取模板包内任何受保护实现）。

用法：uv run --with numpy --with pillow python replicas/engine/measure.py

对每条参考片：
  · 每 1.5s 抽一帧（480×270 测量帧）
  · 逐帧量：8×6 色块网格、量化主色、水平梯度行带（文字带）、内容边界、锐度
  · 相邻帧网格差 → 镜头切点；按切点分段，每段存代表帧的元素级规格
"""
import json
import pathlib
import subprocess

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
REFJSON = ROOT / "reference.json"
FRAMES = ROOT / "frames"
SPECS = ROOT / "specs"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
INTERVAL = 1.5
GW, GH = 8, 6


def probe(path):
    out = subprocess.check_output(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
         "-of", "json", str(path)], text=True)
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return dict(width=int(s["width"]), height=int(s["height"]),
                fps=float(num) / float(den),
                frames=int(s.get("nb_frames") or 0),
                duration=float(s.get("duration") or 0))


def grid_colors(a):
    h, w, _ = a.shape
    out = []
    for gy in range(GH):
        for gx in range(GW):
            cell = a[gy*h//GH:(gy+1)*h//GH, gx*w//GW:(gx+1)*w//GW]
            out.append([int(round(v)) for v in cell.reshape(-1, 3).mean(axis=0)])
    return out


def dominant(a, k=6):
    q = (a // 32).astype(np.int32)
    keys = q[:, :, 0] * 64 + q[:, :, 1] * 8 + q[:, :, 2]
    vals, counts = np.unique(keys.reshape(-1), return_counts=True)
    order = np.argsort(-counts)[:k]
    cols = []
    for v, c in zip(vals[order], counts[order]):
        b, g, r = int(v) % 8, (int(v) // 8) % 8, int(v) // 64
        cols.append([min(255, r*32+16), min(255, g*32+16), min(255, b*32+16),
                     round(float(c) / keys.size, 4)])
    return cols


def bands_of(a):
    g = np.asarray(Image.fromarray(a.astype(np.uint8)).convert("L"), dtype=np.float32)
    gy = np.abs(np.diff(g, axis=0))[:-1, :].mean(axis=1)
    thr = max(2.0, float(gy.mean() + gy.std() * 0.8))
    mask = gy > thr
    bands, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            if i - start >= 3:
                bands.append([start, i, round(float(gy[start:i].mean()), 2)])
            start = None
    if start is not None and len(mask) - start >= 3:
        bands.append([start, len(mask), round(float(gy[start:].mean()), 2)])
    return sorted(bands, key=lambda b: -(b[1]-b[0])*b[2])[:6]


def bbox_of(a, bg):
    dev = np.abs(a - np.array(bg, dtype=np.float32)).mean(axis=2)
    mask = dev > 28
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return [0, 0, int(a.shape[1]), int(a.shape[0])]
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]


def sharpness(a):
    g = np.asarray(Image.fromarray(a.astype(np.uint8)).convert("L"), dtype=np.float32)
    return float((np.abs(np.diff(g, axis=1))[:, :-1].mean()
                  + np.abs(np.diff(g, axis=0))[:-1, :].mean()) / 2)


def measure_one(item):
    slug = item["slug"]
    src = ROOT / "reference" / f"{slug}.mp4"
    meta = probe(src)
    outdir = FRAMES / slug
    if not outdir.exists():
        outdir.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                    "-vf", f"fps=1/{INTERVAL},scale=480:270:flags=lanczos",
                    str(outdir / "%03d.png")], check=True, capture_output=True)
    files = sorted(outdir.glob("*.png"))
    samples = []
    for i, f in enumerate(files):
        a = np.asarray(Image.open(f).convert("RGB"), dtype=np.float32)
        dom = dominant(a)
        grid = grid_colors(a)
        samples.append(dict(i=i, t=round(i * INTERVAL, 3), grid=grid,
                            dominant=dom, bands=bands_of(a),
                            bbox=bbox_of(a, dom[0][:3]), sharp=round(sharpness(a), 3)))

    # 相邻采样帧网格差 → 镜头切点
    cuts, diffs = [], []
    for i in range(1, len(samples)):
        d = float(np.abs(np.array(samples[i]["grid"], dtype=np.float32)
                         - np.array(samples[i-1]["grid"], dtype=np.float32)).mean())
        diffs.append(round(d, 2))
        if d > 22:
            cuts.append(samples[i]["t"])
    # 分段：切点 + 首尾，段内取中帧作为代表
    bounds = [0.0] + cuts + [meta["duration"]]
    segments = []
    for k in range(len(bounds) - 1):
        t0, t1 = bounds[k], bounds[k+1]
        if t1 - t0 < 0.4:
            continue
        mid = (t0 + t1) / 2
        rep = min(samples, key=lambda s: abs(s["t"] - mid))
        segments.append(dict(t0=round(t0, 3), t1=round(t1, 3),
                             rep_index=rep["i"], grid=rep["grid"],
                             dominant=rep["dominant"], bands=rep["bands"],
                             bbox=rep["bbox"], sharp=rep["sharp"]))

    all_dom = {}
    for s in samples:
        for c in s["dominant"][:3]:
            key = tuple(c[:3])
            all_dom[key] = all_dom.get(key, 0) + c[3]
    palette = [list(k) for k, _ in sorted(all_dom.items(), key=lambda kv: -kv[1])[:8]]

    spec = dict(slug=slug, title=item.get("title") or slug,
                version=item["version"], templateId=item["templateId"],
                source=str(src.relative_to(ROOT)), meta=meta,
                sample_interval=INTERVAL, grid_size=[GW, GH],
                frame_count=len(files), palette=palette,
                cuts=[round(c, 3) for c in cuts], cut_diffs=diffs,
                segments=segments,
                note="元素级规格，全部由官方参考成片自动测量；不引用模板包内受保护实现/素材/字体。")
    (SPECS / f"{slug}.spec.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} {meta['width']}x{meta['height']} {meta['fps']:.0f}fps "
          f"{meta['duration']:.2f}s 采样{len(files)}帧 切点{len(cuts)} 段{len(segments)}", flush=True)
    return spec


def main():
    for p in (FRAMES, SPECS):
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)
    items = json.loads(REFJSON.read_text())["items"]
    results = []
    for it in items:
        if not (ROOT / "reference" / f"{it['slug']}.mp4").exists():
            print(f"  SKIP {it['slug']} (参考片缺失)", flush=True)
            continue
        results.append(measure_one(it))
    (SPECS / "ALL.json").write_text(json.dumps(
        [dict(slug=r["slug"], version=r["version"], meta=r["meta"],
              segments=len(r["segments"]), cuts=len(r["cuts"])) for r in results],
        ensure_ascii=False, indent=2))
    print(f"✓ {len(results)} 份 spec.json")


if __name__ == "__main__":
    main()
