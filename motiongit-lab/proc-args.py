#!/usr/bin/env python3
"""抓取系统中匹配关键字的进程完整 argv（macOS，走 sysctl KERN_PROCARGS2，不依赖 ps）。
用法: python3 proc-args.py <关键字> [持续秒数]
"""
import ctypes
import ctypes.util
import sys
import time

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
CTL_KERN = 1
KERN_PROCARGS2 = 49
MAX = 4096 * 8


def argv_of(pid):
    mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
    buf = ctypes.create_string_buffer(MAX)
    size = ctypes.c_size_t(MAX)
    rc = libc.sysctl(mib, 3, buf, ctypes.byref(size), None, ctypes.c_size_t(0))
    if rc != 0 or size.value < 8:
        return None
    raw = buf.raw[: size.value]
    argc = int.from_bytes(raw[:4], sys.byteorder, signed=True)
    body = raw[4:]
    parts = body.split(b"\x00")
    out = []
    for p in parts:
        if not p:
            if out:
                break
            continue
        try:
            out.append(p.decode("utf-8", "replace"))
        except Exception:
            pass
        if len(out) >= argc:
            break
    return out or None


def all_pids():
    mib = (ctypes.c_int * 4)(CTL_KERN, 6, 1, 0)  # KERN_PROC_ALL
    libc.sysctl.restype = ctypes.c_int
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 4, None, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        return []
    buf = ctypes.create_string_buffer(size.value * 2)
    if libc.sysctl(mib, 4, buf, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        return []
    # struct kinfo_proc 固定 648 字节（64 位），首个 int 为 pid
    stride, pids = 648, []
    for off in range(0, size.value - stride, stride):
        pid = int.from_bytes(buf.raw[off + 40: off + 44], sys.byteorder, signed=True)
        if pid > 0:
            pids.append(pid)
    return pids


def main():
    kw = sys.argv[1] if len(sys.argv) > 1 else "pip"
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    seen, end = set(), time.time() + secs
    while time.time() < end:
        for pid in all_pids():
            args = argv_of(pid)
            if not args:
                continue
            line = " ".join(args)
            if kw in line and line not in seen:
                seen.add(line)
                print(f"[{pid}] {line[:1500]}", flush=True)
        time.sleep(0.15)
    if not seen:
        print(f"(未捕获到含 '{kw}' 的进程)", flush=True)


if __name__ == "__main__":
    main()
