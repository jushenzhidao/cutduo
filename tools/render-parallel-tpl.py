#!/usr/bin/env python3
"""【实验失败 · 默认禁用】MotionGit 模板按时间切片并行渲染。

2026-11-09 实测结论（46.386s / 2783 帧，本机）：

  · 串行基线 89s；
  · 4 路分片 453s —— 慢 5 倍，不是快 4 倍；
  · 且输出有缺陷：分片后右侧口播人物卡片消失，右上角多出 00:00 时间码。

原因：
  1) 每个分片都要完整跑 check-params（约 47s）+ plan（约 52s）+ prepare + preview，
     这些是固定开销，不随片长缩小，分 N 片就乘 N 倍；
  2) 模板的合成状态（presenter 分段映射、HUD 计时）依赖全局时间轴，
     重设 t0 后映射错位。

结论：这个模板不适合分片。要提速只能走批处理（多条片子并发）或换渲染引擎（见 SKIA-ROADMAP.md）。
保留本脚本仅为记录实验结果，需加 --force 才会执行。
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent
TPL_DIR = ROOT / "templates" / "paper-perspective"
RUN = TPL_DIR / "run-tpl.sh"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def run(args, tag="", quiet=True):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        msg = (r.stdout + r.stderr).strip().splitlines()
        tail = msg[-3:] if msg else ["(无输出)"]
        raise RuntimeError(f"{tag} 失败:\n  " + "\n  ".join(tail))
    return r.stdout.strip()


def tpl(shard, *args):
    return run(["bash", str(RUN), "--instance", str(shard), *map(str, args)])


def probe_dur(path):
    return float(run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", str(path)]))


def window_plan(boundaries, workers):
    """在分镜边界上尽量均匀地切 N 段。"""
    total = boundaries[-1]
    target = total / workers
    cuts, acc = [0.0], 0.0
    for b in boundaries[1:-1]:
        if b - acc >= target * 0.75 and (total - b) >= target * 0.5:
            cuts.append(b)
            acc = b
    cuts.append(total)
    return list(zip(cuts[:-1], cuts[1:]))


def build_shard(base, idx, a, b):
    shard = base / f"shard{idx}"
    run([sys.executable, str(ROOT / "shard-tpl.py"),
         "--instance", str(base / "src"), "--window", f"{a},{b}", "--out", str(shard)],
        tag=f"切片 {idx}")
    return shard


def render_shard(shard, idx):
    t0 = time.time()
    tpl(shard, "check-params", shard / "params.json", "--inputs", shard / "inputs", "--language", "zh")
    tpl(shard, "plan", shard / "params.json", "--inputs", shard / "inputs",
        "--out", shard / "plan", "--language", "zh")
    rv = shard / "plan" / "review.json"
    d = json.loads(rv.read_text()); d["reviewed"] = True
    rv.write_text(json.dumps(d, ensure_ascii=False, indent=1))

    tpl(shard, "prepare", shard / "params.json", "--inputs", shard / "inputs",
        "--plan", shard / "plan", "--out", shard / "project", "--language", "zh")

    dur = json.loads((shard / "params.json").read_text())["timeline"]["duration"]
    tpl(shard, "preview", shard / "project", "--times", f"{dur / 2:.2f}", "--language", "zh")
    pv = shard / "project" / "preview.json"
    d = json.loads(pv.read_text()); d["reviewed"] = True
    pv.write_text(json.dumps(d, ensure_ascii=False, indent=1))

    out = shard / "out.mp4"
    tpl(shard, "render", shard / "project", "--out", out, "--language", "zh")
    return idx, out, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep", action="store_true", help="保留分片目录")
    ap.add_argument("--force", action="store_true", help="已知缺陷，仍要执行")
    args = ap.parse_args()

    if not args.force:
        print("已知实验失败：4 路分片比串行慢 5 倍，且会丢失口播人物卡片。\n"
              "详见脚本头部说明与 SKIA-ROADMAP.md；如确需复现请加 --force。")
        return 2

    src = pathlib.Path(args.instance)
    params = json.loads((src / "params.json").read_text())
    bounds = [0.0] + [s["t1"] for s in params["timeline"]["segments"]]
    wins = window_plan(bounds, args.workers)
    print(f"共 {bounds[-1]:.3f}s，切 {len(wins)} 片：" +
          "  ".join(f"[{a:.2f},{b:.2f}]" for a, b in wins))

    base = pathlib.Path("/tmp/mgtpl-parallel")
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True)
    (base / "src").symlink_to(src)

    t0 = time.time()
    shards = [build_shard(base, i, a, b) for i, (a, b) in enumerate(wins)]
    print(f"切片完成 {time.time() - t0:.1f}s")

    t1 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        results = sorted(ex.map(lambda p: render_shard(*p), [(s, i) for i, s in enumerate(shards)]))
    print(f"分片渲染完成 {time.time() - t1:.1f}s（各片: " +
          ", ".join(f"#{i} {d:.1f}s" for i, _, d in results) + "）")

    # 合片：各片只取视频流，音轨统一用原始完整音轨
    t2 = time.time()
    listfile = base / "list.txt"
    lines = []
    for _, out, _ in results:
        ts = out.with_suffix(".ts")
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(out),
             "-map", "0:v:0", "-c", "copy", "-f", "mpegts", str(ts)], tag="转 TS")
        lines.append(f"file '{ts}'")
    listfile.write_text("\n".join(lines))

    total = probe_dur(src / "inputs" / "voiceover.m4a")
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", str(listfile),
         "-i", str(src / "inputs" / "voiceover.m4a"),
         "-map", "0:v:0", "-map", "1:a:0",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-t", f"{total:.3f}", "-movflags", "+faststart", str(args.out)], tag="合片")
    print(f"合片完成 {time.time() - t2:.1f}s → {args.out}")

    if not args.keep:
        shutil.rmtree(base, ignore_errors=True)

    d = probe_dur(args.out)
    frames = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
                  "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(args.out)])
    print(f"总耗时 {time.time() - t0:.1f}s｜成片 {d:.3f}s｜{frames} 帧")


if __name__ == "__main__":
    sys.exit(main())
