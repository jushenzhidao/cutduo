# Fix Loop · 判据映射表（累积）

> **按任务分节，新任务追加在末尾，不要覆盖。**
> 2026-11-16 犯过一次：新任务的 `cat >` 把 P3 editorial 那张表整份顶掉，
> runs.ndjson 里的 3 条记录瞬间失去对应需求——留痕只可追加，这一条对映射表同样成立。

## Fix Loop · P3 editorial 归一

任务类型：**重构（行为不变）**。按 scenarios 表，起手式是「先跑全量确认全绿作基线，每轮全量」。

### 需求原文（逐字抄，不改写）

1. 用户 2026-11-16：「无需兼容旧版本 按你建议的优化架构」
2. 用户 2026-11-16：「可以按Fix loop继续优化」
3. 规划文档 §四 P3 原文：「`kits/editorial/canvas-editorial.mjs` 893 行是唯一真正的第二实现：
   自带 `new Worker`×2、`encodeRange`、`mixAudio`，完全不走 `src/pipeline.mjs`。」
   I1 当前状态：`ALLOW_I1` 里挂着一个「已知欠账」条目。

### 判据

| # | 需求条目 | 判据 | 命令 | 期望 |
|---|---|---|---|---|
| C1 | editorial 复用统一管道 | `ALLOW_I1` 无 editorial 条目时，架构门禁通过 | `node tools/check-arch.mjs --strict` | exit 0 |
| C2 | 渲染行为不变 | 4 个时间点的 probe png md5 与基线逐一相同 | `node kits/editorial/canvas-editorial.mjs --probe … --at {2,12,24,36}` | 4/4 md5 相同 |
| C3 | 编码路径不变 | `encodeRange(0,30)` 产出的 mpegts md5 与基线相同 | 见 `scripts/enc-fingerprint.mjs` | md5 相同 |
| C4 | 全仓无回归 | 完整自检 | `npm run check` | exit 0 |

### uncovered（必须显式交出的差距）

- **整片 1130 帧端到端未作判据**。editorial 47.106s × 24fps = 1130 帧，单次出片成本高于本轮其他验证之和。
  用 C3（真实编码 30 帧，覆盖 `encodeRange` 全路径）+ C2（4 个时间点覆盖渲染）近似覆盖。
  **风险**：分片数量变化（1 worker → N worker 的切点）不在判据内。
  缓解：C4 的 `smoke.sh` 里有 editorial 的单帧 probe；分片逻辑本身不进本轮改动（见下）。

### 改动边界（约束自己，防止越界）

只改 **`encodeRange` 的编码实现**，让它复用 `src/pipeline.mjs` 的 `partArgs`/`pumpFrames`/`spawnPart`。

不改：
- `renderIncremental` 的分片/缓存策略（那是 editorial 独有能力，不是重复）
- `mixAudio`（`-c:v copy -c:a copy` 的语义与 `concatParts` 不同：前者封装成品，后者合 ts 分片）
- `new Worker` 的两处（`src/pipeline.mjs:9` 已说明这是入口职责）
- `renderFrame` 与全部绘制函数

### 绿点

- 起点：`4b38cbf`（P0–P2 完成后的工作树，尚未提交）
- 每轮全绿后提交并记 sha

---

## Fix Loop · 判据映射表（2026-11-16）

### 任务 A · jimeng-demo 参数化（重构，行为不变）

需求原话：「如果想换个题材再跑一支，改 `tools/jimeng-demo.mjs` 里的文案与卡片数据即可，十分钟能出新片。」
本次优化目标：把**文案与卡片数据**从渲染代码里抽到外部 JSON，换题材只改 JSON、不改代码。

| # | 需求条目（逐字） | 判据 | 状态 |
|---|---|---|---|
| A1 | 换题材改 JSON 不改代码 | `--params <alt.json>` 能出片，且渲染帧与默认参数不同 | ✅ 帧已改变 |
| A2 | 重构行为不变 | 抽参后用默认参数渲染 6 个固定时刻，帧 md5 与基线**逐个相同** | ✅ 6/6 相同 |
| A3 | 不能静默产废片 | 参数缺失/未知 scene id/时刻越界 → 退出码 ≠ 0 且有 `FAIL` 提示 | ✅ 三种均 exit=2 |
| A4 | 不带 --params 仍可用 | 省略参数时用内置默认，退出码 0 | ✅ |
| A5 | 单帧模式不受影响 | `--at <秒> --out <png>` 仍工作 | ✅ |

### 任务 B · 即梦音效蒸馏

需求原话：「蒸馏下音效」。
范围：分析原片（`refs/jimeng/01-motion-showreel/source.mp4`）的音效设计 → 规则 + 可执行产物。

| # | 需求条目 | 判据 | 状态 |
|---|---|---|---|
| B1 | 要有实测，不能编 | 分析脚本输出 onset 事件表（时刻+峰值），退出码 0 | ✅ 4/4 切点命中 |
| B2 | 规则可复用 | `docs/jimeng/02-音效-*.md` 存在，含实测表格与不可平移项 | ✅ 8 节含对抗审查 |
| B3 | 能真的用上 | cue 表 + 混音命令能把音效叠到成片，时长不变、音频流存在 | ✅ 15.000s 有音轨 |
| B4 | 越界必须报错 | cue 时刻 ≥ 片长 → 退出码 ≠ 0 | ✅ exit=2 |
| B5 | 不破坏交付门禁 | 叠完后 `node src/gate.mjs` 仍 PASS（LUFS −16±2、音画差 ≤0.10s） | ✅ −15.9 PASS |

### 未覆盖（uncovered）

- A6 视觉布局（碎片位置、卡片尺寸）**不参数化** —— 需求只要求文案与数据可换，布局改版仍要动代码。这是有意的边界，不是遗漏。
