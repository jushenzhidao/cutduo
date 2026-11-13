# kits/collage · Screen Collage（深色科技风宣传片）

**半蒸馏**自 `motiongit.com/motiongit/motiongit-promo-main`（template-585 · v2.6.5-alpha.1 · 5.46MB）。
11 段、1920×1080@60、57 秒。渲染层全部重写，借它的**场景结构与语义块**。

> 口径收敛：**不是** 229 个文字槽的字段级契约。上游 `copy-contract.json` 有 229 槽 / 11 个顶层参数，
> 本 kit 映射为 75 个 args 字段（≈33%），只保留"哪个场景有哪些语义块"。
> 审计见 `docs/collage-对抗审查-2026-11-13.md`。

```bash
node render.mjs --kit collage --params kits/collage/presets/cutduo.json --out out/cutduo-film-57s.mp4
```

两个 preset 分工明确：`cutduo.json` 是本仓自己的片子（默认预设，就是一份 params JSON）；
`demo.json` 是参考片复刻件，**唯一保留 MotionGit 品牌**（`.motion` / motiongit.com / MotionGit）的地方，
用于与参考片逐帧对位。`kits/collage` 的代码默认值已全部改成 cutduo / `.json`——
新写 preset 时漏字段，也只会漏出自家品牌。

---

## 1. 为什么是半蒸馏，不是换宿主

按 `docs/AGENTS.md` §1.1 的梯子，先查两件事：

| 判据 | 实测 | 结论 |
|---|---|---|
| 引擎是 Canvas2D？ | 查不了 —— `content/release.bin` 里 `protected/core.enc` + 152 个 `objects/*.enc`，AES-256-GCM 密文 | 换宿主不成立 |
| 源码可读？ | 否。`protection: protected`，渲染核只有密文与 Ed25519 签名 | 只剩 Chrome 或半蒸馏 |
| 内容模型可读？ | **是**。`guide.json` 19KB / `copy-contract.json` 67KB / `params.schema.json` 71KB 全明文 | **半蒸馏成立** |

> 一处口径不一致，别被它带偏：包内 `motion.json` 的 `runtime.profile` 写 `motiongit-host/1`、
> `specVersion` 写 `1.0.0-rc.1`，而官网页面标的是 `html-canvas/1` / `0.1.0-draft.1`。
> 判据不在这两个字段上——只看「渲染源码是否可读」。

---

## 2. 内容模型：上游 → 本 kit

| 上游 | 本 kit | 说明 |
|---|---|---|
| `guide.duration.rules` 的 11 段原长与停留点 | `presets/demo.json` 的 `scenes[].t0/t1` | 硬规律，照抄 |
| `copy.<scene>.*`（**229** 个文字槽） | 每段 `args` 里的具名字段 | 槽位语义保留，粒度合并 |
| `media.demo` / `portrait` / `wall00..11`（14 个载体） | 暂无（作品墙为程序化缩略图） | 见 §6 已知差距 |
| `brand.name` / `domain` / `initial` | `end.args.brand` / `domain` | |
| `copy.labels.<scene>`（11 条） | `scenes[].args.label` | HUD 左上角章节名 |
| `durationSeconds`（min 57 / max 600） | 与时间轴一致即可 | 放宽，但仍校验 |

### 11 段结构（原长 / 停留点，单位秒）

| # | type | HUD 章节 | 原长 | 停留点 | 画面 |
|---|---|---|---|---|---|
| 1 | `hero` | 01 / FORMAT | 4.5 | — | 紫点 → 全息字标 `. motion` → 主张 |
| 2 | `recipe` | 02 / RECIPE | 6.5 | 4.75 | 格式样张掠过 → `.mp4`（像素卡）对 `.motion`（配方层） |
| 3 | `open` | 03 / OPEN | 3.5 | — | `m` 图标 + "An open video template format" |
| 4 | `pack` | 04 / PACKAGE | 6.5 | 5.75 | 雷达环 + 文件图标 + `$ motion inspect template` |
| 5 | `flow` | 05 / CREATE | 10 | 8.5 | 四步轨道 + AI 会话面板 + 模板预览 |
| 6 | `adapt` | 06 / ADAPT | 4 | 2 | 同一设计 16:9 / 9:16 双窗 |
| 7 | `reuse` | 07 / WORK | 5.5 | 4 | 4×3 作品墙 + 图注 |
| 8 | `spec` | 08 / SPEC | 4 | — | `motion.json` 代码卡 + 10 个工具胶囊 |
| 9 | `share` | 09 / SHARE | 4 | 3 | Git 分支图 + "Great ideas. Shared and refined." |
| 10 | `finale` | 10 / MOTION | 4 | — | 字标回归 + "Start every creation with great design" |
| 11 | `end` | — | 4.5 | 2.5 | `m MotionGit` + `motiongit.com`（HUD 淡出） |

