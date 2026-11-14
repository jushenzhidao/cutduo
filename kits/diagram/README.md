# kits/diagram · 说明性图示（13 类段型）

把「数据怎么比、关系怎么走、结构怎么分」画成图，而不是写成句子。
现有 kit 里 `compare` 只能放两列文字、`steps` 只能排线性步骤；一旦要讲
「四个样本的量差」「四次测量的走势」「三个步骤怎么循环」，只能硬凑。

已实现 13 类：`data-bar` `data-line` `hierarchy` `cycle` `definition` `compare` `process`
`causal` `parts` `experiment` `evidence` `formula` `recap`。

## 一、这是什么，不是什么

**是段型库，不是版式。** 它不自带片头、头像卡、字幕条 —— 那些由调用它的 kit 负责。
`render.mjs` 只是把这 4 类串成一条验证片用的最简入口。

**只借规则，不搬代码。** 13 类的 recipe 契约（哪类要哪些字段、容量上限、揭示节奏）
来自对 Metro 类模板的阅读；绘制代码全是这里自己写的。理由不是许可，是维护：
上游那套是 907 行单行压缩 + 两个全局耦合，搬进来改一次 token 都要绕它。

## 二、13 个 family 的字段契约

| family | 用途 | 每项必填 | 容量 |
|---|---|---|---|
| `data-bar` | 同类对象的量差 | `id` `label` `value` | 2–8 项 |
| `data-line` | 同一指标的序列 | `id` `label` `x` `value` | 2–8 点 |
| `hierarchy` | 分类 / 包含关系 | `id` `label`（`parent` 指上层） | 1–8 节点、最深 4 层 |
| `cycle` | 首尾相接的闭环 | `id` `label`（`text` 可选一句说明） | 2–8 节点 |
| `definition` | 术语与释义 | `id` `label` `text` | 1–6 条 |
| `compare` | 同一对象的两个时点 | `id` `label` `before` `after` | 2–6 行 |
| `process` | 线性步骤 | `id` `label`（`text` 可选） | 2–6 步 |
| `causal` | 因 → 果 | `id` `label` + 段级 `links[{from,to}]` | 2–6 节点、两层 |
| `parts` | 部分与整体 | `id` `label` `value` | 2–6 段 |
| `experiment` | 条件下的一次观察 | `id` `condition` `result` | 1–4 组 |
| `evidence` | 引文与出处 | `id` `text` `source` | 1–3 条 |
| `formula` | 公式 + 变量表 | 段级 `formula`；项 `symbol` `meaning` `value?` | 0–6 变量 |
| `recap` | 复习收束 | `id` `label`（`text` 可选） | 2–6 条 |

段级字段：`family` `duration` `title?` `unit?` `note?` `items[]`。

## 三、四条版式决策（都是踩过才定的）

1. **条形横着放**（`data-bar`）。16:9 里竖柱要把中文标签斜排或缩写；横条把标签放左、
   数值放右，一个字都不用改。
2. **横轴按真实 x 间距**（`data-line`）。等距会让"第 3 次和第 9 次"看起来一样远，
   读者会读错趋势。`x` 是数值不是序号。
3. **层级用「编号圆点 + 文字 + 直角折线」，不画方框**。8 个方框会变成 8 个色块，
   视觉重量压过内容。连线从**父节点文字下方**出发 —— 从圆点直接拉会穿过标签。
4. **循环用矩形环，不用正圆**。正圆在 16:9 里会把上下两个节点推到屏幕边缘，
   而文字阅读区在中带。

## 四、跑

```bash
# 13 类各一张 1920×1080 + 一张 4×4 总览（版式回归用）
node kits/diagram/sheet.mjs --out out/diagram-sheet

# 无声验证片（13 段）
node kits/diagram/render.mjs --params kits/diagram/presets/all.json --out out/diagram-all.mp4

# 带配音与字幕：先出时间轴，再出片
node kits/diagram/tools/vo.mjs --params kits/diagram/presets/render-cost.json \
  --out-params out/render-cost.vo.json --out-audio out/render-cost.vo.wav
node kits/diagram/render.mjs --params out/render-cost.vo.json --out out/render-cost.mp4

# 响度归一（gate 会报偏离 -16±2，这一步是交付必经）
ffmpeg -y -i out/render-cost.mp4 -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:v copy -c:a aac -b:a 160k -movflags +faststart out/render-cost-final.mp4

node src/gate.mjs out/render-cost-final.mp4 --require-audio
```

