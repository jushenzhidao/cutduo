#!/usr/bin/env python3
"""本轮新增能力的端到端验证：webhook / 直传交付 / DNS rebinding / 存储配额 / metrics。

不是为了凑覆盖率：这几条路径在上一轮都只有代码、没有测试；
其中「DNS 二次解析」光看代码看不出来，必须让解析器在投递阶段失效才能证明。
"""
from __future__ import annotations

import json
import re
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from renderd import netguard                            # noqa: E402
from renderd.config import load_config                   # noqa: E402
from renderd.fixtures import ensure_media                # noqa: E402
from renderd.service import Service                     # noqa: E402
from renderd.worker import Worker                        # noqa: E402

RECORDED: list[dict] = []
STATUSES: list[int] = []


class Receiver(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _handle(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        RECORDED.append({"method": self.command, "path": self.path,
                         "body": body, "headers": dict(self.headers)})
        code = STATUSES.pop(0) if STATUSES else 200
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    do_POST = _handle
    do_PUT = _handle

    def log_message(self, *args) -> None:
        pass


class Harness(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self) -> None:
        RECORDED.clear()
        STATUSES.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = load_config(Path(self.tmp.name) / "data")
        self.cfg.allow_private_callbacks = True
        self.cfg.default_storage_mb = 2          # 存储配额测试用
        self.svc = Service(self.cfg)
        self.svc.ensure_tenant("t", monthly_minutes=10000, qps=1000)
        self.media = ensure_media(self.cfg.media_dir)
        self.uri = "file://" + self.media["v_a.mp4"]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _payload(self, key: str, **over) -> dict:
        p = {
            "template_id": "hook_vertical_6s",
            "variables": {"clip": "a1", "hook": "加固测试"},
            "assets": [{"id": "a1", "uri": self.uri}],
            "idempotency_key": key,
        }
        p.update(over)
        return p

    def _run(self, payload: dict) -> dict:
        sub = self.svc.submit(payload, "t")
        Worker(self.cfg, self.svc.store, self.svc.runner, name="w-hard").run_once()
        return self.svc.store.get(sub["job_id"])

    # ── webhook ──
    def test_01_webhook_delivered(self) -> None:
        url = f"http://127.0.0.1:{self.port}/hook"
        job = self._run(self._payload("hook-ok-0001", callback_url=url))
        self.assertEqual(job["status"], "succeeded")
        posts = [r for r in RECORDED if r["method"] == "POST"]
        self.assertEqual(len(posts), 1, "应恰好投递一次")
        body = json.loads(posts[0]["body"])
        self.assertEqual(body["job_id"], job["id"])
        self.assertEqual(body["status"], "succeeded")
        self.assertIn("receipt_url", body)
        self.assertTrue(job["callback_ip"].startswith("{"))
        self.assertEqual(json.loads(job["callback_ip"])["ip"], "127.0.0.1")

    def test_02_webhook_retry_once(self) -> None:
        STATUSES.extend([500, 200])
        url = f"http://127.0.0.1:{self.port}/hook"
        job = self._run(self._payload("hook-retry-0001", callback_url=url))
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(len([r for r in RECORDED if r["method"] == "POST"]), 2)

    def test_03_webhook_failure_does_not_fail_job(self) -> None:
        # 指向一个没有监听的端口：投递失败只能降级，不能把成功的任务判失败
        url = "http://127.0.0.1:1/hook"
        job = self._run(self._payload("hook-dead-0001", callback_url=url))
        self.assertEqual(job["status"], "succeeded")
        evs = self.svc.store.events(job["id"])
        self.assertTrue(any("webhook 投递失败" in e["message"] for e in evs))

    # ── DNS rebinding ──
    def test_04_no_dns_resolution_at_delivery(self) -> None:
        """投递阶段让所有域名解析失败；若走 pinned IP 直连，webhook 仍应送达。"""
        url = f"http://localhost:{self.port}/hook"
        payload = self._payload("dns-rebind-0001", callback_url=url)
        sub = self.svc.submit(payload, "t")
        job = self.svc.store.get(sub["job_id"])
        # 先跑完任务但暂时屏蔽 _notify 之外的解析
        original = socket.getaddrinfo

        def guarded(host, port, *a, **kw):
            if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", str(host)):
                raise socket.gaierror("simulated DNS failure / rebinding")
            return original(host, port, *a, **kw)

        socket.getaddrinfo = guarded
        try:
            Worker(self.cfg, self.svc.store, self.svc.runner,
                   name="w-dns").run_once()
        finally:
            socket.getaddrinfo = original
        done = self.svc.store.get(sub["job_id"])
        self.assertEqual(done["status"], "succeeded")
        posts = [r for r in RECORDED if r["method"] == "POST"]
        self.assertEqual(len(posts), 1, "域名解析全挂时仍应通过钉住的 IP 送达")
        self.assertEqual(posts[0]["headers"]["Host"], f"localhost:{self.port}")

    def test_05_private_ip_rejected_by_default(self) -> None:
        from renderd.errors import JobError
        cfg = load_config(Path(self.tmp.name) / "strict")
        cfg.allow_private_callbacks = False
        with self.assertRaises(JobError) as ctx:
            netguard.resolve_pinned("http://127.0.0.1:9999/x",
                                    allow_private=False)
        self.assertEqual(ctx.exception.code, "E_CALLBACK_FORBIDDEN")

    # ── 直传交付 ──
    def test_06_put_url_delivery(self) -> None:
        url = f"http://127.0.0.1:{self.port}/upload/clip.mp4"
        payload = self._payload("put-url-0001",
                                 delivery={"mode": "put_url", "url": url})
        job = self._run(payload)
        self.assertEqual(job["status"], "succeeded")
        puts = [r for r in RECORDED if r["method"] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertIn(b"ftyp", puts[0]["body"][:16], "PUT 的应是真实 MP4")
        self.assertTrue(len(puts[0]["body"]) > 10000, "PUT 的应是真实成片")
        rec = json.loads(job["receipt_json"])
        self.assertEqual(rec["delivery"]["mode"], "put_url")
        self.assertEqual(rec["delivery"]["status"], "delivered")
        self.assertEqual(rec["delivery"]["http_status"], 200)

    def test_07_put_url_failure_recorded(self) -> None:
        url = "http://127.0.0.1:1/upload/clip.mp4"
        payload = self._run(self._payload(
            "put-url-dead-0001", delivery={"mode": "put_url", "url": url}))
        self.assertEqual(payload["status"], "succeeded")
        rec = json.loads(payload["receipt_json"])
        self.assertEqual(rec["delivery"]["status"], "failed")
        self.assertTrue(any("直传失败" in w for w in rec["warnings"]))
        # 成片确实生成（job=succeeded），但客户唯一取片通道失败，
        # 回执必须降级，否则 Agent 会以为交付成功而不再重试。
        self.assertEqual(rec["verdict"], "fail")
        self.assertIn("E_DELIVERY_FAILED", rec["failures"])

    # ── 存储配额 ──
    def test_08_storage_quota(self) -> None:
        from renderd.errors import JobError
        self.svc.store.set_quota("t", storage_mb=1)
        small = b"x" * 600000
        info = self.svc.put_asset(small, "a.mp4", tenant="t")
        self.assertFalse(info["deduplicated"])
        # 重复上传同一内容不重复计费
        again = self.svc.put_asset(small, "a.mp4", tenant="t")
        self.assertTrue(again["deduplicated"])
        self.assertEqual(self.svc.store.storage_used_bytes("t"), len(small))
        with self.assertRaises(JobError) as ctx:
            self.svc.put_asset(b"y" * 600000, "b.mp4", tenant="t")
        self.assertEqual(ctx.exception.code, "E_QUOTA_STORAGE_EXCEEDED")
        usage = self.svc.usage("t")
        self.assertEqual(usage["storage_quota_mb"], 1)
        self.assertGreater(usage["storage_used_bytes"], 0)

    # ── 缓存命中的磁盘语义 ──
    def test_10_cache_hit_uses_hardlink(self) -> None:
        import os
        j1 = self._run(self._payload("hardlink-0001"))
        j2 = self._run(self._payload("hardlink-0002"))
        self.assertEqual(j1["status"], "succeeded")
        self.assertEqual(j2["status"], "succeeded")
        self.assertEqual(j2["cache_hit"], 1)
        p1, p2 = Path(j1["output_path"]), Path(j2["output_path"])
        self.assertEqual(p1.stat().st_ino, p2.stat().st_ino,
                         "缓存命中应硬链接同一 inode，而不是复制 5MB 成片")
        self.assertGreater(p1.stat().st_nlink, 1)

    def test_11_thread_connection_released(self) -> None:
        # 后端无关：只断言「关闭后不可再用 + 能重建干净连接」。
        # 具体异常类型与 row 形状属于 SQLite/PG 各自的驱动细节，不该写进测试。
        st = self.svc.store
        c1 = st._conn()
        st.close_thread_connection()
        with self.assertRaises(Exception):
            c1.execute("SELECT 1")
        c2 = st._conn()
        self.assertIsNot(c1, c2, "关闭后应能重新建立干净的连接")
        row = c2.execute("SELECT 1 AS n").fetchone()
        self.assertEqual(row["n"] if isinstance(row, dict) else row[0], 1)

    # ── metrics 白名单 ──
    def test_09_metrics_cidrs(self) -> None:
        import ipaddress
        from renderd.api import _valid_net

        def allowed(src: str, cidrs: str) -> bool:
            addr = ipaddress.ip_address(src)
            return any(addr in ipaddress.ip_network(c.strip(), strict=False)
                       for c in cidrs.split(",") if _valid_net(c.strip()))

        self.assertFalse(allowed("203.0.113.5", "10.0.0.0/8"))
        self.assertTrue(allowed("127.0.0.1", "127.0.0.1/32"))
        self.assertTrue(allowed("192.168.1.7", "10.0.0.0/8,192.168.0.0/16"))
        self.assertFalse(allowed("203.0.113.5", "not-a-cidr"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
