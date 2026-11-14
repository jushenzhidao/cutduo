# MEMORY.md — 本项目长期约定（2026-11-13 压缩版）

> 完整历史版：`MEMORY-archive-2026-11-13.md`（24KB，含被删的过程叙述）。
> 本文件只留**结论与数字**；过程性踩坑在各日 `YYYY-MM-DD.md`。

## 一、发版（2026-11-13 实测，`v0.2.2`）

- **运行结论 success ≠ 发布成功**。判发布是否成立要看**步骤级**结论：
  `v0.2.0`/`v0.2.1` 都出现过 run=success 而 `Build changelog`/`Create Release` 全 skipped
  —— tag 在、Release 零个、无任何告警。
- **根因**：两个 tag 的提交**正文**里写了跳过发版标记（CI 提交），而逃生阀判定跑在
  模式判定**之前**且匹配 `%B` 整条 message ⇒ 人工打 tag 被自动补丁的开关否决。
- **`release.yml` 已改（`b79468d`，+50/−21）**：① 先定 MODE，跳过标记只在 `MODE=auto` 生效；
  ② 补发旧 tag 时 `PREV` 锚定 `git tag … --merged "${TAG}^{commit}^"`（否则 range 反向，
  `git log` 空且不报错）；③ `mode=skip` 写 Summary + `::warning::`。
- **自身提交不能写标记字面量**，否则那次 push 自己就被跳过。
- 组织惯例：tag-only、0 资产、标题=tag 名；自动补丁 v0.x.**y+1**，契约变化才人工打 tag。
- **`image.yml` 已删（`30f7e97`）**：它构建 `context: renderd`，而该目录在 Skia 重构（`da0ea50`）
  就没了，产物 `ghcr.io/*/cutduo-renderd` 无任何消费方（MCP 是在 x86 服务器上原生构建）。
  按发版技能 §5「镜像先推、tag 后打」，真要有容器产物就并进 `release.yml` 在打 tag **之前**构建。
- 纯 CI / 纯文档提交用 `[skip release]`：实测 `30f7e97` job success 7s、零新 tag、Summary 带 warning。

## 二、速度口径（比较必须同片）

- **判据三条**：出片墙钟、渲染吞吐 fps、体积（+重复帧）。**同一支片、同一参数，只换引擎**。
- 同一口播 46.386s / 8 段 / 60fps：film-kit 51s·55fps·24.4MB｜skia-kit **6.8s·409fps·3.26MB**｜
  cinecode 113.3s·24.6fps·6.13MB。
- 1920×1080@24 / 892 帧：skia-kit 2.3s·388fps·2.20MB｜cinecode 15.8s·56.5fps·6.15MB
  ⇒ 慢 6.9×、体积 2.8×。体感"更快"来自省参数与对话式改稿，**不来自渲染**。
- **fps 随片长上升**（预热摊销）：4127 帧 344fps，1419 帧 195–210fps ⇒ 跨片比 fps 会误判。
- **速度只有两个开关**：有无浏览器（≈6×）、中间帧压不压缩（10–30%）。壁纸走 GPU、
  H.265 对速度影响 <5%。

## 三、速度档命名（2026-11-13 定稿，用户两次反馈后）

四段式 `速度档 / 模板 / 传帧 / 封装`，例 `极速档 / desk / raw / h264`（写进 `AGENTS.md` §0，
**只落文档层，不改物理目录**）。栈名 = **Skia 直出**（两个「直」= 直出编码器、直出裸帧）。

| 档 | 代号 | 构成 | 实测（1440×1080@60 / 8w） |
|---|---|---|---|
| 极速 | `fast` | Skia + GPU 壁纸 + 裸帧 | 344 fps（68.8s 片 12.0s） |
| 标准 | `std` | Skia + 静态壁纸 + 压缩帧 | 189–210 fps（20–22s） |
| 浏览器 | `chrome` | Chromium（film-kit） | 55 fps（75s） |
| 对照 | `ref` | Chromium（cinecode） | 24.6 fps（168s） |

- 五个模板 `desk/science/paper/editorial/mg` 共用 `@napi-rs/canvas`（Skia）⇒ **模板不改速度档**。
  `science` 额外支持浏览器宿主，是双跑能力。`film-kit`/`cinecode` = 浏览器档与对照档的实例。
