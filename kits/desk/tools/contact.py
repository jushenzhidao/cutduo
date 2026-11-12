#!/usr/bin/env python3
"""按分镜中点抽帧，拼一张全片总览图（改稿后快速看有没有遮挡/空镜）。

用法：uv run --with pillow python desktop-kit/tools/contact.py \
        --video out/desktop-uv.mp4 --params content/uv-voiced.json \
        --out out/uv-contact.jpg [--cols 3] [--cell 420]
"""
import argparse
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FFMPEG = "/opt/homebrew/bin/ffmpeg"

from PIL import Image, ImageDraw  # noqa: E402


def resolve(p):
    q = pathlib.Path(p)
    return q if q.is_absolute() else ROOT / q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--params", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--cell", type=int, default=420)
    a = ap.parse_args()

    video, params, out = resolve(a.video), resolve(a.params), resolve(a.out)
    d = json.loads(params.read_text())
    cw, ch = a.cell, int(a.cell * 3 / 4)
    label_h = 26
    with tempfile.TemporaryDirectory(prefix="desktop-contact-") as td:
        frames = []
        for i, s in enumerate(d["shots"]):
            at = (s["t0"] + s["t1"]) / 2
            f = pathlib.Path(td) / f"f{i:02d}.jpg"
            subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                            "-ss", f"{at:.3f}", "-i", str(video), "-frames:v", "1",
                            "-q:v", "2", str(f)], check=True)
            frames.append((f, s["type"], at))
        rows = (len(frames) + a.cols - 1) // a.cols
        sheet = Image.new("RGB", (a.cols * cw, rows * (ch + label_h)), (20, 22, 28))
        draw = ImageDraw.Draw(sheet)
        for i, (f, typ, at) in enumerate(frames):
            im = Image.open(f).convert("RGB").resize((cw, ch))
            x, y = (i % a.cols) * cw, (i // a.cols) * (ch + label_h)
            sheet.paste(im, (x, y))
            draw.text((x + 8, y + ch + 5), f"{i+1:02d}  {typ}  @{at:.1f}s", fill=(226, 229, 235))
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out, quality=88)
    print(f"✓ {out}  {len(frames)} 帧 / {sheet.width}x{sheet.height}")


if __name__ == "__main__":
    main()
