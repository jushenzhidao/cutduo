# result.md — 验收材料

本轮任务：**「继续 全部完成」** —— 把上一轮 `blockers.md` 里的未解决事项全部关掉或给出可运行的落地物，不留半成品。

时窗：2026-11-09 03:54 → 04:31（无人值守，全程未暂停）。
**状态：四个阶段全部完成，全量回归全绿。**

> 上一轮的产出（服务设计、容器化、对抗审查）保留在 `renderd/README.md`、`renderd/docs/`、
> `deliverables/对抗审查报告.html`。本文只覆盖本轮。
> 完整过程日志见 `progress.md`，逐条决策见 `decisions.md`，未解决事项见 `blockers.md`。

---

## 一、完成清单

### 阶段 A · 输入归一化真正接进服务 ✅

| 产出 | 路径 |
|---|---|
| 三段式归一化引擎（probe / decide / normalize） | `renderd/renderd/ingest.py`（约 500 行） |
| 接入编排层（预检 + 执行 + 长度复核 + 缓存键） | `renderd/renderd/runner.py` |
| 回执新增 `L0_ingest`（素材决策单） | `renderd/renderd/validate.py` |
| 21 条脏语料回归脚本 + 矩阵 | `renderd/tests/ingest_corpus.py`、`renderd/var/ingest_regression/matrix.json` |
| 归一化产物与决策单 | `renderd/var/<data>/mezz/<key>.mp4` + `.json` |

和 P0 验证脚本的 5 处实质差异：目标 fps 取 IR（不是写死 30）、HDR 用 zscale 线性光 + hable tone mapping
（不是 colorspace 直转）、旋转矩阵强制烤进画面、产物内容寻址缓存 + 决策单可回放、
所有动作写进 `receipt.L0_ingest` 且 digest 纳入缓存键（禁止静默改变素材语义）。

**实测**：21 条语料 → 18 条归一化通过 8 项规格校验、3 条按预期硬失败（0 字节 / 截断 / 纯音频投视频位）；
HDR→`TONEMAP_HDR` 且产物 bt709；旋转→`BAKE_ROTATION`；黑边→`CROP_PILLARBOX`；
奇数分辨率→`FIX_ODD`(crop)；全部产物 30fps / 48k 立体声 / yuv420p / SAR 1:1。
另挑 4 条走完整链路（提交→worker→receipt），全部 `verdict=pass` 且回执含 `L0_ingest`。

### 阶段 B · 关闭 P0 安全缺口 ✅

| 产出 | 路径 |
|---|---|
| 出站防线：解析一次、钉住 IP、投递期零解析 | `renderd/renderd/netguard.py` |
| 存储配额（schema 迁移 + 锁内校验 + 跨月累计） | `renderd/renderd/store.py`、`service.py`、`config.py` |
| 新增攻击用例 F06 / F07 / F08 | `renderd/tests/attack.py` |

- **DNS rebinding**：提交期 `resolve_pinned()` 校验并钉住 IP 存入 `jobs.callback_ip`；投递期
  `pinned_request()` 手写 HTTP/1.1 over pinned socket（HTTPS 保留 SNI/Host），不用 urllib；
  `revalidate_pin()` 复核。IPv4 优先 + 备选地址逐个重试（实测 `localhost` 首个返回 `::1`，
  收端只听 IPv4 时会失败 —— 这是加固测试逼出来的真实问题）。
- **存储配额**：`usage.bytes` + `tenants.storage_mb`，`put_asset()` 锁内「查配额→写→计数」，
  内容寻址去重、跨月求和；超限 `413 E_QUOTA_STORAGE_EXCEEDED`。
- **交付链路不是后门**：新增的第二条出网路径也走同一个 netguard；`169.254.169.254` 与
  `file:///etc/passwd` 均被 `E_CALLBACK_FORBIDDEN` 拦下。

### 阶段 C · 交付与运维能力补齐 ✅

| 产出 | 路径 |
|---|---|
| 成片直传客户 OSS（预签名 PUT） | `renderd/renderd/delivery.py` |
| webhook / 直传 / DNS rebinding / 配额 / 白名单端到端测试 | `renderd/tests/test_hardening.py`（11 项） |
| 服务内置 TLS + `/metrics` 来源白名单 | `renderd/renderd/api.py`、`config.py` |
| Caddy / nginx 反代配置 + TLS compose | `renderd/deploy/Caddyfile`、`nginx.conf`、`docker-compose.tls.yml` |
| TLS 与网关端到端 | `renderd/tests/tls_smoke.sh`、`gateway_e2e.sh` |
| Colima 环境修复固化（幂等） | `renderd/deploy/colima-bootstrap.sh` |
| MCP 契约同步（delivery / callback_url / L0_ingest） | `renderd/renderd/mcp_stdio.py`、`cutproof/mcp/tools.json` |

### 阶段 D · 长稳、修复与全量回归 ✅

- 500 条长稳（混合冷渲染 + 缓存命中）：**500/500 成功，0 失败**，707s，p50 793ms。
- **长稳抓到第三个真实缺陷**：67 个未释放的 SQLite fd → 内存线性爬升；缓存命中复制成片 →
  磁盘线性膨胀。两处都已修复并有 100 条复测验证（见 §三）。
- `renderd/tests/soak_verify.sh`：把 `fd < 20` 做成自动门禁。
- 文档与构建入口更新：`README.md`、`docs/SECURITY.md`、`docs/OPS.md`、`docs/API.md`、`Makefile`、
  `docker-compose.yml`、`requirements.txt` 无需改动（新模块只用 stdlib + pillow）。
- 报告：`deliverables/落地总报告.html`（脚本渲染，非手填）。

---

## 二、验证总表（最终镜像，全部真跑）

