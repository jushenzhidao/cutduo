# MEMORY.md — 本项目长期约定

> 只留「下次一定会用到、且不看文档就会踩坑」的结论与数字。
> 过程性叙述在各日 `YYYY-MM-DD.md`；从代码能读到的细节不在这里重复。
> 上一版 28KB 已被注入截断，这是 2026-11-14 的重写版（原档 `MEMORY-archive-2026-11-14.md`）。

## 一、发版

- **运行结论 success ≠ 发布成功**。判发布成立要看**步骤级**结论（`Build changelog` / `Create Release`）。
  曾出现 run=success 而两处全 skipped：tag 在、Release 零个、无告警。
- 根因：tag 提交的**正文**里写了跳过标记，而逃生阀判定跑在模式判定之前且匹配整条 message。
  `release.yml` 已修：先定 MODE，跳过标记只在 `MODE=auto` 生效。
- 惯例：tag-only、0 资产、标题=tag 名；自动补丁 `v0.x.y+1`，**契约变化才人工打 tag**。
- 纯 CI / 纯文档提交用 `[skip release]`。**但 `[skip release]` 会让 tag 也不打**：
  2026-11-14 推了 18 笔全带跳过标记，CI run=success 而 tag 停在旧版本、Release 零个。
  要发版必须**人工打 tag 再推**（`git tag -a vX.Y.Z && git push origin vX.Y.Z`），
  且 tag message 里**不能**出现跳过标记。

## 二、速度口径（比较必须同片）

- 判据三条：出片墙钟、渲染吞吐 fps、体积。同一支片、同一参数，**只换引擎**。
- 同一口播 46.386s / 8 段 / 60fps：film-kit 51s·55fps｜skia-kit **6.8s·409fps**｜cinecode 113s·24.6fps。
- **fps 随片长上升**（预热摊销）：4127 帧 344fps，1419 帧 195–210fps ⇒ 跨片比 fps 会误判。
- 速度只有两个开关：有无浏览器（≈6×）、中间帧压不压缩（10–30%）。
- 四段式命名 `速度档 / 模板 / 传帧 / 封装`，例 `极速档 / desk / raw / h264`（`docs/AGENTS.md` §0）。
  五模板共用 `@napi-rs/canvas`（Skia）⇒ **模板不改速度档**；`editorial` 不走浏览器。

## 三、模板接入策略（`docs/AGENTS.md` §1.1）

**先问用途，再问技术；默认 Chrome，别拿换宿主当性能手段。**

| 用途 | 走哪 | 成本 |
|---|---|---|
| 一次性出片 | Chrome | 0 |
| 短期反复（源码可读 + Canvas2D） | 换宿主 | 几小时 |
| 长期产线 | 半蒸馏（蒸**内容模型**，非视觉代码） | 2–4 天 |

## 四、交付门禁（`src/gate.mjs`）

**三项"看起来像门禁"的指标其实是连续分布**：hook（前 2s 运动）0.06–5.29 / p50 0.31（0.5 会误杀 13/19）、
平均 L\* 0.40–91.3、重复帧 0–36.8% ⇒ **只报不拦**。

**能当门禁的是完整性**：空帧 ≤8%、黑帧 ≤3%、帧数差 ≤1、音画差 ≤0.10s。

| 检查 | 口径 | 状态 |
|---|---|---|
| `--blank` 空镜 | 主体区（crop 底部 18%）240×105 灰度 std，连续 ≥2s <12 报警 | 只报 |
| `--loudness` | −16 LUFS ±2 / 真峰值 ≤−0.5 dBTP | 5 支走 loudnorm 的全部 −15.9 |
| `--bgm` | **旁白间隙**（有 BGM 0 段静音 / 无 20–22 段）；互相关 ≥0.12 已证伪 | 只报 |
| `--facts` | 正查「台账数字有没有上屏」+ 反查「屏幕有台账没有」（反向要滤噪声） | 只报 |
| `--caption-check` | 字幕区 OCR 覆盖率 <60% 报警；含**阅读时间** `max(1.8s, 字数/5.5)` | 只报 |

