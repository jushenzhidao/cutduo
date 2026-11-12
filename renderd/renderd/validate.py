"""三层校验与证据回执。

L1 结构层：字段全等，同后端要求字节一致
L2 感知层：只有拿到 reference 才有意义 —— 只用于回归，不能判首次正确性
L3 语义层：字形覆盖 / 安全区 / 响度 / 黑场 —— 唯一能判「首次对不对」的东西
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from . import RECEIPT_SCHEMA
from .ir import duration_seconds
from .render import probe_json
from .textlayer import Layer

_S = re.compile(r"SSIM.*?All:\s*([0-9.]+)")
_P = re.compile(r"PSNR.*?average:\s*([0-9.]+|inf)")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def structural(meta: dict, path: Path) -> dict:
    streams = meta.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    a = next((s for s in streams if s.get("codec_type") == "audio"), {})
    num, den = (v.get("r_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    nb = int(v.get("nb_frames") or round(float(v.get("duration", 0) or 0) * fps))
    return {
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": f"{num}/{den}",
        "fps_value": round(fps, 4),
        "frames": nb,
        "pix_fmt": v.get("pix_fmt"),
        "codec": v.get("codec_name"),
        "color_primaries": v.get("color_primaries"),
        "color_transfer": v.get("color_transfer"),
        "color_space": v.get("color_space"),
        "color_range": v.get("color_range"),
        "audio_codec": a.get("codec_name"),
        "audio_rate": int(a["sample_rate"]) if a.get("sample_rate") else None,
        "audio_channels": a.get("channels"),
        "audio_duration": float(a["duration"]) if a.get("duration") else None,
        "duration": float(meta.get("format", {}).get("duration") or 0),
        "size_bytes": path.stat().st_size if path.exists() else 0,
    }


def l1(struct: dict, ir: dict) -> tuple[dict, list[str]]:
    o = ir["output"]
    fps_str = f'{o["fps"]["num"]}/{o["fps"]["den"]}'
    dur_s = duration_seconds(ir)
    checks = {
        "resolution": ((struct["width"], struct["height"]), (o["width"], o["height"])),
        "fps": (struct["fps"], fps_str),
        "frames": (struct["frames"], o["duration_frames"]),
        "pix_fmt": (struct["pix_fmt"], o["video"]["pix_fmt"]),
        "color_space": (struct["color_space"], "bt709"),
        "color_range": (struct["color_range"], "tv"),
        "audio_rate": (struct["audio_rate"], o["audio"]["sample_rate"]),
        "audio_channels": (struct["audio_channels"], o["audio"]["channels"]),
    }
    out: dict[str, dict] = {}
    fails: list[str] = []
    for name, (actual, expect) in checks.items():
        if name == "color_range":
            ok = actual in ("tv", "limited", None)
        else:
            ok = actual == expect
        out[name] = {"actual": actual, "expect": expect, "pass": bool(ok)}
        if not ok:
            fails.append(f"L1_{name.upper()}_MISMATCH")

    delta = None
    if struct["audio_duration"] is not None:
        delta = round(abs(struct["audio_duration"] - dur_s) * (o["fps"]["num"] / o["fps"]["den"]), 2)
    ok_delta = delta is not None and delta <= 1.0
    out["audio_duration_delta_frames"] = {"actual": delta, "expect": "<=1", "pass": ok_delta}
    if not ok_delta:
        fails.append("L1_AUDIO_DESYNC")

    out["frames_match"] = {
        "actual": struct["frames"], "expect": o["duration_frames"],
        "pass": struct["frames"] == o["duration_frames"],
    }
    return out, fails


def loudness(ffmpeg: str, path: Path, target: float | None = -14.0,
             tol: float = 1.0, timeout: float = 300) -> dict:
    """测整体响度并对目标做断言。

    `target=None`（或 0）表示 IR 显式关闭了响度归一（`audio.target_lufs: null`）：
    这时只测量、不判定 —— 是否「够响」由调用方自己按素材决定，不该拿 -14 去卡。
    """
    try:
        p = subprocess.run([ffmpeg, "-v", "info", "-nostats", "-i", str(path),
                            "-af", "ebur128=peak=true", "-f", "null", "-"],
                           capture_output=True, text=True, timeout=timeout)
        err = p.stderr
    except Exception as exc:
        return {"ok": False, "error": str(exc), "target_lufs": target}
    lufs = re.findall(r"I:\s*(-?\d+\.\d+)\s*LUFS", err)
    tp = re.findall(r"Peak:\s*(-?\d+\.\d+)\s*dBFS", err)
    val = float(lufs[-1]) if lufs else None
    normalised = target not in (None, 0, 0.0)
    return {
        "integrated_lufs": val,
        "true_peak_dbfs": float(tp[-1]) if tp else None,
        "target_lufs": target if normalised else None,
        "tolerance": tol,
        "normalised": normalised,
        "note": None if normalised else "IR 关闭了响度归一，仅测量不判定",
        "ok": val is not None and (not normalised or abs(val - float(target)) <= tol),
    }


def black_ranges(ffmpeg: str, path: Path, min_dur: float = 0.3,
                 timeout: float = 300) -> dict:
    try:
        p = subprocess.run([ffmpeg, "-v", "info", "-nostats", "-i", str(path),
                            "-vf", f"blackdetect=d={min_dur}:pix_th=0.10",
                            "-f", "null", "-"], capture_output=True, text=True,
                           timeout=timeout)
        hits = [{"start": float(a), "end": float(b)} for a, b in
                re.findall(r"black_start:(\d+\.?\d*)\s+black_end:(\d+\.?\d*)", p.stderr)]
    except Exception:
        hits = []
    return {"ranges": hits, "count": len(hits)}


def vmaf(ffmpeg: str, reference: Path, candidate: Path,
         timeout: float = 1800) -> float | None:
    try:
        p = subprocess.run([ffmpeg, "-v", "info", "-nostats",
                            "-i", str(reference), "-i", str(candidate),
                            "-lavfi", "[0:v][1:v]libvmaf", "-f", "null", "-"],
                           capture_output=True, text=True, timeout=timeout)
        m = re.search(r"VMAF score:\s*(\d+\.\d+)", p.stderr)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def ssim_psnr(ffmpeg: str, a: Path, b: Path, timeout: float = 1800) -> dict:
    out: dict = {}
    for name, filt, rx in (("ssim", "[0:v][1:v]ssim", _S),
                           ("psnr", "[0:v][1:v]psnr", _P)):
        try:
            p = subprocess.run([ffmpeg, "-v", "info", "-nostats", "-i", str(a),
                                "-i", str(b), "-lavfi", filt, "-f", "null", "-"],
                               capture_output=True, text=True, timeout=timeout)
            m = rx.search(p.stderr)
            out[name] = (float(m.group(1)) if m and m.group(1) != "inf"
                         else (float("inf") if m else None))
        except Exception:
            out[name] = None
    return out


_BLACK_HIT = re.compile(r"black_start:(\d+\.?\d*)\s+black_end:(\d+\.?\d*)")


def video_analysis(ffmpeg: str, path: Path, out_dir: Path, frames: int,
                   fps: float = 30.0, timeout: float = 300) -> dict:
    """一次解码同时产出黑场区间与接触表，末帧用 seek。

    为什么合：原来 blackdetect、contact sheet、last frame 各自完整解码一遍，
    450 帧的片子光这三遍就要 7 s（占单任务 29%）。合并后视频只解一次，
    末帧改成从结尾 seek，实测 2.15 s → 0.35 s。

    合并只在同一个解码器输出上分叉，**断言输入完全不变**：
    黑场区间与接触表的帧号选择都与原来一致（接触表已逐字节比对过）。
    任何一步失败都回落到原来的单遍实现 —— 验证结果不能因为优化而缺失。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    ev = {
        "contact_sheet": out_dir / "contact_sheet.jpg",
        "first_frame": out_dir / "first.jpg",
        "last_frame": out_dir / "last.jpg",
        "waveform": out_dir / "waveform.png",
    }
    hits: list[dict] = []

    # 1) 黑场 + 接触表：同一次解码，两个分支
    graph = ("[0:v]split=2[b1][b2];"
             "[b1]blackdetect=d=0.3:pix_th=0.10[bd];[bd]nullsink;"
             "[b2]select='not(mod(n\\,45))',scale=270:-1,tile=5x2[cs]")
    try:
        p = subprocess.run(
            [ffmpeg, "-v", "info", "-nostats", "-i", str(path),
             "-filter_complex", graph, "-map", "[cs]", "-frames:v", "1",
             "-y", str(ev["contact_sheet"])],
            capture_output=True, text=True, timeout=timeout)
        hits = [{"start": float(a), "end": float(b)}
                for a, b in _BLACK_HIT.findall(p.stderr)]
    except Exception:
        pass

    # 回落：合并跑失败就退回两遍，宁可慢也不能少证据
    if not ev["contact_sheet"].exists():
        try:
            subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(path), "-vf",
                            "select='not(mod(n\\,45))',scale=270:-1,tile=5x2",
                            "-frames:v", "1", str(ev["contact_sheet"])],
                           capture_output=True, timeout=timeout)
        except Exception:
            pass
        hits = black_ranges(ffmpeg, path, timeout=timeout)["ranges"]

    # 2) 首帧（只解 1 帧，本来就便宜）
    try:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(path), "-vf",
                        "select=eq(n\\,0)", "-frames:v", "1", "-q:v", "2",
                        str(ev["first_frame"])], capture_output=True, timeout=timeout)
    except Exception:
        pass

    # 3) 末帧：从结尾 seek，而不是解到第 N 帧。
    #    eps 取 1.5 帧：实测 -0.1 s（3 帧 @30fps）会早一帧，-0.05 s 正好是末帧。
    eps = max(1.5 / max(fps, 1.0), 0.02)
    try:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-sseof", f"-{eps:.4f}",
                        "-i", str(path), "-frames:v", "1", "-q:v", "2",
                        str(ev["last_frame"])], capture_output=True, timeout=timeout)
    except Exception:
        pass
    if not ev["last_frame"].exists():        # 极短片或 seek 失败：退回全解码取末帧
        try:
            subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(path), "-vf",
                            f"select=eq(n\\,{max(0, frames - 1)})", "-frames:v", "1",
                            "-q:v", "2", str(ev["last_frame"])], capture_output=True,
                           timeout=timeout)
        except Exception:
            pass

    # 4) 波形（音频，本来就便宜：实测 92 ms）
    try:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(path), "-filter_complex",
                        "aformat=channel_layouts=mono,showwavespic=s=1200x200:colors=#2E5A88",
                        "-frames:v", "1", str(ev["waveform"])],
                       capture_output=True, timeout=timeout)
    except Exception:
        pass

    return {
        "black": {"ranges": hits, "count": len(hits)},
        "evidence": {k: str(v) for k, v in ev.items() if v.exists()},
    }


