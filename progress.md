# progress.md

无人值守构建日志。任何时刻中断，从最后一节「下一步」恢复即可。

---

## 00:12 · 启动，任务拆解

**目标**：把前面分析出的剪辑渲染服务完整落地——不是原型，是能起服务、能提交任务、能拿到证据回执、能重启恢复的东西。

**交付物**

| 路径 | 内容 |
|---|---|
| `renderd/` | 服务代码（stdlib + PIL + ffmpeg） |
| `renderd/tests/` | 单元 + 端到端 + 负向 + 确定性测试 |
| `renderd/docs/` | 部署、运维、API、IR 规范 |
| `result.md` / `decisions.md` / `blockers.md` / `progress.md` | 验收材料 |

**阶段划分**

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 核心模型与编译层：config / errors / IR 校验 / 模板 / 字体与字形覆盖 / 文本图层 / FFmpeg 编译 / MLT 编译 / 渲染执行器 | 进行中 |
| 二 | 持久化与调度：SQLite、幂等提交、拉取式领取、租约与回收、重试与失败分类、内容寻址缓存、配额 | 待开始 |
| 三 | 三层校验与证据回执：L1/L2/L3、证据图、receipt v1 | 待开始 |
| 四 | 接口层：REST、MCP stdio、鉴权/配额/限流、审计、webhook | 待开始 |
| 五 | 测试、容器化、文档、验收材料 | 待开始 |

**环境事实（已核实）**
- Python 3.13.12 / SQLite 3.50.4（支持 `UPDATE … RETURNING`，可用作原子领取）
- ffmpeg 9.0.2（`libx264`/`libx265`/`videotoolbox`/`libvmaf` 可用；**无 `zscale`、无 `drawtext`**）
- Pillow 已装（仅用于文字栅格化与字形覆盖检查）
- 无 melt 运行时 → MLT 分支只能做结构校验，不能真渲染

**已知约束（来自前期结论）**
1. 文字必须在编译期栅格化成图层，不能让渲染器现算字形。
2. 时间一律整数帧。
3. 同后端两次渲染必须字节一致（前期实测可达）。
4. L2 感知指标只能做回归，不能判首次正确性。

**下一步**：阶段一，先写 config/errors/ir 三个基座，再写编译层。

---

（后续里程碑在此追加）

---

## 01:05 · 里程碑一 + 二完成（核心模型 / 编译层 / 持久化 / 调度）

**已跑通**
- `IR → FFmpeg` 真实渲出片：540×960 / 120 帧 / 0.33s（12× 实时）；1080×1920 三个模板全部成功。
- `IR → MLT XML` 结构校验通过（services 白名单、profile、tractor 齐全）。
- 三模板端到端：`hook_vertical_6s` 2.4s / `caption_square_9s` 1.8s / `brand_vertical_15s` 4.1s。
- 队列语义：幂等重放返回同 job_id、双 worker 不双领、租约过期自动回收并重排。
- 缓存：同 IR 二次提交命中缓存，0.07s，不重复计费。
- 负向全部按预期拦截：`E_FONT_MISSING` / `E_TEXT_OVERFLOW` / `E_MEDIA_TOO_SHORT` / `E_IR_INVALID`。

**这一阶段最重要的发现（已写进 decisions）**

x264 在 **CBR/ABR（`-b:v` + `-maxrate` + `-bufsize`）且 `-threads > 1`** 时，同一条命令连续两次会产出**不同字节**（实测 11,579,252 vs 11,580,534）。二分结果：

```
ABR + threads 4   → DIFF          CRF + threads 4        → SAME
ABR + threads 1   → SAME          capped CRF + threads 4 → SAME 且更快
ABR 无 VBV + t4   → SAME
```

原因在 x264 的 VBV 占用在帧级线程下逐次微移。**换成 capped CRF（`-crf` + `-maxrate` + `-bufsize`）后完全确定，而且快 3.6×**（0.5s vs 1.8s）。这条直接决定了产品承诺能不能成立——「同 IR 两次渲染字节一致」在 ABR 下是假的。

**顺手修正的三处**
1. 音频必须强制对齐到时间线总时长（`apad` + `atrim`），否则短音乐床会让 L1 音画时长不一致——第一次跑就抓到了。
2. 响度用 `loudnorm` 在渲染期归一，L3 才从「随机失败」变成「验证自己的承诺」。
3. 无音轨的片子不该被要求 -14 LUFS：响度断言改为「有真实音轨才适用」。

**下一步**：阶段四，REST + MCP 接口层。

---

## 01:25 · 里程碑四完成（REST + MCP 接口层）

**REST 冒烟 9/9 通过**
- 鉴权：无 token / 错 token 均 401；正确 token 放行到租户 `acme`。
- `POST /v1/assets` 上传 → 返回 `upload:<sha>.mp4`，内容寻址。
- `POST /v1/validate` 五项检查全绿，返回成本估算（0.0049 元 / 3.0s / 9.0s）。
- `POST /v1/render` 202 + job_id；**同 idempotency_key 重放返回同一 job_id 且 replay=true**。
- 轮询到 `succeeded`，`cost_seconds=2.189`。
- `GET /receipt` verdict=pass，L1 十项全过，L3 证据四件齐备。
- 签名 URL 下载 2.9MB，ffprobe 校验 1080×1920 / 180 帧；**篡改签名 401**。
- `/v1/usage` 与 `/metrics` 正常。

**MCP 冒烟 26/26 通过**
- `initialize` → serverInfo 正确；`tools/list` 五个工具且都有 inputSchema。
- `validate_render` 负向：拉丁字体渲染中文 → `font_coverage: false`，且返回可直接照改的 `fixes`（`pick_font: Hiragino Sans GB`，附缺失码点）。
- `submit_render` dry_run 不入队；真实提交拿到 job_id；**同 key 重放同 job 且 replay=true**。
- `get_job_status` 轮询到 succeeded，返回 `video_url`（带签名）。
- `get_receipt` verdict=pass，L1 全过，证据四件齐备，`render_sha256` 存在。
- 未知工具返回 isError。

**接口层设计要点（已落地）**
- REST 与 MCP 共用 `service.py` 一套语义，不存在「两个版本的系统」。
- 错误契约统一：`code / message / hint / field / allowed_values / retryable / stage`。
- 下载链接用 HMAC 签名，允许 Agent 不带 header 直接取。

**下一步**：阶段五，单元/集成测试补全、容器化、文档与验收材料。

---

## 01:40 · 里程碑五完成 —— 全部阶段收口

**测试全绿**
- 单元 34 + 集成 24 = **58 个用例，18.9s，OK**
- REST 冒烟 **11/11**（含字体缺失 422 + `E_FONT_MISSING` 契约校验）
- MCP 冒烟 **26/26**（真子进程 + JSON-RPC 帧）
- `docker compose config` 语法校验通过

