# blockers.md

未解决事项。每条写清：卡在哪、影响什么、需要什么才能解。

> **本轮（「继续 全部完成」）已关闭 6 条**：HDR/黑边/旋转归一化、DNS rebinding、存储配额、
> webhook 端到端测试、对象存储交付、TLS/WAF、长稳样本不足、Colima 环境未固化。
> 由 9 条 P0/P1 + 环境限制 → 剩 3 条，且全部是「需要外部输入」或「刻意的产品/架构选择」，
> 没有一条是「代码没写完」。
>
> **续轮 2（「继续做」）**：上一轮验收后又审计出 6 项「生产级异步」缺口，
> 已全部关闭（见 §二末）。另有 2 项 P1 明确暂缓，已列入 §三 P2 表。
>
> **续轮 5（「1-3 解决下」）**：上一轮「仍未解决」的三条全部关闭 ——
> 进程内限流/配额（P0）、墙钟跳变只缓解、签名 URL 不绑租户。
> 3 副本容器实测：5 QPS 不再变 15，1MB 配额不再写成 1.34MB。
> 现在还剩 **2 条**：真实客户素材回归、HDR 调色定位（都要外部输入）；
> 架构侧唯一未做的是「文件卷跨机」（§8.1）与 webhook outbox（§6.2）。

---

## 一、仍然保留（3 条）

### 1. 没有真实客户素材回归（P0 性质，但需外部输入）

**现状**：`cutproof/corpus` 的 21 条脏素材已全部接进 `renderd` 服务内引擎回归
（`tests/ingest_corpus.py`），覆盖 HLG HDR、VFR 时间戳断档、旋转显示矩阵、10bit 无标记、
无音轨、单声道 44.1k、5.1 声道、0 字节、截断、超长、黑边、屏录、120fps、非方形像素、
隔行、老容器、内嵌字幕、多音轨、纯音频、奇数分辨率，以及 1 条干净对照组。

**缺的是什么**：合成素材覆盖的是**故障模式**，覆盖不了真实拍摄素材的噪声分布、
真实字体渲染的复杂字形连写、真实音乐床的响度分布、真实手机拍摄的旋转/色彩元数据组合。

**需要什么**：50–100 条真实客户素材（脱敏），跑一次
`python3 tests/ingest_corpus.py` 的扩展版 + 一次人工抽帧复核。
在此之前，「能用」的结论只对合成素材与 lavfi 素材成立。

### 2. SQLite 只支持单机 —— **已关闭（09:58，PG 双后端落地）**

原记录：`store.py` 把队列、租户、配额、缓存、审计全放在一个 SQLite 文件里，
适用规模是单机 2–4 worker。SQLite 官方明确 WAL 不支持网络文件系统。

**本轮已解**：`Store()` 改成工厂函数，新增 `renderd/store_pg.py`；
在 Colima 起 PostgreSQL 16.15，同一套 85 个用例、51 项对抗、21 条语料在两套后端各跑一遍，
全绿。生产入口是 `docker-compose.pg.yml`（api / worker 可各自扩副本）。
**没有引入 Redis**：租约靠 PG 的 `FOR UPDATE SKIP LOCKED` 与 `jobs.lease_until` 就够了，
状态、配额、审计、幂等全部留在同一个关系型存储里，出事故才能对账。

**仍需注意**：不设 `RENDERD_DB_DSN` 时仍是单机 SQLite（默认、零依赖），
且 `RENDERD_PG_SCHEMA` 在生产必须所有进程一致。另见下方 §六「文件卷仍未多机化」。

### 3. HDR 是预览级 tone mapping，不是广播级调色（产品定位）

`zscale 线性光 → hable tonemap → BT.709` 比「直接 format=yuv420p」正确得多，
但它没有创作意图：高光滚降、肤色、HLG 场景光级别都需要人工判断。
`receipt.L0_ingest` 里对每条 HDR 素材都明确写了「预览级处理，不是广播级调色」。

**需要什么**：先拿到客户素材里 HDR 的占比与调色预期，再决定上 libplacebo、
加 LUT 通道，还是把 HDR 素材标记成「需人工复核」直接拒绝自动出片。

---

## 二、本轮已关闭（留档，便于验收时对照）

