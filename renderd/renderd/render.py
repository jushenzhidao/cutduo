"""渲染执行器：起子进程、读进度、超时杀进程组、收敛 stderr。

为什么单起一个模块：渲染是整个服务里唯一「不可预测耗时、会挂死、会吃满 IO」的环节，
它必须有自己的超时、自己的进程组、自己的进度通道。
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class RenderResult:
    ok: bool
    exit_code: int
    elapsed_s: float
    frames_done: int = 0
    stderr_tail: str = ""
    timed_out: bool = False
    killed: bool = False
    progress_points: list[tuple[float, int]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "exit_code": self.exit_code,
            "elapsed_s": round(self.elapsed_s, 3),
            "frames_done": self.frames_done,
            "timed_out": self.timed_out,
            "killed": self.killed,
            "stderr_tail": self.stderr_tail[-1500:],
        }


def _parse_progress(line: str) -> tuple[int | None, int | None]:
    """返回 (frame, out_time_us)。ffmpeg 的 -progress 输出是 key=value 行。"""
    if "=" not in line:
        return None, None
    k, _, v = line.partition("=")
    k, v = k.strip(), v.strip()
    try:
        if k == "frame":
            return int(v), None
        if k == "out_time_us":
            return None, int(v)
        if k == "out_time_ms":            # 历史字段，单位其实是微秒
            return None, int(v)
    except ValueError:
        pass
    return None, None


def run(argv: list[str], *, timeout: float, cwd: Path | None = None,
        expected_frames: int | None = None,
        on_progress: Callable[[int, float], None] | None = None) -> RenderResult:
    started = time.time()
    err_tail: deque[str] = deque(maxlen=400)
    frames = 0
    points: list[tuple[float, int]] = []

    proc = subprocess.Popen(
        argv, cwd=str(cwd) if cwd else None,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, start_new_session=True,
    )

    def pump_stdout() -> None:
        nonlocal frames
        assert proc.stdout is not None
        for line in proc.stdout:
            f, _us = _parse_progress(line)
            if f is not None and f != frames:
                frames = f
                elapsed = time.time() - started
                points.append((round(elapsed, 2), f))
                if on_progress:
                    try:
                        on_progress(f, elapsed)
                    except Exception:
                        pass

    def pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            err_tail.append(line.rstrip())

    t_out = threading.Thread(target=pump_stdout, daemon=True)
    t_err = threading.Thread(target=pump_stderr, daemon=True)
    t_out.start()
    t_err.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_group(proc)
        proc.wait(timeout=15)

    t_out.join(timeout=5)
    t_err.join(timeout=5)
    # pump 线程读完后显式关管道：只靠 Popen 对象 GC 会留下
    # TextIOWrapper 的 ResourceWarning 与两个悬挂 pipe fd。
    for stream in (proc.stdout, proc.stderr):
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass
    elapsed = time.time() - started
    tail = "\n".join(err_tail)

    return RenderResult(
        ok=(proc.returncode == 0 and not timed_out),
        exit_code=proc.returncode or 0,
        elapsed_s=elapsed,
        frames_done=frames,
        stderr_tail=tail,
        timed_out=timed_out,
        killed=proc.returncode in (-9, 137),
        progress_points=points,
    )


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    deadline = time.time() + 5
    while time.time() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def ffmpeg_version(ffmpeg: str = "ffmpeg") -> str:
    try:
        p = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, timeout=20)
        first = (p.stdout or "").splitlines()[0]
        return first.split("Copyright")[0].strip()
    except Exception:
        return "unknown"


def probe_json(ffprobe: str, path: str | Path) -> dict:
    import json
    p = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    try:
        return json.loads(p.stdout or "{}")
    except Exception:
        return {}
