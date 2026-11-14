# 版式总清单（自动生成）

> 由 `tools/inventory.mjs` 生成，**不要手改**。改了版式跑 `npm run inv`；
> 漂移检查跑 `npm run docs:check`（README / STYLES / API 是否漏了某一支）。

- kits：**9** 支（接入 API：**9** 支，无遗漏）
- 三件套模板：**4** 支可直出
- 可渲染合计：**13** 支

| id | 类型 | 可出片 | 接 API | 入口 | 画幅/帧率 | schema |
|---|---|---|---|---|---|---|
| `clay` | kit | ✓ | ✓ | `render.mjs --kit clay` | 1920×1080@30 | complete |
| `collage` | kit | ✓ | ✓ | `render.mjs --kit collage` | 1920×1080@60 | complete |
| `desk` | kit | ✓ | ✓ | `kits/desk/render.mjs --params <preset>` | 1440×1080@60 | complete |
| `diagram` | kit | ✓ | ✓ | `kits/diagram/render.mjs --params <preset>` | 1920×1080@30 | complete |
| `editorial` | kit | ✓ | ✓ | `kits/editorial/canvas-editorial.mjs --params <preset>` | 1920×1080@24 | complete |
| `iso` | kit | ✓ | ✓ | `render.mjs --kit iso` | 1920×1080@60 | complete |
| `mg` | kit | ✓ | ✓ | `kits/mg/render.mjs --params <preset>` | 1920×1080@60 | complete |
| `paper` | kit | ✓ | ✓ | `render.mjs --kit paper` | 1920×1080@60 | complete |
| `science` | kit | ✓ | ✓ | `render.mjs --kit science` | 1920×1080@30 | complete |
| `chalkboard` | template | ✓ | — | `render.mjs --kit chalkboard` | 1920×1080 | template |
| `cute-mv` | template | ✓ | — | `render.mjs --kit cute-mv` | 1920×1080 | template |
| `night-card` | template | ✓ | ✓ | `render.mjs --kit night-card` | 1080×1920@30 | complete |
| `sketchnote` | template | ✓ | — | `render.mjs --kit sketchnote` | 1920×1080 | template |

## 未接 API 但可出片的模板

- `chalkboard`：`render.mjs --kit chalkboard`
- `cute-mv`：`render.mjs --kit cute-mv`
- `sketchnote`：`render.mjs --kit sketchnote`

## 目录里存在但不可直出的模板

- `distill`：不是三件套（缺 kit.js/layouts.js/stage.js），不能走 --kit 直出
- `editorial`：不是三件套（缺 kit.js/layouts.js/stage.js），不能走 --kit 直出
