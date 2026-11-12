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

## 二、打包自建模板

```bash
uv run python build-template.py --src templates/own/science-explainer \
  --out own/workbuddy-science-explainer.motion
```

产物含 `integrity.json`（SHA-256 清单）。验证：

```bash
node motion-render.mjs inspect --package /tmp/sep-check.motion
# 期望 integrity 30/30 通过
```

## 三、迁移记录（2026-11-12）

1. **先改规则**：`.gitignore` 的 5 条按包名整包规则合并为 `templates/vendor/`，再移动；
2. **下载包用 `mv`**（不在 git 索引里），**自建包用 `git mv`**（保留历史）；
3. **移动后查凭据**：`git status --short | grep -E 'personal/|release.bin|core.enc'` 必须为空；
4. **回归**：`build-template.py` 打包 `own/science-explainer` → `motion-render.mjs inspect` 30/30，
   `desktop-kit/verify.mjs` 13/13。

历史文档 `MOTIONGIT-PLAYBOOK.md` 保留写作时的旧路径，文件头已加版本注记。
