# 科普版式 · 医学科普知识讲解

把一条中文医学科普片蒸馏成**可换文案的 `.motion` 模板包**。8 类版式、字幕烧录、零外部素材可跑。

- 画幅 1920×1080 / 30fps / 54.5s（demo）
- 两条运行路径（同一份 `src/`，画面一致）：
  - `html-canvas/1`：Node 22+ / Chromium headless / FFmpeg，字体用系统 `PingFang SC`
  - `skia/1`：Node 22+ / `@napi-rs/canvas` / FFmpeg，**零浏览器**，字体用随包 Noto Sans SC
- Skia 直出实测快 20–27%，详见 [SKIA-SPEC.md](SKIA-SPEC.md)

## 蒸馏自

`d6ef49c88c4766217c388678d9ba7aca_raw.mp4` — 153.64s / 960×544 / 28fps / 48 切点 / 中位镜头 2.75s。

复刻的是**信息语法**（版式、节奏、标签语汇、字幕规范），不是画面素材。原片的插画、器官图、角色、文案、品牌标识均未复制。详细数据见 [SPEC.md](SPEC.md)。

## 八类版式

| 版式 | 用途 | 一句话 |
|---|---|---|
| `cover` | 开场钩子 | 洋红爆炸贴 + 双色标题 + 黄标签副标 |
| `talk` | 讲解位 | 右（左）侧半身讲解员，另一侧放 1–3 行要点 |
| `diagram` | 原理图解 | 格子纸 + 白圆盘 + 拟人器官 + 探头声波 + 引线标注 |
| `compare` | 新旧对比 | 左右卡片 + 红箭头 + 对错角标 + 金句条 |
| `matrix` | 清单枚举 | 3–4 个圆卡图标 + 胶囊标签 |
| `focus` | 单点卖点 | 梯形标题条 + 黄底圆卡 + 被划掉的旧认知 |
| `tip` | 知识小贴士 | 胶带便签 + 勾选条目 |
| `outro` | 结尾 | 两条斜切色块 + 免责声明 |

## 运行

```bash
node motion-render.mjs plan     --package templates/own/science-explainer
node motion-render.mjs preview  --package templates/own/science-explainer --out out/preview
node motion-render.mjs render   --package templates/own/science-explainer --out out/demo.mp4 --jobs 6
node skia-kit/gate.mjs out/demo.mp4
```

实测：1635 帧 / 10.1s（≈162 fps）/ 5.14 MB / 门禁 PASS。

Skia 直出（不需要 Chromium）：

```bash
node skia-kit/render.mjs --kit science \
  --params templates/own/science-explainer/presets/demo.vo.json \
  --audio out/demo.vo.wav --out out/demo-skia.mp4 --fps 30 --workers 20
```

实测：2215 帧 / 11.3s（≈196 fps）/ 6.88 MB / 门禁 PASS；同片 canvas 版 14.37s（154 fps）。
单帧探针用 `--probe out/f.png --at 12.5`，调版式时秒级出图。

## 配音（关键：配音决定时间轴）

模板只出画面。音轨用 `tools/vo.py` 生成，而且**让配音反过来决定时间轴**：

```bash
uv run --with numpy python tools/vo.py \
  --preset presets/microwave.json \
  --out-preset presets/microwave.vo.json \
  --out-audio out/microwave.vo.wav \
  --voice zh-CN-XiaoxiaoNeural --rate +8%

node motion-render.mjs render --package . --style microwave.vo \
  --audio out/microwave.vo.wav --out out/film.mp4 --jobs 6
```

`vo.py` 做三件事：

1. 逐句 edge-tts，**实测**每句时长（不猜）
2. 重算段落：段长 = 段首留白 0.45s + 本段句音频 + 句间隔 0.28s + 段尾留白 0.55s
3. 把句子按新起点写进全长静音底，并做 -16 LUFS 响度归一化

