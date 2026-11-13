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

## 模板接入策略（2026-11-13 定稿，权威版在 `motiongit-lab/AGENTS.md` §1.1）

**一句话：先问用途，再问技术；默认 Chrome，别拿「换宿主」当性能手段。**

| 用途 | 走哪 | 成本 |
|---|---|---|
| 一次性出片 | Chrome | 0 |
| 短期反复（源码可读 + Canvas2D） | 换宿主 | 几小时 |
| 长期产线 | 半蒸馏（蒸**内容模型**，不是视觉代码） | 2–4 天；无源码反推 3–5 天 |

- **`protection` 不是门槛**，只决定方式：open 可换宿主；protected 只能 Chrome 或照片反推
  （蒸馏本来就是重写，源码只是参考；skia-kit 当年就反推过 paper-perspective）。
- 换宿主还需要引擎是 Canvas2D（有 `dom.js` / 非 canvas createElement 就不成立）。
- 速度只有两处能白拿：关模板审计、缓存重复绘制。多进程是最后手段，只对纯 JS 计算型模板有效
  （Chrome 多实例在重绘制场景几乎不扩展：native 8 实例 32.9 fps < 单实例 42 fps）。
- 已评估：`mac-desktop` 换宿主最优（480 fps / 24w）；`sketchnote` 可换但手绘单核 14 fps、
  要 12 worker 才划算（138.9 fps）；`camera-mode` 引擎 DOM；`paper-*`/`promo-ink` 源码加密。

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

## 命名约定：速度档优先（2026-11-13，用户两次反馈后定稿）

用户先要求「给这几种方案取个名字」，我按**画面风格**给了「桌面线/科普线/纸感线/杂志线/通用线」，
反馈**「还是看不懂」**；改按**技术栈**提名，用户又说**「或者按速度效率也行」**。
结论：**按速度分档最实用**——速度差 14 倍，可直接感知，且由明确的工程开关决定，不是主观感觉。
雅名（桌面线/纸感线）对工程师是负担：要先记「名字→目录」再记「目录→什么库」，多一跳。

定稿四段式：`速度档 / 模板 / 传帧 / 封装`，例 `极速档 / desk / raw / h264`。已写入 `AGENTS.md` §0。

**栈名 = Skia 直出**（四个档共用）。不用「很快」这类评价命名——「快」是结果，
换机器换片长就变；「直出」是机制，两个「直」各对应一个快因：
直出编码器（不经过浏览器，6×）、直出裸帧（不做中间 JPEG，10–30%）。
相对实时 **5.7×**（68.8s 片 11.98s 出完）。代价是放弃 HTML/CSS 通用性、
裸帧 8.8GB 过内存只在本地成立、GPU 壁纸依赖 `headless-gl` 原生模块。

| 速度档 | 代号 | 构成 | 实测（1440×1080@60 / 8 worker） |
|---|---|---|---|
| 极速档 | `fast` | Skia 直出 + GPU 壁纸 + 裸帧 | 344 fps / 同片 68.8s 用 12.0s |
| 标准档 | `std` | Skia 直出 + 静态壁纸 + 压缩帧 | 189–210 fps / 20–22s |
| 浏览器档 | `chrome` | Chromium（film-kit 官方） | 55 fps / 75s |
| 对照档 | `ref` | Chromium（cinecode） | 24.6 fps / 168s |

- **速度只由两个开关决定**：有无浏览器（约 6×）、中间帧压不压缩（10–30%）。
  壁纸走 GPU、编码选 H.265 对速度影响都 <5%（影响的是氛围与体积）。
- **fps 随片长上升**（worker 预热与 ffmpeg 启动摊销）：4127 帧 344 fps，1419 帧只有 195–210 fps。
  ⇒ **比较速度必须同片**，跨片比 fps 会误判。
- 模板五个（`desk`/`science`/`paper`/`editorial`/`mg`）用**同一个渲染库** `@napi-rs/canvas`（Skia），
  所以模板不改变速度档。`science` 额外支持浏览器宿主，是双跑能力，不是另一套栈。
- `film-kit` / `cinecode` 现在定位为**浏览器档与对照档的实例**；`templates/vendor/*` 仅作对照。
- 五支交付片是**同一组合** `极速档 / desk / raw / h264`，差别只在内容与素材。
- 命名只落文档层，**不改物理目录**。

### 一处事实纠正

上一版把 `editorial` 说成「走浏览器 canvas2d」是**错的**：`canvas-editorial.mjs` 实际 import
`@napi-rs/canvas`，全仓只有 `motion-render.mjs` 用 playwright（跑第三方 `.motion` 模板）。
我们的出片栈**只有一条**：Node + `@napi-rs/canvas`（Skia）+ 可选 `headless-gl` + ffmpeg。

