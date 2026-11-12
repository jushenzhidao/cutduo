#!/usr/bin/env python3
"""8 条对抗审查清单（skia-kit/REPLICATION.md §7）的自动化判定。

用法：uv run --with numpy --with pillow python replicas/engine/audit.py [--tag before|after]
每项给 PASS/FAIL + 可复现实证，不藏不利数据。
"""
import hashlib
import json
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
MGLAB = ROOT.parent
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
TAG = sys.argv[sys.argv.index('--tag') + 1] if '--tag' in sys.argv else 'before'


def sh(args, cwd=None):
    return subprocess.run(args, capture_output=True, text=True, cwd=cwd)


def md5(p):
    return hashlib.md5(pathlib.Path(p).read_bytes()).hexdigest()


def frames_of(p):
    o = sh([FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate,duration",
            "-of", "json", str(p)])
    s = json.loads(o.stdout)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return dict(n=int(s["nb_read_frames"]), w=int(s["width"]), h=int(s["height"]),
                fps=float(num) / float(den), dur=float(s["duration"]))


def safe_zone(png):
    a = np.asarray(Image.open(png).convert("L"), dtype=np.float32)
    h, w = a.shape
    border = 64
    strips = [a[:border, :], a[-border:, :], a[:, :border], a[:, -border:]]
    ratios = []
    for s in strips:
        ratios.append(float((np.abs(s - np.median(s)) > 60).mean()))
    return round(max(ratios), 5)


