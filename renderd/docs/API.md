# API 契约 v1

Base URL 默认 `http://127.0.0.1:8787`。所有响应 `application/json; charset=utf-8`。

## 鉴权

```
Authorization: Bearer <token>
```

token 由 `RENDERD_TOKENS="token:tenant,token2:tenantB"` 配置，**token 与租户一一映射**。
未配置任何 token 且 `RENDERD_ALLOW_ANON=1` 时退化为匿名 `dev` 租户（仅限本地开发）。

下载类端点额外支持签名 URL，便于 Agent 直接取（Agent 常常拿不到自定义 header）：

```
GET /v1/jobs/{id}/video?exp=<unix>&sig=<hmac>&t=<tenant>
GET /v1/jobs/{id}/evidence/{name}?exp=<unix>&sig=<hmac>&t=<tenant>
```

签名覆盖**租户、用途、任务、过期时间**四要素：

```
payload = JSON(["v2", tenant, scope, job_id, exp])     # 无空格、UTF-8
sig     = HMAC-SHA256(RENDERD_SECRET, payload)[:32]
scope   = "video" | "evidence:<文件名>"
```

- 换 `t=`、改 `job_id`、把成片链接用于 evidence，一律 **401**
- 校验顺序是「先验签 → 再查任务 → 最后比对 owner」，不会用 404/401 的差异泄露 job 是否存在
- 每次成功下载写 `audit(action="download.signed", tenant, target, ip, scope)`；URL 泄露可追溯
- 带 `Authorization` 时走 token 鉴权，租户必须与任务 owner 一致（签名参数可省略）

回执里的 `evidence` 与 `video_url` 都是**已签名**可直接打开的地址。

## 幂等

提交必须带 `idempotency_key`（≥8 字符）。唯一约束 `(tenant, idempotency_key)`：

- 同 key 重复提交 → 返回**同一个 job_id**，`idempotent_replay=true`，**不产生第二次渲染成本**
- 不同租户用同一个 key → 互不影响

## 提交渲染

```
POST /v1/render
```

```json
{
  "idempotency_key": "order-20261109-001",
  "template_id": "brand_vertical_15s",
  "variables": {"clip1": "a1", "clip2": "a2", "clip3": "a3", "title": "季度回顾", "music": "m1"},
  "assets": [
    {"id": "a1", "uri": "file:///data/media/a.mp4"},
    {"id": "a2", "uri": "upload:9f3d....mp4"},
    {"id": "a3", "uri": "file:///data/media/c.mp4"},
    {"id": "m1", "uri": "upload:11ab....m4a"}
  ],
  "priority": "normal",
  "callback_url": "https://example.com/hook",
  "dry_run": false,
  "backend": "ffmpeg"
}
```

也可以直传 IR（高级用法，跳过模板）：

```json
{"idempotency_key": "...", "ir": { /* 见 IR.md */ }}
```

**响应 202**

```json
{
  "job_id": "job_35111bb1c430",
  "status": "accepted",
  "stage": "queued",
  "idempotent_replay": false,
  "poll_after_s": 3,
  "estimate": {"cost_cny": 0.0123, "render_s_p50": 7.5, "wall_clock_s_p50": 13.5},
  "template_id": "brand_vertical_15s"
}
```

`dry_run=true` 时返回 `{"dry_run": true, "job_id": null, "estimate": {...}, "checks": {...}}`，不入队。

**提交前会做完整预检**（IR schema / 素材可读 / 字体覆盖 / 安全区）。预检不过直接返回具体错误码，不会进入队列后才发现。

## 预检（不渲染）

```
POST /v1/validate
```

请求体同 `/v1/render`（`idempotency_key` 可省）。响应：

```json
{
  "valid": false,
  "checks": {
    "ir_schema":      {"pass": true,  "detail": []},
    "assets_readable":{"pass": true,  "detail": {"a1": {"type":"video","frames":240}}},
    "font_coverage":  {"pass": false, "error": {"code":"E_FONT_MISSING","message":"模板字体缺字：U+7B2C"}},
    "text_safe_area": {"pass": true,  "detail": [{"bbox":[264,1499,818,1613],"within_safe_area":true}]},
    "audio_present":  {"pass": true,  "detail": "无音轨，将补静音（已告知）"}
  },
  "fixes": [
    {"field": "styles.*.font_family", "action": "pick_font", "value": "Hiragino Sans GB",
     "reason": "当前字体缺字: U+7B2C,U+4E00"}
  ],
  "estimate": {"cost_cny": 0.0049, "render_s_p50": 3.0, "wall_clock_s_p50": 9.0}
}
```

