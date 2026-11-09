"""引擎能力探测。

为什么要探测，而不是在代码里写死一组「支持的能力」：

同一份 renderd 可能跑在两种 ffmpeg 上 —— Debian 打包版、或官方静态构建。
两者的滤镜集**不一样**，最典型的是 `libvmaf`（Debian 的 ffmpeg 不带）。
写死常量会在换镜像时对客户端撒谎：`/healthz` 说支持 L2，实际一跑就
"No such filter"。

所以：启动后跑一次 `ffmpeg -filters` 与 `-buildconf`，把结果缓存起来，
由 `/healthz` 如实暴露。能力缺失从此是可观测的，而不是等验证阶段才炸。

注意滤镜的正名：VMAF 的滤镜叫 `libvmaf`，不是 `vmaf`。用错名字会得出
"两边都缺"的错误结论（本项目就踩过这个坑）。
"""

from __future__ import annotations

import functools
import re
import subprocess

# 这些滤镜是「能对客户承诺什么」的分界线：
#   zscale    HDR → SDR 的色调映射（没有它 HDR 素材只能走近似路径）
#   libvmaf   L2 感知层（回执里 L2 是否有资格适用）
#   subtitles 字幕烧录（需要 libass）
#   drawtext  文字图层兜底（Pillow 不可用时的降级路径）
#   loudnorm  响度归一到 target_lufs
REQUIRED_FILTERS = ("zscale", "libvmaf", "subtitles", "drawtext", "loudnorm")

# 构建期开关，用于解释「为什么某个滤镜不在」
BUILD_FLAGS = ("libvmaf", "libzimg", "libass", "libx264", "libx265", "libfreetype")


@functools.lru_cache(maxsize=4)
def probe(ffmpeg: str) -> dict:
    """探测一次并缓存。返回 {version, filters, build_flags, error?}。

    任何一步失败都不抛异常 —— 健康端点不该因为探测失败而 500，
    它要如实说明「没探到」。
    """
    out: dict = {"binary": ffmpeg, "version": None, "filters": {}, "build_flags": {}}

    try:
        ver = subprocess.run([ffmpeg, "-hide_banner", "-version"],
                             capture_output=True, text=True, timeout=20)
        first = (ver.stdout or "").strip().splitlines()
        head = first[0] if first else ""
        m = re.search(r"ffmpeg version (\S+)", head)
        out["version"] = m.group(1) if m else (head[:80] or None)
    except Exception as exc:                    # noqa: BLE001 — 探测失败要原样报告
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out

    try:
        flt = subprocess.run([ffmpeg, "-hide_banner", "-filters"],
                             capture_output=True, text=True, timeout=30)
        names: set[str] = set()
        for line in (flt.stdout or "").splitlines():
            parts = line.split()
            # 行格式：` T.. name  in->out  描述`，名字在第二列
            if len(parts) >= 3 and parts[0].startswith(("T", ".", "V", "A", "S")):
                names.add(parts[1])
        out["filters"] = {n: (n in names) for n in REQUIRED_FILTERS}
    except Exception as exc:                    # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"

    try:
        bc = subprocess.run([ffmpeg, "-hide_banner", "-buildconf"],
                            capture_output=True, text=True, timeout=20)
        text = bc.stdout or ""
        out["build_flags"] = {f: (f"--enable-{f}" in text) for f in BUILD_FLAGS}
    except Exception:                           # noqa: BLE001 — 非致命
        pass

    return out


def summary(ffmpeg: str) -> dict:
    """给 /healthz 用的精简视图：只留「能不能做」和版本。"""
    info = probe(ffmpeg)
    filters = info.get("filters") or {}
    return {
        "version": info.get("version"),
        "filters": filters,
        # 一步到位的判断：L2 能不能跑
        "l2_vmaf": bool(filters.get("libvmaf")),
        "hdr_zscale": bool(filters.get("zscale")),
        **({"probe_error": info["error"]} if info.get("error") else {}),
    }
