# kits/iso/ · 等轴测爆炸大片（iso-explode-film 蒸馏）

> 把一件产品拆成几十个凸块零件，按层爆炸、阵列飞散、核心件特写拆解、机构按压、夹层推镜，
> 最后一层层合拢。**Canvas2D 直出，不经过浏览器，不落中间帧。**
>
> 上游：`Warrickchenxin/iso-explode-film`（等轴爆炸大片 skill，MIT）。
> 本地副本在 `refs/vendor/iso-explode-film/`（不入库），蒸馏结论见 `docs/iso-explode-蒸馏-2026-11-14.md`。

## 一条命令

```bash
node render.mjs --kit iso --params content/iso-powerbank/params.json --out out/iso.mp4
node render.mjs --kit iso --params content/iso-powerbank/params.json --probe out/a.png --at 8
```

实测 1638 帧 / 27.3s / 1920×1080@60：**13.3s（123 fps，15 worker）**。

同一份 content 出两版配色（与上游一致）：

```bash
node render.mjs --kit iso --params content/iso-powerbank/params.json --out out/a.mp4
ISO_LOOK=dark node render.mjs --kit iso --params content/iso-powerbank/params.json --out out/b.mp4
```

音频走 params.audio（`src/audio-mix.mjs`）：配乐用 `tools/synth-bgm.mjs` 代码合成（零素材、
drop 自动落在最长/信息最满那一段 = 爆炸开头），转场与落位用内置 `whoosh / tick / impact / rise` 事件轨。

## 内容模型

```jsonc
{
  "fps": 60, "width": 1920, "height": 1080,
  "content": {
    "title": "PB-1",            // 右上角图版标记 + 收尾型号
    "look": "split",            // split 灰橙桌面 / dark 深色柔光
    "radius": 148,              // ≈0.8 × 包围盒对角线；所有机位按它缩放
    "bounds": [[-84,84],[-37,37],[0,35.6]],
    "layers": [ { "id":"top", "zh":"上壳", "en":"TOP SHELL" }, … ],  // 从上到下
    "parts":  [ { "id":"topShell", "layer":"top", "x":0,"y":0,"z":22.4,
                  "w":152,"d":74,"h":6.6,"r":9, "material":"shell" }, … ],
    "arrays": [ { "id":"cells", "layer":"cells", "rise":34, "spread":0.85 } ],
    "hero":   { "part":"buttonCap", "size":10.4, "pull":22, "hover":11, "steps":[10,6] },
    "mech":   [ { "dir":[0,0,-1], "travel":1.6 } ]
  },
  "scenes": [
    { "type":"hero", "t0":0, "t1":3.4, "args":{ "intro":"act" } },
    { "type":"explode", "t0":5.4, "t1":10.5, "args":{ "card":{ "big":"7 层", "small":"{parts} 件" } } }
  ]
}
```

九种镜头：`hero / rise / explode / part / action / array / stack / assemble / end`。
完整字段见 `params.schema.json`，示例见 `content/iso-powerbank/params.json`。

## 几何规则（不是审美，是排序成立的条件）

- **只用凸块**：`box`（圆角矩形柱）/ `cyl` / `prism`（自定义凸多边形）。L 形、U 形、环形要拆成几块。
- **零件不许穿插**。两件互穿时，分离轴测试三个轴全重叠 ⇒ 排不出先后 ⇒ 画出随机破面。
  上游的硬规则就是这一条；本实现不再用深度兜底（兜底会造环，实测 32 条边被违反）。
- **共面也危险**：贴在 PCB 上的元件要抬高 0.1–0.3 mm，别正好压在同一平面上。
- **侧面要有壁**：只有上下壳时，中段内部件会从侧面露出来（一圈黑缝）。用四面 `shellDark` 侧壁
  （`content/iso-powerbank` 的 `wallN/S/W/E`）补上，且侧壁要内缩 2–3 mm，否则圆角处会戳出尖角。
- **配色**：外壳一个主色、内部 2–3 中性色 + **只给一件**用强调色（本例是红色按键）。

## 实现要点

| 文件 | 内容 |
|---|---|
| `model.mjs` | 投影（含针孔透视）、凸块面生成、材质 4 级明暗、**零件级遮挡顺序**、通道 → 位移 |
| `plan.mjs` | 分镜 → 通道关键帧 / 机位 / 字卡 / 层标注窗口；**按主体包围盒反算机位** |
| `iso.mjs` | 背景（灰橙分色 / 深色柔光）、阴影、绘制、层标注、字卡、图版标记 |

### 遮挡顺序（`orderParts`）

按面心深度排序会错：顶壳是一块 152×74 的大板，面心深度被 x/y 拉低，电芯会画到顶壳上面。
上游的做法是**预先算两两之间的分离平面**；本实现在每帧对零件对做分离轴测试：

1. 只要在某个轴上完全分开，就由该轴决定谁在前（`d[a]` 的符号 = 相机在轴的哪一侧）；
2. 两个轴给出相反结论 ⇒ 两件在屏幕上本来就分开，**不建边**；
3. 三轴全重叠（互穿）⇒ 也不建边（这是内容错误，排序器不替它擦屁股）；
4. 得到偏序图后拓扑排序；有环时挑"最远"的一件强制出队。

### 机位（`fitCam`）

手抄 zoom 一换产品就废。每个镜头先取主体（整机 / 核心件 / 某个阵列 / 某一层），
按当前通道状态求世界包围盒 → 试投 → 反算 `zoom = min(fill·W/bw, fill·H/bh)` 与 `pan`。
核心件被 `pull` 抬走后，`sample()` 只补「当前 − 取景时」的高度差，主体始终在画面里。

