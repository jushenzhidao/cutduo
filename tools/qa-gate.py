#!/usr/bin/env python3
"""成片质量闸门：帧数、黑帧、重复帧、可选 PSNR 回归。

用法:
  python3 qa-gate.py --video out/inc-first.mp4 --expect-frames 1131
  python3 qa-gate.py --video out/new.mp4 --ref out/old.mp4
输出: PASS / WARN / FAIL + 明细
"""
import argparse
import json
import re
import subprocess
import sys

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def probe(video):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries",
         "stream=index,codec_type,codec_name,width,height,nb_frames,duration",
         "-show_entries", "format=duration,size", "-of", "json", video],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def black_segments(video):
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", video, "-vf", "blackdetect=d=0.04:pix_th=0.03",
         "-f", "null", "-"], capture_output=True, text=True).stderr
    segs = []
    for m in re.finditer(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)", r):
        segs.append(tuple(float(x) for x in m.groups()))
    return segs


def repeat_runs(video, min_run=3):
    r = subprocess.run(
        [FFMPEG, "-v", "error", "-i", video, "-f", "framemd5", "-"],
        capture_output=True, text=True).stdout
    rows = []
    for line in r.splitlines():
        if line.startswith("#"):
            continue
        p = line.split(", ")
        if len(p) >= 6:
            rows.append((int(p[1]), p[-1]))
    runs, cur = [], [rows[0]] if rows else []
    for i in range(1, len(rows)):
        if rows[i][1] == rows[i - 1][1]:
            cur.append(rows[i])
        else:
            if len(cur) >= min_run:
                runs.append((cur[0][0], cur[-1][0], len(cur)))
            cur = [rows[i]]
    if len(cur) >= min_run:
        runs.append((cur[0][0], cur[-1][0], len(cur)))
    return runs


def psnr(video, ref):
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", video, "-i", ref,
         "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    m = re.search(r"average:([\d.]+) min:([\d.]+)", r)
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--expect-frames", type=int)
    ap.add_argument("--ref")
    ap.add_argument("--min-psnr", type=float, default=40.0)
    a = ap.parse_args()

    info = probe(a.video)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    aud = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if not v:
        print("FAIL 没有视频流")
        sys.exit(1)
    frames = int(v.get("nb_frames") or 0)
    dur = float(v.get("duration") or 0)
    fmt_dur = float(info["format"]["duration"])
    size = int(info["format"]["size"]) / 1048576
    print(f"video: {v['width']}×{v['height']} {v.get('codec_name')} {frames} 帧 {dur:.3f}s")
    print(f"audio: {aud.get('codec_name') if aud else '无'} "
          f"{float(aud.get('duration', 0)):.3f}s" if aud else "audio: 无")
    print(f"容器: {fmt_dur:.3f}s / {size:.2f} MB")

    fails, warns = [], []
    if a.expect_frames and abs(frames - a.expect_frames) > 1:
        fails.append(f"帧数 {frames} != 期望 {a.expect_frames}")
    if abs(fmt_dur - dur) > 0.08:
        warns.append(f"容器时长 {fmt_dur:.3f}s 与视频 {dur:.3f}s 差 {abs(fmt_dur-dur):.3f}s")
    if not aud:
        warns.append("无音频流")

    blacks = black_segments(a.video)
    print(f"黑帧段: {len(blacks)}" + ("" if not blacks else " -> " +
          ", ".join(f"{s:.2f}-{e:.2f}s({d:.2f}s)" for s, e, d in blacks)))
    # 深色场景会误报，只把片头/片中超过 0.6s 的黑段标为可疑
    for s, e, d in blacks:
        if d > 0.6 and s > 0.5 and e < dur - 0.8:
            warns.append(f"可疑长黑帧 {s:.2f}-{e:.2f}s（{d:.2f}s）")

    runs = repeat_runs(a.video)
    print(f"连续≥3帧相同: {len(runs)} 段" + ("" if not runs else " -> " +
          ", ".join(f"{a0/24:.2f}s×{n}" for a0, b0, n in runs[:6])))
    for a0, b0, n in runs:
        if n >= 12 and a0 > 12:  # 开场静态除外
            warns.append(f"中段连续重复 {n} 帧（{a0/24:.2f}s）")

    if a.ref:
        avg, mn = psnr(a.video, a.ref)
        print(f"PSNR vs ref: avg {avg:.2f}dB / min {mn:.2f}dB")
        if avg is not None and avg < a.min_psnr:
            fails.append(f"PSNR 回归：avg {avg:.2f} < {a.min_psnr}")

    print()
    for w in warns:
        print("WARN", w)
    for f in fails:
        print("FAIL", f)
    if fails:
        print("RESULT: FAIL")
        sys.exit(2)
    if warns:
        print("RESULT: WARN")
    else:
        print("RESULT: PASS")


if __name__ == "__main__":
    main()