**不要反过来**（先定死 50s 再塞配音），那样只能变速或砍字。参考片的节奏本来就是被口播决定的：实测中位镜头 2.75s ≈ 一句话的长度。

`tip` 版式的 `itemAt` 由 `vo.py` 自动写入 —— 第 i 句开播就点亮第 i 条，长镜头不再静止。

实测：原 50s 脚本配完音变 64.8s，各段按语音重新分配；医学版 54.5s → 73.8s。

## 双人对白 + 会动的人物

`talk` 段现在支持三种东西，足够做「一问一答」的亲子/医患对话：

| 能力 | 参数 | 说明 |
|---|---|---|
| 两个音色 | `voices: {kid, mom}` + `captions[].speaker` | 每个角色一个 TTS 音色，`vo.py` 按 speaker 分配 |
| 角色区分 | `coat` / `hair` / `eyebrowColor` | 孩子蓝外套、妈妈橙外套，眉标竖条同色 |
| 人物动作 | `gesture` = `idle / explain / open / point / count / nod` | 手会抬起来比划；呼吸、眨眼常驻；说话时嘴型开合 |
| 口型同步 | `talking` | 由 `vo.py` 按配音写入说话区间，不播的时候闭嘴 |

人物是**分层骨骼**（躯干 / 手臂 / 颈头三层），不是逐帧插画：

- 躯干：呼吸起伏 ±3px
- 头：绕脖根旋转（点头/摇头），每 3.9s 眨一次眼
- 嘴：`mouth` 0..1 控制开合，说人话时用 11Hz + 5Hz 双谐波，避免机械匀速
- 手臂：肩→手端点用二次贝塞尔连接，`gesture` 控制抬到胸前

**做不到的**：原片那种逐帧手绘的微表情和身体转动。这是程序化骨骼的边界——想要那种精度只能上插画素材（`figureImage` 槽位已经留好）。

## 3D 软胶人物素材（flux-3-image 生成）

`assets/figures/` 里有 4 个姿态的同一角色，透明底 PNG（720×980）：

| 文件 | 姿态 |
|---|---|
| `idle.png` | 双手垂在身侧 |
| `explain.png` | 右手抬起比划 |
| `open.png` | 双手摊开 |
| `point.png` | 食指指向左侧 |

接入方式：`index.html` 里以 `<img data-fig="idle" src="../assets/figures/idle.png">` 挂载，
渲染器内联成 dataURL；`talk` 段按 `gesture` 在姿态间做 0.34s 混合，叠加呼吸起伏与轻微摆动。

- `figure: 'none'`：该段不画人（提问段只出字卡，回答段才让医生出场）
- `figures: false`：强制回退到内置矢量人物
- `figureHeight`：人物高度占画面比，默认 0.86

生成与抠图链路：flux-3-image（`aspect_ratio 3:4` / `resolution 1k`，用首张做 reference 保证同角色）
→ PIL 四角 floodfill 去白底（thresh 46）→ 近白残留清零 → alpha 收缩 1px → 羽化 0.7 → 统一底对齐。

## 换内容

改 `presets/demo.json`（或复制一份用 `--style` 指定）：

1. `captions` — 口播字幕，一条一句，句间留 0.1s
2. `segments` — 镜头序列，`type` + `dur` + `args`
3. `theme` — 六个强调色即可换整套品牌色
4. `brand` — 左下角角标；`show:false` 关闭

`guide.json` 里有每个版式的参数说明与容量上限。

## 边界

- 不生成语音、不生成配乐（要配音用 `--audio` 传文件）
- 器官图形是矢量示意，不是医学精确图；做持证宣教请替换为专业插画
- 只有横屏；竖屏需重排版式，不能裁切
- 未随包分发字体；Windows 会回退到微软雅黑，字重观感会变

## 许可

见 [licenses/TEMPLATE-LICENSE.txt](licenses/TEMPLATE-LICENSE.txt)。源码原创，可自由修改复用；不含第三方图片、音频、字体。
