#!/usr/bin/env python3
"""生成单页 HTML 接口文档。

事实来源分成两半：
  · 端点清单来自 `api.ROUTES`（少写一个就会在生成时报错）
  · 错误码来自 `errors.ERROR_SPECS`（状态码 / 是否可重试 / 阶段）

正文示例是手写的 —— 示例必须能读，不能从代码里猜。但**路由与错误码不允许漂移**：
新增一个路由却没写说明，脚本直接失败。
"""
from __future__ import annotations

import html
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from renderd import __version__                      # noqa: E402
from renderd.api import ROUTES                       # noqa: E402
from renderd.errors import ERROR_SPECS               # noqa: E402

OUT = ROOT.parent / "deliverables" / "接口文档.html"
esc = lambda x: html.escape(str(x), quote=True)


# ── 端点说明（key = ROUTES 里的 handler 名）──────────────────────────
E = {
    "health": dict(
        group="公开", scope="public", title="健康检查",
        desc="存活探针。返回引擎版本、字体族数量、运行时长。不鉴权，可用于负载均衡探活。",
        params=[], resp='''{"ok": true, "version": "0.1.0", "ir_version": "0.1",
 "engine": "ffmpeg version 7.1.5", "uptime_s": 128.4,
 "backend_default": "ffmpeg", "fonts_available": 68}''',
        errs=[]),
    "metrics": dict(
        group="公开", scope="public", title="Prometheus 指标",
        desc="文本格式指标。默认只对回环与私网开放，来源不在 `RENDERD_METRICS_CIDRS` 内返回 403。",
        params=[("来源 IP", "—", "必须在 RENDERD_METRICS_CIDRS 内")],
        resp='''renderd_jobs_total 128
renderd_queue_depth 3
renderd_jobs_running 2
renderd_clock_skew_seconds 0''',
        errs=["E_METRICS_FORBIDDEN"]),
    "templates": dict(
        group="渲染主链路", scope="tenant", title="模板列表",
        desc="返回模板 id、画面比例、时长、分辨率，以及每个变量的 schema（必填、最大字数、可选值）。",
        params=[], resp='''{"templates": [{"id": "hook_vertical_6s", "aspect": "9:16",
  "duration_s": 6.0, "resolution": [1080, 1920],
  "variables": [{"name": "hook", "type": "text", "required": true, "max_chars": 14}]}]}''',
        errs=[]),
    "validate": dict(
        group="渲染主链路", scope="tenant", title="预检（不渲染）",
        desc="请求体与 `/v1/render` 相同（`idempotency_key` 可省）。返回逐项检查与**机器可执行**的 fixes，"
             "Agent 照改即可重试。不占队列、不计费。",
        params=[("body", "object", "见提交渲染；`dry_run` 无意义")],
        resp='''{"valid": false,
 "checks": {
   "ir_schema": {"pass": true},
   "assets_readable": {"pass": true},
   "font_coverage": {"pass": false, "error": {"code": "E_FONT_MISSING"}},
   "text_safe_area": {"pass": true},
   "audio_present": {"pass": true}},
 "fixes": [{"field": "styles.*.font_family", "action": "pick_font",
            "value": "Noto Sans CJK SC"}],
 "estimate": {"cost_cny": 0.0049, "render_s_p50": 3.0, "wall_clock_s_p50": 9.0}}''',
        errs=["E_BAD_REQUEST", "E_IR_INVALID"]),
    "submit": dict(
        group="渲染主链路", scope="tenant", title="提交渲染",
        desc="提交任务。同步完成预检（IR / 素材 / 字体 / 安全区 / 容量），预检不过直接返回错误码，不进队列。"
             "`dry_run=true` 只算成本、不入队。",
        params=[
            ("idempotency_key", "string，必填，≥8", "调用方自己的任务号；同 key 重复提交返回同一 job，不二次计费"),
            ("template_id", "string", "与 `ir` 二选一"),
            ("variables", "object", "模板变量"),
            ("assets", "array", "`[{id, uri}]`，uri 支持 `file://`（限 media 目录）与 `upload:<name>`"),
            ("ir", "object", "直传 IR，跳过模板；见 docs/IR.md"),
            ("priority", "low / normal / high", "默认 normal"),
            ("callback_url", "string", "完成回调；提交期解析并钉住 IP，防 DNS rebinding"),
            ("delivery", "object", "`put_url` 直传客户对象存储，见下"),
            ("dry_run", "bool", "只算成本与 checks"),
            ("backend", "ffmpeg / mlt", "默认 ffmpeg"),
        ],
        req='''{
  "idempotency_key": "order-20261109-001",
  "template_id": "brand_vertical_15s",
  "variables": {"clip1": "a1", "clip2": "a2", "clip3": "a3",
                "title": "季度回顾", "music": "m1"},
  "assets": [
    {"id": "a1", "uri": "upload:9f3d....mp4"},
    {"id": "a2", "uri": "file:///data/media/b.mp4"},
    {"id": "a3", "uri": "upload:11ab....mp4"},
    {"id": "m1", "uri": "upload:77cd....m4a"}
  ],
  "priority": "normal",
  "callback_url": "https://example.com/hook"
}''',
        resp='''202 Accepted
{"job_id": "job_35111bb1c430", "status": "accepted", "stage": "queued",
 "idempotent_replay": false, "poll_after_s": 3,
 "estimate": {"cost_cny": 0.0123, "render_s_p50": 7.5, "wall_clock_s_p50": 13.5}}''',
        errs=["E_BAD_REQUEST", "E_IR_INVALID", "E_TEMPLATE_NOT_FOUND", "E_TEMPLATE_VARS",
              "E_FONT_MISSING", "E_TEXT_OVERFLOW", "E_QUOTA_EXCEEDED", "E_QUEUE_FULL",
              "E_RATE_LIMITED", "E_CALLBACK_FORBIDDEN"]),
    "upload": dict(
        group="素材", scope="tenant", title="上传素材",
        desc="原始字节上传，按 sha256 落盘与寻址，天然去重。重复上传同一内容不重复计费。",
        params=[("X-Filename", "header", "用于推断扩展名；非法扩展名会退化为 .bin"),
                ("body", "binary", "原始字节，上限 RENDERD_MAX_UPLOAD_MB（默认 512）")],
        resp='''201 Created
{"asset_id": "asset_8f3d9d13546e", "sha256": "8f3d...",
 "uri": "upload:8f3d....mp4", "bytes": 5033074, "deduplicated": false}''',
        errs=["E_UPLOAD_TOO_LARGE", "E_QUOTA_STORAGE_EXCEEDED", "E_INPUT_UNREADABLE"]),
    "list_assets": dict(
        group="素材", scope="tenant", title="素材列表",
        desc="本租户引用的素材与占用。`charged_bytes=0` 表示命中去重：文件是别人写的，不收你的配额，"
             "但引用关系保留（否则对方删除会误删你在用的内容）。",
        params=[("limit", "int，默认 100", "上限 500")],
        resp='''{"assets": [{"asset_id": "asset_8f3d9d13546e", "sha256": "8f3d...",
   "bytes": 5033074, "charged_bytes": 5033074,
   "created_at": 1794192694.1, "last_seen": 1794192694.1}],
 "count": 1, "storage_used_bytes": 5033074, "storage_quota_bytes": 2147483648}''',
        errs=[]),
    "delete_asset": dict(
        group="素材", scope="tenant", title="删除素材（释放配额）",
        desc="解除本租户对素材的引用；最后一个引用消失时才删文件并退回配额。"
             "仍被 `accepted/running` 任务引用时拒绝。",
        params=[("asset_id", "path", "`asset_<sha12>` 或完整 sha256 前缀；匹配多个返回 409")],
        resp='''{"asset_id": "asset_8f3d9d13546e", "sha256": "8f3d...",
 "refunded_bytes": 5033074, "file_removed": true,
 "storage_used_bytes": 0}''',
        errs=["E_NOT_FOUND", "E_ASSET_IN_USE", "E_ASSET_AMBIGUOUS"]),
    "list_jobs": dict(
        group="查询", scope="tenant", title="任务列表",
        desc="按创建时间倒序，只返回本租户。",
        params=[("limit", "int，默认 50", "上限 200"), ("status", "string", "按状态过滤")],
        resp='''{"jobs": [{"id": "job_...", "status": "succeeded", "stage": "done",
  "attempts": 1, "created_at": 1794192694.1, "frames_total": 450,
  "cache_hit": 1, "cost_seconds": 12.4}]}''',
        errs=[]),
    "job": dict(
        group="查询", scope="tenant", title="任务状态",
        desc="轮询主入口。`stage` 比百分比有用：`ingesting` 失败是素材问题，`rendering` 失败是资源问题。"
             "成功时返回可直接打开的已签名 `video_url`。",
        params=[("id", "path", "job_id")],
        resp='''{"job_id": "job_...", "status": "running", "stage": "rendering",
 "attempts": 1, "max_attempts": 3, "frames_done": 128, "frames_total": 450,
 "progress": 0.2844, "elapsed_s": 6.2, "cache_hit": false,
 "video_url": "/v1/jobs/job_.../video?exp=...&sig=...&t=acme"}''',
        errs=["E_NOT_FOUND"]),
    "events": dict(
        group="查询", scope="tenant", title="阶段流水",
        desc="逐条事件：阶段、时间、消息，以及编译命令、缓存键、失败原因等细节。排障先看这里。",
        params=[("id", "path", "job_id")],
        resp='''{"events": [{"id": 12, "ts": 1794192694.1, "stage": "rendering",
  "level": "info", "message": "ffmpeg started"}, ...]}''',
        errs=["E_NOT_FOUND"]),
    "receipt": dict(
        group="查询", scope="tenant", title="证据回执",
        desc="Agent 看不见视频，回执是它唯一的判断依据。包含 L0 归一化决策单、L1 结构断言、"
             "L3 语义检查、每个证据文件的 sha256，以及已签名的证据链接。",
        params=[("id", "path", "job_id")],
        resp='''{"schema": "cutproof/receipt/v1", "verdict": "pass", "failures": [],
 "L0_ingest": {"actions": ["TONEMAP_HDR"], "note": "预览级 tone mapping"},
 "L1": {"structural": {"width": 1080, "height": 1920, "frames": 450}, "assertions": {}},
 "L3": {"font_coverage": {"ok": true}, "loudness": {"integrated_lufs": -14.0}},
 "evidence_sha256": {"contact_sheet": "...", "first_frame": "..."},
 "evidence": {"contact_sheet": "/v1/jobs/job_.../evidence/contact_sheet.jpg?exp=...&sig=...&t=acme"},
 "video_url": "/v1/jobs/job_.../video?exp=...&sig=...&t=acme"}''',
        errs=["E_NOT_FOUND"]),
    "video": dict(
        group="文件", scope="public+auth", title="下载成片",
        desc="两种方式：`Authorization: Bearer <token>`，或签名 URL（`exp` / `sig` / `t`）。"
             "签名绑定租户与用途，换 `t=`、改 job_id、拿成片签名取证据文件都会 401。",
        params=[("id", "path", "job_id"),
                ("exp", "query", "unix 秒，过期时间"),
                ("sig", "query", "HMAC-SHA256(secret, JSON([\"v2\",tenant,scope,job_id,exp]))[:32]"),
                ("t", "query", "租户名，必须与任务 owner 一致")],
        resp="200 OK, Content-Type: video/mp4（整文件下载，未实现 Range；需要断点续传请用 delivery.put_url 直传对象存储）",
        errs=["E_AUTH_REQUIRED", "E_NOT_FOUND"]),
    "evidence": dict(
        group="文件", scope="public+auth", title="下载证据文件",
        desc="`scope` 是 `evidence:<文件名>`。成片签名不能用来取这里的文件。成功下载会写 "
             "`audit(action=download.signed)`。",
        params=[("id", "path", "job_id"), ("name", "path", "文件名，路径穿越会被规范化丢弃")],
        resp="200 OK, image/jpeg / image/png",
        errs=["E_AUTH_REQUIRED", "E_NOT_FOUND"]),
    "cancel": dict(
        group="运维", scope="tenant", title="取消任务",
        desc="仅 `accepted`（排队中）可取消。运行中的任务不支持取消 —— 需要先做进程组管理，否则自动归还 running 会造成双领。",
        params=[("id", "path", "job_id")],
        resp='{"job_id": "job_...", "status": "cancelled"}',
        errs=["E_CANCELLED", "E_NOT_FOUND"]),
    "replay": dict(
        group="运维", scope="tenant", title="重放死信",
        desc="把 `failed` 任务就地改回 `accepted`，重置 attempts 与错误，不新建任务。"
             "若素材已被删除，会以 `E_MEDIA_MISSING` 失败。",
        params=[("id", "path", "job_id")],
        resp='{"job_id": "job_...", "status": "accepted", "attempts": 0, "replayed": true}',
        errs=["E_NOT_FOUND"]),
    "queue": dict(
        group="运维", scope="tenant/admin", title="队列视图",
        desc="容量信息对所有租户开放（判断要不要错峰需要它）；`inflight_by_tenant` 是运维视图 —— "
             "普通租户只看到自己（`scope=tenant`），`RENDERD_ADMIN_TOKENS` 才返回全量。",
        params=[],
        resp='''{"depth": 12, "ready": 10, "delayed": 2, "running": 3,
 "oldest_wait_s": 8.2, "failed_24h": 1, "clock_skew_s": null,
 "inflight_by_tenant": {"acme": 3}, "scope": "tenant",
 "max_queue_depth": 2000, "max_tenant_inflight": 8}''',
        errs=[]),
    "dlq": dict(
        group="运维", scope="tenant", title="死信列表",
        desc="本租户 `failed` 任务，按结束时间倒序。",
        params=[("limit", "int，默认 50", "上限 200")],
        resp='{"jobs": [{"id": "job_...", "error_code": "E_TIMEOUT", "attempts": 3}]}',
        errs=[]),
    "usage": dict(
        group="运维", scope="tenant", title="用量与配额",
        desc="本月渲染秒数、剩余分钟、QPS、素材数与存储占用。存储占用按**引用**求和：删素材即释放。",
        params=[],
        resp='''{"tenant": "acme", "period": "2026-11", "rendered_seconds": 4210.5,
 "jobs": 128, "monthly_quota_minutes": 1000, "remaining_minutes": 929.8,
 "qps": 5, "assets": 12, "storage_used_bytes": 5033074,
 "storage_quota_mb": 2048, "inflight": 2, "inflight_limit": 8}''',
        errs=[]),
}

