"""MCP server（stdio，JSON-RPC 2.0，按行分隔）。

这是 Agent 的入口。三条设计约束写在工具定义里而不是文档里：
  · 只暴露「提交意图」的工具，不暴露执行计划
  · 成功必须带 receipt，不能只给 URL —— Agent 看不见视频
  · 错误必须带 code/hint/field/allowed_values，Agent 才能自我修正
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any

from . import __version__
from .errors import JobError, ERROR_SPECS
from .service import Service

PROTOCOL_VERSION = "2025-06-18"
# 我们只声明「legacy 通道」的版本集合。WorkBuddy / SDK 的 modern 通道是 2026-07-28+
# 且**取消了 initialize 握手**，本服务端是 legacy 形态，按老协议协商即可。
# 2025-06-18 对我们是纯增量（structuredContent / elicitation 都是可选能力，我们只广告 tools），
# 而 2025-11-25 的 tasks 语义我们没实现，故不声明，让客户端按最高可实现版本协商。
SUPPORTED_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07")

# 素材的形状**内联**，不写 `$ref: #/$defs/Asset`。
# 曾经踩过：schema 里引用了 `$defs/Asset`，但每个 inputSchema 是独立文档，
# 里面并没有 `$defs` —— 于是 tools/list 返回一个悬空引用，客户端解析不到、
# LLM 只能瞎猜；而 assets 恰恰是唯一传视频的入口。
ASSET_SCHEMA = {
    "type": "object",
    "description": "素材引用。先 upload_asset 拿到 uri，或直接用已上传过的文件名。",
    "properties": {
        "id": {"type": "string", "description": "时间线内引用名，例如 a1（同一 IR 内唯一）"},
        "uri": {"type": "string",
                "description": "upload:<sha256>.<ext>（upload_asset 的返回值），"
                               "或 media 目录下的文件名"},
        "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$",
                   "description": "可选：内容校验，填了就会校验实际文件"},
        "kind": {"type": "string", "enum": ["video", "audio", "image", "subtitle"],
                 "description": "可选：显式声明类型，不确定就省略，服务端会探针判定"},
    },
    "required": ["id", "uri"],
    "additionalProperties": False,
}

TOOLS = [
    {
        "name": "list_templates",
        "description": "列出可用模板及其变量 schema。先调这个，再决定用哪个模板、填哪些变量。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "family": {"type": "string", "description": "按模板族过滤"},
                "aspect": {"type": "string", "enum": ["9:16", "16:9", "1:1", "4:5"]},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "validate_render",
        "description": "预检：不渲染，只校验 IR/素材/字体/安全区，并给出成本与耗时预估。"
                       "返回的 fixes 可以直接照改再提交。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "template_id": {"type": "string"},
                "variables": {"type": "object"},
                "assets": {"type": "array", "items": ASSET_SCHEMA, "description": "素材清单；每项需 id + uri（uri 来自 upload_asset）"},
                "ir": {"type": "object", "description": "高级用法：直传 IR"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "submit_render",
        "description": "提交渲染。必须带 idempotency_key（同 key 重放返回同一 job_id，不重复计费）。"
                       "dry_run=true 只返回估算，不入队。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "idempotency_key": {"type": "string", "minLength": 8},
                "template_id": {"type": "string"},
                "variables": {"type": "object"},
                "assets": {"type": "array", "items": ASSET_SCHEMA, "description": "素材清单；每项需 id + uri（uri 来自 upload_asset）"},
                "ir": {"type": "object"},
                "priority": {"enum": ["low", "normal", "high"]},
                "callback_url": {"type": "string"},
                "delivery": {
                    "type": "object",
                    "description": "成片交付。mode=local（默认）走本地签名 URL；"
                                   "mode=put_url 直传客户自己的预签名 PUT 地址。",
                    "properties": {
                        "mode": {"enum": ["local", "put_url"]},
                        "url": {"type": "string"},
                        "headers": {"type": "object"},
                    },
                    "additionalProperties": False,
                },
                "dry_run": {"type": "boolean"},
            },
            "required": ["idempotency_key"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_job_status",
        "description": "查任务状态。返回阶段（stage）与进度；失败时返回可执行的错误契约。",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_receipt",
        "description": "取证据回执：L0_ingest（每个素材被怎么归一化的决策单）/ L1 结构断言 / "
                       "L2 感知（若有 reference）/ L3 语义断言 + delivery 交付结果 + 首尾帧、"
                       "接触表、波形图、响度。Agent 靠它判断成片对不对，而不是靠再渲一次。",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "upload_asset",
        "description": "上传素材，返回 upload:<sha256>.<ext> 形式的 uri，直接填进 assets[].uri。"
                       "内容寻址：同一份字节重复上传不会重复计费。大文件建议走 REST "
                       "POST /v1/assets（流式，不占 JSON 体积）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string",
                             "description": "带扩展名的文件名，用来决定容器格式，如 clip.mp4"},
                "content_base64": {"type": "string",
                                   "description": "文件内容的 base64；上限按服务端 max_upload_mb"},
                "kind": {"type": "string", "enum": ["video", "audio", "image", "subtitle"]},
            },
            "required": ["filename", "content_base64"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_jobs",
        "description": "列出本租户的任务。丢了 job_id 时用它找回上一次提交。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                "status": {"type": "string",
                           "enum": ["accepted", "running", "succeeded", "failed", "cancelled"]},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "cancel_job",
        "description": "取消**排队中**的任务。已开始渲染的任务不能取消（会返回 E_CANCELLED 并说明原因），"
                       "因为中断 ffmpeg 会留下半成品产物。",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
            "additionalProperties": False,
        },
    },
]


class MCPServer:
    def __init__(self, service: Service | None = None, tenant: str = "mcp",
                 *, from_env: bool = True):
        self.service = service or Service()
        # 只有 stdio 允许用环境变量兜底租户 —— 那是「谁 spawn，谁就是谁」的模型：
        # 进程由调用方创建，环境变量也由调用方给。
        # HTTP 传输下租户**必须**来自 Bearer token，否则一个环境变量就能冒充任意租户。
        self.tenant = os.environ.get("RENDERD_MCP_TENANT", tenant) if from_env else tenant
        self.service.ensure_tenant(self.tenant)

    # ── JSON-RPC ──────────────────────────────────────
    def handle(self, msg: dict) -> dict | None:
        method = msg.get("method")
        mid = msg.get("id")
        is_notification = "id" not in msg

        try:
            if method == "initialize":
                want = str((msg.get("params") or {}).get("protocolVersion") or "")
                result = {
                    # 客户端要的版本我们支持就照办，否则回自己的默认版本（由客户端决定是否断开）
                    "protocolVersion": want if want in SUPPORTED_PROTOCOLS else PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "renderd", "version": __version__},
                    "instructions": "提交模板+素材即可渲染；成功后会返回证据回执。"
                                    "先用 list_templates 看有哪些模板。",
                }
            elif method in ("notifications/initialized", "initialized"):
                return None
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                result = self.call_tool(msg.get("params") or {})
            elif method in ("resources/list", "prompts/list"):
                result = {"resources": []} if method.startswith("resources") else {"prompts": []}
            else:
                if is_notification:
                    return None
                return self._err(mid, -32601, f"Method not found: {method}")
        except JobError as exc:
            return {"jsonrpc": "2.0", "id": mid,
                    "result": {"content": [{"type": "text",
                                            "text": json.dumps({"error": exc.to_dict()},
                                                               ensure_ascii=False)}],
                               "isError": True}}
        except Exception as exc:  # pragma: no cover
            traceback.print_exc(file=sys.stderr)
            if is_notification:
                return None
            return self._err(mid, -32603, f"{type(exc).__name__}: {exc}")

        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def _err(self, mid, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": code, "message": message}}

    # ── 工具实现 ───────────────────────────────────────
    def call_tool(self, params: dict) -> dict:
        name = params.get("name")
        args = params.get("arguments") or {}

        if name == "list_templates":
            tpls = self.service.templates()
            family = args.get("family")
            aspect = args.get("aspect")
            if family:
                tpls = [t for t in tpls if t["family"] == family]
            if aspect:
                tpls = [t for t in tpls if t["aspect"] == aspect]
            return self._ok({"templates": tpls, "count": len(tpls)})

        if name == "validate_render":
            return self._ok(self.service.validate(args))

        if name == "submit_render":
            payload = {k: v for k, v in args.items()
                       if k in ("template_id", "variables", "assets", "ir",
                                "priority", "callback_url", "delivery", "dry_run")}
            payload["idempotency_key"] = args.get("idempotency_key")
            result = self.service.submit(payload, self.tenant)
            return self._ok(result)

        if name == "get_job_status":
            return self._ok(self.service.status(args["job_id"], self.tenant))

        if name == "get_receipt":
            return self._ok(self.service.receipt(args["job_id"], self.tenant))

        if name == "upload_asset":
            import base64
            import binascii

            raw = args.get("content_base64") or ""
            # 先按 base64 长度粗判，避免把 700MB 字符串解码进内存才发现超限
            limit_mb = self.service.cfg.max_upload_mb
            if len(raw) * 3 // 4 > limit_mb * 1024 * 1024 + 3:
                raise JobError(
                    "E_UPLOAD_TOO_LARGE",
                    f"base64 体积换算后超过上限 {limit_mb}MB",
                    hint="改用 REST POST /v1/assets 流式上传",
                    allowed_values=[f"<= {limit_mb} MB"])
            try:
                data = base64.b64decode(raw, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise JobError("E_BAD_REQUEST", f"content_base64 不是合法 base64: {exc}",
                               field="content_base64") from exc
            return self._ok(self.service.put_asset(
                data, str(args.get("filename") or ""), self.tenant))

        if name == "list_jobs":
            limit = int(args.get("limit") or 50)
            if not 1 <= limit <= 200:
                raise JobError("E_BAD_REQUEST", "limit 需在 1..200 之间",
                               field="limit", allowed_values=[1, 200])
            jobs = self.service.list_jobs(self.tenant, limit=limit,
                                          status=args.get("status"))
            return self._ok({"jobs": jobs, "count": len(jobs)})

        if name == "cancel_job":
            return self._ok(self.service.cancel(args["job_id"], self.tenant))

        raise JobError("E_BAD_REQUEST", f"未知工具: {name}",
                       allowed_values=[t["name"] for t in TOOLS])

    def _ok(self, obj: Any) -> dict:
        text = json.dumps(obj, ensure_ascii=False, indent=1)
        return {"content": [{"type": "text", "text": text}], "isError": False}

    # ── 主循环 ─────────────────────────────────────────
    def serve_forever(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            t0 = time.monotonic()
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self._note(msg=None, outcome="rejected", code="-32700", t0=t0)
                self._write(self._err(None, -32700, "Parse error"))
                continue
            resp = self.handle(msg)
            self._note(msg=msg, resp=resp, t0=t0)
            if resp is not None:
                self._write(resp)

    def _note(self, *, msg, resp=None, outcome=None, code=None, t0=None) -> None:
        """本地嵌入时的一行观测日志，写 stderr。

        为什么是 stderr：stdout 是 JSON-RPC 的传输通道，往里混一行文本会直接
        破坏协议。stderr 在 stdio 模式下由调用方（编辑器/Agent）收走，正好用来
        看「刚才那步为什么失败」。
        """
        ms = int((time.monotonic() - t0) * 1000) if t0 else 0
        method = (msg or {}).get("method") or "-"
        params = (msg or {}).get("params") or {}
        tool = params.get("name", "-") if method == "tools/call" else "-"
        kind = outcome or "ok"
        if outcome is None and resp is not None:
            if "error" in resp:
                kind = "rpc_error"
                code = (resp.get("error") or {}).get("code")
            elif (resp.get("result") or {}).get("isError"):
                kind = "iserror"
        sys.stderr.write(
            f"mcp-stdio tenant={self.tenant} method={method} tool={tool} "
            f"outcome={kind}" + (f" code={code}" if code not in (None, "-") else "") +
            f" ms={ms}\n"
        )
        sys.stderr.flush()

    def _write(self, obj: dict) -> None:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main() -> None:
    MCPServer().serve_forever()


if __name__ == "__main__":
    main()
