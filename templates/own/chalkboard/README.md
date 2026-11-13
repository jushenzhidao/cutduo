# 粉笔黑板（`chalkboard`）

> 一支用真实几何讲知识点的模板：光源、轨道、本影、投影都是算出来的，不是画出来的。

## 这是什么

- **画面语言**：深墨绿板面 + 粉笔手写体（LongCang）+ 白/黄/蓝三色粉笔线，线条带抖动、粉尘与断点。画面统一「左几何 / 右数据」两栏，右侧给可核对的百分比与判定结果。
- **适用内容**：需要**几何解释**的知识讲解——相位怎么变、影为什么会落到球上、为什么有时挡不住、两个相似的暗现象原因不同、哪块板挡住哪几条光。
- **不适用**：纯观点输出、人物访谈、产品宣传、需要大量真实照片或图标的题材。它没有通用图示库，也没有图标库。
- **来源**：半蒸馏自 `knowledge-explainer-chalkboard v2.7.4`（@adunext，MotionGit）。**只借内容模型**：8 个 mechanism 的字段契约、几何语义（相位角 / 本影锥 / 圆面重叠 / 光路求交）、21 个内容族到机制的映射、条件谓词定义。渲染层全部自写，未复制其素材、文案、品牌标识、13 类通用图示库与 102 个图标。

## 八个机制

| `type` | 讲什么 |
|---|---|
| `orbit-phase` | 同一球体绕行，可见受光比例随角度变 |
| `surface-view` | 把球取出放大，看光从哪一侧来 |
| `shadow-overlap` | 本影与球面圆面相交的面积决定遮挡 |
| `inclined-orbit` | 轨道有倾角，俯视排成线也可能避开 |
| `projection-compare` | 同一三维状态，两个投影看起来不同 |
| `causal-compare` | 外观相近、原因不同（缺光 vs 被挡） |
| `ray-topology` | 每条光路停在遇到的第一块挡板 |
| `condition-proof` | 几何谓词逐条判真假，结论跟随状态 |

选型与容量见 `SPEC.md` 第一、二节。

## 怎么用

```bash
# 1. 结构体检（不需要渲染）
uv run python tools/check-template.py --src templates/own/chalkboard

# 2. 出片（Skia 直出，不启浏览器）
node render.mjs --kit chalkboard --params templates/own/chalkboard/presets/default.json \
  --out out/chalkboard-demo.mp4 --workers 8

# 3. 交付门禁
node src/gate.mjs out/chalkboard-demo.mp4
```

带配音（时间轴由配音反推，不是配音迁就时间轴）：

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

uv run --with numpy python templates/own/sketchnote/tools/vo.py \
  --preset templates/own/chalkboard/presets/voiced.json \
  --out-preset templates/own/chalkboard/presets/voiced.vo.json \
  --out-audio out/chalk-vo.wav --voice zh-CN-XiaoxiaoNeural

node render.mjs --kit chalkboard \
  --params templates/own/chalkboard/presets/voiced.vo.json --audio out/chalk-vo.wav \
  --out out/chalkboard-vo.mp4 --workers 8

node src/gate.mjs out/chalkboard-vo.mp4 --require-audio
```

内容怎么改：只动 `presets/*.json`。`presets/recipes.json` 是八个机制各一段的样板（80s），
`presets/default.json` 是四段演示（34s），`presets/voiced.json` 带 8 句文案。

## 字体依赖（宿主提供，不随包分发）

这支模板的画面有一半是字体给的：`LongCang`（龙藏体）出粉笔字，`LXGW WenKai` 出数字与正文。
**两支都不在 `.motion` 包里**（包 145KB），由宿主的 `assets/fonts/` 提供。

```bash
bash tools/fetch-fonts.sh --verify   # 部署/换机器后先确认
bash tools/fetch-fonts.sh            # 缺了就补
```

缺字体时 Skia **不报错**，只是静默退化成 PingFang SC：画面结构仍对，黑板味全丢。
判据不能靠肉眼，用测宽（见 `docs/FONTS.md` §6）：同一串中文在 `LongCang` / `LXGW WenKai` /
`NotoSC Black` / 不存在的族名下会给出四个宽度，后两者相同即说明回退了。

OFL 许可原文在 `licenses/longcang-OFL.txt` 与 `licenses/lxgwwenkai-OFL.txt`。

## 文件在哪一层

| 层 | 文件 | 什么时候改 |
|---|---|---|
| L0 协议 | `motion.json` `motion.lock.json` `integrity.json` `licenses/` | 改身份、版本、输出规格。`integrity.json` 只由打包器生成 |
| L1 契约 | `SKILL.md` `guide.json` `params.schema.json` | 加机制、改容量、改节奏时三份一起改 |
| L2 内容 | `presets/` `assets/` `asset-manifest.json` | 每次出片 |
| L3 源码 | `src/` `tools/` | 改画面语言 |
| L4 说明 | `README.md`（本文件）`SPEC.md` `SKIA-SPEC.md` | 沉淀可复用规律 |

**改哪一层有讲究**：改 L2 不用重新打包就能出片；改 L1/L3 必须重新打包并重算 integrity。

## 四条不可破的约束

1. `durationSeconds` = `segments[].dur` 之和，差一点末段就被截断。
2. `src/kit.js` 与 `src/layouts.js` 不许出现 `document` / `window` / `createElement`。
3. 文案与颜色不许写进 `src/`，一律从 preset 来——`src/` 里剩下的中文只有兜底默认值与报错信息。
4. **几何必须真算**：百分比、倾角、通达条数都从 `geo.physical()` / `geo.rayState()` 推出，
   不许为了好看把数字写死。这是这支模板和"画个球配个数字"的区别。

体检脚本会把前三条扫一遍；第四条只能靠 review。