GROUP_ORDER = ["公开", "渲染主链路", "素材", "查询", "文件", "运维"]
SCOPE_LABEL = {"public": "公开", "tenant": "租户令牌", "public+auth": "令牌或签名",
               "tenant/admin": "租户 / admin"}

CSS = """
:root{--paper:#f7f4ec;--card:#fffdf7;--ink:#1f1c17;--ink2:#4a453b;--ink3:#7d7668;
--rule:#dcd6c8;--acc:#b23a2b;--accs:#f7e6e1;--teal:#1d6f5c;--amber:#a97a1e;--code:#eee9dd}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;
font-size:15.5px;line-height:1.78;-webkit-font-smoothing:antialiased}
.layout{display:grid;grid-template-columns:266px minmax(0,1fr);max-width:1240px;margin:0 auto;
gap:0;padding:0 24px 100px}
nav{position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;padding:34px 18px 40px 0;
border-right:1px solid var(--rule)}
nav .brand{font-family:"Songti SC",Georgia,serif;font-size:19px;margin-bottom:4px}
nav .ver{font-size:11.5px;color:var(--ink3);letter-spacing:.08em;margin-bottom:22px}
nav .grp{font-size:11px;letter-spacing:.14em;color:var(--acc);font-weight:700;margin:20px 0 7px}
nav a{display:block;color:var(--ink2);text-decoration:none;font-size:13.5px;padding:3px 0 3px 8px;
border-left:2px solid transparent}
nav a:hover{color:var(--ink);border-left-color:var(--rule)}
nav a .m{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--ink3);margin-right:6px}
main{padding:34px 0 0 40px;min-width:0}
h1{font-family:"Songti SC",Georgia,serif;font-size:34px;line-height:1.24;margin:0 0 10px}
.lede{color:var(--ink2);max-width:760px;margin:0 0 18px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.pill{font-size:12px;border:1px solid var(--rule);background:var(--card);padding:3px 9px;border-radius:999px;
color:var(--ink2)}
.pill b{color:var(--ink)}
section{margin-top:46px;scroll-margin-top:16px}
h2{font-size:23px;font-family:"Songti SC",Georgia,serif;margin:0 0 6px;padding-top:14px;
border-top:2px solid var(--ink)}
h2 .num{font-size:12px;letter-spacing:.1em;color:var(--acc);margin-right:10px;vertical-align:3px;
font-family:-apple-system,sans-serif;font-weight:700}
h3{font-size:17.5px;margin:26px 0 8px}
p{margin:0 0 12px;color:var(--ink2)}
code{font-family:ui-monospace,Menlo,monospace;font-size:.86em;background:var(--code);
padding:1px 5px;border-radius:2px;color:#3a352c}
pre{background:var(--code);padding:13px 15px;border-radius:3px;overflow-x:auto;font-size:12.5px;
line-height:1.62;color:#3a352c;margin:0 0 14px}
pre code{background:none;padding:0;font-size:inherit}
table{border-collapse:collapse;width:100%;margin:6px 0 16px;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:11.5px;letter-spacing:.06em;color:var(--ink3);font-weight:700;white-space:nowrap}
td code{white-space:nowrap}
.ep{border:1px solid var(--rule);background:var(--card);margin:26px 0 0;scroll-margin-top:14px}
.ep .hd{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--rule)}
.ep .hd h3{margin:0;font-size:16.5px;flex:1}
.mth{font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;letter-spacing:.06em;
padding:3px 7px;border-radius:3px;color:#fff;background:var(--ink2)}
.mth.get{background:#2f6b5a}.mth.post{background:#8f5b1e}.mth.delete{background:#9c3225}
.path{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--ink)}
.ep .bd{padding:14px 16px 4px}
.scope{font-size:11.5px;color:var(--ink3)}
.chg{margin-top:50px;padding-top:18px;border-top:1px solid var(--rule);font-size:13px;color:var(--ink3)}
.note{background:var(--accs);border-left:3px solid var(--acc);padding:11px 14px;margin:14px 0;
font-size:13.5px;color:var(--ink2)}
@media(max-width:920px){.layout{grid-template-columns:1fr;padding:0 16px 60px}
nav{position:static;max-height:none;border-right:none;border-bottom:1px solid var(--rule);padding:22px 0 10px}
nav a{display:inline-block;margin-right:12px;border-left:none;border-bottom:2px solid transparent;padding:2px 0}
main{padding:22px 0 0}}
"""


