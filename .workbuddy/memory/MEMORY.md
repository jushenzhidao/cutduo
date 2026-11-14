# MEMORY.md — 本项目长期约定

> 只留「下次一定用到、不看文档就会踩坑」的结论与数字。过程见各日日志；代码可读的不重复。
> 2026-11-14 三次压缩（原档 `MEMORY-archive-2026-11-14.md`）。注入上限约 12KB，超了会被截断。

## 一、发版

- **run=success ≠ 发布成功**，只看步骤级结论（`Build changelog` / `Create Release`）。曾 run=success 而两步全
  skipped：tag 在、Release 零个、无告警。根因：tag 正文有跳过标记，逃生阀判定早于模式判定且匹配整条 message。
- 惯例：tag-only、0 资产、标题=tag 名；自动补丁 `v0.x.y+1`，契约变化才人工打 tag。
- 纯 CI/纯文档用 `[skip release]`，**但它连 tag 一起跳过**（18 笔全带 ⇒ CI success、tag 停旧版）。要发版须人工
  `git tag -a vX.Y.Z && git push origin vX.Y.Z`，tag message 不能含跳过标记。

## 二、速度口径（同片同参，只换引擎）

- 三判据：墙钟、渲染 fps、体积。46.386s/8 段/60fps 同口播：film-kit 51s·55fps｜skia-kit **6.8s·409fps**｜cinecode 113s·24.6fps。
- **fps 随片长上升**（4127 帧 344 vs 1419 帧 195–210）⇒ 跨片比 fps 会误判。两个真开关：有无浏览器（≈6×）、
  中间帧压不压缩（10–30%）。命名四段式 `速度档/模板/传帧/封装`；`editorial` 不走浏览器。

## 三、模板接入与外来项目吸收

先问用途再问技术，默认 Chrome，别把换宿主当性能手段：一次性出片 → Chrome（0）；短期反复且源码可读 +
Canvas2D → 换宿主（几小时）；长期产线 → 半蒸馏（蒸**内容模型**，不蒸视觉代码，2–4 天）。

吸收外来项目（hypit / vibe-knowledge / anything2explainer / iso-explode-film）：**先定性它是什么（引擎？方法包？
素材包？），再分"能平移的规则"与"不可平移的假设"**，产出一份 `docs/<名>-蒸馏-<日期>.md` + 至少一个能跑的检查工具，
不整仓拷贝。anything2explainer 是方法包，三条不可平移：帧率基线（上游 0.1s）、底色极性（`lum>120` 取前景，
遇 paper 浅底会把整张纸当主体）、版式家族（静止占比差 15 倍）。许可证不商用也照此办：只取规则，代码与文字重写；
用户说"不用管协议"时同样重写，不做整段移植。

## 四、交付门禁（`src/gate.mjs`）

三项"像门禁"的其实是连续分布，**只报不拦**：hook 0.06–5.29（p50 0.31，阈值 0.5 会误杀 13/19）、平均 L\*
0.40–91.3、重复帧 0–36.8%。**能拦的只有完整性**：空帧 ≤8%、黑帧 ≤3%、帧数差 ≤1、音画差 ≤0.10s。

| 检查 | 口径 |
|---|---|
| `--blank` | 主体区（crop 底 18%）240×105 灰度 std，连续 ≥2s <12 报警。补 `flat%` 盲区（3s 空镜只占全片 4.2%） |
| `--loudness` | −16 LUFS ±2 / 真峰值 ≤−0.5 dBTP（5 支 loudnorm 全 −15.9） |
| `--bgm` | 看**旁白间隙**：有 BGM 0 段静音 / 无 20–22 段。互相关 ≥0.12 已证伪 |
| `--facts` | 正查台账→屏幕 + 反查屏幕→台账（反向要滤噪声） |
| `--caption-check` | 字幕带 OCR 覆盖 <60% 报警；阅读时间 `max(1.8s, 字数/5.5)` |
| `--check-determinism` | render.mjs 新开关：同一 t 单独渲 vs 插远处 t 再回来，逐像素比。抓 ctx 状态泄漏（按序出片看不出）。**不重渲视频**，FAIL 退出码 2 |

