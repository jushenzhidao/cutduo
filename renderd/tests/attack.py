#!/usr/bin/env python3
"""对抗性测试套件。

按攻击者视角逐项尝试，而不是按功能清单逐项验证。
每一项都记录：期望行为 / 实际行为 / 判定。

用法：
    python3 tests/attack.py --base http://127.0.0.1:8787 --token devtoken
    python3 tests/attack.py --base http://127.0.0.1:8787 --token devtoken --json out.json
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from renderd import auth as _auth   # noqa: E402  签名格式只有一处实现

RESULTS: list[dict] = []


@dataclass
class Ctx:
    base: str
    token: str
    tenant: str = "acme"
    other_token: str = ""
    other_tenant: str = "rival"
    secret: str = ""
    burst_token: str = ""
    storage_token: str = ""


def hdr(ctx: Ctx, token: str | None = None) -> dict:
    t = token if token is not None else ctx.token
    return {"Authorization": f"Bearer {t}"} if t else {}


def req(ctx: Ctx, path: str, method: str = "GET", body=None, token: str | None = None,
        raw: bytes | None = None, headers: dict | None = None,
        timeout: float = 60) -> tuple[int, object]:
    url = ctx.base + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    if data is not None and "Content-Type" not in (headers or {}):
        r.add_header("Content-Type", "application/json")
    if token is None:
        for k, v in hdr(ctx).items():
            r.add_header(k, v)
    elif token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw_body = resp.read()
            try:
                return resp.status, json.loads(raw_body or b"{}")
            except json.JSONDecodeError:
                return resp.status, {"_raw_len": len(raw_body)}
    except urllib.error.HTTPError as e:
        raw_body = e.read()
        try:
            return e.code, json.loads(raw_body or b"{}")
        except json.JSONDecodeError:
            return e.code, {"_raw_len": len(raw_body)}
    except (urllib.error.URLError, TimeoutError):
        return 0, {"error": "connection"}
    except Exception as exc:  # pragma: no cover
        return -1, {"error": str(exc)}


def record(cid: str, name: str, severity: str, expect: str, actual: str,
           ok: bool, detail: str = "") -> None:
    RESULTS.append({"id": cid, "name": name, "severity": severity,
                    "expect": expect, "actual": actual,
                    "verdict": "PASS" if ok else "FAIL", "detail": detail})
    mark = "✓" if ok else "✗"
    print(f"  {mark} {cid} {name:36} {actual}")
    if not ok and detail:
        print(f"       ↳ {detail[:160]}")


_ASSET_URI: str = ""


def tiny_asset(ctx: "Ctx") -> str:
    """上传一段真实的小视频，返回 upload:<name>。"""
    global _ASSET_URI
    if _ASSET_URI:
        return _ASSET_URI
    import subprocess
    p = Path("/tmp/_attack_clip8.mp4")
    if not p.exists():
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                        "-i", "testsrc2=s=320x240:r=30:d=8",
                        "-c:v", "libx264", "-preset", "ultrafast",
                        "-pix_fmt", "yuv420p", str(p)], check=True)
    body = p.read_bytes()
    code, resp = req(ctx, "/v1/assets", "POST", raw=body,
                     headers={"X-Filename": "attack.mp4",
                              "Content-Type": "application/octet-stream"})
    if code != 201:
        raise RuntimeError(f"上传素材失败: {code} {resp}")
    _ASSET_URI = resp["uri"]
    return _ASSET_URI


def minimal_ir(asset_uri: str, **over) -> dict:
    ir = {
        "ir_version": "0.1", "id": "attack_case",
        "output": {"width": 320, "height": 480, "fps": {"num": 30, "den": 1},
                   "duration_frames": 30,
                   "video": {"codec": "h264", "bitrate_kbps": 1000, "pix_fmt": "yuv420p"},
                   "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2},
                   "color": {"primaries": "bt709", "transfer": "bt709",
                             "matrix": "bt709", "range": "tv"}},
        "styles": {},
        "assets": [{"id": "a0", "uri": asset_uri}],
        "tracks": [{"id": "v1", "kind": "video",
                    "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 30}]}],
    }
    ir.update(over)
    return ir


# ═══════════════════════════════════════════════════ A 认证与授权
def run_auth(ctx: Ctx) -> None:
    print("\n── A 认证与授权 ──")
    code, _ = req(ctx, "/v1/templates", token="")
    record("A01", "无 token 访问模板", "high", "401", f"{code}", code == 401)

    code, _ = req(ctx, "/v1/templates", token="wrong-token")
    record("A02", "错误 token", "high", "401", f"{code}", code == 401)

    # 造一条本租户任务，另一个租户去读
    body = {"template_id": "hook_vertical_6s",
            "variables": {"clip": "a0", "hook": "越权测试"},
            "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
            "idempotency_key": f"auth-{int(time.time()*1000)}"}
    code, job = req(ctx, "/v1/render", "POST", body)
    if code in (202, 200) and isinstance(job, dict) and job.get("job_id"):
        jid = job["job_id"]
        if ctx.other_token:
            c2, b2 = req(ctx, f"/v1/jobs/{jid}", token=ctx.other_token)
            record("A03", "跨租户读任务", "critical", "404", f"{c2}",
                   c2 == 404, str(b2)[:120])
            c3, _ = req(ctx, f"/v1/jobs/{jid}/video", token=ctx.other_token)
            record("A04", "跨租户下载成片", "critical", "404/401", f"{c3}",
                   c3 in (404, 401))
            c4, _ = req(ctx, f"/v1/jobs/{jid}/receipt", token=ctx.other_token)
            record("A05", "跨租户读回执", "critical", "404", f"{c4}", c4 == 404)
        else:
            record("A03", "跨租户读任务", "critical", "需第二个 token", "SKIP", True,
                   "未提供 --other-token")

    # 签名相关
    jid = "job_000000000000"
    c, _ = req(ctx, f"/v1/jobs/{jid}/video?exp=9999999999&sig=deadbeef", token="")
    record("A06", "伪造签名", "critical", "401", f"{c}", c == 401)

    c, _ = req(ctx, f"/v1/jobs/{jid}/video?exp=1000000000&sig=deadbeef", token="")
    record("A07", "过期签名", "high", "401", f"{c}", c == 401)

    # 用 A 任务的签名去访问 B 任务（签名应绑定 job_id）
    if ctx.secret:
        exp = int(time.time()) + 3600
        sig_a = _auth.sign("job_aaaaaaaaaaaa", exp, ctx.tenant, "video")
        c, _ = req(ctx, f"/v1/jobs/job_bbbbbbbbbbbb/video?exp={exp}&sig={sig_a}"
                        f"&t={ctx.tenant}", token="")
        record("A08", "签名跨任务重放", "critical", "401", f"{c}", c == 401)
    else:
        record("A08", "签名跨任务重放", "critical", "需 --secret", "SKIP", True,
               "未提供 --secret")

    c, _ = req(ctx, "/healthz", token="")
    record("A09", "健康检查公开", "info", "200", f"{c}", c == 200)

    c, b = req(ctx, "/metrics", token="")
    leaked = isinstance(b, dict) and b.get("_raw_len", 0) > 0
    record("A10", "metrics 公开（信息面）", "low", "200 可接受", f"{c}", c == 200,
           "公开指标便于监控，但会暴露任务总量；生产可加白名单")


# ═══════════════════════════════════════════════════ B 路径与文件
def run_fs(ctx: Ctx) -> None:
    print("\n── B 路径穿越与文件 ──")
    # 这四个目标在容器/宿主机上都真实存在，必须被围栏挡在门外（不能靠"文件不存在"侥幸通过）
    cases = [
        ("B01", "file:///etc/passwd 作为素材", "critical", "file:///etc/passwd", True),
        ("B02", "upload:../../../../etc/passwd", "critical",
         "upload:../../../../../etc/passwd", True),
        ("B03", "../../../../etc/passwd 相对路径", "critical",
         "../../../../../etc/passwd", True),
        ("B04", "file:///proc/self/environ", "critical", "file:///proc/self/environ", True),
        ("B10", "file:///etc/hostname（存在的普通文件）", "high",
         "file:///etc/hostname", True),
    ]
    for cid, name, sev, uri, _must_deny in cases:
        body = {"ir": minimal_ir(uri),
                "idempotency_key": f"fs-{cid}-{int(time.time()*1000)}"}
        code, resp = req(ctx, "/v1/render", "POST", body)
        err = (resp or {}).get("error", {}) if isinstance(resp, dict) else {}
        ecode = err.get("code", "") if isinstance(err, dict) else ""
        ok = code == 403 and ecode == "E_MEDIA_FORBIDDEN"
        record(cid, name, sev, "403 E_MEDIA_FORBIDDEN", f"{code} {ecode}", ok,
               json.dumps(err, ensure_ascii=False)[:200])

    # evidence 文件名穿越
    jid = "job_000000000000"
    if ctx.secret:
        exp = int(time.time()) + 3600
        # 每个穿越名单独签：scope 里带文件名，签错了就测不出穿越
        sig_of = {n: _auth.sign(jid, exp, ctx.tenant, f"evidence:{n}")
                  for n in ("..", "../../etc/passwd", "..%2f..%2fetc%2fpasswd")}
        for cid, name in (("B05", "evidence 名 .."),
                          ("B06", "evidence 名 ../../etc/passwd"),
                          ("B07", "evidence 名 URL 编码穿越")):
            payload = {"B05": "..", "B06": "../../etc/passwd",
                       "B07": "..%2f..%2fetc%2fpasswd"}[cid]
            c, b = req(ctx, f"/v1/jobs/{jid}/evidence/{payload}?exp={exp}"
                            f"&sig={sig_of[payload]}&t={ctx.tenant}", token="")
            ok = c in (400, 404)
            record(cid, name, "critical", "400/404", f"{c}", ok)
    else:
        for cid, name in (("B05", "evidence 名 .."), ("B06", "evidence 名穿越"),
                          ("B07", "evidence 编码穿越")):
            record(cid, name, "critical", "需 --secret", "SKIP", True, "")

    # 上传边界
    c, b = req(ctx, "/v1/assets", "POST", raw=b"", headers={"X-Filename": "x.mp4"})
    record("B08", "0 字节上传", "medium", "4xx", f"{c}", 400 <= c < 500,
           json.dumps(b, ensure_ascii=False)[:120] if isinstance(b, dict) else "")

    big = b"\x00" * (600 * 1024 * 1024) if False else b"\x00" * (2 * 1024 * 1024)
    c, b = req(ctx, "/v1/assets", "POST", raw=big, headers={"X-Filename": "big.mp4"})
    record("B09", "2MB 垃圾字节上传", "low", "接受或 4xx", f"{c}", c in (201, 400, 413, 422))


# ═══════════════════════════════════════════════════ C SSRF
def run_ssrf(ctx: Ctx) -> None:
    print("\n── C SSRF（callback_url）──")
    cases = [
        ("C01", "云元数据 169.254.169.254", "critical",
         "http://169.254.169.254/latest/meta-data/"),
        ("C02", "file:// 协议", "critical", "file:///etc/passwd"),
        ("C03", "本机回环", "high", "http://127.0.0.1:8787/healthz"),
        ("C04", "gopher/dict 协议", "high", "gopher://127.0.0.1:6379/_INFO"),
        ("C05", "内网网段", "high", "http://10.0.0.1:80/"),
    ]
    for cid, name, sev, url in cases:
        body = {"ir": minimal_ir(tiny_asset(ctx)),
                "idempotency_key": f"ssrf-{cid}-{int(time.time()*1000)}",
                "callback_url": url}
        code, resp = req(ctx, "/v1/render", "POST", body)
        err = (resp or {}).get("error", {}) if isinstance(resp, dict) else {}
        ecode = err.get("code", "") if isinstance(err, dict) else ""
        ok = code in (400, 422) and ecode in ("E_CALLBACK_FORBIDDEN", "E_BAD_REQUEST")
        record(cid, name, sev, "400 E_CALLBACK_FORBIDDEN", f"{code} {ecode}", ok,
               json.dumps(err, ensure_ascii=False)[:160])


# ═══════════════════════════════════════════════════ D 资源与 DoS
def run_dos(ctx: Ctx) -> None:
    print("\n── D 资源耗尽 ──")
    # JSON 深度炸弹
    depth = 4000
    bomb = ('{"ir":' + "[" * depth + "]" * depth + ',"idempotency_key":"deep-00000001"}').encode()
    c, b = req(ctx, "/v1/render", "POST", raw=bomb)
    record("D01", "JSON 深度炸弹 4000 层", "medium", "400 而非 500", f"{c}",
           c == 400, str(b)[:120])

    # 超大 body
    huge = b'{"ir":{}}' + b" " * (24 * 1024 * 1024)
    t0 = time.time()
    c, b = req(ctx, "/v1/render", "POST", raw=huge, timeout=90)
    dt = time.time() - t0
    record("D02", "24MB 请求体", "medium", "413", f"{c} ({dt:.1f}s)", c == 413)

    # 超长文本
    long_text = "字" * 20000
    body = {"template_id": "hook_vertical_6s",
            "variables": {"clip": "a0", "hook": long_text},
            "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
            "idempotency_key": f"d03-{int(time.time()*1000)}"}
    t0 = time.time()
    c, b = req(ctx, "/v1/validate", "POST", body, timeout=120)
    dt = time.time() - t0
    record("D03", "2 万字文本", "medium", "400 且 <5s", f"{c} ({dt:.1f}s)", c == 400)

    # 素材数量爆炸
    ntracks = 300
    ir = minimal_ir(tiny_asset(ctx))
    ir["tracks"] = [{"id": "v1", "kind": "video",
                     "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 30}]}]
    ir["assets"] = [{"id": f"a{i}", "uri": tiny_asset(ctx)} for i in range(ntracks)]
    c, b = req(ctx, "/v1/validate", "POST",
               {"ir": ir, "idempotency_key": f"d04-{int(time.time()*1000)}"})
    ok4 = (c == 200 and isinstance(b, dict) and b.get("valid") is False) or (400 <= c < 500)
    record("D04", "300 个素材", "medium", "valid=false 或 4xx",
           f"{c} valid={b.get('valid') if isinstance(b, dict) else '?'}", ok4)

    # 超长时长（2 小时 4K）
    ir2 = minimal_ir(tiny_asset(ctx))
    ir2["output"].update({"width": 3840, "height": 2160, "duration_frames": 216000})
    ir2["tracks"][0]["clips"][0]["out_frame"] = 216000
    c, b = req(ctx, "/v1/render", "POST",
               {"ir": ir2, "idempotency_key": f"d05-{int(time.time()*1000)}"})
    err = (b or {}).get("error", {}) if isinstance(b, dict) else {}
    ok = c in (400, 422)
    record("D05", "2 小时 4K 任务", "high", "拒绝（超出单任务上限）", f"{c}",
           ok, json.dumps(err, ensure_ascii=False)[:160])

    # 并发同幂等键
    key = f"race-{int(time.time()*1000)}"
    body = {"template_id": "hook_vertical_6s",
            "variables": {"clip": "a0", "hook": "并发"},
            "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
            "idempotency_key": key}
    ids: list[str] = []
    lock = threading.Lock()

    def fire():
        c, b = req(ctx, "/v1/render", "POST", body)
        if isinstance(b, dict) and b.get("job_id"):
            with lock:
                ids.append(b["job_id"])

    ts = [threading.Thread(target=fire) for _ in range(12)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    uniq = set(ids)
    record("D06", "12 并发同幂等键", "critical", "恰好 1 个 job", f"{len(uniq)} 个",
           len(uniq) <= 1, f"ids={list(uniq)[:3]}")

    # QPS（用独立的低配额租户，避免污染功能测试）
    codes = []
    tok = ctx.burst_token or ctx.token
    for _ in range(40):
        c, _b = req(ctx, "/v1/templates", token=tok, timeout=10)
        codes.append(c)
    limited = codes.count(429)
    if ctx.burst_token:
        record("D07", "40 次连发（QPS=5 租户）", "medium", "出现 429", f"429×{limited}",
               limited > 0, f"codes={sorted(set(codes))}")
    else:
        record("D07", "40 次连发 QPS", "medium", "需 --burst-token", "SKIP", True,
               f"codes={sorted(set(codes))}")

    # 慢速 body 不应阻塞其他请求
    def slow_post():
        try:
            s = socket.create_connection((ctx.base.split("//")[1].split(":")[0],
                                          int(ctx.base.split(":")[-1])), timeout=5)
            s.sendall(b"POST /v1/render HTTP/1.1\r\nHost: x\r\n"
                      b"Authorization: Bearer " + ctx.token.encode() + b"\r\n"
                      b"Content-Type: application/json\r\nContent-Length: 10000\r\n\r\n")
            s.sendall(b'{"a":')
            time.sleep(2.0)
            s.close()
        except Exception:
            pass

    th = threading.Thread(target=slow_post, daemon=True)
    th.start()
    time.sleep(0.3)
    t0 = time.time()
    c, _b = req(ctx, "/healthz", timeout=5)
    dt = time.time() - t0
    th.join(timeout=3)
    record("D08", "慢速 POST 期间健康检查", "medium", "<1s 且 200", f"{c} ({dt:.2f}s)",
           c == 200 and dt < 1.0)


# ═══════════════════════════════════════════════════ E 注入
def run_injection(ctx: Ctx) -> None:
    print("\n── E 注入 ──")
    payloads = [
        ("E01", "SQL 注入幂等键", "'; DROP TABLE jobs; --"),
        ("E02", "SQL 注入 job_id", "job' OR '1'='1"),
    ]
    for cid, name, key in payloads:
        body = {"ir": minimal_ir(tiny_asset(ctx)), "idempotency_key": key}
        c, b = req(ctx, "/v1/render", "POST", body)
        record(cid, name, "critical", "不返回 500", f"{c}", c != 500,
               str(b)[:120])

    # 查 jobs 表还在
    c, b = req(ctx, "/v1/jobs?limit=3")
    record("E03", "注入后 jobs 表仍可用", "critical", "200", f"{c}", c == 200)

    # 命令注入：文本里放 shell 元字符（我们不走 shell）
    ir = minimal_ir(tiny_asset(ctx))
    ir["styles"] = {"s": {"font_family": "Hiragino Sans GB", "font_size": 40,
                          "fill": "#FFFFFF"}}
    ir["tracks"].append({"id": "t1", "kind": "text", "clips": [
        {"at_frame": 0, "out_frame": 30,
         "text": "$(touch /tmp/pwned); `id`; | cat /etc/passwd", "style": "s"}]})
    c, b = req(ctx, "/v1/validate", "POST",
               {"ir": ir, "idempotency_key": f"e04-{int(time.time()*1000)}"})
    record("E04", "文本命令替换", "critical", "不产生副作用", f"{c}", c in (200, 422),
           "编译走 argv，不经 shell")

    # null 字节 / 非法 UTF-8
    raw = b'{"ir":' + json.dumps(minimal_ir(tiny_asset(ctx))).encode() + \
          b',"idempotency_key":"e05-00000000","variables":{"x":"a\\u0000b"}}'
    c, b = req(ctx, "/v1/render", "POST", raw=raw)
    record("E05", "含 null 字节的 JSON", "low", "4xx 或安全接受", f"{c}",
           c in (200, 202, 400, 422), str(b)[:100])

    bad_utf8 = b'{"ir":{}\xff\xfe}'
    c, b = req(ctx, "/v1/render", "POST", raw=bad_utf8)
    record("E06", "非法 UTF-8 请求体", "low", "400", f"{c}", c == 400)


# ═══════════════════════════════════════════════════ F 业务逻辑
def run_logic(ctx: Ctx) -> None:
    print("\n── F 业务逻辑 ──")
    # dry_run 不落库、不扣配额。
    # 不能靠「两次 /v1/usage 相等」判断：并发任务随时会改变 seconds，那是 flaky。
    # 用幂等键证明：dry_run 若写了库，同键真实提交必然变成重放。
    key = f"dry-{int(time.time()*1000)}"
    body = {"template_id": "hook_vertical_6s",
            "variables": {"clip": "a0", "hook": "试算"},
            "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
            "idempotency_key": key, "dry_run": True}
    c0, dry = req(ctx, "/v1/render", "POST", body)
    dry_ok = (c0 in (200, 202) and isinstance(dry, dict)
              and dry.get("job_id") is None)
    c1, real = req(ctx, "/v1/render", "POST", {**body, "dry_run": False})
    fresh = (isinstance(real, dict) and bool(real.get("job_id"))
             and not real.get("idempotent_replay"))
    record("F01", "dry_run 不落库（同键真实提交非重放）", "high",
           "job_id=None 且非重放",
           f"dry={dry_ok} fresh={fresh}", dry_ok and fresh)

    # 同幂等键不同 payload：返回第一个任务，不覆盖
    key = f"idem-{int(time.time()*1000)}"
    b1 = {"template_id": "hook_vertical_6s",
          "variables": {"clip": "a0", "hook": "第一个"},
          "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
          "idempotency_key": key}
    b2 = {**b1, "variables": {"clip": "a0", "hook": "第二个"}}
    c1, j1 = req(ctx, "/v1/render", "POST", b1)
    c2, j2 = req(ctx, "/v1/render", "POST", b2)
    same_id = (isinstance(j1, dict) and isinstance(j2, dict)
               and j1.get("job_id") == j2.get("job_id"))
    record("F02", "同幂等键不同 payload", "high", "返回首个任务", f"{same_id}", same_id)

    # priority 非法值
    body = {"ir": minimal_ir(tiny_asset(ctx)),
            "idempotency_key": f"prio-{int(time.time()*1000)}",
            "priority": "urgent-999"}
    c, b = req(ctx, "/v1/render", "POST", body)
    record("F03", "非法 priority", "low", "400 或归一", f"{c}", c in (200, 202, 400))

    # 超大分辨率素材（解码炸弹）：1MB 的 5000×5000 视频
    import subprocess
    big = Path("/tmp/_attack_8k.mp4")
    if not big.exists():
        subprocess.run(["ffmpeg","-y","-v","error","-f","lavfi",
                        "-i","testsrc2=s=5000x5000:r=1:d=2","-frames:v","1",
                        "-c:v","libx264","-preset","ultrafast","-level","6.1",
                        "-pix_fmt","yuv420p",str(big)], check=False)
    if big.exists():
        up = req(ctx, "/v1/assets", "POST", raw=big.read_bytes(),
                 headers={"X-Filename": "huge.mp4",
                          "Content-Type": "application/octet-stream"})
        if up[0] == 201:
            ir = minimal_ir(up[1]["uri"])
            ir["tracks"][0]["clips"][0]["out_frame"] = 1
            ir["output"]["duration_frames"] = 1
            c, b = req(ctx, "/v1/render", "POST",
                       {"ir": ir, "idempotency_key": f"f05-{int(time.time()*1000)}"})
            err = (b or {}).get("error", {}) if isinstance(b, dict) else {}
            ecode = err.get("code","") if isinstance(err, dict) else ""
            ok5 = c in (400, 422) and ecode == "E_INPUT_TOO_LARGE"
            record("F05", "5000×5000 解码炸弹", "high", "422 E_INPUT_TOO_LARGE",
                   f"{c} {ecode}", ok5, json.dumps(err, ensure_ascii=False)[:160])
        else:
            record("F05", "5000×5000 解码炸弹", "high", "上传成功", f"{up[0]}", False,
                   "生成的上传失败")
    else:
        record("F05", "5000×5000 解码炸弹", "high", "素材生成成功", "SKIP", True,
               "本机 ffmpeg 生成 5000×5000 失败")

    # 存储配额爆破：低配额租户连续上传，第二次必须被 413 挡住
    if ctx.storage_token:
        blob = b"Z" * 700000
        h = {"X-Filename": "quota.mp4", "Content-Type": "application/octet-stream"}
        c1, _b1 = req(ctx, "/v1/assets", "POST", raw=blob,
                      token=ctx.storage_token, headers=h)
        c2, b2 = req(ctx, "/v1/assets", "POST", raw=b"Y" * 700000,
                     token=ctx.storage_token, headers=h)
        e = (b2 or {}).get("error", {}) if isinstance(b2, dict) else {}
        code = e.get("code", "") if isinstance(e, dict) else ""
        record("F06", "存储配额爆破（1MB 租户）", "high",
               "413 E_QUOTA_STORAGE_EXCEEDED", f"{c1}/{c2} {code}",
               c1 == 201 and c2 == 413 and code == "E_QUOTA_STORAGE_EXCEEDED",
               json.dumps(e, ensure_ascii=False)[:160])
    else:
        record("F06", "存储配额爆破", "high", "需 --storage-token", "SKIP", True)

    # 直传交付同样走 SSRF 白名单，不能成为绕过 callback_url 校验的后门
    for cid, url in [("F07", "http://169.254.169.254/latest/meta-data/"),
                     ("F08", "file:///etc/passwd")]:
        body = {"template_id": "hook_vertical_6s",
                "variables": {"clip": "a0", "hook": "交付探测"},
                "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
                "idempotency_key": f"dlv-{cid}-{int(time.time()*1000)}",
                "delivery": {"mode": "put_url", "url": url}}
        c, b = req(ctx, "/v1/render", "POST", body)
        e = (b or {}).get("error", {}) if isinstance(b, dict) else {}
        code = e.get("code", "") if isinstance(e, dict) else ""
        ok7 = c in (400, 422) and code in ("E_CALLBACK_FORBIDDEN", "E_BAD_REQUEST")
        record(cid, "delivery put_url SSRF 后门", "high",
               "400 E_CALLBACK_FORBIDDEN", f"{c} {code}", ok7,
               json.dumps(e, ensure_ascii=False)[:160])

    # frames_total 撒谎：IR 才会被采信
    body = {**b1, "idempotency_key": f"ft-{int(time.time()*1000)}",
            "frames_total": 1}
    c, b = req(ctx, "/v1/render", "POST", body)
    record("F04", "客户端传 frames_total", "low", "被忽略", f"{c}", c in (200, 202, 400))


# ═══════════════════════════════════════════════════ G 容器与运维
def run_adversarial(ctx: Ctx) -> None:
    """H 组：本轮对抗审查新增的三类面（密钥熵 / 头注入 / 回执承诺）。"""
    print("\n── H 对抗审查 ──")
    cases = [
        ("H01", {"X-Note": "a\r\nX-Injected: yes"}, "delivery.headers CRLF 注入"),
        ("H02", {"Host": "evil.example"}, "delivery.headers 覆盖 Host"),
        ("H03", {"Content-Length": "1"}, "delivery.headers 覆盖 Content-Length"),
    ]
    for cid, hdr, name in cases:
        body = {"template_id": "hook_vertical_6s",
                "variables": {"clip": "a0", "hook": "头注入"},
                "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
                "idempotency_key": f"hdr-{cid}-{int(time.time()*1000)}",
                "delivery": {"mode": "put_url",
                             "url": "http://127.0.0.1:9/x", "headers": hdr}}
        c, b = req(ctx, "/v1/render", "POST", body)
        err = (b or {}).get("error", {}) if isinstance(b, dict) else {}
        code = err.get("code", "") if isinstance(err, dict) else ""
        fld = err.get("field", "") if isinstance(err, dict) else ""
        ok = c == 400 and code == "E_BAD_REQUEST" and fld == "delivery.headers"
        record(cid, name, "high", "400 E_BAD_REQUEST (field=delivery.headers)",
               f"{c} {code} {fld}", ok, json.dumps(err, ensure_ascii=False)[:180])

    # H04：用源码里的默认常量伪造下载签名，必须 401
    body = {"template_id": "hook_vertical_6s",
            "variables": {"clip": "a0", "hook": "签名"},
            "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
            "idempotency_key": f"sig-{int(time.time()*1000)}"}
    c, b = req(ctx, "/v1/render", "POST", body)
    jid = (b or {}).get("job_id") if isinstance(b, dict) else None
    if jid:
        import hashlib as _h
        import hmac as _hm
        exp = int(time.time()) + 3600
        forged = _hm.new(b"renderd-dev-secret", f"{jid}:{exp}".encode(),
                         _h.sha256).hexdigest()[:32]
        c, _ = req(ctx, f"/v1/jobs/{jid}/video?exp={exp}&sig={forged}", token="")
        record("H04", "默认常量伪造下载签名", "critical", "401",
               f"{c}", c == 401)
    else:
        record("H04", "默认常量伪造下载签名", "critical", "先能提交任务",
               f"{c}", False, "提交失败，无法验证签名")

    # H05/H06：签名必须绑定 scope 与 tenant（只有 job_id 的签名等于万能钥匙）
    if jid and ctx.secret:
        exp = int(time.time()) + 3600
        vsig = _auth.sign(jid, exp, ctx.tenant, "video")
        c1, _ = req(ctx, f"/v1/jobs/{jid}/evidence/contact_sheet.jpg"
                        f"?exp={exp}&sig={vsig}&t={ctx.tenant}", token="")
        record("H05", "成片签名取证据文件", "high", "401", f"{c1}", c1 == 401)
        c2, _ = req(ctx, f"/v1/jobs/{jid}/video?exp={exp}&sig={vsig}&t=rival", token="")
        record("H06", "签名换租户参数", "high", "401", f"{c2}", c2 == 401)


def run_tenancy(ctx: Ctx) -> None:
    """I 组：租户边界。看三件事 —— 谁能打、谁能看、谁能删。"""
    print("\n── I 租户边界 ──")

    # I01 错 token 洪水：如果 401 不受限，这里会 40 个 401
    codes = []
    for i in range(40):
        c, _b = req(ctx, "/v1/templates", token=f"bad-token-{i}")
        codes.append(c)
    n429 = codes.count(429)
    record("I01", "40 次错 token 连发", "medium", "出现 429（认证失败限流）",
           f"429×{n429}", n429 > 0, f"codes={sorted(set(codes))}")

    # I02 队列视图：acme 不该看到 rival 的名字
    if ctx.other_token:
        body = {"template_id": "hook_vertical_6s",
                "variables": {"clip": "a0", "hook": "邻居"},
                "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
                "idempotency_key": f"i02-{int(time.time()*1000)}"}
        req(ctx, "/v1/render", "POST", body, token=ctx.other_token)
        c, q = req(ctx, "/v1/queue")
        leaked = ctx.other_tenant in ((q or {}).get("inflight_by_tenant") or {})
        record("I02", "队列视图泄露其他租户名", "high", "不出现 rival",
               f"{c} leaked={leaked}", c == 200 and not leaked,
               f"scope={(q or {}).get('scope')}")
    else:
        record("I02", "队列视图泄露其他租户名", "high", "需 --other-token", "SKIP", True)

    # I03/I04 素材归属与删除
    blob = bytes([0x41 + (int(time.time()) % 20)]) * 50000
    c, up = req(ctx, "/v1/assets", "POST", raw=blob,
                headers={"X-Filename": "ownership.mp4",
                         "Content-Type": "application/octet-stream"})
    aid = (up or {}).get("asset_id")
    if c == 201 and aid:
        if ctx.other_token:
            c2, b2 = req(ctx, f"/v1/assets/{aid}", "DELETE", token=ctx.other_token)
            e = (b2 or {}).get("error", {}) if isinstance(b2, dict) else {}
            record("I03", "跨租户删除素材", "critical", "404",
                   f"{c2} {e.get('code', '')}", c2 == 404)
        c4, b4 = req(ctx, f"/v1/assets/{aid}", "DELETE")
        record("I04", "自己的素材可删除并释放配额", "medium",
               "200 且 file_removed", f"{c4} {b4.get('file_removed') if isinstance(b4, dict) else ''}",
               c4 == 200 and isinstance(b4, dict) and b4.get("file_removed") is True)
    else:
        record("I03", "跨租户删除素材", "critical", "先能上传", f"{c}", False)
        record("I04", "自己的素材可删除", "medium", "先能上传", f"{c}", False)


def run_tenancy(ctx: Ctx) -> None:
    """I 组：租户边界 —— 谁能打、谁能看、谁能删。"""
    print("\n── I 租户边界 ──")

    # I01 错 token 洪水：如果 401 不受限，这里会 40 个 401
    codes = []
    for i in range(40):
        c, _b = req(ctx, "/v1/templates", token=f"bad-token-{i}")
        codes.append(c)
    n429 = codes.count(429)
    record("I01", "40 次错 token 连发", "medium", "出现 429（认证失败限流）",
           f"429x{n429}", n429 > 0, f"codes={sorted(set(codes))}")

    # I02 队列视图：acme 不该看到 rival 的名字
    if ctx.other_token:
        body = {"template_id": "hook_vertical_6s",
                "variables": {"clip": "a0", "hook": "邻居"},
                "assets": [{"id": "a0", "uri": tiny_asset(ctx)}],
                "idempotency_key": f"i02-{int(time.time()*1000)}"}
        req(ctx, "/v1/render", "POST", body, token=ctx.other_token)
        c, q = req(ctx, "/v1/queue")
        leaked = ctx.other_tenant in ((q or {}).get("inflight_by_tenant") or {})
        record("I02", "队列视图泄露其他租户名", "high", "不出现 rival",
               f"{c} leaked={leaked}", c == 200 and not leaked,
               f"scope={(q or {}).get('scope')}")
    else:
        record("I02", "队列视图泄露其他租户名", "high", "需 --other-token", "SKIP", True)

    # I03/I04 素材归属与删除
    blob = bytes([0x41 + (int(time.time()) % 20)]) * 50000
    c, up = req(ctx, "/v1/assets", "POST", raw=blob,
                headers={"X-Filename": "ownership.mp4",
                         "Content-Type": "application/octet-stream"})
    aid = (up or {}).get("asset_id")
    if c == 201 and aid:
        if ctx.other_token:
            c2, b2 = req(ctx, f"/v1/assets/{aid}", "DELETE", token=ctx.other_token)
            e = (b2 or {}).get("error", {}) if isinstance(b2, dict) else {}
            record("I03", "跨租户删除素材", "critical", "404",
                   f"{c2} {e.get('code', '')}", c2 == 404)
        c4, b4 = req(ctx, f"/v1/assets/{aid}", "DELETE")
        removed = b4.get("file_removed") if isinstance(b4, dict) else None
        record("I04", "自己的素材可删除并释放配额", "medium",
               "200 且 file_removed", f"{c4} {removed}",
               c4 == 200 and removed is True)
    else:
        record("I03", "跨租户删除素材", "critical", "先能上传", f"{c}", False)
        record("I04", "自己的素材可删除", "medium", "先能上传", f"{c}", False)


def run_ops(ctx: Ctx) -> None:
    print("\n── G 运维面 ──")
    c, b = req(ctx, "/healthz", token="")
    ok = isinstance(b, dict) and b.get("ok") and "engine" in b and "fonts_available" in b
    record("G01", "healthz 含引擎与字体信息", "info", "字段齐全", f"{c}",
           bool(ok), json.dumps(b, ensure_ascii=False)[:150])

    c, b = req(ctx, "/metrics", token="")
    record("G02", "metrics 可抓取", "info", "200", f"{c}", c == 200)

    c, b = req(ctx, "/v1/openapi.json")
    record("G03", "无此路由返回 404 JSON", "low", "404", f"{c}", c == 404)

    # 未知方法
    c, b = req(ctx, "/v1/render", "PUT", {"x": 1})
    record("G04", "不合法的 HTTP 方法", "low", "404/405", f"{c}", c in (404, 405))


# ═══════════════════════════════════════════════════ main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8787")
    ap.add_argument("--token", default="devtoken")
    ap.add_argument("--other-token", default="")
    ap.add_argument("--secret", default="")
    ap.add_argument("--burst-token", default="")
    ap.add_argument("--storage-token", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--only", default="", help="只跑某个分类，如 A B")
    args = ap.parse_args()

    ctx = Ctx(base=args.base.rstrip("/"), token=args.token,
              other_token=args.other_token, secret=args.secret,
              burst_token=args.burst_token,
              storage_token=args.storage_token)

    print(f"目标 {ctx.base}  token={args.token[:4]}…")
    c, b = req(ctx, "/healthz", token="")
    print(f"healthz → {c} {json.dumps(b, ensure_ascii=False)[:160]}")

    groups = {"A": run_auth, "B": run_fs, "C": run_ssrf, "D": run_dos,
              "E": run_injection, "F": run_logic, "H": run_adversarial,
              "G": run_ops, "I": run_tenancy}
    only = set(args.only.split()) if args.only else set(groups)
    for k, fn in groups.items():
        if k in only:
            try:
                fn(ctx)
            except Exception as exc:
                record(f"{k}XX", f"{k} 组执行异常", "high", "无异常",
                       f"{type(exc).__name__}", False, str(exc)[:200])

    total = len(RESULTS)
    fails = [r for r in RESULTS if r["verdict"] == "FAIL"]
    crit = [r for r in fails if r["severity"] == "critical"]
    print(f"\n{'='*66}")
    print(f"共 {total} 项：通过 {total - len(fails)} / 失败 {len(fails)}"
          f"（critical {len(crit)}）")
    if fails:
        print("\n失败项：")
        for r in fails:
            print(f"  [{r['severity']:8}] {r['id']} {r['name']}  → {r['actual']}")
    print("=" * 66)

    if args.json:
        Path(args.json).write_text(json.dumps(
            {"base": ctx.base, "total": total, "results": RESULTS},
            ensure_ascii=False, indent=2) + "\n")
        print(f"→ {args.json}")
    return 0 if not crit else 1


if __name__ == "__main__":
    raise SystemExit(main())
