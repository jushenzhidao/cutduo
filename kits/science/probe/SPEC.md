# SPEC.md · 结构规律（可复用口径）

> 这份文件只写「可复用的规律」，不写「这次做了什么」。改动记录属于 progress.md。
> 判断标准：换一支内容还能用的，写这里；只对这一支成立的，不写。

## 一、节奏

| 项 | 值 | 依据 |
|---|---|---|
| 切点中位 | TBD s | 参考片实测，不是估值 |
| 段间转场 | 硬切，无过渡 | 转场会吃掉 0.3–0.5s 且拉低完播 |
| 字幕延迟 | 画面出现后 0.2–0.5s | 同步出现会显得生硬 |
| 句间间隙 | ≥ 0.1s | 同帧双条字幕是硬缺陷 |

段型配比（写实测值，不写目标值）：

| 段型 | 占比 |
|---|---|
| 主讲解 | TBD% |
| 图解释意 | TBD% |
| 标签强调 | TBD% |
| 首尾 | TBD% |

## 二、容量（必须实测，不许拍脑袋）

单行容量 = 在目标字号下，一行放得下且不挤压安全区的字数。

| 元素 | 字号 | 单行上限 | 超了怎么办 |
|---|---|---|---|
| 主标题 | TBD px | TBD 字 | 降一档字号，再超就换版式 |
| 副题 | TBD px | TBD 字 | 拆成两行，两行**统一字号** |
| 字幕 | TBD px | TBD 字 | 按标点折行，字号降到下限为止 |
| 标签 | TBD px | TBD 字 | 换更短的词，不缩字号 |

> 判安全区用**视觉顶端**，不是基线。中文字形在基线上方约 0.78em，
> 用基线判会差出 40px 量级、顶到内容区。

## 三、双宿主

同一份 `kit.js` + `layouts.js` 有两个宿主：

| 宿主 | 入口 | 特点 |
|---|---|---|
| Chromium | `src/index.html` | 系统字体，GPU 光栅 |
| Skia | `skia-kit/render.mjs --kit <name>` | 随包字体，CPU 光栅，确定性 |

能双跑的前提就一条：**绘制代码是纯 Canvas2D**。判据见 `check-template.py` 的 `purity` 检查。

## 四、交付前自检

```bash
uv run python check-template.py --src templates/own/<name>   # 结构
uv run python build-template.py --src templates/own/<name> --out packages/<name>.motion
node motion-render.mjs inspect --package packages/<name>.motion   # 期望 integrity 全通过
node skia-kit/gate.mjs <成片>                                      # 交付完整性
```
