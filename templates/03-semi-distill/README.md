# 03 · 半蒸馏（semi-distill）· 借它的内容模型

**一句话**：把模板的 `recipe / params.schema / AI-CHOICES` 留下当「内容编译器」，渲染层自己写 ——
**内容是它的，画面是自己的。**

## 怎么算停在这一级

- 参数仍按它的 `params.schema.json` 写，切镜、版式选择仍走它的规则；
- 绘制代码是我们的（`@napi-rs/canvas` 直出）；
- **不 import 它的渲染文件**，只读它的内容层。

与「换宿主」的分界：换宿主还在跑它的 `draw()`；半蒸馏只跑它的「决定画什么」，不跑「怎么画」。

## 现状：3 个实例

前两支是同一作者（@adunext）同一系列（knowledge-explainer）的两个方向：
sketchnote 蒸的是**版式枚举**，chalkboard 蒸的是**几何机制**。
第三支换了个问题域：不是"讲解结构"，而是"歌词与画面的对位"。

### 1. `templates/own/sketchnote/` —— 手绘解说

2026-11-13 半蒸馏自 `knowledge-explainer-sketchnote v2.7.4`。

| 借了什么 | 没借什么 |
|---|---|
| 4 类 mechanism 的字段契约（`title` / `items` / `revision` / `return`） | 它的渲染代码与版式坐标 |
| 容量上限（`label` ≤12 字、`notes` ≤18 字、`title` ≤28 字…） | 素材、文案、品牌标识 |
| 内容族划分（`process` / `definition` / `data-bar` …） | — |

### 2. `templates/own/chalkboard/` —— 粉笔黑板几何讲解

2026-11-13 半蒸馏自 `knowledge-explainer-chalkboard v2.7.4`。

| 借了什么 | 没借什么 |
|---|---|
| 8 类 mechanism 的字段契约（`orbit-phase` … `condition-proof`） | 它的粉笔笔触、板面材质、版式坐标 |
| **几何式子**：轨道参数化 / 可见受光比例 / 本影锥 / 圆面重叠 / 光路求交 | 8 章手写的原片演出脚本 |
| 4 个条件谓词的定义（`near-opposition` … `direct-center-ray`） | 13 类通用图示库、102 个图标、素材、文案 |
| 21 个内容族到机制的映射 | 品牌标识 |

**这一支的关键判断**：上游包总 417 个条目，其中 `runtime/diagrams.js` 383KB + catalog 803KB
（13 类通用图示）与 `graphics/knowledge-icons.js` 102KB + catalog 187KB（102 图标）占了大头，
但**这两块没蒸**——它们是「通用图示」，`science` 已经有同类能力，蒸了就是重复建设。
真正值钱的是那 8 条几何式子：它们让「百分比」不是画上去的，而是算出来的。

**它也不该走换宿主**：虽然引擎是纯 Canvas2D（理论可换），但上游把 8 章演出写成了
30KB 手写 chapter 脚本（`native/source/chapters/*.js`），换宿主只能复现那一支片，
换不了「讲新内容」。要长期产线就得把机制层拿到手，这正是半蒸馏的定义。

上游的真实资产不是 382 个渲染文件，而是这三份：

| 资产 | 作用 |
|---|---|
| `AI-CHOICES.json`（57 KB） | 内容决策规则：`need → existingFamilies` |
| `KNOWLEDGE-GUIDE.md` | 讲解结构规范 |
| `native/parameters.schema.json` | 4 类 mechanism 的字段契约（`oneOf`） |

提取已工具化：

```bash
python3 tools/distill-inspect.py --package refs/vendor/knowledge-explainer-sketchnote/template.motion
# → out/distill-knowledge-explainer-sketchnote/report.md + guide.draft.json
```

注意：`protected` 包也能提 —— 加密只覆盖渲染源码，`params.schema.json` 仍是明文。

### 3. `templates/own/cute-mv/` —— 可爱角色歌词 MV

2026-11-13 半蒸馏自 `cute-character-lyric-mv v1.0.1`（Remotion 4 + Canvas2D，MIT，个人下载包）。

| 借了什么 | 没借什么 |
|---|---|
| `lyrics` / `keywords` / `notes` 三字段契约与 12/12/6 条上限 | 上游 `Shots.tsx` / `rig.ts` 的任何代码 |
| 9 镜头的顺序与时长（4.25/3.65/3.15/4.25/4.5/3.95/2.8/3.25/3.2 s） | 9 个渐变背景与占位角色的画法 |
| 三类文字的排版数值（62px 底部歌词 / 150px 顶部大字 / 40px 纸条） | 示例歌词、纸条文案、品牌标识与《碎碎念》演示片 |
| 固定 33 s / 30 fps / 1920×1080 | — |

上游这一支最有价值的是**节奏模型**：切点跟歌词换句走、不跟动作走；
以及**三类文字的层级**（大字在底、纸条压人、歌词条最上）。渲染层自写后实测
990 帧 / 8 worker **5.2 s ≈190 fps**，成片 5.5 MB，gate PASS。

## 落点与成本

- 模板：`motiongit-lab/templates/own/<name>/`
  最小集合 = `README.md` / `presets/*.json` / `params.schema.json` / `integrity.json`
- 成本：**有源码 2–4 天**；无源码只能照片反推，**3–5 天**
- 收益：相对 Chrome 3–14×（量级参照全蒸馏的 `science-explainer`：5–6 ms/帧）

## 为什么这一级最划算

模板最值钱的是**内容模型**（怎么写、怎么切、什么情况下用哪种版式），
不是几百个渲染文件。渲染层自写只花一次，之后每条片子都吃这个倍率。

## 下一步

写完后若还要自己的镜头语言（不止换版式）→ 升级到 `../04-full-distill/`。