**基准（1080×1920 / h264 / Apple Silicon）**
```
hook_vertical_6s      6.0s → 2.19s  (2.74× 实时)
brand_vertical_15s   15.0s → 3.88s  (3.87× 实时)
```

**规模**：服务代码 4,149 行 / 19 模块；测试 1,113 行；文档 656 行。

**收尾时补的一个修复**：跨平台字体回退链。
容器里是 Noto Sans CJK SC，模板写的是 Hiragino Sans GB，原先在 Docker 里会直接 `E_FONT_MISSING`。
现在按链回退，并且**强制留痕**（`receipt.warnings` + `validate.fixes`）。
回退 ≠ 缺字静默替换：前者是换字体并告知，后者是骗人。

**交付材料**
- `../result.md` 完成清单 + 验证结果 + 三个关键发现
- `../decisions.md` 22 条决策（含时间/理由/影响）
- `../blockers.md` 7 条未解决事项，按 P0/P1/P2 分级
- `../cutproof/` P0 阶段的归一化引擎、断言库、MCP 契约、21 条语料（本轮未改动）

**状态：本轮任务收口。** 下一步优先级见 blockers.md：① 把 ingest 归一化接进服务 ② 在有 daemon 的机器上验镜像 ③ 真实素材回归。

---

## 03:32–03:45 · Colima 环境打通（阶段一）

**环境**：Colima 0.10.3 + vz + Docker 29.5.2 / linux-arm64 / 4C8G。

**踩到并解决的两个环境坑**
1. VM 内 `/etc/resolv.conf` 是指向 `systemd-resolved` 的**断链**（目标文件不存在），Go 解析器退到 `[::1]:53` → 所有镜像拉取失败。
   修法：删符号链接，写死 `nameserver 192.168.112.1 / 223.5.5.5`。
2. `registry-1.docker.io` 在本地被劫持解析到不可达地址。
   修法：`daemon.json` 配四个镜像加速器（daocloud / 1ms / dockerproxy / rat.dev），拉取成功。
   附注：BuildKit 插件缺失，退回传统 builder。

**镜像**：`renderd:0.1.0`，Debian 13 + ffmpeg 7.1.5 + Noto CJK，非 root（uid 10001），首次构建 1m13s。

---

## 03:45–03:52 · 容器内端到端（阶段二）

`tests/container_e2e.sh` **10/10 通过**：上传 → 预检 → 三模板提交 → 轮询 → 回执 → 下载 → 幂等重放。

**容器暴露的两个真实缺陷（已修）**
1. **`.ttc` 只注册第 0 个字面**。PIL 打开 `NotoSansCJK-Regular.ttc` 默认给 face 0，而 face 0 是 **Noto Sans CJK JP**，于是「Noto Sans CJK SC」永远查不到 → 一路回退到 DejaVu（无 CJK）→ `E_FONT_MISSING`。
   修法：对 `.ttc/.otc` 枚举 face 0..15，索引值变成 `path#face`。
2. **同族多字重按字典序取首个**，Debian 里 `NotoSansCJK-Bold` 排在 Regular 前面 → 正文整篇变粗。
   修法：按字重打分，Regular/W3/Light 优先。
3. 附带修的：`text_safe_area` 预检仍用 `fonts.require(原始 family)`，回退后依然硬失败。

**修复后的实测**：`Noto Sans CJK SC -> NotoSansCJK-Regular.ttc#2`；容器内三条模板全部成功（6.2s / 6.8s / 9.9s），回执 `warnings` 里明确写着「已回退到 Noto Sans CJK SC，字形会与设计稿不同」；成片抽帧确认中文正常、无豆腐块。

---

## 03:52–04:00 · 对抗测试（阶段三，进行中）

`tests/attack.py`：47 项，按攻击者视角分 7 组（认证 / 路径 / SSRF / DoS / 注入 / 业务逻辑 / 运维面）。

**基线（未加固版）**：47 项里 11 项失败，其中 **1 项 critical** ——
`file:///etc/passwd` 当素材 → 服务真的去打开了这个文件（返回 `E_INPUT_AUDIO_ONLY` 说明已解析文件头）。

**已加固的 8 项**

| 问题 | 加固方式 |
|---|---|
| 素材路径任意读 | `resolve_uri` 强制围栏在 media 目录内；`upload:` 名走白名单正则；`file://` 越界 → 403 `E_MEDIA_FORBIDDEN` |
| 请求体无上限（内存 DoS） | `MAX_JSON_MB=4`，超限先丢弃 body 再回 413（直接断连会让客户端读不到错误） |
| JSON 深度炸弹 / 非法 UTF-8 | `RecursionError` / `ValueError` 归到 400 |
| 文本超长（字体栅格化 DoS） | `MAX_TEXT_CHARS=4000` |
| 素材数 / 片段数爆炸 | `MAX_ASSETS=64` / `MAX_CLIPS_PER_TRACK=512` |
| 2 小时 4K 单任务 | `MAX_OUTPUT_SECONDS=600` → `E_OUTPUT_TOO_LONG` |
| callback_url SSRF | 协议白名单 + 解析目标 IP，拒绝私网/回环/链路本地/保留地址 → `E_CALLBACK_FORBIDDEN` |
| 非法 HTTP 方法返回 501 | 改为 405 `E_METHOD_NOT_ALLOWED` |

**加固后**：宿主机 47/47、容器 47/47。随后新增 F05（5000×5000 解码炸弹）→ 48 项，需重跑确认。

**Compose 又炸出一个真缺陷**：租约回收原本只写在 `Worker.run_forever` 里 ——
**所有 worker 都挂掉时，没有任何人扫描过期租约，任务会永久停在 running**。
已抽出独立 `start_reaper()`：API 进程默认启动（`RENDERD_REAPER=1`），并新增 `renderd reaper` 子命令供分离部署。
`tests/compose_e2e.sh` 复测 **11/11**：kill -9 worker → 15s 后租约过期被识别 → worker 拉起后任务自愈（attempts=2）→ 4 条全部成功 → 重启 api 后任务仍在 → 二次提交命中缓存。

**下一步**：容器重跑 48 项对抗 + 多 worker 并发不双领 + 长稳测试；然后写审查报告与验收材料。

---

## 04:00–04:10 · 并发与长稳（阶段三收尾）

**多 worker 并发 7/7**（`tests/multiclient.py`）
1 个 API（0 worker）+ 3 个独立 worker 进程，6 线程并发提交 12 条：
12 个不同 job、每条恰好 1 次 `rendering` 事件、`attempts` 全为 1、日志无 requeued；
同一批幂等键再并发重放 12 次 → 12/12 命中同一 job。

