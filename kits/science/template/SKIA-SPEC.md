# 科普版式 · Skia 直出实现

> 参考片：`d6ef49c88c4766217c388678d9ba7aca_raw.mp4`（153.64s / 960×544 / 28fps / 4302 帧）
> 信息语法蒸馏见 [SPEC.md](SPEC.md)：48 切点 / 中位镜头 2.75s / 讲解 37% + 图解 33% + 标签 10%
> 本文只讲一件事：**同一套版式怎么在 Skia 上跑，代价与收益各是多少**。

---

## 一、结论

| 指标 | canvas / Chrome | Skia / @napi-rs | 差异 |
|---|---:|---:|---|
| 79.0s 片（2369 帧，姿态图 + 手势 + 口型） | 24.21s / 98 fps | **13.2s / 179 fps** | 快 83% |
| 73.8s 片（2215 帧，无机口型） | 14.37s / 154 fps | **11.3s / 196 fps** | 快 27% |
| 54.5s 片（1635 帧，无声 demo） | 10.24s / 160 fps | **8.5s / 192 fps** | 快 20% |
| 峰值内存 | 6 路 Chromium，未单独测 | 8 worker 1.34GB / 20 worker 2.78GB | 进程数从 6 个浏览器降到 1 个 node |
| 输出体积 | 7.91MB | 6.98MB | −12% |
| 画面差异 | 基准 | MAE 2.90/255、PSNR 23.8dB | 见 §四 |

三档数据的差别在于人物层怎么画：**位图姿态图（drawImage）在 Skia 上比矢量路径快得多**，而 Chrome 那条"GPU 绘制 + 截图回读"的路子对位图并不便宜（83% > 59% > 27% > 20%）。早期 15.2s 那一版是因为 Skia 侧没加载姿态图、退回矢量人物，反而更慢。

**这不是 6.9 倍那种提速**。`skia-kit` 的 paper 版式能从 56 fps 跑到 388 fps，是因为那张片是纯色底 + 少量文字，瓶颈全在 Chrome 的截图 IPC 上。科普版式反过来：格子纸、手绘器官、爆炸贴、描边字、卡片阴影都是栅格化密集型，两边各有便宜可占。

净收益是工程性的：**一条命令、零浏览器、零字体依赖、内存可控、结果确定**。速度只是顺带。

---

## 二、做法：移植，不是重写

`templates/own/science-explainer/src/` 里是两个 IIFE：`kit.js`（绘图原语 + 图标库，888 行）和 `layouts.js`（9 个版式，890 行）。它们只依赖 `window.MK` / `window.L` 和 Canvas 2D API，**没有一处 `ctx.filter`、没有 blend 模式**。

所以 `skia-kit/science.mjs` 不做重画，只做宿主替换：

```
浏览器宿主                          Skia 宿主
─────────────────────────────      ─────────────────────────────
window 对象                        new Function('window', src)(win)
document.getElementById('c')       createCanvas(1920, 1080)
new Image() + onload               loadImage()（await 后写入 __MK_IMAGES）
PingFang / Hiragino（系统字体）     Noto Sans SC 三档，按字重映射
window.renderFrame(frame, inputs)  renderFrame(t)，段轴为 t0/t1
```

版式代码逐字不动 —— 这是保真的前提。同一份源码在两边跑，不存在"照着重画"的漂移。

### 改到原文件的只有三处，且都是加法

| 位置 | 改动 | 浏览器端影响 |
|---|---|---|
| `kit.js` 字体常量 | 加 `fontCss()` / `familyOf()`，读 `window.__FONTS` | 未注入时输出与原来**逐字一致** |
| `kit.js` 的 `paper()` | 拆成 `paintPaper()` + 缓存包装，读 `window.__createCanvas` | 未注入时走原路径 |
| `kit.js` 的 `heavy` 描边 | 已选 Black 字重时不再叠加同色描边 | `familyOf().bold` 恒为 false，等价 |

