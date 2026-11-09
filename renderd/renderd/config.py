"""集中配置。所有可调项走环境变量，带 RENDERD_ 前缀。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(f"RENDERD_{name}", default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(f"RENDERD_{name}", default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(f"RENDERD_{name}", default))
    except (TypeError, ValueError):
        return default


FONT_SEARCH_DIRS = [
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    "/usr/share/fonts",
    "/usr/share/fonts/truetype",
    "/usr/share/fonts/opentype",
    str(Path.home() / "Library/Fonts"),
]


@dataclass
class Target:
    """canonical 中间片规格。改这里等于改产品契约，不要在别处散落常量。"""

    long_edge: int = 1920
    fps: int = 30
    pix_fmt: str = "yuv420p"
    sample_rate: int = 48000
    channels: int = 2
    crf: int = 16
    preset: str = "veryfast"
    gop: int = 60


@dataclass
class Config:
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "var")))
    api_host: str = field(default_factory=lambda: _env("HOST", "127.0.0.1"))
    api_port: int = field(default_factory=lambda: _env_int("PORT", 8787))
    api_token: str = field(default_factory=lambda: _env("TOKEN", ""))
    public_base_url: str = field(default_factory=lambda: _env("PUBLIC_BASE_URL", ""))

    worker_concurrency: int = field(default_factory=lambda: _env_int("WORKER_CONCURRENCY", 2))
    lease_s: float = field(default_factory=lambda: _env_float("LEASE_S", 120))
    job_timeout_s: float = field(default_factory=lambda: _env_float("JOB_TIMEOUT_S", 1800))
    render_timeout_s: float = field(default_factory=lambda: _env_float("RENDER_TIMEOUT_S", 1500))
    max_attempts: int = field(default_factory=lambda: _env_int("MAX_ATTEMPTS", 3))

    ffmpeg: str = field(default_factory=lambda: _env("FFMPEG", "ffmpeg"))
    ffprobe: str = field(default_factory=lambda: _env("FFPROBE", "ffprobe"))
    # MLT 后端（可选）：默认镜像不带 melt，装了才可用
    melt: str = field(default_factory=lambda: _env("MELT", "melt"))

    target: Target = field(default_factory=Target)

    # 租户默认配额：每月渲染分钟数、每秒请求数
    default_monthly_minutes: int = field(default_factory=lambda: _env_int("QUOTA_MINUTES", 1000))
    default_qps: int = field(default_factory=lambda: _env_int("QUOTA_QPS", 10))

    max_upload_mb: int = field(default_factory=lambda: _env_int("MAX_UPLOAD_MB", 512))
    max_json_mb: int = field(default_factory=lambda: _env_int("MAX_JSON_MB", 4))
    max_output_seconds: float = field(
        default_factory=lambda: _env_float("MAX_OUTPUT_SECONDS", 600))
    max_assets: int = field(default_factory=lambda: _env_int("MAX_ASSETS", 64))
    # 单帧解码像素上限：防「1MB 的 16K 视频」把解码器打爆
    max_decoded_pixels: int = field(
        default_factory=lambda: _env_int("MAX_DECODED_PIXELS", 4096 * 4096))
    max_clips_per_track: int = field(
        default_factory=lambda: _env_int("MAX_CLIPS_PER_TRACK", 512))
    max_text_chars: int = field(default_factory=lambda: _env_int("MAX_TEXT_CHARS", 4000))
    # ── 输入归一化 ──
    ingest_normalize: bool = field(
        default_factory=lambda: os.environ.get("RENDERD_INGEST_NORMALIZE", "1") not in ("0", "false"))
    ingest_cropdetect: bool = field(
        default_factory=lambda: os.environ.get("RENDERD_INGEST_CROPDETECT", "1") not in ("0", "false"))
    max_asset_seconds: float = field(
        default_factory=lambda: _env_float("MAX_ASSET_SECONDS", 3600))
    # ── 队列背压与重试 ──
    max_queue_depth: int = field(
        default_factory=lambda: _env_int("MAX_QUEUE_DEPTH", 2000))
    max_tenant_inflight: int = field(
        default_factory=lambda: _env_int("MAX_TENANT_INFLIGHT", 8))
    retry_backoff_base_s: float = field(
        default_factory=lambda: _env_float("RETRY_BACKOFF_BASE_S", 1.0))
    # ── 存储配额 ──
    default_storage_mb: int = field(
        default_factory=lambda: _env_int("STORAGE_QUOTA_MB", 2048))
    asset_retention_days: int = field(
        default_factory=lambda: _env_int("ASSET_RETENTION_DAYS", 30))
    # ── 鉴权 ──
    # 认证失败的限速：按客户端 IP 计，默认 10 次/秒。合法客户端不该连续失败；
    # 没有这一层，错 token 的洪水不受任何约束（限流原本在鉴权之后）。
    # 阈值不能太小：NAT 后面可能有正常客户与错配置的客户端共用出口 IP，
    # 设成 2 会误伤；10 对 64 hex 的 token 暴破仍然毫无意义。
    auth_fail_qps: int = field(
        default_factory=lambda: _env_int("AUTH_FAIL_QPS", 10))
    # ── 运维 ──
    # 就绪探针的磁盘闸：低于这个值不再接新任务。渲染是「素材进、成片出」，
    # 磁盘写满时 ffmpeg 会在写到一半失败，比直接拒单难排查得多。
    min_free_gb: float = field(
        default_factory=lambda: _env_float("MIN_FREE_GB", 5.0))
    metrics_allow_cidrs: str = field(default_factory=lambda: _env(
        "METRICS_CIDRS", "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"))
    tls_cert: str = field(default_factory=lambda: _env("TLS_CERT", ""))
    tls_key: str = field(default_factory=lambda: _env("TLS_KEY", ""))
    # 素材路径：默认只允许 media 目录内的文件。本地开发可放开，生产禁止。
    allow_arbitrary_paths: bool = field(
        default_factory=lambda: os.environ.get("RENDERD_ALLOW_ARBITRARY_PATHS", "") in ("1", "true"))
    # webhook 回调：默认禁止私网/回环/链路本地（防 SSRF 打云元数据）
    allow_private_callbacks: bool = field(
        default_factory=lambda: os.environ.get("RENDERD_ALLOW_PRIVATE_CALLBACKS", "") in ("1", "true"))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "renderd.sqlite3"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def out_dir(self) -> Path:
        return self.data_dir / "out"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @property
    def template_dir(self) -> Path:
        return self.data_dir / "templates"

    @property
    def evidence_dir(self) -> Path:
        return self.data_dir / "evidence"

    @property
    def mezz_dir(self) -> Path:
        return self.data_dir / "mezz"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.media_dir, self.out_dir,
                  self.tmp_dir, self.template_dir, self.evidence_dir,
                  self.mezz_dir):
            d.mkdir(parents=True, exist_ok=True)


def load_config(data_dir: str | Path | None = None) -> Config:
    cfg = Config()
    if data_dir:
        cfg.data_dir = Path(data_dir)
    cfg.ensure_dirs()
    return cfg
