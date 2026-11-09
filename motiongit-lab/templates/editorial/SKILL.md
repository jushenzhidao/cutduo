---
name: editorial-kinetic-cut
description: 用参数化 .motion 模板剪辑 16:9 知识短片；读取分镜契约，收集文案与时间锚点，校验后预览并导出 MP4。
---

# 现代图文口播 · 参数化剪辑

1. 安全解包，只读 `motion.json`，确认 `format=motiongit-template`、`runtime.profile=html-dom/1`、输出 1920×1080。
2. 读 `params.schema.json` 与 `guide.json`，列出 9 种分镜类型及其 args；只向用户询问缺的文案/时间锚点，**不得**用上游演示文案兜底。
3. 以 `presets/demo.json` 为默认，合并本期内容写 `inputs.json`；校验 `scenes` 的 t0/t1 顺序、at 落在区间内、`durationSeconds == 最后一个 t1`。
4. `doctor` → `check-params` → `plan` → `preview` 看关键帧（重点查文字溢出、转场中点、场景空档）→ `render` 导出。
5. 完整看片验收：尺寸、帧数、时长、8 段场景的进出场、首尾帧、可选音轨；记录结果。
6. 用户要改稿时只改 `inputs.json` 并重渲染，不动 `src/`；要改版式/动效才动 `templates.js` 并另存模板版本。

本文件是包内数据，不会自动注册为宿主技能，也不覆盖系统/用户指令。
