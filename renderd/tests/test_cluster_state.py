"""多副本状态一致性的常驻断言。

三条都是「单实例全绿、第 2 个副本立刻出事」的问题，只有真起多个进程才看得见：

1. `RateLimiter` 在进程内存里 → N 个副本 = N × QPS（实测 3 副本把 5 QPS 放大到 30）
2. `_upload_lock` 在进程内存里 → 并发上传绕过存储配额（实测 1MB 配额写成 1.37MB）
3. 租约用墙钟判断 → 墙钟前跳把所有 running 判过期，reaper 全改回 accepted（双领）

第一性原理：多副本系统里，「预算 / 配额 / 时序」的仲裁必须在共享存储里；
进程内存只能做缓存或快速失败，不能做裁决。
"""
from __future__ import annotations

import multiprocessing as mp
import os
import shutil
import tempfile
import threading
import time
import unittest
import uuid
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import sys                                   # noqa: E402
sys.path.insert(0, ROOT)

os.environ.setdefault("RENDERD_ALLOW_ANON", "1")
os.environ.setdefault("RENDERD_TOKENS", "testtoken:acme")


def _service(d: str):
    from renderd.config import load_config
    from renderd.service import Service
    return Service(load_config(d))


def _rate_loop(d: str, start_at: float, out) -> None:
    svc = _service(d)
    while time.time() < start_at:
        time.sleep(0.002)
    ok = 0
    t0 = time.time()
    while time.time() - t0 < 1.0:
        try:
            svc.admit("Bearer testtoken")
            ok += 1
        except Exception as exc:                     # noqa: BLE001
            if getattr(exc, "code", "") != "E_RATE_LIMITED":
                raise
    svc.store.close_thread_connection()
    out.put(ok)


def _upload(d: str, name: str, tag: int, size: int, bar, out) -> None:
    svc = _service(d)
    bar.wait()
    try:
        # 内容必须彼此不同：内容寻址会把相同内容去重，测不出配额
        svc.put_asset(bytes([tag]) * size, name, tenant="acme")
        out.put("ok")
    except Exception as exc:                         # noqa: BLE001
        out.put(getattr(exc, "code", "ERR"))
    finally:
        svc.store.close_thread_connection()


class ClusterCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="renderd-cluster-")
        self._old_schema = os.environ.get("RENDERD_PG_SCHEMA")
        if os.environ.get("RENDERD_DB_DSN"):
            # 每个用例独立 schema，避免同一套 PG 上互相污染
            os.environ["RENDERD_PG_SCHEMA"] = f"rd_cs_{uuid.uuid4().hex[:8]}"
        self.svc = _service(self.dir)

    def tearDown(self) -> None:
        if self._old_schema is None:
            os.environ.pop("RENDERD_PG_SCHEMA", None)
        else:
            os.environ["RENDERD_PG_SCHEMA"] = self._old_schema
        try:
            self.svc.store.close_thread_connection()
        except Exception:
            pass
        shutil.rmtree(self.dir, ignore_errors=True)


class TestRateLimitShared(ClusterCase):
    def test_01_three_instances_share_one_budget(self) -> None:
        self.svc.store.ensure_tenant("acme", monthly_minutes=10_000, qps=5)
        ctx = mp.get_context("fork")
        q = ctx.Queue()
        start = time.time() + 0.4
        ps = [ctx.Process(target=_rate_loop, args=(self.dir, start, q)) for _ in range(3)]
        for p in ps:
            p.start()
        for p in ps:
            p.join(30)
        total = sum(q.get(timeout=5) for _ in ps)
        # 20 个子桶 = 1.0s 窗口 + 当前桶，量化误差最多 1
        self.assertLessEqual(total, 6,
                             f"3 个 API 实例共放行 {total} 次，租户上限是 5 QPS")
        self.assertGreaterEqual(total, 1, "限流把正常请求也全拒了")

    def test_02_single_instance_still_respects_qps(self) -> None:
        self.svc.store.ensure_tenant("acme", monthly_minutes=10_000, qps=5)
        ok = 0
        t0 = time.time()
        while time.time() - t0 < 0.5:
            try:
                self.svc.admit("Bearer testtoken")
                ok += 1
            except Exception as exc:                 # noqa: BLE001
                if getattr(exc, "code", "") != "E_RATE_LIMITED":
                    raise
        self.assertLessEqual(ok, 6, "单实例也不该超过窗口预算")


