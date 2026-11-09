"""字体解析与字形覆盖检查。

字形覆盖用 .notdef 指纹比对法：拿私有使用区码点 U+E000 的渲染结果当"缺失"基准，
逐字比对，相同即为缺字。不需要 fontTools，能跑在渲染节点的最小镜像里。
"""

from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from .config import FONT_SEARCH_DIRS

NOTDEF_PROBE = "\ue000"

# 跨平台字体回退链。只在「声明的字体整族不存在」时启用，并且必须留痕——
# 字形形状会变，这跟「缺字静默替换」是两回事：前者是换字体，后者是骗人。
FALLBACK_CHAIN = [
    "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC",
    "Hiragino Sans GB", "PingFang SC", "Heiti SC", "Songti SC",
    "Microsoft YaHei", "Arial Unicode MS", "DejaVu Sans",
]
FONT_EXT = {".ttf", ".otf", ".ttc", ".otc"}


def pillow_available() -> bool:
    try:
        import PIL  # noqa: F401
        return True
    except Exception:
        return False


def _require_pillow():
    try:
        from PIL import ImageFont  # noqa: F401
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "文字图层需要 Pillow：pip install pillow。"
            "本服务刻意不降级——让渲染器现算字形会破坏跨端一致性。"
        ) from exc


def _walk_fonts(dirs: Iterable[str]) -> list[Path]:
    found: list[Path] = []
    for d in dirs:
        p = Path(d)
        if not p.is_dir():
            continue
        for root, subdirs, files in os.walk(p):
            depth = len(Path(root).relative_to(p).parts)
            if depth >= 2:                       # 只下钻两层，避免扫全盘
                subdirs[:] = []
            for fn in files:
                if Path(fn).suffix.lower() in FONT_EXT:
                    found.append(Path(root) / fn)
    return sorted(set(found))


def load(ref: str, size: int):
    """ref 形如 `/path/a.ttc#3`（# 后是 ttc 内字面序号）。"""
    from PIL import ImageFont
    path, idx = split_ref(ref)
    return ImageFont.truetype(path, size, index=idx)


def split_ref(ref: str) -> tuple[str, int]:
    if "#" in ref:
        p, _, i = ref.rpartition("#")
        try:
            return p, int(i)
        except ValueError:
            return ref, 0
    return ref, 0


@lru_cache(maxsize=1)
def font_index() -> dict[str, str]:
    """family(小写) -> 字体引用（path 或 path#index）。

    为什么必须枚举 ttc 内的字面：PIL 打开 .ttc 默认只给第 0 个 face。
    NotoSansCJK-Regular.ttc 的第 0 个是「Noto Sans CJK JP」，
    于是「Noto Sans CJK SC」永远查不到 —— 容器里就会一路回退到 DejaVu（无 CJK）。
    """
    _require_pillow()
    from PIL import ImageFont

    index: dict[str, str] = {}
    score: dict[str, int] = {}

    def _score(style: str, path: Path) -> int:
        """同一 family 有多个字重文件时，优先 Regular。

        Debian 的 Noto 只有 Bold 和 Regular 两个 ttc，按字典序 Bold 在前；
        不排权重的话正文会整篇变粗，肉眼一看就不对。
        """
        st = (style or "").lower()
        pth = path.name.lower()
        if st in ("regular", "w3", "book", "normal", "light") or "regular" in pth:
            return 0
        if any(k in st or k in pth for k in
               ("bold", "black", "heavy", "semibold", "demibold", "medium")):
            return 3
        return 1

    for path in _walk_fonts(FONT_SEARCH_DIRS):
        collection = path.suffix.lower() in (".ttc", ".otc")
        max_face = 16 if collection else 1
        first_ref = str(path)
        for face in range(max_face):
            try:
                font = ImageFont.truetype(str(path), 12, index=face)
            except Exception:
                break
            family, style = font.getname()
            if family:
                ref = str(path) if face == 0 else f"{path}#{face}"
                fam = family.lower()
                sc = _score(style, path)
                if fam not in index or sc < score.get(fam, 9):
                    index[fam] = ref
                    score[fam] = sc
                if style:
                    full = f"{fam} {style.lower()}"
                    if full not in index or sc < score.get(full, 9):
                        index[full] = ref
                        score[full] = sc
        index.setdefault(str(path).lower(), first_ref)
        index.setdefault(path.stem.lower(), first_ref)
    return index


def resolve(family_or_path: str) -> str | None:
    if not family_or_path:
        return None
    p = Path(family_or_path)
    if p.is_file() and p.suffix.lower() in FONT_EXT:
        return str(p)
    return font_index().get(family_or_path.lower())


def resolve_or_fallback(family_or_path: str) -> tuple[str | None, str, str]:
    """返回 (路径, 实际使用的字体名, 警告)。警告非空表示发生了字体族回退。"""
    path = resolve(family_or_path)
    if path:
        return path, family_or_path, ""
    for fb in FALLBACK_CHAIN:
        if fb.lower() == family_or_path.lower():
            continue
        path = resolve(fb)
        if path:
            return path, fb, (f"字体「{family_or_path}」在本机不存在，已回退到「{fb}」；"
                              f"字形会与设计稿不同，请确认")
    return None, family_or_path, ""


def require(family_or_path: str) -> str:
    path = resolve(family_or_path)
    if not path:
        from .errors import JobError
        raise JobError(
            "E_FONT_MISSING",
            f"找不到字体: {family_or_path}",
            hint="把字体文件装进镜像，或在 styles 里用 font_file 指定绝对路径",
            field="styles.*.font_family",
            allowed_values=sorted(k for k in font_index() if "/" not in k)[:40],
        )
    return path


def fingerprint(ref: str) -> str:
    """廉价指纹：路径 + 大小 + mtime。不读全文件，避免大 ttc 拖慢提交。"""
    path, _idx = split_ref(ref)
    st = os.stat(path)
    raw = f"{Path(path).name}|{st.st_size}|{st.st_mtime_ns}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _mask_sig(font, ch: str):
    try:
        m = font.getmask(ch)
    except Exception:
        return None
    return (m.size, bytes(m))


def coverage(path: str, text: str, size: int = 64) -> dict:
    """返回缺字信息。ok=False 时调用方必须硬失败（E_FONT_MISSING）。"""
    _require_pillow()
    from PIL import ImageFont

    real, idx = split_ref(path)
    out = {"font": Path(real).name + (f"#{idx}" if idx else ""),
           "ok": True, "checked": 0, "missing": []}
    try:
        font = ImageFont.truetype(real, size, index=idx)
    except Exception as exc:
        return {**out, "ok": False, "error": f"字体不可加载: {exc}"}

    ref = _mask_sig(font, NOTDEF_PROBE)
    if ref is None:
        return {**out, "ok": False, "error": "无法生成 notdef 指纹"}

    for ch in sorted({c for c in text if c not in "\n\r\t "}):
        out["checked"] += 1
        sig = _mask_sig(font, ch)
        if sig is None or sig == ref:
            out["missing"].append(ch)

    out["ok"] = not out["missing"]
    if out["missing"]:
        out["missing_codepoints"] = [f"U+{ord(c):04X}" for c in out["missing"]]
    return out


def fonts_digest(paths: Iterable[str]) -> str:
    """多个字体的联合指纹，进缓存键。"""
    items = sorted(fingerprint(p) for p in set(paths)
                   if p and os.path.exists(split_ref(p)[0]))
    return hashlib.sha256("|".join(items).encode()).hexdigest()[:32]


def dump_index(path: Path) -> None:
    path.write_text(json.dumps(font_index(), ensure_ascii=False, indent=1))