- 事实纠正：`editorial` **不走浏览器**（`canvas-editorial.mjs` 直接 import `@napi-rs/canvas`）；
  全仓只有 `motion-render.mjs` 用 playwright（跑第三方 `.motion`）。

## 四、模板接入策略（权威版 `docs/AGENTS.md` §1.1）

**先问用途，再问技术；默认 Chrome，别拿换宿主当性能手段。**

| 用途 | 走哪 | 成本 |
|---|---|---|
| 一次性出片 | Chrome | 0 |
| 短期反复（源码可读 + Canvas2D） | 换宿主 | 几小时 |
| 长期产线 | 半蒸馏（蒸**内容模型**，非视觉代码） | 2–4 天；无源码反推 3–5 天 |

- `protection` 不是门槛：open 可换宿主，protected 只能 Chrome 或照片反推；换宿主还需引擎是 Canvas2D。
- 已评估：`mac-desktop` 最优（480fps/24w）；`sketchnote` 手绘单核 14fps、要 12 worker
  （138.9fps）；`camera-mode` 引擎 DOM；`paper-*`/`promo-ink` 源码加密。

## 五、交付门禁（`gate.mjs`，19 支旧片 + 3 支新片标定）

三项"看起来像门禁"的指标其实是连续分布：hook(前2s运动) 0.06–5.29/p50 0.31（0.5 会误杀 13/19）、
平均 L\* 0.40–91.3/p50 64.5、重复帧 0–36.8%。**只报不拦**。

**能当门禁的只有交付完整性**（阈值 = 实测最大 + 余量）：空帧 ≤8%（实测 5.26）、黑帧 ≤3%（1.75）、
帧数差 ≤1、音画时长差 ≤0.10s；无音轨只告警，`--require-audio` 才失败。
负向自检：插 2s 黑场→FAIL；音轨截短 3.17s→FAIL；健康片 PASS。

**2026-11-14 加三项内容层判据**（默认只报，显式开关才拦）：最长静止（26 支实测最长 8.5s、12 支 >3s
⇒ 上游「静止 ≤3s」在本仓不成立，告警线 **10s**、0 支触发）、OCR 回读（`--ocr/--expect`，容错匹配吃掉
OCR 单字误识）、BGM 铺底（`--bgm`）。**上游 BGM 互相关 ≥0.12 已证伪**：本仓有 BGM 仅 0.058/0.080、
无 0.048/0.024（差 0.03），平均音量也分不出；改判**旁白间隙**（有 BGM 0 段静音 / 无 20–22 段）。
两坑：`freezedetect` 冻到片尾只打 `freeze_start` 不打 `duration`（要按 片长−起点 补）；
`execFileSync` 只取 stdout，freezedetect 在 stderr 要用 `spawnSync`。

**字幕回读**（`--caption-check params.json`）：用 params.captions 与 OCR 的**字幕区**（y<0.3）比字符覆盖率，
<60% 报警。**只报不拦**——OCR 对逐字擦除动画的首字读不到（`一个班`→`个班`）。会自动把抽帧加密到 1s。
负向自检：替换一条字幕 → 报 11% 覆盖；正常片 0 告警。

**字幕阅读时间**（`--caption-check` 内）：一条至少停 `max(1.8s, 字数/5.5)`。规则取自
lemo-opuscar 的 `STYLE.md §4`（它写 `speech+0.6s`），但**必须去掉 +0.6**——本仓字幕与配音同步，
N 字就说 N/5.5 秒，"停留 ≥ 说话+0.6"数学上永远不成立（照搬 22/39 条全报）。去掉后报 5/39（真太快的）。
生成侧 `fit_captions`：放不下就合并最短相邻条、按**所需时长**加权分配（按字数分会让 6 字短句只拿 1.2s）。

**空镜**（`--blank`）：只取画面主体区（crop 掉底部 18% 字幕）缩到 240×105 灰度，逐秒算标准差。
三档实测：纯纸背景 **0–1.5** / 引文页 **18–20** / 常规图文 **56**。阈值 **12**、连续 **≥2s** 报警，
只报不拦。**freeze 抓不到这类问题**：paper 的画面变化量中位仅 0.29、p10 为 0（天然就静），
而真出问题的段落 0.11 与正常 0.3–4.8 同一量级，动作量上分不开。
负向自检：插 3s 纯纸背景 → 报「疑似空镜 1 处（38–41s，信息量 0.0）」；正常片零误报。
注意 `flat%` 只看全片比例（3s 空镜仅占 4.2%，8% 阈值不拦），补的正是"局部连续空镜"。

