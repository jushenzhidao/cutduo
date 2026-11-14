# vendor/lemo/ · 从 lemo-opuscar 收编的最小渲染库

> 来源：`lemomo-ai/lemo-opuscar`（SSH 稀疏克隆，仅取 `core/render` + `styles/midcentury-toon`）。
> 用途：把它的**页面**当模板出片；本仓不复制它的故事、分镜与音轨。
> 许可：代码与文档见上游 `LICENSE`（文档 CC BY-NC 4.0、样片 CC BY 4.0）。本目录只做内部出片，不再分发。

## 目录

```
vendor/lemo/
  core/render/            page / serve / browser / video / still / slot（72KB，去掉了 three 与 3D 资产）
  styles/midcentury-toon/ 50 年代扁平卡通：demo/ + STYLE.md + DEMO.md
  assets/fonts -> ../../../assets/fonts   软链，避免 18MB 字体重复入库
```

`core/render/page.mjs` 以「`core/` 的上一级」为静态服务器根，所以这里的根是 `vendor/lemo/`。
中文字体用绝对路径 `/assets/fonts/...` 命中软链目标。

## 相对上游改了五处（都为了中文内容，不碰绘制逻辑）

| # | 文件 | 改动 | 原因 |
|---|---|---|---|
| 1 | `demo/index.html` | 追加 `fonts/fonts-zh.css` | 上游三个族名（Oleo / Slab / Jost）没有中文字形，直接渲成方框 |
| 2 | `demo/fonts/fonts-zh.css` | 新增：族名映射到 ZCOOL 快乐体 / 思源黑体 Black / Medium | 同上；映射族名比改 60 处 `ctx.font` 稳 |
| 3 | `demo/film.js` | `STEP n OF N` → `第 n 步 · 共 N 步` | 中文化 |
| 4 | `demo/film.js` | 末步固定 2 小节 → 按时长取小节 | 上游末句是 "Step three. Press start."（2.5s），中文 5.9s 会被下一段截断 |
| 5 | `demo/film.js` | 片尾署名行改 `midcentury-toon · 中文改编` | 上游写的是它的作者署名，不是本片 |

**未改**：`engine/*`、`STYLE.md`、所有绘制与时间线语义。

## 出片（一条命令）

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node vendor/lemo/render.mjs --params content/lemo-vacuum/script.json --out out/x.mp4
```

它自己做完五件事：**配音（缺哪句补哪句）→ 时长 → 页面算时间轴 → 混音 → 渲染 → 封装 → 自检**。
实测：47s 片 15s 渲完，全程约 40s（含 6 句 TTS）。

| 开关 | 默认 | 说明 |
|---|---|---|
| `--audio <m4a>` | 无 | 自带音轨，跳过 TTS 与混音 |
| `--fps` / `--workers` / `--crf` | 24 / 4 / 20 | 画面与编码 |
| `--bgm` / `--bpm` | chillwave / 100 | 垫底配乐（`tools/synth-bgm.mjs` 的曲风） |
| `--keep` | 关 | 保留 `out/.lemo-work/` 的中间产物 |

两点要知道：

1. **必须先设 `PLAYWRIGHT_CHROME` 再 import `page.mjs`**——它在模块顶层读这个变量；`render.mjs` 里已经先探本机 `ms-playwright` 缓存再动态 import。
2. **配音缓存按内容判断**：`content/<片>/audio/<句>.wav` 旁边有同名 `.txt`，两者都在且文本没改才复用；改文案会自动重合成。

<details>
<summary>手工三步（排查用）</summary>

```bash
cd vendor/lemo
cp ../../content/lemo-vacuum/script.json     styles/midcentury-toon/demo/content-zh.json
cp ../../content/lemo-vacuum/audio/durs.json styles/midcentury-toon/demo/durs-zh.json
node core/render/video.mjs styles/midcentury-toon/demo --fps 24 --workers 4 \
  --q "content=content-zh.json&durs=durs-zh.json" --out /tmp/lemo-zh.mp4
```
</details>

## 三条硬约束

1. **`durs` 决定时间线**：段落长度按旁白时长取整到 132 BPM 的小节，先有配音再排版，顺序不能反。
2. **`window.SRT` 是唯一的混音时刻表**：不要在外部按内容顺序猜时间，页面的 J-cut 会把旁白提前半拍。
3. **AAC 用 `aac_at`**：macOS 上 ffmpeg 原生 `aac` 编码这段密集内容时，实测真峰值比源高约 10 dB（源 −2.2 dBFS → 解码后 +7.7 dBFS）；`aac_at` 正常。

## 没做、也不假装做了的

- **配乐**：上游 `music/score.py` 依赖 CC0 采样库（Salamander / VSCO / MuldjordKit），不在仓库里；本片用本仓 `tools/synth-bgm.mjs` 合成 chillwave 垫底，不是 50 年代 cool jazz。
- **配音**：上游用 Kokoro + Whisper 校验；本片用 edge-tts `zh-CN-YunyangNeural`。
- **kits/ 与 API**：没有注册成 kit。这是一支片子的模板，不是一条产线；要产线化再谈 `api/kits/lemo-midcentury.mjs`。
