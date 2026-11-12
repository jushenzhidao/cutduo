# 复刻一个 motiongit 新模板：可重复的流程

> 目标不是“做得像”，是**可验证地像**：每个元素有坐标、每次改动有回归、每条结论有数字。
> 本文以 `paper-perspective`（纸面口播）为例，全流程约 4 小时；换版式家族约 2–6 小时。

## 0. 先判：这个模板要不要复刻

复刻的成本是 2–6 小时 + 后续维护；收益是**出片速度**和**可批量**。先算账：

| 情况 | 建议 | 理由 |
|---|---|---|
| 一次性品牌片 / 客户点名要原版 | **直接跑模板** | 复刻省不下时间，还丢授权边界 |
| 每月 ≥10 条，版式固定、只换文案 | **Skia 重写** | 274s → 6s，单条成本降两个数量级 |
| 版式常变、要调参数试效果 | **包装原模板**（脚本化参数 + 批处理） | 保留设计灵活性，别急着重画 |
| 依赖粒子 / 3D / 视频素材 / 复杂 shader | **不复刻** | Skia 2D 画不出来，投入产出不成比例 |

判据一句话：**你会在同一个版式上出 10 条以上，且不需要逐条微调设计，才值得复刻。**

先看模板的 `motion.json`：

```bash
unzip -p template.motion motion.json | jq '{runtime, output, parameters}'
```

- `runtime.profile = html-canvas/1`：页面 + 参数，可用 Chromium 直接批量跑，通常**不用复刻**
- `runtime.profile = motion-kit / film-kit`：闭源运行时，才需要“照着成片重画”
- `output.durationPolicy = fixed`：时长写死，复刻时反而要改成跟随配音

## 1. 取参考片（一切测量的前提）

复刻的输入不是模板包，是**成片**。用你自己的文案跑一遍原模板，拿到 1080p 参考片：

```bash
# 模板路线（示例：motion-kit）
./templates/vendor/paper-perspective/run-tpl.sh          # 产出 out/ab3/tpl.mp4
```

要求：
1. **同文案、同分辨率、同帧率**——否则字号和位置没有可比性；
2. 记下每个分镜的 `t0/t1`（来自你传给模板的 params）；
3. 抽帧时间取**镜头中段**（动画已稳定），不要取转场。

```bash
ffmpeg -ss 2.5 -i tpl.mp4 -frames:v 1 -q:v 1 hero.jpg
```

## 2. 标定字体（90% 的“不像”出在这一步）

先验证渲染器到底用了什么字体，别信配置：

```js
GlobalFonts.registerFromPath('/System/Library/Fonts/PingFang.ttc', 'PingFang SC');
GlobalFonts.has('PingFang SC')      // false —— @napi-rs/canvas 对 PingFang.ttc 静默失败
g.font = '800 152px "PingFang SC"';
g.measureText('一').width            // 118.2 = 0.78em，正常 CJK 应为 1.00em
```

用**墨迹宽高**反解字号，不要用 `font-size` 猜：

```js
// 参考片里量到首行墨迹 936×129
for (const s of [120, 124, 126, 128]) {
  const r = ink('一条片子做三天，', `900 ${s}px "NotoSC Black"`);
  // 126 → 932×129  ← 命中
}
```

字体选型：思源黑体家族（Noto Sans SC / Source Han Sans）覆盖绝大多数中文模板；
字重按墨迹厚度选（模板标题多为 Heavy/Black）。字体文件不进 git，用 `./fetch-fonts.sh` 拉。

**判据**：同字号下墨迹宽高与参考片相差 ≤2%，才算标定完成。

## 3. 量版式（工具化，别用眼睛）

```bash
uv run --with numpy --with pillow --with scipy python skia-kit/tools/measure.py \
  --video out/ab3/tpl.mp4 \
  --times 2.5,8.5,14.5,19.8,25,30.5,35,40 \
  --names hero,point,number,compare,steps,quote,checklist,outro \
  --out out/measure/skia-kit
```

输出（真实结果）：

| 场景 | 底色 | 墨色 | 强调色 | 文字行带 (y/h) | 头像框 | 字幕条 | 锐度 |
|---|---|---|---|---|---|---|---|
| hero | #EFEFE5 | #152319 | #328E6F | 285/21 / 346/272 | 1264,73 472×803 | 520,930 880×70 | 2.75 |
| number | #EFEFE5 | #18251B | #288868 | 153/580 | 1264,73 472×802 | 410,930 1100×70 | 2.56 |
| quote | #EFEFE5 | #152319 | #248869 | 180/68 / 328/83 / 447/80 / 716/30 | 1264,73 473×802 | 586,930 748×70 | 2.57 |

读法：
- **行带 y/h** = 每个文字块的墨迹顶与高度 → 直接给 `tokens.json` 的 `titleY/size/pitch`；
- **segs x/w** = 同一行被拆成几段 → 判断是否多栏（compare 的左右栏就是这样发现的）；
- **avatar/caption** = 常驻元素的位置尺寸；
- **sobel** = 目标锐度，出片后要拿它对自己的成片比一遍。