`fixes` 是**机器可执行**的：`action` 只有 `set / pick_font / shorten_text / replace_asset` 四种，Agent 照改即可重试。

## 状态

```
GET /v1/jobs/{id}
```

```json
{
  "job_id": "job_...",
  "status": "running",
  "stage": "rendering",
  "attempts": 1, "max_attempts": 3,
  "frames_done": 128, "frames_total": 450, "progress": 0.2844,
  "elapsed_s": 6.2, "cache_hit": false, "cost_seconds": 0.0,
  "video_url": "/v1/jobs/job_.../video?exp=...&sig=...&t=acme"
}
```

- `status`: `accepted | running | succeeded | failed | cancelled`
- `stage`: `queued | ingesting | compiling | rendering | validating | delivering | done | failed`

**阶段比百分比有用**：`ingesting` 失败是素材问题，`rendering` 失败是资源问题，Agent 据此决定重试还是换素材。

失败时：

```json
{"status": "failed", "error": {"code": "E_MEDIA_TOO_SHORT", "message": "...", "retryable": false,
 "field": "tracks[v1].clips", "allowed_values": ["out_frame ≤ 200"]}}
```

## 回执

```
GET /v1/jobs/{id}/receipt
```

```json
{
  "schema": "cutproof/receipt/v1",
  "ir_id": "brand_vertical_15s",
  "ir_hash": "…", "render_sha256": "…",
  "verdict": "pass",
  "failures": [],
  "L1": {
    "structural": {"width":1080,"height":1920,"fps":"30/1","frames":450,"pix_fmt":"yuv420p",
                   "color_space":"bt709","color_range":"tv","audio_rate":48000,"audio_channels":2},
    "assertions": {"resolution": {"actual":[1080,1920],"expect":[1080,1920],"pass":true}, "...": {}}
  },
  "L2": {"applicable": false, "gate": 95, "note": "L2 需要 reference，只能做回归"},
  "L3": {
    "font_coverage": {"ok": true, "checked": 5, "missing": []},
    "safe_area": [{"track":"t1","frames":[30,420],"bbox":[281,1400,800,1574],"within_safe_area":true}],
    "loudness": {"integrated_lufs": -14.0, "true_peak_dbfs": -1.5, "target_lufs": -14.0, "ok": true},
    "black_frames": {"ranges": [], "count": 0}
  },
  "evidence": {
    "contact_sheet": "/v1/jobs/job_.../evidence/contact_sheet.jpg",
    "first_frame":   "/v1/jobs/job_.../evidence/first.jpg",
    "last_frame":    "/v1/jobs/job_.../evidence/last.jpg",
    "waveform":      "/v1/jobs/job_.../evidence/waveform.png"
  },
  "video_url": "/v1/jobs/job_.../video?exp=...&sig=...&t=acme",
  "generated_at": "2026-11-09T01:20:00+08:00"
}
```

`verdict != "pass"` 时 `failures` 非空，元素是错误码或断言名（如 `L3_LOUDNESS_OUT_OF_RANGE`）。

## 素材上传

```
POST /v1/assets
X-Filename: clip.mp4
<raw bytes>
```

```json
{"asset_id": "asset_8f3d9d13546e", "sha256": "8f3d…", "uri": "upload:8f3d….mp4", "bytes": 5033074}
```

上限 `RENDERD_MAX_UPLOAD_MB`（默认 512）。落盘按 sha256 命名，天然去重。

### 字幕素材（续轮 10）

字幕和视频走同一个上传接口，只是提交时声明 `kind`：

```bash
curl -X POST /v1/assets -H "Authorization: Bearer $TOKEN" \
     -H "X-Filename: captions.srt" --data-binary @captions.srt
# → {"asset_id": "asset_...", "uri": "upload:<sha>.srt", ...}
```

```json
{"assets": [{"id": "sub", "uri": "upload:<sha>.srt", "kind": "subtitle"}],
 "tracks": [{"id": "sb", "kind": "subtitle",
             "clips": [{"asset": "sub", "style": "caption",
                        "at_frame": 0, "out_frame": 450}]}]}
```

- 支持 SRT / WebVTT；编码 UTF-8（兼容 GB18030 回退）
- 时间码按整条时间线解释，再与 clip 窗口求交
- 字幕的字体/字号/描边/安全区全部由 `styles` 决定，文件自带的定位会被剥离
- 超框 → `E_TEXT_OVERFLOW` 硬失败

