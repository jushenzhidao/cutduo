"""多租户边界的常驻断言。

三条都是「单租户开发时看不见，第二个租户一来就出事」的问题：

1. 认证失败不受限流 —— 错 token 的洪水可以无限打 401（限流原本在鉴权之后）
2. `/v1/queue` 把**别的租户**的名字与在途数给任何合法租户看
3. 素材没有删除通道 —— 文件永不回收，`usage.bytes` 只增不减

第一性原理：租户边界不是「查询时加个 WHERE」就完事，它包括
「谁能看到谁」「谁能消耗多少」「谁能释放什么」。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

os.environ.setdefault("RENDERD_TOKENS", "testtoken:acme")

from renderd.config import load_config          # noqa: E402
from renderd.errors import JobError             # noqa: E402
from renderd.service import Service             # noqa: E402


class TenancyCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="renderd-tenancy-")
        self.cfg = load_config(self.dir)
        self.svc = Service(self.cfg)
        self.svc.store.ensure_tenant("acme", monthly_minutes=10_000,
                                     qps=1000, storage_mb=1)
        self.svc.store.ensure_tenant("rival", monthly_minutes=10_000,
                                     qps=1000, storage_mb=1)

    def tearDown(self) -> None:
        try:
            self.svc.store.close_thread_connection()
        except Exception:
            pass
        shutil.rmtree(self.dir, ignore_errors=True)


class TestAuthFailureThrottle(TenancyCase):
    def test_01_bad_token_is_rate_limited(self) -> None:
        self.svc.cfg.auth_fail_qps = 2
        codes = []
        for _ in range(4):
            try:
                self.svc.admit("Bearer definitely-not-a-token", ip="203.0.113.9")
                codes.append("OK")
            except JobError as exc:
                codes.append(exc.code)
        self.assertEqual(codes[:2], ["E_AUTH_REQUIRED", "E_AUTH_REQUIRED"],
                         f"前两次应是普通 401: {codes}")
        self.assertEqual(codes[2], "E_RATE_LIMITED",
                         f"第三次应被 IP 级限流挡住: {codes}")
        self.assertEqual(codes[3], "E_RATE_LIMITED")

    def test_02_valid_token_unaffected(self) -> None:
        self.svc.cfg.auth_fail_qps = 2
        # 另一个 IP 的合法请求不受影响
        self.assertEqual(self.svc.admit("Bearer testtoken", ip="198.51.100.7"), "acme")
        # 同一个 IP 上失败打满预算后，合法 token 仍必须放行 ——
        # 否则 NAT 后面一个配错 token 的客户端会把同出口的正常客户一起打死。
        for _ in range(3):
            try:
                self.svc.admit("Bearer bad", ip="198.51.100.8")
            except JobError:
                pass
        self.assertEqual(self.svc.admit("Bearer testtoken", ip="198.51.100.8"), "acme")

    def test_03_no_ip_means_no_extra_query(self) -> None:
        # MCP / 进程内调用没有客户端 IP：不启用 IP 限流，但鉴权仍生效
        with self.assertRaises(JobError):
            self.svc.admit("Bearer bad")
        self.assertEqual(self.svc.admit("Bearer testtoken"), "acme")


class TestQueueVisibility(TenancyCase):
    def _make_inflight(self) -> None:
        for tenant, key in (("acme", "q-acme-1"), ("rival", "q-rival-1")):
            self.svc.store.submit(tenant=tenant, idem_key=key,
                                  ir_json={"ir_version": "0.1"}, ir_hash="h",
                                  frames_total=0)

    def test_04_tenant_sees_only_itself(self) -> None:
        self._make_inflight()
        mine = self.svc.queue("acme", admin=False)
        self.assertEqual(mine["scope"], "tenant")
        self.assertEqual(list(mine["inflight_by_tenant"]), ["acme"],
                         "不该把别的租户名暴露出来")
        self.assertEqual(mine["inflight_by_tenant"]["acme"], 1)
        # 容量信息仍然可见（这是租户判断要不要错峰的依据）
        self.assertGreaterEqual(mine["depth"], 2)

    def test_05_admin_sees_all(self) -> None:
        self._make_inflight()
        full = self.svc.queue(admin=True)
        self.assertEqual(full["scope"], "admin")
        self.assertEqual(set(full["inflight_by_tenant"]), {"acme", "rival"})


class TestAssetLifecycle(TenancyCase):
    def _upload(self, tenant: str, data: bytes, name: str = "a.mp4") -> dict:
        return self.svc.put_asset(data, name, tenant=tenant)

    def test_06_delete_refunds_quota_and_removes_file(self) -> None:
        blob = b"A" * (300 * 1024)
        info = self._upload("acme", blob)
        self.assertEqual(self.svc.store.storage_used_bytes("acme"), len(blob))
        path = self.cfg.media_dir / f"{info['sha256']}.mp4"
        self.assertTrue(path.exists())

        res = self.svc.delete_asset(info["asset_id"], "acme")
        self.assertEqual(res["refunded_bytes"], len(blob))
        self.assertTrue(res["file_removed"])
        self.assertFalse(path.exists(), "最后一个引用消失时必须删文件")
        self.assertEqual(self.svc.store.storage_used_bytes("acme"), 0)

    def test_07_delete_blocked_while_job_inflight(self) -> None:
        info = self._upload("acme", b"B" * (100 * 1024))
        self.svc.store.submit(tenant="acme", idem_key="inuse-1",
                              ir_json={"assets": [{"uri": f"upload:{info['sha256']}.mp4"}]},
                              ir_hash="h", frames_total=0)
        with self.assertRaises(JobError) as cm:
            self.svc.delete_asset(info["asset_id"], "acme")
        self.assertEqual(cm.exception.code, "E_ASSET_IN_USE")
        # 取消之后就能删
        job = self.svc.store.queue_stats()
        self.assertEqual(job["depth"], 1)
        for j in self.svc.store.list_jobs("acme", limit=5):
            self.svc.store.cancel(j["id"])
        res = self.svc.delete_asset(info["asset_id"], "acme")
        self.assertTrue(res["file_removed"])

    def test_08_shared_content_survives_until_last_ref(self) -> None:
        blob = b"C" * (200 * 1024)
        a = self._upload("acme", blob)
        b = self._upload("rival", blob)
        self.assertTrue(b["deduplicated"], "同内容应由第二个租户去重命中")
        self.assertEqual(self.svc.store.storage_used_bytes("rival"), 0,
                         "去重命中的租户不该被重复计费")

        r1 = self.svc.delete_asset(a["asset_id"], "acme")
        self.assertFalse(r1["file_removed"], "rival 还引用着，文件不能删")
        self.assertEqual(self.svc.store.storage_used_bytes("acme"), 0)
        self.assertTrue((self.cfg.media_dir / f"{a['sha256']}.mp4").exists())

        r2 = self.svc.delete_asset(b["asset_id"], "rival")
        self.assertTrue(r2["file_removed"], "最后一个引用消失，文件应删除")

    def test_09_tenant_cannot_delete_other_tenants_asset(self) -> None:
        info = self._upload("acme", b"D" * (50 * 1024))
        with self.assertRaises(JobError) as cm:
            self.svc.delete_asset(info["asset_id"], "rival")
        self.assertEqual(cm.exception.code, "E_NOT_FOUND",
                         "跨租户删除必须表现为「不存在」，不能确认它存在")

    def test_10_orphan_gc(self) -> None:
        info = self._upload("acme", b"E" * (120 * 1024))
        path = self.cfg.media_dir / f"{info['sha256']}.mp4"
        dry = self.svc.store.gc_assets(older_than_s=-1, dry_run=True)
        self.assertEqual(dry["candidates"], 1)
        self.assertTrue(path.exists(), "dry-run 不能删文件")
        done = self.svc.store.gc_assets(older_than_s=-1, dry_run=False)
        self.assertEqual(done["candidates"], 1)
        self.assertFalse(path.exists())
        self.assertEqual(self.svc.store.storage_used_bytes("acme"), 0)

    def test_11_referenced_asset_is_not_collected(self) -> None:
        info = self._upload("acme", b"F" * (80 * 1024))
        self.svc.store.submit(tenant="acme", idem_key="gc-ref-1",
                              ir_json={"assets": [{"uri": f"upload:{info['sha256']}.mp4"}]},
                              ir_hash="h", frames_total=0)
        res = self.svc.store.gc_assets(older_than_s=-1, dry_run=False)
        self.assertEqual(res["candidates"], 0, "被任务引用过的素材不能被 GC")
        self.assertEqual(self.svc.store.storage_used_bytes("acme"), len(b"F" * (80 * 1024)))


class TestLegacyUsageMigration(unittest.TestCase):
    def test_12_legacy_bytes_become_a_reference(self) -> None:
        d = tempfile.mkdtemp(prefix="renderd-legacy-")
        db = Path(d) / "renderd.sqlite3"
        old_schema = os.environ.get("RENDERD_PG_SCHEMA")
        if os.environ.get("RENDERD_DB_DSN"):
            # PG 下每个 Store 默认随机 schema，这个用例要「同一个库开两次」
            os.environ["RENDERD_PG_SCHEMA"] = "rd_legacy_" + os.urandom(4).hex()
        try:
            from renderd.store import Store
            s1 = Store(db)
            s1._conn().execute(
                "INSERT INTO usage(tenant,period,seconds,jobs,bytes) VALUES(?,?,0,0,?)",
                ("old", "2026-08", 4321))
            s1.close_thread_connection()

            s2 = Store(db)          # 重新打开触发 backfill
            self.assertEqual(s2.storage_used_bytes("old"), 4321,
                             "老库的累计字节必须继续算作已用")
            rows = s2.assets_list("old")
            self.assertEqual(len(rows), 1)
            self.assertTrue(rows[0]["sha"].startswith("legacy:"))
            # legacy 行不对应文件，GC 不能碰它
            self.assertEqual(s2.gc_assets(older_than_s=-1, dry_run=False)["candidates"], 0)
            self.assertEqual(s2.storage_used_bytes("old"), 4321)
            s2.close_thread_connection()
        finally:
            if old_schema is None:
                os.environ.pop("RENDERD_PG_SCHEMA", None)
            else:
                os.environ["RENDERD_PG_SCHEMA"] = old_schema
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
