#!/usr/bin/env python3
"""
对比测试的量化部分：SSIM / PSNR 矩阵 + 编码蒸馏。

原则：所有数字来自 ffmpeg 实测，脚本不写死任何常量。
像素级对比只在「同内容」的片之间才有意义——A↔B 是换传输，C↔D 是换引擎，
A↔C 是换壁纸内容，后者 SSIM 低不代表画质差，只代表画面不同。
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "out"
FF = "/opt/homebrew/bin/ffmpeg"
FP = "/opt/homebrew/bin/ffprobe"

VARIANTS = {
    "a": "static/jpeg · 现状",
    "b": "static/raw · 换传输",
    "c": "gpu/jpeg · 换引擎",
    "d": "js/jpeg · CPU 同效",
    "e": "gpu/raw · 综合",
}


def probe(p):
    r = subprocess.run(
        [FP, "-v", "error", "-show_entries", "stream=width,height,nb_frames,r_frame_rate,codec_name",
         "-show_entries", "format=duration,size", "-of", "json", str(p)],
        capture_output=True, text=True)
    d = json.loads(r.stdout)
    st = d["streams"][0]
    return {
        "codec": st["codec_name"], "w": st["width"], "h": st["height"],
        "frames": int(st.get("nb_frames") or 0),
        "duration": float(d["format"]["duration"]),
        "sizeMB": round(int(d["format"]["size"]) / 1048576, 2),
        "bitrateMbps": round(int(d["format"]["size"]) * 8 / float(d["format"]["duration"]) / 1e6, 3),
    }


def metric(a, b, filt):
    """ssim 返回 Y/U/V/All 四个值（Y 才是画面结构，U/V 受色度子采样影响）；
    psnr 返回 All 通道的 dB。"""
    r = subprocess.run(
        [FF, "-hide_banner", "-loglevel", "info", "-i", str(a), "-i", str(b),
         "-lavfi", f"[0:v]setpts=PTS-STARTPTS[x];[1:v]setpts=PTS-STARTPTS[y];[x][y]{filt}",
         "-f", "null", "-"], capture_output=True, text=True)
    txt = r.stderr
    if filt.startswith("ssim"):
        # ffmpeg 的输出形如：SSIM Y:0.99 (20.1) U:0.98 (…) V:0.99 (…) All:0.99 (20.0)
        line = ""
        for ln in txt.splitlines():
            if "SSIM" in ln and "Y:" in ln:
                line = ln
        if not line:
            return None
        def pick(key):
            m = re.search(rf"{key}:([0-9.]+)", line)
            return float(m.group(1)) if m else None
        return {"Y": pick("Y"), "U": pick("U"), "V": pick("V"), "All": pick("All")}
    m = re.findall(r"average:([0-9.]+)", txt)
    return float(m[-1]) if m else None


def main():
    files = {k: OUT / f"cmp-{k}.mp4" for k in VARIANTS}
    missing = [k for k, p in files.items() if not p.exists()]
    if missing:
        sys.exit(f"缺少成片：{missing}")

    info = {k: probe(p) for k, p in files.items()}

    # 成对比较：只对这些组合做像素级判据，其余无意义
    pairs = [("a", "b", "换传输（应几乎无损）"),
             ("c", "d", "换引擎（同公式）"),
             ("a", "c", "换壁纸内容（画面本就不同）"),
             ("e", "c", "综合 vs 仅换引擎")]

    rows = []
    for x, y, why in pairs:
        rows.append({
            "x": x, "y": y, "why": why,
            "ssim": metric(files[x], files[y], "ssim"),
            "psnr": metric(files[x], files[y], "psnr"),
        })

    # 编码蒸馏：对综合方案片做四种编码，比体积与保真度
    src = files["e"]
    codecs = [
        ("h264", ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast"], "mp4"),
        ("h265", ["-c:v", "libx265", "-crf", "24", "-preset", "fast", "-tag:v", "hvc1"], "mp4"),
        ("vp9", ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1"], "webm"),
        ("av1", ["-c:v", "libsvtav1", "-crf", "32", "-preset", "8"], "mp4"),
    ]
    enc = []
    for name, args, ext in codecs:
        dst = OUT / f"cmp-e-{name}.{ext}"
        fresh = dst.exists() and dst.stat().st_mtime > src.stat().st_mtime
        if not fresh:
            subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                            *args, "-an", str(dst)], capture_output=True, text=True)
        if not dst.exists():
            enc.append({"name": name, "ok": False, "err": "编码失败或文件为空"})
            continue
        e = probe(dst)
        e.update({"name": name, "ok": True,
                  "ssim": metric(src, dst, "ssim"),
                  "psnr": metric(src, dst, "psnr")})
        enc.append(e)

    # 交付完整性：帧数/时长的硬判据（对比片也不能缺帧）
    for k, v in info.items():
        v["expectedFrames"] = 1419
        v["framesOk"] = v["frames"] == 1419

    payload = {"variants": {k: {**v, "label": VARIANTS[k]} for k, v in info.items()},
               "pairs": rows, "codecs": enc}
    (OUT / "cmp-quality.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    print(f"{'变体':<6}{'编码':<8}{'帧数':>6}{'时长':>9}{'MB':>8}{'Mbps':>8}")
    for k, v in info.items():
        print(f"{k:<6}{v['codec']:<8}{v['frames']:>6}{v['duration']:>9.3f}{v['sizeMB']:>8}{v['bitrateMbps']:>8}")
    print("\n成对比较（Y 通道 = 画面结构；U/V 受 4:2:0 子采样影响）")
    for r in rows:
        s = r["ssim"]
        if s:
            print(f"  {r['x']}↔{r['y']}  SSIM Y {s['Y']:.5f} / U {s['U']:.5f} / V {s['V']:.5f} / All {s['All']:.5f}"
                  f"   PSNR {r['psnr']:.2f} dB   {r['why']}")
        else:
            print(f"  {r['x']}↔{r['y']}  SSIM 不可用   {r['why']}")
    print("\n编码蒸馏（源 = e 综合方案）")
    for e in enc:
        if not e["ok"]:
            print(f"  {e['name']:<6} 不可用：{e['err']}")
        elif e.get("ssim"):
            print(f"  {e['name']:<6}{e['sizeMB']:>7}MB  {e['bitrateMbps']:>6}Mbps  "
                  f"SSIM Y {e['ssim']['Y']:.5f}  PSNR {e['psnr']:.2f}dB")
        else:
            print(f"  {e['name']:<6}{e['sizeMB']:>7}MB  {e['bitrateMbps']:>6}Mbps  （质量指标不可用）")


if __name__ == "__main__":
    main()
