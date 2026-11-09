"""单元测试：IR 校验 / 字体 / 编译 / 存储。

这些用例只跑毫秒级逻辑，不碰 ffmpeg —— 渲染相关在 test_integration.py。
"""

from __future__ import annotations

import unittest

from helpers import minimal_ir

from renderd import compile_ffmpeg, compile_mlt, fonts, ir as IR
from renderd.config import Target
from renderd.errors import JobError
from renderd.store import Store
from renderd.textlayer import Layer


class TestIRValidation(unittest.TestCase):
    def test_valid_minimal(self):
        self.assertEqual(IR.validate(IR.normalize(minimal_ir())), [])

    def test_reject_odd_dimensions(self):
        ir = minimal_ir()
        ir["output"]["width"] = 321
        msgs = [p.message for p in IR.validate(ir)]
        self.assertTrue(any("偶数" in m for m in msgs), msgs)

    def test_reject_bad_fps(self):
        ir = minimal_ir()
        ir["output"]["fps"] = {"num": 0, "den": 1}
        self.assertIn("E_IR_INVALID", [p.code for p in IR.validate(ir)])

    def test_reject_unknown_asset(self):
        ir = minimal_ir()
        ir["tracks"][0]["clips"][0]["asset"] = "ghost"
        codes = [p.code for p in IR.validate(ir)]
        self.assertIn("E_IR_INVALID", codes)

    def test_reject_track_gap(self):
        ir = minimal_ir()
        ir["tracks"][0]["clips"] = [
            {"asset": "a0", "at_frame": 0, "out_frame": 20},
            {"asset": "a0", "at_frame": 30, "out_frame": 60},
        ]
        codes = [p.code for p in IR.validate(ir)]
        self.assertIn("E_IR_UNSUPPORTED", codes)

    def test_reject_track_not_covering_duration(self):
        ir = minimal_ir()
        ir["tracks"][0]["clips"][0]["out_frame"] = 30
        codes = [p.code for p in IR.validate(ir)]
        self.assertIn("E_IR_UNSUPPORTED", codes)

    def test_reject_out_before_at(self):
        ir = minimal_ir()
        ir["tracks"][0]["clips"][0]["out_frame"] = 0
        self.assertTrue(any("out_frame" in p.field for p in IR.validate(ir)))

    def test_reject_text_without_style(self):
        ir = minimal_ir()
        ir["tracks"].append({"id": "t1", "kind": "text", "clips": [
            {"at_frame": 0, "out_frame": 10, "text": "x", "style": "nope"}]})
        codes = [p.code for p in IR.validate(ir)]
        self.assertIn("E_IR_INVALID", codes)

    def test_reject_empty_text(self):
        ir = minimal_ir()
        ir["tracks"].append({"id": "t1", "kind": "text", "clips": [
            {"at_frame": 0, "out_frame": 10, "text": "  ", "style": "s"}]})
        self.assertTrue(any(p.field.endswith(".text") for p in IR.validate(ir)))

    def test_normalize_fills_defaults(self):
        n = IR.normalize(minimal_ir())
        self.assertEqual(n["output"]["color"]["range"], "tv")
        self.assertEqual(n["output"]["video"]["crf"], 20)
        self.assertEqual(n["tracks"][0]["clips"][0]["fit"], "cover")

    def test_content_hash_is_stable_and_sensitive(self):
        n = IR.normalize(minimal_ir())
        a = IR.content_hash(n, backend="ffmpeg", engine="e", font_fp="f", target_fp="t")
        b = IR.content_hash(n, backend="ffmpeg", engine="e", font_fp="f", target_fp="t")
        c = IR.content_hash(n, backend="ffmpeg", engine="e2", font_fp="f", target_fp="t")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c, "引擎版本变了缓存键必须变")

    def test_duration_helpers(self):
        n = IR.normalize(minimal_ir())
        self.assertAlmostEqual(IR.duration_seconds(n), 2.0)
        self.assertAlmostEqual(IR.frame_to_seconds(n, 45), 1.5)


