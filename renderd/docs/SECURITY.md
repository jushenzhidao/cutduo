# 安全模型与对抗测试结论

本文记录 renderd 的威胁模型、已加固项与仍存在的残余风险。
**结论先行**：51 项对抗测试在容器内全部通过（0 critical）。累计发现并修复 12 个真实缺陷，其中 2 个严重级别（任意文件读取、全 worker 失联时任务永久卡死）。续轮又关闭了 DNS rebinding、存储配额绕过、交付链路 SSRF 后门三项残余风险。

---

## 一、威胁模型

假设攻击者是**已持有合法 token 的租户**（这是最现实的场景：SaaS 的付费客户，或者被泄露的密钥）。
完全未认证的攻击者能触达的面只有 `/healthz` 与 `/metrics`。

| 资产 | 攻击者想做什么 | 缓解 |
|---|---|---|
| 宿主机/容器内文件 | 通过素材路径读任意文件 | 路径围栏（见 §2.1） |
| 内网服务 | 通过 callback_url 做 SSRF 探测 | 协议 + 目标 IP 白名单（§2.2） |
| 其他租户的任务与成片 | 越权读取 | 租户隔离 + 签名绑定 job_id（§2.3） |
| 算力/内存 | 用一条请求打满集群 | 七道容量护栏（§2.4） |
| 数据库 | SQL 注入 | 全参数化 + 无字符串拼接（§2.5） |
| 交付链路 | 伪造下载链接 | HMAC + 过期时间（§2.3） |

**明确不在威胁模型内**：拿到宿主机 root、拿到 `RENDERD_SECRET`、物理接触磁盘。
这些情况下任何应用层防护都无效，属于基础设施安全范畴。

---

## 二、已加固项（附修复前的实证）

### 2.1 任意文件读取（critical，已修）

**修复前**：`POST /v1/render` 里 `assets[].uri` 传 `file:///etc/passwd`，服务会真的打开它
（返回 `E_INPUT_AUDIO_ONLY`，说明 ffprobe 已经解析过文件头）。

**修复**：`resolve_uri()` 强制围栏：

```python
media_root = cfg.media_dir.resolve()
if uri.startswith("upload:"):
    name = uri.split(":", 1)[1]
    if not UPLOAD_NAME.match(name) or ".." in name:  # ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
        deny(...)
    p = (media_root / name).resolve()
    if not _inside(p, media_root): deny(...)
elif uri.startswith("file://"):
    p = Path(uri[7:]).resolve()
    if not cfg.allow_arbitrary_paths and not _inside(p, media_root): deny(...)
```

`Path.resolve()` 会解开符号链接，所以软链逃逸也被覆盖。
越界统一返回 `403 E_MEDIA_FORBIDDEN`，并提示改用 `upload:<name>`。

本地开发需要读任意路径时显式开 `RENDERD_ALLOW_ARBITRARY_PATHS=1`（生产禁止）。

**回归**：B01–B04、B10 五项，目标都是真实存在的文件（`/etc/passwd`、`/proc/self/environ`、`/etc/hostname`），必须全部 403。

### 2.2 SSRF（high，已修）

**修复前**：`callback_url` 原样存库，渲染完成后 `urllib.request.urlopen()` 直接请求。
在云环境里可以直接打 `169.254.169.254/latest/meta-data/` 拿实例凭证。

**修复**：`check_callback()` 在**提交时**校验：

1. 协议只允许 `http` / `https`（拦掉 `file://`、`gopher://`、`dict://`）
2. 解析域名，拒绝 `is_private / is_loopback / is_link_local / is_reserved / is_multicast / is_unspecified`
3. 域名解析失败 → 直接报错（fail-closed）

内网回调需显式开 `RENDERD_ALLOW_PRIVATE_CALLBACKS=1`。

**残余风险**：DNS rebinding（提交时解析到公网、投递时解析到内网）。
彻底解法是在投递时重新解析并校验，或在网络层限制 egress。已记入 blockers。

