#!/usr/bin/env python3
"""nginx 性能日志 → 延迟分布报告。

配套的 nginx 配置（`docs/剪辑架构.md` §九）：

    log_format cutduo_perf escape=json '{"ts":"$time_iso8601","ip":"$remote_addr",
      "m":"$request_method","uri":"$request_uri","st":$status,"rt":$request_time,
      "urt":"$upstream_response_time","uct":"$upstream_connect_time",
      "body":$body_bytes_sent,"req":$request_length,"ua":"$http_user_agent"}';
    access_log /www/wwwlogs/mcp.cutduo.com.perf.log cutduo_perf;

为什么需要它：默认 access_log 只有状态码和字节数，回答不了「慢在哪一层」。
`rt` 是客户端感知的端到端耗时，`urt` 才是应用处理耗时 —— 两者的差额是
TLS + 网络 + 客户端上行，把它算进服务端性能是常见的误判来源。

用法：
    python3 tests/perf_report.py                          # 最近 30 分钟
    python3 tests/perf_report.py --since 120 --top 20
    python3 tests/perf_report.py --log /tmp/perf.log --json out.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

DEFAULT_LOG = "/www/wwwlogs/mcp.cutduo.com.perf.log"

# /v1/jobs/job_abc123/video → /v1/jobs/{id}/video，否则每个任务一行，分布没意义
_ID = re.compile(r"(job_[0-9a-f]{6,}|[0-9a-f]{32})")


def norm_uri(uri: str) -> str:
    uri = uri.split("?")[0]
    uri = _ID.sub("{id}", uri)
    return uri.rstrip("/") or "/"


def pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * q))]


def load(path: Path, since_min: int | None, skip_ua: str | None) -> list[dict]:
    if not path.exists():
        sys.exit(f"日志不存在: {path}")
    cutoff = datetime.now().astimezone() - timedelta(minutes=since_min) if since_min else None
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if skip_ua and str(r.get("ua", "")).startswith(skip_ua):
            continue
        if cutoff:
            try:
                ts = datetime.fromisoformat(r["ts"])
            except (KeyError, ValueError):
                continue
            if ts < cutoff:
                continue
        # nginx 在解析请求行之前就返回 400 时，$request_method 和 $uri 都是空串
        r["ep"] = f'{r.get("m") or "-"} {norm_uri(r.get("uri") or "/")}'
        rows.append(r)
    return rows


def upstream(r: dict) -> list[float]:
    """$upstream_response_time 在多级代理下是逗号分隔的链，取最后一个（最近一跳）。"""
    out = []
    for part in str(r.get("urt", "")).split(","):
        part = part.strip()
        if part and part != "-":
            try:
                out.append(float(part))
            except ValueError:
                pass
    return out


def report(rows: list[dict], top: int) -> dict:
    by_ep: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_ep[r["ep"]].append(r)

    eps = []
    for ep, rs in sorted(by_ep.items(), key=lambda kv: -len(kv[1])):
        rt = sorted(float(x.get("rt") or 0) for x in rs)
        ur = sorted(u for x in rs for u in upstream(x))
        eps.append({
            "endpoint": ep,
            "n": len(rs),
            "p50_ms": round(pct(rt, 0.50) * 1000, 1),
            "p95_ms": round(pct(rt, 0.95) * 1000, 1),
            "p99_ms": round(pct(rt, 0.99) * 1000, 1),
            "max_ms": round(rt[-1] * 1000, 1),
            "upstream_p50_ms": round(pct(ur, 0.50) * 1000, 1) if ur else None,
            "status": dict(sorted({s: sum(1 for x in rs if x.get("st") == s)
                                   for s in {x.get("st") for x in rs}}.items())),
        })

    uploads = [{
        "ts": x.get("ts", "")[11:19],
        "mb": round(int(x.get("req") or 0) / 1048576, 2),
        "client_s": round(float(x.get("rt") or 0), 2),
        "server_s": round((upstream(x) or [0])[-1], 3),
        "up_mbps": round((int(x.get("req") or 0) / 1048576) / max(float(x.get("rt") or 1), 1e-6), 2),
    } for x in rows if x.get("m") == "POST" and norm_uri(x.get("uri", "")) == "/v1/assets"]

    return {
        "window": [rows[0].get("ts", "")[11:19], rows[-1].get("ts", "")[11:19]] if rows else ["", ""],
        "total": len(rows),
        "status": {str(k): v for k, v in sorted(
            {s: sum(1 for r in rows if r.get("st") == s) for s in {r.get("st") for r in rows}}.items())},
        "endpoints": eps[:top],
        "uploads": uploads,
    }


def render(rep: dict) -> str:
    L = [f"窗口 {rep['window'][0]} → {rep['window'][1]}   请求 {rep['total']}", ""]
    L.append(f"{'端点':<34}{'n':>4}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>9}{'上游p50':>10}  状态")
    L.append("-" * 92)
    for e in rep["endpoints"]:
        up = f"{e['upstream_p50_ms']:>7.0f}ms" if e["upstream_p50_ms"] is not None else " " * 9
        L.append(f"{e['endpoint']:<34}{e['n']:>4}{e['p50_ms']:>7.0f}ms{e['p95_ms']:>7.0f}ms"
                 f"{e['p99_ms']:>7.0f}ms{e['max_ms']:>7.0f}ms{up:>10}  {e['status']}")
    if rep["uploads"]:
        L += ["", "上传（client_s 含客户端上行，server_s 才是服务端）"]
        for u in rep["uploads"]:
            L.append(f"  {u['ts']}  {u['mb']:>5.2f}MB  client={u['client_s']:>5.2f}s  "
                     f"server={u['server_s']:>6.3f}s  上行 {u['up_mbps']:.2f} MB/s")
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser(description="nginx 性能日志延迟分布")
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--since", type=int, default=30, help="只看最近 N 分钟（0 表示全部）")
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--skip-ua", default=None, help="排除某类探针流量，如 mon-probe")
    ap.add_argument("--json", default=None, help="同时写出 JSON")
    a = ap.parse_args()

    rows = load(Path(a.log), a.since or None, a.skip_ua)
    if not rows:
        sys.exit("没有匹配的记录（窗口内无流量？）")
    rep = report(rows, a.top)
    print(render(rep))
    if a.json:
        Path(a.json).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nJSON → {a.json}", file=sys.stderr)


if __name__ == "__main__":
    main()
