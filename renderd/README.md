# renderd

商业级视频渲染服务：**IR 进，成片 + 证据回执出**。

不是渲染脚本，是一个能起服务、能排队、能重试、能重启恢复、能被 Agent 调用的系统。

```
意图（模板 + 变量 / 裸 IR）
   ↓  compile（产品壁垒，也是安全边界）
IR  ── 事实来源，整数帧，内容寻址素材
   ↓  compile（可缓存）
执行计划（FFmpeg filtergraph / MLT XML）── 字节码，可换可丢
   ↓
渲染 → L1 结构断言 → L3 语义断言 → 证据回执 → 交付
```

## 30 秒跑起来

```bash
make install          # pip install pillow（唯一第三方依赖）
make doctor           # 环境自检
make test             # 58 个用例，约 20 秒
make serve            # 起服务 http://127.0.0.1:8787
make demo             # 三个模板各渲一条，看速度
```

起服务后：

```bash
export T=devtoken
curl -s localhost:8787/v1/templates -H "Authorization: Bearer $T" | python3 -m json.tool
curl -s localhost:8787/v1/render -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{
    "template_id": "hook_vertical_6s",
    "variables": {"clip": "a1", "hook": "第一性原理"},
    "assets": [{"id": "a1", "uri": "file:///abs/path/clip.mp4"}],
    "idempotency_key": "my-job-0001"
  }'
```

## 容器

```bash
make docker-build          # 构建镜像（Debian 13 + ffmpeg 7.1 + Noto CJK，非 root）
make docker-run            # 起单容器，端口 8788
make test-container        # 容器内端到端：上传→预检→三模板→回执→下载
make test-compose          # compose 分离部署 + kill -9 崩溃恢复（约 90s）
make test-gateway          # Caddy TLS 网关 + /metrics 白名单（约 30s）
make soak500               # 500 条长稳，看内存收敛曲线
make bootstrap             # Colima 重建 VM 后固化 DNS / mirror 修复
```

Compose 是 api / worker 分离部署，两者共用一个 `/data` 卷（同一个 SQLite）。
worker 被 `kill -9` 后，独立 reaper 会在租约到期时把任务重新入队 —— 这条链路有专门测试：

```bash
docker compose kill -s SIGKILL worker   # 崩溃
# 等 LEASE_S 秒 → 任务回到 queued → worker 拉起后自愈
```

## 存储后端：SQLite / PostgreSQL 双后端

```bash
make test                  # 默认 SQLite，零外部依赖
export RENDERD_DB_DSN="postgresql://user:pwd@host:5432/renderd"
make test-pg               # 同一套 85 个用例切到 PG
make docker-pg             # PG + api + worker 分离部署（可各自扩副本）
```

`Store()` 是工厂函数：`SqliteStore` 原样保留，`PostgresStore` 用方言代理复用全部 45 条
SQL，只 override 三处真差异（`ON CONFLICT` 幂等、`FOR UPDATE SKIP LOCKED` 领取、无
`BEGIN IMMEDIATE` 的事务）。**REST / MCP 契约完全一致**，切换只在部署侧。
生产必须显式设 `RENDERD_PG_SCHEMA` 且所有进程一致；不指定时每个实例自动隔离（unittest 用）。

实测（PostgreSQL 16.15 @ Colima）：PG 85/85 用例、51/51 对抗（0 critical）、21 条语料 PASS；
SQLite 侧同样 85/85。详见 [`docs/OPS.md`](docs/OPS.md)「PG 后端」。

**边界**：`docker-compose.pg.yml` 里 api/worker 仍共用 `/data` 卷放素材与成片 ——
状态可以多机，文件还不能；真正多 pod 要换成对象存储。

## 测试矩阵

| 命令 | 覆盖 | 时长 |
|---|---|---|
| `make test` | 自动发现全部 **85 个用例** | ~85s |
| `make test-pg` | 同一套 85 个用例跑在 PG 后端 | ~90s |
| `make unit` | IR 校验 / 字体 / 编译 / 存储 | 0.2s |
| `make integ` | 真渲染 / 字节确定性 / 缓存 / REST / MCP | 25s |
| `make hardening` | webhook / 直传 / DNS rebinding / 存储配额 / 白名单 | 40s |
| 生产级异步 11 项 | 可观测 / 背压 / 退避 / 死信重放 / 优雅退出配置 | 20s |
| 双后端契约 5 项 | 工厂选择 / DDL 翻译 / 占位符 / SKIP LOCKED / 真 PG 连通 | 2s |
| `make ingest-corpus` | 21 条脏素材归一化 + 4 条端到端 | 40s |
| `make smoke` | REST 11 项 + MCP stdio 26 项 | 15s |
| `make tls` | 内置 TLS + `/metrics` 来源白名单 | 3s |
| `make multi` | 3 worker 并发 12 条，不双领 | 12s |
| `make test-container` | 容器内端到端 | 25s |
| `make test-compose` | 分离部署 + 崩溃恢复 + 重启持久化 | 90s |
| `make test-gateway` | TLS 网关 + 真实任务 + 白名单收紧 | 30s |
| `make attack` | 51 项对抗测试 | 12s |
| `make soak500` | 500 条长稳，内存/磁盘/延迟 | ~10min |