### 2.3 越权与签名

- 带 token 访问 `/v1/jobs/{id}`、`/receipt`、`/video` 时都会走 `_get_job(id, tenant)`，不属于本租户一律 404（不泄露存在性）。
- 不带 token 时走 HMAC 签名：`sig = HMAC-SHA256(secret, "{job_id}:{exp}")[:32]`。
  签名**绑定 job_id**，A 任务的签名拿去访问 B 任务会失败（A08 已验证）。
- 签名过期即失效；篡改 sig 返回 401。
- 签名 URL 等价于 bearer 凭证 —— 这是预设行为（同 S3 presigned URL），泄露即失效，默认 1 小时。

### 2.4 容量护栏（防 DoS）

| 护栏 | 默认值 | 环境变量 |
|---|---|---|
| 请求体大小 | 4 MB | `MAX_JSON_MB` |
| 上传大小 | 512 MB | `MAX_UPLOAD_MB` |
| 成片时长 | 600 s | `MAX_OUTPUT_SECONDS` |
| 素材数 | 64 | `MAX_ASSETS` |
| 单轨片段数 | 512 | `MAX_CLIPS_PER_TRACK` |
| 单条文本字数 | 4000 | `MAX_TEXT_CHARS` |
| 单帧解码像素 | 4096×4096 | `MAX_DECODED_PIXELS` |
| 租户 QPS | 10 | `QUOTA_QPS` |
| 月渲染时长 | 1000 min | `QUOTA_MINUTES` |

两个实现细节值得记：
- **超大 body 先丢弃再回 413**。直接 `close()` 会让客户端在发送途中被 RST，连错误码都读不到。
- **JSON 深度炸弹**（4000 层嵌套）会触发 `RecursionError`，必须显式归到 400，否则是 500。

### 2.5 注入

- SQL 全参数化，`tenant` / `idempotency_key` / `job_id` 都走占位符。注入串只会变成普通字符串（E01/E02 验证：202 接受、表结构完好）。
- **不经过 shell**：渲染是 `subprocess.Popen(argv_list)`，文本里的 `$(...)`、反引号、`|` 都只是字面量。
- 路由正则 `[A-Za-z0-9_]+` 天然阻断路径字符；evidence 文件名再做一次 `Path(name).name` 净化。
- 上传扩展名白名单 `\.[a-z0-9]{1,8}`，异常扩展名一律降级为 `.bin`。

### 2.6 租约与单点故障（critical，已修）

**修复前**：租约回收只写在 `Worker.run_forever()` 里。**所有 worker 都挂掉时，没有任何进程扫描过期租约**，
任务永久停在 `running`，客户只能干等。

**修复**：抽出 `start_reaper()`，API 进程默认启动（`RENDERD_REAPER=1`），并提供 `renderd reaper` 子命令供分离部署。

**验证**：`tests/compose_e2e.sh` 用 `docker compose kill -9 worker` 制造真实崩溃，
15s 后任务被识别为租约过期、重新入队，worker 拉起后自愈（attempts=2），四条任务全部成功。

### 2.7 容器内字体（functional，非安全）

容器里是 Noto CJK，模板写的是 Hiragino。两个连锁问题：
1. `.ttc` 只注册 face 0，而 Noto CJK 的 face 0 是 **JP** → `Noto Sans CJK SC` 永远查不到 → 回退到 DejaVu（无 CJK）→ `E_FONT_MISSING`。
2. 同族多字重按字典序取首个，Debian 的 Bold 排在 Regular 前 → 正文整篇变粗。

修复：枚举 ttc face（`path#face`）+ 字重打分（Regular 优先）+ 回退留痕（`receipt.warnings`）。

---

## 三、对抗测试清单（48 项）

