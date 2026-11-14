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