**响度**（`--loudness`）：口径 −16 LUFS ±2 / 真峰值 ≤ −0.5 dBTP。26 支里 11 支有音轨，走 loudnorm 的
5 支 **全部 −15.9**；未走的 −18~−31 只报不拦。ebur128 的 Summary 在 stderr、两段要跨行正则。

**台账对照**（`tools/facts-check.mjs` + `--facts/--require-facts`）：正向查「台账里的数字有没有真的上屏」，
反向列「屏幕上有、台账没有」的数字。**反向必须滤噪声**（时间码 / 分辨率 / 章节号），滤前 22 个滤后 11 个；
正向单个数字也算，反向要 strict（≥2 位或带 % / 小数点）。

## 六、film-kit（mac-desktop / camera-mode）可直跑

旧结论"渲染不可达"作废，真因是 Chrome sandbox 起不来（`Operation not permitted`）→ GPU 崩溃。
两条路径：随包 `assistant/motion.mjs` **不认** `MOTION_BROWSER`；模板 `runtime/entry.mjs`
**认**（`~/.local/bin/mg-chrome` 包 `--no-sandbox`）。实测 2819 帧/51s≈55fps。
`api music-prepare` 是 **0 积分**，别为此调付费 TTS。cinecode 需 `--flags "--no-sandbox"`，
PATH 要有 `/opt/homebrew/bin`；`capture.mjs` 写完 video 不退出（墙钟 vs 有效渲染分开记）。

- **science 版式与 paper 结构完全不同**（2026-11-14 实测）：段容器 `segments`（不是 scenes）、
  **只用 `dur` 累积**（无 t0/t1）、段型 cover/talk/diagram/matrix/focus/tip/outro、
  顶层还要 `theme`/`subtitle`/`fadeOutSeconds`。**不能复用 paper 的 build**，
  已写 `content/gut-antibiotic/build.py` 作为 science 专用构建脚本。
  图标只有 7 个（gut/hip-joint/drop/radiation/shield/check/clock）⇒ **选题必须由图标倒推**。
- **concat 会静默丢段**：edge-tts 的 24kHz mp3 与 44.1kHz wav 静音混拼，7 段+6 gap 应得 62.05s
  实际只拼出 60.55s（音画差 1.51s）。必须**先统一转 wav** 再 concat。
- **七、科普模板 `science`

- 结构硬规律：讲解位 37% / 图解释意 33% / 标签 10% / 阵列 6% / 对比 4% / 首尾 10%；
  切点中位 **2.75s**，跟句子不跟动作。
- 双宿主同源：Chrome 14.37s/154fps（PingFang）vs Skia 11.3s/196fps（Noto Sans SC）。
  **只快 20–27%**，别照抄 paper 的 6.9× —— 版式栅格化密集，CPU 光栅化吃掉差距；
  收益在零浏览器、内存 1.3GB、确定性。
- Skia 记账：单看 `renderFrame` 1ms 是假象，真实 10–16ms（封面 45ms），代价在 `canvas.data()`。
  唯一有效优化是并行度：6/8/12/16/20w → 132/141/172/186/192fps。
- 三个必踩坑：`env.T` 必须"完整调色板 + theme 覆盖"；`MK.icon` 外层已 translate 到中心时
  再传 cx/cy 会二次偏移；硬切段首入场从 −0.1s 起、容器缩放下限 0.86。
- `enter()` 有 0.82 下限 ⇒ **永不返回 0**，`if (k<=0) return` 是假门禁，要用 `if (t < at) return`。
- `vo.py` 的 `mouthCurve` 是**死数据**：写在 preset 顶层，而版式只拿 `scenes[].args` ⇒
  `layouts.js` 里 `a.mouthCurve` 恒 undefined，口型一直走 `mouthAt()` 的 11Hz 模拟。
  接通要同时改宿主（`science.mjs` 的 `renderFrame(t)` 不传帧号）。