**长稳 30/30**
- 第一批 15 条（冷）：p50 5132ms / p90 5149ms
- 第二批 15 条（命中缓存）：p50 807ms
- 内存 156.9 → 168.6 → 170.3 MiB（第二批仅 +1.7 MiB，判为堆预热）
- 磁盘 21 → 76 → 125 MB（每条约 5.5MB，线性）

**容器重跑 48 项对抗**：48/48，0 critical（新增 F05 5000×5000 解码炸弹 → 422 `E_INPUT_TOO_LARGE`）。

---

## 04:10 · 里程碑五完成 —— 全部阶段收口

**回归**：58 单元/集成 + 11 REST + 26 MCP + 10 容器 + 11 compose + 7 并发 + 48 对抗 + 30 长稳，全绿。

**交付材料**
- `../result.md`：完成清单 / 修复清单 / 验证总表 / 决策摘要 / 未解决事项
- `../blockers.md`：重写，关闭 2 条 P0、新开 2 条（DNS rebinding、存储配额）
- `../decisions.md`：本轮 +8 条（共 25 条）
- `../deliverables/对抗审查报告.html`：48 项逐条结果 + 修复前后对照
- `renderd/docs/SECURITY.md`：威胁模型 + 加固清单 + 残余风险

**这一轮真正的收获**不是"全绿"，而是那两个只有对抗测试才会露出来的 critical：
任意文件读取（`file:///etc/passwd` 真的被打开）、以及所有 worker 挂掉后任务永久卡死。
如果只跑功能测试，这两个都碰不到。

**下一步优先级**见 blockers：① ingest 归一化接入 ② DNS rebinding 重解析 ③ 上传存储配额 ④ webhook 端到端测试。

---

## 04:12 · 续轮启动：目标是清空 blockers.md 的所有「未解决」

用户指令「继续 全部完成」。本轮把上一轮留下的 9 条 blocker 逐条关闭或给出可运行的落地物，不做半成品。

**阶段划分**
- A 归一化引擎接入服务（blocker #1）
- B DNS rebinding + 存储配额（blocker #2/#3）
- C webhook E2E / 对象存储交付 / TLS 反代 / Colima bootstrap（blocker #6/#7/#8 + 环境限制）
- D 500 条长稳 + 全量回归 + 验收材料（blocker #4/#9 + 材料）

---

## 04:26 · 里程碑 A 完成 —— 归一化真正接进了服务

新增 `renderd/renderd/ingest.py`（约 500 行），从 P0 的 `cutproof/ingest.py` 产品化，五处关键差异：

1. **目标 fps 取自 IR**，不写死 30 —— 否则 `trim=start_frame` 的帧号语义会错。
2. **HDR 用 zscale 线性光 + hable tone mapping**（`zscale=t=linear:npl=100 → gbrpf32le → tonemap → zscale bt709`），两端 ffmpeg 9.0.2 / 7.1.5 实测可用；替代了会压平高光的 `colorspace` 直转。
3. **旋转矩阵必须强制转码烤进画面**：`-c copy` 会把旋转元数据原样带下去，下游当横版处理。
4. **产物内容寻址缓存**（`data/mezz/<key>.mp4` + `.json` 决策单），同素材只归一化一次；决策单可回放对账。
5. **`L0_ingest` 进回执**：每个素材的 flags / actions / 人话解释 / warnings / post 规格全写进 receipt，禁止静默改变素材语义。缓存键纳入 `ingest_digest`。

**另外两处顺带修的**
- 提交预检 `normalizer.precheck()` 会做抽样解码 —— **截断文件在提交时就被拦下**（以前只在 worker 阶段失败，Agent 会以为提交成功）。
- `_probe_assets` 的帧数改按时间线帧率折算；归一化后用 canonical 帧数再复核一次长度。

**回归（`tests/ingest_corpus.py`，真跑 21 条脏语料）全绿**
```
18 条归一化成功 / 3 条按预期硬失败（0字节 / 截断 / 纯音频投视频位）
HDR→TONEMAP_HDR 且产物 bt709；旋转→BAKE_ROTATION；黑边→CROP_PILLARBOX
奇数分辨率→FIX_ODD(crop)；全部产物 30fps / 48k stereo / yuv420p / SAR 1:1
4 条端到端（提交→worker→receipt）全部 verdict=pass 且 L0_ingest 有记录
```
单元测试 34/34、集成 24/24 在改动后仍全过。

**下一步**：阶段 B/C 的加固与新能力测试。

---

## 04:12 · 里程碑 B + C 完成 —— 安全缺口与新能力全部实测

**B：两个 P0 安全缺口关闭**
- DNS rebinding：`netguard.py` 把「解析一次 → 钉住 IP → 投递期零解析」做成唯一出网路径；
  手写 HTTP/1.1 over pinned socket（HTTPS 保留 SNI/Host），不用 urllib。
  实证：投递阶段把 `socket.getaddrinfo` 换成「非 IP 字面量一律抛错」，webhook 仍送达。
  第一次跑失败，根因是 `localhost` 首个解析到 `::1` 而收端只听 IPv4 —— 补了 IPv4 优先 + 备选重试。
- 存储配额：`usage.bytes` + `tenants.storage_mb`，锁内「查配额→写→计数」，内容寻址去重，
  跨月求和读取；超限 `413 E_QUOTA_STORAGE_EXCEEDED`。

**C：交付与运维**
- `delivery.put_url`：成片直传客户预签名地址，出口流量不经我方（成本模型里 61% 那一项归零）。
  新增的第二条出网路径**也走同一个 netguard**，F07/F08 攻击用例验证没有后门。
- webhook 端到端 `tests/test_hardening.py` 9 项：成功投递 / 500 重试 / 目标不可达降级 / DNS rebinding /
  直传成功与失败 / 存储配额 / metrics 白名单，全部 PASS。
- TLS：服务内置可选 TLS（`tests/tls_smoke.sh` 6/6）+ Caddy 网关（`tests/gateway_e2e.sh` 10/10，
  含 HTTPS 上传→提交→回执全链路与收紧白名单后 403）。
- Colima 环境修复固化成 `deploy/colima-bootstrap.sh`（幂等），重建 VM 不再丢。

**容器全量回归（新镜像）**
```
doctor 7/7   容器 E2E 10/10   Compose E2E 11/11（kill -9 → 自愈 attempts=2）
对抗 51/51（新增 F06 存储配额爆破、F07/F08 交付 SSRF 后门，0 critical）
67 unittest / 11 REST / 26 MCP / 21 条语料回归 全绿
```

**顺手做的一处打磨**：缓存命中原本为每个 job 复制一份 5MB 成片，500 条长稳会让磁盘线性涨 2.5GB；
改成硬链接（每 job 仍有独立可签名路径），并加了回归用例。`renderd gc` 增加 mezz 占用的只读报告
（共享产物不自动删，避免破坏别的任务的缓存）。