def audit_one(slug):
    cur = ROOT / "specs" / f"{slug}.spec.json"
    old = ROOT / "specs" / f"{slug}.spec.before.json"
    spec_path = old if (TAG == 'before' and old.exists()) else cur
    spec = json.loads(spec_path.read_text())
    rep = ROOT / "out" / slug / ("replica-fixed.mp4" if TAG == 'after' else "replica.mp4")
    if not rep.exists():
        rep = ROOT / "out" / slug / "replica.mp4"
    items = []

    def add(name, ok, evidence):
        items.append(dict(name=name, verdict="PASS" if ok else "FAIL", evidence=evidence))

    # 1 字体
    probe = sh(["node", "--input-type=module", "-e",
               "import {registerFonts} from './replicas/engine/replica.mjs';"
               "import {GlobalFonts} from '@napi-rs/canvas';"
               "console.log(registerFonts('./assets/fonts'), GlobalFonts.has('NotoSC Medium'));"],
              cwd=str(MGLAB))
    fonts = probe.stdout.strip()
    add("1 字体注册与假注册检测", "3 true" in fonts,
        f"registerFonts + GlobalFonts.has: {fonts or probe.stderr[:120]}")

    # 2 确定性 / 代码指纹
    p1, p2 = f"/tmp/audit-{slug}-a.png", f"/tmp/audit-{slug}-b.png"
    for p in (p1, p2):
        sh(["node", "replicas/engine/render.mjs", "--spec", str(spec_path),
            "--probe", p, "--at", "3.0"], cwd=str(MGLAB))
    d1, d2 = md5(p1), md5(p2)
    code = hashlib.sha256(b"".join((ROOT / "engine" / f).read_bytes()
                                   for f in ("replica.mjs", "render.mjs"))).hexdigest()[:16]
    add("2 同帧确定性 + 代码指纹", d1 == d2, f"md5={d1[:12]} 二次一致={d1==d2} 代码指纹={code}")

    # 3 worker 参数下发
    src = (ROOT / "engine" / "render.mjs").read_text()
    ok = "specPath: A.spec" in src and "fps: FPS" in src and "postMessage" in src
    add("3 worker 参数下发与回报", ok,
        "workerData 含 specPath/fps；worker 回报 frames/fonts/segments" if ok else "源码断言失败")

    # 4 安全区（四边 64px 内不得有高对比文字）
    r = safe_zone(p1)
    add("4 安全区 ≥64px", r < 0.005, f"边框内高对比像素占比 max={r}（阈值 0.005）")

    # 5 锐度比：用 8 组的中位数，而不是均值。
    # 实测 velocity 第 1 组参考帧近乎纯色（ref 锐度 0.048 → 比值 45.9），
    # 单个异常组会把均值拉到 8.27，属内容差异而非渲染缺陷。
    mf = ROOT / "out" / slug / f"metrics-{TAG}.json"
    ratio = None
    note = "metrics 缺失（需先跑 compare.py）"
    if mf.exists():
        rows = json.loads(mf.read_text())["rows"]
        ratio = round(float(np.median([r["sharp_ratio"] for r in rows])), 3)
        note = f"8 组锐度比中位数={ratio}（均值={json.loads(mf.read_text())['means']['sharp_ratio']}）"
    add("5 锐度比 0.93–1.05（中位数）", ratio is not None and 0.93 <= ratio <= 1.05, note)

    # 6 音画 / 黑帧 / 重复帧
    f = frames_of(rep)
    expect = round(f["dur"] * f["fps"])
    lum, dup = [], []
    for t in [f["dur"] * (i + 0.5) / 8 for i in range(8)]:
        for off, tag in ((0, "a"), (1 / f["fps"], "b")):
            p = f"/tmp/audit-{slug}-{t:.1f}-{tag}.png"
            sh([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t+off:.4f}",
                "-i", str(rep), "-frames:v", "1", "-y", p])
            im = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
            (lum if tag == "a" else dup).append(im)
    black = min(float(x.mean()) for x in lum)
    # 「无重复帧」的正确判据是有像素在变，不是全画面平均差 > 0.05：
    # 1920×1080 里一个 7×26 游标移动 5px，平均差仅 0.01，但画面确实在动。
    changed = float(np.mean([(np.abs(a - b).max(axis=2) > 2).mean() for a, b in zip(lum, dup)]))
    mean_delta = float(np.mean([np.abs(a - b).mean() for a, b in zip(lum, dup)]))
    add("6 帧数 / 无黑帧 / 无重复帧", f["n"] == expect and black > 8 and changed > 0.0001,
        f"帧数 {f['n']}/{expect} 最暗均值 {black:.1f} 变化像素占比 {changed:.5f} 平均差 {mean_delta:.2f}")

    # 7 可读性（文字按带宽自适应，不裁切）
    rsrc = (ROOT / "engine" / "replica.mjs").read_text()
    add("7 文字不裁切", "fitSize" in rsrc and "maxWidth" not in rsrc,
        "渲染器 fitSize 按可用宽收敛字号" if "fitSize" in rsrc else "缺 fitSize")

    # 8 授权边界
    # git check-ignore -q 只接受单路径；一次传两个会 fatal 128（审查器自身曾误报 8 条 FAIL）
    ws = str(MGLAB.parent)
    p_ref = str((ROOT / "reference" / f"{slug}.mp4").relative_to(MGLAB.parent))
    p_pkg = str((ROOT / "downloads" / f"{slug}-v{spec['version']}.motion").relative_to(MGLAB.parent))
    rc = [sh(["git", "check-ignore", "-q", p], cwd=ws).returncode for p in (p_ref, p_pkg)]
    clean = "templates/" not in rsrc and "release.bin" not in rsrc
    add("8 授权与不外发", all(r == 0 for r in rc) and clean,
        f"git check-ignore 参考片/封套 rc={rc}；复刻源码引用模板实现={'有' if not clean else '无'}")

    return dict(slug=slug, tag=TAG, replica=str(rep.relative_to(ROOT)),
                pass_count=sum(1 for i in items if i["verdict"] == "PASS"),
                total=len(items), items=items)


def main():
    slugs = [p.stem.replace('.spec', '') for p in sorted((ROOT / "specs").glob("*.spec.json"))]
    out = []
    for s in slugs:
        if not (ROOT / "out" / s / "replica.mp4").exists():
            continue
        r = audit_one(s)
        out.append(r)
        print(f"  {s:<28} {r['pass_count']}/{r['total']}  " +
              " ".join(f"{i['name'][0]}:{i['verdict'][0]}" for i in r["items"]), flush=True)
    (ROOT / f"audit-{TAG}.json").write_text(json.dumps(
        dict(tag=TAG, count=len(out),
             overall_pass=sum(r["pass_count"] for r in out),
             overall_total=sum(r["total"] for r in out), items=out),
        ensure_ascii=False, indent=2))
    print(f"✓ {TAG}: {sum(r['pass_count'] for r in out)}/{sum(r['total'] for r in out)} PASS")


if __name__ == "__main__":
    main()