合计 57.0s。停留（hold）本版未启用——`demo.json` 按无停留的原编排，与参考片 57s 版本一致。

---

## 3. 实测

同片 3420 帧 / 57.000s / 1920×1080@60，8 worker，30 核 M 系列：

| 项 | 数值 |
|---|---|
| 出片 | **10.2–10.3s**（两次） |
| 吞吐 | **332 fps** |
| 体积 | 3.85 MB（h264 crf20 veryfast + tune animation） |
| 门禁 | PASS（flat 1.8% / black 1.8% / hook 0.18 / mean Y 30.2） |
| 峰值 | 8 进程，无浏览器 |

**与上游的对照必须标注口径**：`guide.json` 的 `duration.rules` 自述「本机 1080p60 约 2.7 帧/秒」，
按同片算是约 1267s ⇒ **约 123×**。这个数是「实测 vs 上游自述」，**不是同机 A/B**。
真要 A/B 得先补齐 14 个素材载体与 229 个文案槽才能过它的 `plan`，那是另一轮工作。

### 与参考片的几何对齐（hero 帧，像素级）

用 `bench/bbox-compare.mjs` 量高亮像素包围盒（阈值 L>90）：

| 元素 | 参考片 | 复刻 | 差 |
|---|---|---|---|
| 字标 `. motion` | x 454–1509 / y 290–506（1055×216） | x 453–1509 / y 290–506（1056×216） | **1px / 0px** |
| 主张句 | 1034×54，y 665–719 | 1021×54，y 667–721 | 宽 −1.3%，高 0 |

同帧 SSIM 0.644（参考片有真实光晕与颗粒，复刻是纯矢量绘制，SSIM 偏低不代表版式不对——
版式对不对看包围盒，质感差异看人眼）。

---

## 4. 六个坑（都踩过，都不报错）

1. **空渐变不绘制**。`createLinearGradient` 之后不 `addColorStop` 会得到「没有停止点」的渐变，
   Skia 对它**一个像素都不画**，也不抛错——症状是字标整块消失。仓里统一走 `ui.mjs` 的 `makeGrad()`。
2. **全息条带必须 `source-atop` 画在离屏画布上**。在文字包围盒里画会从字缝漏出去，
   在整屏画布上画会把背景一起染白。做法：字标渲染一次到 1211×405 的离屏 canvas，条带用
   `globalCompositeOperation='source-atop'` 约束到字形 alpha，之后每帧只 `drawImage` + 裁切展开。
3. **静态背景必须缓存**。底色 / 辉光 / 版面残影 / 透视地面 / 暗角 = 4 次全屏渐变填充，
   实测占单帧绘制时间 ~60%。缓存成一张位图后：**17.7s → 10.3s**（−42%）。
   星点是唯一逐帧变化的部分，单独画。
4. **扫过类动画要给负起点**。`recipe` 的格式卡片如果从 `t=0` 起跑，切点进来会先空 0.5 秒。
   改成 `-0.30 + i*0.40` 预滚，段首第一帧就有内容。
5. **参考片的字体介于 Mona Sans 常规与 Expanded 之间**。实测宽高比：常规 4.62 / Expanded 5.63 /
   参考片 4.88。做法是 `272px MonaSans-Black` + **横向 6% 拉伸**，才能同时对上宽度与高度；
   只换字族或只调字号，两者必有一个差 10% 以上。
6. **样张卡片不能"各自飞一趟"**。第一版每张卡片独立 `lerp(2020 → -900, 1.05s)`，
   约 **2876 px/s**，字读不出来，而且三张跑完后到对照进场之间留了 **0.5s 空场**。
   第二版改成匀速连排（1250 px/s），速度是慢了，但三张同时挤在画面里更乱。
   现在是一次只给一张：**进 0.8s → 停 0.5s（可读）→ 出 0.5s（easeIn，先滞留后加速）**，
   槽位 1.45s 形成 0.35s 交接；出场不做透明度渐变（会留 0.16 的鬼影），靠移出边框。
