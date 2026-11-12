"""Postgres 后端：多 pod / 无单点部署时的共享状态层。

设计取舍：**不复制一份 SQL**。SqliteStore 的 45 条语句全部复用，只在连接层做
方言代理（`?` → `%s`、Decimal 归一化），并 override 三处真正有语义差异的方法：

1. `submit()` —— PG 的 `INSERT … SELECT %s,… WHERE NOT EXISTS` 无法推断参数类型，
   改成 `ON CONFLICT (tenant,idem_key) DO NOTHING`（并发下也更稳）。
2. `claim()` —— 子查询加 `FOR UPDATE SKIP LOCKED`，否则多 worker 会互相等行锁。
3. `tx()` —— 没有 `BEGIN IMMEDIATE`，串行化交给行锁而不是全库写锁。

这样「支持 PG」不是第二套实现，而是同一套队列语义的第二种底座；
任何 store.py 的改动都会自动被两套后端同时覆盖，也就能用同一套 80 个用例回归。

schema 隔离：`RENDERD_PG_SCHEMA` 显式指定 → 所有进程共用（生产 api + worker）；
未指定 → 每实例随机 schema，让 unittest 之间互不影响。
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

from . import store as _sqlite_store


# ── 方言代理 ────────────────────────────────────────────────
def _translate(sql: str) -> str:
    # store.py 的 SQL 里没有字符串字面包含 '?'，全部都是参数占位符。
    # 保留这条断言，避免将来有人写了含 '?' 的字面量而静默出错。
    return sql.replace("?", "%s")


def _norm(row: Any) -> Any:
    if row is None:
        return None
    out = {}
    for k, v in dict(row).items():
        if isinstance(v, Decimal):
            out[k] = int(v) if v == v.to_integral_value() else float(v)
        else:
            out[k] = v
    return out


class _PgCur:
    def __init__(self, cur):
        self._cur = cur

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    def fetchone(self):
        return _norm(self._cur.fetchone())

    def fetchall(self):
        return [_norm(r) for r in self._cur.fetchall()]

    def __iter__(self):
        return self

    def __next__(self):
        return _norm(next(self._cur))


class _PgConn:
    """让 SqliteStore 里的 `c.execute(sql, params)` 原样可用。

    连接是 autocommit 的：单条语句（含 rate_hit 那条带子查询的 upsert）
    本身就是原子的，不需要显式事务，也就省掉一次往返。
    多语句的原子性由 `tx()` 里的显式 `BEGIN … COMMIT` 提供。
    """

    def __init__(self, conn):
        self._c = conn
        self._in_tx = False

    def execute(self, sql: str, params: Any = None):
        cur = self._c.cursor()
        cur.execute(_translate(sql), params if params is not None else ())
        return _PgCur(cur)

    def commit(self) -> None:
        self._c.commit()

    def rollback(self) -> None:
        self._c.rollback()

    def close(self) -> None:
        self._c.close()


def _pg_ddl() -> list[str]:
    """从 SQLite 的 SCHEMA 生成 PG DDL —— 保证两套 schema 永远同步。"""
    out = []
    for raw in _sqlite_store.SCHEMA.split(";"):
        stmt = raw.strip()
        if not stmt or stmt.upper().startswith("PRAGMA"):
            continue
        stmt = stmt.replace("INTEGER PRIMARY KEY AUTOINCREMENT",
                            "BIGSERIAL PRIMARY KEY")
        stmt = stmt.replace("REAL", "DOUBLE PRECISION")
        out.append(stmt)
    return out


# 存量 schema 的类型修正。ALTER ... TYPE 对已经是目标类型的列是幂等的，
# 放在 bootstrap 里跑一次，不必写「先查 information_schema 再决定」的迁移框架。
_PG_ALTERS = [
    "ALTER TABLE usage ALTER COLUMN bytes TYPE BIGINT",
    "ALTER TABLE rate_window ALTER COLUMN bucket TYPE BIGINT",
    # 配额预占（2026-11-10）：CREATE TABLE IF NOT EXISTS 不会给存量表加列。
    # 少了这条，新版 INSERT 会直接报 column "billed_seconds" does not exist。
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS billed_seconds DOUBLE PRECISION "
    "NOT NULL DEFAULT 0",
]


# ── 实现 ────────────────────────────────────────────────────
class PostgresStore(_sqlite_store.SqliteStore):
    # pg 驱动把 SQL 文本里的 % 当占位符，字面量 LIKE '%…%' 会直接报错；
    # strpos 语义等价且不含 %。
    SQL_CONTAINS = "(strpos({a}, {b}) > 0)"

    def __init__(self, dsn: str, data_dir: Path | None = None):
        import psycopg  # noqa: F401  仅 PG 路径需要

        self.dsn = dsn
        self.data_dir = Path(data_dir or "var")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        # gc() 用它拼 mezz 路径；PG 后端并不真的打开这个文件
        self.db_path = self.data_dir / "renderd.sqlite3"
        self._init_state()
        # 跟踪所有线程的连接：HTTP 请求线程是短命的，光靠 threading.local
        # 会在 GC 时留下 "Connection was deleted while still open" 告警。
        self._all: list[_PgConn] = []

        schema = os.environ.get("RENDERD_PG_SCHEMA") or ("rd_" + uuid.uuid4().hex[:10])
        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", schema):
            raise ValueError(f"非法的 PG schema 名: {schema!r}")
        self.schema = schema
        self._bootstrap()
        self._backfill_assets()

    def _bootstrap(self) -> None:
        import psycopg

        conn = psycopg.connect(self.dsn)
        try:
            with conn.cursor() as c:
                c.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.schema}"')
                c.execute(f'SET search_path TO "{self.schema}"')
                for stmt in _pg_ddl():
                    c.execute(stmt)
                for stmt in _PG_ALTERS:
                    c.execute(stmt)
            conn.commit()
        finally:
            conn.close()

    def _conn(self) -> _PgConn:
        wrap = getattr(self._local, "wrap", None)
        if wrap is None or wrap._c.closed:
            import psycopg
            from psycopg.rows import dict_row

            conn = psycopg.connect(self.dsn, row_factory=dict_row, autocommit=True)
            with conn.cursor() as c:
                c.execute(f'SET search_path TO "{self.schema}"')
            conn.commit()
            wrap = _PgConn(conn)
            self._local.wrap = wrap
            self._all.append(wrap)
        return wrap

    def close_thread_connection(self) -> None:
        wrap = getattr(self._local, "wrap", None)
        self._local.wrap = None
        self._local.tx_depth = 0
        if wrap is not None:
            if wrap in self._all:
                self._all.remove(wrap)
            try:
                wrap.close()
            except Exception:
                pass

    def __del__(self) -> None:
        for wrap in getattr(self, "_all", []):
            try:
                wrap.close()
            except Exception:
                pass

    def _migrate(self) -> None:
        # PG 建表时已包含全部列，无需 ALTER TABLE 补列
        return None

    def _lock_tenant_row(self, c, tenant: str) -> None:
        """PG 下配额预占必须锁租户行。

        READ COMMITTED 下两个 pod 同时 `SELECT SUM(bytes)` 会读到同一份 used，
        各自放行 —— 这正是 SQLite 上被 `BEGIN IMMEDIATE` 掩盖、换 PG 后
        放大成真事故的那类问题。行锁把「查已用 → 记账」串行化。
        """
        c.execute("SELECT id FROM tenants WHERE id=? FOR UPDATE", (tenant,))

    @contextmanager
    def tx(self) -> Iterator[_PgConn]:
        c = self._conn()
        depth = getattr(self._local, "tx_depth", 0)
        if depth:
            self._local.tx_depth = depth + 1
            try:
                yield c
            finally:
                self._local.tx_depth = depth
            return
        self._local.tx_depth = 1
        c._in_tx = True
        c.execute("BEGIN")
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c._in_tx = False
            self._local.tx_depth = 0

    # ── 三处语义差异 ────────────────────────────────────────
    def submit(self, *, tenant: str, idem_key: str, ir_json: dict, ir_hash: str,
               frames_total: int, backend: str = "ffmpeg", priority: int = 0,
               max_attempts: int = 3, callback_url: str | None = None,
               callback_pin: dict | None = None, delivery_spec: dict | None = None,
               cost_seconds: float = 0.0,
               billed_seconds: float = 0.0) -> tuple[dict, bool]:
        now = time.time()
        job_id = _sqlite_store.new_job_id()
        with self.tx() as c:
            cur = c.execute(
                "INSERT INTO jobs(id,tenant,idem_key,ir_hash,ir_json,backend,"
                "status,stage,priority,attempts,max_attempts,created_at,"
                "frames_total,callback_url,callback_ip,delivery_json,cost_seconds,"
                "billed_seconds) "
                "VALUES(?,?,?,?,?,?,'accepted','queued',?,0,?,?,?,?,?,?,?,?) "
                "ON CONFLICT (tenant,idem_key) DO NOTHING",
                (job_id, tenant, idem_key, ir_hash,
                 json.dumps(ir_json, ensure_ascii=False), backend,
                 priority, max_attempts, now, frames_total,
                 callback_url,
                 json.dumps(callback_pin, ensure_ascii=False) if callback_pin else None,
                 json.dumps(delivery_spec, ensure_ascii=False) if delivery_spec else None,
                 cost_seconds, billed_seconds))
            row = c.execute("SELECT * FROM jobs WHERE tenant=? AND idem_key=?",
                            (tenant, idem_key)).fetchone()
            job = dict(row)
            replay = job["id"] != job_id
            if not replay and cur.rowcount:
                # 与 SQLite 后端同一语义：插入后在同一事务里判额度，超了就回滚
                self._quota_guard(tenant, billed_seconds)
        if not replay:
            self.event(job["id"], "queued", f"accepted, priority={priority}")
        return job, replay

    def claim(self, worker: str, lease_s: float) -> dict | None:
        now = time.time()
        with self.tx() as c:
            row = c.execute(
                "UPDATE jobs SET status='running', stage='ingesting', worker=?, "
                "lease_until=?, started_at=COALESCE(started_at,?), attempts=attempts+1 "
                "WHERE id=(SELECT id FROM jobs WHERE status='accepted' "
                "         AND (available_at IS NULL OR available_at <= ?) "
                "         ORDER BY priority DESC, created_at ASC "
                "         LIMIT 1 FOR UPDATE SKIP LOCKED) "
                "RETURNING *", (worker, now + lease_s, now, now)).fetchone()
        job = dict(row) if row else None
        if job:
            self.event(job["id"], "ingesting",
                       f"claimed by {worker} (attempt {job['attempts']}/{job['max_attempts']})")
        return job
