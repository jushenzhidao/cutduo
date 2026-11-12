# AGENTS.md · motiongit-lab 导航

面向 AI agent 的入口。目标：**用最短路径找到该改的文件，并且知道改完怎么验**。
路径以本目录为根；命令默认在 `motiongit-lab/` 下执行，且先 `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`。

## 1. 这是什么

MotionGit `.motion` 模板的运行时实验与出片产线。两条主线：

- **拆**：解包、测量、复刻第三方模板（`templates/`、`replicas/`、`ref/`）。
- **造**：用自己的渲染器出片（`desktop-kit/`、`skia-kit/`、`mg-kit/`、`content/`）。

## 2. 五层结构（2026-11-12 起）

| 层 | 路径 | 放什么 | 能不能随便动 |
|---|---|---|---|
| 代码 | `desktop-kit/`、`skia-kit/`、`mg-kit/` | 渲染器、组件、工具、自检 | 动完必须跑 `verify` |
| 内容 | `content/` | 15 个分镜 JSON（镜头/文案/素材引用） | 可自由改，改完重跑 TTS |
| 素材 | `edits/assets/` | 实拍照片、生成人像、Pexels 图/视频帧 | 唯一副本，**不删** |
| 产物 | `out/`、`replicas/out/` | 成片、总览、报告 | 可重跑，已忽略入库 |
| 第三方模板 | `templates/` | 下载包 + 自建模板 | 下载包含个人 Key，**不外传** |

`desktop-kit/presets` 是指向 `../content` 的过渡软链，旧命令仍可用；新命令请写 `content/`。

## 3. 任务路由

| 你想做 | 去哪 |
|---|---|
| 改一支片的文案/分镜 | `content/<name>.json` → `tools/build-voices.py` → 出片 |
| 加一种镜头/改版式 | `desktop-kit/desktop.mjs` 的 `SHOTS` → 探针帧 → `verify.mjs` |
| 换壁纸/氛围层 | `desktop-kit/tools/bg-providers.mjs` |
| 调出片管线/性能 | `desktop-kit/tools/render-bench.mjs`、`MOTIONGIT-PLAYBOOK.md` §42–§46 |
| 加实拍图/视频 | `content/` 顶层 `photos` / `clips` + `edits/assets/` |
| 复刻第三方模板 | `replicas/engine/`、`templates/`、`ref/` |
| 看历史结论/踩坑 | `MOTIONGIT-PLAYBOOK.md`（§0–§46，按主题检索） |
| 仓库体检/清理 | `docs/仓库清理-*.md`、`docs/模板与代码分离-2026-11-12.md` |

出片的一键编排在用户级 skill：`~/.workbuddy/skills/desktop-video-pipeline/scripts/make_film.py`。

## 4. 根目录脚本索引

根目录脚本是历史实验的扁平堆积。**按用途查表，不要按名字猜**。迁移前先看「可移植性」。
`bench/` 下的脚本依赖 `process.cwd()`，**必须从仓库根运行**（详见 `bench/README.md`）。

### 入口 / 必需

| 文件 | 用途 | 注意 |
|---|---|---|
| `motion-render.mjs` | `.motion` 通用宿主（doctor/check-params/preview/render） | 主入口 |
| `setup.sh` | 装 Playwright/Chromium/FFmpeg（国内镜像） | 首次环境 |
| `fetch-fonts.sh` | 拉 Noto Sans SC 三字重 | 首次环境 |
| `build-template.py` | 把 `templates/<name>/` 打成 `.motion` | `--src/--out` |
| `safe-unpack.py` | 只读安全解包（拒绝越界/软链/压缩炸弹） | 安全边界 |
| `gen-tpl-params.py` | 由 `.motion` 生成参数样例 | — |

### 渲染引擎 / 实验实现

