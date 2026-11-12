# MEMORY.md — 本项目长期约定

## 评估外部产线 / 工具的固定做法（2026-11-10 用户指定）

- **凡评价 cinecode（clinecode-kit）与本仓 motion-kit / skia-kit 的快慢，必须用同一条口播片实测，不接受体感判断。**
  - 基准做法：取同一份 `inputs-v4.json`（8 版式 / 37.146s / 24fps）+ 同一条 `audio-v4.m4a`，
    只换渲染引擎；cinecode 侧只需出画面，音轨用同一条 mux 上去。
  - 判据三条：出片墙钟时间、渲染吞吐（fps）、文件体积与重复帧数。
- **实测结论（2026-11-10，892 帧 / 1920×1080 / 24fps）**
  | 管线 | 出片 | 吞吐 | 体积 | 重复帧 |
  |---|---|---|---|---|
  | skia-kit（8 worker, Skia 直出） | 2.3s | 388 fps | 2.20MB | 19 |
  | cinecode（8 worker, 无头 Chrome） | 15.8s | 56.5 fps | 6.15MB | 0 |
  ⇒ **cinecode 慢 6.9 倍、体积大 2.8 倍**。体感"更快"来自省掉 params JSON 与对话式改稿，
    不来自渲染。
- **cinecode 的门禁阈值不可直接移植，先标定**：
  - `qc.py hook`（前 2s mean≥0.5）：skia-kit 0.22、cinecode 0.34，两者皆 FAIL ⇒ 该阈值编码的是
    短视频"开场强运动"，与口播静态标题冲突。
  - 手机可读性：横屏 1920×1080 要求字高 40px，而 skia-kit 字幕为 34px ⇒ 会把自家片判不合格。
  - 结论：搬**判据维度**（亮度 L* 下限 / 分横竖的最小字高 / 开场运动），阈值用现有成片分位标定。

## 交付门禁的标定结果（2026-11-10，已落地为 `skia-kit/gate.mjs`）

在 19 支既有成片 + 3 支新片上实测，三项"看起来像门禁"的指标其实是连续分布，不是对错：

| 指标 | 实测范围 | p50 | 照搬 cinecode 阈值的后果 |
|---|---|---|---|
| hook（前 2s 运动） | 0.06–5.29 | 0.31 | 0.5 会误杀 13/19，含全部口播 |
| 平均 L* | 0.40–91.3 | 64.5 | 亮度下限会误杀三支深色模板复刻 |
| 重复帧 | 0–36.8% | 0.03 | 版式停留是设计，不是缺陷 |

**能当门禁的只有交付完整性**（阈值 = 实测最大值 + 余量）：
- 空帧（YMAX−YMIN<40）≤ 8%（实测最大 5.26）
- 黑帧（YMAX<24）≤ 3%（最大 1.75）
- 帧数与 duration×fps 差 ≤ 1；音画时长差 ≤ 0.10s
- 无音轨只告警，`--require-audio` 才判失败（8 支复刻片是无声素材）

**只报不拦**：hook（告警线 0.10 = p10）、首帧亮度（参考片淡入正常）、dup%、Y。
负向自检：插 2s 黑场 → "黑帧 5% > 3%" FAIL；音轨截短 3.17s → FAIL；健康片 PASS。
`node skia-kit/verify.mjs` 仍全 PASS——未改动该文件，门禁是独立入口。

## film-kit（mac-desktop / camera-mode）可以直跑（2026-11-10 实测，更正旧结论）

- **旧结论「film-kit 渲染不可达 / 入口崩溃」作废**。真因是浏览器：本机 Chrome 自带 sandbox
  起不来（`sandbox initialization failed: Operation not permitted`）→ GPU 进程连崩 → FATAL，
  上层只报 `BROWSER_CLOSED` + crashpad 噪声。
- **两条驱动路径必须分清**：
  - 随包 `assistant/motion.mjs run ...`：有自带 Chrome Driver，**不认** `MOTION_BROWSER`，必挂。
  - 模板 `runtime/entry.mjs`（包内 `content/release.bin` 是普通 zip，`protection: open`）：
    `findBrowser()` **认** `MOTION_BROWSER`。用 `~/.local/bin/mg-chrome` 包一层 `--no-sandbox` 即通。
- 实测（1440×1080 / 60fps / 46.98s）：**2819 帧 / 51s ≈ 55 fps**，24.4MB，内置 check 全过。
  量级上比自建 Skia（2.3s）仍慢 22 倍，比 paper-perspective（89s）快 1.7 倍。
- 配乐 `api music-prepare` 是 **0 积分**（CC0 曲目 + 按目标时长裁剪），不要为此去调付费 TTS/生图。
- 完整复盘见 `motiongit-lab/MOTIONGIT-PLAYBOOK.md` §41；成片 `out/mac-desktop-rc2-v1.mp4`。

## 同一支片三条管线的固定对照口径（2026-11-10）

同一口播 46.386s / 8 段结构，只换渲染器（1440 或 1920 宽、60fps、2783–2819 帧）：

| 管线 | 有效出片 | 吞吐 | 体积 |
|---|---|---|---|
| film-kit 官方 mac-desktop | 51s | 55 fps | 24.4MB |
| skia-kit | **6.8s** | 409 fps | 3.26MB |
| cinecode | 113.3s | 24.6 fps | 6.13MB |

- cinecode 必须 `--flags "--no-sandbox"`，且 PATH 要有 `/opt/homebrew/bin`（它 spawn ffmpeg）。
- **capture.mjs 写完 video 后不退出**，墙钟会比日志多 5 分钟量级；报数分开记（有效渲染 vs 墙钟）。
- 三条都能过 `skia-kit/gate.mjs`；cinecode 自带的 40px 字高与 hook 0.5 阈值仍不可移植。