| 套件 | 结果 |
|---|---|
| 单元 + 集成 + 加固（unittest discover） | **69 / 69** |
| REST 冒烟 | **11 / 11** |
| MCP stdio 冒烟（真子进程 + JSON-RPC） | **29 / 29** |
| 21 条脏语料归一化 + 4 条端到端 | **PASS** |
| 容器内 doctor | **7 / 7** |
| 容器内 E2E | **10 / 10** |
| Compose 分离部署 + `kill -9` 崩溃恢复 | **11 / 11**（attempts=2 自愈） |
| Caddy TLS 网关 E2E | **10 / 10** |
| 内置 TLS + `/metrics` 白名单 | **6 / 6** |
| 对抗测试（容器内） | **51 / 51**，0 critical |
| 多 worker 并发不双领 | **7 / 7** |
| 长稳（修复前镜像） | **500 / 500**，707s |
| 资源修复验证（最终镜像） | **100 / 100**，148s，fd 门禁通过 |

---

## 三、本轮三个最值得看的发现

**① 500 条长稳零失败，但内存没收敛。** 194.2 → 213 → 235.1 → 246 → 257 MiB，
前 100 条可解释为堆预热，之后每 100 条仍稳定 +11 MiB。
`docker exec renderd-test ls /proc/1/fd` → **71 个 fd，67 个指向 sqlite**，而线程只有 4 个。
根因是 `Store._conn()` 用 `threading.local` 存连接，短命 HTTP 线程结束后连接靠 GC 才回收。
修法：请求结束在 `_dispatch` 的 finally 里显式 `close_thread_connection()`。
修复后 100 条复测：fd 11 → 14，内存 22.45 → 64.32 MiB 后稳定。

**② 磁盘 97M → 1.7G 不是泄漏，是每个 job 一份成片副本。** 缓存命中原本 `shutil.copy2`，
改成 `os.link` 硬链接后，100 条只涨 66M（且主要是 5 个不同成片 + 回执/证据）。

**③ 加固测试第一次跑 DNS rebinding 用例时失败了，但不是 rebinding 的问题。**
`getaddrinfo("localhost")` 首个返回 `::1`，而收端只监听 IPv4 —— 钉死第一个 IP 会直接
ECONNREFUSED。补了 IPv4 优先 + 备选地址逐个重试。这是真实环境会踩的坑。

另有一处同类事故被前置拦截：c09 截断文件 ffprobe 显示时长 20 秒、编码正常、元数据完全健康，
只有真解码才在 12 秒处报错。现在提交期抽样解码直接 `422 E_INPUT_TRUNCATED`，
Agent 不会以为提交成功然后在异步阶段莫名失败。

---

## 四、decisions.md 决策日志（累计 55 条，本轮新增 19 条，完整见文件）

关键几条：

| 决策 | 理由 |
|---|---|
| 归一化默认开启，配置 `RENDERD_INGEST_NORMALIZE=0` 才关 | 这是交付正确性缺陷，默认关闭等于没修 |
| 目标 fps 取 IR 而非固定 30 | 编译器用 `trim=start_frame`，输入帧率必须等于时间线帧率 |
| HDR 改 zscale 线性光 + hable，不用 colorspace 直转 | 直转压平高光；两端 ffmpeg 实测支持 |
| 旋转矩阵强制转码烤进画面并清元数据 | `-c copy` 会原样保留显示矩阵，下游当横版 |
| 决策单落盘 + `L0_ingest` 进回执 + digest 进缓存键 | 静默改变素材语义是商业化事故 |
| 抽样解码放进提交预检 | 截断文件异步失败会让 Agent 误判 |
| 出站请求钉住 IP、投递期零解析 | DNS rebinding |
| 出站 IP 优先 IPv4 并保留备选 | `localhost` 首个是 `::1`，收端常只听 IPv4 |
| 存储配额按月写、跨月求和读 | 文件不会因月份翻篇消失 |
| 成片直传用客户预签名 PUT URL，不做我方 OSS SDK | 出口带宽占成本 61%，直传可归零；且不需持有客户凭据 |
| TLS 做两层（内置 + Caddy 网关） | 单层容易在没配反代时裸奔；两条链路都实测 |
| HTTP 请求结束显式关闭线程局部 SQLite 连接 | 500 条长稳实测的 fd 泄漏 |
| 缓存命中用 `os.link` 而非 `copy2` | 磁盘线性膨胀 |
| `mezz` 缓存只报告占用、不自动删除 | 共享引用，无引用计数的自动删除会破坏别的任务 |

---

## 五、blockers.md 未解决事项（9 条 → 3 条）

关闭 7 条：归一化未接入、DNS rebinding、存储配额、webhook 无测试、对象存储交付、
无 TLS/WAF、长稳样本不足；另把 Colima 环境修复固化成幂等脚本。

**剩余 3 条，全部是「需要外部输入」或「刻意选择」，没有一条是代码没写完：**

1. **真实客户素材回归**：21 条合成脏素材覆盖故障模式，覆盖不了真实拍摄噪声、复杂字形连写、
   真实音乐床响度分布。需要 50–100 条脱敏真实素材跑一次回归 + 人工抽帧复核。
2. **SQLite 单机**：单机 2–4 worker / 500–2000 条每天适用；SQL 全隔离在 `Store` 一个类里。
   超出规模换 Postgres + Redis。**不要放 NFS 上跑多机**（文件锁语义不保证，会双领）。
3. **HDR 是预览级 tone mapping**：`zscale + hable` 比直转正确得多，但没有创作意图
   （高光滚降、肤色、HLG 场景光级别需人工判断）。回执里对每条 HDR 素材都明确标注了。
   要先拿到客户 HDR 占比与调色预期，再决定上 libplacebo / LUT / 标记人工复核。

另有 P2 已知但刻意不做 6 项（多轨 alpha 叠加、字幕资产通道、自动清理旧产物、
签名 URL 绑定租户、GPU 编码会话、MLT 跨端一致性），完整见 `blockers.md`。

---

## 六、怎么验

