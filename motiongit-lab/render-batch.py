#!/usr/bin/env python3
"""MotionGit 模板批处理并行：多条片子各跑一条完整流水线，互不干扰。

为什么不是分片：单条片子分片会把 check-params/plan 的固定开销乘 N 倍，
而且重设 t0 会让 presenter/HUD 的全局时间映射错位（详见 MOTIONGIT-PLAYBOOK 第 18 节）。
批处理则每条都是完整时间轴，输出与串行完全一致，只是并发跑。

用法：
  python3 render-batch.py --jobs 3 --out-dir out/batch instA instB instC
  # 每个 instance 目录里需有 params.json 与 inputs/

产出：<out-dir>/<实例名>.mp4，并打印每条耗时与总耗时。
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent
RUN = ROOT / "templates" / "paper-perspective" / "run-tpl.sh"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def sh(*args, tag=""):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        raise RuntimeError(f"{tag}: " + " | ".join(tail))
    return r.stdout.strip()


def tpl(inst, *args):
    return sh("bash", str(RUN), "--instance", str(inst), *map(str, args))


def probe(path):
    d = sh(FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path))
    f = sh(FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
           "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path))
    return float(d), int(f)


def render_one(inst, out, reuse=False):
    t0 = time.time()
    params, inputs = inst / "params.json", inst / "inputs"
    plan, project = inst / "plan", inst / "project"

    if not (reuse and plan.exists()):
        tpl(inst, "check-params", params, "--inputs", inputs, "--language", "zh")
        if plan.exists():
            subprocess.run(["rm", "-rf", str(plan)], check=True)
        tpl(inst, "plan", params, "--inputs", inputs, "--out", plan, "--language", "zh")
    rv = plan / "review.json"
    d = json.loads(rv.read_text()); d["reviewed"] = True
    rv.write_text(json.dumps(d, ensure_ascii=False, indent=1))

    if project.exists():
        subprocess.run(["rm", "-rf", str(project)], check=True)
    tpl(inst, "prepare", params, "--inputs", inputs, "--plan", plan, "--out", project, "--language", "zh")

    dur = json.loads(params.read_text())["timeline"]["duration"]
    if not (reuse and (project / "preview.json").exists()):
        tpl(inst, "preview", project, "--times", f"{dur / 2:.2f}", "--language", "zh")
    pv = project / "preview.json"
    d = json.loads(pv.read_text()); d["reviewed"] = True
    pv.write_text(json.dumps(d, ensure_ascii=False, indent=1))

    tpl(inst, "render", project, "--out", out, "--language", "zh")
    return inst.name, out, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("instances", nargs="+")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--out-dir", default="out/batch")
    args = ap.parse_args()

    out_dir = pathlib.Path(args.out_dir).resolve()   # 核心会把 --out 解析到实例目录内，必须给绝对路径
    out_dir.mkdir(parents=True, exist_ok=True)
    insts = [pathlib.Path(p).resolve() for p in args.instances]

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=min(args.jobs, len(insts))) as ex:
        futures = [ex.submit(render_one, i, out_dir / f"{i.name}.mp4") for i in insts]
        results, errors = [], []
        for f in futures:
            try:
                results.append(f.result())
            except Exception as e:
                errors.append(str(e))
    wall = time.time() - t0

    print(f"\n批处理 {len(insts)} 条 / {args.jobs} 并发｜总耗时 {wall:.1f}s")
    cpu = 0.0
    for name, out, sec in sorted(results, key=lambda r: r[0]):
        d, fr = probe(out)
        cpu += sec
        print(f"  {name:<12} {sec:6.1f}s  {d:7.3f}s  {fr} 帧  → {out}")
    if results:
        print(f"  串行预估 {cpu:.1f}s｜提速 {cpu / wall:.2f}×")
    for e in errors:
        print("  ✗", e.splitlines()[0][:200])
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
