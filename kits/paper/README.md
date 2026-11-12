# paper · 纸面口播版式（Skia，无浏览器）

把 motion-kit《paper-perspective》的 8 个版式按成片**逐像素反推**后重写成的可复用模板。
渲染只用 `@napi-rs/canvas`（Skia）+ ffmpeg，不需要 Chromium/Playwright。

- 1920×1080 @60fps，跟随配音时长
- 8 个版式：`hero` `point` `number` `compare` `steps` `quote` `checklist` `outro`
- 科普版式是独立的一支（`kits/science`），同一渲染库，见 `kits/science/template/SPEC.md`
- 常驻头像卡、烧录字幕、右上时间码、`*强调词*`、自动折行、字号自适应
- 全片 42.9s / 2573 帧，**6.1s** 出片（8 worker），峰值内存 < 1GB

> 位置：`kits/paper/`。对外的入口是仓库根的 `render.mjs --kit paper`。
> 相对路径先按 cwd、再按仓库根解析，所以在任意子目录里跑都能找到同一份文件。

## 30 秒上手

```bash
bash tools/fetch-fonts.sh           # 首次：拉 Noto Sans SC 三个字重（OFL）
node render.mjs --kit paper \
  --params kits/paper/presets/v8t.json \
  --audio  assets/audio/audio-v8t.m4a \
  --out    out/demo.mp4
```

自检（量墨迹、比模板实测坐标，容差 8px）：

```bash
node src/verify.mjs                   # 8 项几何 + 底色 + 安全区 + 动画
```

## 换一条新片

模板只管“画”，时间轴由你自己的脚本决定。最短路径：

```bash
# 1) 写 8 句旁白（每段一句），选音色，自动按真实语音时长重排分镜
cat > /tmp/lines.json <<'EOF'
["一句话说清一件事。", "先给结论，再给证据。", "一页只讲一个观点。", "结构比信息量重要。",
 "四步骨架：问题、结论、证据、行动。", "记住的不是信息，是结构。", "发布前三问。", "改一份文案就能再做一期。"]
EOF
uv run python tools/build-sync.py --voices /tmp/lines.json \
  --scenes content/inputs-v2.json --prefix mine --voice zh-CN-XiaoxiaoNeural

# 2) 出片（build-sync 产出 24fps 的 inputs；要 60fps 加 --fps 60）
node render.mjs --kit paper --params content/inputs-mine.json --audio assets/audio/audio-mine.m4a \
  --out out/mine.mp4 --fps 60

# 3) 验收
uv run python tools/qa-gate.py --video out/mine.mp4 --expect-frames <帧数>
```

> `build-sync.py` 产出的 `inputs-*.json` 就是本模板的 params，字段见下。

## params 结构

```jsonc
{
  "fps": 60,
  "durationSeconds": 42.886,
  "captions": [{ "start": 0.4, "end": 4.72, "text": "一条片子做三天，一半时间不在做，在等。" }],
  "scenes": [
    { "type": "hero", "t0": 0.35, "t1": 5.32,
      "args": { "lines": [["一条片子做三天，", 0.715], ["一半时间*在等*", 1.812]],
                "sub": "// 制作效率 · 改稿成本" } }
  ]
}
```

| 类型 | args | 说明 |
|---|---|---|
| `hero` | `lines:[["文案", 入场秒]]`, `sub` | 眉标 + 两行大标题；`*词*` 走强调色，带遮罩揭示 |
| `point` | `words:[["文案", 秒]]`, `cards:[["文案", 秒]]` | 大弧 + 关键词（强调词带底纹和下划线）+ 下方正文 |
| `number` | `label, value, unit, from, dur, sub, at` | 双环 + 数字滚动 + 说明 |
| `compare` | `left:{title,items[]}`, `right:{...}`, `leftAt, rightAt` | 左栏左对齐、右栏右对齐，中缝 VS |
| `steps` | `title`, `steps:[["文案", 秒]]` | 时间轴 + 白色卡片（未到场的显示幽灵态） |
| `quote` | `lines:["行1","行2"]`, `by, at` | 引号 + 逐字打字机 + 落款 |
| `checklist` | `title`, `items:[["文案", 秒]]` | 仪表盘 + 指针扫动 + 大数字 |
| `outro` | `title, lines[], prompt` | 纵向拉伸大标题 + CTA 胶囊（`prompt` 为空则不画） |

完整字段校验见 `params.schema.json`。

