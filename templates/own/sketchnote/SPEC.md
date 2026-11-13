# SPEC.md · 手绘解说的结构规律

> 只写「换一支内容还能用」的规律。来源：半蒸馏自 `knowledge-explainer-sketchnote v2.7.4`，
> 只借了内容模型（四类 mechanism + 字段约束 + 内容族划分），坐标与画法全部自写。

## 一、四个版式的分工

| 版式 | 讲什么 | items | 专用字段 | 每片次数 |
|---|---|---|---|---|
| `step-sequence` | 逐步累积，每一步保留 | 2–6 | — | 不限 |
| `keyword-annotation` | 整页只有一个词 | **恰好 1** | — | 不限 |
| `sticky-revision` | 判断被修正 | 2–6 | `revision{targetId, lines[]}` | 不限 |
| `return-loop` | 收口回到前面某一环 | 2–6 | `return{fromId, toId, label}` | 每片 1 次 |

选择规则（来自上游 `AI-CHOICES.tasks` 的 `need → existingFamilies` 映射）：

- 讲「先…再…最后…」→ `step-sequence`
- 讲「这个词到底指什么」→ `keyword-annotation`（塞第二个词就废了）
- 讲「原以为 A，其实是 B」→ `sticky-revision`
- 讲「绕回来」→ `return-loop`，它是收尾不是过场

## 二、容量（上游 schema 的硬约束，非估值）

| 字段 | 上限 | 来源 |
|---|---|---|
| `title` | 28 字 | `native/parameters.schema.json` maxLength |
| `subtitle` | 44 字 | 同上 |
| `label` | 12 字 | 同上（画面上是卡片最大字） |
| `notes[]` | 1–2 条，每条 18 字 | 同上 |
| `conclusion[]` | 1–2 条，每条 20 字 | 同上 |
| `return.label` | 12 字 | 弧上的字，再长会压到两个圆 |

## 三、实测的排版参数

这些是调出来的，不是拍的。改版式时先按这组值，再微调：

| 项 | 值 | 为什么 |
|---|---|---|
| 步骤卡宽度 | `0.83W / n - gap`，gap=`0.022W` | 4 张时每张约 0.19W，`label` 12 字能单行放下 |
| 步骤卡高度 | `0.30H` | 再高下半就是空白（0.33H 试过，空） |
| 步骤出现间隔 | `1.35s` | 慢于 1.0s 才跟得上字幕；快于 1.6s 会显得拖 |
| 便签出现间隔 | `0.55s` | 便签是「铺开」不是「逐条讲」，要快 |
| 便签网格 | `cardW=0.21W, cardH=0.25H, gapX=0.035W, gapY=0.04H` | 2×2 在 16:9 下最稳 |
| 白便签覆盖区 | 从 `0.6H_card` 起、高 `0.34H_card` | **必须从 0.6 起**：0.44 起会盖住被划掉的旧行，「改了什么」就看不见了 |
| 便签内笔记 y | `0.44 / 0.60`（两行） | 与白便签（0.6 起）分层，互不遮挡 |
| 环半径 | `rx=0.26W, ry=0.19H` | 4 点时正好上下左右；6 点会挤，最多 4–5 点 |
| 回环弧的膨胀量 | `bulge=0.17·min(W,H)`，沿**连线法线** | 沿径向会退化：两点相对时控制点落在圆心，弧变直线 |

## 四、手绘的确定性

抖动种子来自**元素下标**（`seed = 20 + i*17`），不来自时间。

用时间当种子，线条会逐帧重算 —— 成片看起来像在震，而且逐帧没法缓存。
这条和「`enter()` 有 0.82 下限，`if (k<=0)` 是假门禁」一起写在 `guide.json` 的 `pitfalls[]` 里。

## 五、双宿主

同一份 `src/` 两个宿主：

| 宿主 | 入口 | 字体 |
|---|---|---|
| Chromium | `src/index.html` | 系统 PingFang SC |
| Skia | `render.mjs --kit sketchnote`（`src/webcanvas.mjs`） | 随包 Noto，`__FONT_PICK` 按字重映射 |

本模板**不依赖任何位图素材**，所以双宿主之间没有「姿态图静默退化」那类问题 ——
纯矢量的模板迁移成本最低。

## 六、交付前自检

```bash
python3 tools/check-template.py --src templates/own/sketchnote
python3 tools/template-smoke.py --template templates/own/sketchnote
node render.mjs --kit sketchnote --params templates/own/sketchnote/presets/default.json --out out/sketchnote-demo.mp4 --workers 8
node src/gate.mjs out/sketchnote-demo.mp4
```

带配音（时间轴由配音反推，不是配音迁就时间轴）：

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

uv run --with numpy python tools/vo.py \
  --preset presets/default.json \
  --out-preset presets/default.vo.json \
  --out-audio out/default.vo.wav \
  --voice zh-CN-XiaoxiaoNeural

node render.mjs --kit sketchnote \
  --params presets/default.vo.json --audio out/default.vo.wav \
  --out out/sketchnote-vo.mp4 --workers 8

node src/gate.mjs out/sketchnote-vo.mp4 --require-audio
```

实测（无声版 / 配音版）：

| | 帧 | 时长 | 体积 | 出片 | gate |
|---|---|---|---|---|---|
| 无声 | 720 | 24.00s | 0.87MB | 1.9s | PASS |
| 配音 | 731 | 24.37s | 1.28MB | 2.4s | PASS（`--require-audio`） |

配音版：7 句 → 段长重排为 6.68 / 6.92 / 6.75 / 4.02s；音视频流时长差 **0.0003s**；
`pcm_s16le → aac 160k` 由管道的 codec 探测自动完成（PCM 直接进 mp4 会让浏览器整轨静音）。
