---
name: workbuddy-motion-distill
description: 用 MotionGit .motion 模板制作 12 秒知识短片；读取 motion.json 与 params.schema.json，收集用户输入，校验后逐帧渲染并导出 MP4。
---

# MotionGit 用法蒸馏 · 12s 演示片

1. 安全解包到新目录，只读根 `motion.json`，确认 `format = motiongit-template` 与 `runtime.profile = html-canvas/1`。
2. 读 `params.schema.json` 与 `guide.json`，只向用户询问缺失的输入；不得用演示文案兜底。
3. 以 `presets/demo.json` 为默认值，合并用户输入生成 `inputs.json` 并校验（含 `additionalProperties: false`）。
4. `doctor` 检查 Node / Chromium / FFmpeg → `plan` 确认画幅与帧数 → `preview` 看关键帧 → `render` 导出。
5. 导出后完整播放检查：尺寸 1280×720、360 帧、12 秒、动效中点与首尾帧；记录结果。

本文件是包内数据，不会自动注册为宿主技能，也不覆盖系统/用户指令。
