#!/usr/bin/env python3
"""参考片 ↔ 复刻成片的并列对照 + 锐度量化。

从官方 demo 的抽帧里挑 8 个同类型镜头，从复刻成片按分镜中点抽对应帧，
生成 out/desktop-compare.html 与像素级锐度比值。
用法：uv run --with numpy --with pillow python desktop-kit/tools/compare.py
"""
import json
import os
import pathlib
import subprocess
import html
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
VIDEO = ROOT / "out" / "desktop.mp4"
PARAMS = ROOT / "desktop-kit" / "presets" / "demo-voiced.json"
REF = ROOT / "ref" / "mac-desktop" / "frames"
OUT = ROOT / "out" / "desktop-compare"
FFMPEG = "/opt/homebrew/bin/ffmpeg"

# (参考帧秒, 复刻镜头 type, 说明)
PAIRS = [
    (0,   "title",     "出发屏 / 翻牌大标题"),
    (32,  "comments",  "评论卡片瀑布"),
    (56,  "talk",      "蓝色壁纸 + 白窗口 + 桌面骨架"),
    (104, "rating",    "白窗口评估 + 翻牌评价"),
    (120, "flipBoard", "深色翻牌屏"),
    (152, "chart",     "白窗口折线图"),
    (176, "ranking",   "排名翻牌换位"),
    (224, "outro",     "结尾票券窗口"),
]

import numpy as np
from PIL import Image


BOX_WALL = (1330, 620, 1430, 920)   # 右侧桌面图标列下方：各镜头通常都是纯壁纸
BOX_TEXT = (300, 900, 1140, 995)    # 双语字幕行

# 固定采样点（与 tools/video-compare.py 一致），用于实算系统配色偏差
SAMPLES = {
    "menuBar": (700, 13), "wallLeft": (70, 520), "wallTop": (700, 80),
    "wallRight": (1380, 520), "wallLowL": (110, 900), "wallLowR": (1300, 900),
    "dock": (500, 1030),
}


def patch(a, x, y, r=6):
    return a[max(0, y-r):y+r, max(0, x-r):x+r].reshape(-1, 3).mean(axis=0)


def color_diff(ref_path, our_path):
    a = np.asarray(Image.open(ref_path).convert("RGB"), dtype=np.float32)
    b = np.asarray(Image.open(our_path).convert("RGB"), dtype=np.float32)
    return float(np.mean([np.abs(patch(a, x, y) - patch(b, x, y)).mean()
                          for x, y in SAMPLES.values()]))


def sharpness(path, box=None):
    im = Image.open(path).convert("L")
    if box:
        im = im.crop(box)
    a = np.asarray(im, dtype=np.float32)
    gx = np.abs(np.diff(a, axis=1))[:, :-1]
    gy = np.abs(np.diff(a, axis=0))[:-1, :]
    return float((gx.mean() + gy.mean()) / 2)


