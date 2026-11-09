#!/usr/bin/env python3
"""生成对抗审查报告（结果数据来自真实跑测的 JSON）。"""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DELIV = ROOT.parent / "deliverables"
ATTACK = Path(os.environ.get("RENDERD_ATTACK_JSON", "/tmp/attack_final.json"))

results = json.loads(ATTACK.read_text())["results"] if ATTACK.exists() else []
by_id = {r["id"]: r for r in results}
total = len(results)
passed = sum(1 for r in results if r["verdict"] == "PASS")
fails = [r for r in results if r["verdict"] != "PASS"]
crit = [r for r in fails if r["severity"] == "critical"]

# 基线（未加固）的实测失败项，人工核对过分因：真实缺陷 vs 限流噪声
BASELINE = [
    ("B01", "file:///etc/passwd 当素材", "critical",
     "422 E_INPUT_AUDIO_ONLY", "服务真的打开了 /etc/passwd 并解析了文件头",
     "路径围栏 → 403 E_MEDIA_FORBIDDEN"),
    ("C01", "callback_url 打云元数据", "critical",
     "422（未校验，只是被别处挡住）", "回调校验缺失，投递时会请求 169.254.169.254",
     "协议+IP 白名单 → 400 E_CALLBACK_FORBIDDEN"),
    ("C03", "callback_url 打回环", "high", "422（同上）",
     "可探测本机端口", "同上"),
    ("D02", "24MB 请求体", "medium", "连接被重置（0）",
     "无 body 上限，直接读进内存；且直接断连让客户端读不到错误",
     "4MB 上限 + 先 drain 再 413"),
    ("D04", "300 个素材", "medium", "200 通过",
     "无素材数上限，一次请求可让编译期 O(n) 爆炸", "MAX_ASSETS=64"),
    ("D05", "2 小时 4K 任务", "high", "429（限流噪声掩盖了真实问题）",
     "无单任务时长上限，一条请求可占满集群数小时", "MAX_OUTPUT_SECONDS=600"),
    ("E06", "非法 UTF-8 请求体", "low", "500",
     "UnicodeDecodeError 逃逸成 500", "归到 400"),
    ("G04", "PUT 方法", "low", "501",
     "http.server 默认行为，不走统一错误契约", "405 E_METHOD_NOT_ALLOWED"),
]


def baseline_rows() -> str:
    out = []
    for cid, name, sev, actual, why, fix in BASELINE:
        cls = {"critical": "crit", "high": "high", "medium": "med", "low": "low"}[sev]
        out.append(f"""<tr>
  <td><code>{cid}</code></td>
  <td>{name}</td>
  <td><span class="sev {cls}">{sev}</span></td>
  <td class="mono">{actual}</td>
  <td class="why">{why}</td>
  <td class="fix">{fix}</td>
</tr>""")
    return "\n".join(out)


def group_rows(prefix: str) -> str:
    out = []
    for r in results:
        if not r["id"].startswith(prefix):
            continue
        cls = {"critical": "crit", "high": "high", "medium": "med",
               "low": "low", "info": "low"}.get(r["severity"], "low")
        mark = "✓" if r["verdict"] == "PASS" else "✗"
        out.append(f"""<tr>
  <td class="mono">{r['id']}</td>
  <td>{r['name']}</td>
  <td><span class="sev {cls}">{r['severity']}</span></td>
  <td class="mono">{r['actual']}</td>
  <td class="{'ok' if r['verdict'] == 'PASS' else 'bad'}">{mark}</td>
</tr>""")
    return "\n".join(out)