### 素材管理（续轮 6）

```
GET    /v1/assets?limit=100           # 本租户的素材引用与占用
DELETE /v1/assets/{asset_id}          # 释放引用；最后一个引用消失时才删文件
```

```json
// GET
{"assets":[{"asset_id":"asset_8f3d9d13546e","sha256":"8f3d…","bytes":5033074,
            "charged_bytes":5033074,"created_at":…,"last_seen":…}],
 "count":1,"storage_used_bytes":5033074,"storage_quota_bytes":2147483648}

// DELETE
{"asset_id":"asset_8f3d9d13546e","sha256":"8f3d…","refunded_bytes":5033074,
 "file_removed":true,"storage_used_bytes":0}
```

- 只有**真正写过盘**的租户计费；同内容后来上传的租户去重命中，`charged_bytes=0`，但引用关系保留
- 仍被 `accepted/running` 任务引用 → `409 E_ASSET_IN_USE`（已结束任务的产物不受影响）
- 跨租户删除一律 `404`（不能确认别人的素材是否存在）
- 老库迁移出来的 `legacy:<tenant>` 行没有对应文件，删除返回 404，只能由管理员清零

## 其他

| 端点 | 说明 |
|---|---|
| `GET /v1/templates` | 模板列表，含 variables schema、safe_area、fonts |
| `GET /v1/jobs?limit=50&status=succeeded` | 本租户任务列表 |
| `GET /v1/jobs/{id}/events` | 阶段流水（含编译命令、缓存键、失败原因） |
| `POST /v1/jobs/{id}/cancel` | 仅 `accepted` 状态可取消 |
| `GET /v1/usage` | 本月渲染秒数 / 剩余配额 / QPS / 素材数与占用 |
| `GET /v1/queue` | 队列视图。普通租户只看到自己的 inflight；admin 令牌看到全部（`scope` 字段区分） |
| `GET /healthz` | 公开，含引擎版本与字体数 |
| `GET /metrics` | Prometheus 文本 |

## 错误码一览

| code | HTTP | 可重试 | 阶段 |
|---|---|---|---|
| `E_AUTH_REQUIRED` | 401 | 否 | admission |
| `E_QUOTA_EXCEEDED` | 429 | 否 | admission |
| `E_RATE_LIMITED` | 429 | 是 | admission（含认证失败限速，见下） |
| `E_BAD_REQUEST` | 400 | 否 | admission |
| `E_NOT_FOUND` | 404 | 否 | admission |
| `E_UPLOAD_TOO_LARGE` | 413 | 否 | ingesting |
| `E_INPUT_UNREADABLE` | 422 | 否 | ingesting |
| `E_INPUT_AUDIO_ONLY` | 422 | 否 | ingesting |
| `E_INPUT_TRUNCATED` | 422 | 否 | ingesting |
| `E_MEDIA_MISSING` | 422 | 否 | ingesting |
| `E_MEDIA_TOO_SHORT` | 422 | 否 | ingesting |
| `E_IR_INVALID` | 400 | 否 | compiling |
| `E_IR_UNSUPPORTED` | 400 | 否 | compiling |
| `E_TEMPLATE_NOT_FOUND` | 404 | 否 | compiling |
| `E_TEMPLATE_VARS` | 400 | 否 | compiling |
| `E_FONT_MISSING` | 422 | 否 | compiling |
| `E_TEXT_OVERFLOW` | 422 | 否 | compiling |
| `E_TIMEOUT` | 504 | 是 | rendering |
| `E_OOM` | 503 | 是 | rendering |
| `E_RENDER_FAILED` | 500 | 是 | rendering |
| `E_OUTPUT_INVALID` | 500 | 否 | validating |
| `E_INTERNAL` | 500 | 是 | internal |


---

## 续轮新增字段

### 提交：`callback_url` 与 `delivery`

```json
{
  "template_id": "hook_vertical_6s",
  "variables": {"clip": "a1", "hook": "…"},
  "assets": [{"id": "a1", "uri": "upload:abc.mp4"}],
  "idempotency_key": "…",
  "callback_url": "https://hooks.example.com/renderd",
  "delivery": {"mode": "put_url",
                "url": "https://oss.example.com/presigned-put?...",
                "headers": {"Content-Type": "video/mp4"}}
}
```

- `callback_url`：任务成功/失败时 POST 一个 `{job_id, status, receipt_url, error}`。
  提交期校验并把解析到的公网 IP 钉进任务；投递期直连该 IP（防 DNS rebinding）。
