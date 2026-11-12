# API · agent 契约

> 这份文档定义的是**契约**，不是命令手册。命令会变，契约不变。
> 五个动词 `capabilities / describe / validate / render / probe / gate` 是唯一的对外面，
> CLI 只是它的一个宿主。同一个 `api/index.mjs` 可以再挂 HTTP 或 MCP，不需要改任何 kit。

## 为什么要有这一层

改造前，agent 要用这个仓库得先读五个 README，再猜：

- 有哪些版式？—— `ls kits/`
- 每支要什么参数？—— 读 `params.schema.json`，但 `editorial` 和 `mg` 没有
- 出片多久、多少帧？—— 只有一行 console 文本，且是**自述的计划值**
- 参数写错了会怎样？—— 渲染跑到一半抛 `ReferenceError`，或者安静地出一支空片

api first 的做法是反过来：**先把契约定死，实现按契约补齐**。具体三个决定：

1. **能力清单是数据，不是文档**。`api/capabilities.json` 由代码生成，五支的 id、画幅、帧率、内容模型、schema 状态都可枚举。agent 不需要读 Markdown。
2. **回执只信探测**。帧数/时长/分辨率一律由 ffprobe 读产物得出，不解析渲染器的 stdout。五支的实现差异因此不会泄漏到回执字段上。
3. **错误必须可纠正**。每个错误带 `code`（可分支）、`hint`（为什么）、`fix`（改什么）。只写 `throw new Error('找不到 kit')` 的调用方只能把原文甩给用户，agent 无法自我修复。

## 五个动词

| 动词 | 语义 | 是否出片 | 失败行为 |
|---|---|---|---|
| `capabilities()` | 有哪些能力、各自要什么、产出什么 | 否 | 抛 |
| `describe(kit)` | 单支详情，含完整 params schema | 否 | 抛 |
| `validate(req)` | 参数预检 | 否 | **不抛**，返回结构化问题列表 |
| `render(req)` | 出片 | 是 | 抛 |
| `probe(req)` | 出一帧 PNG 看版式 | 否 | 抛 |
| `gate(file)` | 对既有成片跑交付门禁 | 否 | 抛（判 FAIL 时 `pass:false`） |

`validate` 之所以不抛，是因为它的语义就是「告诉我哪里有问题」；抛异常反而逼调用方用 try/catch 取信息。

## 请求

只有一种形状。`params` / `paramsPath` / `preset` 三选一，优先级从高到低。

