# MEMORY.md — 本项目长期约定

## 评估外部产线 / 工具的固定做法（2026-11-10 用户指定）

- **凡评价 cinecode（clinecode-kit）与本仓 motion-kit / skia-kit 的快慢，必须用同一条口播片实测，不接受体感判断。**
  - 基准做法：取同一份 `inputs-v4.json`（8 版式 / 37.146s / 24fps）+ 同一条 `audio-v4.m4a`，
    只换渲染引擎；cinecode 侧只需出画面，音轨用同一条 mux 上去。
  - 判据三条：出片墙钟时间、渲染吞吐（fps）、文件体积与重复帧数。
- **实测结论（2026-11-10，892 帧 / 1920×1080 / 24fps）**
  | 管线 | 出片 | 吞吐 | 体积 | 重复帧 |
  |---|---|---|---|---|
  | skia-kit（8 worker, Skia 直出） | 2.3s | 388 fps | 2.20MB | 19 |
  | cinecode（8 worker, 无头 Chrome） | 15.8s | 56.5 fps | 6.15MB | 0 |
  ⇒ **cinecode 慢 6.9 倍、体积大 2.8 倍**。体感"更快"来自省掉 params JSON 与对话式改稿，
    不来自渲染。
- **cinecode 的门禁阈值不可直接移植，先标定**：
  - `qc.py hook`（前 2s mean≥0.5）：skia-kit 0.22、cinecode 0.34，两者皆 FAIL ⇒ 该阈值编码的是
    短视频"开场强运动"，与口播静态标题冲突。
  - 手机可读性：横屏 1920×1080 要求字高 40px，而 skia-kit 字幕为 34px ⇒ 会把自家片判不合格。
  - 结论：搬**判据维度**（亮度 L* 下限 / 分横竖的最小字高 / 开场运动），阈值用现有成片分位标定。

## 交付门禁的标定结果（2026-11-10，已落地为 `skia-kit/gate.mjs`）

在 19 支既有成片 + 3 支新片上实测，三项"看起来像门禁"的指标其实是连续分布，不是对错：

| 指标 | 实测范围 | p50 | 照搬 cinecode 阈值的后果 |
|---|---|---|---|
| hook（前 2s 运动） | 0.06–5.29 | 0.31 | 0.5 会误杀 13/19，含全部口播 |
| 平均 L* | 0.40–91.3 | 64.5 | 亮度下限会误杀三支深色模板复刻 |
| 重复帧 | 0–36.8% | 0.03 | 版式停留是设计，不是缺陷 |

**能当门禁的只有交付完整性**（阈值 = 实测最大值 + 余量）：
- 空帧（YMAX−YMIN<40）≤ 8%（实测最大 5.26）
- 黑帧（YMAX<24）≤ 3%（最大 1.75）
- 帧数与 duration×fps 差 ≤ 1；音画时长差 ≤ 0.10s
- 无音轨只告警，`--require-audio` 才判失败（8 支复刻片是无声素材）

**只报不拦**：hook（告警线 0.10 = p10）、首帧亮度（参考片淡入正常）、dup%、Y。
负向自检：插 2s 黑场 → "黑帧 5% > 3%" FAIL；音轨截短 3.17s → FAIL；健康片 PASS。
`node skia-kit/verify.mjs` 仍全 PASS——未改动该文件，门禁是独立入口。

## film-kit（mac-desktop / camera-mode）可以直跑（2026-11-10 实测，更正旧结论）

- **旧结论「film-kit 渲染不可达 / 入口崩溃」作废**。真因是浏览器：本机 Chrome 自带 sandbox
  起不来（`sandbox initialization failed: Operation not permitted`）→ GPU 进程连崩 → FATAL，
  上层只报 `BROWSER_CLOSED` + crashpad 噪声。
- **两条驱动路径必须分清**：
  - 随包 `assistant/motion.mjs run ...`：有自带 Chrome Driver，**不认** `MOTION_BROWSER`，必挂。
  - 模板 `runtime/entry.mjs`（包内 `content/release.bin` 是普通 zip，`protection: open`）：
    `findBrowser()` **认** `MOTION_BROWSER`。用 `~/.local/bin/mg-chrome` 包一层 `--no-sandbox` 即通。
- 实测（1440×1080 / 60fps / 46.98s）：**2819 帧 / 51s ≈ 55 fps**，24.4MB，内置 check 全过。
  量级上比自建 Skia（2.3s）仍慢 22 倍，比 paper-perspective（89s）快 1.7 倍。
- 配乐 `api music-prepare` 是 **0 积分**（CC0 曲目 + 按目标时长裁剪），不要为此去调付费 TTS/生图。
- 完整复盘见 `motiongit-lab/MOTIONGIT-PLAYBOOK.md` §41；成片 `out/mac-desktop-rc2-v1.mp4`。

## 同一支片三条管线的固定对照口径（2026-11-10）

同一口播 46.386s / 8 段结构，只换渲染器（1440 或 1920 宽、60fps、2783–2819 帧）：

| 管线 | 有效出片 | 吞吐 | 体积 |
|---|---|---|---|
| film-kit 官方 mac-desktop | 51s | 55 fps | 24.4MB |
| skia-kit | **6.8s** | 409 fps | 3.26MB |
| cinecode | 113.3s | 24.6 fps | 6.13MB |

- cinecode 必须 `--flags "--no-sandbox"`，且 PATH 要有 `/opt/homebrew/bin`（它 spawn ffmpeg）。
- **capture.mjs 写完 video 后不退出**，墙钟会比日志多 5 分钟量级；报数分开记（有效渲染 vs 墙钟）。
- 三条都能过 `skia-kit/gate.mjs`；cinecode 自带的 40px 字高与 hook 0.5 阈值仍不可移植。

## 科普片模板（science-explainer，2026-11-12）

- **结构是硬规律**：讲解位 37% / 图解释意 33% / 标签强调 10% / 阵列 6% / 对比 4% / 首尾 10%；
  切点中位 **2.75s**，跟句子走不跟动作走。详见 `templates/science-explainer/SPEC.md`。
- 位置：`templates/science-explainer/`（源）+ `templates/workbuddy-science-explainer.motion`（40KB 包）；
  成片 `out/science-explainer-demo.mp4` 54.5s / 1635 帧 / 10.15s 渲染（161 fps）/ gate PASS。
- **三个必踩坑**：① `env.T` 必须是"完整调色板 + theme 覆盖"，只传 theme 会让 `T.white` 等 undefined；
  ② `MK.icon` 内部按 (x±size/2) 平移，外层已 translate 到中心时再传 cx/cy 会二次偏移飞出画面；
  ③ 硬切段首入场一律从 -0.1s 起、容器缩放下限 0.86，否则切点首帧是"缩成一点"甚至空帧。
