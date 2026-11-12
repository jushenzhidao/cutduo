# 04 · 全蒸馏（full-distill）· 只借设计参考

**一句话**：模板只当视觉参照，版式、镜头、渲染器全部自建 —— 我们自己的五支模板都在这一级。

## 现有实例

| 代号 | 中文 | 代码 | 来源 | 实测 |
|---|---|---|---|---|
| `desk` | 桌面 | `motiongit-lab/desktop-kit/` | 复刻 mac-desktop | 8 worker 344 fps（极速档） |
| `science` | 科普 | `motiongit-lab/skia-kit/science.mjs` | 自建，9 版式 | 20 worker 196 fps |
| `paper` | 纸感 | `motiongit-lab/skia-kit/paper.mjs` | 逐像素反推 paper-perspective | 189–210 fps |
| `editorial` | 杂志 | `motiongit-lab/canvas-editorial.mjs` | 改造自 MIT 项目 | 走 Skia，无浏览器 |
| `mg` | 通用 | `motiongit-lab/mg-kit/` | 历史通用线 | 2026-11-10 后未改动 |

## 落点

- 模板：`motiongit-lab/templates/own/<name>/`
- 内容：`motiongit-lab/content/*.json`、`motiongit-lab/edits/inputs*.json`
- 渲染器：`@napi-rs/canvas`（Skia）+ ffmpeg，**无浏览器**

```bash
cd motiongit-lab
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

node skia-kit/render.mjs --kit science \
  --params templates/own/science-explainer/presets/microwave.json \
  --out out/science.mp4 --workers 20

node skia-kit/render.mjs --kit paper \
  --params skia-kit/presets/v8t.json --out out/paper.mp4

node desktop-kit/render.mjs \
  --params desktop-kit/presets/demo-voiced.json \
  --audio edits/audio-desktop.m4a --out out/desktop.mp4 --fps 60
```

## 一个容易看错的点

`desk` 与 `templates/vendor/mac-desktop/` 是**同一条模板的两级**：
vendor 里那次是换宿主（`../02-rehost/`），`desktop-kit/` 是全蒸馏。
这正是「四级是梯子、不是互斥分类」的活证据 —— 一个模板可以同时停在两级。

## 成本

2–4 天起（有明确设计参考）；没有源码只能照片反推时 3–5 天。
换来的是一条**完全可控**的产线：改一版式只改自己的代码，不受模板升级影响。
