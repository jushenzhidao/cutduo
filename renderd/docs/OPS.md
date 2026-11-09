# 运维手册

## 部署

### 单机（推荐起步）

```bash
docker compose up --build -d
curl -s localhost:8787/healthz
```

或裸机：

```bash
pip install -r requirements.txt
export RENDERD_TOKENS="$(openssl rand -hex 16):acme"
export RENDERD_SECRET="$(openssl rand -hex 32)"
python3 -m renderd --data-dir /var/lib/renderd serve --workers 4
```

**worker 数**：`--workers N` 是进程内并发。1080p 单条渲染大约吃 2–4 核，`N ≈ 核数 / 4` 起步，用 `renderd bench` 校准。

### 分离部署

API 与 worker 可以分进程/分容器，共用同一个 `/data` 卷（同一个 SQLite）：

```bash
python3 -m renderd serve --workers 0            # 只做 API
python3 -m renderd worker --tenant acme --name w1
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RENDERD_DATA_DIR` | `var` | 数据根目录（DB / 素材 / 成片 / 证据 / 模板） |
| `RENDERD_HOST` / `RENDERD_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `RENDERD_TOKENS` | 空 | `token:tenant,token2:tenantB` |
| `RENDERD_ADMIN_TOKENS` | 空 | `RENDERD_TOKENS` 的子集，多一个「看全局队列」的权限 |
| `RENDERD_AUTH_FAIL_QPS` | 10 | 单个 IP 的**无效令牌**请求上限/秒 |
| `RENDERD_SECRET` | token | 下载签名密钥，**生产必须单独设置** |
| `RENDERD_ALLOW_ANON` | 空 | `1` 时允许无 token（仅本地开发） |
| `RENDERD_WORKER_CONCURRENCY` | 2 | 进程内并发 |
| `RENDERD_LEASE_S` | 120 | 任务租约；worker 崩溃后超过这个时间会被回收重排 |
| `RENDERD_RENDER_TIMEOUT_S` | 1500 | 单条渲染硬超时 |
| `RENDERD_MAX_ATTEMPTS` | 3 | 瞬态错误重试上限 |
| `RENDERD_QUOTA_MINUTES` | 1000 | 新租户默认月配额 |
| `RENDERD_QUOTA_QPS` | 10 | 新租户默认 QPS |
| `RENDERD_MAX_UPLOAD_MB` | 512 | 上传上限 |
| `RENDERD_STORAGE_QUOTA_MB` | 2048 | 新租户默认存储配额 |
| `RENDERD_ASSET_RETENTION_DAYS` | 30 | 孤儿素材 GC 的默认保留天数 |
| `RENDERD_FFMPEG` / `RENDERD_FFPROBE` | ffmpeg / ffprobe | 可指向自编译版本 |

## 健康与观测

| 端点 | 用途 |
|---|---|
| `GET /healthz` | 存活探针，返回引擎版本、字体数、uptime |
| `GET /metrics` | Prometheus：`renderd_jobs_total`、`renderd_jobs{status,stage}`、`renderd_cache_entries`、`renderd_cache_hits_total` |

**建议告警**

| 指标 | 阈值 | 含义 |
|---|---|---|
| `renderd_jobs{status="failed"}` 增长 | >10/小时 | 可能是素材问题集中爆发，或引擎配置被改 |
| `renderd_cache_hits_total` 停滞 | 持续 0 | 缓存键里有不稳定因子（字体 mtime？线程数？） |
| failed 任务中 `E_OUTPUT_INVALID` 占比 | >5% | 断言在拦真问题，去查最近的引擎/字体变更 |
| 队列深度 | >100 持续 10 分钟 | 加 worker 或降级优先级 |

`GET /v1/jobs/{id}/events` 是最有用的排障入口——它记录每个阶段、编译命令、缓存键、失败原因。

## 排障手册

| 现象 | 查什么 | 处理 |
|---|---|---|
| 任务卡在 `running` 不结束 | `events` 最后一条；`ps` 看 ffmpeg 是否僵尸 | 等 `LEASE_S` 过期自动回收；或重启 worker 进程 |
| 全部任务 `E_MEDIA_MISSING` | 素材 URI 是否绝对路径 / 卷是否挂上 | 容器里 `file:///data/...` 要指向卷内真实路径 |
| 突然大面积 `E_FONT_MISSING` | 镜像是否换了字体包 | 字体变了字形像素就变，回滚镜像；不要"补个字体凑合" |
| 缓存命中率骤降 | 字体 mtime、线程数、`engine` 版本 | 缓存键含这三者；任一变化都会全量失效 |
| 同一条 IR 两次渲染字节不同 | 是否有人改了 `-crf` 成 `-b:v` | 见下节「确定性」 |
| 渲染超时 | 素材是否 4K/10bit、是否多轨叠加 | 调 `RENDER_TIMEOUT_S` 或换更快的 preset |

