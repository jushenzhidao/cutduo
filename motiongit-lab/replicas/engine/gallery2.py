#!/usr/bin/env python3
"""v2 交付整理：8 条完整对比视频、48s 总览、24 段精选、8 张拼图、索引页。

与 v1 产物完全隔离（highlights-v2/ preview-v2/ ALL-COMPARE-V2.mp4 / VIDEOS-V2.html），
便于把「严格独立骨架复刻」与「高密度测量重建」两套结果并列审查。
用法：uv run --with numpy --with pillow python replicas/engine/gallery2.py
"""
import html
import json
import pathlib
import shutil
import subprocess

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
FFMPEG = "/opt/homebrew/bin/ffmpeg"
PICKS = (0, 3, 7)
STRIPS = (0, 2, 4, 6)
SIDE_W, SIDE_H, LABEL_H, DUR = 640, 360, 60, 2.0


def run(args):
    subprocess.run(args, check=True, capture_output=True)


def esc(s):
    return html.escape(str(s))


def one(slug):
    out = ROOT / "out" / slug
    cmp = out / "compare-v2.mp4"
    vc = out / "vcompare2"
    met = json.loads((out / "metrics-v2.json").read_text())
    meta = json.loads((ROOT / "specs2" / slug / "meta.json").read_text())

    hi = ROOT / "highlights-v2"
    if not hi.exists():
        hi.mkdir(parents=True)
    picks = []
    for k, i in enumerate(PICKS):
        dst = hi / f"{slug.replace('motiongit-promo-', '')}-{k + 1:02d}.mp4"
        shutil.copy2(vc / f"pair-{i:02d}.mp4", dst)
        picks.append(dict(n=k + 1, group=i + 1, t=met["rows"][i]["t"],
                          file=str(dst.relative_to(ROOT))))

    prev = ROOT / "preview-v2"
    if not prev.exists():
        prev.mkdir(parents=True)
    cell_h = (SIDE_H + LABEL_H) // 2
    canvas = Image.new("RGB", (SIDE_W * 2, cell_h * 2), (14, 16, 21))
    for k, i in enumerate(STRIPS):
        p = f"/tmp/gal2-{slug}-{i}.png"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{i * DUR + DUR / 2:.3f}",
             "-i", str(cmp), "-frames:v", "1", "-y", p])
        im = Image.open(p).convert("RGB").resize((SIDE_W, cell_h), Image.LANCZOS)
        canvas.paste(im, ((k % 2) * SIDE_W, (k // 2) * cell_h))
    pimg = prev / f"{slug.replace('motiongit-promo-', '')}.png"
    canvas.save(pimg)
    return dict(slug=slug, short=slug.replace('motiongit-promo-', ''),
                duration=meta["duration"], fields=meta["field_count"],
                texts=meta["text_total"], grid=f"{meta['field_w']}×{meta['field_h']}",
                compare=str(cmp.relative_to(ROOT)), preview=str(pimg.relative_to(ROOT)),
                means=met["means"], picks=picks)


def make_overview(items):
    lines = []
    for it in items:
        for i in PICKS:
            p = (ROOT / "out" / it["slug"] / "vcompare2" / f"pair-{i:02d}.mp4").resolve()
            lines.append(f"file '{p}'")
    lst = ROOT / "overview-v2-concat.txt"
    lst.write_text("\n".join(lines) + "\n")
    dst = ROOT / "ALL-COMPARE-V2.mp4"
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(lst), "-c", "copy", "-y", str(dst)])
    return dst


def build_html(items, overview, ev, audit):
    m = ev["means"]
    mad_drop = (m["mad"]["v1"] - m["mad"]["v2"]) / m["mad"]["v1"] * 100
    grid_drop = (m["grid_diff"]["v1"] - m["grid_diff"]["v2"]) / m["grid_diff"]["v1"] * 100
    kpis = [
        (f"{m['mad']['v1']} → {m['mad']['v2']}", "全画面 MAD（8 模板均值）"),
        (f"−{mad_drop:.1f}%", "MAD 降幅"),
        (f"−{grid_drop:.1f}%", "网格色差降幅"),
        ("8 / 8", "模板均已出 v2 成片与对比视频"),
        (f"{audit['overall_pass']}/{audit['overall_total']}", "v1 审查结果（保留留档）"),
    ]
    kpi = "".join(f'<div class=stat><b>{esc(v)}</b><span>{esc(n)}</span></div>' for v, n in kpis)
    cards = []
    evmap = {r["slug"]: r for r in ev["rows"]}
    for it in items:
        e = evmap[it["slug"]]
        links = " · ".join(f'<a href="{esc(p["file"])}">片段 {p["n"]} · t={p["t"]}s</a>'
                           for p in it["picks"])
        cards.append(f'''<div class=card><h3>{esc(it["short"])}
<span>{it["duration"]:.1f}s · {it["fields"]} 个颜色场 · {it["texts"]} 个文字元素</span></h3>
<div class=metrics><span>MAD <b>{e["v1"]["mad"]} → {e["v2"]["mad"]}</b></span>
<span>降幅 <b>{e["improvement_mad"]}%</b></span><span>网格色差 <b>{e["v2"]["grid_diff"]}</b></span>
<span>固定点色差 <b>{e["v2"]["point_diff"]}</b></span></div>
<video src="{esc(it["compare"])}" controls preload=metadata></video>
<img src="{esc(it["preview"])}" alt="四点拼图" loading=lazy>
<div class=links>{links}</div></div>''')
    rows = "".join(
        f'<tr><td class=mono>{esc(r["slug"].replace("motiongit-promo-", ""))}</td>'
        f'<td class=num>{r["v1"]["mad"]}</td><td class=num>{r["v2"]["mad"]}</td>'
        f'<td class=good>−{r["improvement_mad"]}%</td>'
        f'<td class=num>{r["v1"]["grid_diff"]}</td><td class=num>{r["v2"]["grid_diff"]}</td>'
        f'<td class=num>{r["v1"]["point_diff"]}</td><td class=num>{r["v2"]["point_diff"]}</td></tr>'
        for r in ev["rows"])
    h = f'''<!doctype html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>v2 · 高密度测量重建与官方原片对比</title><style>
:root{{color-scheme:dark}}body{{margin:0;background:#0e1116;color:#e6e9ef;
font:15px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:44px 26px 80px}}
.kicker{{color:#7aa2f7;font-size:12px;letter-spacing:.18em;text-transform:uppercase}}
h1{{font-size:29px;margin:10px 0 6px;font-weight:650}}
h2{{font-size:19px;margin:40px 0 14px;padding-bottom:8px;border-bottom:1px solid #242a35}}
.sub{{color:#98a2b3}}.stats{{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}}
.stat{{background:#151a22;border:1px solid #242a35;border-radius:10px;padding:12px 18px;min-width:145px}}
.stat b{{display:block;font-size:20px;color:#9ece6a}}.stat span{{font-size:12px;color:#98a2b3}}
video{{width:100%;background:#000;border:1px solid #242a35;border-radius:8px;display:block}}
.hero{{margin:14px 0}}.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}}
.card{{background:#151a22;border:1px solid #242a35;border-radius:10px;padding:16px}}
.card h3{{font-size:16px;margin:0 0 8px;font-weight:600}}
.card h3 span{{font-size:12px;color:#8b93a1;font-weight:400;margin-left:8px}}
.metrics{{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#8b93a1;margin-bottom:10px}}
.metrics b{{color:#c6ccd8;font-variant-numeric:tabular-nums}}
.card img{{width:100%;border:1px solid #242a35;border-radius:8px;margin-top:10px;display:block}}
.links{{margin-top:10px;font-size:12px}}.links a{{color:#7aa2f7;text-decoration:none;margin-right:6px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{text-align:left;color:#98a2b3;font-weight:500;padding:9px 8px;border-bottom:1px solid #2a313d}}
td{{padding:9px 8px;border-bottom:1px solid #1c222c}}
.mono{{font-family:ui-monospace,Menlo,monospace;font-size:12px}}
.num{{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}}
.good{{color:#9ece6a;font-weight:600}}
.note{{background:#1b1f28;border:1px solid #2a313d;border-radius:8px;padding:14px 18px;color:#a9b1c0;font-size:13px}}
.card2{{background:#151a22;border:1px solid #242a35;border-left:3px solid #7aa2f7;border-radius:8px;
padding:12px 16px;margin:10px 0}}.card2 b{{color:#c6ccd8}}
.card2 p{{margin:4px 0 0;color:#a9b1c0;font-size:13px}}
code{{background:#1b2230;padding:2px 6px;border-radius:4px;font-size:12px;color:#9ece6a}}
footer{{margin-top:44px;color:#6b7484;font-size:12px}}
</style><div class=wrap>
<div class=kicker>1:1 还原 · 第二轮优化</div>
<h1>v2：高密度成片测量重建，逐模板对比官方原片</h1>
<div class=sub>左半＝官方预览原片，右半＝v2 复刻成片；每模板 8 个均匀时间点各 2.0s 并排。
指标为两侧从原视频按精确时间点抽无损 PNG 后的实算值，与 v1 完全同口径。</div>
<div class=stats>{kpi}</div>
<h2>总览：8 模板 × 3 个时间窗（48s）</h2>
<div class=hero><video src="{esc(overview.name)}" controls preload=metadata></video>
<div class=sub>每个模板取第 1 / 4 / 8 组。逐模板完整 16s 对比见下方卡片；
v1 版本见 <a href="VIDEOS.html" style="color:#7aa2f7">VIDEOS.html</a>。</div></div>
<h2>量化：v1 → v2（8 模板 × 8 时间点同口径）</h2>
<table><thead><tr><th>模板</th><th>MAD v1</th><th>MAD v2</th><th>降幅</th>
<th>网格 v1</th><th>网格 v2</th><th>固定点 v1</th><th>固定点 v2</th></tr></thead>
<tbody>{rows}</tbody></table>
<h2>逐模板对比视频</h2><div class=grid>{"".join(cards)}</div>
<h2>为什么 v1 做不到 1:1：误差分解</h2>
<div class=note><p>对 8 模板 4 个时间点的实测：<b>平坦背景区贡献 45–74% 的 MAD</b>，
而平坦区本身 MAD 高达 25–56（ink 25.25 / velocity 55.91 / user 35.02 / keynote 32.72）。
根因不是文字或素材不可重建，而是 v1 用「分段代表帧」的恒定 8×6 网格颜色，
官方片在段内有渐变与转场 —— <b>大面积底色随时间对不上</b>。
颜色场粒度上界实验（96×54）：velocity 59.08→6.09、user 38.63→4.55、keynote 35.58→6.27。</p></div>
<h2>v2 做了什么</h2>
<div class=card2><b>① 逐时刻颜色场（160×90 / 0.25s）</b><p>从公开成片按 4fps 面积平均测量，
每格约 12×12 原像素，只表达色彩布局、不含可读文字；渲染时按关键帧真实时间戳在相邻两场间
混合后放大铺底。段内渐变与转场因此被还原；0.5s→0.25s 把密集硬切的定位精度提高一倍。</p></div>
<div class=card2><b>② 文字层独立重建</b><p>macOS Vision OCR 逐 1s 测得文本、bbox、置信度，
再从同帧量出前景/背景色与字号，用本机 Arial 独立绘制；跨 OCR 段按文本匹配交叉淡化。
8 模板共测得 3334 个文字元素。</p></div>
<div class=card2><b>③ 时间轴：PTS 标签 ≠ 帧内容</b><p>ffmpeg <code>fps=N</code> 输出帧的
<code>showinfo</code> PTS 是 i×DT，但用精确帧号验证，取用的帧内容其实是区间中点
(i+0.5)×DT（FIELD_DT=0.5 时 field/0001 与源帧 n=15 / t=0.25s 完全一致，MAD=0）。
忽略这半个区间的偏移会让快速切换模板整片错帧（velocity 网格色差 2.90→17.50）。</p></div>
<div class=card2><b>④ 硬切不插值</b><p>相邻颜色场平均差 &gt;20 标记为镜头硬切，
该区间改为在区间中点硬切而非线性插值 —— 插值会合成原片不存在的混合画面。
实测 velocity 21 处、user 36 处硬切；修复后 velocity MAD 23.68→10.56、
user 从 24.68 继续收敛。</p></div>
<div class=card2><b>⑤ 确定性微噪点（低幅互补）</b><p>两张逐像素互补的全幅噪点图按帧号奇偶切换，
以 0.025 的低 alpha 破除 60fps 静态段重复帧，同时把纯色背景上的理论 MAD 开销
从约 4.9/255 压到约 2.7/255；相位由帧号唯一决定，逐帧可独立 seek。</p></div>
<h2>对抗审查：三轮修正与两条否决</h2>
<div class=card2><b>修正 1 · 时间轴</b><p>先按相似度推测 +0.25s，后用 <code>showinfo</code>
看到 PTS=0/0.5/1.0，一度以为改错方向；最终用<b>精确帧号</b>（select eq(n,·)）判定：
PTS 只是标签，帧内容取的是区间中点。判定器自身也会误导，最终证据必须来自可直接对齐的量。</p></div>
<div class=card2><b>修正 2 · 硬切插值</b><p>首轮 v2 平均 MAD 仅 −10.7%，velocity / user / creator
反而劣化；误差分解发现劣化模板的相邻颜色场平均差高达 25–29（ink 仅 4.0），
指向「插值跨过硬切」。改为硬切后平均降幅收敛到 −31.1%。</p></div>
<div class=card2><b>修正 3 · 采样密度与噪点</b><p>user 的残留劣化集中在单个采样点
t=33.05s（MAD 115.39），不是普遍错色；0.5s 采样不足以定位该切点。收紧到 0.25s
并降低噪点后，该点降到 25.2、整片 MAD 24.68→11.74。</p></div>
<div class=card2><b>否决 A · 净背景场擦除 + 矢量图形层</b><p>曾把文字/图形覆盖的颜色场格子
插值擦除，并把高对比连通块画成矢量圆/矩形。实测单帧 MAD <b>7.20 → 8.38 反而变差</b>，
目视出现抹除色带，且把「蓝色圆点群 / 带字 logo」错误聚合成矩形。已回退，
改用提高颜色场粒度（96×54→160×90，MAD 7.20→6.57）让糊影自然减轻。</p></div>
<div class=card2><b>否决 B · 把整帧降采样直接当画面</b><p>若直接贴高分辨率参考帧，
MAD 可以趋近 0，但那是重编码不是复刻。v2 保持 160×90 的低维色彩参数 +
独立文字层，并把这一边界明确写出，不用「指标全绿」掩盖方法。</p></div>
<h2>诚实清单：离严格 1:1 还差什么</h2>
<div class=note>
<p>1. <b>不是逐像素 1:1</b>：官方片的真实字体、字距、抗锯齿、UI 截图内部细节、
渐变纹理与动效曲线无法仅凭成片测量精确重建；v2 还原的是色彩布局、构图、文案内容与时间轴。
MAD 仍在 {m["mad"]["v2"]} 量级。颜色场平滑也会让高频纹理低于参考片（逐模板锐度比
0.14–1.35），这是用「色彩/构图对齐」交换「纹理细节」的固有代价。</p>
<p>2. <b>方法边界要讲清</b>：160×90 颜色场来自公开成片的低分辨率测量，属于
「高密度的成片观测参数」，<b>不是 v1 意义上的纯手工独立建模</b>；文字层才是独立重建。
v1 全部产物保留在 <code>VIDEOS.html</code> / <code>REPORT.html</code>，两套并列可选。</p>
<p>3. <b>受保护实现未触碰</b>：8 个包均为 <code>protection: protected</code>，
全程只读公开预览片像素，未检视 core / release.bin；若要真正逐像素 1:1，
需要授权使用模板包内素材与实现，这超出当前合规路径。</p>
<p>4. <b>无原片音轨</b>；参考片、含账户 Key 的封套与可重跑媒体均已 .gitignore 隔离。</p>
<p>5. <b>v1 的 64/64 审查未被覆盖</b>：该判据是为骨架复刻设计（含锐度中位数、安全区等），
v2 画面结构不同，不宣称在同一清单上全绿；本轮以同口径 MAD / 色差作为还原度判据。</p>
</div>
<h2>复跑命令</h2><div class=note><p><code>uv run --with numpy --with pillow python replicas/engine/v2/measure2.py</code> →
<code>node replicas/engine/v2/render2.mjs --slug &lt;slug&gt; --out replicas/out/&lt;slug&gt;/replica-v2.mp4</code> →
<code>uv run --with numpy --with pillow python replicas/engine/compare2.py</code> →
<code>uv run --with numpy --with pillow python replicas/engine/evaluate2.py</code> →
<code>uv run --with numpy --with pillow python replicas/engine/gallery2.py</code></p></div>
<footer>数据由脚本从 8 条真实成片与官方预览片渲染 · 2026-11-10</footer></div></html>'''
    (ROOT / "VIDEOS-V2.html").write_text(h)
    return ROOT / "VIDEOS-V2.html"


def main():
    items = [one(s) for s in sorted(p.stem.replace('.spec', '')
                                   for p in (ROOT / "specs").glob("*.spec.json"))]
    overview = make_overview(items)
    ev = json.loads((ROOT / "v2-eval.json").read_text())
    audit = json.loads((ROOT / "audit-after.json").read_text())
    page = build_html(items, overview, ev, audit)
    print(f"✓ {overview.name} (48s) · 精选 {len(items)*len(PICKS)} 段 · "
          f"拼图 {len(items)} 张 · {page.name}")


if __name__ == "__main__":
    main()
