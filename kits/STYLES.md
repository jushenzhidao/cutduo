# 版式图鉴 · 什么时候用哪一支

> 选版式先看「要讲什么」，再看视觉。各支的详细规律与坑见 `kits/<name>/README.md`；
> 本文件只解决「该选哪一支」。**完整清单与 API 注册状态以 [`docs/inventory.md`](../docs/inventory.md) 为准**
> （由 `tools/inventory.mjs` 生成，不要手抄）。

> **⚠ 入口不统一（2026-11-15 复核）**：13 支可渲染的版式里，9 支走主 CLI
> `render.mjs --kit <name>`（含 4 支三件套模板），4 支有自己的入口：`desk` / `editorial` / `mg` / `diagram`。
> 给它们传 `--kit` 会报「找不到 kit」。下表「入口」一列必须看。

## 按用途选

| 场景 | 首选 | 次选 | 为什么 |
|---|---|---|---|
| 知识科普 / 讲解 | **paper** | science | paper 的 11 种段型（数字、对比、步骤、金句、**点阵、图表**）最齐全，60fps 更顺 |
| 数据故事 / 时间序列 | **paper** | diagram | `grid` 点阵表达数量、`chart` 画真折线/柱状；单张关系图用 diagram |
| 医学科普 | **science** | paper | 自带 18 个医学图标（器官、探头、光片）与圆框图解，别处没有 |
| 界面 / 产品演示 | **desk**（`npm run desk`） | mg | desk 是桌面实拍风格，1440×1080 竖构图 |
| 观点 / 专栏 / 长文 | **editorial**（`npm run editorial`） | paper | 24fps 图文口播，节奏慢，适合"读"的内容 |
| 主题动效 / 概念可视化 | **mg**（`npm run mg`） | collage | 段型按主题写，适合"一个概念配一个动态镜头" |
| 数据关系 / 机制 / 结构图 | **diagram** | paper | 13 类图示段型：量差、走势、层级、循环、因果、部件、公式…；只有段型，不带片头 |
| 3D 拆装 / 爆炸图 / 产品结构 | **iso** | diagram | 零件几何与镜头全部 JSON 声明；拆开、阵列、合拢是一条连续运镜 |
| 图示 / 黏土质感 | **clay** | chalkboard | clay 黏土 7 种拆合机制；讲几何/光学用 chalkboard（投影是算出来的） |
| 快剪 / 混剪 / 合辑 | **collage** | mg | 高密度切换，靠节奏而非叙事 |
| 竖屏卡片 / 短句 | **night-card** | editorial | 1080×1920，为信息流里的单屏而生 |

## 十三支一览

| 代号 | 中文 | 画面是什么 | 帧率 / 画幅 | 入口 |
|---|---|---|---|---|
| `paper` | 纸感 | 米白纸面 + 印刷体 + 荧光笔强调 | 60 / 1920×1080 | `--kit paper` |
| `science` | 科普 | 圆框图解 + 扁平讲解员 + 引线标注 | 30 / 1920×1080 | `--kit science` |
| `clay` | 黏土 | 3D 黏土质感的图示模块 | 30 / 1920×1080 | `--kit clay` |
| `collage` | 拼贴 | 深色科技风，高密度快剪 | 60 / 1920×1080 | `--kit collage` |
| `iso` | 等轴爆炸 | 等轴测零件拆开、阵列、特写、合拢 | 60 / 1920×1080 | `--kit iso` |
| `diagram` | 说明性图示 | 13 类数据/关系/结构图，支持字级锚点 | 30 / 1920×1080 | **`kits/diagram/render.mjs`** |
| `night-card` | 竖屏卡 | 深色情绪向，一屏一句 + 四角取景框 + 底部进度线 | 30 / 1080×1920 | `--kit night-card` |
| `chalkboard` | 黑板几何 | 光源、轨道、本影、投影**算出来**而不是画出来 | 30 / 1920×1080 | `--kit chalkboard` |
| `cute-mv` | 歌词 MV | chibi 矢量角色 + 底部歌词条 + 3D 关键词，零素材 | 30 / 1920×1080 | `--kit cute-mv` |
| `sketchnote` | 手绘笔记 | 米色纸上的抖动描边、荧光笔、便签 | 30 / 1920×1080 | `--kit sketchnote` |
| `editorial` | 现代图文 | 图文口播的杂志化排布（段型与 paper 相同，换视觉） | **24** / 1920×1080 | **`npm run editorial`** |
| `desk` | 桌面 | macOS 桌面实拍感，窗口与光标 | 60 / 1440×1080 | **`npm run desk`** |
| `mg` | 主题动效 | 代码驱动的主题动效段（intro / archive / blackhole…） | 60 / 1920×1080 | **`npm run mg`** |