## 位图背景（`content.backdrop`）

```json
{ "content": { "backdrop": "assets/gen/studio-backdrop.jpg" } }
```

`drawBackdrop` 优先画这张图（cover 铺满），并做两件事：

- **伪视差**：按 `zoom` 放大 `1+(z−1)*0.06`、按 `panX/panY` 反向平移 `0.25`。系数刻意做小——
  放大过头会露边，纹理也会"飘"得像贴纸。位移必须夹在能铺满的范围内（`panX` 一负就在左侧露黑边，实测 16 px）。
- **距离雾化**：`zoom < 1.15` 时按 `(1.15−z)/0.35*0.5` 蒙一层浅色。爆炸镜头把主体缩到 1/3 画面，
  近景木桌会显得"人是小的、桌是近的"，蒙一层就对了。

⚠ 解码只能走 `loadImage`（异步），所以渲染器提供了 `ready()`，`render.mjs` 在 `pumpFrames` 之前
`await r.ready()`（与 science/collage 同一约定）。`new Image(); img.src = buf` 在 napi-rs 里
width/complete 都对，但 `drawImage` 画出来是全透明——踩过一次。

## 贴片（`kind: 'sprite'`）

```json
{ "id": "duck", "kind": "sprite", "src": "assets/gen/duck-sprite.png",
  "x": 0, "y": -1, "z": 8, "w": 70, "h": 78,
  "showIn": ["explode", "layer", "orbit"] }
```

- **永远是面向相机的平面**：`w` 按两端投影实测像素宽（针孔下不能直接乘 k），`h` 由图片比例推。
  镜头 yaw 一转就露馅，所以只用在"机位基本固定"的镜头；`showIn` 按镜头类型切换（同一只鸭子做了
  「杯里只露头」和「整只」两张图）。
- 没有面集：`buildFaces` 返回空数组，`bbox` 按声明尺寸补一个极薄的盒（取景与层标注要用）。
- **必须补接地阴影**：贴片没有底面，不补一块就浮在半空——特写镜头最明显。阴影按底部中心投影画椭圆。
- 图同样只能 `loadImage` 异步解码，走渲染器的 `ready()`。

## 核对外廓：正交三视图

```bash
node tools/iso-ortho.mjs --params content/<片>/params.json --out out/ortho.png
```

统一比例尺（三格同 zoom，一个 mm 占同样像素）、`distance = 600R` 逼近正交、排除 `static` 道具件。
用途是和素材照片并排量宽高厚——透视图里几层叠一起量不出比例。同时会把 `content.bounds`
与实测外包对账，偏差 >2% 红字告警（手写常量偏大 6–7% 是常态）。

## 几十层怎么做

- **等间距层距**：`content.spacing`（mm/层）。默认曲线是按 6–8 层调的，24 层会挤成每层 5 mm；
  给了 spacing 就按 `(NL-1-i) × spacing` 均匀拉开（24 层 × 13 mm = 299 mm 高的柱）。
- **`layer` 镜头**（逐层展示）：镜头停在一层上、缓慢侧转 10°，其余层降到 8% 幽灵；
  主体描一圈 `rgba(214,228,255,.45)` 的亮边——黑玻璃、电芯这类深色件在深底上只有轮廓可读。
- 转场用 `orbit` 在层与层之间移动，比甩镜更像"沿着柱状结构往上走"。

## 运动：转场 / 循环 / 模糊

- **转场**（每个镜头 `args.transition`）：
  - `whip`：0.26 s 五次方缓动甩镜（默认）；
  - `orbit`：绕到目标机位，中点抬高、侧绕 20°、荷兰角 10°、变焦压 0.84 —— 视差与轮廓同时变，读作"绕过去"；
  - `spin`：原地转 360°（0.52 s，正弦缓动），终点与起点同向，衔接无缝。
- **荷兰角**：相机基向量绕视线轴旋转（`roll`），`makeCamera` 里做，`sampleCam` 按关键帧插值。
- **循环镜头** `orbit` 类型：正弦摆动 ±sweep、roll ±3，段首段尾完全相同 ⇒ 这一段可直接当循环素材。
- **末尾静止的目标必须等于最后一帧机位**：差 3° 就会让整段后半程持续漂，pacing 的 hold 直接判 4 帧（实测）。
- **运动模糊**：转场窗口内 8 个子帧，先各自画到离屏画布（不透明），再按 1/N 加性叠到累加图。
  直接叠半透明残影只会得到重影边；在一张图上直接叠子帧会因同帧多面叠加而过曝。

## 坑

- **`whipTo` 先插一个 `t−1e-3` 的起点键**，键序会倒退；采样按数组顺序走，不排序会读到"未来"的键
  （实测 zoom 卡在 7.8 而不是 9.5）。`buildPlan` 末尾必须 `sort`。
- **甩镜会从还没合拢的层里穿过去**：`part` 镜头要先合层（0.2s）再甩（0.16s 后开始），
  否则中间二十帧是一块黑支架糊满屏幕。
- **末尾要留静止**：`settle()` 让最后 0.8s 机位不动。`tools/pacing.mjs` 的 hold 判据
  （≥30f@30fps）就是抓"落位即切"；不留静止，9 段里 4 段不达标。
- **桌面不要放进三维里投影**：特写镜头 `D ≈ 2.6R`，桌面远端会落到相机背后，透视除法把坐标翻面，
  橙色铺满整帧。改成屏幕空间的一条斜线（`lx = 0.58W`），字卡永远在灰侧。
- **阵列/夹层的取景**：尺幅小的层（电芯 130×58）在低机位下只剩两条板，上面的大件会闯进画面。
  这两镜目前是弱项，见蒸馏文档「已知未做」。
