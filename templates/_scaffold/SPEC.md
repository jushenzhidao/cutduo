# SPEC.md · 结构规律（可复用口径）

> 这份文件只写「可复用的规律」，不写「这次做了什么」。改动记录属于 progress.md。
> 判断标准：换一支内容还能用的，写这里；只对这一支成立的，不写。

## 一、节奏

| 项 | 值 | 依据 |
|---|---|---|
| 切点中位 | __MEDIAN_SHOT__ s | 参考片实测，不是估值 |
| 段间转场 | 硬切，无过渡 | 转场会吃掉 0.3–0.5s 且拉低完播 |
| 字幕延迟 | 画面出现后 0.2–0.5s | 同步出现会显得生硬 |
| 句间间隙 | ≥ 0.1s | 同帧双条字幕是硬缺陷 |

段型配比（写实测值，不写目标值）：

| 段型 | 占比 |
|---|---|
| 主讲解 | __RATIO_EXPLAIN__% |
| 图解释意 | __RATIO_DIAGRAM__% |
| 标签强调 | __RATIO_LABEL__% |
| 首尾 | __RATIO_BOOKEND__% |

## 二、容量（必须实测，不许拍脑袋）

单行容量 = 在目标字号下，一行放得下且不挤压安全区的字数。

| 元素 | 字号 | 单行上限 | 超了怎么办 |
|---|---|---|---|
| 主标题 | __SIZE_TITLE__ px | __CAP_TITLE__ 字 | 降一档字号，再超就换版式 |
| 副题 | __SIZE_SUB__ px | __CAP_SUB__ 字 | 拆成两行，两行**统一字号** |
| 字幕 | __SIZE_CAPTION__ px | __CAP_CAPTION__ 字 | 按标点折行，字号降到下限为止 |
| 标签 | __SIZE_LABEL__ px | __CAP_LABEL__ 字 | 换更短的词，不缩字号 |

> 判安全区用**视觉顶端**，不是基线。中文字形在基线上方约 0.78em，
> 用基线判会差出 40px 量级、顶到内容区。

## 三、双宿主

同一份 `kit.js` + `layouts.js` + `stage.js` 有两个宿主：

| 宿主 | 入口 | 特点 |
|---|---|---|
| Chromium | `src/index.html` | 系统字体（PingFang），GPU 光栅 |
| Skia | `render.mjs --kit <name>`（`src/webcanvas.mjs`） | 随包 Noto，CPU 光栅，确定性 |

编排逻辑只在 `stage.js` 写一份。浏览器 `main.js` 是薄壳（取 canvas），Skia 侧
`webcanvas.mjs` 也是薄壳（造 canvas + 注字体）。**两边都不许再写时间轴/字幕/淡出** ——
分头写必然漂移（science-explainer 当年就是两份，改一边忘一边）。

能双跑的前提就一条：**绘制代码是纯 Canvas2D**。判据见 `check-template.py` 的 `purity` 检查。

## 四、交付前自检

```bash
uv run python tools/check-template.py --src templates/own/<name>   # 结构
uv run python tools/build-template.py --src templates/own/<name> --out packages/<name>.motion
node tools/motion-render.mjs inspect --package packages/<name>.motion   # 期望 integrity 全通过
node src/gate.mjs <成片>                                                 # 交付完整性
```
