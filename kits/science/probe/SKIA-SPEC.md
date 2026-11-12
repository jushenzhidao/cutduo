# SKIA-SPEC.md · Skia 宿主适配

`.motion` 规范里 `runtime.profile` 只声明了 `html-canvas/1`（浏览器宿主）。
我们不污染 `motion.json` 的字段，另起这份文件说明第二宿主——**同一份 `src/` 不启动浏览器也能出片**。

## 一、为什么不写进 motion.json

`motion.json` 的字段受 `specVersion: 0.1.0-draft.1` 约束，自创字段会让第三方安装器
在 `additionalProperties: false` 处失败。宿主差异属于**实现说明**，不是**包协议**，所以放这里。

## 二、三个注入点

Skia 侧没有 DOM，靠三处注入把浏览器心智模型搬过去：

| 注入 | 浏览器 | Skia | 作用 |
|---|---|---|---|
| `__createCanvas(w,h)` | `document.createElement('canvas')` | `@napi-rs/canvas` 的 `createCanvas` | 让 `kit.js` 不必自己造画布 |
| `__FONTS` | 系统 PingFang SC | 随包 Noto Sans SC | 缺字体会整段糊成方块 |
| `__MK_IMAGES` | `<img>` 预加载 | 位图直读（`loadImage` 同构） | 姿态图/道具 |

`collectFigures()` 见到 `document === undefined` 会直接 return ——
**不补 `__MK_FIGS` 就静默退化成矢量人物，画面与浏览器不一致且不报错**。这是最容易漏的一条。

## 三、字体分流（按字号，不按字重）

粗标题靠「同色描边膨胀」模拟 heavy，不是真的 Black 字重。按字号分流的实测口径：

```
≥ 800px            → Black
≥ 700px 且 ≥ 64px  → Black
其余 700            → Medium + 保留原 heavy 描边
```

不分流会导致字幕糊死（Medium 被当 Black 拉伸）。

## 四、性能口径

- **绘制调用是记账，代价在 `canvas.data()` 结算。** 单看 `renderFrame` 的 1ms 是假象，
  真实 10–16ms（封面 45ms）。
- 有效优化只有并行度：6/8/12/16/20 worker → 132/141/172/186/192 fps。
- 位图姿态图比矢量人物快（2369 帧 15.2s → 13.2s）。

## 五、回归口径

改 `kit.js` 或 `layouts.js` 后**必须**跑双宿主同帧比对，MAE 目标 0.00：

```bash
node skia-kit/render.mjs --kit <name> --params <preset> --probe /tmp/a.png --at 5
# 浏览器侧同帧导出后比对
```

`--probe` 的正确写法是 `--probe <file.png> --at <秒>`；
写成 `--probe --at 5` 会把 `--at` 当成文件名，在当前目录生成一个叫 `--at` 的 PNG。
