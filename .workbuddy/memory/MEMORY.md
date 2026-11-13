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
- **遗留**：`image.yml` 仍指 `context: renderd`，该目录已在 Skia 重构（`da0ea50`）删除 ⇒
  镜像构建必失败。与 Release 无关，待定是删工作流还是改指向。

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

## 六、film-kit（mac-desktop / camera-mode）可直跑

旧结论"渲染不可达"作废，真因是 Chrome sandbox 起不来（`Operation not permitted`）→ GPU 崩溃。
两条路径：随包 `assistant/motion.mjs` **不认** `MOTION_BROWSER`；模板 `runtime/entry.mjs`
**认**（`~/.local/bin/mg-chrome` 包 `--no-sandbox`）。实测 2819 帧/51s≈55fps。
`api music-prepare` 是 **0 积分**，别为此调付费 TTS。cinecode 需 `--flags "--no-sandbox"`，
PATH 要有 `/opt/homebrew/bin`；`capture.mjs` 写完 video 不退出（墙钟 vs 有效渲染分开记）。

## 七、科普模板 `science`（2026-11-12/13）

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

- 不蒸的部分要写明（chalkboard 的 13 类图示与 102 图标不蒸，`science` 已有同类能力）。
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

## 十二、音频

- 已实现 `src/audio-mix.mjs`：事件轨（adelay/amix/sidechain ducking/apad+atrim）+ 合成音
  whoosh/tick/impact/rise，`--audio` 优先于 `params.audio`。
- 上游 33 个音效拿不到（发行时物理删除 + `retained.sfx.wav` 有名无实 + 事件表在 `core.enc`
  + 官方 `sfx.search/generate` disabled）；素材本身是 CC0 ⇒ 不是版权墙，是发行与通路。
- 后续增强：① cue 改场景相对时间（加 hold 后绝对秒会错位）② loudnorm 到 −16 LUFS（现 −27）
  ③ 真实 CC0 配乐 ④ 放开 pipeline 的 `-ac 1` 才有立体声。

- **加 BGM 别二次编码**：`tools/add-bgm.mjs --audio <旁白.wav>` 走独立旁白轨，人声只编码一次
  （此前是 pipeline 先压 160k、add-bgm 再压 192k）。混音必须 `-t <视频时长>`：
  vo.py 故意多写 0.12s 音频防截末帧，不裁会让容器时长跟着音轨走，帧数门禁直接报错。
  循环配乐优先长素材：`Afloat Pad` 19.6s（4 个接缝）优于 `Mellow Drizzle` 8.3s（10 个）。