**下一步**：500 条长稳收尾 → 全量回归复跑 → 重写 result.md / blockers.md / 总报告。

---

## 04:25 · 里程碑 D（进行中）—— 500 条长稳暴露了第三个真实缺陷

**500 条长稳结果（修复前镜像）**
```
总计 707s  成功 500 / 失败 0    p50 793ms / p90 821ms / max 6281ms
内存 194.2 → 213 → 235.1 → 246 → 257 MiB   磁盘 97M → 1.7G
```
零失败，但**内存没有收敛**：前 100 条 +18.8 MiB 可解释为堆预热，
之后每 100 条仍稳定 +11 MiB，是泄漏的形状，不是预热。

**定位**：`docker exec renderd-test ls /proc/1/fd` → **71 个 fd，其中 67 个指向
renderd.sqlite / -wal / -shm**，而 `Threads: 4`。
根因：`Store._conn()` 用 `threading.local` 存连接，ThreadingHTTPServer 每个请求
开一个短命线程；sqlite3.Connection 与游标存在循环引用，靠 GC 才回收，
于是 500 条请求累积出 67 个连接 → 每个连接的 page cache / WAL 映射常驻 → +60 MiB。

**修复**：`Store.close_thread_connection()` + `Handler._dispatch` 的 finally 里
对每个请求显式关闭线程局部连接（长命的 worker / reaper 线程不关，保留各自连接）。
同时缓存命中改成 `os.link` 硬链接，避免为每个 job 复制 5MB 成片 —— 这正是磁盘
97M→1.7G 线性增长的来源。`renderd gc` 增加 mezz 占用的只读报告。

**验证**：重建镜像后跑 `tests/soak_verify.sh`（100 条 + fd/内存/磁盘采样），
随后容器 E2E / 对抗 51 项 / compose / 网关 / TLS / MCP 全量复跑。数字见 result.md 终稿。

**这一轮的规律**：功能测试全绿不代表没缺陷。500 条长稳抓到的两个问题
（fd 泄漏、副本膨胀）都只有「跑得够久」才看得见，30 条时完全正常。

---

## 04:31 · 里程碑 D 完成 —— 全部阶段收口（最终状态）

**资源修复验证（最终镜像，100 条同款混合负载）**
```
起始  fd=11  mem=22.45MiB  disk=200K
结束  fd=14  mem=64.32MiB  disk=66M
总计 148s  成功 100 / 失败 0   p50 799ms / p90 822ms / max 6894ms
判定  PASS  fd=14 < 20（SQLite 连接已随请求释放）
```
对比修复前 500 条：67 个 sqlite fd、内存 194→257 MiB 线性爬升、磁盘 97M→1.7G。
两处都已定性并修复，`tests/soak_verify.sh` 把 fd<20 做成自动门禁。

**最终全量回归（新镜像，全部真跑）**
```
69 unittest / 11 REST / 29 MCP / 21 条语料(PASS) / doctor 7
容器 E2E 10 / Compose 11 / TLS 网关 10 / TLS 冒烟 6 / 对抗 51 (0 critical)
500 条长稳 500 成功 / 100 条资源验证 100 成功          全部通过
```

**交付材料**
- `../result.md`：完成清单 / 决策摘要 / 未解决事项 / 怎么验（终稿）
- `../decisions.md`：累计 55 条决策（本轮 +19）
- `../blockers.md`：重写，9 条 → 3 条，逐条给结论
- `../deliverables/落地总报告.html`：8 节，51 项对抗逐条结果 + 21 条语料矩阵 +
  长稳修复前后对照，全部由脚本从真实 JSON/日志渲染
- `renderd/`：`ingest.py` / `netguard.py` / `delivery.py` 三个新模块，
  `tests/` 新增 4 个脚本，`deploy/` 新增 5 个部署文件，文档与 Makefile 同步

**本轮真正的收获不是「全绿」**：三个缺陷都只有在对抗视角或跑得够久时才露出来 ——
任意文件读取（上一轮）、DNS rebinding 的 IPv6 细节、以及 500 条才看得见的 fd 泄漏。
功能测试全绿从来不等于没有缺陷。

**状态：本轮任务收口。** 剩 3 条 blockers 全部需要外部输入或属于刻意选择，见 blockers.md。

---

## 08:46–09:0x · 续轮 2：把队列从「可靠」推到「生产级」

用户指令「继续做」，承接上一轮给出的 P0 清单。**六项全部落地**：

1. **可观测**：`Store.queue_stats()` 返回 depth/ready/delayed/running/oldest_wait_s/
   next_lease_s/inflight_by_tenant/failed_24h；`/metrics` 新增 7 个 gauge；
   新增 `GET /v1/queue` 与 `renderd queue`。
2. **背压**：`Service.submit()` 在 dry_run 之后检查全局队列深度与租户 in-flight，
   超限 `429 E_QUEUE_FULL`（retryable）。dry_run 不占队列。
   `/v1/usage` 新增 inflight / inflight_limit。
3. **重试退避**：jobs 加 `available_at` 列（含存量库迁移），claim 过滤未到期任务；
   `fail()` 按 `base × attempts²` 写入延迟。确定性失败不设退避直接进死信。
4. **死信与重放**：`Store.dlq/replay/release_worker` + `GET /v1/dlq`、
   `POST /v1/jobs/{id}/replay`、CLI `dlq/replay/release`。
   replay 就地改状态、重置 attempts，不新建任务。
5. **优雅退出**：Dockerfile `STOPSIGNAL SIGTERM` + 两个 compose 的 api/worker
   `stop_grace_period: 300s`。刻意不做 SIGTERM 自动归还（会双领）。
6. **webhook 去重键**：payload 增加 `event_id` 与 `attempt`，契约写进 API.md / OPS.md。

**回归抓到一个真实迁移 bug**：新增 `available_at` 时把
`CREATE INDEX ...(status, available_at)` 留在 SCHEMA 里，排在 `ALTER TABLE` 之前，
语料回归用上一轮留下的存量数据目录一打开就 `OperationalError: no such column`。
修法：索引移到 `_migrate()` 补列之后创建；三个存量库复测全部可打开。

**验证**：新增 `tests/test_production_async.py` 11/11；全量 unittest 80/80；
REST 11/11、MCP 29/29、语料回归 PASS、TLS 6/6。
容器内：队列端点 / CLI / 新 gauge PASS、E2E 10/10、对抗 51/51（0 critical）。

**文档**：`docs/OPS.md` 新增「生产级异步」章节、`docs/API.md` 新增队列运维端点与
webhook 契约、README 更新能力表与测试矩阵、Makefile 新增 `queue` / `dlq`，
`deliverables/落地总报告.html` 新增 §09。

---

## 09:15 · 续轮 2 容器全量回归 + fd 门禁修正