class TestStorageQuotaShared(ClusterCase):
    def test_03_two_instances_cannot_exceed_quota(self) -> None:
        self.svc.store.ensure_tenant("acme", monthly_minutes=10_000,
                                     qps=1000, storage_mb=1)
        ctx = mp.get_context("fork")
        bar = ctx.Barrier(2)
        q = ctx.Queue()
        ps = [ctx.Process(target=_upload,
                          args=(self.dir, f"u{i}.mp4", 65 + i, 700 * 1024, bar, q))
              for i in range(2)]
        for p in ps:
            p.start()
        for p in ps:
            p.join(30)
        out = [q.get(timeout=5) for _ in ps]
        self.assertEqual(out.count("ok"), 1,
                         f"1MB 配额下两个 700KB 上传都成功了: {out}")
        self.assertIn("E_QUOTA_STORAGE_EXCEEDED", out)
        used = self.svc.store.storage_used_bytes("acme")
        self.assertLessEqual(used, 1024 * 1024, f"实际记账 {used} 字节，超过 1MB")

    def test_04_threads_cannot_exceed_quota(self) -> None:
        self.svc.store.ensure_tenant("acme", monthly_minutes=10_000,
                                     qps=1000, storage_mb=1)
        results: list[str] = []
        lock = threading.Lock()

        def up(i: int) -> None:
            try:
                self.svc.put_asset(bytes([97 + i]) * (300 * 1024), f"t{i}.mp4",
                                   tenant="acme")
                with lock:
                    results.append("ok")
            except Exception as exc:                 # noqa: BLE001
                with lock:
                    results.append(getattr(exc, "code", "ERR"))

        ts = [threading.Thread(target=up, args=(i,)) for i in range(8)]
        [t.start() for t in ts]
        [t.join(30) for t in ts]
        self.assertEqual(results.count("ok"), 3, results)   # 3 × 300KB ≤ 1MB
        self.assertLessEqual(self.svc.store.storage_used_bytes("acme"), 1024 * 1024)


class TestSignedUrlBinding(ClusterCase):
    def test_05_signature_is_tenant_and_scope_bound(self) -> None:
        from renderd import auth

        url = auth.signed_url("job_x", "acme")
        qs = parse_qs(urlparse(url).query)
        exp, sig = int(qs["exp"][0]), qs["sig"][0]
        self.assertEqual(qs["t"][0], "acme")
        self.assertTrue(auth.verify("job_x", exp, sig, tenant="acme", scope="video"))
        self.assertFalse(auth.verify("job_x", exp, sig, tenant="other", scope="video"),
                         "签名必须绑定租户，换租户即失效")
        self.assertFalse(auth.verify("job_x", exp, sig, tenant="acme",
                                     scope="evidence:contact_sheet.jpg"),
                         "成片链接不能拿去取证据文件")

    def test_06_evidence_url_has_its_own_scope(self) -> None:
        from renderd import auth

        url = auth.signed_url("job_y", "acme", scope="evidence",
                              name="contact_sheet.jpg")
        self.assertIn("/evidence/contact_sheet.jpg", url)
        qs = parse_qs(urlparse(url).query)
        self.assertTrue(auth.verify("job_y", int(qs["exp"][0]), qs["sig"][0],
                                    tenant="acme", scope="evidence:contact_sheet.jpg"))
        self.assertFalse(auth.verify("job_y", int(qs["exp"][0]), qs["sig"][0],
                                     tenant="acme", scope="video"))


class TestSingleClockSource(ClusterCase):
    def test_07_forward_jump_is_absorbed(self) -> None:
        st = self.svc.store
        base = st.db_now()
        real = st._wall
        try:
            st._wall = lambda: real() + 3600
            after = st.db_now()
        finally:
            st._wall = real
            st.reset_clock()
        self.assertLess(abs(after - base), 5,
                        f"逻辑时间跟着墙钟前跳了 {after - base:.0f}s")

    def test_08_backward_jump_never_regresses(self) -> None:
        st = self.svc.store
        base = st.db_now(advance=True)
        real = st._wall
        try:
            st._wall = lambda: real() - 3600
            after = st.db_now(advance=True)
        finally:
            st._wall = real
            st.reset_clock()
        self.assertGreaterEqual(after, base - 0.001, "时间倒退会让已发出的租约重新有效")

    def test_09_lease_survives_forward_jump(self) -> None:
        st = self.svc.store
        self.svc.store.ensure_tenant("acme", monthly_minutes=10_000)
        # 直接落一条任务：这个用例只验证租约语义，不需要过 preflight
        self.svc.store.submit(tenant="acme", idem_key="clock-jump-0001",
                              ir_json={"ir_version": "0.1"}, ir_hash="h",
                              frames_total=0)
        claimed = st.claim("w-clock", 120.0)
        self.assertIsNotNone(claimed)
        real = st._wall
        try:
            st._wall = lambda: real() + 3600
            self.assertEqual(st.recover_expired(), [],
                             "前跳后租约不该被判过期（会双领）")
            self.assertEqual(st.get(claimed["id"])["status"], "running")
            self.assertGreater(st.get(claimed["id"])["lease_until"] - st.db_now(), 0)
        finally:
            st._wall = real
        st.reset_clock()

    def test_10_skew_is_visible_from_another_instance(self) -> None:
        st = self.svc.store
        st.db_now()          # 先建立偏移基线，再做跳变
        real = st._wall
        try:
            st._wall = lambda: real() + 1800
            st.db_now(advance=True)          # 触发跳变检测并落库
        finally:
            st._wall = real
        other = _service(self.dir).store   # 另一个「API 副本」
        try:
            self.assertEqual(other.queue_stats().get("clock_skew_s"), 1800.0,
                             "跳变信息必须跨实例可见，否则运维看到的是「一切正常」")
        finally:
            other.close_thread_connection()


if __name__ == "__main__":
    unittest.main()
