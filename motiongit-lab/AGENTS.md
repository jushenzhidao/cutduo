# AGENTS.md · motiongit-lab 导航

面向 AI agent 的入口。目标：**用最短路径找到该改的文件，并且知道改完怎么验**。
路径以本目录为根；命令默认在 `motiongit-lab/` 下执行，且先 `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`。

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
| `desk` | 桌面 | `desktop-kit/` | `content/*.json` |
| `science` | 科普 | `skia-kit/science.mjs` | `templates/own/science-explainer/presets/` |
| `paper` | 纸感 | `skia-kit/paper.mjs` | `skia-kit/presets/` |
| `editorial` | 杂志 | `canvas-editorial.mjs` | `edits/inputs*.json` |
| `mg` | 通用 | `mg-kit/` | `mg-kit/params.json`（2026-11-10 后未改动、无交付片） |

五个模板用的是**同一个渲染库**（`@napi-rs/canvas` / Skia），所以模板不改变速度档。
`science` 额外支持浏览器宿主（同一份 `kit.js` + `layouts.js`），那是它的双跑能力，不是另一套栈。

### 超参预设（把四个维度打包成档）

`desktop-kit/profiles.json` 只留两档：`standard`（默认，肉眼无损）/ `quality`（crf15+film，质量优先）。原 `small`/`tiny`/`flat` 已删除，等效命令见 `docs/编码优化-2026-11-13.md` §5。
`--profile <name>` 选用，任意单项可用 CLI 覆盖（优先级：CLI > profile > 默认）。
运行时会打印生效配置。**没有比 `standard` 更快的档**——换 preset 换不来速度，编码不是瓶颈。

### 第三、四维：传帧与封装

| 维度 | 档位 | 代价 |
|---|---|---|
| 传帧 | `raw` 裸帧 / `jpeg` 压缩帧 | 12.2 vs 28.8 ms/帧；两者的体积与保真度同时反向 |
| 封装 | `h264` 兼容 / `h265` 小型（0.64×）/ `av1` 极窄 | 只影响体积，不影响速度 |

### 明确不在这套命名里

- `film-kit`（官方原件）、`cinecode`（三方）—— 它们是**浏览器档与对照档的实例**，不是我们的产线。
- `templates/vendor/*` —— 下载来的模板包，仅作对照，**不入库、不外传**。
- **五支交付片（`desktop-opt` / `ai-cut` / `nanjing` / `period` / `hotpot`）是同一组合**：
  `极速档 / desk / raw / h264`，差别只在内容与素材，不是五套方案。

> 命名只落文档层，**不改物理目录**——路径稳定性优先于整齐，改目录会牵动十余处引用。

## 1. 这是什么

MotionGit `.motion` 模板的运行时实验与出片产线。两条主线：

- **拆**：解包、测量、复刻第三方模板（`templates/`、`replicas/`、`ref/`）。
- **造**：用自己的渲染器出片（`desktop-kit/` = 桌面线、`skia-kit/` = 纸感线与科普线、`mg-kit/` = 通用线、`content/`）。

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

> protected ≠ 做不了。蒸馏本来就是重写渲染，源码只是参考；`skia-kit` 当年就是逐像素反推
> `paper-perspective`。代价是要自己对齐版式与笔触，时间从 2 天变 3–5 天。

三条路的定位，别混（**这是接入深度的四级梯子，不是四个互斥分类**）：

| 档 | 借什么 | 相对 Chrome | 产物落点 | 成本 |
|---|---|---|---|---|
| **原版** | 全部（官方 Chrome 链路） | 1× | `templates/vendor/<name>/` | 0 |
| **换宿主** | 它的渲染器 | 0.8–1.5×（视绘制复杂度） | 同上，不改模板 | 几小时 |
| **半蒸馏** | 它的**内容模型**（recipe/schema） | 3–14× | `templates/own/<name>/` | 2–4 天 |
| **全蒸馏** | 只借设计参考 | 6–14× | `templates/own/<name>/` + `content/` | 2–4 天起 |

`原版` 不是「落后档」，是**默认档**——多数模板停在这里就对了。四级之间是同一条模板可以逐级深入的关系：
先跑原版看效果，需要去浏览器就跑换宿主，需要新内容就半蒸馏，需要自己的镜头语言才全蒸馏。

**铁律**：不要拿「换宿主」当性能手段。它省的是 Chromium 依赖与可定制性，不是时间。
速度只有两处能白拿：模板的 QA/记账链路（关审计）、重复绘制（缓存）。多进程是最后手段，
且只对「纯 JS 计算型」模板有效（Chrome 多实例在重绘制场景几乎不扩展）。

已评估过的模板，别再重复试：

