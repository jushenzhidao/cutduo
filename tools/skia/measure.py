#!/usr/bin/env python3
"""从参考片里量版式：底色、墨色、强调色、文字行带、头像框、字幕条、锐度。

一条 motiongit 模板要复刻，第一步不是写代码，是把它的“版式参数”量出来。
本脚本把这件事做成可重复的一步：

  uv run --with numpy --with pillow --with scipy python skia-kit/tools/measure.py \
    --video out/ab3/tpl.mp4 --times 2.5,8.5,14.5 --names hero,point,number \
    --out out/measure/skia-kit

输出：
  <out>/<name>.jpg      抽出来的帧（q=1，便于人工复核）
  <out>/measure.json    每帧的全部度量
  stdout                Markdown 表格，可直接贴进文档
"""
import argparse
import json
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

FFMPEG = "/opt/homebrew/bin/ffmpeg"


def extract(video: str, t: float, dst: pathlib.Path) -> None:
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", video,
                    "-frames:v", "1", "-q:v", "1", str(dst)], check=True)


def load(p: pathlib.Path) -> np.ndarray:
    return np.array(Image.open(p).convert("RGB")).astype(np.int16)


def bg_color(a: np.ndarray) -> np.ndarray:
    h, w, _ = a.shape
    k = 6
    pts = np.concatenate([a[:k, :k].reshape(-1, 3), a[:k, -k:].reshape(-1, 3),
                          a[-k:, :k].reshape(-1, 3), a[-k:, -k:].reshape(-1, 3)])
    return np.median(pts, axis=0)


def sobel_mean(a: np.ndarray) -> float:
    g = a.mean(axis=2).astype(np.float32)
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = (g[:, 2:] - g[:, :-2]) / 2
    gy[1:-1, :] = (g[2:, :] - g[:-2, :]) / 2
    return float(np.sqrt(gx ** 2 + gy ** 2).mean())


