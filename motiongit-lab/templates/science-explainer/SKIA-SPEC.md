# 科普版式 · Skia 直出实现

> 参考片：`d6ef49c88c4766217c388678d9ba7aca_raw.mp4`（153.64s / 960×544 / 28fps / 4302 帧）
> 信息语法蒸馏见 [SPEC.md](SPEC.md)：48 切点 / 中位镜头 2.75s / 讲解 37% + 图解 33% + 标签 10%
> 本文只讲一件事：**同一套版式怎么在 Skia 上跑，代价与收益各是多少**。

---

## 一、结论

| 指标 | canvas / Chrome | Skia / @napi-rs | 差异 |
|---|---:|---:|---|
| 73.8s 片（2215 帧） | 14.37s / 154 fps | **11.3s / 196 fps** | 快 27% |
| 54.5s 片（1635 帧） | 10.24s / 160 fps | **8.5s / 192 fps** | 快 20% |
| 65.3s 片（1959 帧） | — | 12.0s / 163 fps | — |
| 峰值内存 | 6 路 Chromium，未单独测 | 8 worker 1.34GB / 20 worker 2.78GB | 进程数从 6 个浏览器降到 1 个 node |
| 输出体积 | 7.01MB | 6.88MB | −1.9% |
| 画面差异 | 基准 | MAE 2.90/255、PSNR 23.8dB | 见 §四 |

**这不是 6.9 倍那种提速**。`skia-kit` 的 paper 版式能从 56 fps 跑到 388 fps，是因为那张片是纯色底 + 少量文字，瓶颈全在 Chrome 的截图 IPC 上。科普版式反过来：格子纸、手绘器官、爆炸贴、描边字、卡片阴影都是栅格化密集型，而 `@napi-rs/canvas` 是 **CPU 光栅化**、Chrome 的 canvas2d 走 **GPU 加速**，差距被抵消掉大半。

净收益是工程性的：**一条命令、零浏览器、零字体依赖、内存可控、结果确定**。速度只是顺带快两成。

---

## 二、做法：移植，不是重写

`templates/science-explainer/src/` 里是两个 IIFE：`kit.js`（绘图原语 + 图标库，888 行）和 `layouts.js`（9 个版式，890 行）。它们只依赖 `window.MK` / `window.L` 和 Canvas 2D API，**没有一处 `ctx.filter`、没有 blend 模式**。

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
  --params templates/science-explainer/presets/demo.vo.json \
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
| `demo.vo.json`（儿科超声） | 73.8s | 2215 | 11.3s | PASS |
| `kids-qa.vo.json`（肚子咕咕叫） | 65.3s | 1959 | 12.0s | PASS |
| `demo.json`（无声） | 54.5s | 1635 | 8.5s | PASS |

---

## 七、边界

1. **不含配音与配乐**。模板只出画面，`--audio` 传音轨。
2. **字体固定为随包的 Noto Sans SC 三档**。换字体要重跑 §三 的映射规则，字号会变（字面宽度不同）。
3. **只支持横屏 1920×1080**。竖屏要重排版式，不能裁切。
4. **需要 `--kit science`**。默认仍是 paper 版式（`skia-kit/tokens.json` 那套几何），两者共用同一个 CLI 与编码管线。
5. 器官图形是矢量示意，不是医学精确图。