- **`--caption-check` 的字幕带写死过 `y<0.3`**（距底 30% 内），竖屏片字幕在 0.28–0.45 ⇒ 15/15 条全报
  "覆盖 0%"，而画面清清楚楚。竖屏必须显式传 `--subtitle-y 0.28,0.45`。
  且加参数时先确认**调用处真的把实参传进去了**（本例第一次加了参数但 `checkCaptions(cp, oc.lines, opt.ocr)`
  只有三个实参，参数不生效，看起来像"参数没作用"）。

- **空镜判据为什么不用动作量**：paper 画面变化量中位 0.29、p10 为 0（天然就静），真出问题的段落 0.11
  与正常 0.3–4.8 **同一量级** ⇒ freeze 分不开。信息量分得开：纯纸背景 0–1.5 / 引文页 18–20 / 图文 56。
- `flat%` 只看全片比例（3s 空镜仅占 4.2%，8% 阈值不拦）⇒ `--blank` 补的正是「局部连续空镜」。
- 负向自检：插 2s 黑场→FAIL；音轨截短 3.17s→FAIL；插 3s 纯背景→报空镜；健康片零误报。
- **`freezedetect` 两个坑**：冻到片尾只打 `freeze_start` 不打 `duration`（按 片长−起点 补）；
  `execFileSync` 只取 stdout，它在 stderr 要用 `spawnSync`。
- **字幕阅读时间不能照抄上游 `speech+0.6s`**：本仓字幕与配音同步，N 字就说 N/5.5 秒，
  "停留 ≥ 说话+0.6"数学上永不成立（照搬会 22/39 条全报）。

## 五、时间轴契约（`src/temporal.mjs`，最容易踩的一类）

**两套时间语义必须分开处理**：

| 来源 | 语义 | 处理 |
|---|---|---|
| 骨架 args（v8t）的 `cards[][1]` / `at` | **绝对秒**（7.868 落在段 5.32–11.44 内） | 按 `t − base.t0` 平移 |
| 用户在 `script.json` 的 `screens` 里写 | **段内相对秒**（1.2 / 2.8） | 直接 `+ t` |
| `segments`（science） | 只有 `dur`，前缀和累积 | — |

混在一起会得出 71.72 这种远超段末的时间 ⇒ 卡片永不出现 ⇒ 画面只剩字幕（实测 40–43s 空镜）。

**五条硬规则**：

1. **换段型时不继承骨架 args**（两套段型的字段混在一起，`at` 会变成负数）。
2. **`number` 的 `from` 是数值起点不是时间**。白名单 `at|leftAt|rightAt|strikeAt|itemAt`，
   含 `from` 会让数字从 18 滚到 30 而不是从 0 滚。
2.5. **`screens` 的时刻必须小于子段时长**（2026-11-14）：build 把一拍按 ≤7s 拆段，每段**重放**
   `screens[k]` 并从 0 起算。元素钉在 4.2s 而子段只有 3.6s ⇒ 永不出现，画面只剩标题。
   **已有代码防**：`new-film` 生成时 `clampTimes` 等比压到 ≤3.0s（实测子段最短 3.5s，留 15% 余量），
   build 时逐段检查、超限打警告。另：每屏要给 `cast`（2–6 字），缺省会退回标题 ⇒ 关键词卡重复标题。
3. **`renderFrame` 在场景空隙里不能取 `scenes[末尾]`**：每两场景间 0.25s gap 会让**每个间隙闪一帧片尾卡**。
   应保持上一个已结束场景的末态。
