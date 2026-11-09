"""就绪探针（`/readyz`）：任何一项不过都必须判不可用。

这条用例守的是一个真实事故形态：DB 断了、盘满了，`/healthz` 照样 200，
负载均衡继续打流量，客户端拿到 500 而不是明确的 503 —— 排障时看到的
是「服务活着但一直报错」，而不是「这个实例被摘掉了」。
"""

from __future__ import annotations

import unittest
from unittest import mock

from helpers import Sandbox


class TestReadyz(unittest.TestCase):
    def setUp(self) -> None:
        self.sb = Sandbox("readyz")
        self.svc = self.sb.service

    def tearDown(self) -> None:
        self.sb.cleanup()

    def test_01_all_green(self) -> None:
        body = self.svc.ready()
        self.assertTrue(body["ok"], body)
        for name in ("db", "data_dir", "disk", "ffmpeg", "ffprobe"):
            self.assertTrue(body["checks"][name]["ok"], f"{name}: {body['checks'][name]}")
        # 探针要有耗时，才能区分「连上了」和「连上了但很慢」
        self.assertGreaterEqual(body["checks"]["db"]["ms"], 0)

    def test_02_db_down_marks_not_ready(self) -> None:
        with mock.patch.object(self.svc.store, "ping", side_effect=RuntimeError("conn refused")):
            body = self.svc.ready()
        self.assertFalse(body["ok"])
        self.assertFalse(body["checks"]["db"]["ok"])
        self.assertIn("conn refused", body["checks"]["db"]["error"])
        # 其他项不受牵连：诊断要能指出到底哪一项坏了
        self.assertTrue(body["checks"]["disk"]["ok"])

    def test_03_disk_below_threshold(self) -> None:
        self.svc.cfg.min_free_gb = 10 ** 9   # 任何真实磁盘都不够
        body = self.svc.ready()
        self.assertFalse(body["ok"])
        self.assertFalse(body["checks"]["disk"]["ok"])
        self.assertEqual(body["checks"]["disk"]["threshold_gb"], 10 ** 9)
        self.assertTrue(body["checks"]["db"]["ok"])

    def test_04_ffmpeg_missing(self) -> None:
        self.svc.cfg.ffmpeg = "/nonexistent/ffmpeg"
        body = self.svc.ready()
        self.assertFalse(body["ok"])
        self.assertFalse(body["checks"]["ffmpeg"]["ok"])
        self.assertIsNone(body["checks"]["ffmpeg"]["path"])

    def test_05_healthz_survives_what_readyz_rejects(self) -> None:
        """分工的证明：同一个坏掉的实例，healthz 该 200，readyz 该 503。"""
        with mock.patch.object(self.svc.store, "ping", side_effect=RuntimeError("down")):
            self.assertTrue(self.svc.health()["ok"])
            self.assertFalse(self.svc.ready()["ok"])

    def test_06_unwritable_data_dir(self) -> None:
        with mock.patch("pathlib.Path.write_bytes", side_effect=OSError("read-only fs")):
            body = self.svc.ready()
        self.assertFalse(body["ok"])
        self.assertFalse(body["checks"]["data_dir"]["ok"])
        self.assertIn("read-only fs", body["checks"]["data_dir"]["error"])


if __name__ == "__main__":
    unittest.main()