| 模板 | 结论 |
|---|---|
| `mac-desktop` | 换宿主最优（480 fps / 24 worker，官方 8.7×） |
| `knowledge-explainer-sketchnote` | 可换宿主；通用图解 184 fps、手绘 native 14 fps（单核）。要多进程才划算（12 worker 138.9 fps） |
| `camera-mode` | 引擎是 DOM/CSS，换宿主不成立；走 Chrome 或蒸馏 |
| `paper-perspective` / `paper-perspective-11` / `promo-ink` | 源码加密，换宿主不成立；走 Chrome 或照片反推 |

### 1.2 自建一支新模板：从骨架生成，别手抄

```bash
uv run python new-template.py --id my-template --title "我的版式"   # 生成 + 自检
uv run python check-template.py --src templates/own/my-template      # 随时体检
```

骨架在 `templates/_scaffold/`，**能出片**（完整绘制原语 + 两个版式 + 宿主入口），
但画面语言要自己写。模板内部的五层（协议 / 契约 / 内容 / 源码 / 说明）与四条硬边界
见 `templates/_scaffold/README.md` —— 注意这跟本文件 §2 的「仓库分层」不是一个东西：
§2 说文件放在仓库哪，那边说一份模板内部该有什么。

体检器分两层：通用约束（所有模板）与形态约束（按 `runtime.profile` 与内容模型分派）。
它不强迫所有模板同构——`editorial` 用 `scenes`、`distill` 用平铺点位、`science-explainer`
用 `segments[].args`，三种都合法。

## 2. 仓库分层（2026-11-12 起）

| 层 | 路径 | 放什么 | 能不能随便动 |
|---|---|---|---|
| 代码 | `desktop-kit/`、`skia-kit/`、`mg-kit/` | 渲染器、组件、工具、自检 | 动完必须跑 `verify` |
| 内容 | `content/` | 15 个分镜 JSON（镜头/文案/素材引用） | 可自由改，改完重跑 TTS |
| 素材 | `edits/assets/` | 实拍照片、生成人像、Pexels 图/视频帧 | 唯一副本，**不删** |
| 产物 | `out/`、`replicas/out/` | 成片、总览、报告 | 可重跑，已忽略入库 |
| 自建模板 | `templates/own/` | `distill` / `editorial` / `science-explainer` + 打包产物 | 可改、可分发；保留上游 LICENSE |
| 模板骨架 | `templates/_scaffold/` | 新建模板时复制的空骨架（结构完整、能出片） | 改它会影响以后所有新模板，改完跑 `check-template.py --src templates/_scaffold` |
| 下载模板 | `templates/vendor/` | 5 个个人下载包（film-kit / motion-kit / html-canvas） | **不入库、不外传**，含个人 Key |

`desktop-kit/presets` 是指向 `../content` 的过渡软链，旧命令仍可用；新命令请写 `content/`。

## 3. 任务路由

| 你想做 | 去哪 |
|---|---|
| 改一支片的文案/分镜 | `content/<name>.json` → `tools/build-voices.py` → 出片 |
| 加一种镜头/改版式 | `desktop-kit/desktop.mjs` 的 `SHOTS` → 探针帧 → `verify.mjs` |
| 换壁纸/氛围层 | `desktop-kit/tools/bg-providers.mjs` |
| 调出片管线/性能 | `desktop-kit/tools/render-bench.mjs`、`MOTIONGIT-PLAYBOOK.md` §42–§46 |
| 加实拍图/视频 | `content/` 顶层 `photos` / `clips` + `edits/assets/` |
| 复刻第三方模板 | `replicas/engine/`、`templates/vendor/`、`ref/` |
| 看历史结论/踩坑 | `MOTIONGIT-PLAYBOOK.md`（§0–§46，按主题检索） |
| 仓库体检/清理 | `docs/仓库清理-*.md`、`docs/模板与代码分离-2026-11-12.md` |

出片的一键编排在用户级 skill：`~/.workbuddy/skills/desktop-video-pipeline/scripts/make_film.py`。

## 4. 脚本索引

根目录已收敛为 **入口 / 引擎 / 工具** 三类（18 个）；一次性基准、探针、拼图脚本全部在 `bench/`（19 个）。

### 根目录（18）

| 类别 | 文件 | 用途 |
|---|---|---|
| 入口 | `motion-render.mjs` | `.motion` 通用宿主（doctor/check-params/preview/render） |
| 入口 | `setup.sh` / `fetch-fonts.sh` | 首次环境：Playwright/Chromium/FFmpeg、Noto 字体 |
| 入口 | `build-template.py` | 把 `templates/own/<name>/` 打成 `.motion` |
| 入口 | `safe-unpack.py` | 只读安全解包（拒绝越界/软链/压缩炸弹） |
| 引擎 | `canvas-editorial.mjs` | Skia 版 editorial 剪辑（36K，读 `edits/inputs*.json`） |
| 引擎 | `render-daemon.mjs` | 常驻 daemon（复用 Skia/字体/worker） |
| 引擎 | `render-parallel.mjs` | 分片并行渲染原型 |
| 引擎 | `render-batch.py` | 多条片各跑一条完整流水线 |
| 引擎 | `render-parallel-tpl.py` | **实验失败，默认禁用**（文件头有实测结论） |
| 工具 | `build-sync.py` | 旁白逐句合成 + 时间轴重排 |
| 工具 | `build-voices.sh` / `build-voices-more.sh` | 批量换音色/方言 |
| 工具 | `gen-tpl-params.py` / `make-tpl.sh` / `shard-tpl.py` / `test-theme.sh` | 模板参数/打包/切片/主题测试 |
| 门禁 | `qa-gate.py` | 交付完整性（黑帧/重复段/音画时长）；**skill 写死此路径，勿移** |