- **竖屏必须传 `--subtitle-y 0.28,0.45`**：默认写死 `y<0.3`，竖屏 15/15 全报 0% 而画面清楚。加参数先确认调用处
  真把实参传进去（第一次 `checkCaptions(cp, oc.lines, opt.ocr)` 只有三个参数）。
- 空镜不用动作量：paper 变化量中位 0.29、p10=0，问题段 0.11 与正常 0.3–4.8 同量级；改用信息量（纯纸 0–1.5 /
  引文 18–20 / 图文 56）。
- `freezedetect`：冻到片尾只打 `freeze_start` 不打 duration（按 片长−起点 补）；输出在 stderr，要 `spawnSync`。
- `tools/contact-sheet.mjs`（`npm run sheet`）：扫片（0.33s 一格、4×8）+ 卡点（词前 0.1s/后 0.35s）拼图。
  gate 是数字指标，抓不到截断/叠字/卡点偏——这三类只能人眼看格子。
- 字幕阅读时间不能照抄 `speech+0.6`（本仓字幕与配音同步，N 字即 N/5.5 秒，照搬 22/39 条全报）。
- 负向自检：插 2s 黑场→FAIL；音轨截短 3.17s→FAIL；插 3s 纯背景→报空镜；健康片零误报。

### ### 4.2 长段静止的解法（2026-11-14 实测，`birthday-paradox` 6/9 → 0/9）

**先纠正一个误判**：pacing 的 17.77s 不是"判据不准"。复现它的口径（320×180 灰度、0.1s 间隔、
阈值 0.35）后测出：遮罩扫出 + 32px 位移只产生 0.163 均值差、119 变化像素（门槛 153）。
**是动作幅度不够。**

三条量化结论：
- 一次揭示要约 **153 变化像素**才被识别（0.35 × 57600 / 灰度差 100）。
- **时间窗口会摊薄幅度**：0.4s 的弹出每 0.1s 只完成 25% ⇒ 均值差 0.10；0.24s 窗口才够。
  这就是 steps 段"90 次变化仍判静止"的真因。
- 有效组合 = **整行一次性出现 + 40–90px 位移 + 0.1–0.26s 窗口**。遮罩扫出反而更差
  （同一时刻只露 1/3）。位移要大到 90px 才压得住 42px 小字（number 的 sub）。

**事件数 ≥ 段长/8 才达标**：compare 4 条 / steps 5 步 → 铺得开；hero 2 行 / number 1 个数 /
outro 1 个 CTA → 必须加事件（hero 加了第 3 行对齐口播第 3 句，number 把 sub 拆三段）。

4.1 节奏（`tools/pacing.mjs`）

- 上游「静止 ≤3s」绑死 MG 风格：静止占比 MG 6% / paper 86–92% / science 86%，差 15 倍。默认 `stillMax 8s`
  （健康语料最长 6.83+余量），`--strict` 才 3s。
- **时间基线必须 0.1s**（`--equiv-fps 10`）：上游按每 3 帧抽 1 张 @30fps 标定；用相邻帧把差分压到 1/6
  （同片 96.7% vs 93% 判静止）。
- `hold ≥30f@30fps` 是**下界**判据（只抓"落位即切"）；全片静止 <20% 判连续运动型、不判 hold（cute-mv 假阳性）。
- 离群：birthday-paradox 6/9 段超 8s、最坏 17.77s。构图量化没做：paper 浅底深字、无"发光主角"，直译全误判。

## 五、时间轴契约（`src/temporal.mjs`）

两套语义必须分开：骨架 args（v8t）的 `cards[][1]`/`at` 是**绝对秒**（按 `t−base.t0` 平移）；`script.json` 的
`screens` 是**段内相对秒**（直接 `+t`）；science 的 `segments` 只有 `dur`（前缀和）。混用会算出 71.72 这种超段末
时刻 ⇒ 卡片永不出现、只剩字幕（实测 40–43s 空镜）。