- 圆盘里的插画别用方图直塞：方形裁切边会停在盘中央，读作"骨头断了"。
  用 `tools/circle-prop.mjs` 做圆形 alpha，配 `organSize: 765`（×0.92≈704=圆盘直径）把断口压到盘缘。

## 七点五、对抗审查自身也会错

- `adversarial.mjs` 曾用 `params.fps`（30）去切 60fps 帧序列 ⇒ 切点索引减半，8/8 切点报"重复帧"。
  已改为优先 ffprobe `r_frame_rate`。**60fps 出片后必须重跑**，否则会把假警报当缺陷查。
- 人物层：Skia 侧 `collectFigures()` 见 `document===undefined` 直接 return ⇒ 不补 `__MK_FIGS`
  会静默退化成矢量；位图姿态图更快（15.2→13.2s）；`figureHeight` 矢量 0.86 / 3D 0.92–0.96。
- 字幕：62px 单行上限 **26 字**，超了按标点折行 + 降档（50→下限 44）；安全区用**视觉顶端**
  （中文在基线上方 ~0.78em）；两行必须统一字号。
- 音轨：vo.py 产 wav，**不能 `-c:a copy`**（PCM 进 MP4 浏览器整轨静音），非 aac 转 `aac 160k`。

## 八、仓库结构（`~/Desktop/wb/cutduo`，旧路径是软链）

- **两套时间语义必须分开处理**（2026-11-14）：骨架 args（v8t）里的 `cards[][1]`/`at` 是**绝对秒**，
  用户在 script.json 的 screens 里写的是**段内相对秒**。merge 后无法区分，必须先各算各的：
  骨架按 `t − base.t0` 平移，用户 screens 直接 `+t`。混在一起会得出 71.72 这种远超段末的时间
  ⇒ 卡片永不出现 ⇒ 画面只剩字幕（实测 40–43s 空镜）。
- **`renderFrame` 在场景空隙里不能取 `scenes[末尾]`**：每两场景之间有 0.25s gap，取末尾会让
  **每个间隙闪一帧片尾卡**（实测 43.0s 闪出 outro）。应保持上一个已结束场景的末态。
- **`number` 段的 `from` 是数值起点不是时间**（2026-11-14）：时间白名单里若含 `from`，会被
  和 `at` 一起平移，`benford` 实测变成 `from=18.21`（应为 0）⇒ 数字从 18 滚到 30 而不是从 0 滚。
  白名单应为 `at|leftAt|rightAt|strikeAt|itemAt`。
- **配乐统用 `tools/audio-bed.mjs`**：`scenes` 与 `segments` 两种容器都认（后者用 dur 前缀和），
  三层曲风预设 electrohouse/chillwave/hiphop，各 4 层 loop，按段落包络进出。
  `content/<片>/bgm.mjs` 是 paper 专用的历史遗留，读 `scenes[i].t0`，别给 science 用。
- **写新片 args 前必读 `kits/<kit>/presets/*.json` 里该段型的真实结构**（2026-11-14 血泪）：
  按"看着合理"猜会一路崩到渲染函数，错误信息完全不指向病因。踩过的三类：
  ① `quote.lines` 是**字符串数组**（不是 `[[text,at],…]`）；② `compare.left/right` 是 `{title,items}`；
  ③ `hero.lines` 才是 `[[text,at],…]`。换段型时 build 脚本**不能继承骨架 args**（否则 at 变负数）。
- **跨版式喂参数会静默产废片**（2026-11-14 实测）：8 支版式的 params JSON 结构看着一样（brand/fps/
  durationSeconds/scenes/captions），但**渲染语义不同**。把 paper 的 params 喂 editorial，能跑完 6126 帧、
  gate 判 PASS，实际 22s 白屏、后半段卡死。根因：editorial 的 `switch(sc.type)` 有 `default: bg('paper')`
  ——不认识的段型画白纸。已改为抛错。**换版式要换参数，同一份 params 只在同一支渲染器内部通用。**
