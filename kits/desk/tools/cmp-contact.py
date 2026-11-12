#!/usr/bin/env python3
"""
对比片的同帧总览：同一时间点 × 五条管线，逐行排开。

为什么不用缩略图拼完就算完：缩略图会掩盖文字与纹理差异，所以每格保留原始像素
（只做等比例缩小，不重采样到不同比例），并同时输出全尺寸单帧供放大核对。
"""
import json
import pathlib
import subprocess

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "out"
FF = "/opt/homebrew/bin/ffmpeg"

ORDER = [("a", "A · Skia 壁纸 + JPEG 管道（现状）"),
         ("b", "B · Skia 壁纸 + RAW 管道"),
         ("c", "C · GPU 流体壁纸 + JPEG 管道"),
         ("d", "D · JS 流体壁纸 + JPEG 管道"),
         ("e", "E · GPU 壁纸 + RAW 管道（综合）")]

TIMES = [(2.0, "title · 蓝壁纸"), (8.6, "flipBoard · 橙壁纸"), (15.6, "chart · 浅壁纸")]


def grab(video, t, dst):
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-ss", str(t),
                    "-i", str(video), "-frames:v", "1", str(dst)], check=True)


def main():
    q = json.loads((OUT / "cmp-quality.json").read_text())
    cell_dir = OUT / "cmp-frames"
    cell_dir.mkdir(exist_ok=True)
    W, H = 512, 384
    sheet = Image.new("RGB", (W * len(TIMES) + 170, (H + 26) * len(ORDER) + 40), (18, 19, 23))
    d = ImageDraw.Draw(sheet)
    d.text((12, 10), "desktop-kit · 同一条片 1419 帧 / 23.65s / 1440×1080@60 · 只换管线", fill=(226, 228, 234))
    for c, (t, label) in enumerate(TIMES):
        d.text((170 + c * W + 8, 26), f"{t}s  {label}", fill=(150, 156, 168))
    for r, (k, label) in enumerate(ORDER):
        y = 40 + r * (H + 26)
        d.text((12, y + H // 2 - 6), k.upper(), fill=(245, 179, 33))
        d.text((12, y + H // 2 + 10), f"{q['variants'][k]['sizeMB']}MB", fill=(150, 156, 168))
        for c, (t, _) in enumerate(TIMES):
            p = cell_dir / f"{k}-{int(t * 10)}.jpg"
            if not p.exists():
                grab(OUT / f"cmp-{k}.mp4", t, p)
            im = Image.open(p).convert("RGB")
            im = im.resize((W, H), Image.LANCZOS)
            sheet.paste(im, (170 + c * W, y))
            d.rectangle([170 + c * W, y, 170 + c * W + W - 1, y + H - 1], outline=(52, 55, 63))
            d.text((170 + c * W + 8, y + H + 6), label[:48], fill=(120, 126, 138))
    sheet.save(OUT / "cmp-contact.jpg", quality=90)
    print("sheet", sheet.size)


if __name__ == "__main__":
    main()