## 确定性：三条不能碰的线

「同 IR 两次渲染字节一致」是产品承诺，靠三件事守住：

1. **码率控制必须是 capped CRF**（`-crf` + `-maxrate` + `-bufsize`）。
   改成 `-b:v`（ABR/CBR）后，`-threads > 1` 会让 x264 的 VBV 状态逐次微移，两次输出差 1–12KB。
2. **线程数固定**（默认 4）并写进缓存键。
3. **字体固定**。字体文件变了，字形像素就变；`fonts_digest` 只取 `name|size|mtime_ns`，换字体文件必然失效缓存。

> 回归手段：`cd tests && python3 -m unittest test_integration.TestRenderPipeline.test_02_byte_determinism_without_cache`

## 备份与恢复

需要备份的只有 `$RENDERD_DATA_DIR` 下的三样：

| 路径 | 内容 | 可否重建 |
|---|---|---|
| `renderd.sqlite3` | 任务、租户、配额、缓存索引 | 不能（审计与计费依据） |
| `media/` | 上传素材（按 sha256 命名） | 客户有原件则可重建 |
| `templates/` | 模板 JSON | 可以从代码 seed 重建，但客户改过的不能 |

`out/` 与 `evidence/` 可以丢——重跑即可（缓存会失效但结果一致）。

**热备份**：SQLite 在 WAL 模式下，用 `sqlite3 renderd.sqlite3 ".backup '/backup/r.sqlite3'"`，不要直接 `cp`。

## 磁盘与素材回收

单条 1080p/15s 成片约 5–12MB，证据图约 300KB。按「日成片数 × 15MB × 保留天数」估。

素材（`media/`）按 sha256 内容寻址，**配额按引用计**：

```bash
python3 -m renderd assets --tenant acme            # 看该租户的引用与占用
curl -X DELETE /v1/assets/asset_8f3d9d13546e       # 客户端主动释放（在途任务引用中会 409）
python3 -m renderd gc --assets --older-days 30              # dry-run：只报孤儿
python3 -m renderd gc --assets --older-days 30 --apply      # 真删（不可逆）
```

- **孤儿** = 上传后从未进入任何任务 IR 的文件（校验失败、试探上传、被替换的版本）。
  被任何任务引用过的都不动 —— 删了会让 `replay` 直接 `E_MEDIA_MISSING`。
- 老库迁移出来的 `legacy:<tenant>` 行没有对应文件，GC 跳过；那部分只能由管理员在库里清零。
- `usage.bytes` 字段保留为历史计费记录，**配额判断已改为 `asset_refs` 求和**
  （同一个文件被多个租户引用时，只有实际写盘的租户计费）。

```bash
python3 -m renderd gc --older-days 7          # dry-run，只报告
python3 -m renderd gc --older-days 7 --apply  # 真删（不可逆）
```

**不提供自动清理定时任务**——删除是不可逆操作，必须由外部调度器显式调用并留痕。

## 扩缩容

| 规模 | 方案 |
|---|---|
| < 500 条/天 | 单机 docker compose，2–4 worker |
| 500–5000 条/天 | 多 worker 容器共享一个 `/data` 卷；渲染与 API 分离 |
| > 5000 条/天 | **必须换掉 SQLite**：把 `store.py` 换成 Postgres 实现（接口已隔离在一个类里），队列改 `SELECT … FOR UPDATE SKIP LOCKED` 或 Redis `BRPOPLPUSH` |

不要在没有换 store 的情况下把 SQLite 放到 NFS 上跑多机——文件锁语义不保证，会双领。

### 缓存键与 `COMPILE_REV`

渲染缓存键由「IR 内容 + 后端 + ffmpeg 版本 + 字体指纹 + 目标规格 + 编码参数指纹」算出。
其中编码参数指纹 = `compile_ffmpeg.encoder_signature(ir)`，它同时包含：