依赖方向单向 `kits/* → src/*`：`render.mjs`（主 CLI）· `src/`（引擎）·
`kits/{paper,science,desk,editorial,mg}` · `content/` · `assets/{fonts,audio,captions,media}` ·
`templates/`（own/vendor）· `tools/` · `bench/` · `docs/`；`refs/*` 与 `out/` 不入库。
`motiongit-lab/` 这一层已不存在。

## 九、API 层（`api/` 是唯一业务实现，CLI 只是宿主）

- 六动词 `capabilities / describe / validate / render / probe / gate`；契约见 `docs/API.md`；
  `api/capabilities.json` 由代码生成，**不要手改**。
- 回执规格**只信 ffprobe 探测**，不解析 kit stdout。错误必带 `code/hint/fix`；`validate` 永不抛。
- `overrides` 白名单只放渲染超参（`api/contract.mjs` 硬编码），内容必须走 `params`。
- 新增版式：写 `api/kits/<name>.mjs`（导 `capability`+`adapter`）+ 在 `api/registry.mjs` 加一行。
- 异步 job（`api/jobs.mjs`）：① 一 job 一独立进程（detached）；② **判终态先读 stdout 不看 pid**
  （pid 复用曾致 job 永久 running）；③ `elapsedSeconds` 取 stdout mtime。
- 并发 `MAX_JOBS = clamp(1..4, cpus/8)`，超出排队。⚠️ 并发几乎无收益（每支已吃满 8 worker）：
  3 个 mg 并行各 12s vs 单独 7s。**`status()` 不是纯查询**（lazy scheduling 会拉队首）。
- schema 只约束 `scenes[].type/t0/t1` 骨架，**不设 `additionalProperties:false`、不校验 `args` 内部**。
- 仓库根只能从 `src/root.mjs` 取（向上找 `.git`）；字体注册只有 `src/fonts.mjs`。
- **`paper` 的 11 种段型**（2026-11-14 加 grid/chart）：`grid` 点阵表达数量（`rows/cols/highlight/
  exception`，例外点跳出网格+2.2 倍半径+虚线牵引——换颜色或换方形都分不出）、`chart` 真图表
  （`line`/`bar`，轴先长再落点、跨零画虚线、bar 不画 x 数字）。**图表做成段型而非独立版式**：
  它是内容呈现方式，不是视觉语言。**注意 `chart` 段的 freeze 会被高估**（标记点占画面 0.02%）。
- **`paper.mjs` 的关键词卡兜底**（2026-11-14 修）：无人物图时退化「本章关键词」卡，`cast` 曾兜底到
  `String(sc.type)` ⇒ 屏幕上出现 `hero`/`comp are`。现为 `cast > title > label`，**不再退到 type**；
  内容侧要给每段 `args.cast`（2–6 字）。`steps` 是横排 5 步，字号必然偏小（v8t 同形），文案缩到 4–6 字。
- **`api/validate.mjs` 现在支持 `if/then/else`**（2026-11-14 补）：此前刻意不支持，导致 paper schema 里
  **9 组段型必填约束全失效**——缺 `value` 的 number 段能过 API、渲染成空白。if 用子校验判匹配，
  errors 不并入（否则刷噪音）。仍不支持 `$ref` / `format`。
- **API 校验面比渲染器严**：CLI 不校验 schema，API/MCP 校验 ⇒ 渲染器新加的开关不进 schema，
  就只有云端会挂。已踩：`snapToFrames`（vo.py 每份 .vo.json 必写）、`strikeFill`、`_note`
  ——前两个导致「任何配音片经 MCP 必被拒」。新增版式参数必须同时改 `guide.json` 并重跑
  `python3 tools/gen-schema.py --write`；顶层开关要手补进 `params.schema.json`（生成器只换 args）。
- MCP `cutduo_render` 已透传 `overrides`（crf/preset/pipe/theme）：`{"crf":15,"preset":"slow"}`
  实测 PSNR 50.70 vs 本地母版 50.85，可复刻质量档。`capabilities().presets` 只是内置样例，
  定制片走内联 `params` + `POST /assets` 上传音轨（`docs/MCP-DEPLOY.md` §十）。
- `.gitignore` 按**身份特征**匹配（`**/core.enc`、`**/template.motion`、`/refs/`、`**/*_raw.png`），
  禁止回退成路径枚举——旧规则 7 条搬家后静默失效，其中一条保护 vendor 的账户 Key。
