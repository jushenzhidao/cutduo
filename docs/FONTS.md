# 字体

## 一、铁律：随包字体在前，系统字体在后

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
**且不报任何错误**。本地因为装了 PingFang 一直看不出来。修完后云端与本地 PSNR = `inf`。

## 二、清单：19 个文件 / 57 MB / 19 项注册

`src/fonts.mjs` 的 `FONT_FILES` 注册 19 项，磁盘上有几个就注册几个（缺的静默跳过）。

| 文件 | 注册名 | 体积 | 谁在用 |
|---|---|---|---|
| `NotoSansSC-Black.otf` | `NotoSC Black` | 8.4 M | 五支内置 kit 的标题/强调 |
| `NotoSansSC-Medium.otf` | `NotoSC Medium` | 8.0 M | 副标题 |
| `NotoSansSC-Regular.otf` | `NotoSC Regular` | 7.9 M | 正文 |
| `LongCang-Regular.ttf` | `LongCang` | 4.9 M | **chalkboard** 的粉笔字 |
| `LXGWWenKai-Regular.ttf` | `LXGW WenKai` | 18.4 M（v1.510） | chalkboard 数字与正文；cute-mv 歌词 |
| `ZCOOLKuaiLe-Regular.ttf` | `ZCOOL KuaiLe` | 1.4 M | cute-mv 圆体 |
| `MonaSans-{Black,Bold,SemiBold,Medium,Regular}.ttf` | `Mona*` | 0.7 M | **collage** 西文标牌 |
| `MonaSansDisplay-Black.ttf` | `MonaDispBlack` | 0.1 M | collage 标题 |
| `MonaSansExpanded-{Black,Bold,SemiBold,Medium}.ttf` | `MonaExp*` | 0.6 M | collage 拉伸字标 |
| `JetBrainsMono-{Regular,Medium,Bold}.ttf` | `JBMono*` | 0.8 M | collage HUD / 数值 |

三支手写/西文字体族都是 OFL，许可随模板放在 `templates/own/chalkboard/licenses/` 与上游包内。

**注册失败不抛异常**（`try/catch` 后继续），因为缺一档字重应该降级出片，而不是让整次渲染失败。

## 三、分组口径（2026-11-13 重整）

```
BASE_FONTS          基础三档 Noto —— 任何 kit 都靠它兜中文，缺了整屏退化
TEMPLATE_FONTS
  ├─ chalkboard     LongCang
  ├─ hand           LXGW WenKai + ZCOOL KuaiLe（chalkboard 与 cute-mv 共用）
  └─ collage        Mona Sans ×10 + JetBrains Mono ×3
FONT_FILES         = BASE + 全部模板专用（registerFonts 注册的就是这份）
HAND_FONTS         = TEMPLATE_FONTS.hand（同一个对象，不是副本）
```

早先 `FONT_FILES` 与 `HAND_FONTS` 各自列了一遍 LXGW，调字体要改两处，漏一处就静默不一致。
现在共用字体只登记一次。

## 四、字体不进 git：`tools/fetch-fonts.sh`

字体是**构建依赖**，不是源码。`assets/fonts/.gitignore` 用 `*` + `!.gitignore` 全排除，
由脚本保证可复现：

```bash
bash tools/fetch-fonts.sh            # 缺什么补什么
bash tools/fetch-fonts.sh --verify   # 只校验，不下载（部署前跑）
bash tools/fetch-fonts.sh --force    # 已存在也重下
```

**19 个文件全部 sha256 硬校验，没有「只锁 tag」的例外。**

这条是被坑出来的：上一版对 13 个文件只锁 tag，而 Mona Sans 的路径写的是
`@v1.0.1/fonts/ttf/`——那个目录里的 `MonaSans-Black.ttf` 是 67416 字节，
磁盘上是 148164 字节，**体积差一倍**。脚本会「成功」下到另一个版本的字形，
`--verify` 永远显示 ✓。这类静默错版只有字节级校验挡得住。

正确的上游坐标（2026-11-13 用 GitHub trees API 逐个核对过体积）：

| 族 | 坐标 |
|---|---|
| Noto Sans SC | `googlefonts/noto-cjk@main/Sans/SubsetOTF/SC` |
| LongCang / ZCOOL KuaiLe | `google/fonts@main/ofl/<family>` |
| LXGW WenKai | `lxgw/LxgwWenKai@v1.510/fonts/TTF` |
| Mona Sans | `github/mona-sans@v2.0.27/fonts/static/ttf` ← **不是** `v1.0.1/fonts/ttf` |
| JetBrains Mono | `JetBrains/JetBrainsMono@v2.304/fonts/ttf` |

**多源回退**：`google/fonts` 是巨型仓库，jsDelivr 的 `@main` 会中途
`Recv failure: Connection reset by peer`。脚本对这类条目配了
jsDelivr → raw.githubusercontent → fastly.jsdelivr 三个源，并且必须带
`--retry-all-errors`——默认的 `--retry` **不重试「传到一半断了」**，这是实测踩到的。

