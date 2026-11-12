# templates · 模板来源与分发边界

这个目录同时放着**第三方下载包**和**自建模板**，两者在许可与可分发性上完全不同。
新增模板前先看本表；不确定来源，按「不可分发」处理。

## 一、清单

| 目录 / 文件 | 类型 | runtime profile | 来源 | 入库 | 可分发 |
|---|---|---|---|---|---|
| `camera-mode/` | 个人下载包 | `motiongit-host/1`（film-kit） | motiongit.com 个人下载 | 否 | **禁止** |
| `mac-desktop/` | 个人下载包 | `motiongit-host/1`（film-kit） | motiongit.com/adunext/mac-desktop | 否 | **禁止** |
| `paper-perspective/` | 个人下载包 | `motiongit-host/1`（motion-kit） | motiongit.com/adunext | 否 | **禁止** |
| `paper-perspective-11/` | 个人下载包 | `motiongit-host/1`（motion-kit） | 同上（v11 分支） | 否 | **禁止** |
| `promo-ink/` | 个人下载包 | `motiongit-host/1`（html-canvas） | motiongit.com/motiongit | 否 | **禁止** |
| `distill/` | 自建模板 | `html-canvas/1` | 按 `.motion` 规范自建 | 是 | 可 |
| `editorial/` | 自建模板 | `html-dom/1` | 改造自 `aisovip/adu-motion-video`（MIT） | 是 | 可（保留 `licenses/UPSTREAM-LICENSE.txt`） |
| `science-explainer/` | 自建模板 | `html-canvas/1` | 依科普片结构规律自建 | 是 | 可 |
| `workbuddy-science-explainer.motion` | 打包产物 | 同上 | 由 `science-explainer/` 打包 | 需 `git add -f`（`*.motion` 全局忽略） | 可 |

## 二、为什么下载包不入库

`.gitignore` 按「身份层特征」排除，而不是逐个包名列举：

```
templates/**/package/personal/         # 个人 Key 与回执
templates/**/package/content/release.bin
templates/**/template.motion
templates/**/core.enc
```

另加 5 条整包规则覆盖上述个人下载目录。`PLAYBOOK.md` 第 133 行明确「不得再分发模板本身」——
**个人下载包含账号凭据，既不能进版本库，也不能随交付外发**。

## 三、将来拆 own / vendor 的顺序

当前没有物理拆分。真要拆，严格按这个顺序，否则规则会短暂失效：

1. 先把 `.gitignore` 的 5 条整包规则换成 `templates/vendor/`（**规则先就位**）；
2. 再用 `git mv` 把 5 个下载包移入 `templates/vendor/`；
3. 把 3 个自建模板移入 `templates/own/`（可选，收益仅是语义清楚）；
4. 跑 `git status --short` 确认没有任何 `personal/`、`release.bin`、`core.enc` 出现在待提交列表；
5. 同步 `build-template.py` 的默认 `--src` 与文档引用。

第 4 步是硬门槛：只要看到凭据文件，立即回滚。

## 四、打包

```bash
uv run python build-template.py --src templates/science-explainer \
  --out templates/workbuddy-science-explainer.motion
```

产物含 `integrity.json`（SHA-256 清单），用 `motion-render.mjs inspect` 验证后再交付。