## 安全

威胁模型、已加固项、残余风险见 [`docs/SECURITY.md`](docs/SECURITY.md)。
51 项对抗测试在容器内 51/51 通过（0 critical）。修复过的严重问题：任意文件读取
（`file:///etc/passwd`）、全 worker 失联时任务永久卡死、SSRF 打云元数据、
DNS rebinding、请求体无上限、存储配额绕过。

## 续轮新增能力

| 能力 | 入口 | 说明 |
|---|---|---|
| **输入归一化** | `renderd/ingest.py` | HDR tone mapping / 旋转 / VFR / 黑边 / 奇数边 / 音轨归一；决策单落盘，`receipt.L0_ingest` 留痕 |
| **提交期截断检测** | `Normalizer.precheck()` | 元数据健康但实际解码失败的文件，提交时直接 `E_INPUT_TRUNCATED` |
| **成片直传客户 OSS** | `delivery.put_url` | 客户给预签名 PUT URL，出口流量不经我方（成本模型里 61% 那一项归零） |
| **DNS rebinding 防护** | `netguard.py` | 解析一次、钉住 IP、投递期零解析；IPv4 优先 + 备选重试 |
| **租户存储配额** | `RENDERD_STORAGE_QUOTA_MB` | 锁内校验、内容寻址去重、跨月累计 |
| **TLS + metrics 白名单** | `docker-compose.tls.yml` | Caddy 反代 + 服务内置 TLS 双保险 |
| **Colima 环境固化** | `deploy/colima-bootstrap.sh` | 重建 VM 不丢 DNS / mirror 修复 |
| **队列可观测** | `Store.queue_stats()` + `/metrics` 7 个 gauge | depth / ready / delayed / running / oldest_wait / per-tenant inflight / failed_24h |
| **背压** | `RENDERD_MAX_QUEUE_DEPTH` / `RENDERD_MAX_TENANT_INFLIGHT` | 超限 `429 E_QUEUE_FULL`，dry_run 不占队列 |
| **重试退避** | `jobs.available_at` + `base × attempts²` | 瞬态错误不再几秒内连烧完 3 次机会 |
| **死信重放** | `renderd dlq` / `replay` / `release` + REST 三端点 | failed 任务可对账、可重放；失联 worker 可主动归还 |
| **优雅退出** | `STOPSIGNAL SIGTERM` + `stop_grace_period: 300s` | 让当前渲染跑完，而不是自动归还造成双领 |

## 为什么是这样设计的

| 决策 | 原因 |
|---|---|
| **IR 是事实来源，MLT XML 是编译产物** | 把执行格式当契约，引擎升级等于存量工程全废；也没法回答「两个引擎渲的是不是同一支片子」 |
| **时间一律整数帧** | 29.97/23.976 下浮点秒必然累积漂移，漂 1 帧的视觉伤害远大于换编码器 |
| **文字在编译期栅格化成图层** | 让目标机现算字形，输出就绑定那台机器的 freetype 版本，跨端一致从物理上不可保证 |
| **码率控制用 capped CRF，不用 CBR/ABR** | 实测：`-b:v`+`-maxrate`+`-bufsize` 在 `-threads>1` 下同命令两次字节不同（x264 的 VBV 状态在帧级线程下漂移）。capped CRF 完全确定且快 3.6× |
| **线程数固定 4 并进缓存键** | x264 字节输出与线程数相关；不固定则同机不同负载下可能不重现 |
| **每次成功都产出证据回执** | Agent 看不见视频。只给 URL，它只能靠重试试探，烧的是你的算力配额 |
| **断言失败不重试** | 确定性失败重跑只会再失败一次，白烧 3 倍算力 |
| **SQLite + `UPDATE … RETURNING` 做队列** | 「先查后改」在并发 worker 下必然双领，双领=渲染两次+计费两次，这类 bug 极难复现 |

## 三层断言

```
L1 结构层  分辨率 / 帧数 / fps / 像素格式 / 色彩四标 / 音频参数 / 音画时长差 ≤1 帧
L2 感知层  仅在有 reference 时生效（回归用）。首次渲染无参照片，不能判对错
L3 语义层  字形覆盖 / 文本安全区 / 响度 / 黑场 —— 唯一能判「首次对不对」的
```

**L4 不存在的**：没有第四层。判不了的就不判，不发明指标。

## 接口