## 仓库位置与结构（2026-11-13 04:23 重构后，权威版在根 `README.md`）

- **仓库根 = `~/Desktop/wb/cutduo`**。旧路径 `~/WorkBuddy/2026-11-08-21-08-09` 是指向它的软链。
- **`motiongit-lab/` 这一层已不存在**，拆为四类边界（依赖方向单向 `kits/* → src/*`）：
  `render.mjs`（主 CLI）/ `src/`（引擎）/ `kits/{paper,science,desk,editorial,mg}` / `content/` /
  `assets/{fonts,audio,captions,media}` / `templates/` / `tools/` / `bench/` / `docs/`；
  `refs/{vendor,replicas,reference}` 与 `out/` 整目录不入库。

## API 层（2026-11-13 04:40 起，agent api first）

- **`api/` 是唯一业务实现，CLI 只是宿主。** 六个动词：`capabilities / describe / validate / render / probe / gate`。
- 契约细节见 `docs/API.md`；能力清单 `api/capabilities.json` 由代码生成，**不要手改**。
- **回执规格只信 ffprobe 探测**，不解析 kit 的 stdout（自述是计划值，且五支格式不同）。
- **错误必带 `code` / `hint` / `fix`**；`validate` 永不抛，报错精确到 JSON Pointer。
- **`overrides` 白名单只放渲染超参**，内容必须走 `params`；白名单在 `api/contract.mjs` 硬编码。
- `editorial` / `mg` 无 `params.schema.json` → `schemaStatus: 'missing'`，回执 `unvalidated: true`。
  补 schema 后自动纳入校验，不需要改 API。
- 新增一支版式：写 `api/kits/<name>.mjs`（导出 `capability` + `adapter`），
  在 `api/registry.mjs` 的 `MODULES` 加一行。CLI / 清单 / 冒烟自动跟上。
- **`tools/smoke.sh` 现在同时验 CLI 与 API**：五支 CLI 探针 + 五支 `api.probe` + capabilities 枚举 + job 状态机。
- **异步 job（`api/jobs.mjs`）**：`submitJob / jobStatus / listJobs / cancelJob`，状态落 `out/jobs/`。
  三条硬约束：① 一 job 一独立进程（detached），不用线程；② **判定终态先读 stdout，不看 pid**
  （pid 会复用，曾导致已完成的 job 永久卡 running）；③ `elapsedSeconds` 取 stdout 的 mtime，不是判定时刻。
- **并发上限 `MAX_JOBS = clamp(1..4, cpus/8)`**（30 核 = 3，`CUTDUO_MAX_JOBS` 可覆盖），
  超出**排队而非拒绝**。⚠️ 代价：**`status()` 不是纯查询**，它在 lazy scheduling 里补位拉队首。
  实测 3 个 mg 并行各 12s vs 单独 7s ⇒ 并发几乎无吞吐收益（每支已吃满 8 worker），排队是保护。
- **五支 schema 全 complete**，但只约束 `scenes[].type/t0/t1` 骨架与少量全局字段，
  **不设 `additionalProperties:false`、不校验 `args` 内部**——各版式 args 形态不同，锁死必误杀历史参数。
- **仓库根只能从 `src/root.mjs` 取**（向上找 `.git`）。禁止再写 `ROOT = dirname(..)`——
  各 kit 深度不同（render.mjs 在根、desk/mg 在 kits/<name>/），一搬家必错。
- **字体注册只有 `src/fonts.mjs`**；`kits/paper/paper.mjs` 仅 re-export。
- **`.gitignore` 按身份特征匹配，禁止改回路径枚举**（`**/core.enc`、`**/template.motion`、`/refs/`、`**/*_raw.png`）。
  旧规则全是 `motiongit-lab/xxx`，搬家后 7 条静默失效，其中一条保护 vendor 的账户 Key。
- **改路径必须跑 `bash tools/smoke.sh`**（五支各出一帧，>5KB）。`node --check` 抓不住 404。
- 探针写法：`--probe <file.png> --at <秒>`；`--probe --at 5` 会把 `--at` 当文件名。

## 半蒸馏：两个实例与选型判据（2026-11-13）

`templates/own/` 下有两支半蒸馏产物，**蒸的不是同一种东西**：