4. **`script.json` 的 `type` 优先于骨架的 `paperType`**（否则改了 `type: chart` 也渲成 steps）。
5. **链式生成按实际间隔**：同一拍拆出的子段之间没有 gap，一律写 `@prev+0.25` 会让 15 段凭空多出 1.76s，
   配音按真实总长切 ⇒ 音画差 1.77s、gate FAIL。

## 六、版式与段型

### 6.1 十一支版式，两套入口

| 入口 | 版式 |
|---|---|
| `render.mjs --kit X` | paper / science / clay / collage / night-card / chalkboard / cute-mv / sketchnote |
| `npm run editorial` / `desk` / `mg` | 各有独立 render.mjs，传 `--kit` 会报「找不到 kit」 |

内置渲染器只有 4 个 kind（science/paper/clay/collage），其余走 `templates/own/<name>/src` 的 webcanvas。

### 6.2 `paper` 的 11 种段型

`hero / point / number / compare / steps / quote / checklist / outro / broll / grid / chart`

- `grid`：点阵表达数量（`rows/cols/highlight/exception`）。**例外点必须跳出网格 + 2.2 倍半径 + 虚线牵回**
  ——换颜色或换方形都分不出（三次迭代才成立）。
- `chart`：`line` / `bar` 真图表。轴先长再落点、跨零画虚线、**bar 必须标数值**、bar 不画 x 数字。
- **`chart` 段的 freeze 会被严重高估**（标记点只占画面 0.02%，低于 freezedetect 的 0.2% 阈值）。
- **图表是内容呈现方式，不是视觉语言** ⇒ 做成段型而不是独立版式。

### 6.3 `science` 与 `paper` 结构完全不同

| | paper | science |
|---|---|---|
| 容器 | `scenes` | `segments`（**只用 `dur` 累积**） |
| 段型 | 11 种（上） | cover / talk / diagram / matrix / focus / tip / outro |
| 顶层 | brand / accent | 还要 `theme` / `subtitle` / `fadeOutSeconds` |

- **不能复用 paper 的 build**。实例：`content/gut-antibiotic/build.py`。
- 图标只有 7 个（gut / hip-joint / drop / radiation / shield / check / clock）⇒ **选题必须由图标倒推**。
- `talk.lines` 是**无时间的字符串数组**；`matrix.items` 需要 `{icon,label,disc}`。

### 6.4 跨版式喂参数会静默产废片

8 支版式 params 结构看着一样，**渲染语义不同**。paper 的 params 喂 editorial：能跑完 6126 帧、
gate 判 PASS，实际 22s 白屏、后半段卡死（根因 `default: bg('paper')` 画白纸）。**已改为抛错**。
换版式要换参数，同一份 params 只在同一支渲染器内部通用。

### 6.5 args 结构（写新片前必读 `kits/paper/presets/v8t.json`）

按"看着合理"猜会一路崩到渲染函数，错误信息完全不指向病因（`l.replace is not a function`）：

| 段型 | 字段 | 格式 |
|---|---|---|
| quote | `lines` | **字符串数组** `["第一行","第二行"]` |
| point | `words` / `cards` | **元组数组** `[["文字",0.4]]`（写成字符串数组不报错、**不渲染**） |
| hero | `lines` | 元组数组 `[["文字",0.5]]` |
| compare | `left/right` | `{title, items:[…]}` |
| outro | `lines` | 字符串数组 |

`quote.lines` 与 `point.words` 正好相反，最容易混。`new-film` 现在会把 v8t 的真实结构
（时间归一化成段内相对）直接填进 `screens`。

**一拍拆多段时每段重放同一份 screens** ⇒ 同一画面重复 2–5 遍（D 母版 5 拍 × 18s 必拆）。
必须给每拍**多个 screens**（内容递进），实测 2/3/2/4/3 个才够。

**配音缓存只判 mp3 是否存在**：改了 script.json 也不重配（实测文案加到 438 字、成片还是 70s）。
已改为比较 mtime。改文案后时长没变，先查这个。