7. **ffmpeg 的 scene 检测找不到切点**。对参考片跑 `select='gt(scene,0.18)'` 只报出 2 处（35.1s / 37.8s）——
   大部分转场是软过渡，被元素运动吃掉了。**场景表只能读 `guide.json`，不能靠检测**。

---

## 5. 换内容 / 换品牌

只改 preset，不动代码：

```jsonc
{
  "brand": { "name": ".cutduo", "initial": "c" },  // HUD 产品名 + 所有图标里的字母
  "scenes": [
    { "type": "hero", "t0": 0, "t1": 4.5,
      "args": { "wordmark": ".cutduo", "chip": ".cutduo · ...", "chipDot": false } },
    { "type": "pack", "t0": 14.5, "t1": 21,
      "args": { "fileExt": ".json", "fileName": "presets/cutduo.json", "cmd": "..." } }
  ]
}
```

- `brand.initial` 会注入 `open` / `pack` / `end` 三处的图标字母；`wordmark` 只在 `hero` 与 `finale`。
- **字标带不带点由字符串自己决定**：`".cutduo"` → 句点按基线圆点画、紧贴首字母（实测间距 7px）；
  `"motion"` + `"dotStyle": "floating"` → 参考片那种悬浮紫点。两者都不写则只画字母。
- 品牌自带句点时，hero 胶囊会重复出一个点 —— 传 `"chipDot": false` 关掉胶囊的前置圆点。
- `klineGrad` 必须是 `kline` 的子串，否则该行按纯白绘制（不报错）。
- 中文自动切 Noto Sans SC Black/Medium（Mona Sans 无中文字形），字距与渐变照常生效。
- 改完先 `node api/cli.mjs validate --kit collage --params <preset>`，再出片。

## 6. 文件

```
kits/collage/
  collage.mjs           渲染器：背景（缓存）/ HUD / 时间轴 / 场景分派
  scenes.mjs            11 个场景 + 字标精灵 + 作品墙缩略图
  ui.mjs                令牌（色阶实测）/ 文本 / 玻璃面板 / 胶囊 / 图标
  params.schema.json    骨架校验 + x-sceneArgs（11 段的 args 字段说明）
  presets/demo.json     原样复刻参考片的文案与编排（对位用）
  presets/cutduo.json   同一套 11 段，换成 cutduo 自己的内容（成片 out/cutduo-film-57s.mp4）
  licenses/             Mona Sans、JetBrains Mono 的 OFL
api/kits/collage.mjs    能力声明（contentModel: scenes[]）
```

字体装到 `assets/fonts/`（Mona Sans 7 个字重 + JetBrains Mono 3 个），
注册在 `src/fonts.mjs`——**全仓唯一的注册入口**，别在 kit 里另开。

## 7. 半蒸馏的验收口径：每个维度都要有测量

这次翻车的根因不是渲染，是**验收维度缺了一维**。

| 维度 | 口径 | 工具 | 当时有没有 |
|---|---|---|---|
| 空间（位置/尺寸） | 高亮像素包围盒 | `bench/bbox-compare.mjs` | 有 → 字标做到 1px |
| 颜色 | 逐点采样色阶 | 脚本内联 | 有 → 渐变 6 段对齐 |
| 时长（场景级） | `guide.json` 的 duration.rules | — | 有 → 11 段分毫不差 |
| **时间（镜头级节拍）** | **相邻帧横向位移曲线** | `bench/motion-scan.mjs` | **没有 → 事故就在这一格** |
| 空旷 | 亮像素占比 | `bench/ink-scan.mjs` | 没有 → 后补 |

**教训**：半蒸馏给你的是**场景级时间轴**，不是镜头级的节拍。
`recipe 6.5s` 是已知，`卡片何时进、停多久、怎么换` 是未知——未知的那一格如果靠"看两帧猜"，就会造出参考片根本不存在的东西。

实测参考片：`recipe` 4.4–7.6s 有 **26/31 帧横向位移为 0**，全片 P90 仅 **720 px/s**（83% 的帧静止）。
它是"卡片不动、格式名在卡里原地变（.avi → .webm → .mp4），最后才缩放成对照左块"。
我第一版却写了一条 2876 px/s 的滚动带——**那不是复刻，是发明**。

