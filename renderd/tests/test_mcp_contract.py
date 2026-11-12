#!/usr/bin/env python3
"""MCP 契约：schema 必须自洽，工具必须真的能用。

背景（2026-11-10 实测）：`validate_render.assets` 与 `submit_render.assets` 写的是
`{"$ref": "#/$defs/Asset"}`，但每个 inputSchema 是独立文档、里面并没有 `$defs`。
结果是 tools/list 返回一个**悬空引用** —— 客户端解析不到，LLM 只能猜「素材长什么样」。
而 assets 恰恰是唯一传视频的入口，猜错的代价是一次 400 + 一轮对话。

这个文件同时钉住两件事：
1. schema 自洽：不许有解析不了的 $ref，required 必须都在 properties 里；
2. 新增的三个工具（upload_asset / list_jobs / cancel_job）真的能跑通。
"""
from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from renderd.config import load_config                     # noqa: E402
from renderd.mcp_stdio import TOOLS, MCPServer             # noqa: E402
from renderd.service import Service                        # noqa: E402


def _walk_refs(node, found: list[str]) -> None:
    if isinstance(node, dict):
        if "$ref" in node:
            found.append(node["$ref"])
        for v in node.values():
            _walk_refs(v, found)
    elif isinstance(node, list):
        for v in node:
            _walk_refs(v, found)


class Contract(unittest.TestCase):
    def test_no_dangling_refs(self) -> None:
        refs: list[str] = []
        for tool in TOOLS:
            _walk_refs(tool["inputSchema"], refs)
        # 我们不使用 $defs：每个 inputSchema 都是独立文档，$ref 在其中无法解析
        self.assertEqual(refs, [], f"出现了无法解析的 $ref: {refs}")

    def test_required_is_declared(self) -> None:
        for tool in TOOLS:
            schema = tool["inputSchema"]
            self.assertEqual(schema.get("type"), "object", tool["name"])
            props = schema.get("properties") or {}
            for field in schema.get("required") or []:
                self.assertIn(field, props, f"{tool['name']}.{field} 未在 properties 中声明")
            self.assertFalse(schema.get("additionalProperties", True),
                             f"{tool['name']} 应关闭 additionalProperties")

    def test_assets_is_described(self) -> None:
        """素材结构必须能在 tools/list 里直接读到，而不是靠猜。"""
        for tool in TOOLS:
            props = tool["inputSchema"].get("properties") or {}
            if "assets" not in props:
                continue
            item = props["assets"]["items"]
            self.assertEqual(item.get("type"), "object", tool["name"])
            self.assertIn("id", item["properties"], tool["name"])
            self.assertIn("uri", item["properties"], tool["name"])
            self.assertEqual(sorted(item.get("required") or []), ["id", "uri"])

    def test_expected_tools_present(self) -> None:
        names = {t["name"] for t in TOOLS}
        for want in ("list_templates", "validate_render", "submit_render",
                     "get_job_status", "get_receipt",
                     "upload_asset", "list_jobs", "cancel_job"):
            self.assertIn(want, names)


class Tools(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = load_config(Path(self.tmp.name) / "data")
        self.svc = Service(self.cfg)
        self.svc.ensure_tenant("t", qps=1000)
        self.srv = MCPServer(self.svc, "t", from_env=False)

    def tearDown(self) -> None:
        self.svc.store.close_thread_connection()
        self.tmp.cleanup()

    def _call(self, name: str, arguments: dict) -> dict:
        res = self.srv.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                               "params": {"name": name, "arguments": arguments}})
        return json.loads(res["result"]["content"][0]["text"])

    def test_upload_asset_roundtrip(self) -> None:
        payload = b"\x00\x00\x00\x18ftypmp42" + b"\xab" * 512
        out = self._call("upload_asset", {
            "filename": "clip.mp4",
            "content_base64": base64.b64encode(payload).decode(),
        })
        self.assertTrue(out["uri"].startswith("upload:"), out)
        self.assertEqual(out["bytes"], len(payload))
        self.assertEqual(len(out["sha256"]), 64)

        # 同一份字节再传一次：内容寻址，不该重复占额度
        again = self._call("upload_asset", {
            "filename": "clip.mp4",
            "content_base64": base64.b64encode(payload).decode(),
        })
        self.assertEqual(again["sha256"], out["sha256"])

    def test_upload_asset_rejects_bad_base64(self) -> None:
        res = self.srv.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                               "params": {"name": "upload_asset",
                                          "arguments": {"filename": "x.mp4",
                                                        "content_base64": "不是base64!!"}}})
        self.assertTrue(res["result"]["isError"])
        self.assertIn("E_BAD_REQUEST", res["result"]["content"][0]["text"])

    def test_list_jobs_and_cancel(self) -> None:
        out = self._call("list_jobs", {})
        self.assertEqual(out["count"], 0)

        # cancel 一个不存在的任务应当是「可执行的错误」，不是协议错误
        res = self.srv.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                               "params": {"name": "cancel_job",
                                          "arguments": {"job_id": "job_000000000000"}}})
        self.assertTrue(res["result"]["isError"])
        self.assertIn("E_NOT_FOUND", res["result"]["content"][0]["text"])

    def test_list_jobs_limit_validated(self) -> None:
        res = self.srv.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                               "params": {"name": "list_jobs", "arguments": {"limit": 999}}})
        self.assertTrue(res["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