def evidence(ffmpeg: str, path: Path, out_dir: Path, frames: int,
             timeout: float = 300) -> dict:
    """只要证据文件（保留旧签名，内部已合并解码）。"""
    return video_analysis(ffmpeg, path, out_dir, frames, timeout=timeout)["evidence"]


def build_receipt(*, ir: dict, ir_hash: str, render_path: Path, struct: dict,
                  layers: list[Layer], font_coverage: dict | None,
                  loud: dict, black: dict, ev: dict,
                  warnings: list[str], reference: Path | None = None,
                  vmaf_gate: float = 95.0, extra_l1_fails: list[str] | None = None,
                  has_audio_track: bool = True,
                  ingest: dict | None = None, delivery: dict | None = None) -> dict:
    assertions, fails = l1(struct, ir)
    fails = list(fails) + list(extra_l1_fails or [])

    l2: dict = {
        "applicable": reference is not None,
        "gate": vmaf_gate,
        "note": "L2 需要 reference，只能做回归，不能判首次正确性",
    }
    if reference is not None and reference.exists():
        score = vmaf("ffmpeg", reference, render_path)
        l2["vmaf"] = score
        l2["pass"] = score is not None and score >= vmaf_gate
        if not l2["pass"]:
            fails.append("L2_VMAF_BELOW_GATE")

    l3: dict = {
        "font_coverage": font_coverage or {"ok": True, "skipped": "无文本轨"},
        "safe_area": [l.summary() for l in layers],
        "loudness": loud,
        "black_frames": black,
    }
    if font_coverage and not font_coverage.get("ok", True):
        fails.append("E_FONT_MISSING")
    if any(l.within_safe is False for l in layers):
        fails.append("L3_TEXT_OUTSIDE_SAFE_AREA")
    if not has_audio_track:
        # 无音轨的片子（静音信息流）不该被要求 -14 LUFS：补的是静音，不是内容
        l3["loudness"] = {**loud, "applicable": False, "ok": True,
                          "note": "IR 无音轨，响度断言不适用"}
    elif not loud.get("ok", False):
        fails.append("L3_LOUDNESS_OUT_OF_RANGE")

    verdict = "pass" if not fails else "fail"
    return {
        "schema": RECEIPT_SCHEMA,
        "ir_id": ir.get("id"),
        "ir_hash": ir_hash,
        "render": str(render_path),
        "render_sha256": sha256_file(render_path) if render_path.exists() else None,
        "L0_ingest": ingest or {"applicable": False},
        "L1": {"structural": struct, "assertions": assertions},
        "L2": l2,
        "L3": l3,
        "delivery": delivery or {"mode": "local"},
        "verdict": verdict,
        "failures": sorted(set(fails)),
        "warnings": warnings,
        "evidence": ev,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def copy_evidence(ev: dict, dest_dir: Path) -> dict:
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = {}
    for k, p in ev.items():
        src = Path(p)
        if not src.exists():
            continue
        dst = dest_dir / src.name
        try:
            shutil.copy2(src, dst)
            out[k] = str(dst)
        except Exception:
            out[k] = str(src)
    return out