工具只量“墨迹矩形”，量不出圆角和弧线。遇到圆环/表盘，补一步最小二乘拟合（见 `paper.mjs` 里
`number` 的 r=265/237、`checklist` 的 R=330 —— 都是拟合出来的）。

**适用边界（实测）**：`measure.py` 假设「纯色底 + 单色字」。纸面这类模板命中率 100%；
换成宣纸手卷（promo-ink，纹理铺满全屏）时主色只占 24.8%，行带会糊成一片——脚本会告警。
这类模板加 `--light-text` 也未必够，改用**定点裁剪 + 人工框选**：先裁出标题/正文的小图，
再对小块跑同一套阈值，比全画面投影稳。

## 4. 写版式（一个场景一个函数）

在 `skia-kit/paper.mjs` 里加 `pXxx(t, args)`，然后在 `renderPaper` 的 switch 注册：

```js
function pDemo(t, a) {
  paperBg();
  const chars = parseRichChars(a.title || '');
  const f = `900 ${fitSize(a.title, 126, 1356, v => `900 ${v}px ${PF.black}`)}px ${PF.black}`;
  drawChars({ chars }, T.hero.x, T.hero.titleY + inkAsc(a.title, f), f, PK.ink, BLUE,
            charsWidth(chars, f) * eo(pr(t, a.at, a.at + 0.5)));  // 遮罩揭示
}
```

三条硬规则：
1. **入场动画**用 `pr(t, at, at+dur)` 的裁切宽度实现（`drawChars` 的 `clipW`），不要改透明度了事；
2. 所有常量先落 `tokens.json` 再引用，方便自检和后续调；
3. 文字必须走 `fitSize`，宁可小一号也不裁字（模板会裁，但那是缺陷不是设计）。

## 5. 自检（把“像不像”变成断言）

```bash
node skia-kit/verify.mjs
```

八项坐标 + 底色 + 安全区 + 动画活性，超差退出码 1。常见超差原因：

| 现象 | 原因 | 修法 |
|---|---|---|
| 整体偏右 5–15px | 字体左侧边距不同 | 用 `textLeft` 对齐，不要按 `x` 对齐 |
| 高 1px / 矮 1px | 字号差 2px | 按墨迹高度反解，别按宽度 |
| 只有某一行偏 | 该行有标点/数字，ascent 不同 | 每行独立 `inkAsc`，别共用 basline |
| 锐度比 <0.9 | 字体回退 / JPEG 质量低 | 查 `GlobalFonts.has`，提 `--jpeg`/降 `--crf` |

## 6. 出片与基准

```bash
node skia-kit/render.mjs --params params.json --audio voice.m4a --out out/v1.mp4 --fps 60
python3 qa-gate.py --video out/v1.mp4 --expect-frames <帧数>
```

- `--crf 20`：42.9s 片约 2.8MB；`--crf 16` 更稳但 +30% 体积
- **首渲用 kit CLI，改稿重渲用 `--incremental`**：按分镜切段编码会白白多花 1.8× 码率
  （实测 826kbps vs 367kbps，画质无差）

## 7. 对抗审查清单（交付前逐条打勾）

1. **字体**：`GlobalFonts.has()` 为真；换机器重跑 `fetch-fonts.sh` 后字号不变
2. **缓存 key**：包含渲染器代码指纹，改代码不会命中旧段
3. **worker 参数**：主题/皮肤/输入路径随 `workerData` 下发，且有回报校验
4. **安全区**：所有文字距边 ≥64px，页脚对比度 ≥4.5:1
5. **锐度**：8 场景 sobel 与参考片比值在 0.93–1.05
6. **音画**：帧数 = round(时长×fps)，`qa-gate` 无黑帧/重复帧
7. **可读性**：卡片/胶囊内文字不裁切（模板裁字要主动修）
8. **授权**：模板内容受保护，复刻只用于自有产线，不二次分发

## 8. 成本与边界（诚实版）

| 版式家族 | 预估 | 说明 |
|---|---|---|
| 纯排版（标题/正文/列表） | 2–3h | 量 + 写 + 自检，一次到位 |
| 含图形（圆环/仪表/时间轴） | +1–2h | 要拟合圆、算角度 |
| 含纹理/纸纹/遮罩 | +1h | 程序化噪点要固定种子 |
| 含粒子/3D/视频素材 | 不建议 | Skia 2D 不划算，直接用原模板 |

复刻后维护成本主要在**字体与编码**：换字体要重标字号，换码率要重测锐度。
`verify.mjs` 和 `qa-gate.py` 就是为此存在的——它们让“看起来一样”变成“测得出来一样”。

## 附：一次真实的时间线（skia-kit）

| 步骤 | 耗时 | 备注 |
|---|---|---|
| 取参考片 + 抽 8 帧 | 10 min | 已有模板渲染脚本 |
| 字体标定 | 40 min | 发现 PingFang 假注册，换 Noto |
| 量 8 个场景 | 50 min | 手写脚本，现已工具化（`measure.py`） |
| 写 8 个版式 | 90 min | 一半时间在圆环/表盘拟合 |
| 自检 + 修偏差 | 40 min | 从 ±20px 收敛到 ±5px |
| 出片 + QA | 10 min | 6.1s 出片，QA 全 PASS |
| **合计** | **≈4h** | 之后每条新片 2 分钟 |
