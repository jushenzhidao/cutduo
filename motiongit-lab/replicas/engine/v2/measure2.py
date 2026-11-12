#!/usr/bin/env python3
"""v2 元素级测量：从官方公开参考成片提取「净背景颜色场 + 文字层 + 图形层」。

与 v1（8×6 网格 + 分段代表帧）的差别：
  · 颜色场按 0.25s 粒度逐时刻测量（160×90，每格约 12×12 原像素），
    捕捉段内渐变与转场 —— 误差分解显示大面积底色贡献 45–74% 的 MAD。
  · 文字层用 macOS Vision OCR 测得文本、bbox、置信度，再从同一帧量出
    前景/背景色与字号；渲染时用本机字体独立绘制。
  · 图形层检测非文字的高对比小色块（圆点、logo 徽记等），输出 bbox 与主色，
    渲染时用矢量图元绘制。
  · 净背景场：把文字/图形覆盖的颜色场格子用上下邻域插值擦除，
    避免 96×54 平均后的「旧文字糊影」与清晰文字叠加形成重影。

合规：只读取公开参考成片的像素，不检视模板包内任何受保护实现/core。
用法：uv run --with numpy --with pillow python replicas/engine/v2/measure2.py [--slug <slug>]
"""
import json
import pathlib
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]     # replicas/
V2 = pathlib.Path(__file__).resolve().parent
OCR = V2 / "ocr"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FW, FH = 160, 90            # 颜色场分辨率（每格约 12×12 原像素，仍不含可读文字）
FIELD_DT = 0.25             # 颜色场采样间隔（秒）：密集硬切模板需要更细的切点定位
OCR_DT = 1.0                # 文字/图形层采样间隔（秒）
OCR_W, OCR_H = 960, 540

REF = ROOT / "reference"
OUT = ROOT / "specs2"
TMP = pathlib.Path("/tmp/mg-v2-ocr")


def run(args):
    subprocess.run(args, check=True, capture_output=True)


def probe(path):
    out = subprocess.check_output(
        ["/opt/homebrew/bin/ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
         "-of", "json", str(path)], text=True)
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return dict(width=int(s["width"]), height=int(s["height"]),
                fps=float(num) / float(den),
                frames=int(s.get("nb_frames") or 0),
                duration=float(s.get("duration") or 0))


