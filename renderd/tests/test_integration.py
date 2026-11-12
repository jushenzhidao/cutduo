"""集成测试：真实渲染、确定性、缓存、REST、MCP。

渲染相关用例会真的起 ffmpeg，单条约 2–4 秒。
"""

from __future__ import annotations

import json
import socket
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from helpers import Sandbox

from renderd import api, ir as IR
from renderd.errors import JobError
from renderd.mcp_stdio import MCPServer

HOOK = "hook_vertical_6s"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class TestRenderPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sb = Sandbox("pipe")

    @classmethod
    def tearDownClass(cls):
        cls.sb.cleanup()

    def _payload(self, key: str, hook: str = "第一性原理") -> dict:
        return {
            "template_id": HOOK,
            "variables": {"clip": "a0", "hook": hook},
            "assets": self.sb.assets("v_a.mp4"),
            "idempotency_key": key,
        }

    def test_01_render_and_receipt(self):
        job = self.sb.render(self._payload("int-render-001"))
        self.assertEqual(job["status"], "succeeded", job["error_json"])
        rec = json.loads(job["receipt_json"])
        self.assertEqual(rec["verdict"], "pass", rec["failures"])
        self.assertTrue(all(v["pass"] for v in rec["L1"]["assertions"].values()
                            if isinstance(v, dict)))
        self.assertEqual(rec["L1"]["structural"]["width"], 1080)
        self.assertEqual(rec["L1"]["structural"]["frames"], 180)
        self.assertTrue(Path(job["output_path"]).exists())
        for k in ("contact_sheet", "first_frame", "last_frame", "waveform"):
            self.assertIn(k, rec["evidence"])
            self.assertTrue(Path(rec["evidence"][k]).exists(), k)
        self.assertGreater(len(rec["render_sha256"]), 10)

    def test_02_byte_determinism_without_cache(self):
        import hashlib
        p = self._payload("int-det-a")
        st = self.sb.service.store
        st._conn().execute("DELETE FROM render_cache")
        a = self.sb.render(p)
        st._conn().execute("DELETE FROM render_cache")
        b = self.sb.render({**p, "idempotency_key": "int-det-b"})
        ha = hashlib.sha256(Path(a["output_path"]).read_bytes()).hexdigest()
        hb = hashlib.sha256(Path(b["output_path"]).read_bytes()).hexdigest()
        self.assertEqual(ha, hb, "同 IR 两次渲染必须字节一致（capped CRF + 固定线程）")

    def test_03_cache_hit(self):
        p = self._payload("int-cache-a")
        self.sb.service.store._conn().execute("DELETE FROM render_cache")
        a = self.sb.render(p)
        b = self.sb.render({**p, "idempotency_key": "int-cache-b"})
        self.assertTrue(b["cache_hit"], "第二次应命中缓存")
        self.assertEqual(Path(a["output_path"]).stat().st_size,
                         Path(b["output_path"]).stat().st_size)

    def test_04_idempotent_replay(self):
        p = self._payload("int-idem-001")
        a = self.sb.submit(p)
        b = self.sb.submit(p)
        self.assertEqual(a["job_id"], b["job_id"])
        self.assertFalse(a["idempotent_replay"])
        self.assertTrue(b["idempotent_replay"])

    def test_05_dry_run_not_queued(self):
        out = self.sb.submit({**self._payload("int-dry-001"), "dry_run": True})
        self.assertTrue(out["dry_run"])
        self.assertIsNone(out["job_id"])
        self.assertIn("cost_cny", out["estimate"])

    def test_06_font_missing_rejected(self):
        ir, _ = self.sb.service.resolve_ir(self._payload("int-font-001"))
        for s in ir["styles"].values():
            s["font_family"] = "Helvetica"
        with self.assertRaises(JobError) as ctx:
            self.sb.submit({"ir": ir, "idempotency_key": "int-font-001"})
        self.assertEqual(ctx.exception.code, "E_FONT_MISSING")
        self.assertTrue(ctx.exception.allowed_values)

    def test_07_text_overflow_rejected(self):
        ir, _ = self.sb.service.resolve_ir(self._payload("int-of-001"))
        ir["tracks"][1]["clips"][0]["text"] = "超长文案" * 8
        ir["styles"]["s_hook"]["font_size"] = 200
        ir["styles"]["s_hook"]["max_chars_per_line"] = 12
        with self.assertRaises(JobError) as ctx:
            self.sb.submit({"ir": ir, "idempotency_key": "int-of-001"})
        self.assertIn(ctx.exception.code, ("E_TEXT_OVERFLOW", "E_IR_INVALID"))

    def test_08_media_too_short(self):
        ir, _ = self.sb.service.resolve_ir(self._payload("int-short-001"))
        ir["output"]["duration_frames"] = 300
        ir["tracks"] = [{"id": "v1", "kind": "video", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 300}]}]
        with self.assertRaises(JobError) as ctx:
            self.sb.submit({"ir": ir, "idempotency_key": "int-short-001"})
        self.assertEqual(ctx.exception.code, "E_MEDIA_TOO_SHORT")

    def test_09_quota_exceeded(self):
        st = self.sb.service.store
        st.ensure_tenant("poor", monthly_minutes=1)
        st.usage_add("poor", 60.0)
        with self.assertRaises(JobError) as ctx:
            self.sb.submit(self._payload("int-quota-001"), tenant="poor")
        self.assertEqual(ctx.exception.code, "E_QUOTA_EXCEEDED")

    def test_10_preflight_gives_fixes(self):
        ir, _ = self.sb.service.resolve_ir(self._payload("int-fix-001"))
        for s in ir["styles"].values():
            s["font_family"] = "Helvetica"
        result = self.sb.service.validate({"ir": ir})
        self.assertFalse(result["valid"])
        self.assertTrue(any(f["action"] == "pick_font" for f in result["fixes"]))


class TestRestAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sb = Sandbox("api")
        cls.port = free_port()
        cls.sb.cfg.api_port = cls.port
        cls.httpd, cls.svc, cls.workers = api.start(
            cls.sb.cfg, cls.sb.service, with_workers=1, background=True)
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(50):
            try:
                urllib.request.urlopen(cls.base + "/healthz", timeout=1).read()
                break
            except Exception:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        for w in cls.workers:
            w.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.sb.cleanup()

    def req(self, path, method="GET", body=None, token="testtoken"):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if token:
            r.add_header("Authorization", f"Bearer {token}")
        if data:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return e.code, {"raw": raw.decode(errors="replace")}

    def test_health_public(self):
        code, body = self.req("/healthz", token=None)
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])

    def test_auth_required(self):
        code, body = self.req("/v1/templates", token=None)
        self.assertEqual(code, 401)
        self.assertEqual(body["error"]["code"], "E_AUTH_REQUIRED")

    def test_templates(self):
        code, body = self.req("/v1/templates")
        self.assertEqual(code, 200)
        ids = [t["id"] for t in body["templates"]]
        self.assertIn(HOOK, ids)
        self.assertTrue(all("variables" in t for t in body["templates"]))

    def test_full_flow(self):
        assets = [{"id": "a0", "uri": self.sb.uri("v_a.mp4")}]
        payload = {"template_id": HOOK,
                   "variables": {"clip": "a0", "hook": "接口联通"},
                   "assets": assets, "idempotency_key": "api-flow-001"}
        code, body = self.req("/v1/render", "POST", payload)
        self.assertEqual(code, 202, body)
        job = body["job_id"]
        status = {}
        for _ in range(150):
            code, status = self.req(f"/v1/jobs/{job}")
            if status.get("status") in ("succeeded", "failed"):
                break
            time.sleep(0.3)
        self.assertEqual(status["status"], "succeeded", status.get("error"))
        code, rec = self.req(f"/v1/jobs/{job}/receipt")
        self.assertEqual(code, 200)
        self.assertEqual(rec["verdict"], "pass")
        url = status["video_url"]
        r = urllib.request.Request(self.base + url)
        with urllib.request.urlopen(r, timeout=30) as resp:
            self.assertEqual(resp.status, 200)
            self.assertGreater(len(resp.read(2048)), 1024)

    def test_signed_url_scope_and_tenant(self):
        """成片链接不能取证据文件，也不能换成别的租户身份用。"""
        assets = [{"id": "a0", "uri": self.sb.uri("v_a.mp4")}]
        payload = {"template_id": HOOK,
                   "variables": {"clip": "a0", "hook": "签名边界"},
                   "assets": assets, "idempotency_key": "api-bind-001"}
        code, body = self.req("/v1/render", "POST", payload)
        self.assertEqual(code, 202, body)
        job = body["job_id"]
        status = {}
        for _ in range(150):
            code, status = self.req(f"/v1/jobs/{job}")
            if status.get("status") in ("succeeded", "failed"):
                break
            time.sleep(0.3)
        self.assertEqual(status["status"], "succeeded", status.get("error"))
        url = status["video_url"]
        qs = url.split("?", 1)[1]

        code, _ = self.req(f"/v1/jobs/{job}/evidence/contact_sheet.jpg?{qs}", token=None)
        self.assertEqual(code, 401, "成片签名不能拿去取证据文件")

        code, _ = self.req(f"/v1/jobs/{job}/video?{qs.replace('t=acme', 't=other')}",
                           token=None)
        self.assertEqual(code, 401, "签名必须绑定租户")

        code, rec = self.req(f"/v1/jobs/{job}/receipt")
        ev = rec["evidence"]["contact_sheet"]
        with urllib.request.urlopen(self.base + ev, timeout=30) as resp:
            self.assertEqual(resp.status, 200, "回执里的证据链接必须可直接打开")
        with urllib.request.urlopen(self.base + url, timeout=30) as resp:
            self.assertEqual(resp.status, 200)

    def test_asset_lifecycle_over_http(self):
        """上传 → 列表 → 删除：DELETE 是这轮新增的唯一写方法。"""
        blob = b"Z" * 4096
        r = urllib.request.Request(
            self.base + "/v1/assets", data=blob, method="POST",
            headers={"Authorization": "Bearer testtoken", "X-Filename": "life.mp4",
                     "Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(r, timeout=30) as resp:
            info = json.loads(resp.read())
        aid = info["asset_id"]

        code, body = self.req("/v1/assets?limit=50")
        self.assertEqual(code, 200)
        self.assertIn(aid, [a["asset_id"] for a in body["assets"]])

        code, res = self.req(f"/v1/assets/{aid}", "DELETE")
        self.assertEqual(code, 200, res)
        self.assertTrue(res["file_removed"])
        self.assertEqual(res["storage_used_bytes"], 0)

        code, body = self.req("/v1/assets?limit=50")
        self.assertNotIn(aid, [a["asset_id"] for a in body["assets"]])

        code, _ = self.req("/v1/assets/asset_000000000000", "DELETE")
        self.assertEqual(code, 404)

    def test_bad_signature(self):
        code, body = self.req("/v1/jobs/job_deadbeef/video?exp=9999999999&sig=deadbeef",
                              token=None)
        self.assertEqual(code, 401)

    def test_metrics(self):
        r = urllib.request.Request(self.base + "/metrics")
        with urllib.request.urlopen(r, timeout=10) as resp:
            text = resp.read().decode()
        self.assertIn("renderd_jobs_total", text)

    def test_unknown_route(self):
        code, body = self.req("/v1/nope")
        self.assertEqual(code, 404)


class TestMCP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sb = Sandbox("mcp")
        cls.mcp = MCPServer(cls.sb.service, tenant="acme")

    @classmethod
    def tearDownClass(cls):
        cls.sb.cleanup()

    def call(self, name, args):
        resp = self.mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": name, "arguments": args}})
        res = resp["result"]
        return res["isError"], json.loads(res["content"][0]["text"])

    def test_initialize(self):
        resp = self.mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                "params": {}})
        self.assertEqual(resp["result"]["serverInfo"]["name"], "renderd")
        self.assertIn("protocolVersion", resp["result"])

    def test_notification_returns_none(self):
        self.assertIsNone(self.mcp.handle({"jsonrpc": "2.0",
                                           "method": "notifications/initialized"}))

    def test_tools_list(self):
        resp = self.mcp.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = {t["name"] for t in resp["result"]["tools"]}
        self.assertEqual(names, {"list_templates", "validate_render",
                                 "submit_render", "get_job_status", "get_receipt",
                                 # 2026-11-10 补：素材上传与任务管理，让 MCP 契约自洽
                                 "upload_asset", "list_jobs", "cancel_job"})

    def test_list_templates(self):
        err, data = self.call("list_templates", {})
        self.assertFalse(err)
        self.assertGreaterEqual(data["count"], 3)

    def test_validate_and_submit_dry_run(self):
        assets = [{"id": "a0", "uri": self.sb.uri("v_a.mp4")}]
        err, data = self.call("validate_render", {
            "template_id": HOOK,
            "variables": {"clip": "a0", "hook": "校验通过"},
            "assets": assets})
        self.assertFalse(err)
        self.assertTrue(data["valid"], data["checks"])
        err, data = self.call("submit_render", {
            "idempotency_key": "mcp-dry-0001",
            "template_id": HOOK,
            "variables": {"clip": "a0", "hook": "校验通过"},
            "assets": assets, "dry_run": True})
        self.assertFalse(err)
        self.assertTrue(data["dry_run"])

    def test_unknown_tool(self):
        err, data = self.call("no_such_tool", {})
        self.assertTrue(err)
        self.assertEqual(data["error"]["code"], "E_BAD_REQUEST")

    def test_full_job_via_mcp(self):
        assets = [{"id": "a0", "uri": self.sb.uri("v_a.mp4")}]
        err, data = self.call("submit_render", {
            "idempotency_key": "mcp-real-0001",
            "template_id": HOOK,
            "variables": {"clip": "a0", "hook": "MCP 全链路"},
            "assets": assets})
        self.assertFalse(err)
        job = data["job_id"]
        self.sb.run_one()
        err, status = self.call("get_job_status", {"job_id": job})
        self.assertFalse(err)
        self.assertEqual(status["status"], "succeeded", status.get("error"))
        err, rec = self.call("get_receipt", {"job_id": job})
        self.assertFalse(err)
        self.assertEqual(rec["verdict"], "pass")
        self.assertIn("video_url", rec)


if __name__ == "__main__":
    unittest.main()
