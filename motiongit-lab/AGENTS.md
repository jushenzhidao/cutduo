# AGENTS.md · motiongit-lab 导航

面向 AI agent 的入口。目标：**用最短路径找到该改的文件，并且知道改完怎么验**。
路径以本目录为根；命令默认在 `motiongit-lab/` 下执行，且先 `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`。

## 0. 命名约定（先读，避免「方案」一词四义）

历史上「方案」这个词同时指了四件正交的事，导致沟通歧义。约定如下：**「方案」只指产线**，
其余三层一律叫「档位」。一条成片 = 产线 × 壁纸 × 传帧 × 封装。

### 产线（决定画面长相）

| 代号 | 中文名 | 代码 | 内容入口 | 状态 |
|---|---|---|---|---|
| `desk` | 桌面线 | `desktop-kit/` | `content/*.json` | **主力**，全部交付片走这条 |
| `science` | 科普线 | `skia-kit/science.mjs` | `templates/own/science-explainer/presets/` | 可用，浏览器/Skia 双宿主 |
| `paper` | 纸感线 | `skia-kit/paper.mjs` | `skia-kit/presets/` | 可用，1920×1080@60 |
| `editorial` | 杂志线 | `canvas-editorial.mjs` | `edits/inputs*.json` | 可用，走浏览器 canvas2d |
| `mg` | 通用线 | `mg-kit/` | `mg-kit/params.json` | 历史最小引擎（5 scene），2026-11-10 后未改动、无交付片使用 |

以上五个是**我们自己的**。以下三个是对照对象，不是产线，别混：

- `film-kit` — motiongit 官方 mac-desktop 原件（浏览器，55 fps）
- `cinecode` — 第三方产线（无头 Chrome，24.6 fps）
- `vendor/*` — `templates/vendor/` 下 5 个个人下载模板包

### 三个参数档位（不改变画面风格）

| 维度 | 档位 | 含义 | 代价 |
|---|---|---|---|
| 壁纸 | **静态** | Skia 渐变 | 0.05–0.16 ms/帧，无流动感 |
| | **流体** | GPU fBm（headless-gl） | 3.0 ms/帧，需 `HEADLESS_GL` |
| | **仿流体** | JS 逐像素同效 | 164 ms/帧，仅作 CPU 侧对照 |
| 传帧 | **裸帧** | RGBA 直供 ffmpeg stdin | 12.2 ms/帧，6.2 MB/帧过管道 |
| | **压缩帧** | JPEG q94 中间帧 | 28.8 ms/帧，多一次有损 |
| 封装 | **兼容档** | H.264 crf20 | 任何设备可播 |
| | **小型档** | H.265 crf24 | 约 0.64×，老设备可能不认 |
| | **极窄档** | AV1 | 同 CRF 下反而可能更大，慎用 |

### 固定句式与例子

写成 `产线 · 壁纸 · 传帧 · 封装`：

- `桌面线 · 流体 · 裸帧 · 兼容档` — `out/desktop-opt.mp4`（4127 帧 / 68.8s / 8.34 MB / 344 fps）
- `桌面线 · 静态 · 压缩帧 · 兼容档` — 未优化的早期版本
- `科普线 · 静态 · 压缩帧 · 兼容档` — `out/science-explainer-*.mp4`

**五支交付片（`desktop-opt` / `ai-cut` / `nanjing` / `period` / `hotpot`）用的是同一组合**，
差别只在内容与素材——它们是同一条产线的五个内容，不是五套方案。

> 命名只落在文档层，**不改物理目录**。路径稳定性优先于整齐，改目录会牵动十余处引用。

## 1. 这是什么

MotionGit `.motion` 模板的运行时实验与出片产线。两条主线：

- **拆**：解包、测量、复刻第三方模板（`templates/`、`replicas/`、`ref/`）。
- **造**：用自己的渲染器出片（`desktop-kit/` = 桌面线、`skia-kit/` = 纸感线与科普线、`mg-kit/` = 通用线、`content/`）。

## 2. 五层结构（2026-11-12 起）

| 层 | 路径 | 放什么 | 能不能随便动 |
|---|---|---|---|
| 代码 | `desktop-kit/`、`skia-kit/`、`mg-kit/` | 渲染器、组件、工具、自检 | 动完必须跑 `verify` |
| 内容 | `content/` | 15 个分镜 JSON（镜头/文案/素材引用） | 可自由改，改完重跑 TTS |
| 素材 | `edits/assets/` | 实拍照片、生成人像、Pexels 图/视频帧 | 唯一副本，**不删** |
| 产物 | `out/`、`replicas/out/` | 成片、总览、报告 | 可重跑，已忽略入库 |
| 自建模板 | `templates/own/` | `distill` / `editorial` / `science-explainer` + 打包产物 | 可改、可分发；保留上游 LICENSE |
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