- `delivery.mode=put_url`：成片直接 PUT 到客户自己的对象存储预签名地址。
  服务端不经手出网流量，成本模型里占 61% 的出口带宽项归零。
  失败不阻断任务成功，但 `receipt.delivery.status=failed` 且 `receipt.warnings` 留痕。
- 不传 `delivery` 时 `receipt.delivery = {"mode":"local"}`，成片留本地卷走签名 URL 下载。

两者都受 SSRF 白名单约束：`file://`、私网、链路本地（`169.254.169.254`）、URL 内嵌凭据
一律 `400 E_CALLBACK_FORBIDDEN`。

### 回执新增 `L0_ingest`

```json
{
  "L0_ingest": {
    "applicable": true,
    "target_fps": 30,
    "hdr_mode": "zscale+hable",
    "digest": "…",
    "assets": {
      "a1": {
        "flags": ["HDR", "NO_AUDIO"],
        "actions": ["TONEMAP_HDR", "AUDIO_SYNTH"],
        "action_desc": {"TONEMAP_HDR": "HDR → BT.709 SDR（zscale 线性光 + hable tone mapping）"},
        "warnings": ["HDR 已做 tone mapping…预览级处理"],
        "reasons": ["TONEMAP_HDR ← transfer=arib-std-b67 / primaries=bt2020"],
        "passthrough": false,
        "post": {"width": 1920, "height": 1080, "fps": 30,
                 "pix_fmt": "yuv420p", "color_space": "bt709",
                 "audio_rate": 48000, "audio_channels": 2}
      }
    },
    "warnings": ["[a1] …"]
  },
  "delivery": {"mode": "put_url", "status": "delivered", "http_status": 200}
}
```

`L0_ingest.digest` 纳入渲染缓存键；字体、引擎、归一化动作变化都会自动失效缓存。

### `/v1/usage` 新增字段

`storage_used_bytes`、`storage_used_mb`、`storage_quota_mb`。

### 新增错误码

| code | HTTP | 含义 |
|---|---|---|
| `E_QUOTA_STORAGE_EXCEEDED` | 413 | 租户存储配额不足 |
| `E_METRICS_FORBIDDEN` | 403 | `/metrics` 不对该来源开放 |
| `E_INPUT_TRUNCATED` | 422 | 抽样解码发现素材被截断（提交期即拦截） |
| `E_INPUT_OVERLONG` | 422 | 素材时长超上限 |
| `E_NORMALIZE_FAILED` | 422 | 归一化执行失败或未通过自校验 |

---

## 续轮 2：队列运维端点

| 端点 | 说明 |
|---|---|
| `GET /v1/queue` | 队列统计：`depth / ready / delayed / running / oldest_wait_s / inflight_by_tenant / failed_24h / max_queue_depth / max_tenant_inflight` |
| `GET /v1/dlq?limit=50` | 当前租户的失败任务（`id / error_code / error_json / attempts / finished_at`） |
| `POST /v1/jobs/{id}/replay` | 重放死信，返回 `{job_id, status:"accepted", attempts:0, replayed:true}` |
| `GET /v1/usage` | 新增 `inflight` / `inflight_limit` |

新增错误码 `E_QUEUE_FULL`（429，retryable=true）：队列深度或租户在途任务超限。
`dry_run=true` 的试算不占队列，不受此限制。

### webhook 契约（at-least-once）

任务终态 POST 到 `callback_url`：

```json
{
  "job_id": "job_xxx",
  "status": "succeeded",
  "event_id": "job_xxx:succeeded:1",
  "attempt": 1,
  "receipt_url": "/v1/jobs/job_xxx/receipt",
  "error": null
}
```

投递失败会重试 1 次，**收端必须按 `event_id` 去重**。同一次尝试的重发
（含网络抖动导致的重复）持有同一个 `event_id`；人工 `replay` 后 attempts 重置，
会生成新的键。回调地址在提交期解析并钉住 IP，投递期不做二次 DNS 解析。

---

## 存储后端（对使用者透明）

服务支持 SQLite（默认，零外部依赖）与 PostgreSQL（多 pod）两种状态后端，
**REST / MCP 契约完全一致**，切换只需在部署侧设置 `RENDERD_DB_DSN`。
`GET /healthz` 与 `/metrics` 在当前版本不暴露后端类型；需要确认时查部署环境变量，
或执行 `renderd queue`（能正常返回即说明状态层可用）。

生产用 `docker-compose.pg.yml`，注意 `RENDERD_PG_SCHEMA` 必须所有进程一致。
详见 `docs/OPS.md`「PG 后端」。

