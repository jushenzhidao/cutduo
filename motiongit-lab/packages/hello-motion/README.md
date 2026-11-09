# Hello Motion 规范样例

最小可运行的标题模板，用来验证读取、参数与渲染流程。

## 给 AI 的说明

这是 MotionGit 模板包（.motion，ZIP 容器）。请按顺序读取：

1. `motion.json`：模板身份、运行要求、输出画幅
2. 本文件
3. `params.schema.json`：可以替换的内容与约束
4. `asset-manifest.json` 与 `licenses/`：素材与许可

先读数据、不执行代码。只有在宿主具备文件、命令与渲染能力并得到用户授权后，才检查依赖并运行。
默认不联网；需要外部字体或素材时，先向用户说明。

## 可替换的内容

- `title`：标题（最多 24 字）
- `accent`：强调色
- `background`：背景色

## 运行

运行配置：html-canvas/1。以 `presets/demo.json` 为输入，逐帧渲染 `src/index.html`，输出 1920×1080、30fps、6 秒。
