"""持久化与队列。

一张表同时承担「任务存储」和「队列」两个角色，用 `UPDATE … RETURNING` 做原子领取。
为什么不用「先 SELECT 再 UPDATE」：并发 worker 下必然双领，而且双领的后果是
同一条任务被渲染两次、计费两次——这类 bug 在生产上极难复现也极难解释。
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .errors import JobError

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tenants(
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  monthly_minutes INTEGER NOT NULL DEFAULT 1000,
  qps             INTEGER NOT NULL DEFAULT 10,
  storage_mb      INTEGER NOT NULL DEFAULT 2048,
  created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs(
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  ir_hash       TEXT NOT NULL,
  ir_json       TEXT NOT NULL,
  backend       TEXT NOT NULL DEFAULT 'ffmpeg',
  status        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  created_at    REAL NOT NULL,
  started_at    REAL,
  finished_at   REAL,
  lease_until   REAL,
  worker        TEXT,
  frames_done   INTEGER NOT NULL DEFAULT 0,
  frames_total  INTEGER NOT NULL DEFAULT 0,
  cache_hit     INTEGER NOT NULL DEFAULT 0,
  cost_seconds  REAL NOT NULL DEFAULT 0,
  billed_seconds REAL NOT NULL DEFAULT 0,
  error_code    TEXT,
  error_json    TEXT,
  output_path   TEXT,
  receipt_path  TEXT,
  receipt_json  TEXT,
  callback_url  TEXT,
  callback_ip   TEXT,
  delivery_json TEXT,
  available_at  REAL,
  UNIQUE(tenant, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant, created_at DESC);
-- failed_24h 只查最近失败的行，不该为它扫全表历史
CREATE INDEX IF NOT EXISTS idx_jobs_failed_recent ON jobs(finished_at) WHERE status='failed';

CREATE TABLE IF NOT EXISTS job_events(
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL,
  ts      REAL NOT NULL,
  stage   TEXT NOT NULL,
  level   TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL DEFAULT '',
  data    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS render_cache(
  key         TEXT PRIMARY KEY,
  ir_hash     TEXT NOT NULL,
  backend     TEXT NOT NULL,
  output_path TEXT NOT NULL,
  receipt_path TEXT,
  bytes       INTEGER NOT NULL DEFAULT 0,
  created_at  REAL NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage(
  tenant  TEXT NOT NULL,
  period  TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  jobs    INTEGER NOT NULL DEFAULT 0,
  -- BIGINT：配额按 MB 计，2GB 就已经顶到 PG INTEGER 上限
  bytes   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant, period)
);

CREATE TABLE IF NOT EXISTS audit(
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     REAL NOT NULL,
  tenant TEXT,
  actor  TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip     TEXT,
  data   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

-- ── 跨实例准入控制 ──────────────────────────────────────
-- 限流计数必须离开进程内存：N 个 API 副本各自计数 = N×QPS，限流形同虚设。
CREATE TABLE IF NOT EXISTS rate_window(
  tenant TEXT NOT NULL,
  -- BIGINT：bucket = epoch/0.05 ≈ 3.6e10，PG 的 INTEGER 是 32 位会直接溢出
  bucket BIGINT NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant, bucket)
);

-- ── 单一时钟源（HLC） ───────────────────────────────────
-- 租约、退避、超时全部基于这个时间基：只前进不后退，且不跟随墙钟跳变。
-- 墙钟跳一次就把所有 running 判过期 → reaper 全部改回 accepted → 双领。
CREATE TABLE IF NOT EXISTS clock(
  id      INTEGER PRIMARY KEY,
  last_ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS clock_events(
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      REAL NOT NULL,
  drift_s REAL NOT NULL,
  actor   TEXT
);
CREATE INDEX IF NOT EXISTS idx_clock_events_ts ON clock_events(ts DESC);
INSERT INTO clock(id,last_ts) VALUES(1,0) ON CONFLICT DO NOTHING;

-- ── 素材登记与引用 ──────────────────────────────────────
-- 为什么要两张表：文件名是内容寻址的（一个 sha 只有一个文件），但「谁占用了
-- 这份内容」「谁为它付过配额」是多对多的。只记 usage.bytes 聚合值时，
-- 文件删不掉、配额也退不回来 —— 实测就是这样：配额只增不减。
CREATE TABLE IF NOT EXISTS assets(
  sha        TEXT PRIMARY KEY,
  bytes      BIGINT NOT NULL,
  path       TEXT,
  created_at REAL NOT NULL,
  last_seen  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_refs(
  sha        TEXT NOT NULL,
  tenant     TEXT NOT NULL,
  -- 只有「真的写了盘」的那个租户记字节数；后来命中去重的租户记 0，
  -- 但引用关系仍要留，否则删文件会删掉别人还在用的内容。
  bytes      BIGINT NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  last_seen  REAL NOT NULL,
  PRIMARY KEY(sha, tenant)
);
CREATE INDEX IF NOT EXISTS idx_asset_refs_tenant ON asset_refs(tenant);
"""

TERMINAL = ("succeeded", "failed", "cancelled")

# 墙钟与「逻辑时间」允许的最大偏差。超过即判定为系统时间跳变：
# NTP 步进、管理员改表、VM 快照恢复都会触发，量级通常是秒到小时。
CLOCK_JUMP_TOL_S = 5.0


def period_of(ts: float | None = None) -> str:
    t = time.localtime(ts or time.time())
    return f"{t.tm_year:04d}-{t.tm_mon:02d}"


def new_job_id() -> str:
    return "job_" + uuid.uuid4().hex[:12]


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


class SqliteStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_state()
        with self._conn() as c:
            c.executescript(SCHEMA)
        self._migrate()

    def _init_state(self) -> None:
        """两个后端共用的运行期状态。PostgresStore 不走 __init__，必须也调这里，
        否则 db_now()/rate_hit() 会用到一个不存在的锁。"""
        self._local = threading.local()
        # ── 单一时钟源（HLC）的进程内状态 ──
        # anchor_wall/mono 是「逻辑时间 = 墙钟锚点 + 单调钟增量」的锚；
        # 墙钟只用于观测跳变，不参与计算。详见 db_now()。
        self._clock_lock = threading.Lock()
        self._anchor_mono: float | None = None
        self._anchor_wall = 0.0
        self._last_off: float | None = None
        self._last_drift: float | None = None
        self._pending_drift: float | None = None
        self._clock_actor = f"{socket.gethostname()}:{os.getpid()}"
        self._rate_pruned: dict[str, int] = {}
        self._rate_cooldown: dict[str, int] = {}
        # 时钟来源可注入：测试要模拟「墙钟跳 1 小时」，不能去改全局 time 模块
        self._wall = time.time
        self._mono = time.monotonic

    def _migrate(self) -> None:
        """存量库补列。CREATE TABLE IF NOT EXISTS 对已存在的表不会加列，
        不写这段，老数据目录一起服就会在 SELECT 时炸。"""
        c = self._conn()
        jobs_cols = {r["name"] for r in c.execute("PRAGMA table_info(jobs)")}
        for name, ddl in (("callback_ip", "TEXT"), ("delivery_json", "TEXT"),
                         ("available_at", "REAL"),
                         ("billed_seconds", "REAL NOT NULL DEFAULT 0")):
            if name not in jobs_cols:
                c.execute(f"ALTER TABLE jobs ADD COLUMN {name} {ddl}")
        tenant_cols = {r["name"] for r in c.execute("PRAGMA table_info(tenants)")}
        if "storage_mb" not in tenant_cols:
            c.execute("ALTER TABLE tenants ADD COLUMN storage_mb "
                      "INTEGER NOT NULL DEFAULT 2048")
        usage_cols = {r["name"] for r in c.execute("PRAGMA table_info(usage)")}
        if "bytes" not in usage_cols:
            c.execute("ALTER TABLE usage ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0")
        # 索引必须在补列之后建：SCHEMA 里的 CREATE INDEX 会在存量旧表上
        # 引用还不存在的 available_at，导致数据库一打开就 OperationalError。
        c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_available "
                  "ON jobs(status, available_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_failed_recent "
                  "ON jobs(finished_at) WHERE status='failed'")
        self._backfill_assets()

    def _backfill_assets(self) -> None:
        """把老库的 `usage.bytes` 折成一条 legacy 引用。

        老版本只记了「某租户累计上传了多少字节」，没有文件级明细，无法反推
        到 sha。折成一条 `legacy:<tenant>` 的引用后：配额语义不变（仍算已用），
        但它不对应任何文件，GC 会跳过 —— 要释放只能显式清零，不能假装能自动回收。
        """
        c = self._conn()
        if c.execute("SELECT COUNT(*) n FROM asset_refs").fetchone()["n"]:
            return
        rows = c.execute(
            "SELECT tenant, SUM(bytes) b FROM usage WHERE bytes>0 GROUP BY tenant"
        ).fetchall()
        if not rows:
            return
        now = self.db_now()
        with self.tx() as tx:
            for r in rows:
                tx.execute(
                    "INSERT INTO asset_refs(sha,tenant,bytes,created_at,last_seen) "
                    "VALUES(?,?,?,?,?) ON CONFLICT(sha,tenant) DO NOTHING",
                    (f"legacy:{r['tenant']}", r["tenant"], int(r["b"]), now, now))

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.db_path), timeout=30,
                                   isolation_level=None,
                                   check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=8000")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def close_thread_connection(self) -> None:
        """关闭当前线程的 SQLite 连接。

        ThreadingHTTPServer 每个请求开一个短命线程，而 threading.local 里的
        sqlite3.Connection 有「连接↔游标」循环引用，靠 GC 才回收 —— 500 条
        长稳实测残留 67 个 sqlite fd、常驻内存从 194 涨到 257 MiB。
        在请求结束时显式关掉，fd 与 page cache 立刻释放。
        长期存活的 worker / reaper 线程不调用这个方法，保留各自连接。
        """
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            self._local.conn = None
            self._local.tx_depth = 0
            try:
                conn.close()
            except Exception:
                pass

    # ── 单一时钟源：HLC ────────────────────────────────────
    def _read_last_ts(self, c=None) -> float:
        cur = c if c is not None else self._conn()
        row = cur.execute("SELECT last_ts FROM clock WHERE id=1").fetchone()
        return float(row["last_ts"]) if row else 0.0

    def _write_last_ts(self, c, ts: float) -> None:
        # 只前进：并发写时后到的较小值不覆盖较大值（PG 下行锁串行化）
        c.execute("UPDATE clock SET last_ts=? WHERE id=1 AND last_ts<?", (ts, ts))

    def _init_anchor(self) -> None:
        self._anchor_wall = self._wall()
        self._anchor_mono = self._mono()
        self._last_off: float | None = None

    def _logical_now(self) -> float:
        """逻辑时间 = 锚点 + 单调钟增量。墙钟只用来**观测**跳变，不参与计算。

        租约的判据必须是连续时间。墙钟前跳 1 小时，`lease_until < now` 会对
        所有 running 同时成立，reaper 把它们全改回 accepted，而原 worker 还在
        渲染 —— 双领。回拨则相反：过期任务永远不被回收。

        做法：逻辑时间完全不看墙钟，只按单调钟前进；同时记录「墙钟 - 逻辑时间」
        的偏移，偏移突变超过阈值就判定为系统时钟被调整，留痕但**不改时间**。
        """
        with self._clock_lock:
            if self._anchor_mono is None:
                self._init_anchor()
            logical = self._anchor_wall + (self._mono() - self._anchor_mono)
            off = self._wall() - logical
            if self._last_off is None:
                self._last_off = off
            elif abs(off - self._last_off) > CLOCK_JUMP_TOL_S:
                self._last_drift = round(off - self._last_off, 3)
                self._pending_drift = self._last_drift
                self._last_off = off
            return logical

    def db_now(self, *, advance: bool = False) -> float:
        """当前时间（逻辑时钟），DB 内单调不回退。

        `advance=True` 用于状态变更：把共享时间基推进到当前值，并落一条
        时钟跳变事件（如果有）。只前进不后退，所以任何实例都不会读到
        比「已经发放出去的租约」更早的时间。
        """
        logical = self._logical_now()
        base = self._read_last_ts()
        if base > logical:
            # 收到更大的时钟（别的实例/重启前的自己）：前移锚点，绝不后退
            with self._clock_lock:
                self._anchor_wall += base - logical
                self._last_off = None      # 重新建立偏移基线，避免误报跳变
            logical = base
        if advance:
            drift = self._pending_drift
            with self.tx() as c:
                self._write_last_ts(c, logical)
                if drift is not None:
                    c.execute("INSERT INTO clock_events(ts,drift_s,actor) VALUES(?,?,?)",
                              (logical, drift, self._clock_actor))
                    # 跳变只留痕，不停手：逻辑时间根本没跟着跳，
                    # 停手只会让崩溃任务多等一个窗口（实测 compose 恢复被拖慢 60s）。
                    c.execute("INSERT INTO audit(ts,actor,action,data) VALUES(?,?,?,?)",
                              (logical, self._clock_actor, "clock_skew_detected",
                               json.dumps({"drift_s": drift,
                                           "note": "已吸收，租约判断不受影响"},
                                          ensure_ascii=False)))
                    self._pending_drift = None
        return logical

    def reset_clock(self) -> None:
        """测试用：丢弃本实例的时间锚与偏移基线，重新对齐墙钟。"""
        with self._clock_lock:
            self._anchor_mono = None
            self._last_off = None
            self._last_drift = None
            self._pending_drift = None

    def clock_skew_s(self) -> float | None:
        """最近一次时钟跳变幅度（跨实例可见）。

        原先存在实例属性里，API 副本 A 看到跳变、副本 B 的 /metrics 仍是 null ——
        运维看到的是「没有异常」。落库后任何实例都能回答同一个问题。
        """
        row = self._conn().execute(
            "SELECT drift_s FROM clock_events ORDER BY id DESC LIMIT 1").fetchone()
        return float(row["drift_s"]) if row else None

    def _event(self, c, job_id: str, stage: str, message: str = "",
               data: dict | None = None, level: str = "info",
               ts: float | None = None) -> None:
        """在**调用方的事务内**写事件。

        原先每次状态变更要开两个事务（UPDATE jobs + INSERT job_events），
        一条任务约 24 次写事务；合并后状态与事件要么都落、要么都不落，
        原子性更好，PG 下还省掉一半网络往返。
        """
        c.execute(
            "INSERT INTO job_events(job_id,ts,stage,level,message,data) "
            "VALUES(?,?,?,?,?,?)",
            (job_id, ts if ts is not None else self.db_now(), stage, level, message,
             json.dumps(data, ensure_ascii=False) if data else None))

    def ping(self) -> float:
        """连通性探针：一次真实往返，返回毫秒。

        刻意不走 `tx()`：那会开 `BEGIN IMMEDIATE` 拿写锁，探针每分钟都在跑，
        队列繁忙时会把就绪检查卡成「假下线」。只读 SELECT 不参与锁竞争。
        """
        t0 = time.perf_counter()
        self._conn().execute("SELECT 1").fetchone()
        return (time.perf_counter() - t0) * 1000

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """事务。可重入：内层复用外层事务，只有最外层提交/回滚。

        重入不是为了好看：`db_now(advance=True)` 自己也要写 clock 表，
        如果被调用时已经在事务里，再发一次 BEGIN IMMEDIATE 会直接报
        「cannot start a transaction within a transaction」。
        """
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
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        finally:
            self._local.tx_depth = 0

    # ── 租户 ─────────────────────────────────────────────
    def ensure_tenant(self, tenant: str, name: str = "",
                      monthly_minutes: int = 1000, qps: int = 10,
                      storage_mb: int = 2048) -> dict:
        with self.tx() as c:
            c.execute(
                "INSERT INTO tenants(id,name,monthly_minutes,qps,storage_mb,created_at) "
                "VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
                (tenant, name, monthly_minutes, qps, storage_mb, self.db_now(advance=True)))
            row = c.execute("SELECT * FROM tenants WHERE id=?", (tenant,)).fetchone()
        return dict(row)

    def get_tenant(self, tenant: str) -> dict | None:
        row = self._conn().execute("SELECT * FROM tenants WHERE id=?", (tenant,)).fetchone()
        return _row_to_dict(row)

    def set_quota(self, tenant: str, monthly_minutes: int | None = None,
                  qps: int | None = None, storage_mb: int | None = None) -> dict | None:
        with self.tx() as c:
            if monthly_minutes is not None:
                c.execute("UPDATE tenants SET monthly_minutes=? WHERE id=?",
                          (monthly_minutes, tenant))
            if qps is not None:
                c.execute("UPDATE tenants SET qps=? WHERE id=?", (qps, tenant))
            if storage_mb is not None:
                c.execute("UPDATE tenants SET storage_mb=? WHERE id=?",
                          (storage_mb, tenant))
        return self.get_tenant(tenant)

    # ── 用量 ─────────────────────────────────────────────
    def usage_get(self, tenant: str, period: str | None = None) -> dict:
        p = period or period_of()
        row = self._conn().execute(
            "SELECT * FROM usage WHERE tenant=? AND period=?", (tenant, p)).fetchone()
        return dict(row) if row else {
            "tenant": tenant, "period": p, "seconds": 0.0, "jobs": 0, "bytes": 0}

    def usage_add(self, tenant: str, seconds: float, jobs: int = 1) -> None:
        p = period_of()
        with self.tx() as c:
            c.execute(
                "INSERT INTO usage(tenant,period,seconds,jobs,bytes) VALUES(?,?,?,?,0) "
                "ON CONFLICT(tenant,period) DO UPDATE SET "
                "seconds=usage.seconds+excluded.seconds, jobs=usage.jobs+excluded.jobs",
                (tenant, p, seconds, jobs))

    def usage_add_bytes(self, tenant: str, n: int) -> None:
        """上传配额：只计「真正新写入」的字节。内容寻址去重后重复上传不计费。"""
        p = period_of()
        with self.tx() as c:
            c.execute(
                "INSERT INTO usage(tenant,period,seconds,jobs,bytes) VALUES(?,?,0,0,?) "
                "ON CONFLICT(tenant,period) DO UPDATE SET "
                "bytes=usage.bytes+excluded.bytes",
                (tenant, p, int(n)))

    def storage_used_bytes(self, tenant: str) -> int:
        """按「当前仍被该租户引用的素材」求和。

        原先是 `SUM(usage.bytes)`：只增不减 —— 文件删了配额也退不回来，
        因为没有一张表能把「这份字节属于哪个文件」拆开。改成引用表后，
        删除引用即释放配额，且跨月不会重置（文件不会因为翻篇就消失）。
        """
        row = self._conn().execute(
            "SELECT COALESCE(SUM(bytes),0) n FROM asset_refs WHERE tenant=?",
            (tenant,)).fetchone()
        return int(row["n"] if row else 0)

    def storage_quota_bytes(self, tenant: str) -> int:
        t = self.get_tenant(tenant) or {}
        return int(t.get("storage_mb") or 2048) * 1024 * 1024

    def _lock_tenant_row(self, c, tenant: str) -> None:
        """在写事务里给租户行加锁。SQLite 的 BEGIN IMMEDIATE 已经串行化所有写，
        这里不需要额外动作；PG 必须显式 FOR UPDATE，否则两个 pod 会同时读到
        同一份 used，配额被并发绕过（见 store_pg.py 的 override）。"""
        return None

    def storage_reserve(self, tenant: str, sha: str, n: int,
                        quota: int) -> tuple[bool, int]:
        """原子预占存储配额：查已用 + 记引用在同一个写事务里完成。

        原先是 `threading.Lock` 包住「查→写→计数」，进程内成立、多副本立刻失效：
        两个实例同时读到 used=0，各自放行 700KB，1MB 配额写成 1.34MB。
        配额是钱，必须由共享存储做仲裁，不能由进程内存做。
        """
        with self.tx() as c:
            self._lock_tenant_row(c, tenant)
            row = c.execute(
                "SELECT COALESCE(SUM(bytes),0) n FROM asset_refs WHERE tenant=?",
                (tenant,)).fetchone()
            used = int(row["n"] if row else 0)
            if used + n > quota:
                return False, used
            now = self.db_now()
            c.execute(
                "INSERT INTO asset_refs(sha,tenant,bytes,created_at,last_seen) "
                "VALUES(?,?,?,?,?) ON CONFLICT(sha,tenant) DO UPDATE SET "
                "bytes=asset_refs.bytes+excluded.bytes, last_seen=excluded.last_seen",
                (sha, tenant, int(n), now, now))
        return True, used

    def storage_refund(self, tenant: str, sha: str, n: int) -> int:
        """退回预占。写盘失败或去重命中时调用；不会把 bytes 扣成负数。"""
        with self.tx() as c:
            cur = c.execute(
                "UPDATE asset_refs SET bytes=bytes-? WHERE sha=? AND tenant=? AND bytes>=?",
                (int(n), sha, tenant, int(n)))
            return cur.rowcount

    # ── 素材登记 / 引用 / 回收 ────────────────────────────
    def asset_register(self, sha: str, size: int, path: str) -> None:
        now = self.db_now()
        with self.tx() as c:
            c.execute(
                "INSERT INTO assets(sha,bytes,path,created_at,last_seen) "
                "VALUES(?,?,?,?,?) ON CONFLICT(sha) DO UPDATE SET "
                "last_seen=excluded.last_seen, bytes=excluded.bytes, "
                "path=COALESCE(excluded.path, assets.path)",
                (sha, int(size), path, now, now))

    def asset_ref_ensure(self, sha: str, tenant: str) -> None:
        """登记「这个租户引用了这份内容」，不计费（内容寻址去重）。"""
        now = self.db_now()
        with self.tx() as c:
            c.execute(
                "INSERT INTO asset_refs(sha,tenant,bytes,created_at,last_seen) "
                "VALUES(?,?,0,?,?) ON CONFLICT(sha,tenant) DO UPDATE SET "
                "last_seen=excluded.last_seen", (sha, tenant, now, now))

    def asset_resolve(self, asset_id: str, tenant: str) -> dict | None:
        key = asset_id[6:] if asset_id.startswith("asset_") else asset_id
        rows = self._conn().execute(
            "SELECT a.sha, a.bytes, a.path FROM assets a "
            "JOIN asset_refs r ON r.sha=a.sha "
            "WHERE r.tenant=? AND (a.sha=? OR a.sha LIKE ?) LIMIT 2",
            (tenant, key, key + "%")).fetchall()
        if not rows:
            return None
        if len(rows) > 1:
            raise JobError("E_ASSET_AMBIGUOUS",
                           f"素材前缀 {asset_id} 匹配到多个对象",
                           field="asset_id", hint="用完整 sha256 或返回的 asset_id")
        return dict(rows[0])

    def asset_release(self, sha: str, tenant: str) -> dict | None:
        """解除一个租户对素材的引用；最后一个引用消失时才删除登记行。

        文件本身由调用方删（service 拥有 media_dir），这里只做数据一致性判断。
        """
        with self.tx() as c:
            row = c.execute("SELECT bytes,path FROM assets WHERE sha=?", (sha,)).fetchone()
            if not row:
                return None
            ref = c.execute("SELECT bytes FROM asset_refs WHERE sha=? AND tenant=?",
                            (sha, tenant)).fetchone()
            if not ref:
                return None
            active = c.execute(
                "SELECT COUNT(*) n FROM jobs WHERE status IN ('accepted','running') "
                "AND ir_json LIKE ?", ("%" + sha + "%",)).fetchone()["n"]
            if active:
                raise JobError("E_ASSET_IN_USE",
                               f"素材仍被 {active} 个在途任务引用，暂不能删除",
                               field="asset_id",
                               hint="等任务结束，或先 cancel；已结束任务的产物不受影响")
            refunded = int(ref["bytes"])
            c.execute("DELETE FROM asset_refs WHERE sha=? AND tenant=?", (sha, tenant))
            left = c.execute("SELECT COUNT(*) n FROM asset_refs WHERE sha=?",
                             (sha,)).fetchone()["n"]
            removed = False
            if left == 0:
                c.execute("DELETE FROM assets WHERE sha=?", (sha,))
                removed = True
        return {"sha": sha, "refunded_bytes": refunded,
                "file_removed": removed, "path": row["path"],
                "remaining_refs": max(0, left)}

    def assets_count(self, tenant: str) -> int:
        row = self._conn().execute(
            "SELECT COUNT(*) n FROM asset_refs WHERE tenant=?", (tenant,)).fetchone()
        return int(row["n"] if row else 0)

    def assets_list(self, tenant: str, limit: int = 100) -> list[dict]:
        # LEFT JOIN：老库折出来的 legacy 行没有对应文件，但它确实占着配额，
        # 列表里必须看得见 —— 否则「已用 4KB，列表却空」无法解释。
        rows = self._conn().execute(
            "SELECT r.sha, COALESCE(a.bytes, r.bytes) bytes, a.path, "
            "       r.created_at, r.last_seen, r.bytes charged "
            "FROM asset_refs r LEFT JOIN assets a ON a.sha=r.sha "
            "WHERE r.tenant=? ORDER BY r.last_seen DESC LIMIT ?",
            (tenant, min(limit, 500))).fetchall()
        return [dict(r) for r in rows]

    # ── 准入限流（跨实例） ────────────────────────────────
    # 方言钩子：SQL 里的字面量 `%` 会被 psycopg 当成占位符（即便有参数时也一样），
    # 所以「子串包含」不能写成共享的 LIKE '%' || x || '%'。SQLite 用 LIKE，
    # PG 用 strpos，由子类覆盖这一行。
    SQL_CONTAINS = "({a} LIKE '%' || {b} || '%')"

    RATE_BUCKET_S = 0.05      # 子桶宽度：50ms
    # 20 个历史子桶（1.0s）+ 当前子桶 = 1.05s 有效窗口。
    # 少一个桶就会漏：burst 隔 0.97s 发生两次时，1 秒内能看到 2×qps（实测过）。
    RATE_WINDOW = 21

    def rate_count(self, key: str) -> int:
        """只读：当前 1 秒窗口内已记多少次。用于鉴权失败的前置拦截。"""
        b = int(time.time() / self.RATE_BUCKET_S)
        row = self._conn().execute(
            "SELECT COALESCE(SUM(hits),0) n FROM rate_window "
            "WHERE tenant=? AND bucket BETWEEN ? AND ?",
            (key, b - self.RATE_WINDOW + 1, b)).fetchone()
        return int(row["n"] if row else 0)

    def rate_bump(self, key: str, cost: int = 1) -> None:
        """无条件记账。与 rate_hit 的区别：调用方自己决定超限后做什么。"""
        b = int(time.time() / self.RATE_BUCKET_S)
        with self.tx() as c:
            c.execute(
                "INSERT INTO rate_window(tenant,bucket,hits) VALUES(?,?,?) "
                "ON CONFLICT(tenant,bucket) DO UPDATE SET "
                "hits=rate_window.hits+excluded.hits", (key, b, cost))

    def rate_guard(self, key: str, qps: int) -> None:
        """前置拦截：窗口内已超预算就直接拒，不再做后面的鉴权计算。"""
        if qps <= 0:
            return
        if self.rate_count(key) >= qps:
            raise JobError("E_RATE_LIMITED",
                           f"鉴权失败过于频繁（{qps}/s），请检查 token",
                           hint="退避后重试；连续失败会被持续限速")

    def rate_hit(self, tenant: str, qps: int, cost: int = 1) -> None:
        """租户级 QPS，计数在共享存储里，N 个副本共享同一个预算。

        为什么不是「固定 1 秒窗口」：固定窗口在整秒边界能放行 2×qps
        （59.9s 用满 + 60.1s 再用满），实测 1 秒内能看到 1.5–2 倍。
        这里用 20 个 50ms 子桶求和，任意 1 秒窗口最多 qps + 1（量化误差）。

        整条判定是**一条 SQL**：`INSERT … SELECT … WHERE 窗口未满 ON CONFLICT
        DO UPDATE … WHERE 当前桶未满`。这样「读窗口 → 判断 → 记账」没有间隙，
        也不需要显式事务（单语句本身就是原子的），PG 下只花一次往返。
        """
        if qps <= 0:
            return
        # 子桶用墙钟：限流对齐的是「秒」，不是租约那种必须连续的时序。
        # 好处是这里完全不需要读 DB 时钟，少一次往返。
        b = int(time.time() / self.RATE_BUCKET_S)
        # 本地冷却：同一子桶内已被拒过就不要再打 DB。这只会「更严」，
        # 不会「更松」——被拒的请求本来也过不去，但洪水下能省掉大量查询。
        if self._rate_cooldown.get(tenant) == b:
            raise JobError("E_RATE_LIMITED", f"超过 {qps} req/s", hint="退避后重试")
        lo = b - self.RATE_WINDOW + 1
        row = self._conn().execute(
            "INSERT INTO rate_window(tenant,bucket,hits) SELECT ?,?,? "
            "WHERE (SELECT COALESCE(SUM(hits),0) FROM rate_window "
            "       WHERE tenant=? AND bucket BETWEEN ? AND ?) + ? <= ? "
            "ON CONFLICT(tenant,bucket) DO UPDATE SET "
            "hits=rate_window.hits+excluded.hits "
            "WHERE rate_window.hits+excluded.hits <= ? - "
            "  (SELECT COALESCE(SUM(hits),0) FROM rate_window r "
            "   WHERE r.tenant=excluded.tenant AND r.bucket BETWEEN ? AND ?) "
            "RETURNING hits",
            (tenant, b, cost, tenant, lo, b - 1, cost, qps, qps, lo, b - 1)).fetchone()
        if not row:
            self._rate_cooldown[tenant] = b
            raise JobError("E_RATE_LIMITED", f"超过 {qps} req/s", hint="退避后重试")
        # 每秒清一次过期子桶：不清的话单租户每小时会攒 7 万行
        if self._rate_pruned.get(tenant) != b // self.RATE_WINDOW:
            self._conn().execute(
                "DELETE FROM rate_window WHERE tenant=? AND bucket < ?",
                (tenant, lo - 1))
            self._rate_pruned[tenant] = b // self.RATE_WINDOW

    def find_by_idem(self, tenant: str, idem_key: str) -> dict | None:
        """按幂等键找已存在的任务。用于「重放不该被配额拦住」的短路判断。"""
        row = self._conn().execute(
            "SELECT * FROM jobs WHERE tenant=? AND idem_key=?",
            (tenant, idem_key)).fetchone()
        return dict(row) if row else None

    def quota_reserved_seconds(self, tenant: str) -> float:
        """在途任务已占用的额度（按成片时长 `billed_seconds` 计）。

        为什么不需要单独一张「预占表」：`billed_seconds` 在提交时写入，
        任务一旦离开 accepted/running（成功记用量、失败或取消）就自动失效。
        于是 jobs 表本身就是预占记录 —— 少一张表的生命周期要维护，
        也不会出现「预占忘记释放」这类最常见的账务 bug。
        """
        row = self._conn().execute(
            "SELECT COALESCE(SUM(billed_seconds),0) s FROM jobs "
            "WHERE tenant=? AND status IN ('accepted','running')", (tenant,)).fetchone()
        return float(row["s"] or 0.0)

    def quota_remaining_seconds(self, tenant: str) -> float | None:
        t = self.get_tenant(tenant)
        if not t:
            return None
        used = self.usage_get(tenant)["seconds"]
        # 已用 + 在途预占。只减 used 的话，排队中的任务不占额度，
        # 一个租户可以在配额见底前把在途名额（默认 8）全部灌满 —— 实测透支 2 倍。
        reserved = self.quota_reserved_seconds(tenant)
        return max(0.0, t["monthly_minutes"] * 60.0 - used - reserved)

    def _quota_guard(self, tenant: str, billed_seconds: float) -> None:
        """在事务内判定配额，超了抛 E_QUOTA_EXCEEDED。

        必须在**任务行已经写入之后**调用：新任务自己也算在 `reserved` 里，
        判据是 `used + reserved > quota`，正好等于额度是允许的（4 × 15 s = 60 s 应放行）。
        反过来用 `quota_remaining_seconds()`（它在 0 处截断）会少放一个任务。
        """
        t = self.get_tenant(tenant)
        if not t or billed_seconds <= 0:
            return
        quota = float(t["monthly_minutes"]) * 60.0
        used = float(self.usage_get(tenant)["seconds"] or 0.0)
        reserved = self.quota_reserved_seconds(tenant)      # 含本次
        if used + reserved > quota + 1e-6:
            before = max(0.0, quota - used - (reserved - billed_seconds))
            raise JobError(
                "E_QUOTA_EXCEEDED",
                f"本月剩余 {before:.0f}s（已扣在途任务），本次需要 {billed_seconds:.0f}s",
                hint="等下月重置、提高配额，或等当前任务结束",
                allowed_values=[f"<= {before:.0f}"])

    # ── 提交（幂等） ──────────────────────────────────────
    def submit(self, *, tenant: str, idem_key: str, ir_json: dict, ir_hash: str,
               frames_total: int, backend: str = "ffmpeg", priority: int = 0,
               max_attempts: int = 3, callback_url: str | None = None,
               callback_pin: dict | None = None, delivery_spec: dict | None = None,
               cost_seconds: float = 0.0,
               billed_seconds: float = 0.0) -> tuple[dict, bool]:
        """返回 (job, replay)。replay=True 表示命中了幂等键，没有产生新任务。

        配额在**同一个事务里**判定：插入新任务后立刻算「已用 + 在途预占」，
        超过月配额就抛错回滚。放在 service 层的读-判-写之间是有间隙的 ——
        两个并发提交会同时通过检查（实测 60 s 配额能接进 120 s）。
        """
        now = self.db_now(advance=True)
        job_id = new_job_id()
        with self.tx() as c:
            cur = c.execute(
                "INSERT INTO jobs(id,tenant,idem_key,ir_hash,ir_json,backend,"
                "status,stage,priority,attempts,max_attempts,created_at,"
                "frames_total,callback_url,callback_ip,delivery_json,cost_seconds,"
                "billed_seconds) "
                "SELECT ?,?,?,?,?,?,'accepted','queued',?,0,?,?,?,?,?,?,?,? "
                "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE tenant=? AND idem_key=?)",
                (job_id, tenant, idem_key, ir_hash,
                 json.dumps(ir_json, ensure_ascii=False), backend,
                 priority, max_attempts, now, frames_total,
                 callback_url,
                 json.dumps(callback_pin, ensure_ascii=False) if callback_pin else None,
                 json.dumps(delivery_spec, ensure_ascii=False) if delivery_spec else None,
                 cost_seconds, billed_seconds, tenant, idem_key))
            row = c.execute("SELECT * FROM jobs WHERE tenant=? AND idem_key=?",
                            (tenant, idem_key)).fetchone()
            job = dict(row)
            replay = job["id"] != job_id
            if not replay:
                # 幂等重放不重新算额度：老任务已经在账上了
                self._quota_guard(tenant, billed_seconds)
                self._event(c, job["id"], "queued", f"accepted, priority={priority}")
        return job, replay

    # ── 领取 ─────────────────────────────────────────────
    def claim(self, worker: str, lease_s: float) -> dict | None:
        now = self.db_now(advance=True)
        with self.tx() as c:
            row = c.execute(
                "UPDATE jobs SET status='running', stage='ingesting', worker=?, "
                "lease_until=?, started_at=COALESCE(started_at,?), attempts=attempts+1 "
                "WHERE id=(SELECT id FROM jobs WHERE status='accepted' "
                "         AND (available_at IS NULL OR available_at <= ?) "
                "         ORDER BY priority DESC, created_at ASC LIMIT 1) "
                "RETURNING *", (worker, now + lease_s, now, now)).fetchone()
            job = _row_to_dict(row)
            if job:
                self._event(c, job["id"], "ingesting",
                          f"claimed by {worker} "
                          f"(attempt {job['attempts']}/{job['max_attempts']})")
        return job

    def heartbeat(self, job_id: str, worker: str, lease_s: float,
                  frames_done: int | None = None) -> bool:
        now = self.db_now(advance=True)
        with self.tx() as c:
            if frames_done is None:
                cur = c.execute("UPDATE jobs SET lease_until=? WHERE id=? AND worker=? "
                                "AND status='running'", (now + lease_s, job_id, worker))
            else:
                cur = c.execute("UPDATE jobs SET lease_until=?, frames_done=? WHERE id=? "
                                "AND worker=? AND status='running'",
                                (now + lease_s, frames_done, job_id, worker))
            return cur.rowcount > 0

    def set_stage(self, job_id: str, stage: str, message: str = "",
                  data: dict | None = None) -> None:
        with self.tx() as c:
            c.execute("UPDATE jobs SET stage=? WHERE id=?", (stage, job_id))
            self._event(c, job_id, stage, message, data)

    def succeed(self, job_id: str, *, output_path: str, receipt_path: str,
                receipt: dict, cache_hit: bool = False) -> None:
        now = self.db_now(advance=True)
        with self.tx() as c:
            row = c.execute("SELECT started_at, tenant FROM jobs WHERE id=?",
                            (job_id,)).fetchone()
            started = row["started_at"] if row else now
            c.execute(
                "UPDATE jobs SET status='succeeded', stage='done', finished_at=?, "
                "lease_until=NULL, worker=NULL, output_path=?, receipt_path=?, "
                "receipt_json=?, cache_hit=?, cost_seconds=? WHERE id=?",
                (now, output_path, receipt_path,
                 json.dumps(receipt, ensure_ascii=False),
                 1 if cache_hit else 0, max(0.0, now - (started or now)), job_id))
            self._event(c, job_id, "done",
                      "succeeded" + (" (cache hit)" if cache_hit else ""))

    def fail(self, job_id: str, error: dict, *, backoff_base_s: float = 0.0) -> str:
        """返回最终状态：'accepted'（将重试）或 'failed'。

        指数退避：第 n 次失败后延迟 base × n² 秒再可领取。没有这一层，
        瞬态错误（NVENC 会话满、OOM）会在几秒内连烧完所有 attempts。
        """
        now = self.db_now(advance=True)
        with self.tx() as c:
            row = c.execute("SELECT attempts,max_attempts FROM jobs WHERE id=?",
                            (job_id,)).fetchone()
            if not row:
                return "failed"
            retryable = bool(error.get("retryable"))
            can_retry = retryable and row["attempts"] < row["max_attempts"]
            status = "accepted" if can_retry else "failed"
            delay = backoff_base_s * (row["attempts"] ** 2) if can_retry else 0.0
            available_at = now + delay if can_retry else None
            c.execute(
                "UPDATE jobs SET status=?, stage=?, finished_at=?, lease_until=NULL, "
                "worker=NULL, available_at=?, error_code=?, error_json=? WHERE id=?",
                (status, "queued" if can_retry else "failed",
                 None if can_retry else now, available_at,
                 error.get("code"), json.dumps(error, ensure_ascii=False), job_id))
            self._event(c, job_id, "queued" if can_retry else "failed",
                      f"{error.get('code')} retryable={error.get('retryable')} "
                      f"backoff={round(delay, 2)}s")
        return status

    def cancel(self, job_id: str) -> bool:
        with self.tx() as c:
            cur = c.execute(
                "UPDATE jobs SET status='cancelled', stage='cancelled', finished_at=?, "
                "lease_until=NULL, worker=NULL WHERE id=? AND status IN ('accepted')",
                (self.db_now(advance=True), job_id))
            return cur.rowcount > 0

    # ── 回收 ─────────────────────────────────────────────
    def recover_expired(self) -> list[str]:
        """租约过期的任务：还有重试次数就回到队列，否则判失败。

        判据完全在**逻辑时间**上（见 db_now）。墙钟跳变已被吸收，所以这里
        不再需要「检测到跳变就停手」—— 停手是上一轮的缓解手段，在 HLC 下
        只会让崩溃任务多等一个窗口（compose 崩溃恢复实测被拖慢 60s）。
        跳变本身仍然留痕：`clock_events` + `audit(clock_skew_detected)`。
        """
        now = self.db_now(advance=True)
        with self.tx() as c:
            rows = c.execute(
                "UPDATE jobs SET "
                "  status = CASE WHEN attempts < max_attempts THEN 'accepted' ELSE 'failed' END, "
                "  stage  = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, "
                "  finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE ? END, "
                "  error_code = COALESCE(error_code,'E_TIMEOUT'), "
                "  available_at = NULL, lease_until = NULL, worker = NULL "
                "WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ? "
                "RETURNING id", (now, now)).fetchall()
            ids = [r["id"] for r in rows]
            for jid in ids:
                self._event(c, jid, "queued", "lease expired, requeued")
        return ids

    # ── 查询 ─────────────────────────────────────────────
    def get(self, job_id: str, tenant: str | None = None) -> dict | None:
        if tenant:
            row = self._conn().execute(
                "SELECT * FROM jobs WHERE id=? AND tenant=?", (job_id, tenant)).fetchone()
        else:
            row = self._conn().execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return _row_to_dict(row)

    def list_jobs(self, tenant: str, limit: int = 50, status: str | None = None) -> list[dict]:
        sql = "SELECT id,tenant,status,stage,priority,attempts,created_at,finished_at," \
              "frames_total,cache_hit,error_code,cost_seconds FROM jobs WHERE tenant=?"
        args: list[Any] = [tenant]
        if status:
            sql += " AND status=?"
            args.append(status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        return [dict(r) for r in self._conn().execute(sql, args)]

    def events(self, job_id: str, limit: int = 200) -> list[dict]:
        rows = self._conn().execute(
            "SELECT * FROM job_events WHERE job_id=? ORDER BY id LIMIT ?",
            (job_id, limit)).fetchall()
        return [dict(r) for r in rows]

    def event(self, job_id: str, stage: str, message: str = "",
              data: dict | None = None, level: str = "info") -> None:
        with self.tx() as c:
            self._event(c, job_id, stage, message, data, level)

    # ── 缓存 ─────────────────────────────────────────────
    def cache_get(self, key: str) -> dict | None:
        row = self._conn().execute("SELECT * FROM render_cache WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        item = dict(row)
        if not Path(item["output_path"]).exists():
            return None
        with self.tx() as c:
            c.execute("UPDATE render_cache SET hits=hits+1 WHERE key=?", (key,))
        return item

    def cache_put(self, key: str, *, ir_hash: str, backend: str, output_path: str,
                  receipt_path: str, size: int) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO render_cache(key,ir_hash,backend,output_path,receipt_path,"
                "bytes,created_at,hits) VALUES(?,?,?,?,?,?,?,0) "
                "ON CONFLICT(key) DO UPDATE SET output_path=excluded.output_path,"
                "receipt_path=excluded.receipt_path, bytes=excluded.bytes",
                (key, ir_hash, backend, output_path, receipt_path, size,
                 self.db_now(advance=True)))

    # ── 审计 ─────────────────────────────────────────────
    def audit(self, *, action: str, tenant: str | None = None, actor: str | None = None,
              target: str | None = None, ip: str | None = None,
              data: dict | None = None) -> None:
        with self.tx() as c:
            c.execute("INSERT INTO audit(ts,tenant,actor,action,target,ip,data) "
                      "VALUES(?,?,?,?,?,?,?)",
                      (self.db_now(), tenant, actor, action, target, ip,
                       json.dumps(data, ensure_ascii=False) if data else None))

    def audit_tail(self, limit: int = 100) -> list[dict]:
        return [dict(r) for r in self._conn().execute(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))]

    # ── 队列可观测 / 死信 / 运维 ──────────────────────────
    def queue_stats(self) -> dict:
        """出事故时要能一眼回答：堆了多少、最老等多久、谁在占着队列。"""
        c = self._conn()
        now = self.db_now()
        row = c.execute(
            "SELECT "
            " COALESCE(SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END),0) depth, "
            " COALESCE(SUM(CASE WHEN status='accepted' AND "
            "   (available_at IS NULL OR available_at <= ?) THEN 1 ELSE 0 END),0) ready, "
            " COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) running, "
            " MIN(CASE WHEN status='accepted' THEN created_at END) oldest, "
            " MIN(CASE WHEN status='running' THEN lease_until END) next_lease "
            "FROM jobs WHERE status IN ('accepted','running')", (now,)).fetchone()
        inflight = [dict(r) for r in c.execute(
            "SELECT tenant, COUNT(*) n FROM jobs "
            "WHERE status IN ('accepted','running') GROUP BY tenant")]
        failed_24h = c.execute(
            "SELECT COUNT(*) n FROM jobs WHERE status='failed' AND finished_at > ?",
            (now - 86400,)).fetchone()["n"]
        return {
            "depth": row["depth"], "ready": row["ready"],
            "delayed": row["depth"] - row["ready"], "running": row["running"],
            "oldest_wait_s": round(now - row["oldest"], 2) if row["oldest"] else 0.0,
            "next_lease_s": round((row["next_lease"] or now) - now, 2),
            "inflight_by_tenant": {r["tenant"]: r["n"] for r in inflight},
            "failed_24h": failed_24h,
            "clock_skew_s": self.clock_skew_s(),
        }

    def dlq(self, tenant: str | None = None, limit: int = 50) -> list[dict]:
        sql = ("SELECT id,tenant,status,stage,attempts,max_attempts,error_code,"
               "error_json,created_at,finished_at FROM jobs WHERE status='failed'")
        args: list[Any] = []
        if tenant:
            sql += " AND tenant=?"
            args.append(tenant)
        sql += " ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?"
        args.append(min(limit, 200))
        return [dict(r) for r in self._conn().execute(sql, args)]

    def replay(self, job_id: str, tenant: str | None = None) -> dict | None:
        """人工重放死信：就地改回 accepted，重置 attempts 与错误，不新建任务。"""
        sql = ("UPDATE jobs SET status='accepted', stage='queued', finished_at=NULL, "
               "lease_until=NULL, worker=NULL, available_at=NULL, attempts=0, "
               "error_code=NULL, error_json=NULL WHERE id=? AND status='failed'")
        args: list[Any] = [job_id]
        if tenant:
            sql += " AND tenant=?"
            args.append(tenant)
        sql += " RETURNING *"
        with self.tx() as c:
            row = c.execute(sql, args).fetchone()
            if row:
                self._event(c, job_id, "queued",
                          "manual replay from DLQ (attempts reset)")
        return dict(row) if row else None

    def release_worker(self, worker: str) -> list[str]:
        """运维主动归还某个失联 worker 的任务，不必等租约到期。\n\n        刻意不做成 SIGTERM 自动行为：原进程可能还在跑 ffmpeg，\n        立刻改回 accepted 会造成双领。只有确认进程已退出才调用。\n        """
        with self.tx() as c:
            rows = c.execute(
                "UPDATE jobs SET status='accepted', stage='queued', lease_until=NULL, "
                "worker=NULL, available_at=NULL WHERE status='running' AND worker=? "
                "RETURNING id", (worker,)).fetchall()
            ids = [r["id"] for r in rows]
            for jid in ids:
                self._event(c, jid, "queued", f"released by operator from {worker}")
        return ids

    # ── 统计 ─────────────────────────────────────────────
    def known_tenants(self, limit: int = 500) -> list[str]:
        """所有登记过的租户 id。

        指标要给每个租户暴露 0 值：如果「无在途任务」时整条序列消失，
        `rate()` 会断、面板会出空档、`absent()` 会把正常的空闲误判成故障。
        """
        try:
            rows = self._conn().execute(
                "SELECT id FROM tenants ORDER BY id LIMIT ?", (limit,)).fetchall()
            return [r["id"] for r in rows]
        except Exception:            # noqa: BLE001 —— 指标不能因为这张表出问题就 500
            return []

    def stats(self) -> dict:
        c = self._conn()
        by_status = {(r["status"], r["stage"]): r["n"] for r in c.execute(
            "SELECT status, stage, COUNT(*) n FROM jobs GROUP BY status, stage")}
        total = c.execute("SELECT COUNT(*) n FROM jobs").fetchone()["n"]
        cache = c.execute("SELECT COUNT(*) n, COALESCE(SUM(hits),0) h FROM render_cache").fetchone()
        return {
            "jobs_total": total,
            "by_status": [{"status": k[0], "stage": k[1], "count": v}
                          for k, v in sorted(by_status.items())],
            "cache_entries": cache["n"],
            "cache_hits": cache["h"],
            "tenants": c.execute("SELECT COUNT(*) n FROM tenants").fetchone()["n"],
        }

    def gc_assets(self, older_than_s: float = 30 * 86400, *,
                  dry_run: bool = True) -> dict:
        """清理「没有任何任务引用」的素材。

        只删孤儿：上传了却没进过任何 IR 的文件（校验失败、试探性上传、被替换的版本）。
        被任何任务引用过的都不动 —— 删了会让 replay 直接 E_MEDIA_MISSING，
        而 replay 是客户侧可观察的运维动作。
        """
        cutoff = self.db_now() - older_than_s
        contains = self.SQL_CONTAINS.format(a="j.ir_json", b="a.sha")
        rows = self._conn().execute(
            "SELECT a.sha, a.path, a.bytes FROM assets a "
            "WHERE a.last_seen < ? AND a.sha NOT LIKE ? "
            f"  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE {contains})",
            (cutoff, "legacy:%")).fetchall()
        removed, freed = [], 0
        for r in rows:
            freed += int(r["bytes"] or 0)
            removed.append(r["path"] or r["sha"])
            if dry_run:
                continue
            if r["path"]:
                try:
                    Path(r["path"]).unlink()
                except OSError:
                    pass
            with self.tx() as c:
                c.execute("DELETE FROM asset_refs WHERE sha=?", (r["sha"],))
                c.execute("DELETE FROM assets WHERE sha=?", (r["sha"],))
        return {"dry_run": dry_run, "candidates": len(rows), "bytes": freed,
                "sample": removed[:10],
                "note": "只回收无任务引用的孤儿素材；被引用过的请用 DELETE /v1/assets/{id}"}

    def gc(self, older_than_s: float = 7 * 86400, *, dry_run: bool = True) -> dict:
        """清理过期产物。默认 dry-run —— 删除是不可逆操作，不自动执行。"""
        cutoff = self.db_now() - older_than_s
        rows = self._conn().execute(
            "SELECT id, output_path, receipt_path FROM jobs "
            "WHERE status IN ('succeeded','failed','cancelled') AND finished_at < ?",
            (cutoff,)).fetchall()
        freed = 0
        removed = []
        for r in rows:
            for p in (r["output_path"], r["receipt_path"]):
                if p and Path(p).exists():
                    freed += Path(p).stat().st_size
                    removed.append(p)
                    if not dry_run:
                        try:
                            Path(p).unlink()
                        except OSError:
                            pass
        # 归一化中间片是内容寻址共享产物，可能被多个 job 引用 —— 只报告占用，
        # 不自动删。要删必须做引用计数，否则会静默破坏别的任务的缓存。
        mezz_dir = self.db_path.parent / "mezz"
        mezz = [p for p in mezz_dir.glob("*.mp4")] if mezz_dir.exists() else []
        # 限流桶只保留最近一小时：永久累积会让 rate_hit 的索引膨胀
        tokens = 0
        if not dry_run:
            with self.tx() as c:
                tokens = c.execute("DELETE FROM rate_window WHERE bucket < ?",
                                   (int(self.db_now()) - 3600,)).rowcount
        return {"dry_run": dry_run, "jobs": len(rows), "files": len(removed),
                "bytes": freed, "sample": removed[:10],
                "mezz_files": len(mezz),
                "mezz_bytes": sum(p.stat().st_size for p in mezz),
                "rate_buckets_pruned": tokens,
                "mezz_note": "归一化中间片仅报告占用，不自动删除（共享引用）"}


# ---------------------------------------------------------------------------
# 后端工厂：SQLite 仍是默认，PG 由环境变量切换。
# 之所以做成工厂而不是改测试：80 个用例、21 条语料、51 项对抗必须能在
# 两套后端上跑同一份代码，否则「支持 PG」只是文档里的一句话。
# ---------------------------------------------------------------------------
def Store(db_path: Path | str | None = None, *, dsn: str | None = None,
          data_dir: Path | str | None = None):
    """返回 SqliteStore 或 PostgresStore。

    RENDERD_DB_DSN 存在 → PG；否则 SQLite（零依赖，本地/单机默认）。
    RENDERD_PG_SCHEMA 显式指定时所有进程共用该 schema（生产 api+worker）；
    未指定则每个实例自动隔离，避免同一套 unittest 互相污染。
    """
    import os
    dsn = dsn or os.environ.get("RENDERD_DB_DSN")
    path = Path(db_path) if db_path is not None else Path("var/renderd.sqlite3")
    if dsn:
        from .store_pg import PostgresStore
        return PostgresStore(dsn, data_dir=Path(data_dir) if data_dir else path.parent)
    return SqliteStore(path)