## 科普片模板（science-explainer，2026-11-12）

- **结构是硬规律**：讲解位 37% / 图解释意 33% / 标签强调 10% / 阵列 6% / 对比 4% / 首尾 10%；
  切点中位 **2.75s**，跟句子走不跟动作走。详见 `templates/science-explainer/SPEC.md`。
- 位置：`templates/science-explainer/`（源）+ `templates/workbuddy-science-explainer.motion`（40KB 包）；
  成片 `out/science-explainer-demo.mp4` 54.5s / 1635 帧 / 10.15s 渲染（161 fps）/ gate PASS。
- **三个必踩坑**：① `env.T` 必须是"完整调色板 + theme 覆盖"，只传 theme 会让 `T.white` 等 undefined；
  ② `MK.icon` 内部按 (x±size/2) 平移，外层已 translate 到中心时再传 cx/cy 会二次偏移飞出画面；
  ③ 硬切段首入场一律从 -0.1s 起、容器缩放下限 0.86，否则切点首帧是"缩成一点"甚至空帧。

## 科普模板的两条运行路径（2026-11-12 落地）

同一份 `templates/science-explainer/src/`（kit.js + layouts.js，纯 Canvas2D）有两个宿主：

| 路径 | 命令 | 字体 | 2215 帧 / 73.8s |
|---|---|---|---|
| canvas/Chrome | `node motion-render.mjs render --package . --style X --jobs 6` | 系统 PingFang | 14.37s / 154 fps |
| **Skia** | `node skia-kit/render.mjs --kit science --params X.json --workers 20` | 随包 Noto Sans SC | **11.3s / 196 fps** |

- **只快 20–27%，别照抄 paper-kit 的「6.9 倍」结论**：科普版式栅格化密集，@napi-rs/canvas 是
  CPU 光栅化，Chrome canvas2d 走 GPU，差距被吃掉。收益在零浏览器、内存 1.3GB、确定性。
- **字体必须按字号分流**，否则字幕糊死：`≥800 或 (≥700 且 ≥64px) → Black`，
  其余 700 → Medium + 保留原 heavy 描边（PingFang 原设计是 SemiBold+2.2px 膨胀）。
- **绘制调用是 Skia 记账，代价在 `canvas.data()` 结算**。单看 renderFrame 的 1ms 是假象，
  真实 10–16ms（封面 45ms）。有效优化只有并行度：6/8/12/16/20 worker → 132/141/172/186/192 fps。
- 改 kit.js 的三处注入（`__FONTS` / `__createCanvas` / heavy）都做了浏览器端零回归，
  同帧比对 MAE 0.00；以后动这两个文件先跑这个回归。

### 科普模板追加（2026-11-13 凌晨）

- **`enter()` 有 0.82 入场下限 → 永不返回 0**，所以 layouts.js 里 `if (k<=0) return` 是假门禁，
  想按 itemAt 逐项出现必须显式 `if (t < at) return`。tip 用 `ease()` 所以没这个问题。
- **音轨合成不能无脑 `-c:a copy`**：vo.py 产 wav，PCM 进 MP4 会让浏览器整轨静音；
  要探测 codec，非 aac 转 `aac 160k`。
- `build-template.py` 已排除 `_raw.*`；模板目录在 `templates/own/science-explainer`（会变动，
  science.mjs 用双路径探测）。

### 科普模板 · 人物层（2026-11-13）

- **Skia 侧必须自己喂姿态图**：`collectFigures()` 见到 `document === undefined` 直接 return，
  不补 `__MK_FIGS` 就静默退化成矢量人物（画面与浏览器不一致且不报错）。
- **位图姿态图比矢量人物快**：2369 帧 15.2s → 13.2s；canvas/Chrome 反而更慢（24.12s）。
- `figureHeight`：矢量 0.86 合适，3D 姿态图要 0.92–0.96。
- 手势 `open`/`point`/`explain` 由 preset 指定，`gestureAt` 默认 0.9s 淡入。

### 科普模板 · 字幕（2026-11-13）

- 62px 单行舒适上限 **26 字**；超了先按标点折行、字号降档（50 → 下限 44），不是一味缩字号。
- **判安全区用视觉顶端，不是基线**：中文字形在基线上方约 0.78em，用基线判会差 45px、顶到内容。
- 两行必须统一字号（逐行各套 maxW 会缩出两种大小）。

## 命名约定：产线与档位（2026-11-13，用户要求消歧）

用户原话「这几种方案取个名字，我现在分不清」。根因是**「方案」一词同时指了四层正交的事**。
约定：**「方案」只指产线**，其余三层统称「档位」。已写入 `motiongit-lab/AGENTS.md` §0。

- 产线（决定画面长相）：`desk` 桌面线（主力）/ `science` 科普线（浏览器+Skia 双宿主）/
  `paper` 纸感线（1920×1080@60）/ `editorial` 杂志线（浏览器 canvas2d）/
  `mg` 通用线（5 scene，2026-11-10 后未改动、无交付片）。
- 档位：壁纸 静态/流体/仿流体；传帧 裸帧/压缩帧；封装 兼容档 H.264 / 小型档 H.265 / 极窄档 AV1。
- 固定句式 `产线 · 壁纸 · 传帧 · 封装`，例 `桌面线 · 流体 · 裸帧 · 兼容档`。
- `film-kit`（官方原件 55fps）/ `cinecode`（三方 24.6fps）/ `vendor/*`（下载包）是**对照对象，不是产线**。
- 五支交付片（desktop-opt / ai-cut / nanjing / period / hotpot）是**同一组合的五个内容**，不是五套方案。
- 命名只在文档层，**不改物理目录**——路径稳定性优先于整齐。
