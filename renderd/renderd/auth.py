"""鉴权、签名与限流。

  · Bearer token → tenant 一一映射
  · 租户级 QPS 计数在共享存储里（store.rate_hit），不在进程内存
  · 下载链接用 HMAC 签名，签名覆盖 tenant + scope + job_id + 过期时间：
    拿到成片链接不等于拿到证据文件，也不等于能用别的租户身份取
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import quote

from .errors import JobError

# 已知占位值。签名机制的有效性 = 密钥熵，不是「有没有调用 hmac」；
# 用源码里的常量当默认密钥，等于没有签名。
WEAK_SECRETS = {"", "change-me", "changeme", "renderd-dev-secret",
                "dev", "secret", "test", "password", "admin"}
_BOOT_WALL = time.time()
_GENERATED_KEY: bytes | None = None


def init_secret(data_dir: Path | str) -> str:
    """服务启动时确立签名密钥。返回来源，供 doctor 展示。

    显式配置 → 用它；未配置 → 生成 32 字节随机密钥并持久化到 data_dir，
    这样重启不会让已经发出的签名 URL 失效。多实例必须共享同一 data_dir
    或显式配置 RENDERD_SECRET，否则各实例签名互不相认（见 docs/OPS.md）。
    """
    global _GENERATED_KEY
    env = os.environ.get("RENDERD_SECRET") or os.environ.get("RENDERD_TOKEN") or ""
    if env:
        if env.strip().lower() in WEAK_SECRETS:
            raise RuntimeError(
                "RENDERD_SECRET 是已知占位值；签名 URL 可被任何人伪造。"
                "请设置 RENDERD_SECRET=$(openssl rand -hex 32)")
        return "env"
    p = Path(data_dir) / ".signing_key"
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        _GENERATED_KEY = p.read_bytes().strip()
        return "file"
    key = secrets.token_hex(32).encode()
    try:
        fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
    except FileExistsError:
        key = p.read_bytes().strip()
    _GENERATED_KEY = key
    return "generated"


def secret_status() -> dict:
    env = os.environ.get("RENDERD_SECRET") or os.environ.get("RENDERD_TOKEN") or ""
    if env:
        return {"source": "env", "weak": env.strip().lower() in WEAK_SECRETS}
    if _GENERATED_KEY:
        return {"source": "generated/file", "weak": False}
    return {"source": "not-initialized (dev fallback)", "weak": True}


def _secret() -> bytes:
    s = os.environ.get("RENDERD_SECRET") or os.environ.get("RENDERD_TOKEN") or ""
    if s:
        return s.encode()
    # 未经 init_secret 的纯库调用（单测直接调 sign/verify）仍有确定性兜底，
    # 但服务启动时一定会先 init_secret，生产路径不会走到这里。
    return _GENERATED_KEY or b"renderd-dev-secret"


def parse_tokens(spec: str) -> dict[str, str]:
    """`token:tenant,token2:tenant2` → {token: tenant}"""
    out: dict[str, str] = {}
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            tok, tenant = part.split(":", 1)
            out[tok.strip()] = tenant.strip()
        else:
            out[part] = "default"
    return out


class Auth:
    def __init__(self, tokens: dict[str, str], allow_anon: bool = False,
                 admin_tokens: set[str] | None = None):
        self.tokens = tokens
        self.allow_anon = allow_anon
        # 管理令牌是 tokens 的子集：同一个 token，多了「看全局运维视图」的权限。
        # 单独一套凭据会让「谁是谁」出现两套映射，出事故对不上。
        self.admin_tokens = {t for t in (admin_tokens or set()) if t in tokens}

    @classmethod
    def from_env(cls) -> "Auth":
        tokens = parse_tokens(os.environ.get("RENDERD_TOKENS", ""))
        single = os.environ.get("RENDERD_TOKEN", "")
        if single and not tokens:
            tokens[single] = "default"
        allow_anon = os.environ.get("RENDERD_ALLOW_ANON", "") in ("1", "true", "yes")
        admins = {x.strip() for x in os.environ.get("RENDERD_ADMIN_TOKENS", "").split(",")
                  if x.strip()}
        return cls(tokens, allow_anon, admins)

    def resolve_principal(self, authorization: str | None,
                          fallback_tenant: str = "dev") -> tuple[str, bool]:
        """返回 (tenant, is_admin)。两个信息必须一起取：分两次解析会多一次
        token 比较，还会让「解析出来的身份」与「判断的权限」有机会不一致。"""
        if not self.tokens:
            if self.allow_anon or not os.environ.get("RENDERD_REQUIRE_AUTH"):
                return fallback_tenant, False
            raise JobError("E_AUTH_REQUIRED", "服务未配置令牌，拒绝匿名访问")
        if not authorization:
            raise JobError("E_AUTH_REQUIRED", "缺少 Authorization: Bearer <token>")
        parts = authorization.split()
        token = parts[-1] if parts else ""
        tenant = self.tokens.get(token)
        if not tenant:
            raise JobError("E_AUTH_REQUIRED", "令牌无效")
        return tenant, token in self.admin_tokens

    def resolve(self, authorization: str | None, fallback_tenant: str = "dev") -> str:
        return self.resolve_principal(authorization, fallback_tenant)[0]

    def token_known(self, token: str) -> bool:
        """这个 token 是不是已配置的合法令牌。一次 dict 查，微秒级。

        用途：IP 级限速只拦「无效令牌」，不能把同一出口 IP 后面的正常客户一起拦掉。
        """
        return bool(token) and token in self.tokens


class RateLimiter:
    """已废弃：进程内计数在多副本下把 QPS 放大 N 倍（实测 3 实例 → 15 QPS）。

    保留这个类只是为了让旧的导入不至于当场崩，实际准入走 `store.rate_hit`。
    """

    def __init__(self):
        raise RuntimeError(
            "RateLimiter 已废弃：限流计数必须放在共享存储里（store.rate_hit），"
            "进程内计数在 N 个 API 副本下会把配额放大 N 倍")


def _scope_token(scope: str, name: str = "") -> str:
    if scope == "evidence":
        return f"evidence:{Path(name).name}"
    return scope


def _payload(job_id: str, expires: int, tenant: str, scope: str) -> bytes:
    # 定长/转义都交给 json：tenant 与 scope 里出现分隔符也不会产生歧义
    return json.dumps(["v2", tenant, scope, job_id, int(expires)],
                      separators=(",", ":"), ensure_ascii=False).encode()


def sign(job_id: str, expires: int, tenant: str = "", scope: str = "video") -> str:
    return hmac.new(_secret(), _payload(job_id, expires, tenant, scope),
                    hashlib.sha256).hexdigest()[:32]


def verify(job_id: str, expires: int, sig: str, *, tenant: str = "",
           scope: str = "video") -> bool:
    if not sig:
        return False
    now = time.time()
    # 墙钟回拨会让已经过期的 URL 复活。进程启动时记录一次墙钟基线，
    # 明显倒退时宁可拒绝，也不要让旧签名重新有效。
    if now < _BOOT_WALL - 60:
        return False
    if now > expires:
        return False
    return hmac.compare_digest(sign(job_id, expires, tenant, scope), sig)


def signed_url(job_id: str, tenant: str, ttl: int = 3600, *,
               scope: str = "video", name: str = "") -> str:
    """签发下载链接。签名绑定 tenant 与 scope。

    为什么不只是「HMAC(job_id)」：那样一个成片链接可以原样拿去取
    contact sheet 与回执文件（同一个 job_id），也可以被换成别的租户身份使用。
    把 tenant 和 scope 一起签进去，泄露面就收敛到「这一个文件的这一个用途」。
    """
    exp = int(time.time()) + ttl
    token = _scope_token(scope, name)
    sig = sign(job_id, exp, tenant, token)
    q = f"exp={exp}&sig={sig}&t={quote(tenant, safe='')}"
    if scope == "evidence":
        return f"/v1/jobs/{job_id}/evidence/{quote(Path(name).name, safe='')}?{q}"
    return f"/v1/jobs/{job_id}/video?{q}"