| # | 原事项 | 怎么关的 | 实证 |
|---|---|---|---|
| 1 | HDR / 黑边 / 旋转归一化未接入服务 | `renderd/ingest.py` 三段式 probe/decide/normalize 接进 `ingesting` 阶段；目标 fps 取 IR；决策单落盘；`L0_ingest` 进回执 | 21 条语料：18 条归一、3 条按预期拒绝；8 项断言 + 4 条端到端全 PASS |
| 2 | DNS rebinding 绕过 SSRF | `netguard.py` 钉 IP，投递期手写 HTTP/1.1 over pinned socket，零二次解析；IPv4 优先 + 备选重试 | `test_hardening.test_04`：投递期 DNS 全挂仍送达；F07/F08 交付链路无后门 |
| 3 | `/v1/assets` 无存储配额 | `usage.bytes` + `tenants.storage_mb`，锁内校验、内容寻址去重、跨月求和 | F06：1MB 配额租户第二次上传 413 |
| 6 | webhook 只有代码没有测试 | `tests/test_hardening.py` 真起 `http.server` 收端 | 9/9：成功 / 500 重试 / 不可达降级 / DNS rebinding / 直传 / 配额 / 白名单 |
| 7 | 没有对象存储交付 | `delivery.put_url` 直传客户预签名 PUT 地址，出口流量不经我方 | 收端实测 PUT 真实 MP4、200、回执 `status=delivered`；失败留痕 |
| 8 | 无 TLS / 无 WAF | 服务内置可选 TLS + `/metrics` 来源白名单；`Caddyfile` / `nginx.conf` / `docker-compose.tls.yml` | `tls_smoke.sh` 6/6、`gateway_e2e.sh` 10/10 |
| 9 | 长稳样本不足（30 条） | 500 条混合负载，每 100 条采样内存/磁盘 | 见 `result.md` §四与 `progress.md` 最终里程碑 |
| 环境 | Colima DNS / mirror 修复重建 VM 会丢 | `deploy/colima-bootstrap.sh` 幂等固化 | `bash -n` 语法通过；镜像可重复拉取 |

### 续轮 2 新关闭（生产级异步）

| 缺口 | 怎么关的 | 实证 |
|---|---|---|
| 队列堆积看不见 | `Store.queue_stats()` + `/metrics` 7 个 gauge + `GET /v1/queue` | 容器内端点/CLI/指标实测 PASS |
| 单租户可灌满队列 | 全局 depth + 租户 inflight 两道背压，超限 `E_QUEUE_FULL` | `test_03/04/05` 通过 |
| 瞬态错误连烧重试 | `available_at` + `base × attempts²` | `test_06/07` 通过，退避期内 claim 取不到 |
| failed 任务无法对账重放 | DLQ 视图 / replay / release + 3 个 REST 端点 + 3 个 CLI | `test_08/09` 通过 |
| 优雅退出配置缺失 | `STOPSIGNAL SIGTERM` + `stop_grace_period: 300s` | compose 语法校验 + `test_11` 静态断言 |
| webhook 无去重键 | `event_id = job_id:status:attempts` | `test_10` 真收端验证同键重发 |

---

## 三、P2 · 已知但刻意不做

| 事项 | 为什么不做 |
|---|---|
| 多轨视频叠加（overlay 带 alpha） | 按全画幅叠加，源无 alpha 会遮挡下层；模板体系还没到需要画中画 |
| 字幕资产通道（内嵌字幕转 SRT/ASS） | 归一化时丢弃并**写进 warnings**；要做需先设计字幕资产在 IR 里的表示 |
| 自动清理旧产物 | 删除不可逆，只提供 `renderd gc`（默认 dry-run）；新增 `mezz_files`/`mezz_bytes` 只读占用报告 |
| 签名 URL 绑定租户 | 当前是 S3 presigned 语义（泄露即失效）；需要时把 tenant 签进 sig |
| 多进程共享 GPU 编码会话 | 本机无 GPU 编码路径，未验证 |
| 运行中任务取消 | 需要能安全终止 ffmpeg 子进程；当前 `cancel` 只支持 `accepted`。自动归还 running 会造成双领，必须先做进程组管理 |
| SSE / WebSocket 推送替代轮询 | 当前 `poll_after_s=3` + webhook 足够；推送要引入连接管理与断线重放，等有实时性需求再做 |
| ~~MLT 后端跨端一致性~~ | **已关闭（14:20，见 §十）**：装了 melt 的镜像里已能真实出片 |