## 可调项（tokens.json）

`tokens.json` 是模板的几何规格，全部数值来自模板成片的墨迹测量。

运行时**生效**的字段：

| 字段 | 作用 |
|---|---|
| `palette` | 底色 / 墨色 / 强调色 / 正文灰 / 字幕条 |
| `fonts` | 三个字重的 family 名（换成别的字体需自行校准字号） |
| `avatarBox` | 头像卡位置尺寸 `{x,y,w,h,r}` |
| `margin` | 版心左边距（hero / point 之外的标题用它） |
| `presenterLabel` | 头像卡左上角胶囊文案 |
| `--theme clean` | 运行时主题：只换 palette（白底/中性正文/实心字幕条），几何一个不动 |
| `--avatar off` | 不画人物卡；此时右侧改画「本章关键词卡」（取 `args.cast`，无则退回 `args.title`） |

其余字段（各版式的锚点、字号、半径、卡片尺寸）是**锁定的版式**：改它们等于改设计，
改完请跑 `verify.mjs`，并把 `verify.mjs` 里的期望值一起更新。

## CLI

```
node render.mjs --kit paper --params <json> --audio <m4a> --out <mp4>
  [--fps 60] [--workers 8] [--crf 20] [--jpeg 94] [--preset veryfast]
  [--avatar edits/assets/avatar.png|off] [--probe out/frame.png --at 2.5]
  [--kit paper|science] [--x264-threads 1]
```

- `--crf` 默认 20：42.9s 片 ≈ 2.8MB / 540kbps（视频 367 + 音频 160），100% 裁切看不出压缩痕迹
- 想更小：`--crf 23`（≈2.2MB）；想更稳：`--crf 16`
- `--workers` 默认 `min(8, CPU)`；单 worker 也能跑，只是慢

## 动效清单

所有入场都在 0.2–1.0s 内收完，**p=1 时 transform 归零、alpha=1**，所以落版几何与模板逐像素一致，
`verify.mjs` 的 8 项坐标量的是「静止态」，不受动画影响。

| 版式 | 动效 |
|---|---|
| 全局 | 字幕条上浮 9px + 淡入（0.22s）；时间码、头像卡静置 |
| `hero` | 遮罩从左揭示 + 整行上浮 18px；强调词揭示完成后画一道 6px 强调色横线（0.38s，easeInOut） |
| `point` | 背景大弧按角度长出（0.9s）；标题上浮 14px + 遮罩；强调词荧光底扫过 + 下划线 |
| `number` | 外环从 0.9 倍半径扩到原位；36 条刻度随进度逐条点亮；数字 easeOutQuart 滚动 |
| `compare` | 左栏从 −26px、右栏从 +26px 滑入；VS 从 0.86 倍弹到 1 倍；`strikeAt` 起一道强调色横线扫过左栏标题 |
| `steps` | 节点激活时外扩涟漪（0.4s 消隐）；卡片 0.94→1 倍弹出 + 上浮 12px；连线按进度生长 |
| `quote` | 大引号 0.88→1 倍淡入；逐字打字机 + 柔和脉动光标（只出现在正在打的那一行） |
| `checklist` | 指针扫动 + 白弧；25 条刻度随进度点亮；当前条目上浮 10px |
| `outro` | 标题纵向拉伸遮罩；副文案 / CTA 依次上浮；CTA 箭头每 2s 前推 3px |

代价：同一片体积 2.75MB → 3.06MB（+11%，614kbps），出片时间不变（5.2→5.3s）。

**转场**：默认硬切（`--transition cut`）。另有 `--transition wipe --transition-dur 0.26` 可选，
做法是竖向擦除（每个像素只属于一个镜头），**不要用溶解** —— 两张 126px 标题在同一位置交叠，
中段读不出字（实测见 `out/probe-cut/strip-cut.png` 与 `strip-wipe.png`）。硬切是默认值，
且与加转场前的成片 **md5 完全一致**（零回归）。

## 氛围层：生成素材怎么接（以及为什么慎用）

模板的输出是「信息层」，生成模型能补的是「氛围层」。三个接口都默认关闭，不影响现有出片：

