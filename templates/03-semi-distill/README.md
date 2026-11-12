# 03 · 半蒸馏（semi-distill）· 借它的内容模型

**一句话**：把模板的 `recipe / params.schema / AI-CHOICES` 留下当「内容编译器」，渲染层自己写 ——
**内容是它的，画面是自己的。**

## 怎么算停在这一级

- 参数仍按它的 `params.schema.json` 写，切镜、版式选择仍走它的规则；
- 绘制代码是我们的（`@napi-rs/canvas` 直出）；
- **不 import 它的渲染文件**，只读它的内容层。

与「换宿主」的分界：换宿主还在跑它的 `draw()`；半蒸馏只跑它的「决定画什么」，不跑「怎么画」。

## 现状：暂无实例

第一个候选是 `knowledge-explainer-sketchnote`。它的真实资产不是 382 个渲染文件，而是：

| 资产 | 体量 | 作用 |
|---|---|---|
| `AI-CHOICES.json` | 68 KB | 内容决策规则 |
| `KNOWLEDGE-GUIDE` | 20 KB | 讲解结构规范 |
| `params.schema.json` | 1 MB | 内容模型（可校验） |

预计落点：`motiongit-lab/templates/own/sketchnote-distill/`。

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