| 组 | 项数 | 覆盖 |
|---|---|---|
| A 认证与授权 | 10 | 无/错 token、跨租户读任务/回执/成片、伪造签名、过期签名、跨任务重放、公开端点 |
| B 路径与文件 | 10 | `file://` 任意路径 ×3、`upload:` 穿越、相对路径穿越、evidence 穿越 ×3、0 字节、垃圾上传 |
| C SSRF | 5 | 云元数据、`file://`、回环、`gopher://`、内网网段 |
| D 资源耗尽 | 8 | JSON 深度炸弹、24MB body、2 万字文本、300 素材、2 小时 4K、12 并发同幂等键、QPS、慢速 POST |
| E 注入 | 6 | SQL ×2、表可用性、命令替换、null 字节、非法 UTF-8 |
| F 业务逻辑 | 5 | dry_run 不扣配额、同键改 payload、非法 priority、frames_total 撒谎、5000×5000 解码炸弹 |
| G 运维面 | 4 | healthz 字段、metrics、404、非法方法 |

**结果**：宿主机 48/48、容器 48/48，0 critical。

复跑方式：

```bash
python3 tests/attack.py --base http://127.0.0.1:8787 \
  --token <tokenA> --other-token <tokenB> --burst-token <lowQpsToken> \
  --secret <RENDERD_SECRET> --json attack.json
```

---

## 四、残余风险（未修，已记入 blockers）

| 风险 | 影响 | 建议 |
|---|---|---|
| DNS rebinding 绕过 SSRF 校验 | 回调可打到内网 | 投递时重新解析 + 网络层 egress 白名单 |
| 签名 URL 无租户绑定 | 泄露即可下载 | 短期够用；需要时可把 tenant 签进 sig |
| `/metrics` 公开 | 暴露任务总量与状态分布 | 生产用反代加 IP 白名单 |
| 无速率限制的 `/v1/assets` | 可刷满磁盘 | 加租户级存储配额（当前只有渲染时长配额） |
| SQLite 单机 | 多机部署需换 store | 见 blockers §4 |
| 无 WAF / 无 TLS | 明文传输 | 反向代理终止 TLS |

---

## 五、一条经验

**对抗测试的价值不在"全绿"，在它暴露的那两个 critical。**
如果只跑功能测试，`file:///etc/passwd` 和一个 kill -9 都不会被碰到——
而这两个恰好是「上线第一天就会被利用」和「上线第一周一定会遇到」的。


---

## 六、续轮新增加固（2026-11-09）

上一版留下 4 条残余风险，这一轮全部关闭，并补了两条新的攻击面。

### 6.1 DNS rebinding（high，已修）

**原缺陷**：`check_callback()` 只在**提交时**解析域名并检查 IP。攻击者让域名第一次解析到公网、投递时解析到内网，就能打云元数据。

**修法**：新增 `netguard.py`，把「解析一次 → 钉住 IP → 之后永不二次解析」做成唯一出网路径。

1. 提交时 `resolve_pinned()` 校验协议、拒绝 URL 内嵌凭据、解析并拒绝所有私网/回环/链路本地/保留地址；结果（含 IP、host、port、path）JSON 化存进 `jobs.callback_ip`。
2. 投递时 `pinned_request()` **手写 HTTP/1.1 over pinned socket**：`socket.create_connection((ip, port))` 直连，HTTPS 用 `server_hostname=host` 保留 SNI、Host 头保留原域名。全程不调用 `urllib`（它会自己再做一次名字解析）。
3. 投递前 `revalidate_pin()` 复核钉住的 IP 仍然合法。
4. **IPv4 优先 + 备选地址逐个重试**：实测 `getaddrinfo("localhost")` 首个返回 `::1`，而绝大多数接收端只监听 `0.0.0.0` —— 钉死第一个 IP 会直接 ECONNREFUSED。这是加固测试第一次跑出来的真实缺陷，不是理论推演。

**实证**（`tests/test_hardening.py::test_04`）：投递阶段把 `socket.getaddrinfo` 换成「非 IP 字面量一律抛 gaierror」的守卫，模拟域名解析完全失效 / rebinding；webhook 仍送达，且 Host 头是原域名。若走二次解析，这条必然失败。

