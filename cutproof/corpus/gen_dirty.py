#!/usr/bin/env python3
"""
20 条脏素材语料工厂 + 自校验。

每一条都对应一个真实世界里会让你半夜爬起来的事故模式，而不是随机脏数据。
生成完之后立刻 ffprobe 自检：**如果探测不到预期的故障特征，这条语料就是无效的**
（说明它没复现出那个事故），会标 INAPECT 并退出非零。

用法：
    python3 corpus/gen_dirty.py            # 生成 + 自检
    python3 corpus/gen_dirty.py --verify   # 只自检已有语料
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
MANIFEST = HERE / "manifest.json"


def run(argv: list[str], timeout: int = 300) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stderr or "")[-1200:]
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def probe(path: Path) -> dict:
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True)
    try:
        return json.loads(p.stdout)
    except Exception:
        return {}


def v(path: Path) -> dict:
    d = probe(path)
    return next((s for s in d.get("streams", []) if s["codec_type"] == "video"), {})


def a(path: Path) -> dict:
    d = probe(path)
    return next((s for s in d.get("streams", []) if s["codec_type"] == "audio"), {})


# ─────────────────────────────────────────────────────────── 期望：真正复现了才算数
def exp_hdr(p):
    s = v(p)
    return s.get("color_transfer") in ("arib-std-b67", "smpte2084") or \
           s.get("color_primaries") == "bt2020"


def exp_vfr(p):
    s = v(p)
    try:
        r = eval(s["r_frame_rate"], {"__builtins__": {}}) if "/" in s["r_frame_rate"] else 0
        a_ = eval(s["avg_frame_rate"], {"__builtins__": {}}) if "/" in s["avg_frame_rate"] else 0
    except Exception:
        return False
    return r and a_ and abs(r - a_) > 0.5


def exp_rotation(p):
    s = v(p)
    rot = s.get("side_data_list") or []
    return any("rotation" in sd for sd in rot) or abs(float(s.get("tags", {}).get("rotate", 0) or 0)) > 0


def exp_depth10(p):
    return v(p).get("pix_fmt") in ("yuv420p10le", "yuv422p10le", "yuv444p10le")


def exp_no_audio(p):
    d = probe(p)
    return not any(s["codec_type"] == "audio" for s in d.get("streams", []))


def exp_mono441(p):
    s = a(p)
    return s.get("channels") == 1 and s.get("sample_rate") == "44100"


def exp_51(p):
    return (a(p).get("channels") or 0) >= 6


def exp_empty(p):
    return p.stat().st_size == 0


def exp_truncated(p):
    """容器头在、mdat 被截断：能开、能解一部分、读到一半报错。"""
    rc, err = run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "null", "-"])
    return rc != 0 or "error" in err.lower() or "partial" in err.lower()


def exp_long(p):
    return float(probe(p).get("format", {}).get("duration", 0) or 0) > 300


def exp_pillarbox(p):
    """竖屏内容塞进横屏画布，左右有黑边。"""
    rc, err = run(["ffmpeg", "-v", "info", "-i", str(p),
                   "-vf", "cropdetect=limit=0.1:round=2:reset=0", "-frames:v", "90",
                   "-f", "null", "-"])
    return "crop=" in err


def exp_lowfps(p):
    return eval(v(p)["r_frame_rate"], {"__builtins__": {}}) <= 10


def exp_highfps(p):
    return eval(v(p)["r_frame_rate"], {"__builtins__": {}}) >= 100


def exp_anamorphic(p):
    s = v(p)
    return s.get("sample_aspect_ratio") not in (None, "1:1", "0:1")


def exp_interlaced(p):
    return (v(p).get("field_order") or "progressive") not in ("progressive", "unknown")


def exp_legacy(p):
    d = probe(p)
    return d.get("format", {}).get("format_name") == "avi" and \
           v(p).get("codec_name") in ("mpeg4", "msmpeg4v3", "h263")


def exp_subs(p):
    return any(s["codec_type"] == "subtitle" for s in probe(p).get("streams", []))


def exp_multiaudio(p):
    return len([s for s in probe(p).get("streams", []) if s["codec_type"] == "audio"]) >= 2


def exp_audioonly(p):
    d = probe(p)
    return not any(s["codec_type"] == "video" for s in d.get("streams", []))


def exp_odd(p):
    s = v(p)
    return s["width"] % 2 == 1 or s["height"] % 2 == 1


def exp_clean(p):
    s = v(p)
    return (s.get("codec_name") == "h264" and s.get("pix_fmt") == "yuv420p"
            and s.get("sample_aspect_ratio") == "1:1"
            and (s.get("field_order") or "progressive") == "progressive"
            and a(p).get("sample_rate") == "48000")


SPECS = [
    # ── 基线 ──
    ("c00_clean", "干净的对照组：H.264 / yuv420p / 48k 立体声 / 色彩标记完整", exp_clean,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-color_range", "tv",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", "{out}"]),

    # ── 色彩 ──
    ("c01_hlg_hdr", "iPhone 拍的 HLG HDR：bt2020 / 10bit / HLG 传输函数",
     exp_hdr,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=4",
      "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast",
      "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67"
                     ":colormatrix=bt2020nc:range=limited",
      "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
      "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
      "-colorspace", "bt2020nc", "-color_range", "tv", "{out}"]),

    ("c04_hevc10_untagged", "10bit HEVC 且无色彩标记：色彩解释完全靠猜",
     exp_depth10,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4",
      "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast",
      "-x265-params", "log-level=error", "-pix_fmt", "yuv420p10le", "{out}"]),

    # ── 时序 ──
    ("c02_vfr_gap", "VFR：时间戳断档 5 帧（导出后音画不同步的元凶）",
     exp_vfr,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6",
      "-vf", "select='not(between(n,90,94))'", "-fps_mode", "vfr",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "{out}"]),

    ("c13_120fps", "120fps 高帧率：时间线是 30fps，直接丢帧会抖",
     exp_highfps,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=120:d=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "{out}"]),

    ("c15_interlaced_ts", "1080i 隔行 MPEG-TS：不反交错就是横条纹",
     exp_interlaced,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=25:d=4",
      "-vf", "interlace=scan=tff", "-flags", "+ilme+ildct", "-c:v", "mpeg2video",
      "-q:v", "4", "-f", "mpegts", "{out}"]),

    # ── 几何 ──
    ("c03_rotated_mov", "带旋转显示矩阵的 MOV：不读矩阵就出横版",
     exp_rotation, "ROTATE"),

    ("c11_pillarbox", "竖屏内容塞进 1920×1080 画布：左右黑边，构图被压扁",
     exp_pillarbox,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=608x1080:r=30:d=5",
      "-vf", "pad=1920:1080:(ow-iw)/2:0:black", "-c:v", "libx264",
      "-preset", "ultrafast", "-pix_fmt", "yuv420p", "{out}"]),

    ("c14_anamorphic", "非方形像素 (SAR 16:11)：按像素尺寸缩放会变形",
     exp_anamorphic,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=720x576:r=25:d=4",
      "-vf", "setsar=16/11", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "{out}"]),

    ("c20_odd_res", "奇数分辨率 641×481 + yuv444p：yuv420p 直接编不了",
     exp_odd,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=642x482:r=25:d=4",
      "-vf", "crop=641:481:0:0:exact=1", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv444p", "{out}"]),

    # ── 音频 ──
    ("c05_no_audio", "完全无音轨：拿音频时长当总时长会截断画面",
     exp_no_audio,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "{out}"]),

    ("c06_mono_441", "单声道 44.1kHz：重采样 + 上混没做就是单边出声",
     exp_mono441,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-f", "lavfi", "-i", "sine=f=440:r=44100:d=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "1", "-shortest", "{out}"]),

    ("c07_51_surround", "5.1 环绕声：直接 -ac 2 会丢 LFE 和相位",
     exp_51,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5",
      "-af", "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "6", "-shortest", "{out}"]),

    ("c19_audio_only", "纯音频文件被当成视频素材传进来",
     exp_audioonly,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5",
      "-c:a", "aac", "-b:a", "192k", "{out}"]),

    # ── 文件完整性 ──
    ("c08_zero_bytes", "0 字节文件：下载中断的典型产物",
     exp_empty, None),

    ("c09_truncated", "moov 在头、mdat 被截断：能开、解一半报错",
     exp_truncated,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=20",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-b:v", "6M", "__TRUNC__"]),

    ("c10_long", "超长素材（10 分钟，代替 4 小时素材的时长检查路径）",
     exp_long,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=15:d=600",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40", "{out}"]),

    # ── 容器 / 流结构 ──
    ("c12_screenrecord", "屏幕录制：低帧率 + 大面积静态 + 锐利文字",
     exp_lowfps,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0xf5f5f7:s=1920x1080:r=5:d=5",
      "-vf", "drawbox=x=0:y=0:w=1920:h=64:color=0x1a1a1a:t=fill,"
             "drawbox=x=40:y=140:w=520:h=28:color=0x333333:t=fill,"
             "drawbox=x=40:y=200:w=900:h=14:color=0xbbbbbb:t=fill,"
             "drawbox=x=40:y=240:w=760:h=14:color=0xbbbbbb:t=fill",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", "{out}"]),

    ("c16_legacy_avi", "上古容器 AVI + MPEG-4 Part 2：很多库直接不认",
     exp_legacy,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x480:r=25:d=4",
      "-c:v", "mpeg4", "-q:v", "5", "{out}"]),

    ("c17_embedded_subs", "内嵌字幕轨：忽略它 = 客户说「字幕没了」",
     exp_subs, "SUBS"),

    ("c18_multi_audio", "两条音轨（原声 / 配音）：选错轨就是交付事故",
     exp_multiaudio,
     ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5",
      "-f", "lavfi", "-i", "sine=f=660:r=48000:d=5",
      "-map", "0:v", "-map", "1:a", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2",
      "-metadata:s:a:0", "language=zho", "-metadata:s:a:0", "title=原声",
      "-metadata:s:a:1", "language=zho", "-metadata:s:a:1", "title=配音",
      "-shortest", "{out}"]),
]


def build_one(spec_id: str, desc: str, expect, recipe, outdir: Path) -> dict:
    ext = {"c01_hlg_hdr": ".mov", "c03_rotated_mov": ".mov", "c04_hevc10_untagged": ".mkv",
           "c15_interlaced_ts": ".ts", "c16_legacy_avi": ".avi", "c17_embedded_subs": ".mkv",
           "c18_multi_audio": ".mkv", "c19_audio_only": ".m4a", "c12_screenrecord": ".mov",
           }.get(spec_id, ".mp4")
    out = outdir / (spec_id + ext)
    rec = {"id": spec_id, "desc": desc, "path": str(out), "size": 0,
           "status": "", "expect": "", "detail": ""}

    if recipe is None:                                  # 0 字节
        out.write_bytes(b"")
    elif recipe == "ROTATE":                            # 旋转显示矩阵（ffmpeg 9 需两步）
        base = outdir / "_rot_base.mp4"
        rc, err = run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                       "-i", "testsrc2=s=1920x1080:r=30:d=4",
                       "-c:v", "libx264", "-preset", "ultrafast",
                       "-pix_fmt", "yuv420p", str(base)])
        if rc == 0:
            rc, err = run(["ffmpeg", "-y", "-v", "error", "-display_rotation", "90",
                           "-i", str(base), "-c", "copy", str(out)])
        if rc != 0:
            rec["status"], rec["detail"] = "FAIL", err[:400]
            return rec
    elif recipe == "SUBS":                              # 内嵌字幕
        srt = outdir / "_sub.srt"
        srt.write_text("1\n00:00:00,500 --> 00:00:02,000\n第一性原理 / CUT PROOF\n\n"
                       "2\n00:00:02,500 --> 00:00:04,000\n字幕必须被看见\n")
        rc, err = run(["ffmpeg", "-y", "-v", "error",
                       "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5",
                       "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5",
                       "-i", str(srt), "-map", "0:v", "-map", "1:a", "-map", "2:s",
                       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                       "-c:a", "aac", "-c:s", "srt", "-shortest", str(out)])
        if rc != 0:
            rec["status"], rec["detail"] = "FAIL", err[:400]
            return rec
    else:
        argv = [str(out) if x == "{out}" else x for x in recipe]
        truncate = "__TRUNC__" in argv
        if truncate:
            argv = [str(out) if x == "__TRUNC__" else x for x in argv]
        rc, err = run(argv)
        if rc != 0:
            rec["status"], rec["detail"] = "FAIL", err[:400]
            return rec
        if truncate:                                    # 截掉尾部 40%
            b = out.read_bytes()
            out.write_bytes(b[: int(len(b) * 0.6)])

    rec["size"] = out.stat().st_size
    rec["sha256"] = hashlib.sha256(out.read_bytes()).hexdigest()

    # ── 自检：真的复现了吗 ──
    if spec_id == "c08_zero_bytes":
        ok = out.stat().st_size == 0
    else:
        try:
            ok = bool(expect(out))
        except Exception as e:
            ok = False
            rec["detail"] = f"probe error: {e}"
    rec["status"] = "OK" if ok else "INEXPECT"
    rec["expect"] = expect.__name__
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    ASSETS.mkdir(parents=True, exist_ok=True)

    if not args.verify:
        print(f"生成 {len(SPECS)} 条语料 → {ASSETS}\n")
        manifest = []
        for spec_id, desc, expect, recipe in SPECS:
            r = build_one(spec_id, desc, expect, recipe, ASSETS)
            manifest.append(r)
            mark = {"OK": "✓", "INEXPECT": "⚠", "FAIL": "✗"}.get(r["status"], "?")
            print(f"  {mark} {spec_id:22} {r['size']:>10,} B  {r['status']}")
            if r["detail"]:
                print(f"      {r['detail'].splitlines()[0][:120] if r['detail'] else ''}")
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    man = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else []
    bad = [m for m in man if m["status"] != "OK"]
    total = sum(m["size"] for m in man)
    print(f"\n合计 {len(man)} 条 / {total / 1e6:.1f} MB / 异常 {len(bad)} 条")
    for m in bad:
        print(f"  ⚠ {m['id']}: {m['status']} — {m['desc']}")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