---

## 四、环境备注（不再是 blocker）

| 限制 | 现状 |
|---|---|
| Colima VM 内 `/etc/resolv.conf` 断链 | 已写进 `deploy/colima-bootstrap.sh`，重建 VM 跑一次即可 |
| `registry-1.docker.io` 被劫持 | 四个 mirror 已写进 bootstrap 脚本的 `daemon.json` |
| BuildKit / buildx 缺失 | 用传统 builder，构建约 1 分钟，可接受 |
| 镜像内 ffmpeg 7.1.5 / 宿主机 9.0.2 | 两套版本的归一化滤镜链都实测可用；缓存键含引擎版本，不会串 |

---

## 五、新发现：进程内状态在多实例下失效（09:34）—— **已关闭，见 §6.1**

全仓没有 Redis；大部分状态在 SQLite 里天然跨实例，但有两处曾是**进程内内存**，
单实例成立、多实例立刻失效。此前 80 个用例 / 51 项对抗 / 51 项容器测试全部跑在**单 API 实例**上，
所以没有暴露。以下为当时的实测记录（留档）。

用 fork 起 2–3 个独立 `Service`（共享同一 SQLite 文件）实测，脚本 `/tmp/redis_gap_probe.py`：

```
API 实例=1  1 秒内通过= 5   租户声明上限 qps=5   放大 1.0x
API 实例=2  1 秒内通过=10                        放大 2.0x
API 实例=3  1 秒内通过=15                        放大 3.0x

2 实例并发上传 2×700KB → 两边都判定 accepted
                        实际写入 1.34MB / 配额 1MB（usage 记录也是 1.34MB）
```

| 位置 | 问题 | 影响 |
|---|---|---|
| `auth.py:70` `RateLimiter`（`deque` + `threading.Lock`），`service.py:66` 调用 | 每实例独立计数，N 个实例 = N× QPS | 限流形同虚设；攻击用例 D07 只在单实例测过 |
| `service.py:48` `_upload_lock`（`threading.Lock`），`service.py:88` 包住「查配额→写→计数」 | 锁不跨进程，两个实例同时读到 used=0 | 存储配额可并发绕过；F06 也只在单实例测过 |

**对照组**：`queue_stats()` 背压、`claim()`、`recover_expired()`、幂等键、用量、缓存全部走 DB，
天然跨实例 —— 这正是「状态放 DB」的价值，也说明问题只在这两处，不在整体架构。

**建议修法（不要为此引入 Redis 当队列）**：把这两处移进 DB 事务即可 ——
限流用带 TTL 的计数表 + `BEGIN IMMEDIATE`（或 PG 的 `INSERT … ON CONFLICT DO UPDATE`），
上传配额把「查→写→计数」包进同一个写事务。Redis 只在 QPS 高到 DB 计数成为热点时才值得引入，
且只承担**可丢的高频计数**，不承担任务状态 / 配额 / 审计 / 幂等（分在多个存储里出事故无法对账）。

**触发条件**：只要出现第 2 个 API 实例（滚动升级、K8s 多副本、控制面选 Argo/Step Functions/Temporal），
这两条就从「理论缺陷」变成「线上事故」。与上一节 SQLite 的判定同源：**单机前提**。

---

## 六、本轮（PG 双后端）之后的未解决事项（10:02）

### 6.1 两处进程内状态 —— **已关闭（11:05，共享存储仲裁 + 三副本容器实测）**

原记录：`API 实例 1/2/3 → 5 / 10 / 15 QPS（租户上限 5）`、`2 实例并发上传 → 1MB 配额被写成 1.34MB`。

**已解**：

