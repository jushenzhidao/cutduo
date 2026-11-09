"""测试公共设施。"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("RENDERD_ALLOW_ANON", "1")
os.environ.setdefault("RENDERD_TOKENS", "testtoken:acme")

from renderd.config import load_config          # noqa: E402
from renderd.fixtures import ensure_media       # noqa: E402
from renderd.service import Service             # noqa: E402

_MEDIA_CACHE: dict[str, dict[str, str]] = {}


class Sandbox:
    """每个用例一个独立数据目录，避免互相污染。"""

    def __init__(self, name: str = "t"):
        self.dir = Path(tempfile.mkdtemp(prefix=f"renderd-{name}-"))
        self.cfg = load_config(self.dir)
        self.service = Service(self.cfg)
        self.service.ensure_tenant("acme", monthly_minutes=10_000)
        key = str(self.cfg.media_dir)
        if key not in _MEDIA_CACHE:
            _MEDIA_CACHE[key] = ensure_media(self.cfg.media_dir)
        self.media = _MEDIA_CACHE[key]
        self.acme = "acme"

    def uri(self, name: str) -> str:
        return "file://" + self.media[name]

    def assets(self, *names: str) -> list[dict]:
        return [{"id": f"a{i}", "uri": self.uri(n)} for i, n in enumerate(names)]

    def submit(self, payload: dict, tenant: str | None = None) -> dict:
        payload.setdefault("idempotency_key", f"test-{os.urandom(6).hex()}")
        return self.service.submit(payload, tenant or self.acme)

    def run_one(self) -> None:
        from renderd.worker import Worker
        Worker(self.cfg, self.service.store, self.service.runner,
               name="w-test").run_once()

    def render(self, payload: dict) -> dict:
        out = self.submit(payload)
        self.run_one()
        return self.service.store.get(out["job_id"])

    def cleanup(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def minimal_ir(**over) -> dict:
    ir = {
        "ir_version": "0.1",
        "id": "unit_case",
        "output": {
            "width": 320, "height": 480,
            "fps": {"num": 30, "den": 1},
            "duration_frames": 60,
            "video": {"codec": "h264", "bitrate_kbps": 1500, "pix_fmt": "yuv420p"},
            "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2},
            "color": {"primaries": "bt709", "transfer": "bt709",
                      "matrix": "bt709", "range": "tv"},
        },
        "styles": {"s": {"font_family": "Hiragino Sans GB", "font_size": 40,
                         "fill": "#FFFFFF"}},
        "assets": [{"id": "a0", "uri": "file:///nonexistent.mp4"}],
        "tracks": [
            {"id": "v1", "kind": "video",
             "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 60}]},
        ],
    }
    ir.update(over)
    return ir