| 文件 | 用途 | 状态 |
|---|---|---|
| `canvas-editorial.mjs` | Skia 版 editorial 剪辑（36K，读 `edits/inputs*.json`） | 可用，被文档引用 7 处 |
| `render-daemon.mjs` | 常驻渲染 daemon（复用 Skia/字体/worker） | 实验可用 |
| `render-parallel.mjs` | 分片并行渲染原型（N 段 Chromium + FFmpeg） | 实验可用 |
| `render-batch.py` | 多条片各跑一条完整流水线 | 可用 |
| `render-parallel-tpl.py` | 模板按时间切片并行 | **实验失败，默认禁用**（文件头有实测结论） |

### 基准（一次性，结论已进 PLAYBOOK）

| 文件 | 用途 | 可移植性 |
|---|---|---|
| `bench-draw.mjs` | 绘制成本 | **硬编码绝对路径**，换机器/移动即断 |
| `bench/bench-enc.mjs` | 纯编码成本 | 已移入 `bench/`，须从仓库根运行 |
| `bench-pipe.mjs` | JPEG vs RAW 管道 A/B | 用 `path.resolve('.')`，须在根运行 |
| `bench-ffmpeg.py` | FFmpeg 编码档位 + PSNR | 参数化 |
| `bench-limit.sh` | worker 数 / 内存极限压测 | `cd $(dirname)`，**移动会断** |
| `bench-three.sh` | 串行 / 4 路 / 8 路对比 | 同上 |

### 探针（回答单点问题）

| 文件 | 用途 |
|---|---|
| `cankit-probe.mjs` | CanvasKit / SkSL 可行性（三问） |
| `bench/grain-probe.mjs` | SkSL 烘颗粒 tile 的正确用法 | 已移入 `bench/` |
| `probe-kit.mjs` | 按分镜中点抽帧成 PNG（唯一有相对 import 的脚本） |
| `profile-chrome.mjs` | Chrome 逐帧截图路径对比 |
| `profile-engines.mjs` | Chromium / WebKit / Firefox 引擎对比 |
| `mem-monitor.py` | 进程树 RSS 峰值采样 |
| `proc-args.py` | 进程参数/环境读取 |

### 拼图 / 截图 / 临时

| 文件 | 用途 | 注意 |
|---|---|---|
| `mk-compare.mjs` | 四条管线同点对比图 | 依赖 `/tmp/cmp/*.jpg` |
| `mk-compare-skia.mjs` | 三版 Skia 对比图 | — |
| `mk-label.mjs` | 批量打标签 | 依赖 `assets/fonts` |
| `shot.mjs` / `shot2.mjs` | 用 Playwright 截 HTML 报告 | 依赖 `process.cwd()` |
| `bench/font-metrics.mjs` | 字体度量小样（原 `t.mjs`） | 已移入 `bench/` |

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

- **已完成**：内容与代码分离（`presets/` → `content/`，保留软链）；README 体积表与清理记录；本索引；
  第一批 3 个脚本移入 `bench/`（`font-metrics` / `bench-enc` / `grain-probe`），三个都已实跑通过。
- **下一步（每次 ≤5 个文件）**：只移动「无文档引用 + 无相对 import + 不依赖 cwd」的脚本，移动后跑一次探针 + `verify`。
  下一批要先修依赖：`bench-draw.mjs` 的硬编码绝对路径、`bench-limit.sh` / `bench-three.sh` 的 `cd $(dirname)`。
  `profile-*` / `shot*` 因文档引用多、依赖 cwd，暂留根目录。
- **暂不移动**：`bench-draw.mjs`（绝对路径）、`bench-limit.sh` / `bench-three.sh`（`cd $(dirname)`）、
  `profile-*` / `shot*`（依赖 cwd）、`canvas-editorial.mjs` / `render-*.{mjs,py}`（是引擎不是脚本）。
- **`templates/` 的 own/vendor 分离**：暂以索引标注代替物理拆分；真要拆，先改 `.gitignore` 的 5 条整包规则，
  再移动，避免个人 Key 因规则失效被误提交。
