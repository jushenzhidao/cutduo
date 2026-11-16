# docs/jimeng · 即梦（Dreamina）风格归档

> 这个目录只收一件事：**从即梦 / Dreamina 官方投放素材里反推出的视觉与叙事规则**。
> 其他来源的蒸馏仍在 `docs/蒸馏-索引.md`；这里是为了把「同一个来源的一批片子」放在一起比较，
> 而不是散在 docs/ 根下按日期堆。

## 一、来源域名（认片用）

| 项 | 值 | 证据强度 |
|---|---|---|
| 主域 | `v6-artist.vlabvod.com` | 实测 |
| 归属 | 字节系 VOD 分发域（`vlabvod` = video lab vod）；路径里的 `tos-cn-v-<n>` 是火山引擎 TOS 桶前缀 | 推断（命名规律，未查官方文档） |
| 路径形状 | `/{32位hex}/{8位hex}/video/tos/cn/tos-cn-v-<bucket>/<fileid>/?...` | 实测 |
| 关键参数 | `mime_type=video_mp4` `br=2284` `bt=2284` `qs=0` `dy_q=<unix>` `l=<yyyymmddhhmmss+hex>` `expire_time=<unix>` | 实测 |
| `l` 参数 | 签发时间（本次 `20261116163502`，与请求时刻一致到秒） | 实测 |
| 有效期 | **6 小时**：`expire_time − dy_q = 1794839702 − 1794818102 = 21600s` | 实测 |
| 身份判据 | 回放域名含 `artist` 段 + `dy_q`（抖音请求号）⇒ 抖音侧发出的即梦成片 | 推断 |

**这些是带签名的一次性链接，不能当长期资源登记。** 归档必须落本地文件；
过期后重新取链只能回原页面重新触发一次导出。

下载姿势（2026-11-16 实测成功）：

```bash
curl -sL --http1.1 --retry 3 \
  -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" \
  -e "https://www.douyin.com/" -o source.mp4 "<签名 URL>"
file source.mp4   # 过期会拿到 XML/HTML 而不是 MP4
```

## 二、目录约定

```
docs/jimeng/
  README.md                     ← 本文件：域名、收录判据、索引
  NN-<slug>-YYYY-MM-DD.md       ← 每支片子一份蒸馏记录，NN 递增
refs/jimeng/NN-<slug>/          ← 原片与抽帧，refs/ 不入库
  source.mp4
  key/                          ← 关键帧；contact-2fps.png 是 2fps 总览
  frames-2fps/                  ← 2fps 抽帧，复查用
  luma.txt                      ← 逐帧 YAVG / SATAVG，测明暗节奏
```

`NN` 是**专题**序号，与 `docs/distillations.json` 里 `id` 为 `jimeng-<slug>` 的条目一一对应
（序号只是阅读顺序，不是优先级）。同一支片可以拆成多个专题——01 讲版式与叙事，02 讲音效。

## 三、收录判据

不是所有即梦成片都值得收。三条同时成立才收：

1. 有**版式意图** —— 能看出排版决策，不是纯特效炫技；
2. 能说清**它解决什么叙事问题** —— 否则只是好看，无法转成规则；
3. 至少 **1 条本仓没有的规则** —— 全是已有能力就不必占一个编号。

只满足「好看」的，记在 `refs/jimeng/` 当参考素材即可，不写蒸馏文档。

## 四、已收录

| # | 片名 | 时长 | 画幅 / fps | 日期 | 核心吸收 | 落地 |
|---|---|---|---|---|---|---|
| 01 | Motion Showreel（Dreamina 产品功能片） | 15.019s | 1920×1080 / 30 | 2026-11-16 | 制片监视器 HUD 常驻、每镜换构图、单叙事道具贯穿 | `tools/hud-overlay.mjs`<br>`tools/jimeng-demo.mjs`（同语法验证片 `out/jimeng-showreel.mp4`） |
| 02 | 同上一支的**音效**（不新增片源） | — | — | 2026-11-16 | 切点必然有瞬态（4/4，±50ms）、riser 跨越切点、软过渡用 whoosh | `tools/sfx-probe.py`<br>`tools/sfx-synth.mjs`（`content/jimeng-showreel/sfx.json`） |

> 状态以 `docs/distillations.json` 为准（id 前缀 `jimeng-`）。