| | sketchnote | chalkboard |
|---|---|---|
| 上游 | knowledge-explainer-sketchnote v2.7.4 | knowledge-explainer-chalkboard v2.7.4 |
| 内容模型 | 4 类 mechanism **枚举**（版式型） | 8 类 mechanism + **几何式子**（机制型） |
| 蒸的核心 | 字段契约 / 容量 / 内容族划分 | 轨道参数化 / 受光比例 / 本影锥 / 圆面重叠 / 光路求交 |
| 渲染难点 | 手绘抖动（视觉） | 几何正确性（数学） |
| 实测 | 720 帧 1.9s | 1020 帧 6.1s（167 fps）、配音 919 帧 6.2s |

**判据**：先看上游是「版式枚举」还是「机制参数」。前者的价值在 schema 与容量，后者的价值在式子；
后者**不该走换宿主**——若上游把原片写成手写章节脚本（chalkboard 是 30KB `chapters/*.js`），
换宿主只能复现那一支片，换不了「讲新内容」。

**不蒸的部分要写清楚**：chalkboard 的上游 70% 体积是 13 类通用图示（383KB+803KB）与 102 图标
（102KB+187KB），这两块明确不蒸——`science` 已有同类能力，蒸了是重复建设。

## 模板 schema 的形态要求（2026-11-13，工具硬约束）

`tools/check-template.py` **只认** `segments.items.properties`（或 `.args.properties`），不展开 `oneOf`。
多机制模板（如 chalkboard 8 支）必须写成「**并集 properties + 判别 oneOf**」：

```json
"items": { "properties": { …全部字段的并集… },
           "oneOf": [ { "properties": {"type":{"const":"orbit-phase"}}, "required":[…] }, … ] }
```

否则报「未声明 N 个版式参数」。另外 `guide.layouts[].args` 的键名不能带点——
`labels.actual` 会被当成一个独立参数，要写进 `labels` 的说明里。

## 半蒸馏 cute-mv（2026-11-13，第三个半蒸馏实例）

`templates/own/cute-mv/`：33s / 9 镜头 / 1920×1080@30，零素材（人物与场景全矢量）。
上游 `cute-character-lyric-mv v1.0.1` 是 Remotion 4 工程，外层却是 `personal-download-v1`，
真源码在内层 `content/release.bin`；只有 ~30KB（9 个渐变背景 + 一个挥手 chibi），
**值钱的是内容模型**：`lyrics/keywords/notes` 三字段（12/12/6 上限）+ 9 镜头时长 + 三类文字排版数值。

- 实测：990 帧 / 8 worker **5.2–5.9s ≈170–190 fps**，5.5MB，gate PASS；包 39KB / 17 文件。
- 字体：`ZCOOL KuaiLe` + `LXGW WenKai`（OFL，不进包），走新加的 `registerHandFonts()` 与 `__FAM` 注入。
- **四个必踩坑**：手举过 `y<-380` 时手臂要先画（否则穿脸）；伞面钉在头顶、杆斜到手；
  淡入最高 86%（首帧纯黑 = 门禁黑帧 3.03%）；`content` 必须在 render.mjs 里显式透传。
- `tools/check-template.py` 只认 `segments`，不认 `scenes`；`guide.layouts[].args` 的键要能对上 schema。

## collage（第七支 · 半蒸馏 motiongit-promo-main，2026-11-13）

- **路线判据**：`content/release.bin` 里 `protected/core.enc` + 152 个 `.enc` ⇒ 换宿主不成立；
  `guide.json` / `copy-contract.json` / `params.schema.json` 明文 ⇒ 半蒸馏成立。
- **内容模型硬规律**：11 段原长 hero 4.5 / recipe 6.5 / open 3.5 / pack 6.5 / flow 10 / adapt 4 /
  reuse 5.5 / spec 4 / share 4 / finale 4 / end 4.5 = **57.0s**；229 文字槽；14 素材载体。
  **场景表只能读 guide.json**——ffmpeg scene 检测对本片只报 2 个切点（转场是软过渡）。
- **实测**：3420 帧 / 1920×1080@60 / **10.2–10.3s（332 fps）** / 3.85MB / gate PASS。
  上游自述 2.7 帧/秒 ⇒ 约 123×，但这是「实测 vs 自述」，**不是同机 A/B**。
- **hero 字标包围盒逐像素对齐**（453–1509/290–506 vs 参考 454–1509/290–506）。
  做法：`272px MonaSans-Black` + **横向 6% 拉伸**（参考片宽高比 4.88，常规 4.62、Expanded 5.63）。
- **三条会静默失效的坑**：① `createLinearGradient` 不 addColorStop → Skia 不画任何像素且不报错；
  ② 全息条带必须离屏 + `source-atop`，否则从字缝漏出/染白背景；③ 静态背景必须缓存
  （4 次全屏渐变占单帧 60%，缓存后 17.7s→10.3s）。
