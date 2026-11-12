# 字体

## 铁律：随包字体在前，系统字体在后

```js
// 对
const FONT = '"NotoSC Black", "PingFang SC", sans-serif';
// 错——本地 macOS 看着正常，容器里整屏豆腐块
const FONT = '"PingFang SC", "NotoSC Black", sans-serif';
```

Skia 的 `ctx.font` 是 CSS 风格的字体族列表，**按顺序回退，找不到就继续往后，全找不到才用默认字体**。
把系统字体写在前面，等于在无该字体的机器上主动放弃自带字体。

2026-11-13 云端 `editorial` 就是这么坏的：`"PingFang SC", "Helvetica Neue", sans-serif` 三个
在 Linux 容器里都不存在，回退到无中文字形的 sans-serif，标题/副标题/字幕全是方框，
**且不报任何错误**。本地因为装了 PingFang 一直看不出来。

修完后云端与本地渲染 PSNR = `inf`（逐像素一致）。

## 清单

`assets/fonts/` 现有 16 个文件、约 85MB，但 `src/fonts.mjs` 的 `FONT_FILES` **只注册 5 个**：

| 文件 | 注册名 | 用途 |
|---|---|---|
| `NotoSansSC-Black.otf` (8.4M) | `NotoSC Black` | 标题/强调 |
| `NotoSansSC-Medium.otf` (8.0M) | `NotoSC Medium` | 副标题 |
| `NotoSansSC-Regular.otf` (7.9M) | `NotoSC Regular` | 正文 |
| `LongCang-Regular.ttf` (4.9M) | `LongCang` | 手写粉笔字（chalkboard） |
| `LXGWWenKai-Regular.ttf` (24M) | `LXGW WenKai` | 楷体正文 |

未注册的 11 个（JetBrainsMono ×3、MonaSans ×7、ZCOOLKuaiLe）**不会被加载**。
这是刻意的白名单：磁盘上有不等于要用，注册了才占内存。

注册失败不抛异常（`try/catch` 后继续），因为缺一档字重应该降级出片，而不是让整次渲染失败。

## 各支版式的字体依赖

| kit | 字体来源 | 容器内是否正常 |
|---|---|---|
| `paper` | `NotoSC *` → PingFang 兜底 | ✓ |
| `science` | `FONT_MAP` 全映射到 NotoSC | ✓ |
| `desk` | `safeFont()`：含 CJK 的等宽串替换成 NotoSC | ✓ |
| `mg` | `NotoSC *` → PingFang 兜底 | ✓（mono 串回退） |
| `editorial` | 原本 PingFang 优先 → **已改为 NotoSC 优先** | ✓（2026-11-13 修） |
| `clay` | 把上游的 `ClaySans`/`Inter`/`ClayKai` 别名映射到 NotoSansSC-Medium | ✓ |

## 要不要继续加字体

**功能上不需要。** 五支版式只用 NotoSC 三档就能出完整中文片。加字体解决的是**风格**，不是能力。

加之前先算代价：

1. **镜像体积**。字体直接进镜像，`LXGWWenKai` 一个就 24MB。加五个字体镜像涨 100MB+，
   而 ai-prod 拉镜像本来就慢。
2. **注册才有用**。加到 `assets/fonts/` 但没进 `FONT_FILES`，等于没加。
3. **部署才算数**。`assets/fonts/*.otf` 在 `.gitignore` 里（字体不入库），
   所以**服务器上有没有字体，取决于打包那一刻本地磁盘有什么**。
   2026-11-13 就出现过：打包时只有 3 个，13 个 ttf 在打包后才被加进来，
   服务器至今只有 3 个。

## 体积优化：子集化

NotoSC 三档 24MB 是因为收了全部 CJK 扩展区。实际成片只用常用字 + 少量术语，
用 `pyftsubset` 裁到 GB2312 + 项目用字，通常能压到 1–2MB/档，**省 80% 以上**。

代价：出现生僻字时会缺字回退。要按项目实际用字表裁，不能一刀切。

未做，因为当前 85MB 的体积对镜像构建还不构成瓶颈；一旦要频繁推镜像就该做。
