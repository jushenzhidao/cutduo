# kits/ · 五套版式

每支 kit 是一个自治单元：**渲染器 + 参数 schema + presets**。版式之间不互相 import，
共享的东西一律下沉到 `src/`（依赖方向单向：`kits/* → src/*`）。

| 代号 | 中文 | 画幅 / 帧率 | 入口 | 参数入口 |
|---|---|---|---|---|
| `paper` | 纸感 | 1920×1080 @60 | `render.mjs --kit paper` | `kits/paper/presets/v8t.json` |
| `science` | 科普 | 1920×1080 @30 | `render.mjs --kit science` | `kits/science/template/presets/*.json` |
| `desk` | 桌面 | 1440×1080 @60 | `kits/desk/render.mjs` | `content/*.json`（`*-voiced.json` 带配音） |
| `editorial` | 杂志 | 1920×1080 @30 | `kits/editorial/canvas-editorial.mjs` | `content/inputs-*.json` |
| `mg` | 通用 | 1920×1080 @30 | `kits/mg/render.mjs` | `kits/mg/params.json` |
| `clay` | 黏土图示 | 1920×1080 @30 | `render.mjs --kit clay` | `kits/clay/presets/*.json`（7 种机制） |

六者共用 `@napi-rs/canvas`（Skia），**换版式不换速度档**。

`clay` 是**换宿主**（原样跑上游 Canvas2D 源码），不是自建；其余五支是自建或全蒸馏。

```bash
bash tools/smoke.sh     # 五支各出一帧，回归用
```

## 为什么 desk / editorial / mg 不走根入口

四份 `render.mjs` 里各有一段约 350 行重复的骨架：参数解析、worker 分片、
ffmpeg 管道、mpegts concat。合并它们要动分片边界与编码参数，是独立的一步工作。

目录已按「版式自治」摆好，合并时只需把各自的 `render.mjs` 改成一层薄适配器，
调用 `src/` 里的公共管道，不动这里的文件位置。

## 目录约定

```
kits/<name>/
  <name>.mjs 或 render.mjs   渲染器 / 出片入口
  params.schema.json         参数声明（可校验）
  presets/*.json             示例参数
  tokens.json                几何与配色规格（可选）
  README.md                  这支版式的结构规律与坑
```

`science` 额外带 `template/`，那是**渲染器的源码本体**：`science.mjs` 逐字加载其中的
`src/kit.js` + `layouts.js`，改它等于改成片。这与 `templates/own/` 里的模板是两种东西：

| 位置 | 是什么 | 有没有代码在执行它 |
|---|---|---|
| `kits/<name>/template/` | 渲染器源码本体 | 有（`science.mjs` 直接加载） |
| `templates/own/<name>/` | 可分发模板资产，可能是上游原版 | 没有（`editorial` 的上游 DOM 版；Skia 实现在 `kits/editorial/`） |

判据就是这一列：有代码在执行，就放渲染器旁边；只是原版存档，放 `templates/own/`。

`science` 同时支持 Skia 与浏览器两个宿主——双跑能力，不是另一套栈。

## 新增一支版式

1. 建 `kits/<name>/`，放渲染器与 `params.schema.json`。
2. 需要共享能力（字体、画布工厂、编码）→ 从 `src/` 引，不要在版式之间互相 import。
3. 内容不进 kit，写 `content/<片子>.json`，靠参数传入。
4. 在 `tools/smoke.sh` 加一行 `probe`，保证以后改路径能回归。
5. 走根入口的话，在 `render.mjs` 的 `kitSpec()` 里加一个 `kind`；
   若是三件套形式（`kit.js` + `layouts.js` + `stage.js`），`--kit <name>` 会自动按
   `templates/own/<name>/src` → `<name>/src` → `<name>`（目录本身）依次探测，无需改代码。
   **`kits/<name>/template/src` 不在通用探测里**：只有 `kits/science/template/src` 被
   `render.mjs` 单独硬编码为 science 专用适配器（要预载姿态图与口型贴片，通用宿主不认）。
   新模板一律落 `templates/own/`，放 `kits/` 下会报「找不到 kit」。