```bash
node bench/motion-scan.mjs video refs/replicas/reference/motiongit-promo-main.mp4 4.4 7.6 10
node bench/motion-scan.mjs kit   kits/collage/presets/cutduo.json 4.5 11 10
```

⚠️ 方法自身的盲区：列剖面互相关假设"整体平移"，遇到大块面积出现/消失（淡入、换卡）会读出假峰值
（本轮就在像素卡淡入处读到过 1800 px/s）。**读数异常时先看帧，再改代码。**

## 8. 空帧检查（gate 抓不到的那一类）

`src/gate.mjs` 判的是**黑帧**（YMAX<24）。「只有背景辉光、元素还在淡入」的近空帧不触发它，
但一样难看。`bench/ink-scan.mjs` 逐帧统计亮像素占比，< 0.35% 报「偏空」：

```bash
node bench/ink-scan.mjs 0 57 0.2
```

用它扫全片，抓出过 `pack` 前 0.5s（0.09%）、`recipe` 卡片段尾部（0.10%）两处洞。

## 8.5 音频：现状与后续增强（2026-11-13 决定「后续再做」）

**已经在的**（不是从零开始）：

- `src/audio-mix.mjs`：事件轨 `cues[{at,src,gain}]` → `adelay` 定位 → `amix` 叠加 →
  有 `voice` 时 `sidechaincompress` 做 ducking → `apad` 补到成片时长再 `atrim`。
- 内置合成音 4 个（`whoosh` / `tick` / `impact` / `rise`），程序合成、确定性噪声，逐帧可复现。
- `mode` 三态：`external-music` / `effects-only` / `none`；`--audio` 优先级高于 `params.audio`。
- `cutduo.json` 已挂 17 条 cue，实测 -27 LUFS（纯音效，无配乐）。

**后续增强的四件事**（按收益排序）：

| # | 事项 | 为什么排这 |
|---|---|---|
| 1 | **cue 改成场景相对时间**（`at: {scene:'flow', offset:1.2}`） | 现在 cue 是绝对秒。一旦加 `hold`，场景整体后移而 cue 不动，音画立刻错位。这是当前设计最容易被踩的一处 |
| 2 | **响度归一**（`loudnorm=I=-16:TP=-1.5`） | 现片 -27 LUFS，平台上偏轻；有配乐后更明显。归一化要放在 amix 之后、atrim 之前 |
| 3 | **真实的配乐与音效资产** | 上游那 33 条拿不到（见审查报告附录五层断点）。可走 CC0 库选材，或等平台的 `sfx.search` 开放（当前 `configured=false`） |
| 4 | **立体声** | `src/pipeline.mjs` 对非 aac 音轨写死 `-ac 1`，混音被压成单声道；要做声场得先放开这条 |

**不做**：复刻上游那 33 个音效本身。资产不存在，事件表在密文里，官方通路关着——这不是工程量问题。

## 9. 已知差距（不要当成已完成）

按"能不能 replace 上游产线"分两类。**当前定位：能出同风格片的独立版式，不是 drop-in。**

### 能力缺口（上游有，我们没有）

| 能力 | 上游 | 本 kit |
|---|---|---|
| `hold` 停留点 | 已审核静止点可停 0–6s，1/60 秒粒度 | **未实现**；只能拉长 `t1`，动画会提前播完 |
| 音频 | 33 个动作音效事件 + 配乐 ducking + `soundtrackMode` 三态 | 只有画面，音轨外挂 `--audio`；上游发行时已把音频资产剥离（`audio-content-boundary.removed` 33 条） |
| 媒体载体 | 14 个（`demo`/`portrait`/`wall00–11`），含视频时钟 | 作品墙是程序化缩略图，无视频载体 |
| `copy` 契约 | 一个整体对象，plan 阶段校验容量 | per-scene args，schema 只校验骨架 |

### 精度差距（有，但量过）

- **逐场景 SSIM 0.44–0.65（均值 0.589）**，纯黑基线 0.086。是"结构相似、细节不同"，
  不能说"复刻到像素"。最差 `adapt` 0.442。
- **字体是同源近似**：上游随包许可是 Mona Sans + JetBrains Mono（都 OFL），
  但字重与光学尺寸未必与作者实例相同。
- **未跑上游同片 A/B**：123× 是「实测 vs 上游 `duration.rules` 自述」，不是同机对比。
- **flow 右面板内嵌预览是固定插画**（暖色人物 + 条形图），只有标题/版本/说明可换。
