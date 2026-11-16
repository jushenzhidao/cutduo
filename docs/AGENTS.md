# AGENTS.md · cutduo 导航

面向 AI agent 的入口。目标：**用最短路径找到该改的文件，并且知道改完怎么验**。
路径以**仓库根**为根；命令默认在仓库根执行，且先 `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`。

## 0. 命名约定（先读，避免「方案」一词歧义）

用户反馈过两次「分不清」。根因是**「方案」同时指了四层正交的事**。约定四段式，
每段都是可测的工程量，不需要记雅名：

```
速度档 / 模板 / 传帧 / 封装
```

例：`极速档 / desk / raw / h264`

### 第一维：速度档（按实测吞吐，1440×1080@60 · 8 worker）

> 四档共用**同一条技术栈：Skia 直出** —— Node + `@napi-rs/canvas`（Skia CPU 光栅）
> + 可选 `headless-gl`（GPU 壁纸）+ ffmpeg，8 进程分片。档位差别只在「有无浏览器」与「中间帧压不压缩」。
> 「直出」两字各指一个快因：直出编码器（不经过浏览器）、直出裸帧（不做中间 JPEG）。
> 快到 5.7× 实时（68.8s 片 / 11.98s 出片），代价是放弃 HTML/CSS 通用性。

| 档 | 代号 | 构成 | 实测 | 同片 68.8s 耗时 |
|---|---|---|---|---|
| **极速档** | `fast` | Skia 直出 + GPU 壁纸 + 裸帧 | 344 fps | 12.0 s |
| **标准档** | `std` | Skia 直出 + 静态壁纸 + 压缩帧 | 189–210 fps | 20–22 s |
| **浏览器档** | `chrome` | Chromium 渲染（film-kit 官方） | 55 fps | 75 s |
| **对照档** | `ref` | Chromium（cinecode） | 24.6 fps | 168 s |

速度只由两件事决定：**有没有浏览器（约 6×）**、**中间帧压不压缩（10–30%）**。
壁纸是否走 GPU、编码选 H.265 还是 H.264，对速度影响都 **< 5%**。

> ⚠️ fps 随片长上升（worker 预热与 ffmpeg 启动的固定开销被摊薄）：4127 帧的片 344 fps，
> 1419 帧的片只有 195–210 fps。**比较速度必须同片**，跨片比 fps 会误判。

### 第二维：模板（决定画面长相，不改变速度档）

| 代号 | 中文 | 代码 | 内容入口 |
|---|---|---|---|
| `desk` | 桌面 | `kits/desk/` | `content/*.json` |
| `science` | 科普 | `kits/science/science.mjs` | `kits/science/template/presets/` |
| `paper` | 纸感 | `kits/paper/paper.mjs` | `kits/paper/presets/` |
| `editorial` | 杂志 | `kits/editorial/canvas-editorial.mjs` | `content/inputs*.json` |
| `mg` | 通用 | `kits/mg/` | `kits/mg/params.json`（2026-11-10 后未改动、无交付片） |
| `clay` | 黏土图示 | `kits/clay/` | `kits/clay/presets/*.json`（换宿主，7 种机制） |
| `collage` | 屏拼贴 | `kits/collage/` | `kits/collage/presets/cutduo.json`（半蒸馏自 motiongit-promo-main，11 段） |
| `iso` | 等轴爆炸 | `kits/iso/` | `content/iso-*/params.json`（全蒸馏，几何与镜头全 JSON） |
| `diagram` | 说明性图示 | `kits/diagram/` | `kits/diagram/presets/*.json`（13 类段型，单进程） |

九支版式用的是**同一个渲染库**（`@napi-rs/canvas` / Skia），所以模板不改变速度档。
`clay` 是换宿主、`collage` 是半蒸馏、`iso` 是全蒸馏、`diagram` 是规则吸收；
四种来源不影响宿主与速度。完整清单见 `docs/inventory.md`。
`science` 额外支持浏览器宿主（同一份 `kit.js` + `layouts.js`），那是它的双跑能力，不是另一套栈。

### 超参预设（把四个维度打包成档）