### `bench/`（19）

| 类别 | 文件 |
|---|---|
| 成本基准 | `bench-draw` `bench-enc` `bench-pipe` `bench-ffmpeg` |
| 并发/内存 | `bench-limit.sh` `bench-three.sh` `mem-monitor.py` `proc-args.py` |
| 探针 | `cankit-probe` `grain-probe` `probe-kit` `profile-chrome` `profile-engines` |
| 拼图/截图 | `mk-compare` `mk-compare-skia` `mk-label` `shot` `shot2` |
| 宿主 | `motion-host/poc.mjs` | `.motion` 单镜头跑在 Skia 上（依赖 `templates/vendor`） |
| 宿主 | `motion-host/poc-full.mjs` | `.motion` 整片宿主 main.js 跑在 Skia 上，`--bench` 测单帧 1.01 ms |
| 宿主 | `motion-host/render-parallel.mjs` | 换宿主 + 并行出片，24 worker 480 fps（8.7× 官方） |
| 宿主 | `motion-host/check-hostable.mjs` | 判据：5 个 vendor 模板里只有 `mac-desktop` 可换宿主 |
| 字体 | `font-metrics`（原 `t.mjs`） |

**必须在仓库根运行**（脚本用 `process.cwd()` 解析 `assets/fonts`、`edits/inputs-md.json`），
两个 shell 已改成 `cd "$(dirname "$0")/.."`。详见 `bench/README.md`。

## 5. 禁区

- `templates/**/package/personal/`、`release.bin`、`core.enc`、`*.motion`：个人下载凭据或受限模板，**不入库、不外传**。
- `ref/**/*.mp4`、`replicas/reference/`：仅本地 1:1 校验，不随交付外发。
- `out/`：产物，可重跑；不要把它当源码改。
- 删除参考帧/校准素材前，先 `grep` 自检与门禁对它的依赖（`ref/mac-desktop/t104.jpg` 曾被误删导致 verify FAIL）。

## 6. 改动纪律

1. **先探针，后全片**：`render-bench.mjs --probe /tmp/p.png --at <秒>`，确认版式再出整片。
2. **动代码必跑 `node desktop-kit/verify.mjs`**（当前 13 项）；几何、比色、缺素材负向断言都在里面。
3. **改文案必重跑 TTS**：`build-voices.py` 会按真实句长重排时间轴。
4. **内容不进代码目录**：新分镜写 `content/`，不要写回 `desktop-kit/`。
5. **一次只改一个变量**：比较管线/版式时固定分镜、音轨、分辨率。
6. **收口前跑全套**：`qa-gate.py --expect-frames <round(dur*60)>` + `skia-kit/gate.mjs`。

## 7. 渐进式优化路线

不为整齐而大搬家——移动会破坏文档引用与脚本内的相对/绝对路径。按「先索引、再小步移动、每步验证」推进：

- **已完成**：内容与代码分离（`presets/` → `content/`）；脚本三层收敛（根目录 37 → 18，`bench/` 19 个）；
  `templates/` 拆为 `own/`（3 个自建 + 1 个产物）与 `vendor/`（5 个个人下载包）；本索引。
- **下一步**：可选的 `engines/` 归并——但会牵动 10+ 处文档引用，收益低，暂不做。
- **不再移动**：`canvas-editorial` / `render-*` 是引擎；`motion-render` / `setup` / `build-template` 是入口；
  `qa-gate.py` 被 skill 写死。路径稳定性优先于目录整齐。
- **暂不移动**：`bench-draw.mjs`（绝对路径）、`bench-limit.sh` / `bench-three.sh`（`cd $(dirname)`）、
  `profile-*` / `shot*`（依赖 cwd）、`canvas-editorial.mjs` / `render-*.{mjs,py}`（是引擎不是脚本）。
- **`templates/` 的 own/vendor 分离**：已建立 `templates/README.md`（来源/许可/入库/分发清单），
  并在 `.gitignore` 预留 `templates/vendor/` 规则；**物理移动仍未做**。顺序必须是「先改规则 → 再移动」，
  否则个人 Key 会因规则失效被误提交；移动后 `git status` 只要出现 `personal/`、`core.enc` 就立即回滚。