class TestFonts(unittest.TestCase):
    def test_resolve_by_family(self):
        p = fonts.resolve("Hiragino Sans GB")
        self.assertIsNotNone(p, "测试环境应安装 Hiragino Sans GB")

    def test_coverage_detects_missing_cjk(self):
        latin = fonts.resolve("Helvetica") or fonts.resolve("Arial")
        if not latin:
            self.skipTest("无拉丁字体")
        cov = fonts.coverage(latin, "第一性原理")
        self.assertFalse(cov["ok"])
        self.assertIn("U+7B2C", cov["missing_codepoints"])

    def test_coverage_passes_for_cjk_font(self):
        p = fonts.require("Hiragino Sans GB")
        cov = fonts.coverage(p, "第一性原理 CUT")
        self.assertTrue(cov["ok"], cov)

    def test_require_raises_contract(self):
        with self.assertRaises(JobError) as ctx:
            fonts.require("No Such Font Family 123")
        self.assertEqual(ctx.exception.code, "E_FONT_MISSING")
        self.assertTrue(ctx.exception.allowed_values)

    def test_digest_stable(self):
        p = fonts.require("Hiragino Sans GB")
        self.assertEqual(fonts.fonts_digest([p]), fonts.fonts_digest([p]))


class TestCompile(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = tempfile.mkdtemp()
        self.media_file = str(Path(self.tmp) / "m.mp4")
        Path(self.media_file).write_bytes(b"\x00" * 16)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _layer(self, tmpdir):
        from pathlib import Path
        png = Path(tmpdir) / "l.png"
        from PIL import Image
        Image.new("RGBA", (10, 10), (255, 255, 255, 0)).save(png)
        return [Layer(track="t1", clip_index=0, at_frame=5, out_frame=50,
                      text="x", png=png, sha256="0" * 64, bbox=(0, 0, 10, 10),
                      within_safe=True, safe_area={}, font_size=40)]

    def test_ffmpeg_argv_deterministic(self):
        import tempfile
        ir = IR.normalize(minimal_ir())
        media = {"a0": self.media_file}
        with tempfile.TemporaryDirectory() as d:
            layers = self._layer(d)
            a = compile_ffmpeg.build(ir, media, layers, "/tmp/o.mp4", Target())
            b = compile_ffmpeg.build(ir, media, layers, "/tmp/o.mp4", Target())
        self.assertEqual(a.argv, b.argv)
        self.assertIn("-filter_complex", a.argv)
        self.assertIn("libx264", a.argv)

    def test_ffmpeg_uses_capped_crf_not_abr(self):
        import tempfile
        ir = IR.normalize(minimal_ir())
        with tempfile.TemporaryDirectory() as d:
            plan = compile_ffmpeg.build(ir, {"a0": self.media_file}, self._layer(d),
                                        "/tmp/o.mp4", Target())
        argv = plan.argv
        self.assertIn("-crf", argv, "必须用 CRF：ABR+多线程会破坏字节确定性")
        self.assertIn("-maxrate", argv)
        self.assertNotIn("-b:v", argv)

    def test_ffmpeg_audio_aligned_to_timeline(self):
        ir = IR.normalize(minimal_ir())
        ir["tracks"].append({"id": "a1", "kind": "audio", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]})
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            plan = compile_ffmpeg.build(ir, {"a0": self.media_file}, self._layer(d),
                                        "/tmp/o.mp4", Target())
        self.assertIn("apad", plan.filtergraph)
        self.assertIn("loudnorm", plan.filtergraph)
        self.assertIn("atrim=end_sample=96000", plan.filtergraph)  # 2s * 48k

    def test_missing_media_raises(self):
        ir = IR.normalize(minimal_ir())
        with self.assertRaises(JobError) as ctx:
            compile_ffmpeg.build(ir, {}, [], "/tmp/o.mp4", Target())
        self.assertEqual(ctx.exception.code, "E_MEDIA_MISSING")

    def test_mlt_well_formed(self):
        ir = IR.normalize(minimal_ir())
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            xml = compile_mlt.build(ir, {"a0": self.media_file}, self._layer(d))
            info = compile_mlt.validate_xml(xml)
        self.assertTrue(info["ok"], info)
        self.assertEqual(info["unknown_services"], [])
        self.assertTrue(info["has_profile"] and info["has_tractor"])

    def test_mlt_rejects_bad_xml(self):
        info = compile_mlt.validate_xml("<mlt><broken>")
        self.assertFalse(info["ok"])