REST（`docs/API.md` 文字版；`make api-doc` 生成可浏览的 `deliverables/接口文档.html`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` `/metrics` | 公开 |
| GET | `/v1/templates` | 模板与变量 schema |
| POST | `/v1/validate` | 预检：不渲染，给 checks + fixes + 成本估算 |
| POST | `/v1/assets` | 上传素材，内容寻址 |
| GET | `/v1/assets` | 本租户素材引用与占用 |
| DELETE | `/v1/assets/{id}` | 释放素材引用（在途任务引用中返回 409） |
| POST | `/v1/render` | 提交（幂等），202 |
| GET | `/v1/jobs/{id}` | 状态 / 阶段 / 进度 |
| GET | `/v1/jobs/{id}/receipt` | 证据回执 |
| GET | `/v1/jobs/{id}/video` | 成片（Bearer 或签名 URL） |
| GET | `/v1/jobs/{id}/events` | 阶段流水 |
| POST | `/v1/jobs/{id}/cancel` | 取消（仅排队中） |
| GET | `/v1/usage` | 本月用量、剩余配额、素材数与占用 |
| GET | `/v1/queue` | 队列视图（普通租户只看自己；admin 令牌看全量） |

MLT 后端（可选）：`make docker-build-mlt` 得到 `renderd:0.1.0-mlt`，
提交时带 `"backend": "mlt"` 即可走 MLT 出片；默认镜像不含 melt，会明确报错而不是降级。

MCP 工具：`list_templates` / `validate_render` / `submit_render` / `get_job_status` / `get_receipt`。
两条传输，**共用同一份业务分发**，工具集与错误码只有一套：

| 传输 | 适用 | 租户来源 |
|---|---|---|
| stdio（`renderd mcp`） | Agent 与服务同机 | token 或 `RENDERD_MCP_TENANT` |
| Streamable HTTP（`POST /mcp`） | **服务端部署、跨网络接入** | **只能** Bearer token |

同机嵌入（Claude Code / Cursor）：

```json
{
  "mcpServers": {
    "renderd": {
      "command": "python3",
      "args": ["-m", "renderd", "--data-dir", "/abs/path/renderd/var", "mcp"],
      "env": { "RENDERD_MCP_TENANT": "acme" }
    }
  }
}
```

服务端部署（多客户）：

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

契约细节见 `docs/API.md` 的「MCP over Streamable HTTP」；验收 `make test-mcp-http`（16 项）。

同一个服务也可以用 REST 给人类前端用——两条入口共用 `service.py` 一套语义，不存在「两个版本的系统」。

## 错误契约

所有失败都返回同一形状，Agent 靠它自我修正：

```json
{
  "code": "E_FONT_MISSING",
  "message": "模板字体缺字：U+7B2C,U+4E00",
  "hint": "换字体或补齐字体文件；禁止静默替换",
  "field": "styles.*.font_family",
  "allowed_values": ["Hiragino Sans GB"],
  "retryable": false,
  "stage": "compiling"
}
```

26 个错误码覆盖 ingest / compile / admission / render / validate / delivery 六个阶段，见 `renderd/errors.py`。

## 目录

```
renderd/
├── renderd/
│   ├── ir.py              IR 校验 / 规范化 / 内容哈希
│   ├── templates.py       模板注册表（3 个内置模板）
│   ├── textlayer.py       文字图层栅格化 + 安全区断言
│   ├── fonts.py           字体解析 + 字形覆盖（notdef 指纹法）
│   ├── compile_ffmpeg.py  IR → FFmpeg filtergraph
│   ├── compile_mlt.py     IR → MLT XML（结构校验）
│   ├── render.py          渲染执行器（进度 / 超时 / 进程组）
│   ├── validate.py        L1/L2/L3 + 证据 + 回执
│   ├── store.py           SQLite 任务存储与队列
│   ├── runner.py          任务编排（6 阶段）
│   ├── worker.py          拉取式 worker
│   ├── service.py         业务门面（REST 与 MCP 共用）
│   ├── api.py             HTTP 服务
│   ├── mcp_stdio.py       MCP 分发（stdio 与 HTTP 共用）
│   ├── auth.py            Bearer / 限流 / 签名 URL
│   └── cli.py             命令行
├── tests/                 58 个用例 + REST/MCP 冒烟脚本
├── docs/                  API / IR / 运维
└── Dockerfile, docker-compose.yml, Makefile
```

## 边界（诚实清单）

- **SQLite 单机**。横向扩要换 `store.py` 的实现，接口已经隔离在一个类里。
- **MLT 后端只做结构校验**，本机无 melt 运行时，不作为默认后端。
- **HDR→SDR 用 `colorspace` 直转**而非 tone curve（本机 ffmpeg 无 zimg），回执里标 `approx_tonemap`。
- **文本越界/缺字一律硬失败**，不做静默替换。
- **不自动删旧产物**。`renderd gc` 默认 dry-run，删除是不可逆操作。
- 模板 3 个，够跑通链路，不够覆盖业务；加模板改 `templates.py` 的 `builtin_templates()` 或往 `var/templates/*.json` 丢文件。
