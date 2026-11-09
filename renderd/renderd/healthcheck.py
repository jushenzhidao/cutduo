"""容器健康探针：先判断自己是 api 还是 worker，再给对应的判定。

为什么要按角色分：同一个镜像既要跑 api 也要跑 worker，而 worker 是**拉取式进程**，
不监听任何端口。镜像里若只有一个「打 /healthz」的探针，worker 必然被判成 unhealthy
——实测就是这么发生的：`URLError: Connection refused`，重试三次后容器挂上红标。
这个假警报会污染监控，更糟的是在 `depends_on: service_healthy` 场景下直接卡住启动。

判定原则：
  · api    → 打本地 /healthz，200 才算活（它本来就有 HTTP 面）；
  · worker → 进程在就算活。worker 能不能接到活由数据库和 api 的 /ready 反映，
             在这里再探一次 DB 只会把「DB 抖动」误报成「worker 挂了」。
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

HEALTH_URL = "http://127.0.0.1:8787/healthz"


def role() -> str:
    """从 PID1 的命令行判断角色。容器里 PID1 就是镜像的 CMD。"""
    try:
        cmd = Path("/proc/1/cmdline").read_bytes()
    except OSError:
        return "unknown"
    if b"worker" in cmd:
        return "worker"
    if b"serve" in cmd or b"mcp" in cmd:
        return "api"
    return "unknown"


def main() -> int:
    kind = role()
    if kind == "worker":
        return 0
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=3) as resp:
            return 0 if resp.status == 200 else 1
    except Exception:                                    # noqa: BLE001
        return 1


if __name__ == "__main__":
    sys.exit(main())