| 位置 | 原实现 | 现实现 | 实测 |
|---|---|---|---|
| 限流 | `auth.RateLimiter`：进程内 `deque` + `Lock` | `store.rate_hit()`：`rate_window(tenant,bucket,hits)`，20 个 50ms 子桶滑窗，**一条 SQL** 完成「读窗口→判满→记账」 | 3 副本：5 放行 / 1 拒绝（期望 ≤6）；单实例 40 连发出现 429 |
| 上传配额 | `service._upload_lock`：进程内 `Lock` 包住「查→写→计数」 | `store.storage_reserve()`：一个写事务内完成「查已用→预占→记账」，PG 用 `SELECT … FOR UPDATE` 锁租户行；写入用 `O_CREAT\|O_EXCL` 原子创建，失败/重复则退款 | 3 副本并发 3×700KB：1 成功 / 2 拒绝，记账 700000 字节 |

**为什么不是引入 Redis**：限流与配额都要求「拒绝即确定」，属可对账状态。
放 Redis 会让状态分裂到两个存储，出事故无法回溯；放同一个关系库，`usage`/`rate_window`/`jobs` 在同一个事务域里。
成本实测：`rate_hit` SQLite p50 0.015ms、PG p50 1.52ms（本机经 Colima 端口映射，含 1 次往返；集群内 ~0.2ms）。

**新的可观测**：`rate_window` 子桶每秒清理一次（`rate_hit` 内）与 `gc` 兜底，单租户常驻 ≤ 21 行。

### 6.2 webhook 同步投递阻塞 worker（P1，契约变更）

收端不响应时 `_notify()` 实测 **16.52s**（8s 超时 × 2 次重试），期间 worker 不能领下一条任务。
正确形态是持久化 outbox + 独立 dispatcher（`webhook_outbox` 表 + `UPDATE … RETURNING` 领取 + 退避重排）。
多 pod 下内存线程队列会丢回调，必须落库。

**刻意没做**：这会把投递从同步变异步，是客户可观察的时序契约变更；要新增表、改 4 个 webhook 用例。
方案与实测已写进 `docs/OPS.md`「异步架构复审」与 `deliverables/落地总报告.html` §10。

### 6.3 状态可以多机，文件还不能（P1，架构前提）

`docker-compose.pg.yml` 里 api 与 worker 仍共用 `renderd-data` 卷存放素材 / 成片 / mezz 中间片，
`render_cache.output_path` 也是本地路径，缓存命中用 `os.link` 硬链接（要求同一文件系统）。
真正多 pod 要做：对象存储 + 预签名 URL、缓存路径改 URL、去掉硬链接假设。
这是下一轮的架构任务，不是配置项。

### 6.4 其余复审观察（P2）

优先级无时间衰减（低优先级可能永久饥饿）、API reaper 与每个 worker 重复扫过期租约、
提交期抽样解码预检占用 HTTP 请求线程 1–3s。都有明确方案，暂未触发规模门槛。

---

## 七、对抗审查之后（10:26）

### 7.1 本轮关闭

| 原风险 | 结论 |
|---|---|
| 默认签名密钥可伪造下载 URL | **关闭**。密钥改为运行时生成并 0600 落盘，弱值启动即拒绝，三个 compose 默认值清空 |
| 出站请求头 CRLF 注入 / 覆盖 Host | **关闭**。准入期 + 出站前两处净化，受保护头不可覆盖 |
| 证据文件无内容承诺 | **关闭**。`receipt.evidence_sha256` 覆盖每个证据文件 |
| 唯一交付通道失败仍判 pass | **关闭**。verdict 降级为 fail + `E_DELIVERY_FAILED` |
| 墙钟前跳误回收（双领） | **缓解**。检测到跳变即跳过回收并写 audit；根治见 7.2 |

### 7.2 新增的残余风险

| 风险 | 为什么还没解 |
|---|---|
| ~~墙钟跳变只是**缓解**~~ | **已关闭（11:05）**。逻辑时钟改为 HLC：`logical = 锚点 + 单调钟增量`，墙钟只用于**观测跳变**、不参与计算；`db_now()` 在 DB 内只前进不回退，跳变落 `clock_events` 并行 `audit`。租约、退避、超时全部改用它（`jobs.created_at/lease_until/available_at/…`）。前跳 +3600s 实测：`db_now()` 偏移 < 1s、running 任务不被回收、`clock_skew_s` 跨实例可见 |
| ~~签名 URL 不绑定租户~~ | **已关闭（11:05）**。签名载荷 = `["v2", tenant, scope, job_id, exp]`；`scope` 区分 `video` / `evidence:<文件名>`。URL 带 `t=`，服务端先验签（避免用 404/401 差异探测 job_id 是否存在）再比对任务 owner，最后写 `download.signed` 审计。成片链接取证据文件、换 `t` 取成片，均 401 |
| 密钥文件与 `data_dir` 同生命周期 | 删掉 `data_dir` 等于轮换密钥，所有未过期签名 URL 立即失效。这是可接受的语义，但没有显式轮换命令 |
| ~~`RateLimiter` / `_upload_lock` 仍是进程内~~ | **已关闭（11:05）**，见 §6.1 |