- **已知差距**：作品墙 12 格是程序化缩略图（非真实截图）；无音效/配乐；字体为同源近似。


## 字体是构建依赖，不是源码（2026-11-13 定稿）

- **`assets/fonts/.gitignore` = `*` + `!.gitignore`**，19 个文件约 34MB 一律不入库，
  由 `bash tools/fetch-fonts.sh` 保证可复现（`--verify` 只校验）。
- **中间态是最坏的**：旧规则只忽略 `*.otf`，`.ttf` 变成「没入库也没被忽略」，
  `git status` 一屏 untracked，而服务器有没有字体取决于打包那台机器碰巧留了什么。
- **校验分两档**：Google Fonts 那几支（无版本号、`@main` 漂移）→ sha256 硬校验；
  有 tag 的（LXGW v1.510 / Mona Sans v1.0.1 / JetBrains v2.304）→ 锁 tag + 字体魔数 + 体积下限。
- **旧 `fetch-fonts.sh` 有路径 bug**：`dirname "$0"/assets/fonts` 会落到 `tools/assets/fonts/`，
  下载成功但下到错地方。已修 `dirname/..`。
- **判字体是否生效用测宽，不靠肉眼**：同一串中文在真字体/不存在族名下宽度相同 = 静默回退。
  缺字体时 Skia 不报错，只是退化（LongCang→PingFang，黑板感消失）。

## 字体注册表的分组口径（2026-11-13）

`src/fonts.mjs`：`BASE_FONTS`(Noto 三档) + `TEMPLATE_FONTS.{chalkboard, hand, collage}`，
`HAND_FONTS` 指向 `TEMPLATE_FONTS.hand` **同一个对象**。
早先 `FONT_FILES` 与 `HAND_FONTS` 各列一遍 LXGW——调字体要改两处，漏一处就静默不一致。
新增模板字体加到 `TEMPLATE_FONTS.<模板名>`，不要往 `FONT_FILES` 平铺。

## 字体校验必须是字节级（2026-11-13 彻底修复后）

- **`fetch-fonts.sh` 19 个文件全部 sha256 硬校验**，取消「只锁 tag」例外。
  教训：Mona Sans 路径写成 `@v1.0.1/fonts/ttf`，那目录的文件体积只有磁盘的一半
  （67416 vs 148164），脚本「成功」下到另一个版本字形，`--verify` 永远 ✓。
  正确坐标是 `@v2.0.27/fonts/static/ttf`，用 GitHub trees API 逐个体积核对过。
- **`curl --retry` 不重试「传到一半断了」**（`Recv failure: Connection reset by peer`），
  必须加 `--retry-all-errors --retry-connrefused`。`google/fonts` 这类巨型仓库走
  jsDelivr `@main` 尤其容易断，配 jsDelivr → raw.githubusercontent → fastly 三源回退。
- **字节对 ≠ 能用**：另有 `node tools/check-fonts.mjs`，三重判据
  （`GlobalFonts.has` / `measureText` ≠ 回退基准 / 模板 FACE 声明的族名都在注册表）。
  族名要从 CSS font-family 列表**按逗号拆**，整串正则会漏掉第一个。
- LXGW WenKai 统一到 **v1.510**（19.3MB，原 24.7MB 来源不明且锁不住）；常用字无缺。

## 音频：能力有，资产没有，增强排期在「后续」（2026-11-13 定）

- **已实现**：`src/audio-mix.mjs` 事件轨（cues → adelay / amix / sidechain ducking / apad+atrim），
  内置合成音 whoosh/tick/impact/rise，`mode` 三态，`--audio` 优先于 `params.audio`。
- **上游那 33 个音效拿不到**，五层断点：① 发行时物理删除（`audio-content-boundary.removed` 34 条）
  ② `retained.sfx.wav` 有名无实 ③ 事件表在 `protected/core.enc` ④ 我方无事件轨（已补）
  ⑤ 官方 API `sfx.search`/`sfx.generate` 双双 disabled（前者 `configured=false`）。
  原始素材是 **CC0**（被删清单里有 `LICENSE-ASSETS-CC0.txt`），所以不是版权墙，是发行+通路。
- **后续增强四件事（按收益）**：① cue 改场景相对时间（加 hold 后绝对秒会错位，最易踩）
  ② loudnorm 到 -16 LUFS（现片 -27）③ 真实 CC0 配乐/音效 ④ 放开 pipeline 的 `-ac 1` 才有立体声。
- 细节见 `kits/collage/README.md` §8.5。