- **改路径必须跑 `bash tools/smoke.sh`**（`node --check` 抓不住 404）。探针：
  `--probe <file.png> --at <秒>`（`--probe --at 5` 会把 `--at` 当文件名）。

## 十、半蒸馏（`templates/own/`，五个实例）

**判据：先看上游是「版式枚举」还是「机制参数」**。前者价值在 schema 与容量，后者在式子；
若上游把原片写成手写章节脚本，换宿主只能复现那一支片，换不了"讲新内容"。

| 实例 | 上游 | 内容模型 | 实测 |
|---|---|---|---|
| sketchnote | sketchnote v2.7.4 | 4 类 mechanism 枚举（版式型） | 720 帧 1.9s |
| chalkboard | chalkboard v2.7.4 | 8 类 mechanism + **几何式子** | 1020 帧 6.1s / 167fps |
| cute-mv | cute-character-lyric-mv v1.0.1（Remotion） | `lyrics/keywords/notes` 三字段 | 990 帧 5.2–5.9s / 170–190fps |
| collage | motiongit-promo-main | 11 段原长 57.0s / 229 文字槽 | 3420 帧 10.2–10.3s / 332fps |
| science | 自建 | 见 §七 | 2215 帧 11.3s / 196fps |

- **paper 目标已打通（2026-11-14）**：`buildSkeleton({target:'paper'})` 按 `guide.json` 的 `paperType`
  直接出 paper scenes（A/B 母版显式指定，C–F 按 scienceType 兜底），段长拆 ≤7s、gap 只加在拍之间。
  三个坑：`planBeats` 重构时丢 `paperType`；拆段每段加 gap 会多 5s；**args 里的 `at`/`leftAt`/`cards[][1]`
  是绝对秒，必须按 (新t0−原t0) 平移**，否则元素"早出现过"⇒ freeze 16.7s（修后 5.3s）。
  **骨架 freeze 偏高是结构性的**：同拍子段用同一份占位 args，首尾相接成死画面（A 6.1s / C 17.2s）；
  试过改文案与按段长缩放都无效 ⇒ 一拍必须拆成内容不同的镜头，那是写稿的事。
- **`tools/knowledge/`（2026-11-14，内容模型层，不在 `kits/` 下）**：6 母版（A 猜谜/B 两难/C 痛点/
  D 主线/E 闯关/F 六面）× 4 时长档（速览 45–60s 5–7 拍 / 精讲 / 标准 / 深挖 14–20 拍）× 对位规则。
  `new.mjs --score` 五项 0–2 打分→推荐档，`--template --tier` 生成可渲染骨架，`--audit` 结构审查。
  **拍长 ≠ 段长**：母版一拍 12–16s，静态版式单段 >8s 就是死画面（1:1 映射实测 15.6s 静止，
  按 ≤8s 自动拆段降到 6.6s）；拍长按 role 加权，均分会让钩子拖沓。放 `kits/` 会触发 smoke 的
  capabilities 一致性检查（kits 下每支必须是可渲染版式）⇒ 必须放 `tools/`。
- 路线判据看 `content/release.bin`：有 `protected/core.enc` + 散装 `.enc` ⇒ 换宿主不成立；
  `guide.json`/`params.schema.json` 明文 ⇒ 半蒸馏成立。**场景表只能读 guide.json**，
  ffmpeg scene 检测对软转场无效（collage 只报 2 个切点）。
- schema 形态：`tools/check-template.py` **只认** `segments.items.properties`，不展开 `oneOf`
  ⇒ 多机制模板写「并集 properties + 判别 oneOf」；`guide.layouts[].args` 键名不能带点。
- collage 三条静默失效：`createLinearGradient` 不 addColorStop（Skia 不画且不报错）；
  全息条带必须离屏 + `source-atop`；静态背景必须缓存（4 次全屏渐变占单帧 60%，17.7→10.3s）。

## 十一、字体是构建依赖（2026-11-13 彻底修复）

- `assets/fonts/.gitignore` = `*` + `!.gitignore`，19 文件 ~34MB 不入库，由 `tools/fetch-fonts.sh`
  保证可复现。中间态最坏：旧规则只忽略 `*.otf`，`.ttf` 成了"没入库也没被忽略"。