---

## 八、续轮 5 之后的未解决事项（11:05）

### 8.1 多副本下仍有两条「状态可以、文件不行」

限流与配额已经进 DB，但**素材/成片/mezz 仍是本地卷**，缓存命中用 `os.link` 硬链接
（要求同一文件系统）。`docker-compose.pg.yml` 里 api 与 worker 共用 `renderd-data` 卷，
所以「多 pod」目前只在**同一台机器/同一个卷**成立。跨机器要：对象存储 + 预签名 URL、
缓存路径改 URL、去掉硬链接假设。这是架构任务，不是配置项（原 §6.3，未变）。

### 8.2 时钟的代价：逻辑时间可能与墙钟长期偏移

跳变被「吸收」后，逻辑时间保持连续，但与墙钟的偏移不会自动回归——只有进程重启才重新对齐。
对本服务无影响（租约、退避、计费周期都按相对时长或日历月），但**运维看 `created_at`
时要知道它不是严格墙钟**。要彻底消除这一点，需要外部可信时间源（chrony/NTP 监控）。
当前策略：偏移超过 5s 即记 `clock_events` + audit，`queue_stats().clock_skew_s` 暴露最近一次幅度。

### 8.3 限流是「每租户固定窗口」，不是全局限流

`rate_window` 只约束单租户，不限制「所有租户总量」。若担心单机被多租户打满，
应由反向代理做全局连接数/QPS 限制（`deploy/nginx.conf` 已留 `limit_req` 位置，默认未开）。

### 8.4 其余复审观察（P2）

优先级无时间衰减（低优先级可能永久饥饿）、API reaper 与每个 worker 重复扫过期租约、
提交期抽样解码预检占用 HTTP 请求线程 1–3s。都有明确方案，暂未触发规模门槛。
webhook outbox（§6.2）仍是 P1 契约变更，未做。


---

## 九、续轮 6 之后（13:35）

### 9.1 本轮关闭（上一轮回答里列的「新发现 4 条」中的 3 条）

| 原问题 | 怎么关的 | 实证 |
|---|---|---|
| 未认证请求完全不限流 | 鉴权前按 IP 拦无效令牌（`AUTH_FAIL_QPS`，默认 10/s），合法令牌不受影响 | `test_tenancy.test_01/02`；攻击 I01：40 次错 token 出现 429 |
| `/v1/queue` 全局可见 | 普通租户 `scope=tenant` 只看自己；`RENDERD_ADMIN_TOKENS` 看全量 | `test_tenancy.test_04/05`；攻击 I02 |
| 素材无删除/GC 通道、配额只增不减 | `assets` + `asset_refs` 两张表；`DELETE /v1/assets/{id}`；`renderd gc --assets` 清孤儿 | `test_tenancy.test_06~11`；攻击 I03/I04 |

### 9.2 仍然存在（诚实清单）

| 事项 | 为什么还没解 |
|---|---|
| 缓存命中仍按输出时长计费 | 口径问题不是 bug：按「成片时长」收费成立，按「算力」收费不成立。需要产品定 |
| 限流是「每租户 + 每 IP 失败」，不是全局限流 | 全局 QPS/连接数应在网关做（`deploy/nginx.conf` 的 `limit_req` 默认未开） |
| legacy 用量只能人工清零 | 老数据没有文件级明细；给了 `assets` 列表能看见，但退不掉 |
| 素材删除后，历史任务的 `ir_json` 仍指向它 | 已结束任务的产物不受影响；`replay` 会 `E_MEDIA_MISSING` —— 这是删除接口的预期语义，需在客户端文档里写清 |
| webhook outbox、文件卷跨机 | 见 §6.2 / §8.1，P1，未动 |
| 真实客户素材回归、HDR 调色定位 | 需要外部输入，见 §一 |

