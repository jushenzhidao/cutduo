#!/usr/bin/env python3
"""MCP 服务压测（开环 rps / 并发突刺 / 真实渲染吞吐）。

在**服务所在的机器上**跑，直连 127.0.0.1:<port>，避免把公网往返算进服务延迟。

    TOK=<tenant token> JOBID=<任一已完成任务> ASSET=upload:<文件名> \
      python3 tests/stress_mcp.py --phase ab
    TOK=... ASSET=... python3 tests/stress_mcp.py --phase c --k 8

三段：
  A 开环固定 rps —— 找吞吐上限与延迟曲线（关键是「从哪一档开始出现 429」）
  B 闭环并发突刺 —— 探线程/连接的行为边界（关心的是有没有 5xx 与超时）
  C 真实渲染吞吐 —— 提交 N 个任务并轮询到终态，量排队与串行吞吐

**止损只看我们自己的资源**：宿主 load 由同机 20+ 个业务决定，用绝对值判定会一直误报
（实测这台机器基线 load 就在 60–74 之间）。因此只监控 api 容器的 cgroup CPU：
超过 195%（配额 200%）或可用内存 < 8 GB 才停。出现 5xx 也会停 —— 那是真故障，不是过载。
"""
import argparse, json, os, threading, time
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

TOK = os.environ["TOK"]
APP = "http://127.0.0.1:39340"
JOB = os.environ.get("JOBID", "")
ASSET = os.environ.get("ASSET", "")
STOP = threading.Event()
MON = []


