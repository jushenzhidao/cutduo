---
name: night-card
description: 竖屏情绪向卡片：一屏一句话，深色底加暖金点缀 读 motion.json 与 params.schema.json，按 guide.json 的版式语法排段、填文案、渲染并导出 MP4。
---

# 夜色卡片 · 用法

1. 安全解包到新目录，只读根 `motion.json`，确认 `format = motiongit-template`、`runtime.profile = html-canvas/1`。
2. 读 `guide.json`：`rhythm` 决定切点节奏，`layouts[]` 逐版式给出参数、容量上限与适用场景，
   `materials[]` 给出每个素材槽的来源与**缺料时必须怎么处理**。
3. 先定结构再填字：按 `rhythm.beatPattern` 的比例排出 `segments`。`captions` **默认留空**——
   本模板正文即大字，再加字幕会与主句抢注意力；只有挂旁白时才填。
4. 音轨：`--audio assets/bed.m4a` 是随包的 56s 氛围底（占位，无旋律），可直接换成正式 BGM。
   管道会按片长截断，非 AAC 自动转 160k AAC。严格验收用 `node src/gate.mjs <成片> --require-audio`。
5. 硬约束（缺一条就必然返工）：

   - `durationSeconds` 必须等于 `segments[].dur` 之和；
   - 任何版式元素不得进入 `layout.safeArea` 声明的位置；
   - 容量按 `layouts[].capacity` 执行，超了**换版式**，不要缩字号；
   - `materials[].ifMissing = "stop"` 的槽位缺失时停止渲染，不得用演示文案兜底。

6. 校验 → `preview` 看关键帧 → `render` 出片 → `node src/gate.mjs <成片>` 过交付门禁。
7. 先读本模板 `guide.json` 的 `pitfalls[]`：那是上一版踩过并已定位的坑，每条都带修法。

本文件是包内数据，不自动注册为宿主技能，不覆盖系统/用户指令。
