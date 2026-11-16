# tools/ · 脚本索引

> 根目录只留 `render.mjs`。这里按**用途**分组，不按语言或字母。
> `npm run smoke` / `npm run check` 会检查「有没有脚本没登记」，新脚本请加到对应组。

## 日常入口

| 文件 | 用途 |
|---|---|
| `new-film.mjs` | 建一支新片：`content/<slug>/` 的 script / facts / build / bgm / make.sh |
| `render-all.mjs` | 批量出片：列出状态（skeleton/stale/ready/done），只重渲 ready |
| `motion-render.mjs` | `.motion` 通用宿主：doctor / check-params / preview / render |
| `new-template.py` | 从 `templates/_scaffold/` 生成三件套模板并自检 |
| `build-template.py` | 把 `templates/own/<name>/` 打成 `.motion` |
| `safe-unpack.py` | 只读安全解包（拒绝越界 / 软链 / 压缩炸弹） |
| `smoke.sh` | 全部版式各出一帧 + API 契约 + 文档漂移（提交前必跑） |
| `setup.sh` | 首次环境：Playwright / Chromium / FFmpeg |
| `fetch-fonts.sh` | 拉 Noto Sans SC 三档字体 |

## 校验与门禁

| 文件 | 用途 |
|---|---|
| `qc.mjs` | 一支片出完后的统一质检入口（make.sh 最后一步） |
| `adversarial.mjs` | 生成后的对抗审查执行器（结构 / 素材 / 音画 / 画面四层） |
| `case-loop.mjs` | 一条片的对抗审查驱动器：每次出片自动跑并留痕 |
| `check-kit-contract.mjs` | 渲染器认的段型 vs schema 允许的段型 |
| `check-docs.mjs` | 文档漂移：数量 / 覆盖 / 失效路径 / npm script |
| `check-arch.mjs` | 架构不变量：单实现 / 单门 / 契约单向（带 `--self-test` 负向自检） |
| `check-beats.mjs` | 「一拍拆多段但 screens 不够」的静态检查 |
| `check-screens.mjs` | `script.json` 的 screens 结构校验（时刻 / cast / 元组形态） |
| `check-shotbook.mjs` | 渲染前空窗体检（版式轮换闸 + 字级锚点） |
| `check-times.mjs` | 段内时刻越界（静态检查，秒级） |
| `check-fonts.mjs` | 字体注册与缺字检查 |
| `asset-audit.py` | 素材引用与来源审计（P0 路径 / P1 source / P2 可重跑） |
| `verify-calibration.mjs` | 外观锚点是否对得上真实渲染 |
| `pacing.mjs` | 节奏体检：长时间无变化 / 落位即切 |
| `narration-lint.mjs` | 旁白文案 lint |
| `facts-check.mjs` | 台账数字必须在屏幕上出现（双向） |
| `review-sheet.mjs` | 锚点帧审片表（该看哪一帧不靠手感） |
| `template-smoke.py` | 单支模板四关：结构 → 单帧 → 打包 → 包校验 |
| `check-template.py` | 模板体检：通用约束 + 按形态分派的约束 |
| `inventory.mjs` | 生成 `docs/inventory.{json,md}`（版式唯一清单） |
| `gen-capabilities.mjs` | 生成 / 校验 `api/capabilities.json` |
| `distill-check.mjs` | 校验蒸馏登记表并生成 `docs/蒸馏-索引.md` |
| `contact-sheet.mjs` | 抽帧拼成审片表 |
| `qa-gate.py` | **legacy**：旧交付门禁（skill 写死该路径，勿移）；新脚本用 `src/gate.mjs` |

## 音频与素材

| 文件 | 用途 |
|---|---|
| `build-sync.py` | 旁白逐句合成 + 时间轴重排（`--tts edge`） |
| `audio-bed.mjs` | 三层曲风配乐（electrohouse / chillwave / hiphop） |
| `synth-bgm.mjs` | 纯 Node 代码合成 BGM（确定性，零素材） |
| `add-bgm.mjs` | 把 BGM 混进成片（sidechain 下潜） |
| `normalize.mjs` | 响度归一（两遍法，−16 LUFS） |
| `esfx-render.py` / `esfx-warm.mjs` | earshot 音效批量渲染 / 预热缓存 |
| `trim-alpha.mjs` | 纯底图 → 透明底方形素材 |
| `circle-prop.mjs` | 方图裁成圆形视窗道具（带 alpha） |
| `reframe.mjs` | 横屏 → 竖屏（模糊填充，不裁内容） |
| `apply-camera.mjs` | 按「拍」批量编排段级运镜 |
| `hud-overlay.mjs` | 制片监视器 HUD 叠层（四角信息 + 进度轨 + 时间码），来源见 `docs/jimeng/` |
| `jimeng-demo.mjs` | 即梦语法的验证片（六镜各换信息轴）：`out/jimeng-showreel.mp4` 由它出帧 |
| `jimeng-demo-check.mjs` | 上者的判据（fix-loop）：帧 md5 对齐基线 / `--params` 生效 / 非法参数必报错 |