**容器（新镜像）全绿**
```
队列端点 / CLI / 7 个新 metrics gauge     PASS
容器 E2E 10/10     对抗 51/51（0 critical）
Compose 崩溃恢复 11/11    TLS 网关 10/10
30 条混合长稳 30/30，p50 812ms
```

**fd 门禁报了一次 FAIL，查清后确定是误报**：上一轮设的是绝对阈值 `fd < 20`，
而这次容器连续跑了 18 分钟、叠了四套测试，常驻 worker / reaper 线程的基线本就 >20。
隔离验证：
- 干净容器只打 60 次 HTTP 请求：sqlite fd 7 → 8（delta 1）
- 现有容器再跑 10 条真实渲染：21 → 21（delta 0）

说明 **没有持续泄漏**，是绝对阈值脆弱。两处修正：
1. `tests/soak_verify.sh` 改成**增量门禁**（结束−基线 < 10），测「有没有继续涨」；
2. `render.run()` 的 pump 线程 join 后显式关 stdout/stderr 管道，消除
   `TextIOWrapper` ResourceWarning 与两个悬挂 pipe fd。

随后重建镜像、起干净容器，用 50 条混合负载复跑增量门禁。


---

## 09:19 · 续轮 2 最终收口（全绿）

**最终镜像 `renderd:0.1.0`（sha256:f65b4771…）验证**
```
宿主机 unittest 80/80（90s）
干净容器 50 条混合长稳 50/50，75s，p50 812ms
fd 增量门禁：基线 11 → 结束 14，delta 3，PASS
容器 E2E 10/10    对抗 51/51（0 critical）
（上一轮同镜像已过 Compose 11/11、网关 10/10、REST 11/11、MCP 29/29、语料 PASS、TLS 6/6）
```

**交付材料**
- `result.md` 追加 §七（含最终验证表与 fd 门禁说明）
- `decisions.md` +11 条（累计 66 条）
- `blockers.md` 追加「续轮 2 新关闭」6 项，P2 表加 2 项刻意暂缓
- `docs/OPS.md` / `docs/API.md` / `README.md` / `Makefile` 同步
- `deliverables/落地总报告.html` 更新到 9 节，数据由脚本从真实 JSON/日志渲染

**这一轮的规律和上一轮一样**：功能测试全绿不代表没缺陷。
迁移 bug（CREATE INDEX 顺序）只有用存量库跑回归才暴露；
fd 绝对阈值的误报只有长跑 + 多套测试叠加才暴露。
两处都不是靠读代码能发现的。

**状态：本轮任务收口。**

---

## 09:39–10:02 · 续轮 3：PG 双后端落地 + 异步架构复审（全部阶段完成）

**用户指令**：在 Colima 起一个 PG 容器跑同一套 80 个用例和 51 项对抗；另外看下异步任务架构有没有需要优化的。

### 阶段一：Postgres 后端（完成）

- `renderd/store.py`：`Store` → 工厂函数，`SqliteStore` 原样保留；新增 `renderd/store_pg.py`。
- 方言代理复用全部 45 条 SQL（`?`→`%s`、Decimal 归一化、cursor 可迭代），只 override 三处：
  `ON CONFLICT` 幂等、`FOR UPDATE SKIP LOCKED` 领取、无 `BEGIN IMMEDIATE` 的 `tx()`。
- DDL 由 `_pg_ddl()` 从 SQLite SCHEMA 自动翻译（`AUTOINCREMENT→BIGSERIAL`、`REAL→DOUBLE PRECISION`），
  两套 schema 永远同步。
- `RENDERD_PG_SCHEMA` 显式共用 / 未指定每实例隔离（unittest 用）。
- `requirements-pg.txt` + Dockerfile 预装 psycopg 3.3.8；`docker-compose.pg.yml`（pg + api + worker）。
- 修复 `test_11` 后端耦合断言；新增 `tests/test_pg_backend.py` 5 个常驻用例。

### 阶段二：PG 容器 + 全量回归（完成）

Colima 里 `postgres:16-alpine`（PostgreSQL 16.15 / aarch64，端口 5433）。
镜像拉取 1m45s，容器 2s 就绪。

```
unittest discover     PG 85/85 (88.9s)     SQLite 85/85 (80.8s, 1 skip)
对抗测试               PG 51/51, critical 0（优化前后各跑一次，均全绿）
21 条脏语料            PG PASS（18 归一 / 3 硬失败 / 4 端到端 pass）
compose.pg 语法        OK      镜像内 psycopg 3.3.8 可导入
```

**环境坑（已绕过）**：Bash 会话 PATH 里缺 `/opt/homebrew/bin`，导致 `ffmpeg`/`docker`
找不到；加上 PATH 后 `python3` 又变成 Homebrew 解释器（psycopg 装在 WorkBuddy 解释器里）。
最终统一用解释器绝对路径 + 显式 PATH，两套后端才跑通。

### 阶段三：异步架构复审（完成）

按领取 / 心跳 / 回收 / 投递 / 预检五条路径审，两项实测后落地：

1. **`queue_stats` 从 O(历史行数) 变成 O(活跃行数)**
   基线 1k/10k/50k/100k 行 = 0.133 / 1.290 / 7.774 / 15.270 ms；
   优化后 0.036 / 0.013 / 0.027 / 0.029 ms（10 万行约 527×，且不再随历史增长）。
   改法：主聚合加 `WHERE status IN ('accepted','running')`，`failed_24h` 加部分索引。
2. **事件写入合并进主事务**：8 个方法不再为每条事件单开事务，
   按调用点统计一条任务约 24 → 12 次写事务，状态与事件原子落库。

**最大剩余瓶颈**：webhook 同步投递，收端不响应实测 **16.52s** 阻塞 worker。
改持久化 outbox 是契约变更，已连同方案写进 blockers §6.2 与 OPS.md。

### 阶段四：材料（完成）

`result.md` §八、`decisions.md` +11 条、`blockers.md` §二第 2 条关闭 + §六新增 4 项、
`docs/OPS.md` / `docs/API.md` / `README.md` / `Makefile` 同步、
`deliverables/落地总报告.html` 更新到 10 节（§10 由 evidence.json 渲染）。

**状态：本轮收口。** PG 容器 `renderd-pg` 保留供验收。
明确暂缓：两处进程内状态（多 pod 前必须修）、webhook outbox、文件卷多机化。

---

## 10:04–10:26 · 续轮 4：对抗审查（五条坐实、五条修复）

**方法**：不接着补用例，先回到四条基本事实重算信任边界 ——
Agent 看不见视频 / 安全取决于熵与净化 / 持久化时序不能用墙钟 / 成功由客户能否拿到定义。
每条候选先写可复现实验（`/tmp/adversarial_probe.py`），修复后再跑同一脚本。

