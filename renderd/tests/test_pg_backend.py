"""双后端常驻保障：仓库里必须有一组用例钉住「PG 不是文档里的一句话」。

不设 RENDERD_DB_DSN 时只跑静态契约检查；设了就在真 PG 上跑一遍
幂等 / 原子领取 / schema 隔离，和 80 个用例用的是同一个 Store 工厂。
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
import sys  # noqa: E402

sys.path.insert(0, str(ROOT))


class TestPgBackend(unittest.TestCase):
    def test_01_default_is_sqlite(self) -> None:
        from renderd.store import SqliteStore, Store

        old = os.environ.pop("RENDERD_DB_DSN", None)
        try:
            st = Store(Path(tempfile.mkdtemp()) / "q.sqlite3")
            self.assertIsInstance(st, SqliteStore)
            st.close_thread_connection()
        finally:
            if old:
                os.environ["RENDERD_DB_DSN"] = old

    def test_02_pg_ddl_translation(self) -> None:
        from renderd.store_pg import _pg_ddl

        ddl = "\n".join(_pg_ddl()).upper()
        self.assertNotIn("PRAGMA", ddl)
        self.assertNotIn("AUTOINCREMENT", ddl)
        self.assertIn("BIGSERIAL PRIMARY KEY", ddl)
        self.assertIn("DOUBLE PRECISION", ddl)
        self.assertIn("WHERE STATUS='FAILED'", ddl.replace(" ", " ").upper())

    def test_03_placeholder_translation(self) -> None:
        from renderd.store_pg import _translate

        self.assertEqual(_translate("SELECT * FROM jobs WHERE id=? AND tenant=?"),
                         "SELECT * FROM jobs WHERE id=%s AND tenant=%s")

    def test_04_claim_uses_skip_locked(self) -> None:
        from renderd import store_pg

        src = Path(store_pg.__file__).read_text()
        self.assertIn("FOR UPDATE SKIP LOCKED", src,
                      "PG 领取必须跳过已锁行，否则多 worker 互相等锁")
        self.assertIn("ON CONFLICT (tenant,idem_key) DO NOTHING", src,
                      "PG 提交必须靠唯一约束做幂等，不能靠 WHERE NOT EXISTS")

    @unittest.skipUnless(os.environ.get("RENDERD_DB_DSN"),
                         "需要 RENDERD_DB_DSN 指向一个可用的 PG")
    def test_05_live_pg_idempotent_and_exclusive(self) -> None:
        from renderd.store import Store
        from renderd.store_pg import PostgresStore

        dsn = os.environ["RENDERD_DB_DSN"]
        # 强制隔离，避免污染正在跑的服务 schema
        old = os.environ.get("RENDERD_PG_SCHEMA")
        os.environ.pop("RENDERD_PG_SCHEMA", None)
        try:
            st = Store(Path(tempfile.mkdtemp()) / "q.sqlite3", dsn=dsn)
            self.assertIsInstance(st, PostgresStore)
            st.ensure_tenant("pgtest", monthly_minutes=1000, qps=100)
            a, r1 = st.submit(tenant="pgtest", idem_key="k", ir_json={"x": 1},
                              ir_hash="h", frames_total=30)
            b, r2 = st.submit(tenant="pgtest", idem_key="k", ir_json={"x": 1},
                              ir_hash="h", frames_total=30)
            self.assertFalse(r1)
            self.assertTrue(r2)
            self.assertEqual(a["id"], b["id"])
            c1 = st.claim("w1", 60.0)
            self.assertIsNotNone(c1)
            self.assertEqual(c1["id"], a["id"])
            self.assertIsNone(st.claim("w2", 60.0), "同一条不能被领两次")
            st.set_stage(c1["id"], "rendering", "pg parity")
            self.assertGreaterEqual(len(st.events(c1["id"])), 3)
            st.close_thread_connection()
        finally:
            if old:
                os.environ["RENDERD_PG_SCHEMA"] = old


if __name__ == "__main__":
    unittest.main()