```bash
cd renderd
make doctor                       # 环境自检
make test                           # 69 个用例
make ingest-corpus                  # 21 条脏素材归一化回归
make docker-build && make docker-run
make test-container                  # 10 项（容器内端到端）
make test-compose                    # 11 项（kill -9 崩溃恢复）
make test-gateway                    # 10 项（TLS 网关）
make tls                             # 6 项（内置 TLS + 白名单）
make attack BASE=http://127.0.0.1:8788 TOKEN=<A> OTHER_TOKEN=<B> \
     BURST_TOKEN=<C> STORAGE_TOKEN=<D> SECRET=<S>   # 51 项
make soak500                         # 500 条长稳
```

抗测试复现需要 4 个 token（burst 低 QPS、storage 1MB 配额），用
`python -m renderd tenant --name burst --qps 5` / `--storage-mb 1` 设置。
清理：`docker rm -f renderd-test`；`colima stop` 关虚拟机。

**报告**：`deliverables/落地总报告.html`（本轮）、`deliverables/对抗审查报告.html`（上一轮）。
**安全模型**：`renderd/docs/SECURITY.md`。

---

## 七、续轮 2：生产级异步落地（08:46–09:0x）

上一轮验收后按「出事故时能不能看见、能不能刹住、能不能对账」重新审计队列，
发现 6 项缺口，本轮全部关闭。**这一轮没有换存储、没有换语言**，全是纯增量。

| 缺口 | 落地物 |
|---|---|
| 队列堆积看不见 | `Store.queue_stats()`、`/metrics` 7 个 gauge、`GET /v1/queue`、`renderd queue` |
| 单租户可灌满队列 | `RENDERD_MAX_QUEUE_DEPTH` / `RENDERD_MAX_TENANT_INFLIGHT`，超限 `429 E_QUEUE_FULL` |
| 瞬态错误几秒连烧 3 次 | `jobs.available_at` + `base × attempts²`（默认 1/4/9s），claim 过滤未到期任务 |
| failed 无法对账重放 | `GET /v1/dlq`、`POST /v1/jobs/{id}/replay`、`renderd dlq/replay/release` |
| 优雅退出配置 | `STOPSIGNAL SIGTERM` + `stop_grace_period: 300s` |
| webhook 无去重键 | `event_id = job_id:status:attempts` + `attempt`，契约写入 API.md |

**刻意没做**：SIGTERM 时自动把 running 任务改回 accepted。原进程可能还在跑 ffmpeg，
新 worker 会立刻领走 → 双领。改为给足优雅期让当前任务跑完，reaper 只兜底真猝死；
确认进程已退出后用 `renderd release --worker` 提前收回。

**回归抓到一个真 bug**：新增 `available_at` 时 `CREATE INDEX` 留在 SCHEMA 里、
排在 `ALTER TABLE` 之前，存量库一打开就 `no such column`。索引移到 `_migrate()`
补列之后创建，三个存量数据目录复测可正常打开。

**验证**：新增 `tests/test_production_async.py` 11/11；全量 unittest **80/80**；
REST 11/11、MCP 29/29、语料回归 PASS、TLS 6/6；容器内队列端点/CLI/新指标 PASS、
E2E 10/10、对抗 51/51（0 critical）。

详见 `docs/OPS.md`「生产级异步」、`docs/API.md`「队列运维端点」、
`deliverables/落地总报告.html` §09。


### 最终验证（重建镜像后）

```
宿主机   unittest 80/80   REST 11/11   MCP 29/29   语料回归 PASS   TLS 6/6
容器     队列端点/CLI/7 个新 gauge PASS
         E2E 10/10   对抗 51/51（0 critical）
         Compose 崩溃恢复 11/11   TLS 网关 10/10
         50 条混合长稳 50/50，p50 812ms
         fd 增量门禁：11 → 14（delta 3）PASS
```

**fd 门禁的一次误报，查清后修对了**：上一轮的绝对阈值 `fd < 20` 在连跑 18 分钟、
叠了四套测试的容器上报 FAIL（实测 25）。隔离测量证明没有持续泄漏 ——
干净容器 60 次 HTTP 请求 sqlite fd 7→8，现有容器再跑 10 条真实渲染 21→21。
绝对阈值把「常驻 worker / reaper 线程的基线」误当成泄漏，改成**增量门禁**（结束−基线 < 10）。
同时把 `render.run()` 的 pump 线程管道显式关闭，消除 `TextIOWrapper` 的 ResourceWarning。

**状态：续轮 2 收口。** 仍未做的只有两项 P1（运行中任务取消、SSE 推送），
都已在 `blockers.md` 的 P2 表里写明「为什么暂缓」。

---

## 八、续轮 3：PG 双后端 + 异步架构复审（09:39–10:02）

### 完成清单

| 阶段 | 产出物 |
|---|---|
| PG 后端 | `renderd/renderd/store_pg.py`（新增）、`renderd/renderd/store.py`（`Store` 改工厂 + 两项优化） |
| 部署 | `renderd/requirements-pg.txt`、`renderd/Dockerfile`、`renderd/docker-compose.pg.yml` |
| 测试 | `renderd/tests/test_pg_backend.py`（新增 5 项）、`test_hardening.py`（去后端耦合） |
| 证据 | `renderd/var/pg_regression/evidence.json`、`/tmp/attack_pg.json`、`/tmp/queue_scan_probe.py`、`/tmp/webhook_block_probe.py` |
| 文档 | `docs/OPS.md`「PG 后端 / 异步架构复审」、`docs/API.md`、`README.md`、`Makefile` |
| 报告 | `deliverables/落地总报告.html` 更新到 10 节（§10 由 evidence.json 真实渲染） |

### 验证结果（PostgreSQL 16.15 @ Colima，端口 5433）