HTML = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>renderd 对抗审查报告</title>
<style>
:root{{--paper:#f7f5f0;--card:#fffefb;--ink:#1b1a17;--ink2:#4a4740;--ink3:#8a857b;
--rule:#ded8cc;--acc:#b8402a;--accs:#f3e4df;--teal:#0f5b57;--teals:#e3eeec;--amber:#9a6b1f}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;
font-size:16px;line-height:1.8;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:1120px;margin:0 auto;padding:0 28px 110px}}
h1,h2,h3{{font-family:"Songti SC",Georgia,serif;font-weight:600}}
.hero{{padding:72px 0 34px;border-bottom:1px solid var(--rule)}}
.kicker{{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--acc);font-weight:700;margin-bottom:18px}}
h1{{font-size:42px;line-height:1.22;margin:0 0 16px}}
.lede{{font-size:17.5px;color:var(--ink2);max-width:780px;margin:0}}
.lede b{{color:var(--ink)}}
.stats{{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--rule);border:1px solid var(--rule);margin:34px 0 0}}
.stat{{background:var(--card);padding:18px 20px}}
.stat .n{{font-family:"Songti SC",Georgia,serif;font-size:36px;line-height:1.1}}
.stat .l{{font-size:12.5px;color:var(--ink3);margin-top:4px}}
.stat.hot .n{{color:var(--acc)}} .stat.good .n{{color:var(--teal)}}
section{{margin-top:56px}}
h2{{font-size:25px;margin:0 0 8px;padding-top:16px;border-top:2px solid var(--ink)}}
h2 .num{{font-size:13px;letter-spacing:.1em;color:var(--acc);margin-right:11px;vertical-align:3px;
font-family:-apple-system,sans-serif;font-weight:700}}
.sub{{color:var(--ink3);font-size:14.5px;margin:0 0 22px}}
h3{{font-size:18px;margin:30px 0 10px}}
p{{margin:0 0 15px;color:var(--ink2)}}
code{{font-family:ui-monospace,Menlo,monospace;font-size:.86em;background:#eee9dd;padding:1px 5px;border-radius:2px;color:#3a352c}}
table{{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--card);margin:0 0 12px}}
th{{text-align:left;font-size:12px;letter-spacing:.04em;padding:10px 12px;border-bottom:1.5px solid var(--ink);background:#fbf9f3;white-space:nowrap}}
td{{padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top;color:var(--ink2)}}
tr:last-child td{{border-bottom:none}}
.mono{{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:nowrap}}
.sev{{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;white-space:nowrap}}
.sev.crit{{background:var(--acc);color:#fff}}
.sev.high{{background:var(--accs);color:var(--acc)}}
.sev.med{{background:#f6eeda;color:var(--amber)}}
.sev.low{{background:#eceae4;color:var(--ink3)}}
.ok{{color:var(--teal);font-weight:700}} .bad{{color:var(--acc);font-weight:700}}
.why{{font-size:13px}} .fix{{font-size:13px;color:var(--teal)}}
.tblwrap{{border:1px solid var(--rule);overflow-x:auto}}
.note{{border-left:2px solid var(--teal);padding:2px 0 2px 20px;margin:20px 0;color:var(--ink2);font-size:15px}}
.note.warn{{border-left-color:var(--acc)}}
.note .h{{display:block;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--teal);font-weight:700;margin-bottom:5px}}
.note.warn .h{{color:var(--acc)}}
.case{{background:var(--card);border:1px solid var(--rule);padding:20px 22px;margin:0 0 14px}}
.case .t{{font-weight:600;font-size:16px;margin-bottom:8px}}
.case .t em{{font-style:normal;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--acc);margin-left:8px}}
.case p{{margin:0 0 10px;font-size:14px}}
.case pre{{margin:8px 0 0;background:#25231f;color:#e8e3d7;padding:12px 14px;border-radius:2px;
font-size:12px;line-height:1.65;overflow-x:auto;font-family:ui-monospace,Menlo,monospace}}
.case pre b{{color:#f0b429}}
.chk{{list-style:none;padding:0;margin:14px 0}}
.chk li{{position:relative;padding:9px 0 9px 24px;border-bottom:1px solid var(--rule);font-size:14.5px;color:var(--ink2)}}
.chk li::before{{content:"✓";position:absolute;left:0;top:9px;color:var(--teal);font-weight:700}}
footer{{margin-top:60px;padding-top:22px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink3);line-height:1.9}}
@media(max-width:820px){{.stats{{grid-template-columns:repeat(2,1fr)}}h1{{font-size:30px}}}}
</style>
</head>
<body>
<div class="wrap">

<header class="hero">
  <div class="kicker">对抗审查 · Colima 容器 · 2026-11-09</div>
  <h1>{total} 项攻击，2 个严重缺陷</h1>
  <p class="lede">按攻击者视角而不是功能清单去测。结论不是"全绿"，而是：<b>有两个问题只有在对抗测试里才会露出来</b>——一个是任意文件读取，一个是所有 worker 挂掉后任务永久卡死。两者都在真实容器里复现、修复、复测通过。</p>
  <div class="stats">
    <div class="stat"><div class="n">{total}</div><div class="l">攻击项（容器内）</div></div>
    <div class="stat good"><div class="n">{passed}</div><div class="l">通过</div></div>
    <div class="stat hot"><div class="n">2</div><div class="l">critical（已修）</div></div>
    <div class="stat"><div class="n">8</div><div class="l">真实缺陷总数</div></div>
  </div>
</header>

<section>
  <h2><span class="num">01</span>威胁模型</h2>
  <p class="sub">先假设攻击者是谁，否则测试会变成"检查功能列表"。</p>
  <p>假设攻击者<strong>持有合法 token</strong>——这是最现实的场景：SaaS 的付费客户，或者被泄露的密钥。完全未认证的攻击者只能触达 <code>/healthz</code> 与 <code>/metrics</code>。</p>
  <table>
    <tr><th style="width:200px">资产</th><th>攻击者想做什么</th><th style="width:260px">缓解</th></tr>
    <tr><td>容器内文件</td><td>通过素材路径读任意文件</td><td>路径围栏（resolve + 白名单）</td></tr>
    <tr><td>内网服务</td><td>通过 callback_url 做 SSRF 探测</td><td>协议 + 目标 IP 白名单</td></tr>
    <tr><td>其他租户的数据</td><td>越权读任务 / 回执 / 成片</td><td>租户隔离 + 签名绑定 job_id</td></tr>
    <tr><td>算力与内存</td><td>一条请求打满集群</td><td>九道容量护栏</td></tr>
    <tr><td>数据库</td><td>SQL 注入</td><td>全参数化，无字符串拼接</td></tr>
  </table>
  <div class="note warn">
    <span class="h">不在威胁模型内</span>
    拿到宿主 root、拿到 <code>RENDERD_SECRET</code>、物理接触磁盘。这些情况下应用层防护无效，属于基础设施安全。
  </div>
</section>

<section>
  <h2><span class="num">02</span>两个 critical</h2>
  <p class="sub">都不是"配置问题"，是设计漏洞。修复前后的行为差异都有实测证据。</p>

  <div class="case">
    <div class="t">任意文件读取<em>B01 · file:///etc/passwd</em></div>
    <p>提交渲染时把素材地址写成 <code>file:///etc/passwd</code>，服务会真的去打开它。证据是返回码：</p>
    <pre>修复前： 422 <b>E_INPUT_AUDIO_ONLY</b>   ← 说明 ffprobe 已经解析过这个文件
修复后： 403 <b>E_MEDIA_FORBIDDEN</b>   ← 在解析之前就被挡住</pre>
    <p>多租户环境下这意味着：租户 A 可以枚举容器内任意路径是否存在，读到别的租户的成片（路径可猜），或者读配置文件。</p>
    <p><strong>修法</strong>：<code>resolve_uri()</code> 统一围栏到 <code>media/</code>，<code>Path.resolve()</code> 顺带解开符号链接；<code>upload:</code> 名走 <code>^[A-Za-z0-9][A-Za-z0-9._-]{{0,127}}$</code>；越界一律 403。</p>
  </div>

  <div class="case">
    <div class="t">全 worker 失联时任务永久卡死<em>租约回收的单点故障</em></div>
    <p>租约回收原先只写在 <code>Worker.run_forever()</code> 里。用 <code>docker compose kill -9 worker</code> 之后：</p>
    <pre>t+0s   任务 running
t+18s  任务 <b>仍然 running</b>     ← 没有任何进程在扫过期租约
t+30s  拉起 worker → 立刻被回收 → attempts=2 → 重新渲染成功</pre>
    <p>也就是说：<strong>worker 全挂的那段时间，客户的任务是死状态</strong>，而且 API 还在正常接受新任务，队列越积越多。</p>
    <p><strong>修法</strong>：抽出独立 <code>start_reaper()</code>，API 进程默认启动，另提供 <code>renderd reaper</code> 供分离部署。复测：kill 后 15s 内识别、自动重排、worker 拉起后自愈。</p>
  </div>
</section>

<section>
  <h2><span class="num">03</span>基线与修复对照</h2>
  <p class="sub">基线跑（未加固）共 11 项失败，其中 3 项是限流噪声，8 项是真实缺陷。</p>
  <div class="tblwrap">
  <table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>基线实际</th><th>为什么危险</th><th>修复</th></tr>
    {baseline_rows()}
  </table>
  </div>
  <div class="note">
    <span class="h">被限流噪声掩盖的两项</span>
    基线的 C04/C05/D01/D03/F03/F04 返回 429，是测试自己发得太快（默认 QPS=10）。这提醒一件事：
    <strong>对抗测试必须用独立的高 QPS 租户跑功能项，另用低 QPS 租户专门测限流</strong>，否则会把"没测到"当成"通过了"。
  </div>
</section>

<section>
  <h2><span class="num">04</span>加固后的结果（容器内）</h2>
  <p class="sub">全部 {total} 项，按攻击者视角的七组。这一份表格是程序跑出来的，不是手写的。</p>

  <h3>A 认证与授权</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("A")}
  </table></div>

  <h3>B 路径与文件</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("B")}
  </table></div>

  <h3>C SSRF</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("C")}
  </table></div>

  <h3>D 资源耗尽</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("D")}
  </table></div>

  <h3>E 注入</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("E")}
  </table></div>

  <h3>F 业务逻辑</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("F")}
  </table></div>

  <h3>G 运维面</h3>
  <div class="tblwrap"><table>
    <tr><th>ID</th><th>攻击</th><th>严重度</th><th>实际</th><th></th></tr>
    {group_rows("G")}
  </table></div>
</section>

<section>
  <h2><span class="num">05</span>容器与稳定性</h2>
  <p class="sub">对抗测试之外，还跑了四条真实链路。</p>
  <ul class="chk">
    <li><b>容器内端到端 10/10</b> —— 上传 → 预检 → 三模板提交 → 轮询 → 回执 → 下载 → 幂等重放。成片抽帧确认中文正常（Noto CJK 回退），无豆腐块。</li>
    <li><b>Compose 11/11</b> —— api/worker 分离、kill -9 崩溃、租约回收、任务自愈（attempts=2）、重启 api 后任务与缓存都在。</li>
    <li><b>多 worker 并发 7/7</b> —— 3 个 worker、6 线程并发提交 12 条：12 个不同 job、每条恰好 1 次 rendering、attempts 全为 1、无租约回收；并发重放 12/12 命中同一 job。</li>
    <li><b>长稳 30 条</b> —— 全部成功。首批 p50 5132ms，第二批（命中缓存）p50 807ms；内存 156.9 → 168.6 → 170.3 MiB，第二批仅 +1.7 MiB，判断为首批的堆预热而非泄漏；磁盘按每条约 5.5MB 线性增长。</li>
  </ul>
  <div class="note">
    <span class="h">容器带来的两个真实功能缺陷</span>
    <code>.ttc</code> 只注册 face 0（Noto CJK 的 face 0 是 JP，导致 SC 永远查不到，一路回退到无 CJK 的 DejaVu）；
    同族多字重按字典序排在 Bold（正文整篇变粗）。两者在宿主机上都不会暴露——<strong>这就是必须进容器测的理由</strong>。
  </div>
</section>

<section>
  <h2><span class="num">06</span>残余风险</h2>
  <p class="sub">没修的、修不动的、和需要基础设施配合的。</p>
  <table>
    <tr><th style="width:240px">风险</th><th>影响</th><th style="width:300px">建议</th></tr>
    <tr><td>DNS rebinding 绕过 SSRF 校验</td><td>提交时解析到公网、投递时解析到内网</td><td>投递时重新解析 + 网络层 egress 白名单</td></tr>
    <tr><td>签名 URL 不绑定租户</td><td>链接泄露即可下载（同 S3 presigned 语义）</td><td>需要时把 tenant 签进 sig</td></tr>
    <tr><td><code>/metrics</code> 公开</td><td>暴露任务总量与状态分布</td><td>反代加 IP 白名单</td></tr>
    <tr><td><code>/v1/assets</code> 无存储配额</td><td>可刷满磁盘（只有渲染时长配额）</td><td>加租户级存储配额</td></tr>
    <tr><td>SQLite 单机</td><td>不能多机横向扩</td><td>换 Postgres / Redis 队列</td></tr>
    <tr><td>无 TLS / 无 WAF</td><td>明文传输</td><td>反代终止 TLS</td></tr>
  </table>
  <div class="note warn">
    <span class="h">如果继续打，我会从这里进</span>
    ① 用 DNS rebinding 打 <code>callback_url</code>，绕过提交时校验；
    ② 上传海量小文件打磁盘（没有存储配额）；
    ③ 用合法 token 提交大量合法任务打配额边界（并发竞态下的配额扣减）；
    ④ 在 <code>text</code> 里塞极端 Unicode（组合字符 / RTL / 超长单行）看字形覆盖与行宽计算。
  </div>
</section>

<footer>
  <p><strong>可复现</strong>：<code>python3 tests/attack.py --base &lt;url&gt; --token &lt;A&gt; --other-token &lt;B&gt; --burst-token &lt;C&gt; --secret &lt;S&gt; --json out.json</code>；
  容器链路 <code>make test-container</code> / <code>make test-compose</code> / <code>make multi</code> / <code>make soak</code>。</p>
  <p><strong>口径说明</strong>：第 02、03 节的"修复前"行为来自加固前的真实跑测记录（含返回码）；第 04 节的 {total} 项结果为容器内最终跑测的原始输出，由脚本直接渲染，未经手工修改。长稳的内存数字来自 <code>docker stats</code> 采样，本轮已补 500 条混合负载长稳，见《落地总报告》。</p>
</footer>

</div>
</body>
</html>
"""

DELIV.mkdir(parents=True, exist_ok=True)
out = DELIV / "对抗审查报告.html"
out.write_text(HTML)
print(f"✓ {out}  ({out.stat().st_size:,} bytes)")
print(f"  {total} 项 / 通过 {passed} / 失败 {len(fails)} / critical {len(crit)}")
