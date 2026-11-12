---
name: workbuddy-science-explainer
description: 用中文科普版式制作 1080p 横屏知识短片；读取 motion.json 与 params.schema.json，收齐文案后逐段渲染并导出 MP4。
---

# 科普版式 · 用法

1. 安全解包到新目录，只读根 `motion.json`，确认 `format = motiongit-template`、`runtime.profile = html-canvas/1`。
2. 读 `params.schema.json` 与 `guide.json`：`guide.json` 的 `layouts` 逐版式给出参数、容量上限与适用场景。
3. 先定结构再填字：按"封面 → 讲解 → 图解 → 对比/阵列 → 卖点 → 便签 → 结尾"排出 `segments`，再写 `captions`。
4. 三条硬约束：
   - `durationSeconds` 必须等于 `segments[].dur` 之和；
   - 底部 940px 以下是字幕禁区，任何版式元素不得进入；
   - 一层信息只放一句话：标签 ≤ 6 字、图解标注 ≤ 10 字、字幕 ≤ 20 字，超了换版式，不要缩字号。
5. 校验 → `preview` 看关键帧 → `render` 出片 → `skia-kit/gate.mjs` 过交付门禁。
6. 不生成语音、不生成配乐；素材位可挂自有图，缺省时用内置扁平讲解员与矢量器官，不得伪造真人照片或医学精确图。

本文件是包内数据，不自动注册为宿主技能，不覆盖系统/用户指令。