def route_rows() -> str:
    rows = []
    for method, rx, name in ROUTES:
        e = E.get(name)
        if e is None:
            continue
        rows.append(f"<tr><td><span class='mth {method.lower()}'>{method}</span></td>"
                    f"<td><a href='#{esc(name)}'><code>{esc(rx.pattern.replace('^', '').replace('$', ''))}</code></a></td>"
                    f"<td>{esc(e['title'])}</td>"
                    f"<td class='scope'>{esc(SCOPE_LABEL.get(e['scope'], e['scope']))}</td></tr>")
    return "".join(rows)


def nav() -> str:
    out = ["<nav><div class='brand'>renderd 接口文档</div>"
           f"<div class='ver'>API v1 · {esc(__version__)}</div>"]
    out.append("<div class='grp'>开始</div>")
    for anchor, label in (("base", "基础约定"), ("quickstart", "三步跑通"),
                          ("errors", "错误码")):
        out.append(f"<a href='#{anchor}'>{label}</a>")
    for g in GROUP_ORDER:
        items = [(n, e) for n, e in E.items() if e["group"] == g]
        if not items:
            continue
        out.append(f"<div class='grp'>{esc(g)}</div>")
        for name, e in items:
            m = next((x[0] for x in ROUTES if x[2] == name), "")
            out.append(f"<a href='#{name}'><span class='m'>{esc(m)}</span>{esc(e['title'])}</a>")
    out.append("</nav>")
    return "".join(out)


