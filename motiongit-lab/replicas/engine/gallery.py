#!/usr/bin/env python3
"""把 8 个模板的对比视频整理成可直接播放/目视的交付：总览视频、每模板精选片段与拼图、索引页。

用法：uv run --with numpy --with pillow python replicas/engine/gallery.py
依赖：先跑 compare.py --tag after 与 verify-video.py。
"""
import html
import json
import pathlib
import shutil
import subprocess

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
FFMPEG = "/opt/homebrew/bin/ffmpeg"
PICKS = (0, 3, 7)          # 每个模板取首 / 中 / 尾三个时间点
STRIPS = (0, 2, 4, 6)      # 拼图取四个时间点
SIDE_W, SIDE_H, LABEL_H, DUR = 640, 360, 60, 2.0


def run(args):
    subprocess.run(args, check=True, capture_output=True)


def esc(s):
    return html.escape(str(s))


def one(slug):
    out = ROOT / "out" / slug
    cmp = out / "compare.mp4"
    spec = json.loads((ROOT / "specs" / f"{slug}.spec.json").read_text())
    met = json.loads((out / "metrics-after.json").read_text())
    vc = out / "vcompare"

    # 1) 每个模板 3 段精选并排视频，放到统一可访问目录
    hi = ROOT / "highlights"
    if not hi.exists():
        hi.mkdir(parents=True)
    picks = []
    for k, i in enumerate(PICKS):
        src = vc / f"pair-{i:02d}.mp4"
        dst = hi / f"{slug.replace('motiongit-promo-', '')}-{k + 1:02d}.mp4"
        shutil.copy2(src, dst)
        picks.append(dict(n=k + 1, group=i + 1, t=met["rows"][i]["t"],
                          file=str(dst.relative_to(ROOT))))

    # 2) 四点拼图（2×2 缩略，标签栏保留，可直接目视左右差异）
    prev = ROOT / "preview"
    if not prev.exists():
        prev.mkdir(parents=True)
    cell_h = (SIDE_H + LABEL_H) // 2
    canvas = Image.new("RGB", (SIDE_W * 2, cell_h * 2), (14, 16, 21))
    for k, i in enumerate(STRIPS):
        p = f"/tmp/gal-{slug}-{i}.png"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{i * DUR + DUR / 2:.3f}",
             "-i", str(cmp), "-frames:v", "1", "-y", p])
        im = Image.open(p).convert("RGB").resize((SIDE_W, cell_h), Image.LANCZOS)
        canvas.paste(im, ((k % 2) * SIDE_W, (k // 2) * cell_h))
    pimg = prev / f"{slug.replace('motiongit-promo-', '')}.png"
    canvas.save(pimg)

    return dict(slug=slug, short=slug.replace('motiongit-promo-', ''),
                version=spec.get("version", "-"), duration=spec["meta"]["duration"],
                compare=str(cmp.relative_to(ROOT)), preview=str(pimg.relative_to(ROOT)),
                means=met["means"], picks=picks)


def make_overview(items):
    lines = []
    for it in items:
        for i in PICKS:
            lines.append(f"file '{(ROOT / 'out' / it['slug'] / 'vcompare' / f'pair-{i:02d}.mp4').resolve()}'")
    lst = ROOT / "overview-concat.txt"
    lst.write_text("\n".join(lines) + "\n")
    dst = ROOT / "ALL-COMPARE.mp4"
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(lst), "-c", "copy", "-y", str(dst)])
    return dst


def build_html(items, overview, integrity, audit):
    kpis = [
        ("8 条", "每模板一条完整对比视频（16s / 8 组）"),
        (f"{len(items) * len(PICKS)} 段", "精选并排片段（首 / 中 / 尾）"),
        (f"{len(items) * len(PICKS) * DUR:.0f}s", "总览视频时长"),
        (f"{integrity['pass_count']}/{integrity['total']}", "左右对应关系实测通过"),
        (f"{audit['overall_pass']}/{audit['overall_total']}", "8 条对抗审查清单"),
    ]
    kpi = "".join(f'<div class=stat><b>{esc(v)}</b><span>{esc(n)}</span></div>' for v, n in kpis)
    cards = []
    for it in items:
        m = it["means"]
        links = " · ".join(
            f'<a href="{esc(p["file"])}">片段 {p["n"]} · t={p["t"]}s</a>' for p in it["picks"])
        cards.append(f'''<div class=card>
<h3>{esc(it["short"])} <span>v{esc(it["version"])} · {it["duration"]:.1f}s · 8 组</span></h3>
<div class=metrics><span>网格色差 <b>{m["grid_diff"]}</b></span><span>固定点色差 <b>{m["point_diff"]}</b></span>
<span>MAD <b>{m["mad"]}</b></span><span>锐度比 <b>{m["sharp_ratio"]}</b></span></div>
<video src="{esc(it["compare"])}" controls preload=metadata></video>
<img src="{esc(it["preview"])}" alt="四点拼图" loading=lazy>
<div class=links>{links}</div></div>''')
    rows = []
    for r in integrity["items"]:
        lo = min(x["left_vs_official"] for x in r["rows"])
        ro = min(x["right_vs_replica"] for x in r["rows"])
        lx = min(x["left_vs_replica"] for x in r["rows"])
        rx = min(x["right_vs_official"] for x in r["rows"])
        rows.append(f'<tr><td class=mono>{esc(r["slug"].replace("motiongit-promo-", ""))}</td>'
                    f'<td class=num>{r["pass_groups"]}/{r["total_groups"]}</td>'
                    f'<td class=num>{lo:.1f} / {lx:.1f}</td><td class=num>{ro:.1f} / {rx:.1f}</td>'
                    f'<td class="{ "good" if r["verdict"] == "PASS" else "bad" }">{r["verdict"]}</td></tr>')
    h = f'''<!doctype html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>8 模板 · 视频对比原版</title><style>
:root{{color-scheme:dark}}body{{margin:0;background:#0e1116;color:#e6e9ef;
font:15px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:44px 26px 80px}}
.kicker{{color:#7aa2f7;font-size:12px;letter-spacing:.18em;text-transform:uppercase}}
h1{{font-size:29px;margin:10px 0 6px;font-weight:650}}
h2{{font-size:19px;margin:40px 0 14px;padding-bottom:8px;border-bottom:1px solid #242a35}}
.sub{{color:#98a2b3}}.stats{{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}}
.stat{{background:#151a22;border:1px solid #242a35;border-radius:10px;padding:12px 18px;min-width:135px}}
.stat b{{display:block;font-size:21px;color:#9ece6a}}.stat span{{font-size:12px;color:#98a2b3}}
video{{width:100%;background:#000;border:1px solid #242a35;border-radius:8px;display:block}}
.hero{{margin:14px 0}}.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}}
.card{{background:#151a22;border:1px solid #242a35;border-radius:10px;padding:16px}}
.card h3{{font-size:16px;margin:0 0 8px;font-weight:600}}
.card h3 span{{font-size:12px;color:#8b93a1;font-weight:400;margin-left:8px}}
.metrics{{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#8b93a1;margin-bottom:10px}}
.metrics b{{color:#c6ccd8;font-variant-numeric:tabular-nums}}
.card img{{width:100%;border:1px solid #242a35;border-radius:8px;margin-top:10px;display:block}}
.links{{margin-top:10px;font-size:12px}}.links a{{color:#7aa2f7;text-decoration:none;margin-right:6px}}
.links a:hover{{text-decoration:underline}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{text-align:left;color:#98a2b3;font-weight:500;padding:9px 8px;border-bottom:1px solid #2a313d}}
td{{padding:9px 8px;border-bottom:1px solid #1c222c}}
.mono{{font-family:ui-monospace,Menlo,monospace;font-size:12px}}
.num{{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}}
.good{{color:#9ece6a;font-weight:600}}.bad{{color:#f7768e;font-weight:600}}
.note{{background:#1b1f28;border:1px solid #2a313d;border-radius:8px;padding:14px 18px;color:#a9b1c0;font-size:13px}}
.card2{{background:#151a22;border:1px solid #242a35;border-left:3px solid #7aa2f7;border-radius:8px;
padding:12px 16px;margin:10px 0}}.card2 b{{color:#c6ccd8}}.card2 p{{margin:4px 0 0;color:#a9b1c0;font-size:13px}}
code{{background:#1b2230;padding:2px 6px;border-radius:4px;font-size:12px;color:#9ece6a}}
footer{{margin-top:44px;color:#6b7484;font-size:12px}}
</style><div class=wrap>
<div class=kicker>元素级复刻 · 视频对比原版</div>
<h1>8 个模板：每个都跑视频，逐一对比官方原版</h1>
<div class=sub>左半＝官方预览原片，右半＝独立元素级复刻成片；每模板 8 个均匀时间点各 2.0s 并排，
标签栏注明模板、时间点与该组实算指标。所有视频均可直接播放。</div>
<div class=stats>{kpi}</div>
<h2>总览：8 模板 × 3 个时间窗（48s，左官方 / 右复刻）</h2>
<div class=hero><video src="{esc(overview.name)}" controls preload=metadata></video>
<div class=sub>顺序按模板名，每个模板取第 1 / 4 / 8 组。逐模板完整 16s 对比见下方卡片。</div></div>
<h2>逐模板对比视频</h2><div class=grid>{"".join(cards)}</div>
<h2>对抗审查：左右对应关系（从成片抽帧实测）</h2>
<table><thead><tr><th>模板</th><th>通过组数</th><th>左半 MAD：官方 / 复刻</th>
<th>右半 MAD：复刻 / 官方</th><th>判定</th></tr></thead><tbody>{"".join(rows)}</tbody></table>
<div class=note style="margin-top:14px"><p>每侧数值为该模板 8 组中的<b>最小</b> MAD。
左半对官方的距离显著小于对复刻的距离、右半反之，证明拼接没有把左右接反，
也没有把片段时间点错位。<code>compare.mp4</code> 是 8×2s 的拼接视频（16s），
验证脚本按 <code>concat_t=2i+1</code> 映射回原片时间点，不能直接用原片时间 seek。</p></div>
<h2>本轮修了什么</h2>
<div class=card2><b>① 标签栏左右错位</b><p>原 <code>label()</code> 把「官方参考 / 复刻 / 指标」全部画在
x=640 以右，与画面左右不对应，容易把右半误读成官方。现左半只写官方侧、右半只写复刻侧与该组指标。</p></div>
<div class=card2><b>② 中文标签渲染成方块</b><p>代码写死 <code>/System/Library/Fonts/PingFang.ttc</code>，
本机不存在该路径，Pillow 静默回退到无中文字形的默认字体。改为按候选列表探测
（STHeiti Medium → Arial Unicode），并保留兜底。</p></div>
<div class=card2><b>③ 补一条可复跑的完整性判据</b><p>新增 <code>verify-video.py</code>：
从成片抽帧裁出左右半边，与两源片在对应原片时间点抽帧做 MAD 比对，8 模板 × 8 组给出证据。
此前「对比视频存在」只靠文件与目视，没有机器可复现的左右对应证明。</p></div>
<h2>诚实清单</h2>
<div class=note><p>1. 复刻是<b>视觉系统级骨架</b>而非逐像素搬运：官方片含真实文案、人物、素材与字体，
复刻片是测量得到的色块网格 / 文字带 / 内容边界 / 时间轴，因此画面内容不同；
可比的是配色分布、几何、节奏与锐度特征，指标已逐项列在卡片上。</p>
<p>2. 模板包为 <code>protection: protected</code>，规格只从公开成片测量获得，未检视受保护实现。</p>
<p>3. 无原片音轨；参考片与含账户 Key 的封套、可重跑媒体产物均已 .gitignore 隔离，不随交付外发。</p>
<p>4. 修复标签只改变标签栏像素，不改渲染器与 spec；重跑 <code>compare.py --tag after</code> 后
指标数值与 <code>audit-after.json</code> 保持一致。</p></div>
<h2>复跑命令</h2><div class=note><p><code>uv run --with numpy --with pillow python replicas/engine/compare.py --tag after</code> ·
<code>uv run --with numpy --with pillow python replicas/engine/verify-video.py</code> ·
<code>uv run --with numpy --with pillow python replicas/engine/gallery.py</code></p></div>
<footer>数据由脚本从 8 条真实成片与源片渲染 · 2026-11-10</footer></div></html>'''
    (ROOT / "VIDEOS.html").write_text(h)
    return ROOT / "VIDEOS.html"


def main():
    slugs = sorted(p.stem.replace('.spec', '') for p in (ROOT / "specs").glob("*.spec.json"))
    items = [one(s) for s in slugs]
    overview = make_overview(items)
    integrity = json.loads((ROOT / "video-integrity.json").read_text())
    audit = json.loads((ROOT / "audit-after.json").read_text())
    page = build_html(items, overview, integrity, audit)
    print(f"✓ 总览 {overview.name} ({len(items) * len(PICKS) * DUR:.0f}s) · "
          f"精选 {len(items) * len(PICKS)} 段 · 拼图 {len(items)} 张 · 索引 {page.name}")
    for it in items:
        print(f"  {it['short']:<12} 网格 {it['means']['grid_diff']:6.2f}  "
              f"MAD {it['means']['mad']:6.2f}  {it['compare']}")


if __name__ == "__main__":
    main()