class TestStore(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "s.sqlite3")
        self.store.ensure_tenant("t1", monthly_minutes=10)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _submit(self, key="k1", tenant="t1"):
        return self.store.submit(tenant=tenant, idem_key=key,
                                 ir_json={"x": 1}, ir_hash="h", frames_total=30)

    def test_idempotent_replay(self):
        a, r1 = self._submit()
        b, r2 = self._submit()
        self.assertFalse(r1)
        self.assertTrue(r2)
        self.assertEqual(a["id"], b["id"])

    def test_tenant_isolation_same_key(self):
        self.store.ensure_tenant("t2")
        a, _ = self._submit("dup", "t1")
        b, _ = self._submit("dup", "t2")
        self.assertNotEqual(a["id"], b["id"], "不同租户同 key 不应互相阻塞")

    def test_claim_is_exclusive(self):
        self._submit("k1")
        self._submit("k2")
        c1 = self.store.claim("w1", 60)
        c2 = self.store.claim("w2", 60)
        self.assertIsNotNone(c1)
        self.assertIsNotNone(c2)
        self.assertNotEqual(c1["id"], c2["id"])
        self.assertIsNone(self.store.claim("w3", 60))

    def test_priority_order(self):
        self.store.submit(tenant="t1", idem_key="low", ir_json={}, ir_hash="h",
                          frames_total=1, priority=-10)
        self.store.submit(tenant="t1", idem_key="high", ir_json={}, ir_hash="h",
                          frames_total=1, priority=10)
        job = self.store.claim("w", 60)
        self.assertEqual(job["idem_key"], "high")

    def test_lease_recovery(self):
        self._submit()
        c = self.store.claim("w1", 60)
        self.store.heartbeat(c["id"], "w1", 0.0)
        import time
        time.sleep(0.02)
        recovered = self.store.recover_expired()
        self.assertEqual(recovered, [c["id"]])
        job = self.store.get(c["id"])
        self.assertEqual(job["status"], "accepted")
        self.assertEqual(job["attempts"], 1)

    def test_retry_budget_exhaustion(self):
        self._submit()
        for i in range(3):
            c = self.store.claim("w", 0.0)
            self.assertIsNotNone(c, f"第 {i+1} 次应能领到")
            status = self.store.fail(c["id"], {"code": "E_TIMEOUT",
                                               "retryable": True, "stage": "rendering"})
            if i < 2:
                self.assertEqual(status, "accepted")
            else:
                self.assertEqual(status, "failed")

    def test_permanent_error_no_retry(self):
        self._submit()
        c = self.store.claim("w", 60)
        status = self.store.fail(c["id"], {"code": "E_FONT_MISSING",
                                           "retryable": False, "stage": "compiling"})
        self.assertEqual(status, "failed")

    def test_usage_accumulates(self):
        self.store.usage_add("t1", 30.0)
        self.store.usage_add("t1", 15.0)
        u = self.store.usage_get("t1")
        self.assertAlmostEqual(u["seconds"], 45.0)
        self.assertEqual(u["jobs"], 2)

    def test_quota_remaining(self):
        self.store.ensure_tenant("q", monthly_minutes=1)
        self.assertAlmostEqual(self.store.quota_remaining_seconds("q"), 60.0)
        self.store.usage_add("q", 60.0)
        self.assertAlmostEqual(self.store.quota_remaining_seconds("q"), 0.0)

    def test_cache_roundtrip(self):
        import tempfile
        from pathlib import Path
        p = Path(tempfile.mkstemp()[1])
        p.write_bytes(b"data")
        self.store.cache_put("k", ir_hash="h", backend="ffmpeg",
                             output_path=str(p), receipt_path="", size=4)
        hit = self.store.cache_get("k")
        self.assertIsNotNone(hit)
        p.unlink()
        self.assertIsNone(self.store.cache_get("k"), "文件没了缓存必须失效")

    def test_cancel_only_queued(self):
        j, _ = self._submit()
        self.assertTrue(self.store.cancel(j["id"]))
        j2, _ = self._submit("k2")
        self.store.claim("w", 60)
        self.assertFalse(self.store.cancel(j2["id"]))


if __name__ == "__main__":
    unittest.main()