### 6.2 存储配额（high，已修）

`usage` 表新增 `bytes` 列，`tenants` 新增 `storage_mb`（默认 2048）。`put_asset()` 在**锁内**完成「查配额 → 写文件 → 记用量」，避免并发上传绕过；内容寻址去重，重复上传同一文件不重复计费；跨月求和读取（文件不会因月份翻篇消失）。超限返回 `413 E_QUOTA_STORAGE_EXCEEDED`。

对抗用例 F06：1MB 配额租户第一次上传 700KB 成功、第二次 413。

### 6.3 交付链路不能成为 SSRF 后门（high，已修）

新增 `delivery.put_url`（成片直传客户预签名 PUT URL）后，出现了第二条出网路径。**所有出网必须走同一个 netguard**：`delivery.parse_spec()` 在提交期调用 `resolve_pinned()`，投递期用钉住的 IP 做 PUT。

对抗用例 F07/F08：`169.254.169.254` 与 `file:///etc/passwd` 均被 `E_CALLBACK_FORBIDDEN` 挡下。

### 6.4 `/metrics` 与明文 HTTP（medium，已修）

- `/metrics` 增加来源 CIDR 白名单（`RENDERD_METRICS_CIDRS`，默认仅 loopback + 三个私网段的运维网），非白名单 `403 E_METRICS_FORBIDDEN`。
- 服务内置可选 TLS（`RENDERD_TLS_CERT` / `RENDERD_TLS_KEY`），并提供 `deploy/Caddyfile` + `docker-compose.tls.yml` 作为生产推荐（TLS 终止 + 双层白名单 + 请求体上限）。
- `tests/tls_smoke.sh` 6/6：HTTPS healthz 200、明文 HTTP 被拒、loopback metrics 200、收紧白名单后 403 且错误契约正确。

### 6.5 输入归一化预检（functional，非安全但影响信任）

`Normalizer.precheck()` 在提交期做抽样解码。c09 截断文件 ffprobe 显示时长 20 秒、编码正常、元数据完全健康，只有真解码才会在 12 秒处报错。以前它会在 worker 阶段莫名失败，Agent 以为提交成功；现在提交时直接 `422 E_INPUT_TRUNCATED`。

### 6.6 交付正确性（非攻击面，但属于「看起来成功」类事故）

HDR 素材以前直接 `format=yuv420p` 会偏色，L1/L3 断言全都抓不到。归一化引擎接入后：HDR 走 zscale 线性光 + hable tone mapping、旋转矩阵烤进画面、黑边裁切、奇数边用 crop、音轨统一 48k 立体声；所有动作写进 `receipt.L0_ingest`，**禁止静默改变素材语义**。21 条脏语料回归全部通过。

---

## 七、当前残余风险（重写）

| 风险 | 状态 | 说明 |
|---|---|---|
| DNS rebinding | **已关闭** | pin IP + 投递期零解析，有实证测试 |
| 存储配额绕过 | **已关闭** | 锁内校验 + 跨月累计 |
| 交付链路 SSRF | **已关闭** | 与 webhook 共用 netguard |
| `/metrics` 公网暴露 | **已关闭** | 服务层 + 网关层双白名单 |
| 无 TLS | **已关闭（提供配置与实测）** | 生产仍需换成 ACME 真证书 |
| SQLite 单机 | 保留 | 架构约束，不是缺陷；换 store 实现即可横扩 |
| 真实客户素材回归 | 保留 | 合成语料覆盖故障模式，不覆盖真实噪声分布 |
| 归一化产物的磁盘占用 | 保留 | `mezz/` 内容寻址缓存无自动 GC；提供 `renderd gc` 但默认 dry-run |
| 签名 URL 不绑定租户 | 保留 | 当前是 S3 presigned 语义，泄露即失效 |
| HDR 为预览级 tone mapping | 保留 | 非广播级调色，receipt 已明确标注 |