1. 换段型**不继承**骨架 args（两套字段混在一起，`at` 变负数）。
2. `number.from` 是数值起点不是时间；时间白名单只 `at|leftAt|rightAt|strikeAt|itemAt`（含 from 会从 18 滚到 30）。
3. **关键词锚点**：`wordTimes: {词:[start,end]}` + `{$mark}`（绝对秒，args 内用）/ `{$markRel}`（段内相对，
   screens 用）。词不在表、或落点越出本段 → **出片前抛错**（这正是上面第 3 条的现场）。判定只看值形状
  不看 key 名（`from` 在内容里常是「出处」）。段级 `t0/t1` 写锚点会被 params.schema 拒，仍由 build.py 算。
3c. **`number` 默认 `from = value`（不滚）**：原 `a.from || 0` 让"不写 from"等价于"从 0 滚"，
   而滚动中间值以 172px 清晰上屏 ⇒ 标签是"误差上限"时观众先看到 0%、2% 这些不存在的事实，
   还会让台账核对报"台账外数字"（实测 4 支片）。要滚必须显式给 from。
3d. **台账检查有约 4 成误报**：7 个"台账外数字"里只有 3 个是真的——Y 轴刻度（自动算 max+8%）、
   OCR 丢小数点（`11.0`→`10`）、点阵被连读（`000000`）都会误报。**先出帧核对再改内容**。
3e. **章节号的 `06/0` 是 OCR 误识不是 bug**（画面实为 `07 / 09`）。`paperBeatOrder()` 的兜底
   写不进调用处（`sc.beat` 为假时走 `scenes.length`），加兜底是死代码，已回退。
3b. **越界现在会拦**：`tools/check-times.mjs` + `auditTiming` 会检查 `args` 内时刻是否落在段内，
   越界=元素永不出现。**paper 的 args 是绝对秒，science 是段内相对秒**（renderFrame 传 localT）——
   判错会把正常片全拦死（实测 science diagram.callouts.at=1.40 被报「早于段起点 19.50s」）。
4. **`screens` 时刻必须 < 子段时长**：build 按 ≤7s 拆段、每段重放 `screens[k]` 从 0 起算，钉在 4.2s 而子段 3.6s
   ⇒ 永不出现。`new-film` 的 `clampTimes` 压到 ≤3.0s（最短子段 3.5s），build 逐段警告。每屏还要给 `cast`
   （2–6 字），缺省退标题 ⇒ 关键词卡重复标题。
4. `renderFrame` 在场景间隙不能取 `scenes[末尾]`（0.25s gap 会让每个间隙闪一帧片尾卡），保持上一场景末态。
5. `script.json` 的 `type` 优先于骨架 `paperType`；链式生成按实际间隔（同拍子段无 gap，写 `@prev+0.25` 会让
   15 段多出 1.76s ⇒ 音画差 1.77s FAIL）。

### 5.1 计数与章节号（2026-11-14）

- **`number` 段不要 from 0 起滚**：中间值（1%、2%）会清晰上屏，而标签是「误差上限」⇒ 等于画了一个
  不存在的事实。`from = value` 只走圆环。代价是 freeze +1s。
- **章节卡编号按「拍」算**（`kits/paper` 的 `paperBeatOrder()`）：原来用 `scenes.indexOf`，一拍拆 2 段
  ⇒ 7 拍的片显示「05 / 14」。旧片不重渲不会变。

## 六、版式与段型

### 6.1 十一支版式，两套入口

`render.mjs --kit X`：paper/science/clay/collage/night-card/chalkboard/cute-mv/sketchnote；`npm run editorial|desk|mg`
各有独立 render.mjs，传 `--kit` 报「找不到 kit」。内置只有 4 个 kind（science/paper/clay/collage），其余走
`templates/own/<name>/src` 的 webcanvas。

### 6.2 paper 的 11 种段型

`hero / point / number / compare / steps / quote / checklist / outro / broll / grid / chart`

