#!/usr/bin/env python3
"""
ingest.py —— 素材探针 + 归一化引擎

三段式，刻意分开：
    probe()      只观测，不改动，输出规范化描述 + 风险标记
    decide()     只决策，不执行，输出声明式动作序列 + 错误码（可审计、可缓存）
    normalize()  只执行，按动作序列拼 filtergraph，输出 canonical 中间片 + 校验

为什么要拆开：如果「探测到 HDR 就直接转 SDR」写在一个函数里，你永远无法回答
「这条素材为什么被转成了这样」。拆开之后，决策是一份可以 review、可以入库、
可以回放的 JSON——出事时能对账。

用法：
    python3 ingest.py all                 # probe → decide → normalize → matrix
    python3 ingest.py probe|plan|normalize|matrix
    python3 ingest.py one path/to/file.mp4
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
CORPUS = ROOT / "corpus" / "assets"
MANIFEST = ROOT / "corpus" / "manifest.json"
RES = ROOT / "res"
P_DIR, L_DIR, M_DIR = RES / "probes", RES / "plans", RES / "mezz"

# ── canonical 中间片规格 ────────────────────────────────────
T = {
    "long_edge": 1920,
    "fps": 30,
    "pix_fmt": "yuv420p",
    "sample_rate": 48000,
    "channels": 2,
    "crf": 16,
    "max_duration_s": 3600,       # 超长素材上限，超过要人工确认
    "hdr_transfer_prone": ("arib-std-b67", "smpte2084", "smpte428"),
}

# 坑：libx264 只认这一行，单给 -color_primaries 不会写进 SPS VUI，
# ffprobe 会读到 transfer=unknown / primaries=unknown，交付后各播放器各显各的。
COLOR_TAG_BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709",
                   "-colorspace", "bt709", "-color_range", "tv",
                   "-x264-params", "colorprim=bt709:transfer=bt709:"
                                    "colormatrix=bt709:range=tv"]

# 动作 -> 人话
ACT_DESC = {
    "DEINTERLACE": "yadif 反交错（隔行素材必须先做，否则缩放出横条纹）",
    "CFR": "转恒定帧率（VFR 时间戳断档会导致音画不同步）",
    "DECIMATE": "高帧率降采样到 30fps",
    "TONEMAP_HDR": "HDR → BT.709 SDR（colorspace 直转，非 tone curve）",
    "CROP_PILLARBOX": "裁掉非内容黑边",
    "SQUARE_PIXELS": "非方形像素方形化（SAR → 1:1，保持 DAR）",
    "CAP_LONG_EDGE": "长边限制到 1920（等比，不裁）",
    "FIX_ODD": "奇数分辨率偶数化",
    "FORMAT_YUV420P": "统一像素格式 yuv420p",
    "TAG_COLOR": "补写色彩标记（primaries/transfer/matrix 缺失，交付后播放器各显各的）",
    "AUDIO_DOWNMIX": "5.1 → 立体声（带 pan 系数，保留中置和对白）",
    "AUDIO_UPMIX": "单声道 → 立体声（复制到双声道）",
    "AUDIO_RESAMPLE": "重采样到 48kHz",
    "AUDIO_SYNTH": "补静音轨（原素材无音轨）",
    "AUDIO_PICK_FIRST": "多音轨取第一条（记录被丢弃的轨）",
    "TRIM_OVERLONG": "超长素材截断",
    "DROP_SUBS": "丢弃内嵌字幕轨（需模板侧另行处理）",
}


def run(argv: list[str], timeout: int = 600) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def ffprobe(path: Path) -> dict:
    p = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                        "-show_format", "-show_streams", "-show_error", str(path)],
                       capture_output=True, text=True)
    try:
        return json.loads(p.stdout or "{}")
    except Exception:
        return {}


def ratio(s: str | None) -> float | None:
    if not s or "/" not in s:
        return None
    try:
        n, d = s.split("/")
        return float(n) / float(d) if float(d) else None
    except Exception:
        return None


def cropdetect(path: Path) -> str | None:
    rc, err = run(["ffmpeg", "-v", "info", "-i", str(path), "-t", "3",
                   "-vf", "cropdetect=limit=0.1:round=2:reset=0", "-f", "null", "-"])
    hits = re.findall(r"crop=(\d+:\d+:\d+:\d+)", err)
    return hits[-1] if hits else None


def sample_decode_ok(path: Path, seconds: int = 15) -> tuple[bool, str]:
    """抽样解码，用来抓截断/损坏。生产环境应对整片跑一次深度校验。"""
    rc, err = run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path),
                   "-t", str(seconds), "-f", "null", "-"])
    bad = rc != 0 or bool(re.search(r"error|invalid|corrupt|truncat|partial", err, re.I))
    return (not bad), err.strip().splitlines()[-1] if err.strip() else ""


# ══════════════════════════════════════════════════════ probe
def probe(path: Path) -> dict:
    st = path.stat()
    pr = {
        "path": str(path), "size": st.st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if st.st_size else "",
        "readable": False, "video": None, "audio": None, "flags": [], "raw_notes": {},
    }
    if st.st_size == 0:
        pr["flags"].append("EMPTY_FILE")
        return pr

    meta = ffprobe(path)
    if not meta.get("streams"):
        pr["flags"].append("UNREADABLE")
        pr["raw_notes"]["ffprobe"] = (meta.get("error") or {}).get("string", "no streams")
        return pr

    v = next((s for s in meta["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in meta["streams"] if s["codec_type"] == "audio"), None)
    n_sub = len([s for s in meta["streams"] if s["codec_type"] == "subtitle"])
    n_aud = len([s for s in meta["streams"] if s["codec_type"] == "audio"])
    fmt = meta.get("format", {})
    pr["readable"] = True
    pr["container"] = fmt.get("format_name")
    pr["duration_s"] = float(fmt.get("duration") or 0)

    if v is None:
        pr["flags"].append("AUDIO_ONLY")
        pr["audio"] = {
            "codec": a.get("codec_name"), "rate": int(a.get("sample_rate") or 0),
            "channels": a.get("channels"), "layout": a.get("channel_layout"),
        }
        return pr

    rot = 0.0
    for sd in (v.get("side_data_list") or []):
        if "rotation" in sd:
            rot = float(sd["rotation"])
    if not rot:
        try:
            rot = float(v.get("tags", {}).get("rotate", 0) or 0)
        except Exception:
            rot = 0.0

    sar = v.get("sample_aspect_ratio")
    pr["video"] = {
        "codec": v.get("codec_name"), "profile": v.get("profile"),
        "width": v.get("width"), "height": v.get("height"),
        "coded_width": v.get("coded_width"), "coded_height": v.get("coded_height"),
        "pix_fmt": v.get("pix_fmt"), "bit_depth": 10 if (v.get("pix_fmt") or "").endswith("10le") else 8,
        "fps_num_den": v.get("r_frame_rate"),
        "fps": ratio(v.get("r_frame_rate")),
        "avg_fps": ratio(v.get("avg_frame_rate")),
        "field_order": v.get("field_order"),
        "sar": sar, "dar": v.get("display_aspect_ratio"),
        "color_primaries": v.get("color_primaries"),
        "color_transfer": v.get("color_transfer"),
        "color_space": v.get("color_space"),
        "color_range": v.get("color_range"),
        "rotation": rot,
        "nb_frames": int(v["nb_frames"]) if v.get("nb_frames") else None,
    }
    if a:
        pr["audio"] = {
            "codec": a.get("codec_name"), "rate": int(a.get("sample_rate") or 0),
            "channels": a.get("channels"), "layout": a.get("channel_layout"),
            "duration_s": float(a.get("duration") or 0),
        }
    pr["streams"] = {"video": 1, "audio": n_aud, "subtitle": n_sub}

    # ── 风险标记 ──
    f = pr["flags"]
    vv = pr["video"]
    if vv["color_transfer"] in T["hdr_transfer_prone"] or vv["color_primaries"] == "bt2020":
        f.append("HDR")
    elif vv["bit_depth"] > 8 and not vv["color_primaries"]:
        f.append("UNTAGGED_DEEP_COLOR")
    if not (vv["color_primaries"] and vv["color_transfer"] and vv["color_space"]):
        f.append("COLOR_UNTAGGED")
    if vv["bit_depth"] > 8:
        f.append("DEEP_COLOR")
    if vv["fps"] and vv["avg_fps"] and abs(vv["fps"] - vv["avg_fps"]) > 0.5:
        f.append("VFR")
    if vv["fps"] and vv["fps"] > 60:
        f.append("HIGH_FPS")
    if vv["fps"] and vv["fps"] < 12:
        f.append("LOW_FPS")
    if (vv["field_order"] or "progressive") not in ("progressive", "unknown"):
        f.append("INTERLACED")
    if abs(vv["rotation"]) > 0.01:
        f.append("ROTATION")
    if vv["sar"] not in (None, "1:1", "0:1"):
        f.append("ANAMORPHIC")
    if (vv["width"] or 0) % 2 or (vv["height"] or 0) % 2:
        f.append("ODD_DIMENSIONS")
    if (vv["pix_fmt"] or "") not in ("yuv420p", "yuvj420p"):
        f.append("NONSTANDARD_PIXFMT")
    if not a:
        f.append("NO_AUDIO")
    else:
        if a.get("channels") and a["channels"] >= 6:
            f.append("SURROUND")
        elif a.get("channels") == 1:
            f.append("MONO")
        if int(a.get("sample_rate") or 0) not in (0, 48000):
            f.append("ODD_SAMPLE_RATE")
        if pr["duration_s"] and pr["audio"].get("duration_s") and \
                abs(pr["duration_s"] - pr["audio"]["duration_s"]) > 0.5:
            f.append("AUDIO_VIDEO_DUR_MISMATCH")
        if pr["audio"].get("codec") not in ("aac", "mp3", "opus", "pcm_s16le", "flac"):
            f.append("EXOTIC_AUDIO_CODEC")
    if pr["duration_s"] > T["max_duration_s"]:
        f.append("OVERLONG")
    if n_aud > 1:
        f.append("MULTI_AUDIO")
    if n_sub:
        f.append("EMBEDDED_SUBS")
    if (pr.get("container") or "") in ("avi", "matroska,webm", "mpegts") and \
            vv["codec"] in ("mpeg4", "mpeg2video"):
        f.append("LEGACY_CODEC")

    # 黑边检测（只在需要时跑，避免每条都花 3 秒）
    if (vv["width"] or 0) != (vv["height"] or 0):
        c = cropdetect(path)
        if c:
            w, h, x, y = (int(i) for i in c.split(":"))
            if w * h < 0.92 * vv["width"] * vv["height"]:
                f.append("LETTERBOXED")
                pr["raw_notes"]["crop"] = c

    ok, err = sample_decode_ok(path)
    if not ok:
        f.append("TRUNCATED_OR_CORRUPT")
        pr["raw_notes"]["decode_error"] = err[:300]

    pr["flags"] = sorted(set(f))
    return pr


# ══════════════════════════════════════════════════════ decide
def decide(pr: dict) -> dict:
    """纯决策：标记 → 动作 + 错误码。不碰文件。"""
    plan = {"asset_id": Path(pr["path"]).stem, "actions": [], "warnings": [],
            "error": None, "severity": "ok", "reasons": []}
    f = set(pr["flags"])
    a = plan["actions"]

    def add(act, why):
        if act not in a:
            a.append(act)
        plan["reasons"].append(f"{act} ← {why}")

    # ── 硬失败 ──
    if "EMPTY_FILE" in f:
        return {**plan, "error": "E_INPUT_UNREADABLE", "severity": "block",
                "warnings": ["文件为 0 字节，通常是下载/上传中断"]}
    if "UNREADABLE" in f:
        return {**plan, "error": "E_INPUT_UNREADABLE", "severity": "block",
                "warnings": [pr["raw_notes"].get("ffprobe", "")]}
    if "AUDIO_ONLY" in f:
        return {**plan, "error": "E_INPUT_AUDIO_ONLY", "severity": "block",
                "warnings": ["纯音频文件被投递到视频素材位；请改用音频轨接口"]}
    if "TRUNCATED_OR_CORRUPT" in f:
        return {**plan, "error": "E_INPUT_TRUNCATED", "severity": "block",
                "warnings": ["抽样解码失败，文件可能被截断或损坏",
                             pr["raw_notes"].get("decode_error", "")]}
    if "OVERLONG" in f:
        plan["error"] = "E_INPUT_OVERLONG"
        plan["severity"] = "block"
        plan["warnings"].append(
            f"时长 {pr['duration_s']:.0f}s 超过 {T['max_duration_s']}s 上限，需人工确认后再入队")
        return plan

    # ── 归一化 ──
    v = pr["video"]
    if "INTERLACED" in f:
        add("DEINTERLACE", f"field_order={v['field_order']}")
    if "VFR" in f:
        add("CFR", f"r_fps={v['fps']:.3f} ≠ avg_fps={v['avg_fps']:.3f}（时间戳不连续）")
    elif "HIGH_FPS" in f:
        add("DECIMATE", f"{v['fps']:.0f}fps → 30fps")
    elif v["fps"] and abs(v["fps"] - T["fps"]) > 0.01:
        add("CFR", f"{v['fps']:.3f}fps → {T['fps']}fps")
    if "HDR" in f:
        add("TONEMAP_HDR", f"transfer={v['color_transfer']} / primaries={v['color_primaries']}")
        plan["warnings"].append(
            "HDR 走 colorspace 直转而非 tone curve；正式产品应换 libplacebo 或 zimg")
    if "UNTAGGED_DEEP_COLOR" in f:
        plan["warnings"].append(
            f"{v['bit_depth']}bit 且无色彩标记：按 BT.709 解释，可能与拍摄意图不符，建议人工复核")
    if "ROTATION" in f:
        plan["warnings"].append(
            f"显示矩阵 rotation={v['rotation']:.0f}°，由解码器自动应用，输出已清除元数据")
    if "LETTERBOXED" in f:
        add("CROP_PILLARBOX", f"内容区 {pr['raw_notes']['crop']} 小于画布")
    if "ANAMORPHIC" in f:
        add("SQUARE_PIXELS", f"SAR={v['sar']}，不方形化会变形")
    if max(v["width"] or 0, v["height"] or 0) > T["long_edge"]:
        add("CAP_LONG_EDGE", f"{v['width']}×{v['height']} 长边超 {T['long_edge']}")
    if "ODD_DIMENSIONS" in f:
        # 裁掉而非拉伸：奇数边偶数化一定丢 1px，丢掉比变形好
        add("FIX_ODD", f"{v['width']}×{v['height']} 含奇数边")
    if (v["pix_fmt"] or "") not in ("yuv420p",):
        add("FORMAT_YUV420P", f"pix_fmt={v['pix_fmt']}")
    if "COLOR_UNTAGGED" in f and "HDR" not in f:
        add("TAG_COLOR", "色彩标记缺失，无法 passthrough")

    if "NO_AUDIO" in f:
        add("AUDIO_SYNTH", "无音轨")
        plan["warnings"].append("已补静音轨；模板若依赖音频节拍需人工确认")
    else:
        au = pr["audio"]
        if "SURROUND" in f:
            add("AUDIO_DOWNMIX", f"{au['channels']}ch {au['layout']}")
        elif "MONO" in f:
            add("AUDIO_UPMIX", "mono")
        if int(au.get("rate") or 0) != T["sample_rate"]:
            add("AUDIO_RESAMPLE", f"{au['rate']}Hz → 48000Hz")
        if "MULTI_AUDIO" in f:
            add("AUDIO_PICK_FIRST", f"{pr['streams']['audio']} 条音轨")
            plan["warnings"].append("多音轨只保留第一条；如需配音轨请在 IR 里显式指定")
        if "AUDIO_VIDEO_DUR_MISMATCH" in f:
            plan["warnings"].append(
                f"音视频时长差 {abs(pr['duration_s'] - au['duration_s']):.2f}s，已按视频对齐")

    if "EMBEDDED_SUBS" in f:
        add("DROP_SUBS", f"{pr['streams']['subtitle']} 条字幕轨")
        plan["warnings"].append(
            "内嵌字幕未烧录进画面，也未转成字幕资产；如需保留请走字幕资产通道")
    if "LEGACY_CODEC" in f:
        plan["warnings"].append(f"老编码 {v['codec']} / {pr.get('container')}，需转码（已默认转码）")
    if "LOW_FPS" in f:
        plan["warnings"].append(f"{v['fps']:.0f}fps 低帧率素材，补帧到 30 会有重复帧")

    plan["severity"] = "warn" if plan["warnings"] else "ok"
    return plan


# ══════════════════════════════════════════════════════ normalize
def vf_chain(pr: dict, plan: dict) -> str:
    v = pr["video"]
    a = set(plan["actions"])
    ch: list[str] = []
    if "DEINTERLACE" in a:
        ch.append("yadif=mode=send_frame:parity=auto:deint=all")
    if "CFR" in a or "DECIMATE" in a:
        ch.append(f"fps={T['fps']}")
    if "TONEMAP_HDR" in a:
        ch.append("colorspace=iall=bt2020:all=bt709:fast=1")
    if "CROP_PILLARBOX" in a:
        ch.append(f"crop={pr['raw_notes']['crop']}")
    # 先方形化像素（保持 DAR），再限制长边
    ch.append("scale=w='trunc(ih*dar/2)*2':h=ih:flags=bicubic,setsar=1")
    if "CAP_LONG_EDGE" in a:
        ch.append(f"scale=w='if(gte(iw,ih),min({T['long_edge']},iw),-2)'"
                  f":h='if(gte(iw,ih),-2,min({T['long_edge']},ih))':flags=bicubic")
    if "FIX_ODD" in a:
        ch.append("crop=trunc(iw/2)*2:trunc(ih/2)*2")
    ch.append(f"format={T['pix_fmt']}")
    ch.append("setsar=1")
    return ",".join(ch)


def af_chain(pr: dict, plan: dict) -> str:
    a = set(plan["actions"])
    ch: list[str] = []
    if "AUDIO_DOWNMIX" in a:
        ch.append("pan=stereo|FL=0.5*FL+0.707*FC+0.707*BL|FR=0.5*FR+0.707*FC+0.707*BR")
    elif "AUDIO_UPMIX" in a:
        ch.append("pan=stereo|FL=c0|FR=c0")
    ch.append(f"aresample={T['sample_rate']}")
    ch.append("aformat=sample_fmts=fltp:channel_layouts=stereo")
    return ",".join(ch)


def normalize(pr: dict, plan: dict, out: Path) -> dict:
    res = {"asset_id": plan["asset_id"], "out": str(out), "ok": False, "error": None}
    if plan["severity"] == "block":
        res["error"] = plan["error"]
        res["skipped"] = True
        return res

    v = pr["video"]
    synth = "AUDIO_SYNTH" in plan["actions"]
    dur = min(pr["duration_s"], T["max_duration_s"])
    passthrough = not plan["actions"]        # 干净素材：零转码，只重封装

    argv = ["ffmpeg", "-y", "-v", "error", "-nostdin", "-i", str(pr["path"])]
    if synth:
        argv += ["-f", "lavfi", "-i",
                 f"anullsrc=channel_layout=stereo:sample_rate={T['sample_rate']}"]
    argv += ["-map", "0:v:0"]
    argv += ["-map", "1:a:0"] if synth else ["-map", "0:a:0"]
    argv += ["-t", f"{dur:.3f}"]
    if passthrough:
        argv += ["-c", "copy"]
    else:
        argv += ["-vf", vf_chain(pr, plan)]
        argv += [] if synth else ["-af", af_chain(pr, plan)]
        argv += ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(T["crf"]),
                 "-pix_fmt", T["pix_fmt"], "-profile:v", "high", "-g", "60"]
        argv += COLOR_TAG_BT709
        argv += ["-c:a", "aac", "-ar", str(T["sample_rate"]), "-ac", "2", "-b:a", "192k"]
    argv += ["-movflags", "+faststart", "-map_metadata", "-1",
             "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"]
    argv += [str(out)]

    rc, err = run(argv, timeout=900)
    if rc != 0:
        res["error"] = "E_NORMALIZE_FAILED"
        res["stderr"] = err[-500:]
        return res

    # 归一化后校验：canonical 规格必须成立
    post = probe(out)
    checks = {
        "pix_fmt_yuv420p": (post["video"] or {}).get("pix_fmt") == "yuv420p",
        "sar_1_1": (post["video"] or {}).get("sar") == "1:1",
        "fps_30": abs(((post["video"] or {}).get("fps") or 0) - 30) < 0.01,
        "has_audio": post["audio"] is not None,
        "audio_48k": (post["audio"] or {}).get("rate") == 48000,
        "audio_stereo": (post["audio"] or {}).get("channels") == 2,
        "color_tagged": (post["video"] or {}).get("color_space") == "bt709",
        "even_dims": (post["video"] or {}).get("width", 0) % 2 == 0
                      and (post["video"] or {}).get("height", 0) % 2 == 0,
    }
    res["ok"] = all(checks.values())
    res["checks"] = checks
    res["passthrough"] = passthrough
    if not res["ok"]:
        res["error"] = "E_OUTPUT_INVALID"
    res["post"] = {k: (post["video"] or {}).get(k) for k in
                   ("width", "height", "pix_fmt", "fps", "sar", "color_space")}
    res["post"]["audio"] = post.get("audio")
    res["size"] = out.stat().st_size if out.exists() else 0
    return res


# ══════════════════════════════════════════════════════ pipeline
def load_corpus() -> list[Path]:
    if MANIFEST.exists():
        man = json.loads(MANIFEST.read_text())
        return [Path(m["path"]) for m in man if Path(m["path"]).exists()]
    return sorted(p for p in CORPUS.glob("*") if p.is_file() and not p.name.startswith("_"))


def cmd_all(args) -> None:
    for d in (P_DIR, L_DIR, M_DIR):
        d.mkdir(parents=True, exist_ok=True)
    files = load_corpus()
    print(f"语料 {len(files)} 条\n")

    rows = []
    for i, path in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {path.name}")
        pr = probe(path)
        plan = decide(pr)
        (P_DIR / f"{path.stem}.json").write_text(json.dumps(pr, ensure_ascii=False, indent=2))
        (L_DIR / f"{path.stem}.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2))

        out = M_DIR / f"{path.stem}.mp4"
        r = normalize(pr, plan, out)
        print(f"    标记 {','.join(pr['flags']) or '-'}")
        print(f"    决策 {r['error'] or 'OK':24} 动作 {len(plan['actions'])} 条")

        rows.append({
            "id": path.stem, "file": path.name, "size": pr["size"],
            "container": pr.get("container"),
            "flags": pr["flags"], "actions": plan["actions"],
            "error": plan["error"] if plan["severity"] == "block" else r["error"],
            "severity": plan["severity"],
            "warnings": plan["warnings"],
            "reasons": plan["reasons"],
            "normalized_ok": r.get("ok", False),
            "checks": r.get("checks"),
            "post": r.get("post"),
            "probe_video": pr.get("video"),
            "probe_audio": pr.get("audio"),
            "duration_s": pr.get("duration_s"),
        })

    RES.mkdir(parents=True, exist_ok=True)
    (RES / "matrix.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")

    # ── summary ──
    blocked = [r for r in rows if r["severity"] == "block"]
    warned = [r for r in rows if r["severity"] == "warn"]
    oknorm = [r for r in rows if r["normalized_ok"]]
    clean = [r for r in rows if not r["flags"]]
    print("\n" + "═" * 62)
    print(f"语料 {len(rows)} 条")
    print(f"  零标记（干净素材）     {len(clean)}")
    print(f"  需归一化              {len([r for r in rows if r['actions'] and r['severity'] != 'block'])}")
    print(f"  归一化成功            {len(oknorm)}")
    print(f"  带警告                {len(warned)}")
    print(f"  硬失败（拒绝入队）      {len(blocked)}")
    for r in blocked:
        print(f"     - {r['id']:22} {r['error']}")
    bad = [r for r in rows if r["severity"] != "block" and not r["normalized_ok"]]
    if bad:
        print("  归一化未通过校验：")
        for r in bad:
            print(f"     - {r['id']:22} {r['error']} {r.get('checks')}")
    print("═" * 62)
    print(f"矩阵 → {RES / 'matrix.json'}")


def cmd_one(args) -> None:
    path = Path(args.path)
    pr = probe(path)
    plan = decide(pr)
    print(json.dumps({"probe": pr, "plan": plan}, ensure_ascii=False, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("all").set_defaults(fn=cmd_all)
    sub.add_parser("matrix").set_defaults(fn=cmd_all)
    p = sub.add_parser("one")
    p.add_argument("path")
    p.set_defaults(fn=cmd_one)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