```
unittest discover     PG 85/85 (88.9s)      SQLite 85/85 (80.8s, 1 skip)
对抗测试               PG 51/51, critical 0（优化前后各一次，均全绿）
21 条脏语料            PG PASS（18 归一 / 3 硬失败 / 4 端到端 pass）
compose.pg 语法        OK
镜像内 psycopg         3.3.8，PostgresStore 可导入
```

用户要求的「同一套 80 个用例 + 51 项对抗」已全部在 PG 后端跑通；
用例数从 80 增到 85，是因为新增了 5 个双后端常驻保障用例。

### 设计要点

`Store()` 是工厂函数：`SqliteStore` 原样保留，`PostgresStore` 用方言代理复用全部 45 条 SQL，
只 override 三处真差异 —— `ON CONFLICT` 幂等、`FOR UPDATE SKIP LOCKED` 领取、
无 `BEGIN IMMEDIATE` 的事务。DDL 从 SQLite SCHEMA 自动翻译，两套 schema 永远同步。
**REST / MCP 契约完全一致**，切换只在部署侧设 `RENDERD_DB_DSN`。

### 异步架构复审结论

按领取 / 心跳 / 回收 / 投递 / 预检五条路径审，两项实测后落地：

| 优化 | 实测 |
|---|---|
| `queue_stats` 只扫活跃行 + `failed_24h` 部分索引 | 历史 1k→100k 行：0.133→15.270 ms 变成 0.036→0.029 ms（10 万行约 527×，不再随历史增长） |
| 事件写入合并进主事务（8 个方法） | 一条任务写事务约 24 → 12 次（静态调用点统计），状态与事件原子落库 |

**最大剩余瓶颈**：webhook 同步投递，收端不响应实测 **16.52s** 阻塞 worker。
正确形态是持久化 outbox + 独立 dispatcher，但那是客户可观察的时序契约变更，
已连同完整方案写进 `blockers.md` §6.2，不夹带在性能优化里。

### 未解决（详见 blockers.md §六）

1. **P0 / 多 pod 前必须修**：`RateLimiter` 与 `_upload_lock` 仍是进程内状态 ——
   换成 PG 不会自动解决，实测 3 个 API 实例 → 15 QPS（上限 5）、1MB 配额写成 1.34MB。
2. **P1**：webhook outbox 化；状态已多机但 `/data` 文件卷与硬链接缓存还不能。
3. **P2**：优先级饥饿、reaper 重复扫、提交期预检占用请求线程。

### 怎么验

```bash
cd renderd
make test                                  # SQLite 85 个用例
export RENDERD_DB_DSN="postgresql://renderd:renderd_local@127.0.0.1:5433/renderd"
make test-pg                               # 同一套 85 个用例跑 PG
make docker-pg                             # PG + api + worker 分离部署
docker ps --format '{{.Names}} {{.Status}}' # renderd-pg 容器仍在运行
```

PG 容器 `renderd-pg` 已保留供验收；`docker rm -f renderd-pg` 可清理。

---

## 九、续轮 4：对抗审查（10:04–10:26）

### 方法

不接着补用例，先回到基本事实重算信任边界：

1. Agent 看不见视频，回执是它唯一的判断依据；
2. 安全机制的有效性取决于密钥熵与输入净化，不是「有没有调用 hmac」；
3. 持久化的时序判断不能依赖非单调墙钟；
4. 「成功」由客户能否拿到成片定义，不是文件写到了我的磁盘。

每条候选先写可复现实验（`/tmp/adversarial_probe.py`），修复后再跑同一脚本。

### 五条被坐实的问题

| # | 问题 | 级别 | 修复前（实测） | 修复后（实测） |
|---|---|---|---|---|
| A | 默认签名密钥可伪造下载 URL | critical | 源码常量伪造 → `auth.verify=True` | `False`；服务自签仍 `True` |
| B | 出站请求头 CRLF 注入 / 覆盖 Host | high | 收端收到 `X-Injected: yes`、`Host: evil.example` | `ValueError` 拒绝；合法头可用 |
| C | 证据文件无内容承诺 | high | 无 `evidence_sha256`，替换证据 verdict 仍 pass | 4 个文件全有哈希，可检出 |
| D | 唯一交付通道失败仍判 pass | high | `verdict=pass`, `failures=[]` | `verdict=fail`, `E_DELIVERY_FAILED` |
| E | 墙钟前跳误回收 running（双领） | critical | +3600s → 回收，`status→accepted` | 回收 `[]`，`status=running` |

### 修复

- `auth.init_secret()`：随机 32 字节密钥 0600 落盘；弱值启动即拒绝；`verify` 拒绝墙钟回拨
- `netguard.sanitize_headers()`：token 头名 / 无控制字符 / 受保护头；准入期与出站前两处
- `delivery.parse_spec`：headers 校验排在 SSRF 解析之前（错误不被 DNS 掩盖）
- `runner._deliver`：`evidence_sha256` + 交付失败 verdict 降级
- `store._clock_jump()`：单调钟与墙钟漂移 >5s 则跳过回收并写 audit；`clock_skew_s` 进指标

### 验证

```
unittest discover   SQLite 93/93 (1 skip, 88.8s)   PG 93/93 (95.7s)
对抗套件            PG 55/55（新增 H 组 4 项），critical 0
hardening           11/11    adversarial_review 8/8
```

### 仍未解决

1. **P0**：`RateLimiter` / `_upload_lock` 仍是进程内 —— 多 API 副本前必须修（blockers §6.1）。
2. **P1**：墙钟跳变只是缓解，根治需 DB 单一时钟源；签名 URL 不绑定租户。
3. **P1**：webhook 同步阻塞 16.52s（上一轮实测），outbox 方案已写明。

---

## 续轮 5 · 「1-3 解决下」：上一轮三条「仍未解决」全部关闭（10:27–11:10）

三条都不是靠改文档关的：每条都有「修复前 → 修复后」的同一脚本对照，
新增 `tests/test_cluster_state.py`（10 项）与 `tests/multi_replica.sh`（3 副本容器）钉住。

