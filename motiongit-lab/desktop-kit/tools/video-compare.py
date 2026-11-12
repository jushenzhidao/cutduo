#!/usr/bin/env python3
"""官方 demo ↔ desktop-kit 复刻：逐镜头视频并排对比 + 同编码条件的像素指标。

用法：
  uv run --with numpy --with pillow python desktop-kit/tools/video-compare.py

产出（全部在 out/ 下）：
  desktop-vcompare/pair-00.mp4 … pair-07.mp4   8 组镜头并排片段（左官方 / 右复刻）
  desktop-compare-video.mp4                     8 段拼接的汇总视频
  desktop-vcompare/labels/*.png                 每组标签条
  desktop-vcompare/mid/*.png                    用于量化的无损中帧
  desktop-video-compare.json                    逐组指标（脚本实算，无硬编码）
"""
import json
import math
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEMO = ROOT / "ref" / "mac-desktop" / "demo.mp4"
OURS = ROOT / "out" / "desktop.mp4"
PARAMS = ROOT / "desktop-kit" / "presets" / "demo-voiced.json"
OUT = ROOT / "out" / "desktop-vcompare"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
DUR = 2.5                      # 每组片段时长（秒）
FPS = 60
HALF_W, HALF_H = 720, 540     # 每侧画幅（原 1440×1080 对半）
LABEL_H = 60

PAIRS = [
    (0,   "title",     "出发屏 / 翻牌大标题"),
    (32,  "comments",  "评论卡片瀑布"),
    (56,  "talk",      "蓝色壁纸 + 白窗口 + 桌面骨架"),
    (104, "rating",    "白窗口评估 + 翻牌评价"),
    (120, "flipBoard", "深色翻牌屏"),
    (152, "chart",     "白窗口折线图"),
    (176, "ranking",   "排名翻牌换位"),
    (224, "outro",     "结尾票券窗口"),
]

# 与文案内容无关的固定采样点（菜单栏 / 壁纸四角 / 桌面图标列 / Dock），用于系统配色比色
SAMPLES = {
    "menuBar":   (700, 13),
    "wallLeft":  (70, 520),
    "wallTop":   (700, 80),
    "wallRight": (1380, 520),
    "wallLowL":  (110, 900),
    "wallLowR":  (1300, 900),
    "dock":      (500, 1030),
}
BOX_WALL = (1330, 620, 1430, 920)
BOX_TEXT = (300, 900, 1140, 995)


def run(args):
    subprocess.run(args, check=True, capture_output=True)


def sharpness(arr, box=None):
    a = np.asarray(Image.fromarray(arr).convert("L"), dtype=np.float32)
    if box:
        x0, y0, x1, y1 = box
        a = a[y0:y1, x0:x1]
    gx = np.abs(np.diff(a, axis=1))[:, :-1]
    gy = np.abs(np.diff(a, axis=0))[:-1, :]
    return float((gx.mean() + gy.mean()) / 2)


def rgb(path_png):
    return np.asarray(Image.open(path_png).convert("RGB"), dtype=np.float32)


def patch(a, x, y, r=6):
    return a[max(0, y-r):y+r, max(0, x-r):x+r].reshape(-1, 3).mean(axis=0)


def make_label(path, idx, label, ref_t, our_t, metrics):
    im = Image.new("RGB", (HALF_W * 2, LABEL_H), (16, 18, 23))
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 22)
        fs = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 15)
    except OSError:
        f = fs = ImageFont.load_default()
    d.text((18, 14), f"{idx:02d}", font=f, fill=(245, 179, 33))
    d.text((66, 16), label, font=f, fill=(233, 235, 239))
    d.text((HALF_W + 18, 20), f"官方 demo  t={ref_t}s", font=fs, fill=(154, 162, 175))
    d.text((HALF_W + 300, 20), f"desktop-kit  t={our_t:.2f}s", font=fs, fill=(154, 162, 175))
    d.text((HALF_W + 560, 20), f"色差 {metrics:.1f}", font=fs, fill=(154, 206, 106))
    d.line([(HALF_W, 0), (HALF_W, LABEL_H)], fill=(80, 88, 100), width=2)
    d.line([(0, LABEL_H-1), (HALF_W*2, LABEL_H-1)], fill=(42, 47, 56), width=1)
    im.save(path)