回归实测：改动后重跑 canvas 版，与旧成片同帧比对 **MAE 0.00 / maxdiff 0**（逐像素不变）。

---

## 三、字体是关键，规则如下

`@napi-rs/canvas` 不做 weight 合成：写 `700 54px "Noto Sans SC"` 不会自动选到 Black。所以必须把"字重"翻译成"字体族"。

但直接 `700 → Black` 会翻车 —— 原设计里 700 用的是 PingFang **SemiBold + 2.2px 同色描边**（PingFang 最粗只到 SemiBold，靠这层膨胀补到 Black 的视觉重量）。换成真 Black 再叠描边，字幕会糊成一团（实测：笔画缝隙消失，20 字里 6 字粘连）。

最终规则按**字号**分流：

```js
w >= 800                      → NotoSC Black
w >= 700 且 字号 >= 64px       → NotoSC Black（大标题本来就该最重）
w >= 700 且 字号 <  64px       → NotoSC Medium + 保留原 heavy 描边
w >= 500                      → NotoSC Medium
其余                          → NotoSC Regular
```

64px 这条线是按实际用途定的：封面 148 / 讲解位 84 / 便签标题 68 走 Black；字幕 62 / 卡片标题 54 / 正文 44 走 Medium + 膨胀，正好复现原设计。

代价：Noto 与 PingFang 的字面宽度差 1–3%，长文案的居中线会轻微移动（见 §四 outro 色块宽度差 4px）。

---

## 四、保真度

### 4.1 全片像素差（9 个时间点，覆盖全部 9 版式）

| 指标 | 值 |
|---|---|
| 平均 MAE | 2.90 / 255（1.14%） |
| 平均 PSNR | 23.82 dB |
| 显著差异像素（灰阶差 > 40） | 1.82% |

PSNR 20 出头听起来低，但对"换了字体的矢量重绘"是正常值 —— 1.8% 的差异像素几乎全在文字笔画边缘，背景与图形是逐像素对齐的。

### 4.2 关键元素坐标（客观测量，非目测）

| 版式 | 元素 | canvas | Skia | 差 |
|---|---|---|---|---|
| tip | 便签包围盒 y | 103–419 | 103–419 | **0** |
| tip | 便签覆盖率 | 30.3% | 30.2% | 0.1pp |
| outro | 主色块 y | 130–386 | 130–386 | **0** |
| outro | 主色块宽 | 308 | 312 | 4px（1.3%） |

### 4.3 已验证的版式

cover / talk / compare / diagram / matrix / focus / tip / outro 全部对齐；含双引线标注的 diagram、含 `itemAt` 逐条点亮的 tip/matrix 均正常。

---

## 五、性能是怎么来的

单帧成本拆解（1920×1080，本机 M 系 30 核）：

| 阶段 | 成本 |
|---|---|
| 纯绘制调用（Skia 记账，延迟执行） | 0.5–1.4ms |
| 触发栅格化 + 读回 RGBA（`canvas.data()`） | 10–16ms（封面 45ms，元素最多） |
| x264 编码（veryfast / crf20 / 1080p） | 主体剩余部分 |

关键认知：`renderFrame()` 里的绘制调用是**记账**，真实代价在 `canvas.data()` 时结算。所以"绘制只要 1ms"是假象。

试过但没用的优化：

| 尝试 | 结果 |
|---|---|
| 静态纸底缓存成离屏位图 | 16.0s → 15.9s（+0.6%），瓶颈不在背景 |
| `--pipe jpeg`（少传 8.3MB/帧） | 17.3s，更慢（JPEG 编码在 JS 线程） |
| `--x264-threads 2/4` | 11.7s 不变（1080p 单帧帧内并行度有限） |
| `--preset ultrafast` | 9.7s 但体积 25.3MB（6 倍），不采用 |

真正有效的只有**并行度**：

| workers | 1635 帧耗时 | 吞吐 |
|---:|---:|---:|
| 6 | 12.4s | 132 fps |
| 8 | 11.6s | 141 fps |
| 12 | 9.5s | 172 fps |
| 16 | 8.8s | 186 fps |
| 20 | **8.5s** | **192 fps** |

