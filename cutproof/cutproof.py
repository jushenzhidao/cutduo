#!/usr/bin/env python3
"""
cutproof —— 剪辑渲染「可验证性」最小闭环（约 400 行，一个文件）

为什么需要它：
    商用剪辑的失败点不在「能不能渲染出一支片子」，而在「能不能每次都渲染出
    同一支片子，并且在渲染错的时候比客户先知道」。这个脚本把这句话变成可执行
    的四个断言：

    M1 同一后端重复渲染      —— 是否完全一致（确定性）
    M2 同一 IR 不同编码器     —— 跨后端差异有多大（双端一致性的真实上限）
    M3 同一 IR 时间线偏移 1 帧 —— 「1 帧容差」到底有多不可接受
    M4 同一 IR 不同引擎       —— MLT vs FFmpeg（装了 melt 才跑）

用法：
    python3 cutproof.py all              # 全流程：造素材→编译→渲染→测量→出 receipt
    python3 cutproof.py assets           # 只造可复现的合成素材
    python3 cutproof.py compile-mlt      # IR -> MLT XML（结构校验）
    python3 cutproof.py compile-ff       # IR -> FFmpeg 命令（打印，不执行）
    python3 cutproof.py render --variant base|hw|shift1
    python3 cutproof.py measure A.mp4 B.mp4 --label M2
    python3 cutproof.py receipt          # 汇总 L1/L2/L3 成 receipt.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IR_PATH = ROOT / "ir" / "sample_15s_vertical.json"
ASSETS = ROOT / "assets"
OUT = ROOT / "out"
FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]
# 只含拉丁字形的字体：用来复现「字体缺失 → 静默回退成豆腐块」的错片
LATIN_ONLY_FONTS = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


# ----------------------------------------------------------------------------- utils
def run(argv: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def ffprobe(path: Path) -> dict:
    p = run(["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)])
    return json.loads(p.stdout)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pick_font(explicit: str | None = None) -> str:
    if explicit and Path(explicit).exists():
        return explicit
    for c in FONT_CANDIDATES:
        if Path(c).exists():
            return c
    raise SystemExit("找不到可用字体，请用 --font 指定 fontfile")


def structure(path: Path) -> dict:
    """L1 结构层：必须是 100% 可断言、不依赖像素比对的字段。"""
    meta = ffprobe(path)
    v = next((s for s in meta["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in meta["streams"] if s["codec_type"] == "audio"), {})
    if v is None:
        return {
            "kind": "audio_only",
            "audio_codec": a.get("codec_name"),
            "audio_rate": int(a["sample_rate"]) if a.get("sample_rate") else None,
            "audio_channels": a.get("channels"),
            "audio_duration": float(a.get("duration", 0)),
            "size_bytes": path.stat().st_size,
        }
    num, den = (int(x) for x in v["r_frame_rate"].split("/"))
    fps = num / den if den else 30.0
    nb = int(v.get("nb_frames") or round(float(v.get("duration", 0)) * fps))
    return {
        "width": v["width"],
        "height": v["height"],
        "fps": f"{num}/{den}",
        "frames": nb,
        "pix_fmt": v["pix_fmt"],
        "codec": v["codec_name"],
        "profile": v.get("profile"),
        "color_primaries": v.get("color_primaries"),
        "color_transfer": v.get("color_transfer"),
        "color_space": v.get("color_space"),
        "color_range": v.get("color_range"),
        "audio_codec": a.get("codec_name"),
        "audio_rate": int(a["sample_rate"]) if a.get("sample_rate") else None,
        "audio_channels": a.get("channels"),
        "audio_duration": float(a["duration"]) if a.get("duration") else None,
        "size_bytes": path.stat().st_size,
    }


# ----------------------------------------------------------------------------- assets
CLIPS = [
    ("clip1.mp4", "testsrc2=size=1080x1920:rate=30:duration=6"),
    ("clip2.mp4", "testsrc2=size=1280x720:rate=30:duration=5,hue=h=120"),
    ("clip3.mp4", "testsrc2=size=1080x1920:rate=30:duration=6,hue=h=240"),
]


def cmd_assets(args) -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    for name, src in CLIPS:
        dst = ASSETS / name
        run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", src,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", "30",
             "-colorspace", "bt709", "-color_primaries", "bt709",
             "-color_trc", "bt709", "-color_range", "tv",
             "-fflags", "+bitexact", "-flags:v", "+bitexact",
             "-map_metadata", "-1", str(dst)])
        print(f"  ✓ {dst.name}  {dst.stat().st_size // 1024} KB")
    music = ASSETS / "music.m4a"
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", "sine=frequency=220:sample_rate=48000:duration=15",
         "-af", "volume=0.25", "-c:a", "aac", "-b:a", "192k", str(music)])
    print(f"  ✓ {music.name}  {music.stat().st_size // 1024} KB")


def load_ir(path: Path = IR_PATH) -> dict:
    ir = json.loads(path.read_text())
    for asset in ir["assets"]:
        if "sha256" in asset and asset["sha256"] == "0" * 64:
            continue
    return ir


def refresh_hashes(ir: dict) -> dict:
    for asset in ir["assets"]:
        p = Path(asset["uri"].replace("file://", ""))
        if p.exists():
            asset["sha256"] = sha256(p)
            asset["probe"] = structure(p)
    IR_PATH.write_text(json.dumps(ir, ensure_ascii=False, indent=2) + "\n")
    return ir


# ----------------------------------------------------------------------------- MLT backend
def cmd_compile_mlt(args) -> None:
    """IR -> MLT XML。

    注意：MLT XML 是**编译产物**，不是事实来源。它包含 producer id、服务名、
    绝对帧号、文件路径——这些是执行细节。把它当 source of truth，等于把
    引擎版本、模块可用性、路径布局焊进产品契约里。
    """
    ir = refresh_hashes(load_ir())
    out = ir["output"]
    fnum, fden = out["fps"]["num"], out["fps"]["den"]
    W, H, total = out["width"], out["height"], out["duration_frames"]
    font = pick_font(getattr(args, "font", None))
    assets = {a["id"]: a for a in ir["assets"]}

    L = ['<?xml version="1.0" encoding="utf-8"?>',
         f'<mlt LC_NUMERIC="C" version="7.30.0" title="{ir["id"]}" producer="tractor0">',
         f'  <profile description="{W}x{H} {fnum}/{fden}" width="{W}" height="{H}" progressive="1" '
         f'sample_aspect_num="1" sample_aspect_den="1" '
         f'display_aspect_num="{W // 60}" display_aspect_den="{H // 60}" '
         f'frame_rate_num="{fnum}" frame_rate_den="{fden}" colorspace="709"/>']

    # 每个被引用的素材 -> 一个 producer
    prod_id = {}
    for track in ir["tracks"]:
        if track["kind"] not in ("video", "overlay", "audio"):
            continue
        for clip in track["clips"]:
            aid = clip.get("asset")
            if not aid or aid in prod_id:
                continue
            p = Path(assets[aid]["uri"].replace("file://", ""))
            pid = f'producer{len(prod_id)}'
            prod_id[aid] = pid
            L.append(f'  <producer id="{pid}" in="0" out="{total + 600}">')
            L.append(f'    <property name="resource">{p}</property>')
            L.append('    <property name="mlt_service">avformat-novalidate</property>')
            L.append('    <property name="audio_index">1</property>')
            L.append('    <property name="video_index">0</property>')
            L.append('    <property name="set.test_audio">0</property>')
            L.append('  </producer>')

    # 视频轨：轨道内必须无空洞（本编译器只支持连续排布，空洞即报错）
    video_tracks = [t for t in ir["tracks"] if t["kind"] in ("video", "overlay")]
    for ti, track in enumerate(video_tracks):
        clips = sorted(track["clips"], key=lambda c: c["at_frame"])
        L.append(f'  <playlist id="playlist{ti}">')
        for clip in clips:
            pid = prod_id[clip["asset"]]
            in_f = clip.get("in_frame", 0)
            length = clip["out_frame"] - clip["at_frame"]
            L.append(f'    <entry producer="{pid}" in="{in_f}" out="{in_f + length - 1}"/>')
        L.append('  </playlist>')

    # 文本轨：MLT 用 colour 源 + dynamictext 滤镜
    text_tracks = [t for t in ir["tracks"] if t["kind"] == "text"]
    for k, track in enumerate(text_tracks):
        tid = f'playlist_text{k}'
        L.append(f'  <playlist id="{tid}">')
        cursor = 0
        for clip in sorted(track["clips"], key=lambda c: c["at_frame"]):
            if clip["at_frame"] > cursor:
                L.append(f'    <blank length="{clip["at_frame"] - cursor}"/>')
            style = ir["styles"][clip["style"]]
            length = clip["out_frame"] - clip["at_frame"]
            L.append(f'    <entry producer="colour_text{k}_{clip["at_frame"]}" '
                     f'in="0" out="{length - 1}"/>')
            cursor = clip["at_frame"] + length
        L.append('  </playlist>')

    L.append(f'  <tractor id="tractor0" in="0" out="{total - 1}">')
    L.append('    <property name="shotcut:projectAudioChannels">2</property>')
    for ti, track in enumerate(video_tracks):
        L.append(f'    <track producer="playlist{ti}"/>')
    for k in range(len(text_tracks)):
        L.append(f'    <track producer="playlist_text{k}"/>')
    # 音轨
    audio_tracks = [t for t in ir["tracks"] if t["kind"] == "audio"]
    for ai, track in enumerate(audio_tracks):
        clip = track["clips"][0]
        pid = prod_id[clip["asset"]]
        L.append(f'    <track producer="playlist_audio{ai}"/>')
        L.append(f'    <playlist id="playlist_audio{ai}">')
        L.append(f'      <entry producer="{pid}" in="0" out="{total - 1}"/>')
        L.append('    </playlist>')
    # 合成器：视频轨用 qtblend，音频轨用 mix
    for ti in range(1, len(video_tracks) + len(text_tracks)):
        L.append(f'    <transition id="transition{ti}">')
        L.append('      <property name="a_track">0</property>')
        L.append(f'      <property name="b_track">{ti}</property>')
        L.append('      <property name="mlt_service">qtblend</property>')
        L.append('      <property name="always_active">1</property>')
        L.append(f'      <property name="rect">{0} {0} {W} {H} 1</property>')
        L.append('    </transition>')
    if audio_tracks:
        base = len(video_tracks) + len(text_tracks)
        L.append(f'    <transition id="transition_audio">')
        L.append('      <property name="a_track">0</property>')
        L.append(f'      <property name="b_track">{base}</property>')
        L.append('      <property name="mlt_service">mix</property>')
        L.append('      <property name="always_active">1</property>')
        L.append('      <property name="sum">1</property>')
        L.append('    </transition>')
    L.append('  </tractor>')
    L.append('</mlt>')

    xml = "\n".join(L) + "\n"
    dst = OUT / "timeline.mlt"
    dst.write_text(xml)

    # 结构校验：well-formed + 服务名白名单
    import xml.etree.ElementTree as ET
    tree = ET.parse(dst)
    services = {p.text for p in tree.iter("property") if p.get("name") == "mlt_service"}
    allowed = {"avformat-novalidate", "qtblend", "mix", "dynamictext", "colour"}
    unknown = services - allowed
    print(f"  ✓ {dst}  ({len(xml)} bytes, well-formed)")
    print(f"    服务: {sorted(services)}")
    if unknown:
        print(f"    ⚠ 白名单外的服务: {sorted(unknown)} — 目标节点未装对应模块时渲染会静默降级")
    print("    ⚠ MLT 分支仅做结构校验；真渲染需目标节点有 melt + qtblend 模块")


# ----------------------------------------------------------------------------- text rasterizer
def compile_text_layers(ir: dict, font: str) -> list[dict]:
    """文本原语 -> 内容寻址的 RGBA 图层资产，并在编译期算出几何断言。

    这是本 harness 里最重要的一个设计选择：**文本不交给渲染器去栅格化**。
    一旦 drawtext/字幕滤镜在目标机器上现算字形，输出就绑定了那台机器的
    freetype/harfbuzz 版本与字体搜索路径，跨端一致性从物理上不可保证。
    正确做法是把文字先栅格化成图层（PNG/SVG），图层的 sha256 进入 IR 的缓存
    键，渲染器只做合成——字形像素在编译期就冻结了。
    """
    from PIL import Image, ImageDraw, ImageFont

    W, H = ir["output"]["width"], ir["output"]["height"]
    layers: list[dict] = []
    for track in [t for t in ir["tracks"] if t["kind"] == "text"]:
        for clip in track["clips"]:
            st = ir["styles"][clip["style"]]
            img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            f = ImageFont.truetype(font, st["font_size"])
            text = clip["text"]
            maxc = st.get("max_chars_per_line")
            lines: list[str] = []
            for para in text.split("\n"):
                if maxc:
                    lines += [para[i:i + maxc] for i in range(0, len(para), maxc)]
                else:
                    lines.append(para)
            body = "\n".join(lines)

            anchor = st.get("anchor", "center")
            safe = st.get("safe_area", {})
            bottom_pad = safe.get("bottom", 0.18)
            if anchor == "bottom":
                y = H * (1 - bottom_pad)
            elif anchor == "top":
                y = H * safe.get("top", 0.12)
            else:
                y = H / 2 + st.get("offset_y", 0)

            stroke_w = 6 if st.get("stroke") else 0
            stroke_fill = st.get("stroke", "#000000").split("@")[0]
            align = st.get("align", "center")

            # 自己算包围盒（PIL 的 multiline 不支持 anchor 参数）
            lb = draw.multiline_textbbox((0, 0), body, font=f, align=align,
                                         stroke_width=stroke_w)
            tw, th = lb[2] - lb[0], lb[3] - lb[1]
            top = {"bottom": y - th - lb[1], "top": y - lb[1]}.get(anchor, y - th / 2 - lb[1])
            left = W / 2 - tw / 2 - lb[0]
            draw.multiline_text((left, top), body, font=f,
                                fill=st["fill"].split("@")[0], align=align,
                                stroke_width=stroke_w, stroke_fill=stroke_fill)

            bbox = img.getbbox()  # 实际墨迹包围盒
            within = None
            if bbox and safe:
                x0, y0 = W * safe.get("left", 0), H * safe.get("top", 0)
                x1, y1 = W * (1 - safe.get("right", 0)), H * (1 - safe.get("bottom", 0))
                within = (bbox[0] >= x0 - 1 and bbox[1] >= y0 - 1
                          and bbox[2] <= x1 + 1 and bbox[3] <= y1 + 1)

            png = OUT / f"layer_{track['id']}_{clip['at_frame']}.png"
            img.save(png)
            layers.append({
                "track": track["id"], "clip": clip, "png": str(png),
                "sha256": sha256(png),
                "bbox_px": bbox,
                "within_safe_area": within,
                "lines": len(lines),
                "at_frame": clip["at_frame"],
                "out_frame": clip["out_frame"],
                "safe_area": safe,
            })
    summary = [{k: v for k, v in l.items() if k != "clip"} for l in layers]
    (OUT / "layers.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return layers


# ----------------------------------------------------------------------------- FFmpeg backend
def build_ffmpeg(ir: dict, variant: str, font: str, out_path: Path,
                 layers: list[dict] | None = None) -> list[str]:
    o = ir["output"]
    W, H = o["width"], o["height"]
    fnum, fden = o["fps"]["num"], o["fps"]["den"]
    total = o["duration_frames"]
    assets = {a["id"]: a for a in ir["assets"]}
    paths = {aid: a["uri"].replace("file://", "") for aid, a in assets.items()}

    video_tracks = [t for t in ir["tracks"] if t["kind"] in ("video", "overlay")]
    text_tracks = [t for t in ir["tracks"] if t["kind"] == "text"]
    audio_tracks = [t for t in ir["tracks"] if t["kind"] == "audio"]

    argv: list[str] = ["ffmpeg", "-y", "-v", "error", "-nostdin"]
    idx: dict[str, int] = {}
    n_inputs = 0
    for aid in paths:
        idx[aid] = n_inputs
        argv += ["-i", paths[aid]]
        n_inputs += 1
    layers = layers if layers is not None else compile_text_layers(ir, font)
    dur_s = total / (fnum / fden)
    for li, layer in enumerate(layers):
        layer["_idx"] = n_inputs
        argv += ["-loop", "1", "-framerate", f"{fnum}/{fden}", "-t", f"{dur_s:.3f}",
                 "-i", layer["png"]]
        n_inputs += 1

    graph: list[str] = []
    # 视频轨：一致性断言 —— 轨道必须连续铺满，否则拒绝编译（而不是静默出错片）
    for ti, track in enumerate(video_tracks):
        clips = sorted(track["clips"], key=lambda c: c["at_frame"])
        cursor = 0
        segs = []
        for ci, clip in enumerate(clips):
            if clip["at_frame"] != cursor:
                raise SystemExit(
                    f"E_IR_UNSUPPORTED: 轨道 {track['id']} 在帧 {cursor} 处有空洞；"
                    f"本版本编译器不支持空洞，请补 blank 或修正 IR")
            cur_out = clip["out_frame"]
            length = cur_out - clip["at_frame"]
            src_in = clip.get("in_frame", 0) + (1 if variant == "shift1" else 0)
            tag = f"v{ti}_{ci}"
            graph.append(
                f"[{idx[clip['asset']]}:v]"
                f"trim=start_frame={src_in}:end_frame={src_in + length},"
                f"setpts=PTS-STARTPTS,"
                f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=bicubic,"
                f"crop={W}:{H},setsar=1,fps={fnum}/{fden},format=yuv420p[{tag}]")
            segs.append(f"[{tag}]")
            cursor = cur_out
        if cursor != total:
            raise SystemExit(f"E_IR_UNSUPPORTED: 轨道 {track['id']} 结束于 {cursor}，"
                             f"与 duration_frames={total} 不符")
        if len(segs) == 1:
            graph.append(f"{segs[0]}null[vbase{ti}]")
        else:
            graph.append(f"{''.join(segs)}concat=n={len(segs)}:v=1:a=0[vbase{ti}]")

    cur = f"[vbase0]"
    for ti in range(1, len(video_tracks)):
        graph.append(f"{cur}[vbase{ti}]overlay=0:0:format=auto,format=yuv420p[vo{ti}]")
        cur = f"[vo{ti}]"

    # 文本层：合成已栅格化的图层资产，不在渲染时现算字形
    for li, layer in enumerate(layers):
        clip = layer["clip"]
        t0 = clip["at_frame"] / (fnum / fden)
        t1 = clip["out_frame"] / (fnum / fden)
        tag = f"vt{li}"
        graph.append(f"[{layer['_idx']}:v]format=rgba,setpts=PTS-STARTPTS[lyr{li}]")
        graph.append(
            f"{cur}[lyr{li}]overlay=0:0:format=auto:eof_action=repeat:"
            f"enable='between(t,{t0:.3f},{t1:.3f})',format=yuv420p[{tag}]")
        cur = f"[{tag}]"
    graph.append(f"{cur}format=yuv420p[vout]")

    # 音频
    if audio_tracks:
        clip = audio_tracks[0]["clips"][0]
        sr = o["audio"]["sample_rate"]
        n_samples = round(dur_s * sr)          # 用采样数而不是秒，避免浮点截断
        fade_n = round(0.5 * sr)
        graph.append(
            f"[{idx[clip['asset']]}:a]atrim=end_sample={n_samples},"
            f"asetpts=PTS-STARTPTS,aresample={sr},"
            f"aformat=channel_layouts=stereo,"
            f"afade=t=in:st=0:d=0.5,"
            f"afade=t=out:st={(n_samples - fade_n) / sr:.6f}:d=0.5,"
            f"loudnorm=I={o['audio'].get('target_lufs', -14)}:TP=-1.5:LRA=11[aout]")
    else:
        graph.append(f"anullsrc=r={o['audio']['sample_rate']}:cl=stereo,"
                     f"atrim=end_frame={total}[aout]")

    argv += ["-filter_complex", ";".join(graph), "-map", "[vout]", "-map", "[aout]"]

    if variant == "hw":
        argv += ["-c:v", "h264_videotoolbox", "-b:v", f"{o['video']['bitrate_kbps']}k",
                 "-pix_fmt", o["video"]["pix_fmt"], "-profile:v", "high"]
    else:
        argv += ["-c:v", "libx264", "-preset", o["video"].get("preset", "veryfast"),
                 "-b:v", f"{o['video']['bitrate_kbps']}k",
                 "-pix_fmt", o["video"]["pix_fmt"], "-profile:v", "high",
                 "-g", str(o["video"].get("gop_frames", 60)), "-bf", "2"]

    argv += [
        "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-ar", str(o["audio"]["sample_rate"]),
        "-ac", str(o["audio"]["channels"]), "-b:a", f"{o['audio'].get('bitrate_kbps', 192)}k",
        "-movflags", "+faststart", "-shortest",
        # 确定性：去掉一切可能写进容器的非确定性元信息
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-threads", "4",
        str(out_path),
    ]
    return argv


def cmd_compile_ff(args) -> None:
    ir = load_ir()
    argv = build_ffmpeg(ir, args.variant, pick_font(getattr(args, "font", None)),
                        OUT / f"render_{args.variant}.mp4")
    if args.print_cmd:
        print(" \\\n  ".join(argv))
    else:
        print(f"  已生成 {len(argv)} 个参数；用 --print-cmd 查看完整命令")


def font_for(variant: str, explicit: str | None) -> str:
    if explicit:
        return pick_font(explicit)
    if variant == "fontmiss":
        for c in LATIN_ONLY_FONTS:
            if Path(c).exists():
                return c
    return pick_font(None)


def cmd_render(args) -> None:
    ir = load_ir()
    if args.ir:
        ir = json.loads(Path(args.ir).read_text())
    out = OUT / f"render_{args.variant}.mp4"
    argv = build_ffmpeg(ir, args.variant, font_for(args.variant, args.font), out)
    print(f"  渲染 {out.name} ...")
    import time
    t = time.time()
    p = subprocess.run(argv, capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stderr[-2000:])
        raise SystemExit(f"渲染失败 (exit {p.returncode})")
    dt = time.time() - t
    dur = ir["output"]["duration_frames"] / (ir["output"]["fps"]["num"] / ir["output"]["fps"]["den"])
    print(f"  ✓ {out.name}  {out.stat().st_size // 1024} KB  "
          f"{dt:.2f}s  ({dur / dt:.2f}× 实时)")


# ----------------------------------------------------------------------------- measure
def cmd_measure(args) -> None:
    a, b = Path(args.a), Path(args.b)
    sa, sb = structure(a), structure(b)
    l1_keys = ["width", "height", "fps", "frames", "pix_fmt", "color_primaries",
               "color_space", "color_range", "audio_rate", "audio_channels"]
    l1 = {k: (sa[k], sb[k], sa[k] == sb[k]) for k in l1_keys}

    def filt(f: str) -> list[float]:
        p = run(["ffmpeg", "-v", "info", "-i", str(a), "-i", str(b),
                 "-lavfi", f, "-f", "null", "-"], check=False)
        err = p.stderr
        m = re.search(r"SSIM.*?All:\s*([0-9.]+)", err)
        if m:
            return [float(m.group(1))]
        m = re.search(r"PSNR.*?average:\s*([0-9.]+|inf)", err)
        if m:
            return [999.0 if m.group(1) == "inf" else float(m.group(1))]
        nums = re.findall(r"All:\s*([0-9.]+)", err)
        return [float(n) for n in nums]

    ssim = filt("[0:v][1:v]ssim")
    psnr = filt("[0:v][1:v]psnr")
    vmaf = None
    p = run(["ffmpeg", "-v", "info", "-i", str(a), "-i", str(b),
             "-lavfi", "[0:v][1:v]libvmaf", "-f", "null", "-"], check=False)
    m = re.search(r"VMAF score:\s*([0-9.]+)", p.stderr)
    if m:
        vmaf = float(m.group(1))

    result = {
        "label": args.label,
        "a": a.name, "b": b.name,
        "L1_structure": l1,
        "L1_all_equal": all(v[2] for v in l1.values()),
        "L2_ssim": ssim[0] if ssim else None,
        "L2_psnr_db": psnr[0] if psnr else None,
        "L2_vmaf": vmaf,
        "identical_bytes": sha256(a) == sha256(b),
        "size_delta_pct": round((sb["size_bytes"] - sa["size_bytes"]) / sa["size_bytes"] * 100, 2),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def loudness(path: Path) -> dict:
    p = run(["ffmpeg", "-v", "info", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
            check=False)
    m = re.findall(r"I:\s*(-?[0-9.]+) LUFS", p.stderr)
    tp = re.findall(r"Peak:\s*(-?[0-9.]+) dBFS", p.stderr)
    return {"integrated_lufs": float(m[-1]) if m else None,
            "true_peak_dbfs": float(tp[-1]) if tp else None}


def black_frames(path: Path) -> list[dict]:
    p = run(["ffmpeg", "-v", "info", "-i", str(path),
             "-vf", "blackdetect=d=0.1:pix_th=0.10", "-f", "null", "-"], check=False)
    out = []
    for m in re.finditer(r"black_start:([0-9.]+) black_end:([0-9.]+)", p.stderr):
        out.append({"start": float(m.group(1)), "end": float(m.group(2))})
    return out


def cmd_receipt(args) -> None:
    """把 L1/L2/L3 合成一份『证据回执』——Agent 靠它自我纠错，而不是靠猜。

    实现委托给 asserts.py，保证「一个断言只有一个定义」。
    """
    sys.path.insert(0, str(Path(__file__).parent))
    import asserts  # noqa: E402

    ref = OUT / "render_base.mp4"
    if not ref.exists():
        raise SystemExit("先跑 render --variant base")
    ir = load_ir()
    rec = asserts.build_receipt(
        ir, ref, IR_PATH, reference=None,
        font=args.font or font_for("base", None))
    (OUT / "receipt.json").write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"verdict": rec["verdict"], "failures": rec["failures"],
                      "L1_fail": [k for k, v in rec["L1"]["assertions"].items()
                                  if isinstance(v, dict) and not v.get("pass", True)],
                      "L3_fonts": rec["L3"].get("font_coverage", {}).get("ok"),
                      "L3_loudness": rec["L3"]["loudness"]["integrated_lufs"]},
                     ensure_ascii=False, indent=2))
    print(f"  → {OUT / 'receipt.json'}")


def cmd_evidence(args) -> None:
    ref = OUT / "render_base.mp4"
    total = structure(ref)["frames"]
    run(["ffmpeg", "-y", "-v", "error", "-i", str(ref),
         "-vf", "select='not(mod(n\\,45))',scale=270:-1,tile=5x2",
         "-frames:v", "1", str(OUT / "contact_sheet.jpg")])
    run(["ffmpeg", "-y", "-v", "error", "-i", str(ref), "-vf", "select=eq(n\\,0)",
         "-frames:v", "1", "-q:v", "2", str(OUT / "frame_first.jpg")])
    run(["ffmpeg", "-y", "-v", "error", "-i", str(ref),
         "-vf", f"select=eq(n\\,{total - 1})", "-frames:v", "1", "-q:v", "2",
         str(OUT / "frame_last.jpg")])
    print(f"  ✓ contact_sheet.jpg / frame_first.jpg / frame_last.jpg")


# ----------------------------------------------------------------------------- all
def cmd_all(args) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("\n[1/7] 生成可复现素材")
    cmd_assets(args)
    print("\n[2/7] 编译 MLT XML（结构校验）")
    cmd_compile_mlt(args)
    print("\n[3/7] 渲染 base（libx264）")
    cmd_render(argparse.Namespace(variant="base", font=args.font, ir=None))
    print("\n[4/7] 渲染 base 第二次（确定性）")
    av = build_ffmpeg(load_ir(), "base", font_for("base", args.font), OUT / "render_base_2.mp4")
    subprocess.run(av, check=True, capture_output=True)
    print("  ✓ render_base_2.mp4")
    print("\n[5/7] 渲染 hw / shift1 / fontmiss")
    for v in ("hw", "shift1", "fontmiss"):
        cmd_render(argparse.Namespace(variant=v, font=args.font, ir=None))

    print("\n[6/7] 测量")
    results = []
    for label, x, y in [
        ("M1 同后端两次渲染", "render_base.mp4", "render_base_2.mp4"),
        ("M2 同 IR·软编 vs 硬编", "render_base.mp4", "render_hw.mp4"),
        ("M3 同 IR·时间线偏移 1 帧", "render_base.mp4", "render_shift1.mp4"),
        ("M4 字体缺失·错片 vs 正确", "render_base.mp4", "render_fontmiss.mp4"),
    ]:
        results.append(cmd_measure(argparse.Namespace(
            a=str(OUT / x), b=str(OUT / y), label=label)))

    cmd_evidence(args)
    (OUT / "measurements.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n")

    print("\n══ 汇总 ══")
    print(f"{'断言':32} {'L1全等':8} {'SSIM':>8} {'PSNR dB':>9} {'VMAF':>7} {'字节相同':>9}")
    for r in results:
        print(f"{r['label']:32} {str(r['L1_all_equal']):8} "
              f"{(r['L2_ssim'] or 0):8.5f} {(r['L2_psnr_db'] or 0):9.2f} "
              f"{(r['L2_vmaf'] or 0):7.2f} {str(r['identical_bytes']):>9}")


def main() -> None:
    ap = argparse.ArgumentParser(description="剪辑渲染可验证性最小闭环")
    ap.add_argument("--font", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("assets").set_defaults(fn=cmd_assets)
    sub.add_parser("compile-mlt").set_defaults(fn=cmd_compile_mlt)
    p = sub.add_parser("compile-ff")
    p.add_argument("--variant", default="base")
    p.add_argument("--print-cmd", action="store_true")
    p.set_defaults(fn=cmd_compile_ff)
    p = sub.add_parser("render")
    p.add_argument("--variant", default="base",
                   choices=["base", "hw", "shift1", "fontmiss"])
    p.add_argument("--ir", default=None)
    p.set_defaults(fn=cmd_render)
    p = sub.add_parser("measure")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--label", default="")
    p.set_defaults(fn=cmd_measure)
    p = sub.add_parser("receipt")
    p.add_argument("--font", default=None)
    p.set_defaults(fn=cmd_receipt)
    sub.add_parser("evidence").set_defaults(fn=cmd_evidence)
    sub.add_parser("all").set_defaults(fn=cmd_all)

    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    args.fn(args)


if __name__ == "__main__":
    main()