def render_ep(name: str, e: dict) -> str:
    method = next((x[0] for x in ROUTES if x[2] == name), "GET")
    rx = next((x[1] for x in ROUTES if x[2] == name), None)
    path = rx.pattern.replace("^", "").replace("$", "") if rx else ""
    parts = [f"<div class='ep' id='{esc(name)}'>",
             f"<div class='hd'><span class='mth {method.lower()}'>{method}</span>"
             f"<span class='path'>{esc(path)}</span>"
             f"<h3>{esc(e['title'])}</h3></div><div class='bd'>",
             f"<p>{esc(e['desc'])}</p>"]
    if e["params"]:
        parts.append("<table><tr><th>参数</th><th>类型</th><th>说明</th></tr>")
        for a, b, c in e["params"]:
            parts.append(f"<tr><td><code>{esc(a)}</code></td><td>{esc(b)}</td><td>{esc(c)}</td></tr>")
        parts.append("</table>")
    if e.get("req"):
        parts.append("<pre><code>" + esc(e["req"]) + "</code></pre>")
    parts.append("<p style='font-size:12px;color:var(--ink3);margin-bottom:4px'>响应</p>")
    parts.append("<pre><code>" + esc(e["resp"]) + "</code></pre>")
    if e["errs"]:
        chips = " ".join(f"<code>{esc(x)}</code>" for x in e["errs"])
        parts.append(f"<p style='font-size:12.5px;color:var(--ink3)'>可能的错误：{chips}</p>")
    parts.append("</div></div>")
    return "".join(parts)


