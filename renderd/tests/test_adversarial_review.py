"""对抗审查的常驻断言：修过的问题必须有测试钉住。

五条都来自实测（见 /tmp/adversarial_probe.py 的修复前后对照）：
  A 默认签名密钥可伪造下载 URL
  B 出站请求头 CRLF 注入 / 覆盖 Host
  C 证据文件无内容承诺，被替换后回执仍说 pass
  D 唯一交付通道失败，回执仍说 pass
  E 墙钟前跳把 running 任务误回收（双领）

第一性原理：
  · 密钥熵来自运行时，不能来自源码常量；
  · 输入净化在准入边界，不在出站前一刻；
  · Agent 看不见视频，回执要对它引用的每个文件做内容承诺；
  · 「成功」由客户能否拿到成片定义，不是「文件写到了我的磁盘」；
  · 时钟不确定时，宁可不动状态。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))


class TestSecret(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.pop(k, None)
                       for k in ("RENDERD_SECRET", "RENDERD_TOKEN")}
        self.tmp = tempfile.mkdtemp(prefix="adv-secret-")

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def test_01_source_default_cannot_forge_signature(self) -> None:
        from renderd import auth

        src = auth.init_secret(self.tmp)
        self.assertIn(src, ("generated", "file"))
        exp = int(time.time()) + 3600
        forged = hmac.new(b"renderd-dev-secret", f"job_x:{exp}".encode(),
                          hashlib.sha256).hexdigest()[:32]
        self.assertFalse(auth.verify("job_x", exp, forged),
                         "源码里的常量绝不能当签名密钥")
        self.assertTrue(auth.verify("job_x", exp, auth.sign("job_x", exp)),
                        "服务自己签出的 URL 必须仍可验证")
        # 密钥落盘且重启复用（否则已发出的 URL 会全部失效）
        self.assertTrue((Path(self.tmp) / ".signing_key").exists())
        self.assertEqual(auth.init_secret(self.tmp), "file")

    def test_02_weak_secret_rejected_at_startup(self) -> None:
        from renderd import auth

        for weak in ("change-me", "renderd-dev-secret", "secret"):
            os.environ["RENDERD_SECRET"] = weak
            with self.assertRaises(RuntimeError, msg=f"{weak} 应被拒绝"):
                auth.init_secret(self.tmp)
        os.environ["RENDERD_SECRET"] = "x" * 32
        self.assertEqual(auth.init_secret(self.tmp), "env")

    def test_03_signature_rejects_clock_rollback(self) -> None:
        from renderd import auth

        auth.init_secret(self.tmp)
        exp = int(time.time()) + 3600
        sig = auth.sign("job_y", exp)
        old = auth._BOOT_WALL
        try:
            auth._BOOT_WALL = time.time() + 7200     # 模拟墙钟被回拨 2 小时
            self.assertFalse(auth.verify("job_y", exp, sig),
                             "时钟回拨不应让已发出的签名重新有效")
        finally:
            auth._BOOT_WALL = old


class TestHeaderInjection(unittest.TestCase):
    def test_04_sanitizer_blocks_crlf_and_protected(self) -> None:
        from renderd import netguard

        bad = [
            {"X-Note": "a\r\nX-Injected: yes"},
            {"X-Note": "a\nX-Injected: yes"},
            {"Host": "evil.example"},
            {"Content-Length": "999"},
            {"X Bad": "v"},
            {"X-Note": "中文"},
            {"X-Note": "a\x00b"},
        ]
        for h in bad:
            with self.assertRaises(ValueError, msg=str(h)):
                netguard.sanitize_headers(h)
        self.assertEqual(netguard.sanitize_headers({"X-Trace": "ok"}),
                         {"X-Trace": "ok"})
        self.assertEqual(netguard.sanitize_headers(None), {})

    def test_05_rejected_at_admission_not_at_delivery(self) -> None:
        from renderd.config import load_config
        from renderd.delivery import parse_spec
        from renderd.errors import JobError

        cfg = load_config(tempfile.mkdtemp(prefix="adv-cfg-"))
        cfg.allow_private_callbacks = True
        with self.assertRaises(JobError) as cm:
            parse_spec({"delivery": {
                "mode": "put_url", "url": "http://127.0.0.1:9/x",
                "headers": {"X": "a\r\nX-Injected: yes"}}}, cfg)
        self.assertEqual(getattr(cm.exception, "code", ""), "E_BAD_REQUEST")
        self.assertEqual(getattr(cm.exception, "field", ""), "delivery.headers")


class TestReceiptIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from helpers import Sandbox

        cls.s = Sandbox("adv-receipt")
        cls.s.cfg.allow_private_callbacks = True
        cls.ok = cls.s.render({"template_id": "hook_vertical_6s",
                               "variables": {"clip": "a0", "hook": "正常交付"},
                               "assets": cls.s.assets("v_a.mp4")})
        cls.bad = cls.s.render({"template_id": "hook_vertical_6s",
                                "variables": {"clip": "a0", "hook": "直传失败"},
                                "assets": cls.s.assets("v_a.mp4"),
                                "delivery": {"mode": "put_url",
                                             "url": "http://127.0.0.1:1/x.mp4"}})

    @classmethod
    def tearDownClass(cls) -> None:
        cls.s.cleanup()

    def test_06_evidence_files_have_digests(self) -> None:
        from renderd.validate import sha256_file

        rec = json.loads(self.ok["receipt_json"])
        dig = rec.get("evidence_sha256") or {}
        self.assertGreaterEqual(len(dig), 3, "证据文件数量不对")
        for name, h in dig.items():
            p = Path(rec["evidence"][name])
            self.assertTrue(p.exists(), name)
            self.assertEqual(sha256_file(p), h, f"{name} 的承诺与实际内容不一致")
        self.assertEqual(rec["verdict"], "pass")

    def test_07_delivery_failure_degrades_verdict(self) -> None:
        rec = json.loads(self.bad["receipt_json"])
        self.assertEqual(self.bad["status"], "succeeded",
                         "成片确实生成，job 状态不该被交付失败改写")
        self.assertEqual(rec["delivery"]["status"], "failed")
        self.assertEqual(rec["verdict"], "fail",
                         "客户唯一取片通道失败，回执不能说 pass")
        self.assertIn("E_DELIVERY_FAILED", rec["failures"])


class TestClockSkew(unittest.TestCase):
    def test_08_clock_jump_blocks_reaper(self) -> None:
        from helpers import Sandbox

        s = Sandbox("adv-clock")
        j = s.service.submit({"template_id": "hook_vertical_6s",
                              "variables": {"clip": "a0", "hook": "时钟"},
                              "assets": s.assets("v_a.mp4"),
                              "idempotency_key": "adv-clock-0001"}, "acme")
        s.service.store.claim("w-adv", 120.0)
        st = s.service.store
        real = st._wall
        try:
            st._wall = lambda: real() + 3600
            self.assertEqual(st.recover_expired(), [],
                             "时钟跳变时不能回收租约（会双领）")
            self.assertEqual(st.get(j["job_id"])["status"], "running")
            self.assertEqual(st.queue_stats().get("clock_skew_s"), 3600.0,
                             "跳变必须留痕，否则运维以为一切正常")
            # 逻辑时间已经被吸收：不跟着墙钟前跳
            self.assertLess(st.db_now() - real(), 60)
        finally:
            st._wall = real
            st.reset_clock()
        s.cleanup()


if __name__ == "__main__":
    unittest.main()
