# SPEC.md · 粉笔黑板的结构规律

> 只写「换一支内容还能用」的规律。来源：半蒸馏自 `knowledge-explainer-chalkboard v2.7.4`（@adunext，MotionGit），
> 只借内容模型（8 个 mechanism 的字段契约 + 几何语义 + 21 个内容族到机制的映射），
> 渲染层（粉笔笔触、板面、版式坐标、字体排布）全部自写。

## 一、八个机制的分工

这不是八个"皮肤"，是八类几何关系。选错机制，参数再对也讲不清。

| 机制 | 讲什么 | 必备参数 | 画面构成 | 每片次数 |
|---|---|---|---|---|
| `orbit-phase` | 同一球体绕行，可见受光比例随角度变 | `model` + `phaseKeys` | 左轨道 + 右相位盘 | 不限 |
| `surface-view` | 把球取出放大，看光从哪一侧来 | `model` + `phaseKeys` | 左大球（5 条入射光）+ 右缩略轨道 | 不限 |
| `shadow-overlap` | 本影与球面圆面相交的面积决定遮挡 | `model` + `phaseKeys` | 左轨道 + 右上相位盘 + 右下截面 | 不限 |
| `inclined-orbit` | 轨道有倾角，俯视排成线也可能避开 | `model` + `nodeKeys` | 左倾斜轨道 + 右相位盘 | 不限 |
| `projection-compare` | 同一三维状态，两个投影看起来不同 | `model` + `phaseKeys` | 左右两幅投影（beta 0 / 0.43π） | 不限 |
| `causal-compare` | 外观相近、原因不同（缺光 vs 被挡） | `model` + `comparison` | 左右两个球，中间一条竖线 | 不限 |
| `ray-topology` | 每条光路停在遇到的第一块挡板 | `optics` | 左光路图 + 右挡板清单 | 不限 |
| `condition-proof` | 几何谓词逐条判真假，结论跟随状态 | `model` + `conditions` | 左轨道（含影）+ 右条件清单 | 不限 |

选择规则（来自上游 `AI-CHOICES.tasks` 的 21 个内容族到机制映射）：

| 内容要讲的东西 | 用哪一支 |
|---|---|
| 概念、定义、单点标注 | `orbit-phase` |
| 光照方向、局部放大 | `surface-view` |
| 挡住多少、遮挡过程 | `shadow-overlap` |
| 为什么有时挡不住 | `inclined-orbit` |
| 看到的不等于发生的 | `projection-compare` |
| 两个相似现象的原因拆解 | `causal-compare` |
| 哪块板挡住了哪几条 | `ray-topology` |
| 多个条件同时成立才算 | `condition-proof` |

## 二、容量（schema 与画面双重约束）

| 字段 | 上限 | 来源 |
|---|---|---|
| `title` | 44 字 | schema maxLength；标题带 0.66W，超过两行 |
| `labels.*` | 12 字 | 画面单行标签；超过会被 `label()` 折行，两行就挤出内容区 |
| `phaseKeys` / `nodeKeys` | 2–12 个 | schema；必须覆盖 `0 → 段长`，否则末帧停在中间角度 |
| `optics.blockers` | 6 个 | 右栏每条挡板占两行（名称 + 拦截数） |
| `optics.rays` | 1–24，可读 7–9 | 再多光路糊成一片，看不出"哪条被谁挡" |
| `conditions` | 1–4 个 | 右栏每行 0.045H 的判定语 |
| 字幕 | 30 字/行（46px） | 1660px 安全宽 ÷ 46px ≈ 33，留余量 |

## 三、实测的排版参数

调出来的，不是拍的。改版式先按这组值：

| 项 | 值 | 为什么 |
|---|---|---|
| 轨道半径 | `min(box.w*0.33, box.h*0.39)` | 0.31/0.36 时俯视图会缩成一团 |
| 标题带 | 0.055–0.128H | 标题基线 0.108H，横线 0.128H |
| 内容区 | 0.165–0.885H | 下沿留 0.885H 给字幕带（0.912H） |
| 左/右分栏 | 0.60 / 0.40（`shadow-overlap` 用 0.50/0.48） | 右栏只放得下两组数值，四组就挤 |
| 相位盘半径 | `min(box.w*0.26, box.h*0.19)` | 0.22 时球占框高 88%，视点框失去「窗口」的意义 |
| 视点框 alpha | 0.30 | 只是分区提示，0.4 以上和球抢视线 |
| 本影填充 alpha | 0.55 + 红色边界线 | 0.9 会让球体轮廓消失，只剩一团棕 |
| 截面区高度 | `area.h*0.46` | 0.40 时本影圆与球一起缩小，交集看不出来 |
| 文字压线 | `label(..., {bg: T.board})` | 黑板上字压线是常态，靠「先擦再写」解决，不靠手算避让 |
| 字幕 | 46px / y=0.912 / 底条 = 擦净板面 | 半透明黑方块像 UI 贴图，不像黑板 |
| 角标 | 0.021H，y = H−34 | 字幕带在 0.912H，角标必须让到最底 |
| 描出时长 | `focus` 起 0.85–0.95s | 短于 0.7s 像闪，长于 1.2s 拖 |
| 段长舒适区 | 8–12s | 再短看不清相位怎么走 |