def error_table() -> str:
    rows = []
    for code, (retry, stage, status, msg) in sorted(ERROR_SPECS.items(),
                                                    key=lambda kv: (kv[1][2], kv[0])):
        rows.append(f"<tr><td><code>{esc(code)}</code></td><td>{status}</td>"
                    f"<td>{'是' if retry else '否'}</td><td>{esc(stage)}</td>"
                    f"<td>{esc(msg)}</td></tr>")
    return "".join(rows)


def main() -> int:
    undocumented = [x[2] for x in ROUTES if x[2] not in E]
    if undocumented:
        raise SystemExit(f"这些路由没有文档条目，先补 E 字典：{undocumented}")
    unused = [k for k in E if k not in {x[2] for x in ROUTES}]
    if unused:
        raise SystemExit(f"这些文档条目没有对应路由：{unused}")

    groups = []
    n = 0
    for g in GROUP_ORDER:
        items = [(name, e) for name, e in E.items() if e["group"] == g]
        if not items:
            continue
        n += 1
        body = "".join(render_ep(name, e) for name, e in items)
        groups.append(f"<section><h2><span class='num'>{n:02d}</span>{esc(g)}</h2>{body}</section>")

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>renderd 接口文档 v1</title>
<style>{CSS}</style></head><body>
<div class="layout">
{nav()}
<main>
<h1>渲染服务接口文档</h1>
<p class="lede">面向调用方（Agent / 业务后端）的 REST 契约。所有示例都是真实请求与响应；
错误码是契约，<code>message</code> 只是叙事 —— 请按 <code>code</code> 决策。</p>
<div class="meta">
  <span class="pill">Base URL <b>http://127.0.0.1:8787</b></span>
  <span class="pill">版本 <b>v1</b></span>
  <span class="pill">认证 <b>Bearer token</b></span>
  <span class="pill">编码 <b>UTF-8 / JSON</b></span>
