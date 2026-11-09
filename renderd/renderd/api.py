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
]


def log(msg: str, *extra) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", *extra, flush=True)


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

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Renderd-Version", __version__)
        if self.close_connection:
            self.send_header("Connection", "close")
        try:
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
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