### 1 · P0 进程内限流 / 配额 → 共享存储仲裁

| 场景 | 修复前（实测） | 修复后（实测） |
|---|---|---|
| 3 个 API 实例，租户 `qps=5` | 1 秒放行 **30** | 1 秒放行 **5** |
| 2 个实例并发 700KB（配额 1MB） | 都成功，记账 **1.37MB** | 1 成功 1 拒绝，记账 **0.68MB** |
| 3 个**容器** + 同一个 PG（`multi_replica.sh`） | — | 放行 5 / 拒绝 1；上传 1/3，记账 700000 字节 |

- `store.rate_hit()`：`rate_window(tenant,bucket,hits)`，20×50ms 子桶滑窗（固定 1s 桶在边界会放行 2×，实测过）。
  判定压成**一条 SQL**：`INSERT … SELECT … WHERE 窗口未满 ON CONFLICT DO UPDATE … WHERE 当前桶未满`
  —— 「读窗口 → 判断 → 记账」之间没有可被并发穿过的间隙，PG 下只花一次往返。
- `store.storage_reserve()`：一个写事务内完成「查已用 → 预占 → 记账」；PG 用 `SELECT … FOR UPDATE`
  锁租户行（READ COMMITTED 下两个 pod 会读到同一份 used）。文件用 `O_CREAT|O_EXCL` 原子创建，
  写失败或内容重复则退款。
- 删掉 `auth.RateLimiter` 与 `service._upload_lock`。仍不引 Redis：状态必须同域可对账。

成本：`rate_hit` SQLite p50 **0.015ms**、PG p50 **1.52ms**（本机经 Colima 端口映射，含 1 次往返；
集群内更低）。PG 侧顺手把连接改成 autocommit（原来每条只读 SELECT 也要 commit，一次读=两次往返），
单次准入从 8.5ms 降到 1.52ms。

### 2 · 墙钟「缓解」→ 单一时钟源（HLC）

| 场景 | 修复前 | 修复后（实测） |
|---|---|---|
| 墙钟 +3600s 后 `recover_expired()` | 靠「检测到跳变就停手」规避，时钟异常期间回收停摆 | 逻辑时间不动 → 租约不过期，`running` 保持，`db_now()` 偏移 < 1s |
| 墙钟 -3600s | 已发出的租约可能重新有效 | 逻辑时间只前进不回退 |
| `clock_skew_s` 可见性 | 存实例属性：副本 A 看到、副本 B 的 `/metrics` 仍是 null | 落 `clock_events`，任何实例 `/v1/queue` 都能读到同一值 |

`db_now()`：`逻辑时间 = 锚点(墙钟,单调钟) + 单调钟增量`。墙钟只用来**观测**跳变，
不参与计算；`clock.last_ts` 在 DB 内只前进不回退，跨实例用它对齐。
`jobs.created_at/started_at/finished_at/lease_until/available_at`、事件时间、audit 时间、
`gc` 截止全部改为逻辑时间 —— 一个系统只能有一个时间基，混用会让 `elapsed_s` 出现负数。

**代价**（已写进 blockers §8.2）：跳变被吸收后，逻辑时间与墙钟的偏移不会自动回归，重启才重新对齐。

### 3 · 签名 URL 绑定租户与用途

载荷从 `job_id:exp` 改为 `["v2", tenant, scope, job_id, exp]`，`scope` = `video` | `evidence:<文件名>`。

| 攻击 | 结果 |
|---|---|
| 成片签名 → 取 `evidence/contact_sheet.jpg` | **401**（原来 200：同一 job 的万能钥匙） |
| 把 `t=acme` 改成 `t=rival` | **401** |
| 改 `job_id` 保留签名 | **401** |
| 源码常量伪造 | **401** |
| 正常成片 / 正常证据 | **200** |

顺序是「先验签 → 再查任务 → 最后比对 owner」：反过来就变成用 404/401 的差异探测 job 是否存在。
每次成功下载写 `audit(action="download.signed", tenant, target, ip, scope)`。
顺带修了一个真问题：回执里的 evidence 链接原本是**无签名**路径，Agent 点开就是 401 ——
回执给了不能用的地址。现在是签名 URL，`test_signed_url_scope_and_tenant` 实测 200。

### 本轮回归

```
unittest discover    SQLite 104/104 (1 skip, 97.9s)   PG 104/104 (106.4s)
对抗套件              SQLite 57/57   PG 57/57         critical 0（H 组扩到 6 项）
容器 E2E              10/10（镜像已重建）
Compose 崩溃恢复      11/11（kill -9 → 租约过期 → 自愈 → attempts=2）
TLS 网关              10/10
三副本容器           3/3（限流 / 配额 / 记账）
```

新增/改动文件：

| 文件 | 作用 |
|---|---|
| `renderd/store.py` | `rate_window` / `clock` / `clock_events` 表；`rate_hit`、`storage_reserve`、`db_now`、可重入 `tx()` |
| `renderd/store_pg.py` | `_lock_tenant_row`（FOR UPDATE）、autocommit、`_PG_ALTERS`（BIGINT 修正） |
| `renderd/auth.py` | 签名 v2（tenant+scope）、删除进程内 `RateLimiter` |
| `renderd/service.py` | 准入走 DB、配额预占、证据链接签名、`elapsed_s` 用逻辑时钟 |
| `renderd/api.py` | 先验签后查任务、`download.signed` 审计、未消费 body 关连接、worker 名唯一 |
| `renderd/tests/test_cluster_state.py` | 10 项：多进程限流/配额、HLC 前跳/回拨、跨实例 skew、签名绑定 |
| `renderd/tests/multi_replica.sh` | 3 个 API 容器 + 同一 PG 的现场验证 |
| `renderd/tests/attack.py` | H05/H06（跨 scope / 换租户）；F01 改判据；签名用服务端同一实现 |

### 现在的 blockers

