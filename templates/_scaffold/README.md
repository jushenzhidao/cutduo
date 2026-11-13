# _scaffold · 视频模板骨架（五层结构）

本目录**不是模板**，是新建模板时复制的骨架。下划线前缀让它排在 `own/` `vendor/` 之前，
且一眼能看出「这里没有内容」。文件名以点开头的（如 `.README.md.tmpl`）是模板文件，
生成时改名为正式文件，不进打包。

```bash
uv run python tools/new-template.py --id my-template --title "我的版式"      # 生成
uv run python tools/check-template.py --src templates/own/my-template       # 体检

# 出片（Skia 直出，不启浏览器；走 src/webcanvas.mjs 通用宿主）
node render.mjs --kit my-template \
  --params templates/own/my-template/presets/default.json --out out/my.mp4
```

## 一、为什么要分层：`.motion` 真正值钱的地方

`.motion` 包里最值得抄的不是目录整齐，是**它把「AI 该怎么用」和「AI 必须停在哪里」写成了数据**。
三份文件三个读者，互不重复：

| 文件 | 读者 | 只回答 | 不回答 |
|---|---|---|---|
| `motion.json` | 任何 `.motion` 工具 | 这是什么包、装它有什么风险 | 怎么填内容 |
| `params.schema.json` | 校验器 | 每个字段能填什么值 | 内容该怎么组织 |
| `guide.json` | AI / 内容生产者 | 版式怎么排、容量多少、缺料怎么办 | 字段类型与取值范围 |

最狠的一条是 `guide.materials[].ifMissing`——**「缺了要停」写在数据里，不靠 AI 自觉**。
文档里写「建议不要用演示文案兜底」会被忽略，写在 JSON 里就会被读取。

## 二、五层与单向引用

```
L0 协议层   motion.json / motion.lock.json / integrity.json / licenses/
              字段名受 specVersion 约束，不许自创 —— 这层是「能被装」的代价
L1 契约层   SKILL.md / guide.json / params.schema.json
              三个读者，三份文件，零重复
L2 内容层   presets/*.json + assets/ + asset-manifest.json
              换内容只动这层
L3 源码层   src/ + tools/
              换宿主只动这层，L2 不动
L4 说明层   README.md / SPEC.md / SKIA-SPEC.md
              人读，无运行时作用
```

引用方向**只能向下**：L1 可以引用 L2 的路径，L3 可以读 L2 的值，反过来一律禁止。

## 三、四条硬边界（比文件清单重要）

**① 反向引用禁止**
`src/*.js` 里不许出现文案、颜色、字号等任何内容的字面量，必须从 preset 读。
判据：`check-template.py` 会扫 `src/` 里成串的中文。

**② 层内唯一**
一个事实只在一层出现一次。容量上限只在 `guide.layouts[].capacity`，
`schema` 不写、`README` 不写。重复写就会出现「文档说 26 字、代码按 30 字裁」的漂移。

**③ 全部可冻结**
L0–L3 全部进 `integrity.json`。改一个字节就要重新打包，否则 `inspect` 会报不通过。
这不是麻烦，是让「跑得通的包」与「跑不通的源码」可区分。

**④ 双宿主纯度**
`src/kit.js` 与 `src/layouts.js` 必须是纯 Canvas2D：不得出现 `document.` / `window.` /
`createElement`。这些只允许出现在 `src/index.html` 与 `src/main.js`。
原因是同一份绘制代码要同时喂 Chromium 与 Skia；一旦绘制层碰 DOM，换宿主就不成立，
`02-rehost` 那一级直接断掉。

## 四、照抄 .motion 的七条 / 我们补的三条

