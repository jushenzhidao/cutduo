# cutduo

**Skia 直出的视频管线：五套版式，一条命令出片，不经过浏览器。**

Node + [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas)（Skia）逐帧绘制 → 管道喂给 ffmpeg 编码 → 合成音轨。
没有 Chromium，没有截图，没有中间 JPEG。4127 帧 / 1440×1080 / 60fps 出片 12.0 秒，约 **344 fps**，是实时的 5.7 倍。

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

node render.mjs --kit paper   --params kits/paper/presets/v8t.json --out out/paper.mp4
node render.mjs --kit science --params kits/science/template/presets/demo.json --audio assets/audio/audio-v8t.m4a --out out/science.mp4
node kits/desk/render.mjs --params content/demo.json --audio assets/audio/audio-desktop.m4a --out out/desk.mp4 --fps 60
```

## 两种用法

人用 CLI，agent 用 API。**API 是唯一实现，CLI 是它的一个宿主。**

```bash
node api/cli.mjs capabilities            # 五支版式：id / 画幅 / 帧率 / 内容模型 / schema 状态
node api/cli.mjs describe --kit science  # 单支详情，含完整 params schema
node api/cli.mjs validate --kit paper --preset v8t     # 只校验，不出片
node api/cli.mjs render   --kit paper --preset v8t --json
```

```bash
# agent 首选：JSON in / JSON out
echo '{"kit":"paper","preset":"v8t"}' | node api/cli.mjs render --stdin --json
```

长片或调用方可能断线时用异步：`render --async` 拿 jobId，`status --id <id>` 轮询，
`jobs` 列出最近任务，`cancel --id <id>` 终止。job 状态落在 `out/jobs/`，跨进程可查。

回执里的帧数、时长、分辨率一律由 ffprobe 读产物得出，**不是渲染器的自述计划值**；
错误带 `code` / `hint` / `fix`，调用方能据此自行纠正。契约细节见 [`docs/API.md`](docs/API.md)。

新增一支版式只需在 `api/kits/` 声明 `capability` 与 `adapter`，CLI、能力清单、
冒烟全部自动跟上——不需要改 API 层。

## 五套版式

| 代号 | 中文 | 画幅 | 入口 | 说明 |
|---|---|---|---|---|
| `paper` | 纸感 | 1920×1080 | `render.mjs --kit paper` | 从 paper-perspective 成片逐像素反推的 8 个版式 |
| `science` | 科普 | 1920×1080 | `render.mjs --kit science` | 自建，9 版式，讲解位 37% / 图解释意 33% |
| `desk` | 桌面 | 1440×1080@60 | `kits/desk/render.mjs` | 整台 Mac 桌面 + 16 个版式镜头 + 素材镜头 |
| `editorial` | 杂志 | 1920×1080 | `kits/editorial/canvas-editorial.mjs` | 8 段分镜，改造自 MIT 项目 |
| `mg` | 通用 | 1920×1080 | `kits/mg/render.mjs` | 5 类镜头的动效验证（2026-11-10 后未改动） |

五者共用同一个渲染库，所以**换版式不换速度档**。

> `desk` / `editorial` / `mg` 仍各有自己的 `render.mjs`，但**管道已不再重复**：
> 「分片 → ffmpeg → concat → 音轨」收进了 `src/pipeline.mjs`，三个入口只剩渲染器构造与画幅参数
> （`mg` 136 → 108 行、`desk` 165 → 141 行、根入口 225 → 214 行）。
> 抽取前后用同片同参逐帧比对：MAE 0.000、差异像素 0、体积与帧数一致。
>
> 合并还暴露了一处真实漂移：`mg` 的无音轨分支带 `-movflags +faststart`，另两支漏了 ——
> 同一仓库对同一件事有两种做法，分散时没人发现。已统一，现在所有 mp4 的 moov 都在文件头。
> （`paper` / `desk` 因补了 faststart 而哈希变化，但 PSNR 为 `y:inf u:inf v:inf`，画面逐像素一致。）
>
> `editorial` 例外——它自带 `render-cache` 与两套 worker 路径，结构与前三套不同，
> 强行合并会引入抽象泄漏，先留着。

## 自己加一套版式

`templates/_scaffold/` 是一支**能跑**的骨架：`kit.js`（绘制原语）+ `layouts.js`（版式）+
`stage.js`（时间轴/字幕/角标/淡出，宿主无关）三件套齐全，带五层结构说明与两个校验脚本。

```bash
uv run python tools/new-template.py --id my-template --title "我的版式"   # 生成 + 自检
node render.mjs --kit my-template \
  --params templates/own/my-template/presets/default.json --out out/my.mp4  # Skia 直出