默认 8 是保守值（`min(8, cpu)`）；这台机器上 20 才是拐点。worker 数上去后分片变多，GOP 重置次数增加，体积从 4.10MB 涨到 5.06MB —— 想要更小就用 8 worker。

---

## 六、怎么用

```bash
# 一条命令出片（params 支持 scenes[] 或 segments[] 两种结构）
node skia-kit/render.mjs --kit science \
  --params templates/own/science-explainer/presets/demo.vo.json \
  --audio /path/to/vo.m4a \
  --out out/film.mp4 --fps 30 --workers 20

# 单帧探针（调版式时用，秒级）
node skia-kit/render.mjs --kit science --params <json> --out /tmp/x.mp4 \
  --probe /tmp/f.png --at 12.5

# 交付门禁
node skia-kit/gate.mjs out/film.mp4
```

换内容只改 preset：`captions`（口播）+ `segments`（版式序列）+ `theme`（6 个强调色）+ `brand`（角标）。`tools/vo.py` 可以用配音反推时间轴，产出的 `*.vo.json` 直接喂给上面的命令。

实测已跑通三套内容：

| preset | 时长 | 帧数 | 耗时 | gate |
|---|---:|---:|---:|---|
| `demo.edge.json`（儿科超声 · edge-tts 新配音） | 79.0s | 2369 | 15.2s | PASS |
| `demo.vo.json`（儿科超声 · 旧配音） | 73.8s | 2215 | 11.3s | PASS |
| `kids-qa.vo.json`（肚子咕咕叫） | 65.3s | 1959 | 12.0s | PASS |
| `demo.json`（无声） | 59.1s | 1773 | — | — |

---

## 七、配音驱动动效（本轮修复）

模板原先的 `itemAt` 只在「句子数 == 条目数」时写入，于是两类文案会退化成「条目一次性全亮」：

| 文案形态 | 例子 | 修复方式 |
|---|---|---|
| 引入句 + N 条 | 「记住三点」+ 三条要点 | 条目对齐**后** N 句；多出的 1 句视为引入 |
| 一句列举 N 项 | 「阑尾炎、肠套叠、胆囊炎、肾结石」 | 按顿号/逗号切分，按各段字数比例分配语音区间 |

第二类不依赖词级时间戳：中文朗读匀速，等长词的误差 < 0.1s，实测四个病种的点击间隔为 1.00 / 0.99 / 1.00s。

还有一个更隐蔽的坑：`layouts.js` 的 `enter()` 带 **0.82 的入场下限**（为硬切首帧准备，保证首帧不是"缩成一点"），因此它**永不返回 0**，`if (k <= 0) return` 形同虚设 —— 未到时间的图标照样会画出来（只是小一号）。修复是显式判 `t < at` 直接跳过。

验证序列（`presets/demo.edge.json`，matrix 段）：

| 时间 | local | 已出现图标 | 已点亮标签 |
|---|---:|---:|---:|
| 35.6s | 0.31 | 0 | 0 |
| 36.9s | 1.61 | 2 | 1 |
| 38.0s | 2.71 | 3 | 2 |
| 39.1s | 3.81 | 4 | 4 |

tip 段同理：三帧分别只亮第 1 / 第 2 / 第 3 条，且与「第一…」「第二…」「第三…」字幕逐句对齐。

---

## 八、人物层：姿态图、手势、口型

这一层有个不显眼但会让人"以为模板坏了"的坑。

### 8.1 Skia 侧必须自己喂姿态图

`layouts.js` 的取图逻辑是：

```js
function collectFigures() {
  if (typeof document === 'undefined') return;   // ← Skia 下直接 return
  document.querySelectorAll('img[data-fig]').forEach(...);
}
```

