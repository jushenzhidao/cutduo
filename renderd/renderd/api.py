"""REST API（stdlib http.server）。

不引框架的理由：这个服务的瓶颈在 ffmpeg 子进程，不在 HTTP 层；
少一个依赖就少一处部署风险。路由与错误契约在这里集中，业务在 service.py。
"""

from __future__ import annotations

import ipaddress
import json
import mimetypes
import os
import re
import signal
import socket
import ssl
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import auth, __version__
from .config import Config, load_config
from .errors import JobError
from .mcp_stdio import MCPServer
from .service import Service
from .worker import Worker, start_reaper

ROUTES = [
    ("GET", re.compile(r"^/healthz$"), "health"),
    ("GET", re.compile(r"^/readyz$"), "ready"),
    ("GET", re.compile(r"^/metrics$"), "metrics"),
    ("GET", re.compile(r"^/v1/templates$"), "templates"),
    ("POST", re.compile(r"^/v1/validate$"), "validate"),
    ("POST", re.compile(r"^/v1/render$"), "submit"),
    ("POST", re.compile(r"^/v1/assets$"), "upload"),
    ("GET", re.compile(r"^/v1/assets$"), "list_assets"),
    ("DELETE", re.compile(r"^/v1/assets/([A-Za-z0-9_.-]+)$"), "delete_asset"),
    ("GET", re.compile(r"^/v1/jobs$"), "list_jobs"),
    ("GET", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)$"), "job"),
    ("GET", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)/events$"), "events"),
    ("GET", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)/receipt$"), "receipt"),
    ("GET", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)/video$"), "video"),
    ("GET", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)/evidence/([A-Za-z0-9_.-]+)$"), "evidence"),
    ("POST", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)/cancel$"), "cancel"),
    ("POST", re.compile(r"^/v1/jobs/([A-Za-z0-9_]+)/replay$"), "replay"),
    ("GET", re.compile(r"^/v1/queue$"), "queue"),
    ("GET", re.compile(r"^/v1/dlq$"), "dlq"),
    ("GET", re.compile(r"^/v1/usage$"), "usage"),
    # MCP over Streamable HTTP：与 stdio 共用 MCPServer.handle()，只是换了传输
    ("POST", re.compile(r"^/mcp$"), "mcp"),
    ("GET", re.compile(r"^/mcp$"), "mcp_probe"),
]


def log(msg: str, *extra) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", *extra, flush=True)


_KV_SAFE = re.compile(r"^[A-Za-z0-9._:/+@-]+$")


def _kv(key: str, value) -> str:
    """logfmt 字段。值里有空格/引号就加引号，保证一行一条、可直接 grep。

    选 logfmt 而不是 JSON：人用眼睛能读，Agent 用正则能切，日志采集器也都认。
    JSON 行虽然更规范，但在这类"一行一次调用"的场景里噪音更大。
    """
    s = "-" if value is None or value == "" else str(value)
    if _KV_SAFE.match(s):
        return f"{key}={s}"
    return f'{key}="{s.replace(chr(34), chr(39))}"'


