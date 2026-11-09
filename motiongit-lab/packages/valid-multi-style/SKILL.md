---
name: sample-multi-style
description: 使用 MotionGit 模板「Hello Motion 规范样例」制作视频。读取 motion.json 与 params.schema.json，收集用户输入，校验后渲染。
---

# Hello Motion 规范样例

1. 解包到新目录，读取根 motion.json，确认 format 为 motiongit-template。
2. 读取 params.schema.json，向用户只询问缺少的输入。
3. 用 presets/demo.json 作为默认值，生成本次输入 inputs.json 并校验。
4. 在宿主具备执行能力时渲染；否则交付 inputs.json 并说明需要的运行环境。
