"""IR（时间线中间表示）的校验、规范化与内容哈希。

三条硬约束写进校验器，而不是写在文档里：
  · 时间是整数帧
  · 素材用内容寻址（sha256）
  · 不可表达的结构直接报错，不静默降级
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from . import IR_VERSION
from .errors import Problem

CODECS_V = {"h264", "hevc", "av1"}
CODECS_A = {"aac", "opus"}
PIX_FMTS = {"yuv420p", "yuv422p10le", "yuv420p10le"}
TRACK_KINDS = {"video", "overlay", "text", "audio", "subtitle"}
# blur：背景用同一素材放大+高斯模糊铺满，前景完整缩放居中 —— 横版素材上竖版
# 的标准做法。cover 会裁掉两侧（16:9 → 9:16 只剩中间 31% 宽度），
# contain 会留黑边；blur 既保留完整画面又不浪费屏幕。
FITS = {"cover", "contain", "stretch", "blur"}
ASSET_KINDS = {"video", "audio", "image", "subtitle"}
# 故意只暴露稳定的 xfade 子集：xfade 支持的 transition 有 40+ 种，
# 但一部分在不同 ffmpeg 版本间行为不一致（custom/zoomin/hblur 等）。
# 这里只放语义明确、跨版本稳定的八个。
TRANSITIONS = {"fade", "dissolve", "wipeleft", "wiperight",
               "slideup", "slidedown", "circleopen", "fadeblack"}
MAX_FRAMES = 216_000          # 2 小时 @30fps
HEX64 = re.compile(r"^[a-f0-9]{64}$")
COLOR = re.compile(r"^#[0-9A-Fa-f]{6}(@[0-9.]+)?$")
ID = re.compile(r"^[a-z0-9_]{3,64}$")


def _p(field: str, code: str, msg: str, allowed: list[Any] | None = None) -> Problem:
    return Problem(field, code, msg, allowed or [])


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate(ir: Any) -> list[Problem]:
    """返回全部问题，而不是遇到第一个就抛。一次给全，调用方才能一次改完。"""
    ps: list[Problem] = []
    if not isinstance(ir, dict):
        return [_p("$", "E_IR_INVALID", "IR 必须是 JSON 对象")]

    if ir.get("ir_version") != IR_VERSION:
        ps.append(_p("ir_version", "E_IR_INVALID",
                     f"ir_version 必须为 {IR_VERSION}", [IR_VERSION]))
    if not isinstance(ir.get("id"), str) or not ID.match(ir.get("id", "")):
        ps.append(_p("id", "E_IR_INVALID", "id 必须是 3-64 位小写字母/数字/下划线"))

    out = ir.get("output")
    if not isinstance(out, dict):
        ps.append(_p("output", "E_IR_INVALID", "缺少 output"))
        return ps

    w, h = out.get("width"), out.get("height")
    for name, val in (("width", w), ("height", h)):
        if not _is_int(val) or not (16 <= val <= 4096):
            ps.append(_p(f"output.{name}", "E_IR_INVALID", f"{name} 必须是 16-4096 的整数"))
        elif val % 2:
            ps.append(_p(f"output.{name}", "E_IR_INVALID",
                         f"{name} 必须为偶数（yuv420p 要求）"))

    fps = out.get("fps") or {}
    if not isinstance(fps, dict) or not _is_int(fps.get("num")) or not _is_int(fps.get("den")) \
            or fps.get("num", 0) <= 0 or fps.get("den", 0) <= 0:
        ps.append(_p("output.fps", "E_IR_INVALID", "fps 必须是 {num, den} 正整数对"))

    dur = out.get("duration_frames")
    if not _is_int(dur) or not (1 <= dur <= MAX_FRAMES):
        ps.append(_p("output.duration_frames", "E_IR_INVALID",
                     f"duration_frames 必须是 1-{MAX_FRAMES} 的整数"))

    v = out.get("video") or {}
    if v.get("codec") not in CODECS_V:
        ps.append(_p("output.video.codec", "E_IR_INVALID", "不支持的视频编码",
                     sorted(CODECS_V)))
    if not _is_int(v.get("bitrate_kbps")) or not (200 <= v.get("bitrate_kbps", 0) <= 80_000):
        ps.append(_p("output.video.bitrate_kbps", "E_IR_INVALID",
                     "bitrate_kbps 必须是 200-80000 的整数"))
    if v.get("pix_fmt") not in PIX_FMTS:
        ps.append(_p("output.video.pix_fmt", "E_IR_INVALID", "不支持的像素格式",
                     sorted(PIX_FMTS)))

    a = out.get("audio") or {}
    if a.get("codec") not in CODECS_A:
        ps.append(_p("output.audio.codec", "E_IR_INVALID", "不支持的音频编码",
                     sorted(CODECS_A)))
    if a.get("sample_rate") not in (44100, 48000):
        ps.append(_p("output.audio.sample_rate", "E_IR_INVALID",
                     "sample_rate 只能是 44100 或 48000", [44100, 48000]))
    if a.get("channels") not in (1, 2):
        ps.append(_p("output.audio.channels", "E_IR_INVALID",
                     "channels 只能是 1 或 2", [1, 2]))

    color = out.get("color") or {}
    for k, want in (("primaries", "bt709"), ("transfer", "bt709"),
                    ("matrix", "bt709"), ("range", "tv")):
        if color.get(k) not in (None, want):
            ps.append(_p(f"output.color.{k}", "E_IR_INVALID",
                         f"本版本只支持 {want}", [want]))

    # ── 素材 ──
    assets = ir.get("assets")
    if not isinstance(assets, list) or not assets:
        ps.append(_p("assets", "E_IR_INVALID", "assets 必须是非空数组"))
        assets = []
    seen: set[str] = set()
    by_id: dict[str, dict] = {}
    for i, asset in enumerate(assets):
        f = f"assets[{i}]"
        if not isinstance(asset, dict):
            ps.append(_p(f, "E_IR_INVALID", "素材项必须是对象"))
            continue
        aid = asset.get("id")
        if not isinstance(aid, str) or not aid:
            ps.append(_p(f"{f}.id", "E_IR_INVALID", "素材 id 必填"))
        elif aid in seen:
            ps.append(_p(f"{f}.id", "E_IR_INVALID", f"素材 id 重复: {aid}"))
        else:
            seen.add(aid)
            by_id[aid] = asset
        if not isinstance(asset.get("uri"), str) or not asset["uri"]:
            ps.append(_p(f"{f}.uri", "E_IR_INVALID", "素材 uri 必填"))
        sha = asset.get("sha256")
        if sha and not (isinstance(sha, str) and HEX64.match(sha)):
            ps.append(_p(f"{f}.sha256", "E_IR_INVALID", "sha256 必须是 64 位十六进制"))
        if asset.get("kind") is not None and asset["kind"] not in ASSET_KINDS:
            ps.append(_p(f"{f}.kind", "E_IR_INVALID", "不支持的素材类型",
                         sorted(ASSET_KINDS)))

    # ── 样式 ──
    styles = ir.get("styles") or {}
    if not isinstance(styles, dict):
        ps.append(_p("styles", "E_IR_INVALID", "styles 必须是对象"))
        styles = {}
    for key, st in styles.items():
        f = f"styles.{key}"
        if not isinstance(st, dict):
            ps.append(_p(f, "E_IR_INVALID", "样式必须是对象"))
            continue
        if not isinstance(st.get("font_family"), str) or not st["font_family"]:
            ps.append(_p(f"{f}.font_family", "E_IR_INVALID", "font_family 必填"))
        size = st.get("font_size")
        if not _is_int(size) or not (8 <= size <= 400):
            ps.append(_p(f"{f}.font_size", "E_IR_INVALID", "font_size 必须是 8-400 的整数"))
        if not isinstance(st.get("fill"), str) or not COLOR.match(st["fill"]):
            ps.append(_p(f"{f}.fill", "E_IR_INVALID", "fill 必须形如 #RRGGBB 或 #RRGGBB@0.8"))
        if st.get("stroke") and not COLOR.match(str(st["stroke"])):
            ps.append(_p(f"{f}.stroke", "E_IR_INVALID", "stroke 必须形如 #RRGGBB"))

    # ── 轨道 ──
    tracks = ir.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        ps.append(_p("tracks", "E_IR_INVALID", "tracks 必须是非空数组"))
        return ps

    for ti, track in enumerate(tracks):
        f = f"tracks[{ti}]"
        if not isinstance(track, dict):
            ps.append(_p(f, "E_IR_INVALID", "轨道必须是对象"))
            continue
        kind = track.get("kind")
        if kind not in TRACK_KINDS:
            ps.append(_p(f"{f}.kind", "E_IR_INVALID", "不支持的轨道类型",
                         sorted(TRACK_KINDS)))
            continue
        clips = track.get("clips")
        if not isinstance(clips, list) or not clips:
            ps.append(_p(f"{f}.clips", "E_IR_INVALID", "clips 必须是非空数组"))
            continue

        cursor = 0
        prev_at = 0
        ordered = sorted(clips, key=lambda c: c.get("at_frame", 0) if isinstance(c, dict) else 0)
        for ci, clip in enumerate(ordered):
            cf = f"{f}.clips[{ci}]"
            if not isinstance(clip, dict):
                ps.append(_p(cf, "E_IR_INVALID", "clip 必须是对象"))
                continue
            at, oat = clip.get("at_frame"), clip.get("out_frame")
            if not _is_int(at) or at < 0:
                ps.append(_p(f"{cf}.at_frame", "E_IR_INVALID", "at_frame 必须是 >=0 的整数帧"))
                continue
            if not _is_int(oat) or oat <= at:
                ps.append(_p(f"{cf}.out_frame", "E_IR_INVALID",
                             "out_frame 必须大于 at_frame（整数帧）",
                             [at + 1, at + max(1, (dur or 1) - at)]))
                continue
            if _is_int(dur) and oat > dur:
                ps.append(_p(f"{cf}.out_frame", "E_IR_INVALID",
                             f"out_frame 超出 duration_frames={dur}", [dur]))
            if clip.get("in_frame") is not None and (
                    not _is_int(clip["in_frame"]) or clip["in_frame"] < 0):
                ps.append(_p(f"{cf}.in_frame", "E_IR_INVALID", "in_frame 必须是 >=0 的整数帧"))
            if clip.get("fit") and clip["fit"] not in FITS:
                ps.append(_p(f"{cf}.fit", "E_IR_INVALID", "不支持的 fit", sorted(FITS)))
            sp = clip.get("speed", 1.0)
            if not _is_num(sp) or sp <= 0:
                ps.append(_p(f"{cf}.speed", "E_IR_INVALID", "speed 必须 > 0"))
            vol = clip.get("volume")
            if vol is not None:
                if not _is_num(vol) or not (0.0 <= vol <= 4.0):
                    ps.append(_p(f"{cf}.volume", "E_IR_INVALID",
                                 "volume 必须是 0-4 的数值（1.0 为原始音量）",
                                 [0.0, 1.0, 2.0]))
                elif kind != "audio":
                    ps.append(_p(f"{cf}.volume", "E_IR_UNSUPPORTED",
                                 "volume 只对 audio 轨有效", ["audio"]))
            tr = clip.get("transition_in")
            if tr is not None:
                tf = f"{cf}.transition_in"
                if kind not in ("video", "overlay"):
                    ps.append(_p(tf, "E_IR_UNSUPPORTED",
                                 "transition_in 只对 video / overlay 轨有效",
                                 ["video", "overlay"]))
                elif ci == 0:
                    ps.append(_p(tf, "E_IR_INVALID",
                                 "轨道第一段不能有 transition_in（没有前一段可衔接）"))
                elif not isinstance(tr, dict):
                    ps.append(_p(tf, "E_IR_INVALID", "transition_in 必须是对象"))
                else:
                    if tr.get("type") not in TRANSITIONS:
                        ps.append(_p(f"{tf}.type", "E_IR_INVALID",
                                     "不支持的转场", sorted(TRANSITIONS)))
                    nf = tr.get("frames")
                    if not _is_int(nf) or nf <= 0:
                        ps.append(_p(f"{tf}.frames", "E_IR_INVALID",
                                     "frames 必须是正整数"))
                    elif _is_int(at) and nf >= (oat - at):
                        ps.append(_p(f"{tf}.frames", "E_IR_INVALID",
                                     "转场帧数必须小于本段长度",
                                     [1, max(1, (oat - at) - 1)]))

            if kind in ("video", "overlay", "audio"):
                aid = clip.get("asset")
                if not isinstance(aid, str) or aid not in seen:
                    ps.append(_p(f"{cf}.asset", "E_IR_INVALID",
                                 "asset 必须是 assets[].id 之一", sorted(seen)))
            if kind == "text":
                if not isinstance(clip.get("text"), str) or not clip["text"].strip():
                    ps.append(_p(f"{cf}.text", "E_IR_INVALID", "text 不能为空"))
                if clip.get("style") not in styles:
                    ps.append(_p(f"{cf}.style", "E_IR_INVALID",
                                 "style 必须是 styles 的 key", sorted(styles)))
            if kind == "subtitle":
                sub = clip.get("asset")
                if not isinstance(sub, str) or sub not in seen:
                    ps.append(_p(f"{cf}.asset", "E_IR_INVALID",
                                 "字幕轨的 asset 必须是 assets[].id", sorted(seen)))
                elif by_id.get(sub, {}).get("kind") != "subtitle":
                    ps.append(_p(f"{cf}.asset", "E_IR_INVALID",
                                 "该素材不是字幕（assets[].kind 需为 subtitle）",
                                 ["subtitle"]))
                if clip.get("style") not in styles:
                    ps.append(_p(f"{cf}.style", "E_IR_INVALID",
                                 "style 必须是 styles 的 key", sorted(styles)))

            # 视频/叠加轨必须连续铺满，不允许空洞。
            # 转场会让本段与前段**重叠** N 帧（交叉淡化需要两段同时存在），
            # 所以合法位置是 cursor 或 cursor - N。除此之外都是空洞/重叠错误。
            if kind in ("video", "overlay"):
                tr_n = 0
                tr = clip.get("transition_in")
                if isinstance(tr, dict) and _is_int(tr.get("frames")):
                    tr_n = int(tr["frames"])
                prev_len = cursor - prev_at if ci else 0
                if tr_n:
                    if at != cursor - tr_n:
                        ps.append(_p(f"{cf}.at_frame", "E_IR_UNSUPPORTED",
                                     f"带 {tr_n} 帧转场的段应从帧 {cursor - tr_n} 开始"
                                     f"（与前段重叠），实际是 {at}",
                                     [cursor - tr_n]))
                    elif tr_n >= prev_len:
                        ps.append(_p(f"{cf}.transition_in.frames", "E_IR_INVALID",
                                     "转场帧数必须小于前一段长度",
                                     [1, max(1, prev_len - 1)]))
                elif at != cursor:
                    ps.append(_p(f"{cf}.at_frame", "E_IR_UNSUPPORTED",
                                 f"轨道在帧 {cursor} 处有空洞（本版本要求连续铺满）",
                                 [cursor]))
                prev_at = at
                cursor = oat
            if kind == "audio" and _is_int(dur) and oat > dur:
                ps.append(_p(f"{cf}.out_frame", "E_IR_INVALID", "音轨超出总时长"))

        if kind in ("video", "overlay") and _is_int(dur) and cursor != dur:
            ps.append(_p(f"{f}.clips", "E_IR_UNSUPPORTED",
                         f"轨道结束于帧 {cursor}，与 duration_frames={dur} 不符", [dur]))

    return ps


def normalize(ir: dict) -> dict:
    """补默认值，返回新对象。哈希与编译都基于规范化后的结果。"""
    out = json.loads(json.dumps(ir))          # deep copy
    o = out.setdefault("output", {})
    o.setdefault("color", {"primaries": "bt709", "transfer": "bt709",
                           "matrix": "bt709", "range": "tv"})
    v = o.setdefault("video", {})
    v.setdefault("bitrate_kbps", 8000)
    v.setdefault("pix_fmt", "yuv420p")
    v.setdefault("preset", "veryfast")
    v.setdefault("crf", 20)
    v.setdefault("gop_frames", 60)
    a = o.setdefault("audio", {})
    a.setdefault("codec", "aac")
    a.setdefault("sample_rate", 48000)
    a.setdefault("channels", 2)
    a.setdefault("bitrate_kbps", 192)
    a.setdefault("target_lufs", -14.0)
    out.setdefault("styles", {})
    out.setdefault("assets", [])
    out.setdefault("tracks", [])
    for st in out["styles"].values():
        st.setdefault("align", "center")
        st.setdefault("anchor", "center")
        st.setdefault("offset_y", 0)
        st.setdefault("safe_area", {"top": 0.08, "bottom": 0.12,
                                    "left": 0.06, "right": 0.06})
    for t in out["tracks"]:
        for c in t.get("clips", []):
            c.setdefault("in_frame", 0)
            c.setdefault("fit", "cover")
            c.setdefault("speed", 1.0)
    return out


def canonical_json(ir: dict) -> str:
    return json.dumps(ir, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def content_hash(ir: dict, *, backend: str, engine: str, font_fp: str,
                 target_fp: str) -> str:
    """内容寻址的缓存键。

    必须把引擎版本和字体指纹算进去——否则升级引擎或换字体后会命中旧缓存，
    返回一支跟当前代码不一致的片子，这是最难查的一类 bug。
    """
    payload = {
        "ir": {k: v for k, v in ir.items() if k != "id"},
        "assets": sorted((a.get("sha256") or a.get("uri"), a["id"])
                         for a in ir.get("assets", [])),
        "backend": backend,
        "engine": engine,
        "fonts": font_fp,
        "target": target_fp,
    }
    return hashlib.sha256(canonical_json(payload).encode()).hexdigest()


def duration_seconds(ir: dict) -> float:
    o = ir["output"]
    return o["duration_frames"] / (o["fps"]["num"] / o["fps"]["den"])


def frame_to_seconds(ir: dict, frame: int) -> float:
    f = ir["output"]["fps"]
    return frame * f["den"] / f["num"]


def all_text(ir: dict) -> str:
    parts = []
    for t in ir.get("tracks", []):
        if t.get("kind") != "text":
            continue
        for c in t.get("clips", []):
            parts.append(c.get("text", ""))
    return "\n".join(parts)