- IR 里的编码参数（codec / tag / preset / crf / gop / 音频规格）
- **编译器版本 `compile_ffmpeg.COMPILE_REV`**

第二条是必须的。缓存键由 IR 算出，但同一份 IR 在不同版本的编译器下会产出不同字节。
实测踩过：HEVC tag 从 `hev1` 改成 `hvc1`，IR 一个字段都没动，键不变，
线上继续返回旧的 `hev1` 成片（Safari 播不了）。

因此：**改动 argv 构造方式（滤镜、tag、码控参数）时必须 `COMPILE_REV += 1`。**
代价是全部渲染缓存失效一次，这是有意的 —— 宁可重算，也不要让用户拿到与当前代码
不一致的产物。

```python
# renderd/compile_ffmpeg.py
COMPILE_REV = 4      # 4: fit=blur；3: 转场/音量/alpha/字幕
```

`tests/test_codec_branches.py::test_05` 钉住「改 rev 必须改签名」，
`test_07` 钉住「换 preset / 换 backend 必须换键」。

### MLT 后端（可选，`backend=mlt`）

默认镜像**不带** melt。需要时：

```bash
make docker-build-mlt                      # renderd:0.1.0-mlt，镜像约 1.48GB（默认 1.03GB）
docker run --rm -p 8787:8787 -e RENDERD_TOKENS=devtoken:acme renderd:0.1.0-mlt
make test-mlt                              # 结构 4 项 + 真渲染 4 项（8 项，含 hevc tag）
```

默认镜像上请求 `backend=mlt` 会返回 `E_RENDER_FAILED`（「需要 melt 运行时」），不会静默降级。

三个已知差异（都已在 `tests/test_mlt_backend.py` 里钉住）：

| 差异 | 处理 |
|---|---|
| **MLT 写 HEVC 用 `hev1`** | 出片后统一走 `finalize_argv`，写 `hvc1`（视频 copy） |
| MLT 没有 LUFS 目标 | 同一道补 `loudnorm`（只重编音频、视频 copy） |
| 音频轨到最后一个片段就结束 | 同一道补 `apad` + `atrim`，对齐时间线时长 |
| 字节确定性未承诺 | 缓存键含 backend，MLT 与 ffmpeg 的结果不会互相污染 |
| 容器规范化是**必跑**步骤 | 不再是「有音轨才补」—— 无音轨也要写 tag |
| **转场未实现** | MLT 编译前直接 `E_IR_UNSUPPORTED`，不会静默变成硬切 |
| 音量已支持 | 写成 entry 级 `volume` filter（MLT 没有轨道增益） |

### 什么时候才需要 Redis / 外部队列

先看实测（本机 Colima，PG 经端口映射；集群内会更高）：

| 路径 | SQLite | PostgreSQL |
|---|---|---|
| 准入写（`rate_hit`，同一租户同一行） | 6,501 次/秒 | 1,515 次/秒 |
| 状态读（`/v1/jobs/{id}` 含租户查询） | 10,308 次/秒 | 6,216 次/秒 |

结论：当前「每分钟几个任务」的负载，离上限差 2–3 个数量级，**引入 Redis 只会多一个要维护的 HA 组件**。

三条触发条件（任一满足再评估）：

1. 准入 p95 > 5ms，或数据库 CPU 持续 > 30%；
2. 全站 API 持续 > 500 req/s（约为实测 PG 上限的 1/3）；
3. 状态轮询 > 2k 次/秒（约 6k 个并发轮询的 Agent）。

即使触发，边界也是固定的：

- Redis **只**承担「可丢的高频计数」与「读缓存」，失效时自动回落到数据库；
- 任务状态、幂等键、配额台账、审计**不进** Redis —— 它们必须能对账；
- 队列仍然用 `jobs` 表：把队列搬进 Redis 会同时失去「可查询」和「与业务同事务」两个性质。

## 升级

1. 备份 `renderd.sqlite3`。
2. 换镜像/代码，重启 worker（在跑的会被 `LEASE_S` 后回收重排）。
3. **升级 ffmpeg 会让所有缓存失效**（缓存键含引擎版本），这是刻意的：宁可重渲，不要返回跟当前代码不一致的片。
4. 升级后跑一次 `make integ`，重点看 `test_02_byte_determinism_without_cache`。

## 安全

