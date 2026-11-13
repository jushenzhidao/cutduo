# clay · 黏土图示

**换宿主**（不是半蒸馏）：直接跑上游的 Canvas2D 源码，只接管环境与时间轴。

上游：`knowledge-explainer-clay v2.7.4`（@adunext，motiongit.com）。许可见 `vendor/LICENSE-*.txt`。

## 为什么是换宿主

上游 runtime 写的是 `native-python-node/1`，容易让人以为引擎是 Python + 3D。实测推翻：

| 判据 | 结果 |
|---|---|
| `adapter/run.mjs`（48KB） | **没有 `getContext`** —— 它是编排器，不是绘制器 |
| `native/native-clay.js`（111KB） | `getContext('2d')` + `beginPath`×16 + `createRadialGradient`×3 + `shadowBlur`×3 |
| `engine/` 目录 | 空的 |
| `audio-mix.py` | 只做混音（Python 只出现在这里） |

所以渲染层是纯 Canvas2D，换宿主半天，半蒸馏要 4–6 天。

## 七种机制

都是**数值驱动的物体形变**，不是排版。

| 机制 | 语义 | 专有参数 |
|---|---|---|
| `split-merge` | 按份量拆分 / 合并 | `parts`, `direction` |
| `interface-bind` | 边界逐个附着 | `agents` |
| `shear-break` | 压力过阈值才断 | `parts`, `force`, `threshold` |
| `lineage-track` | 谱系追踪到最早一支 | `parts` |
| `channel-transport` | 沿通道绕过障碍 | `route`, `obstacles` |
| `focus-return` | 聚焦后原位返回 | `focusId` |
| `alternative-compare` | 同路不同条件的对比 | `route`, `obstacles`, `conditions` |

共同基础：`title` / `nodes`（含 `value` 数值）/ `unit` / `valueUnit` / `decimals`。
`parts[].weight` 决定分块比例（1:2:3 → 36 克拆成 6/12/18）。

## 怎么用

```bash
node render.mjs --kit clay --params kits/clay/presets/default.json --out out/clay-demo.mp4 --workers 8
node src/gate.mjs out/clay-demo.mp4
```

实测：2100 帧 / 70s / 1920×1080 / 1.89MB / **8.0s**（262 fps）/ gate PASS（空帧 0%、黑帧 0%）。

改内容只动 preset：每个 `segments[]` 就是一条 recipe，`type` 填机制名。

## 配音（edge-tts）

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

uv run --with numpy python templates/own/sketchnote/tools/vo.py \
  --preset kits/clay/presets/default.json \
  --out-preset kits/clay/presets/default.vo.json \
  --out-audio kits/clay/out/default.vo.wav \
  --voice zh-CN-YunyangNeural --rate "+5%" \
  --min-seg 9          # 关键：见下方「duration 硬约束」

node render.mjs --kit clay \
  --params kits/clay/presets/default.vo.json --audio kits/clay/out/default.vo.wav \
  --out out/clay-vo.mp4 --workers 8
```

实测（无声版 / 旁白版）：

| | 帧 | 时长 | 体积 | 出片 | gate |
|---|---|---|---|---|---|
| 无声 | 2100 | 70.00s | 1.89MB | 8.0s | PASS |
| 旁白 | 1890 | 63.00s | 1.49MB | 7.0s | PASS（`--require-audio`） |

**`--min-seg` 必须 ≥ 9**：语速正常时一句旁白只有 2.6–3.0 秒，直接套 `vo.py` 的默认下限会把
段压到 3–4 秒 —— 黏土的拆解动画是一闪而过。7 段 × 9s = 63s，动画能演完，剩下的是让观众看的留白。

## 四个坑（都真踩过）

| 症状 | 原因 | 修法 |
|---|---|---|
| `DOMMatrix is not defined` | 上游用 `new DOMMatrix()` 做位姿 | `@napi-rs/canvas` **自带导出** DOMMatrix/DOMPoint/Path2D，作为参数注入 `new Function`（挂 window 无效，free variable 走作用域链） |
| 中文全是方框 | 上游写死 `600 ${size}px ClaySans`，映射到 Inter 就没中文 | 把 `ClaySans` / `ClayKai` / `Inter` 三个族名都注册到 `NotoSansSC-Medium.otf` |
| **整片黑底** | `draw()` 只画物体，**不画背景** —— 背景是独立的 `background()` 导出 | 每帧先 `clay.drawBackground(ctx, box, {time})`。漏了不会报错：canvas 透明 → yuv420p 变黑，且 gate 判不出黑帧（有物体时 YMAX 够高） |
| 段匹配整片错位 | `render.mjs` 的 `normalizeSegments` 把 `dur` 换成了 `t0/t1` | 适配器必须读 `t0/t1`；只读 `s.dur` 会全部落到默认 6s（7 段×6=42s，实际 70s） |
| **`duration outside numerical limits`** | 上游 schema 限死 `duration ∈ [9,45]`，是硬校验不是建议值；preset 段里没有 `duration` 字段时会退化成 8，直接抛错 | 适配器把 duration clamp 到 `[9,45]`，并让它跟随段长；段长也设 ≥9，否则动画只能播到 8/9 |

第三条最隐蔽：黑底成片的平均亮度 Y≈24，补上背景后 Y≈210 —— **Y 的跳变就是修复的证据**。

## 文件

```
kits/clay/
  clay.mjs              宿主适配器（boot + 段映射 + 字幕 + 角标）
  params.schema.json    段参数契约（7 种机制枚举 + 23 个段字段）
  presets/default.json  7 段示例（直接取自上游 native/examples/recipes.json）
  vendor/               上游渲染源码与许可（native-clay.js 111KB）
```

上游包本体不入库（在 `refs/vendor/knowledge-explainer-clay/`，含账户 Key）。
`vendor/native-clay.js` 是可分发的渲染源码，单独放一份以便 `kits/clay` 自洽。