**闭环验证（2026-11-13，三轮）**：

| 轮次 | 结果 | 说明 |
|---|---|---|
| 1 | 18/19，LongCang 失败 | 单源 + 默认 --retry，传输中断不重试 |
| 2 | 15/19 | 同上，四个文件撞上 reset |
| 3 | **19/19，0 换源** | 加 `--retry-all-errors` + 多源后一次过 |

**另一个真 bug**：旧脚本 `DIR="$(cd "$(dirname "$0")" && pwd)/assets/fonts"` 会落到
`tools/assets/fonts/`，下载成功但下到错地方。已修为 `dirname/..`。

## 五、各支版式的字体依赖

| kit / 模板 | 字体来源 | 容器内是否正常 |
|---|---|---|
| `paper` | `NotoSC *` → PingFang 兜底 | ✓ |
| `science` | `FONT_MAP` 全映射到 NotoSC | ✓ |
| `desk` | `safeFont()`：含 CJK 的等宽串替换成 NotoSC | ✓ |
| `mg` | `NotoSC *` → PingFang 兜底 | ✓（mono 串回退） |
| `editorial` | 原本 PingFang 优先 → **已改为 NotoSC 优先** | ✓（2026-11-13 修） |
| `clay` | 上游 `ClaySans`/`Inter`/`ClayKai` 别名映射到 NotoSansSC-Medium | ✓ |
| `templates/own/chalkboard` | `LongCang` + `LXGW WenKai` | ✓（缺字体退化成 PingFang，黑板感消失但不报错） |
| `templates/own/cute-mv` | `ZCOOL KuaiLe` + `LXGW WenKai`，经 `__FAM` 注入 | ✓ |
| `kits/collage` | `Mona*` + `JBMono*`，中文由 Noto 兜底 | ✓ |

## 六、验证字体是否真的生效（不靠肉眼）

`fetch-fonts.sh --verify` 只证明「字节对」，证明不了「Skia 认这个族名」。中间还有两道静默坑：
登记了但文件名写错、模板里写死的族名在注册表里根本不存在。所以另有
**`node tools/check-fonts.mjs`**，三重判据，任何一重不过就 FAIL：

| 判据 | 挡的是什么 |
|---|---|
| `GlobalFonts.has(family)` | 文件在、注册没成功 |
| `measureText` 宽度 ≠ 回退基准 | 族名拼错，Skia 静默用了默认字体 |
| 模板 `FACE`/`FAM` 里的族名都在注册表 | 模板用了没人注册的字体 |

实测输出：19 项全 PASS，回退基准字宽 310.69，各字体给出 259–408 的不同宽度。

**测宽对照**（同一串中文，`遮挡比例 99.8%`）：

字体缺失时 Skia **不报错**，只是静默回退。判据用测宽：同一串中文在不同字体下宽度不同，
与「不存在的字体族」宽度相同则说明回退了。

```js
ctx.font = '48px "LongCang"';        ctx.measureText('遮挡比例 99.8%').width; // 306.82
ctx.font = '48px "LXGW WenKai"';     ctx.measureText('遮挡比例 99.8%').width; // 350.40
ctx.font = '48px "NotoSC Black"';    ctx.measureText('遮挡比例 99.8%').width; // 285.33
ctx.font = '48px "NoSuchFontXYZ"';   ctx.measureText('遮挡比例 99.8%').width; // 285.33 ← 回退值
```

三个真实字体给出三个不同宽度，才算真的注册上了。

## 七、要不要继续加字体

**功能上不需要。** 五支内置版式只用 NotoSC 三档就能出完整中文片。加字体解决的是**风格**，不是能力。

加之前先算三笔账：

1. **镜像体积**。字体直接进镜像，现在 `assets/fonts/` 已 53 MB；再加一族 CJK 就是 +20 MB 起，
   而 ai-prod 拉镜像本来就慢。
2. **注册才有用**。放到 `assets/fonts/` 但没进 `FONT_FILES`（或对应模板分组），等于没加。
3. **部署才算数**。以前字体靠「打包那台机器磁盘上碰巧有什么」决定，已经出过事
   （云端只有 3 个 Noto，chalkboard 的粉笔字全退化）。现在统一由 `fetch-fonts.sh` 拉，
   部署前跑 `--verify` 就能确认。

## 八、体积优化：子集化

NotoSC 三档 24 MB 是因为收了全部 CJK 扩展区。实际成片只用常用字 + 少量术语，
用 `pyftsubset` 裁到 GB2312 + 项目用字，通常能压到 **1–2 MB/档，省 80% 以上**。

代价：出现生僻字时缺字回退。**要按项目实际用字表裁，不能一刀切。**
对模板尤其危险——模板要换内容，用户写的字不在表里就是硬缺陷。

未做，因为 57 MB 对镜像构建还不构成瓶颈；一旦要频繁推镜像、或要把模板分发给别人，就该做。