- 非 root 运行（镜像里 `uid=10001`）。
- token 与租户一一映射；下载链接签名默认 1 小时过期。
- `evidence` 与 `video` 端点都会校验归属：带 token 时校验租户，不带时校验签名。
- 素材与成片路径不接受外部传入的任意路径——URI 只允许 `file://` 绝对路径、`upload:<name>` 或相对 `media/` 的名字；`evidence` 文件名会做 `Path(name).name` 净化。


---

## 输入归一化（续轮新增，默认开启）

```bash
RENDERD_INGEST_NORMALIZE=1        # 0 关闭（不建议）
RENDERD_INGEST_CROPDETECT=1       # 黑边检测，宽高不等的素材才跑
RENDERD_MAX_ASSET_SECONDS=3600    # 单素材时长上限
```

流水线：`_probe_assets`（路径围栏 / 分辨率上限）→ `Normalizer.precheck`（提交期抽样解码）
→ `Normalizer.run`（执行期归一化）→ `_check_length`（用 canonical 帧数复核）→ 编译。

产物在 `data/mezz/<key>.mp4`，配套的 `<key>.json` 是**决策单**：probe 标记、动作序列、
每条动作的触发原因、归一化后的实测规格。客户问「我的 HDR 素材为什么变成这样」时，
把这份 JSON 拿出来对账即可。key 由「源文件指纹 + 动作 + 目标规格 + 引擎版本」算出，
引擎升级、动作变化、模板帧率变化都会自动失效缓存，不会拿旧片交付。

**必须留痕**：所有动作与警告都写进 `receipt.L0_ingest` 与 `receipt.warnings`。
静默改变素材语义是交付事故；宁可让客户看到「已回退 / 已补静音 / HDR 已做预览级 tone mapping」。

**截断文件在提交期就被拦下**：c09 这类元数据完全健康、只有真解码才报错的素材，
以前会在 worker 阶段莫名失败。`Normalizer.precheck()` 抽样解码前 15 秒，失败直接
`422 E_INPUT_TRUNCATED`，Agent 拿到的是可执行错误而不是异步失败。

## 存储配额

```bash
RENDERD_STORAGE_QUOTA_MB=2048                       # 新租户默认
python -m renderd tenant --name acme --storage-mb 4096
curl -H "Authorization: Bearer <t>" /v1/usage       # 看 storage_used_mb / storage_quota_mb
```

`usage.bytes` 按月写、`storage_used_bytes()` 跨月求和 —— 文件不会因为月份翻篇就消失。
`put_asset()` 在锁内完成「查配额 → 写 → 计数」，内容寻址去重后重复上传不重复计费。
超限 `413 E_QUOTA_STORAGE_EXCEEDED`。

## 出网与 webhook

所有出网请求（webhook / 成片直传）统一走 `netguard.py`：提交期解析并钉住 IP，
投递期直连该 IP，不做二次解析。默认拒绝私网/回环/链路本地/保留地址。

```bash
RENDERD_ALLOW_PRIVATE_CALLBACKS=1   # 本地联调（127.0.0.1 收端）才开，生产禁止
RENDERD_ALLOW_ARBITRARY_PATHS=1     # 本地直接引用绝对路径素材，生产禁止
```

## TLS 与网关

```bash
./deploy/make-dev-cert.sh                             # 自签证书，仅供本地验证
RENDERD_TLS_CERT=... RENDERD_TLS_KEY=... python -m renderd serve   # 服务内置 TLS
RENDERD_METRICS_CIDRS="127.0.0.1/32,10.0.0.0/8"      # /metrics 来源白名单
docker compose -f docker-compose.tls.yml up -d --build  # Caddy 反代，8443
make test-gateway                                     # 端到端 10 项
```

生产请把 `deploy/Caddyfile` 的 `tls` 行换成 ACME（`tls you@example.com`），
并去掉 `auto_https off`。`deploy/nginx.conf` 是不用 Caddy 时的等价备选。

## Colima 环境固化

VM 内 `/etc/resolv.conf` 是断链、`registry-1.docker.io` 在部分网络被劫持，重建 VM 会丢修复。
`deploy/colima-bootstrap.sh` 幂等地重建这两处配置并验证镜像可拉取：

```bash
COLIMA_HOST_DNS=192.168.112.1 ./deploy/colima-bootstrap.sh
```

