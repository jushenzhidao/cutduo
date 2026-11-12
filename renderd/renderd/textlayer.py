"""文字图层栅格化。

为什么不在渲染时画字：
    一旦让 drawtext / 字幕滤镜在目标机现算字形，输出就绑定了那台机器的
    freetype/harfbuzz 版本与字体搜索路径，跨端一致从物理上不可保证。
    正确做法是把文字先烘成 RGBA 图层，图层的 sha256 进入缓存键，
    渲染器只做合成——字形像素在编译期就冻结了。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

from .errors import JobError


@dataclass
class Layer:
    track: str
    clip_index: int
    at_frame: int
    out_frame: int
    text: str
    png: Path
    sha256: str
    bbox: tuple[int, int, int, int] | None
    within_safe: bool | None
    safe_area: dict = field(default_factory=dict)
    lines: int = 1
    font_size: int = 0

    def summary(self) -> dict:
        return {
            "track": self.track,
            "frames": [self.at_frame, self.out_frame],
            "bbox": list(self.bbox) if self.bbox else None,
            "within_safe_area": self.within_safe,
            "sha256": self.sha256[:16],
            "lines": self.lines,
        }


def _wrap(text: str, max_chars: int | None) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        if max_chars and len(para) > max_chars:
            lines.extend(para[i:i + max_chars] for i in range(0, len(para), max_chars))
        else:
            lines.append(para)
    return lines or [""]


def safe_rect(width: int, height: int, safe: dict) -> tuple[float, float, float, float]:
    return (
        width * float(safe.get("left", 0.0)),
        height * float(safe.get("top", 0.0)),
        width * (1 - float(safe.get("right", 0.0))),
        height * (1 - float(safe.get("bottom", 0.0))),
    )


def rasterize(ir: dict, font_path: str, out_dir: Path,
              *, strict_safe_area: bool = True) -> list[Layer]:
    """把 IR 里所有文本 clip 烘成 PNG 图层。"""
    try:
        from PIL import Image, ImageDraw
    except Exception as exc:  # pragma: no cover
        raise JobError("E_FONT_MISSING", "缺少 Pillow，无法栅格化文字",
                       hint="pip install pillow") from exc

    from . import fonts as _fonts

    W = ir["output"]["width"]
    H = ir["output"]["height"]
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    layers: list[Layer] = []

    for ti, track in enumerate(ir.get("tracks", [])):
        if track.get("kind") != "text":
            continue
        for ci, clip in enumerate(track["clips"]):
            st = ir["styles"][clip["style"]]
            size = int(st["font_size"])
            font = _fonts.load(font_path, size)
            lines = _wrap(clip["text"], st.get("max_chars_per_line"))
            body = "\n".join(lines)

            stroke_w = 6 if st.get("stroke") else 0
            stroke_fill = str(st.get("stroke") or "#000000").split("@")[0]
            fill = str(st["fill"]).split("@")[0]
            align = st.get("align", "center")
            anchor = st.get("anchor", "center")
            safe = st.get("safe_area") or {}

            img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            lb = draw.multiline_textbbox((0, 0), body, font=font, align=align,
                                         stroke_width=stroke_w)
            tw, th = lb[2] - lb[0], lb[3] - lb[1]

            if anchor == "bottom":
                y = H * (1 - float(safe.get("bottom", 0.12))) + float(st.get("offset_y", 0))
                top = y - th - lb[1]
            elif anchor == "top":
                y = H * float(safe.get("top", 0.08)) + float(st.get("offset_y", 0))
                top = y - lb[1]
            else:
                y = H / 2 + float(st.get("offset_y", 0))
                top = y - th / 2 - lb[1]
            left = W / 2 - tw / 2 - lb[0]

            draw.multiline_text((left, top), body, font=font, fill=fill, align=align,
                                stroke_width=stroke_w, stroke_fill=stroke_fill)

            bbox = img.getbbox()
            within: bool | None = None
            if bbox and safe:
                x0, y0, x1, y1 = safe_rect(W, H, safe)
                within = (bbox[0] >= x0 - 1 and bbox[1] >= y0 - 1
                          and bbox[2] <= x1 + 1 and bbox[3] <= y1 + 1)

            png = out_dir / f"layer_{track.get('id', ti)}_{clip['at_frame']}_{ci}.png"
            # 只存「有内容的矩形」，不存整帧。
            # 实测文字只占画面 0.8%–3.7%，但整帧 RGBA 会让渲染期每帧做一次
            # 1080×1920 的全帧 alpha 混合 —— 同样的像素结果，白付 96% 的混合成本。
            # bbox 是**绝对坐标**，编译期按它做 overlay 偏移；像素完全一致。
            if bbox:
                img.crop(bbox).save(png)
            else:
                # 全透明（空文案）：存 1×1 占位，编译期按 bbox=None 跳过叠加
                img.crop((0, 0, 1, 1)).save(png)
            digest = hashlib.sha256(png.read_bytes()).hexdigest()

            if within is False and strict_safe_area:
                x0, y0, x1, y1 = safe_rect(W, H, safe)
                over = [round(max(0, x0 - bbox[0])), round(max(0, y0 - bbox[1])),
                        round(max(0, bbox[2] - x1)), round(max(0, bbox[3] - y1))]
                raise JobError(
                    "E_TEXT_OVERFLOW",
                    f"文本越出安全区，超出 左{over[0]} 上{over[1]} 右{over[2]} 下{over[3]} px",
                    hint="缩短文案、减小 font_size，或调整 styles.*.safe_area",
                    field=f"tracks[{ti}].clips[{ci}].text",
                    allowed_values=[f"≤{st.get('max_chars_per_line') or len(clip['text'])} 字"],
                    detail=f"bbox={bbox} safe_rect=({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f})",
                )

            layers.append(Layer(
                track=track.get("id", f"t{ti}"), clip_index=ci,
                at_frame=clip["at_frame"], out_frame=clip["out_frame"],
                text=clip["text"], png=png, sha256=digest, bbox=bbox,
                within_safe=within, safe_area=safe, lines=len(lines), font_size=size,
            ))

    return layers


def layers_digest(layers: list[Layer]) -> str:
    h = hashlib.sha256()
    for l in sorted(layers, key=lambda x: (x.at_frame, x.track)):
        h.update(l.sha256.encode())
        h.update(f"{l.at_frame}:{l.out_frame}".encode())
    return h.hexdigest()[:32]