def text_colors(a, box):
    """从 OCR 帧量文字前景色/背景色。a 为 OCR_W×OCR_H 的 RGB 数组。"""
    x, y, w, h = box
    x0, y0 = max(0, int(x * OCR_W)), max(0, int(y * OCR_H))
    x1, y1 = min(OCR_W, int((x + w) * OCR_W)), min(OCR_H, int((y + h) * OCR_H))
    if x1 <= x0 or y1 <= y0:
        return [30, 30, 34], [235, 235, 240]
    reg = a[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
    bg = np.median(reg, axis=0)
    dev = np.abs(reg - bg).mean(axis=1)
    hi = dev >= np.percentile(dev, 90)
    fg = reg[hi].mean(axis=0) if hi.any() else reg.max(axis=0)
    return [int(round(v)) for v in bg], [int(round(v)) for v in fg]


def detect_shapes(im, a, texts):
    """检测非文字的高对比小色块：16×16 块密度 + 连通域，输出矢量图元参数。"""
    bg = np.asarray(im.filter(ImageFilter.GaussianBlur(22)), dtype=np.float32)
    diff = np.abs(a - bg).mean(axis=2)
    m = diff > 32
    for t in texts:                       # 排除文字区域
        x, y, w, h = t["box"]
        x0, y0 = max(0, int((x - 0.012) * OCR_W)), max(0, int((y - 0.012) * OCR_H))
        x1, y1 = min(OCR_W, int((x + w + 0.012) * OCR_W)), min(OCR_H, int((y + h + 0.012) * OCR_H))
        m[y0:y1, x0:x1] = False
    m[:int(OCR_H * .035)] = False; m[-int(OCR_H * .035):] = False
    m[:, :int(OCR_W * .025)] = False; m[:, -int(OCR_W * .025):] = False
    bs = 16
    H, W = m.shape
    bh, bw = H // bs, W // bs
    dens = m[:bh * bs, :bw * bs].reshape(bh, bs, bw, bs).mean(axis=(1, 3))
    hot = dens > 0.18
    seen = np.zeros_like(hot)
    comps = []
    for by in range(bh):
        for bx in range(bw):
            if not hot[by, bx] or seen[by, bx]:
                continue
            stack, cells = [(by, bx)], []
            while stack:
                cy, cx = stack.pop()
                if not (0 <= cy < bh and 0 <= cx < bw) or seen[cy, cx] or not hot[cy, cx]:
                    continue
                seen[cy, cx] = True
                cells.append((cy, cx))
                stack.extend([(cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)])
            ys = [c[0] for c in cells]; xs = [c[1] for c in cells]
            x0, y0, x1, y1 = min(xs) * bs, min(ys) * bs, (max(xs) + 1) * bs, (max(ys) + 1) * bs
            area = (x1 - x0) * (y1 - y0) / (W * H)
            if not (0.0002 < area < 0.02):
                continue
            reg = a[y0:y1, x0:x1]
            d2 = diff[y0:y1, x0:x1]
            sel = d2 > np.percentile(d2, 70)
            col = reg[sel].mean(axis=0) if sel.any() else reg.mean(axis=(0, 1))
            comps.append(dict(box=[round(x0 / W, 4), round(y0 / H, 4),
                                   round((x1 - x0) / W, 4), round((y1 - y0) / H, 4)],
                              color=[int(round(v)) for v in col],
                              area=round(float(area), 5)))
    comps.sort(key=lambda c: -c["area"])
    return comps[:6]


def clean_field(p, boxes):
    """把文字/图形覆盖的颜色场格子，用同列上下未覆盖行插值擦除。"""
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
    mask = np.zeros((a.shape[0], a.shape[1]), dtype=bool)
    for x, y, w, h in boxes:
        gx0, gy0 = max(0, int(x * a.shape[1])), max(0, int(y * a.shape[0]))
        gx1 = min(a.shape[1], int((x + w) * a.shape[1]) + 1)
        gy1 = min(a.shape[0], int((y + h) * a.shape[0]) + 1)
        pad = 1
        mask[max(0, gy0 - pad):min(a.shape[0], gy1 + pad),
             max(0, gx0 - pad):min(a.shape[1], gx1 + pad)] = True
    out = a.copy()
    for gx in range(a.shape[1]):
        col = mask[:, gx]
        if not col.any():
            continue
        free = np.where(~col)[0]
        if not len(free):
            continue
        for gy in np.where(col)[0]:
            up, dn = free[free < gy], free[free > gy]
            if len(up) and len(dn):
                a0, a1 = up[-1], dn[0]
                k = (gy - a0) / (a1 - a0)
                out[gy, gx] = a[a0, gx] * (1 - k) + a[a1, gx] * k
            elif len(up):
                out[gy, gx] = a[up[-1], gx]
            else:
                out[gy, gx] = a[dn[0], gx]
    return Image.fromarray(out.astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))