BuildKit 插件缺失时退回传统 builder：`DOCKER_BUILDKIT=0 docker build -t renderd:0.1.0 .`

---

## 生产级异步（续轮 2 新增）

上一版的队列「可靠但盲」：能不丢不错，但堆积时看不见、刹不住。这一轮补齐四件。

### 队列可观测

```bash
make queue                       # 或 renderd queue
curl -H "Authorization: Bearer <t>" /v1/queue
curl -sk https://.../metrics | grep renderd_queue
```

`Store.queue_stats()` 返回：`depth`（accepted 总数）、`ready`（可立即领取）、
`delayed`（退避中）、`running`、`oldest_wait_s`（最老一条已等待多久）、
`next_lease_s`、`inflight_by_tenant`、`failed_24h`。

`/metrics` 新增 7 个 gauge：`renderd_queue_depth` / `renderd_queue_ready` /
`renderd_queue_delayed` / `renderd_jobs_running` / `renderd_queue_oldest_wait_seconds` /
`renderd_failed_jobs_24h` / `renderd_tenant_inflight{tenant="…"}`。

**告警建议**：`oldest_wait_s > 120` 或 `depth > max_queue_depth * 0.6` 就该扩容 worker；
`failed_24h` 突增优先看 DLQ 而不是翻日志。

### 背压

```bash
RENDERD_MAX_QUEUE_DEPTH=2000          # 全局 accepted 上限
RENDERD_MAX_TENANT_INFLIGHT=8         # 单租户 accepted+running 上限
```

两道都在 `Service.submit()` 的「dry_run 之后、INSERT 之前」检查，超限
`429 E_QUEUE_FULL`（`retryable=true`，客户端可稍后重试）。`dry_run` 只试算不占队列，
所以不会被背压拦。`GET /v1/usage` 新增 `inflight` / `inflight_limit`。

这道护栏解决的是最常见的事故形态：一个租户批量灌任务，让所有其他租户排几小时队。

### 重试退避

`jobs` 新增 `available_at` 列（含存量库的 `ALTER TABLE` 迁移）。
`claim()` 的子查询加 `AND (available_at IS NULL OR available_at <= now)`；
`fail()` 在可重试时写 `available_at = now + base × attempts²`：

```bash
RENDERD_RETRY_BACKOFF_BASE_S=1.0      # 默认 1s / 4s / 9s
```

没有这一层，NVENC 会话满、OOM 这类瞬态错误会在几秒内连烧完 3 次 attempts 然后判死。
确定性失败（`E_FONT_MISSING` / `E_OUTPUT_INVALID`）不设退避，直接进死信。
`recover_expired()` 重排时清空 `available_at`（猝死回收应立即重试，不叠加退避）。

### 死信、重放与主动归还

```bash
renderd dlq --tenant acme --limit 50        # 或 GET /v1/dlq?limit=50
renderd replay --job-id job_xxx --tenant acme   # 或 POST /v1/jobs/{id}/replay
renderd release --worker w1                 # 确认进程已退出后，主动归还其 running 任务
```

`replay` 就地改回 `accepted`、重置 `attempts=0`、清空错误，不新建任务（幂等键仍在）。
DLQ 查询按 tenant 隔离。`release` 只给运维手动用，**刻意不做成 SIGTERM 自动行为**。

### 优雅退出的正确语义

`Dockerfile` 加 `STOPSIGNAL SIGTERM`，两个 compose 文件的 api / worker 加
`stop_grace_period: 300s`。`Worker.stop()` 的语义是「不再取新任务，当前这条跑完」。

**不要**在 SIGTERM 时把 running 任务自动改回 `accepted`：原进程可能还在跑 ffmpeg，
新 worker 会立刻领走 → 双领。正确性事故比晚几十秒回收严重得多。
reaper 只兜底真正的猝死；确认进程已退出时用 `renderd release --worker` 提前收回。

### webhook 去重

回调 payload 新增 `event_id = "{job_id}:{status}:{attempts}"` 与 `attempt`。
投递是 at-least-once（失败重试 1 次），**收端必须按 `event_id` 幂等**：
同一次尝试的重发持有同一个键，重放 / 新尝试则不同。

---

## PG 后端（多 pod / 无单点）

上一版的边界是「单机 + 本地卷」：SQLite WAL 要求所有进程共享同一台主机的内存，
一旦跨节点或在 NFS/EFS 卷上就不成立。这一轮把状态层换成可切换的 Postgres。

