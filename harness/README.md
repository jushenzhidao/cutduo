# harness/ — 让 agent 自己迭代的评测闭环

> 一句话：把「渲一遍 → 看指标 → 改参数 → 再渲」固化成**一次命令 + 一份可执行建议**，
> 并且**判据不能被骗**。

```bash
node harness/run.mjs   --task harness/tasks/hip-v4.json --visual-only   # 单轮评测（约 28s）
node harness/patch.mjs --task harness/tasks/hip-v4.json --set 'segments[6].args.itemAt[0]=3.15'
node harness/run.mjs   --task harness/tasks/hip-v4.json --visual-only   # 下一轮
```

## 闭环协议

```
run → round-NN/report.json + report.md
        │
        ├─ verdict=PASS ──→ 交付
        └─ verdict=FAIL ──→ advice[]: {id, fields[], hint}      ← agent 读这个
                                   │
                                   ▼
                            patch.mjs（白名单校验）
                                   │
                                   ▼
                            next.json ──→ run 消费并进入 round-N+1
```

**agent 只需要读两样东西**：`report.md` 里「必须改」的 id，和 `advice[].fields` 指到哪个字段。
不需要理解 gate / calibration / adversarial 三套脚本各自的输出格式。

## 判据（三门 + 任务约束）

| 来源 | 判什么 | 落在 report 的哪 |
|---|---|---|
| `src/gate.mjs` | 帧数/音画差/空帧/黑帧 | `detail.gate` |
| `tools/verify-calibration.mjs` | 外观锚点是否是该代外观 | `detail.calibration.bad[]` |
| `tools/adversarial.mjs` | 结构/素材/音画/画面四层 | `detail.adversarial` |
| task.limits | 时长区间、BLOCKER/WARN 上限 | `fails[]` / `warns[]` |

## 三条防作弊设计

1. **白名单改字段**。`task.allow` 决定 agent 能碰什么。不给 `captions[].text`、`durationSeconds`——
   否则它可以把文案删短让时长落进区间、把 itemAt 删掉让 BLOCKER 消失，分数漂亮片子废了。
2. **视觉迭代不许动时间轴**。`--visual-only` 复用旧音轨，若段长或文案与参考不一致直接 abort。
   gate 只比总时长，查不出这种错位。
3. **检查器没输出 = 失败**。任一门没产出可解析 JSON，写 `harness.checkMissing`，
   不当成"跳过"。这条是被自己坑出来的，见下。

## 两次「静默通过」——harness 自己踩的坑

做这个 harness 的 40 分钟里，抓到两个同类的静默失效，都属于**最危险的一类：什么都没改，却判 PASS**。

1. `adversarial.mjs --json` 是打到 **stdout**，我按"写文件"处理，文件不存在 → `adv=null` →
   所有对抗判据被跳过。加了 missing 兜底。
2. `--visual-only` 分支 `fileCopy` 了原始 `task.vo` 覆盖掉刚打了补丁的 `params.json` ——
   每轮都渲同一份参数。修成"补丁后的 params 直接就是 vo.json"。

教训：**harness 的每一次"没报错"都要能追溯到某个判据真的跑过**。做不到，它比没有 harness 更糟——
它会给你一个绿色的假象。

## 为什么不是自动循环

harness 不内置"自动改参数"的优化器。原因：
- 参数空间是**语义的**（`itemAt` 该往前挪多少、`figureCx` 挪多少）不是可微的，黑盒搜索要几十轮；
- 真正需要判断的是"这句文案该不该拆"这类**内容决策**，只有 agent/人能拍。

所以 harness 只做两件事：**把反馈变成结构化、把改动限制在安全集合内**。循环由 agent 驱动。

## 预算

`task.budget.rounds`（默认 8）。轮次从目录里现有的 `round-NN` 数出来，超了直接拒绝运行。
每轮独立存档（params / film / 三门 JSON / report），可回溯"第几轮改了什么、指标怎么动"。

## 加一个任务

```json
{
  "id": "my-task",
  "kit": "science",
  "base": "kits/science/template/presets/xxx.json",   // 已配音的 vo.json 才能 --visual-only
  "vo": "out/xxx/xxx.vo.json", "voWav": "out/xxx/xxx.wav",
  "limits": { "duration": [45, 60], "maxBlocker": 0, "maxWarn": 3 },
  "allow": ["segments[].args.*", "theme.*"],
  "budget": { "rounds": 6 }
}
```

`base` 用静默 preset 时，每轮都会重跑 TTS（约 45s）；用已配音的 vo.json + `--visual-only` 只重渲画面（约 28s，
其中 12s 是三门判据本身）。