## 模板与格式

| 文件 | 用途 |
|---|---|
| `distill-inspect.py` | 半蒸馏第一步：读 `.motion` 包的内容模型，产出报告 + guide 草稿 |
| `intake.mjs` | **模板接入计划器（Phase 1，只读）**：分类 / 保护与凭据 / 提取内容模型 / 输出 `out/intake/<id>/plan.{json,md}` |
| `intake-selftest.mjs` | `intake.mjs` 的正负向自测（三件套 / `.motion` / protected 假凭据），不碰仓库 |
| `intake-apply.mjs` | **Phase 2**：读 plan，rehost 生成 `api/kits/<id>.mjs`，semi/full 生成 `templates/own/<id>` 骨架；默认 dry-run，`--yes` 才写，失败撤回 adapter |
| `intake-copy.mjs` | 把 vendor 包的 `release.bin` / `engine` / `native/source` 抽到 `refs/replicas/<id>/vendor-source`；保留 LICENSE，排除 personal/ 与密钥；抽取物不是可直出的三件套 |
| `intake-apply-selftest.mjs` | apply 的前置条件自测：拒绝覆盖 / dry-run 不落盘 / 凭据 blocking，不写仓库 |
| `gen-schema.py` | 从 guide + presets 反推 `params.schema.json` 的段参数约束 |
| `gen-tpl-params.py` | 模板参数生成 |
| `make-tpl.sh` | 模板打包 |
| `shard-tpl.py` | 模板按时间切片 |
| `render-batch.py` | 多条片各跑一条完整流水线 |
| `render-parallel-tpl.py` | **实验失败，默认禁用**（文件头有实测结论） |
| `mcp-e2e.mjs` | MCP 端到端冒烟（起服务 → 调工具 → 校验回执） |

## 测量、复刻与基准

| 文件 | 用途 |
|---|---|
| `composition.mjs` | 构图量化：主体尺度 / 重心 / 贴边 |
| `text-bands.mjs` | 量文字行带（复刻标定用） |
| `coverage.mjs` | 段型覆盖率体检（主指标：每种段型平均复用次数） |
| `report.mjs` | 片库总览（生成 `out/report/index.html`） |
| `publish-pack.mjs` | 出发布包（封面取段末、标题带不透明） |
| `replica-captions.mjs` | 从成片反推字幕元素（区间 + 文案图） |
| `replica-compare.mjs` | 复刻验收：参考片 ↔ 复刻片逐元素对照 |
| `replica-diff.mjs` | 逐帧差分流（复刻验收的仪表） |
| `canvas-bench.js` / `canvas-bench-parallel.js` | Canvas 单进程 / 并行基准 |
| `iso-ortho.mjs` | 正交三视图（合体态，统一比例尺） |
| `skia/bg-probe.mjs` | 壁纸探针 |
| `skia/measure.py` | Skia 侧测量 |
| `skia/overlay-pass.mjs` | 叠加层绘制验证 |

## 知识库

| 文件 | 用途 |
|---|---|
| `knowledge/knowledge.mjs` | 母版 / 容量表 / 配对规则 |
| `knowledge/new.mjs` | 按母版新建一支片（`npm run know`） |

## 归档

| 文件 | 说明 |
|---|---|
| `legacy/mouth-demo.mjs` | 口型演示，历史脚本；保留用于对照 |
| `legacy/render-daemon.mjs` / `legacy/render-parallel.mjs` | **断链归档**：2026-11-13 平铺重构后 import 路径未跟（`./canvas-editorial.mjs` 实际在 `kits/editorial/`），起不来。并行能力已由 `render.mjs` 的 worker 分片取代 |
| `legacy/build-voices.sh` / `legacy/build-voices-more.sh` | **断链归档**：依赖 `packages/editorial-sync.motion`，该包从未入库也不会再生成 |
| `legacy/test-theme.sh` | **断链归档**：依赖上面两个 |
| `timing/ledger.jsonl` / `timing/open.json` | 计时账本与未闭环项（数据，不是脚本） |
| `bin/` | 预留目录，当前为空 |
| `__pycache__/` | Python 缓存，已忽略 |

> 归档区的口径：**能跑但过时** 与 **完全跑不起来** 是两件事，这里只收后者。
> 断链文件的判据是可复现的：直接 `node` 一次，报 `ERR_MODULE_NOT_FOUND` 或依赖产物不存在即成立。
> 它们不参与 `tools/check-arch.mjs` 的 I2 判定（`tools/legacy/` 整体跳过），也不该被当成活路径引用。
>
> `bench/` 下的 19 个基准与探针不在这里登记，见 `bench/README.md`；
> 它们必须在仓库根运行（脚本用 `process.cwd()` 解析 `assets/fonts`）。