```bash
# 1. 起 PG（本机 Colima 验证用；生产换成托管 PG）
docker run -d --name renderd-pg -p 5433:5432 \
  -e POSTGRES_USER=renderd -e POSTGRES_PASSWORD=renderd_local \
  -e POSTGRES_DB=renderd postgres:16-alpine

# 2. 同一套用例切到 PG
export RENDERD_DB_DSN="postgresql://renderd:renderd_local@127.0.0.1:5433/renderd"
make test                       # 85 个用例，含真 PG 连通性检查

# 3. 分离部署（api / worker 可各自扩副本）
docker compose -f docker-compose.pg.yml up -d --build
```

### 环境变量

| 变量 | 作用 |
|---|---|
| `RENDERD_DB_DSN` | 设置即切到 PG；不设就是零外部依赖的 SQLite 单机模式 |
| `RENDERD_PG_SCHEMA` | **生产必须显式指定且所有进程一致**；不指定时每个实例自动隔离（unittest 用） |

`Store()` 是工厂函数：`SqliteStore` 原样保留，`PostgresStore` 用连接层方言代理
（`?` → `%s`、Decimal 归一化）复用全部 45 条 SQL，只 override 三处语义差异：

1. `submit()` → `INSERT … ON CONFLICT (tenant,idem_key) DO NOTHING`（PG 无法推断
   `SELECT %s,…` 的参数类型，且并发下唯一约束更稳）
2. `claim()` → 子查询加 `FOR UPDATE SKIP LOCKED`（否则多 worker 互相等行锁）
3. `tx()` → 无 `BEGIN IMMEDIATE`，串行化交给行锁而不是全库写锁

DDL 由 `_pg_ddl()` 从 SQLite 的 `SCHEMA` 自动翻译（`AUTOINCREMENT → BIGSERIAL`、
`REAL → DOUBLE PRECISION`），两套 schema 永远同步，不会改了一边忘了另一边。

### 实测（PostgreSQL 16.15 / aarch64 @ Colima）

```
unittest discover     PG 85/85 (88.9s)   SQLite 85/85 (80.8s)
对抗测试               PG 51/51, critical 0
21 条脏语料            PG PASS（18 归一 / 3 硬失败 / 4 端到端 pass）
镜像内 psycopg         3.3.8，compose.pg 语法校验通过
```

### 仍未解决的前提

`docker-compose.pg.yml` 里 api 与 worker 仍共用 `renderd-data` 卷存放素材 / 成片 /
mezz 中间片。**状态已经可以多机，文件还没有**：真正多 pod 要把这一卷换成对象存储，
`render_cache.output_path` 也从本地路径改成 URL。这是下一步，不是配置问题。

## 异步架构复审（五条路径）

按「领取 / 心跳 / 回收 / 投递 / 预检」逐条审，实测数据见
`../deliverables/落地总报告.html` §10 与 `var/pg_regression/evidence.json`。

### 已落地两项

**① `queue_stats` 从 O(历史行数) 变成 O(活跃行数)**。主聚合原本
`SELECT SUM(CASE …) FROM jobs` 无 WHERE，每次 `/metrics` 抓取、**每次提交做背压检查**
都要扫全部历史任务。实测：

```
历史 1k / 10k / 50k / 100k 行
优化前  0.133 / 1.290 / 7.774 / 15.270 ms
优化后  0.036 / 0.013 / 0.027 / 0.029 ms   （10 万行约 527×）
```

改法：主聚合加 `WHERE status IN ('accepted','running')`，`failed_24h` 加部分索引
`WHERE status='failed'`（索引同时进 SCHEMA 与 `_migrate()`，存量库也会补建）。

**② 事件写入合并进主事务**。`submit / claim / set_stage / succeed / fail /
recover_expired / release_worker / replay` 原本每个动作开两个写事务
（UPDATE jobs + INSERT job_events），按调用点统计一条任务约 24 次写事务；
合并后约 12 次，且状态与事件原子落库。PG 下每次事务都是一次网络往返，收益更明显。

### 明确暂缓（P1）

