# templates/ · 模板目录（cutduo 仓库根）

本目录回答两个不同的问题，分两层：

| 层 | 看哪 | 回答什么 |
|---|---|---|
| **类型层** | `01-original/` ～ `04-full-distill/` | 这条模板**停在哪一级**（原版 / 换宿主 / 半蒸馏 / 全蒸馏） |
| **索引层** | 本文件第二节 | 要出这种画面，**跑哪个文件、喂哪份参数** |

四个类型目录里只有 `README.md`，**不放代码与参数副本**——物理模板一律在 `templates/own/` 与 `refs/vendor/`。
这不是洁癖：`own/` 与 `vendor/` 是按「能不能分发」分的，属凭据与许可的硬约束；
接入深度是过程属性，会随投入变化（今天原版、明天换宿主），按它搬文件会让路径天天变。
沿用 `docs/AGENTS.md` §0 末段「路径稳定性优先于整齐」。

> 目录名用 ASCII 前缀（`01-`…`04-`）是为了命令里好敲；中文档名写在各目录 README 标题里。

> **2026-11-13 平铺重构后**：`motiongit-lab/` 这一层已去掉。渲染器到仓库根
> （`render.mjs` + `kits/` + `src/`），脚本到 `tools/`，模板资产仍在 `templates/`。
> 本文件的路径已同步；`docs/` 里带日期的历史文档保留原路径，不改写。

## 一、四类 = 接入深度的四级梯子

| 目录 | 档 | 借它什么 | 产物落点 | 成本 | 相对 Chrome |
|---|---|---|---|---|---|
| [`01-original/`](01-original/README.md) | 原版 | 全部（官方 Chromium） | `refs/vendor/<name>/`（不入库） | 0 | 1× |
| [`02-rehost/`](02-rehost/README.md) | 换宿主 | 它的**渲染器** | 同上，模板不改；脚本在 `bench/motion-host/` | 几小时 | 0.8–1.5× |
| [`03-semi-distill/`](03-semi-distill/README.md) | 半蒸馏 | 它的**内容模型**（recipe / schema） | `templates/own/<name>/` | 2–4 天 | 3–14× |
| [`04-full-distill/`](04-full-distill/README.md) | 全蒸馏 | 只借**设计参考** | `own/<name>/` + `content/` | 2–4 天起 | 6–14× |

**这不是四个互斥分类，是一条可以逐级深入的梯子。** 同一模板可能同时停在两级：
`mac-desktop` 在 `02-rehost/` 有换宿主 PoC，在 `04-full-distill/` 有全蒸馏的 `kits/desk`。

怎么选，一句话：**一次性出片走原版；要反复出且引擎是 Canvas2D 走换宿主；
要长期产线走半蒸馏；要有自己的镜头语言才全蒸馏。** `原版` 是默认档，不是落后档。

## 二、五支内置模板（与「速度档」正交）

速度档只决定快慢（有无浏览器、中间帧压不压缩），模板只决定画面长相。
四档实测与判据见 `docs/AGENTS.md` §0，此处不重复。

| 代号 | 中文 | 代码入口 | 参数 / 内容入口 |
|---|---|---|---|
| `desk` | 桌面 | `kits/desk/render.mjs` | `content/*.json`（`*-voiced.json` 带配音） |
| `science` | 科普 | `kits/science/science.mjs`（经 `render.mjs --kit science`） | `kits/science/template/presets/*.json` |
| `paper` | 纸感 | `kits/paper/paper.mjs`（经 `render.mjs --kit paper`） | `kits/paper/presets/v8t.json` |
| `editorial` | 杂志 | `kits/editorial/canvas-editorial.mjs` | `content/inputs-*.json`（默认 `inputs-inc-a.json`） |
| `mg` | 通用 | `kits/mg/render.mjs` | `kits/mg/params.json`（2026-11-10 后未改动，无交付片） |

五者共用同一个渲染库 `@napi-rs/canvas`（Skia），所以**换模板不换速度档**。
`science` 额外支持浏览器宿主（同一份 `kit.js` + `layouts.js`），那是双跑能力，不是另一套栈。

**还有第六种：任意三件套模板。** 只要 `src/` 有 `kit.js` + `layouts.js` + `stage.js`，
就能不占内置代号直出：