def post(path, body, timeout=60):
    req = urllib.request.Request(
        APP + path, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
            return (time.perf_counter() - t0) * 1000, r.status, payload
    except urllib.error.HTTPError as e:
        e.read()
        return (time.perf_counter() - t0) * 1000, e.code, b""
    except Exception as e:
        return (time.perf_counter() - t0) * 1000, type(e).__name__, b""


def mcp(method, params=None, timeout=60):
    ms, code, body = post("/mcp", {"jsonrpc": "2.0", "id": 1,
                                   "method": method, "params": params or {}}, timeout)
    return ms, code, body


BASE = float(os.environ.get("BASE_LOAD", "0") or 0)
API_CGROUP = os.environ.get("API_CGROUP", "")
PEAK = {"api_cpu": 0.0}


def _api_cpu_pct():
    """读 api 容器 cgroup 的累计 CPU 时间，换算成占单核的百分比。"""
    if not API_CGROUP:
        return 0.0
    try:
        for line in open(API_CGROUP + "/cpu.stat"):
            if line.startswith("usage_usec"):
                return int(line.split()[1]) / 1e6
    except Exception:
        pass
    return 0.0


def monitor(interval=2.0):
    """止损只看我们自己的资源：宿主 load 由 20+ 个邻居决定，用它判定会一直误报。"""
    prev, prev_t = _api_cpu_pct(), time.time()
    global MON
    while not STOP.is_set():
        try:
            now = time.time()
            cpu = _api_cpu_pct()
            dt = now - prev_t
            pct_cpu = (cpu - prev) / dt * 100 if dt > 0 and cpu >= prev else 0.0
            prev, prev_t = cpu, now
            PEAK["api_cpu"] = max(PEAK["api_cpu"], pct_cpu)
            load1 = float(open("/proc/loadavg").read().split()[0])
            mem = int([l for l in open("/proc/meminfo")
                       if l.startswith("MemAvailable")][0].split()[1]) // 1024
            MON.append((load1, mem, pct_cpu))
            # 只在「我们自己把 2 核打满超过 6 秒」或内存见底时停
            if pct_cpu > 195 or mem < 8192:
                STOP.set()
        except Exception:
            pass
        time.sleep(interval)


def pct(a, q):
    a = sorted(a)
    return a[min(len(a) - 1, int(len(a) * q))] if a else 0


def phase_a(targets=(2, 5, 8, 10, 12), dur=20.0):
    print(f"\n=== A. 开环固定 rps（20s/档，MCP 读写 7:3）===")
    print(f"{'目标':>5}{'实际':>7}{'完成':>6}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>9}{'200':>6}{'429':>6}{'其他':>6}")
    for target in targets:
        if STOP.is_set():
            print("  触发止损，停止")
            break
        lat, codes, lock = [], {}, threading.Lock()
        pool = ThreadPoolExecutor(max_workers=128)
        futs = []
        t_end = time.time() + dur
        next_t = time.time()
        n = 0

        def fire(i):
            if i % 10 < 7:
                ms, code, _ = mcp("tools/list")
            else:
                ms, code, _ = mcp("tools/call", {"name": "get_job_status",
                                                 "arguments": {"job_id": JOB}})
            if isinstance(code, int) and code >= 500:
                STOP.set()
            with lock:
                lat.append(ms)
                codes[code] = codes.get(code, 0) + 1

        while time.time() < t_end:
            now = time.time()
            if now < next_t:
                time.sleep(min(0.004, next_t - now))
                continue
            next_t += 1.0 / target
            n += 1
            futs.append(pool.submit(fire, n))
        for f in futs:
            f.result()
        pool.shutdown(wait=True)
        other = {k: v for k, v in codes.items() if k not in (200, 429)}
        print(f"{target:>5}{n/dur:>7.1f}{codes.get(200,0):>6}{pct(lat,.5):>8.0f}ms"
              f"{pct(lat,.95):>7.0f}ms{pct(lat,.99):>7.0f}ms{max(lat):>8.0f}ms"
              f"{codes.get(200,0):>6}{codes.get(429,0):>6}{sum(other.values()):>6}")
        if other:
            print("   非 429/200:", other)
        time.sleep(2)


def phase_b(levels=(30, 60, 100)):
    print(f"\n=== B. 闭环并发突刺（tools/list 单轮）===")
    print(f"{'并发':>5}{'墙钟':>10}{'p50':>9}{'p95':>9}{'max':>9}{'成功':>6}{'429':>6}{'其他':>6}")
    for n in levels:
        if STOP.is_set():
            print("  触发止损，停止")
            break
        t0 = time.perf_counter()
        with ThreadPoolExecutor(n) as ex:
            res = list(ex.map(lambda _: mcp("tools/list"), range(n)))
        wall = (time.perf_counter() - t0) * 1000
        lat = [r[0] for r in res]
        codes = {}
        for r in res:
            codes[r[1]] = codes.get(r[1], 0) + 1
        other = {k: v for k, v in codes.items() if k not in (200, 429)}
        print(f"{n:>5}{wall:>9.0f}ms{pct(lat,.5):>8.0f}ms{pct(lat,.95):>7.0f}ms{max(lat):>8.0f}ms"
              f"{codes.get(200,0):>6}{codes.get(429,0):>6}{sum(other.values()):>6}")
        if other:
            print("   其他:", other)
        time.sleep(3)


def phase_c(k=8):
    print(f"\n=== C. 真实渲染吞吐（{k} 个 180 帧任务）===")
    ids, submits = [], []
    for i in range(k):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "submit_render", "arguments": {
                    "idempotency_key": f"loadtest-{int(time.time())}-{i}",
                    "template_id": "hook_vertical_6s",
                    "variables": {"clip": "a1", "hook": f"压测{i}"},
                    "assets": [{"id": "a1", "uri": ASSET}]}}}
        ms, code, payload = post("/mcp", body, timeout=120)
        jid = None
        try:
            txt = json.loads(payload)["result"]["content"][0]["text"]
            jid = json.loads(txt).get("job_id")
        except Exception:
            pass
        submits.append(ms)
        ids.append(jid)
        print(f"  submit #{i+1}: {ms:6.0f}ms  http={code}  {jid}")
        if code != 200 or not jid:
            print("  提交失败，终止")
            return
        time.sleep(0.2)

    t0 = time.time()
    done = {}
    while len(done) < len(ids) and time.time() - t0 < 600:
        for jid in ids:
            if jid in done:
                continue
            ms, code, payload = mcp("tools/call", {"name": "get_job_status",
                                                   "arguments": {"job_id": jid}}, timeout=30)
            if code != 200:
                continue
            try:
                st = json.loads(json.loads(payload)["result"]["content"][0]["text"])
            except Exception:
                continue
            if st.get("status") in ("succeeded", "failed"):
                done[jid] = (time.time() - t0, st.get("status"), st.get("elapsed_s"))
        time.sleep(1.5)
    wall = time.time() - t0
    ok = sum(1 for v in done.values() if v[1] == "succeeded")
    print(f"\n  完成 {len(done)}/{len(ids)}，成功 {ok}，排队到全部结束 {wall:.1f}s")
    print(f"  吞吐 ≈ {len(done)/wall*60:.1f} 任务/分钟（单 worker，串行）")
    for jid, (t, st, el) in list(done.items())[:3]:
        print(f"    {jid}  {st}  {t:.1f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", default="ab")
    ap.add_argument("--k", type=int, default=8)
    a = ap.parse_args()
    threading.Thread(target=monitor, daemon=True).start()
    t0 = time.time()
    try:
        if "a" in a.phase:
            phase_a()
        if "b" in a.phase:
            phase_b()
        if "c" in a.phase:
            phase_c(a.k)
    finally:
        STOP.set()
        time.sleep(0.1)
        if MON:
            loads = [x[0] for x in MON]
            mems = [x[1] for x in MON]
            print(f"\n监测：{len(MON)} 采样  宿主 load1 {min(loads):.1f}–{max(loads):.1f}（邻居主导）"
                  f"  api 容器 CPU 峰值 {PEAK['api_cpu']:.0f}%（配额 200%）"
                  f"  可用内存最低 {min(mems)} MB  {'（触发止损）' if STOP.is_set() else ''}")
        print(f"总耗时 {time.time()-t0:.0f}s")
