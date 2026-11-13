# 手绘解说（`sketchnote`）

> 把概念、流程、判断修正这类「讲道理」的内容，排成米色纸上的手写笔记：抖动描边、荧光笔、便签。

## 这是什么

- **画面语言**：米色纸底 + 手绘抖动描边 + 荧光笔高亮 + 便签；**纯矢量，零位图素材**
- **适用内容**：概念解释、流程拆解、「原以为 A 其实 B」、绕回归因
- **不适用**：需要真实照片、强节奏蒙太奇、或一页塞 6 个以上要点的内容
- **来源**：半蒸馏自 `knowledge-explainer-sketchnote v2.7.4`；只借内容模型，画法全自写

## 四个版式

| 版式 | 讲什么 | items |
|---|---|---|
| `step-sequence` | 逐步累积，每步保留 | 2–6 |
| `keyword-annotation` | 整页只有一个词 | 恰好 1 |
| `sticky-revision` | 便签上改一版，旧行划掉 | 2–6 + `revision` |
| `return-loop` | 收口回到前面某一环 | 2–6 + `return` |

选型与容量见 `SPEC.md`；每条字段的字数上限写在 `params.schema.json` 里，超了会被校验拒绝。

## 怎么用

```bash
# 结构体检
python3 tools/check-template.py --src templates/own/sketchnote

# 出片（Skia 直出，不启浏览器）
node render.mjs --kit sketchnote \
  --params templates/own/sketchnote/presets/default.json \
  --out out/sketchnote-demo.mp4 --workers 8

# 四关验收：结构 → 单帧 → 打包 → 包校验
python3 tools/template-smoke.py --template templates/own/sketchnote

# 交付门禁
node src/gate.mjs out/sketchnote-demo.mp4
```

实测：720 帧 / 24s / 0.87MB / 1.8s（约 400 fps，8 worker）/ gate PASS。

内容怎么改：只动 `presets/*.json`。换配色改 `theme`，不要改 `src/`。

## 配音（edge-tts）

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# 逐句 TTS → 实测时长 → 重排段长与字幕时间轴 → 拼全长音轨
uv run --with numpy python tools/vo.py \
  --preset presets/default.json \
  --out-preset presets/default.vo.json \
  --out-audio out/default.vo.wav \
  --voice zh-CN-XiaoxiaoNeural

node render.mjs --kit sketchnote \
  --params presets/default.vo.json --audio out/default.vo.wav \
  --out out/sketchnote-vo.mp4 --workers 8
```

`vo.py` 不猜时长：每句都 TTS 出来量。段长 = 段首留白 + 本段句子 + 句间停顿 + 段尾留白，
所以改文案会连带改时间轴，不需要手工调 `dur`。产出的 `*.vo.json` 是可回滚的独立文件。

## 文件在哪一层

| 层 | 文件 | 什么时候改 |
|---|---|---|
| L0 协议 | `motion.json` `motion.lock.json` `integrity.json` `licenses/` | 改身份、版本、输出规格；`integrity.json` 只由打包器生成 |
| L1 契约 | `SKILL.md` `guide.json` `params.schema.json` | 加版式、改容量、改节奏时三份一起改 |
| L2 内容 | `presets/` `assets/` `asset-manifest.json` | 每次出片 |
| L3 源码 | `src/` | 改画面语言 |
| L4 说明 | `README.md` `SPEC.md` `SKIA-SPEC.md` | 沉淀可复用规律 |

## 三条不可破的约束

1. `durationSeconds` = `segments[].dur` 之和（这里 24s = 8+6+6+4）。
2. `src/kit.js` 与 `src/layouts.js` 不许出现 `document` / `window` / `createElement`。
3. 文案与颜色不许写进 `src/`，一律从 preset 来。
   抖动种子也不许用时间 —— 用元素下标，否则线条逐帧发抖。

体检脚本会把这三条都扫一遍。
