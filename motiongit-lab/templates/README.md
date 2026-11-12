# templates · 自建与下载分开

2026-11-12 拆分：`own/` 放自建模板（入库、可分发），`vendor/` 放个人下载包（不入库、不外传）。
新增模板前先看本表；不确定来源，按「不可分发」处理。

## 一、清单

### `own/` · 自建（入库、可分发）

| 目录 / 文件 | runtime profile | 来源 | 备注 |
|---|---|---|---|
| `own/distill/` | `html-canvas/1` | 按 `.motion` 规范自建 | 最初用于验证格式 |
| `own/editorial/` | `html-dom/1` | 改造自 `aisovip/adu-motion-video`（MIT） | 保留 `licenses/UPSTREAM-LICENSE.txt` |
| `own/science-explainer/` | `html-canvas/1` | 依科普片结构规律自建 | 9 个版式，`SKIA-SPEC.md` 有宿主移植说明 |
| `own/workbuddy-science-explainer.motion` | 同上 | 由 `own/science-explainer/` 打包 | `*.motion` 被全局忽略，入库需 `git add -f` |

### `vendor/` · 个人下载（不入库、禁止分发）

| 目录 | runtime profile | 来源 |
|---|---|---|
| `vendor/camera-mode/` | `motiongit-host/1`（film-kit） | motiongit.com 个人下载 |
| `vendor/mac-desktop/` | `motiongit-host/1`（film-kit） | motiongit.com/adunext/mac-desktop |
| `vendor/paper-perspective/` | `motiongit-host/1`（motion-kit） | motiongit.com/adunext |
| `vendor/paper-perspective-11/` | `motiongit-host/1`（motion-kit） | 同上（v11 分支） |
| `vendor/promo-ink/` | `motiongit-host/1`（html-canvas） | motiongit.com/motiongit |

**为什么整目录排除**：个人下载包含账号凭据（`package/personal/`）、加密核心（`core.enc`）
与受限 `release.bin`。`PLAYBOOK.md` 第 133 行明确「不得再分发模板本身」——
既不能进版本库，也不能随交付外发。

`.gitignore` 现有规则：

```
templates/vendor/                        # 整目录排除
templates/**/package/personal/           # 身份层特征，双保险
templates/**/package/content/release.bin
templates/**/template.motion
templates/**/core.enc
*.motion
```

## 二、按接入深度看：每个模板停在哪一级

四级梯子（定义见 `AGENTS.md` §1.1）：**原版 → 换宿主 → 半蒸馏 → 全蒸馏**。
同一条模板可以逐级深入，不是互斥分类；`原版` 是默认档，不是落后档。

| 模板 | 当前级别 | 依据 / 实测 |
|---|---|---|
| `vendor/mac-desktop` | **换宿主**（另有全蒸馏线 `desktop-kit/`） | 24 worker 480 fps，官方 8.7× |
| `vendor/knowledge-explainer-sketchnote` | **换宿主** | 通用图解 184 fps；手绘 native 12 worker 138.9 fps |
| `vendor/camera-mode` | 原版 | 引擎是 DOM/CSS，换宿主不成立 |
| `vendor/paper-perspective` / `-11` / `promo-ink` | 原版 | 源码加密，换宿主不成立；要深入只能照片反推（3–5 天） |
| `own/science-explainer` | **全蒸馏** | 自建 9 版式，20 worker 196 fps |
| `own/editorial` | **全蒸馏**（改造自 MIT 项目） | 工程是 `html-dom/1`，出片用 `canvas-editorial.mjs`（Skia 直出，无浏览器） |
| `own/distill` | 规范验证包 | 不承载产线 |

四级的代码落点：

| 档 | 模板放哪 | 代码放哪 |
|---|---|---|
| 原版 | `templates/vendor/<name>/template.motion` | `motion-render.mjs` |
| 换宿主 | 同上（不改模板） | `bench/motion-host/*-host.mjs`、`*-parallel*.mjs` |
| 半蒸馏 | `templates/own/<name>/` | 新 kit（可复用 `skia-kit/` 的渲染骨架） |
| 全蒸馏 | `templates/own/<name>/` + `content/` | `desktop-kit/`、`skia-kit/` |

**四级目录在哪**：仓库根的 `templates/01-original/` ～ `04-full-distill/` 是**类型索引层**——
每个目录只放一份 `README.md`（判据、实例、命令），不放代码与参数副本；本目录的 `own/` + `vendor/`
仍是唯一物理落点。

**为什么不把物理文件按四级搬**：`own/` 与 `vendor/` 是按「能不能分发」分的，属凭据与许可的硬约束；
四级是过程属性，会随投入变化（今天原版，明天换宿主）。按过程搬目录会让路径不稳定，且同一模板
可能同时有两级产物（`mac-desktop` 既有换宿主 PoC，也有 `desktop-kit`）。用类型目录 + 这张表串起来即可。

**半蒸馏目前没有实例**——如果决定把 sketchnote 做下去，它会是第一个：自写渲染 + 沿用它的
recipe/schema，落在 `templates/own/sketchnote-distill/`。

## 三、打包自建模板

```bash
uv run python build-template.py --src templates/own/science-explainer \
  --out own/workbuddy-science-explainer.motion
```

产物含 `integrity.json`（SHA-256 清单）。验证：

```bash
node motion-render.mjs inspect --package /tmp/sep-check.motion
# 期望 integrity 30/30 通过
```

## 四、迁移记录（2026-11-12）

1. **先改规则**：`.gitignore` 的 5 条按包名整包规则合并为 `templates/vendor/`，再移动；
2. **下载包用 `mv`**（不在 git 索引里），**自建包用 `git mv`**（保留历史）；
3. **移动后查凭据**：`git status --short | grep -E 'personal/|release.bin|core.enc'` 必须为空；
4. **回归**：`build-template.py` 打包 `own/science-explainer` → `motion-render.mjs inspect` 30/30，
   `desktop-kit/verify.mjs` 13/13。

历史文档 `MOTIONGIT-PLAYBOOK.md` 保留写作时的旧路径，文件头已加版本注记。
