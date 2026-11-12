#!/usr/bin/env python3
"""Measure the delivered films so the gates can be calibrated instead of copied.

For every film: opening motion (qc hook), mean lightness L* (qc bright), exact duplicate frames (qc dup) and black
intervals (qc black). Writes calibration.json plus a markdown table, then prints the percentile summary that the
thresholds should be set from.

Usage:  python3 calibrate.py [corpus.txt]
"""
import json
import pathlib
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parents[2]
QC = pathlib.Path.home() / ".claude/skills/cinecode/scripts/qc.py"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def run(check, video):
    r = subprocess.run([sys.executable, str(QC), check, str(video)], capture_output=True, text=True)
    return r.stdout + r.stderr


def probe(video):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate,nb_frames", "-show_entries", "format=duration",
                        "-of", "json", str(video)], capture_output=True, text=True)
    d = json.loads(r.stdout or "{}")
    st = (d.get("streams") or [{}])[0]
    return {
        "w": st.get("width"), "h": st.get("height"),
        "fps": st.get("r_frame_rate"),
        "dur": float(d.get("format", {}).get("duration") or 0),
    }


def luma_stats(path, fps):
    """Per-second luma spread: a frame with almost no range is an empty frame, whatever the palette is."""
    step = max(1, int(round(fps or 24)))
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-an",
                        "-vf", f"select='not(mod(n,{step}))',signalstats,metadata=print:file=-",
                        "-f", "null", "-"], capture_output=True, text=True)
    txt = r.stdout + r.stderr
    ymin = [int(x) for x in re.findall(r"YMIN=(\d+)", txt)]
    ymax = [int(x) for x in re.findall(r"YMAX=(\d+)", txt)]
    yavg = [float(x) for x in re.findall(r"YAVG=([0-9.]+)", txt)]
    n = min(len(ymin), len(ymax))
    if not n:
        return {}
    spread = [ymax[i] - ymin[i] for i in range(n)]
    return {
        "samples": n,
        "flat_pct": round(100.0 * sum(1 for v in spread if v < 40) / n, 2),
        "black_pct": round(100.0 * sum(1 for i in range(n) if ymax[i] < 24) / n, 2),
        "yavg_mean": round(sum(yavg) / len(yavg), 1) if yavg else None,
    }


def one(path):
    p = ROOT / path
    if not p.exists():
        return {"file": path, "error": "missing"}
    info = probe(p)
    out = {"file": path, **info}

    m = re.search(r"mean=([0-9.]+)\s+min=([0-9.]+)\s+first_step=([0-9.]+)", run("hook", p))
    if m:
        out["hook_mean"], out["hook_min"], out["hook_first"] = (float(g) for g in m.groups())
    out["hook_pass"] = "PASS" in run("hook", p)

    m = re.search(r"mean L\*: ([0-9.]+), min: ([0-9.]+), max: ([0-9.]+), .*?: ([0-9.]+)%", run("bright", p))
    if m:
        out["L_mean"], out["L_min"], out["L_max"], out["L_dark_pct"] = (float(g) for g in m.groups())

    m = re.search(r"frames: (\d+), duplicates: (\d+)", run("dup", p))
    if m:
        out["frames"], out["dups"] = int(m.group(1)), int(m.group(2))
        out["dup_pct"] = round(100.0 * out["dups"] / max(1, out["frames"]), 2)

    fps = None
    try:
        fps = float(str(info.get("fps", "24/1")).split("/")[0]) / (float(str(info.get("fps", "24/1")).split("/")[1]) if "/" in str(info.get("fps")) else 1)
    except Exception:
        fps = 24
    out.update(luma_stats(p, fps))

    black = run("black", p)
    durs = [float(x) for x in re.findall(r"black_duration:([0-9.]+)", black)]
    out["black_s"], out["black_n"] = round(sum(durs), 2), len(durs)
    return out


def pct(vals, q):
    v = sorted(vals)
    if not v:
        return None
    k = (len(v) - 1) * q / 100.0
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo), 3)


def main():
    listing = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/corpus.txt")
    files = [ln.strip() for ln in listing.read_text().splitlines() if ln.strip() and not ln.startswith("#")]
    with ThreadPoolExecutor(max_workers=4) as ex:
        rows = list(ex.map(one, files))
    ok = [r for r in rows if "error" not in r]

    here = pathlib.Path(__file__).resolve().parent
    (here / "calibration.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))

    keys = ["hook_mean", "L_mean", "dup_pct", "flat_pct", "black_pct"]
    print(f"{'film':<44}{'画幅':<12}{'hook':>7}{'L*':>8}{'dup%':>7}{'flat%':>8}{'black%':>8}")
    for r in rows:
        if "error" in r:
            print(f"{pathlib.Path(r['file']).name:<44}MISSING")
            continue
        wh = f"{r['w']}x{r['h']}"
        print(f"{pathlib.Path(r['file']).name:<44}{wh:<12}{r.get('hook_mean', 0):>7.2f}{r.get('L_mean', 0):>8.1f}"
              f"{r.get('dup_pct', 0):>7.2f}{r.get('flat_pct', 0):>8.1f}{r.get('black_pct', 0):>8.1f}")

    print("\n分位（n=%d）" % len(ok))
    for k in keys:
        vals = [r[k] for r in ok if k in r]
        if not vals:
            continue
        print(f"  {k:<10} min {min(vals):8.2f}  p10 {pct(vals,10):7.2f}  p50 {pct(vals,50):7.2f}  max {max(vals):8.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