uv run python tools/check-template.py --src templates/own/my-template        # 随时体检
```

三件套齐全的模板**不需要进 `kits/`**：`--kit` 先查内置适配器，再按 `templates/own/<名字>/src`
找三件套，都能直出。同一份 `src/` 也能走浏览器宿主（`tools/motion-render.mjs`），
双宿主逐帧比对的 MAE 由 `stage.js` 单点编排保证——编排只写一份，不在两个宿主里各写一遍。

`.motion` 的哪些设计被吸收（三文件三读者、`ifMissing` 写进数据、容量跟版式走）、
哪些是我们补的（`pitfalls[]`、Skia 宿主声明、实测字高下限）见 `templates/_scaffold/README.md`。


## 目录

四类边界：**引擎 / 版式 / 内容 / 素材**。改哪一层，影响范围是可预测的。

| 目录 | 装什么 | 改它会影响 |
|---|---|---|
| `api/` | **契约层**：能力清单、参数校验、统一回执、五支 adapter | agent 的全部调用面 |
| `render.mjs` | 主 CLI，按 `--kit` 分发 | 全部版式 |
| `src/` | 引擎：仓库根探测、字体注册、门禁、参数校验、计时账本 | 全部版式 |
| `kits/` | 五套版式，每支自治（渲染器 + 参数 schema + presets） | 只影响自己 |
| `content/` | 分镜 JSON：文案、镜头、素材引用、配音对齐 | 不动代码 |
| `assets/` | 字体（Noto Sans SC 三档）、配音 m4a、字幕 srt、图片 | 全部版式 |
| `templates/` | MotionGit `.motion` 格式模板 + 四级接入索引 | 模板格式 |
| `tools/` | 打包、校验、测量、`smoke.sh` | — |
| `bench/` | 性能基准，含浏览器档与对照档的实测 | — |
| `docs/` | 设计决策、实测记录、历史归档 | — |
| `refs/` | **不入库**：vendor 模板（含账户 Key）、复刻工程、官方参考片 | — |
| `out/` | 产物，可整体删除 | — |

### 为什么这么分

2026-11-13 之前，所有东西都在 `motiongit-lab/` 一个目录里：引擎在 `skia-kit/`（156K），
产物 842M，参考素材 200M+，两套模板体系混在 `templates/` 下。重构后边界才立起来：

1. **引擎与版式分开**：原先 `mg` / `editorial` 要从 `../skia-kit/paper.mjs` 借 `registerFonts`，
   版式之间产生了一条假依赖。现在字体注册在 `src/fonts.mjs`，依赖方向单向：`kits/* → src/*`。
2. **仓库根不再靠 `dirname(..)` 猜**：四个 kit 原先各自算 `ROOT = dirname(..)`，深度一变就全错。
   现在统一向上找 `.git`，见 `src/root.mjs`。搬家不再需要改任何路径计算。
3. **产物与素材出仓**：`out/` 可整体删；`refs/` 整目录不入库（含不可外发的个人下载包）。
   `.gitignore` 按身份特征匹配而不是路径枚举——旧规则全是 `motiongit-lab/xxx` 硬编码，
   一搬家就整体失效，而其中一条正保护着 vendor 模板里的账户 Key。

## 交付门禁

```bash
node src/gate.mjs out/film.mp4          # 单支
node src/gate.mjs out/*.mp4 --html report.html
```

只拦**交付完整性**：帧数与时长×fps 的偏差、音画时长差、空帧 ≤8%、黑帧 ≤3%。
不拦 hook（前 2 秒运动）、平均亮度、重复帧——这三项在本仓 19 支成片上是连续分布，
照搬外部阈值会误杀 13/19，包括全部口播片。判据标定过程写在 `src/gate.mjs` 头部。

## 改完代码的回归

```bash
bash tools/smoke.sh      # 五套版式各出一帧，> 5KB 视为有效

# 单支模板四关：结构 → 单帧渲染 → 打包 → 包校验（骨架会自动实例化）
python3 tools/template-smoke.py --template kits/science/template
python3 tools/template-smoke.py --template templates/own/<名字>
```

语法检查抓不住路径错误——`import` 合法、运行时才 404。只有真渲染一帧才知道。

## 速度档

速度只由两个开关决定：**有无浏览器**（约 6×）、**中间帧压不压缩**（10–30%）。

| 档 | 构成 | 实测（1440×1080@60 / 8 worker） |
|---|---|---|
| 极速 | Skia 直出 + GPU 壁纸 + 裸帧 | 344 fps / 68.8s 片用 12.0s |
| 标准 | Skia 直出 + 静态壁纸 + 压缩帧 | 189–210 fps / 20–22s |
| 浏览器 | Chromium（film-kit 官方） | 55 fps / 75s |
| 对照 | Chromium（cinecode） | 24.6 fps / 168s |

fps 随片长上升（worker 预热与 ffmpeg 启动摊销），**比较速度必须同片**。

## 文档

| 想知道什么 | 看哪里 |
|---|---|
| agent 找文件 / 任务路由 / 改动纪律 | `docs/AGENTS.md` |
| 一条模板该停在哪一级（原版→换宿主→半蒸馏→全蒸馏） | `templates/README.md` |
| MotionGit 模板格式与前因后果 | `docs/MOTIONGIT-PLAYBOOK.md` |
| 科普版式的结构规律（37/33/10 是怎么来的） | `kits/science/template/SPEC.md` |
| 编码与并行优化实测 | `docs/编码优化-2026-11-13.md` |
| `.motion` 模板换宿主到 Skia 的可行性 | `docs/motion换宿主-2026-11-13.md` |
| 仓库体积治理记录 | `docs/仓库清理-*.md` |
