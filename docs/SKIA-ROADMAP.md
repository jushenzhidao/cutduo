# Skia 渲染路线 · 未来计划

> 状态：**暂缓**（不阻塞当前交付）。等触发出现在下面「什么时候值得做」一节时再启动。
> 记录时间：2026-11-09

## 为什么会有这条路线

浏览器截图是整条链路里唯一的瓶颈。本机实测（1920×1080，80 帧采样）：

| 路径 | 单帧 | 说明 |
|---|---|---|
| Playwright `page.screenshot` | 32.65ms | 现状 |
| CDP `Page.captureScreenshot` | 32.56ms | 封装不是瓶颈 |
| CDP + `optimizeForSpeed` | 30.34ms | 只有 ~7% |
| CSS `contain` / `content-visibility` | 32.5–32.9ms | 无收益 |
| **Skia Canvas 单线程** | **13.2ms** | 2.5× |
| **Skia Canvas 8 worker** | **1.9ms** | 16.9×（相对串行） |

`window.seek(t)` 本身只要 0.05ms，**99% 的时间在截图 + JPEG 编码**。所以换引擎是唯一能进一个数量级的办法。

现网数据也对得上：MotionGit 纸面透视模板 2783 帧 / 89s ≈ **32.0ms/帧**。

## 两种并行的本质差别

- **Playwright 并行 = 分片**：每片一个完整浏览器进程，靠进程数堆吞吐。实测 4 路 3.9×、8 路 6.9×，再往上被内存和调度吃掉。
- **Skia 并行 = 线程**：每线程一块画布，没有合成器、没有读回、没有进程启动。实测 8 线程 521fps。

前者是「多开窗口」，后者是「把窗口去掉」。

## 什么时候值得做

同时满足两条再启动：

1. 单条片子的渲染时间成为迭代瓶颈（例如频繁改文案重出片）；
2. 模板由我们自己维护——**这是硬前提**。

原因：MotionGit 模板的绘制逻辑封在受保护的 `release.bin` 里，只能调参数、改不了画法。第三方模板走不了 Skia，只能靠分片（已落地，见 `render-parallel-tpl.py`）。

## 分阶段计划

### 阶段 0：抽场景描述层（1 天）

把「画什么」和「怎么画」解耦，产出一份与渲染器无关的 scene spec：

```
scene = { type, t0, t1, props, captions }
```

现有 `canvas-editorial.mjs` 已经是一半（直接调 Canvas API 画），需要把每个分镜抽成 `draw(ctx, scene, t)` 的纯函数族。

### 阶段 1：Skia 后端（1–2 天）

- 用 `@napi-rs/canvas` 做 Canvas 2D 后端，字体走 `GlobalFonts.registerFromPath`（PingFang）；
- 覆盖现有 8 种分镜：title / keyword / number / compare / steps / quote / checklist / outro；
- 逐帧 `toBuffer('image/jpeg', 94)` → ffmpeg 管道。

已有实现参考：`canvas-editorial.mjs`（约 600 行，8 分镜 + 字幕 + 头像）。

### 阶段 2：并行与缓存（已在别处验证过）

- `worker_threads` 分片，`renderIncremental()` 按场景内容哈希缓存 TS 段；
- 实测：全命中 130ms，改 1 段 0.76s，首渲 2.30s（8 worker）；
- 这条链路在 `motion-render.mjs` / `render-daemon.mjs` 里已经跑通，可直接复用。

### 阶段 3：质量闸门

- `qa-gate.py`：帧数、黑帧、重复帧、PSNR 回归；
- 与 Chromium 版逐帧比对，PSNR > 45dB 视为视觉无损。

## 代价与风险

| 项 | 说明 |
|---|---|
| 文本排版 | DOM 的自动换行 / 断行 / 富文本要自己实现，中文标点避头尾尤其费工 |
| 视觉效果 | `backdrop-filter`、多层阴影、混合模式要手写近似 |
| 维护成本 | 版式一改就要同步改 Canvas 代码；DOM 版改 CSS 即可 |
| 字体 | 依赖系统字体，换机器要确认 PingFang 存在（缺字会渲染成方块） |
| 已验证的坑 | PNG 编码 210ms/帧，帧流必须 JPEG |

## 决策建议

- **版式稳定、批量出片** → Skia 值得做，收益 2.5×（单线程）到 17×（8 线程）。
- **版式经常改、富文本多** → 维持 Chromium + 分片，别为速度牺牲迭代效率。
- **用第三方模板** → 没有选择，只能分片。

## 相关文件

- `canvas-editorial.mjs` — Skia 原型（8 分镜）
- `canvas-bench.js` / `canvas-bench-parallel.js` — 单帧与多线程基准
- `render-parallel-tpl.py` — 当前 Playwright 分片方案
- `qa-gate.py` — 质量闸门
