#!/usr/bin/env python3
"""把一份 MotionGit 模板实例按时间窗口切成独立分片，供并行渲染。

每个分片是一个完整实例：segments/captions/narrationMap 全部裁剪并左移到 0 起点，
音轨用 ffmpeg 精确切段，duration 改为窗口长度。

用法：
  python3 shard-tpl.py --instance <inst> --window 0,23.02 --out /tmp/shard0
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys

FFMPEG = "/opt/homebrew/bin/ffmpeg"


def clip_len(t0, t1, a, b):
    return max(0.0, min(t1, b) - max(t0, a))


def srt_ts(sec):
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True)
    ap.add_argument("--window", required=True, help="start,end（秒）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    a, b = [float(x) for x in args.window.split(",")]
    src = pathlib.Path(args.instance)
    dst = pathlib.Path(args.out)
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=True)

    for junk in ("plan", "project", "video.mp4", "video-v2.mp4"):
        p = dst / junk
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()

    params = json.loads((dst / "params.json").read_text())
    tl = params["timeline"]

    segs, caps, nmap = [], [], []
    for seg in tl["segments"]:
        if clip_len(seg["t0"], seg["t1"], a, b) < 0.3:
            continue
        seg = dict(seg)
        seg["t0"] = round(max(seg["t0"], a) - a, 3)
        seg["t1"] = round(min(seg["t1"], b) - a, 3)
        segs.append(seg)

    for c in tl.get("captions", []):
        if clip_len(c["s"], c["e"], a, b) < 0.15:
            continue
        caps.append({
            "s": round(max(c["s"], a) - a, 3),
            "e": round(min(c["e"], b) - a, 3),
            "text": c["text"],
        })

    for m in tl.get("narrationMap", []):
        if clip_len(m["start"], m["end"], a, b) < 0.15:
            continue
        m = dict(m)
        m["start"] = round(max(m["start"], a) - a, 3)
        m["end"] = round(min(m["end"], b) - a, 3)
        m["subtitleId"] = len(nmap) + 1
        nmap.append(m)

    tl["segments"] = segs
    tl["captions"] = caps
    if "narrationMap" in tl:
        tl["narrationMap"] = nmap
    tl["duration"] = round(b - a, 3)

    # 音轨切段
    src_audio = dst / "inputs" / "voiceover.m4a"
    out_audio = dst / "inputs" / f"voiceover-{int(a*1000)}.wav"
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(src_audio),
                    "-af", f"atrim=start={a}:end={b},asetpts=PTS-STARTPTS",
                    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
                    str(out_audio)], check=True)
    tl["voiceover"] = out_audio.name

    # 字幕文件同步切段
    srt = []
    for i, c in enumerate(caps, 1):
        srt += [str(i), f"{srt_ts(c['s'])} --> {srt_ts(c['e'])}", c["text"], ""]
    (dst / "inputs" / "captions.srt").write_text("\n".join(srt), encoding="utf-8")
    tl["subtitles"] = "captions.srt"

    (dst / "params.json").write_text(json.dumps(params, ensure_ascii=False, indent=2))

    dur = round(b - a, 3)
    print(json.dumps({
        "window": [a, b], "duration": dur, "segments": len(segs),
        "captions": len(caps), "narrationMap": len(nmap),
        "first_seg": [segs[0]["t0"], segs[0]["t1"]] if segs else None,
        "last_seg": [segs[-1]["t0"], segs[-1]["t1"]] if segs else None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