def main():
    for p in (OUT, OUT / "labels", OUT / "mid"):
        if not p.exists():          # 宿主 shim 对已存在目录的 mkdir(exist_ok=True) 会抛 EEXIST
            p.mkdir(parents=True, exist_ok=True)
    d = json.loads(PARAMS.read_text())
    shots = {s["type"]: s for s in d["shots"]}
    rows, concat_lines = [], []

    for i, (ref_t, typ, label) in enumerate(PAIRS):
        s = shots[typ]
        at = (s["t0"] + s["t1"]) / 2
        our_start = max(0.0, at - DUR / 2)
        ref_clip = OUT / f"clip-ref-{i:02d}.mp4"
        our_clip = OUT / f"clip-our-{i:02d}.mp4"
        common = ["-an", "-vf", f"fps={FPS},scale={HALF_W}:{HALF_H}:flags=lanczos,setsar=1",
                  "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                  "-r", str(FPS), "-y"]
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{ref_t}", "-t", f"{DUR}",
             "-i", str(DEMO), *common, str(ref_clip)])
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{our_start:.3f}", "-t", f"{DUR}",
             "-i", str(OURS), *common, str(our_clip)])

        # 指标帧：精确时间点 + 原始 1440×1080 无损 PNG。
        # 不从 2.5s 片段中帧取——片段中帧可能落在镜头切换处，造成配对错配；
        # 两侧同为无损 PNG，也消除了源片码率 / JPEG 压缩对锐度的污染。
        mid_ref = OUT / "mid" / f"ref-{i:02d}.png"
        mid_our = OUT / "mid" / f"our-{i:02d}.png"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{ref_t}",
             "-i", str(DEMO), "-frames:v", "1", "-y", str(mid_ref)])
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{at:.3f}",
             "-i", str(OURS), "-frames:v", "1", "-y", str(mid_our)])

        a_ref, a_our = rgb(mid_ref), rgb(mid_our)
        b_ref = np.asarray(a_ref, dtype=np.float32)
        b_our = np.asarray(a_our, dtype=np.float32)
        diffs = []
        for name, (x, y) in SAMPLES.items():
            pr, po = patch(b_ref, x, y), patch(b_our, x, y)
            diffs.append(float(np.abs(pr - po).mean()))
        color = sum(diffs) / len(diffs)
        rs, os_ = sharpness(b_ref.astype(np.uint8)), sharpness(b_our.astype(np.uint8))
        rw, ow = sharpness(b_ref.astype(np.uint8), BOX_WALL), sharpness(b_our.astype(np.uint8), BOX_WALL)
        rt, ot = sharpness(b_ref.astype(np.uint8), BOX_TEXT), sharpness(b_our.astype(np.uint8), BOX_TEXT)
        mad = float(np.abs(b_ref - b_our).mean())

        lab = OUT / "labels" / f"label-{i:02d}.png"
        make_label(lab, i + 1, label, ref_t, at, color)
        pair = OUT / f"pair-{i:02d}.mp4"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(ref_clip), "-i", str(our_clip),
             "-loop", "1", "-i", str(lab),
             "-filter_complex",
             f"[0:v][1:v]hstack=inputs=2[hs];[hs]pad={HALF_W*2}:{HALF_H+LABEL_H}:0:{LABEL_H}:black[pd];"
             f"[pd][2:v]overlay=0:0:shortest=1[v]",
             "-map", "[v]", "-t", f"{DUR}", "-r", str(FPS),
             "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
             "-y", str(pair)])
        concat_lines.append(f"file '{pair}'")
        rows.append(dict(i=i + 1, typ=typ, label=label, ref_t=ref_t, our_t=round(at, 3),
                         our_start=round(our_start, 3), color_diff=round(color, 2),
                         sample_diffs={k: round(v, 1) for k, v in zip(SAMPLES, diffs)},
                         sharp_all=(round(rs, 3), round(os_, 3), round(os_/max(rs, 1e-6), 3)),
                         sharp_wall=(round(rw, 3), round(ow, 3), round(ow/max(rw, 1e-6), 3)),
                         sharp_text=(round(rt, 3), round(ot, 3), round(ot/max(rt, 1e-6), 3)),
                         mad=round(mad, 2), pair=str(pair.relative_to(ROOT))))
        print(f"  {i+1:02d} {typ:<10} 色差 {color:5.1f}  锐度 all {os_/max(rs,1e-6):.2f} "
              f"wall {ow/max(rw,1e-6):.2f} text {ot/max(rt,1e-6):.2f}  MAD {mad:.1f}", flush=True)

    concat = OUT / "concat.txt"
    concat.write_text("\n".join(concat_lines) + "\n")
    summary = ROOT / "out" / "desktop-compare-video.mp4"
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(concat), "-c", "copy", "-y", str(summary)])

    means = dict(
        color=round(sum(r["color_diff"] for r in rows) / len(rows), 2),
        sharp_all=round(sum(r["sharp_all"][2] for r in rows) / len(rows), 3),
        sharp_wall=round(sum(r["sharp_wall"][2] for r in rows) / len(rows), 3),
        sharp_text=round(sum(r["sharp_text"][2] for r in rows) / len(rows), 3),
        mad=round(sum(r["mad"] for r in rows) / len(rows), 2),
    )
    report = dict(method="官方 demo 与复刻成片按镜头时间窗裁 2.5s 同画幅片段做并排视频；指标另取精确时间点的原始 1440×1080 无损 PNG 计算，两侧编码条件一致，避免片段中帧错配与源片码率/JPEG 差异污染锐度。",
                  pair_count=len(rows), duration_each=DUR, fps=FPS,
                  caveat="文案、镜头内容与人物不同，锐度/MAD 含内容差异；固定采样点色差亦受镜头组件不同影响，只有字幕字号/字重/描边与骨架几何属可修的系统性偏差。",
                  means=means, rows=rows,
                  summary_video=str(summary.relative_to(ROOT)))
    (ROOT / "out" / "desktop-video-compare.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"✓ {summary}  ({DUR*len(rows):.1f}s)")
    print("平均:", means)


if __name__ == "__main__":
    main()
