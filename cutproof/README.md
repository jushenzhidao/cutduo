# cutproof

剪辑渲染「可验证性」的最小闭环：从**素材进得来**到**成片敢交付**，全链路可重跑。

存在的理由只有一句话：**商用剪辑的失败点不在「能不能渲染出一支片子」，而在「能不能每次都渲染出同一支片子，并且在渲染错的时候比客户先知道」。**

## 快速开始

```bash
python3 -m pip install --user pillow     # 只用于文字层栅格化与字形覆盖检查
./ci/gate.sh                             # 一步跑完：语料 → 归一化 → 渲染 → 回执 → 负向测试
```

`ci/gate.sh` 五步全绿 ≈ 1 分钟。任何一步失败即非零退出，可直接挂 CI。

## 四条产线

| 模块 | 职责 | 入口 |
|---|---|---|
| **语料工厂** | 21 条能复现真实故障模式的素材，生成后自检「故障特征是否真的复现」 | `corpus/gen_dirty.py` |
| **归一化引擎** | probe（只观测）→ decide（只决策）→ normalize（只执行 + 自校验） | `ingest.py` |
| **渲染 harness** | IR → 双后端编译（MLT XML / FFmpeg graph），四组一致性对照 | `cutproof.py` |
| **断言库** | L1 结构 / L2 感知 / L3 语义，产出证据回执 | `asserts.py` |

外加 `mcp/tools.json`（Agent 工具契约）与 `P1-启动包.md`（取材 runbook / GPU 规格 / 定价速算 / 门禁）。

## 一、语料：21 条故障模式

```
c00_clean           干净的对照组：H.264 / yuv420p / 48k 立体声 / 色彩四标齐全
c01_hlg_hdr         iPhone HLG HDR：bt2020 / 10bit / HLG
c02_vfr_gap         VFR：时间戳断档 5 帧（音画不同步的元凶）
c03_rotated_mov     带旋转显示矩阵的 MOV（不读矩阵就出横版）
c04_hevc10_untagged 10bit HEVC 且无色彩标记（色彩解释完全靠猜）
c05_no_audio        完全无音轨
c06_mono_441        单声道 44.1kHz
c07_51_surround     5.1 环绕声
c08_zero_bytes      0 字节文件
c09_truncated       moov 在头、mdat 被截断（元数据健康，解码才炸）
c10_long            10 分钟超长素材
c11_pillarbox       竖屏内容塞进 1920×1080 画布
c12_screenrecord    屏幕录制：低帧率 + 大面积静态 + 锐利文字
c13_120fps          120fps 高帧率
c14_anamorphic      非方形像素 SAR 16:11
c15_interlaced_ts   1080i 隔行 MPEG-TS
c16_legacy_avi      上古容器 AVI + MPEG-4 Part 2
c17_embedded_subs   内嵌字幕轨
c18_multi_audio     两条音轨（原声 / 配音）
c19_audio_only      纯音频文件被当成视频素材
c20_odd_res         奇数分辨率 641×481 + yuv444p
```

生成时**自校验**：每条都声明「预期故障特征」，生成后立刻 ffprobe 验证。对不上就标 `INEXPECT` 并非零退出——**语料没复现出故障，等于测试用例失效**，比代码有 bug 更危险。

## 二、归一化：三段式

```
probe()      只观测 → 规范化描述 + 风险标记（不改动任何字节）
   ↓
decide()     只决策 → 声明式动作序列 + 错误码 + 警告（不碰文件，可 review 可回放）
   ↓
normalize()  只执行 → 拼 filtergraph → 出 canonical 中间片 → 再 probe 一次自校验
```

拆开的收益：客户问「这条素材为什么被转成这样」，直接把 `res/plans/<id>.json` 甩出去——里面写着每个动作的触发原因（`"TONEMAP_HDR ← transfer=arib-std-b67 / primaries=bt2020"`）。写成一个函数就永远答不上来。

### 实测结果

| | 数量 |
|---|---|
| 语料 | 21 |
| 零转码直通 | 1 |
| 转码后通过 8 项规格校验 | 17 |
| 带警告（能救但改变了语义） | 15 |
| 必须拒绝入队 | 3 |

三个硬失败：`E_INPUT_UNREADABLE`（0 字节）· `E_INPUT_AUDIO_ONLY`（纯音频投到视频位）· `E_INPUT_TRUNCATED`（元数据健康、解码才炸）。

### canonical 中间片规格

| 维度 | 规格 | 理由 |
|---|---|---|
| 时间 | 整数帧，CFR 30fps | 浮点秒在 29.97 下必然漂移；漂 1 帧的伤害比换编码器大得多 |
| 像素 | yuv420p · SAR 1:1 · 长边 ≤1920 | SAR≠1 会让后续所有 crop/scale 坐标带隐藏系数 |
| 色彩 | bt709 ×4 标齐全 | 缺一个播放器就各显各的 |
| 音频 | 48kHz 立体声 AAC 192k | 采样率不统一，拼接会产生 1 帧内音画偏移 |
| 几何 | 保留源宽高比，只限长边 | 归一化阶段不做 cover/contain —— 那是模板的事 |

