#!/usr/bin/env python3
"""MCP stdio 冒烟：起 worker 子进程 + MCP 子进程，走完整 5 个工具。

用法：python3 tests/mcp_smoke.py
退出码 0 = 全过。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 每次跑用唯一的临时数据目录：不需要「先删旧目录」，也就不会触发
# 批量删除保护（旧实现 rmtree 固定目录，跑几次后文件数 >50 会被拦）。
DATA = Path(tempfile.mkdtemp(prefix="renderd-mcp-"))
PASS, FAIL = 0, 0


def chk(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


class MCP:
    def __init__(self, data_dir: Path):
        env = {**os.environ, "RENDERD_DATA_DIR": str(data_dir),
               "RENDERD_MCP_TENANT": "mcp"}
        self.p = subprocess.Popen(
            [sys.executable, "-m", "renderd", "--data-dir", str(data_dir), "mcp"],
            cwd=str(ROOT), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
        self._id = 0

    def rpc(self, method: str, params: dict | None = None,
            notify: bool = False) -> dict | None:
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            self._id += 1
            msg["id"] = self._id
        assert self.p.stdin
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        if notify:
            return None
        assert self.p.stdout
        line = self.p.stdout.readline()
        if not line:
            err = self.p.stderr.read() if self.p.stderr else ""
            raise RuntimeError(f"MCP 无响应，stderr:\n{err[-1500:]}")
        return json.loads(line)

    def tool(self, name: str, args: dict) -> dict:
        resp = self.rpc("tools/call", {"name": name, "arguments": args})
        res = resp.get("result") or {}
        text = (res.get("content") or [{}])[0].get("text", "{}")
        return {"is_error": bool(res.get("isError")), "data": json.loads(text)}

    def close(self) -> None:
        try:
            if self.p.stdin:
                self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def main() -> int:
    # 准备素材
    from renderd.config import load_config
    from renderd.fixtures import ensure_media
    os.environ["RENDERD_DATA_DIR"] = str(DATA)
    cfg = load_config(DATA)
    media = ensure_media(cfg.media_dir)
    print("素材:", sorted(Path(p).name for p in media.values()))

    # 起 worker
    worker = subprocess.Popen(
        [sys.executable, "-m", "renderd", "--data-dir", str(DATA), "worker",
         "--tenant", "mcp", "--name", "w-mcp"],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, "RENDERD_DATA_DIR": str(DATA)})
    time.sleep(0.8)

    mcp = MCP(DATA)
    try:
        print("\n── initialize ──")
        r = mcp.rpc("initialize", {"protocolVersion": "2024-11-05",
                                   "capabilities": {},
                                   "clientInfo": {"name": "smoke", "version": "1"}})
        info = (r or {}).get("result", {}).get("serverInfo", {})
        chk("serverInfo.name", info.get("name") == "renderd", str(info))
        mcp.rpc("notifications/initialized", {}, notify=True)

        print("\n── tools/list ──")
        r = mcp.rpc("tools/list", {})
        tools = [t["name"] for t in (r or {}).get("result", {}).get("tools", [])]
        chk("五个工具齐备", set(tools) == {"list_templates", "validate_render",
                                          "submit_render", "get_job_status",
                                          "get_receipt"}, str(tools))
        for t in (r or {}).get("result", {}).get("tools", []):
            chk(f"{t['name']} 有 inputSchema", "inputSchema" in t)

        print("\n── list_templates ──")
        out = mcp.tool("list_templates", {})
        chk("模板数量 >= 3", out["data"].get("count", 0) >= 3,
            str([t["id"] for t in out["data"].get("templates", [])]))

        assets = [{"id": "a1", "uri": "file://" + media["v_a.mp4"]}]

        print("\n── validate_render ──")
        out = mcp.tool("validate_render", {
            "template_id": "hook_vertical_6s",
            "variables": {"clip": "a1", "hook": "第一性原理"},
            "assets": assets})
        chk("valid", out["data"].get("valid") is True, str(out["data"].get("checks")))
        chk("有 estimate", "estimate" in out["data"],
            str(out["data"].get("estimate")))

        print("\n── validate 负向：变量缺字（拉丁字体）──")
        ir = out_ir = None
        from renderd.service import Service
        svc = Service(cfg)
        ir, _ = svc.resolve_ir({"template_id": "hook_vertical_6s",
                                "variables": {"clip": "a1", "hook": "中文缺字测试"},
                                "assets": assets})
        for s in ir["styles"].values():
            s["font_family"] = "Helvetica"
        out = mcp.tool("validate_render", {"ir": ir})
        chk("字体缺失被拦", out["data"].get("valid") is False,
            str({k: v.get("pass") for k, v in out["data"].get("checks", {}).items()}))
        chk("给出 fixes", len(out["data"].get("fixes", [])) > 0,
            str(out["data"].get("fixes", [])[:1]))

        print("\n── submit_render（dry_run）──")
        out = mcp.tool("submit_render", {
            "idempotency_key": "mcp-dryrun-001",
            "template_id": "hook_vertical_6s",
            "variables": {"clip": "a1", "hook": "第一性原理"},
            "assets": assets, "dry_run": True})
        chk("dry_run 不入队", out["data"].get("dry_run") is True and out["data"].get("job_id") is None,
            str(out["data"].get("estimate")))

        out_d = mcp.tool("submit_render", {
            "idempotency_key": "mcp-delivery-dry-0001",
            "template_id": "hook_vertical_6s",
            "variables": {"clip": "a1", "hook": "交付字段"},
            "assets": assets, "dry_run": True,
            "delivery": {"mode": "local"}})
        chk("delivery 字段被 MCP 接受",
            out_d["data"].get("dry_run") is True and not out_d.get("isError"),
            str(out_d.get("error", ""))[:120])

        print("\n── submit_render（真实）──")
        out = mcp.tool("submit_render", {
            "idempotency_key": "mcp-real-001",
            "template_id": "hook_vertical_6s",
            "variables": {"clip": "a1", "hook": "第一性原理"},
            "assets": assets})
        job = out["data"].get("job_id")
        chk("拿到 job_id", bool(job), str(job))
        chk("idempotent_replay=false", out["data"].get("idempotent_replay") is False)

        print("\n── 幂等重放 ──")
        out2 = mcp.tool("submit_render", {
            "idempotency_key": "mcp-real-001",
            "template_id": "hook_vertical_6s",
            "variables": {"clip": "a1", "hook": "第一性原理"},
            "assets": assets})
        chk("同 key 同 job", out2["data"].get("job_id") == job,
            f"{out2['data'].get('job_id')} vs {job}")
        chk("replay=true", out2["data"].get("idempotent_replay") is True)

        print("\n── get_job_status 轮询 ──")
        status = {}
        for _ in range(120):
            status = mcp.tool("get_job_status", {"job_id": job})["data"]
            if status.get("status") in ("succeeded", "failed"):
                break
            time.sleep(0.4)
        chk("succeeded", status.get("status") == "succeeded",
            f"{status.get('status')} {status.get('error')}")
        chk("有 stage", status.get("stage") == "done", str(status.get("stage")))
        chk("有 video_url", bool(status.get("video_url")), str(status.get("video_url")))

        print("\n── get_receipt ──")
        rec = mcp.tool("get_receipt", {"job_id": job})["data"]
        chk("verdict=pass", rec.get("verdict") == "pass", str(rec.get("failures")))
        chk("L1 全过", all(v["pass"] for v in rec["L1"]["assertions"].values()
                          if isinstance(v, dict)), "")
        chk("L3 安全区存在", isinstance(rec["L3"]["safe_area"], list)
            and len(rec["L3"]["safe_area"]) > 0)
        chk("证据齐备", set(["contact_sheet", "first_frame", "last_frame",
                             "waveform"]) <= set(rec.get("evidence", {})),
            str(list(rec.get("evidence", {}))))
        chk("render_sha256", bool(rec.get("render_sha256")), rec.get("render_sha256", "")[:16])
        chk("回执含 L0_ingest", isinstance(rec.get("L0_ingest"), dict)
            and rec["L0_ingest"].get("applicable") is True,
            str(list((rec.get("L0_ingest") or {}).keys())))
        chk("回执含 delivery", isinstance(rec.get("delivery"), dict)
            and "mode" in rec["delivery"], str(rec.get("delivery")))

        print("\n── 未知工具 ──")
        resp = mcp.rpc("tools/call", {"name": "nope", "arguments": {}})
        chk("未知工具报错", bool((resp or {}).get("result", {}).get("isError")),
            str(resp)[:120])

    finally:
        mcp.close()
        worker.terminate()
        try:
            worker.wait(timeout=10)
        except Exception:
            worker.kill()

    print(f"\n通过 {PASS} / 失败 {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
