"""字幕资产：SRT / WebVTT → 文本片段（text 轨）。

为什么不用 ffmpeg 的 `subtitles`/libass：
  · 两个后端（ffmpeg 与 MLT）要同结果，libass 在两者里的渲染细节不一致
  · 现有文字层已经有安全区硬校验、字体指纹、确定性断言；字幕走同一条路才能复用
  · 客户改字幕样式时改的是 IR 的 `styles`，不是 ASS 的样式行

所以这里只做一件事：**解析时间码**。渲染交给 textlayer。

支持：
  · SRT（`,` 或 `.` 分隔毫秒；容忍 BOM、序号行、多行文本）
  · WebVTT（`WEBVTT` 头、`NOTE` 块、cue settings）
  · 去掉 `<i>` `<b>` 之类的标签与 `{\\an8}` 覆盖码 —— 位置由 IR 的 style 决定，
    不允许字幕文件自带定位，否则安全区校验形同虚设
"""

from __future__ import annotations

import re
from pathlib import Path

from .errors import JobError

# 时间码：HH:MM:SS,mmm 或 HH:MM:SS.mmm（MM 也允许两位以上）
_TS = re.compile(r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})")
_TAG = re.compile(r"<[^>]{1,40}>")
_OVERRIDE = re.compile(r"\{[^}]{0,40}\}")


def _to_seconds(m: re.Match[str]) -> float:
    h, mi, s, ms = (int(g) for g in m.groups())
    return h * 3600 + mi * 60 + s + ms / 1000.0


def parse_cues(raw: str) -> list[tuple[float, float, str]]:
    """解析成 [(start_s, end_s, text)]。顺序保持文件里的顺序。"""
    text = raw.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    cues: list[tuple[float, float, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if "-->" not in line:
            i += 1
            continue
        left, right = line.split("-->", 1)
        m1 = _TS.search(left)
        m2 = _TS.search(right)
        if not m1 or not m2:
            i += 1
            continue
        start, end = _to_seconds(m1), _to_seconds(m2)
        # 收后面的文本行，直到空行或下一条时间码
        body: list[str] = []
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if not nxt.strip():
                break
            if "-->" in nxt:
                break                      # 缺少空行的紧凑文件
            body.append(nxt.strip())
            i += 1
        # 去掉标签与 ASS 覆盖码：定位由 style 决定，不接受文件自带位置
        cleaned = _OVERRIDE.sub("", _TAG.sub("", "\n".join(body))).strip()
        if cleaned and end > start:
            cues.append((start, end, cleaned))
    return cues


def read_cues(path: Path) -> list[tuple[float, float, str]]:
    p = Path(path)
    try:
        raw = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            raw = p.read_text(encoding="gb18030")   # 国内客户常见
        except Exception as exc:                     # noqa: BLE001
            raise JobError("E_INPUT_UNREADABLE",
                           f"字幕文件无法解码: {p.name}",
                           field="assets",
                           hint="请存为 UTF-8") from exc
    except OSError as exc:
        raise JobError("E_MEDIA_MISSING", f"字幕文件读不到: {p.name}",
                       field="assets") from exc
    cues = parse_cues(raw)
    if not cues:
        raise JobError("E_INPUT_UNREADABLE",
                       f"字幕文件里没有可识别的时间码: {p.name}",
                       field="assets",
                       hint="支持 SRT 与 WebVTT；每条需要 00:00:01,000 --> 00:00:03,000")
    return cues


def expand(ir: dict, media: dict[str, str]) -> None:
    """把 subtitle 轨就地展开成 text 轨。

    必须在 `_probe_assets` 之后调用（此时 media 里是本地绝对路径）。
    cue 的绝对时间直接映射到时间线帧，再与 clip 的 [at_frame, out_frame) 求交 ——
    字幕文件里的时间码是相对整条视频的，不是相对片段。
    """
    fps = ir["output"]["fps"]["num"] / ir["output"]["fps"]["den"]
    total = ir["output"]["duration_frames"]

    out_tracks: list[dict] = []
    seen_ids = {t["id"] for t in ir["tracks"]}
    for track in ir["tracks"]:
        if track.get("kind") != "subtitle":
            out_tracks.append(track)
            continue
        clips: list[dict] = []
        for ci, sc in enumerate(track["clips"]):
            path = Path(str(media.get(sc["asset"], "")))
            cues = read_cues(path)
            win_a, win_b = sc["at_frame"], sc["out_frame"]
            for cue_i, (start, end, body) in enumerate(cues):
                a = max(win_a, round(start * fps))
                b = min(win_b, round(end * fps), total)
                if b - a < 1:
                    continue
                clips.append({"text": body, "style": sc["style"],
                              "at_frame": a, "out_frame": b})
        if not clips:
            continue                     # 窗口内没有字幕：不生成空轨
        tid = f"{track['id']}_txt"
        n = 1
        while tid in seen_ids:           # 绝不覆盖调用方自己的轨 id
            tid = f"{track['id']}_txt{n}"
            n += 1
        seen_ids.add(tid)
        out_tracks.append({"id": tid, "kind": "text", "clips": clips})
    ir["tracks"] = out_tracks


def cue_count(ir: dict, media: dict[str, str]) -> int:
    """字幕条数（用于回执与运维观测）。"""
    n = 0
    for t in ir["tracks"]:
        if t.get("kind") != "subtitle":
            continue
        for c in t["clips"]:
            p = media.get(c["asset"])
            if p:
                n += len(read_cues(Path(p)))
    return n