`kits/desk/profiles.json` 只留两档：`standard`（默认，肉眼无损）/ `quality`（crf15+film，质量优先）。原 `small`/`tiny`/`flat` 已删除，等效命令见 `docs/编码优化-2026-11-13.md` §5。
`--profile <name>` 选用，任意单项可用 CLI 覆盖（优先级：CLI > profile > 默认）。
运行时会打印生效配置。**没有比 `standard` 更快的档**——换 preset 换不来速度，编码不是瓶颈。

### 第三、四维：传帧与封装

| 维度 | 档位 | 代价 |
|---|---|---|
| 传帧 | `raw` 裸帧 / `jpeg` 压缩帧 | 12.2 vs 28.8 ms/帧；两者的体积与保真度同时反向 |
| 封装 | `h264` 兼容 / `h265` 小型（0.64×）/ `av1` 极窄 | 只影响体积，不影响速度 |

### 明确不在这套命名里

- `film-kit`（官方原件）、`cinecode`（三方）—— 它们是**浏览器档与对照档的实例**，不是我们的产线。
- `refs/vendor/*` —— 下载来的模板包，仅作对照，**不入库、不外传**。
- **五支交付片（`desktop-opt` / `ai-cut` / `nanjing` / `period` / `hotpot`）是同一组合**：
  `极速档 / desk / raw / h264`，差别只在内容与素材，不是五套方案。

> 命名只落文档层，**不改物理目录**——路径稳定性优先于整齐，改目录会牵动十余处引用。

## 1. 这是什么

MotionGit `.motion` 模板的运行时实验与出片产线。两条主线：

- **拆**：解包、测量、复刻第三方模板（`templates/`、`replicas/`、`ref/`）。
- **造**：用自己的渲染器出片（`kits/desk/` = 桌面、`kits/paper/` = 纸感、`kits/science/` = 科普、`kits/mg/` = 通用、`kits/editorial/` = 杂志，内容在 `content/`）。

### 1.1 拿到一个新模板，先问用途（2026-11-13 定稿）

**不用 `protection` 定生死**——它只决定「用哪种方式」，不决定「能不能做」。

| 用途 | 走哪 | 说明 |
|---|---|---|
| 一次性出片 | **Chrome** | 官方链路，零成本（60s 片约 2.6 分钟） |
| 短期反复（几条～几十条） | **换宿主** | 需同时满足：源码可读 + 引擎 Canvas2D；不满足就 Chrome |
| 长期产线（持续产出） | **半蒸馏** | 有源码：蒸内容模型（2–4 天）；无源码：照片反推（3–5 天） |

技术判据只剩两条，且只用来判断「换宿主」成不成立：

1. **引擎必须是 Canvas2D**：有 `src/dom.js` 或非 canvas 的 `createElement('div'/'img')` → 换宿主等于写半个浏览器。
2. **源码可读**：`protection: protected` 是 AES-256-GCM 密文，换宿主需要源码 ⇒ 只能 Chrome 或照片反推。

> protected ≠ 做不了。蒸馏本来就是重写渲染，源码只是参考；`kits/paper` 当年就是逐像素反推
> `paper-perspective`。代价是要自己对齐版式与笔触，时间从 2 天变 3–5 天。

三条路的定位，别混（**这是接入深度的四级梯子，不是四个互斥分类**）：

| 档 | 借什么 | 相对 Chrome | 产物落点 | 成本 |
|---|---|---|---|---|
| **原版** | 全部（官方 Chrome 链路） | 1× | `refs/vendor/<name>/` | 0 |
| **换宿主** | 它的渲染器 | 0.8–1.5×（视绘制复杂度） | 同上，不改模板 | 几小时 |
| **半蒸馏** | 它的**内容模型**（recipe/schema） | 3–14× | `templates/own/<name>/` | 2–4 天 |
| **全蒸馏** | 只借设计参考 | 6–14× | `templates/own/<name>/` + `content/` | 2–4 天起 |

`原版` 不是「落后档」，是**默认档**——多数模板停在这里就对了。四级之间是同一条模板可以逐级深入的关系：
先跑原版看效果，需要去浏览器就跑换宿主，需要新内容就半蒸馏，需要自己的镜头语言才全蒸馏。

**铁律**：不要拿「换宿主」当性能手段。它省的是 Chromium 依赖与可定制性，不是时间。
速度只有两处能白拿：模板的 QA/记账链路（关审计）、重复绘制（缓存）。多进程是最后手段，
且只对「纯 JS 计算型」模板有效（Chrome 多实例在重绘制场景几乎不扩展）。

