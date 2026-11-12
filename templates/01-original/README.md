# 01 · 原版（original）· 模板原样跑

**一句话**：模板是别人的，渲染器也是别人的 —— 用官方 Chromium 链路出片，一行渲染代码都不改。

## 怎么算停在这一级

- 只喂 `params`，不碰引擎源码；
- 出片进程里有 Chromium（`motion-render.mjs`，或 film-kit 的 `assistant/motion.mjs`）；
- 换分辨率、时长、文案只改参数，不改代码。

## 现有实例

| 模板 | 为什么留在原版 |
|---|---|
| `../../motiongit-lab/templates/vendor/camera-mode/` | 引擎是 DOM/CSS（有 `src/dom.js`），换宿主等于写半个浏览器 |
| `../../motiongit-lab/templates/vendor/paper-perspective/` | `protection: protected`，AES-256-GCM 密文 |
| `../../motiongit-lab/templates/vendor/paper-perspective-11/` | 同上 |
| `../../motiongit-lab/templates/vendor/promo-ink/` | 同上 |

## 入口

- 模板包：`motiongit-lab/templates/vendor/<name>/*.motion`
- 驱动：`motiongit-lab/motion-render.mjs`（playwright 宿主）
- 参考吞吐：24–55 fps（浏览器档，同片对比见 `../README.md` 第二节）

```bash
cd motiongit-lab
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node motion-render.mjs --help
```

## 什么时候往下走

同一条模板要反复出 5 条以上、且每次都要改内容 → 先看能不能换宿主（`../02-rehost/`）；
需要自己的版式语言 → 直接全蒸馏（`../04-full-distill/`）。

> 提醒：`原版` 是**默认档**，不是落后档。多数模板停在这里就对了。
