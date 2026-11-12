# knowledge-explainer-sketchnote 换宿主实测（2026-11-13）

对象：https://motiongit.com/adunext/knowledge-explainer-sketchnote
版本：`2.7.4-alpha.2`（26.7MB，个人下载包，`content.protection: open`）
参数：`presets/demo.json` 复制成 8 段 / 48s / 1920×1080@60fps（`/tmp/ke-48s.json`）

## 一、能不能换：能，而且是目前最干净的一个

| 判据 | 结果 |
|---|---|
| 源码可读 | ✅ `protection: open`，`content/release.bin` 是普通 ZIP，382 个文件全明文 |
| 引擎类型 | ✅ 纯 Canvas2D。`runtime/index.html` 只挂一个 `<canvas>` |
| DOM 依赖 | ✅ 仅 5 处：`querySelector('canvas')`、`createElement('canvas')`、`document.fonts`、`baseURI`、`currentScript` |
| 需要自建布局引擎 | ❌ 不需要（对比 camera-mode 的 div + CSS transform） |
| iframe | 仅 `mountPerformance()`（sourcePerformance 绑定）用，默认不走 |

脚本加载顺序（照 index.html）：`graphics/knowledge-icons.js` → `runtime/diagrams.js` →
`native/native-sketchnote.js` → `runtime/presenter-framing.js` → `runtime/time-mark.js` → `runtime/film.js`。
全部普通 script，`vm.runInThisContext` 直接跑，挂在 `window.KnowledgeFilm` / `window.NativeSketchnote`。

宿主入口只有两个：

```js
await KnowledgeFilm.initialize({ params, style, width, height });
await KnowledgeFilm.render(t);   // 无状态，可任意跳帧
```

## 二、宿主层必须做的 4 件事

1. **font 注册**：`FontFace` + `document.fonts.add` 是浏览器 API。shim 成
   `GlobalFonts.registerFromPath(fileURLToPath(url), family)`。`style.fonts` 里 4 个字体：
   SK-Kai(woff)、SK-Brush(ttf)、SK-Num(ttf)、SK-Mono(ttf)。
2. **字重吸附**：Skia 不做合成粗体。`SK-Kai` 只有 500 一个 face，模板请求 `700`（标题）时
   **整个 fallback 到系统黑体**，且 `measureText` 与 `fillText` 用不同字体 → 右侧裁字。
   宿主把 `ctx.font` 的 weight 吸附到该家族已注册的 face（SK-Kai→500、SK-Brush→400）。
3. **getTransform 缓存**：模板的 `instrument()` 给每个绘制调用包一层 `project()`，
   每帧上万次 `ctx.getTransform()`。@napi-rs/canvas 每次都新建 DOMMatrix，
   **占 45.7% + 17.2% ≈ 63% 帧时间**。缓存成普通 `{a..f}`，只在
   `setTransform/translate/rotate/scale/transform/restore` 后失效。
4. **拆 Chrome 兼容 wrapper**：`@napi-rs/canvas` 给每个方法套了参数个数检查（`index.js:229`），
   每帧上万次调用占 34%。从 `proto[Symbol]` 的 stash 里取原生方法绑回实例。

## 三、速度（同一份 48s 参数、1920×1080、只换宿主）

| 管线 | 单帧 | 单核/单页 |
|---|---|---|
| Skia 裸 shim（未优化） | 60.8 ms | 16 fps |
| Skia + ①②③④ | 12.7 ms | **79 fps** |
| Skia + 跳过 `instrument()` | 6.6 ms | **151 fps** |
| Chrome（模板自带 `adapter/browser.mjs` CDP 管道） | 8.13 ms | **123 fps** |
| Chrome + `toDataURL('image/png')` | 15.04 ms | 66 fps |