def one(slug):
    ref = REF / f"{slug}.mp4"
    meta = probe(ref)
    d = OUT / slug
    fd = d / "field"
    # 不做批量删除（会触发保护阈值）；ffmpeg -y 覆盖同名序号文件，
    # 同一影片在同一 fps 下帧数恒定，不会残留多余帧。
    fd.mkdir(parents=True, exist_ok=True)

    # ① 颜色场：一次解码，0.5s 一帧，96×54 面积平均
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(ref),
         "-vf", f"fps={1/FIELD_DT},scale={FW}:{FH}:flags=area", "-q:v", "2",
         str(fd / "%04d.jpg")])
    n_field = int(meta["duration"] / FIELD_DT) + 1
    fields = sorted(fd.glob("*.jpg"))[:n_field]

    # ② OCR 帧：1s 一帧，960×540
    od = TMP / slug
    od.mkdir(parents=True, exist_ok=True)
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(ref),
         "-vf", f"fps={1/OCR_DT},scale={OCR_W}:{OCR_H}:flags=lanczos", "-q:v", "2",
         str(od / "%04d.jpg")])
    n_ocr = int(meta["duration"] / OCR_DT) + 1
    ocr_frames = sorted(od.glob("*.jpg"))[:n_ocr]

    # ③ 逐 OCR 帧识别文字、量色、检测图形
    ocr_by_t = {}
    for k, p in enumerate(ocr_frames):
        # ffmpeg fps=N 输出帧代表采样区间中点，不是区间起点（实测 +DT/2）。
        t = (k + 0.5) * OCR_DT
        out = subprocess.run([str(OCR), str(p)], capture_output=True, text=True)
        try:
            items = json.loads(out.stdout.strip() or "[]") if out.returncode == 0 else []
        except json.JSONDecodeError:
            items = []
        im = Image.open(p).convert("RGB")
        a = np.asarray(im, dtype=np.float32)
        texts = []
        for it in items:
            if float(it.get("conf", 0)) < 0.3 or float(it.get("h", 0)) < 0.008:
                continue
            box = [float(it["x"]), float(it["y"]), float(it["w"]), float(it["h"])]
            bg, fg = text_colors(a, box)
            texts.append(dict(text=it["text"], box=[round(v, 4) for v in box],
                              bg=bg, fg=fg,
                              size=round(box[3] * meta["height"] * 0.88, 1),
                              conf=round(float(it["conf"]), 3)))
        ocr_by_t[t] = dict(texts=texts, shapes=detect_shapes(im, a, texts))

    # ④ FIELD_DT 粒度关键帧。
    # 注：曾尝试「擦除文字/图形区域生成净背景场 + 矢量图形层」，实测单帧 MAD
    # 7.20→8.38 且目视出现抹除色带、把圆点群/logo 错画成矩形，已回退。
    # 改用提高颜色场粒度（160×90）让糊影自然减轻，不做手工修补。
    keys = []
    for i, f in enumerate(fields):
        t = round((i + 0.5) * FIELD_DT, 3)
        ot = min(ocr_by_t, key=lambda x: abs(x - t))
        layer = ocr_by_t[ot]
        keys.append(dict(t=t, field=f.name, ocr_t=round(ot, 3), **layer))

    # 硬切标记：相邻颜色场差 > 20 视为镜头切换。
    # 线性插值会在硬切处合成原片不存在的混合画面（实测 velocity 21 处 / user 31 处，
    # 正是这两个模板 v2 反而劣化的主因）。渲染端据此在切点做硬切而非插值。
    fa = [np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) for p in fields]
    hard = 0
    for i in range(len(keys) - 1):
        cut = float(np.abs(fa[i + 1] - fa[i]).mean()) > 20
        keys[i]["hard_next"] = cut
        hard += int(cut)
    keys[-1]["hard_next"] = False
    (d / "keyframes.json").write_text(json.dumps(keys, ensure_ascii=False))
    m = dict(slug=slug, **meta, field_w=FW, field_h=FH, field_dt=FIELD_DT,
             ocr_dt=OCR_DT, field_count=len(fields), ocr_count=len(ocr_frames),
             text_total=sum(len(o["texts"]) for o in ocr_by_t.values()),
             shape_total=sum(len(o["shapes"]) for o in ocr_by_t.values()),
             hard_cuts=hard,
             time_offset_note="ffmpeg fps=N 的 PTS 标签是 i*DT，但取用的帧内容经精确帧号验证为区间中点 "
                              "(i+0.5)*DT（FIELD_DT=0.5 时 field/0001 与源帧 n=15/t=0.25 完全一致 MAD=0）。"
                              "忽略该偏移会让快速切换模板整片错帧（velocity 网格色差 2.90→17.50）。"
                              "FIELD_DT 收紧到 0.25s 以提高密集硬切的切点定位精度。",
             hard_cut_note="相邻颜色场平均差 >20 标记为镜头硬切；渲染时该区间不插值，"
                           "在区间中点硬切，避免合成原片不存在的混合画面。",
             method="颜色场 = 公开成片 0.25s 粒度 160×90 面积平均测量；"
                    "文字 = Vision OCR 测得文本/bbox/色值/字号后本机字体独立重绘；"
                    "图形连通块仅测量留档，实测矢量重绘会劣化画面故不渲染。",
             boundary="颜色场是低分辨率色彩布局参数（每格约 12×12 原像素，不含可读文字），"
                      "不是原帧像素搬运；文字层为独立重建。未读取模板包 core/实现。")
    (d / "meta.json").write_text(json.dumps(m, ensure_ascii=False, indent=2))
    print(f"  {slug:<28} 场 {len(fields):4d}  OCR {len(ocr_frames):3d}  "
          f"文字 {sum(len(o['texts']) for o in ocr_by_t.values()):4d}  "
          f"图形 {sum(len(o['shapes']) for o in ocr_by_t.values()):4d}", flush=True)
    return m


def main():
    only = sys.argv[sys.argv.index('--slug') + 1] if '--slug' in sys.argv else None
    slugs = [only] if only else sorted(p.stem.replace('.spec', '')
                                      for p in (ROOT / "specs").glob("*.spec.json"))
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    rows = [one(s) for s in slugs]
    if not only:
        (OUT / "ALL.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f"✓ v2 测量完成 {len(rows)} 个模板")


if __name__ == "__main__":
    main()