| 接口 | 用法 | 结论 |
|---|---|---|
| `bgImage` + `bgWash` | `createPaperRenderer({ bgImage, bgWash })` 把生成底图垫在最底层，再压一层纸色蒙版 | **慎用**。要保住正文 WCAG 4.5，wash 必须 ≥0.82，那时纹理只剩原图 6%，等于白做 |
| `transparentBg` | 只画字幕条/时间码/头像卡，底透明 | 生成素材的**整屏插入**走这条：`overlay-pass.mjs` 出帧 → ffmpeg overlay |
| `broll` 分镜类型 | 不画正文、只出字幕与头像卡 | 空镜插片只需要一条旁白，时间轴不破 |

**实测（`tools/bg-probe.mjs`，生成纸纹底图 1920×1080）**

| wash | 底色亮度 | 纹理 σ | vs 标题 | vs 正文 |
|---|---|---|---|---|
| 0 | 0.559 | 0.047 | 9.47 | 3.29 ✗ |
| 0.72 | 0.763 | 0.030 | 12.63 | 4.39 ✗ |
| 0.82 | 0.799 | 0.029 | 13.18 | 4.58 ✓ |
| 0.90 | 0.829 | 0.029 | 13.65 | 4.75 ✓ |

纹理强度与文字对比度是同一个变量的两端，`bgWash` 就是这个变量 —— 保可读，纹理必被压没。

**空镜插入的工程代价（5s 生成素材实测）**：源 1344×768 / 24fps / 带平台水印，需裁水印、
1.43× 上采样、24→60fps 转帧；纸色 184,178,162 与模板 238,238,228 差一截，不调色直接剪会跳；
同样 5 秒，生成素材 1.45MB（2.3Mbps）而模板图文 0.39MB（0.63Mbps），码率 3.7×。

## 实测

| 项 | 值 |
|---|---|
| 出片 | 2573 帧 / 42.886s / 60fps / 6.1s（8 worker） |
| 单帧 | 2.4ms 绘制 + 编码 |
| 体积 | 2.76MB / 540kbps（CRF 20） |
| 峰值内存 | < 1GB（浏览器链路 9.7GB） |
| 版式偏差 | 8 个关键元素 ≤5px（`verify.mjs` 输出） |
| 边缘锐度 | 模板的 0.972（8 场景均值） |
| QA | 0 黑帧 / 0 重复帧 / 音画对齐 |

## 与 motion-kit 原片的差异

1. **steps 卡片文字不裁切**：模板 200px 卡片硬排 44px 字，末字会被卡片边缘裁掉；
   这里按卡宽自适应并居中（实排 35px，左右各 29px）。
2. **`*强调词*` 渲染成强调色**：模板会把星号原样印出来。
3. 头像取景差约 3%（同一张素材，取景中心不同）。
4. 入场曲线（遮罩 0.52s / 打字机 1.1s）是按帧反推的近似。

## 目录

```
kits/paper/
  paper.mjs          渲染器（createPaperRenderer / loadTokens）
  tokens.json        几何规格 + 可调项
  params.schema.json 参数 schema
  presets/v8t.json   示例参数（v8 文案）
  README.md          你正在看的

src/fonts.mjs        字体注册（全仓唯一实现，paper 在此 re-export）
render.mjs           出片 CLI，仓库根，--kit 分发到本目录
```

## 复刻另一套新模板

完整流程见 [`REPLICATION.md`](../../docs/REPLICATION.md)：取参考片 → 标定字体 → 量版式（`tools/measure.py`）
→ 写版式 → `verify.mjs` 自检 → 出片 → 对抗审查。含成本估算与“哪些模板不值得复刻”的判据。

```bash
uv run --with numpy --with pillow --with scipy python tools/skia/measure.py \
  --video ref.mp4 --times 2.5,8.5 --names hero,point --out out/measure/new-kit
```

## 校准方法（换字体/换分辨率时）

1. 从参考片抽一帧 → 与底色求差 → 行/列投影 → 得到每个文字块与图形的墨迹包围盒；
2. 用 `canvas.measureText` 反解字号（同字重下墨迹宽高与字号近似线性）；
3. 把锚点写进 `paper.mjs` 对应版式，跑 `verify.mjs` 把期望值调到实测值；
4. 换分辨率时按 1920×1080 等比缩放，字号需重新拟合（`fitSize` 会兜底）。

字体是这套版式的命门：`@napi-rs/canvas` 对 `PingFang.ttc` 的注册会**静默失败**
（`GlobalFonts.has('PingFang SC') === false`），回退字体的字面窄 22%、笔画轻一档，
锐度和排版会同时跑偏。务必用 `registerFonts()` 注册随包的 Noto Sans SC。
