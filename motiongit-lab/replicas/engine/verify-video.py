#!/usr/bin/env python3
"""对抗审查：验证每条对比视频的左右两半确实分别是官方原片与复刻成片。

为什么需要：对比视频由 8 段 hstack 拼接 + concat 而成。若输入顺序搞反、
片段时间点错位或 concat 顺序错乱，肉眼看到的仍是「两条并排画面」，
但对比结论全部失效。本脚本从成片抽帧，与两侧源片在同一原片时间点
抽出的帧做 MAD 比对，给出可复现的证据。

用法：uv run --with numpy --with pillow python replicas/engine/verify-video.py
"""
import json
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
FFMPEG = "/opt/homebrew/bin/ffmpeg"
SIDE_W, SIDE_H, LABEL_H, DUR, FPS = 640, 360, 60, 2.0, 60

# 默认校验 v1 的 compare.mp4 / replica-fixed.mp4；--v2 切到 v2 产物。
V2 = "--v2" in sys.argv[1:]
CMP_NAME = "compare-v2.mp4" if V2 else "compare.mp4"
REP_NAME = "replica-v2.mp4" if V2 else "replica-fixed.mp4"
OUT_NAME = "video-integrity-v2.json" if V2 else "video-integrity.json"


def run(args):
    subprocess.run(args, check=True, capture_output=True)


def grab(path, args, box=None, resize=None):
    run([FFMPEG, "-hide_banner", "-loglevel", "error", *args,
         "-frames:v", "1", "-y", str(path)])
    im = Image.open(path).convert("RGB")
    if box:
        im = im.crop(box)
    if resize:
        im = im.resize(resize, Image.LANCZOS)
    return np.asarray(im, dtype=np.float32)


def mad(a, b):
    return float(np.abs(a - b).mean())


def probe(path):
    out = subprocess.run(["/opt/homebrew/bin/ffprobe", "-v", "error",
                          "-show_entries", "format=duration",
                          "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    st = j["streams"][0]
    return dict(w=st["width"], h=st["height"], fps=st["r_frame_rate"],
                n=int(st["nb_frames"]), dur=float(j["format"]["duration"]))


def one(slug):
    spec = json.loads((ROOT / "specs" / f"{slug}.spec.json").read_text())
    duration = spec["meta"]["duration"]
    ref = ROOT / "reference" / f"{slug}.mp4"
    rep = ROOT / "out" / slug / REP_NAME
    cmp = ROOT / "out" / slug / CMP_NAME
    meta = probe(cmp)
    shape_ok = (meta["w"], meta["h"], meta["n"], meta["fps"]) == (1280, 420, 960, "60/1")
    rows = []
    tag = slug.replace('motiongit-promo-', '')
    for i in range(8):
        t = duration * (i + 0.5) / 8
        start = max(0.0, min(duration - DUR, t - DUR / 2))
        source_t = start + DUR / 2          # 原片时间点
        concat_t = i * DUR + DUR / 2        # 拼接视频时间点（关键映射）
        cf = grab(f"/tmp/mgv-{tag}-cmp.png", ["-ss", f"{concat_t:.3f}", "-i", str(cmp)])
        L = np.asarray(Image.fromarray(cf.astype(np.uint8)).crop(
            (0, LABEL_H, SIDE_W, LABEL_H + SIDE_H)), dtype=np.float32)
        R = np.asarray(Image.fromarray(cf.astype(np.uint8)).crop(
            (SIDE_W, LABEL_H, SIDE_W * 2, LABEL_H + SIDE_H)), dtype=np.float32)
        vf = f"scale={SIDE_W}:{SIDE_H}:flags=lanczos"
        A = grab(f"/tmp/mgv-{tag}-ref.png", ["-ss", f"{source_t:.3f}", "-i", str(ref), "-vf", vf])
        B = grab(f"/tmp/mgv-{tag}-our.png", ["-ss", f"{source_t:.3f}", "-i", str(rep), "-vf", vf])
        d = dict(left_vs_official=mad(L, A), left_vs_replica=mad(L, B),
                 right_vs_official=mad(R, A), right_vs_replica=mad(R, B))
        # 左右各自更接近预期来源，且留有 10% 裕度（容忍 H.264 编码噪声）
        ok = (d["left_vs_official"] * 1.1 < d["left_vs_replica"]
              and d["right_vs_replica"] * 1.1 < d["right_vs_official"])
        rows.append(dict(group=i + 1, source_t=round(source_t, 3), concat_t=round(concat_t, 3),
                         **{k: round(v, 2) for k, v in d.items()}, verdict="PASS" if ok else "FAIL"))
    passed = sum(r["verdict"] == "PASS" for r in rows)
    return dict(slug=slug, compare_video=str(cmp.relative_to(ROOT)),
                container=meta, shape_ok=shape_ok, pass_groups=passed, total_groups=len(rows),
                verdict="PASS" if shape_ok and passed == len(rows) else "FAIL", rows=rows)


def main():
    slugs = sorted(p.stem.replace('.spec', '') for p in (ROOT / "specs").glob("*.spec.json"))
    items = [one(s) for s in slugs]
    for r in items:
        print(f"  {r['slug']:<28} 容器 {r['container']['w']}x{r['container']['h']} "
              f"{r['container']['n']}帧 {r['container']['dur']}s  "
              f"左右对应 {r['pass_groups']}/{r['total_groups']}  {r['verdict']}", flush=True)
    ok = sum(r["verdict"] == "PASS" for r in items)
    out = dict(variant="v2" if V2 else "v1",
               compare_name=CMP_NAME, replica_name=REP_NAME,
               method="从每条对比成片按拼接时间点抽帧，裁出左右画面；与两源片在对应原片时间点抽帧缩放后算 MAD。"
                      "判定：左更接近官方、右更接近复刻，且各有 10% 裕度。",
               note="compare.mp4 是 8×2s 拼接（16s），不可直接用原片时间点 seek；映射 concat_t=8i+1。",
               pass_count=ok, total=len(items), items=items)
    (ROOT / OUT_NAME).write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"✓ 视频完整性 {ok}/{len(items)} PASS")


if __name__ == "__main__":
    main()