已评估过的模板，别再重复试（完整登记与落地产物见 `docs/蒸馏-索引.md`）：

| 模板 | 结论 |
|---|---|
| `mac-desktop` | 换宿主最优（480 fps / 24 worker，官方 8.7×） |
| `knowledge-explainer-sketchnote` | 可换宿主；通用图解 184 fps、手绘 native 14 fps（单核）。要多进程才划算（12 worker 138.9 fps） |
| `camera-mode` | 引擎是 DOM/CSS，换宿主不成立；走 Chrome 或蒸馏 |
| `paper-perspective` / `paper-perspective-11` / `promo-ink` | 源码加密，换宿主不成立；走 Chrome 或照片反推 |
| `motiongit-promo-main`（template-585） | 源码加密（`content/release.bin` 内 158 个 `.enc`），但 `guide.json` / `copy-contract.json` 可读 ⇒ **已半蒸馏为 `kits/collage`** |
| `cute-character-lyric-mv`（Remotion 4 + Canvas2D） | **已半蒸馏**为 `cute-mv`：只借 lyrics/keywords/notes 三字段与 9 镜头时长，渲染层自写；990 帧 5.2 s ≈190 fps |

### 1.2 自建一支新模板：从骨架生成，别手抄

```bash
uv run python tools/new-template.py --id my-template --title "我的版式"   # 生成 + 自检
uv run python tools/check-template.py --src templates/own/my-template      # 随时体检
```

骨架在 `templates/_scaffold/`，**能出片**（完整绘制原语 + 两个版式 + 宿主入口），
但画面语言要自己写。模板内部的五层（协议 / 契约 / 内容 / 源码 / 说明）与四条硬边界
见 `templates/_scaffold/README.md` —— 注意这跟本文件 §2 的「仓库分层」不是一个东西：
§2 说文件放在仓库哪，那边说一份模板内部该有什么。

体检器分两层：通用约束（所有模板）与形态约束（按 `runtime.profile` 与内容模型分派）。
它不强迫所有模板同构——`editorial` 用 `scenes`、`distill` 用平铺点位、`science-explainer`
用 `segments[].args`，三种都合法。

**已自建的三件套模板**（完整清单以 `templates/README.md` 第二节为准，这里只记接入口径）：
`--kit <名字>` 直出，**不进 `kits/`**。最新的 `night-card`（竖屏 9:16 情绪向卡片，六版式）
全链路已验：`template-smoke` 四关 PASS、包 918KB / integrity 18/18、
带音轨 1680 帧 / 56s / 4.6s（365 fps）/ 4.22MB、`gate --require-audio` PASS。

它同时注册进了 API（`api/kits/night-card.mjs`），是**模板也能进能力清单**的第一个例子。
`tools/smoke.sh` 的断言因此从「清单 == kits/ 目录集合」改成「kits/ 全部接入，允许模板多于目录」——
把目录布局当契约，只要接入一个 `templates/own/` 的模板就会误报。

## 2. 仓库分层（2026-11-13 重构后）

四类边界：**引擎 / 版式 / 内容 / 素材**。依赖方向单向：`kits/* → src/*`，版式之间不互相 import。

| 层 | 路径 | 放什么 | 能不能随便动 |
|---|---|---|---|
| 入口 | `render.mjs` / `AGENTS.md` | 主 CLI 分发；agent 短入口 | 改渲染入口影响全部版式 |
| 契约 | `api/` | 能力清单、校验、回执、每支 kit 一个 adapter | agent 的全部调用面；改完跑 `npm run check` |
| 远程 | `mcp/` + `deploy/` | Streamable HTTP MCP、上传与产物下载、compose/nginx | 远程调用面 |
| 引擎 | `src/` | 根探测、字体注册、门禁、校验、计时 | 动完跑 `bash tools/smoke.sh` |
| 版式 | `kits/<name>/` | 渲染器 + params.schema + presets，各支自治 | 只影响自己；共享能力从 `src/` 取 |
| 内容 | `content/` | 分镜 JSON（镜头/文案/素材引用/配音对齐） | 可自由改，改完重跑 TTS |
| 素材 | `assets/{fonts,audio,captions,media}/` | 字体、配音、字幕、实拍与生成图 | 唯一副本，**不删** |
| 产物 | `out/` | 成片、探针帧、报告、异步 job 状态 | 可重跑，已忽略入库 |
| 自助台 | `web/` | 表单 → 配音 → 出片 → 下载（内网/演示） | 无鉴权，不要直接暴露公网 |
| 评测闭环 | `harness/` | 渲染 → 三门判据 → 结构化建议 → 白名单改参 | 自动调参流程 |
| 分发 | `packages/` | 打好的 `.motion` 产物包 | 不入库，按需重建 |
| 交付 | `deliverables/` | 对外报告、样片与 QA 证据 | 归档；不要当源码 |
| 自建模板 | `templates/own/` | 三件套（night-card / cute-mv / sketchnote / chalkboard）与上游存档（distill / editorial） | 可改、可分发；保留上游 LICENSE |
| 模板样本 | `templates/fixtures/` | 模板格式的测试包（10 个 `.motion`） | 格式回归用 |
| 模板骨架 | `templates/_scaffold/` | 新建模板时复制的空骨架 | 改完跑 `tools/check-template.py --src templates/_scaffold` |
| 下载模板 | `refs/vendor/` | 个人下载包（含账户 Key） | **不入库、不外传** |