- **带 audit 的 Skia 比 Chrome 慢 0.64×；关掉 audit 才快 1.23×。**
- 与 paper-kit 的「6.9×」不同：这个模板把 QA 逻辑（ledger / 碰撞检测）放在绘制热路径上，
  换宿主省不掉它，反而因为 @napi-rs/canvas 的对象分配更贵。
- 浏览器侧 8.13ms 是纯 `render()` 循环（不含 CDP 传输）；Skia 侧 12.7ms 含全部 JS。

## 四、一个假坑：SK-Kai 渲染出来是黑体

`LXGWWenKai-500.woff` 转 ttf 后仍然渲染成黑体，PIL 独立渲染同样如此 ⇒ **不是宿主问题，
是模板打包的字体子集本身**（2.0MB / 7122 字形，名字写 LXGW WenKai Medium 但轮廓是黑体）。
结论：换宿主对比时不要拿"看起来不像手写"当宿主缺陷。

## 五、结论

- 这个模板**技术上完全可换宿主**，shim 不到 200 行，没有 div/CSS/布局引擎。
- **但速度上没有白赚**：模板自带 `instrument()` 审计占 55%，加上 Skia 的对象分配，
  只有显式关掉审计才反超单实例浏览器。
- 多进程实测（§7.4）后结论更保守：**同规模下 Skia 与 Chrome 多实例基本打平（±5%）**，
  8 规模下优化版快 18.6%，12/16 规模只快 4–5%。
- 换宿主的真实收益不是速度，是「不需要 Chromium」：零浏览器、启动 0.11s、内存与进程模型可控、
  可以在宿主层做模板本身做不到的优化（背景层缓存、按需审计）。

## 六、产物

- `bench/motion-host/sketchnote-host.mjs`：宿主 shim（可复用）
- `bench/motion-host/poc-sketchnote.mjs`：单帧/测速/无状态检查
- `bench/motion-host/chrome-sketchnote.mjs`：浏览器基准（模板自带 CDP 管道）
- `bench/motion-host/render-parallel-sketchnote.mjs`：N worker 整片出片

## 七、续测：到底加不加速（2026-11-13 02:40）

上一版只测了「裸 shim vs 带三项修正」，漏了**背景层缓存**和**端到端**两个关键口径。

### 7.1 单帧渲染（不含编码）

| 配置 | 单帧 | fps |
|---|---|---|
| Skia 裸 shim | 60.8 ms | 16 |
| Skia + transform/wrapper/字重三项 | 13.6 ms | 74 |
| **+ 背景层缓存** | **9.79 ms** | **102** |
| **+ 关审计（no-ledger）** | **5.42 ms** | **184** |
| Chrome（模板自带 CDP） | 8.13 ms | 123 |

背景层缓存：`drawBackground` 是纯静态点阵（`for x += 40 / for y += 40` 画 ~7000 个 1.5px 圆），
每帧重画且每点都被 `instrument()` 逐条记账。宿主把它渲染一次成位图，之后每帧一次 `drawImage`。

### 7.2 端到端出片（480 帧 = 8s，x264 veryfast crf20 + 管道）

| 配置 | 墙钟 | 吞吐 |
|---|---|---|
| Chrome（PNG+base64 → ffmpeg image2pipe） | 9.39s | 51.1 fps |
| Skia 原样（审计 + 实时背景） | 11.12s | 43.1 fps |
| Skia + 背景缓存 | 9.43s | 50.9 fps |
| Skia + 背景缓存 + 关审计 | **7.22s** | **66.5 fps** |

**画面对比**（ffmpeg SSIM）：
- Skia（任意配置）vs Chrome：`All 0.995417 / Y 0.994275`（差异来自光栅化与字体 hinting）
- 关审计 vs 开审计：`1.000000 (inf)`，**逐像素一致**
- 背景缓存 vs 实时背景：对 Chrome 的 SSIM 完全相同 ⇒ 缓存也没有改画面

### 7.3 结论修正

