"""Worker：拉取式取任务，一进程一任务，干完确认。

拉取而不是推送的理由：worker 自己来取，天然负载均衡、天然故障转移，
不需要中心调度器知道谁闲着。HTTP 负载均衡对长任务是错误的抽象。
"""

from __future__ import annotations

import signal
import socket
import threading
import time
import uuid

from .config import Config
from .runner import Runner
from .store import Store


def start_reaper(store: Store, cfg: Config, name: str = "reaper"):
    """独立回收线程。

    为什么必须独立于 worker：租约回收原先只写在 Worker.run_forever 里，
    一旦所有 worker 都被 OOM/重启干掉，就没人去扫过期租约了——
    任务会永久停在 running，直到下一个 worker 起来。这是单点故障。
    """
    stop = threading.Event()
    interval = max(5.0, min(30.0, cfg.lease_s / 3.0))

    def loop() -> None:
        while not stop.wait(interval):
            try:
                ids = store.recover_expired()
                if ids:
                    print(f"[{name}] requeued {len(ids)} expired job(s)", flush=True)
            except Exception:
                pass

    t = threading.Thread(target=loop, name=name, daemon=True)
    t.start()
    return t, stop


class Worker:
    def __init__(self, cfg: Config, store: Store, runner: Runner,
                 name: str | None = None):
        self.cfg = cfg
        self.store = store
        self.runner = runner
        self.name = name or f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}"
        self._stop = threading.Event()
        self._jobs_done = 0
        self._recover_every = 20
        self._tick = 0

    def stop(self) -> None:
        self._stop.set()

    def install_signal_handlers(self) -> None:
        def handler(signum, _frame):
            self.stop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, handler)
            except ValueError:      # 非主线程
                pass

    def run_once(self) -> bool:
        """取一条并跑完。返回是否有活干。"""
        job = self.store.claim(self.name, self.cfg.lease_s)
        if not job:
            return False
        try:
            self.runner.execute(job, worker=self.name)
        finally:
            self._jobs_done += 1
        return True

    def run_forever(self, poll_s: float = 0.5, max_jobs: int | None = None) -> int:
        self.install_signal_handlers()
        while not self._stop.is_set():
            self._tick += 1
            if self._tick % self._recover_every == 1:
                try:
                    self.store.recover_expired()
                except Exception:
                    pass
            if max_jobs is not None and self._jobs_done >= max_jobs:
                break
            try:
                busy = self.run_once()
            except Exception:
                busy = False
                time.sleep(1.0)
            if not busy:
                self._stop.wait(poll_s)
        return self._jobs_done