每型的参数手感与坑见 **`kits/paper/segments/`**（number/grid/chart 已写，其余待写）。三条不搬走的结论：
`grid` 的例外点必须跳出网格（换色/换方形都分不出）｜`chart` 的 freeze 被 freezedetect 严重高估（标记点
占 0.02% < 0.2% 阈值）｜`checklist` 是半圆仪表盘不是勾选框。

### 6.3 science ≠ paper

paper 用 `scenes`，science 用 `segments`（只 dur 累积）；段型 cover/talk/diagram/matrix/focus/tip/outro；顶层多
`theme`/`subtitle`/`fadeOutSeconds`。**不能复用 paper 的 build**（`content/gut-antibiotic/build.py`）。图标只有 7 个
（gut/hip-joint/drop/radiation/shield/check/clock）⇒ **选题由图标倒推**。`talk.lines` 是无时间字符串数组；
`matrix.items` 要 `{icon,label,disc}`。

### 6.4 跨版式喂参数会静默产废片

paper 的 params 喂 editorial：跑完 6126 帧、gate PASS，实际 22s 白屏（`default: bg('paper')` 画白纸）。已改为抛错。

### 6.5 args 结构（写新片前必读 `kits/paper/presets/v8t.json`）

| 段型 | 字段 | 格式 |
|---|---|---|
| quote / outro | `lines` | **字符串数组** |
| point | `words` / `cards` | **元组数组** `[["文字",0.4]]`（写成字符串数组不报错、**不渲染**） |
| hero | `lines` | 元组数组 |
| compare | `left/right` | `{title, items:[…]}` |

`quote.lines` 与 `point.words` 正好相反，最易混。一拍拆多段时每段重放同一份 screens ⇒ 同画面重复 2–5 遍，
每拍必须多个 screens（实测 2/3/2/4/3 个）。**配音缓存只判 mp3 是否存在**（改 script.json 不重配，成片停在 70s）⇒
已比 mtime。**台词 4.9 字/秒**（336→70s、448→91s），别用 3.2 估。

### 6.7 段级运镜（`src/camera.mjs`，2026-11-14）

`args.camera = {kind, z, dur, anchor}`；kind 只 push/pull/punch/drift（cut=关）。
**只放大不缩小**（z≤1 会露画布外空白，直接判无效）。只包内容层——时间码/头像卡/字幕/品牌角标在变换外，
加 push 后这两块 PSNR=inf（逐像素不变）。不写 camera = 现状零回归（同帧 PSNR=inf）。
`hold` = 整段固定某倍数（一拍拆多段时 push→hold→pull 才连续；没有它会「推-跳-推」）。
`tools/apply-camera.mjs` 按连续同型段组自动编排，默认拒 chart/grid/steps/number。
门禁 `--camera-check <params>` 只报不拦：推近 >8 次/分 或 punch >1/3 镜头 报黄（标尺来自那支
「102s 推近 48 次」被判不 smooth 的片）。画面自己在动的段（chart/grid 逐个长）别加，两个运动会打架。

### 6.6 五套母版（全部实测）

| 母版 | 名 | 拍 | 段型序列 |
|---|---|---|---|
| A | 反直觉探针 | 9 | hero/point/number/compare/quote/grid/steps/outro |
| B | 两难选择 | 9 | hero/point/**hero**/number/point/quote/quote/compare/outro（两段 hero=给选项/下判断） |
| C | 痛点原理 | 7–8 | hero/point/number/diagram/steps/quote/compare/outro |
| D | 一条主线 | 5 | hero/point/steps/steps/outro（每拍 18s 必拆 ⇒ 每拍多份 screens） |
| E | 闯关 | 5 | hero/compare/quote/number/checklist |

`number` 不给 `dur` 时数字瞬间到位、整段静止；`checklist.items` 时刻必须在子段时长内。

### 6.7 `iso`（等轴测爆炸图，2026-11-14）

`kits/iso/` + `content/iso-powerbank/`：7 层 40 件 / 27.3s / 60fps / 1638 帧 **13.3s（123 fps）**，gate PASS，
pacing 0/9 不达标。内容模型 `layers/parts/arrays/hero/mech` 全是 JSON，九种镜头
`hero/rise/explode/part/action/array/stack/assemble/end`。
- **遮挡不能按面心深度**（大板压小件会翻）：零件对做分离轴投票 → 拓扑排序；两轴相反或互穿**不建边**，
  按深度补边会造环（实测 32–64 条边被违反）。