| 照抄 | 原文出处 | 落点 |
|---|---|---|
| 三文件三读者 | `motion.json` + `params.schema.json` + `guide.json` | L1 |
| 缺料要停 | `guide.materials[].ifMissing` | `guide.json` |
| 容量跟版式走 | `guide.layouts[].capacity` | `guide.json`（**必须是实测值**） |
| 溯源 | `template.distilledFrom` | `motion.json` + `guide.json`（写明**没**复制什么） |
| 冻结清单 | `integrity.json` | L0 |
| 空依赖也是声明 | `motion.lock.json.dependencies: {}` | L0 |
| AI 入口带边界 | `SKILL.md` 末行「不覆盖系统/用户指令」 | L1（防注入，不许删） |

| 我们补 | 为什么 `.motion` 没有 |
|---|---|
| `pitfalls[]`（症状/成因/修法） | 规范只描述「应该怎样」，不沉淀「踩过什么」。`enter()` 入场下限、图标二次偏移、硬切首帧空帧、Skia 姿态图静默退化——每一条都会让新模板白跑一遍。`kits/science/template/guide.json` 已有 4 条示范 |
| Skia 宿主声明（`SKIA-SPEC.md`） | `runtime.profile` 只有 `html-canvas/1`。我们不污染 `motion.json` 的字段，另起一份说明 |
| 字高与安全区的**实测**下限 | 规范只有语义安全区（「底部 940px 以下」），没有像素级判据。我们的判据是「横屏正文 ≥40px、单行 ≤26 字」 |

## 五、新建一支模板的填写顺序

顺序不是随意的，前三步是**串行依赖**：

1. **`guide.json` 先写 `rhythm` 与 `layouts[].capacity`** —— 这决定这支模板能装多少字、切点多久。
   没这两个数，后面 schema 不知道该约束什么。
2. **`params.schema.json` 用 `tools/gen-schema.py` 从 guide + presets 反推**：

   ```bash
   python3 tools/gen-schema.py --template templates/own/<名字>           # 先看统计
   python3 tools/gen-schema.py --template templates/own/<名字> --write   # 写回
   ```

   类型取**真实 presets 的实测类型**（全样本同类型才收紧），只有说明、没有样本的参数不加 `type`——
   宁松不错。手写 40+ 个参数必然漏，而且会漏掉 `additionalProperties` 这条唯一的硬约束。
   生成后 `segments[].args` 就有了 `additionalProperties: false`，拼错键名会被拒。
3. **`presets/default.json` 照 schema 填一份能跑的最小内容** —— 它是 `parameters.defaultPreset`，打包时会被 assert 存在。
4. `motion.json` 填身份与输出规格（`durationSeconds` 要等于 `segments[].dur` 之和）。
5. `SKILL.md` 写操作序列，末行保留边界声明。
6. 最后写 `SPEC.md`（结构规律）与 `README.md`（这支模板是什么）。
7. 打包 → `node tools/motion-render.mjs inspect --package <out>.motion` → 期望 `integrity N/N 通过`。

## 六、骨架能做什么

- ✅ `check-template.py` 全绿
- ✅ `tools/build-template.py` 打包成功、`inspect` 认它为合法 `.motion`
- ✅ **能出片**：`kit.js` 有完整绘制原语（`paper` / `text` / `caption` / `cornerBadge` /
  `enter`），`layouts.js` 有 `cover` 与 `explain` 两个版式，`main.js` 对齐宿主
  `window.renderFrame(frame, inputs)`。生成立刻能渲染 10 秒占位片。
- ❌ 不提供画面语言。骨架的画是「能看出结构在动」的水平，不是能交付的设计。

参考实例：`own/science-explainer/`（9 版式、双宿主都验过，196 fps）。

## 七、与既有目录的关系

| 目录 | 是什么 |
|---|---|
| `templates/_scaffold/` | **本目录**，空骨架，可复制 |
| `templates/own/<name>/` | 自建模板真身，可分发 |
| `templates/vendor/<name>/` | 下载包，不入库、不外传 |
| 仓库根 `templates/01-…04-…` | 纯索引，回答「这条模板停在哪一级」 |

新建的模板默认落在 `own/`，并在仓库根 `templates/` 对应级别目录的 README 里加一行——
**只加行，不搬文件**（`AGENTS.md` §0 末段：路径稳定性优先于整齐）。
