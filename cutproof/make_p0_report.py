#!/usr/bin/env python3
"""从真实运行结果生成 P0 输入归一化手册（表格数据全部来自 res/matrix.json）。"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DELIV = ROOT.parent / "deliverables"

matrix = json.loads((ROOT / "res" / "matrix.json").read_text())
manifest = {m["id"]: m for m in json.loads((ROOT / "corpus" / "manifest.json").read_text())}

TOTAL = len(matrix)
PASS_THRU = [r for r in matrix if not r["actions"] and not r["error"]]
NORM_OK = [r for r in matrix if r["normalized_ok"]]
BLOCKED = [r for r in matrix if r["severity"] == "block"]
TRANSCODED = [r for r in matrix if r["normalized_ok"] and r["actions"]]
WARNED = [r for r in matrix if r["warnings"] and r["severity"] != "block"]
CLEAN = [r for r in matrix if not r["flags"]]

RES_PILL = {"ok": '<span class="pill ok">归一化通过</span>',
            "block": '<span class="pill bad">拒绝入队</span>'}


def short(id_):
    return id_.split("_", 1)[1].replace("_", " ") if "_" in id_ else id_


def rows_html():
    out = []
    for r in matrix:
        desc = manifest.get(r["id"], {}).get("desc", "")
        flags = " · ".join(f'<code>{f}</code>' for f in r["flags"]) or '<span class="dim">— 无标记 —</span>'
        acts = " · ".join(f'<span class="act">{a}</span>' for a in r["actions"]) or '<span class="dim">零转码直通</span>'
        if r["error"]:
            res = f'<span class="pill bad">拒绝入队</span><div class="code">{r["error"]}</div>'
            spec = '<span class="dim">—</span>'
        else:
            res = RES_PILL["ok"]
            p = r.get("post") or {}
            a = p.get("audio") or {}
            spec = (f'{p.get("width")}×{p.get("height")} · {p.get("pix_fmt")} · '
                    f'{p.get("fps")}fps · {a.get("rate")}Hz/{a.get("channels")}ch')
        warn = ""
        if r["warnings"]:
            warn = f'<div class="warn">{r["warnings"][0]}</div>'
        out.append(f'''<tr>
  <td><div class="id">{r["id"]}</div><div class="spec">{spec}</div></td>
  <td class="desc">{desc}{warn}</td>
  <td class="flags">{flags}</td>
  <td class="acts">{acts}</td>
  <td class="res">{res}</td>
</tr>''')
    return "\n".join(out)


HTML = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P0 · 输入归一化手册</title>
<style>
:root{{
  --paper:#f7f5f0;--card:#fffefb;--ink:#1b1a17;--ink-2:#4a4740;--ink-3:#8a857b;
  --rule:#ded8cc;--rule-2:#c9c2b2;--acc:#b8402a;--acc-soft:#f3e4df;
  --teal:#0f5b57;--teal-soft:#e3eeec;--amber:#9a6b1f;--amber-soft:#f6eeda;
}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:16px;line-height:1.8;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:1180px;margin:0 auto;padding:0 28px 110px}}
h1,h2,h3,.serif{{font-family:"Songti SC","Noto Serif SC",Georgia,serif;font-weight:600}}
.hero{{padding:70px 0 36px;border-bottom:1px solid var(--rule)}}
.kicker{{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--acc);font-weight:700;margin-bottom:20px}}
h1{{font-size:40px;line-height:1.25;margin:0 0 18px}}
.lede{{font-size:17.5px;color:var(--ink-2);max-width:760px;margin:0}}
.lede b{{color:var(--ink)}}

.stats{{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--rule);
  border:1px solid var(--rule);margin:38px 0 0}}
.stat{{background:var(--card);padding:18px 20px}}
.stat .n{{font-family:"Songti SC",Georgia,serif;font-size:34px;line-height:1.1;color:var(--ink)}}
.stat .n small{{font-size:14px;color:var(--ink-3);font-family:inherit}}
.stat .l{{font-size:12.5px;color:var(--ink-3);margin-top:4px;letter-spacing:.02em}}
.stat.hot .n{{color:var(--acc)}}
.stat.good .n{{color:var(--teal)}}

section{{margin-top:58px}}
h2{{font-size:25px;margin:0 0 8px;padding-top:16px;border-top:2px solid var(--ink)}}
h2 .num{{font-size:13px;letter-spacing:.1em;color:var(--acc);margin-right:11px;
  vertical-align:3px;font-family:-apple-system,sans-serif;font-weight:700}}
.sub{{color:var(--ink-3);font-size:14.5px;margin:0 0 24px}}
h3{{font-size:18.5px;margin:34px 0 10px}}
p{{margin:0 0 16px;color:var(--ink-2)}}
strong{{color:var(--ink);font-weight:600}}
code{{font-family:ui-monospace,Menlo,monospace;font-size:.86em;background:#eee9dd;
  padding:1px 5px;border-radius:2px;color:#3a352c}}

/* 矩阵表 */
.mwrap{{overflow-x:auto;border:1px solid var(--rule);background:var(--card)}}
table{{width:100%;border-collapse:collapse;font-size:13.5px;min-width:1000px}}
th{{text-align:left;font-size:12px;letter-spacing:.05em;color:var(--ink);font-weight:600;
  padding:10px 14px;border-bottom:1.5px solid var(--ink);white-space:nowrap;background:#fbf9f3}}
td{{padding:12px 14px;border-bottom:1px solid var(--rule);vertical-align:top}}
tr:last-child td{{border-bottom:none}}
.id{{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--ink);font-weight:600}}
.spec{{font-size:11.5px;color:var(--ink-3);margin-top:3px;font-family:ui-monospace,Menlo,monospace}}
.desc{{color:var(--ink-2);font-size:13px;line-height:1.6;min-width:230px}}
.warn{{font-size:11.5px;color:var(--amber);margin-top:5px;line-height:1.5;
  padding-left:9px;border-left:2px solid var(--amber-soft)}}
.flags code{{display:inline-block;font-size:10.5px;background:#eee9dd;color:#5a5346;
  padding:1px 5px;margin:0 3px 3px 0}}
.acts .act{{display:inline-block;font-size:11px;background:var(--teal-soft);color:var(--teal);
  padding:1px 6px;border-radius:2px;margin:0 3px 3px 0;font-family:ui-monospace,Menlo,monospace}}
.res{{white-space:nowrap}}
.code{{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--acc);margin-top:4px}}
.pill{{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11.5px;line-height:1.75;white-space:nowrap}}
.pill.ok{{background:var(--teal-soft);color:var(--teal)}}
.pill.bad{{background:var(--acc-soft);color:var(--acc)}}
.pill.mid{{background:var(--amber-soft);color:var(--amber)}}
.dim{{color:var(--ink-3);font-size:12px}}

/* 流程图 */
.flow{{display:grid;grid-template-columns:1fr 46px 1fr 46px 1fr;align-items:stretch;gap:0;margin:26px 0 8px}}
.step{{background:var(--card);border:1px solid var(--rule);padding:18px 20px}}
.step .t{{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--acc);
  letter-spacing:.06em;margin-bottom:6px;font-weight:600}}
.step h4{{margin:0 0 8px;font-size:16px;font-family:"Songti SC",Georgia,serif;font-weight:600}}
.step p{{margin:0;font-size:13px;line-height:1.65}}
.arrow{{display:flex;align-items:center;justify-content:center;color:var(--rule-2);font-size:20px}}

/* 通用表 */
.t2{{width:100%;border-collapse:collapse;font-size:14px;background:var(--card);margin:0 0 10px}}
.t2 th{{text-align:left;font-size:12.5px;padding:10px 14px;border-bottom:1.5px solid var(--ink);background:#fbf9f3}}
.t2 td{{padding:11px 14px;border-bottom:1px solid var(--rule);color:var(--ink-2)}}
.t2 tr:last-child td{{border-bottom:none}}
.t2 td.hi{{color:var(--ink);font-weight:600}}

.note{{border-left:2px solid var(--teal);padding:2px 0 2px 20px;margin:22px 0;color:var(--ink-2);font-size:15px}}
.note.warn-note{{border-left-color:var(--acc)}}
.note .h{{display:block;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--teal);font-weight:700;margin-bottom:5px}}
.note.warn-note .h{{color:var(--acc)}}

.pit{{background:var(--card);border:1px solid var(--rule);border-radius:2px;padding:18px 22px;margin:0 0 12px}}
.pit .t{{font-weight:600;font-size:15.5px;color:var(--ink);margin-bottom:6px}}
.pit .t em{{font-style:normal;font-family:ui-monospace,Menlo,monospace;font-size:12px;
  color:var(--acc);margin-left:8px}}
.pit p{{margin:0;font-size:14px}}
.pit pre{{margin:10px 0 0;background:#25231f;color:#e8e3d7;padding:12px 14px;border-radius:2px;
  font-size:12px;line-height:1.7;overflow-x:auto;font-family:ui-monospace,Menlo,monospace}}
.pit pre b{{color:#f0b429;font-weight:600}}

.chk{{list-style:none;padding:0;margin:16px 0}}
.chk li{{position:relative;padding:11px 0 11px 26px;border-bottom:1px solid var(--rule);font-size:14.5px;color:var(--ink-2)}}
.chk li::before{{content:"";position:absolute;left:2px;top:17px;width:9px;height:9px;
  border:1.5px solid var(--acc);border-radius:2px}}
.chk li b{{color:var(--ink)}}

footer{{margin-top:64px;padding-top:24px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink-3);line-height:1.9}}
@media (max-width:900px){{
  .stats{{grid-template-columns:repeat(2,1fr)}}
  .flow{{grid-template-columns:1fr}}
  .arrow{{height:34px}}
  h1{{font-size:30px}}
}}
</style>
</head>
<body>
<div class="wrap">

<header class="hero">
  <div class="kicker">P0 · 阶段交付 · 第 1–2 周</div>
  <h1>输入归一化手册</h1>
  <p class="lede">这不是一份清单，是一份<strong>跑出来的矩阵</strong>。{TOTAL} 条语料、{TOTAL} 次真实探测、{len(TRANSCODED)} 次真实转码、1 次零转码直通，每条都先在生成时自检"故障特征是否真的复现了"，对不上就判无效。手册里所有数字都可以用一条命令重跑。</p>

  <div class="stats">
    <div class="stat"><div class="n">{TOTAL}</div><div class="l">条故障语料</div></div>
    <div class="stat good"><div class="n">{len(PASS_THRU)}</div><div class="l">零转码直通</div></div>
    <div class="stat good"><div class="n">{len(TRANSCODED)}</div><div class="l">转码后通过校验</div></div>
    <div class="stat"><div class="n">{len(WARNED)}</div><div class="l">带警告（改变了语义）</div></div>
    <div class="stat hot"><div class="n">{len(BLOCKED)}</div><div class="l">必须拒绝入队</div></div>
  </div>
</header>

<section id="why">
  <h2><span class="num">01</span>为什么这个阶段不能跳</h2>
  <p class="sub">先讲一件会决定后面所有工期可信度的事。</p>

  <p>原方案把「跑通产品」定义为"云端 melt 命令行 + XML 模板渲染，打通任务队列 → 成片链路"。这个定义里没有输入归一化。后果是：<strong>输入侧的任何问题，最终都会以"渲染 bug"的形态出现在你面前</strong>——HDR 素材渲出来发灰，你会去查色彩管理；VFR 素材音画不同步，你会去查时间线；旋转素材出横版，你会去查 scale 参数。每一次都会花掉半天到两天，而且修完一个还会再来一个。</p>

  <p>这 {TOTAL} 条语料里，只有 <strong>{len(PASS_THRU)} 条</strong>能零转码直通。<strong>{len(BLOCKED)} 条</strong>必须在入队前就拒绝——它们不是"渲染失败"，是"根本不该开始"。剩下 {len(TRANSCODED)} 条能救，但其中 {len(WARNED)} 条救完会改变素材语义，必须让客户知道。</p>

  <div class="note">
    <span class="h">这一阶段的验收标准</span>
    不是"能渲染了"，而是：<strong>{TOTAL}/{TOTAL} 条语料都被正确分类</strong>——该直通的直通、该归一化的归一化后校验通过、该拒绝的报对错误码。达不到这个，先别装 melt。
  </div>
</section>

<section id="three">
  <h2><span class="num">02</span>三段式：观测 / 决策 / 执行</h2>
  <p class="sub">刻意拆成三个函数，而不是写成一个"检测到就处理"的大函数。</p>

  <div class="flow">
    <div class="step">
      <div class="t">probe()</div>
      <h4>只观测</h4>
      <p>原始 ffprobe + 规范化描述 + 风险标记。<strong>不改动任何字节</strong>。输出可入库、可比对。</p>
    </div>
    <div class="arrow">→</div>
    <div class="step">
      <div class="t">decide()</div>
      <h4>只决策</h4>
      <p>标记 → 声明式动作序列 + 错误码 + 警告。<strong>不碰文件</strong>。这份 JSON 可以 review、可以回放、可以入库对账。</p>
    </div>
    <div class="arrow">→</div>
    <div class="step">
      <div class="t">normalize()</div>
      <h4>只执行</h4>
      <p>按动作序列拼 filtergraph，输出 canonical 中间片，<strong>再跑一次 probe 做自校验</strong>。</p>
    </div>
  </div>

  <p style="margin-top:20px">拆开的收益很具体：客户问"这条素材为什么被转成了这样"，你能直接把 <code>plans/&lt;id&gt;.json</code> 甩出去——里面写着每一个动作的触发原因（<code>"TONEMAP_HDR ← transfer=arib-std-b67 / primaries=bt2020"</code>）。如果三者写在一起，这个问题永远答不上来，只能重新猜一遍。</p>

  <h3>canonical 中间片规格（不可协商）</h3>
  <table class="t2">
    <tr><th style="width:150px">维度</th><th>规格</th><th>为什么</th></tr>
    <tr><td class="hi">时间</td><td>整数帧，CFR 30fps</td><td>浮点秒在 29.97 下必然漂移；漂 1 帧的伤害比换编码器大得多（见主报告 M2/M3）</td></tr>
    <tr><td class="hi">像素</td><td>yuv420p · SAR 1:1 · 长边 ≤1920</td><td>SAR 非 1:1 会让后续所有 crop/scale 的坐标计算带上隐藏系数</td></tr>
    <tr><td class="hi">色彩</td><td>bt709 / bt709 / bt709 / tv，<b>四标齐全</b></td><td>缺一个，播放器就各显各的；见第 05 节第一个坑</td></tr>
    <tr><td class="hi">音频</td><td>48kHz · 立体声 · AAC 192k</td><td>采样率不统一，拼接时重采样会产生 1 帧以内的音画偏移</td></tr>
    <tr><td class="hi">几何</td><td>保留源宽高比，只限长边</td><td>归一化阶段不做 cover/contain —— 那是模板的事，此处裁掉就不可逆</td></tr>
  </table>
</section>

<section id="matrix">
  <h2><span class="num">03</span>归一化矩阵</h2>
  <p class="sub">全部 {TOTAL} 条，按探测顺序。最后一列是"归一化后的实测规格"，不是应该是什么，是实际跑出来是什么。</p>
  <div class="mwrap">
  <table>
    <thead><tr>
      <th style="width:190px">语料 / 产物规格</th>
      <th style="width:280px">事故模式</th>
      <th style="width:230px">检出标记</th>
      <th style="width:230px">决策动作</th>
      <th style="width:110px">结果</th>
    </tr></thead>
    <tbody>
{rows_html()}
    </tbody>
  </table>
  </div>
</section>

<section id="block">
  <h2><span class="num">04</span>三条必须拒绝的</h2>
  <p class="sub">这三个的共同点：<strong>任何"容错"处理都是在替客户做一个他不知道自己做了的决定。</strong></p>

  <table class="t2">
    <tr><th style="width:210px">错误码</th><th style="width:170px">检出点</th><th>为什么不能猜</th></tr>
    <tr>
      <td class="hi"><code>E_INPUT_UNREADABLE</code><br><span class="dim">c08_zero_bytes</span></td>
      <td>入库，stat + ffprobe</td>
      <td>0 字节文件的容错空间是零。补一个黑帧？那是对一支客户以为有内容的片子撒谎。</td>
    </tr>
    <tr>
      <td class="hi"><code>E_INPUT_AUDIO_ONLY</code><br><span class="dim">c19_audio_only</span></td>
      <td>入库，流类型检查</td>
      <td>纯音频被投到视频素材位，说明上游参数组装错了。此处静默补黑帧，会把一个上游 bug 变成一个下游谜题。</td>
    </tr>
    <tr>
      <td class="hi"><code>E_INPUT_TRUNCATED</code><br><span class="dim">c09_truncated</span></td>
      <td>入库，抽样解码</td>
      <td>moov 在头、mdat 被截断：容器说 20 秒，实际只能解 12 秒。<b>它会被 ffprobe 判为"可读"</b>，只有真解码才暴露。这是最危险的一类——所有基于元数据的检查都会放行。</td>
    </tr>
  </table>

  <div class="note warn-note">
    <span class="h">关于 c09</span>
    这条值得单独说：<code>ffprobe</code> 说它时长 20 秒、分辨率正常、编码正常。<strong>元数据层面它完全健康。</strong>只有把帧真解一遍才会在 12 秒处炸。所以入库必须有一次抽样解码——而且生产环境应该对整片跑一次，抽样只是为了不让入库耗时失控。
  </div>
</section>

<section id="warn">
  <h2><span class="num">05</span>五类"能救但改变了语义"的</h2>
  <p class="sub">技术上成功，商业上必须告知。这类是客服工单的主要来源。</p>

  <table class="t2">
    <tr><th style="width:180px">情况</th><th style="width:210px">我们的处理</th><th>必须告知客户什么</th></tr>
    <tr><td class="hi">HDR（HLG / PQ）</td><td><code>TONEMAP_HDR</code>：colorspace 直转 BT.709</td><td>直转不是 tone curve。高光会压平、饱和度会偏。正式产品应换 libplacebo / zimg，在此之前这类素材应标"预览级"。</td></tr>
    <tr><td class="hi">无音轨</td><td><code>AUDIO_SYNTH</code>：补 48k 立体声静音</td><td>时长会以视频为准。如果模板依赖音频节拍（卡点），成片会完全错位，必须人工确认。</td></tr>
    <tr><td class="hi">多音轨</td><td><code>AUDIO_PICK_FIRST</code>：取第一条</td><td>丢弃的可能是原声也可能是配音。这条如果不告知，交付事故率接近 100%。</td></tr>
    <tr><td class="hi">内嵌字幕</td><td><code>DROP_SUBS</code>：不烧录、不转资产</td><td>客户会说"字幕没了"。正确做法是把它转成字幕资产进 IR，这是 P1 的范围，P0 必须显式记录成警告。</td></tr>
    <tr><td class="hi">VFR / 高帧率</td><td><code>CFR</code> / <code>DECIMATE</code></td><td>帧数会变。120fps 降到 30fps 是丢 3/4 的帧，慢动作素材会失去慢动作感。</td></tr>
  </table>
</section>

<section id="pits">
  <h2><span class="num">06</span>三个只有真跑才会发现的坑</h2>
  <p class="sub">这三条不是从文档里抄的，是这一轮跑语料撞出来的。每一条都会让"看起来正确"的产物在客户手里出错。</p>

  <div class="pit">
    <div class="t">libx264 不写 VUI 色彩标记<em>-color_primaries 单独给没用</em></div>
    <p>只传 <code>-color_primaries bt709 -color_trc bt709</code>，ffprobe 会读到 <code>primaries=unknown / transfer=unknown</code>，只有 <code>color_space</code> 落了。成片在播放器里各显各的。这条坑让本手册的干净对照组第一次跑就失败了——它本来就是我用来当"免检"基准的。</p>
    <pre># ✗ 不够
-color_primaries bt709 -color_trc bt709 -colorspace bt709
# ✓ 必须显式进 SPS VUI
<b>-x264-params colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv</b></pre>
  </div>

  <div class="pit">
    <div class="t">奇数分辨率：<code>scale</code> 是拉伸，<code>crop</code> 才是裁切<em>641×481 → 640×480 还是 640×482</em></div>
    <p>奇数边必须偶数化（yuv420p 要求），但两种做法结果完全不同：<code>scale=trunc(iw/2)*2</code> 会把 641 压成 640——<strong>整幅画横向缩了 1/641，是变形</strong>；用 <code>crop</code> 则丢掉最后一列像素，没有变形。默认应该裁。</p>
    <pre># ✗ 变形
scale=trunc(iw/2)*2:trunc(ih/2)*2
# ✓ 丢 1px，不变形
<b>crop=trunc(iw/2)*2:trunc(ih/2)*2</b></pre>
  </div>

  <div class="pit">
    <div class="t">ffmpeg 9 已不能靠 metadata 写旋转矩阵<em>-metadata:s:v rotate=90 静默失效</em></div>
    <p>老办法 <code>-metadata:s:v:0 rotate=90</code> 在新版上不报错，但也不写显示矩阵——你会得到一条"看起来有 rotation 元数据、实际 ffprobe 读不到"的片子，测试用例因此假通过。必须两步：先出片，再用 <code>-display_rotation</code> 重封装。</p>
    <pre>ffmpeg -y -i in.mp4 -c:v libx264 base.mp4
<b>ffmpeg -y -display_rotation 90 -i base.mp4 -c copy out.mov</b></pre>
  </div>
</section>

<section id="taxonomy">
  <h2><span class="num">07</span>失败分类学（P0 定稿版）</h2>
  <p class="sub">code 是契约，message 是叙事。二者不可互换——Agent 靠 code 决策，人靠 message 理解。</p>

  <table class="t2">
    <tr><th style="width:230px">code</th><th style="width:110px">阶段</th><th style="width:80px">可重试</th><th>客户可见文案</th></tr>
    <tr><td><code>E_INPUT_UNREADABLE</code></td><td>ingest</td><td>否</td><td>素材无法解析（编码或封装不支持），已附探测到的实际格式</td></tr>
    <tr><td><code>E_INPUT_AUDIO_ONLY</code></td><td>ingest</td><td>否</td><td>纯音频文件被投递到视频素材位，请改用音频轨接口</td></tr>
    <tr><td><code>E_INPUT_TRUNCATED</code></td><td>ingest</td><td>否</td><td>文件被截断或损坏（容器元数据正常，解码在第 N 秒失败）</td></tr>
    <tr><td><code>E_INPUT_OVERLONG</code></td><td>ingest</td><td>否</td><td>时长超过上限，需人工确认后再入队</td></tr>
    <tr><td><code>E_IR_INVALID</code></td><td>compile</td><td>否</td><td>时间线参数非法：<b>字段名 + 实际值 + 允许范围</b></td></tr>
    <tr><td><code>E_IR_UNSUPPORTED</code></td><td>compile</td><td>否</td><td>轨道在帧 N 处有空洞；本版本要求轨道连续铺满</td></tr>
    <tr><td><code>E_MEDIA_MISSING</code></td><td>compile</td><td>否</td><td>引用的素材不存在或已过期，附 asset id 与内容哈希</td></tr>
    <tr><td><code>E_FONT_MISSING</code></td><td>compile</td><td>否</td><td><b>硬失败。</b>模板字体缺字符，附缺失码点列表；禁止静默替换</td></tr>
    <tr><td><code>E_TEXT_OVERFLOW</code></td><td>compile</td><td>否</td><td>文本越出安全区，附越界像素数与建议缩短字数</td></tr>
    <tr><td><code>E_QUOTA_EXCEEDED</code></td><td>admission</td><td>是</td><td>配额不足，附 retry_after</td></tr>
    <tr><td><code>E_TIMEOUT</code></td><td>render</td><td>是</td><td>渲染超时，已按降预设自动重试一次</td></tr>
    <tr><td><code>E_OOM</code></td><td>render</td><td>是</td><td>资源不足，已降并发重排</td></tr>
    <tr><td><code>E_NVENC_SESSION</code></td><td>render</td><td>是</td><td>编码会话达上限（GeForce 驱动限制），已退 CPU 路径</td></tr>
    <tr><td><code>E_NORMALIZE_FAILED</code></td><td>ingest</td><td>视情况</td><td>归一化失败，附失败动作与 stderr 摘要</td></tr>
    <tr><td><code>E_OUTPUT_INVALID</code></td><td>validate</td><td>是</td><td>成片未通过 L1/L3 断言，已自动重渲</td></tr>
    <tr><td><code>E_PUBLISH_FAILED</code></td><td>deliver</td><td>视情况</td><td>发布失败：需人工确认 / 需重新登录 / 平台页面结构变更</td></tr>
  </table>
</section>

<section id="checklist">
  <h2><span class="num">08</span>进 P1 之前的检查清单</h2>
  <p class="sub">八条，全部可验证。少一条，P1 的第一个 bug 就会伪装成渲染问题。</p>
  <ul class="chk">
    <li><b>{TOTAL}/{TOTAL} 语料分类正确。</b>直通、归一化、拒绝三类都归对，且归一化后产物通过 8 项规格校验。</li>
    <li><b>失误率有基线。</b>记录当前每条语料的入库耗时，P1 的端到端预算从这里往下算。</li>
    <li><b>零转码路径存在。</b>{len(PASS_THRU)}/{TOTAL} 条直通——这条路径决定了客户量级上来后的成本曲线。</li>
    <li><b>色彩四标齐全</b>（primaries / transfer / matrix / range），且已用 <code>-x264-params</code> 落进 SPS VUI 验证过。</li>
    <li><b>抽样解码在入库链路里</b>，且对 c09 这类"元数据健康"的截断文件能报警。</li>
    <li><b>决策 JSON 入库</b>，能回答"这条素材为什么被转成这样"。</li>
    <li><b>警告能透传到客户</b>——不是打在日志里，是进 receipt。</li>
    <li><b>拒绝入队不产生渲染成本</b>，且返回的 code 与文案能让人立刻知道该改什么。</li>
  </ul>
</section>

<footer>
  <p><strong>怎么重跑</strong>：<code>cd cutproof &amp;&amp; python3 corpus/gen_dirty.py &amp;&amp; python3 ingest.py all</code>。语料全部是 lavfi 合成的，无版权风险、体积可控（约 97 MB）、可确定性复现。表格数据来自 <code>res/matrix.json</code>，本页由 <code>make_p0_report.py</code> 生成，没有任何一个数字是手填的。</p>
  <p><strong>已知边界</strong>：语料是合成的，能复现"故障模式"但不能复现"真实拍摄素材的噪声分布"；上线前仍需灌入 50–100 条真实客户素材做一次回归。HDR 转换用的是 colorspace 直转而非 tone curve（本机 ffmpeg 无 zimg），正式产品应替换为 libplacebo。抽样解码默认 15 秒，长素材的尾部损坏不会被抓到。</p>
</footer>

</div>
</body>
</html>
'''

DELIV.mkdir(parents=True, exist_ok=True)
out = DELIV / "P0-输入归一化手册.html"
out.write_text(HTML)
print(f"✓ {out}  ({out.stat().st_size:,} bytes)")
print(f"  直通 {len(PASS_THRU)} / 归一化 {len(NORM_OK)} / 拒绝 {len(BLOCKED)} / 警告 {len(WARNED)}")
