"""成片交付：默认落本地卷，可选直传到客户自己的对象存储（预签名 PUT URL）。

第一性原理重算里算过：出口带宽占直接成本的 61%，是最大的一项。
让成片从渲染节点直传客户 bucket，服务端不经手出网流量，这一项直接归零。
因此这里刻意不做「我方托管下载」之外的复杂对象存储 SDK —— 客户给一个
预签名 PUT URL，我们 PUT 上去，receipt 里记证据，就够了。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from . import netguard
from .config import Config


def parse_spec(payload: dict, cfg: Config) -> dict | None:
    """提交时校验 delivery 声明，并把解析到的公网 IP 钉进 spec。"""
    spec = payload.get("delivery")
    if not spec:
        return None
    if not isinstance(spec, dict):
        from .errors import JobError
        raise JobError("E_BAD_REQUEST", "delivery 必须是对象", field="delivery")
    # 兼容 P0 契约里预留的 delivery.egress 枚举：
    #   platform ↔ local（我方托管签名 URL），customer_bucket ↔ put_url（直传客户 OSS）
    mode = spec.get("mode")
    if not mode:
        mode = ("put_url" if spec.get("egress") == "customer_bucket" else "local")
    if mode == "local":
        return {"mode": "local", "egress": "platform"}
    if mode != "put_url":
        from .errors import JobError
        raise JobError("E_BAD_REQUEST", f"未知交付模式: {mode}",
                       field="delivery.mode", allowed_values=["local", "put_url"])
    url = spec.get("url")
    if not isinstance(url, str) or not url:
        from .errors import JobError
        raise JobError("E_BAD_REQUEST", "put_url 模式需要 url", field="delivery.url")
    # 头净化必须在准入期，且排在 SSRF 解析之前：格式错误不需要联网就能判定，
    # 先拒能给出确定、可执行的错误，而不是被 DNS 结果掩盖。
    from .errors import JobError
    if spec.get("headers") is not None and not isinstance(spec["headers"], dict):
        raise JobError("E_BAD_REQUEST", "delivery.headers 必须是对象",
                       field="delivery.headers")
    try:
        clean_headers = netguard.sanitize_headers(spec.get("headers"))
    except ValueError as exc:
        raise JobError("E_BAD_REQUEST", str(exc), field="delivery.headers",
                       hint="头名用 HTTP token 字符；值不能含 CRLF / 控制字符；"
                            "Host、Content-Length 等由服务端构造，不可覆盖")
    pin = netguard.resolve_pinned(url, allow_private=cfg.allow_private_callbacks)
    # 只保留必要的字段，URL 里可能带签名参数，原样留着用于投递
    return {"mode": "put_url", "egress": "customer_bucket", "url": url, "pin": pin,
            "headers": clean_headers}


def push(job: dict, out_path: Path, cfg: Config, store=None) -> dict:
    """渲染成功后调用。失败不阻断任务成功，但必须留痕。"""
    raw = job.get("delivery_json")
    if not raw:
        return {"mode": "local", "status": "skipped",
                "note": "成片保留在服务本地卷，通过签名 URL 下载"}
    try:
        spec = json.loads(raw)
    except Exception:
        return {"mode": "local", "status": "skipped", "note": "delivery 声明无法解析"}
    if spec.get("mode") != "put_url":
        return {"mode": "local", "status": "skipped"}

    pin = spec.get("pin") or {}
    result: dict = {"mode": "put_url",
                    "egress": spec.get("egress") or "customer_bucket",
                    "host": pin.get("host"),
                    "target_bytes": out_path.stat().st_size if out_path.exists() else 0}
    try:
        netguard.revalidate_pin(pin, allow_private=cfg.allow_private_callbacks)
        extra = dict(spec.get("headers") or {})
        extra.setdefault("Content-Type", "video/mp4")
        body = out_path.read_bytes()
        t0 = time.time()
        status, line = netguard.pinned_request(
            pin, method="PUT", data=body, headers=extra, timeout=30.0)
        result.update({
            "http_status": status,
            "status": "delivered" if 200 <= status < 300 else "rejected",
            "elapsed_s": round(time.time() - t0, 2),
            "response_line": line[:120],
        })
    except Exception as exc:
        result.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:300]})

    if store:
        try:
            store.event(job["id"], "delivering",
                         f"delivery put_url {result['status']} "
                         f"http={result.get('http_status')}", level="info"
                         if result.get("status") == "delivered" else "warn",
                         data={"delivery": result})
        except Exception:
            pass
    return result