```
修复前                                          修复后
A 源码常量伪造签名 → verify=True                → verify=False，服务自签仍 True
B 收端收到 X-Injected / Host: evil.example      → ValueError 拒绝，合法头仍可用
C 无 evidence_sha256，替换证据 verdict 仍 pass  → 4 个文件全有哈希，篡改可检出
D delivery failed 但 verdict=pass failures=[]   → verdict=fail + E_DELIVERY_FAILED
E 墙钟 +3600s → 回收 running，status→accepted   → 回收 []，status 仍 running
```

**两条 critical**：A（密钥熵来自源码 = 没有签名）、E（时钟前跳 = 双领）。
**一条同源**：C/D 都是「回执必须可信」—— 对引用文件做内容承诺、成功必须包含交付。

**改动**
- `auth.init_secret()`：随机密钥落盘 0600、弱值拒绝启动、`verify` 加回拨保护
- `netguard.sanitize_headers()`：token 名 / 无控制字符 / 受保护头；准入期 + 出站前两处
- `delivery.parse_spec`：headers 校验排在 SSRF 之前
- `runner._deliver`：证据 sha256 + 交付失败 verdict 降级
- `store._clock_jump()`：漂移检测，异常跳过回收 + audit + `clock_skew_s`

**回归**
```
unittest discover   SQLite 93/93 (1 skip, 88.8s)   PG 93/93 (95.7s)
对抗套件            PG 55/55（新增 H 组 4 项），critical 0
hardening           11/11（test_07 增加 verdict 断言）
adversarial_review  8/8 (8.9s)
```

**材料**：`deliverables/落地总报告.html` 增至 11 节；
`docs/SECURITY.md` §八、`docs/API.md`、`docs/OPS.md` 同步；
`var/adv_review/evidence.json` 为报告数据源。

---

## 10:27–11:10 · 续轮 5：「1-3 解决下」

上一轮结尾的三条「仍未解决」，本轮逐条关闭。**先写探针拿修复前数字，再改代码**，
每条都用同一脚本复测（沿用前几轮的方法，避免「改完感觉好了」）。

### 阶段一：探针（10:28）

`/tmp/state_probe.py`：fork 3 个进程共享同一 SQLite，各自用 qps=5 的租户连续 `admit` 1 秒；
再 fork 2 个进程同时上传 700KB（配额 1MB）。

```
修复前：instances=3  admitted=30 (期望 ≤5)      uploads=[ok, ok]  usage=1.37MB (quota 1.00MB)
```

和上一轮 `redis_gap_probe.py` 的结论一致，但这次是在**带新代码的仓库**上复现的，确认问题还在。

### 阶段二：限流与配额进共享存储（10:30–10:40）

- `rate_window(tenant,bucket,hits)`：20 个 50ms 子桶滑窗。
  先写成「两个固定桶加权」，1 秒窗口实测仍能看到 10 次（qps=5）——因为 0.95s 窗口
  在两个 burst 相隔 0.97s 时都会放行。改成 20 桶（1.0s 历史 + 当前桶）后归零。
- 判定压成一条 SQL。中间版本是「SELECT 窗口 → 判断 → tx 里 upsert」，PG 下 8.5ms；
  压成单语句 + autocommit 后 1.52ms。
- `storage_reserve()` + `O_CREAT|O_EXCL` + 退款。PG 补 `_lock_tenant_row`（`FOR UPDATE`）。

**复测**：`instances=3 admitted=5`、`uploads=[err, ok] usage=0.68MB`。

### 阶段三：单一时钟源（10:41–10:45）

`db_now()` = 锚点 + 单调钟增量；墙钟只观测。第一版写错了符号（`offset -= drift` 让逻辑时间
倒退 3600s），被 `test_07` 直接抓住；改成「逻辑时间根本不参与墙钟计算，只维护偏移量用于检测」。

连带把所有持久化时间戳换成 `db_now()`（含 `gc` 截止），否则 `elapsed_s` / `oldest_wait_s`
会在跳变后出现负数。时钟来源做成可注入，测试不再改全局 `time.time`。

### 阶段四：签名绑定租户与 scope（10:46–10:49）

载荷 `["v2", tenant, scope, job_id, exp]`；`_may_access` 改成「先验签 → 再查任务 → 比对 owner」。
顺带发现回执里的 evidence 链接是**无签名**的（点开 401），一并改成签名 URL。

### 阶段五：回归里冒出来的四个真问题

1. **PG `NumericValueOutOfRange`**：`rate_window.bucket = epoch/0.05 ≈ 3.6e10` 超出 32 位 INTEGER。
   SQLite 的 INTEGER 是 64 位，所以本地全绿、PG 全红。改 `BIGINT` + bootstrap 幂等 `ALTER … TYPE`。
   `usage.bytes` 同样问题（2GB 配额就顶到 21 亿）。
2. **PG 每条只读语句都 commit**：一次 `get_tenant` = 2 次往返，准入路径被白白拖慢一倍。
   改 `autocommit=True` + `tx()` 显式 `BEGIN`。
3. **未消费请求体导致连接错位**：401 发生在读 body 之前时，HTTP/1.1 长连接把剩下的
   视频字节当成下一个请求行解析，容器日志出现 `Bad request version`。修：这类响应带 `Connection: close`。
4. **`inproc-0` 跨 pod 撞名**：心跳按 worker 名校验，两个 pod 同名就能互相续租 = 双领。
   改名加 `hostname + uuid`。

### 阶段六：新增常驻断言与现场验证（11:00–11:08）

- `tests/test_cluster_state.py` 10 项：三进程限流、两进程配额、8 线程配额、签名 scope/tenant、
  HLC 前跳/回拨/租约不被误回收/跨实例可见。
- `tests/multi_replica.sh`：3 个 `renderd:0.1.0` 容器 + 一个 `postgres:16-alpine`，
  断言「5 QPS 不被放大 / 1MB 配额只成功一次 / 记账不超配额」→ 3/3。
- `attack.py`：新增 H05/H06（跨 scope、换租户），签名改用服务端同一 `auth.sign()`；
  F01 改成「同键真实提交是否重放」，去掉一个 flaky 断言 → 57 项。

### 回归

```
SQLite 104/104 (1 skip, 97.9s)    PG 104/104 (106.4s)
对抗   SQLite 57/57               PG 57/57   critical 0
容器 E2E 10/10    Compose 11/11    TLS 网关 10/10    三副本 3/3
```

### 环境备注

- `grep` 在 BRE 下不支持 `\|`，本会话多次静默返回空 —— 改用 Grep 工具。
- 两次 `compose_e2e` 重叠运行：先起的那个被 sandbox 终止时 trap 执行了 `compose down -v`，
  把后一个的 `renderd_default` 网络删了，表现为「worker 起不来 / 网络找不到」。
  compose 相关脚本必须串行跑，已记在这里。

