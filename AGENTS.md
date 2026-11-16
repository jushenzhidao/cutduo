# AGENTS.md · cutduo 的 agent 入口

> 这份文件只回答三件事：**现在有什么、怎么调、改完怎么验**。
> 不要用目录名推断能力——`kits/` 里有目录不等于接了 API，`templates/own/` 里也有能出片的模板。
> **唯一事实来源是 `node api/cli.mjs capabilities --json`**。

## 0. 先跑这四条

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

node api/cli.mjs capabilities --json          # 全部 kit：id / 画幅 / schema / presets / 入口
node api/cli.mjs describe --kit <id> --json   # 单支完整 params schema
node api/cli.mjs validate --kit <id> --preset <p> --json
node api/cli.mjs probe --kit <id> --preset <p> --out out/p.mp4 --at 3 --json
```

出片：

```bash
echo '{"kit":"paper","preset":"v8t"}' | node api/cli.mjs render --stdin --json
# 长片 / 可能断线：--async 拿 jobId，再 status / jobs / cancel
```

回执里的帧数、时长、分辨率一律由 ffprobe 读产物；错误带 `code` / `hint` / `fix`。
契约见 `docs/API.md`。

## 1. 请求形状（只有一种）

```json
{
  "kit": "<capabilities().kits[].id>",
  "preset": "<presets[].id>",        // 或 paramsPath / params，三选一
  "audio": "assets/audio/x.m4a",     // 可选
  "out": "out/x.mp4",
  "overrides": { "fps": 60 }         // 只放渲染超参
}
```

- **内容（文案 / 分镜 / 几何）只能走 `params`**。放进 `overrides` 会被拒。
- `overrides` 白名单：`fps` / `workers` / `crf` / `preset` / `pipe` / `at` / `theme` / `transition`。
  某支不支持的开关会返回 `BAD_REQUEST`，不会静默忽略（例：`diagram` 是单进程，传 `workers` 会报错）。
- `preset` 是具名参数；`overrides.preset` 是编码 preset，两者不是一个东西。

## 2. 任务路由

| 你要做 | 去哪 |
|---|---|
| 查有哪些版式 / 入口 / API 状态 | `docs/inventory.json`（机器） / `docs/inventory.md`（人） |
| 选哪一支 | `kits/STYLES.md`（按用途的首选/次选） |
| 改一支片的文案 | `content/<slug>/script.json` → `tools/build-sync.py` → 重出 |
| 加一支版式 | `kits/<id>/` + `api/kits/<id>.mjs`（**文件名 = id**）→ `npm run inv` → `npm run check` |
| 加一个三件套模板 | `tools/new-template.py` → `templates/own/<id>/`；不必进 `kits/` |
| 吸收外部技能 | `docs/蒸馏-方法论.md`；登记 `docs/distillations.json` |
| 接入/蒸馏一个新模板（先评估） | `node tools/intake.mjs plan --source <目录或 .motion 文件>`；只读，产物在 `out/intake/` |
| Phase 2 落机械动作 | `node tools/intake-apply.mjs --plan out/intake/<id>/plan.json`（默认 dry-run；`--yes` 才写） |
| 抽取 vendor 源码作参考 | `node tools/intake-copy.mjs --plan out/intake/<id>/plan.json --yes`；保留 LICENSE、排除 personal/；**不是可直出模板** |
| 排查历史结论 | `docs/MOTIONGIT-PLAYBOOK.md`、`docs/AGENTS.md` |
| 改 MCP / 部署 | `mcp/server.mjs`、`docs/MCP-DEPLOY.md`、`deploy/` |

## 3. 硬规则

1. **`api/` 是唯一对外契约层**。CLI、MCP、web、harness 都只是宿主；不要在各宿主里复制业务逻辑。
   渲染实现分布在 `src/pipeline.mjs`（帧循环 / 编码 / 封装）与 `kits/*/`（各版式）；各支走子进程是
   为了隔离，**不代表 api 是实现所在地**。别把「有 api 目录」当成 API-first——判据是
   `node tools/check-arch.mjs`：有没有第二条绕过 api 的路、有没有第二个自己编码的入口。
2. **注册表自动发现**：`api/kits/*.mjs` 文件名必须等于 `capability.id`；写坏会在 API 启动时直接抛错。
3. **新增 kit 后必须跑 `npm run inv`**：`docs/inventory.json` / `.md` 是生成的，不生成就过期。
4. **`refs/` 不入库、不外传**（vendor 模板含账户 Key）；`out/` 可整体删除。
5. **交付门禁只拦完整性**（帧数 / 音画差 / 空帧 / 黑帧）。hook、亮度、重复帧是连续分布，只报不拦；
   不要照搬外部阈值。判据标定见 `src/gate.mjs` 头部。
6. **比较速度必须同片**：fps 随片长上升（worker 与 ffmpeg 启动开销被摊薄）。
7. **文档里的数量以 `docs/inventory.json` 为准**。`npm run docs:check` 会抓数量漂移、漏掉的 kit、
   失效路径与不存在的 npm script。

## 4. 改完怎么验

```bash
npm run check          # 全部版式各出一帧 + api.render 端到端 + API 契约 + 文档漂移 + 架构
npm run arch           # 只查架构不变量：I1 单实现 / I2 单门 / I3 契约单向
npm run arch:selftest  # 负向自检：检查器自己能不能报错（抓不到人造违规 = 没装）
npm run inv:check      # 只查版式清单是否过期
npm run docs:check     # 只查文档（路径 / 数量 / 覆盖）
node tools/check-kit-contract.mjs   # 渲染器认的段型 vs schema 允许的段型
node src/gate.mjs out/film.mp4      # 单支成片门禁
```

语法检查抓不住路径错误（`import` 合法、运行时才 404）。**只有真渲染一帧才知道。**

反过来也成立：**一帧知道不了主流程**。probe 在各入口里是 `process.exit(0)` 早退——
worker 分片、`concatParts` 合流、音轨混流三段都不执行。`npm run check` 里那条 `api:render`
是唯一真跑完整片的地方（paper + 3 秒 PCM 音轨，顺带验回执不撒谎与 pcm→aac）。
所以「10 支 probe 全绿」不等于「10 条路都通」。