- **19 个文件全部 sha256 硬校验**（教训：Mona Sans 路径 `@v1.0.1/fonts/ttf` 体积只有一半，
  下到另一个版本字形而 `--verify` 永远 ✓；正确是 `@v2.0.27/fonts/static/ttf`）。
- `curl --retry` 不重试传到一半断连，要 `--retry-all-errors --retry-connrefused`，
  配 jsDelivr→raw.githubusercontent→fastly 三源回退。
- **字节对 ≠ 能用**：另有 `node tools/check-fonts.mjs` 三重判据（`GlobalFonts.has` /
  `measureText` ≠ 回退基准 / 模板 FACE 族名都在表里）。族名要按逗号拆，整串正则会漏第一个。
- 注册表分组：`BASE_FONTS` + `TEMPLATE_FONTS.{chalkboard,hand,collage}`，`HAND_FONTS` 指向
  `TEMPLATE_FONTS.hand` **同一对象**（早先两处各列一遍，漏一处就静默不一致）。
- 字号分流否则字幕糊：`≥800 或 (≥700 且 ≥64px) → Black`，其余 700 → Medium + 保留 heavy 描边。

## 十一五、时间轴契约（`src/temporal.mjs`，2026-11-14）

- **与 `src/timing.mjs` 分工**：timing = 工时账本（author/render/revision 三个时钟）；temporal = 时间轴校验。
  名字别混，别覆盖。
- 模型取自 hypit 四层（Narrative→Alignment→Projection→Instant/Window）**只留后两层**：
  `Window`（半开 `[start,end)`、帧边界）+ `Extent`（帧数）。语义归内容侧，渲染器不碰。
- **判据按本仓标定，不照搬上游**：上游要求端点在帧边界（它声明帧），本仓时间来自口播实测浮点秒
  ⇒ 照搬让 `v8t.json` 一次报 30 条 0.16–0.36 帧的假错。改为：**端点偏离 >0.5 帧只 warn**，
  真正拦的是**取整后相邻窗口不连续**（`toFrame(prev.end)` vs `toFrame(cur.start)`）。
  用帧比不用秒比：秒比会放过真实 1 帧错位、也会因 0.001s 重叠误报。
- 骨架识别：`captions` 全落在 0–1s ⇒ 未配音骨架，越界/空窗口全降 warn（配音后 vo.py 重算）。
- **声明式已接入**：`loadParams` 先调 `normalizeTiming()` 把 `{from,for}/{until,for}/{from,until}`
  展开成 `t0/t1`，渲染器零改动；校验与渲染共用同一套展开。展开时落整帧（`toSeconds(toFrame(..))`）。
- 接入 `render.mjs`：**默认拦（exit 2）**，`--allow-time-drift` 只告警放行；骨架在校验器内部降级不误伤。
  **坑：`from` 也是内容字段**（night-card 的 quote 段 `{from:"某个凌晨 · 03:47"}` 是"出处"）⇒
  `isTimeValue()` 只认数字/纯数字串，且 `dur` 优先于 `from/until`，否则会把整支片拦死（冒烟抓到 2 FAIL）。
- **全量 92 个 params：91 通过**（含 3 个骨架、1 个跳过非参数文件）；唯一真错
  `kits/science/template/presets/triage.json`（内容 59.8s 但 `durationSeconds` 写 44s，6 处越界）。
- **抓到的真 bug**：`tools/knowledge` 的 `buildSkeleton` 原按秒分配（`toFixed(2)`），29 段累加漂到
  165.03s > 165s ⇒ `segments[29]` 越界 1 帧被截。改为**按帧分配 + 余数补给**（floor 后按小数部分分发），
  拆段同样按帧。改后 25 窗口全过、4950 帧出片正常。
- 声明式：`{from,for}` 起点锚定 / `{until,for}` 末端锚定 / `{from,until}` 两端锚定，
  改时长只动 `for`，另一段自动跟随。
- **引用式顺移（同日加）**：`"from": "@prev+0.25"` 让后续段跟着动，`"durationSeconds": "@last+0.02"`
  让总时长跟着走 ⇒ **改 1 个 `for`，9 段全部顺移、总长自动跟**（实测 105.65→107.63）。
  代价：每段展开都归整帧，`for:12.43`（745.8 帧）补成 746，9 段累积边界偏移 ≤2 帧
  ⇒ 与手写版 115 帧差异（1.8%，全在入场动画头几帧）。**这是帧对齐的必然，不是 bug。**