## 3. 任务路由

| 你想做 | 去哪 |
|---|---|
| 选版式 / 查有哪些 | `docs/inventory.md`（事实）→ `kits/STYLES.md`（怎么选） |
| 加一支版式 | `kits/<id>/` + `api/kits/<id>.mjs`（文件名 = id）→ `npm run inv` → `npm run check` |
| 吸收一个外部技能 | `docs/蒸馏-方法论.md` → 登记 `docs/distillations.json` → `npm run distill:check` |
| 新模板先做接入评估 | `node tools/intake.mjs plan --source <目录或 .motion 文件>`（只读；protected / 凭据 / DOM 引擎会报阻塞） |
| 评估后落机械动作 | `node tools/intake-apply.mjs --plan out/intake/<id>/plan.json`（dry-run 默认；`--yes` 写 adapter 或骨架） |
| vendor 源码抽到参考目录 | `node tools/intake-copy.mjs --plan out/intake/<id>/plan.json --yes`（保留 LICENSE；排除凭据；仍要人接 adapter） |
| 改一支片的文案/分镜 | `content/<name>.json` → `tools/build-sync.py --tts edge` → 出片 |
| 加一种镜头/改版式 | `kits/desk/desktop.mjs` 的 `SHOTS` → 探针帧 → `kits/desk/verify.mjs` |
| 换壁纸/氛围层 | `kits/desk/tools/bg-providers.mjs` |
| 调出片管线/性能 | `kits/desk/tools/render-bench.mjs`、`docs/MOTIONGIT-PLAYBOOK.md` §42–§46 |
| 加实拍图/视频 | `content/` 顶层 `photos` / `clips` + `assets/media/` |
| 判断要不要生成 BGM/配音/图/动图/视频/数字人 | **`docs/ASSET-POLICY.md`**（先问缺什么，再问用什么；渲染期禁止调生成 API） |
| 复刻第三方模板 | `refs/replicas/engine/`、`refs/vendor/`、`refs/reference/` |
| 看历史结论/踩坑 | `docs/MOTIONGIT-PLAYBOOK.md`（§0–§46，按主题检索） |
| 仓库体检/清理 | `docs/仓库清理-*.md` |

出片的一键编排在用户级 skill：`~/.workbuddy/skills/desktop-video-pipeline/scripts/make_film.py`。

## 4. 脚本索引（全部在 tools/，完整清单见 tools/README.md）

根目录只保留 `render.mjs` / `package.json` / `README.md` / `AGENTS.md`。
2026-11-13 起原先散在根的入口与引擎脚本已收进 `tools/`；下表只列高频入口，查全量看索引。