---

## 十、续轮 8：MLT 后端从「只生成 XML」到「真能出片」（14:10–14:25）

### 10.1 之前的真实状态

`compile_mlt.py` 能生成 XML，`validate_xml()` 也能过，但**从来没有被 melt 执行过**。
拿它去渲染，输出只有 1 帧（0.042s）。四个问题叠在一起：

| # | 问题 | 后果 |
|---|---|---|
| 1 | `avformat-novalidate` 不做探测，拿不到时长 | melt 把整条时间线当 1 帧 |
| 2 | 写死 `audio_index=1` / `video_index=0` | 纯音频素材（音乐床）打不开 |
| 3 | 视频轨没有 `hide="audio"` | 视频自带的声音混进成片，与 ffmpeg 后端不一致 |
| 4 | 只给第一条音频轨加 `mix` | 第二条及以后的音轨被静默丢弃 |

再加上两个「能出片但不过断言」的问题：

| # | 问题 | 后果 |
|---|---|---|
| 5 | MLT 没有 LUFS 目标 | L3 响度断言失败（实测 -24 LUFS vs 目标 -14） |
| 6 | 音频轨到最后一个片段就结束 | 音轨比画面短（音乐床 10s / 时间线 15s）→ `L1_AUDIO_DESYNC` |

### 10.2 现在的状态

- `backend=mlt` 真正可跑：XML → melt → 响度归一（`apad` + `loudnorm` + `atrim`，视频 copy）→ 断言 → 回执
- 镜像可选：`Dockerfile.mlt`，约 1.48GB（默认 1.03GB）。默认镜像仍不装 melt，请求该后端会明确报错
- 测试：`tests/test_mlt_backend.py` 7 项（结构 4 + 真渲染 3），`make test-mlt` 在带 melt 的镜像里跑
- 实测：带音乐床的 `brand_vertical_15s` 走 MLT，`verdict=pass`、`integrated_lufs=-14.0`、450 帧

### 10.3 仍未承诺

| 事项 | 说明 |
|---|---|
| 字节确定性 | 只对 ffmpeg 后端承诺；MLT 未验证逐字节一致，缓存键含 backend 不会串 |
| 转场 | 容器里的 melt 支持 `ltransition`/`luma`，但 IR 还没有转场语义，两个后端都没接 |
| 音轨高级处理 | 每轨音量/自动化/ducking 目前 ffmpeg 与 MLT 都没有；IR 需先扩展 `volume`/`ducking` 字段 |

---

## 十一、续轮 9：编码分支实跑后暴露的两条（14:55–15:20）

### 11.1 已关闭

| # | 问题 | 为什么之前没发现 | 修法 | 实证 |
|---|---|---|---|---|
| 1 | HEVC 输出 tag 是 `hev1`，Safari/iOS 不播 | 只有 h264 走过完整回归；hevc/av1 属于「代码里有分支、没人跑」。自动断言只看帧数/响度/黑场，不看 tag | 显式 `-tag:v hvc1`；MLT 侧 `finalize_argv()` 统一规范 | `tests/test_codec_branches.py::test_02/08`、`test_mlt_backend.py::test_08`，实测 `hevc,hvc1` |
| 2 | 改编码参数后仍命中旧缓存 | 缓存键只含 IR + ffmpeg 版本。tag 是代码里推导的，不由 IR 决定 | `encoder_signature()` + `COMPILE_REV` 进键 | `test_05/06/07` |

### 11.2 这轮顺带确认「不是问题」的

| 项 | 结论 |
|---|---|
| av1 出片 | 实测 `av1,av01`、180 帧、`verdict=pass` |
| h264 出片 | tag `avc1`，全量 134 项回归覆盖 |
| faststart | hevc/av1 都是 `moov` 在 `mdat` 前，实测确认 |

### 11.3 仍然存在（引擎侧诚实清单）

