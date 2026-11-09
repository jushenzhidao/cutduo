#!/usr/bin/env python3
"""生产级异步四项能力的回归：可观测 / 背压 / 重试退避 / 死信重放。"""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from renderd.config import load_config                     # noqa: E402
from renderd.errors import JobError                        # noqa: E402
from renderd.fixtures import ensure_media                  # noqa: E402
from renderd.service import Service                        # noqa: E402

RECEIVED: list[dict] = []


class Sink(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        RECEIVED.append(json.loads(self.rfile.read(n) or b"{}"))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args) -> None:
        pass


class ProdAsync(unittest.TestCase):
    def setUp(self) -> None:
        RECEIVED.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = load_config(Path(self.tmp.name) / "data")
        self.cfg.allow_private_callbacks = True
        self.svc = Service(self.cfg)
        self.svc.ensure_tenant("t", monthly_minutes=10000, qps=1000)
        self.media = ensure_media(self.cfg.media_dir)
        self.uri = "file://" + self.media["v_a.mp4"]

    def tearDown(self) -> None:
        # 测试进程不经过 HTTP _dispatch 的 finally，显式关掉线程局部连接
        self.svc.store.close_thread_connection()
        self.tmp.cleanup()

    def _payload(self, key: str) -> dict:
        return {"template_id": "hook_vertical_6s",
                "variables": {"clip": "a1", "hook": "生产级"},
                "assets": [{"id": "a1", "uri": self.uri}],
                "idempotency_key": key}

    def _insert(self, key: str) -> dict:
        """绕过准入直接落一条任务，用于测队列原语。"""
        job, _ = self.svc.store.submit(
            tenant="t", idem_key=key, ir_json={"ir_version": "0.1", "id": key},
            ir_hash="h", frames_total=60)
        return job

    # ── 1 可观测 ──
    def test_01_queue_stats_fields(self) -> None:
        self._insert("stats-0001")
        q = self.svc.store.queue_stats()
        for k in ("depth", "ready", "delayed", "running", "oldest_wait_s",
                  "next_lease_s", "inflight_by_tenant", "failed_24h"):
            self.assertIn(k, q, k)
        self.assertEqual(q["depth"], 1)
        self.assertEqual(q["ready"], 1)
        self.assertEqual(q["inflight_by_tenant"].get("t"), 1)

    def test_02_metrics_exposes_gauges(self) -> None:
        self._insert("metrics-0001")
        m = self.svc.metrics()
        for name in ("renderd_queue_depth", "renderd_queue_ready",
                     "renderd_queue_delayed", "renderd_jobs_running",
                     "renderd_queue_oldest_wait_seconds",
                     "renderd_tenant_inflight", "renderd_failed_jobs_24h"):
            self.assertIn(name, m, name)
        self.assertIn('renderd_tenant_inflight{tenant="t"} 1', m)

    # ── 2 背压 ──
    def test_03_global_queue_depth_limit(self) -> None:
        self.cfg.max_queue_depth = 2
        self.cfg.max_tenant_inflight = 100
        self.svc.submit(self._payload("bp-global-0001"), "t")
        self.svc.submit(self._payload("bp-global-0002"), "t")
        with self.assertRaises(JobError) as ctx:
            self.svc.submit(self._payload("bp-global-0003"), "t")
        self.assertEqual(ctx.exception.code, "E_QUEUE_FULL")
        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(self.svc.store.queue_stats()["depth"], 2)

    def test_04_tenant_inflight_limit(self) -> None:
        self.cfg.max_queue_depth = 100
        self.cfg.max_tenant_inflight = 2
        self.svc.submit(self._payload("bp-tenant-0001"), "t")
        self.svc.submit(self._payload("bp-tenant-0002"), "t")
        with self.assertRaises(JobError) as ctx:
            self.svc.submit(self._payload("bp-tenant-0003"), "t")
        self.assertEqual(ctx.exception.code, "E_QUEUE_FULL")
        self.assertEqual(self.svc.usage("t")["inflight"], 2)

    def test_05_dry_run_bypasses_backpressure(self) -> None:
        self.cfg.max_queue_depth = 1
        self.cfg.max_tenant_inflight = 1
        for i in range(3):
            p = self._payload(f"bp-dry-{i:04d}")
            p["dry_run"] = True
            out = self.svc.submit(p, "t")
            self.assertTrue(out["dry_run"])
        self.assertEqual(self.svc.store.queue_stats()["depth"], 0)

    # ── 3 重试退避 ──
    def test_06_retry_backoff_blocks_immediate_reclaim(self) -> None:
        job = self._insert("backoff-0001")
        claimed = self.svc.store.claim("w1", 60)
        self.assertEqual(claimed["id"], job["id"])
        self.assertEqual(claimed["attempts"], 1)
        status = self.svc.store.fail(
            job["id"], {"code": "E_TIMEOUT", "retryable": True},
            backoff_base_s=5.0)
        self.assertEqual(status, "accepted")
        row = self.svc.store.get(job["id"])
        self.assertGreater(row["available_at"] - time.time(), 4.0)
        self.assertIsNone(self.svc.store.claim("w2", 60),
                          "退避期内不该被立刻重新领取")
        # 到期后可取，且 attempts 递增而不是连烧
        with self.svc.store.tx() as c:
            c.execute("UPDATE jobs SET available_at=? WHERE id=?",
                      (time.time() - 1, job["id"]))
        again = self.svc.store.claim("w3", 60)
        self.assertIsNotNone(again)
        self.assertEqual(again["attempts"], 2)

    def test_07_nonretryable_goes_straight_to_failed(self) -> None:
        job = self._insert("noretry-0001")
        self.svc.store.claim("w1", 60)
        status = self.svc.store.fail(
            job["id"], {"code": "E_FONT_MISSING", "retryable": False},
            backoff_base_s=5.0)
        self.assertEqual(status, "failed")
        self.assertIsNone(self.svc.store.get(job["id"])["available_at"])

    # ── 4 死信 / 重放 / 主动归还 ──
    def test_08_dlq_and_replay(self) -> None:
        job = self._insert("dlq-0001")
        self.svc.store.claim("w1", 60)
        self.svc.store.fail(job["id"], {"code": "E_OUTPUT_INVALID",
                                        "retryable": False})
        rows = self.svc.store.dlq("t")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["error_code"], "E_OUTPUT_INVALID")
        # 别的租户看不到
        self.assertEqual(len(self.svc.store.dlq("rival")), 0)
        out = self.svc.replay(job["id"], "t")
        self.assertTrue(out["replayed"])
        row = self.svc.store.get(job["id"])
        self.assertEqual(row["status"], "accepted")
        self.assertEqual(row["attempts"], 0)
        self.assertIsNone(row["error_code"])
        self.assertEqual(len(self.svc.store.dlq("t")), 0)

    def test_09_release_worker(self) -> None:
        job = self._insert("release-0001")
        self.svc.store.claim("w1", 60)
        self.assertEqual(self.svc.store.queue_stats()["running"], 1)
        ids = self.svc.store.release_worker("w1")
        self.assertEqual(ids, [job["id"]])
        self.assertEqual(self.svc.store.queue_stats()["running"], 0)
        again = self.svc.store.claim("w2", 60)
        self.assertEqual(again["id"], job["id"])

    # ── 5 webhook 去重键 ──
    def test_10_webhook_event_id(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            pin = {"url": f"http://127.0.0.1:{port}/hook", "host": "127.0.0.1",
                   "port": port, "ip": "127.0.0.1", "scheme": "http", "path": "/hook"}
            job = {"id": "job_eventid01", "attempts": 2,
                   "callback_url": pin["url"],
                   "callback_ip": json.dumps(pin)}
            self.svc.runner._notify(job, "succeeded")
            self.assertEqual(len(RECEIVED), 1)
            self.assertEqual(RECEIVED[0]["event_id"],
                             "job_eventid01:succeeded:2")
            self.assertEqual(RECEIVED[0]["attempt"], 2)
            self.svc.runner._notify(job, "succeeded")
            self.assertEqual(RECEIVED[0]["event_id"], RECEIVED[1]["event_id"],
                             "同一次尝试重发必须持有同一个去重键")
        finally:
            httpd.shutdown()
            httpd.server_close()

    # ── 6 优雅退出配置 ──
    def test_11_graceful_shutdown_config(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn("STOPSIGNAL SIGTERM", dockerfile)
        for name in ("docker-compose.yml", "docker-compose.tls.yml"):
            s = (ROOT / name).read_text()
            self.assertGreaterEqual(s.count("stop_grace_period: 300s"), 2, name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