| 类别 | 文件 | 用途 |
|---|---|---|
| 入口 | `tools/motion-render.mjs` | `.motion` 通用宿主（doctor/check-params/preview/render） |
| 入口 | `tools/setup.sh` / `tools/fetch-fonts.sh` | 首次环境：Playwright/Chromium/FFmpeg、Noto 字体 |
| 入口 | `tools/build-template.py` / `tools/safe-unpack.py` | 打包 `.motion` / 只读安全解包 |
| 建片 | `tools/new-film.mjs` / `tools/new-template.py` | 新片骨架 / 新模板骨架 |
| 出片 | `tools/render-all.mjs` | 批量出片（走 `api/cli.mjs`）；常驻 daemon 已归档，见 `tools/README.md` 归档区 |
| 配音 | `tools/build-sync.py` | 逐句 TTS + 时间轴重排（批量换音色脚本已归档：依赖不存在的 `.motion` 包） |
| 校验 | `tools/smoke.sh` / `tools/check-docs.mjs` / `tools/inventory.mjs` | 出帧冒烟 / 文档漂移 / 版式清单 |
| 门禁 | `src/gate.mjs`（主）/ `tools/qa-gate.py`（legacy，skill 写死路径） | 交付完整性 |
| 音频 | `tools/audio-bed.mjs` / `tools/synth-bgm.mjs` / `tools/add-bgm.mjs` | 配乐 / 代码合成 / 混入 |
| 报告 | `tools/report.mjs` / `tools/coverage.mjs` / `tools/contact-sheet.mjs` | 片库总览 / 段型覆盖 / 审片表 |
| 归档 | `tools/legacy/`、`bench/`（19 个基准与探针） | 历史脚本与一次性基准 |

`bench/` 必须在仓库根运行（脚本用 `process.cwd()` 解析 `assets/fonts`），详见 `bench/README.md`。

## 5. 禁区

- `refs/**/package/personal/`、`release.bin`、`core.enc`、`*.motion`：个人下载凭据或受限模板，**不入库、不外传**。
- `refs/reference/**/*.mp4`、`refs/replicas/reference/`：仅本地 1:1 校验，不随交付外发。
- `out/`：产物，可重跑；不要把它当源码改。
- 删除参考帧/校准素材前，先 `grep` 自检与门禁对它的依赖（`ref/mac-desktop/t104.jpg` 曾被误删导致 verify FAIL）。

## 6. 改动纪律

1. **先探针，后全片**：`render-bench.mjs --probe /tmp/p.png --at <秒>`，确认版式再出整片。
2. **动代码必跑 `node kits/desk/verify.mjs`**（当前 13 项）与 `bash tools/smoke.sh`；几何、比色、缺素材负向断言都在里面。
3. **改文案必重跑 TTS**：`tools/build-sync.py --tts edge` 会按真实句长重排时间轴（`build-voices.py` 是旧名，已不存在）。
4. **内容不进代码目录**：新分镜写 `content/`，不要写回 `kits/`。
5. **一次只改一个变量**：比较管线/版式时固定分镜、音轨、分辨率。
6. **收口前跑全套**：`npm run check`（出帧 + 文档漂移）+ `node src/gate.mjs <成片>`；
   旧 `tools/qa-gate.py --expect-frames` 仍可单独用（skill 写死该路径）。

## 7. 目录演进记录

2026-11-13 完成结构性重构：`motiongit-lab/` 拆成 `src/` + `kits/` + `content/` + `assets/`。
上一版 §7 写的「不再移动 / 暂不移动」清单随之作废——那次判断的前提是「移动会牵动十余处引用」，
实际做法是先消灭 `dirname(..)` 猜根，再全量搬，最后用冒烟回归。

四条经验，下次搬家照做：

1. **先修 `.gitignore`，再移动**。原规则全是 `motiongit-lab/xxx` 硬编码，一搬家就有多条静默失效，
   其中一条正保护 vendor 模板里的账户 Key。现规则按身份特征匹配（`**/package/personal/`、`**/core.enc`、`**/template.motion`）。
2. **不要用 `dirname(..)` 推仓库根**。统一向上找 `.git`（`src/root.mjs`）；否则每支 kit 的目录深度一变，路径就全错。
3. **搬家只改路径，不改逻辑**。混在一起的改动无法二分定位。这次唯一顺带修的是
   `kits/desk/render.mjs` 的 `makeRenderer` 漏传 `start`/`end`（probe 与 worker 两条路径都会崩）。
4. **验收靠冒烟，不靠语法检查**。`node --check` 全过，运行时仍可能 404。`bash tools/smoke.sh` 全部版式各出一帧。

已删除并归档到仓库外：`cutproof/`（208M）、`cinecode-probe/`（163M）→ `~/Desktop/wb/_archive-20261113/`。
`renderd/` 的验收文档在 `docs/renderd-archive/`，代码只在 git 历史里。