## 四、几何语义（内容模型里真正值钱的部分）

半蒸馏借的是这几条式子，不是它的绘制代码。实现见 `src/kit.js` 的 `geo`。

**轨道位置**：θ 为轨道相位，node 为节点相位，incl 为倾角。

```
a  = π − θ − node
x  = R·(cos a·cos node − sin a·sin node·cos incl)
y  = R·(cos a·sin node + sin a·cos node·cos incl)
z  = R·sin a·sin incl
```

**可见受光比例**：光源在 −x 侧、平行光。

```
fraction = (1 + light·eye) / 2,  light = (−1,0,0),  eye = −pos/|pos|
```

**本影半径**（相似三角形，遮挡片是圆片不是点光源）：

```
umbra = occluderRadius − pos.x·(sourceRadius − occluderRadius) / sourceDistance
```

**圆面重叠比例**：标准双圆交叠面积 ÷ 球投影面积。

**光路求交**：每条光线与每个挡板解二次方程，取最小 u ∈ [0,1] 的交点截断。

**四个条件谓词**：

| 谓词 | 判据 | 画面文案 |
|---|---|---|
| `near-opposition` | `pos.x > 0 且 \|sin θ\| < sin 5°` | 处于对向位置 |
| `within-shadow-height` | `umbra > 0 且 \|pos.z\| ≤ umbra + bodyRadius` | 位于影高范围 |
| `shadow-contact` | `blocked > 1e-8` | 发生圆面重叠 |
| `direct-center-ray` | 光源到球心的最近距离 ≥ occluderRadius | 中心光路可达 |

## 五、几何的确定性

**明暗界线的两个端点在圆的上下顶点，不在左右端点。**

界线是 `x = −c·√(r²−y²)`，`c = light·eye`。端点搞错时，`c=1`（满相）也填不满整圆，
表现为"满相的球仍然全暗"。正确路径 = 右半圆（下顶点→上顶点）+ 界线（上顶点→下顶点）。

**抖动种子来自元素 id 与下标，不来自时间。** 用时间当种子粉笔毛边会逐帧重算，成片像在沸腾。

**交集高亮必须画在球之后。** 截面图里「球 ∩ 本影」那块红色是唯一能把 `blocked` 百分比
落实到画面上的东西。画在球之前会被球体填充整个盖掉——上一版就是这样，红色一点看不见，
只留下一个看不懂的 32.7%。

## 六、双宿主

同一份 `src/` 两个宿主：

| 宿主 | 入口 | 字体 |
|---|---|---|
| Chromium | `src/index.html` | 系统 PingFang SC（无 LongCang 时退化） |
| Skia | `render.mjs --kit chalkboard`（`src/webcanvas.mjs`） | 随包 LongCang + LXGW WenKai |

本模板**不依赖任何位图素材**（粉笔质感是路径 + 抖动 + 粉尘点，不是贴图），
所以双宿主之间没有"姿态图静默退化"那类问题。字体是唯一的宿主差异。

## 七、交付前自检

```bash
python3 tools/check-template.py --src templates/own/chalkboard
node render.mjs --kit chalkboard --params templates/own/chalkboard/presets/default.json \
  --out out/chalkboard-demo.mp4 --workers 8
node src/gate.mjs out/chalkboard-demo.mp4
```

实测：

| | 帧 | 时长 | 体积 | 出片 | 吞吐 | gate |
|---|---|---|---|---|---|---|
| 无声（4 段） | 1020 | 34.00s | 1.48MB | 6.1s | 167 fps | PASS |
| 配音（4 段 8 句） | 919 | 30.63s | 1.92MB | 6.4s | 144 fps | PASS（`--require-audio`） |

配音版段长由 `vo.py` 重排为 8.24 / 7.06 / 7.45 / 7.88s；
音轨 `pcm_s16le → aac 160k` 由管道的 codec 探测自动完成（PCM 直接进 mp4 会让浏览器整轨静音）。
