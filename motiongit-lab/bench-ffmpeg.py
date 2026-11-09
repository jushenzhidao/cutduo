#!/usr/bin/env python3
"""FFmpeg 编码基准：同一组 360 帧 JPEG -> MP4，比较耗时 / 体积 / 画质(PSNR)。

用法:
  python3 bench-ffmpeg.py --ffmpeg /opt/homebrew/bin/ffmpeg --runs 3
  python3 bench-ffmpeg.py --compare <pathA> <pathB>   # 自备两份 FFmpeg 时做 A/B 对比

基准帧由 `ffmpeg -i out/motiongit-distill.mp4 -vsync 0 -q:v 2 /tmp/ffbench/frames/f-%04d.jpg` 生成。
注意：旧版 4.4 二进制已按要求删除，历史对比数据见 MOTIONGIT-PLAYBOOK.md 第 11 节。
"""
import argparse
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

FRAMES = "/tmp/ffbench/frames/f-%04d.jpg"
OUT_DIR = Path("/tmp/ffbench/out")

CASES = [
    ("libx264 veryfast crf18", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]),
    ("libx264 medium crf18", ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]),
    ("libx264 ultrafast crf18", ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p"]),
    ("h264_videotoolbox 6M", ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-pix_fmt", "yuv420p"]),
    ("h264_videotoolbox 12M", ["-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p"]),
]


def encoders(ff):
    r = subprocess.run([ff, "-hide_banner", "-encoders"], capture_output=True, text=True)
    return r.stdout


def version(ff):
    r = subprocess.run([ff, "-hide_banner", "-version"], capture_output=True, text=True)
    return r.stdout.splitlines()[0] if r.stdout else "?"


def encode(ff, opts, out, runs):
    times = []
    for _ in range(runs):
        t = time.perf_counter()
        r = subprocess.run(
            [ff, "-hide_banner", "-loglevel", "error", "-y", "-framerate", "30", "-i", FRAMES,
             *opts, "-an", "-movflags", "+faststart", str(out)],
            capture_output=True, text=True,
        )
        times.append(time.perf_counter() - t)
        if r.returncode != 0:
            return None, None, r.stderr.strip()[-400:]
    return statistics.median(times), out.stat().st_size, None


def psnr(ff, out):
    r = subprocess.run(
        [ff, "-hide_banner", "-framerate", "30", "-i", FRAMES, "-i", str(out),
         "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.findall(r"average:([0-9.]+|inf)", r.stderr)
    return float(m[-1]) if m and m[-1] != "inf" else (float("inf") if m else None)


def run_one(ff, label, runs, skip_psnr=False):
    print(f"\n=== {label} · {version(ff)} ===")
    if not Path(FRAMES.replace("%04d", "0001")).exists():
        sys.exit(f"缺少基准帧: {FRAMES}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    avail = encoders(ff)
    results = []
    for name, opts in CASES:
        enc = opts[1]
        if enc not in avail:
            print(f"  - {name:30s} 编码器不可用，跳过")
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        out = OUT_DIR / f"{slug}-{re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')}.mp4"
        t, size, err = encode(ff, opts, out, runs)
        if err:
            print(f"  ! {name:30s} 失败: {err}")
            continue
        p = None if skip_psnr else psnr(ff, out)
        results.append((name, t, size, p))
        print(f"  {name:30s} {t:6.2f}s  {size/1024/1024:6.2f} MB"
              + (f"  PSNR {p:5.2f} dB" if isinstance(p, float) else ""))
    if results:
        best = min(results, key=lambda r: r[1])
        print(f"  -> 最快: {best[0]} ({best[1]:.2f}s)")
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", default="/opt/homebrew/bin/ffmpeg")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--label", default="ffmpeg")
    ap.add_argument("--skip-psnr", action="store_true")
    ap.add_argument("--compare", nargs=2, metavar=("OLD", "NEW"))
    a = ap.parse_args()
    if a.compare:
        run_one(a.compare[0], "old", a.runs, a.skip_psnr)
        run_one(a.compare[1], "new", a.runs, a.skip_psnr)
    else:
        run_one(a.ffmpeg, a.label, a.runs, a.skip_psnr)


if __name__ == "__main__":
    main()