| 事项 | 状态 |
|---|---|
| 转场（xfade / ltransition） | IR 无转场语义，两个后端都没接 |
| 多轨 alpha 叠加 | 未做（无 alpha 会遮挡下层） |
| 字幕资产通道 | 归一化时丢弃并写 warnings |
| 每轨音量自动化 / ducking | 需先扩 IR 的 `volume` / `ducking` 字段 |
| GPU 编码 | 无（Colima 无 GPU；镜像未编 nvenc/videotoolbox） |
| HDR 输出 | 只做预览级 tone mapping 到 bt709，不做 HDR 交付 |
| 真实客户素材回归 / HDR 调色定位 | 需外部输入 |
| 字节确定性 | 只对 ffmpeg 后端承诺；MLT 未验证 |

---

## 十二、续轮 10：四项引擎能力落地（16:10）

### 12.1 已关闭（上一轮 §11.3 里的一半）

| 原缺口 | 现在 | 实证 |
|---|---|---|
| 转场 | `clip.transition_in`（8 种）→ xfade；MLT 明确拒绝 | 中点各占 A/B 一半；180 帧不变 |
| 每轨音量 | `clip.volume` 0–4，混音前增益；`target_lufs=null` 可关归一 | 0.25 增益实测低 12.1dB（理论 12.04） |
| 字幕资产 | `kind=subtitle` 轨 + SRT/VTT 解析，走 Pillow 文字层 | 字幕时段 1606 白像素 / 非字幕 0 |
| 多轨 alpha | overlay 素材透传 + `format=yuva420p` | 叠加后 meanR 185.7 / stdevG 60.7（理论 186.5 / 62） |

### 12.2 仍然存在（引擎侧最终清单）

| 事项 | 为什么还没做 | 影响 |
|---|---|---|
| GPU 编码 | Colima 无 GPU；镜像未编 nvenc / videotoolbox | 纯 CPU 编码，4K 长片慢 |
| HDR 交付 | 需要客户素材与调色目标才能定位 | 只做预览级 tonemap 到 bt709，回执里写明 |
| 音量自动化曲线 / ducking | 需要扩 IR（关键帧序列 + sidechain 引用），不是加个字段的事 | 目前只有常量 volume + 淡入淡出 |
| MLT 后端转场 | luma transition 需要重构 playlist/tractor 结构 | 明确 `E_IR_UNSUPPORTED`，不静默降级 |
| MLT 字节确定性 | 未逐字节验证 | 缓存键含 backend，不会串；但不承诺复现 |
| 真实客户素材回归 / HDR 调色定位 | 需外部输入（脱敏素材 + 人工抽帧） | 合成语料覆盖故障模式，覆盖不了真实噪声分布 |

---

## 十三、续轮 11：真实素材回归（16:00）

### 13.1 「真实客户素材回归」这条 blocker 现在怎么算

第一次用真实素材跑通全链路（4 个文件 / 37MB 主视频 / 带音轨 / 60fps）。
结论：**引擎能处理真实素材，但适配策略需要客户确认**。

| 发现 | 判定 |
|---|---|
| 3.75s@24fps 卡片归一化后 112 帧，按 4s 排版被 `E_MEDIA_TOO_SHORT` 拦住 | 保护正确，改 IR 不改引擎 |
| 16:9 `cover` 到 9:16 只剩 31.6% 宽度，两侧信息全丢 | **真实缺陷** → 新增 `fit=blur` |
| 宿主机缺 Noto 字体，回退 Hiragino（有 warning） | 行为正确，但跨端字形差异仍在（见 §8.1 同源问题） |
| 卡片无音轨 → 补静音并写 warning | 正确 |

### 13.2 这条 blocker 还不能完全关掉

一次真实素材 ≠ 客户素材回归。仍然缺：

| 缺口 | 说明 |
|---|---|
| 客户自己的素材 | 现在用的是公开 promo 素材（科技风、深色、主体居中）；客户素材可能是实拍人脸、商品特写、强纹理 |
| 人工抽帧复核 | 我只看了 4 帧；正式验收需要按镜头逐段确认 |
| 客户对「竖版裁切」的预期 | `cover` / `contain` / `blur` 三选一是产品决策，需要客户拍板默认值 |
| 批量回归 | 需要 50–100 条素材跑一遍并统计失败模式 |

判定：**可以开始接真实客户试跑，但第一批量产前必须做一次人工抽帧复核。**