</div>

<section id="base"><h2><span class="num">00</span>基础约定</h2>
<h3>鉴权</h3>
<p><code>Authorization: Bearer &lt;token&gt;</code>，token 与租户一一映射
（<code>RENDERD_TOKENS="token:tenant,token2:tenantB"</code>）。下载类端点额外支持签名 URL，
便于 Agent 直接取。<b>鉴权失败也有限速</b>：同一 IP 的无效令牌超过 <code>RENDERD_AUTH_FAIL_QPS</code>
（默认 10/s）返回 429。</p>

<h3>幂等</h3>
<p>提交必须带 <code>idempotency_key</code>（≥8 字符）。唯一约束是 <code>(tenant, key)</code>：
同 key 重复提交返回同一 <code>job_id</code> 且不二次计费；不同租户用同一个 key 互不影响。</p>

<h3>错误结构</h3>
<pre><code>{{"error": {{"code": "E_MEDIA_TOO_SHORT", "message": "...", "retryable": false,
          "stage": "ingesting", "field": "tracks[v1].clips",
          "allowed_values": ["out_frame <= 200"]}},
 "request_id": "9f3d2a1c"}}</code></pre>
<p><code>retryable=true</code> 才重试；<code>field</code> 指出改哪里，<code>allowed_values</code> 给出可接受范围。
完整列表见 <a href="#errors">错误码</a>。</p>