| 问题 | 实测 | 为什么这轮不做 |
|---|---|---|
| webhook 同步投递阻塞 worker | 收端不响应时 `_notify()` 耗时 **16.52s**（8s × 2 次），期间 worker 不能领下一条 | 改成持久化 outbox + dispatcher 会把投递从同步变异步，是客户可观察的时序契约变更；要新增表、改 4 个用例 |
| 优先级无时间衰减 | `ORDER BY priority DESC, created_at` 会让低优先级永久饥饿 | 需要引入等待时长权重，属于调度策略变更 |
| reaper 重复扫 | API 一个 + 每个 worker 每 20 tick 一次 | `UPDATE … RETURNING` 幂等，只是浪费；规模上来再说 |
| 提交期抽样解码 | 新素材预检 1–3s 占用 HTTP 请求线程 | 需要把预检挪到异步或加探针结果缓存，涉及错误返回时机 |

**outbox 的正确形态**（下一轮照这个做）：新增 `webhook_outbox` 表存
`event_id / payload / pin / attempts / available_at / delivered_at`；
`_notify` 只做一次 INSERT；独立 dispatcher 用 `UPDATE … RETURNING` 领取并投递，
失败按退避重排。多 pod 下内存线程队列会丢回调，所以必须落库。

---

## 签名密钥与时钟（续轮 4）

### 密钥

```bash
# 单机：不配置即可，服务会在 data_dir 生成随机密钥（0600，重启复用）
python -m renderd doctor          # 看 "signing secret 非弱值  source=generated/file"

# 多实例 / 多 pod：必须显式设置且各实例一致
export RENDERD_SECRET=$(openssl rand -hex 32)
```

`change-me`、`renderd-dev-secret` 等已知占位值会让服务**启动失败** ——
这是刻意的：签名 URL 的安全性完全来自密钥熵，用可预测默认值等于没有签名。
三个 compose 文件的 `RENDERD_SECRET` 默认值已清空，不再注入弱值。

### 时间：单一时钟源（HLC）

租约、退避、超时**不用墙钟**。`store.db_now()` 的语义是：

```
逻辑时间 = 锚点(墙钟, 单调钟) + 单调钟增量
```

墙钟只用来**观测**跳变（`|wall - logical|` 变化 >5s 判定为跳变），不参与计算。
落库的 `clock.last_ts` 只前进不回退，所有实例通过它对齐；
`jobs.created_at/started_at/lease_until/available_at` 等全部是逻辑时间。

因此：

- 墙钟前跳 1 小时 → 逻辑时间不动 → 不会有 running 任务被判过期（不会双领）
- 墙钟回拨 1 小时 → 逻辑时间不回退 → 已发出的租约不会重新有效
- 断电重启 → 以墙钟重建锚点；若库里的 `last_ts` 更大则以前者为准（HLC receive）

```bash
curl /v1/queue | jq .clock_skew_s          # 最近一次跳变幅度（跨实例可见）
curl /metrics | grep renderd_clock_skew    # 同名 gauge
sqlite3 var/renderd.sqlite3 "select * from clock_events order by id desc limit 5"
```

**代价**：跳变被吸收后，逻辑时间与墙钟的偏移不会自动回归（重启才重新对齐）。
本服务只用相对时长与日历月计费，不受影响；但排查问题时要知道 `created_at`
是逻辑时间，不是严格墙钟。详见 `blockers.md` §8.2。

### 准入：限流与存储配额（续轮 5）

两者都在共享存储里，多副本共享同一个预算 —— 不需要 Redis，也不会随副本数放大。

```bash
# 租户 QPS：20 个 50ms 子桶的 1 秒滑动窗口（rate_window）
renderd tenant --id acme --qps 5

# 存储配额：上传前预占、写失败/去重则退款（usage.bytes 跨月求和）
renderd tenant --id acme --storage-mb 1024
curl /v1/usage | jq '{storage_used_bytes,storage_quota_mb,qps}'
```

- 超限返回 `429 E_RATE_LIMITED` / `413 E_QUOTA_STORAGE_EXCEEDED`，`retryable=true`
- `rate_window` 每个租户常驻 ≤21 行（每秒自清，`renderd gc` 兜底）
- 单次准入成本：SQLite p50 0.015ms；PG p50 1.5ms（含 1 次往返，集群内更低）
- 反向代理层的**全局**限流仍需在网关做（`deploy/nginx.conf` 的 `limit_req`，默认未开）

验证多副本行为：

```bash
./tests/multi_replica.sh     # 3 个 API 容器 + 同一个 PG，3 项断言
```
