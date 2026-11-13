# SKIA-SPEC.md · Skia 宿主适配

`.motion` 规范里 `runtime.profile` 只声明 `html-canvas/1`（浏览器宿主）。
这份文件说明第二宿主：**同一份 `src/` 不启动浏览器也能出片**。

## 一、为什么不写进 motion.json

`motion.json` 的字段受 `specVersion: 0.1.0-draft.1` 约束，自创字段会让第三方安装器
在 `additionalProperties: false` 处失败。宿主差异是**实现说明**，不是**包协议**。

## 二、本模板用到的注入点

| 注入 | 浏览器 | Skia | 作用 |
|---|---|---|---|
| `__FAM` | 不注入，`kit.js` 用系统字体栈（`LXGW WenKai` → `Kaiti SC` → serif） | `{kai:'"LXGW WenKai"', kuai:'"ZCOOL KuaiLe"'}` | 歌词/纸条的楷体与关键词的圆体，Skia 没有系统楷体，必须显式喂族名 |
| `__FONT_PICK` | 不注入 | 字重 → `NotoSC Black/Medium/Regular` | 兜底：手写体缺失时仍能出字，不糊方块 |
| `__createCanvas` | `document.createElement('canvas')` | `@napi-rs/canvas` | 目前未用（本模板不建离屏画布），保留口径一致 |

本模板**零位图素材**：人物、天空、楼群、草、纸飞机全是矢量，所以不涉及 `__MK_IMAGES` / `__MK_FIGS`。

## 三、字体注册

字体不进包、不进 git，由 `tools/fetch-fonts.sh` 取到仓库 `assets/fonts/`，
再由 `src/webcanvas.mjs` 调 `registerHandFonts()` 注册。两款都是 OFL：

| 文件 | 族名 | 用途 |
|---|---|---|
| `LXGWWenKai-Regular.ttf` | `LXGW WenKai` | 歌词条 62px、纸条 40px |
| `ZCOOLKuaiLe-Regular.ttf` | `ZCOOL KuaiLe` | 3D 关键词 140–170px |

缺字体时不报错：族名解析不到会回落到 `__FONT_PICK` 的 Noto Sans SC，
**字重对、字形不对**——能出片，但"手写感"没了。

## 四、性能口径（本模板实测）

| 项 | 值 |
|---|---|
| 990 帧 / 1920×1080@30 / 8 worker | **5.2–5.9 s**（≈170–190 fps） |
| 单帧探针 | ≈0.9 s（含进程启动与字体注册） |
| 成片 | 5.5 MB（CRF 20、raw pipe、AAC 160k） |

绘制量最大的是雨（110 条线）与草（每镜头 60–90 簇），都走 `stroke` 单路径，不用逐像素操作；
颗粒是 900 个 1.6px 方块、固定 seed，**不做逐帧随机**（否则整片在闪）。

## 五、回归口径

改 `kit.js` / `layouts.js` 后先出单帧校对，再全片：

```bash
node render.mjs --kit cute-mv --params templates/own/cute-mv/presets/default.json \
  --probe /tmp/a.png --at 6.0
node render.mjs --kit cute-mv --params templates/own/cute-mv/presets/default.json \
  --out out/cute-mv-demo.mp4
node src/gate.mjs out/cute-mv-demo.mp4
```

`--probe` 必须写成 `--probe <file.png> --at <秒>`；写成 `--probe --at 5` 会把 `--at` 当文件名。