<h3>限流与背压</h3>
<table><tr><th>层</th><th>触发</th><th>返回</th></tr>
<tr><td>租户 QPS</td><td>1 秒滑动窗口（20 × 50ms 子桶）</td><td><code>429 E_RATE_LIMITED</code></td></tr>
<tr><td>认证失败</td><td>同 IP 无效令牌 &gt; 10/s</td><td><code>429 E_RATE_LIMITED</code></td></tr>
<tr><td>队列深度</td><td>全局排队数 ≥ <code>RENDERD_MAX_QUEUE_DEPTH</code></td><td><code>429 E_QUEUE_FULL</code></td></tr>
<tr><td>租户在途</td><td>该租户 accepted+running ≥ <code>RENDERD_MAX_TENANT_INFLIGHT</code></td><td><code>429 E_QUEUE_FULL</code></td></tr>
</table>

<h3>任务状态机</h3>
<pre><code>accepted → running → succeeded
    ↑          │
    └──────────┴─→ failed（可 replay）    accepted → cancelled</code></pre>
<p><code>stage</code>：<code>queued → ingesting → compiling → rendering → validating → delivering → done</code>。
阶段比百分比有用：<code>ingesting</code> 失败是素材问题，<code>rendering</code> 失败是资源问题。</p>
</section>

<section id="quickstart"><h2><span class="num">00</span>三步跑通</h2>
<pre><code># 1. 上传素材
curl -X POST $BASE/v1/assets -H "Authorization: Bearer $TOKEN" \\
     -H "X-Filename: clip.mp4" --data-binary @clip.mp4

# 2. 提交（idempotency_key 用你自己的任务号）
curl -X POST $BASE/v1/render -H "Authorization: Bearer $TOKEN" \\
     -H "Content-Type: application/json" -d '{{
       "idempotency_key": "order-001",
       "template_id": "hook_vertical_6s",
       "variables": {{"clip": "a0", "hook": "第一性原理"}},
       "assets": [{{"id": "a0", "uri": "upload:&lt;sha&gt;.mp4"}}]}}'

# 3. 轮询（成功后 video_url 可直接打开）
curl $BASE/v1/jobs/$JOB -H "Authorization: Bearer $TOKEN"</code></pre>
<p>更多可运行示例见 <code>renderd/README.md</code>。</p>
</section>

<section id="index"><h2><span class="num">01</span>端点总览</h2>
<p>下表由代码里的路由表生成 —— 不会漏，也不会多。</p>
<table><tr><th>方法</th><th>路径</th><th>说明</th><th>权限</th></tr>{route_rows()}</table>
</section>

{''.join(groups)}

<section id="errors"><h2><span class="num">99</span>错误码</h2>
<p>这张表由 <code>errors.ERROR_SPECS</code> 生成，与代码同源。</p>
<table><tr><th>code</th><th>HTTP</th><th>可重试</th><th>阶段</th><th>含义</th></tr>
{error_table()}</table>
</section>

<div class="chg">
生成于 {esc(__import__("datetime").date.today().isoformat())} · 由 <code>make_api_doc.py</code> 渲染<br>
相关文档：<code>docs/API.md</code>（文字版）· <code>docs/IR.md</code>（时间线格式）·
<code>docs/OPS.md</code>（部署运维）· <code>docs/SECURITY.md</code>（威胁模型）
</div>
</main></div></body></html>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(doc, encoding="utf-8")
    print(f"→ {OUT}  ({len(doc)} bytes, {len(E)} 个端点)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