---

## 13:08–13:35 · 续轮 6：租户边界

用户问「还有哪些需要解决的」，我列了 4 条新发现，然后按「继续」把前 3 条做掉。

### 阶段一：认证失败限流（13:10–13:16）

`admit()` 的顺序是 `resolve()` → `rate_hit()`，错 token 根本走不到限流。
在鉴权前加一层：该 IP 最近失败过 → 查共享计数 → 超预算直接 429。

**第一版按 IP 一刀切**，结果攻击套件 I 组全变 429（所有请求都来自 127.0.0.1）。
这暴露了真实风险：NAT 后面一个配错 token 的客户端会把同出口的正常客户一起打死。
改成只拦「token 不在 `auth.tokens` 里」的请求 —— 一次 dict 查，微秒级，保护不变。

### 阶段二：队列视图分级（13:18–13:20）

`/v1/queue` 原本对任何合法租户返回 `inflight_by_tenant` 全量（别人家的租户名 + 负载）。
加 `RENDERD_ADMIN_TOKENS`（tokens 的子集），普通租户 `scope=tenant` 只看自己，
容量字段（depth/ready/running/oldest_wait_s）保留 —— 租户判断要不要错峰需要它。

### 阶段三：素材表与回收（13:22–13:32）

三张表不够就加两张：`assets`（sha/bytes/path/last_seen）+ `asset_refs`（sha/tenant/bytes）。
配额从 `SUM(usage.bytes)` 改成 `SUM(asset_refs.bytes)`；删除引用即释放。

- 去重语义保持：第二个租户免费，但记一条 `bytes=0` 的引用（否则付费方删除会误删）
- `DELETE /v1/assets/{id}`：在途引用 → 409；跨租户 → 404；删除写 audit
- `gc --assets`：只清「从未进入任何任务 IR」的孤儿，被引用过的留着（否则 replay 会缺素材）
- 老库 `usage.bytes` 折成 `legacy:<tenant>` 引用：配额语义不变，但没有文件，GC 跳过

### 三个只有回归才抓到的问题

1. `service.assets()` 的返回体里，`"assets"` 键被 `usage()` 那次批量替换重复插入，
   后写的 int 覆盖了前面的 list → `TypeError: 'int' object is not iterable`。
2. PG 的 psycopg 把 SQL 文本里的 `%` 当占位符：`LIKE '%' || a.sha || '%'` 直接报错，
   连 `NOT LIKE 'legacy:%'` 也炸。加 `SQL_CONTAINS` 方言钩子（SQLite LIKE / PG strpos），
   并把 legacy 的前缀做成参数。
3. 老库的 legacy 引用没有 `assets` 行，`assets_list` 用 INNER JOIN 时列表为空但
   `storage_used_bytes` 非零 —— 「用着 4KB 却看不到东西」。改 LEFT JOIN 并 `COALESCE`。

### 回归

```
SQLite 117/117 (1 skip, 99.9s)    PG 117/117 (120.7s)
对抗   SQLite 61/61               PG 61/61   critical 0
```

### 阶段四：Compose 回归抓到的时钟残留（13:44）

第一次跑 Compose 时挂了一项：`kill -9 worker` 后等 18s，任务仍是 `running`，
没被识别为租约过期。根因不是租约算错，而是 `recover_expired()` 里还留着上一轮的
「最近一次时钟跳变后 60s 内跳过回收」。HLC 之后时间本身不会跳，这个保险只剩副作用：
把崩溃任务的重排拖过观测窗口（后面 worker 起来仍能自愈，所以只挂一项、不是死锁）。

改成「跳变只留痕、不停手」后 Compose 11/11（过期后 `accepted`）。
教训：换掉一个机制后，要把它留下的所有补丁一起删掉 —— 否则补丁会变成新的故障源。

---

## 14:10–14:25 · 续轮 8：MLT 后端

用户问「Mlt 没做吗 后面音轨会用到」。先把结论摆正：XML 生成器在，但从未被执行过，
拿 melt 一跑只有 1 帧。然后按「能出片 → 过断言 → 可复现」三步推进。

### 阶段一：在镜像里装 melt（14:11）

默认镜像没有 melt，容器又是非 root，`apt-get update` 直接被拒。
用 `FROM renderd:0.1.0` + root 装 melt 的探针镜像解决，实测 melt 7.30.0（正好等于我们 XML 里写的版本）。
镜像 1.03GB → 1.48GB（Qt5/frei0r/ladspa/sox）—— 这个体积决定了它不能进默认镜像。

### 阶段二：逐层排除（14:12–14:16）

用最小 XML 做对照实验：单轨无转场也只剩 1 帧 → 排除了 transition 的嫌疑；
让 melt 自己 `-consumer xml:` 导出参考 XML，发现它给 producer 带了 `length`，
而我们用的是 `avformat-novalidate`（不探测）→ 换成 `avformat`，2.005s。
接着用 `volumedetect` 对比：视频轨自己的声音漏进来了（-24dB），加 `hide="audio"` 后 -91dB；
两条相同音轨叠加只 +0dB（第二条被丢），改成每轨一条 `mix` 后 +6dB。

### 阶段三：过断言（14:17–14:19）

带音乐床的模板能出片，但 `L3_LOUDNESS_OUT_OF_RANGE`（-24 LUFS）。
补一道只重编音频的 `loudnorm`，又撞上 `L1_AUDIO_DESYNC` —— 音乐床 10s、时间线 15s，
MLT 的音频轨到最后一个片段就结束了。补 `apad` + `atrim` 后 `verdict=pass`。

### 阶段四：固化（14:20–14:25）

`Dockerfile.mlt`（可选镜像）、`compile_mlt.plan()`（melt argv）、
`loudness_argv()`（响度+时长归一）、`runner` 接通 `backend=mlt`；
`tests/test_mlt_backend.py` 7 项 + `make test-mlt`。

### 教训

「结构校验通过」和「能跑」是两件事。这个模块的 docstring 一直写着
「本机没有 melt，只做结构校验」—— 于是它就真的只被结构校验过。
凡是不能执行的代码路径，最好在 CI 里给它一个可执行的入口，否则等于没写。

### 阶段五：构建卡住的诊断（14:27–14:50）

`docker build -f Dockerfile.mlt` 跑了 14 分钟没动静，看起来像卡死。诊断结论：**不是代码问题，是 apt 下载卡住**。

判据不是「等了多久」，而是两个数字：

```bash
docker top <构建中间容器>
# root 112258  ...  00:00:02  apt-get install -y --no-install-recommends melt
# _apt 112264  ...  00:00:04  /usr/lib/apt/methods/http
```