段型一览（**有段型枚举**的是 `paper` / `editorial` / `science` / `collage` / `iso` / `diagram`；
`desk` 是镜头表、`clay` / `mg` 按各自机制走）：

| 版式 | 段型 / 镜头 |
|---|---|
| `paper` | hero point number compare steps quote checklist outro broll **grid chart** |
| `editorial` | 同 paper（11 种，无 broll 的图表画法） |
| `science` | cover talk compare diagram matrix focus tip outro |
| `collage` | open hero adapt flow pack recipe reuse share spec finale end |
| `iso` | hero rise explode part action array stack assemble end layer orbit |
| `diagram` | data-bar data-line hierarchy cycle definition compare process causal parts experiment evidence formula recap |

**`paper` 与 `editorial` 段型同名，但画法不通用**（2026-11-14 实测纠正）。

两者都认 `hero / point / number / compare / steps / quote / checklist / outro`，看起来可以互换，实际不行：

- `paper` 后来加了 `grid` / `chart`，`editorial` 没有对应画法；
- 把 `paper` 的 `params` 喂给 `editorial`，不认识的段型会**静默画一张白纸**，成片像"加载失败的 PPT"，
  而 gate 的帧数 / 空帧 / 黑帧检查**全部通过**（实测 6126 帧判 PASS）。

已修：`editorial` 遇到不认识的段型直接报错，不再降级。**结论：换版式要换参数，不能只换入口。**
同一份 `params` 只在同一支渲染器（含其全部段型）内部通用。

## 七种讲法（内容模型，与版式正交）

`tools/knowledge/guide.json` 里的母版决定**怎么讲**，上面的版式决定**长什么样**，两者独立组合：

| 代号 | 母版 | 适合的选题 | 惯例时长 |
|---|---|---|---|
| A | 猜谜概念片 | 抽象概念（熵、本福特定律、贝叶斯） | 3:30–4:30 |
| B | 两难选择片 | 历史事件、博弈论、心理学实验 | 定长 2:55 |
| C | 痛点原理片 | 日常困扰 × 冷门原理 | 2:00–2:30 |
| D | 一条主线片 | 学科体系、技术史、器物身世 | 约 3:00 |
| E | 闯关片 | 考试题型、方法论、流程 | 4–6 分钟 |
| F | 六面轮转片 | 哲学流派、观点对比 | 45–60 秒 |
| G | 数据叙事片 | 时间序列、排名、分布、前后对比（气候、人口、价格史） | 11 拍 · 约 2:00–2:30 |

典型视觉组合（**是参考，不是映射表**）：**A + paper**（知识科普）、**C + clay**（机制解释）、
**B + editorial**（历史叙事）、**F + night-card**（竖屏短句）、**D + iso**（器物拆解）、
**E + diagram**（流程/结构）、**G + paper**（走 `chart` / `grid` 段）。

> **骨架只出两种格式**：`new.mjs` 默认产出 science 的 `segments[]`，加 `--target paper` 产出
> paper 的 `scenes[]`。渲染命令必须与骨架同源，否则报「不支持段型」。
> `guide.json` 的 `pairing.first` **不能**拿去拼 `--kit`——那是旧表，B/D/E/F/G 曾因此指向错误渲染器。

## 换版式不换速度

九支 kit 与四支三件套模板共用 Skia，换版式只改画面不改渲染路径：

| 速度档 | 代号 | 构成 | 实测 |
|---|---|---|---|
| 极速 | `fast` | Skia + GPU 壁纸 + 裸帧 | 344 fps |
| 标准 | `std` | Skia + 静态壁纸 + 压缩帧 | 189–210 fps |
| 浏览器 | `chrome` | Chromium（film-kit 这类） | 55 fps |

## 想加下一支

判断标准（详见 `docs/AGENTS.md` §1.1）：**先问用途，再问技术；默认 Chrome，别拿换宿主当性能手段。**

| 用途 | 走哪 |
|---|---|
| 一次性出片 | Chrome 直接跑，成本 0 |
| 短期反复（源码可读 + Canvas2D） | 换宿主，几小时 |
| 长期产线 | 半蒸馏（蒸内容模型，非视觉代码），2–4 天 |

落地两步：`tools/new-film.mjs` 建片验证选型；要长期保留就加 `kits/<id>/` +
`api/kits/<id>.mjs`（文件名必须等于 id，注册表自动发现），再跑 `npm run inv && npm run check`。