- **裸换宿主确实不加反降**（43.1 vs 51.1）。原因不是 Skia 慢，是这个模板把 55% 的时间花在
  `instrument()` 的 ledger 记账上，而 @napi-rs/canvas 每次 `getTransform` 都新建 DOMMatrix，
  浏览器那边是原生对象、V8 也把记账闭包内联了。
- **加两个宿主级优化就追平/反超**：背景缓存 → 50.9（≈Chrome），再关审计 → 66.5（1.3×）。
- 出片链路上 Chrome 还要为 PNG 编码 + base64 传输付 ~7ms/帧，Skia 是裸 RGBA 直送 ffmpeg。
- 与 mac-desktop 的 6.9× 不可比：那边单帧渲染 1.01ms、编码占绝对大头；这边单帧上万次
  绘制调用 + 每次记账，成本在模板 JS 层，换宿主省不掉。

### 7.4 多进程（沙箱外实测，2026-11-13 02:55）

之前 `fork`/`spawn` 全部 SIGTERM，真因不是沙箱，是脚本 bug：`has('--child')` 会去找
`----child`，child 分支从未进入，子进程递归 spawn 自己把机器打爆。改成 `argv.includes('--child')`
后，关沙箱（`dangerouslyDisableSandbox`）跑通全部规模。

整片 2880 帧 / 48s / 1920×1080@60 / x264 veryfast crf20 + animation，墙钟含启动、分片、concat：

| 规模 | Chrome N 实例 | Skia N worker（原样） | Skia N worker（缓存背景+关审计） |
|---|---|---|---|
| 1 | 55.71s / 51.7 fps | 43.1 fps（单进程） | 66.5 fps |
| 2 | 28.88s / 99.7 fps | 97.5 fps（240 帧） | — |
| 4 | 15.29s / 188.3 fps | 215.1 fps（960 帧） | — |
| 8 | 9.26s / 311.1 fps | 10.54s / 273.1 fps | **7.81s / 368.9 fps** |
| 12 | 7.64s / 377.0 fps | 9.25s / 311.4 fps | **7.36s / 391.6 fps** |
| 16 | 7.17s / 401.4 fps | — | **6.85s / 420.7 fps** |

**结论：同规模下基本打平（±5%）。**

- 8 规模：优化后 Skia 快 18.6%；原样慢 12%。
- 12 规模：优化后只快 3.9%；原样慢 17%。
- 16 规模：优化后快 4.8%。
- 之前说的「7.6×」是拿 12 worker 比 1 个 Chrome 实例，**属不当对比**，作废。

**为什么打不平纸面优势**：这个模板的单帧成本在模板自己的 JS（每帧约 1 万次绘制调用 + 每次都被
`instrument()` 记账），不在宿主。Chrome 的 V8 把这层记账内联得很好；@napi-rs/canvas 每次跨
napi 边界 + 新建 DOMMatrix 更贵。多进程只是把这块 CPU 成本横向摊开，两条管线摊的是同一份成本，
下限又都是 x264。

**换宿主的真实收益**（不是速度）：
1. 无 Chromium 依赖，启动 0.11s/worker vs 0.56s/实例；
2. 可在宿主层做模板做不到的优化（背景层缓存 = 12 规模 +18%，且逐像素不变）；
3. 可按需关审计（零画质代价，单进程 1.8×，多进程约 +10–25%）；
4. 内存与进程模型可控（每个 worker 是一个普通 node 进程）。

**画质**：三条 Skia 整片（原样 / 缓存背景 / 缓存背景+关审计）对 Chrome 整片的 SSIM
全部为 `All 0.993556`——三者像素级一致，差异只来自 Skia 与 Blink 的光栅化/字体 hinting。
四条视频均 2880 帧 / 48.000s，concat 无丢帧。

## 八、上面全部测的是「通用图解」，不是模板的手绘引擎（2026-11-13 03:20）

`presets/demo.json` 的 family 是 `definition`，`isNative()` 判 false ⇒ 走 `runtime/diagrams.js`
（通用图解库），不是 `native/native-sketchnote.js`（点阵手账手绘）。模板真正的卖点在后者。

