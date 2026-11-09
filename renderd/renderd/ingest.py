"""输入归一化：probe → decide → normalize。

三段式刻意分开，因为「探测到 HDR 就直接转 SDR」写在一个函数里，你永远无法回答
「这条素材为什么被转成了这样」。拆开之后，决策是一份能 review、能入库、能回放的
JSON —— 出事时能对账。

与 P0 阶段 cutproof/ingest.py 的关系：那里是验证引擎，这里是产品化实现。差别：
  1. 目标 fps 取自 IR（不是写死 30），否则 trim=start_frame 的帧号语义会错；
  2. HDR 用 zscale + tonemap（两端 ffmpeg 实测可用），不再用 colorspace 直转；
  3. 产物内容寻址缓存，同素材只归一化一次；
  4. 决策与实测规格都进 receipt 的 L0_ingest，禁止静默改变素材语义；
  5. 抽样解码在提交预检阶段就跑，截断文件不会等到 worker 才失败。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

from .config import Config
from .errors import JobError

# 动作 -> 人话。写进 receipt，客户能看懂「我的素材被怎么了」。
ACT_DESC = {
    "DEINTERLACE": "yadif 反交错（隔行素材先做，否则缩放出横条纹）",
    "CFR": "转恒定帧率（VFR 时间戳断档会导致音画不同步）",
    "DECIMATE": "高帧率降采样到时间线帧率",
    "TONEMAP_HDR": "HDR → BT.709 SDR（zscale 线性光 + hable tone mapping）",
    "BAKE_ROTATION": "把显示旋转矩阵烤进画面并清除元数据",
    "CROP_PILLARBOX": "裁掉非内容黑边",
    "SQUARE_PIXELS": "非方形像素方形化（SAR → 1:1，保持 DAR）",
    "CAP_LONG_EDGE": "长边限制（等比，不裁）",
    "FIX_ODD": "奇数分辨率偶数化（裁 1px，不拉伸）",
    "FORMAT_YUV420P": "统一像素格式 yuv420p",
    "TAG_COLOR": "补写 BT.709 色彩标记（SPS VUI）",
    "AUDIO_DOWNMIX": "5.1 → 立体声（带 pan 系数，保留中置对白）",
    "AUDIO_UPMIX": "单声道 → 立体声",
    "AUDIO_RESAMPLE": "重采样到时间线采样率",
    "AUDIO_SYNTH": "补静音轨（原素材无音轨）",
    "AUDIO_PICK_FIRST": "多音轨取第一条（记录被丢弃的轨）",
    "DROP_SUBS": "丢弃内嵌字幕轨（当前无字幕资产通道）",
    "TRIM_OVERLONG": "超长素材截断",
}

HDR_TRANSFERS = ("arib-std-b67", "smpte2084", "smpte428")

# zscale 线性光 + hable tone mapping。比 colorspace 直转保留更多高光层次。
# 实测宿主机 ffmpeg 9.0.2 与容器 ffmpeg 7.1.5 均可用。
HDR_CHAIN = ("zscale=t=linear:npl=100,format=gbrpf32le,"
             "tonemap=tonemap=hable:desat=0,"
             "zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p")

# 坑：libx264 单给 -color_primaries 不会写进 SPS VUI，ffprobe 会读到
# transfer=unknown，交付后各播放器各显各的。必须同时给 -x264-params。
COLOR_TAG_BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709",
                   "-colorspace", "bt709", "-color_range", "tv",
                   "-x264-params", "colorprim=bt709:transfer=bt709:"
                                    "colormatrix=bt709:range=tv"]


def run(argv: list[str], timeout: int = 900) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except OSError as exc:
        return 127, str(exc)


def _ratio(s: str | None) -> float | None:
    if not s or "/" not in s:
        return None
    try:
        n, d = s.split("/")
        return float(n) / float(d) if float(d) else None
    except (ValueError, ZeroDivisionError):
        return None


def _sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _proc_json(cfg: Config, path: Path) -> dict:
    p = subprocess.run([cfg.ffprobe, "-v", "error", "-print_format", "json",
                         "-show_format", "-show_streams", "-show_error", str(path)],
                        capture_output=True, text=True, timeout=120)
    try:
        return json.loads(p.stdout or "{}")
    except Exception:
        return {}


# ── probe ──────────────────────────────────────────────────────────────
def probe(path: Path, cfg: Config, *, deep: bool = True,
          cropdetect: bool = True) -> dict:
    """只观测，不改动。输出规范化描述 + 风险标记。"""
    path = Path(path)
    st = path.stat()
    pr: dict = {
        "path": str(path), "size": st.st_size,
        "readable": False, "video": None, "audio": None,
        "flags": [], "raw_notes": {}, "container": None, "duration_s": 0.0,
    }
    if st.st_size == 0:
        pr["flags"].append("EMPTY_FILE")
        return pr

    meta = _proc_json(cfg, path)
    if not meta.get("streams"):
        pr["flags"].append("UNREADABLE")
        pr["raw_notes"]["ffprobe"] = (meta.get("error") or {}).get("string", "no streams")
        return pr

    streams = meta["streams"]
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    n_sub = sum(1 for s in streams if s.get("codec_type") == "subtitle")
    n_aud = sum(1 for s in streams if s.get("codec_type") == "audio")
    fmt = meta.get("format") or {}
    pr["readable"] = True
    pr["container"] = fmt.get("format_name")
    pr["duration_s"] = float(fmt.get("duration") or 0)

    if v is None:
        pr["flags"].append("AUDIO_ONLY")
        if a:
            pr["audio"] = {
                "codec": a.get("codec_name"),
                "rate": int(a.get("sample_rate") or 0),
                "channels": a.get("channels"), "layout": a.get("channel_layout"),
                "duration_s": float(a.get("duration") or 0),
            }
        return pr

    rot = 0.0
    for sd in (v.get("side_data_list") or []):
        if "rotation" in sd:
            try:
                rot = float(sd["rotation"])
            except (TypeError, ValueError):
                pass
    if not rot:
        try:
            rot = float((v.get("tags") or {}).get("rotate", 0) or 0)
        except (TypeError, ValueError):
            rot = 0.0

    pf = v.get("pix_fmt") or ""
    pr["video"] = {
        "codec": v.get("codec_name"), "profile": v.get("profile"),
        "width": v.get("width"), "height": v.get("height"),
        "pix_fmt": pf,
        "bit_depth": 10 if pf.endswith("10le") else (12 if pf.endswith("12le") else 8),
        "fps": _ratio(v.get("r_frame_rate")),
        "avg_fps": _ratio(v.get("avg_frame_rate")),
        "field_order": v.get("field_order"),
        "sar": v.get("sample_aspect_ratio"), "dar": v.get("display_aspect_ratio"),
        "color_primaries": v.get("color_primaries"),
        "color_transfer": v.get("color_transfer"),
        "color_space": v.get("color_space"),
        "color_range": v.get("color_range"),
        "rotation": rot,
        "nb_frames": int(v["nb_frames"]) if v.get("nb_frames") else None,
    }
    if a:
        pr["audio"] = {
            "codec": a.get("codec_name"),
            "rate": int(a.get("sample_rate") or 0),
            "channels": a.get("channels"), "layout": a.get("channel_layout"),
            "duration_s": float(a.get("duration") or 0),
        }
    pr["streams"] = {"video": 1, "audio": n_aud, "subtitle": n_sub}

    f = pr["flags"]
    vv = pr["video"]
    if vv["color_transfer"] in HDR_TRANSFERS or vv["color_primaries"] == "bt2020":
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
    if (vv["field_order"] or "progressive") not in ("progressive", "unknown", "tb", "bt"):
        f.append("INTERLACED")
    if abs(vv["rotation"]) > 0.01:
        f.append("ROTATION")
    if vv["sar"] not in (None, "1:1", "0:1"):
        f.append("ANAMORPHIC")
    if (vv["width"] or 0) % 2 or (vv["height"] or 0) % 2:
        f.append("ODD_DIMENSIONS")
    if pf not in ("yuv420p", "yuvj420p"):
        f.append("NONSTANDARD_PIXFMT")
    if not a:
        f.append("NO_AUDIO")
    else:
        if (a.get("channels") or 0) >= 6:
            f.append("SURROUND")
        elif a.get("channels") == 1:
            f.append("MONO")
        if int(a.get("sample_rate") or 0) not in (0, 48000):
            f.append("ODD_SAMPLE_RATE")
        if pr["duration_s"] and pr["audio"].get("duration_s") and \
                abs(pr["duration_s"] - pr["audio"]["duration_s"]) > 0.5:
            f.append("AUDIO_VIDEO_DUR_MISMATCH")
    if n_aud > 1:
        f.append("MULTI_AUDIO")
    if n_sub:
        f.append("EMBEDDED_SUBS")
    if (pr.get("container") or "") in ("avi", "matroska,webm", "mpegts") and \
            vv["codec"] in ("mpeg4", "mpeg2video"):
        f.append("LEGACY_CODEC")

    if deep:
        # 黑边检测只在宽高不等时跑，避免每条素材白花 3 秒
        if cropdetect and (vv["width"] or 0) != (vv["height"] or 0):
            rc, err = run([cfg.ffmpeg, "-v", "info", "-i", str(path), "-t", "3",
                           "-vf", "cropdetect=limit=0.1:round=2:reset=0",
                           "-f", "null", "-"], timeout=90)
            hits = re.findall(r"crop=(\d+:\d+:\d+:\d+)", err)
            if hits:
                w, h, x, y = (int(i) for i in hits[-1].split(":"))
                if w * h < 0.92 * (vv["width"] or 1) * (vv["height"] or 1):
                    f.append("LETTERBOXED")
                    pr["raw_notes"]["crop"] = hits[-1]
        # 抽样解码：ffprobe 元数据完全健康的截断文件，只有真解码才报错
        rc, err = run([cfg.ffmpeg, "-v", "error", "-xerror", "-i", str(path),
                       "-t", "15", "-f", "null", "-"], timeout=120)
        if rc != 0 or re.search(r"error|invalid|corrupt|truncat|partial", err, re.I):
            f.append("TRUNCATED_OR_CORRUPT")
            pr["raw_notes"]["decode_error"] = (err.strip().splitlines() or [""])[-1][:300]

    pr["flags"] = sorted(set(f))
    return pr


# ── decide ─────────────────────────────────────────────────────────────
def subtitle_ids(ir: dict) -> set[str]:
    """字幕素材的 id 集合。归一化/预检必须跳过它们。

    字幕没有音视频流：走 probe → decide 会被判成 AUDIO_ONLY 或 UNREADABLE，
    在提交阶段就把一份正常字幕拒掉。真正的解析在 subtitles.expand()。
    """
    return {a["id"] for a in ir.get("assets", []) if a.get("kind") == "subtitle"}


def decide(pr: dict, cfg: Config, *, target_fps: float, audio_role: bool) -> dict:
    """纯决策：标记 → 动作 + 错误码。不碰文件。"""
    plan: dict = {"actions": [], "warnings": [], "error": None,
                  "severity": "ok", "reasons": []}
    f = set(pr["flags"])
    acts: list[str] = plan["actions"]

    def add(act: str, why: str) -> None:
        if act not in acts:
            acts.append(act)
        plan["reasons"].append(f"{act} ← {why}")

    # ── 硬失败 ──
    if "EMPTY_FILE" in f:
        return {**plan, "error": "E_INPUT_UNREADABLE", "severity": "block",
                "warnings": ["文件为 0 字节，通常是上传中断"]}
    if "UNREADABLE" in f:
        return {**plan, "error": "E_INPUT_UNREADABLE", "severity": "block",
                "warnings": [pr["raw_notes"].get("ffprobe", "ffprobe 无流信息")]}
    if "TRUNCATED_OR_CORRUPT" in f:
        return {**plan, "error": "E_INPUT_TRUNCATED", "severity": "block",
                "warnings": ["抽样解码失败，文件可能被截断或损坏",
                             pr["raw_notes"].get("decode_error", "")]}
    if "AUDIO_ONLY" in f:
        if audio_role:      # 纯音频投到音频轨是合法的
            return {**plan, "severity": "ok"}
        return {**plan, "error": "E_INPUT_AUDIO_ONLY", "severity": "block",
                "warnings": ["纯音频文件被投递到视频素材位；请放到音频轨"]}
    if pr.get("duration_s", 0) > cfg.max_asset_seconds:
        return {**plan, "error": "E_INPUT_OVERLONG", "severity": "block",
                "warnings": [f"时长 {pr['duration_s']:.0f}s 超过 "
                             f"{cfg.max_asset_seconds:.0f}s 上限"]}

    v = pr["video"]
    # ── 视频归一 ──
    if "INTERLACED" in f:
        add("DEINTERLACE", f"field_order={v['field_order']}")
    if "VFR" in f:
        add("CFR", f"r_fps={v['fps']:.3f} ≠ avg_fps={v['avg_fps']:.3f}")
    elif "HIGH_FPS" in f:
        add("DECIMATE", f"{v['fps']:.0f}fps → {target_fps:g}fps")
    elif v["fps"] and abs(v["fps"] - target_fps) > 0.01:
        add("CFR", f"{v['fps']:.3f}fps → {target_fps:g}fps")
    if "HDR" in f:
        add("TONEMAP_HDR", f"transfer={v['color_transfer']} / primaries={v['color_primaries']}")
        plan["warnings"].append(
            "HDR 已做 tone mapping（zscale 线性光 + hable）转 BT.709 SDR；"
            "这是预览级处理，不是广播级调色，高光与创作意图可能有差异")
    if "UNTAGGED_DEEP_COLOR" in f:
        plan["warnings"].append(
            f"{v['bit_depth']}bit 且无色彩标记：按 BT.709 解释，可能与拍摄意图不符")
    if "ROTATION" in f:
        # 必须强制转码：-c copy 会把旋转矩阵原样带下去，下游会当横版处理
        add("BAKE_ROTATION", f"显示矩阵 rotation={v['rotation']:.0f}°")
        plan["warnings"].append(
            f"显示矩阵 rotation={v['rotation']:.0f}° 已烤进画面并清除元数据")
    if "LETTERBOXED" in f:
        add("CROP_PILLARBOX", f"内容区 {pr['raw_notes']['crop']} 小于画布")
    if "ANAMORPHIC" in f:
        add("SQUARE_PIXELS", f"SAR={v['sar']}，不方形化会变形")
    if max(v["width"] or 0, v["height"] or 0) > cfg.target.long_edge:
        add("CAP_LONG_EDGE", f"{v['width']}×{v['height']} 长边超 {cfg.target.long_edge}")
    if "ODD_DIMENSIONS" in f:
        add("FIX_ODD", f"{v['width']}×{v['height']} 含奇数边（裁 1px，不拉伸）")
    if (v["pix_fmt"] or "") not in ("yuv420p",):
        add("FORMAT_YUV420P", f"pix_fmt={v['pix_fmt']}")
    if "COLOR_UNTAGGED" in f and "HDR" not in f:
        add("TAG_COLOR", "色彩标记缺失，无法 passthrough")

    # ── 音频归一 ──
    if "NO_AUDIO" in f:
        add("AUDIO_SYNTH", "无音轨")
        plan["warnings"].append("已补静音轨；模板若依赖音频节拍需人工确认")
    else:
        au = pr["audio"]
        if "SURROUND" in f:
            add("AUDIO_DOWNMIX", f"{au['channels']}ch {au['layout']}")
        elif "MONO" in f:
            add("AUDIO_UPMIX", "mono")
        if int(au.get("rate") or 0) not in (0, cfg.target.sample_rate):
            add("AUDIO_RESAMPLE", f"{au['rate']}Hz → {cfg.target.sample_rate}Hz")
        if "MULTI_AUDIO" in f:
            add("AUDIO_PICK_FIRST", f"{pr['streams']['audio']} 条音轨")
            plan["warnings"].append("多音轨只保留第一条；如需配音轨请在 IR 里显式指定")
        if "AUDIO_VIDEO_DUR_MISMATCH" in f:
            plan["warnings"].append(
                f"音视频时长差 {abs(pr['duration_s'] - au['duration_s']):.2f}s，已按视频对齐")
    if "EMBEDDED_SUBS" in f:
        add("DROP_SUBS", f"{pr['streams']['subtitle']} 条字幕轨")
        plan["warnings"].append("内嵌字幕未烧录也未转成字幕资产；如需保留请走字幕资产通道")
    if "LEGACY_CODEC" in f:
        plan["warnings"].append(f"老编码 {v['codec']} / {pr.get('container')}，已重新编码")
    if "LOW_FPS" in f:
        plan["warnings"].append(f"{v['fps']:.0f}fps 低帧率素材，补帧会有重复帧")

    plan["severity"] = "warn" if plan["warnings"] else "ok"
    return plan


# ── normalize ───────────────────────────────────────────────────────────
def vf_chain(pr: dict, plan: dict, cfg: Config, target_fps: float) -> str:
    v = pr["video"]
    a = set(plan["actions"])
    ch: list[str] = []
    if "DEINTERLACE" in a:
        ch.append("yadif=mode=send_frame:parity=auto:deint=all")
    if "CFR" in a or "DECIMATE" in a:
        ch.append(f"fps={target_fps:g}")
    if "TONEMAP_HDR" in a:
        ch.append(HDR_CHAIN)
    if "CROP_PILLARBOX" in a:
        ch.append(f"crop={pr['raw_notes']['crop']}")
    # 先方形化像素（保持 DAR），再限制长边。顺序反了会把变形固化进画面。
    ch.append("scale=w='trunc(ih*dar/2)*2':h=ih:flags=bicubic,setsar=1")
    if "CAP_LONG_EDGE" in a:
        le = cfg.target.long_edge
        ch.append(f"scale=w='if(gte(iw,ih),min({le},iw),-2)'"
                  f":h='if(gte(iw,ih),-2,min({le},ih))':flags=bicubic")
    if "FIX_ODD" in a:
        ch.append("crop=trunc(iw/2)*2:trunc(ih/2)*2")
    ch.append(f"format={cfg.target.pix_fmt}")
    ch.append("setsar=1")
    return ",".join(ch)


def af_chain(plan: dict, cfg: Config) -> str:
    a = set(plan["actions"])
    ch: list[str] = []
    if "AUDIO_DOWNMIX" in a:
        ch.append("pan=stereo|FL=0.5*FL+0.707*FC+0.707*BL|FR=0.5*FR+0.707*FC+0.707*BR")
    elif "AUDIO_UPMIX" in a:
        ch.append("pan=stereo|FL=c0|FR=c0")
    ch.append(f"aresample={cfg.target.sample_rate}")
    ch.append("aformat=sample_fmts=fltp:channel_layouts=stereo")
    return ",".join(ch)


def normalize(pr: dict, plan: dict, out: Path, cfg: Config, *,
               target_fps: float, audio_role: bool) -> dict:
    res: dict = {"ok": False, "error": None, "actions_applied": list(plan["actions"])}
    if plan["severity"] == "block":
        res["error"], res["skipped"] = plan["error"], True
        return res

    synth = "AUDIO_SYNTH" in plan["actions"]
    dur = min(pr["duration_s"] or 0, cfg.max_asset_seconds)
    passthrough = (not plan["actions"]) and not audio_role

    argv = [cfg.ffmpeg, "-y", "-v", "error", "-nostdin", "-i", str(pr["path"])]
    if synth:
        argv += ["-f", "lavfi", "-i",
                 f"anullsrc=channel_layout=stereo:sample_rate={cfg.target.sample_rate}"]
    if audio_role:
        argv += ["-vn", "-map", "0:a:0"]
    else:
        argv += ["-map", "0:v:0", "-map", "1:a:0" if synth else "0:a:0"]
    if dur > 0:
        argv += ["-t", f"{dur:.3f}"]

    if passthrough:
        argv += ["-c", "copy"]
    else:
        if audio_role:
            if plan["actions"]:
                argv += ["-af", af_chain(plan, cfg)]
        else:
            argv += ["-vf", vf_chain(pr, plan, cfg, target_fps)]
            if not synth:
                argv += ["-af", af_chain(plan, cfg)]
            # 固定线程数 + CRF：ABR 在多线程下字节不确定（见 decisions.md）
            argv += ["-c:v", "libx264", "-preset", cfg.target.preset,
                     "-crf", str(cfg.target.crf), "-threads", "4",
                     "-pix_fmt", cfg.target.pix_fmt, "-profile:v", "high",
                     "-g", str(cfg.target.gop)]
            argv += COLOR_TAG_BT709
        argv += ["-c:a", "aac", "-ar", str(cfg.target.sample_rate),
                 "-ac", str(cfg.target.channels), "-b:a", "192k"]
    argv += ["-movflags", "+faststart", "-map_metadata", "-1",
             "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"]
    argv += [str(out)]

    rc, err = run(argv)
    if rc != 0:
        res["error"] = "E_NORMALIZE_FAILED"
        res["stderr"] = err[-600:]
        return res

    post = probe(out, cfg, deep=False, cropdetect=False)
    vpost = post.get("video") or {}
    apost = post.get("audio") or {}
    checks = {
        "has_audio": post.get("audio") is not None,
        "audio_sample_rate": apost.get("rate") == cfg.target.sample_rate,
        "audio_stereo": apost.get("channels") == 2,
    }
    if not audio_role:
        checks.update({
            "pix_fmt": vpost.get("pix_fmt") == cfg.target.pix_fmt,
            "sar_1_1": vpost.get("sar") == "1:1",
            "fps": abs((vpost.get("fps") or 0) - target_fps) < 0.01,
            "color_tagged": vpost.get("color_space") == "bt709",
            "even_dims": (vpost.get("width") or 0) % 2 == 0
                         and (vpost.get("height") or 0) % 2 == 0,
            "rotation_cleared": abs(float(vpost.get("rotation") or 0)) < 0.01,
        })
    res["ok"] = all(checks.values())
    res["checks"] = checks
    res["passthrough"] = passthrough
    res["post"] = {
        "width": vpost.get("width"), "height": vpost.get("height"),
        "fps": vpost.get("fps"), "frames": round((post.get("duration_s") or 0) * target_fps),
        "duration_s": post.get("duration_s"),
        "pix_fmt": vpost.get("pix_fmt"), "sar": vpost.get("sar"),
        "color_space": vpost.get("color_space"),
        "audio_rate": apost.get("rate"), "audio_channels": apost.get("channels"),
    }
    if not res["ok"]:
        res["error"] = "E_OUTPUT_INVALID"
    res["size"] = out.stat().st_size if out.exists() else 0
    return res


# ── 编排 ───────────────────────────────────────────────────────────────
class Normalizer:
    """对一条 IR 的所有素材做归一化，产物内容寻址缓存。"""

    def __init__(self, cfg: Config, engine: str = ""):
        self.cfg = cfg
        self.engine = engine
        self.root = cfg.data_dir / "mezz"
        self.root.mkdir(parents=True, exist_ok=True)

    def _fingerprint(self, path: Path) -> str:
        st = path.stat()
        return hashlib.sha256(
            f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}|{self.engine}"
            .encode()).hexdigest()[:24]

    def _probe_cached(self, path: Path) -> dict:
        fp = self._fingerprint(path)
        cache = self.root / f"_probe_{fp}.json"
        if cache.exists():
            try:
                return json.loads(cache.read_text())
            except Exception:
                pass
        pr = probe(path, self.cfg, deep=True,
                   cropdetect=self.cfg.ingest_cropdetect)
        pr["fingerprint"] = fp
        cache.write_text(json.dumps(pr, ensure_ascii=False, indent=2))
        return pr

    def precheck(self, ir: dict, media: dict[str, str]) -> dict[str, dict]:
        """提交预检用：只跑 probe + decide，不落中间片。截断文件在这里就被拦下。"""
        target_fps = ir["output"]["fps"]["num"] / ir["output"]["fps"]["den"]
        roles = self._roles(ir)
        out: dict[str, dict] = {}
        subs = subtitle_ids(ir)
        for aid, path in media.items():
            if aid in subs:
                out[aid] = {"flags": [], "actions": [], "warnings": [],
                            "severity": "subtitle", "kind": "subtitle"}
                continue
            pr = self._probe_cached(Path(path))
            plan = decide(pr, self.cfg, target_fps=target_fps,
                          audio_role=roles.get(aid) == "audio")
            if plan["severity"] == "block":
                raise JobError(
                    plan["error"],
                    f"素材 {aid}：" + "；".join(w for w in plan["warnings"] if w)[:220],
                    field=f"assets[{aid}]",
                    hint="换一个完整/可解码的素材重新上传",
                    detail=json.dumps({"flags": pr["flags"], "plan": plan},
                                       ensure_ascii=False)[:1200])
            out[aid] = {"flags": pr["flags"], "actions": plan["actions"],
                        "warnings": plan["warnings"], "severity": plan["severity"]}
        return out

    @staticmethod
    def _roles(ir: dict) -> dict[str, str]:
        roles: dict[str, str] = {}
        for t in ir["tracks"]:
            for c in t.get("clips", []):
                aid = c.get("asset")
                if not aid:
                    continue
                kind = t.get("kind")
                role = "audio" if kind == "audio" else (
                    "overlay" if kind == "overlay" else "video")
                # video 优先级最高：同一素材既当底又当叠加时按底处理
                if aid not in roles or role == "video":
                    roles[aid] = role
        return roles

    def run(self, ir: dict, media: dict[str, str],
            info: dict[str, dict]) -> tuple[dict[str, str], dict, dict[str, dict]]:
        """返回 (归一化后的 media, L0 报告, 更新后的 info)。"""
        if not self.cfg.ingest_normalize:
            return media, {"applicable": False, "reason": "已由配置关闭"}, info

        target_fps = ir["output"]["fps"]["num"] / ir["output"]["fps"]["den"]
        roles = self._roles(ir)
        target_fp = (f"{cfg_fp(self.cfg.target)}:fps={target_fps:g}:"
                     f"engine={self.engine}")
        media2: dict[str, str] = {}
        info2 = {k: dict(v) for k, v in info.items()}
        report: dict = {
            "applicable": True, "target_fps": target_fps,
            "hdr_mode": "zscale+hable", "assets": {}, "warnings": [],
            "digest": "",
        }
        digest_parts: list[str] = []

        subs = subtitle_ids(ir)
        for aid, path_str in media.items():
            if aid in subs:
                media2[aid] = path_str          # 原样透传，交给 subtitles.expand()
                continue
            if roles.get(aid) == "overlay":
                # 叠加层必须保留 alpha，而归一化的编码器是 libx264 ——
                # x264 没有 alpha 通道，重编一次 alpha 就没了（实测：源 argb，
                # 归一化后 yuv420p，叠加变成不透明色块）。所以这里原样透传，
                # 由编译器的 scale/overlay 处理尺寸与像素格式。
                media2[aid] = path_str
                report["assets"][aid] = {"passthrough": True,
                                         "reason": "overlay 素材保留原始像素格式（含 alpha）"}
                report["warnings"].append(
                    f"{aid} 为叠加素材，未做归一化（保留 alpha）；"
                    f"请自行保证尺寸与帧率接近目标，否则会多一次缩放")
                continue
            path = Path(path_str)
            audio_role = roles.get(aid) == "audio"
            pr = self._probe_cached(path)
            plan = decide(pr, self.cfg, target_fps=target_fps,
                          audio_role=audio_role)
            if plan["severity"] == "block":
                raise JobError(
                    plan["error"],
                    f"素材 {aid}：" + "；".join(w for w in plan["warnings"] if w)[:220],
                    field=f"assets[{aid}]")

            key = hashlib.sha256(
                (pr["fingerprint"] + "|" + ",".join(plan["actions"]) + "|"
                 + target_fp + "|" + str(audio_role) + "|"
                 + str(pr["raw_notes"].get("crop", ""))).encode()).hexdigest()[:24]
            mezz = self.root / f"{key}.mp4"
            plan_file = self.root / f"{key}.json"

            if not (mezz.exists() and mezz.stat().st_size > 0 and plan_file.exists()):
                tmp = self.root / f".{key}.tmp.mp4"
                r = normalize(pr, plan, tmp, self.cfg, target_fps=target_fps,
                              audio_role=audio_role)
                if not r.get("ok"):
                    tmp.unlink(missing_ok=True)
                    raise JobError(r.get("error") or "E_NORMALIZE_FAILED",
                                   f"素材 {aid} 归一化未通过自校验",
                                   field=f"assets[{aid}]",
                                   detail=json.dumps(r.get("checks", {}),
                                                     ensure_ascii=False))
                tmp.replace(mezz)
                plan_file.write_text(json.dumps(
                    {"probe": {k: pr[k] for k in ("flags", "container", "duration_s")},
                     "plan": plan, "result": r}, ensure_ascii=False, indent=2))
            saved = json.loads(plan_file.read_text())
            result = saved["result"]

            media2[aid] = str(mezz.resolve())
            post = result.get("post") or {}
            info2[aid] = {
                **info2.get(aid, {}),
                "type": "audio" if audio_role else "video",
                "frames": int(post.get("frames") or info2.get(aid, {}).get("frames") or 0),
                "duration": post.get("duration_s") or info2.get(aid, {}).get("duration"),
                "width": post.get("width"), "height": post.get("height"),
                "normalized": True,
            }
            entry = {
                "flags": pr["flags"],
                "actions": plan["actions"],
                "action_desc": {x: ACT_DESC.get(x, x) for x in plan["actions"]},
                "warnings": plan["warnings"],
                "reasons": plan["reasons"],
                "severity": plan["severity"],
                "passthrough": result.get("passthrough", False),
                "post": post,
                "mezz": mezz.name,
                "bytes": result.get("size"),
            }
            report["assets"][aid] = entry
            report["warnings"] += [f"[{aid}] {w}" for w in plan["warnings"]]
            digest_parts.append(f"{aid}:{key}:{result.get('size')}")

        report["digest"] = hashlib.sha256("|".join(sorted(digest_parts))
                                          .encode()).hexdigest()[:24]
        return media2, report, info2


def cfg_fp(t) -> str:
    return f"{t.long_edge}:{t.pix_fmt}:{t.sample_rate}:{t.channels}:{t.crf}:{t.preset}:{t.gop}"
