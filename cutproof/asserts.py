#!/usr/bin/env python3
"""
asserts.py —— L3 语义断言库 + 证据回执

为什么需要这一层（而不是只靠 SSIM/VMAF）：
    感知指标需要 reference。第一次渲染一个新模板时，你没有 reference——
    谁知道「应该长什么样」。所以 L2 只能做回归，不能判首次正确性。
    首次正确性只能来自可计算的语义断言：字形有没有缺、文本有没有出安全区、
    响度对不对、帧数对不对。这些在编译期和渲染后都能算，不需要参照片。

核心能力：
    font_coverage()    零依赖的字形覆盖检查（notdef 比对法）
    safe_area()        文本包围盒 vs 安全区
    loudness()         EBU R128 整片响度 + true peak
    black_ranges()     黑场区间
    build_receipt()    把 L1/L2/L3 汇成一份给 Agent 读的回执

用法：
    python3 asserts.py fonts --font /path/font.ttc --text "第一性原理"
    python3 asserts.py receipt out/render_base.mp4 --ir ir/sample_15s_vertical.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

# 私有使用区，正常字体不会映射 → 拿来当 .notdef 指纹
NOTDEF_PROBE = "\ue000"


def run(argv: list[str], timeout: int = 300) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stderr or "") + (p.stdout or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def ffprobe(path: Path) -> dict:
    p = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                        "-show_format", "-show_streams", str(path)],
                       capture_output=True, text=True)
    try:
        return json.loads(p.stdout or "{}")
    except Exception:
        return {}


# ══════════════════════════════════════════════════ 字体
def _mask_sig(font, ch: str):
    try:
        m = font.getmask(ch)
    except Exception:
        return None
    return (m.size, bytes(m))


def font_coverage(font_path: str, text: str, size: int = 64) -> dict:
    """返回缺失字符。方法：把每个字的渲染结果与 .notdef（私有区码点）比对。

    为什么不用 fontTools 查 cmap：想保持零依赖，让这个检查能跑在渲染节点的
    最小镜像里。notdef 比对法对 ttc/otf/ttf 都有效，包括 CJK 字体常见的
    @font-face 回退场景。
    """
    from PIL import ImageFont

    out = {"font": font_path, "missing": [], "checked": 0, "ok": True}
    try:
        f = ImageFont.truetype(font_path, size)
    except Exception as e:
        return {**out, "ok": False, "error": f"字体不可加载: {e}"}

    ref = _mask_sig(f, NOTDEF_PROBE)
    if ref is None:
        return {**out, "ok": False, "error": "无法生成 notdef 指纹"}

    chars = sorted({c for c in text if c not in "\n\r\t "})
    for ch in chars:
        sig = _mask_sig(f, ch)
        out["checked"] += 1
        if sig is None or sig == ref:
            out["missing"].append(ch)
    out["ok"] = not out["missing"]
    if out["missing"]:
        out["missing_codepoints"] = [f"U+{ord(c):04X}" for c in out["missing"]]
    return out


# ══════════════════════════════════════════════════ 几何
def safe_area(bbox, width: int, height: int, safe: dict) -> dict:
    if not bbox:
        return {"ok": False, "error": "空墨迹包围盒（文本可能完全没渲染出来）"}
    x0 = width * safe.get("left", 0.0)
    y0 = height * safe.get("top", 0.0)
    x1 = width * (1 - safe.get("right", 0.0))
    y1 = height * (1 - safe.get("bottom", 0.0))
    ok = bbox[0] >= x0 - 1 and bbox[1] >= y0 - 1 and bbox[2] <= x1 + 1 and bbox[3] <= y1 + 1
    return {"ok": ok, "bbox": list(bbox), "safe_rect": [round(x0), round(y0), round(x1), round(y1)],
            "overflow_px": [round(max(0, x0 - bbox[0])), round(max(0, y0 - bbox[1])),
                            round(max(0, bbox[2] - x1)), round(max(0, bbox[3] - y1))]}


# ══════════════════════════════════════════════════ 音频
def loudness(path: Path, target: float = -14.0, tol: float = 0.5) -> dict:
    rc, out = run(["ffmpeg", "-v", "info", "-nostats", "-i", str(path),
                   "-af", "ebur128=peak=true", "-f", "null", "-"], timeout=600)
    lufs = re.findall(r"I:\s*(-?\d+\.\d+)\s*LUFS", out)
    tp = re.findall(r"Peak:\s*(-?\d+\.\d+)\s*dBFS", out)
    val = float(lufs[-1]) if lufs else None
    return {"integrated_lufs": val, "true_peak_dbfs": float(tp[-1]) if tp else None,
            "target_lufs": target, "tolerance": tol,
            "ok": (val is not None and abs(val - target) <= tol)}


def black_ranges(path: Path, min_dur: float = 0.3) -> dict:
    rc, out = run(["ffmpeg", "-v", "info", "-nostats", "-i", str(path),
                   "-vf", f"blackdetect=d={min_dur}:pix_th=0.10", "-f", "null", "-"],
                  timeout=600)
    hits = [{"start": float(a), "end": float(b)}
            for a, b in re.findall(r"black_start:(\d+\.?\d*)\s+black_end:(\d+\.?\d*)", out)]
    return {"ranges": hits, "count": len(hits)}


# ══════════════════════════════════════════════════ 结构
def structure(path: Path) -> dict:
    meta = ffprobe(path)
    v = next((s for s in meta.get("streams", []) if s["codec_type"] == "video"), {})
    a = next((s for s in meta.get("streams", []) if s["codec_type"] == "audio"), {})
    num, den = (v.get("r_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    nb = int(v.get("nb_frames") or round(float(v.get("duration", 0)) * fps))
    return {"width": v.get("width"), "height": v.get("height"),
            "fps": f"{num}/{den}", "fps_value": round(fps, 4), "frames": nb,
            "pix_fmt": v.get("pix_fmt"), "codec": v.get("codec_name"),
            "color_primaries": v.get("color_primaries"), "color_transfer": v.get("color_transfer"),
            "color_space": v.get("color_space"), "color_range": v.get("color_range"),
            "audio_codec": a.get("codec_name"),
            "audio_rate": int(a["sample_rate"]) if a.get("sample_rate") else None,
            "audio_channels": a.get("channels"),
            "audio_duration": float(a["duration"]) if a.get("duration") else None,
            "duration": float(meta.get("format", {}).get("duration", 0) or 0),
            "size_bytes": path.stat().st_size}


# ══════════════════════════════════════════════════ 证据
def evidence_clips(path: Path, outdir: Path) -> dict:
    outdir.mkdir(parents=True, exist_ok=True)
    st = structure(path)
    total = st["frames"]
    sheet = outdir / "evidence_contact_sheet.jpg"
    first = outdir / "evidence_first.jpg"
    last = outdir / "evidence_last.jpg"
    wave = outdir / "evidence_waveform.png"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(path),
         "-vf", "select='not(mod(n\\,45))',scale=270:-1,tile=5x2", "-frames:v", "1", str(sheet)])
    run(["ffmpeg", "-y", "-v", "error", "-i", str(path), "-vf", "select=eq(n\\,0)",
         "-frames:v", "1", "-q:v", "2", str(first)])
    run(["ffmpeg", "-y", "-v", "error", "-i", str(path),
         "-vf", f"select=eq(n\\,{max(0, total - 1)})", "-frames:v", "1", "-q:v", "2", str(last)])
    run(["ffmpeg", "-y", "-v", "error", "-i", str(path),
         "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x200:colors=#2E5A88",
         "-frames:v", "1", str(wave)])
    return {k: str(v) for k, v in
            {"contact_sheet": sheet, "first_frame": first, "last_frame": last, "waveform": wave}.items()
            if Path(v).exists()}


# ══════════════════════════════════════════════════ 回执
def build_receipt(ir: dict, render: Path, ir_path: Path,
                  reference: Path | None = None, vmaf_gate: float = 95.0,
                  font: str | None = None) -> dict:
    o = ir["output"]
    st = structure(render)
    failures: list[str] = []

    # ── L1 结构 ──
    dur_s = o["duration_frames"] / (o["fps"]["num"] / o["fps"]["den"])
    l1 = {
        "resolution": {"actual": [st["width"], st["height"]],
                       "expect": [o["width"], o["height"]],
                       "pass": (st["width"], st["height"]) == (o["width"], o["height"])},
        "fps": {"actual": st["fps"], "expect": f'{o["fps"]["num"]}/{o["fps"]["den"]}',
                "pass": st["fps"] == f'{o["fps"]["num"]}/{o["fps"]["den"]}'},
        "frames": {"actual": st["frames"], "expect": o["duration_frames"],
                   "pass": st["frames"] == o["duration_frames"]},
        "pix_fmt": {"actual": st["pix_fmt"], "expect": o["video"]["pix_fmt"],
                    "pass": st["pix_fmt"] == o["video"]["pix_fmt"]},
        "color_space": {"actual": st["color_space"], "expect": "bt709",
                        "pass": st["color_space"] == "bt709"},
        "color_range": {"actual": st["color_range"], "expect": "tv",
                        "pass": st["color_range"] in ("tv", "limited")},
        "audio_rate": {"actual": st["audio_rate"], "expect": o["audio"]["sample_rate"],
                       "pass": st["audio_rate"] == o["audio"]["sample_rate"]},
        "audio_channels": {"actual": st["audio_channels"], "expect": o["audio"]["channels"],
                           "pass": st["audio_channels"] == o["audio"]["channels"]},
    }
    audio_delta = None
    if st["audio_duration"] is not None:
        audio_delta = round(abs(st["audio_duration"] - dur_s) * (o["fps"]["num"] / o["fps"]["den"]), 2)
    l1["audio_duration_delta_frames"] = {"actual": audio_delta, "expect": "<= 1",
                                         "pass": audio_delta is not None and audio_delta <= 1.0}
    for k, v in l1.items():
        if isinstance(v, dict) and not v.get("pass", True):
            failures.append(f"L1_{k.upper()}_MISMATCH")

    # ── L2 感知（仅回归）──
    l2 = {"applicable": reference is not None, "gate": vmaf_gate,
          "note": "L2 需要 reference，只能做回归，不能判首次正确性"}
    if reference is not None and reference.exists():
        rc, out = run(["ffmpeg", "-v", "info", "-i", str(reference), "-i", str(render),
                       "-lavfi", "[0:v][1:v]libvmaf", "-f", "null", "-"], timeout=1200)
        m = re.search(r"VMAF score:\s*(\d+\.\d+)", out)
        l2["vmaf"] = float(m.group(1)) if m else None
        l2["pass"] = l2["vmaf"] is not None and l2["vmaf"] >= vmaf_gate
        if l2["vmaf"] is not None and not l2["pass"]:
            failures.append("L2_VMAF_BELOW_GATE")

    # ── L3 语义 ──
    l3: dict = {}

    # 字形覆盖（编译期可判，此处对成片再确认一次）
    texts = [c.get("text", "") for t in ir["tracks"] if t["kind"] == "text"
             for c in t["clips"]]
    if texts and font:
        fc = font_coverage(font, "\n".join(texts))
        l3["font_coverage"] = fc
        if not fc["ok"]:
            failures.append("E_FONT_MISSING")
    elif texts:
        l3["font_coverage"] = {"ok": True, "skipped": "未提供字体文件，跳过（生产环境禁止跳过）"}

    # 安全区：直接用编译器在编译期算出的墨迹包围盒，不重新渲染
    layers_file = render.parent / "layers.json"
    if layers_file.exists():
        layers = json.loads(layers_file.read_text())
        l3["safe_area"] = [{
            "track": l["track"],
            "frames": [l["at_frame"], l["out_frame"]],
            "bbox": l.get("bbox_px"),
            "within_safe_area": l.get("within_safe_area"),
            "sha256": l["sha256"][:16],
        } for l in layers]
        if any(l.get("within_safe_area") is False for l in layers):
            failures.append("L3_TEXT_OUTSIDE_SAFE_AREA")
    else:
        l3["safe_area"] = {"note": "未找到 layers.json，先跑一次编译"}

    l3["loudness"] = loudness(render, o["audio"].get("target_lufs", -14.0))
    if not l3["loudness"]["ok"]:
        failures.append("L3_LOUDNESS_OUT_OF_RANGE")
    l3["black_frames"] = black_ranges(render)

    verdict = "pass" if not failures else "fail"
    return {
        "schema": "cutproof/receipt/v1",
        "ir_id": ir.get("id"), "ir_hash": hashlib.sha256(ir_path.read_bytes()).hexdigest()[:16],
        "render": str(render), "render_sha256": hashlib.sha256(render.read_bytes()).hexdigest()[:16],
        "L1": {"structural": st, "assertions": l1},
        "L2": l2,
        "L3": l3,
        "verdict": verdict,
        "failures": failures,
        "evidence": evidence_clips(render, render.parent / "evidence"),
        "generated_at": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("fonts")
    p.add_argument("--font", required=True)
    p.add_argument("--text", required=True)
    p.set_defaults(fn=lambda a: print(json.dumps(font_coverage(a.font, a.text),
                                                ensure_ascii=False, indent=2)))

    p = sub.add_parser("receipt")
    p.add_argument("render")
    p.add_argument("--ir", default=str(Path(__file__).parent / "ir/sample_15s_vertical.json"))
    p.add_argument("--reference", default=None)
    p.add_argument("--font", default=None)
    p.add_argument("--out", default=None)

    def _r(a):
        ir_p = Path(a.ir)
        rec = build_receipt(json.loads(ir_p.read_text()), Path(a.render), ir_p,
                            Path(a.reference) if a.reference else None, font=a.font)
        dst = Path(a.out) if a.out else Path(a.render).parent / "receipt.json"
        dst.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({k: rec[k] for k in ("verdict", "failures", "L2")},
                         ensure_ascii=False, indent=2))
        print(f"→ {dst}")
        if rec["verdict"] != "pass":
            sys.exit(1)

    p.set_defaults(fn=_r)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