- **机位不能手抄**：按主体包围盒反算 zoom/pan；核心件被 pull 抬走后只补"当前−取景时"的高度差。
- 桌面**不进三维投影**（特写 D≈2.6R 时远端翻面 ⇒ 橙色铺满帧），改屏幕斜线 `lx=0.58W`。
- 每镜末段 `settle()` 留 0.8s 静止，否则 pacing 的 hold（≥30f@30fps）4/9 段不达标。
- 两版配色：`ISO_LOOK=dark`（与上游同名），深底外壳要 `look.tone=0.82` 压 18%，否则顶到纯白。
- 配乐母带**两步**：先 acompressor+alimiter(level=false) 压 crest，再 loudnorm I=-16:TP=-2.2；
  直接归一顶到 -0.2 dBTP（gate 线 -0.5）。`synth-bgm` 的 drop 自动落在最长段 = 爆炸开头。
- 取景要**两遍实测**（透视非线性，一遍会切边），且**先定落定 yaw 再 fit**（fit 后转 8° 会把长边切出框）。
- 近摄（part/action/array/stack）把非主体降到 8% 幽灵；阵列保留同层作上下文。
- 动作幅度不能越过上覆零件（iPhone 镜片升 2mm 顶穿 0.55mm 的屏 ⇒ 屏幕上出现蓝点）。
- 两支片：powerbank（7 层 40 件）/ iphone（6 层 36 件），均 27.3s，换产品只改 params.json。
- 运动：`args.transition` = whip / orbit（侧绕+荷兰角+变焦压）/ spin（360°、0.52s、正弦缓动，不能进关键帧）；
  `orbit` 镜头（正弦摆动）段首尾同相可直接循环。运动模糊 = 8 子帧**两级离屏**累加（叠残影只会得重影边；
  单图累加会过曝）。
- 几十层：`content.spacing`（mm/层）给等间距，原曲线按 6–8 层调、24 层会挤成 5mm；
  `layer` 镜头（逐层展示）= 停一层 + 侧转 10° + 其余 8% 幽灵 + 主体描亮边。
- `settle` 的目标必须等于最后一帧机位（差 3° ⇒ 后半程持续漂 ⇒ pacing hold 判 4 帧）。
- 代价：24 层 65 件 / 1908 帧 = 48s（40 fps），比 27s 片慢 3.5×（遮挡排序 O(n²)）。
- 已知弱项：array/stack 取景（薄层上方的大件闯进画面）、无穿插检测。

## 七、音频

- `vo.py` 产 wav，**不能 `-c:a copy` 进 MP4**（PCM 在浏览器整轨静音）⇒ 非 aac 一律 `aac 160k`。
- **concat 会静默丢段**：edge-tts 24kHz mp3 + 静音 44.1kHz wav，7 段+6 gap 应 62.05s 实际 60.55s。必须先统一转
  wav 再 concat（无报错，只有时长不对）。
- **`--synth` 走代码合成**（`tools/synth-bgm.mjs`，纯 Node 零依赖、xorshift 确定性、drop 对齐段边界）：
  客观指标与 loop 版等价（−17.1 vs −16.9 LUFS、旁白间隙都 0 段）。本机虽有 Apple Loops 但**不入库**，
  换机/CI 只能走这条。两个坑：kick/hat 必须有 2ms/1ms 起音包络（否则频谱竖线贯穿全频）｜长片 drop 会
  一路到底（90s 片 11.4→87.1s），须让 outro 落在 78% 处 + drop 内每 8 小节回落一次。
- 配乐统一 `tools/audio-bed.mjs`：三层曲风（electrohouse/chillwave/hiphop）、各 4 层 loop 按包络进出。**a 层必须
  是铺底**（鼓组有空档 ⇒ 判"无铺底"FAIL）；各曲风电平差 8–9 dB，TRIM 要乘在**包络上**（hiphop ×2.6），不能乘
  在 amix 后。`content/<片>/bgm.mjs` 是 paper 遗留，别给 science 用。
