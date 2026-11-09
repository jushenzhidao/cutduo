"""服务门面：REST 与 MCP 共用同一套语义。

两条入口（HTTP / MCP stdio）必须行为一致，否则 Agent 和人类客户端看到的
是同一个系统的两个版本。所有业务判断都收敛在这里。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from . import (IR_VERSION, __version__, auth, capabilities, delivery, ir as IR,
               netguard, render)
from .config import Config, load_config
from .errors import JobError
from .runner import Runner, estimate
from .store import Store
from .templates import TemplateRegistry

STAGES = ["queued", "ingesting", "compiling", "rendering", "validating",
          "delivering", "done", "failed"]


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_once(path: Path, data: bytes) -> bool:
    """原子创建：返回 False 表示别的进程已经写好了同一份内容。

    「先 exists() 再 write_bytes()」在单进程内没问题，多副本下两个实例会
    同时判定不存在、同时写入、同时计费。O_EXCL 让内核做这个仲裁。
    """
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        return False
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    return True


class Service:
    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or load_config()
        # 先确立签名密钥：硬编码默认密钥会让任何人伪造下载 URL。
        # 未显式配置时生成随机密钥并持久化到 data_dir，重启不失效。
        self.secret_source = auth.init_secret(self.cfg.data_dir)
        self.store = Store(self.cfg.db_path)
        self.registry = TemplateRegistry(self.cfg.template_dir)
        self.runner = Runner(self.cfg, self.store, self.registry)
        self.auth = auth.Auth.from_env()
        # 限流与配额都不在进程内存里：N 个 API 副本必须共享同一个预算，
        # 否则「5 QPS」在 3 副本下就是 15 QPS（实测）。
        self.started_at = time.time()

    # ── 租户 ─────────────────────────────────────────────
    def ensure_tenant(self, tenant: str, monthly_minutes: int | None = None,
                      qps: int | None = None) -> dict:
        t = self.store.get_tenant(tenant)
        if t:
            return t
        return self.store.ensure_tenant(
            tenant,
            monthly_minutes=monthly_minutes or self.cfg.default_monthly_minutes,
            qps=qps or self.cfg.default_qps,
            storage_mb=self.cfg.default_storage_mb)

    def admit(self, authorization: str | None, ip: str | None = None) -> str:
        return self.admit_principal(authorization, ip)[0]

    def admit_principal(self, authorization: str | None,
                        ip: str | None = None) -> tuple[str, bool]:
        """鉴权 + 限流 + 身份。返回 (tenant, is_admin)。

        限流原本排在鉴权之后 —— 意味着错 token 的洪水完全不受约束，401 可以
        无限打。这里在鉴权**之前**按客户端 IP 做一次前置拦截：只有该 IP 最近
        失败过才去查共享计数（命中缓存才付一次查询），合法流量零额外成本。
        """
        if ip and self.cfg.auth_fail_qps > 0 and self._recent_auth_fail(ip):
            # 只拦无效令牌：NAT 后面可能有正常客户与配错 token 的客户端共用出口 IP，
            # 一刀切会把合法请求一起拒掉（实测攻击套件就会全组 429）。
            parts = (authorization or "").split()
            if not self.auth.token_known(parts[-1] if parts else ""):
                self.store.rate_guard(f"authfail:{ip}", self.cfg.auth_fail_qps)
        try:
            tenant, admin = self.auth.resolve_principal(authorization)
        except JobError:
            if ip and self.cfg.auth_fail_qps > 0:
                self._note_auth_fail(ip)
                self.store.rate_bump(f"authfail:{ip}")
            raise
        t = self.ensure_tenant(tenant)
        self.store.rate_hit(tenant, int(t["qps"]))
        return tenant, admin

    # 最近失败的 IP：进程内只做「要不要去查库」的判断，预算本身在共享存储里。
    # 没有这张表，每个合法请求都要多一次 SELECT 才能确认自己没被限。
    _AUTH_FAIL_TTL_S = 60.0

    def _recent_auth_fail(self, ip: str) -> bool:
        ts = getattr(self, "_auth_fail_ips", {})
        seen = ts.get(ip)
        return bool(seen and time.time() - seen < self._AUTH_FAIL_TTL_S)

    def _note_auth_fail(self, ip: str) -> None:
        ts = getattr(self, "_auth_fail_ips", None)
        if ts is None:
            ts = self._auth_fail_ips = {}
        if len(ts) > 4096:                     # 有界：洪水下不能把内存吃穿
            now = time.time()
            ts = {k: v for k, v in ts.items() if now - v < self._AUTH_FAIL_TTL_S}
            self._auth_fail_ips = ts
        ts[ip] = time.time()

    # ── 模板 ─────────────────────────────────────────────
    def templates(self) -> list[dict]:
        return self.registry.list()

    # ── 素材上传 ──────────────────────────────────────────
    def put_asset(self, data: bytes, filename: str = "", tenant: str = "") -> dict:
        limit = self.cfg.max_upload_mb * 1024 * 1024
        if len(data) > limit:
            raise JobError("E_UPLOAD_TOO_LARGE",
                           f"上传 {len(data)} 字节超过上限 {self.cfg.max_upload_mb}MB",
                           allowed_values=[f"<= {limit}"])
        if not data:
            raise JobError("E_INPUT_UNREADABLE", "上传内容为空")
        sha = _sha256_bytes(data)
        ext = (Path(filename).suffix.lower() or ".bin")
        if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext):
            ext = ".bin"          # 防止奇怪文件名把扩展名带进路径
        dst = self.cfg.media_dir / f"{sha}{ext}"

        # 内容寻址：文件已在盘上就不重复计费，也不重复写。
        # 注意这里不能用「先 exists() 再写」——跨进程会同时判定不存在。
        if dst.exists():
            if tenant:
                self.store.asset_ref_ensure(sha, tenant)   # 只记引用，不收费
            return {"asset_id": f"asset_{sha[:12]}", "sha256": sha,
                    "uri": f"upload:{dst.name}", "bytes": len(data),
                    "deduplicated": True}

        quota = self.store.storage_quota_bytes(tenant) if tenant else 0
        reserved = False
        if tenant:
            ok, used = self.store.storage_reserve(tenant, sha, len(data), quota)
            if not ok:
                raise JobError(
                    "E_QUOTA_STORAGE_EXCEEDED",
                    f"租户已用 {used / 1048576:.1f}MB / 配额 "
                    f"{quota / 1048576:.0f}MB，本次 {len(data) / 1048576:.1f}MB 超限",
                    field="storage_quota_mb",
                    hint="删除旧素材或由管理员提额；内容寻址的重复上传不重复计费",
                    allowed_values=[f"<= {max(0, quota - used)} 字节"])
            reserved = True
        try:
            created = _write_once(dst, data)
        except Exception:
            if reserved:
                self.store.storage_refund(tenant, sha, len(data))
            raise
        if created:
            # 存绝对路径：GC / 删除可能在不同 cwd 下执行，相对路径会指错地方
            self.store.asset_register(sha, len(data), str(dst.resolve()))
            if tenant:
                self.store.asset_ref_ensure(sha, tenant)
        elif reserved:
            # 另一个实例先写好了同一个内容寻址文件：退掉预占，但保留引用
            self.store.storage_refund(tenant, sha, len(data))
        return {"asset_id": f"asset_{sha[:12]}", "sha256": sha,
                "uri": f"upload:{dst.name}", "bytes": len(data),
                "deduplicated": not created}

    # ── 素材管理 ──────────────────────────────────────────
    def assets(self, tenant: str, limit: int = 100) -> dict:
        rows = self.store.assets_list(tenant, limit)
        return {
            "assets": [{"asset_id": f"asset_{r['sha'][:12]}", "sha256": r["sha"],
                        "bytes": r["bytes"], "charged_bytes": r["charged"],
                        "created_at": r["created_at"], "last_seen": r["last_seen"]}
                       for r in rows],
            "count": self.store.assets_count(tenant),
            "storage_used_bytes": self.store.storage_used_bytes(tenant),
            "storage_quota_bytes": self.store.storage_quota_bytes(tenant),
        }

    def delete_asset(self, asset_id: str, tenant: str) -> dict:
        """释放一个素材的引用。有在途任务引用时拒绝（E_ASSET_IN_USE）。"""
        a = self.store.asset_resolve(asset_id, tenant)
        if not a:
            raise JobError("E_NOT_FOUND", f"素材不存在: {asset_id}", field="asset_id")
        if str(a["sha"]).startswith("legacy:"):
            raise JobError("E_NOT_FOUND", "这是老版本遗留的用量行，没有对应文件",
                           field="asset_id",
                           hint="老数据没有文件级明细，只能由管理员在库里清零")
        r = self.store.asset_release(a["sha"], tenant)
        if not r:
            raise JobError("E_NOT_FOUND", f"素材不存在: {asset_id}", field="asset_id")
        if r["file_removed"] and r.get("path"):
            try:
                Path(r["path"]).unlink()
            except OSError:
                pass
        self.store.audit(action="asset.delete", tenant=tenant, target=a["sha"],
                         data={"refunded_bytes": r["refunded_bytes"],
                               "file_removed": r["file_removed"]})
        return {"asset_id": f"asset_{a['sha'][:12]}", "sha256": a["sha"],
                "refunded_bytes": r["refunded_bytes"],
                "file_removed": r["file_removed"],
                "storage_used_bytes": self.store.storage_used_bytes(tenant)}

    # ── IR 解析 ──────────────────────────────────────────
    def resolve_ir(self, payload: dict) -> tuple[dict, dict]:
        """支持两种入口：模板 + 变量，或直传 IR。返回 (ir, meta)。"""
        if not isinstance(payload, dict):
            raise JobError("E_BAD_REQUEST", "请求体必须是 JSON 对象")

        if "ir" in payload:
            ir = payload["ir"]
            if not isinstance(ir, dict):
                raise JobError("E_IR_INVALID", "ir 必须是对象", field="ir")
            return ir, {"source": "ir"}

        tid = payload.get("template_id")
        if not tid:
            raise JobError("E_BAD_REQUEST", "必须提供 template_id 或 ir",
                           field="template_id",
                           allowed_values=[t["id"] for t in self.templates()])

        assets = payload.get("assets") or []
        if not isinstance(assets, list):
            raise JobError("E_BAD_REQUEST", "assets 必须是数组", field="assets")
        for i, a in enumerate(assets):
            if not isinstance(a, dict) or not a.get("id") or not a.get("uri"):
                raise JobError("E_BAD_REQUEST", f"assets[{i}] 需要 id 与 uri",
                               field=f"assets[{i}]")

        ir = self.registry.instantiate(tid, payload.get("variables") or {}, assets)
        return ir, {"source": "template", "template_id": tid}

    # ── 校验 ─────────────────────────────────────────────
    def validate(self, payload: dict) -> dict:
        ir, meta = self.resolve_ir(payload)
        result = self.runner.preflight(ir)
        result["ir_id"] = ir.get("id")
        result["source"] = meta.get("source")
        return result

    # ── 提交 ─────────────────────────────────────────────
    def submit(self, payload: dict, tenant: str) -> dict:
        ir, meta = self.resolve_ir(payload)

        idem = payload.get("idempotency_key")
        if not idem or not isinstance(idem, str) or len(idem) < 8:
            raise JobError("E_BAD_REQUEST",
                           "idempotency_key 必填且至少 8 字符",
                           field="idempotency_key",
                           hint="用调用方自己的任务号，重复提交才不会重复计费")

        # 提交时解析并钉住公网 IP；投递时直连这个 IP，不做二次解析（防 DNS rebinding）
        cb = payload.get("callback_url")
        pin = netguard.resolve_pinned(
            str(cb), allow_private=self.cfg.allow_private_callbacks) if cb else None
        delivery_spec = delivery.parse_spec(payload, self.cfg)

        backend = payload.get("backend") or "ffmpeg"
        if backend not in ("ffmpeg", "mlt"):
            raise JobError("E_BAD_REQUEST", f"未知后端: {backend}",
                           field="backend", allowed_values=["ffmpeg", "mlt"])

        pre = self.runner.preflight(ir, backend=backend)
        if not pre["valid"]:
            for check in pre["checks"].values():
                if isinstance(check, dict) and check.get("error"):
                    raise JobError.from_dict(check["error"])
            raise JobError("E_IR_INVALID", "预检未通过", field="ir",
                           detail=json.dumps(pre["checks"], ensure_ascii=False)[:1500])

        norm = IR.normalize(ir)
        dur = IR.duration_seconds(norm)
        remaining = self.store.quota_remaining_seconds(tenant)
        if remaining is not None and dur > remaining:
            raise JobError("E_QUOTA_EXCEEDED",
                           f"本月剩余 {remaining:.0f}s，本次需要 {dur:.0f}s",
                           hint="下月重置或联系管理员提额",
                           allowed_values=[f"<= {remaining:.0f}"])
        if remaining is not None and remaining <= 0:
            raise JobError("E_QUOTA_EXCEEDED", "本月配额已用完")

        if payload.get("dry_run"):
            return {"dry_run": True, "status": "accepted", "job_id": None,
                    "idempotent_replay": False,
                    "estimate": estimate(norm).to_dict(),
                    "checks": {k: v.get("pass") for k, v in pre["checks"].items()}}

        # 背压：dry_run 不占队列，所以检查放在它之后、真正 INSERT 之前。
        # 没有这一层，一个租户批量灌任务就能让所有人的任务排几小时。
        q = self.store.queue_stats()
        if q["depth"] >= self.cfg.max_queue_depth:
            raise JobError(
                "E_QUEUE_FULL",
                f"队列深度 {q['depth']} 已达上限 {self.cfg.max_queue_depth}，"
                f"最老一条已等待 {q['oldest_wait_s']:.0f}s",
                hint="稍后重试、扩容 worker，或提高 RENDERD_MAX_QUEUE_DEPTH",
                allowed_values=[f"<= {self.cfg.max_queue_depth}"])
        mine = q["inflight_by_tenant"].get(tenant, 0)
        if mine >= self.cfg.max_tenant_inflight:
            raise JobError(
                "E_QUEUE_FULL",
                f"租户在途任务 {mine} 已达上限 {self.cfg.max_tenant_inflight}",
                hint="等当前任务结束，或由管理员提高 RENDERD_MAX_TENANT_INFLIGHT",
                allowed_values=[f"<= {self.cfg.max_tenant_inflight}"])

        ir_hash = IR.content_hash(norm, backend=backend,
                                  engine=self.runner.engine,
                                  font_fp="submit", target_fp="submit")
        prio = {"low": -10, "normal": 0, "high": 10}.get(
            payload.get("priority") or "normal", 0)
        job, replay = self.store.submit(
            tenant=tenant, idem_key=idem, ir_json=norm, ir_hash=ir_hash,
            frames_total=norm["output"]["duration_frames"], backend=backend,
            priority=prio, max_attempts=self.cfg.max_attempts,
            callback_url=payload.get("callback_url"),
            callback_pin=pin, delivery_spec=delivery_spec,
            cost_seconds=estimate(norm).render_s)

        self.store.audit(action="render.submit", tenant=tenant, target=job["id"],
                         data={"template": meta.get("template_id"), "replay": replay})

        return {
            "job_id": job["id"],
            "status": job["status"],
            "stage": job["stage"],
            "idempotent_replay": replay,
            "poll_after_s": 3,
            "estimate": estimate(norm).to_dict(),
            **{k: v for k, v in meta.items() if k != "source"},
        }

    # ── 查询 ─────────────────────────────────────────────
    def _get_job(self, job_id: str, tenant: str | None) -> dict:
        job = self.store.get(job_id, tenant)
        if not job:
            raise JobError("E_NOT_FOUND", f"任务不存在: {job_id}", field="job_id")
        return job

    def status(self, job_id: str, tenant: str | None) -> dict:
        j = self._get_job(job_id, tenant)
        out = {
            "job_id": j["id"],
            "status": j["status"],
            "stage": j["stage"],
            "attempts": j["attempts"],
            "max_attempts": j["max_attempts"],
            "frames_done": j["frames_done"],
            "frames_total": j["frames_total"],
            "cache_hit": bool(j["cache_hit"]),
            "cost_seconds": round(j["cost_seconds"] or 0, 3),
            "created_at": j["created_at"],
            "started_at": j["started_at"],
            "finished_at": j["finished_at"],
        }
        if j["status"] == "running" and j["started_at"]:
            out["elapsed_s"] = round(self.store.db_now() - j["started_at"], 1)
        if j["frames_total"] and j["status"] == "running":
            pct = j["frames_done"] / j["frames_total"]
            out["progress"] = round(pct, 4)
        if j["error_json"]:
            out["error"] = json.loads(j["error_json"])
        if j["status"] == "succeeded":
            out["video_url"] = auth.signed_url(j["id"], j["tenant"])
            out["receipt_url"] = f"/v1/jobs/{j['id']}/receipt"
        return out

    def receipt(self, job_id: str, tenant: str | None) -> dict:
        j = self._get_job(job_id, tenant)
        if not j["receipt_json"]:
            raise JobError("E_NOT_FOUND", "该任务尚无回执（未成功或仍在渲染）",
                           field="job_id", hint="先查询 status")
        rec = json.loads(j["receipt_json"])
        job = j["id"]
        owner = j["tenant"]
        if rec.get("evidence"):
            # 每个证据文件单独签一个 scope：成片链接不能拿去取 contact sheet。
            # 回执是给 Agent 直接用的，链接必须自带签名，否则点开就是 401。
            rec["evidence"] = {
                k: (auth.signed_url(job, owner) if k == "output"
                    else auth.signed_url(job, owner, scope="evidence",
                                         name=Path(v).name))
                for k, v in rec["evidence"].items()
            }
        rec["video_url"] = auth.signed_url(job, owner)
        return rec

    def events(self, job_id: str, tenant: str | None) -> list[dict]:
        self._get_job(job_id, tenant)
        return self.store.events(job_id)

    def cancel(self, job_id: str, tenant: str) -> dict:
        self._get_job(job_id, tenant)
        ok = self.store.cancel(job_id)
        if not ok:
            raise JobError("E_CANCELLED", "任务已在执行中或已结束，无法取消",
                           hint="运行中的任务需要等它结束")
        self.store.audit(action="render.cancel", tenant=tenant, target=job_id)
        return {"job_id": job_id, "status": "cancelled"}

    def list_jobs(self, tenant: str, limit: int = 50,
                  status: str | None = None) -> list[dict]:
        return self.store.list_jobs(tenant, limit=limit, status=status)

    def usage(self, tenant: str) -> dict:
        t = self.ensure_tenant(tenant)
        u = self.store.usage_get(tenant)
        return {
            "tenant": tenant,
            "period": u["period"],
            "rendered_seconds": round(u["seconds"], 1),
            "rendered_minutes": round(u["seconds"] / 60.0, 2),
            "jobs": u["jobs"],
            "monthly_quota_minutes": t["monthly_minutes"],
            "remaining_minutes": round(max(0.0, t["monthly_minutes"] - u["seconds"] / 60.0), 2),
            "qps": t["qps"],
            "assets": self.store.assets_count(tenant),
            "storage_used_bytes": self.store.storage_used_bytes(tenant),
            "storage_used_mb": round(self.store.storage_used_bytes(tenant) / 1048576, 2),
            "storage_quota_mb": t.get("storage_mb") or self.cfg.default_storage_mb,
            "inflight": self.store.queue_stats()["inflight_by_tenant"].get(tenant, 0),
            "inflight_limit": self.cfg.max_tenant_inflight,
        }

    # ── 队列运维 ──────────────────────────────────────────
    def queue(self, tenant: str | None = None, admin: bool = True) -> dict:
        """队列视图。非 admin 只能看到自己的在途数。

        depth / ready / running / oldest_wait_s 是容量信息，任何租户看到都合理；
        `inflight_by_tenant` 是**别人**的租户名与负载，那是运维视图，不该对租户开放。
        """
        q = self.store.queue_stats()
        if not admin:
            mine = q["inflight_by_tenant"].get(tenant or "", 0)
            q["inflight_by_tenant"] = {(tenant or ""): mine}
            q["scope"] = "tenant"
        else:
            q["scope"] = "admin"
        q["max_queue_depth"] = self.cfg.max_queue_depth
        q["max_tenant_inflight"] = self.cfg.max_tenant_inflight
        return q

    def dlq(self, tenant: str, limit: int = 50) -> dict:
        return {"jobs": self.store.dlq(tenant, limit)}

    def replay(self, job_id: str, tenant: str) -> dict:
        row = self.store.replay(job_id, tenant)
        if not row:
            raise JobError("E_NOT_FOUND",
                           f"死信中找不到可重放的任务: {job_id}", field="job_id",
                           hint="只有 status=failed 的任务可以重放")
        self.store.audit(action="render.replay", tenant=tenant, target=job_id)
        return {"job_id": row["id"], "status": "accepted",
                "attempts": row["attempts"], "replayed": True}

    def health(self) -> dict:
        caps = capabilities.summary(self.cfg.ffmpeg)
        # 后端列表是「这台机器实际能跑什么」，不是「代码支持什么」。
        # 缺 melt 时 backend=mlt 会在执行阶段报错，提前声明能省掉一次必然失败的渲染。
        backends = ["ffmpeg"]
        if shutil.which(self.cfg.melt):
            backends.append("mlt")
        return {
            "ok": True,
            "version": __version__,
            "ir_version": IR_VERSION,
            "engine": self.runner.engine,
            "uptime_s": round(time.time() - self.started_at, 1),
            "backend_default": "ffmpeg",
            "backends": backends,
            "capabilities": caps,
            "fonts_available": len([k for k in __import__(
                "renderd.fonts", fromlist=["x"]).font_index() if "/" not in k]),
        }

    def ready(self) -> dict:
        """就绪探针：现在到底能不能接活。

        和 healthz 的分工是刻意的，不是重复：
        - `healthz` 只回答「进程活着吗」。优雅退出中、正在重启，它都该是 200，
          否则编排系统会把「正在体面收尾」当成「挂了」直接 kill。
        - `readyz` 回答「能接流量吗」。DB 断了、盘满了、ffmpeg 丢了，必须摘掉，
          否则负载均衡继续打进来，客户端拿到的是 500 而不是一个明确的 503。

        磁盘闸放在这里的原因：渲染是「素材进、成片出」，盘满时 ffmpeg 会在
        写到一半失败，报出来的错和编码失败长得一样，比直接拒单难查得多。
        """
        checks: dict[str, dict] = {}
        ok = True

        try:
            ms = self.store.ping()
            checks["db"] = {"ok": True, "ms": round(ms, 2)}
        except Exception as exc:  # noqa: BLE001 —— 探针必须吞掉所有异常并报告
            checks["db"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            ok = False

        try:
            probe = self.cfg.tmp_dir / f".readyz-{os.getpid()}"
            probe.write_bytes(b"1")
            probe.unlink()
            checks["data_dir"] = {"ok": True, "path": str(self.cfg.data_dir)}
        except OSError as exc:
            checks["data_dir"] = {"ok": False, "path": str(self.cfg.data_dir),
                                  "error": f"{type(exc).__name__}: {exc}"}
            ok = False

        try:
            free_gb = shutil.disk_usage(str(self.cfg.data_dir)).free / (1024 ** 3)
            enough = free_gb >= self.cfg.min_free_gb
            checks["disk"] = {"ok": enough, "free_gb": round(free_gb, 2),
                              "threshold_gb": self.cfg.min_free_gb}
            ok = ok and enough
        except OSError as exc:
            checks["disk"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            ok = False

        for name, exe in (("ffmpeg", self.cfg.ffmpeg), ("ffprobe", self.cfg.ffprobe)):
            found = shutil.which(exe) or (exe if os.path.isfile(exe) else None)
            checks[name] = {"ok": bool(found), "path": found}
            ok = ok and bool(found)

        return {"ok": ok, "checks": checks, "version": __version__,
                "uptime_s": round(time.time() - self.started_at, 1)}

    def metrics(self) -> str:
        s = self.store.stats()
        lines = [
            "# HELP renderd_jobs_total Total jobs submitted",
            "# TYPE renderd_jobs_total counter",
            f"renderd_jobs_total {s['jobs_total']}",
            "# HELP renderd_cache_entries Cached renders",
            "# TYPE renderd_cache_entries gauge",
            f"renderd_cache_entries {s['cache_entries']}",
            "# HELP renderd_cache_hits_total Cache hits",
            "# TYPE renderd_cache_hits_total counter",
            f"renderd_cache_hits_total {s['cache_hits']}",
        ]
        q = self.store.queue_stats()
        gauges = [
            ("renderd_queue_depth", "Jobs waiting to be claimed", q["depth"]),
            ("renderd_queue_ready", "Jobs ready to run now", q["ready"]),
            ("renderd_queue_delayed", "Jobs in retry backoff", q["delayed"]),
            ("renderd_jobs_running", "Jobs currently running", q["running"]),
            ("renderd_queue_oldest_wait_seconds", "Age of oldest queued job",
             q["oldest_wait_s"]),
            ("renderd_failed_jobs_24h", "Jobs failed in last 24h", q["failed_24h"]),
            ("renderd_clock_skew_seconds", "Wall vs monotonic drift at last reaper scan",
             q.get("clock_skew_s") or 0),
        ]
        for name, help_text, value in gauges:
            lines += [f"# HELP {name} {help_text}",
                      f"# TYPE {name} gauge", f"{name} {value}"]
        lines += ["# HELP renderd_tenant_inflight Jobs in flight per tenant",
                  "# TYPE renderd_tenant_inflight gauge"]
        for tenant_name, n in sorted(q["inflight_by_tenant"].items()):
            lines.append(f'renderd_tenant_inflight{{tenant="{tenant_name}"}} {n}')
        for item in s["by_status"]:
            lines.append(f'renderd_jobs{{status="{item["status"]}",stage="{item["stage"]}"}} '
                         f'{item["count"]}')
        lines.append(f"renderd_uptime_seconds {round(time.time() - self.started_at, 1)}")
        return "\n".join(lines) + "\n"