## 三、渲染：四个对照

同一条 IR，只改一个变量。脚本 `cutproof.py`。

| 断言 | L1全等 | SSIM | PSNR | VMAF | 字节同 |
|---|---|---|---|---|---|
| M1 同后端渲染两次 | ✓ | 1.00000 | ∞ | 99.30 | ✓ |
| M2 软编 vs 硬编 | ✓ | 0.99435 | 43.41 | 97.06 | ✗ |
| M3 时间线偏移 1 帧 | ✓ | 0.96076 | 25.41 | 72.91 | ✗ |
| M4 字体缺失·错片 | ✓ | 0.97970 | 24.26 | 39.00 | ✗ |

读法：
- **L1 结构层对四种情况全通过**，包括错片 → 结构级验收没有鉴别力
- **SSIM 给错片 0.98** → 逐像素平均被小面积高对比错误骗过
- **VMAF 抓到了（39），但需要 reference** → 只能做回归，不能做首次验收
- **M2(97.06) > M3(72.91)** → 合规差异比严重错误的伤害小得多

## 四、三层断言

```
L1 结构层   同后端 → 字节级完全一致；跨后端 → 字段全等
L2 感知层   仅用于回归，对冻结基准 VMAF ≥ 95。不用于首次验收
L3 语义层   编译期 + 渲染后断言，唯一能判「首次对不对」
            字形覆盖率 · 文本安全区 · 响度 -14 LUFS ±0.5 · 黑场
```

L3 的几何断言在**编译期**就能算（`compile_text_layers()` 返回 `bbox_px` 与 `within_safe_area`），不用等渲染。这是它相对 VMAF 的最大优势，也是它便宜的原因。

### 字形覆盖检查（零依赖）

`asserts.py` 用 `.notdef` 指纹比对法：把私有区码点 `U+E000` 的渲染结果当基准（正常字体不会映射它），逐字比对，相同即为缺失。不需要 fontTools，能跑在渲染节点的最小镜像里。

实测：用 Helvetica 渲中文 → `font_coverage.ok = false` → `E_FONT_MISSING` → 退出码 1。**这就是门禁第 5 步的负向测试**。

## 五、MCP 契约

`mcp/tools.json`：`list_templates` / `validate_render` / `submit_render` / `get_job_status` / `get_receipt`。

五条设计约束：

1. Agent 不能生成 MLT XML、不能调 shell，只能提交 IR —— 执行计划由服务端编译，这是安全边界。
2. 成功响应必须带 receipt（证据），不能只给 URL。Agent 看不见视频，只给 URL 它只会瞎试。
3. 错误必须可执行：`code + message + hint + field + allowed_values + retryable` 五件套。
4. `submit_render` 必须幂等：同 key 重放返回同 `job_id`，不产生第二次成本。
5. 所有工具都有 dry-run 语义：先算账再花钱。

## 六、文件

```
cutproof/
├── ci/gate.sh              一键门禁（负向测试是核心）
├── corpus/gen_dirty.py     21 条语料工厂 + 自校验
├── corpus/assets/          生成的语料（约 97 MB，可随时重建）
├── ingest.py               probe / decide / normalize / matrix
├── cutproof.py             IR → 双后端编译 + 四组对照 + 回执
├── asserts.py              L3 断言库 + 证据回执
├── make_p0_report.py       从 matrix.json 生成手册（数字全部来自实测）
├── ir/schema.json          IR 的 JSON Schema
├── ir/sample_15s_vertical.json
├── mcp/tools.json          Agent 工具契约
├── P1-启动包.md            BSK 取材 runbook / GPU 规格 / 定价速算 / 门禁
├── res/                    probes / plans / mezz / matrix.json
└── out/                    renders / layers.json / receipt.json / evidence
```

## 七、三个不可逆决定

1. **时间用整数帧**，不出现浮点秒。29.97 / 23.976 下浮点秒必然累积漂移。
2. **文本先栅格化成图层资产**，hash 进缓存键，渲染器只做合成。不让目标机现算字形——否则输出绑定那台机器的 freetype 版本。
3. **轨道有空洞直接报错**（`E_IR_UNSUPPORTED`），不静默降级。宁可编译失败，不要渲出「看起来成功」的错片。

## 八、边界

- MLT 分支**只做结构校验**，本机没有 melt 运行时。真渲染需目标节点装 melt + qtblend。
- 语料是 lavfi 合成的：能复现**故障模式**，不能复现真实拍摄素材的噪声分布。上线前仍需灌 50–100 条真实客户素材做回归。
- HDR 用 colorspace 直转而非 tone curve（本机 ffmpeg 无 zimg）。正式产品应换 libplacebo。
- 抽样解码默认 15 秒，长素材尾部损坏抓不到。
- 单机单进程。队列、重试、配额、审计不在这个仓库——那是 P2 的事。