只剩 2 条，都需要外部输入：**真实客户素材回归**、**HDR 调色定位**。
架构侧明确未做 2 项：文件卷跨机（§8.1）、webhook outbox（§6.2，P1 契约变更）。

---

## 续轮 6 · 租户边界：上一轮「新发现」里的 3 条（13:08–13:35）

上一轮回答里列了 4 条新发现，这一轮做了前 3 条（第 4 条是计费口径，需产品定）。
三条都属于「单租户开发时看不见、第二个租户一来就出事」。

### 1 · 认证失败不受限流

顺序问题：`admit()` 先 `resolve()` 再 `rate_hit()`，错 token 在限流之前就抛 401 ——
401 可以无限打。现在鉴权前按客户端 IP 拦「无效令牌」，超过 `RENDERD_AUTH_FAIL_QPS`
（默认 10/s）返回 429。

**第一版做错了一次**：按 IP 一刀切（该 IP 失败过就拦所有请求），实测攻击套件整组变 429 ——
同一出口 IP 后面的正常客户会被一起打死。改成只拦「令牌不在配置里」的请求后，
`test_tenancy.test_02` 专门钉住：同一 IP 失败打满预算后，合法令牌仍放行。

### 2 · `/v1/queue` 把邻居暴露给所有租户

| | 修复前 | 修复后 |
|---|---|---|
| 普通租户 | 看到全部租户名与在途数 | `scope=tenant`，`inflight_by_tenant` 只含自己；容量信息保留 |
| admin | — | `scope=admin`，需要 `RENDERD_ADMIN_TOKENS` 里的令牌 |

不做第二套凭据：admin 令牌是 `RENDERD_TOKENS` 的子集，避免身份映射分裂。

### 3 · 素材无法回收（配额只增不减）

根因是没有文件级明细：只记 `usage.bytes` 聚合值，无法回答「这份字节属于哪个文件」，
于是文件删不掉、配额也退不回。

| | 修复前 | 修复后 |
|---|---|---|
| 数据结构 | `usage.bytes` 一个聚合值 | `assets`（文件）+ `asset_refs`（谁引用/谁付费） |
| 配额来源 | `SUM(usage.bytes)`，只增不减 | `SUM(asset_refs.bytes)`，删引用即释放 |
| 删除 | 无 `DELETE` 路由 | `DELETE /v1/assets/{id}`，在途引用 → 409 |
| 回收 | 只有 job 产物 GC | `renderd gc --assets` 清孤儿（默认 dry-run） |
| 去重 | 第二个租户免费，但无引用记录 | 记 `bytes=0` 的引用，付费方删除不会误删别人还在用的文件 |

`tests/test_tenancy.py` 12 项覆盖：错 token 限流、合法令牌不受影响、队列分级、
删除退款、在途引用拒绝、跨租户 404、共享内容最后一个引用才删、孤儿 GC、legacy 迁移。

### 本轮回归

```
unittest   SQLite 117/117 (1 skip, 99.9s)   PG 117/117 (120.7s)
对抗       SQLite 61/61   PG 61/61          critical 0（新增 I 组 4 项）
```

新增接口：`GET /v1/assets`、`DELETE /v1/assets/{id}`、`renderd assets`、
`renderd gc --assets`。新增错误码：`E_ASSET_IN_USE`(409)、`E_ASSET_AMBIGUOUS`(409)。

### 剩下的

计费口径（缓存命中是否收费）、全局限流（网关层）、legacy 清零（人工）、
webhook outbox、文件卷跨机，以及需要外部输入的真实素材回归 / HDR 定位。

### 补记：Compose 回归抓到的时钟残留

第一次跑 Compose 时挂了一项：`kill -9` 后等 18s，任务仍 `running` ——
`recover_expired()` 里还留着上一轮的「跳变后 60s 内跳过回收」。HLC 之后时间不会跳，
这个保险只剩副作用：把崩溃任务的重排拖过观测窗口。改成「跳变只留痕、不停手」后
Compose **11/11**（过期后 `accepted`，attempts=2 后自愈）。
教训写进 progress：换掉机制后，要把它留下的补丁一起删掉。

---

## 续轮 8 · MLT 后端：从「只生成 XML」到「真能出片」（14:10–14:25）

起因是一句提问：「Mlt 没做吗，后面音轨会用到」。查下去发现比「没做」更糟：
生成器在、结构校验也过，但**从来没被 melt 执行过**，真拿去渲染只出 1 帧。

### 六个问题，全部实测定位

| # | 问题 | 现象 | 修法 |
|---|---|---|---|
| 1 | `avformat-novalidate` 不探测时长 | 成片 0.042s（1 帧） | 改用 `avformat` |
| 2 | 写死 `audio_index=1 / video_index=0` | 音乐床（纯音频）打不开 | 交给 melt 自选 |
| 3 | 视频轨没 `hide="audio"` | 视频自带声音混进成片（-24dB，应为静音） | 显式 hide，实测 -91dB |
| 4 | 只给第一条音频轨加 `mix` | 第二条被静默丢弃 | 每轨一条 mix，实测叠加 +6dB |
| 5 | MLT 没有 LUFS 目标 | L3 响度断言失败（-24 vs -14） | 出片后补 `loudnorm`（视频 copy） |
| 6 | 音频轨到最后一个片段就结束 | `L1_AUDIO_DESYNC` | 同一道补 `apad` + `atrim` |

### 现在的状态

- `backend=mlt` 真正可跑：XML → melt → 响度归一 → 断言 → 回执
- **实测**：带音乐床的 `brand_vertical_15s` 走 MLT，`status=succeeded`、`verdict=pass`、
  `integrated_lufs=-14.0`、450 帧、48kHz 立体声
- 镜像可选：`docker build -f Dockerfile.mlt -t renderd:0.1.0-mlt .`（1.48GB vs 默认 1.03GB）；
  默认镜像缺 melt 时返回 `E_RENDER_FAILED` 并给出修法，不静默降级