def _valid_net(c: str) -> bool:
    try:
        ipaddress.ip_network(c, strict=False)
        return True
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    service: Service
    server_version = f"renderd/{__version__}"
    protocol_version = "HTTP/1.1"

    # ── 基础 ─────────────────────────────────────────────
    def log_message(self, fmt: str, *args) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def _json(self, status: int, obj, extra_headers: dict | None = None) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Renderd-Version", __version__)
        # 回给客户端的关联 ID：报障时对方贴出这个值，运维直接 grep 就能定位到那一行。
        self.send_header("X-Request-Id", self._rid())
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        if self.close_connection:
            self.send_header("Connection", "close")
        try:
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _sse(self, items: list) -> None:
        """按 Streamable HTTP 的 SSE 模式回包：每条 JSON-RPC 一帧，发完即关流。

        不做「先发通知、再发结果」的交错流 —— 本服务的工具要么立刻返回句柄
        （submit_render），要么本身就是毫秒级（list_templates / validate_render），
        流里没有中间事件可发。等将来加 `notifications/progress` 才需要。

        json.dumps 会把换行转义成 \\n，所以每帧的 data 一定是单行，
        不需要按 SSE 规范做多行 data: 前缀。
        """
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        # 反代默认会缓冲响应，SSE 必须显式关掉，否则客户端等到流结束才收到内容
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Renderd-Version", __version__)
        self.send_header("X-Request-Id", self._rid())
        self.end_headers()
        try:
            for item in items:
                payload = json.dumps(item, ensure_ascii=False)
                self.wfile.write(f"event: message\ndata: {payload}\n\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, err: JobError) -> None:
        # 401/413 往往发生在读 body 之前。HTTP/1.1 长连接下，未消费的请求体
        # 会被当成下一个请求的起始行来解析（实测容器里出现 "Bad request version"）。
        # 这类响应一律关连接，宁可多一次握手，也不要把字节流错位。
        if not getattr(self, "_body_read", True):
            length = int(self.headers.get("Content-Length") or 0)
            if length > 0:
                self.close_connection = True
        # 统一出口的失败也要留痕：401/429/413 这些最常被客户问到的问题，
        # 只有一行工作日志的话根本查不到租户和来源 IP。
        log(" ".join(["req-fail", _kv("rid", self._rid()),
                      _kv("path", urlparse(self.path).path),
                      _kv("status", err.http_status), _kv("code", err.code),
                      _kv("peer", self._client_ip())]))
        self._json(err.http_status, {"error": err.to_dict(), "request_id": self._rid()})

    def _rid(self) -> str:
        return getattr(self, "_request_id", "-")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._body_read = True
            return {}
        limit = self.service.cfg.max_json_mb * 1024 * 1024
        if length > limit:
            # 先把 body 读掉再回 413：直接关连接会让客户端在发送途中被 RST，
            # 连错误码都读不到。丢弃上限设成 8×，超过就直接断，防内存/带宽耗尽。
            self.close_connection = True
            self._drain(min(length, limit * 8))
            raise JobError("E_PAYLOAD_TOO_LARGE",
                           f"请求体 {length} 字节超过上限 {self.service.cfg.max_json_mb}MB",
                           allowed_values=[f"<= {limit}"])
        raw = self.rfile.read(length)
        self._body_read = True
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise JobError("E_BAD_REQUEST", f"JSON 解析失败: {exc}")
        except (UnicodeDecodeError, ValueError) as exc:
            raise JobError("E_BAD_REQUEST", f"请求体不是合法 UTF-8: {type(exc).__name__}")
        except RecursionError:
            raise JobError("E_BAD_REQUEST", "JSON 嵌套过深")

    def _drain(self, n: int) -> None:
        """丢弃 n 字节请求体，分块读，不驻留内存。"""
        remaining = n
        while remaining > 0:
            chunk = self.rfile.read(min(64 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else ""

    def _tenant(self) -> str:
        return self.service.admit(self.headers.get("Authorization"), self._client_ip())

    def _principal(self) -> tuple[str, bool]:
        return self.service.admit_principal(self.headers.get("Authorization"),
                                            self._client_ip())

    # ── 分发 ─────────────────────────────────────────────
    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_HEAD(self) -> None:
        self._dispatch("GET")

    def do_PUT(self) -> None:
        self._method_not_allowed()

    def do_PATCH(self) -> None:
        self._method_not_allowed()

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        self._error(JobError("E_METHOD_NOT_ALLOWED",
                             f"{self.command} 不支持该路径；"
                             f"可用方法见 docs/API.md"))

    def _dispatch(self, method: str) -> None:
        # 请求级清理：短命 HTTP 线程的 SQLite 连接必须在这里显式关闭，
        # 否则 threading.local 里的连接靠 GC 回收，会随请求数线性累积 fd 与内存。
        try:
            self._dispatch_inner(method)
        finally:
            try:
                self.service.store.close_thread_connection()
            except Exception:
                pass

    def _dispatch_inner(self, method: str) -> None:
        self._request_id = os.urandom(4).hex()
        self._body_read = False
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        for m, rx, name in ROUTES:
            if m != method:
                continue
            match = rx.match(path)
            if not match:
                continue
            try:
                getattr(self, f"h_{name}")(*match.groups(), qs=parse_qs(parsed.query))
            except JobError as exc:
                self._error(exc)
            except (BrokenPipeError, ConnectionResetError):
                # 客户端中途断开不是服务错误：不要记 500，也不要打栈
                pass
            except Exception as exc:  # pragma: no cover
                log(f"unhandled {type(exc).__name__}: {exc}")
                self._error(JobError("E_INTERNAL", f"{type(exc).__name__}: {exc}"))
            return
        if method == "DELETE":
            # DELETE 只在 /v1/assets/{id} 上存在；别处仍然是「方法不允许」，
            # 而不是「资源不存在」—— 后者会让客户端以为路径写错了。
            self._method_not_allowed()
            return
        self._json(404, {"error": {"code": "E_NOT_FOUND", "message": f"无此路由: {path}",
                                   "retryable": False}})

    # ── 公开端点 ──────────────────────────────────────────
    def h_health(self, **_) -> None:
        self._json(200, self.service.health())

    def h_ready(self, **_) -> None:
        """就绪探针。免鉴权（负载均衡打不进来就没意义），但不吐内部细节。

        只给「过没过」和「哪项没过」。数据目录的绝对路径、DB 异常原文、
        磁盘余量都不该出现在公网可达的响应里——完整诊断走 `renderd doctor`。
        """
        body = self.service.ready()
        failing = [k for k, v in body["checks"].items() if not v["ok"]]
        self._json(200 if body["ok"] else 503,
                   {"ok": body["ok"], "failing": failing,
                    "uptime_s": body["uptime_s"]})

    def h_metrics(self, **_) -> None:
        # /metrics 不该对公网开放：暴露任务量、缓存命中率、租户数。
        src = self.client_address[0] if self.client_address else ""
        try:
            addr = ipaddress.ip_address(src)
        except ValueError:
            addr = None
        cidrs = [x.strip() for x in self.service.cfg.metrics_allow_cidrs.split(",")
                 if x.strip()]
        allowed = addr is not None and any(
            addr in ipaddress.ip_network(c, strict=False)
            for c in cidrs if _valid_net(c))
        if not allowed:
            raise JobError("E_METRICS_FORBIDDEN",
                           f"/metrics 不对来源 {src} 开放",
                           hint="把来源网段加进 RENDERD_METRICS_CIDRS，或用反向代理做 IP 白名单")
        body = self.service.metrics().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── 业务端点 ──────────────────────────────────────────
    def h_templates(self, **_) -> None:
        self._tenant()
        self._json(200, {"templates": self.service.templates()})

    def h_validate(self, **_) -> None:
        self._tenant()
        payload = self._read_json()
        self._json(200, self.service.validate(payload))

    def h_submit(self, **_) -> None:
        tenant = self._tenant()
        payload = self._read_json()
        result = self.service.submit(payload, tenant)
        self._json(202 if result.get("job_id") else 200, result)

    def h_list_assets(self, *, qs, **_) -> None:
        tenant = self._tenant()
        limit = int((qs.get("limit") or ["100"])[0])
        self._json(200, self.service.assets(tenant, min(limit, 500)))

    def h_delete_asset(self, asset_id: str, **_) -> None:
        tenant = self._tenant()
        self._json(200, self.service.delete_asset(asset_id, tenant))

    def h_upload(self, **_) -> None:
        tenant = self._tenant()
        length = int(self.headers.get("Content-Length") or 0)
        limit = self.service.cfg.max_upload_mb * 1024 * 1024
        if length > limit:
            self.close_connection = True
            raise JobError("E_UPLOAD_TOO_LARGE",
                           f"超过 {self.service.cfg.max_upload_mb}MB",
                           allowed_values=[f"<= {limit}"])
        data = self.rfile.read(length) if length else b""
        self._body_read = True
        info = self.service.put_asset(
            data, self.headers.get("X-Filename", ""), tenant=tenant)
        self._json(201, info)

    def h_list_jobs(self, *, qs, **_) -> None:
        tenant = self._tenant()
        limit = int((qs.get("limit") or ["50"])[0])
        status = (qs.get("status") or [None])[0]
        self._json(200, {"jobs": self.service.list_jobs(tenant, limit=min(limit, 200),
                                                       status=status)})

    def h_job(self, job_id: str, **_) -> None:
        tenant = self._tenant()
        self._json(200, self.service.status(job_id, tenant))

    def h_events(self, job_id: str, **_) -> None:
        tenant = self._tenant()
        self._json(200, {"events": self.service.events(job_id, tenant)})

    def h_receipt(self, job_id: str, **_) -> None:
        tenant = self._tenant()
        self._json(200, self.service.receipt(job_id, tenant))

    def h_cancel(self, job_id: str, **_) -> None:
        tenant = self._tenant()
        self._json(200, self.service.cancel(job_id, tenant))

    def h_usage(self, **_) -> None:
        tenant = self._tenant()
        self._json(200, self.service.usage(tenant))

    def h_queue(self, **_) -> None:
        tenant, admin = self._principal()
        self._json(200, self.service.queue(tenant, admin=admin))

    def h_dlq(self, *, qs, **_) -> None:
        tenant = self._tenant()
        limit = int((qs.get("limit") or ["50"])[0])
        self._json(200, self.service.dlq(tenant, min(limit, 200)))

    # ── MCP over Streamable HTTP ─────────────────────────
    def h_mcp(self, **_) -> None:
        """JSON-RPC 2.0 over HTTP，单请求-单响应（不做 SSE 服务端推流）。

        传输层只做四件事：定租户、取 body、逐条分发、打包回包。
        业务分发全在 MCPServer.handle() —— 与 stdio 共用同一份，不存在两套契约。

        安全边界：租户**只能**来自 Bearer token。stdio 那种 `RENDERD_MCP_TENANT`
        兜底在这里被显式关掉（from_env=False），否则一个环境变量就能冒充任意租户。
        """
        t0 = time.monotonic()
        # 观测位：请求结束时无条件打一行，哪怕中途抛异常 —— 失败恰恰是最需要日志的时候。
        obs = {"rid": self._rid(), "tenant": "-", "method": "-", "tool": "-",
               "client": "-", "job": "-", "outcome": "ok", "code": "-",
               "msgs": 0, "mode": "json"}
        try:
            try:
                tenant = self._tenant()  # 鉴权 + 限流 + 配额，与 REST 走同一条路径
            except JobError:
                # 准入失败（401/429/413）也由 `_error` 打了 req-fail，
                # 这里只把 outcome 标对，避免出现「同时 401 又 ok」的自相矛盾日志。
                obs["outcome"] = "denied"
                raise
            obs["tenant"] = tenant
            try:
                payload = self._read_json()
            except JobError as exc:
                # JSON 解析失败属于 JSON-RPC 的 Parse error，用 400 + -32700 回，
                # 让客户端能按协议纠错，而不是收到一个自家错误码。
                obs["outcome"], obs["code"] = "rejected", "-32700"
                self._json(400, {"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32700, "message": f"Parse error: {exc.message}"}})
                return

            if not payload:
                obs["outcome"], obs["code"] = "rejected", "-32600"
                self._json(200, {"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32600, "message": "Invalid Request：请求体为空"}})
                return

            batch = isinstance(payload, list)
            msgs = payload if batch else [payload]
            if not all(isinstance(m, dict) for m in msgs):
                obs["outcome"], obs["code"] = "rejected", "-32600"
                self._json(200, {"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32600,
                                           "message": "Invalid Request：需要 JSON-RPC 对象或对象数组"}})
                return
            if len(msgs) > 32:
                obs["outcome"], obs["code"] = "rejected", "-32600"
                self._json(200, {"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32600, "message": "批量上限 32 条"}})
                return

            obs["msgs"] = len(msgs)
            first = msgs[0]
            obs["method"] = first.get("method") or "-"
            params = first.get("params") or {}
            if obs["method"] == "tools/call":
                obs["tool"] = params.get("name") or "-"
            elif obs["method"] == "initialize":
                # 记录谁在连：出问题时第一个要回答的问题就是「哪个客户端、什么版本」。
                ci = params.get("clientInfo") or {}
                obs["client"] = f"{ci.get('name', '?')}/{ci.get('version', '?')}"
                obs["proto"] = params.get("protocolVersion") or "-"

            srv = MCPServer(self.service, tenant, from_env=False)
            out = [r for r in (srv.handle(m) for m in msgs) if r is not None]
            if not out:
                # 全是通知（无 id）→ 规范要求 202 且无响应体
                obs["outcome"] = "notification"
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.send_header("X-Renderd-Version", __version__)
                self.send_header("X-Request-Id", obs["rid"])
                self.end_headers()
                return

            # 结果分类：JSON-RPC 层错误 / 工具内业务错误 / 正常
            # 这三者对人的意义完全不同，日志里必须能一眼分开。
            for r in out:
                if "error" in r:
                    obs["outcome"] = "rpc_error"
                    obs["code"] = (r.get("error") or {}).get("code", "-")
                    break
                res = r.get("result") or {}
                if res.get("isError"):
                    obs["outcome"] = "iserror"
                    txt = ""
                    try:
                        txt = json.dumps(res.get("content"), ensure_ascii=False)
                    except Exception:      # noqa: BLE001
                        pass
                    m = re.search(r'"code"\s*:\s*"([A-Z_]+)"', txt)
                    obs["code"] = m.group(1) if m else "-"
                    break
            # job_id 抽出来：这样一行日志就能把「MCP 调用」和「后续渲染任务」串起来
            blob = json.dumps(out, ensure_ascii=False)
            mj = re.search(r'job_[0-9a-f]{12}', blob)
            if mj:
                obs["job"] = mj.group(0)

            # 传输模式由客户端 Accept 协商：要流就给 SSE，否则给一次性 JSON。
            # 两者都是规范允许的，内容完全一致 —— 差别只在分帧方式。
            accept = (self.headers.get("Accept") or "").lower()
            if "text/event-stream" in accept:
                obs["mode"] = "sse"
                self._sse(out)
                return
            self._json(200, out if batch else out[0])
        finally:
            self._mcp_log(obs, t0)

    def _mcp_log(self, obs: dict, t0: float) -> None:
        """一次 MCP 调用一行。字段固定，便于 grep / 采集 / Agent 解析。

        不记录 token，也不记录工具参数全文 —— 素材 URI 与文案属于客户内容，
        日志里只留「谁、调了什么、结果如何、多久」。需要细查时用 rid 关联
        `job_events` 或 `audit` 表，而不是把业务数据抄进日志。
        """
        ms = int((time.monotonic() - t0) * 1000)
        parts = ["mcp"] + [_kv(k, obs.get(k)) for k in
                           ("rid", "tenant", "method", "tool", "client")]
        parts.append(_kv("outcome", obs.get("outcome")))
        if obs.get("code") not in ("-", None):
            parts.append(_kv("code", obs["code"]))
        if obs.get("job") not in ("-", None):
            parts.append(_kv("job", obs["job"]))
        if obs.get("proto") not in (None, "-"):
            parts.append(_kv("proto", obs["proto"]))
        parts.append(_kv("mode", obs.get("mode")))
        if obs.get("msgs", 0) > 1:
            parts.append(_kv("msgs", obs["msgs"]))
        parts.append(_kv("ms", ms))
        # 慢调用单独标出来：MCP 客户端通常有超时，先于客户端报警发现才是运维的价值
        slow_ms = int(os.environ.get("RENDERD_SLOW_MS", "1000") or 1000)
        if ms >= slow_ms:
            parts.append("slow=1")
        log(" ".join(parts))

    def h_mcp_probe(self, **_) -> None:
        """GET /mcp：明确拒绝，而不是 404。

        MCP 客户端会先试 SSE 流；这里回 405 + Allow，比 404 更快让它回落到 POST 模式，
        也不会让运维误以为路径写错。
        """
        self.close_connection = True
        # 客户端探 SSE 是很常见的一步：记下来，才能区分「配错 transport」和「服务挂了」。
        log(" ".join(["mcp-probe", _kv("rid", self._rid()),
                      _kv("tenant", "-"), _kv("outcome", "rejected"),
                      _kv("code", "405"), _kv("peer", self._client_ip())]))
        self._json(405, {
            "error": {
                "code": "E_METHOD_NOT_ALLOWED",
                "message": "本服务不提供服务端推流（SSE），只支持 POST /mcp 的单请求-单响应模式",
                "hint": "客户端按 streamable-http 的 JSON 响应模式配置；本机嵌入请改用 `renderd mcp`（stdio）",
            }
        }, extra_headers={"Allow": "POST"})

    def h_replay(self, job_id: str, **_) -> None:
        tenant = self._tenant()
        self._json(200, self.service.replay(job_id, tenant))

    # ── 文件流 ────────────────────────────────────────────
    def _may_access(self, job_id: str, qs: dict, scope: str) -> str:
        """返回允许访问的租户。两种方式：Bearer token，或绑定 tenant+scope 的签名。

        签名必须对着**任务所属租户**验：URL 里的 t 只是把 tenant 带进来，
        真正的约束是 HMAC 的入参里也有它 —— 改成别人的 tenant 就验不过。
        """
        authz = self.headers.get("Authorization")
        if authz:
            tenant = self.service.admit(authz, self._client_ip())
            self.service.status(job_id, tenant)      # 越权会抛 E_NOT_FOUND
            return tenant
        exp_raw = (qs.get("exp") or ["0"])[0]
        sig = (qs.get("sig") or [""])[0]
        tenant_q = (qs.get("t") or [""])[0]
        try:
            exp = int(exp_raw or 0)
        except ValueError:
            raise JobError("E_AUTH_REQUIRED", "exp 不是整数")
        # 先验签，再查任务：反过来就变成「用 404/401 的差异探测 job_id 是否存在」。
        if not tenant_q or not auth.verify(job_id, exp, sig, tenant=tenant_q, scope=scope):
            raise JobError("E_AUTH_REQUIRED", "缺少令牌或签名已过期/不匹配",
                           hint=f"scope={scope}")
        job = self.service.store.get(job_id)
        if not job:
            raise JobError("E_NOT_FOUND", f"任务不存在: {job_id}", field="job_id")
        owner = job["tenant"]
        if tenant_q != owner:
            raise JobError("E_AUTH_REQUIRED", "签名与任务所属租户不匹配",
                           hint="链接只对签发它的租户有效")
        self.service.store.audit(
            action="download.signed", tenant=owner, target=job_id,
            ip=self.client_address[0] if self.client_address else None,
            data={"scope": scope})
        return owner

    def h_video(self, job_id: str, *, qs, **_) -> None:
        self._may_access(job_id, qs, "video")
        job = self.service.store.get(job_id)
        if not job or not job["output_path"]:
            raise JobError("E_NOT_FOUND", "成片不存在或尚未生成")
        self._send_file(Path(job["output_path"]), "video/mp4")

    def h_evidence(self, job_id: str, name: str, *, qs, **_) -> None:
        safe = Path(name).name
        self._may_access(job_id, qs, f"evidence:{safe}")
        path = self.service.cfg.evidence_dir / job_id / safe
        if not path.exists():
            raise JobError("E_NOT_FOUND", f"证据文件不存在: {safe}")
        ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        self._send_file(path, ctype)

    def _send_file(self, path: Path, ctype: str) -> None:
        if not path.exists():
            raise JobError("E_NOT_FOUND", "文件不存在")
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "private, max-age=3600")
        try:
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            return
        with open(path, "rb") as f:
            while True:
                chunk = f.read(256 * 1024)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(cfg: Config | None = None, service: Service | None = None,
          with_workers: int = 0, background: bool = False):
    cfg = cfg or load_config()
    svc = service or Service(cfg)
    Handler.service = svc
    httpd = Server((cfg.api_host, cfg.api_port), Handler)
    if cfg.tls_cert and cfg.tls_key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cfg.tls_cert, cfg.tls_key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        log(f"TLS enabled, cert={cfg.tls_cert}")
    workers: list[Worker] = []
    reaper = None
    if os.environ.get("RENDERD_REAPER", "1") not in ("0", "false"):
        reaper, _stop = start_reaper(svc.store, cfg)
    if with_workers:
        for i in range(with_workers):
            # worker 名必须全局唯一：心跳按 worker 名校验，两个 pod 都叫
            # `inproc-0` 时，A 的心跳能续上 B 的租约 —— 又是双领。
            wname = f"{socket.gethostname()}-inproc-{i}-{uuid.uuid4().hex[:6]}"
            w = Worker(cfg, svc.store, svc.runner, name=wname)
            threading.Thread(target=w.run_forever, daemon=True).start()
            workers.append(w)
    if background:
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        return httpd, svc, workers
    log(f"renderd {__version__} listening on {cfg.api_host}:{cfg.api_port} "
        f"(workers={with_workers}, data={cfg.data_dir})")

    def _on_signal(signum, _frame) -> None:
        # 必须走子线程：serve_forever 在主线程里跑，在信号处理器里直接调
        # shutdown() 会死锁 —— 它等的是 serve_forever 返回，而后者正被这个
        # 处理器打断。
        #
        # 这个 handler 不是可选项：容器里 python 是 PID 1，内核会忽略 PID 1
        # 未注册的信号。没有它，SIGTERM 不生效，容器只能等 stop_grace_period
        # 到期被 SIGKILL —— 生产上每次重启白等 5 分钟，且进行中的请求被硬切。
        log(f"received {signal.Signals(signum).name}, draining")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(_sig, _on_signal)
        except ValueError:
            # 非主线程（background=True 的测试场景）无法注册信号，忽略
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        for w in workers:
            w.stop()
        httpd.server_close()
    return httpd, svc, workers
