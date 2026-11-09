#!/usr/bin/env python3
"""多 worker 并发测试：不双领、不重复渲染、幂等键在并发下仍唯一。

起 1 个 API（0 worker）+ 3 个独立 worker 进程，6 个线程并发提交 12 条任务，
然后校验：
  · 12 条全部 succeeded
  · 每条任务只有 1 次 rendering 事件（没有双领导致的重复渲染）
  · attempts 全为 1
  · 同一批幂等键再并发提交 12 次 → 仍是那 12 个 job，且全部 replay=true
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DATA = ROOT / "var" / "multi"
TOKEN = "mtok-00000001"
PASS = FAIL = 0


def chk(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(base: str, path: str, method: str = "GET", body=None,
         raw: bytes | None = None, headers: dict | None = None, timeout=60):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(base + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def main() -> int:
    import shutil
    if DATA.exists():
        shutil.rmtree(DATA)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "RENDERD_DATA_DIR": str(DATA),
           "RENDERD_TOKENS": f"{TOKEN}:acme", "RENDERD_SECRET": "multi-secret",
           "RENDERD_QUOTA_QPS": "500", "RENDERD_LEASE_S": "30"}

    api = subprocess.Popen([sys.executable, "-m", "renderd", "--data-dir", str(DATA),
                            "serve", "--port", str(port), "--workers", "0"],
                           cwd=str(ROOT), env=env,
                           stdout=open("/tmp/multi_api.log", "w"), stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/healthz", timeout=1).read()
            break
        except Exception:
            time.sleep(0.2)

    workers = []
    for i in range(3):
        workers.append(subprocess.Popen(
            [sys.executable, "-m", "renderd", "--data-dir", str(DATA),
             "worker", "--tenant", "acme", "--name", f"mw{i}"],
            cwd=str(ROOT), env=env,
            stdout=open(f"/tmp/multi_w{i}.log", "w"), stderr=subprocess.STDOUT))
    time.sleep(1.5)

    try:
        # 素材
        clip = Path("/tmp/_multi_clip.mp4")
        if not clip.exists():
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                            "-i", "testsrc2=s=540x960:r=30:d=12",
                            "-c:v", "libx264", "-preset", "ultrafast",
                            "-pix_fmt", "yuv420p", str(clip)], check=True)
        code, up = http(base, "/v1/assets", "POST", raw=clip.read_bytes(),
                        headers={"X-Filename": "c.mp4",
                                 "Content-Type": "application/octet-stream"})
        chk("上传素材", code == 201, str(code))
        uri = up["uri"]

        N = 12
        keys = [f"multi-{int(time.time())}-{i}" for i in range(N)]
        ids: dict[str, str] = {}
        lock = threading.Lock()
        errors: list[str] = []

        def submit(i: int) -> None:
            body = {"template_id": "hook_vertical_6s",
                    "variables": {"clip": "a1", "hook": f"并发{i}"},
                    "assets": [{"id": "a1", "uri": uri}],
                    "idempotency_key": keys[i]}
            c, b = http(base, "/v1/render", "POST", body)
            with lock:
                if c in (200, 202) and b.get("job_id"):
                    ids[keys[i]] = b["job_id"]
                else:
                    errors.append(f"{c} {b}")

        threads = [threading.Thread(target=submit, args=(i,)) for i in range(N)]
        t0 = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        chk(f"{N} 条并发提交无错误", not errors, str(errors[:2]))
        chk("拿到 12 个不同 job", len(set(ids.values())) == N, f"{len(set(ids.values()))}")

        # 同一批幂等键再并发提交一次
        replay_ok = []

        def resubmit(i: int) -> None:
            body = {"template_id": "hook_vertical_6s",
                    "variables": {"clip": "a1", "hook": f"并发{i}"},
                    "assets": [{"id": "a1", "uri": uri}],
                    "idempotency_key": keys[i]}
            c, b = http(base, "/v1/render", "POST", body)
            with lock:
                replay_ok.append(b.get("job_id") == ids.get(keys[i])
                                 and b.get("idempotent_replay") is True)

        threads = [threading.Thread(target=resubmit, args=(i,)) for i in range(N)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        chk("并发重放全部命中同一 job", all(replay_ok) and len(replay_ok) == N,
            f"{sum(replay_ok)}/{len(replay_ok)}")

        # 等全部完成
        deadline = time.time() + 180
        while time.time() < deadline:
            states = [http(base, f"/v1/jobs/{j}")[1].get("status") for j in ids.values()]
            if all(s in ("succeeded", "failed") for s in states):
                break
            time.sleep(1)
        ok_n = sum(1 for s in states if s == "succeeded")
        print(f"  耗时 {time.time() - t0:.1f}s，成功 {ok_n}/{N}")
        chk("12 条全部成功", ok_n == N, f"{ok_n}/{N}")

        # 不双领：每条只有一次 rendering 事件、attempts=1
        dup = []
        for j in ids.values():
            st = http(base, f"/v1/jobs/{j}")[1]
            ev = http(base, f"/v1/jobs/{j}/events")[1]["events"]
            renders = sum(1 for e in ev if e["stage"] == "rendering"
                          and "开始渲染" in (e.get("message") or ""))
            if renders != 1 or st["attempts"] != 1:
                dup.append((j, renders, st["attempts"]))
        chk("无重复渲染（每条恰好 1 次 rendering，attempts=1）", not dup, str(dup[:3]))

        # 日志里不应出现 requeue
        logs = Path("/tmp/multi_api.log").read_text(errors="ignore")
        chk("无租约回收发生", "requeued" not in logs,
            [l for l in logs.splitlines() if "requeued" in l][:2])

    finally:
        for w in workers:
            w.terminate()
        api.terminate()
        for p in workers + [api]:
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()

    print(f"\n通过 {PASS} / 失败 {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