- 测试：`tests/test_mlt_backend.py` **7 项**（结构 4 + 真渲染 3），`make test-mlt` 一键跑
- 全量回归：宿主机 124 项（跳过 4 项：3 项 MLT 真渲染 + 1 项 PG 契约），`0.1.0-mlt` 镜像内 MLT 7/7

### 仍未承诺

字节确定性只对 ffmpeg 后端承诺；转场（`xfade`/`ltransition`）两个后端都还没接；
每轨音量/自动化/ducking 需要先扩 IR 的 `volume`/`ducking` 字段。

---

## 续轮 9 · 编码分支实跑：两条「能出片但交付不出去」的问题（14:55–15:20）

起因是一句追问「全部搞定了？后端引擎」。此前 hevc / av1 两条分支属于
「代码里有、没人跑过」—— 这次真跑，两个都能出片且断言通过，但发现两个缺陷。

### 1 · HEVC 的容器 tag 是 `hev1`，Apple 生态不播

| | 修复前（实测） | 修复后（实测） |
|---|---|---|
| ffmpeg 后端 HEVC | `hevc,hev1` | `hevc,hvc1` |
| MLT 后端 HEVC | `hevc,hev1` | `hevc,hvc1` |
| h264 / av1 | `avc1` / `av01` | 不变（显式写死） |

`hev1` 与 `hvc1` 只差两字节，语义不同：`hev1` 允许参数集在码流中重复出现，
`hvc1` 要求只在 `hvcC` 盒子里。**Apple 的解复用器只实现后者。** 所以
「渲染成功 + 断言通过 + 回执 pass」的成片在 iPhone 上打不开 ——
技术指标全绿、交付目标不成立，这是自动断言最容易放过的一类缺陷。

### 2 · 改了编码参数，缓存仍返回旧产物

缓存键原本只含「IR + backend + ffmpeg 版本 + 字体 + 目标规格」。
而 tag 是代码里推导的，不由 IR 决定 —— 修了 tag，IR 一个字段没动，键不变，
线上继续拿旧的 `hev1`。

修法两层：

- `encoder_signature(ir)`：codec / tag / preset / crf / gop / 音频规格进键
- `COMPILE_REV`：编译器自身版本也进键（`test_05` 钉住）

代价：本次 bump 到 2，全部渲染缓存失效一次。有意为之 —— 宁可重算，
也不要让用户拿到与当前代码不一致的产物。

### 引擎侧现在的真实状态

| 能力 | 状态 |
|---|---|
| h264 出片 | ✅ 全量回归（默认编码，21 条语料 + 134 项测试） |
| hevc 出片 | ✅ 实测 pass + `hvc1`（新增常驻断言） |
| av1 出片 | ✅ 实测 pass + `av01`（新增常驻断言） |
| MLT 后端 | ✅ 8 项（含 hevc tag、音乐床、响度、多音轨） |
| 转场 | ❌ IR 无转场语义，两个后端都没接 |
| 多轨 alpha 叠加 | ❌ 未做 |
| 字幕资产 | ❌ 归一化时丢弃并写 warnings |
| 每轨音量自动化 / ducking | ❌ 需先扩 IR 字段 |
| GPU 编码 | ❌ 无（Colima 无 GPU） |
| HDR 交付 | ❌ 只做预览级 tonemap 到 bt709 |
| 字节确定性 | ✅ ffmpeg 承诺；MLT 未验证 |

### 回归

```
unittest   SQLite 134/134（跳过 5：4 项 MLT 真渲染 + 1 项 PG 契约）
           PG     134/134（跳过 4：全是 MLT 真渲染）
MLT 套件   8/8（镜像内）
容器 E2E   10/10
```

新增 `tests/test_codec_branches.py`（9 项）、MLT `test_08`；
`compile_ffmpeg.encoder_signature()` / `COMPILE_REV`、
`compile_mlt.finalize_argv()`。

---

## 续轮 10 · 后端引擎四项能力落地（15:20–16:10）

上一轮结尾的引擎清单里有 4 个 ❌，这轮全部做完。每项都先定 IR 语义、再改编译器，
最后用**可量化**的渲染证据验证 —— 不是「argv 里有这个滤镜」就算完成。

### 1 · 转场

```json
{"asset": "a1", "at_frame": 50, "out_frame": 180,
 "transition_in": {"type": "fade", "frames": 20}}
```

语义：带转场的段从**前一段结束前 N 帧**开始（`at_frame == 前段 out_frame - N`），
两段真实重叠 N 帧，总时长不变。副产品是 **xfade 的 offset 恰好等于 `at_frame/fps`** ——
不需要累计计算，也不会有累计误差。

| 判据 | 实测 |
|---|---|
| 时长守恒 | 180 帧 / 6.000s（与无转场一致） |
| 转场中点 | 与 A、B 的差异各占全差异 0.2–0.8 倍 |
| 硬切对照 | 三帧 MAD≈5（同一机位），转场版 42→68→107 递增 |

支持 8 种：`fade` `dissolve` `wipeleft` `wiperight` `slideup` `slidedown` `circleopen` `fadeblack`。

### 2 · 每轨音量

`clip.volume`（0–4，仅 audio 轨）是**混音前增益**。关键设计：`target_lufs` 设为 `null`
可关闭响度归一 —— 否则 loudnorm 会把单音轨的 volume 拉回 -14 LUFS，等于没效果。

| 设置 | mean_volume |
|---|---|
| volume=1.0 | -24.1 dB |
| volume=0.25 | -36.2 dB |
| 差值 | **12.1 dB**（理论 20·log10(0.25) = 12.04） |

### 3 · 字幕资产

`assets[].kind="subtitle"` + `track.kind="subtitle"`，支持 SRT / WebVTT。

