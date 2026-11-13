# 夜色卡片（`night-card`）

> 竖屏 9:16 深色情绪向卡片：一屏一句话，四角取景框 + 底部进度线，暖金只出现在最需要的那一处。

## 这是什么

- **画面语言**：近黑底（`#0A0A0C`）+ 暖白字（`#F2EDE3`）+ 暖金点缀（`#E0A94A`），字重对比代替颜色对比
- **适用内容**：深夜独白、情绪向口播、图文卡片轮播、歌词式排版
- **不适用**：需要图解释意、数据图表、多栏信息的内容——这套版式刻意不提供这些能力
- **来源**：自建，无参考片。节奏与容量参数来自本模板 8 段示例的实测，不是估值

判断它是否合适，只看一条：**你能不能把内容压成一句一屏**。压不下去就换 `science` 或 `paper`。

## 六个版式

| type | 用途 | 关键参数 | 容量 |
|---|---|---|---|
| `cover` | 封面 / 开场钩子 | `kicker` `title` `sub` | title ≤ 12 字 |
| `statement` | 单句宣言 | `text` `note` `mark` `size` | text ≤ 24 字 |
| `quote` | 引言 / 他人口吻 | `text` `from` | text ≤ 40 字 |
| `contrast` | 前后对照 | `before` `after` | before ≤ 16 字 |
| `number` | 数字冲击 | `value` `label` `note` | value ≤ 6 字符 |
| `outro` | 收尾 / 落款 | `title` `sub` `brand` | title ≤ 10 字 |

`statement` 的 `mark: true` 会在句子上方加一个 8px 暖金圆点，用于「转折句」；
同一支片里最多用两次，多了就不算强调。

## 怎么用

所有命令都在仓库根执行：

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# 结构体检（不需要渲染）
uv run python tools/check-template.py --src templates/own/night-card

# 出片：Skia 直出，不启浏览器（去掉 --audio 就是无声片）
node render.mjs --kit night-card \
  --params templates/own/night-card/presets/default.json \
  --audio templates/own/night-card/assets/bed.m4a \
  --out out/night-card.mp4

# 交付门禁（--require-audio：没有音轨判失败，而不是只告警）
node src/gate.mjs out/night-card.mp4 --require-audio

# 走 API（agent 首选，JSON in / JSON out）
node api/cli.mjs validate --kit night-card --preset default
node api/cli.mjs render   --kit night-card --preset default --json

# 打包成可分发 .motion
uv run python tools/build-template.py --src templates/own/night-card --out packages/night-card.motion
node tools/motion-render.mjs inspect --package packages/night-card.motion
```

实测（含音轨）：`1680 帧 / 56.000s / 30fps / 4.22MB / 4.6s / 15 workers`，约 365 fps。
无声版 3.34MB / 4.9s，差别只在音轨，画面逐帧一致。

## 音轨

模板自带 `assets/bed.m4a`：56s 低频 pad + 粉噪，均值 −29.4 dB、峰值 −17.3 dB，**没有旋律**。
它是占位，不是配乐——发布时建议换成正式 BGM，长度不必正好 56s（管道按片长截断），
非 AAC 会自动转 160k AAC。

音轨是**替换**而不是混音：`--audio` 给的那条会盖掉原轨。要保留旁白 + BGM 两层，
先用 ffmpeg `amix` 混好再传进来。

## 内容怎么改

只动 `presets/*.json`：

```jsonc
{
  "durationSeconds": 56,          // 必须等于 segments[].dur 之和
  "theme": { "accent": "#E0A94A" }, // 只写要改的键，其余走完整调色板
  "segments": [
    { "type": "statement", "dur": 6.5, "text": "一句话", "note": "补一句" }
  ]
}
```

改品牌色只改 `theme`，不要动 `src/`。字幕默认留空——本模板正文就是大字，
再加字幕会和主句抢注意力；只有加旁白时才填 `captions`。

## 文件在哪一层

| 层 | 文件 | 什么时候改 |
|---|---|---|
| L0 协议 | `motion.json` `motion.lock.json` `integrity.json` `licenses/` | 改身份、版本、输出规格。`integrity.json` 只由打包器生成 |
| L1 契约 | `SKILL.md` `guide.json` `params.schema.json` | 加版式、改容量、改节奏时三份一起改 |
| L2 内容 | `presets/` `assets/` `asset-manifest.json` | 每次出片 |
| L3 源码 | `src/` `tools/` | 改画面语言 |
| L4 说明 | `README.md`（本文件）`SPEC.md` `SKIA-SPEC.md` | 沉淀可复用规律 |

改 L2 不用重新打包就能出片；改 L1/L3 必须重新打包并重算 integrity。

## 四个不可破的约束

1. `durationSeconds` = `segments[].dur` 之和，差一点末段就被截断。
2. `src/kit.js` 与 `src/layouts.js` 不许出现 `document` / `window` / `createElement`。
3. 文案与颜色不许写进 `src/`，一律从 preset 来——否则换内容就得改代码。
4. `type` 必须是 `params.schema.json` 枚举里的六个之一，拼错会被 `validate` 拒绝
   （这条是硬的：不接 API 直接跑 `render.mjs` 时，拼错只会落到「unknown layout」兜底）。

体检脚本覆盖前三条，第四条由 schema 校验覆盖。
