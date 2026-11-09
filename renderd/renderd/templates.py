"""模板注册表。

模板 = IR 骨架 + 变量声明。调用方只填变量，不写 IR，更不写 MLT。
这样「意图 → 工程」的编译发生在服务端，Agent 拿不到执行计划，也就不存在注入面。
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from .errors import JobError

PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def _v(name: str, vtype: str, required: bool = True, **kw) -> dict:
    return {"name": name, "type": vtype, "required": required, **kw}


def _output(w: int, h: int, frames: int, bitrate: int = 6000) -> dict:
    return {
        "width": w, "height": h,
        "fps": {"num": 30, "den": 1},
        "duration_frames": frames,
        "video": {"codec": "h264", "bitrate_kbps": bitrate, "pix_fmt": "yuv420p",
                  "preset": "veryfast", "gop_frames": 60},
        "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
                  "bitrate_kbps": 192, "target_lufs": -14.0},
        "color": {"primaries": "bt709", "transfer": "bt709",
                  "matrix": "bt709", "range": "tv"},
    }


def builtin_templates() -> list[dict]:
    """三个内置模板。刻意覆盖：多段拼接、横竖混合、单段、无音轨。"""
    title_style = {
        "font_family": "Hiragino Sans GB",
        "font_size": 84, "fill": "#FFFFFF", "stroke": "#000000@0.8",
        "align": "center", "anchor": "bottom", "offset_y": 0,
        "max_chars_per_line": 9,
        "safe_area": {"top": 0.10, "bottom": 0.16, "left": 0.07, "right": 0.07},
    }
    small_style = {
        "font_family": "Hiragino Sans GB",
        "font_size": 54, "fill": "#FFFFFF", "stroke": "#000000@0.7",
        "align": "center", "anchor": "bottom", "max_chars_per_line": 14,
        "safe_area": {"top": 0.10, "bottom": 0.14, "left": 0.07, "right": 0.07},
    }

    return [
        {
            "template_id": "brand_vertical_15s",
            "family": "brand_vertical",
            "aspect": "9:16",
            "description": "竖版 15 秒：3 段素材拼接 + 主标题 + 音乐床",
            "output": _output(1080, 1920, 450, 8000),
            "styles": {"s_title": title_style},
            "variables": [
                _v("clip1", "asset_id"), _v("clip2", "asset_id"), _v("clip3", "asset_id"),
                _v("title", "string", max_chars=18),
                _v("music", "asset_id", required=False),
            ],
            "tracks": [
                {"id": "v1", "kind": "video", "clips": [
                    {"asset": "{{clip1}}", "at_frame": 0, "out_frame": 150, "fit": "cover"},
                    {"asset": "{{clip2}}", "at_frame": 150, "out_frame": 300, "fit": "cover"},
                    {"asset": "{{clip3}}", "at_frame": 300, "out_frame": 450, "fit": "cover"},
                ]},
                {"id": "t1", "kind": "text", "clips": [
                    {"at_frame": 30, "out_frame": 420, "text": "{{title}}", "style": "s_title"}
                ]},
                {"id": "a1", "kind": "audio", "clips": [
                    {"asset": "{{music}}", "at_frame": 0, "out_frame": 450}
                ]},
            ],
        },
        {
            "template_id": "caption_square_9s",
            "family": "caption_square",
            "aspect": "1:1",
            "description": "方形 9 秒：单段素材 + 底部字幕条",
            "output": _output(1080, 1080, 270, 5000),
            "styles": {"s_caption": small_style},
            "variables": [
                _v("clip", "asset_id"), _v("caption", "string", max_chars=28),
            ],
            "tracks": [
                {"id": "v1", "kind": "video", "clips": [
                    {"asset": "{{clip}}", "at_frame": 0, "out_frame": 270, "fit": "cover"}
                ]},
                {"id": "t1", "kind": "text", "clips": [
                    {"at_frame": 0, "out_frame": 270, "text": "{{caption}}", "style": "s_caption"}
                ]},
            ],
        },
        {
            "template_id": "hook_vertical_6s",
            "family": "hook_vertical",
            "aspect": "9:16",
            "description": "竖版 6 秒钩子：单段素材 + 大字标题（无音轨，用于静音信息流）",
            "output": _output(1080, 1920, 180, 7000),
            "styles": {"s_hook": {**title_style, "font_size": 110, "max_chars_per_line": 7}},
            "variables": [
                _v("clip", "asset_id"), _v("hook", "string", max_chars=14),
            ],
            "tracks": [
                {"id": "v1", "kind": "video", "clips": [
                    {"asset": "{{clip}}", "at_frame": 0, "out_frame": 180, "fit": "cover"}
                ]},
                {"id": "t1", "kind": "text", "clips": [
                    {"at_frame": 6, "out_frame": 174, "text": "{{hook}}", "style": "s_hook"}
                ]},
            ],
        },
    ]


def _subst(node: Any, values: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        return {k: _subst(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [_subst(v, values) for v in node]
    if isinstance(node, str):
        m = PLACEHOLDER.fullmatch(node.strip())
        if m:
            return values.get(m.group(1), node)
        def repl(mm):
            return str(values.get(mm.group(1), mm.group(0)))
        return PLACEHOLDER.sub(repl, node)
    return node


class TemplateRegistry:
    def __init__(self, template_dir: Path):
        self.dir = Path(template_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._seed()

    def _seed(self) -> None:
        for t in builtin_templates():
            p = self.dir / f"{t['template_id']}.json"
            if not p.exists():
                p.write_text(json.dumps(t, ensure_ascii=False, indent=2) + "\n")

    def load(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for p in sorted(self.dir.glob("*.json")):
            try:
                t = json.loads(p.read_text())
                out[t["template_id"]] = t
            except Exception:
                continue
        return out

    def list(self) -> list[dict]:
        items = []
        for t in self.load().values():
            items.append({
                "id": t["template_id"],
                "family": t.get("family", ""),
                "aspect": t.get("aspect", ""),
                "description": t.get("description", ""),
                "duration_frames": t["output"]["duration_frames"],
                "duration_s": round(t["output"]["duration_frames"]
                                    / (t["output"]["fps"]["num"] / t["output"]["fps"]["den"]), 3),
                "resolution": [t["output"]["width"], t["output"]["height"]],
                "variables": t.get("variables", []),
                "constraints": {
                    "safe_area": t["styles"][next(iter(t["styles"]))].get("safe_area", {}),
                    "fonts": sorted({s.get("font_family", "")
                                     for s in t.get("styles", {}).values()} - {""}),
                },
            })
        return sorted(items, key=lambda x: x["id"])

    def get(self, template_id: str) -> dict:
        t = self.load().get(template_id)
        if not t:
            raise JobError("E_TEMPLATE_NOT_FOUND", f"模板不存在: {template_id}",
                           field="template_id",
                           allowed_values=sorted(self.load().keys()))
        return t

    def instantiate(self, template_id: str, variables: dict[str, Any],
                    assets: list[dict]) -> dict:
        t = self.get(template_id)
        specs = {v["name"]: v for v in t.get("variables", [])}
        asset_ids = {a["id"] for a in assets}

        missing = []
        for name, spec in specs.items():
            if spec.get("required", True) and not variables.get(name):
                missing.append(name)
        if missing:
            raise JobError("E_TEMPLATE_VARS", f"缺少模板变量: {', '.join(missing)}",
                           field="variables", allowed_values=sorted(specs.keys()),
                           hint="按 list_templates 返回的 variables 填齐必填项")

        for name, spec in specs.items():
            val = variables.get(name)
            if val is None:
                continue
            if spec["type"] == "asset_id" and val not in asset_ids:
                raise JobError("E_TEMPLATE_VARS",
                               f"变量 {name} 引用的素材不在 assets 里: {val}",
                               field=f"variables.{name}",
                               allowed_values=sorted(asset_ids))
            if spec["type"] == "string":
                limit = spec.get("max_chars")
                if limit and len(str(val)) > limit:
                    raise JobError("E_TEMPLATE_VARS",
                                   f"变量 {name} 超过 {limit} 字（当前 {len(str(val))}）",
                                   field=f"variables.{name}",
                                   allowed_values=[f"≤{limit} 字"])
                if not str(val).strip():
                    raise JobError("E_TEMPLATE_VARS", f"变量 {name} 不能为空",
                                   field=f"variables.{name}")

        skeleton = {
            "ir_version": "0.1",
            "id": t["template_id"],
            "title": t.get("description", ""),
            "output": copy.deepcopy(t["output"]),
            "styles": copy.deepcopy(t.get("styles", {})),
            "assets": [{"id": a["id"], "uri": a["uri"], **({"sha256": a["sha256"]} if a.get("sha256") else {})}
                       for a in assets],
            "tracks": copy.deepcopy(t.get("tracks", [])),
        }
        ir = _subst(skeleton, variables)

        # 可选素材没填时，把对应音轨摘掉（而不是留一个 {{music}} 字符串）
        cleaned_tracks = []
        for tr in ir["tracks"]:
            clips = [c for c in tr["clips"] if not _has_unfilled(c)]
            if clips:
                cleaned_tracks.append({**tr, "clips": clips})
        ir["tracks"] = cleaned_tracks
        return ir


def _has_unfilled(node: Any) -> bool:
    if isinstance(node, dict):
        return any(_has_unfilled(v) for v in node.values())
    if isinstance(node, list):
        return any(_has_unfilled(v) for v in node)
    if isinstance(node, str):
        return bool(PLACEHOLDER.search(node))
    return False