def main():
    if not OUT.exists():
        OUT.mkdir(parents=True, exist_ok=True)
    d = json.loads(PARAMS.read_text())
    shots = {s["type"]: s for s in d["shots"]}
    rows = []
    # 几何偏差与自检通过数不再手填：直接读 verify.mjs 的实测输出
    vd = subprocess.run(["node", str(ROOT / "desktop-kit" / "verify.mjs")],
                        capture_output=True, text=True, cwd=str(ROOT))
    gm = re.search(r"最大偏差\s*\w+\s*=\s*(\d+)px", vd.stdout)
    pm = re.search(r"(\d+)\s*PASS\s*/\s*(\d+)\s*FAIL", vd.stdout)
    geo = f"{gm.group(1)}px" if gm else "n/a"
    checks = f"{pm.group(1)} / {int(pm.group(1)) + int(pm.group(2))}" if pm else "n/a"
    for i, (ref_t, typ, label) in enumerate(PAIRS):
        s = shots[typ]
        at = (s["t0"] + s["t1"]) / 2
        our = OUT / f"our-{i:02d}.jpg"
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                        "-ss", f"{at:.3f}", "-i", str(VIDEO), "-frames:v", "1",
                        "-q:v", "2", str(our)], check=True)
        ref = REF / f"t{ref_t:03d}.jpg"
        rs, os_ = sharpness(ref), sharpness(our)
        rw, ow = sharpness(ref, BOX_WALL), sharpness(our, BOX_WALL)
        rt, ot = sharpness(ref, BOX_TEXT), sharpness(our, BOX_TEXT)
        rows.append(dict(i=i, ref_t=ref_t, typ=typ, label=label, at=at,
                         ref=ref, our=our, rs=rs, os=os_, ratio=os_ / max(rs, 1e-6),
                         rw=rw, ow=ow, rw_ratio=ow / max(rw, 1e-6),
                         rt=rt, ot=ot, rt_ratio=ot / max(rt, 1e-6),
                         color=round(color_diff(ref, our), 2)))

    mean = sum(r["ratio"] for r in rows) / len(rows)
    mean_wall = sum(r["rw_ratio"] for r in rows) / len(rows)
    mean_text = sum(r["rt_ratio"] for r in rows) / len(rows)
    mean_color = sum(r["color"] for r in rows) / len(rows)
    cards = []
    for r in rows:
        cards.append(f"""
    <section class="pair">
      <h3>{html.escape(r['label'])} <span>{r['typ']} · 参考 {r['ref_t']}s / 复刻 {r['at']:.1f}s</span></h3>
      <div class="grid">
        <figure><img src="{os.path.relpath(r['ref'], ROOT / 'out')}"><figcaption>官方 demo · 全画面 {r['rs']:.2f} / 壁纸 {r['rw']:.2f} / 字幕 {r['rt']:.2f}</figcaption></figure>
        <figure><img src="{os.path.relpath(r['our'], ROOT / 'out')}"><figcaption>desktop-kit · 全画面 {r['os']:.2f}（{r['ratio']:.2f}×） / 壁纸 {r['ow']:.2f}（{r['rw_ratio']:.2f}×） / 字幕 {r['ot']:.2f}（{r['rt_ratio']:.2f}×）</figcaption></figure>
      </div>
    </section>""")

    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>desktop-kit · 参考片对照</title>
<style>
:root{{color-scheme:dark}}body{{margin:0;padding:40px;background:#14161b;color:#e9ebef;
font:15px/1.6 -apple-system,"PingFang SC",sans-serif}}
h1{{font-size:28px;margin:0 0 8px}} .sub{{color:#9aa2af;margin-bottom:28px}}
.pair{{margin:0 0 44px}} h3{{font-size:17px;margin:0 0 12px;font-weight:600}}
h3 span{{font-size:12px;color:#8b93a1;font-weight:400;margin-left:10px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
figure{{margin:0;background:#1c1f26;border:1px solid #2a2f38;border-radius:10px;overflow:hidden}}
img{{display:block;width:100%}} figcaption{{padding:8px 12px;color:#9aa2af;font-size:12px}}
.kpi{{display:flex;gap:28px;background:#1c1f26;border:1px solid #2a2f38;border-radius:10px;
padding:16px 20px;margin-bottom:30px;flex-wrap:wrap}}
.kpi b{{display:block;font-size:22px;color:#f5b321}} .kpi span{{color:#8b93a1;font-size:12px}}
</style></head><body>
<h1>desktop-kit · Mac Desktop 复刻对照</h1>
<div class="sub">官方 demo（1440×1080 / 60fps / 230.02s）与 Skia 复刻成片（68.783s / 4127 帧）同类型镜头并列。文案不同，比的是骨架、配色、组件与镜头语言。</div>
<div class="kpi">
  <div><b>{len(rows)}</b><span>对照镜头组</span></div>
  <div><b>{mean:.2f}</b><span>全画面平均锐度比</span></div>
  <div><b>{mean_wall:.2f}</b><span>壁纸区锐度比</span></div>
  <div><b>{mean_text:.2f}</b><span>字幕文字区锐度比</span></div>
  <div><b>{mean_color:.1f}</b><span>采样点平均色差 / 255（脚本实算）</span></div>
  <div><b>{geo}</b><span>骨架几何最大偏差（verify 实测）</span></div>
  <div><b>{checks}</b><span>自检通过（verify 实测）</span></div>
</div>
{''.join(cards)}
</body></html>"""
    (ROOT / "out" / "desktop-compare.html").write_text(page)
    print("✓ out/desktop-compare.html")
    for r in rows:
        print(f"  {r['typ']:<10} all {r['ratio']:.2f}  wall {r['rw_ratio']:.2f}  text {r['rt_ratio']:.2f}")
    print(f"  平均 全画面 {mean:.3f} / 壁纸 {mean_wall:.3f} / 字幕 {mean_text:.3f}")


if __name__ == "__main__":
    main()
