"""命令行入口。

  renderd serve      起 HTTP 服务（可带内联 worker）
  renderd worker     只跑 worker（拉取式）
  renderd render     一次性本地渲染（不走队列，用于调试）
  renderd templates  列模板
  renderd tenant     建租户 / 改配额
  renderd gc         清理过期产物（默认 dry-run）
  renderd mcp        MCP stdio 服务
  renderd doctor     环境自检
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from . import __version__, compile_ffmpeg, compile_mlt, fonts, ir as IR, render, textlayer, validate
from .config import load_config
from .errors import JobError
from .fixtures import ensure_media
from .service import Service
from .store import Store
from .templates import TemplateRegistry


def _svc(args) -> Service:
    cfg = load_config(args.data_dir)
    return Service(cfg)


def cmd_serve(args) -> int:
    from .api import start
    cfg = load_config(args.data_dir)
    os.environ.setdefault("RENDERD_PORT", str(args.port))
    cfg.api_host, cfg.api_port = args.host, args.port
    start(cfg, with_workers=args.workers)
    return 0


def cmd_worker(args) -> int:
    from .api import log
    from .worker import Worker
    cfg = load_config(args.data_dir)
    svc = Service(cfg)
    svc.ensure_tenant(args.tenant)
    w = Worker(cfg, svc.store, svc.runner, name=args.name)
    log(f"worker {w.name} 启动，并发 {args.concurrency}，数据 {cfg.data_dir}")
    done = w.run_forever(max_jobs=args.max_jobs)
    log(f"worker 退出，共处理 {done} 条")
    return 0


def cmd_render(args) -> int:
    """一次性渲染：提交后立刻自己跑，不依赖 worker。"""
    svc = _svc(args)
    payload = json.loads(Path(args.input).read_text()) if args.input else {}
    if args.template:
        payload.update({"template_id": args.template})
    if args.assets:
        payload["assets"] = json.loads(args.assets)
    if args.vars:
        payload["variables"] = json.loads(args.vars)
    payload.setdefault("idempotency_key", f"cli-{int(time.time() * 1000)}")
    tenant = args.tenant
    svc.ensure_tenant(tenant)
    out = svc.submit(payload, tenant)
    job_id = out["job_id"]
    from .worker import Worker
    Worker(svc.cfg, svc.store, svc.runner, name="cli").run_once()
    job = svc.store.get(job_id)
    status = svc.status(job_id, tenant)
    print(json.dumps(status, ensure_ascii=False, indent=2))
    if job["status"] == "succeeded":
        print(f"\n成片: {job['output_path']}")
        print(f"回执: {job['receipt_path']}")
        return 0
    return 1


def cmd_templates(args) -> int:
    reg = TemplateRegistry(load_config(args.data_dir).template_dir)
    tpls = reg.list()
    if args.json:
        print(json.dumps(tpls, ensure_ascii=False, indent=2))
        return 0
    for t in tpls:
        print(f"{t['id']:24} {t['aspect']:5} {t['duration_s']:5.1f}s "
              f"{t['resolution'][0]}x{t['resolution'][1]}  {t['description']}")
        for v in t["variables"]:
            req = "必填" if v.get("required", True) else "可选"
            extra = f" ≤{v['max_chars']}字" if v.get("max_chars") else ""
            print(f"    - {v['name']:10} {v['type']:9} {req}{extra}")
    return 0


def cmd_tenant(args) -> int:
    svc = _svc(args)
    if args.name:
        t = svc.store.ensure_tenant(
            args.name, monthly_minutes=args.minutes or 1000,
            qps=args.qps or 10,
            storage_mb=args.storage_mb or svc.cfg.default_storage_mb)
    else:
        t = svc.store.set_quota(args.id, args.minutes, args.qps, args.storage_mb)
    if not t:
        print(f"租户不存在: {args.id}", file=sys.stderr)
        return 1
    print(json.dumps(t, ensure_ascii=False, indent=2))
    return 0


def cmd_queue(args) -> int:
    svc = _svc(args)
    print(json.dumps(svc.store.queue_stats(), ensure_ascii=False, indent=2))
    return 0


def cmd_dlq(args) -> int:
    svc = _svc(args)
    rows = svc.store.dlq(args.tenant, args.limit)
    print(json.dumps({"count": len(rows), "jobs": rows}, ensure_ascii=False, indent=2))
    return 0


def cmd_replay(args) -> int:
    svc = _svc(args)
    row = svc.store.replay(args.job_id, args.tenant)
    if not row:
        print(f"死信中找不到可重放任务: {args.job_id}", file=sys.stderr)
        return 1
    print(json.dumps({"job_id": row["id"], "status": row["status"],
                      "attempts": row["attempts"]}, ensure_ascii=False, indent=2))
    return 0


def cmd_release(args) -> int:
    """运维主动归还失联 worker 的任务。确认进程已退出后才用。"""
    svc = _svc(args)
    ids = svc.store.release_worker(args.worker)
    print(json.dumps({"worker": args.worker, "released": len(ids), "jobs": ids},
                     ensure_ascii=False, indent=2))
    return 0


def cmd_gc(args) -> int:
    svc = _svc(args)
    if args.assets:
        res = svc.store.gc_assets(older_than_s=args.older_days * 86400,
                                  dry_run=not args.apply)
    else:
        res = svc.store.gc(older_than_s=args.older_days * 86400, dry_run=not args.apply)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    if res["dry_run"]:
        print("\n这是 dry-run。加 --apply 才会真的删除（不可逆）。")
    return 0


def cmd_assets(args) -> int:
    svc = _svc(args)
    print(json.dumps(svc.assets(args.tenant, args.limit), ensure_ascii=False, indent=2))
    return 0


def cmd_mcp(args) -> int:
    from .mcp_stdio import MCPServer
    svc = _svc(args)
    MCPServer(svc, tenant=args.tenant).serve_forever()
    return 0


def cmd_reaper(args) -> int:
    """只跑租约回收。给「API 与 worker 完全分离」的部署用。"""
    import time
    from .api import log
    from .worker import start_reaper
    cfg = load_config(args.data_dir)
    svc = Service(cfg)
    log(f"reaper 启动，租约 {cfg.lease_s}s，每 {max(5.0, min(30.0, cfg.lease_s/3)):.0f}s 扫一次")
    _t, stop = start_reaper(svc.store, cfg)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop.set()
        log("reaper 退出")
    return 0


def cmd_doctor(args) -> int:
    cfg = load_config(args.data_dir)
    checks: list[tuple[str, bool, str]] = []
    checks.append(("python>=3.11", sys.version_info >= (3, 11), sys.version.split()[0]))
    try:
        import sqlite3
        checks.append(("sqlite>=3.35 (UPDATE RETURNING)",
                       tuple(int(x) for x in sqlite3.sqlite_version.split(".")[:2]) >= (3, 35),
                       sqlite3.sqlite_version))
    except Exception as exc:
        checks.append(("sqlite", False, str(exc)))
    try:
        import PIL
        checks.append(("pillow", True, PIL.__version__))
    except Exception:
        checks.append(("pillow", False, "缺失：文字图层无法栅格化"))

    try:
        from . import auth
        src = auth.init_secret(cfg.data_dir)
        st = auth.secret_status()
        checks.append(("signing secret 非弱值", not st["weak"], f"source={src}"))
    except RuntimeError as exc:
        checks.append(("signing secret 非弱值", False, str(exc)[:110]))
    checks.append(("state backend", True,
                   "postgres" if os.environ.get("RENDERD_DB_DSN") else "sqlite"))
    try:
        from . import auth as _auth
        a = _auth.Auth.from_env()
        raw_admin = [x.strip() for x in os.environ.get("RENDERD_ADMIN_TOKENS", "").split(",")
                     if x.strip()]
        unknown = [t for t in raw_admin if t not in a.tokens]
        checks.append(("admin token 是 tokens 子集", not unknown,
                       f"{len(a.admin_tokens)} admin" if not unknown
                       else f"{len(unknown)} 个未在 RENDERD_TOKENS 中"))
    except Exception as exc:
        checks.append(("admin token 是 tokens 子集", False, str(exc)[:110]))

    ver = render.ffmpeg_version(cfg.ffmpeg)
    checks.append(("ffmpeg", ver != "unknown", ver))
    try:
        import subprocess
        p = subprocess.run([cfg.ffmpeg, "-hide_banner", "-encoders"],
                           capture_output=True, text=True, timeout=30)
        for name in ("libx264", "aac"):
            checks.append((f"encoder {name}", name in (p.stdout or ""), ""))
    except Exception as exc:
        checks.append(("encoders", False, str(exc)))
    try:
        idx = fonts.font_index()
        checks.append(("fonts", len(idx) > 0, f"{len([k for k in idx if '/' not in k])} families"))
    except Exception as exc:
        checks.append(("fonts", False, str(exc)))

    width = max(len(c[0]) for c in checks)
    ok = True
    for name, passed, detail in checks:
        ok = ok and passed
        print(f"  {'✓' if passed else '✗'} {name:<{width}}  {detail}")
    print(f"\n数据目录: {cfg.data_dir.resolve()}")
    return 0 if ok else 1


def cmd_bench(args) -> int:
    """快速基准：用内置素材跑三种模板，报实时倍数。"""
    cfg = load_config(args.data_dir)
    svc = Service(cfg)
    svc.ensure_tenant("bench")
    media = ensure_media(cfg.media_dir)
    F = lambda k: "file://" + media[k]
    cases = [
        ("hook_vertical_6s", {"clip": "a1", "hook": "基准测试"},
         [{"id": "a1", "uri": F("v_a.mp4")}]),
        ("brand_vertical_15s",
         {"clip1": "a1", "clip2": "b1", "clip3": "c1", "title": "基准测试", "music": "m1"},
         [{"id": "a1", "uri": F("v_a.mp4")}, {"id": "b1", "uri": F("v_b.mp4")},
          {"id": "c1", "uri": F("v_c.mp4")}, {"id": "m1", "uri": F("music.m4a")}]),
    ]
    from .worker import Worker
    rows = []
    for tpl, vars_, assets in cases:
        st = svc.store
        st._conn().execute("DELETE FROM render_cache")
        payload = {"template_id": tpl, "variables": vars_, "assets": assets,
                   "idempotency_key": f"bench-{tpl}-{int(time.time()*1000)}"}
        out = svc.submit(payload, "bench")
        t0 = time.time()
        Worker(cfg, st, svc.runner, name="bench").run_once()
        dt = time.time() - t0
        job = st.get(out["job_id"])
        dur = job["frames_total"] / 30.0
        rows.append((tpl, dur, dt, job["status"]))
        print(f"  {tpl:22} {dur:5.1f}s 成片 → {dt:5.2f}s  ({dur/dt:5.2f}× 实时)  {job['status']}")
    ok = all(r[3] == "succeeded" for r in rows)
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="renderd", description="商业级视频渲染服务")
    ap.add_argument("--version", action="version", version=f"renderd {__version__}")
    ap.add_argument("--data-dir", default=os.environ.get("RENDERD_DATA_DIR", "var"))
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("serve", help="起 HTTP 服务")
    p.add_argument("--host", default=os.environ.get("RENDERD_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("RENDERD_PORT", 8787)))
    p.add_argument("--workers", type=int, default=0, help="内联 worker 数")
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("worker", help="只跑 worker")
    p.add_argument("--tenant", default="default")
    p.add_argument("--name", default=None)
    p.add_argument("--concurrency", type=int, default=1)
    p.add_argument("--max-jobs", type=int, default=None)
    p.set_defaults(fn=cmd_worker)

    p = sub.add_parser("render", help="一次性本地渲染")
    p.add_argument("--template", default=None)
    p.add_argument("--vars", default=None, help="变量 JSON")
    p.add_argument("--assets", default=None, help="素材 JSON")
    p.add_argument("--input", default=None, help="完整请求 JSON 文件")
    p.add_argument("--tenant", default="cli")
    p.set_defaults(fn=cmd_render)

    p = sub.add_parser("templates", help="列模板")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_templates)

    p = sub.add_parser("tenant", help="建租户或改配额")
    p.add_argument("--id", default=None)
    p.add_argument("--name", default=None)
    p.add_argument("--minutes", type=int, default=None)
    p.add_argument("--qps", type=int, default=None)
    p.add_argument("--storage-mb", type=int, default=None)
    p.set_defaults(fn=cmd_tenant)

    p = sub.add_parser("queue", help="打印队列统计（深度/等待/在途）")
    p.set_defaults(fn=cmd_queue)

    p = sub.add_parser("dlq", help="列出死信任务")
    p.add_argument("--tenant", default=None)
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(fn=cmd_dlq)

    p = sub.add_parser("replay", help="重放死信任务")
    p.add_argument("--job-id", required=True)
    p.add_argument("--tenant", default=None)
    p.set_defaults(fn=cmd_replay)

    p = sub.add_parser("release", help="主动归还失联 worker 的任务")
    p.add_argument("--worker", required=True)
    p.set_defaults(fn=cmd_release)

    p = sub.add_parser("gc", help="清理过期产物 / 孤儿素材")
    p.add_argument("--older-days", type=float, default=7)
    p.add_argument("--assets", action="store_true",
                   help="只清理没有任何任务引用的孤儿素材")
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_gc)

    p = sub.add_parser("assets", help="列出租户的素材引用与占用")
    p.add_argument("--tenant", required=True)
    p.add_argument("--limit", type=int, default=100)
    p.set_defaults(fn=cmd_assets)

    p = sub.add_parser("mcp", help="MCP stdio 服务")
    p.add_argument("--tenant", default="mcp")
    p.set_defaults(fn=cmd_mcp)

    p = sub.add_parser("reaper", help="只跑租约回收")
    p.set_defaults(fn=cmd_reaper)

    p = sub.add_parser("doctor", help="环境自检")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("bench", help="快速基准")
    p.set_defaults(fn=cmd_bench)

    args = ap.parse_args(argv)
    if getattr(args, "id", None) is None and args.cmd == "tenant":
        args.id = args.name
    try:
        return args.fn(args)
    except JobError as exc:
        print(json.dumps({"error": exc.to_dict()}, ensure_ascii=False, indent=2),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
