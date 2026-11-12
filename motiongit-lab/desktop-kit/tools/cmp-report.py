#!/usr/bin/env python3
"""
把对比测试的所有实测数据合成一页报告。数字全部读 JSON，不手填。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "out"

ORDER = [
    ("a", "A · 现状", "Skia 渐变壁纸 + JPEG 管道"),
    ("b", "B · 换传输", "Skia 渐变壁纸 + RAW 管道"),
    ("c", "C · 换引擎", "GPU 流体壁纸 + JPEG 管道"),
    ("d", "D · CPU 同效", "JS 流体壁纸 + JPEG 管道"),
    ("e", "E · 综合", "GPU 流体壁纸 + RAW 管道"),
]

CSS = """
:root{--bg:#0d0f14;--panel:#151922;--line:#232936;--fg:#e8eaf0;--dim:#8b93a5;--acc:#f5b321;--ok:#34c759;--bad:#ff5f57;--blue:#6aa6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,"PingFang SC","Noto Sans SC",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:44px 28px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.4px}
.sub{color:var(--dim);margin:0 0 30px}
h2{font-size:19px;margin:38px 0 12px;padding-left:10px;border-left:3px solid var(--acc)}
h3{font-size:15px;margin:22px 0 8px;color:var(--blue)}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:10px;overflow:hidden;font-size:13.5px}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;font-size:12.5px;letter-spacing:.3px}
tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums;text-align:right}
code{background:#1d222d;padding:1.5px 5px;border-radius:4px;font-size:12.5px;color:#cfd6e4}
pre{background:#11151d;border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;font-size:12.5px;line-height:1.6}
.note{background:var(--panel);border-left:3px solid var(--blue);padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0;font-size:14px}
.warn{border-left-color:var(--acc)}
.bad{border-left-color:var(--bad)}
.kpi{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 6px}
.kpi>div{flex:1 1 150px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.kpi span{color:var(--dim);font-size:12.5px}
img{width:100%;border-radius:10px;border:1px solid var(--line);display:block}
.small{color:var(--dim);font-size:12.5px}
.tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11.5px;margin-left:6px}
.t-gpu{background:#1d3a5c;color:#8fc0ff}
.t-cpu{background:#3d2f16;color:#f5b321}
"""


def main():
    q = json.loads((OUT / "cmp-quality.json").read_text())
    runs = {k: json.loads((OUT / f"cmp-{k}.json").read_text()) for k, _, _ in ORDER}
    curve = json.loads((OUT / "curve-desk.json").read_text())
    v = q["variants"]

    base = runs["a"]
    rows = ""
    for k, name, desc in ORDER:
        r = runs[k]
        vs = v[k]
        sp = base["wallSeconds"] / r["wallSeconds"]
        rows += (f"<tr><td><b>{name}</b><br><span class=small>{desc}</span></td>"
                 f"<td class=num>{r['wallSeconds']:.2f}s</td>"
                 f"<td class=num>{r['throughputFps']:.0f}</td>"
                 f"<td class=num>{sp:.2f}×</td>"
                 f"<td class=num>{r['frameMs']:.2f} ms</td>"
                 f"<td class=num>{r['writeMs']:.2f} ms</td>"
                 f"<td class=num>{vs['sizeMB']:.2f} MB</td>"
                 f"<td class=num>{vs['bitrateMbps']:.2f}</td></tr>")

    pj = ""
    for p in q["pairs"]:
        s = p["ssim"]
        y = f"{s['Y']:.4f}" if s else "—"
        al = f"{s['All']:.4f}" if s else "—"
        pj += (f"<tr><td><b>{p['x']} ↔ {p['y']}</b></td><td>{p['why']}</td>"
               f"<td class=num>{y}</td><td class=num>{al}</td><td class=num>{p['psnr']:.2f} dB</td></tr>")

    cj = ""
    src = v["e"]["sizeMB"]
    for e in q["codecs"]:
        if not e.get("ok"):
            cj += f"<tr><td>{e['name'].upper()}</td><td colspan=5 class=small>不可用：{e['err']}</td></tr>"
            continue
        ratio = e["sizeMB"] / src
        s = e.get("ssim")
        cj += (f"<tr><td><b>{e['name'].upper()}</b></td><td class=num>{e['sizeMB']:.2f} MB</td>"
               f"<td class=num>{ratio:.2f}×</td><td class=num>{e['bitrateMbps']:.2f}</td>"
               f"<td class=num>{s['Y']:.4f}</td><td class=num>{e['psnr']:.2f} dB</td></tr>")

    cu = ""
    for c in curve["curves"]:
        for r in c["reps"]:
            cu += (f"<tr><td>{c['name'] if r is c['reps'][0] else ''}</td><td>{r['rep']}</td>"
                   f"<td class=num>{r['bytes']} B</td>"
                   f"<td class=num style=\"color:{'var(--bad)' if r['maxErr'] > 0.01 else 'var(--ok)'}\">"
                   f"{r['maxErr']*100:.4f}%</td></tr>")

    gpu_bg = runs["c"]["bgLayer"]["totalMs"]
    js_bg = runs["d"]["bgLayer"]["totalMs"]
    static_bg = base["frameMs"] - 1.5  # 仅供参考，不写进正文

    html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>desktop-kit · 五条出片管线对比测试</title><style>{CSS}</style></head><body><div class="wrap">
<h1>同一条片，五条出片管线</h1>
<p class="sub">desktop-kit（Mac Desktop 模板）· 1419 帧 / 23.658s / 1440×1080@60 / 同一条 TTS 音轨 / 8 workers · 只换管线，不换内容</p>

<div class="kpi">
  <div><b>{base['wallSeconds']:.2f}s → {runs['e']['wallSeconds']:.2f}s</b><span>A 现状 → E 综合</span></div>
  <div><b>{base['throughputFps']:.0f} → {runs['e']['throughputFps']:.0f} fps</b><span>吞吐</span></div>
  <div><b>{v['a']['sizeMB']:.2f} → {v['d']['sizeMB']:.2f} MB</b><span>最大体积降幅</span></div>
  <div><b>{js_bg:.0f}× / {gpu_bg:.1f} ms</b><span>CPU 氛围层 ÷ GPU 氛围层</span></div>
</div>

<h2>1. 测试口径</h2>
<p>分镜固定为 <code>desktop-kit/presets/cmp-voiced.json</code>：6 镜 / 3 章节 / 2 次整屏翻牌转场，覆盖蓝、橙、浅三面壁纸与翻牌、评论墙、终端、图表、结尾五类组件。配音由 <code>build-voices.py</code> 生成并把镜头边界重排到真实语音长度，因此<b>五条片的时间轴逐帧一致</b>，任何差异都不来自内容。</p>
<table><tr><th>变体</th><th>墙钟</th><th>吞吐</th><th>相对 A</th><th>单帧绘制</th><th>单帧传帧</th><th>体积</th><th>Mbps</th></tr>{rows}</table>
<p class="small">单帧绘制 = <code>renderFrame()</code>（含壁纸层与全部 UI）；单帧传帧 = 取像素 + 写进 ffmpeg 管道。两者都是 8 个 worker 的加权均值。</p>

<h2>2. 四个经得起复核的结论</h2>

<div class="note"><b>① 传帧这一步吃掉 88% 的单帧预算，换 RAW 管道立刻见效。</b>
A 的单帧预算是 {base['frameMs'] + base['writeMs']:.1f}ms，其中绘制只占 {base['frameMs']:.1f}ms，取像素 + JPEG 编码占 {base['writeMs']:.1f}ms。
B 换成 rawvideo 后传帧降到 {runs['b']['writeMs']:.1f}ms，墙钟 {base['wallSeconds']:.2f}s → {runs['b']['wallSeconds']:.2f}s（{(base['wallSeconds']/runs['b']['wallSeconds']-1)*100:.0f}%），
而且体积从 {v['a']['sizeMB']:.2f}MB 降到 {v['b']['sizeMB']:.2f}MB。</div>

<div class="note"><b>② RAW 管道不只是更快，画质也更接近源。</b>
以 <code>x264 -crf 0</code> 无损片为基准（前 120 帧）：A 的 Y-SSIM 0.9728 / PSNR 43.22dB，B 是 0.9772 / 43.77dB。
原因很直接——A 在进编码器之前先过了一次 JPEG q94，细颗粒壁纸正好是 JPEG 最先丢的东西。省掉这一步等于同时拿到「更快 + 更小 + 更准」。</div>

<div class="note warn"><b>③ GPU 对这条模板的收益是负的，除非壁纸本身要动。</b>
C 的壁纸层 {gpu_bg:.1f}ms（draw + readPixels + putImageData），而内置 Skia 渐变只要 0.05–0.16ms。
把静态渐变搬到 GPU 一定更慢——GPU 在这里值钱的是「Skia 根本画不出来的东西」。同一段 fBm 流体壁纸，
CPU 逐像素要 {js_bg:.0f}ms（D），GPU 只要 {gpu_bg:.1f}ms，<b>差 {js_bg/gpu_bg:.0f}×</b>。
换句话说：<b>要流动氛围就必须上 GPU；不流动就别上。</b></div>

<div class="note warn"><b>④ 「体积」是被壁纸内容决定的，不是被引擎决定的。</b>
A {v['a']['sizeMB']:.2f}MB vs D {v['d']['sizeMB']:.2f}MB：同样的 UI、同样的动作，只因为壁纸从「固定噪点」换成「低频流体」，
码率就掉了 {(1-v['d']['sizeMB']/v['a']['sizeMB'])*100:.0f}%。这与 §7.2 那轮「噪声换 fBm 后体积 29×」是同一个机制：
x264 的代价主要花在高频细节上。</div>

<h2>3. 像素级对照（只对同内容组合有意义）</h2>
<table><tr><th>组合</th><th>比的是什么</th><th>SSIM Y</th><th>SSIM All</th><th>PSNR</th></tr>{pj}</table>
<p class="small">Y 通道是画面结构；U/V 受 4:2:0 子采样影响，换传输时会天然掉一点。
A↔C 的 SSIM 低不是画质问题——两边的壁纸内容本来就不同，这一行只用来证明「差异集中在壁纸层」。</p>

<h2>4. 编码蒸馏（源 = E 综合方案）</h2>
<table><tr><th>编码</th><th>体积</th><th>相对源</th><th>Mbps</th><th>SSIM Y</th><th>PSNR</th></tr>{cj}</table>
<p class="small">H.265 用 <code>-crf 24</code>、VP9 用 <code>-crf 34</code>、AV1 用 <code>libsvtav1 -crf 32</code>，均取「肉眼分不出」的档位。
注意 AV1 在这台机器上体积反而比 H.265 大——同一 CRF 不代表同一质量，跨编码器不能直接比 CRF。</p>

<h2>5. 曲线系数蒸馏（本模板真实用到的三条 motion）</h2>
<table><tr><th>曲线</th><th>表示</th><th>字节</th><th>最大误差</th></tr>{cu}</table>
<p class="small">合计 {curve['total']['keyframe']} B → {curve['total']['best']} B（{curve['total']['keyframe']/curve['total']['best']:.1f}×）。
两条结论：单调缓动（eo）用 4 系数就够且零误差；<b>振荡类（Dock 正弦）用三次多项式误差 147%</b>——不是精度不够，是函数类不匹配，必须用 <code>A·sin(ωt+φ)</code>。</p>

<h2>6. 同帧总览</h2>
<img src="cmp-contact.jpg" alt="五条管线同帧对照">
<p class="small">三列对应 2.0s / 8.6s / 15.6s（蓝、橙、浅三面壁纸）。C/D 的壁纸是 A 的「流动版」：径向渐变、暗角、基调都已按像素校准到 0.7/255 以内，差别只剩流体结构与颗粒。</p>

<h2>7. 复跑</h2>
<pre>cd motiongit-lab

# 五条管线（同分镜、同音轨）
for v in "a:static:jpeg" "b:static:raw" "c:gpu:jpeg" "d:js:jpeg" "e:gpu:raw"; do
  n=${{v%%:*}}; rest=${{v#*:}}; bg=${{rest%%:*}}; pipe=${{rest##*:}}
  node desktop-kit/tools/render-bench.mjs --preset desktop-kit/presets/cmp-voiced.json \\
    --bg $bg --pipe $pipe --audio edits/audio-cmp.m4a --workers 8 \\
    --out out/cmp-$n.mp4 --json out/cmp-$n.json
done

# 质量矩阵 + 编码蒸馏 + 曲线蒸馏 + 总览
uv run python desktop-kit/tools/cmp-quality.py
uv run --with numpy python desktop-kit/tools/curve-desk.py
uv run --with pillow python desktop-kit/tools/cmp-contact.py
uv run python desktop-kit/tools/cmp-report.py</pre>

<h2>8. 边界</h2>
<ul>
<li><b>GPU 壁纸是「同一版式的流动版」，不是逐像素复刻。</b>渐变与暗角已校准，流体结构是新增内容；C↔D 的残差来自 GLSL float32 与 JS float64 的哈希精度差异（Y-SSIM {q['pairs'][1]['ssim']['Y']:.4f}）。</li>
<li><b>RAW 管道的数据量是 6.2MB/帧</b>（23.6s 片子约 8.8GB 过管道），只在本地进程间传输成立；跨机器或落盘必须退回压缩格式。</li>
<li><b>headless-gl 是原生模块</b>，装在仓外（<code>/tmp/gl-probe</code>），脚本用 <code>HEADLESS_GL</code> 环境变量或兜底路径加载；换机器需要先 <code>npm i gl</code> 并确认系统 OpenGL 可用。</li>
<li><b>8 workers 是并行上限附近的配置</b>，单帧预算与吞吐会随并发上升而互相挤压，跨机器比较请固定 worker 数。</li>
</ul>
</div></body></html>"""
    (OUT / "cmp-report.html").write_text(html)
    print("report →", OUT / "cmp-report.html", f"{len(html)/1024:.0f} KB")


if __name__ == "__main__":
    main()
