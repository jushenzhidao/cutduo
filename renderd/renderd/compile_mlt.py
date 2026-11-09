"""IR → MLT XML → melt 执行计划。

用途有二：
  1. 与 Shotcut/Kdenlive 工程互通（客户可以把模板拿去改）。
  2. 可选渲染后端：装了 melt 的节点上，同一份 IR 可以走 MLT 出片。

两个容易踩的坑（都是实测出来的）：
  · `avformat-novalidate` 不做探测就拿不到时长，melt 会把整条时间线当成 1 帧；
    必须用 `avformat`，或者显式给 `<property name="length">`。
  · 不指定 `audio_index` / `video_index` 时 melt 会自动挑第一条视频与音频流；
    写死索引会让纯音频素材（音乐床）直接打不开。
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from .compile_ffmpeg import CompiledPlan
from .config import Config
from .errors import JobError
from .ir import duration_seconds
from .textlayer import Layer

ALLOWED_SERVICES = {
    "avformat-novalidate", "avformat", "qimage", "colour", "qtblend",
    "mix", "volume", "dynamictext", "tractor", "xml",
}


def build(ir: dict, media: dict[str, str], layers: list[Layer],
          target_fps: tuple[int, int] | None = None) -> str:
    o = ir["output"]
    W, H = o["width"], o["height"]
    fnum, fden = o["fps"]["num"], o["fps"]["den"]
    total = o["duration_frames"]
    _reject_unsupported(ir)
    fps = fnum / fden

    video_tracks = [t for t in ir["tracks"] if t.get("kind") in ("video", "overlay")]
    audio_tracks = [t for t in ir["tracks"] if t.get("kind") == "audio"]

    L: list[str] = ['<?xml version="1.0" encoding="utf-8"?>',
                    f'<mlt LC_NUMERIC="C" version="7.30.0" title="{_x(ir.get("id", "cut"))}" '
                    f'producer="tractor0">',
                    f'  <profile description="{W}x{H} {fnum}/{fden}" width="{W}" height="{H}" '
                    f'progressive="1" sample_aspect_num="1" sample_aspect_den="1" '
                    f'display_aspect_num="{W}" display_aspect_den="{H}" '
                    f'frame_rate_num="{fnum}" frame_rate_den="{fden}" colorspace="709"/>']

    # 视频/音频素材 producer
    prod: dict[str, str] = {}
    for track in video_tracks + audio_tracks:
        for clip in track["clips"]:
            aid = clip.get("asset")
            if not aid or aid in prod:
                continue
            pid = f"producer{len(prod)}"
            prod[aid] = pid
            path = media.get(aid, "")
            L += [f'  <producer id="{pid}" in="0" out="{total}">',
                  f'    <property name="resource">{_x(path)}</property>',
                  # avformat（不是 novalidate）：需要探测出真实时长与流信息
                  '    <property name="mlt_service">avformat</property>',
                  '  </producer>']

    # 文本图层 producer（已栅格化，ttl 设为该 clip 需要的帧数）
    for li, layer in enumerate(layers):
        pid = f"layerproducer{li}"
        L += [f'  <producer id="{pid}" in="0" out="{layer.out_frame - layer.at_frame - 1}">',
              f'    <property name="resource">{_x(str(layer.png))}</property>',
              '    <property name="mlt_service">qimage</property>',
              f'    <property name="ttl">{layer.out_frame - layer.at_frame + 1}</property>',
              # length 单位是帧，不是时间码
              f'    <property name="length">{layer.out_frame - layer.at_frame}</property>',
              '  </producer>']

    # 轨道 playlist
    for ti, track in enumerate(video_tracks):
        L.append(f'  <playlist id="playlist{ti}">')
        for clip in track["clips"]:
            length = clip["out_frame"] - clip["at_frame"]
            src_in = int(clip.get("in_frame", 0))
            L.append(f'    <entry producer="{prod[clip["asset"]]}" in="{src_in}" '
                     f'out="{src_in + length - 1}"/>')
        L.append('  </playlist>')

    text_playlists = []
    for li, layer in enumerate(layers):
        pid = f"pl_text{li}"
        text_playlists.append((pid, layer))
        L.append(f'  <playlist id="{pid}">')
        if layer.at_frame > 0:
            L.append(f'    <blank length="{layer.at_frame}"/>')
        L.append(f'    <entry producer="layerproducer{li}" in="0" '
                 f'out="{layer.out_frame - layer.at_frame - 1}"/>')
        L.append('  </playlist>')

    audio_playlists = []
    for ai, track in enumerate(audio_tracks):
        pid = f"pl_audio{ai}"
        audio_playlists.append(pid)
        L.append(f'  <playlist id="{pid}">')
        cursor = 0
        for clip in sorted(track["clips"], key=lambda c: c["at_frame"]):
            if clip["at_frame"] > cursor:
                L.append(f'    <blank length="{clip["at_frame"] - cursor}"/>')
            length = clip["out_frame"] - clip["at_frame"]
            src_in = int(clip.get("in_frame", 0))
            vol = float(clip.get("volume", 1.0))
            if abs(vol - 1.0) > 1e-9:
                # 音量是 entry 级 filter：MLT 没有「轨道增益」，只能挂在条目上
                L.append(f'    <entry producer="{prod[clip["asset"]]}" in="{src_in}" '
                         f'out="{src_in + length - 1}">')
                L.append('      <filter>')
                L.append('        <property name="mlt_service">volume</property>')
                L.append(f'        <property name="level">{vol:.4f}</property>')
                L.append('      </filter>')
                L.append('    </entry>')
            else:
                L.append(f'    <entry producer="{prod[clip["asset"]]}" in="{src_in}" '
                         f'out="{src_in + length - 1}"/>')
            cursor = clip["out_frame"]
        L.append('  </playlist>')

    # tractor
    L.append(f'  <tractor id="tractor0" in="0" out="{total - 1}">')
    L.append('    <property name="shotcut:projectAudioChannels">2</property>')
    # hide 必须显式写：MLT 的 track 默认同时取视频与音频，
    # 视频轨会把它自己的声音也混进来 —— 与 ffmpeg 后端「视频轨只取画面」不一致。
    for ti in range(len(video_tracks)):
        L.append(f'    <track producer="playlist{ti}" hide="audio"/>')
    for pid, _layer in text_playlists:
        L.append(f'    <track producer="{pid}" hide="audio"/>')
    for pid in audio_playlists:
        L.append(f'    <track producer="{pid}" hide="video"/>')

    # 视频/文本层用 qtblend 叠加到第 0 轨
    for bi in range(1, len(video_tracks) + len(text_playlists)):
        L += [f'    <transition id="transition{bi}">',
              '      <property name="a_track">0</property>',
              f'      <property name="b_track">{bi}</property>',
              '      <property name="mlt_service">qtblend</property>',
              '      <property name="always_active">1</property>',
              f'      <property name="rect">0 0 {W} {H} 1</property>',
              '    </transition>']

    # 每条音频轨都要一条 mix：只给第一条加，第二条会被直接丢弃（实测静音）
    base = len(video_tracks) + len(text_playlists)
    for ai in range(len(audio_playlists)):
        L += [f'    <transition id="transition_audio{ai}">',
              '      <property name="a_track">0</property>',
              f'      <property name="b_track">{base + ai}</property>',
              '      <property name="mlt_service">mix</property>',
              '      <property name="always_active">1</property>',
              '      <property name="sum">1</property>',
              '    </transition>']
    L.append('  </tractor>')
    L.append('</mlt>')
    return "\n".join(L) + "\n"


def plan(ir: dict, xml_path: Path, out_path: Path, cfg: Config, *,
         threads: int = 4) -> CompiledPlan:
    """melt 执行计划。返回结构与 ffmpeg 后端一致，runner 不需要分支。"""
    o = ir["output"]
    total = o["duration_frames"]
    _reject_unsupported(ir)
    codec = o["video"]["codec"]
    vcodec = {"h264": "libx264", "hevc": "libx265", "av1": "libsvtav1"}.get(
        codec, "libx264")
    crf = int(o["video"].get("crf", 20))
    argv = [cfg.melt, str(xml_path), "-silent",
            "-consumer", f"avformat:{out_path}",
            "f=mp4", f"vcodec={vcodec}", f"crf={crf}",
            f"preset={o['video'].get('preset', 'veryfast')}",
            f"acodec=aac", f"ar={o['audio']['sample_rate']}",
            f"channels={o['audio']['channels']}",
            f"ab={o['audio']['bitrate_kbps']}k",
            f"threads={threads}", "real_time=-1", "terminate_on_pause=1",
            "movflags=+faststart"]
    return CompiledPlan(argv=argv, backend="mlt", expected_frames=total,
                        warnings=["MLT 后端为可选路径；字节确定性未做承诺"],
                        filtergraph=xml_path.read_text() if xml_path.exists() else "")


MP4_VTAG = {"h264": "avc1", "hevc": "hvc1", "av1": "av01"}


def finalize_argv(ir: dict, src: Path, dst: Path, cfg: Config, *,
                  normalise_audio: bool = True) -> list[str]:
    """MLT 出片后的容器规范化。**无论有没有音轨都要跑。**

    三件事，都是只有真跑才会暴露的：
      · codec tag：melt 写 HEVC 用的是 `hev1`（实测），Safari/iOS 只认 `hvc1`
        —— 客户要 HEVC 往往正是为了 Apple 端省带宽，tag 不对等于白给。
      · 响度：MLT 没有 LUFS 目标的概念，不补 loudnorm 就会在 L3 断言上失败
        （实测 -24 LUFS vs 目标 -14）。
      · 时长：MLT 的音频轨到最后一个片段就结束（音乐床 10s / 时间线 15s），
        不 apad+atrim 就是音画不同步。

    视频流始终 copy，只有音频在需要时才重编。
    """
    o = ir["output"]
    v, a = o["video"], o["audio"]
    dur = duration_seconds(ir)
    vtag = MP4_VTAG.get(v["codec"], "avc1")
    argv = [cfg.ffmpeg, "-y", "-v", "error", "-nostdin", "-i", str(src),
            "-map", "0:v:0",
            # `0:a:0?` 的可选标记：hook 类模板没有音轨，强制映射会直接失败
            "-map", "0:a:0?",
            "-c:v", "copy", "-tag:v", vtag]
    if normalise_audio:
        target = float(a.get("target_lufs", -14.0))
        af = (f"apad=whole_dur={dur:.6f},"
              f"loudnorm=I={target}:TP=-1.5:LRA=11,"
              f"atrim=end={dur:.6f}")
        argv += ["-af", af,
                 "-c:a", "aac", "-ar", str(a["sample_rate"]),
                 "-ac", str(a["channels"]), "-b:a", f"{a['bitrate_kbps']}k"]
    else:
        argv += ["-c:a", "copy"]
    argv += ["-t", f"{dur:.6f}", "-movflags", "+faststart",
             "-map_metadata", "-1", str(dst)]
    return argv


def loudness_argv(ir: dict, src: Path, dst: Path, cfg: Config) -> list[str]:
    """兼容旧调用：等价于 finalize_argv(normalise_audio=True)。"""
    return finalize_argv(ir, src, dst, cfg, normalise_audio=True)


def _x(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def validate_xml(xml: str) -> dict:
    """结构校验：well-formed + 服务名白名单 + 关键元素存在。"""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        return {"ok": False, "error": f"XML 不合法: {exc}"}

    services = {p.text for p in root.iter("property") if p.get("name") == "mlt_service"}
    unknown = sorted(services - ALLOWED_SERVICES)
    has_profile = root.find("profile") is not None
    has_tractor = root.find("tractor") is not None
    producers = len(root.findall("producer"))
    playlists = len(root.findall("playlist"))
    return {
        "ok": has_profile and has_tractor and not unknown,
        "services": sorted(services),
        "unknown_services": unknown,
        "producers": producers,
        "playlists": playlists,
        "has_profile": has_profile,
        "has_tractor": has_tractor,
        "bytes": len(xml.encode()),
    }


def _reject_unsupported(ir: dict) -> None:
    """MLT 后端尚未实现的能力必须在编译前拒绝。

    静默降级（把转场当硬切、把音量当 1.0）比报错更糟：客户看到「成功」，
    拿到的是与 IR 不一致的成片，而且回执里没有任何线索。
    """
    for track in ir["tracks"]:
        for ci, clip in enumerate(track.get("clips", [])):
            if clip.get("transition_in"):
                raise JobError(
                    "E_IR_UNSUPPORTED",
                    f"MLT 后端尚不支持转场（{track['id']} 第 {ci + 1} 段）",
                    field=f"tracks.{track['id']}.clips[{ci}].transition_in",
                    hint="改用 backend=ffmpeg；或去掉 transition_in")


def write(ir: dict, media: dict[str, str], layers: list[Layer],
          path: Path) -> dict:
    xml = build(ir, media, layers)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(xml)
    return {"path": str(path), **validate_xml(xml)}