**台词字数换算：4.9 字/秒**（336 字→70s、448 字→91s），别用 3.2 估。

### 6.6 五套母版的段型结构（全部实测可渲染）

| 母版 | 名 | 拍数（精讲） | 段型序列 |
|---|---|---|---|
| A | 反直觉探针 | 9 | hero/point/number/compare/quote/grid/steps/outro… |
| B | 两难选择 | 9 | hero/point/**hero**/number/point/quote/quote/compare/outro（两段 hero 是"给选项"和"下判断"） |
| C | 痛点原理 | 7–8 | hero/point/number/diagram/steps/quote/compare/outro |
| D | 一条主线 | 5 | hero/point/steps/steps/outro（每拍 18s，必拆多段 ⇒ 每拍要多个 screens） |
| E | 闯关 | 5 | hero/compare/quote/number/**checklist** |

**number 段不给 `dur` 时数字瞬间到位、后面整段静止**（要写 `dur: 2~3`）。
**checklist 的 `items` 时刻必须落在子段时长内**（拆段后每段只有 6 s 左右，铺到 11 s 的后两项永不出现）。

`checklist` 段不是勾选框列表，是**半圆仪表盘 + 指针扫过 + 当前项**（pChecklist：R=330 的弧，
指针按 items 出现顺序推进，中间显示当前项文字）。这是设计，不是缺漏。

## 七、音频

- **`vo.py` 产 wav，不能 `-c:a copy` 进 MP4**（PCM 在浏览器整轨静音），非 aac 一律转 `aac 160k`。
- **concat 会静默丢段**：edge-tts 是 24kHz mp3、静音是 44.1kHz wav，混拼时 7 段 + 6 gap 应得 62.05s
  实际只拼出 60.55s（少掉全部 gap）。**必须先统一转 wav 再 concat**，没有报错只有时长不对。
- **配乐统用 `tools/audio-bed.mjs`**：`scenes` / `segments` 都认，三层曲风（electrohouse / chillwave / hiphop），
  各 4 层 loop 按段落包络进出，缺 loop 报错并列出可用曲风。
  `content/<片>/bgm.mjs` 是 paper 专用遗留（读 `scenes[i].t0`），别给 science 用。
- `vo.py` 的 `mouthCurve` 是**死数据**（写在 preset 顶层，版式只拿 `scenes[].args`）⇒ 口型一直走模拟。

## 八、半蒸馏与换宿主

- **`check-kit-contract` 的段型提取有三种写法**：switch 块、白名单数组、**对象映射**
  （`const PAINTERS = {...}` + `PAINTERS[cur.type]`）。只认前两种时 collage 提取为 0，
  与 schema 一比全错。段型名可能是驼峰（`flipBoard`），正则要允许大写。
  当前覆盖：paper 11 / desk 18 / collage 11 全部与 schema 对表；clay / mg 无枚举（真实情况）。
- **竖屏用 `tools/reframe.mjs`**（模糊填充，不裁内容），不要重排版式：
  paper 的栅格按 1920×1080 定、全是绝对坐标，改 1080×1920 等于重写布局；
  直接裁又会切掉关键词卡和字幕。背景 sigma 48 / 压暗 0.18 / 降饱和 0.55，否则原画面色块抢前景。
- **`protection` 不是门槛**：open 可换宿主，protected 只能 Chrome 或照片反推；换宿主还需引擎是 Canvas2D。
- 已评估：`mac-desktop` 最优（480fps/24w）；`sketchnote` 手绘单核 14fps、要 12 worker；`camera-mode` 引擎 DOM。
- **science 双宿主只快 20–27%**（Chrome 154fps vs Skia 196fps），别照抄 paper 的 6.9×
  ——版式栅格化密集，CPU 光栅化吃掉差距。
- Skia 记账：单看 `renderFrame` 1ms 是假象，真实 10–16ms，代价在 `canvas.data()`。
  唯一有效优化是并行度：6/8/12/16/20w → 132/141/172/186/192fps。

## 九、API 层（`api/` 是唯一业务实现，CLI 只是宿主）

- 六动词 `capabilities / describe / validate / render / probe / gate`；契约见 `docs/API.md`；
  `api/capabilities.json` 由 `tools/gen-capabilities.mjs` 生成，**不要手改**。
- 回执规格**只信 ffprobe 探测**，不解析 kit stdout。错误必带 `code/hint/fix`；`validate` 永不抛。
- `overrides` 白名单只放渲染超参（`api/contract.mjs` 硬编码），内容必须走 `params`。
- **`validate` 支持 `if/then/else`**（2026-11-14 补）：此前不支持导致 paper 的 **9 组段型必填约束全失效**
  （缺 `value` 的 number 段能过 API、渲染成空白）。仍不支持 `$ref` / `format`。
- 异步 job：① 一 job 一独立进程；② **判终态先读 stdout 不看 pid**（pid 复用曾致永久 running）；
  ③ `status()` 不是纯查询（lazy scheduling 会拉队首）。并发几乎无收益（每支已吃满 8 worker）。

## 十、仓库与内容

- 依赖方向单向 `kits/* → src/*`：`render.mjs`（主 CLI）· `src/`（引擎）· `kits/`（版式）· `content/`（片）·
  `assets/` · `templates/`（own/vendor）· `tools/` · `docs/`。`refs/*`、`out/`、`content/*/audio/` 不入库。
- 仓库根只能从 `src/root.mjs` 取（向上找 `.git`）；字体注册只有 `src/fonts.mjs`。
- **`paper.mjs` 的关键词卡**：兜底顺序 `cast > title > label`，**不要退到 `scene.type`**
  （会把 `hero`/`compare` 印到屏幕上）。内容侧要给每段 `args.cast`（2–6 字）。
- 四支成品（2026-11-14）：生日悖论 A×paper 102s、本福特定律 C×paper 68.5s、
  抗生素的另一面 C×science 62.1s、幸存者偏差 97.3s。全部过 6/6 门禁。
- `tools/report.mjs` 出片库总览（并发跑门禁，4 支约 25s）；`tools/publish-pack.mjs` 出发布包
  （封面取**段末**不取段中——元素逐个长出来，取中点只有一半；封面必须压**不透明**标题带，
  半透明会让成片字幕条透出来；字体要用单个 TTF，`.ttc` 集合索引不到中文会渲染成方块）。

## 十一、人物与字幕

- Skia 侧 `collectFigures()` 见 `document===undefined` 直接 return ⇒ 不补 `__MK_FIGS` 会静默退化成矢量。
- 位图姿态图更快（15.2→13.2s）；`figureHeight` 矢量 0.86 / 3D 0.92–0.96。
- 字幕：62px 单行上限 **26 字**，超了按标点折行 + 降档（50→下限 44）；安全区用**视觉顶端**；
  两行必须统一字号。
- 圆盘里的插画别用方图直塞（方边停在盘中央，读作"骨头断了"），用 `tools/circle-prop.mjs` 做圆形 alpha。

## 十二、对抗审查自身也会错

- `adversarial.mjs` 曾用 `params.fps`（30）去切 60fps 帧序列 ⇒ 切点索引减半，8/8 切点报"重复帧"。
  已改为优先 ffprobe `r_frame_rate`。**60fps 出片后必须重跑**。
- **版式清单必须逐支 probe 再写**：照 README 抄曾把 3 支不可用（desk/editorial/mg）写成可用，
  又漏掉 3 支真能跑的（chalkboard/cute-mv/sketchnote）。
- 「适配 1–2 天/个」的估算错了：lemo 的框架只有 189KB / 21 文件 / 2 个 npm 包，
  代码侧 1–2 小时，成本全在素材（字体 / 100MB 扫描图 / 语音模型）。
