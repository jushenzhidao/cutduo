# desktop-kit · Mac Desktop 的 Skia 复刻

把 [motiongit.com/adunext/mac-desktop](https://motiongit.com/adunext/mac-desktop)（`film-kit/1`，
1440×1080 / 60fps / 230.02s / 55 镜头）的**视觉系统**用 `@napi-rs/canvas`（Skia）重写：
不用浏览器、不用模板受保护核心、不用 Playwright。桌面骨架 + 组件库 + 数据驱动的镜头，
一条命令出片。

> **为什么值得复刻**：原模板是 `film-kit/1`，实测 `preview` / `render` / `prepare` 全部崩在
> `entry.mjs:36 isAbsolute(undefined)`，标准 CLI 驱动不了（见 `MOTIONGIT-PLAYBOOK.md` §22）。
> 复刻之后，同一套视觉变成可脚本化、可批量、可增量改稿的产线。

> **分镜与代码分离（2026-11-12）**：内容分镜在 `motiongit-lab/content/`，本目录只放渲染器与工具。
> `desktop-kit/presets` 是指向 `../content` 的过渡软链，旧命令仍可用。

> **超参预设**：`profiles.json` 只留两档——`standard`（默认，4.72MB / 9.7s）与 `quality`（23.14MB / 16.0s）。
> 更小体积用 `--crf 25`，无 GPU 用 `--bg static`，H.265 用 `--codec libx265`。
> 实测依据 `docs/编码优化-2026-11-13.md`。

## 30 秒上手

```bash
# 首次：拉 Noto Sans SC 三个字重（与 skia-kit 共用 assets/fonts）
./fetch-fonts.sh

# 自检（几何 + 比色 + 动画活性）
node desktop-kit/verify.mjs                       # 11 项

# 出片：用 nominal 分镜
node desktop-kit/render.mjs --params content/demo.json --out out/desktop.mp4

# 出片：按真实配音时长重排（推荐）
uv run python desktop-kit/tools/build-voices.py --rate +8%
node desktop-kit/render.mjs \
  --params content/demo-voiced.json \
  --audio edits/audio-desktop.m4a \
  --presenter edits/assets/your-face.png \
  --out out/desktop.mp4 --fps 60
```

单帧探针（改版式时最快回路）：

```bash
node desktop-kit/render.mjs --params content/demo.json \
  --probe out/probe.png --at 12.5
```

## 换一条新片（已实测）

模板唯一的输入是一个 JSON。已用同一套组件做过**第二条完全不同主题**的片子
「用 uv 装 Python 环境」（12 镜头 / 12 句 / 52.117s），渲染器一行没改：

```bash
# 1) 写新分镜 content/uv.json（shots 与 captions 一一对应）
# 2) 配音 + 按真实语音时长重排；输出路径按文件名自动推导
uv run python desktop-kit/tools/build-voices.py --preset content/uv.json --rate +5%
# 3) 出片（--presenter 换自己的摄像头图/逐帧视频）
node desktop-kit/render.mjs --params content/uv-voiced.json \
  --audio edits/audio-uv.m4a --presenter edits/assets/avatar.png \
  --out out/desktop-uv.mp4 --fps 60
# 4) 全片抽帧总览（12 格，一眼看遮挡 / 空镜）
uv run --with pillow python desktop-kit/tools/contact.py \
  --video out/desktop-uv.mp4 --params content/uv-voiced.json \
  --out out/uv-contact.jpg
```

`build-voices.py` 不带参数时等价于首版 demo；带 `--preset` 时自动产出
`<stem>-voiced.json` 与 `edits/audio-<stem>.m4a`，临时目录按 stem 隔离，两条片可并行做。
还可用 `--out-params` / `--audio` 显式指定。

**第一次复用暴露的 4 处写死假设**（已修，见 `PLAYBOOK.md` §35.6）：
`build-voices.py` 输入输出文件名写死；5 字标题压到车次信息；`counter` 窗口被人物窗整块盖住；
`chart` 白窗口右缘压人物窗 40px。都是「demo 内容恰好不触发」的布局缺陷。

## 复刻的边界（先说清，避免误读）

**复刻的是视觉系统，不是 55 个镜头逐条搬运。** 官网镜头库有 55 种，本 kit 落地 16 个
可组合类型，覆盖其中约 30 种的视觉语义；其余依赖真实视频插入、粒子、3D 机车、碎裂物理
或复杂 shader，Skia 2D 重画不划算（判据见 `skia-kit/REPLICATION.md` §0）。

| 本 kit 类型 | 覆盖的官网镜头（视觉语义） |
|---|---|
| `title` | `title`, `stillBoard` 出发屏 |
| `talk` | `talk`（纯口播 + 通知） |
| `flipBoard` | `bigWords`, `wordFlip`, `halfFlip`, `sequence` |
| `comments` | `chatShot`, `comments` 卡片瀑布 |
| `rating` | `rating`, `contact` 评估卡 |
| `terminal` | `terminal`, `facts` |
| `counter` | `counter`, `milestone` |
| `station` | `sign`, `station`, `platform`, `gate` |
| `notify` | `notify`, `spotlight`, `correction` |
| `chart` | `wakeUp`, `seats` 趋势图 |
| `tickets` | `ticketInfo`, `ticket`, `wallet` |
| `ranking` | `ranking`, `overtake`, `opposite` |
| `chat` | `chatPlay`, `agents` |
| `files` | `files`, `folderCount`, `download` |
| `checklist` | `checklist`, `seats` 矩阵 |
| `outro` | `thanks`, `bye`, `replay` |

**明确未复刻**：`bigTrain` / `express` / `trainPass` / `smash` / `shock` / `smash` / `transfer`
（3D 机车、粒子、碎裂）、`phonePlay` / `showcase` / `bloggers` / `depart`（视频素材插入位）、
`smash` / `equal` / `fastClock` / `gate` 的复杂叠加层。扩展方式是在 `desktop.mjs` 的
`SHOTS` 里加一个函数并在 `SHOT_TYPES` 注册 —— 组件（窗口、翻牌、通知、光标、字幕）已经齐了。

## 量化标定（数据来自官方 demo 成片）

输入不是模板包，是**成片**：从 `media.openaicut.com/previews/talking-head/mac-desktop-demo-*.mp4`
按 8 秒间隔抽 29 帧（`ref/mac-desktop/frames/`），配色统计落在 `ref/mac-desktop/palette.json`。

| 项 | 参考片实测 | kit 值 | 偏差 |
|---|---|---|---|
| 菜单栏高 | 26px | 26px | 0 |
| Dock | 280,1000 / 880×74 | 同 | 0 |
| 人物摄像头窗口 | 940,200 / 378×568 | 同 | 0 |
| 桌面图标列中心 x | 1370 | 同 | 0 |
| 默认白窗口 | 40,140 / 895×760 | 同 | 0 |
| 中文字幕 baseline | 958 | 同 | 0 |
| 采样点比色（7 处） | — | — | 平均 **16.4 / 255**（容差 42） |
| 骨架锐度比（8 组对照） | — | — | 全画面 **0.90** / 壁纸区 **0.93** / 字幕区 **1.44** |

三套壁纸（蓝 / 浅灰 / 橙）用四色标径向渐变拟合；`#F5B321` 是翻牌数字与字幕强调色，
`#0E0F13` 是深色屏底，`#FBFBFB` 是白窗口。全部数值在 `tokens.json`，改设计请同步改
`verify.mjs` 的 `REF_GEO` 期望值。

## params 结构

```jsonc
{
  "fps": 60,
  "durationSeconds": 68.778,
  "brand": "desktop-kit · Skia",
  "chapters": [{ "name": "01 起站", "wall": "blue" }],
  "shots": [
    { "type": "rating", "t0": 11.2, "t1": 15.2, "chapter": "02 前靠站",
      "args": { "verdict": "一般", "filled": 2, "foot": "部分" } }
  ],
  "captions": [
    { "start": 11.3, "end": 15.2,
      "zh": "原来的模板很好看，但只发挥了*部分能力*。",
      "en": "The original was good, but only partly used." }
  ]
}
```

- `shots[].type` 必须是 16 种之一，未知类型 **硬失败**（不静默降级成 `talk`）。
- `chapter` 变化触发整屏翻牌转场；`wall` 决定壁纸与菜单栏明暗。
- `captions[].zh` 里的 `*词*` 渲染成黄色强调，中文逐字揭示，英文整句跟随。
- `args.presenterBox` 可覆盖人物窗位置；`args.noPresenter` 可临时隐藏；
  `args.cursor: {x,y,at,from}` 画点击光标。

完整字段约束见 `params.schema.json`。

## CLI

```
node desktop-kit/render.mjs --params <json> [--audio <m4a>] --out <mp4>
  [--fps 60] [--workers 8] [--crf 20] [--jpeg 94] [--preset veryfast]
  [--presenter <png|jpg|off>] [--probe <png> --at 2.5]
```

`--presenter` 给一张图会被 cover 裁进摄像头窗口；不给则画**程序化占位**
（刻意不用参考片里的作者肖像）。要逐帧真人出镜，把口播视频按帧抽出来交给渲染器即可
——这是素材接入问题，不是版式问题。

## 出片路径对比（5 条管线，同一分镜）

```bash
node desktop-kit/tools/render-bench.mjs --preset content/cmp-voiced.json \
  --bg static|gpu|js --pipe jpeg|raw --audio edits/audio-cmp.m4a \
  --workers 8 --out out/cmp-x.mp4 --json out/cmp-x.json
```

同一分镜 `content/cmp-voiced.json`（6 镜 / 3 章节 / 2 次翻牌转场 / 1419 帧 / 23.658s /
1440×1080@60 / 同一条音轨），只换管线：

| 变体 | 壁纸层 | 传帧 | 墙钟 | 吞吐 | 单帧绘制 | 单帧传帧 | 体积 |
|---|---|---|---|---|---|---|---|
| A | Skia 渐变 | JPEG q94 | 7.51s | 188.8 fps | 2.89 ms | **28.77 ms** | 3.76 MB |
| B | Skia 渐变 | RAW | 6.75s | 210.3 fps | 2.73 ms | 24.22 ms | 2.95 MB |
| C | GPU 流体 | JPEG q94 | 7.28s | 195.1 fps | 5.03 ms | 12.80 ms | 2.82 MB |
| D | JS 流体 | JPEG q94 | 40.23s | 35.3 fps | **175.42 ms** | 13.51 ms | 2.52 MB |
| E | GPU 流体 | RAW | 7.27s | 195.2 fps | 4.15 ms | 12.40 ms | 2.69 MB |

三条结论都由上表直接读出，不需要额外解释：

1. **传帧占 A 单帧预算的 91%**（28.77 / 31.66）。换成 RAW 后墙钟 −10%、体积 −22%，
   且以 `x264 -crf 0` 无损片为基准，Y-SSIM 从 0.9728 升到 0.9772 —— 少一次 JPEG 就是「更快 + 更小 + 更准」。
2. **GPU 壁纸层 2.2–3.0 ms，内置渐变只要 0.05–0.16 ms**：静态壁纸搬到 GPU 一定是亏的。
   它值钱的地方是 CPU 做不到的事 —— 同一段 fBm 流体，JS 逐像素 **163.94 ms**，GPU **3.02 ms**（54×）。
3. **体积由壁纸内容决定，不由引擎决定**：同样的 UI 与动作，壁纸从固定噪点换成低频流体，
   A 3.76 MB → D 2.52 MB。x264 的钱主要花在高频细节上（与 §7.2 的 29× 是同一机制）。

质量与编码蒸馏（`uv run python desktop-kit/tools/cmp-quality.py`）：

| 组合 | 比什么 | SSIM Y | PSNR |
|---|---|---|---|
| A ↔ B | 换传输 | 0.9473 | 41.52 dB |
| C ↔ D | 换引擎（同公式） | 0.9869 | 30.49 dB |
| A ↔ C | 换壁纸内容（本就不同） | 0.8843 | 30.27 dB |
| E ↔ C | 综合 vs 仅换引擎 | 0.9948 | 46.48 dB |

| 编码（源 = E 2.69MB） | 体积 | SSIM Y |
|---|---|---|
| H.264 crf20 | 2.17 MB | 0.9975 |
| **H.265 crf24** | **1.38 MB** | 0.9957 |
| VP9 crf34 | 1.41 MB | 0.9949 |
| AV1 svt crf32 | 1.89 MB | 0.9975 |

AV1 在本机体积反而比 H.265 大 —— 同一 CRF 不等于同一质量，跨编码器不能直接比 CRF。

**壁纸钩子**：`createDesktopRenderer({ ctx, wallpaper })` 可替换壁纸层（返回 `true` 表示已画完）。
GPU/JS 两种氛围层都实现在 `tools/bg-providers.mjs`，径向渐变按 canvas 的双圆心圆锥**解二次方程**
逐像素复刻，暗角与噪点层的混合系数经实测拟合，纯壁纸区与原版差 **< 0.5/255**。

## 自检（11 项）

```
字体注册 3 字重 · 骨架几何 13 项 · 采样点比色 7 处 · 安全区 2 项
翻牌入场 / 逐字字幕 / 章节转场 三处动画活性
16 个镜头各渲一帧 · 未知类型硬失败
```

`verify.mjs` 判的是「测得出来像」：几何容差 8px、比色平均通道差 ≤42、动画帧差有下限。
超差退出码 1。自检同时跑 nominal 与交付用的 voiced 分镜，避免「验的是渲染器、交付的是另一条时间轴」。

## 对抗审查（19 项，可复跑）

```bash
node desktop-kit/tools/adversarial.mjs
# → out/desktop-adversarial/report.html + evidence.json（evidence-before.json 是首轮基线）
```

判据基于**期望行为**而非当前行为，修复后同一脚本自动从 FAIL 转 PASS。
首轮 **8 FAIL** → 修复后 **0 FAIL**（17 PASS / 1 WARN / 1 INFO）。

| 攻击 | 首轮实测 | 修复 |
|---|---|---|
| A02–A06 非法 params（t1≤t0、chapter 拼错、时间轴重叠、duration 不符、字幕数不符） | 5 项静默接受，产出错误画面 | `validateParams()` 由 `setContent` 与 `loadParams` 共用，出片前硬失败 |
| A07 60 字字幕 | 字宽 1734px > 上限 1180px，边缘 332 个白像素 = **内容被裁** | 按安全宽度整体缩号，绝不裁字 |
| C05 自检与成片时间轴 | verify 12.5s 是 rating，成片该时刻是 comments | verify 加 voiced 时间点帧差断言 |
| D01 中文字形 | 手机截图小字 `'· 7人AI员工队伍'` 落在 mono 上 → 豆腐块 | 改 Noto + `safeFont()` 运行时兜底（动态中文日志同样受保护） |
| D03 授权扫描 | 审查脚本把自己当被审对象，敏感词必然自报 FAIL | 扫描排除自身 |

两处**判据自身的坑**也修了：A07 用绝对白像素会把固定种子噪点算成溢出（改与正常帧的差分对照）；
verify 的 voiced 帧差取在动画已稳定的镜头中点会得到 0.0（改「入场 vs 中段」）。

**刻意保留，不修**：
- `WARN C03`：全 talk 片（镜头动画 = 0）仍是 0 重复帧，QA 只因无音轨报 WARN ——
  Dock 律动让每帧都不同，「无重复帧」**不能**证明动画生效，必须靠 verify 的分区帧差断言。
- `INFO C04`：`--presenter` 是静态图，摄像头画面连续 10 帧平均差 **0.002/255**；
  参考片是逐帧真人视频。要逐帧出镜需把口播视频抽帧接入，属素材链路而非版式缺陷。

**并发写入提示**：审查期间工作区有另一路任务调整字幕字重并新增 `tools/video-compare.py`，
故修复后按磁盘上最终渲染器重出两条成片，保证证据与交付物同源。

**成片实测**（两条不同内容，同一套组件）：

```
out/desktop.mp4     4127 帧 / 68.783s / 1440×1080 / 11.69MB / 19.3s（8 worker）
                    QA: 0 黑帧 / 0 连续重复帧 / 音画 68.783 vs 68.778s
out/desktop-uv.mp4  3127 帧 / 52.117s / 1440×1080 / 10.15MB / 15.7s（8 worker）
                    QA: 0 黑帧 / 0 连续重复帧 / 带 --presenter 真人图
自检 11/11          8 组参考片对照：全画面锐度比 0.897 / 壁纸 0.927 / 字幕 1.444
对抗 19 项          17 PASS / 0 FAIL / 1 WARN / 1 INFO
```

锐度是分区测的，原因见下一节：参考片的壁纸有细纹理与视频压缩噪点，纯渐变会把
全画面平均值拉到 0.47；补固定种子噪点后回到 0.90，而字幕区 1.44 说明我们的
Noto Black 比参考片的苹方更硬——这是字体差异，不是「糊」。对照页
`out/desktop-compare.html` 逐组列出三个数字，不藏不利数据。

## 字幕墨色随壁纸明暗切换（2026-11-10 修）

参考片字幕在深色壁纸上（白字 + 黑描边）。同一套颜色搬到浅灰壁纸上实测只有
**1.26–1.53:1**（WCAG 正文需 4.5:1），属于「编码指标全绿、交付目标不成立」。
现在 `subtitles(t, dark)` 按章节壁纸切换：深底白字（9.2:1）、浅底深墨 `#14161A` + 白描边
（≈15:1），强调色在浅底由 `#FFC23C` 改 `#A85A00`。同一套 `onWall()` 也接给了**站牌副标题、
口播大字、排名小字**——它们同样是直接画在壁纸上的，浅底白字同样不可读（做南京片时暴露）。

## 照片镜头（photo，实拍素材）

```json
{ "type": "photo", "t0": 10, "t1": 15, "chapter": "02 城",
  "args": { "key": "xuanwu", "layout": "full", "title": "玄武湖", "fx": 0.5, "fy": 0.55 } }
```
素材在分镜顶层声明，出片时统一载入注入：
```json
"photos": { "xuanwu": "edits/assets/nanjing/p35022547.jpg" }
```

- **两种布局**：`full` 全屏铺底 + 慢推（1.05→1.12，Ken Burns）+ 底部压暗；`window` 相框卡片（520×700，contain，竖图不裁主体）。
- **明暗判定按「合成后的字幕区」**：`full` 布局恒叠底部 0.86 压暗渐变，字幕区必然是深色 → 白字；
  `window` 布局按章节壁纸明暗切换。早期版本按原素材像素判定（64×48 底部 40% 均值 <110 判深），
  实测亮锅面视频片段均值 139 会被误判成浅底深墨字。`args.autoDark: true` 可显式回退到实测判定，
  `args.dark: false` 留给将来不压暗的特殊镜头。
- **缺素材硬失败**：`photo "x" 没有注入素材`，不画空白（verify 有专门的负向断言）。
- **版权口径**：素材取自 Pexels（免费许可，可商用、无需署名）。仍保留画面角标与 preset 里的路径记录——「不需要署名」不等于「可以不留痕」。

## 视频片段镜头（clip，预抽帧播放）

```json
"clips": { "xuanwu": { "dir": "edits/assets/nanjing/clips/xuanwu", "fps": 20 } },
{ "type": "clip", "t0": 10, "t1": 13, "args": { "key": "xuanwu", "fps": 20, "title": "玄武湖" } }
```

渲染器**不内嵌解码器**：片段先用 ffmpeg 抽成帧序列（1280×720 / 20fps / 2.5s ≈ 50 帧），
出片时按 `floor((t - t0) × fps)` 取帧。这样渲染循环保持同步，不需要在 draw 里 await。

- **按区间加载**：每个 worker 只加载落在自己负责时间段内的片段。8 个进程全载会到 2.9GB；
  按区间过滤后只有覆盖该段的一两个进程加载（≈184MB）。
- **不叠加推镜**：`photo` 有 Ken Burns，`clip` 没有——画面本身在动，再推会晕。
- **时间码**：左上角 `00:02.15` + 红点，明确「这是素材不是静帧」。
- **明暗判定**同样按合成结果：全屏片段恒用白字（见「照片镜头」一节），不按原素材亮度。

抽帧命令（只解码需要的区间，不下载整条 4K）：
```bash
ffmpeg -ss 3 -t 2.5 -i <mp4-url> -vf "scale=1280:-2,fps=20" -q:v 3 <dir>/f%03d.jpg
```

## 与参考片已知差异（诚实清单）

1. **人物窗口**：参考是真人逐帧出镜；kit 默认是程序化占位（肖像权与授权边界）。
2. **整屏转场**：参考是整块 split-flap；kit 用 12 条竖带余弦压缩，观感接近但不等价。
3. **Dock / 桌面图标**：几何重绘，不是 SF Symbols 与真实 App 图标。
4. **壁纸**：四色标渐变 + 固定种子细噪点（每帧同一张，不闪、可复现）；未复刻参考片
   的织纹与光斑层级。噪点让编码体积从 5.5MB 涨到 11.7MB，是把锐度比从 0.47 拉回 0.90 的代价。
5. **菜单栏时间 / Dock 律动**：时间为固定值，Dock 用确定性正弦（参考片按音乐节拍驱动）。
6. **字幕揭示**：线性逐字，未接语音强制对齐（word timings）。
7. **无配乐与音效**：模板含节拍驱动律动与动效音，kit 只输出画面 + 旁白轨。

## 授权

模板内容受其许可保护（页面标注 Free / Personal use, no redistribution）。本 kit 是
**按公开成片逐像素反推的独立实现**，未复制模板包内受保护代码、素材、字体或人物肖像，
仅用于自有产线，不二次分发模板本身。参考帧留在 `ref/` 仅供本地校验，不随交付外发。

## 目录

```
desktop-kit/
  desktop.mjs          渲染器：骨架 + 组件 + 16 镜头
  render.mjs           出片 CLI（worker 并行 / 音轨封装 / 单帧探针）
  verify.mjs           11 项自检
  tokens.json          几何 + 配色规格（全部来自成片测量）
  params.schema.json   参数契约
  ../content/demo.json        nominal 分镜 A（讲 desktop-kit，16 镜头）
  ../content/demo-voiced.json 按真实配音重排（由 build-voices.py 生成）
  ../content/uv.json          nominal 分镜 B（讲 uv，12 镜头）
  ../content/uv-voiced.json   分镜 B 的音画同步版本
  ../content/cmp.json         nominal 对比分镜（12s，覆盖三面壁纸 + 2 次转场）
  ../content/cmp-voiced.json  对比分镜的音画同步版本（五条管线共用）
  ../content/ai-cut.json      内容分镜 C（AI 剪辑加速，12 镜）
  ../content/nanjing.json     内容分镜 D（南京城市介绍，13 镜）
  ../content/period.json      内容分镜 E（经期应对科普，13 镜）
  ../content/hotpot.json      内容分镜 F（吃火锅，13 镜 + 本人实拍 + 2 段视频）
  tools/build-voices.py   TTS + 逐句时长 + 音画重排（--preset 可换片）
  tools/compare.py        参考片 ↔ 复刻片 8 组分区锐度对照页
  tools/contact.py        按分镜中点抽帧拼全片总览
  tools/adversarial.mjs   19 项对抗套件（输入/确定性/交付/字形/授权）
  tools/render-bench.mjs  出片路径对比 CLI（--bg static|gpu|js × --pipe jpeg|raw）
  tools/bg-providers.mjs  GPU（headless-gl）与 JS 两套流体壁纸实现，同一公式
  tools/probe-bg.mjs      合成原语成本探针（putImageData / drawImage / fBm / readPixels）
  tools/cmp-quality.py    SSIM/PSNR 矩阵 + 四种编码蒸馏
  tools/cmp-contact.py    五管线同帧总览拼图
  tools/cmp-report.py     对比测试报告（读 JSON，不手填数字）
  tools/curve-desk.py     本模板三条真实运动曲线的系数蒸馏
  ../out/desktop-adversarial/report.html  对抗审查报告 + 首轮/修复后对照
  ../out/cmp-report.html  五管线对比测试报告
  README.md            你正在看的
```