- 每 cue 展开成 text clip，走**同一套** Pillow 栅格化 → 继承安全区硬校验、字体指纹、确定性断言
- 时间码按整条时间线解释，再与 clip 窗口求交
- 字幕自带的定位码（`{\an8}`）被剥离：位置只由 `styles` 决定，否则安全区校验形同虚设
- 超框仍 `E_TEXT_OVERFLOW` 硬失败，不静默缩字号

实测：字幕时段近白像素 **1606**，非字幕时段 **0**。

### 4 · 多轨 alpha 叠加

根因不在编译器，在归一化：libx264 **没有 alpha 通道**，归一化一次 alpha 就没了
（实测源 `argb` → 归一化后 `yuv420p` → 叠加变成不透明色块）。

修法：overlay 素材**透传**（不重编码）+ 编译期 `format=yuva420p` + `contain` 的填充色改透明。

| | meanR | meanG | stdevG |
|---|---|---|---|
| 裸底 | 120.9 | 129.4 | 124.0 |
| 叠加 50% 红 | **185.7** | **63.3** | **60.7** |
| 理论值 | 186.5 | 64.7 | 62.0 |

三者全部吻合，说明是精确的 50% 混合且底层纹理保留。

### MLT 后端

- 音量：写成 entry 级 `volume` filter（MLT 没有轨道增益）
- 转场：**未实现，编译前 `E_IR_UNSUPPORTED`** —— 静默降级成硬切比报错更糟

### 回归

```
unittest   SQLite 152/152（跳过 5）   PG 152/152（跳过 4）
MLT 套件   9/9        容器 E2E 10/10
新增       tests/test_engine_caps.py 18 项 + MLT test_09
COMPILE_REV  2 → 3（argv 构造变了，缓存整体失效一次）
```

### 引擎最终清单

| 能力 | 状态 |
|---|---|
| h264 / hevc / av1 出片 | ✅ 三种实测 pass，tag 正确 |
| MLT 后端 | ✅ 9 项（hevc tag / 音乐床 / 响度 / 多音轨 / 音量） |
| 转场 | ✅ 8 种，ffmpeg 后端 |
| 每轨音量 | ✅ 常量音量 + 淡入淡出 |
| 字幕 | ✅ SRT / WebVTT |
| 多轨 alpha | ✅ 保留 alpha |
| GPU 编码 | ❌ Colima 无 GPU，镜像未编 nvenc/videotoolbox |
| HDR 交付 | ❌ 只有预览级 tonemap 到 bt709 |
| 音量自动化 / ducking | ❌ 需扩 IR（关键帧序列 + sidechain） |
| MLT 转场 | ❌ 明确报错，未实现 |
| MLT 字节确定性 | ◐ 未承诺 |

---

## 续轮 11 · 真实素材回归：一条真素材顶十条合成语料（15:38–16:00）

素材来源：`motiongit.com/motiongit/motiongit-promo-main`（template-585）。
主 promo 1920×1080 @60fps / 57s / 37.9MB / h264+aac；另有两个 3.75s 卡片与一张封面。

### 立刻撞到的两件事

| # | 现象 | 判定 |
|---|---|---|
| 1 | 卡片 3.75s @24fps 归一化后 **112 帧**，我按 4 秒（120 帧）排版 → `E_MEDIA_TOO_SHORT` | **保护正确**，改 IR 不改引擎 |
| 2 | 16:9 `cover` 到 9:16 只保留中间 **31.6%** 宽度，promo 两侧的 logo / 时间码 / 说明文字全被切 | **真实缺陷** → 新增 `fit=blur` |

第 2 条是这轮最有价值的发现。比例可以算出来，但**只有拿真实素材跑一遍，
才会意识到「31.6%」等于「边缘信息全丢」**。合成语料（testsrc/colorbar）没有
「边缘有信息」这个属性，所以永远测不出来。

### 新增 `fit: "blur"`

```
split=2
├─ 背景：scale(increase) + crop + boxblur=24:2 + eq(brightness=-0.08)
└─ 前景：scale(decrease)
→ overlay 居中
```

短视频行业标准做法：完整画面居中，上下用同一素材的模糊放大版填满。
`overlay` 轨传 blur 会直接 `E_IR_UNSUPPORTED`（叠加层需要 alpha）。

### 两条成片都跑通了

| | fit=cover | fit=blur |
|---|---|---|
| 规格 | 1080×1920 / 450 帧 / 15.000s / avc1 | 同 |
| 体积 | 4.74MB | 3.46MB |
| 响度 | **-14.2 LUFS**（目标 -14.0）/ TP -1.5dBFS | 同 |
| 断言 | pass | pass |
| 画面 | 两侧被裁，主体仍可辨 | 完整画面居中 + 模糊背景，无黑边无裁切 |

主视频有真实音轨（aac 48kHz 立体声），**响度归一在真实素材上把 -14.2 打进 ±1.0 容差**，
不是只在合成正弦波上成立。

### 另两个真实观察

- 宿主机缺 `Noto Sans CJK SC` → 回退 `Hiragino Sans GB`，回执里有 warning。
  行为正确，但**同一份 IR 在宿主机与镜像里字形不同**，这是跨端一致性的真实风险。
- 卡片素材无音轨 → 引擎补静音并写 warning「模板若依赖音频节拍需人工确认」。

### 回归

```
unittest   SQLite 157/157（跳过 6：5 项 MLT 真渲染 + 1 项 PG 契约）
           PG     157/157（跳过 5：全是 MLT 真渲染）
MLT 套件   9/9        容器 E2E 10/10
新增       TestFitBlur 4 项（19–22）
COMPILE_REV  3 → 4
```

### 这条 blocker 的现状

「真实客户素材回归」**做了一次，但还不能关**：用的是公开 promo（科技风、深色、主体居中），
客户素材可能是实拍人脸、商品特写、强纹理；而且我只人工看了 4 帧。
判定：**可以开始接客户试跑，第一批量产前必须做一次逐镜头人工抽帧复核。**