---

## 八、对抗审查：五条被坐实的问题（10:04–10:20）

这一轮不接着补用例，而是先回到基本事实重算信任边界，每条先写可复现实验再改。
探针脚本：`/tmp/adversarial_probe.py`（修复前后各跑一次）。

| # | 问题 | 级别 | 修复前（实测） | 修复后（实测） |
|---|---|---|---|---|
| A | 默认签名密钥可伪造下载 URL | critical | 用源码常量伪造 → `auth.verify=True` | `False`；服务自签 URL 仍 `True` |
| B | 出站请求头 CRLF 注入 / 覆盖 Host | high | 收端收到 `X-Injected: yes`、`Host: evil.example` | `ValueError` 拒绝；合法头仍可用 |
| C | 证据文件无内容承诺 | high | 无 `evidence_sha256`，替换证据后 verdict 仍 pass | 4 个文件全有哈希，篡改可检出 |
| D | 唯一交付通道失败仍判 pass | high | `verdict=pass`, `failures=[]` | `verdict=fail`, `E_DELIVERY_FAILED` |
| E | 墙钟前跳误回收 running 任务 | critical | +3600s → 回收，`status→accepted`（双领） | 回收 `[]`，`status=running`，`clock_skew_s=3600` |

### A · 密钥熵不能来自源码

`_secret()` 原本回退到 `"renderd-dev-secret"`，三个 compose 的默认值是 `change-me`。
拿到代码的人可以对任意 `job_id` 伪造签名 —— 这是「看起来有 HMAC，实际没有签名」。

修法：`auth.init_secret(data_dir)`。显式配置就用；未配置则生成 32 字节随机密钥，
以 `0600` 落盘到 `data_dir/.signing_key`（重启不失效）；已知弱值启动即 `RuntimeError`。
`doctor` 增加 `signing secret 非弱值` 检查并显示来源。

### B · 净化在准入边界，不在出站前一刻

手写 HTTP/1.1 时把用户头直接拼进 `k: v\r\n`，一个 `\r\n` 就能注入任意头。
`netguard.sanitize_headers()` 做三件事：头名必须是 HTTP token；头值不能含控制字符或
非 ASCII；`Host / Content-Length / Connection / Transfer-Encoding` 不可覆盖。
校验同时放在**准入期**（`delivery.parse_spec`，返回 400 + field）和**出站前**
（`pinned_request`，纵深防御）。

### C/D · 回执必须对「它引用的每个文件」做承诺

Agent 看不见视频，只信回执。原来只有成片有 `render_sha256`，
contact sheet / 首尾帧 / 波形图被替换后回执毫无察觉。现在 `_deliver` 在
`copy_evidence` 后为每个文件计算 `sha256`，写进 `receipt.evidence_sha256`。

同样地，「成功」必须包含「客户能拿到」：`put_url` 唯一交付通道失败时，
`job.status` 仍是 `succeeded`（成片确实生成、本地可取），但
`receipt.verdict` 降级为 `fail` 且 `failures` 含 `E_DELIVERY_FAILED`。
只写 warnings 等于让 Agent 继续相信 pass。

### E · 时钟不确定时不动状态 → 后来改成「时间本身不跳」（续轮 5）

租约判断是 `lease_until < now`。墙钟一前跳，所有 running 任务同时满足过期条件，
reaper 全改回 accepted，而原 worker 还在渲染 —— 新 worker 立刻领走，双领。

最初是「检测到跳变就跳过回收」——那是**缓解**：时钟异常期间租约回收停摆，且只要
有一次跳变发生在两次扫描之间，仍可能误回收。续轮 5 换成**单一时钟源（HLC）**：

```
逻辑时间 = 锚点(墙钟, 单调钟) + 单调钟增量     # 墙钟只用于观测跳变
clock.last_ts 在 DB 内只前进不回退              # 跨实例对齐
```