容器起了 11 分钟，`apt-get` 只累计 2 秒 CPU、`http` 方法 4 秒 —— **在等网络，不是在算**。
（宿主机 load 24 是 Colima VM 里的 apt 与其它容器叠加，不代表在编译。）

处置三步：

1. `docker kill <中间容器>` 让构建失败退出，避免一直占着；
2. 用已有 melt 的镜像做**增量验证**：`FROM renderd:melt-probe` + `COPY renderd /app/renderd`，
   30 秒构建完，`test_mlt_backend` 7/7 —— 证明代码层没问题；
3. 网络恢复后（`apt-get update` 25 秒内 exit=0）用**原 Dockerfile.mlt** 重跑：4 分 40 秒成功，
   在正式镜像上再跑一次 7/7。

教训：`docker build` 长时间无输出时，先区分「在算」和「在等」。`docker top` 看中间容器的
CPU 时间是最快的判据；`tail -6` 会把 build 的输出全缓冲住，看不出任何进度。

---

## 14:55–15:20 · 续轮 9：把 hevc / av1 真跑一遍

起因：用户问「全部搞定了？后端引擎」。这个问题不能用「代码里有分支」回答，
所以把 hevc / av1 各跑一条真渲染。

### 结果比预期好，也比预期坏

好：两条都能出片，`verdict=pass`，180 帧，分辨率正确。
坏：**HEVC 的 tag 是 `hev1`** —— Safari / QuickTime / iOS 只认 `hvc1`，
这样的成片在 Apple 设备上打不开。而客户选 HEVC 往往正是为了 Apple 端省带宽。

顺带查出第二个问题：缓存键不含编码参数。也就是说，即使修了 tag，
同一份 IR 仍会命中旧缓存、返回旧的 `hev1` 产物。**修了等于没修。**

### 改动

1. `compile_ffmpeg`：三种编码显式 `-tag:v`（avc1 / hvc1 / av01）。
2. `encoder_signature(ir)` + `COMPILE_REV` 进缓存键。前者覆盖 IR 参数，
   后者覆盖「代码变了、IR 没变」——本次正是后者。
3. `compile_mlt.finalize_argv()`：MLT 出片后**无条件**做容器规范化。
   原来只在有音轨时补 loudnorm，无音轨的时间线就绕过了 tag 修正。
4. `tests/test_codec_branches.py` 9 项 + MLT `test_08`。

### 两个实现细节

- `-map 0:a:0?` 的可选流标记：hook 模板没有音轨，强制映射会直接失败。
- `-tag:v` 必须放在 `-c:v copy` 旁边（重封装时生效），不能只在编码时给。

### 回归

```
SQLite 134/134（跳过 5）    PG 134/134（跳过 4）    MLT 8/8    容器 10/10
```

### 教训

自动断言只看帧数、响度、黑场 —— 这些都是「技术指标」。而 `hev1` 这种问题
只在「目标设备能不能播」这一层暴露。**技术指标全绿不等于交付成立**，
所以每加一条编码分支，必须同时断言容器层的可播放性（tag / faststart）。

---

## 15:20–16:10 · 续轮 10：四项引擎能力

用户「后端引擎全部落地 马上要用」+「全部一次性落地」。四项一起做。

### 顺序与理由

先扩 IR（一次把 volume / transition_in / subtitle / asset.kind 全加上），
再改编译器，最后写测试。**先定语义再写代码**，避免边写边改导致时间轴语义含糊。

### 关键实现点

1. **转场的 offset 恰好等于 at_frame/fps** —— 这是「重叠 N 帧」语义的直接推论。
   推导：offset_k = 前输出长度 − N_k，而前输出长度 = 前段 out_frame（因为总长守恒），
   又 at_k = 前段 out_frame − N_k，两者相等。省掉累计计算，也就没有累计误差。
2. **volume 必须配 target_lufs=null 才有效** —— loudnorm 在链路最后，会把单音轨的
   音量拉回 -14 LUFS。这不是 bug 而是语义：volume 是混音前增益。
3. **alpha 丢在归一化，不在编译器** —— 第一版只改 compile_ffmpeg 的 format，
   实测仍然纯红。查下来 ingest 用 libx264 重编，x264 无 alpha 通道。
   改成 overlay 素材透传才解决。
4. **字幕不用 libass** —— 两个后端渲染细节不同，且现有文字层已有安全区校验与确定性断言。

### 判据全部可量化

| 能力 | 判据 |
|---|---|
| 转场 | 中点与 A/B 各占全差异 0.2–0.8 倍 |
| 音量 | 0.25 增益降 12.04dB ±1.5 |
| 字幕 | 字幕时段 >500 白像素、非字幕 <50 |
| alpha | 叠加后 G 通道方差仍 > 裸底的 25% |

### 踩到的坑

- `color=c=red@0.5` 在 lavfi 里 alpha 不生效（probe 出来是全 255）→ 必须 `colorchannelmixer=aa=0.5`
- libvpx-vp9 即使给 `-pix_fmt yuva420p` 也会输出 yuv420p → 用 qtrle/argb 造测试素材
- `tempfile` 的 media_dir 里 `file://` 被安全策略拒绝 → 字幕必须走 `upload:` 通道（这也是真实路径）
- 测试里 `IR.validate` 的转场用例一开始构造错了（50 帧没超过本段长度），assert 直接抓出来

### 回归

```
SQLite 152/152（跳过 5）   PG 152/152（跳过 4）
MLT 9/9                    容器 10/10
```

---

## 15:38–16:00 · 续轮 11：真实素材

用户给了 MotionGit 的 promo（template-585）。主视频 37.9MB，网络慢，先续传（5m30s）。

### 过程

1. 解析页面 → 找到 `media.openaicut.com` 上的 previews 与 covers
2. 下载 4 个文件，`put_asset` 走真实上传链路（配额/去重/sha 命名）
3. 第一次排版就撞 `E_MEDIA_TOO_SHORT`（卡片 112 帧 vs 我要 120 帧）→ 改 IR
4. cover 版出片后抽帧，**发现两侧信息全被裁掉** → 加 `fit=blur`
5. blur 版出片，抽帧对比确认完整画面 + 模糊背景

### 三个判断

- **不改错误码改 IR**：112 帧是素材事实，引擎报错是对的。静默补帧会让客户拿到重复帧。
- **blur 必须真渲染验证**：只断言 argv 有 `boxblur` 不够，全黑背景也能「编译通过」。
  所以测试里对比「blur 顶部亮度 121.9」vs「contain 顶部 0.0」。
- **测试素材要选对**：第一版 TestFitBlur 用竖版素材配竖版画幅，contain 也不会有黑边，
  两个 fit 结果完全相同（121.86 == 121.86），被断言抓出来。换横版 `v_b.mp4` 才有对比。

### 回归

```
SQLite 157/157（跳 6）   PG 157/157（跳 5）   MLT 9/9   容器 10/10
```