- **`auditTiming` 必须先 `normalizeTiming` 再校验**：不展开时 `durationSeconds:"@last+0.02"`
  会变成 NaN，报"超出时间线 NaN 帧"的噪音。
- 注意块注释里别写 `content/*/build.py` —— `*/` 会提前闭合注释（踩过一次）。

## 十二、音频

- 已实现 `src/audio-mix.mjs`：事件轨（adelay/amix/sidechain ducking/apad+atrim）+ 合成音
  whoosh/tick/impact/rise，`--audio` 优先于 `params.audio`。
- **踩坑（2026-11-14）**：ducking 里 `[voice]` 同时做 sidechain 触发和进 amix，**必须先 asplit**。
  没 asplit 时第二路拿到空 pad ⇒ **旁白从成片里消失**，实测 105s 片混完只有 −21.0 LUFS
  （比旁白单独 −16.9 还低），症状是"只有配乐没有人声"。修法 `[voice]asplit=2[voiceKey][voiceMix]`。
- **`alimiter` 的 `level` 默认 true（auto level）会把峰值抬回 limit，等于没限幅**
  ⇒ 必须写 `alimiter=limit=0.86:level=false`（−1.3dBFS，给 AAC inter-sample 过冲留 1dB）。
  实测加音效后真峰值到 0.2 dBTP；改后 −16.8→−17.3 LUFS、峰值合规。
- **earshot 音效增益不能统一给**：`pro_impact/short` 峰值 0.181、`swish/soft` 0.110、`click/soft` 0.004
  ——差 40 倍，统一 gain 的结果是 impact 炸、click 听不见。按峰值各自给（0.34 / 0.28 / 1.5）。
- **响度必须在配音环节归一**：edge-tts 原始输出 **−23.7 LUFS**，`add-bgm.mjs` 只做固定增益 + 限幅、
  **故意不做 loudnorm**（单趟动态增益会把段间电平来回拉，实测反而低 2.8dB）。配音后先
  `loudnorm=I=-16:TP=-1.5:LRA=11`（实测 −16.9），成片才落在 −17.0 口径内。
- 上游 33 个音效拿不到（发行时物理删除 + `retained.sfx.wav` 有名无实 + 事件表在 `core.enc`
  + 官方 `sfx.search/generate` disabled）；素材本身是 CC0 ⇒ 不是版权墙，是发行与通路。
- **2026-11-14 已由 earshot 补上**（`Leonxlnx/earshot` MIT，252 条配方音效，纯 DSP 无模型无网络）：
  cue 的 `src` 写 `category/member` 即走 earshot，`align`(onset/peak/end)+`lead` 按实测参考点对齐
  （偏差 ≤5ms），`gainDb` 优先于线性 `gain`。**单次 CLI 3.58s ⇒ 必须一次进程批量渲**
  （17 条 9.1s / 40 条 9.5s），缓存后混音 0.4s、出片 +0.4s。缓存 `~/.cache/cutduo/esfx`。
  `EARSHOT_PY` 显式即强制（`=none` 禁用），降级按 category 映到内置音、字节可复现。
  见 `docs/音效-earshot-2026-11-14.md`；`npm run esfx:warm` 预热 22 条角色音。
- 后续增强：① cue 改场景相对时间（加 hold 后绝对秒会错位）② loudnorm 到 −16 LUFS（现 −27）
  ③ 真实 CC0 配乐 ④ 放开 pipeline 的 `-ac 1` 才有立体声。

- **加 BGM 别二次编码**：`tools/add-bgm.mjs --audio <旁白.wav>` 走独立旁白轨，人声只编码一次
  （此前是 pipeline 先压 160k、add-bgm 再压 192k）。混音必须 `-t <视频时长>`：
  vo.py 故意多写 0.12s 音频防截末帧，不裁会让容器时长跟着音轨走，帧数门禁直接报错。
  循环配乐优先长素材：`Afloat Pad` 19.6s（4 个接缝）优于 `Mellow Drizzle` 8.3s（10 个）。