租约、退避、超时、`gc` 截止全部改用 `db_now()`。墙钟前跳/回拨都不再影响判断；
跳变会落 `clock_events` 并写 `audit(clock_skew_detected)`，`clock_skew_s` 跨实例可见。

### F · 签名 URL 必须绑定「谁」和「用来干什么」（续轮 5）

原来签名载荷只有 `job_id + exp`：一个成片链接可以原样拿去取同一个 job 的
contact sheet / 首尾帧 / 波形图；URL 也不含任何租户承诺。

现在载荷是 `["v2", tenant, scope, job_id, exp]`：

| 场景 | 结果 |
|---|---|
| 正常取成片 | 200 |
| 拿成片签名取 `evidence/contact_sheet.jpg`（scope 不同） | 401 |
| 把 `t=acme` 改成 `t=rival` | 401 |
| 改 `job_id` 保留签名 | 401 |
| 用源码常量伪造 | 401 |

顺序也有讲究：**先验签、再查任务、最后比对 owner**。反过来会变成
「用 404/401 的差异探测某个 job_id 是否存在」。每次成功下载写
`audit(action="download.signed", tenant, target, ip, scope)`，泄露链接可追溯。

### 固化

- `tests/test_adversarial_review.py` 8 项常驻断言（8/8 OK）
- `tests/test_cluster_state.py` 10 项（多进程限流/配额、HLC、签名绑定）
- 对抗套件 H 组扩到 6 项：CRLF / Host / Content-Length / 默认常量伪造 / 跨 scope / 换租户 → 共 **57 项**

### 续轮 6 · 租户边界（三条「单租户开发时看不见」的问题）

| # | 问题 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | 认证失败不受限流 | `admit()` 先 `resolve()` 再 `rate_hit()`；错 token 在限流之前就抛 401，可以无限打 | 同 IP 的**无效令牌**超过 `AUTH_FAIL_QPS`（默认 10/s）→ `429`；合法令牌不受影响（NAT 不误伤） |
| 2 | `/v1/queue` 泄露邻居 | 任何合法租户都能看到全部租户名与在途数 | 普通租户 `scope=tenant`，只看自己；`RENDERD_ADMIN_TOKENS` 才返回全量 |
| 3 | 素材无法回收 | 只记 `usage.bytes` 聚合值，文件删不掉、配额退不回（只增不减） | `assets` + `asset_refs` 两张表；`DELETE /v1/assets/{id}` 释放引用，最后一个引用消失才删文件；配额按引用求和 |

第 1 条的设计取舍：**不按 IP 一刀切**。一开始「该 IP 失败过就拦所有请求」，
实测攻击套件整组变成 429 —— 同一出口 IP 后面的正常客户会被一起打死。
现在只拦「令牌不在配置里」的请求（一次 dict 查，微秒级），保护目标不变：
洪水被 429 挡住，且不会打到数据库。

第 3 条的安全约束：

- 跨租户删除一律 `404`，不能用来确认别人的素材是否存在
- 仍被 `accepted/running` 任务引用时 `409 E_ASSET_IN_USE`
- 删除写 `audit(action="asset.delete")`，含退回字节数与是否删文件
- 内容寻址去重时，非付费租户也保留一条 `bytes=0` 的引用 —— 否则付费方删除会误删别人还在用的文件

### 本轮之后仍存在的

| 风险 | 说明 |
|---|---|
| 密钥与 `data_dir` 同生命周期 | 删 `data_dir` 等于轮换密钥；没有显式轮换命令 |
| 逻辑时间与墙钟可能长期偏移 | 跳变被吸收后不自动回归，重启才对齐；只影响排查时对 `created_at` 的解读 |
| 文件卷仍未跨机 | 状态可多 pod，素材/成片/缓存仍在同一卷（blockers §8.1） |
| webhook 仍同步投递 | 收端不响应时阻塞 worker（blockers §6.2，P1 契约变更） |