```json
{
  "kit": "paper",
  "preset": "v8t",
  "audio": "assets/audio/audio-v8t.m4a",
  "out": "out/demo.mp4",
  "overrides": { "fps": 60, "workers": 8 }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `kit` | 是 | 取自 `capabilities()` 的 id，或已知别名（`desktop`→`desk`、`sci`→`science`） |
| `params` | 三选一 | 内联对象。API 会落盘成临时 JSON，便于回执重放 |
| `paramsPath` | 三选一 | 参数文件路径，按 cwd → 仓库根解析 |
| `preset` | 三选一 | 具名预设，必须来自该 kit 的 `presets[].id` |
| `audio` | 否 | 音轨。口播片必给；纯画面片省略 |
| `out` | 否 | 产物路径，默认 `out/<kit>.mp4` |
| `overrides` | 否 | **只放渲染超参**：`fps` `workers` `crf` `preset` `pipe` `at` `theme` `transition` |

> `overrides` 里出现内容字段（文案、分镜）会被拒。内容只能走 `params`，否则回执里的
> `request` 与实际输入对不上，回执就不能用于重放。

## 回执

字段名一旦定下就是契约，五支必须一致。

```json
{
  "ok": true,
  "kind": "render",
  "kit": "paper",
  "request": { "paramsPath": "kits/paper/presets/v8t.json", "audio": null, "out": "out/demo.mp4", "overrides": {} },
  "output": {
    "path": "out/demo.mp4",
    "bytes": 1146440,
    "width": 1920, "height": 1080, "fps": 60,
    "frames": 2573, "durationSeconds": 42.883,
    "hasAudio": false
  },
  "timings": { "wallSeconds": 5.08, "framesPerSecond": 506.7 },
  "unvalidated": false
}
```

- `output.*` 全部来自 ffprobe 读产物，**不是**渲染器打印的计划值。
- `unvalidated: true` 表示该支没有 `params.schema.json`，参数未被校验（当前是 `editorial` 与 `mg`）。
- `timings.framesPerSecond` 是有效吞吐（帧数 / 墙钟），可直接用于横向比较，但**必须同片比较**。

## 错误

```json
{
  "ok": false,
  "error": {
    "code": "KIT_NOT_FOUND",
    "message": "未知 kit：nope",
    "hint": "kit 必须取自 capabilities() 返回的 id 或已知别名",
    "fix": "可用：paper / science / desk / editorial / mg",
    "details": { "requested": "nope", "available": ["paper", "..."] }
  }
}
```

| code | 何时 | 调用方该做什么 |
|---|---|---|
| `KIT_NOT_FOUND` | kit 不在清单里 | 读 `details.available` 重选 |
| `PARAMS_MISSING` | 三个来源都没给，或 preset 名不存在 | 用 `details`/`fix` 里的候选 |
| `PARAMS_UNREADABLE` | 文件不是合法 JSON | 修 JSON（尾逗号/注释/BOM） |
| `PARAMS_INVALID` | 不符合 schema | 按 `details.errors[].path` 逐条改 |
| `AUDIO_MISSING` | 给了 audio 但文件不存在 | 改路径或删掉该字段 |
| `RENDER_FAILED` | 子进程非 0 / 超时 / ffmpeg 失败 | 看 `details.stderr`，先降 `workers` |
| `OUTPUT_INVALID` | 产物不存在、无视频流、探针空白 | 产物不完整，删了重跑 |
| `GATE_FAILED` | 门禁未通过 | 看 `films[].flat%/black%` |
| `BAD_REQUEST` | 请求形状不对 / 未知 overrides | 按 `fix` 改字段 |

## 调用方式

```bash
# 人读
node api/cli.mjs capabilities
node api/cli.mjs render --kit paper --preset v8t --out out/demo.mp4

# 机器读（agent 首选：JSON in / JSON out）
echo '{"kit":"paper","preset":"v8t"}' | node api/cli.mjs render --stdin --json
node api/cli.mjs validate --kit paper --preset v8t --json
node api/cli.mjs gate out/demo.mp4 --json
```

程序内直接 import：

```js
import { capabilities, describe, validate, render, probe, gate } from './api/index.mjs';

const { kits } = capabilities();                 // 5 支
const r = await render({ kit: 'paper', preset: 'v8t' });
console.log(r.output.frames, r.timings.framesPerSecond);
```

## 与 CLI 的关系

```
api/index.mjs        ← 唯一的业务实现
  ├─ api/cli.mjs     ← 宿主 1：命令行（本仓默认）
  ├─ api/kits/*.mjs  ← 五支 adapter：把各自的 CLI 包成契约
  └─ （待建）HTTP / MCP 宿主：复用同一份实现，不改 kit
```

**新增一支 kit 只需要**：写 `api/kits/<name>.mjs` 导出 `capability` 与 `adapter`，
在 `api/registry.mjs` 的 `MODULES` 里加一行。CLI、文档、能力清单、冒烟全部自动跟上。

## 已知限制

1. **同步执行**。`render()` 会阻塞到出片完成。40s 的片约 5–16 秒，可接受；
   若要做分钟级长片，应加 job 队列与 `jobStatus(jobId)`，当前未做。
2. **两支无 schema**。`editorial` 与 `mg` 的参数只能靠命名约定，回执标 `unvalidated:true`。
   补 `params.schema.json` 后自动纳入校验，不需要改 API。
3. **五支走子进程**。为的是隔离与不动实现；进程启动约 50–100ms，占比可忽略。
   若将来要省，把 `_runner.mjs` 的 spawn 换成 import 即可，契约不变。
4. **overrides 白名单是硬编码**。新增可覆盖的超参要同时改 `contract.mjs` 的 `ALLOWED_OVERRIDES`，
   否则会被拒——这是刻意的，防止内容与超参混在同一个字段里。