---

## 续轮 6：租户边界

### 认证失败限速

限流原先排在鉴权之后 —— 错 token 的请求完全不受约束。现在：

- 同一客户端 IP 的**无效令牌**请求超过 `RENDERD_AUTH_FAIL_QPS`（默认 10/秒）→ `429 E_RATE_LIMITED`
- 只拦无效令牌：同一出口 IP 的合法请求不受影响（NAT 后面的正常客户不被误伤）
- 账号维度仍按租户 `qps` 计，与这一层互不替代

### 队列视图分级

`GET /v1/queue` 返回 `scope`：

- `scope=tenant`：`inflight_by_tenant` 只含调用者自己；容量信息（depth/ready/running/oldest_wait_s）保留
- `scope=admin`：需要 `RENDERD_ADMIN_TOKENS` 里的令牌，返回全部租户的在途数

## 续轮 4：交付头、回执完整性与错误码

### `delivery.headers` 约束（提交期即校验）

- 头名必须是 HTTP token（`[A-Za-z0-9!#$%&'*+.^_`|~-]+`）
- 头值不能含 CRLF、控制字符或非 ASCII 字符
- **不可覆盖** `Host` / `Content-Length` / `Connection` / `Transfer-Encoding`
- 违规返回 `400 E_BAD_REQUEST`，`field="delivery.headers"`，`hint` 说明具体限制

### 回执新增字段

| 字段 | 说明 |
|---|---|
| `evidence_sha256` | 每个证据文件（contact_sheet / first_frame / last_frame / waveform）的 sha256；Agent 下载后可自行校验，服务端换了文件一定对不上 |
| `failures` 中的 `E_DELIVERY_FAILED` | 客户唯一交付通道（`put_url`）未成功。此时 `job.status` 仍为 `succeeded`（成片在本地可取），但 `verdict` 降级为 `fail` |

### 签名密钥

不再有可预测的默认值。未设置 `RENDERD_SECRET` 时，服务在 `data_dir` 生成
`.signing_key`（32 字节随机、0600）。多实例部署要么共享该目录，要么显式设置
`RENDERD_SECRET`；已知占位值（`change-me` 等）会导致启动失败。

---

## MCP over Streamable HTTP（`POST /mcp`）

面向「服务端部署、客户端跨网络接入」的场景。**与 stdio 共用同一份业务分发**
（`MCPServer.handle()`），因此工具集、参数、错误码没有第二套定义。

### 传输契约

| 项 | 值 |
|---|---|
| 路径 | `POST /mcp`（GET 返回 405 + `Allow: POST`，本服务不做 SSE 推流） |
| 鉴权 | 与 REST 相同：`Authorization: Bearer <token>` → 租户 |
| 请求体 | 单个 JSON-RPC 2.0 对象，或对象数组（批量，上限 32 条） |
| 响应体 | `application/json`：单请求回对象，批量回数组；**纯通知回 202 且无体** |
| 协议版本 | 客户端在 `initialize.params.protocolVersion` 指定；支持 `2025-03-26`、`2024-11-05`，其它值回落 `2024-11-05` |

### 租户来源（安全边界）

stdio 模式允许 `RENDERD_MCP_TENANT` 环境变量兜底，因为「谁 spawn 进程，谁就是谁」。
**HTTP 模式显式关闭该兜底**（`MCPServer(..., from_env=False)`）：租户只能来自 Bearer token。
否则部署侧一个环境变量就能让所有客户变成同一个租户，或冒充任意租户。

### 错误语义分层

| 失败点 | HTTP | JSON-RPC `error.code` |
|---|---|---|
| 无/错 token | 401 | —（走 REST 错误信封） |
| body 不是合法 JSON | 400 | `-32700` Parse error |
| body 为空 / 非对象 | 200 | `-32600` Invalid Request |
| 方法不存在 | 200 | `-32601` Method not found |
| 工具内业务错误 | 200 | 无 error 字段，`result.isError=true` 且 content 里带 `code/hint/field` |

业务错误**不进 HTTP 状态码**：Agent 靠 `result.isError` 与内部 `code` 决策，
这层如果换成 500，客户端就只能靠猜。

### 客户端配置示例

```json
{
  "mcpServers": {
    "renderd": {
      "type": "streamable-http",
      "url": "https://render.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### 验收

```bash
make test-mcp-http     # 16 项：协议协商 / 工具 / 通知 202 / 批量 / 错误语义 / 租户来源
```
