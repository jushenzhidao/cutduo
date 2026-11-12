#!/usr/bin/env python3
"""采样进程树的 RSS 峰值（macOS libproc，不依赖 ps 命令）。

用法: python3 mem-monitor.py --pid <pid> [--interval 0.12] [--timeout 300]
输出: PEAK_RSS_MB=... MAX_PROCS=... AT=...s
"""
import argparse
import ctypes
import os
import time

libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
PROC_ALL_PIDS = 1
PROC_PIDTBSDINFO = 3
PROC_PIDTASKINFO = 4
libproc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
libproc.proc_listpids.restype = ctypes.c_int
libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
libproc.proc_pidinfo.restype = ctypes.c_int


def all_pids():
    size = libproc.proc_listpids(PROC_ALL_PIDS, 0, None, 0)
    if size <= 0:
        return []
    buf = ctypes.create_string_buffer(size)
    got = libproc.proc_listpids(PROC_ALL_PIDS, 0, buf, size)
    n = got // ctypes.sizeof(ctypes.c_int)
    arr = ctypes.cast(buf, ctypes.POINTER(ctypes.c_int * n)).contents
    return [p for p in arr if p > 0]


def info(pid):
    b = ctypes.create_string_buffer(256)
    ppid = 0
    if libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, b, 256) > 0:
        ppid = ctypes.c_uint32.from_buffer(b, 16).value
    t = ctypes.create_string_buffer(256)
    rss = 0
    if libproc.proc_pidinfo(pid, PROC_PIDTASKINFO, 0, t, 256) > 0:
        rss = ctypes.c_uint64.from_buffer(t, 8).value
    return ppid, rss


def snapshot(root):
    rows = []
    for pid in all_pids():
        ppid, rss = info(pid)
        if rss:
            rows.append((pid, ppid, rss))
    children = {}
    for pid, ppid, _ in rows:
        children.setdefault(ppid, []).append(pid)
    rss_map = {pid: rss for pid, _, rss in rows}
    stack, seen, total = [root], set(), 0
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        total += rss_map.get(pid, 0)
        stack.extend(children.get(pid, []))
    return total / (1024 * 1024), len(seen)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--interval", type=float, default=0.12)
    ap.add_argument("--timeout", type=float, default=300)
    a = ap.parse_args()

    start = time.time()
    peak = peak_n = 0
    peak_t = 0.0
    while time.time() - start < a.timeout:
        try:
            os.kill(a.pid, 0)
        except OSError:
            break
        rss, n = snapshot(a.pid)
        if rss > peak:
            peak, peak_n, peak_t = rss, n, time.time() - start
        time.sleep(a.interval)
    print(f"PEAK_RSS_MB={peak:.0f} MAX_PROCS={peak_n} AT={peak_t:.2f}s")


if __name__ == "__main__":
    main()
