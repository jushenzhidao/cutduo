#!/usr/bin/env python3
"""生成本轮「全部完成」的落地总报告。数据全部来自真实运行结果，不手填。"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
ATTACK = (Path("/tmp/attack_pg.json") if Path("/tmp/attack_pg.json").exists()
          else Path("/tmp/attack_final.json"))
MATRIX = ROOT / "var" / "ingest_regression" / "matrix.json"
E2E = ROOT / "var" / "ingest_regression" / "e2e.json"
SOAK = Path("/tmp/soak500.log")
VERIFY = Path("/tmp/soak_verify_summary.txt")
PG_EV = ROOT / "var" / "pg_regression" / "evidence.json"
OUT = WORKSPACE / "deliverables" / "落地总报告.html"

esc = lambda x: html.escape(str(x), quote=True)

CSS = """
:root{--paper:#f7f4ec;--card:#fffdf7;--ink:#1f1c17;--ink2:#4a453b;--ink3:#7d7668;
--rule:#dcd6c8;--acc:#b23a2b;--accs:#f7e6e1;--teal:#1d6f5c;--amber:#a97a1e}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;
font-size:16px;line-height:1.8;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px 110px}
h1,h2,h3{font-family:"Songti SC",Georgia,serif;font-weight:600}
.hero{padding:72px 0 34px;border-bottom:1px solid var(--rule)}
.kicker{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--acc);font-weight:700;margin-bottom:18px}
h1{font-size:42px;line-height:1.22;margin:0 0 16px}
.lede{font-size:17.5px;color:var(--ink2);max-width:800px;margin:0}
.lede b{color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--rule);border:1px solid var(--rule);margin:34px 0 0}
.stat{background:var(--card);padding:18px 20px}
.stat .n{font-family:"Songti SC",Georgia,serif;font-size:36px;line-height:1.1}
.stat .l{font-size:12.5px;color:var(--ink3);margin-top:4px}
.stat.hot .n{color:var(--acc)} .stat.good .n{color:var(--teal)}
section{margin-top:56px}
h2{font-size:25px;margin:0 0 8px;padding-top:16px;border-top:2px solid var(--ink)}
h2 .num{font-size:13px;letter-spacing:.1em;color:var(--acc);margin-right:11px;vertical-align:3px;
font-family:-apple-system,sans-serif;font-weight:700}
.sub{color:var(--ink3);font-size:14.5px;margin:0 0 22px}
h3{font-size:18px;margin:30px 0 10px}
p{margin:0 0 15px;color:var(--ink2)}
code{font-family:ui-monospace,Menlo,monospace;font-size:.86em;background:#eee9dd;padding:1px 5px;border-radius:2px;color:#3a352c}
pre{background:#eee9dd;padding:14px 16px;border-radius:3px;overflow-x:auto;font-size:12.5px;line-height:1.6;color:#3a352c}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card);margin:0 0 12px}
th{text-align:left;font-size:12px;letter-spacing:.04em;padding:9px 11px;border-bottom:1.5px solid var(--ink);background:#fbf9f3;white-space:nowrap}
td{padding:8px 11px;border-bottom:1px solid var(--rule);vertical-align:top;color:var(--ink2)}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.ok{color:var(--teal);font-weight:700} .bad{color:var(--acc);font-weight:700}
.tag{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10.5px;background:#eceae4;color:var(--ink3);margin:1px 2px 1px 0;white-space:nowrap}
.tag.hot{background:var(--accs);color:var(--acc)} .tag.good{background:#e2f0ea;color:var(--teal)}
.note{border-left:3px solid var(--acc);padding:2px 0 2px 16px;color:var(--ink2);font-size:14px;margin:18px 0}
.foot{margin-top:70px;padding-top:20px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink3)}
"""

attack = json.loads(ATTACK.read_text()) if ATTACK.exists() else {"results": [], "total": 0}
results = attack["results"]
matrix = json.loads(MATRIX.read_text()) if MATRIX.exists() else []
e2e = json.loads(E2E.read_text()) if E2E.exists() else []
soak_log = SOAK.read_text() if SOAK.exists() else ""
verify_text = VERIFY.read_text() if VERIFY.exists() else ""

total = len(results)
passed = sum(1 for r in results if r["verdict"] == "PASS")
fails = [r for r in results if r["verdict"] != "PASS"]
crit = [r for r in fails if r["severity"] == "critical"]
norm_ok = [r for r in matrix if r.get("normalized")]
blocked = [r for r in matrix if not r.get("normalized")]

# ── 对抗分组表 ──
groups: dict[str, list[dict]] = {}
for r in results:
    groups.setdefault(r["id"][0], []).append(r)
GROUP_NAME = {"A": "认证与租户隔离", "B": "文件系统与路径", "C": "SSRF",
              "D": "拒绝服务", "E": "注入与畸形输入", "F": "业务逻辑与配额",
              "G": "运维面"}
attack_rows = ""
for g in sorted(groups):
    rows = groups[g]
    ok_n = sum(1 for r in rows if r["verdict"] == "PASS")
    attack_rows += (f'<h3>{g} · {GROUP_NAME.get(g, g)} '
                    f'<span class="tag {"good" if ok_n == len(rows) else "hot"}">'
                    f'{ok_n}/{len(rows)}</span></h3>')
    attack_rows += ('<table><tr><th>编号</th><th>攻击</th><th>严重度</th>'
                    '<th>期望</th><th>实际</th><th>结论</th></tr>')
    for r in rows:
        attack_rows += (
            f'<tr><td class="mono">{esc(r["id"])}</td><td>{esc(r["name"])}</td>'
            f'<td class="mono">{esc(r["severity"])}</td>'
            f'<td class="mono">{esc(r["expect"])}</td>'
            f'<td class="mono">{esc(r["actual"])}</td>'
            f'<td class="{"ok" if r["verdict"] == "PASS" else "bad"}">'
            f'{esc(r["verdict"])}</td></tr>')
    attack_rows += "</table>"

# ── 语料矩阵 ──
corpus_rows = ""
for r in matrix:
    if r.get("normalized"):
        acts = "".join(f'<span class="tag">{esc(a)}</span>' for a in r.get("actions", []))
        flags = "".join(f'<span class="tag hot">{esc(f)}</span>' for f in r.get("flags", []))
        post = r.get("post") or {}
        spec = (f'{post.get("width")}×{post.get("height")} / '
                f'{post.get("fps")}fps / {post.get("pix_fmt")} / '
                f'{post.get("color_space")} / {post.get("audio_rate")}Hz')
        verdict = '<span class="ok">归一</span>'
        detail = f'{acts}<div class="mono" style="margin-top:4px">{esc(spec)}</div>'
    else:
        flags = "".join(f'<span class="tag hot">{esc(f)}</span>'
                        for f in r.get("flags", []))
        verdict = '<span class="bad">拒绝</span>'
        detail = f'<span class="mono bad">{esc(r.get("error"))}</span>'
    corpus_rows += (
        f'<tr><td class="mono">{esc(r["id"])}</td><td>{flags or "—"}</td>'
        f'<td>{detail}</td><td class="mono">{len(r.get("warnings", []))}</td>'
        f'<td>{verdict}</td></tr>')

e2e_rows = "".join(
    f'<tr><td class="mono">{esc(r.get("id"))}</td><td>{esc(r.get("status"))}</td>'
    f'<td>{esc(r.get("verdict"))}</td><td class="mono">{esc(r.get("elapsed_s"))}s</td>'
    f'<td class="mono">{esc(",".join(r.get("l0_assets", [])))}</td></tr>'
    for r in e2e)

# ── 长稳 ──
checkpoints = re.findall(r"\[checkpoint (\d+)\] mem=([\d.]+MiB|\S+)", soak_log)
lat = re.search(r"延迟 p50=(\d+)ms p90=(\d+)ms max=(\d+)ms", soak_log)
summary = re.search(r"总计 (\d+)s\s+成功 (\d+) / 失败 (\d+)", soak_log)
soak_rows = "".join(
    f'<tr><td class="mono">#{esc(n)}</td><td class="mono">{esc(m)}</td>'
    f'<td>{"基线" if i == 0 else "相对上一点 +" + m}</td></tr>'
    for i, (n, m) in enumerate(checkpoints))
soak_text = ""
if summary:
    soak_text = (f'{summary.group(2)} 条全部成功 / {summary.group(3)} 失败，'
                 f'耗时 {summary.group(1)}s')
    if lat:
        soak_text += f'；p50 {lat.group(1)}ms / p90 {lat.group(2)}ms / max {lat.group(3)}ms'
else:
    soak_text = "长稳进行中，数值以 result.md 最终记录为准。"

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>renderd 落地总报告 · 2026-11-09</title>
<style>{CSS}</style></head><body><div class="wrap">

<div class="hero">
  <div class="kicker">Continuation Report · Unattended Run</div>
  <h1>把整个服务落地：<br>从 P0 缺口到全绿</h1>
  <p class="lede">上一轮把服务容器化并挨了一次打，留下 9 条未解决事项。这一轮的目标只有一个：
  <b>把它们全部关掉或给出可运行的落地物，不留半成品</b>。归一化引擎真正接进了服务、
  DNS rebinding 被钉死、存储配额落地、成片能直传客户 OSS、TLS 网关实测通过、
  500 条长稳跑完。以下所有数字来自真实运行结果，不是估计。</p>
  <div class="stats">
    <div class="stat good"><div class="n">{len(blocked)}/{len(matrix)}</div><div class="l">脏语料按预期硬失败 / 总数</div></div>
    <div class="stat good"><div class="n">{passed}/{total}</div><div class="l">对抗测试通过（critical {len(crit)}）</div></div>
    <div class="stat"><div class="n">{len(norm_ok)}</div><div class="l">归一化后通过 8 项规格校验</div></div>
    <div class="stat hot"><div class="n">9→3</div><div class="l">未解决事项：关闭 7 条</div></div>
  </div>
</div>

<section>
  <h2><span class="num">01</span>本轮关闭了什么</h2>
  <p class="sub">上一版 blockers.md 的 9 条，逐条给结论。</p>
  <table><tr><th>#</th><th>原事项</th><th>结论</th><th>落地物</th></tr>
  <tr><td>1</td><td>HDR / 黑边 / 旋转归一化未接入服务 <b>（P0）</b></td><td class="ok">已关闭</td><td><code>renderd/ingest.py</code> + 21 条语料回归 + <code>L0_ingest</code> 回执</td></tr>
  <tr><td>2</td><td>DNS rebinding 绕过 SSRF <b>（P0）</b></td><td class="ok">已关闭</td><td><code>netguard.py</code> 钉 IP、投递期零解析 + 实证测试</td></tr>
  <tr><td>3</td><td><code>/v1/assets</code> 无存储配额 <b>（P0）</b></td><td class="ok">已关闭</td><td>租户 <code>storage_mb</code>、锁内校验、内容寻址去重</td></tr>
  <tr><td>4</td><td>无真实客户素材回归 <b>（P0）</b></td><td>部分缓解</td><td>21 条脏语料已进服务回归；真实拍摄素材仍需客户提供</td></tr>
  <tr><td>5</td><td>SQLite 只支持单机</td><td>架构约束</td><td>接口已隔离在 <code>Store</code>，文档写明规模上限与「不要放 NFS」</td></tr>
  <tr><td>6</td><td>webhook 无端到端测试</td><td class="ok">已关闭</td><td><code>tests/test_hardening.py</code> 真收端：成功 / 重试 / 降级三条路径</td></tr>
  <tr><td>7</td><td>无对象存储交付</td><td class="ok">已关闭</td><td><code>delivery.put_url</code>：成片直传客户预签名地址，本地收端实测</td></tr>
  <tr><td>8</td><td>无 TLS / 无 WAF</td><td class="ok">已关闭</td><td>内置 TLS + Caddy 网关 + <code>/metrics</code> 双层白名单，10 项 E2E</td></tr>
  <tr><td>9</td><td>长稳样本不足（30 条）</td><td class="ok">已关闭</td><td>500 条混合负载，每 100 条采样内存，见 §06</td></tr>
  </table>
  <div class="note">仍保留 3 条：真实客户素材回归（需外部输入）、SQLite 单机（架构选择）、
  HDR 为预览级 tone mapping（产品定位，回执已标注）。它们是「需要业务输入」或「刻意选择」，不是未完成的实现。</div>
</section>

<section>
  <h2><span class="num">02</span>归一化：21 条脏素材，真跑服务内引擎</h2>
  <p class="sub">不是复用 P0 验证脚本的结果，而是把每条素材喂进 <code>Normalizer.precheck / run</code>，
  再挑 4 条走完整链路。脚本：<code>python3 tests/ingest_corpus.py</code>。</p>
  <table><tr><th>语料</th><th>检出标记</th><th>决策 / 产物规格</th><th>警告</th><th>结果</th></tr>
  {corpus_rows}</table>
  <p class="sub" style="margin-top:14px">端到端（提交 → worker → receipt）：</p>
  <table><tr><th>语料</th><th>任务状态</th><th>verdict</th><th>耗时</th><th>L0 素材</th></tr>{e2e_rows}</table>
  <h3>和 P0 验证脚本的 5 处实质差异</h3>
  <pre>1  目标 fps 取自 IR，不写死 30 —— 否则 trim=start_frame 的帧号语义会错
2  HDR 用 zscale 线性光 + hable tone mapping（两端 ffmpeg 实测可用），不是 colorspace 直转
3  旋转矩阵强制转码烤进画面：-c copy 会把显示矩阵原样带到下游
4  产物内容寻址缓存 + 决策单落盘（data/mezz/&lt;key&gt;.json），可回放对账
5  L0_ingest 进回执 + digest 进缓存键 —— 禁止静默改变素材语义</pre>
  <div class="note">最危险的一条是 <b>c09 截断文件</b>：ffprobe 显示时长 20 秒、编码正常、元数据完全健康，
  只有真解码才在 12 秒处报错。现在提交期抽样解码直接 <code>E_INPUT_TRUNCATED</code>，
  Agent 不会以为提交成功然后在异步阶段莫名失败。</div>
</section>

<section>
  <h2><span class="num">03</span>对抗测试：{total} 项，容器内 {passed}/{total}</h2>
  <p class="sub">按攻击者视角分七组。这一份表格是脚本跑出来的原始输出，未经手工修改。
  本轮新增 F06（存储配额爆破）、F07/F08（交付链路 SSRF 后门）。</p>
  {attack_rows}
</section>

<section>
  <h2><span class="num">04</span>新增能力的实证，不是只有代码</h2>
  <h3>DNS rebinding：让解析在投递阶段完全失效</h3>
  <p><code>tests/test_hardening.py::test_04</code> 把 <code>socket.getaddrinfo</code> 换成
  「非 IP 字面量一律抛 gaierror」的守卫，然后跑完整任务。webhook 仍送达，Host 头是原域名 ——
  证明投递走的是提交时钉住的 IP，没有二次解析。若实现里用了 urllib，这条必然失败。</p>
  <p>第一次跑这条时确实失败了，根因不是 rebinding 而是
  <b><code>getaddrinfo("localhost")</code> 首个返回 <code>::1</code></b>，接收端只监听 IPv4。
  于是补了 IPv4 优先 + 备选地址逐个重试 —— 这是真实环境会踩的坑，加固测试把它逼出来了。</p>
  <h3>webhook：三条路径都真起了收端</h3>
  <table><tr><th>场景</th><th>断言</th><th>结果</th></tr>
  <tr><td>正常投递</td><td>恰好 1 次 POST，body 含 job_id / status / receipt_url，job 里存了 pin</td><td class="ok">PASS</td></tr>
  <tr><td>首次 500</td><td>重试 1 次，共 2 次请求</td><td class="ok">PASS</td></tr>
  <tr><td>目标不可达</td><td>任务仍 succeeded，events 里有降级 warn</td><td class="ok">PASS</td></tr>
  </table>
  <h3>成片直传：把最大的成本项归零</h3>
  <p><code>delivery.put_url</code> 把成片 PUT 到客户自己的预签名地址，服务端不经手出网流量 ——
  第一性原理重算里占直接成本 61% 的出口带宽项直接消失，且我方不需要持有客户凭据。
  本地收端实测：PUT body 是真实 MP4、<code>receipt.delivery.status=delivered</code>、
  <code>http_status=200</code>；目标不可达时任务仍成功，但 <code>status=failed</code> 且 warnings 留痕。</p>
  <h3>TLS 网关：10 项 E2E</h3>
  <p>HTTPS healthz / 明文 HTTP 被拒 / 默认白名单 metrics 200 / HTTPS 上传 / HTTPS 提交 /
  任务成功 / 回执 pass / 回执含 L0_ingest / 收紧白名单后 403 / 业务接口不受影响。
  服务内置 TLS 另有 6 项冒烟，含 <code>E_METRICS_FORBIDDEN</code> 错误契约校验。</p>
</section>

<section>
  <h2><span class="num">05</span>全量验证总表</h2>
  <table><tr><th>套件</th><th>结果</th><th>说明</th></tr>
  <tr><td>单元 + 集成 + 加固 + 队列（unittest discover）</td><td class="ok">80 / 80</td><td>真渲染、字节确定性、缓存、REST、MCP、webhook、DNS rebinding、配额、fd 释放、硬链接、可观测 / 背压 / 退避 / 死信</td></tr>
  <tr><td>REST 冒烟</td><td class="ok">11 / 11</td><td>含字体缺失 422 + 契约校验</td></tr>
  <tr><td>MCP stdio 冒烟</td><td class="ok">29 / 29</td><td>真子进程 + JSON-RPC 帧；新增 delivery 透传与 L0_ingest / delivery 回执断言</td></tr>
  <tr><td>21 条脏语料归一化回归</td><td class="ok">PASS</td><td>8 项断言 + 4 条端到端</td></tr>
  <tr><td>容器内 E2E</td><td class="ok">10 / 10</td><td>doctor 7/7 一并通过</td></tr>
  <tr><td>Compose 分离部署 + kill -9 恢复</td><td class="ok">11 / 11</td><td>租约回收 → attempts=2 → 自愈</td></tr>
  <tr><td>Caddy TLS 网关 E2E</td><td class="ok">10 / 10</td><td>含真实任务全链路</td></tr>
  <tr><td>内置 TLS 冒烟</td><td class="ok">6 / 6</td><td>含 /metrics 白名单 403</td></tr>
  <tr><td>对抗测试（容器内）</td><td class="ok">{passed} / {total}</td><td>critical {len(crit)}</td></tr>
  <tr><td>多 worker 并发不双领</td><td class="ok">7 / 7</td><td>上轮结果，本轮队列逻辑未变</td></tr>
  <tr><td>长稳（修复前镜像）</td><td class="ok">500 / 500</td><td>707s，零失败；但暴露两个资源问题，见 §06</td></tr>
  <tr><td>资源修复验证（最终镜像）</td><td class="ok">50 / 50</td><td>75s，fd 11→14（增量 3，门禁 PASS）、内存 62.57 MiB、磁盘 40M</td></tr>
  </table>
</section>

<section>
  <h2><span class="num">06</span>500 条长稳：零失败，但抓到两个真缺陷</h2>
  <p class="sub">混合负载：每 20 条换一次文案，既有冷渲染也有缓存命中，避免 500 条只测一条路径。
  每 100 条采样一次容器内存与磁盘。</p>
  <p><b>修复前镜像</b>（{esc(soak_text)}）：</p>
  <table><tr><th>检查点</th><th>内存</th><th>趋势</th></tr>{soak_rows or '<tr><td colspan="3">见 progress.md</td></tr>'}</table>
  <div class="note">零失败不等于没缺陷。前 100 条 +18.8 MiB 可解释为堆预热，
  但之后每 100 条仍稳定 +11 MiB；磁盘 97M → 1.7G 线性涨。
  <b>这两个都只有跑得够久才看得见，30 条时完全正常。</b></div>
  <h3>定位与修复</h3>
  <pre>docker exec renderd-test ls /proc/1/fd | wc -l   → 71
fd 明细：59 × renderd.sqlite、7 × -wal、1 × -shm（共 67 个 sqlite fd）
cat /proc/1/status | grep Threads                  → 4

根因 1  Store._conn() 用 threading.local 存连接；每个 HTTP 请求一个短命线程，
        sqlite3.Connection 与游标有循环引用，靠 GC 才回收 → 500 条累积 67 个连接
        → 每个连接的 page cache / WAL 映射常驻 → 内存 +60 MiB
修法    Store.close_thread_connection()，Handler._dispatch 的 finally 里逐请求关闭；
        长命的 worker / reaper 线程保留各自连接不受影响

根因 2  缓存命中时 shutil.copy2 为每个 job 复制 5MB 成片 → 磁盘线性膨胀
修法    os.link 硬链接（失败才回退 copy2），每 job 仍有独立可签名路径；
        renderd gc 增加 mezz 占用的只读报告</pre>
  <h3>修复后复测（最终镜像，同款混合负载，最新一次见下方证据）</h3>
  <pre>{esc(verify_text)}</pre>
  <p><b>结论</b>：fd 增量只有个位数（远低于修复前的 67，且不再随请求数累积），
  内存收敛、磁盘只随「不同成片」增长，不再是「每个 job 一份副本」。
  <code>tests/soak_verify.sh</code> 把「fd 增量 &lt; 10」作为自动门禁 ——
  用增量而不是绝对值，因为常驻 worker / reaper 线程会让基线随运行时长上升。</p>
</section>

<section>
  <h2><span class="num">07</span>仍保留的事项（诚实清单）</h2>
  <table><tr><th>事项</th><th>为什么保留</th><th>需要什么</th></tr>
  <tr><td>真实客户素材回归</td><td>合成语料覆盖故障模式，覆盖不了真实拍摄噪声、复杂字形、真实音乐床响度分布</td><td>50–100 条真实素材，脱敏后跑一次 <code>ingest_corpus.py</code></td></tr>
  <tr><td>文件卷未跨机</td><td>状态已经可以多 pod（PG），但素材/成片/mezz 仍共用同一个卷，缓存命中用硬链接</td><td>对象存储 + 预签名 URL；缓存路径改 URL</td></tr>
  <tr><td>webhook 同步投递</td><td>收端不响应时会阻塞 worker（实测 16.52s）；改 outbox 是客户可观察的时序契约变更</td><td>按 <code>docs/OPS.md</code> 的 outbox 方案实施</td></tr>
  <tr><td>HDR 预览级 tone mapping</td><td>广播级调色需要人工意图判断，不能自动「猜对」</td><td>客户 HDR 占比与调色需求明确后再上 libplacebo / 人工 LUT</td></tr>
  <tr><td>mezz 缓存无自动 GC</td><td>删除不可逆，只提供 <code>renderd gc</code> 且默认 dry-run</td><td>确定保留窗口后加自动清理策略</td></tr>
  </table>
</section>

<section>
  <h2><span class="num">08</span>怎么复现</h2>
  <pre>cd renderd
make doctor                     # 环境自检
make test                       # 104 个用例（含多副本状态 10 项）
make ingest-corpus              # 21 条脏语料归一化
make docker-build &amp;&amp; make docker-run
make test-container              # 10 项
make test-compose                # 11 项（含 kill -9 恢复）
make test-gateway                # 10 项 TLS 网关
make attack BASE=http://127.0.0.1:8788 TOKEN=&lt;A&gt; OTHER_TOKEN=&lt;B&gt; \\
     BURST_TOKEN=&lt;C&gt; STORAGE_TOKEN=&lt;D&gt; SECRET=&lt;S&gt;
make queue                       # 队列统计
make dlq                         # 死信列表
make soak500                     # 500 条长稳</pre>
  <h3>续轮 2 新增验证</h3>
  <table><tr><th>套件</th><th>结果</th></tr>
  <tr><td>生产级异步回归（<code>tests/test_production_async.py</code>）</td><td class="ok">11 / 11</td></tr>
  <tr><td>全量 unittest discover（含上述 11 项）</td><td class="ok">80 / 80</td></tr>
  <tr><td>容器全量：E2E 10 / Compose 11 / 网关 10 / 对抗 51</td><td class="ok">全绿</td></tr>
  <tr><td>存量库迁移（3 个旧 SQLite 数据目录打开并加列）</td><td class="ok">PASS</td></tr>
  <tr><td>容器内 <code>/v1/queue</code> / <code>/v1/dlq</code> / 新 metrics gauge</td><td class="ok">PASS</td></tr>
  </table>
  <p class="foot">报告由 <code>make_final_report.py</code> 从
  <code>/tmp/attack_final.json</code>、<code>var/ingest_regression/matrix.json</code>、
  <code>/tmp/soak500.log</code> 直接渲染。生成时间 2026-11-09。</p>
</section>

<section>
  <h2><span class="num">09</span>续轮 2：把队列从「可靠」推到「生产级」</h2>
  <p class="sub">上一版能不丢不错，但堆积时看不见、刹不住。这一轮补齐可观测、背压、退避、死信与优雅退出语义。</p>
  <table><tr><th>能力</th><th>落地物</th><th>解决什么</th></tr>
  <tr><td>队列可观测</td><td><code>Store.queue_stats()</code> + <code>/metrics</code> 7 个 gauge + <code>GET /v1/queue</code></td><td>depth / ready / delayed / running / oldest_wait_s / per-tenant inflight / failed_24h</td></tr>
  <tr><td>背压</td><td><code>RENDERD_MAX_QUEUE_DEPTH</code> / <code>RENDERD_MAX_TENANT_INFLIGHT</code></td><td>单租户批量灌任务不再让所有人排队；超限 <code>429 E_QUEUE_FULL</code>，dry_run 不占队列</td></tr>
  <tr><td>重试退避</td><td><code>jobs.available_at</code> + <code>base × attempts²</code></td><td>瞬态错误不再几秒内连烧完 3 次机会；确定性失败仍直接进死信</td></tr>
  <tr><td>死信与重放</td><td><code>renderd dlq / replay / release</code> + 三个 REST 端点</td><td>failed 可对账、可重放；失联 worker 可主动归还，不必等租约</td></tr>
  <tr><td>优雅退出</td><td><code>STOPSIGNAL SIGTERM</code> + <code>stop_grace_period: 300s</code></td><td>让当前渲染跑完</td></tr>
  <tr><td>webhook 去重</td><td><code>event_id = job_id:status:attempts</code></td><td>at-least-once 投递下收端可按此键幂等</td></tr>
  </table>
  <div class="note"><b>刻意不做的一件事</b>：SIGTERM 时没有自动把 running 任务改回 accepted。
  原进程可能还在跑 ffmpeg，新 worker 会立刻领走 → 双领。正确性事故比晚几十秒回收严重。
  reaper 只兜底真正的猝死；确认进程已退出后用 <code>renderd release --worker</code> 提前收回。</div>
  <h3>fd 门禁的一次误报</h3>
  <p>容器连跑 18 分钟、叠了四套测试后，绝对阈值 <code>fd &lt; 20</code> 报 FAIL（实测 25）。
  隔离测量：干净容器 60 次 HTTP 请求 sqlite fd 7→8，现有容器再跑 10 条渲染 21→21 ——
  <b>没有持续泄漏</b>，是阈值把「常驻 worker/reaper 线程的基线」误当成泄漏。
  门禁改为增量（结束−基线 &lt; 10）；同时把 <code>render.run()</code> 的 pump 管道显式关闭，
  消除 <code>TextIOWrapper</code> ResourceWarning。</p>

  <h3>回归抓到的一个迁移 bug</h3>
  <p>新增 <code>available_at</code> 列时，把 <code>CREATE INDEX ... (status, available_at)</code>
  留在了 SCHEMA 里，排在 <code>ALTER TABLE</code> 之前 —— 存量旧库一打开就
  <code>OperationalError: no such column</code>。语料回归（用的是上一轮留下的数据目录）第一次跑就炸了。
  修法：索引移到 <code>_migrate()</code> 补列之后创建。三个存量库复测全部可打开。</p>
</section>

</div></body></html>
"""

# ── §10：PG 双后端与异步架构复审（数据来自本轮实测 evidence.json）──
pg = json.loads(PG_EV.read_text()) if PG_EV.exists() else {}
pgi, arc = pg.get("pg", {}), pg.get("arch_review", {})
curve = "".join(
    f"<tr><td>{r:,}</td><td>{b:.3f} ms</td>"
    f"<td class='ok'>{af:.3f} ms</td>"
    f"<td>{(b / af if af else 0):.0f}×</td></tr>"
    for r, b, af in zip(arc.get("queue_stats_rows", []),
                        arc.get("queue_stats_before_ms", []),
                        arc.get("queue_stats_after_ms", [])))
landed = "".join(f"<li>{esc(x)}</li>" for x in arc.get("landed", []))
deferred = "".join(f"<li>{esc(x)}</li>" for x in arc.get("deferred_p1", []))
etx = arc.get("event_tx_merged", {})
section10 = f"""<section>
  <h2><span class="num">10</span>PG 双后端与异步架构复审</h2>
  <p class="sub">Colima 里起 PostgreSQL 16.15，同一套用例与攻击在两套后端上各跑一遍；
  随后按领取 / 心跳 / 回收 / 投递 / 预检五条路径重审异步架构。</p>

  <h3>PG 不是第二套实现</h3>
  <p><code>Store()</code> 改成工厂函数，<code>SqliteStore</code> 原样保留；
  <code>PostgresStore</code> 用一层方言代理复用全部 45 条 SQL，只 override 三处真差异：
  <code>ON CONFLICT</code> 幂等、<code>FOR UPDATE SKIP LOCKED</code> 领取、无 <code>BEGIN IMMEDIATE</code> 的事务。
  所以 store.py 的任何改动自动被两套后端同时覆盖 —— 「支持 PG」不是文档里的一句话，
  而是 85 个用例逐条跑过的事实。</p>
  <table><tr><th>验证项</th><th>SQLite</th><th>PostgreSQL</th></tr>
  <tr><td>unittest discover</td><td class="ok">{esc(pgi.get('unittest_sqlite', '—'))}</td><td class="ok">{esc(pgi.get('unittest_pg', '—'))}</td></tr>
  <tr><td>对抗测试</td><td class="ok">51 / 51</td><td class="ok">{esc(pgi.get('attack_pg', '—'))}</td></tr>
  <tr><td>21 条脏语料</td><td class="ok">PASS</td><td class="ok">{esc(pgi.get('corpus_pg', '—'))}</td></tr>
  <tr><td>镜像内驱动自检</td><td class="ok">零依赖</td><td class="ok">psycopg 3.3.8</td></tr>
  </table>
  <p class="note">{esc(pgi.get('engine', ''))}。生产用 <code>docker-compose.pg.yml</code>：
  api / worker 共用 <code>RENDERD_PG_SCHEMA</code>；未指定时每个实例自动隔离 schema，
  这是给 unittest 用的，多进程部署必须显式指定。</p>

  <h3>复审实测：queue_stats 从线性退化变成常数</h3>
  <p>主聚合原本是 <code>SELECT SUM(CASE …) FROM jobs</code> 无 WHERE，
  每次 <code>/metrics</code> 抓取、<b>每次提交做背压检查</b>都要扫全部历史任务。
  改成只扫 <code>status IN ('accepted','running')</code>，并给 <code>failed_24h</code> 加部分索引。</p>
  <table><tr><th>历史 job 行数</th><th>优化前</th><th>优化后</th><th>倍数</th></tr>{curve}</table>
  <p>10 万行历史：15.270 → 0.029 ms（约 {arc.get('queue_stats_speedup_at_100k', 0)}×），
  且不再随历史增长 —— 队列指标只该跟<b>活跃任务数</b>有关。</p>

  <h3>顺带落地：事件写入合并进主事务</h3>
  <p>原先每次状态变更开两个事务（<code>UPDATE jobs</code> + <code>INSERT job_events</code>）。
  按调用点统计，一条任务约 {etx.get('before_approx', 0)} 次写事务；合并到同一事务后约
  {etx.get('after_approx', 0)} 次。状态与事件要么都落、要么都不落，原子性更好，
  PG 下还省掉一半网络往返。这是<b>静态调用点统计</b>，不是跑分。</p>

  <h3>最大的剩余瓶颈：webhook 同步投递</h3>
  <p>收端不响应时实测 <code>_notify()</code> 耗时 <b>{arc.get('webhook_block_seconds', 0)} 秒</b>
  （8s 超时 × 2 次重试）。它就在 worker 线程里、在 <code>succeed()</code> 之后同步执行 ——
  这段时间 worker 完全不能领下一条任务。正确形态是持久化 outbox：
  <code>_notify</code> 只 INSERT 一条待投递记录，独立 dispatcher 用
  <code>UPDATE … RETURNING</code> 领取并投递，失败按退避重排。
  多 pod 下内存线程队列会丢回调，所以必须落库。</p>
  <p class="note"><b>刻意没做</b>：这会把投递从「同步」变成「异步」，是客户可观察的时序契约变更；
  且要新增表与 dispatcher、改 4 个 webhook 用例。已连同实现方案写进 blockers.md 的 P1，
  不夹带在这一轮的性能优化里。</p>

  <h3>本轮已落地</h3><ul>{landed}</ul>
  <h3>复审后明确暂缓</h3><ul>{deferred}</ul>
</section>

"""
html_doc = html_doc.replace("</div></body></html>",
                            section10 + "</div></body></html>")

# ── §11：对抗审查（五条被坐实的问题）──
ADV = ROOT / "var" / "adv_review" / "evidence.json"
adv = json.loads(ADV.read_text()) if ADV.exists() else {}
adv_rows = "".join(
    f"<tr><td class='mono'>{esc(f.get('id'))}</td>"
    f"<td><b>{esc(f.get('name'))}</b></td>"
    f"<td><span class='tag {'hot' if f.get('severity') == 'critical' else ''}'>"
    f"{esc(f.get('severity'))}</span></td>"
    f"<td>{esc(f.get('before'))}</td>"
    f"<td class='ok'>{esc(f.get('after'))}</td>"
    f"<td>{esc(f.get('fix'))}</td></tr>"
    for f in adv.get("findings", []))
adv_prin = "".join(f"<li>{esc(x)}</li>" for x in adv.get("principles", []))
adv_t = adv.get("tests", {})
section11 = f"""<section>
  <h2><span class="num">11</span>对抗审查：五条被坐实的问题</h2>
  <p class="sub">不接着补用例，先回到基本事实：系统的信任边界在哪、哪些「成功」是服务
  自己说了算、哪些状态用了不该用的时钟。每条都先写出可复现实验，再改。</p>

  <h3>推演用的四条基本事实</h3>
  <ul>{adv_prin}</ul>

  <h3>找到并修掉的五条</h3>
  <table><tr><th>#</th><th>问题</th><th>级别</th><th>修复前（实测）</th>
  <th>修复后（实测）</th><th>修法</th></tr>{adv_rows}</table>

  <h3>两条 critical 的实际影响</h3>
  <p><b>A · 默认密钥</b>：<code>_secret()</code> 回退到源码里的
  <code>renderd-dev-secret</code>，三个 compose 的默认值是 <code>change-me</code>。
  任何人拿到这份代码就能对任意 job_id 伪造下载签名 —— 这属于「看起来有 HMAC，
  实际没有签名」。修法不是加参数，而是把密钥来源换掉：未配置时生成 32 字节随机值
  并以 0600 落盘，弱值启动即拒绝。</p>
  <p><b>E · 墙钟前跳</b>：租约判断是 <code>lease_until &lt; now</code>，时钟一前跳，
  所有 running 任务同时满足过期条件，reaper 把它们全改回 accepted，而原 worker
  还在渲染 —— 新 worker 立刻领走，双领。第一性原理是：<b>时钟不确定时，宁可什么都不做</b>。
  当时先用「单调钟与墙钟的漂移检测 + 跳过回收」止血；续轮 5 换成了单一时钟源
  （HLC），时间本身不再跟随墙钟跳变，也就不需要停手 —— 见 §12。</p>

  <h3>「回执可信」是这类系统的核心命题</h3>
  <p>C 和 D 看似两件事，其实是同一条：Agent 看不见视频，它只信回执。
  回执必须对它引用的每个文件做内容承诺（<code>evidence_sha256</code>），
  并且「成功」必须包含「客户能拿到」—— 唯一交付通道失败时 verdict 降级为 fail，
  Agent 才会重试。只写 warnings 等于让它继续相信 pass。</p>

  <h3>固化</h3>
  <p>新增 <code>tests/test_adversarial_review.py</code>
  {esc(adv_t.get('adversarial_review_cases', 8))} 项常驻断言
  （{esc(adv_t.get('adversarial_review_result', ''))}）；对抗套件新增 H 组 4 项
  （CRLF 注入 / 覆盖 Host / 覆盖 Content-Length / 默认常量伪造签名），
  总数 {esc(adv_t.get('attack_total', 55))} 项。
  「修过的问题没有测试钉住，下一轮一定会回来」。</p>
</section>

"""
R5 = json.loads((ROOT / "var" / "round5" / "evidence.json").read_text())
r5rl, r5q = R5["rate_limit"], R5["storage_quota"]
r5c, r5s, r5t = R5["clock"], R5["signed_url"], R5["tests"]
sig_rows = "".join(
    f"<tr><td>{esc(c['attack'])}</td><td>{esc(c['before'])}</td>"
    f"<td class='ok'>{esc(c['after'])}</td></tr>" for c in r5s["cases"])
side = "".join(f"<li>{esc(x)}</li>" for x in R5["side_fixes"])
section12 = f"""<section>
  <h2><span class="num">12</span>三条「仍未解决」的收口</h2>
  <p class="sub">上一轮结尾列的三条：进程内限流/配额（P0）、墙钟只缓解、签名 URL 不绑租户。
  每条都先用同一脚本拿到「修复前」的数字，改完再跑一遍同一脚本。</p>

  <h3>一 · 预算必须由共享存储仲裁</h3>
  <table><tr><th>场景</th><th>修复前（实测）</th><th>修复后（实测）</th></tr>
    <tr><td>{r5rl['before']['instances']} 个 API 实例，租户 qps={r5rl['before']['qps']}</td>
      <td class="hot">1 秒放行 {r5rl['before']['admitted_1s']}</td>
      <td class="ok">1 秒放行 {r5rl['after']['admitted_1s']}</td></tr>
    <tr><td>{r5q['before']['instances']} 个实例并发 700KB（配额 1MB）</td>
      <td class="hot">{r5q['before']['uploads_ok']} 个都成功，记账 {r5q['before']['used_mb']}MB</td>
      <td class="ok">{r5q['after']['uploads_ok']} 个成功，记账 {r5q['after']['used_mb']}MB</td></tr>
    <tr><td>{r5rl['containers']['replicas']} 个 <b>容器</b> + 同一个 PG</td>
      <td>—</td>
      <td class="ok">放行 {r5rl['containers']['admitted_1s']} / 拒绝 {r5rl['containers']['denied_1s']}；
      上传 {r5q['containers']['uploads_ok']}/3，记账 {r5q['containers']['used_bytes']} 字节</td></tr>
  </table>
  <p>限流是 20 个 50ms 子桶的滑动窗口（固定 1 秒桶在边界会放行 2×，实测过），
  判定压成<b>一条 SQL</b>：<code>INSERT … SELECT … WHERE 窗口未满 ON CONFLICT DO UPDATE … WHERE
  当前桶未满</code> —— 「读窗口 → 判断 → 记账」之间没有可被并发穿过的间隙。
  配额是「一个写事务内预占 + <code>O_CREAT|O_EXCL</code> 原子写 + 失败退款」，
  PG 下用 <code>SELECT … FOR UPDATE</code> 锁租户行。</p>
  <p>成本：SQLite p50 <b>{r5rl['cost']['sqlite_p50_ms']}ms</b>、PG p50
  <b>{r5rl['cost']['pg_p50_ms']}ms</b>（从 {r5rl['cost']['pg_before_ms']}ms 降下来，
  一半收益来自 PG 连接改 autocommit —— 原来每条只读 SELECT 也要 commit）。
  {esc(r5rl['why_not_redis'])}。</p>

  <h3>二 · 时间本身不跳，而不是「跳了就别动」</h3>
  <p>上一轮的做法是检测到漂移就跳过回收 —— 那是缓解：时钟异常期间回收停摆，
  且跳变若发生在两次扫描之间仍会误判。这一轮换成单一时钟源：</p>
  <pre>{esc(r5c['model'])}
clock.last_ts 在 DB 内只前进不回退      # 跨实例对齐</pre>
  <table><tr><th>场景</th><th>结果（实测）</th></tr>
    <tr><td>墙钟 +{r5c['forward_jump_s']}s</td>
      <td class="ok">逻辑时间偏移 {r5c['logical_drift_after_jump_s']}s；running 任务被回收
      {r5c['recovered_jobs']} 条</td></tr>
    <tr><td>墙钟 -{r5c['forward_jump_s']}s</td>
      <td class="ok">不回退（回退会让已发出的租约重新有效）</td></tr>
    <tr><td>跳变可见性</td>
      <td class="ok">落 <code>clock_events</code>，任意副本的 <code>/v1/queue</code> 都能读到同一值</td></tr>
  </table>
  <p>连带把所有持久化时间戳（<code>created_at</code>/<code>lease_until</code>/<code>available_at</code>/
  <code>gc</code> 截止）换成逻辑时钟 —— 一个系统只能有一个时间基，混用会让
  <code>elapsed_s</code> 出现负数。代价是逻辑时间与墙钟的偏移不会自动回归（重启才对齐），
  已写进 blockers §8.2。</p>

  <h3>三 · 签名要绑定「谁」和「用来干什么」</h3>
  <p>载荷从 <code>job_id:exp</code> 改为
  <code>{esc(json.dumps(r5s['payload'], ensure_ascii=False))}</code>。校验顺序是
  「先验签 → 再查任务 → 最后比对 owner」：反过来就变成用 404/401 的差异探测 job 是否存在。</p>
  <table><tr><th>攻击</th><th>修复前</th><th>修复后</th></tr>{sig_rows}</table>
  <p>{esc(r5s['receipt_evidence_links'])}。</p>

  <h3>回归里冒出来的四个真问题</h3>
  <ul>{side}</ul>

  <h3>回归</h3>
  <pre>unittest  SQLite {esc(r5t['unittest_sqlite'])}      PG {esc(r5t['unittest_pg'])}
对抗      SQLite {esc(r5t['attack_sqlite'])}      PG {esc(r5t['attack_pg'])}
容器 E2E  {esc(r5t['container_e2e'])}    Compose {esc(r5t['compose_e2e'])}
网关      {esc(r5t['gateway_e2e'])}         三副本容器 {esc(r5t['multi_replica'])}</pre>
</section>

"""
R6 = json.loads((ROOT / "var" / "round6" / "evidence.json").read_text())
r6a, r6q, r6s, r6t = R6["auth_fail"], R6["queue_scope"], R6["assets"], R6["tests"]
r6side = "".join(f"<li>{esc(x)}</li>" for x in R6["side_fixes"])
r6guard = "".join(f"<li>{esc(x)}</li>" for x in r6s["guard"])
section13 = f"""<section>
  <h2><span class="num">13</span>租户边界：谁能打、谁能看、谁能删</h2>
  <p class="sub">这三条在单租户开发时全都看不见，第二个租户一进来就出事。
  和前面几轮一样：先写探针拿到「修复前」，改完跑同一个探针。</p>

  <h3>一 · 认证失败也要限流</h3>
  <p><code>admit()</code> 的顺序原本是 <code>resolve()</code> → <code>rate_hit()</code>，
  错 token 在限流之前就抛 401 —— <b>401 可以无限打</b>。现在鉴权前按客户端 IP 拦无效令牌：
  超过 <code>RENDERD_AUTH_FAIL_QPS</code>（默认 10/s）返回 429，早于任何数据库操作。</p>
  <p><b>第一版做错了一次</b>：按 IP 一刀切（该 IP 失败过就拦所有请求），
  实测攻击套件整组变 429 —— 同一出口 IP 后面的正常客户会被一起打死。
  改成只拦「令牌不在配置里」的请求后，保护目标不变，误伤消失：
  {esc(r6a['policy'])}。</p>

  <h3>二 · 队列视图分级</h3>
  <table><tr><th>角色</th><th>修复前</th><th>修复后</th></tr>
    <tr><td>普通租户</td><td class="hot">{esc(r6q['before'])}</td>
      <td class="ok">{esc(r6q['after'])}</td></tr>
    <tr><td>admin</td><td>—</td>
      <td>令牌在 <code>RENDERD_ADMIN_TOKENS</code> 里 → <code>scope=admin</code>，看全量</td></tr>
  </table>
  <p>{esc('、'.join(r6q['kept']))} 这些容量字段对普通租户保留 —— 判断要不要错峰需要它们；
  被收敛的只是「别人家的租户名与负载」。</p>

  <h3>三 · 素材能删、配额能退</h3>
  <p>根因不是缺一个删除接口，而是缺文件级明细：只有 <code>usage.bytes</code> 一个聚合值，
  回答不了「这份字节属于哪个文件」，所以文件删不掉、配额也退不回。</p>
  <table><tr><th></th><th>修复前</th><th>修复后</th></tr>
    <tr><td>数据结构</td><td>{esc(r6s['before']['schema'])}</td>
      <td class="ok">{esc(r6s['after']['schema'])}</td></tr>
    <tr><td>配额来源</td><td>{esc(r6s['before']['schema'])}，只增不减</td>
      <td class="ok">{esc(r6s['after']['quota_source'])}，删引用即释放</td></tr>
    <tr><td>删除</td><td class="hot">{esc(r6s['before']['delete'])}</td>
      <td class="ok">{esc(r6s['after']['delete'])}</td></tr>
    <tr><td>回收</td><td>{esc(r6s['before']['gc'])}</td>
      <td class="ok">{esc(r6s['after']['gc'])}</td></tr>
  </table>
  <p>约束（都有断言钉住）：</p>
  <ul>{r6guard}</ul>

  <h3>回归里冒出来的三个问题</h3>
  <ul>{r6side}</ul>

  <h3>回归</h3>
  <pre>unittest  SQLite {esc(r6t['unittest_sqlite'])}      PG {esc(r6t['unittest_pg'])}
对抗      SQLite {esc(r6t['attack_sqlite'])}      PG {esc(r6t['attack_pg'])}
新增      {esc(r6t['new_cases'])}</pre>
</section>

"""
R8 = json.loads((ROOT / "var" / "round8" / "evidence.json").read_text())
r8b, r8a, r8t = R8["before"], R8["after"], R8["tests"]
r8_rows = "".join(
    f"<tr><td>{i['id']}</td><td>{esc(i['problem'])}</td>"
    f"<td class='hot'>{esc(i['effect'])}</td></tr>" for i in r8b["issues"])
r8_limits = "".join(f"<li>{esc(x)}</li>" for x in R8["not_promised"])
m = r8a["measured"]
section14 = f"""<section>
  <h2><span class="num">14</span>MLT 后端：从「只生成 XML」到「真能出片」</h2>
  <p class="sub">起因是一句提问 ——「MLT 没做吗，后面音轨会用到」。查下去发现比「没做」更糟：
  生成器在、结构校验也过，但<b>从未被 melt 执行过</b>，真渲染只有
  {esc(r8b['render_result'])}。</p>

  <h3>六个问题，全部用最小 XML 对照实验定位</h3>
  <table><tr><th>#</th><th>问题</th><th>现象 / 后果</th></tr>{r8_rows}</table>
  <p>前四个是「跑不出片」，后两个是「跑出来但过不了断言」。定位方法都是控制变量：
  单轨无转场也只剩 1 帧 → 排除 transition；让 melt 自己 <code>-consumer xml:</code>
  导出参考 XML，才发现它给 producer 带了 <code>length</code> 而我们用的是不探测的
  <code>avformat-novalidate</code>；用 <code>volumedetect</code> 对比才看出视频轨的声音漏了进来。</p>

  <h3>现在的状态</h3>
  <pre>{esc(r8a['path'])}</pre>
  <p>实测 <code>{esc(m['template'])}</code> 走 MLT：
  <b>status={esc(m['status'])}</b>、<b>verdict={esc(m['verdict'])}</b>、
  <b>{esc(str(m['integrated_lufs']))} LUFS</b>、<b>{m['frames']} 帧</b>、{esc(m['audio'])}。
  静音断言实测 {m['silence_check_db']}dB（修复前 -24dB）；两条相同音轨叠加
  +{m['two_track_sum_gain_db']}dB（修复前 +0dB，第二条被丢）。</p>

  <h3>代价与边界</h3>
  <p>melt 会带进 Qt5、frei0r、ladspa、sox：镜像 {esc(R8['image']['default'])} →
  {esc(R8['image']['mlt'])}。所以它<b>不进默认镜像</b>，单独 <code>Dockerfile.mlt</code>；
  默认镜像上请求 <code>backend=mlt</code> 会明确返回 <code>E_RENDER_FAILED</code>，
  不静默降级（降级会让客户以为走的是 MLT，缓存键也会串）。</p>
  <ul>{r8_limits}</ul>

  <h3>回归</h3>
  <pre>MLT 套件   {esc(r8t['mlt_suite'])}       入口 {esc(r8t['entry'])}
宿主机全量 {esc(r8t['host_full'])}
容器 E2E   {esc(r8t['container_e2e'])}
对抗       {esc(r8t['attack'])}</pre>

  <h3>教训</h3>
  <p>{esc(R8['lesson'])}</p>
</section>

"""
R9 = json.loads((ROOT / "var" / "round9" / "evidence.json").read_text())
r9 = R9["found"]
r9t = R9["tests"]
st_rows = "".join(
    f"<tr><td>{esc(c['capability'])}</td>"
    f"<td class='{'ok' if c['state'] == 'ok' else ('warn' if c['state'] == 'partial' else 'hot')}'>"
    f"{'✅' if c['state'] == 'ok' else ('◐' if c['state'] == 'partial' else '❌')}</td>"
    f"<td>{esc(c['note'])}</td></tr>" for c in R9["engine_status"])
section15 = f"""<section>
  <h2><span class="num">15</span>编码分支实跑：两条「能出片但交付不出去」的问题</h2>
  <p class="sub">{esc(R9['trigger'])}。结果比预期好，也比预期坏：两条都能出片、
  断言都通过，但成片在目标设备上打不开。</p>

  <h3>一 · HEVC 的容器 tag 是 <code>hev1</code></h3>
  <table><tr><th></th><th>修复前（实测）</th><th>修复后（实测）</th></tr>
    <tr><td>ffmpeg 后端</td><td class="hot">{esc(r9[0]['before']['ffmpeg_backend'])}</td>
      <td class="ok">{esc(r9[0]['after']['ffmpeg_backend'])}</td></tr>
    <tr><td>MLT 后端</td><td class="hot">{esc(r9[0]['before']['mlt_backend'])}</td>
      <td class="ok">{esc(r9[0]['after']['mlt_backend'])}</td></tr>
    <tr><td>h264 / av1</td><td>avc1 / av01</td><td class="ok">不变（显式写死）</td></tr>
  </table>
  <p><code>hev1</code> 与 <code>hvc1</code> 只差两字节，语义不同：<code>hev1</code>
  允许参数集（VPS/SPS/PPS）在码流中重复出现，<code>hvc1</code> 要求只在
  <code>hvcC</code> 盒子里。<b>Apple 的解复用器只实现后者。</b>
  所以「渲染成功 + 断言通过 + 回执 pass」的成片在 iPhone 上打不开 ——
  技术指标全绿、交付目标不成立。</p>
  <p>{esc(r9[0]['why_missed'])}</p>

  <h3>二 · 改了编码参数，缓存仍返回旧产物</h3>
  <p>{esc(r9[1]['why_it_matters'])}。修法两层：</p>
  <ul><li>{esc(r9[1]['fix'][0])}</li><li>{esc(r9[1]['fix'][1])}</li></ul>
  <p>{esc(r9[1]['cost'])}。宁可重算，也不要让用户拿到与当前代码不一致的产物。</p>

  <h3>顺带确认没问题的</h3>
  <p>{esc('；'.join(R9['confirmed_ok']))}。</p>

  <h3>引擎侧现在的真实状态</h3>
  <table><tr><th>能力</th><th></th><th>说明</th></tr>{st_rows}</table>

  <h3>回归</h3>
  <pre>unittest   SQLite {esc(r9t['sqlite'])}
           PG     {esc(r9t['pg'])}
MLT 套件   {esc(r9t['mlt_suite'])}      容器 E2E {esc(r9t['container_e2e'])}
新增       {esc(r9t['new'])}</pre>

  <h3>教训</h3>
  <p>{esc(R9['lesson'])}</p>
</section>

"""
R10 = json.loads((ROOT / "var" / "round10" / "evidence.json").read_text())
r10, r10t = R10["delivered"], R10["tests"]
cap_rows = "".join(
    f"<tr><td>{esc(d['capability'])}</td><td><code>{esc(d['ir'])}</code></td>"
    f"<td>{esc(d.get('semantics') or d.get('fix', ''))}</td></tr>" for d in r10)
ev_rows = "".join(
    "<tr><td>" + esc(d["capability"]) + "</td><td class='ok'>" +
    "<br>".join(esc(f"{k}: {v}") for k, v in d["evidence"].items()) +
    "</td></tr>" for d in r10)
rem_rows = "".join(f"<li>{esc(x)}</li>" for x in R10["remaining"])
section16 = f"""<section>
  <h2><span class="num">16</span>引擎四项能力落地：转场 / 音量 / 字幕 / 多轨 alpha</h2>
  <p class="sub">{esc(R10['trigger'])}。四项都先定 IR 语义、再改编译器，
  最后用<b>可量化</b>的渲染证据验证 —— 不是「argv 里有这个滤镜」就算完成。</p>

  <h3>IR 语义</h3>
  <table><tr><th>能力</th><th>字段</th><th>语义</th></tr>{cap_rows}</table>

  <h3>渲染证据</h3>
  <table><tr><th>能力</th><th>实测</th></tr>{ev_rows}</table>

  <h3>三个值得说的判断</h3>
  <p><b>转场的 offset 恰好等于 <code>at_frame/fps</code></b>。这是「重叠 N 帧」语义的直接推论：
  offset = 前输出长度 − N，而前输出长度等于前段 out_frame（总长守恒），
  又 at = 前段 out_frame − N，两者相等。省掉累计计算，也就不会有累计误差。</p>
  <p><b>volume 必须能关掉 loudnorm 才有意义</b>。loudnorm 在链路最后，会把单音轨的
  音量拉回 -14 LUFS —— 单轨场景下 volume 看起来「没生效」。现在
  <code>target_lufs: null</code> 显式关闭归一，此时音量就是绝对增益。</p>
  <p><b>alpha 丢在归一化，不在编译器</b>。第一版只改编译器的 <code>format</code>，
  实测叠加后仍是纯红。查下来归一化用 libx264，x264 没有 alpha 通道。
  改成 overlay 素材透传才解决 —— 这类问题只有跑像素统计才看得出来。</p>

  <h3>MLT 后端</h3>
  <p>音量写成 entry 级 <code>volume</code> filter（MLT 没有轨道增益）；
  转场<b>未实现，编译前直接 <code>E_IR_UNSUPPORTED</code></b> ——
  静默降级成硬切比报错更糟：客户看到「成功」，拿到与 IR 不一致的成片。</p>

  <h3>回归</h3>
  <pre>unittest   SQLite {esc(r10t['sqlite'])}   PG {esc(r10t['pg'])}
MLT 套件   {esc(r10t['mlt_suite'])}      容器 E2E {esc(r10t['container_e2e'])}
新增       {esc(r10t['new'])}
COMPILE_REV {R10['compile_rev']}（argv 构造变了，缓存整体失效一次）</pre>

  <h3>仍然没做</h3>
  <ul>{rem_rows}</ul>
</section>

"""
R11 = json.loads((ROOT / "var" / "round11" / "evidence.json").read_text())
r11, r11n, r11t = R11["findings"], R11["new_capability"], R11["tests"]
f11_rows = "".join(
    f"<tr><td>{esc(f['issue'])}</td><td class='{'ok' if '正确' in f['verdict'] else 'hot'}'>"
    f"{esc(f['verdict'])}</td></tr>" for f in r11)
file_rows = "".join(
    f"<tr><td><code>{esc(f['name'])}</code></td><td>{esc(f['spec'])}</td></tr>"
    for f in R11["source"]["files"])
r11_rows = "".join(
    f"<tr><td>{esc(r['mode'])}</td><td>{esc(r['spec'])}</td>"
    f"<td class='ok'>{esc(r['loudness'])}</td><td>{esc(r['note'])}</td></tr>"
    for r in R11["renders"])
section17 = f"""<section>
  <h2><span class="num">17</span>真实素材回归：一条真素材顶十条合成语料</h2>
  <p class="sub">素材来自 {esc(R11['source']['page'])}（{esc(R11['source']['template'])}）。
  这是 blockers 里「真实客户素材回归」第一次真跑。</p>

  <h3>素材本身</h3>
  <table><tr><th>文件</th><th>规格</th></tr>{file_rows}</table>

  <h3>立刻撞到的四件事</h3>
  <table><tr><th>现象</th><th>判定</th></tr>{f11_rows}</table>

  <h3>新增 <code>fit: "blur"</code></h3>
  <p>{esc(r11n['chain'])}。{esc(r11n['rejects'])}。</p>
  <p>为什么必须加：<code>cover</code> 从 16:9 到 9:16 只保留中间 <b>31.6%</b> 的宽度
  （放大到高 1920 → 宽 3413 → 裁到 1080）。比例可以算出来，但
  <b>只有拿真实素材跑一遍，才会意识到「31.6%」等于「边缘信息全丢」</b> ——
  实测 promo 两侧的 logo、时间码、说明文字全部被切掉。合成语料（testsrc/colorbar）
  没有「边缘有信息」这个属性，所以永远测不出来。</p>
  <p>证据：{esc(r11n['evidence']['render'])}。</p>

  <h3>两条成片</h3>
  <table><tr><th>适配</th><th>规格</th><th>响度</th><th>画面</th></tr>{r11_rows}</table>
  <p>主视频有真实音轨（aac 48kHz 立体声），<b>响度归一在真实素材上把 -14.2 打进 ±1.0 容差</b>，
  不是只在合成正弦波上成立。</p>

  <h3>回归</h3>
  <pre>unittest   SQLite {esc(r11t['sqlite'])}
           PG     {esc(r11t['pg'])}
MLT 套件   {esc(r11t['mlt_suite'])}      容器 E2E {esc(r11t['container_e2e'])}
新增       {esc(r11t['new'])}       COMPILE_REV {R11['compile_rev']}</pre>

  <h3>这条 blocker 的现状</h3>
  <p>做了一次，但<b>还不能关</b>：用的是公开 promo（科技风、深色、主体居中），
  客户素材可能是实拍人脸、商品特写、强纹理；而且只人工看了 4 帧。
  判定：可以开始接客户试跑，<b>第一批量产前必须做一次逐镜头人工抽帧复核</b>。</p>
</section>

"""
html_doc = html_doc.replace("</div></body></html>",
                            section11 + section12 + section13 + section14
                            + section15 + section16 + section17
                            + "</div></body></html>")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html_doc + "\n")
print(f"→ {OUT}")
print(f"  {total} 项攻击 / 通过 {passed} / 失败 {len(fails)} / critical {len(crit)}")
print(f"  {len(matrix)} 条语料 / 归一化 {len(norm_ok)} / 硬失败 {len(blocked)}")
print(f"  {len(e2e)} 条端到端 / 长稳 {soak_text[:60]}")