浏览器靠 `index.html` 的 `<img data-fig="idle" src="../assets/figures/idle.png">` 收集四张姿态图；Skia 没有 DOM，这段直接跳过，于是 `FIGS` 永远为空 —— **人物静默退化成矢量版**，两条路径出来的不是同一个形象，而且不会报错。

修复在 `science.mjs`：`primeFigures()` 直接把 `assets/figures/{idle,explain,point,open}.png` loadImage 进 `window.__MK_FIGS`，`ready()` 会等它完成。`@napi-rs/canvas` 的 Image 自带 `naturalWidth/naturalHeight/complete`，与 `drawImage` 分支兼容。

顺带一个反直觉结论：**姿态图在 Skia 上比矢量人物更快**（2369 帧 15.2s → 13.2s）。位图是 `drawImage` 一次，矢量人物是几十条路径 + 描边。

### 8.2 手势

`gesture` 决定用哪张姿态图，`gestureAt`（默认 0.9s）起做交叉淡入：

| 手势 | 姿态图 | 语义 |
|---|---|---|
| `idle` | idle.png | 站定 |
| `explain` | explain.png | 单手比划（讲机制） |
| `open` | open.png | 双手摊开（提问 / 铺陈） |
| `point` | point.png | 指向（强调结论） |
| `count` | explain.png | 数点（列举） |
| `nod` | idle.png | 点头（叠加在 idle 上） |

`demo.edge.json` 的两个讲解位分别用 `open`（"家长最常见的困惑"）与 `point`（"记住这一句"），实测手势与左侧文字区不重叠。

**`figureHeight` 要跟着素材走**：矢量人物 0.86 合适，3D 姿态图建议 **0.92–0.96** —— 0.86 时头顶距上沿约 0.22H，人物明显"沉"在画面下半部。

### 8.3 口型

姿态图是 3D 渲染的，矢量嘴形覆盖会穿帮。现在的做法是用 `vo.py` 产出的**逐帧 RMS 包络**（`mouthCurve`）驱动头部起伏与轻微缩放，即"说话时的身体节奏"，而不是精确口型。真正的口型需要口型序列素材，属已知限制。

---

## 九、字幕容量与折行

62px 的字幕在 1660px 安全宽内大约放 **26 个汉字**，这是单行的舒适上限。

原来的实现是「整句超宽就把字号一路缩小」——45 字的句子会被压到 37px，手机上基本读不了。现在的策略是：

| 句子长度 | 处理 |
|---|---|
| ≤ 26 字 | 单行 62px，与改动前**逐像素一致** |
| 27–~44 字 | 按标点折行（取最靠近中点、且两行都放得下的断点），字号降到 50px |
| 更长的句子 | 折行后继续缩，44px 为下限（再小就不值得读） |

两个必须一起处理的细节：

1. **两行必须统一字号**。逐行各自套 `maxW` 会缩出两种大小，观感是"一句话里字忽大忽小"。
2. **判安全区要用视觉顶端，不能用基线**。中文字形在基线上方约 0.78em，直接拿基线判会差出 45px —— 第一版就踩了这个坑，两行字幕顶到封面的黄色标签上。现在按 `基线 − (行数-1)×行距 − 0.78×字号` 判，低于 0.88H 就整体下移。

行距：单行 1.32，两行收紧到 1.22（44px 时两行不粘连）。

`vo.py` 会在配音阶段检查：超过 26 字的句子打印告警并列出前 24 字，提示拆句。**折行是兜底，不是设计** —— 它会让 cover / tip 这类底部本来就有内容的版式变挤。

---

## 十、边界

1. **不含配音与配乐**。模板只出画面，`--audio` 传音轨。
2. **字体固定为随包的 Noto Sans SC 三档**。换字体要重跑 §三 的映射规则，字号会变（字面宽度不同）。
3. **只支持横屏 1920×1080**。竖屏要重排版式，不能裁切。
4. **需要 `--kit science`**。默认仍是 paper 版式（`skia-kit/tokens.json` 那套几何），两者共用同一个 CLI 与编码管线。
5. 器官图形是矢量示意，不是医学精确图。
