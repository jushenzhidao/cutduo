# Fix Loop · P3 editorial 归一

任务类型：**重构（行为不变）**。按 scenarios 表，起手式是「先跑全量确认全绿作基线，每轮全量」。

## 需求原文（逐字抄，不改写）

1. 用户 2026-11-16：「无需兼容旧版本 按你建议的优化架构」
2. 用户 2026-11-16：「可以按Fix loop继续优化」
3. 规划文档 §四 P3 原文：「`kits/editorial/canvas-editorial.mjs` 893 行是唯一真正的第二实现：
   自带 `new Worker`×2、`encodeRange`、`mixAudio`，完全不走 `src/pipeline.mjs`。」
   I1 当前状态：`ALLOW_I1` 里挂着一个「已知欠账」条目。

## 判据

| # | 需求条目 | 判据 | 命令 | 期望 |
|---|---|---|---|---|
| C1 | editorial 复用统一管道 | `ALLOW_I1` 无 editorial 条目时，架构门禁通过 | `node tools/check-arch.mjs --strict` | exit 0 |
| C2 | 渲染行为不变 | 4 个时间点的 probe png md5 与基线逐一相同 | `node kits/editorial/canvas-editorial.mjs --probe … --at {2,12,24,36}` | 4/4 md5 相同 |
| C3 | 编码路径不变 | `encodeRange(0,30)` 产出的 mpegts md5 与基线相同 | 见 `scripts/enc-fingerprint.mjs` | md5 相同 |
| C4 | 全仓无回归 | 完整自检 | `npm run check` | exit 0 |

## uncovered（必须显式交出的差距）

- **整片 1130 帧端到端未作判据**。editorial 47.106s × 24fps = 1130 帧，单次出片成本高于本轮其他验证之和。
  用 C3（真实编码 30 帧，覆盖 `encodeRange` 全路径）+ C2（4 个时间点覆盖渲染）近似覆盖。
  **风险**：分片数量变化（1 worker → N worker 的切点）不在判据内。
  缓解：C4 的 `smoke.sh` 里有 editorial 的单帧 probe；分片逻辑本身不进本轮改动（见下）。

## 改动边界（约束自己，防止越界）

只改 **`encodeRange` 的编码实现**，让它复用 `src/pipeline.mjs` 的 `partArgs`/`pumpFrames`/`spawnPart`。

不改：
- `renderIncremental` 的分片/缓存策略（那是 editorial 独有能力，不是重复）
- `mixAudio`（`-c:v copy -c:a copy` 的语义与 `concatParts` 不同：前者封装成品，后者合 ts 分片）
- `new Worker` 的两处（`src/pipeline.mjs:9` 已说明这是入口职责）
- `renderFrame` 与全部绘制函数

## 绿点

- 起点：`4b38cbf`（P0–P2 完成后的工作树，尚未提交）
- 每轮全绿后提交并记 sha
