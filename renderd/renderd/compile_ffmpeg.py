"""IR → FFmpeg 执行计划。

这一层是「执行计划编译器」，输出的是 argv，不是产品契约。
同一份 IR 也可以编成 MLT XML（见 compile_mlt.py），两者互不影响。
"""

from __future__ import annotations

import hashlib
import json
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from .config import Target
from .errors import JobError
from .ir import duration_seconds
from .textlayer import Layer


@dataclass
class CompiledPlan:
    argv: list[str]
    backend: str = "ffmpeg"
    expected_frames: int = 0
    warnings: list[str] = field(default_factory=list)
    layer_count: int = 0
    filtergraph: str = ""

    def command(self) -> str:
        return " ".join(shlex.quote(a) for a in self.argv)


def _fit_chain(fit: str, w: int, h: int, *, alpha: bool = False) -> str:
    """缩放/填充到目标画幅。alpha=True 时用透明填充，供 overlay 轨使用。"""
    pad_color = "color=#00000000" if alpha else "color=black"
    if fit == "stretch":
        return f"scale={w}:{h}:flags=bicubic,setsar=1"
    if fit == "contain":
        return (f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:{pad_color},setsar=1")
    return (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,"
            f"crop={w}:{h},setsar=1")


# 编码逻辑版本。改动 argv 的构造方式（滤镜、tag、码控参数）时必须 +1。
#
# 为什么需要它：缓存键由 IR 算出，但「同一份 IR 在不同版本的编译器下」会产出
# 不同字节。本次就是实例 —— HEVC tag 从 hev1 改成 hvc1，IR 一个字段都没动，
# 缓存键不变，线上继续返回旧的 hev1 产物（Safari 播不了）。
# 只靠 IR 参数指纹救不了这种情况，必须把编译器自身的版本也编进键。
COMPILE_REV = 5


def encoder_signature(ir: dict) -> str:
    """影响产物的编码参数指纹，供缓存键使用。

    包含两部分：
      · IR 里所有影响字节的编码参数（codec / tag / preset / crf / gop / 音频规格）
      · 编译器自身的版本 COMPILE_REV（改 argv 构造时必须 bump）

    缺任何一半都会让「改了却仍命中旧缓存」重新出现。
    """
    o = ir["output"]
    v, a = o["video"], o["audio"]
    payload = {
        "rev": COMPILE_REV,
        "codec": v["codec"],
        "tag": {"h264": "avc1", "hevc": "hvc1", "av1": "av01"}.get(v["codec"], ""),
        "preset": v.get("preset"),
        "crf": v.get("crf"),
        "gop": v.get("gop_frames"),
        "pix_fmt": v.get("pix_fmt"),
        "maxrate": v.get("bitrate_kbps"),
        "acodec": a.get("codec"),
        "ar": a.get("sample_rate"),
        "ac": a.get("channels"),
        "ab": a.get("bitrate_kbps"),
        "lufs": a.get("target_lufs"),
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def _segment_lines(src: str, head: list[str], fit: str, w: int, h: int,
                   pix_fmt: str, tag: str) -> list[str]:
    """生成一个视频段的滤镜行。

    单独抽出来是因为 `blur` 需要 split 成两路再 overlay，塞不进单条逗号链。
    其余 fit 仍然是一条链。

    blur 的构图：背景 = 同一素材放大裁满 + 高斯模糊 + 压暗；前景 = 完整缩放居中。
    这是横版素材上竖版的标准做法 —— `cover` 会把 16:9 裁到只剩中间约 31% 宽度
    （实测真实 promo 素材两侧文字直接被切掉），`contain` 又会留大片黑边。
    """
    pre = ",".join(head)
    if fit != "blur":
        tail = [_fit_chain(fit, w, h), f"format={pix_fmt}", "setsar=1"]
        return [f"{src}{pre}," + ",".join(tail) + f"[{tag}]"]

    b0, f0 = f"{tag}bg0", f"{tag}fg0"
    return [
        f"{src}{pre},split=2[{b0}][{f0}]",
        f"[{b0}]scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,"
        f"crop={w}:{h},boxblur=24:2,eq=brightness=-0.08[{tag}bg]",
        f"[{f0}]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic"
        f"[{tag}fg]",
        f"[{tag}bg][{tag}fg]overlay=(W-w)/2:(H-h)/2,setsar=1,"
        f"format={pix_fmt}[{tag}]",
    ]


def _join_segments(graph: list[str], track: dict, segs: list[str],
                   fps: float, ti: int) -> None:
    """把一轨内的片段接起来，有 transition_in 的用 xfade，其余用 concat。

    xfade 的 offset 语义：**第一个输入播到第几秒开始转场**。
    我们的时间轴把「带转场的段」定义成从前一段结束前 N 帧开始（重叠 N 帧），
    于是 offset 恰好等于 clip.at_frame / fps —— 不需要额外累加，也不会有累计误差。
    这也是校验器强制 at == cursor - N 的原因：位置与转场帧数必须互相自洽，
    否则 xfade 的输出长度会和 duration_frames 对不上。

    混用 concat 与 xfade 是安全的：两者都保持「输出长度 = 各段之和 - 重叠」，
    所以无论第几段有转场，后续段的 offset 都能用同一个公式。
    """
    clips = track["clips"]
    if len(segs) == 1:
        graph.append(f"{segs[0]}null[vbase{ti}]")
        return

    if not any(c.get("transition_in") for c in clips):
        graph.append(f"{''.join(segs)}concat=n={len(segs)}:v=1:a=0[vbase{ti}]")
        return

    cur = segs[0]
    for k in range(1, len(segs)):
        tr = clips[k].get("transition_in")
        if tr:
            n = int(tr["frames"])
            off = clips[k]["at_frame"] / fps
            out = f"[vxf{ti}_{k}]"
            graph.append(f"{cur}{segs[k]}xfade=transition={tr['type']}:"
                         f"duration={n / fps:.6f}:offset={off:.6f}{out}")
        else:
            out = f"[vcc{ti}_{k}]"
            graph.append(f"{cur}{segs[k]}concat=n=2:v=1:a=0{out}")
        cur = out
    graph.append(f"{cur}null[vbase{ti}]")


def build(ir: dict, media: dict[str, str], layers: list[Layer],
          out_path: Path, target: Target, *, threads: int = 4,
          ffmpeg: str = "ffmpeg") -> CompiledPlan:
    o = ir["output"]
    W, H = o["width"], o["height"]
    fnum, fden = o["fps"]["num"], o["fps"]["den"]
    fps = fnum / fden
    total = o["duration_frames"]

    video_tracks = [t for t in ir["tracks"] if t.get("kind") in ("video", "overlay")]
    audio_tracks = [t for t in ir["tracks"] if t.get("kind") == "audio"]
    if not video_tracks:
        raise JobError("E_IR_INVALID", "缺少视频轨", field="tracks")

    # ── 输入：按首次出现顺序去重，保证同一 IR 每次编出的 argv 完全一致 ──
    argv: list[str] = [ffmpeg, "-y", "-v", "error", "-nostdin",
                       "-progress", "pipe:1", "-nostats"]
    idx: dict[str, int] = {}
    for track in video_tracks + audio_tracks:
        for clip in track["clips"]:
            aid = clip.get("asset")
            if not aid or aid in idx:
                continue
            path = media.get(aid)
            if not path or not Path(path).exists():
                raise JobError("E_MEDIA_MISSING", f"素材 {aid} 的文件不存在",
                               field="assets", hint="重新上传或修正 assets[].uri")
            idx[aid] = len(idx)
            argv += ["-i", str(Path(path).resolve())]

    n_inputs = len(idx)
    for li, layer in enumerate(layers):
        layer_input = len(idx) + li
        argv += ["-loop", "1", "-framerate", str(fps), "-t",
                 f"{duration_seconds(ir):.6f}", "-i", str(Path(layer.png).resolve())]
    layer_base = n_inputs

    graph: list[str] = []
    warnings: list[str] = []

    # ── 视频轨：每轨内逐段 trim → fit → fps，再 concat ──
    base_label = None
    for ti, track in enumerate(video_tracks):
        segs: list[str] = []
        for ci, clip in enumerate(track["clips"]):
            at, oat = clip["at_frame"], clip["out_frame"]
            length = oat - at
            speed = float(clip.get("speed", 1.0))
            consume = max(1, round(length * speed))
            src_in = int(clip.get("in_frame", 0))
            tag = f"v{ti}c{ci}"
            chain = [f"trim=start_frame={src_in}:end_frame={src_in + consume}",
                     "setpts=PTS-STARTPTS"]
            if abs(speed - 1.0) > 1e-6:
                chain.append(f"setpts=PTS/{speed}")
            is_overlay = track.get("kind") == "overlay"
            fit = clip.get("fit", "cover")
            if fit == "blur" and is_overlay:
                raise JobError("E_IR_UNSUPPORTED",
                               "overlay 轨不支持 fit=blur（叠加层需要 alpha，"
                               "模糊背景会把它变成不透明）",
                               field=f"tracks.{track['id']}.clips[{ci}].fit",
                               allowed_values=["cover", "contain", "stretch"])
            # overlay 轨必须保留 alpha 通道：强制 yuv420p 会把 alpha 丢掉，
            # 叠加层就变成不透明色块，把下层画面完全遮住。
            px = "yuva420p" if is_overlay else o["video"]["pix_fmt"]
            chain.append(f"fps={fnum}/{fden}")
            graph.extend(_segment_lines(f"[{idx[clip['asset']]}:v]", chain,
                                        fit, W, H, px, tag))
            segs.append(f"[{tag}]")
        _join_segments(graph, track, segs, fps, ti)
        if base_label is None:
            base_label = f"[vbase{ti}]"
        else:
            graph.append(f"{base_label}[vbase{ti}]overlay=0:0:format=auto,"
                         f"format={o['video']['pix_fmt']}[vov{ti}]")
            base_label = f"[vov{ti}]"
            warnings.append("overlay 轨按全画幅叠加处理；源若不含 alpha，会完全遮挡下层")

    cur = base_label

    # ── 文本层：合成已栅格化的图层 ──
    # 图层文件只包含文字实际占据的矩形（见 textlayer 的 bbox 裁剪），
    # 所以 overlay 必须按 bbox 左上角偏移；bbox 为 None 表示全透明，直接跳过。
    for li, layer in enumerate(layers):
        if not layer.bbox:
            continue
        x, y = int(layer.bbox[0]), int(layer.bbox[1])
        t0, t1 = layer.at_frame / fps, layer.out_frame / fps
        tag = f"vt{li}"
        graph.append(f"[{layer_base + li}:v]format=rgba,setpts=PTS-STARTPTS[lyr{li}]")
        graph.append(f"{cur}[lyr{li}]overlay={x}:{y}:format=auto:eof_action=repeat:"
                     f"enable='between(t,{t0:.6f},{t1:.6f})',"
                     f"format={o['video']['pix_fmt']}[{tag}]")
        cur = f"[{tag}]"
    graph.append(f"{cur}null[vout]")

    # ── 音频轨：adelay + amix，天然支持空洞与重叠 ──
    audio_clips = [(ti, ci, c) for ti, t in enumerate(audio_tracks)
                   for ci, c in enumerate(t["clips"])]
    if audio_clips:
        labels = []
        for ai, (_ti, ci, clip) in enumerate(audio_clips):
            at, oat = clip["at_frame"], clip["out_frame"]
            length = oat - at
            speed = float(clip.get("speed", 1.0))
            consume = max(1, round(length * speed))
            src_in = int(clip.get("in_frame", 0))
            delay_ms = int(round(at / fps * 1000))
            fade_in = int(clip.get("fade_in_frames", 0))
            fade_out = int(clip.get("fade_out_frames", 0))
            # atrim 没有 start_frame，只有 *_sample / *_pts；用采样数才帧级精确
            sr = o["audio"]["sample_rate"]
            s0 = round(src_in * fden / fnum * sr)
            s1 = round((src_in + consume) * fden / fnum * sr)
            chain = [f"atrim=start_sample={s0}:end_sample={s1}",
                     "asetpts=PTS-STARTPTS"]
            if abs(speed - 1.0) > 1e-6:
                chain.append(f"atempo={min(2.0, max(0.5, speed))}")
            chain.append(f"aresample={o['audio']['sample_rate']}")
            chain.append("aformat=sample_fmts=fltp:channel_layouts=stereo")
            vol = float(clip.get("volume", 1.0))
            if abs(vol - 1.0) > 1e-9:
                # 混音前增益：决定各音轨之间的相对比例。
                # 成品绝对响度仍由 target_lufs 决定（见下方是否跳过 loudnorm）。
                chain.append(f"volume={vol:.4f}")
            if fade_in:
                chain.append(f"afade=t=in:st=0:d={fade_in / fps:.4f}")
            if fade_out:
                d = fade_out / fps
                chain.append(f"afade=t=out:st={max(0.0, length / fps - d):.4f}:d={d:.4f}")
            if delay_ms:
                chain.append(f"adelay={delay_ms}|{delay_ms}")
            tag = f"a{ai}"
            graph.append(f"[{idx[clip['asset']]}:a]" + ",".join(chain) + f"[{tag}]")
            labels.append(f"[{tag}]")
        if len(labels) == 1:
            graph.append(f"{labels[0]}anull[amixed]")
        else:
            graph.append(f"{''.join(labels)}amix=inputs={len(labels)}:"
                         f"normalize=0:dropout_transition=0[amixed]")
    else:
        graph.append(f"anullsrc=channel_layout=stereo:sample_rate="
                     f"{o['audio']['sample_rate']}[amixed]")
        warnings.append("IR 无音轨，已补静音")

    # 音频强制对齐到时间线总时长，并做响度归一。
    # 少则补静音、多则裁掉、响度按 IR 声明的 target_lufs 拉平——三者缺一，
    # 交付出去的片子都会出现「音画时长不一致」或「忽大忽小」。
    sr = o["audio"]["sample_rate"]
    dur_s = duration_seconds(ir)
    n_samples = round(dur_s * sr)
    raw_lufs = o["audio"].get("target_lufs", -14.0)
    loud = raw_lufs not in (None, 0, 0.0)
    if loud:
        target_lufs = float(raw_lufs)
        graph.append(
            f"[amixed]apad=whole_dur={dur_s:.6f},"
            f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11,"
            f"aresample={sr},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"atrim=end_sample={n_samples}[aout]")
    else:
        # 显式关闭响度归一（target_lufs = null 或 0）：
        # 此时 clip.volume 是「绝对增益」，成品响度等于混音结果。
        # 单音轨 + 想要精确音量时必须走这条，否则 loudnorm 会把 volume 拉回去。
        graph.append(
            f"[amixed]apad=whole_dur={dur_s:.6f},"
            f"aresample={sr},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"atrim=end_sample={n_samples}[aout]")
        warnings.append("target_lufs 已关闭：不做响度归一，成品响度取决于混音与 volume")

    graph_s = ";".join(graph)
    argv += ["-filter_complex", graph_s, "-map", "[vout]", "-map", "[aout]"]
    argv += ["-t", f"{duration_seconds(ir):.6f}"]

    codec = o["video"]["codec"]
    br = int(o["video"]["bitrate_kbps"])
    crf = int(o["video"].get("crf", 20))
    # 码率控制必须是「capped CRF」而不是 CBR/ABR。
    # 实测：-b:v + -maxrate + -bufsize 在 -threads>1 下同一命令两次会产出不同字节
    # （x264 的 VBV 占用在帧级线程下逐次微移），而 capped CRF 完全确定且更快。
    # 因此 IR 里的 bitrate_kbps 语义是「码率上限」，实际码率由内容复杂度决定。
    # MP4 里的 codec tag 必须显式写：
    # · hevc 默认写成 hev1，参数集允许在码流中重复 —— Safari / QuickTime / iOS
    #   只认 hvc1，拿到 hev1 直接不播。客户要 HEVC 往往就是为了 Apple 端省带宽。
    # · av1 默认 av01、h264 默认 avc1，这里显式写是为了让 encoder_signature()
    #   能覆盖它（否则改了 tag 缓存键不变，线上还会拿到旧产物）。
    vtag = {"h264": "avc1", "hevc": "hvc1", "av1": "av01"}[codec]
    argv += ["-tag:v", vtag]

    if codec == "h264":
        argv += ["-c:v", "libx264", "-preset", o["video"]["preset"],
                 "-crf", str(crf), "-maxrate", f"{br}k", "-bufsize", f"{br * 2}k",
                 "-g", str(o["video"]["gop_frames"]), "-pix_fmt", o["video"]["pix_fmt"],
                 "-profile:v", "high",
                 "-x264-params",
                 "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv"]
    elif codec == "hevc":
        argv += ["-c:v", "libx265", "-preset", "medium",
                 "-crf", str(crf + 2), "-pix_fmt", o["video"]["pix_fmt"],
                 "-x265-params",
                 f"log-level=error:vbv-maxrate={br}:vbv-bufsize={br * 2}:"
                 "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv"]
    else:  # av1
        argv += ["-c:v", "libsvtav1", "-preset", "8",
                 "-crf", str(crf), "-pix_fmt", o["video"]["pix_fmt"]]

    argv += ["-colorspace", "bt709", "-color_primaries", "bt709",
             "-color_trc", "bt709", "-color_range", "tv",
             "-c:a", "aac", "-ar", str(o["audio"]["sample_rate"]),
             "-ac", str(o["audio"]["channels"]),
             "-b:a", f"{o['audio']['bitrate_kbps']}k",
             "-movflags", "+faststart",
             "-map_metadata", "-1", "-map_chapters", "-1",
             "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
             "-threads", str(threads),
             str(out_path)]

    return CompiledPlan(argv=argv, expected_frames=total,
                        warnings=warnings, layer_count=len(layers),
                        filtergraph=graph_s)
