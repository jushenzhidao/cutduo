# 现代图文口播 · 参数化剪辑模板

把阿杜开源模板引擎 `aisovip/adu-motion-video`（MIT）按 MotionGit `.motion` 规范封装成**改 JSON 就能重剪**的模板。上游原版工作流是「每集手改 scenes.js」；这里把分镜、文案、时间锚点全部提到 `inputs.json`。

## 给 AI 的说明

`.motion` 是 ZIP 容器，不是提示词也不是 Apple Motion 工程。先只读：`motion.json` → 本文件 → `params.schema.json` → `guide.json`，确认运行环境与缺失素材后再执行。

- `runtime.profile` 为 `html-dom/1`（本地宿主自定义扩展，非官方内置 `html-canvas/1`）：画面由 DOM/CSS 构成、没有 canvas，宿主自动回退到整页截图；接口仍是 legacy `window.seek(t, inputs)` → 上游 `renderAt(t)`，逐帧确定性。
- 宿主在页面加载前把已校验的 inputs 注入 `window.MOTION_INPUTS`，`src/scene-builder.js` 据此调用 `TPL.<type>` 构建分镜。
- 全片离线：无真人卡、无录屏、无图片、无音频，网络请求被宿主拦截。

## 本期剪辑稿

`edits/inputs.json`。改文案、改分镜顺序、改配色、改时长都在这一份文件；`presets/demo.json` 是模板默认值，用户输入会覆盖它。

## 分镜参数速查（args 原样传给上游 TPL）

| type | 画面 | 关键参数 |
|---|---|---|
| `hero` | 逐行大字开场 | `lines: [[文字, at], ...]`，`sub` |
| `point` | 逐词大字 + 要点卡 | `words: [[文字, at, "slam"?]]`，`cards: [[文字, at]]` |
| `number` | 数字滚动 + 进度条 | `label, at, from, value, unit, dur, sub` |
| `compare` | 旧做法划掉 + 盖章 | `left/right: {title, items}`，`leftAt, rightAt, strikeAt, stamp` |
| `steps` | 横向时间线逐段点亮 | `title`，`steps: [[文字, at]]` |
| `quote` | 整屏金句 | `lines`, `at`, `by`, `size?` |
| `demo` | mac 窗口 + 功能卡（需 image/seq，本期未用） | `title, features` |
| `checklist` | 逐条打勾清单 | `title`，`items: [[文字, at]]` |
| `outro` | 片尾制作说明 + 终端打字 | `title, lines, prompt` |

规则：所有 `at` 都是**全片绝对秒数**，必须落在该场景 `t0..t1` 内；`durationSeconds` 要等于最后一个 `t1`；文字里的 `*xx*` 渲染成强调色。场景自带 wipe / circle / flash / blur 转场。

## 命令

```bash
cd motiongit-lab
python3 build-template.py --src templates/own/editorial --out packages/editorial-cut.motion
node motion-render.mjs check-params --package packages/editorial-cut.motion --inputs edits/inputs.json
node motion-render.mjs preview     --package packages/editorial-cut.motion --inputs edits/inputs.json --out edits/preview
node motion-render.mjs render      --package packages/editorial-cut.motion --inputs edits/inputs.json --out out/editorial-cut.mp4 --audio <可选音轨>
# 追求速度：--jobs 4 分片并行（1920×1080 实测 30.7s → 9.0s，PSNR 58.4dB）
```

## 许可

上游 MIT，完整文本在 `licenses/UPSTREAM-LICENSE.txt`；本次封装与剪辑稿见 `licenses/TEMPLATE-LICENSE.txt`。不含任何第三方素材。