`vo.mjs` 跟 `templates/_scaffold/tools/vo.py` 同一套"时间轴跟随配音"的原则，但结构不同
（这里一段 = 一句口播 + 一张图，没有 scene/line 嵌套），所以是独立实现，不是调用。

段里写 `line` 就是口播稿兼字幕；`vo.mjs` 实测每句时长后重算 `duration`，
所以手写的 `duration` 只是占位，会被覆盖。

`--palette neutral` 可切到中性纸色，用来跟上游对照；默认 `paper` 跟 `kits/paper` 同色温。

## 五、节奏：有 timing 就锚点，没有才均分

**首选：锚点驱动。** 给了 `--timing`，每一项可以绑一个词：

```json
{ "label": "skia-kit", "value": 6.8, "rowAt": "三个引擎", "at": "六点八" }
```

- `rowAt` —— 念到这个词时"这一项**是什么**"出现（行标签、术语）
- `at` —— 念到这个词时"这一项**多大**"长出来（条长、数值）

两组必须分开。合成一组的话，念到"三个引擎"时三条已经长满，后面念"六点八、五十一、
一百一十三"就只是复读；分开以后 4.7s 只有第一根条长出来，正是"画面追声音"。

时刻来自 `tools/timestamps.py`（FireRedASR2-CTC 字级时间戳，本机 CPU）：

```bash
node kits/diagram/tools/vo.mjs --params <preset>.json --out-params out/x.vo.json --out-audio out/x.vo.wav
uv run --with sherpa-onnx python kits/diagram/tools/timestamps.py \
  --wav out/x.vo.wav --manifest out/x.vo.json --out out/x.timing.json
node kits/diagram/render.mjs --params out/x.vo.json --timing out/x.timing.json --out out/x.mp4
```

`resolveAnchors()` 在出片前解析锚点：**词不在稿子里、时刻越界、顺序倒了，一律退出码 2**。
不这么做的话，写错的锚点表现为"某项永远不出现"，不报错，只有看片才发现。

**退路：均分。** 没给 `--timing` 时保持老行为，所有 family 的逐项出场窗口压在段长的 12% 以内。
原因：字幕是整句常显的，图如果慢慢长，会出现"字幕已经念完三个词、图上只有一个"的错位。
宁可图在 1 秒内立起来，剩下时间给读。

这条是按成片实测调的（53.7s / 8 段，段均 6.7s）：窗口 0.34 时 1.1 秒才出第二项，明显落后于语音。

段内还有一层 `activeIndex(p, n)`：按进度推"现在讲到第几项"，给该项加左侧色条或放大字号。
没有词级时间戳时这是唯一能让图跟着语音走的办法；它不解决 `gate` 的 freeze（那个指标在 480×10fps
上测，看不见这类细动效，见 `src/gate.mjs` 注释），只解决"观众听到第三条、图上没指向"。

**开场与片尾**：`titleCard {title, sub, duration}` 做片头卡（不配音，`vo.mjs` 会把音频整体后移）；
`outroFade` + `outroTitle` 做落版，遮罩必须**完全不透明**，否则底层编号会透上来和片名叠字。
`introFade`（默认 0）是整屏揭幕 —— 图示段的小动效在 `hook` 的 64×36 灰度检测下等于静止，
只有大面积变化才提得动分数（实测 0.07 → 0.20）。

**构图轮换**：每段可给 `heading: 'left' | 'center' | 'none'`。八段都用左上标题会看腻：
定义/收束用居中（要停下来读），构成/公式/折线用无标题（图本身够满）。右上角有 `02 / 08` 计数器。
`none` 时图区上移，family 内部的纵向比例会跟着变（`parts` 的条形位置按 box 比例算）。

**一段多句**：用 `lines: ["第一句", "第二句"]` 代替 `line`。短片的锚点常落在段内第二句上
（先给结论、再报数），段落必须能装多句。`vo.mjs` 逐句合成、句间插 `lineGap`，字幕按句切换 ——
两句一起挂会超 26 字上限，还要折行。`lead` / `endPad` / `lineGap` 可按片调，20 秒短片用
0.26 / 0.40 / 0.14（默认 0.42 / 0.62 / 0.18 是给长片留呼吸的）。

**底部让位**：`captionY` 取 946 时 `frame.bottom` 必须 ≥ 200。默认 120 让版心底缘落在 960，
正好压住左下角的 `note`，字幕和注释叠成一坨 —— 样张看不出，只有成片才暴露。

## 五·五、元镜头：讲这条流水线自己

四个不接 `items` 的段型，用来拍"这支片子自己是怎么做出来的"。数据全部由 render 侧注入，
所以**写不出假数字**：

