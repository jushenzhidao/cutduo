"""出站请求的 SSRF 防线：解析一次、钉住 IP、之后永不二次解析。

DNS rebinding 的标准打法是：域名在校验时解析到公网、真正连接时解析到内网。
只在提交时 `getaddrinfo` 检查一次是不够的 —— 必须把「校验通过的那个 IP」写进任务，
投递时直接连这个 IP，并在 TLS 握手里把原域名作为 SNI/Host 传过去。

这里刻意不 urllib / requests：它们会自己再做一次名字解析。
"""

from __future__ import annotations

import ipaddress
import re
import socket
import ssl
from urllib.parse import urlsplit

from .errors import JobError

# HTTP 头名必须是 token；头值不能含任何控制字符或非 ASCII。
# 手写 HTTP/1.1 时若把用户输入直接拼进 `k: v\r\n`，一个 \r\n 就能注入
# 任意请求头甚至第二个请求 —— 这与「钉住 IP」是两条独立的防线。
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_PROTECTED_HEADERS = {"host", "content-length", "connection",
                      "transfer-encoding", "proxy-connection"}


def sanitize_headers(headers: dict | None) -> dict[str, str]:
    """把用户提供的请求头收敛成可安全拼接的键值。非法直接抛 ValueError。"""
    out: dict[str, str] = {}
    for raw_k, raw_v in (headers or {}).items():
        k, v = str(raw_k), str(raw_v)
        if not _HEADER_NAME.fullmatch(k):
            raise ValueError(f"非法出站请求头名: {k!r}（只允许 HTTP token 字符）")
        if k.lower() in _PROTECTED_HEADERS:
            raise ValueError(f"不允许覆盖受保护的出站请求头: {k}")
        if any(ord(c) < 32 or ord(c) == 127 or ord(c) > 126 for c in v):
            raise ValueError(f"出站请求头 {k} 含控制字符或非 ASCII 字符")
        out[k] = v
    return out


def is_forbidden(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return bool(addr.is_private or addr.is_loopback or addr.is_link_local
                 or addr.is_reserved or addr.is_multicast or addr.is_unspecified
                 or addr.is_unspecified)


def resolve_pinned(url: str, *, allow_private: bool = False) -> dict:
    """校验 URL 并返回钉住的连接信息。返回的 dict 会被存进 jobs 表。"""
    u = urlsplit(url)
    if u.scheme not in ("http", "https"):
        raise JobError("E_CALLBACK_FORBIDDEN", f"不支持的协议: {u.scheme}",
                       field="callback_url", allowed_values=["http", "https"])
    host = u.hostname
    if not host:
        raise JobError("E_CALLBACK_FORBIDDEN", "URL 缺少主机名",
                       field="callback_url")
    if u.username or u.password:
        raise JobError("E_CALLBACK_FORBIDDEN", "URL 不允许携带凭据",
                       field="callback_url")
    port = u.port or (443 if u.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise JobError("E_CALLBACK_FORBIDDEN", f"域名无法解析: {host}",
                       field="callback_url", hint="换一个可达的地址")
    ips: list[str] = []
    for info in infos:
        ip = info[4][0]
        if not allow_private and is_forbidden(ip):
            raise JobError(
                "E_CALLBACK_FORBIDDEN",
                f"目标地址指向内网/保留地址: {ip}", field="callback_url",
                hint="生产环境禁止回调到内网；确需如此请开 "
                     "RENDERD_ALLOW_PRIVATE_CALLBACKS=1",
                allowed_values=["公网 http(s) 地址"])
        if ip not in ips:
            ips.append(ip)
    if not ips:
        raise JobError("E_CALLBACK_FORBIDDEN", f"域名无可用地址: {host}",
                       field="callback_url")
    # IPv4 优先：getaddrinfo("localhost") 常把 ::1 排在最前，但绝大多数
    # 接收端只监听 0.0.0.0。钉死第一个 IP 会直接 ECONNREFUSED。
    ips.sort(key=lambda x: 0 if ":" not in x else 1)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    return {
        "url": url, "host": host, "port": port, "ip": ips[0],
        "scheme": u.scheme, "path": path, "all_ips": ips[:4],
    }


def pinned_request(pin: dict, *, method: str = "POST", data: bytes | None = None,
                  headers: dict[str, str] | None = None,
                  timeout: float = 8.0) -> tuple[int, str]:
    """直连钉住的 IP。整个过程不调用 getaddrinfo / getpwnam 等名字解析。"""
    host, port = pin["host"], int(pin["port"])
    hdrs = {
        "Host": host if port in (80, 443) else f"{host}:{port}",
        "User-Agent": "renderd/0.2",
        "Connection": "close",
        "Accept": "*/*",
    }
    # 用户头在准入期已净化过，这里再做一次纵深防御：即使被绕过，
    # 也不可能注入 CRLF 或覆盖 Host / Content-Length。
    hdrs.update(sanitize_headers(headers))
    body = data or b""
    hdrs["Content-Length"] = str(len(body))
    raw = (f"{method} {pin['path']} HTTP/1.1\r\n"
           + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())
           + "\r\n").encode("ascii") + body

    # 逐个尝试提交时已经校验过的 IP（不再解析域名）。首个不可达时换下一个，
    # 这样 IPv6-only / 多 A 记录里某台宕机都不会让投递白失败。
    candidates = list(dict.fromkeys(
        [pin.get("ip", "")] + list(pin.get("all_ips") or [])))[:3]
    last_exc: Exception | None = None
    for ip in candidates:
        if not ip:
            continue
        try:
            sock = socket.create_connection((ip, port), timeout=timeout)
        except OSError as exc:
            last_exc = exc
            continue
        try:
            if pin["scheme"] == "https":
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(sock, server_hostname=host)
            sock.settimeout(timeout)
            sock.sendall(raw)
            buf = b""
            while b"\r\n" not in buf and len(buf) < 8192:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf += chunk
            line = buf.split(b"\r\n", 1)[0].decode("latin-1", "replace")
            parts = line.split(" ", 2)
            status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            return status, line
        finally:
            try:
                sock.close()
            except OSError:
                pass
    raise ConnectionError(
        f"所有钉住的 IP 均不可达: {candidates}; last={last_exc}")


def revalidate_pin(pin: dict, *, allow_private: bool = False) -> None:
    """投递前复核：钉住的 IP 现在仍必须合法（配置变更也能挡住）。"""
    if not allow_private and is_forbidden(str(pin.get("ip", ""))):
        raise JobError("E_CALLBACK_FORBIDDEN",
                       f"钉住的回调 IP 已变为内网/保留地址: {pin.get('ip')}",
                       field="callback_url")
