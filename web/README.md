# 客户自助出片台（web/）

一个零依赖的本地服务 + 单页表单：客户填内容 → 系统配音、排版、出片 → 直接下载 MP4。
不要求客户懂 JSON、itemAt 或帧率。

```bash
node web/server.mjs            # 默认 http://127.0.0.1:8787
node web/server.mjs --port 9000 --host 0.0.0.0
```

依赖与主链路一致：Node 22+ / ffmpeg / `uv`（跑 `tools/vo.py`）/ `edge-tts`（在 `~/.local/bin`）。
**配乐可选**：本机没装 GarageBand 时自动跳过 BGM，只出无音乐版，不阻断。

## 一条任务的六个阶段

| 阶段 | 做什么 | 失败会怎样 |
|---|---|---|
| validate | 按 `guide.json` 的容量表校验（主词 6 字、副标 16 字、口播 26 字…） | 前端逐条高亮，不渲染 |
| tts | `tools/vo.py` 逐句 TTS、重算段长、回填字幕与 `itemAt` | 直接失败并回传 stderr 尾部 |
| render | `render.mjs --kit science` 出 1080p | 同上 |
| bgm | `tools/add-bgm.mjs`（sidechain 下潜） | **跳过**，仍交付无 BGM 版 |
| gate | `src/gate.mjs` 帧数/音画/空帧/黑帧 | 记录判决，不阻断下载 |
| done | 写 `status.json`，前端 `<video>` 直接播 | — |

## 三条实现约束（改代码前先看）

1. **一个任务一个独立进程**（`detached + unref`）。HTTP 进程重启不影响正在跑的渲染。
2. **状态只落文件**（`out/web/<jobId>/status.json`），不存内存 —— 服务重启后前端照样能查。
3. **并发靠排队**，不靠拒绝。每单本身 8 worker，多开只会互相拖慢；
   超出上限进 `queued`，由每次查询触发补位（lazy scheduling）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 表单页 |
| GET | `/api/spec` | 段类型、容量表、图标/贴纸/音色清单、示例 |
| POST | `/api/validate` | 只校验，返回 `{ok, errors}` |
| POST | `/api/jobs` | 提交 → `{jobId}`（先校验，不通过返 400 + 错误列表） |
| GET | `/api/jobs` | 最近任务 |
| GET | `/api/jobs/:id` | 进度（直接返回 status.json + 原始 spec） |
| GET | `/api/jobs/:id/video` | 成品，**支持 Range**，`<video>` 可拖进度 |

## 表单模型

每段只有两样东西：**画面文字** + **口播**（一行一句，行数=字幕条数）。
时长不用填 —— 由配音实测重排。男声会自动换成男性讲解员（`figureImage`），
避免"男声配女像"（`tools/adversarial.mjs` 的 `voice.gender` 会报这类不一致）。

支持 5 种段：`cover / talk / matrix / tip / outro`。
`diagram`（需要配图）与 `compare / focus` 留给 v2 —— 它们要额外的素材与字段，
先不放进客户表单，避免"填得出来但出片难看"。

## 部署边界

- **没有鉴权、没有配额**。这是内网/演示用服务，直接暴露公网前必须加：
  token 或反代 basic auth、每 IP 限流、任务目录定期清理（`out/web/*` 会一直堆）。
- 单机渲染：一单 40s 片约 44s（TTS 占比最大）。要做成产品，TTS 应换成可缓存的
  批量方案，渲染应放到队列机。
- `edge-tts` 依赖微软在线接口；断网时 tts 阶段直接失败（前端会显示 stderr 尾部）。

## 产物

```
out/web/<jobId>/
  spec.json      客户表单原文（可重放）
  preset.json    编译后的 params
  vo.json        配音驱动后的 params
  vo.wav         音轨（-16 LUFS）
  raw.mp4        无 BGM
  final.mp4      交付版（可能含 BGM）
  gate.json      门禁回执
  status.json    进度（前端轮询这个）
  pipeline.log   各步骤 stdout/stderr
```

保留 `spec.json` 的意义：客户改天说"再出一版"，只要改几个字重放即可，不用重填。