| family | 数据来源 | 屏幕上是什么 |
|---|---|---|
| `bignum` | `recipe.value` | 一个巨大数字 + 横排说明（单项时比条形图强） |
| `timeline` | `_timeline`（timing.json） | 每句一条真实范围 + 每字的开口刻线（念到转红） |
| `glyph` | `_chars` + `env.now` | 一句的字逐个点亮，下面印各自秒数 |
| `framecount` | `env.frameInfo` | 当前帧号 + 全片短尺 + 播放头 |

三条纪律：

- `grid: false`。整屏内容铺网格会把数字压成底纹。
- **含中文的字符串不能用 `fonts.mono`**。JetBrainsMono 没有中文字形，"全片 604 帧"会渲成
  `▯▯ 604 ▯`；纯数字才用 mono。这条是成片后才发现的，截图里非常显眼。
- `{total}` / `{frames}` / `{seconds}` 是占位符，出片前由 `render.mjs` 替换成本片真值 ——
  手打的数字迟早和实际帧数对不上。

## 五·六、出片参数：改了会怎样

第三列写**后果**，不写取值范围。一个数没有越界的后果，下一个人调它就是在赌。
（这条来自 video-talkcraft 的参数表体例，见 `docs/video-talkcraft-蒸馏-2026-11-15.md`。）

| 参数 | 默认 | 调节手感 |
|---|---|---|
| `lead` 段首留白 | 0.42 | 给第一个元素入场的窗口。0.3 以下在 20 秒短片里才合适；长片压到 0.3 会让每段都"抢拍子" |
| `endPad` 段尾留白 | 0.62 | 让最后一帧站住。和 `exitFade` 相加才是真正的"停"——两个都调大会读成拖 |
| `lineGap` 段内句间 | 0.18 | 两句之间的一口气。低于 0.1 听不出断句，高于 0.3 像换了一段 |
| `revealFade` 单项入场 | 0.3 | 一项长完的时间。0.15 以下看着像硬切（元素"跳"出来），0.5 以上念完了条还没长满 |
| `exitFade` 段末出场 | 0.2 | **0 = 硬切**（旧行为）。0.15–0.3 是"让位"；>0.5 会读成两段之间在拖，且最后一段会和 `outroFade` 抢时间 |
| `introFade` 整屏揭幕 | 0 | 大片底色压下来。**不是为了好看**：`gate` 的 hook 只看 64×36 灰度差，图示的小动效在那里等于静止，只有整屏变化能提分（实测 0.07 → 0.18） |
| `outroFade` 片尾落版 | 0 | 遮罩必须**完全不透明**，留 8% 时底层编号和字幕会透上来和片名叠字；片尾期间要停画字幕 |
| `captionY` 字幕基线 | 940 | 与 `frame.bottom` 是一对：字幕 946 时 `frame.bottom` 必须 ≥200，否则版心底缘正好压住左下角的 `note` |
| `frame.bottom` 版心下边 | 120 | 收到 210 是给 42px 字幕让位；再大图区就压得太扁，`data-bar` 的行高会顶到上限 |
| `fps` | 60 | 30 只适合信息密度低的短片。逐字点亮（`glyph`）在 30fps 下会看到台阶 |
| `crf` | 18 | 12 起体积翻倍、肉眼无差；24 以上深底渐变会出色带 |

## 六、容量纪律

超容量一律抛 `DIAGRAM_CAPACITY`，不缩字号硬塞：

- 标题超 2 行 → 报错（改标题，别缩字）
- 节点标签超 12 字 → 报错
- `hierarchy` 根节点不是恰好 1 个 → 报错
- `data-bar` / `data-line` 的 value 不是数字 → 报错

`validateDiagram()` 在出片前先跑一遍，`render.mjs` 会把它挡在 ffmpeg 之前。

## 七、还没做

- 全文使用 `--params kits/diagram/presets/all.json` 出全量验证片（13 段 / 84s）。
- 图标：上游有 102 个程序化图标，这里一个都没有 —— `process` / `hierarchy`
  目前是纯文字节点。要上图标得先定"哪些概念必须配图"，否则会变成图标墙。
- 多进程分片：现在是单进程，26s 的片 6.9s 出完。上产线再接
  `src/pipeline.mjs` 的 `planShards`。
- ~~开场运动偏小~~：`introFade 0.7` + 首屏标签在 0.4s 立住之后，`hook` 到 0.15–0.18，
  过阈值 0.10。图示段本身的细动效在 64×36 灰度下仍然等于静止，靠的是整屏揭幕。
