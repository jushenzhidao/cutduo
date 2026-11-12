#!/usr/bin/env python3
"""月度时长配额：在途任务必须预占额度。

背景（2026-11-10 实测的缺陷）：`submit()` 只读配额、`usage_add()` 在渲染成功后才记账，
于是排队中的任务完全不占额度 —— 60 s 配额的租户连提 8 个 15 s 任务，8 个全收（120 s）。
修法是把 `billed_seconds` 写在任务行上，配额判定改成「已用 + 在途预占」，并且放进
`store.submit()` 的同一个事务里（读-判-写之间不能有间隙）。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from renderd.config import load_config                     # noqa: E402
from renderd.errors import JobError                        # noqa: E402
from renderd.fixtures import ensure_media                  # noqa: E402
from renderd.service import Service                        # noqa: E402


class Quota(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = load_config(Path(self.tmp.name) / "data")
        self.cfg.max_tenant_inflight = 100     # 让配额成为唯一约束
        self.svc = Service(self.cfg)
        self.svc.ensure_tenant("q", monthly_minutes=1, qps=1000)   # 60 s
        media = ensure_media(self.cfg.media_dir)
        self.assets = [{"id": "a1", "uri": "file://" + media["v_a.mp4"]},
                       {"id": "b1", "uri": "file://" + media["v_b.mp4"]},
                       {"id": "c1", "uri": "file://" + media["v_c.mp4"]},
                       {"id": "m1", "uri": "file://" + media["music.m4a"]}]

    def tearDown(self) -> None:
        self.svc.store.close_thread_connection()
        self.tmp.cleanup()

    def _submit(self, key: str) -> dict:
        return self.svc.submit({
            "template_id": "brand_vertical_15s",
            "variables": {"clip1": "a1", "clip2": "b1", "clip3": "c1",
                          "title": "配额", "music": "m1"},
            "assets": self.assets,
            "idempotency_key": f"quota-test-{key}",
        }, "q")

    def test_in_flight_jobs_hold_quota(self) -> None:
        """60 s 配额 + 15 s 任务：只能进 4 个，第 5 个必须被拒。"""
        for i in range(4):
            self._submit(f"q-{i:02d}")
        self.assertEqual(self.svc.store.quota_reserved_seconds("q"), 60.0)
        self.assertEqual(self.svc.store.quota_remaining_seconds("q"), 0.0)

        with self.assertRaises(JobError) as ctx:
            self._submit("q-04")
        self.assertEqual(ctx.exception.code, "E_QUOTA_EXCEEDED")
        self.assertIn("在途", ctx.exception.message)

    def test_replay_does_not_recheck_quota(self) -> None:
        """幂等重放不该因为配额用尽而失败 —— 它没有产生新任务。"""
        first = self._submit("q-same")
        for i in range(3):
            self._submit(f"q-fill-{i}")
        self.assertEqual(self.svc.store.quota_remaining_seconds("q"), 0.0)

        again = self._submit("q-same")
        self.assertEqual(again["job_id"], first["job_id"])
        self.assertTrue(again.get("idempotent_replay"))

    def test_completion_releases_reservation(self) -> None:
        """任务结束（成功记用量 / 失败释放）后，预占必须消失。"""
        job = self._submit("q-done")
        self.assertEqual(self.svc.store.quota_reserved_seconds("q"), 15.0)

        self.svc.store.succeed(job["job_id"], output_path="", receipt_path="",
                               receipt={"verdict": "pass"}, cache_hit=False)
        self.svc.store.usage_add("q", 15.0)
        self.assertEqual(self.svc.store.quota_reserved_seconds("q"), 0.0)
        # 用量记账后总额不变（15 s 已用 + 0 预占 = 60 - 15 剩余）
        self.assertEqual(self.svc.store.quota_remaining_seconds("q"), 45.0)

    def test_failed_job_releases_reservation(self) -> None:
        job = self._submit("q-fail")
        self.assertEqual(self.svc.store.quota_reserved_seconds("q"), 15.0)
        self.svc.store.fail(job["job_id"],
                            {"code": "E_RENDER_FAILED", "retryable": False})
        self.assertEqual(self.svc.store.quota_reserved_seconds("q"), 0.0)
        self.assertEqual(self.svc.store.quota_remaining_seconds("q"), 60.0)


if __name__ == "__main__":
    unittest.main()