```bash
node render.mjs --kit <模板名> --params templates/own/<模板名>/presets/default.json --out out/x.mp4
```

`--kit` 先查 `science`/`paper` 内置适配器，再按 `templates/own/<模板名>/src` 找三件套，
最后当作目录路径。这三件套就是 `templates/_scaffold/` 生成出来的形态。

> 别把「接入深度四级」和「模板内部五层」搞混：前者是本文件回答的（这条模板停在哪一级），
> 后者是 `templates/_scaffold/README.md` 回答的（一份模板内部该有哪些文件）。两者正交。

## 三、常用命令（cwd = 仓库根）

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# science（Skia 直出）
node render.mjs --kit science \
  --params kits/science/template/presets/microwave.json \
  --out out/science.mp4 --workers 20

# paper
node render.mjs --kit paper \
  --params kits/paper/presets/v8t.json --out out/paper.mp4

# 任意三件套模板
node render.mjs --kit my-template \
  --params templates/own/my-template/presets/default.json --out out/my.mp4

# desk（1440×1080 / 60fps）
node kits/desk/render.mjs --params content/demo-voiced.json \
  --audio assets/audio/desktop.m4a --out out/desktop.mp4 --fps 60

# editorial
node kits/editorial/canvas-editorial.mjs \
  --inputs content/inputs-inc-a.json --out out/skia-cut.mp4

# mg
node kits/mg/render.mjs --params kits/mg/params.json --out kits/mg/out/mg-demo.mp4
```

交付前跑门禁：`node src/gate.mjs <成片>`。判据只拦交付完整性
（空帧 / 黑帧 / 帧数 / 音画时长差），hook 与亮度只告警不拦 —— 见 `src/gate.mjs` 头部注释。

## 四、新增一支模板怎么落位

### 4.0 先看模板内部结构（五层），再从骨架生成

模板**内部**的骨架在 `templates/_scaffold/`，不在别处。五层（协议 / 契约 / 内容 /
源码 / 说明）与四条硬边界见它自己的 `README.md`。别手抄文件，用生成器：

```bash
uv run python tools/new-template.py --id my-template --title "我的版式"
uv run python tools/check-template.py --src templates/own/my-template
```

骨架**能出片**：`kit.js` 有完整绘制原语，`layouts.js` 有 cover/explain 两个版式，
`stage.js` 承担宿主无关的编排（浏览器与 Skia 共用同一份，不各写一遍）。
它解决的是「结构完整且能被工具认」；画面语言必须自己写。

### 4.1 落位步骤

1. **先定级**：按第一节判断停在哪一级，条目写进对应类型目录的 README（只加一行，不搬文件）。
2. **自建** → 用 `new-template.py` 生成到 `templates/own/<名字>/`，不要手建目录。
   生成后按 `_scaffold/README.md` 第五节顺序填：`guide.json` 的 rhythm 与 capacity →
   `params.schema.json` → `presets/default.json` → `motion.json` → `SKILL.md` → `SPEC.md`。
3. **下载包** → `templates/vendor/<名字>/`，**不入库、不外传**。
   原因不是洁癖：包内含账号凭据（`package/personal/`）、`core.enc` 与受限 `release.bin`。
4. **打包与校验**：
   ```bash
   uv run python tools/build-template.py --src templates/own/<名字> --out packages/<名字>.motion
   node tools/motion-render.mjs inspect --package packages/<名字>.motion   # 期望 integrity 全通过
   ```
5. 打包后把新代号补进本文件第二节与 `docs/AGENTS.md` §0 的模板表 —— 两处都要改，
   只改一处就会出现「文档写着五支、实际六支」。

## 五、本文件与 `_scaffold/README.md` 的分工

| 文件 | 回答什么 |
|---|---|
| **本文件** | 出片视角：哪一级、哪个模板、跑什么命令、参数在哪 |
| `templates/_scaffold/README.md` | 结构视角：一份模板内部该有哪些文件、每层的唯一职责、四条硬边界 |
| `templates/_scaffold/README.md` 第四节 | 哪些是照抄 `.motion` 的、哪些是我们补的 |

两者冲突时，以 `_scaffold/README.md` 的结构约束为准（它管的是模板能不能被工具认）。