- `vo.py` 的 `mouthCurve` 是死数据（写在 preset 顶层）⇒ 口型一直走模拟。

## 八、半蒸馏与换宿主

- `check-kit-contract` 段型提取三种写法：switch、白名单数组、**对象映射**（`PAINTERS[cur.type]`），且要允许驼峰
  （`flipBoard`）。覆盖 paper 11 / desk 18 / collage 11；clay/mg 无枚举（真实）。
- 竖屏用 `tools/reframe.mjs`（模糊填充不裁内容），别重排版式：paper 全绝对坐标，改宽高=重写；直裁又切字幕。
  背景 sigma 48 / 压暗 0.18 / 降饱和 0.55。
- `protection` 不是门槛：open 可换宿主，protected 只能 Chrome；换宿主还需引擎是 Canvas2D。已评估 mac-desktop
  最优（480fps/24w）；sketchnote 单核 14fps。**science 双宿主只快 20–27%**，别照抄 paper 的 6.9×。
- Skia：`renderFrame` 1ms 是假象，真实 10–16ms，代价在 `canvas.data()`；唯一有效优化是并行度
  （6/8/12/16/20w → 132/141/172/186/192fps）。

## 九、API 层（`api/` 是唯一业务实现）

- 六动词 capabilities/describe/validate/render/probe/gate；`api/capabilities.json` 由工具生成，不要手改。回执规格
  只信 ffprobe；错误必带 `code/hint/fix`；validate 永不抛。`overrides` 只放渲染超参，内容走 `params`。
- **validate 支持 `if/then/else`**（补之前 paper 9 组必填约束全失效）；仍不支持 `$ref`/`format`。
- 异步 job：一 job 一进程；**判终态先读 stdout 不看 pid**（pid 复用致永久 running）；`status()` 会拉队首。

## 十、仓库与内容

- 依赖单向 `kits/* → src/*`。目录：`render.mjs`/`src`/`kits`/`content`/`assets`/`templates(own|vendor)`/`tools`/`docs`。
  `refs/*`、`out/`、`content/*/audio/` 不入库。仓库根只从 `src/root.mjs`，字体只 `src/fonts.mjs`。
- `paper.mjs` 关键词卡兜底 `cast > title > label`，**不要退到 scene.type**（会印出 hero/compare）。
- 片库十支（2026-11-14）：paper 五支 55–102s、science 一支 62.1s、desk 两支 65.7/99.3s、iso 一支 27.3s。
- `tools/report.mjs` 出片库总览；`tools/publish-pack.mjs` 封面取**段末**（段中元素只长一半），标题带必须**不透明**
  （半透明会透出字幕条），字体用单 TTF（`.ttc` 索引不到中文会渲成方块）。
- `tools/coverage.mjs` 主指标是**每种段型平均复用次数**（≥3 次即明显重复），不是覆盖率。

## 十一、人物与字幕

- Skia 侧 `collectFigures()` 见 `document===undefined` 直接 return ⇒ 不补 `__MK_FIGS` 会静默退化成矢量。位图姿态图
  更快（15.2→13.2s）；`figureHeight` 矢量 0.86 / 3D 0.92–0.96。
- 字幕 62px 单行上限 **26 字**，超了按标点折行 + 降档（50→44）；安全区用视觉顶端；两行统一字号。
- 圆盘插画别用方图直塞，用 `tools/circle-prop.mjs` 做圆形 alpha。

## 十二、审查自身也会错

- `adversarial.mjs` 曾用 `params.fps`(30) 切 60fps 帧 ⇒ 8/8 报"重复帧"。已改优先 ffprobe `r_frame_rate`；
  **60fps 出片后必须重跑**。
- 版式清单必须逐支 probe 再写（照 README 抄曾 3 支假可用、又漏 3 支真能跑的）。
- 「适配 1–2 天/个」估算错了：lemo 框架仅 189KB/21 文件/2 包，代码 1–2 小时，成本全在素材。