def palette(a: np.ndarray, top: int = 6):
    q = (a // 8 * 8).reshape(-1, 3)
    colors, counts = np.unique(q, axis=0, return_counts=True)
    order = np.argsort(counts)[::-1][:top]
    total = q.shape[0]
    return [{"rgb": colors[i].tolist(), "pct": round(float(counts[i]) / total * 100, 2)} for i in order]


def text_bands(mask: np.ndarray, x0: int, x1: int, y0: int, y1: int, gap_y: int = 10, gap_x: int = 38,
               min_px: int = 3):
    sub = mask[y0:y1, x0:x1]
    rows = np.where(sub.sum(axis=1) >= min_px)[0]
    if not len(rows):
        return []
    bands = []
    s = prev = rows[0]
    for r in rows[1:]:
        if r - prev > gap_y:
            bands.append((s, prev)); s = r
        prev = r
    bands.append((s, prev))
    out = []
    for b0, b1 in bands:
        if b1 - b0 < 4:
            continue
        band = sub[b0:b1 + 1]
        cols = np.where(band.sum(axis=0) > 0)[0]
        segs = []
        cs = cp = cols[0]
        for c in cols[1:]:
            if c - cp > gap_x:
                segs.append((cs, cp)); cs = c
            cp = c
        segs.append((cs, cp))
        out.append({
            "y": int(b0 + y0), "h": int(b1 - b0 + 1),
            "segs": [{"x": int(s0 + x0), "w": int(s1 - s0 + 1)} for s0, s1 in segs],
        })
    return out


def largest_box(mask: np.ndarray, x0: int, x1: int, y0: int, y1: int, min_area: int = 4000):
    """最大连通块；用于头像框/字幕条。"""
    sub = np.zeros_like(mask)
    sub[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    lab, n = ndimage.label(sub)
    if n == 0:
        return None
    sizes = ndimage.sum(sub, lab, range(1, n + 1))
    i = int(np.argmax(sizes))
    if sizes[i] < min_area:
        return None
    sl = ndimage.find_objects(lab)[i]
    return {"x": int(sl[1].start), "y": int(sl[0].start),
            "w": int(sl[1].stop - sl[1].start), "h": int(sl[0].stop - sl[0].start)}


def measure_frame(a: np.ndarray, avatar_from: int = 1180, caption_from: int = 900, light_text: bool = False):
    h, w, _ = a.shape
    bg = bg_color(a)
    if light_text:
        # 深底亮字：只取比底色“更亮”的像素，避免纹理被当成文字
        mask = (a - bg).sum(axis=2) > 90
    else:
        mask = np.abs(a - bg).sum(axis=2) > 30
    # 头像卡：投影阴影会让 bbox 外扩 8–12px，用更高阈值取“实体”
    hard = ((a - bg).sum(axis=2) > 120) if light_text else (np.abs(a - bg).sum(axis=2) > 60)
    data = {
        "size": [w, h],
        "bg": [int(v) for v in bg],
        "palette": palette(a),
        "sobel": round(sobel_mean(a), 3),
        "text": text_bands(mask, 0, avatar_from, 0, caption_from),
        "avatar": largest_box(hard, avatar_from, w, 0, caption_from),
        "caption": largest_box(mask, 0, w, caption_from, h, 800),
    }
    left = a[:, :avatar_from]
    d = left.sum(axis=2)
    idx = np.dstack(np.unravel_index(np.argsort(d.ravel())[:1500], d.shape))[0]
    data["ink"] = [int(v) for v in np.median(left[idx[:, 0], idx[:, 1]], axis=0)]
    # 强调色只在版心文字区取，避开头像照片的肤色
    body = a[:caption_from, :avatar_from]
    chroma = body.max(axis=2) - body.min(axis=2)
    cm = chroma > 45
    if int(cm.sum()) > 300:
        data["accent"] = [int(v) for v in np.median(body[cm], axis=0)]
        data["accent_px"] = int(cm.sum())
    if data["text"]:
        data["textLeft"] = min(seg["x"] for b in data["text"] for seg in b["segs"])
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--times", required=True, help="逗号分隔，单位秒")
    ap.add_argument("--names", default=None, help="逗号分隔；缺省用时间戳")
    ap.add_argument("--out", required=True)
    ap.add_argument("--light-text", action="store_true", help="深底亮字模板（默认浅底深字）")
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    times = [float(x) for x in args.times.split(",")]
    names = args.names.split(",") if args.names else [f"t{t}" for t in times]
    if len(names) != len(times):
        sys.exit("--names 数量必须与 --times 一致")

    frames = []
    for t, name in zip(times, names):
        jpg = out / f"{name}.jpg"
        extract(args.video, t, jpg)
        a = load(jpg)
        m = measure_frame(a, light_text=args.light_text)
        m.update({"t": t, "name": name, "file": jpg.name})
        frames.append(m)

    top = frames[0]["palette"][0]["pct"] if frames and frames[0].get("palette") else 100
    if top < 55:
        print(f"  ⚠ 主色只占 {top}%：背景可能有纹理/渐变，行带结果需人工复核；"
              f"深底模板请加 --light-text", file=sys.stderr)

    report = {"source": args.video, "frames": frames}
    (out / "measure.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))

    print("\n| 场景 | 底色 | 墨色 | 强调色 | 文字行带 (y/h) | 头像框 | 字幕条 | 锐度 |")
    print("|---|---|---|---|---|---|---|---|")
    for f in frames:
        bands = " / ".join(f"{b['y']}/{b['h']}" for b in f["text"][:4])
        av = f["avatar"]
        avs = f"{av['x']},{av['y']} {av['w']}×{av['h']}" if av else "—"
        cap = f["caption"]
        caps = f"{cap['x']},{cap['y']} {cap['w']}×{cap['h']}" if cap else "—"
        hexc = lambda c: "#%02X%02X%02X" % tuple(c)
        print(f"| {f['name']} | {hexc(f['bg'])} | {hexc(f['ink'])} | "
              f"{hexc(f['accent']) if 'accent' in f else '—'} | {bands} | {avs} | {caps} | {f['sobel']} |")
    print(f"\n→ {out / 'measure.json'}")


if __name__ == "__main__":
    main()
