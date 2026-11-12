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

五者共用 `@napi-rs/canvas`（Skia），**换版式不换速度档**。

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

`science` 额外带 `template/`（`.motion` 格式的三件套源码 + SPEC）与 `probe/`（最小验证集），
因为它同时支持 Skia 与浏览器两个宿主——双跑能力，不是另一套栈。

## 新增一支版式

1. 建 `kits/<name>/`，放渲染器与 `params.schema.json`。
2. 需要共享能力（字体、画布工厂、编码）→ 从 `src/` 引，不要在版式之间互相 import。
3. 内容不进 kit，写 `content/<片子>.json`，靠参数传入。
4. 在 `tools/smoke.sh` 加一行 `probe`，保证以后改路径能回归。
5. 走根入口的话，在 `render.mjs` 的 `kitSpec()` 里加一个 `kind`；
   若是三件套形式（`kit.js` + `layouts.js` + `stage.js`），`--kit <name>` 会自动按
   `kits/<name>/template/src` → `templates/own/<name>/src` → 目录路径 依次探测，无需改代码。
