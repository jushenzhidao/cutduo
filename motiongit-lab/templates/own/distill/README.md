# MotionGit 用法蒸馏 · 12s 演示片

按 MotionGit `.motion` 规范（0.1.0-draft.1）自建的最小完整模板，用来验证「读包 → 校验参数 → 逐帧渲染 → 导出 MP4」整条链路。

## 给 AI 的说明

这是 MotionGit 模板包（`.motion`，ZIP 容器），不是 Apple Motion 工程，也不是提示词。请按顺序读取：

1. `motion.json`：身份、运行时、输出规格（1280×720 / 30fps / 12s）
2. 本文件
3. `params.schema.json`：可替换内容与约束
4. `guide.json`、`asset-manifest.json`、`licenses/`：素材契约与许可

**先读数据，不执行包内代码。** 运行时为 `html-canvas/1`：宿主逐帧调用 `window.renderFrame(frame, inputs)`，页面不联网、不读外部资源、不依赖实时时钟。渲染需要 Node.js 22+、Chromium headless、FFmpeg。

## 可替换的内容

`title` / `subtitle` / `eyebrow` / `points`（恰好 3 条）/ `steps`（恰好 4 步）/ `outro` / `accent` / `accent2`。所有文案必须来自本期内容，不能用演示文案兜底。

## 四段场景

| 时间 | 内容 |
|---|---|
| 0–3.35s | 主标题逐字入场 + 副标题 |
| 3.35–6.65s | 三个要点卡片依次滑入 |
| 6.65–9.7s | 四步流程节点依次点亮、连线生长 |
| 9.7–12s | 结语与光环收束 |

调整节奏或布局需要修改 `src/main.js` 并另存模板版本；只改文案/配色不需要动源码。

## 运行

```bash
node motion-render.mjs inspect      --package packages/workbuddy-distill.motion
node motion-render.mjs check-params --package packages/workbuddy-distill.motion --inputs inputs.json
node motion-render.mjs preview     --package packages/workbuddy-distill.motion --inputs inputs.json --out out/preview
node motion-render.mjs render      --package packages/workbuddy-distill.motion --inputs inputs.json --out out/distill.mp4
```