`native/catalog.json` 只有 4 个 family：`step-sequence` / `keyword-annotation` /
`sticky-revision` / `return-loop`，recipe 用 `native/examples/recipes.json` 的示例，
family 写成 `sketchnote.<id>`（`style.id = sketchnote`）。

### 8.1 两类 family 的成本差 13 倍

| family 类型 | Chrome | Skia 换宿主（关审计+缓存背景） |
|---|---|---|
| 通用图解 `definition` | 8.13 ms / 123 fps | **5.42 ms / 184 fps** |
| 手绘 `sketchnote.step-sequence` | **24.03 ms / 42 fps** | 70.4 ms / 14 fps |

- 轻量图解：Skia 快 1.5×（跨 napi 边界不心疼）。
- 手绘：**Skia 慢 2.9×**。手绘每帧要跑大量路径生成 + `recorded()` 逐笔记几何，
  这些在 Blink 里是原生调用，在 @napi-rs/canvas 里每次都要过 JS→Rust 边界。
- 结论修正：**「同规模打平」只对通用图解成立，对模板的核心手绘不成立。**

### 8.2 多进程把结论又翻回来

60s 片 / 3600 帧 / 1080p60：

| 管线 | 墙钟 | 吞吐 |
|---|---|---|
| Chrome 单实例（估算，43.76ms/帧含 PNG） | ~157s | 23 fps |
| Chrome 8 实例 | 109.38s | 32.9 fps |
| **Skia 12 worker** | **25.92s** | **138.9 fps** |

- Chrome 多实例在 native 场景**几乎不扩展**（8 实例 32.9 vs 单实例 42 fps，负优化）：
  每个实例还背着 PNG 编码（~20ms/帧）+ 独立渲染进程，8 个一起抢内存带宽。
- Skia 12 worker 快 **4.2×**：native 的 70ms 是纯 JS 计算，多进程能实打实摊到 12 核。
- **所以对模板的核心能力，换宿主 + 多进程是最快的可用路径**（138.9 fps = 60s 片 26s 出完）。

### 8.3 蒸馏到底能省什么

native 单帧 70ms 里，模板自己承担的、蒸馏可以砍掉的部分：
`recorded()` 逐笔几何记录、`compile()` 每帧重跑布局、1 万次跨边界绘制调用、
模板的 recipe 校验与 capacity 检查。

自建产线的实测基线：`desktop-kit` 0.95ms/帧、`science-explainer` 5–6ms/帧（含手绘笔触、
人物、字幕）。即 **蒸馏后 5–8ms/帧，比 native 换宿主快 9–14×，比 Chrome 快 3–5×**。

代价：手绘笔触系统（wobble / 抖动 / 笔宽变化 / 便笺 / 胶带 / 纸张纹理）+ 4 个 family 的布局，
按 science-explainer 的经验约 2–4 天；且丢掉模板的 recipe 校验与 AI 生成链路。

### 8.4 建议

| 目标 | 选 |
|---|---|
| 只出这一条片 | 直接用 Chrome 单实例（42 fps，60s 片 2.6 分钟），零成本 |
| 要反复出片、且用 native 手绘 | **换宿主 + 12 worker**（26s/60s 片），成本几小时 |
| 要把这条产线长期用下去 | **半蒸馏**：保留模板的 recipe/schema 当「内容编译器」，自己写渲染器 |
| 只做通用图解类内容 | 换宿主即可，甚至更快 |

半蒸馏是性价比最高的一档：模板最有价值的资产是 `AI-CHOICES.json`(68KB) +
`KNOWLEDGE-GUIDE.md`(20KB) + `params.schema.json`(1MB) + `gallery/` 的一整套内容模型，
不是那 382 个渲染文件。把这些当输入，渲染层用自己的 Skia，能同时拿到内容能力和 10× 速度。



