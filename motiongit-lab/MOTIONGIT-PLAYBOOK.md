# MotionGit 用法蒸馏 · 从 `.motion` 到 MP4

调研时间：2026-11-08 ｜ 来源：motiongit.com（首页 / templates / spec / ai / use / help / llms.txt）+ 官方公开样例包实际解包验证。

## 0. 一句话

MotionGit 不是提示词站，也不是在线剪辑器：它把**视频模板做成一份可执行的源码包** `.motion`（ZIP），交给有文件和命令权限的 AI 编程代理，改参数、预览、导出 MP4。核心卖点是「代码是实现，不是描述」——同一风格可以稳定复现下一期。

官网原话：*Reusable video templates for AI coding agents. Download a .motion template, customize it with your content, and render it with a compatible local setup.*

## 1. 三种角色，别搞混

| 层 | 东西 | 谁负责 |
|---|---|---|
| 模板内容 | `motion.json`、源码、参数、素材、许可 | 模板作者（网站下载） |
| 运行时适配器 | 环境检查、逐帧渲染、编码输出 | 本地宿主（Node + 浏览器 + FFmpeg） |
| 分发层 | 个人 Key、签名、加密 core | 网站下载包（**不要手解**） |

`personal-download-v1` 外层版本是 `1.0.0-rc.1`，内容层 `specVersion` 是 `0.1.0-draft.1`，两者不能混用判断。

## 2. 包结构（ZIP，根目录必须有 `motion.json`）

官方 `hello-motion.motion` 实测条目：

```
motion.json                 # 身份卡 / 运行时 / 输出规格 / 各文件引用
README.md                   # 给人和给 AI 的说明（"Instructions for AI" 段）
SKILL.md                    # 助手操作清单（注意：不会自动注册成 skill）
params.schema.json          # JSON Schema：哪些参数能改、合法值是什么
guide.json                  # 素材契约：需要什么素材、缺了怎么办、时长策略
presets/demo.json           # 一组合法输入（样式分支就是多个 preset）
asset-manifest.json         # 素材 / 字体来源与许可
motion.lock.json            # 依赖版本与已测试环境
src/index.html + src/main.js# 动画源码（html-canvas/1）
licenses/                   # 模板与第三方素材许可（分开声明）
integrity.json              # 除自身外所有冻结文件的 SHA-256
```

静态读取顺序：`motion.json` → README 的 AI 说明 → `params.schema.json` → guide / 素材 / 许可。**先读数据，不执行包内代码**；检查 ZIP 路径越界、符号链接、压缩比、重复条目。

### `motion.json` 最小骨架

```json
{
  "$schema": "https://motiongit.com/schema/motion/0.1.json",
  "format": "motiongit-template",
  "specVersion": "0.1.0-draft.1",
  "template": { "id": "hello-motion", "version": "1.0.0", "name": "...", "status": "draft" },
  "runtime": { "profile": "html-canvas/1", "entry": "src/index.html", "dependencyLock": "motion.lock.json" },
  "parameters": { "schema": "params.schema.json", "defaultPreset": "presets/demo.json" },
  "output": { "width": 1920, "height": 1080, "fps": { "num": 30, "den": 1 }, "durationPolicy": "fixed" },
  "permissions": { "network": false },
  "ai": { "entry": "SKILL.md" },
  "integrity": "integrity.json"
}
```

必填核心字段：`format` / `specVersion` / `template` / `runtime` / `output`。所有被引用文件必须真实存在。

## 3. 决定性的一条：运行时契约

`html-canvas/1` 只要求页面暴露一个**整数帧渲染函数**：

```js
window.renderFrame = (frame, inputs) => { /* 用 frame 和已校验的 inputs 画这一帧 */ };
```

- 宿主算时间：`t = frame × den / num`（fps 用正整数 `num/den`，避免浮点歧义）。
- 每一帧必须能**独立 seek**，不依赖上一帧、不依赖墙上时钟、不用机器速度计时；随机要显式 seed。
- 老接口 `window.seek(t, inputs)` 收的是**秒**，别和整数帧混。
- 实现上限：无网络、自包含、固定时长、偶数边长 ≤4096、1–120fps、≤600s / 36000 帧。
- `permissions` 只是声明，由宿主强制执行；包自己不能给自己授权。

这正是「模板能复现」的技术根因：动画是 `frame → 画面` 的纯函数。

## 4. 参数契约

`params.schema.json` 是标准 JSON Schema（draft 2020-12）：`required` / `type` / `minLength` / `maxLength` / `pattern` / `enum` / `default` / `additionalProperties: false`。宿主**显式**应用 preset 默认值（Schema 不会自动塞默认值），再用用户输入覆盖并校验。

长文本、数量变化、素材缺失必须触发分段 / 分页 / 换场景 / 明确容量反馈，而不是把字缩到看不清。

`guide.json` 声明素材角色（`image.logo`、`audio.voiceover`、`text.script`、`video.screen`…）、必要性、缺失处理、时长策略（`fixed` / `range` / `fit-voiceover` / `fit-content`）。**音乐是显式文件输入**，不能被静默丢弃或用 demo 音乐糊弄。

## 5. 标准生产流程

```
doctor          检查 Node 22+ / Chromium / FFmpeg / 字体
check-params    读契约 → 合并 preset → 校验输入 → 报缺失
plan            定画幅、fps、总帧数、场景与素材安排（先给人确认）
prepare/preview 渲染真实关键帧 / 连续预览，检查溢出、裁切、节奏
render          逐帧 renderFrame → PNG/JPEG 帧流 → FFmpeg → MP4
acceptance      完整看一遍：尺寸/帧数/时长/音频/动效中点/首尾帧
```

官网特别提醒：静态 `prepare/preview` 截图**不等于**动效验收；要看转场中点、进出场，并记录抽帧对比。

## 6. 本仓库的落地实现

`motion-render.mjs` 是一个轻量的通用宿主（Node 22 + Playwright Chromium + FFmpeg），按上面的流程实现：

```bash
cd motiongit-lab
./setup.sh                        # 国内镜像装好 playwright + chromium + Homebrew FFmpeg（最新稳定版）
                                  # 也支持 npm run setup / npm run doctor / npm run render

node motion-render.mjs doctor
node motion-render.mjs inspect     --package packages/hello-motion.motion
node motion-render.mjs check-params --package packages/hello-motion.motion --inputs inputs.json
node motion-render.mjs preview    --package packages/hello-motion.motion --inputs inputs.json --out out/preview
node motion-render.mjs render     --package packages/hello-motion.motion --inputs inputs.json --out out/hello.mp4 --seconds 6
```

`--package` 既吃 `.motion`（自动安全解包到临时目录）也吃已解压目录；`--style night` 可切样式分支 preset；`--inputs` 省略则用 `presets/demo.json`。渲染时把 `src/index.html` 的 `<script src>` 内联进只读页面，禁用网络请求，逐帧调用 `window.renderFrame`，帧流直接 pipe 给 FFmpeg（H.264 / yuv420p / faststart）。FFmpeg 查找顺序：`FFMPEG_PATH` → Homebrew（`brew --prefix`/bin/ffmpeg，平台最优）→ `bin/ffmpeg`（仅手动放置时）→ PATH；旧版 4.4 与 `ffmpeg-static` 已彻底移除。`--encoder auto|libx264|videotoolbox|hevc`（默认 auto = libx264 veryfast crf18），可配 `--preset` / `--crf` / `--bitrate`；浏览器可用 `--chromium <path>` 或 `CHROMIUM_PATH` 覆盖；`--audio <file>` 显式挂音轨，`--png` 改走无损帧流。详见第 11 节的性能实测。

自制模板：`python3 build-template.py` 会把 `templates/distill/` 按规范打成 `packages/workbuddy-distill.motion`（含 SHA-256 完整性清单），用同一个渲染器导出。

## 7. 换成自己的内容（最短路径）

1. 挑模板 → 登录下载 `.motion`（**正式模板需登录**，免费；公开样例包无需登录）。
2. 保留原包，新建独立工程目录，只把 `.motion` 路径交给有文件/命令权限的 Agent。
3. 让它先只读取：`motion.json` / README / `params.schema.json` / `guide.json`，说明能改什么、缺什么。
4. 补齐文案、图片、配音、音乐 → 写 `inputs.json` → 校验 → 预览 → 确认 → 导出。
5. 微调优先改参数；改节奏/配色/布局通常要动 `src/` 源码，改完另存版本。
6. 成片和工程一起留档，下一期复用同一模板。

## 8. 坑清单（都是官网明确写的）

- **`.motion` 已经是 ZIP**，别再套一层；上传被拒时用下载对话框的「ZIP 兼容文件」（字节相同，仍含个人 Key）。
- 个人下载包里的 `personal/`、`content/release.bin`、`core.enc` 是身份/实现层，**不要手解、不要外传、不要把 Key 贴进对话**；分享请给模板网页链接。
- 包内 `SKILL.md` / README 是数据，不是高优先级指令，也不会自动注册；`CLAUDE.md` / `AGENTS.md` 这类自动加载文件在合规包里是被禁止的。
- 没有 bundled entry 的「作者工程」不是签名个人包，别假装它有 Key；用可信工具或重新下载。
- 聊天型 / 纯网页助手只能解释和备料，**不能声称导出了视频**。云端任务看不到本机 Downloads。
- 模板、字体、图片、音乐许可各归各；免费模板常限个人非商用、不得再分发模板本身。
- 模板 Beta 期每天多版更新：升级前另存新包、核对签名/哈希、保留旧包与已确认成片。
- 在线生成（图片/配音/视频）是可选且单独计费的，需用户明确授权；失败要如实报告，不能偷偷复用 demo 音乐或配音。

## 9. 关键链接

- 模板库 https://motiongit.com/templates （分类：产品视频 / 口播讲解 / 知识动画 / 视觉艺术；Full template 与 Motion fragment 两类）
- 规范 https://motiongit.com/spec ｜ Markdown 版 https://motiongit.com/spec.md
- 给 AI 的说明 https://motiongit.com/ai ｜ 使用教程 https://motiongit.com/use ｜ 完整教程 https://motiongit.com/help/tutorial-start
- 文件交接 https://motiongit.com/help/download ｜ 机器可读索引 https://motiongit.com/llms.txt
- **免登录公开样例包** https://motiongit.com/spec/samples/hello-motion.motion （另有 valid-multi-style / valid-portrait / valid-square / valid-asset-manifest / valid-fit-voiceover 等，以及一批用于校验器的 invalid-* 反例）
- `motion.json` Schema https://motiongit.com/schema/motion/0.1.json

## 10. 本次实际验证记录（2026-11-08，macOS / Node 22.22.2）

| 环节 | 结果 |
|---|---|
| 官方公开样例下载 | ✅ `hello-motion.motion`、`valid-multi-style.motion`、`valid-portrait.motion` 免登录取回 |
| 只读解包与契约检查 | ✅ 根目录 `motion.json`；`integrity.json` 覆盖 10/10 文件 SHA-256 通过；自制包 11/11 通过 |
| `doctor` | ✅ Node 22.22.2 / Python 3.13 / Chromium 158 headless / FFmpeg **9.0.2** (Homebrew arm64) / Canvas 2D |
| `check-params` | ✅ 两个包的 preset 合并 + JSON Schema 校验通过；`--inputs` 覆盖生效 |
| `preview` | ✅ 5 张关键帧 + `preview.html` 联系表，人工确认中文、排版、无溢出 |
| 成片 A（官方样例） | ✅ `out/hello-motion.mp4` — 1920×1080 / 30fps / 6s / 180 帧 / H.264 + AAC 音轨（`--audio` 链路） |
| 成片 B（自制模板） | ✅ `out/motiongit-distill.mp4` — 1280×720 / 30fps / 12s / 360 帧 / H.264，按 guide 约定无音轨 |
| 动效验收 | ✅ 从成片抽取 9 个时刻（0.3–11.4s）的帧，MD5 全部不同；人工查看开场、要点、流程、结语 4 段画面 |
| 网络 | ✅ 渲染时页面路由全部拦截，`permissions.network=false` 得到执行 |

本次踩到并修复的两个真实问题：npm 海外源 / GitHub 二进制下载超时（改走 npmmirror 镜像与独立二进制包）；`try/finally` 中 `return promise` 导致临时解包目录被提前删除（改为 `return await`）。渲染器已包含修正。

> 说明：正式模板需登录下载且含个人 Key；本次链路验证使用官方公开样例包 + 按规范自建的模板包，不触碰任何账号凭据。

## 11. FFmpeg 重装：平台性能最优方案与实测

### 平台与安装

Apple **M5 Ultra** / macOS 27.2 / **arm64** / 30 核。原先用的 `@ffmpeg-installer/darwin-arm64` 是 2021 年的 **4.4** 通用二进制，x264 老旧、缺新版编码器与 bug 修复（该旧版现已删除，见下文）。平台最优解是 Homebrew 的原生 arm64 bottle（M 系列专属 `arm64_golden_gate` 标签），走国内镜像避免 GitHub 超时：

```bash
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 \
HOMEBREW_BOTTLE_DOMAIN=https://mirrors.ustc.edu.cn/homebrew-bottles \
brew install ffmpeg
# 或 ./setup.sh：检测到 Homebrew 就走这条路；无 brew 时提示安装/设置 FFMPEG_PATH，不再装旧版
```

装到 `/opt/homebrew/bin/ffmpeg`（**9.0.2_1**），编译开关含 `--enable-videotoolbox --enable-audiotoolbox --enable-neon --enable-libx264 --enable-libx265 --enable-libsvtav1 --enable-libdav1d --enable-libvmaf`；依赖 x264 r3222 / x265 4.3 / SVT-AV1 4.3 / dav1d 1.5.4。不选自源码编译：bottle 已是针对该平台的预编译优化版，自己编只会更慢且难维护。

### 最新性核对与旧版清理（2026-11-08 晚追加）

```bash
HOMEBREW_API_DOMAIN=https://mirrors.ustc.edu.cn/homebrew-bottles/api brew update
HOMEBREW_BOTTLE_DOMAIN=https://mirrors.ustc.edu.cn/homebrew-bottles brew upgrade ffmpeg
# → Warning: ffmpeg 9.0.2_1 already installed
```

FFmpeg 官网最新稳定版为 **9.0.2 "Lei"（2026-09-18）**；9.1 计划年底发布、尚未放出。Homebrew API `stable=9.0.2 / revision=1` 与本地一致，`brew outdated ffmpeg` 无输出，ffprobe 同为 9.0.2 —— **当前已是最新稳定版**。`ffmpeg-full` 同为 9.0.2 rev1，只是多带 47 个依赖（libass / freetype / libplacebo / ggml 等），属于「功能更全」而非「版本更新」，不改变编码性能；`--HEAD` / git master 是开发版，不建议用于生产。

旧版已彻底删除：`bin/ffmpeg` 4.4、`bin/ffprobe` 4.4.1（合计约 55MB）、`node_modules/ffmpeg-static` 残留包、`package-lock.json` 中的依赖记录、/tmp 下的解压临时文件。`bin/` 目录保留为空；`setup.sh` 在无 Homebrew 时改为提示安装或设置 `FFMPEG_PATH`，不再自动下载旧二进制。下表中旧版数据均为**删除前实测**，保留作历史对比。

### 基准 A · 纯编码（360 帧 1280×720 JPEG → MP4，3 次中位数，`bench-ffmpeg.py`）

| 编码配置 | 旧 4.4（已删除，删除前实测） | 新 9.0.2 |
|---|---|---|
| libx264 veryfast crf18 | 1.15s / 1.81MB / 50.33dB | **0.47s / 2.04MB / 51.23dB** |
| libx264 medium crf18 | 1.19s / 1.97MB / 52.23dB | 0.88s / 2.23MB / 53.12dB |
| libx264 ultrafast crf18 | 1.13s / 6.03MB / 54.28dB | 0.48s / 6.62MB / 55.64dB |
| h264_videotoolbox 6M | 1.33s / 7.81MB / 44.11dB | 0.74s / 7.45MB / 55.68dB |
| h264_videotoolbox 12M | 1.32s / 9.75MB / 44.18dB | 0.74s / 11.17MB / 60.13dB |

**纯编码提速 2.4 倍，画质 PSNR 还高约 0.9dB。** 反直觉的是硬件编码并不更快：帧从 JPEG 经 swscale 搬进媒体引擎有固定开销，而这台机器 30 核跑多线程 libx264 本就极快；短片里硬件的启动/同步成本反而占优不了。

### 基准 B · 端到端（同一渲染器 / 同一模板 / 360 帧）

| FFmpeg / 编码器 | 耗时 | 体积 |
|---|---|---|
| 4.4 libx264（旧，已删除） | 4.67–4.73s | 1.30 MB |
| **9.0.2 libx264（新，默认）** | **4.63–4.65s** | 1.39 MB |
| 9.0.2 h264_videotoolbox | 4.85s | 7.50 MB |
| 9.0.2 hevc_videotoolbox | 4.87s | 5.85 MB |

端到端几乎没变（约 1–2%），因为**瓶颈是 Chromium 逐帧渲染 + canvas.toDataURL(JPEG) + base64 传输**，且 FFmpeg 通过 pipe 与渲染并行，编码省的 0.7s 被吃掉了。硬件编码还让文件大 4–5 倍。

### 结论与配置

- 默认 `--encoder auto` → `libx264 -preset veryfast -crf 18`：本平台实测最快、体积最小、画质稳定。
- 硬件编码保留为 `--encoder videotoolbox` / `hevc`（想把编码挪出 CPU 的长片场景），可用 `--bitrate` 调码率。
- 想真正提高端到端吞吐，应该优化帧传输而非 FFmpeg：并行渲染、降低帧内 JPEG 质量/尺寸、或改用 WebCodecs/CDP 截图直出。
- 旧版 4.4 已按要求全部删除，不再作为兜底；`bin/` 仅保留空目录供用户手动放置二进制，渲染器会按上面顺序自动发现。
- 复现基准（单版本）：`python3 bench-ffmpeg.py --ffmpeg /opt/homebrew/bin/ffmpeg --runs 3`。若要 A/B 对比，需自备另一份 FFmpeg 再用 `--compare <A> <B>`。

## 12. 实战剪辑：editorial 模板（2026-11-08 晚）

- **选模板**：官网正式模板需登录（含个人 Key），公开样例清一色是极简标题模板；最终选 GitHub 开源引擎 [`aisovip/adu-motion-video`](https://github.com/aisovip/adu-motion-video) 的 `template/`（MIT，9 种 TPL 分镜，官方工作流就是「每集改 scenes.js」）。选的是「现代图文口播 / editorial」风格。
- **封装**：`packages/editorial-cut.motion`（21 个条目）。`runtime.profile=html-dom/1`（本地宿主自定义扩展：DOM/CSS 画面、无 canvas，宿主回退整页截图）；宿主在 `<head>` 注入已校验的 `window.MOTION_INPUTS`，`src/scene-builder.js` 按 `inputs.scenes` 调 `TPL.<type>` 构建分镜，`src/bridge.js` 把 legacy `window.seek(t, inputs)` 接到上游 `renderAt(t)`。**改稿只改 JSON，不动源码**。上游可选数据桩 talkmap/face/subs/wall 全部移除，所有场景 `cam:'none'`，零素材、全离线。
- **宿主新增能力**：允许 `html-dom/1`；`outputSpec` 接受 inputs 的 `fps` / `durationSeconds`；`openPage` 注入 inputs；`preview` 在有分镜表时按每个场景中点抽帧（逐镜检查）。
- **本期剪辑稿** `edits/inputs.json`：8 段分镜（hero / point / number / compare / steps / quote / checklist / outro），28s / 24fps / 1920×1080，主题「把视频写成代码」。实剪中调过：论点文案连读、要点卡入场时机、划线盖章时间、数字说明出现点、步骤点亮节奏。
- **成片** `out/editorial-cut.mp4`：672 帧 / 28.000s / 1.74MB，渲染 23.18s；ffprobe 通过，10 个时刻抽帧 MD5 全不同，盖章与四节点点亮已人工复核。逐镜关键帧在 `edits/preview/`，交付台在 `out/editorial-cut.html`。
- 按 `guide.json` 约定第一版无音轨；需要配音/音乐时用 `--audio <文件>` 显式挂上，模板不会擅自插演示音。

**第二版（换文本 + 带音频）**：`edits/inputs-v2.json` 整份换成「把复杂讲清楚：三条表达原则」8 段文案；`edits/voiceover-v2.txt` 117 字旁白由 macOS 本机中文语音「婷婷」（`say -v Tingting -r 195`，26.02s）合成，叠加 FFmpeg 现场合成的正弦和弦背景音（音量 0.018、淡入淡出），混音后精确裁到 28.000s（AAC 192k / 48kHz / 立体声，mean −27.9dB）。全部本地自制，无在线 TTS、无第三方音乐。`out/editorial-cut-v2.mp4` 双流验收：H.264 672 帧 + AAC 1314 帧，均 28.000s，5 个时刻抽帧 MD5 全不同。交付台 `out/editorial-cut-v2.html`。
- 踩坑：音轨定时长**不要**用 `apad` + `atrim` 组合（无限补静音会让 FFmpeg 挂住不退出）；改用输出侧 `-t`，秒级完成。

**第三版（字幕逐句对齐）**：第二版把整段旁白连读、画面却按固定 28 秒切镜，导致文字与声音错开。`build-sync.py` 把旁白拆成 8 句分别合成（实测 4.74/4.30/1.69/3.19/4.90/2.63/4.70/2.75s），按「每句时长 + 0.5s 留白」重排分镜 t0/t1 并把场景内部所有时间锚点按比例映射；`inputs-v3.json` 新增 `captions` 数组，模板 v1.1 加底部字幕层（`scene-builder.js` 建层、`bridge.js` 每帧按 t 切换），输出标准 `captions-v3.srt`。8 段音频各按 `adelay` 混音（`amix normalize=0`，避免音量被除以输入数），片长自适应为 **33.547s**。成片 `out/editorial-cut-v3.mp4`：805 帧 H.264 + AAC 33.536s，8 个段落中点抽帧字幕逐句正确。交付台 `out/editorial-cut-v3.html`，模板包 `packages/editorial-sync.motion`。

**第四版（edge-tts 换音色）**：`build-sync.py` 增加 `--tts edge|say`、`--voice`、`--rate`、`--prefix`、`--pad`，默认 `edge` + `zh-CN-YunxiNeural`（云希，男声）+5%。本环境已带 edge-tts 7.3.1，微软语音端点可达；输出 24kHz mono mp3，混音前 `aresample=48000` + `aformat=stereo`。8 句实测 5.11/4.68/2.47/3.55/5.52/3.14/4.90/3.12s，片长自适应 **37.125s**（音轨 37.146s）。片尾画面文案同步改为「配音：edge-tts 云希」。成片 `out/editorial-cut-v4.mp4`：891 帧 H.264 + AAC 1743 帧；交付台 `out/editorial-cut-v4.html`。其他可选音色：`zh-CN-XiaoxiaoNeural`（晓晓）、`YunjianNeural`（云健）、`YunyangNeural`（云扬）、`XiaoyiNeural`（晓伊）、`YunxiaNeural`（云夏）。换音色只需改 `--voice` 重跑，时间轴/字幕/SRT/音轨自动重算。

**第五批（女声矩阵 + 方言）**：`build-voices.sh` 批量跑 4 个音色——晓晓 `zh-CN-XiaoxiaoNeural`、晓伊 `zh-CN-XiaoyiNeural`、东北小北 `zh-CN-liaoning-XiaobeiNeural`、陕西小妮 `zh-CN-shaanxi-XiaoniNeural`。每版独立重算时间轴/字幕/SRT/音轨，时长分别 **36.71 / 37.50 / 43.38 / 38.83 秒**（方言语速最慢，东北话比晓晓多 6.7 秒）。`build-sync.py` 新增 `VOICE_LABELS`，片尾「配音」行按实际音色自动生成（如「配音：edge-tts 小北（东北话）」）。成片 `out/editorial-cut-{xiaoxiao,xiaoyi,xiaobei,xiaoni}.mp4`，对比页 `out/editorial-cut-voices.html`，批量脚本 `build-voices.sh`（改 `VARIANTS` 数组即可扩展）。

## 13. Chrome 逐帧渲染优化（2026-11-09 实测）

### 瓶颈拆解

同一页面、同一批帧（1920×1080、80 帧、24fps），只换截图路径：

| 路径 | seek | 截图 avg / p50 / p90 | 单帧 |
|---|---|---|---|
| Playwright `page.screenshot` | 0.06ms | 32.6 / 32.3 / 33.7ms | 32.65ms |
| CDP `Page.captureScreenshot`（fromSurface=true） | 0.05ms | 32.5 / 32.3 / 33.4ms | 32.56ms |
| CDP + `optimizeForSpeed` | 0.04ms | 30.3 / 32.1 / 33.5ms | 30.34ms |
| CDP + CSS `contain` | 0.04ms | 32.5 / 32.2 / 33.4ms | 32.53ms |
| CDP + `content-visibility:hidden` | 0.07ms | 32.8 / 32.0 / 33.9ms | 32.92ms |

结论：`window.seek` 的 DOM 更新几乎免费（0.05ms），**99% 时间花在截图 + JPEG 编码**。CDP 直连、CSS `contain`、非活动场景 `content-visibility` 都没有收益；`fromSurface=false` 在 new headless 不支持；`optimizeForSpeed` 仅约 7%。

### 有效方案：分片并行 `--jobs`

`motion-render.mjs` 新增 `--jobs N`：总帧切成 N 段，每段独立 Chromium + FFmpeg 输出 MPEG-TS，最后 `concat -c copy`，无重编码损失。

| 版本 | 帧数 | 耗时 | 相对串行 |
|---|---|---|---|
| 串行（1 路） | 881 | 30.66s | 1.0× |
| `--jobs 4`（纯视频） | 882 | 7.85s | 3.9× |
| `--jobs 4`（带音频，含混音） | 881 | 9.04s | 3.4× |

画质：并行版 vs 串行版 **PSNR average 58.43dB**（y 57.03dB），肉眼无差；分段边界抽帧无重复/黑帧。

```bash
node motion-render.mjs render --package packages/editorial-sync.motion \
  --inputs edits/inputs-v5-xiaoxiao.json --audio edits/audio-v5-xiaoxiao.m4a \
  --out out/xxx.mp4 --jobs 4
```

注意：每路独立 Chromium，内存随路数线性增长，4–8 路比较合适；`--jobs` 只影响渲染，不改参数契约。

### 其他可选项（按收益排序）

1. **canvas 化**：本仓库 canvas 模板约 12.8ms/帧（360 帧 4.6s），比 DOM 截图 32.6ms 快约 2.5×；把 DOM 场景改成 canvas 绘制是单帧层面最大收益。
2. **降分辨率/质量**：1920×1080 → 1280×720 像素少 56%，截图耗时大致同比例下降；JPEG quality 94 → 85 也能省一点。
3. **场景级增量渲染**：按 `scenes` 缓存帧段，改一段只重渲该段再 concat，迭代时可达 5–10×。
4. **降低帧率**：24 → 20fps 帧数 -17%，适合以静态信息为主的片子。
5. **`optimizeForSpeed`**：约 7% 收益，画质略降，可作默认。
6. **WebCodecs 页面内编码**：省去 JPEG/base64 往返，理论收益大，但 DOM 需先栅格化，工程量大。

工具：`profile-chrome.mjs`（截图路径剖析）、`render-parallel.mjs`（并行原型）、`motion-render.mjs --jobs`（已合并）。

### 替代引擎 / 渲染器实测（11-09）

| 方案 | 单帧耗时 | 相对 Chromium | 结论 |
|---|---|---|---|
| Chromium + DOM 截图 | 32.5ms | 1.0× | 当前基线 |
| Chromium + `--jobs 4` | 8.9ms（等效） | 3.4–3.9× | 已落地，零模板改动 |
| Node + Skia Canvas（`@napi-rs/canvas`） | **13.2ms**（含绘制 + JPEG 94） | 2.5× | 需用 Canvas API 重写模板 |
| Skia Canvas + PNG | 210ms | 0.15× | PNG 编码不可取，JPEG 是正确选择 |
| WebKit / Firefox | 未完成 | — | 镜像缺包、官方源 6 分钟无进展；引擎替换还有 CSS 兼容风险，不建议作为主优化 |

结论：

1. **不改模板**：`--jobs` 并行是性价比最高的（3.4–3.9×），已经合并进渲染器。
2. **愿意重写**：Canvas 化（2.5× 单帧）+ 并行（3–4×）可叠加，900 帧能到 2–3 秒；再上 WebCodecs 页面内编码，省去 JPEG/base64/ffmpeg 管道，理论还能更快。
3. **只换浏览器引擎**（WebKit/Firefox）收益不确定，不建议；Remotion 仍是 Chromium，优势在工程化（并行/缓存/Lambda），本地并行已被 `--jobs` 覆盖。
4. 如果只是要草稿速度：降分辨率到 1280×720（像素 -56%）比换引擎更直接；PNG 帧流不要用（210ms/帧）。

### 并行扩展对比（同一台 M5 Ultra）

| 方案 | 并行度 | 总耗时 | ms/帧 | fps | 相对 Chromium 串行 |
|---|---|---|---|---|---|
| Chromium 串行（含音频） | 1 | 30.66s / 881 帧 | 34.8 | 28.7 | 1.0× |
| Chromium `--jobs 4` | 4 | 7.85s / 882 帧 | 8.9 | 112 | 3.9× |
| Chromium `--jobs 8` | 8 | 4.46s / 882 帧 | 5.1 | 198 | 6.9× |
| Skia 1 worker | 1 | 3.26s / 240 帧 | 13.6 | 74 | 2.4× |
| Skia 2 workers | 2 | 1.64s / 240 帧 | 6.8 | 146 | 4.8× |
| Skia 4 workers | 4 | 0.79s / 240 帧 | 3.3 | 302 | 9.8× |
| Skia 8 workers | 8 | 0.46s / 240 帧 | 1.9 | 521 | 16.9× |

口径：Chromium 一行含页面加载 + 截图 + H.264 编码 + concat；Skia 一行含绘制 + JPEG 编码，不含 H.264（接 ffmpeg 编码预计再加 2–3ms/帧）。即使按这个口径，Skia 8 线程仍比 Chromium 8 路快约 2.5×。

**并行不是某个工具的特权**，只要「每一帧是独立的纯函数」，就能分片。差别在扩展成本：

| 工具 | 并行机制 | 单机上限 | 备注 |
|---|---|---|---|
| Chromium（本仓库） | 多进程分片 + MPEG-TS concat | ~6.9×（8 路） | 零模板改动，已落地 |
| Remotion | `--concurrency` 多 Tab / Lambda 分布式 | 单机同量级，分布式近线性 | 工程化强，仍是 Chromium 截图 |
| Motion Canvas / Revideo | 内置 workers（Canvas） | 接近 Skia | 需用其时间轴重写 |
| Skia Canvas | `worker_threads` 自管 | ~16.9×（8 线程） | 单帧最快，需重写模板 |
| FFmpeg | libx264 多线程 / 分段编码 | 编码已并行 | 不是瓶颈 |

### 并行质量审计（8 路 vs 串行）

| 指标 | 结果 |
|---|---|
| 逐帧 PSNR | 平均 **71.73dB**，min **46.67dB**，p1 47.35dB，p5 50.87dB |
| 最差帧 | 第 556 帧（第 5 片边界附近）46.67dB，仍属视觉无损 |
| 黑帧检测 | 3 段（6.42–6.67s / 33.42–33.58s / 36.29–36.71s），**串行版完全一致**；是 point/outro 深色背景与片尾淡出被 `blackdetect` 误判 |
| 连续重复帧 | 仅片头 9 帧（0–0.33s 纯背景）+ 1 处 2 帧，串行版同样；不是丢帧 |
| 帧数 | 882（并行）vs 881（串行），差 1 帧是音频 `-shortest` 截断 |
| 合片方式 | MPEG-TS 分段 + `concat -c copy`，无二次编码 |

结论：**并行只影响速度，不影响画面**。每片使用同一页面、同一套 inputs、同一 seek 与 JPEG/H.264 参数；分片边界没有黑帧、重复帧或错位。片头 0.33s 静态是 `build-sync.py` 的 lead（0.35s）与时间轴缩放导致文字 0.78s 才入场，不是渲染丢帧；想更紧凑可以调小 lead。

### 实战对比：新剪一条 47 秒片

新主题「AI 剪辑工作流」，8 段分镜 + 晓晓旁白 + 逐句字幕，只改并行度：

| 版本 | 耗时 | 单帧 | 吞吐 | 加速比 | 体积 | PSNR 平均 / 最低 |
|---|---|---|---|---|---|---|
| 串行 1 路 | 39.14s | 34.6ms | 28.9 fps | 1.00× | 2.96 MB | 基准 |
| 并行 4 路 | 11.29s | 10.0ms | 100 fps | 3.47× | 3.10 MB | 80.00 / 48.67 dB |
| 并行 8 路 | 7.26s | 6.4ms | 156 fps | 5.39× | 3.20 MB | 65.46 / 47.48 dB |

三版帧数同为 1130；黑帧 3 段（5.71–6.13s、42.42–42.63s、46.54–47.04s）三版完全一致，是模板深色场景与片尾淡出；无连续 ≥3 帧重复。体积略增来自每段首帧 I 帧，不是画质下降。报告页 `out/render-benchmark.html`，剪辑稿 `edits/scenes-v6.json` + `edits/voices-v6.json`。

### Skia 实际成片对比（同一条 47s 片）

用 `canvas-editorial.mjs` 把同一条片子的 8 段分镜用 Canvas 2D 重绘，直接输出 JPEG 帧流编码，再混同一条音轨：

| 指标 | Chromium 8 路 | Skia 单线程 |
|---|---|---|
| 耗时 | 7.26s | 10.12s |
| 单帧 | 6.4ms | 8.95ms（含 H.264） |
| 体积 | 3.20 MB | **1.99 MB** |
| 渲染源 → 成片 PSNR | — | **41.75 dB** |
| 边缘锐度（sobel YAVG） | 9.24 | 9.17（差 0.7%） |
| 两版逐像素 PSNR | 平均 16.4 dB（**版式差异**，不是质量差） | — |

结论：**Skia 无质量损失**，锐度几乎一致，体积小 38%；单线程已接近 Chromium 8 路，按 worker 并行（实测 8 线程 1.9ms/帧）可到 2–3 秒。代价是模板要用 Canvas 重写（本次 8 段约 600 行），DOM 的自动换行/阴影/backdrop-filter 要自己实现。报告页 `out/skia-vs-chromium.html`，脚本 `canvas-editorial.mjs`。

### 极限压测与内存（Skia worker vs Chromium）

| 方案 | 耗时 | 单帧 | 吞吐 | 峰值 RSS | 进程 |
|---|---|---|---|---|---|
| Skia 1 worker | 9.60s | 8.5ms | 118 fps | 1.05 GB | 2 |
| Skia 2 workers | 5.10s | 4.5ms | 222 fps | 1.95 GB | 3 |
| Skia 4 workers | 2.82s | 2.5ms | 401 fps | 3.69 GB | 5 |
| **Skia 8 workers** | **2.29s** | **2.0ms** | **494 fps** | 6.95 GB | 9 |
| Skia 12 workers | 2.65s | 2.3ms | 427 fps | 9.67 GB | 13 |
| Skia 16 workers | 3.24s | 2.9ms | 349 fps | 10.73 GB | 16 |
| Chromium 8 路 | 7.55s | 6.7ms | 150 fps | 9.72 GB | 41 |

结论：**8 worker 是拐点**（2.29s），比 Chromium 8 路快 3.3×、内存省 28%；12/16 因编码与内存带宽竞争反而更慢，内存继续线性上涨。把 worker 的 V8 堆限制到 128/256/512MB，峰值仍 ~7GB → 内存来自 Skia native 缓存（字体/表面/编码器），不是 JS 堆。采样用 macOS `libproc`（沙箱禁用 `ps`），每 120ms 取进程树 RSS 峰值，已用空 Node 42MB / 1080p Canvas 97MB 校准。报告页 `out/limit-benchmark.html`，脚本 `bench-limit.sh` + `mem-monitor.py`。

## 14. 剪辑流水线优化（2026-11-09）

端到端（47.1s 片，不含写稿）：优化前 ≈20.9s → 首次 ≈8.5s → 缓存命中 ≈3.8s。

- **TTS 是最大瓶颈**：串行 17.43s；`build-sync.py` 加 `--tts-jobs`（默认 4）后 **4.99s（3.5×）**，并加 `edits/tts-cache/`（key = `sha1(tts|voice|rate|text)`），缓存命中 **0.32s（54×）**。迭代改一句只重合成那一句。
- **渲染已到 2.29s**（Skia 8 worker），继续压只能靠增量渲染。
- **编码调参无收益**：JPEG 90 + crf20 省 4% 体积但速度不变；ultrafast + crf22 快 0.09s 但体积 2.6×。保持 94 / veryfast / crf18。
- **未实施建议**：按场景增量渲染（改 1 段只重渲 1 段，迭代 5–10×，最值得做）、渲染与混音重叠（省 1–1.2s）、TTS 8 并发（限流风险）、草稿模式（960×540 + 15fps，3–4×）、自动质量闸门（黑帧/重复帧/PSNR 回归）。
- 坑：沙箱下 `pathlib.mkdir(exist_ok=True)` 对已存在目录会抛 `FileExistsError`，改为先 `exists()` 判断。

## 15. 增量渲染与对抗审查（2026-11-09）

第一性原理：成片 = 有序帧序列 + 音轨；帧 = f(场景内容, t, 字幕, 全局样式) 是纯函数 → 可缓存的最小单位是「输入完全相同的帧段」，场景是天然边界，key = 内容哈希（场景 + args + t0/t1 + 重叠字幕 + 全局样式 + 编码参数 + 渲染器版本）。时间轴变化（换音色）必然让所有段失效，这是数学事实，不是策略问题。

增量实测（47.1s / 1131 帧，8 段）：

| 场景 | 内部耗时 | 含进程启动 |
|---|---|---|
| 首渲（8 段） | 2.70s | 3.87s |
| 全命中 | **0.13s** | 1.37s |
| 改 1 段文案 | 1.43s | 2.70s |
| 改 1 句字幕 | 1.40s | 2.62s |

对抗审查查出的真问题：

- **P0 丢片头 8 帧**：按场景切段用 `round(t0×fps)` 起点，首场景 t0=0.35 → 0–0.33s 被丢掉，整条帧序列前移，PSNR 从 56dB 掉到 17.13dB。修复：首段强制从 0 开始、段间用游标衔接；复测 1131 帧 / 56.00dB。
- **P1 音画差 0.31s**：混音 `-shortest` 留下无画面尾巴；改显式 `-t FRAMES/FPS`，容器 = 视频 = 47.125s。
- **P1 深色场景误判黑帧**：`blackdetect pix_th=0.10` 把 #0A0A0A 判黑；`qa-gate.py` 改 0.03，PASS。
- **P2 响度不统一**：晓晓 −23.0dB vs 云健 −27.5dB（差 4.5dB），建议 loudnorm。
- **P2 其他风险**：字体分发（PingFang）、缓存无 GC、`RENDERER_VERSION` 手升、TTS 缓存不含引擎版本、冷启动 1.2s（增量后占 88%，解法是常驻 daemon）。

新增：`canvas-editorial.mjs --incremental`、`qa-gate.py`（帧数/黑帧/重复帧/PSNR 回归）。报告页 `out/adversarial-review.html`。

## 16. 常驻渲染 daemon（2026-11-09）

全命中 1.37s 的根因**不是冷启动**，是音频重编码 + 两次封装：

- 音频本来就是 AAC 48k 立体声，混音却 `-c:a aac` 重编 47s（≈0.75s）→ 改 `-c:a copy`；
- 先 concat 成 MP4、再读 MP4 混音写第二个 MP4 → 改从 concat 列表一步输出；
- 冷启动（Node + Skia + 字体）约 0.2–0.3s → daemon 常驻，后续请求不再付。

结果：全命中 **1.37s（旧）→ 0.66s（CLI 优化后）→ 130ms（daemon，10.5×）**；改 1 段 2.70s → **1.82s**；首渲 ≈2.8s。daemon 输出与 CLI 版逐帧 **PSNR = inf**（视频流 copy 同一缓存段，像素完全一致）。

实现：`render-daemon.mjs`（HTTP `POST /render`，进程内保留 Skia/字体/场景数组/缓存索引）；`canvas-editorial.mjs` 导出 `loadInputs / renderIncremental / mixAudio`，`renderIncremental` 支持 `concat:false` 返回列表供一步封装，worker 通过 `inputsPath` 加载正确输入。

池化（常驻 4 worker）后：未命中段按 **60 帧切片**并发，改 1 段 **1.37s → 0.82s**（3 片）；全命中稳定 **130ms**。daemon 空闲内存 **212MB**，改 1 段渲染峰值 **1.46GB**（对比 8 worker 全量 6.9GB）。缓存 GC：`gcCache()` 保留当前 key，按总大小（默认 200MB）与 14 天未访问过期清理；实测把上限压到 1MB 时 **17 段 / 3.2MB → 8 段 / 1.3MB**，清 9 个旧段、当前段不误删，再渲全命中 178ms。同 key 去重：`SEG_INFLIGHT` Map 跨请求共享渲染 Promise；实测两个相同全量请求并发（空缓存）分别 3.69s / 3.78s 完成，缓存仅 8 段，无重复渲染。池大小：`node render-daemon.mjs 7799 8` 时首渲 **2.30s**（池 4 约 3s）、改 1 段 0.76s、全命中 136ms，渲染峰值 **4.6GB**。空闲 worker 不建画布，只占库内存；池 8 适合 16GB 以上机器。报告页 `out/daemon-benchmark.html`。

## 17. 口播头像与风格变体（2026-11-09）

- **头像**：ImageGen 生成 1 张女主播头像（约 5–10 积分），裁 800×800 去水印存 `edits/assets/avatar.png`；`canvas-editorial.mjs` 用 `loadImage` 加载，右上角圆形裁剪 + 白描边 + 2.2Hz 呼吸缩放 + 「晓晓 · 口播」标签。`--avatar off` 可关闭；头像路径 + mtime 纳入缓存 key，换头像会自动失效相关段。
- **风格变体**：同一文案出 4 版——原色、暖色（`colorbalance=rs=0.12:gs=0.03:bs=-0.12`）、冷色（`rs=-0.10:bs=0.12`）、黑白（`hue=s=0`）；音频 `-c:a copy` 不重编，四版均 1113 帧 / 46.375s。
- 下一步：把颜色常量抽成 `theme`（纸感/午夜/暖橙/黑白），实现真正的版式风格，而不只是调色。对比页 `out/editorial-v7-styles.html`。

## 18. MotionGit 第三方模板：分片并行失败（2026-11-09）

结论：**这个模板不适合分片并行，已放弃**，脚本保留但默认禁用（需 `--force`）。

| 方案 | 耗时 | 结果 |
|---|---|---|
| 串行 `render`（基线） | 89s / 2783 帧 | 正确 |
| 4 路分片（按分镜边界切） | **453s** | 慢 5 倍，且输出有缺陷 |

**为什么慢**：每个分片都要完整跑一遍 `check-params`（约 47s）+ `plan`（约 52s）+ `prepare` + `preview`，这些是固定开销，不随片长缩小，切 N 片就是 N 倍。渲染本身每片只要约 25s，完全被校验吃掉。

**为什么错**：模板的合成状态依赖全局时间轴。把分片的 `t0` 重置为 0 后，presenter 分段映射错位 —— 分片 12.1s 帧上的右侧口播人物卡片消失，右上角还多出 `00:00` 时间码；同一时刻串行版是正常的头像卡片。

**能用的替代**：
1. 单条片子：没有并行空间，接受 1.9× 实时（46s 片约 89s）；
2. 多条片子：批处理并发（每条独立跑完整流水线），吞吐可线性提升；
3. 要单条更快：只能换渲染引擎，见 `SKIA-ROADMAP.md`。

产物与字段结论：
- `shard-tpl.py` —— 切片工具（音轨必须用 WAV 精确切，AAC 帧对齐会多 20ms 被校验拒）；
- `render-parallel-tpl.py` —— 并行驱动（默认拒绝执行）；
- 分镜边界切分不会切断动画，逐帧校验 2783 帧 / 46.386s 完全对齐，问题只在固定开销与合成状态。

## 19. 批处理并行：多条片子并发出片（2026-11-09，有效）

`render-batch.py`：N 条实例各跑完整流水线，线程池并发。实测 2 条 46.4s 的片子 **2 并发 4m51s**（串行预估约 9.7 分钟），接近线性 2×；输出与单跑一致（两次渲染互比 PSNR 65.8dB，视觉相同）。

用法：
```
python3 render-batch.py --jobs 3 --out-dir out/batch instA instB instC
```

两个坑：
1. 核心把 `--out` 解析到**实例目录内**（`<inst>/out/batch/x.mp4`），必须传绝对路径，否则输出会"消失"；
2. 同一实例重渲要先删 `plan/`、`project/`，模板对已存在的产物直接拒绝。

扩展：批处理天然可跨机 —— 每台机器认领若干实例，最后只汇总 mp4，无共享状态。

## 20. 端到端自动化：剪辑稿 → 模板成片（2026-11-09）

`make-tpl.sh <前缀> [并发数] [口播标签]`：build-sync 的产物直接变成模板成片。

```
edits/inputs-v7.json ──gen-tpl-params.py──► 模板实例（params + inputs/）
edits/audio-v7.m4a  ──┘                      │
                                  render-batch.py
                                             ▼
                                    out/tpl/tpl-auto.mp4
```

实测：v7 全流程（建实例 → 校验 → plan → prepare → preview → render）**一次通过，157s 出片**，2783 帧 / 46.386s / 4.7MB。与手工适配版差异只在文案映射细节（对比镜头大字取 items[0]、keyword 提示词用通用「重点」），可用镜头里 `args.tpl` 覆盖。

`gen-tpl-params.py` 的内置映射（已过校验）：

| 我们的分镜 | 模板控件 | 用途（narrationMap） |
|---|---|---|
| hero | title / slam | neutral-emphasis |
| point | keyword | neutral-list |
| number | number | neutral-emphasis |
| compare | compare / split | real-comparison |
| steps | steps / track | ordered-process |
| quote | quote / type | summary |
| checklist | **number**（checklist 需私有 beats，不可用） | neutral-emphasis |
| outro | outro / thanks | user-requested-action |

三个硬性细节，缺一不可：
1. `narrationMap` 的 start/end 必须严格等于镜头 t0/t1；
2. 首镜 t0 必须为 0（build-sync 的 lead 会让它从 0.35 开始，开头会留空场）；
3. `render --out` 必须留在实例内部（核心会拒绝实例外路径），渲完再搬走。

## 21. 新模板实测：宣纸手卷 promo-ink（2026-11-09）

`motiongit-promo-ink` v2.6.6（Paper Scroll · Brand Story），html-canvas/1 运行时，与 paper-perspective 的 motion-kit 是**两套工作流**：setup 无需工作流名，装的是 `~/.cache/motiongit/canvas-dependencies/`（只有 playwright-core）；参数契约用 `motion.mjs read <pkg> params.schema.json` 获取。

**流水线耗时**（check 5s → plan 10s → prepare 5s → preview 7s → **render 1102s**）：

| 模板 | 渲染 | 单帧 | 每条总成本 |
|---|---|---|---|
| paper-perspective（motion-kit） | 89s / 2783 帧 | 32ms | ≈ 4 min |
| **promo-ink（canvas）** | **1102s / 3555 帧** | **310ms** | **≈ 19.3 min** |

**对抗审查发现**：
1. **时长固定 59.25s**，不适配配音——46.4s 的配音留下 12.9s 纯静音尾（-91dB），且结尾文案（text31-35）正好落在静音区。参数里没有 duration 旋钮，只有 6 个参数；
2. **渲染 310ms/帧**，是纸面透视的 10 倍、自建 Skia（1.9ms）的 163 倍——水墨晕染效果的代价；
3. **文案是 35 个独立槽位**（7 个 4 字序号槽 + 28 个 40 字内容槽），视觉编排固定——**不能拿现成口播直接喂**，配音必须按 59s 脚本写，否则声画错位（30s 处画面近空白而配音在讲步骤）；
4. 媒体路径必须在 `user-media/` 下；brand.markPath 是 700×128 坐标系的 SVG path 字符串；
5. 无黑帧、无 ≥0.1s 冻结、音画时长精确一致（59.250s = 59.250s），视觉质量高（书法/印章/时间码全局正确）。

**对客交付要点**：配音按 59s 脚本定制，或接受静音尾 + 配乐铺底；把交付时长写进合同口径。

## 22. 新一代口播模板 film-kit/1：可驱动性实测（2026-11-09）

`mac-desktop` v1.0.0-rc.2（55 镜头，1440×1080）与 `camera-mode` v1.0.0-rc.4（20 镜头，1080×1440 竖屏）都是 **film-kit/1** 运行时，与 motion-kit / html-canvas 又不同：

**能自动化的部分**（快得惊人）：
- setup 4–6s（免工作流名，只装 playwright-core 到 `~/.cache/motiongit/canvas-dependencies/`）；
- `check-params film.json` 0–7s（时长自适应配音：talk 镜头填 from/to 即可，无 59s 固定时长问题）；
- `plan film.json` 4–6s。

**卡住的部分**：
- `preview` / `render` / `prepare` 全部崩在核心入口 `entry.mjs:36 isAbsolute(undefined)`（ERR_INVALID_ARG_TYPE）——作者验证环境是 Node 23 + 自有 `motion` 全局命令 + 生产工作区契约，标准 CLI 传参驱动不了；
- 工作流名被受保护核心隐藏（`contract` 不列出合法名，穷举 19 个候选全败）；
- film.json 的镜头用 `{"type":"talk","from":0,"to":秒}` 声明时间范围，旁白/字幕文件放在实例根目录（不是 inputs/）。

**对客含义**：film-kit 这一代把可编程面收得更窄——连流水线都要走作者的助手流（交互式 start 首读）。可自动化程度排序：**自建 Skia > motion-kit（paper-perspective，全流水线可脚本化）> html-canvas（promo-ink，可脚本化但 310ms/帧）> film-kit（mac-desktop/camera-mode，暂只能人工助手流）**。

## 23. 「不同模式」速度总表（同一段 46.4s 口播，2026-11-09 汇总）

| 模式 | 引擎/模板 | 单条耗时 | 说明 |
|---|---|---|---|
| 增量命中 | 自建 Skia + daemon | **0.13s** | 改一句文案 0.76s |
| 首渲 | 自建 Skia（8 worker） | **2.3s** | 峰值内存 1.46GB |
| 串行 | **自有模板 + Playwright** | **38.87s / 1113 帧** | 34.9ms/帧，24fps，v7 同稿实测 |
| 8 路并行 | **自有模板 + Playwright** | **7.66s / 1113 帧** | 6.9ms/帧、145fps、5.1×；峰值内存约 9.7GB |
| 串行基线 | MotionGit paper-perspective | 89s 渲染 / ≈4min 总 | 32ms/帧 |
| 批处理 2 并发 | paper-perspective ×2 | 4m51s / 2 条（≈2×） | 输出与单跑一致（PSNR 65.8dB） |
| 分片 4 路 | paper-perspective | 453s（**慢 5 倍**） | 固定开销×N + 全局状态错位 |
| 串行 | MotionGit promo-ink | 1102s 渲染 / ≈19.3min | 310ms/帧，水墨效果代价 |
| film-kit | mac-desktop / camera-mode | 渲染不可达 | 入口崩溃，需作者助手流 |

性价比结论不变并强化：**自建 Skia 的秒级增量是唯一能支撑"客户在场改稿"工作流的架构**；MotionGit 模板按条计费式交付（4min–19min/条），其中 film-kit 一代暂不可自动化。

## 24. 自有模板 + Playwright/Chromium 档位实测（v7 同稿，2026-11-09）

> 命名更正：这一档不是"自建引擎"。渲染栈与官网模板**完全相同**（Node + playwright-core + Chromium/headless shell），区别只在于模板 HTML 是我们自己写的、渲染循环跑在本地。因此它不能当作"另一种引擎"与 MotionGit 模板比较，只能当作"同一引擎 + 不同帧率/流程"来比较。

补上总表里缺的这一档：同一份 `inputs-v7.json`（8 分镜 / 46.386s / 1113 帧）+ `audio-v7.m4a`，只改 `--jobs`。

| 版本 | 耗时 | 单帧 | 吞吐 | 加速 | 体积 |
|---|---|---|---|---|---|
| `--jobs 1` | 38.87s | 34.9ms | 28.6 fps | 1.0× | 2.77 MB |
| `--jobs 8` | **7.66s** | 6.9ms | 145 fps | **5.1×** | 2.92 MB |

**质量审计**：
- 帧数均 1113，音轨 2174 帧 / 46.357s，容器 46.375s，与 Skia 版一致；
- 8 路 vs 串行 **PSNR 平均 55.38dB、最低 46.83dB**，视觉无损（>45dB）；
- 黑帧 1 段 / 冻结 39–40 段，串行版同为 1 / 39，Skia 版为 0 / 39——来自模板静态画面与深色场景，非并行引入；
- 8 路在 35.0s（第 6 个分片边界）多出一段冻结判定，逐帧比对确认**无重复帧**：该处 YDIF 仅 0.003–0.2（近乎静止的淡入段），两边都贴着 `freezedetect` 阈值，属编码噪声造成的阈值抖动，不是卡帧；
- 与 Skia 版逐帧 PSNR 16.56dB 属**版式差异**（两套不同画法），不能当画质指标。

**档位定位**：Chromium 8 路 7.66s 介于「Skia 8 worker 2.3s」与「MotionGit 模板 89s+」之间，比 Skia 慢 **3.3×**、内存高约 40%（9.7GB vs 6.95GB），但换来完整 CSS/DOM 保真（富文本、阴影、滤镜零重写）。它没有场景级增量缓存与常驻 daemon——那是 Skia 架构独有的，Chromium 侧只有并行分片。

**同引擎校准（关键）**：这条链路与纸面透视同为 Chromium/Playwright，单帧成本几乎一样——**34.9ms vs 32ms（差 9%）**。总时长差 2.3× 主要来自帧率：我们是 24fps / 1113 帧，纸面透视是 60fps / 2783 帧。所以「89s vs 38.87s」不是引擎优劣，而是**帧数 + 流水线固定开销**的差；比较引擎只能用 ms/帧，不能用总时长。

## 25. 各工作流依赖清单：官方声明 + 实测锁定（2026-11-09）

**官方声明（四个模板的 `guide.execution.environment` 文本完全一致）**：

| 项 | 官方要求 |
|---|---|
| 入口 | 宿主已有 **Node.js 22+** 跑 `assistant/motion.mjs`（不要求全局 `motion` 命令，`globalMotionCommandRequired: false`） |
| 浏览器 | 优先「已安装的独立 Chromium headless shell」；Windows 可用现有 Chrome/Edge；`CHROME_PATH` 可覆盖（单独校验）；自动化用**独立临时 profile**，不动用户 Chrome 数据 |
| 安装策略 | `setup` **只补缺**：没有可用浏览器时才装 Chromium headless shell；不预装、不打包、不宣称"已测试" |
| 其余渲染依赖 | 由模板自己声明（Python / 浏览器 / 编码器），helper 按声明准备；Python 子进程强制 UTF-8 |
| 账号 | `websiteLoginRequired: false`（包内凭据 + 验签即可） |

**实测锁定版本**：

| 工作流 | 模板 | playwright-core | 期望内核（revision / 版本） | Python 侧 |
|---|---|---|---|---|
| motion-kit | paper-perspective 2.7.21-alpha.12 | **1.58.2** | chromium + headless-shell **1208** = CFT **145.0.7632.6** | **3.13 + numpy 2.4.2**（venv） |
| html-canvas | promo-ink 2.6.6 | **1.55.0** | **1187** = **140.0.7339.16** | 无 |
| film-kit | mac-desktop rc.2 / camera-mode rc.4 | 无独立依赖包 | 复用宿主浏览器 | 无独立 venv |
| 自有 editorial-sync | 本仓库 | **1.65.0**（`playwright`） | **1254** = **158.0.8127.18** | 无（Skia 侧另有 `@napi-rs/canvas`） |

**本机现状与一个必须标注的口径**：`ms-playwright` 里有 1208 / 1254，**没有 1187**。用 canvas 运行时的 1.55.0 实测：默认 `launch()` 直接报 `Executable doesn't exist at .../chromium_headless_shell-1187`，而 `channel: 'chrome'` 成功（系统 Chrome **157.0.8103.39**）。也就是说 promo-ink 那次 1102s 渲染跑在**系统 Chrome 157** 上，不是它 pin 的 140——这个成绩要按"系统 Chrome"口径看待。要严格对齐，可装 1187 后重测（镜像 ~8s），但 310ms/帧主要来自水墨效果本身，预期量级不变。

## 26. 五种工作流效率拆解（v7 同稿，2026-11-09 实测）

同一份 46.386s 稿子（8 分镜 + 晓晓音轨），把「流程开销」和「渲染」分开计时。motion-kit 为本次分阶段重测（gen 4s / check 27s / plan 29s / prepare 28s / preview 32s / render 74s）。

| 工作流 | 前端流程 | 渲染 | 端到端 | 帧数 | 单帧 | 开销占比 | 每 1 分钟成片耗时 |
|---|---|---|---|---|---|---|---|
| 自有模板 + Playwright 8 路（24fps） | 0 | **7.66s** | **7.66s** | 1113 | 6.9ms | 0% | **0.17 分钟** |
| 自有模板 + Playwright 8 路（**60fps 同帧率**） | 0 | **16s** | **16s** | 2783 | 5.75ms | 0% | 0.34 分钟 |
| 自建 Skia 8 worker（24fps） | 0 | **2.3s** | **2.3s** | 1131 | 2.0ms | 0% | **0.05 分钟** |
| motion-kit（纸面透视） | **120s** | 74s | **194s** | 2783 | 26.6ms | **62%** | 4.18 分钟 |
| html-canvas（宣纸手卷） | 27s | 1102s | **1129s** | 3555 | 310ms | 2.4% | 24.3 分钟 |
| film-kit（mac-desktop/camera-mode） | 10–15s | 不可达 | — | — | — | — | — |

**关键发现**：

1. **motion-kit 的效率漏洞在流程，不在渲染**：check 27 + plan 29 + prepare 28 + preview 32 = **120s，占 62%**。preview 只出 2 张静帧却要 32s，因为每个阶段都要冷启动一次受保护核心（约 25–30s/次）。渲染本身 74s（60fps/2783 帧，26.6ms/帧）并不慢。
2. **html-canvas 正好相反**：流程只有 27s（2.4%），但 310ms/帧吞掉 97.6%。它的开销集中在单帧绘制（水墨晕染），不在流程。
3. **自有模板零流程开销**：没有 check/plan/prepare/preview 四道关卡，渲染完即封装。同帧率（60fps/2783 帧）8 路 **16s**，是 motion-kit 端到端的 **12.1×**；按 24fps 交付则是 **25.3×**。
4. **单帧横向排序修正**：Skia 2.0ms ≪ motion-kit **26.6ms** < 自有 PW 34.9ms ≪ html-canvas 310ms。**motion-kit 单帧比我们低 24%**（早前一次 89s 测得 32ms，存在 20% 波动，取区间 26.6–32ms）。上一轮"单帧几乎一样"的说法应修正为：我们的总时长优势来自 **24fps + 零流程开销**，不是引擎更快。
5. **吞吐**（46s 片，仅渲染+流程，不含写稿/TTS）：Skia 1565 条/h（首渲）→ 自有 PW 8 路 470 条/h（24fps）/ 225 条/h（60fps）→ motion-kit 18.6 条/h（2 并发批处理实测约 24.7 条/h）→ html-canvas 3.2 条/h。film-kit 为 0（不可交付）。
6. **改一稿成本**：Skia 0.76s（单场景）→ 自有 PW 7.66s（全片重渲）→ motion-kit 194s（plan 依赖文案，无法只重渲）→ html-canvas 1129s。

**结论**：motion-kit 要提效只能靠**批处理并发**（受保护核心的 4 个阶段无法跳过或缓存）；html-canvas 要提效只能**换渲染引擎或降效果**；自有模板要提效靠 `--jobs`；Skia 靠**增量缓存 + daemon**。四条路的效率上限差两个数量级，选型时先看「迭代频率」，再看「视觉溢价」。

## 27. 主题系统：一套模板出三种视觉（v8，2026-11-09）

给自建 Skia 渲染器加 `--theme`，配色从 5 个硬编码常量改为主题表，文案/时间轴/字幕完全复用：

| 主题 | 底色 | 强调 | 满色场景 | 适用 |
|---|---|---|---|---|
| `knowledge` | #F7F7F5 纸白 | #2462EA 靛蓝 | 靛蓝 | 知识、方法论、课程 |
| `product` | #F1F6F9 冷灰白 | #0E7C86 深青 | 深青 | 产品、工具、SaaS |
| `lifestyle` | #FBF4E8 奶油米 | #B8431A 赤陶 | 赤陶 | 生活、口播、个人品牌 |

实现要点：主题只换 `paper/ink/accent/accent2/dim/soft` 六个值；满色场景的强调色改为主题感知的 `onAccent + mark`（否则深色强调词落在青/陶底色上会糊）。主题写进段缓存 key，并升 `RENDERER_VERSION` 到 `2026-11-09.5`，旧缓存自动失效。

**v8 实测**：42.498s / 1020 帧 / 24fps，三版各 **3.0s**（8 worker），QA 三版全 PASS（0 黑帧、0 重复帧、音画 42.498/42.500 对齐）。

**抓到的 P0 缺陷**：并行渲染的 worker 没有拿到 `--inputs` 与 `--theme`——worker 线程不继承命令行参数，`workerData` 里也没传，于是每个 worker 回落到默认 `edits/inputs-v6.json` + knowledge 配色。后果是**三版输出 md5 完全相同、且内容是旧文案**（帧数/时长却是新的，因为主线程算 FRAMES）。修复：`workerData` 补 `inputsPath` 与 `theme`，worker 侧 `applyTheme(theme)` 后再 `loadInputs`；增量池的消息体也补 `theme`。

连带影响：上一轮「60fps 同帧率校准」的成片也中了同一个 bug（帧数与耗时有效，画面是旧稿），已用修复后的代码重渲并抽帧确认。

### 27.1 修复补全：worker 参数与 daemon 主题（2026-11-09 22:15）

首轮修复只覆盖了 CLI 的两条分片路径，复查后补齐三处，并加上防回归机制：

1. **daemon 请求支持 `theme`**：`POST /render` 新增 `theme` 字段，主线程先 `applyTheme` 再 `loadInputs`；池任务携带 `theme`，worker 侧 `msg.theme` 生效。
2. **worker 回报校验（fail-fast）**：worker 完成任务后回传实际使用的 `inputsPath` 与 `theme`；主线程与 daemon 池逐条比对，不一致直接抛 `worker 参数不一致`，不再静默产出错内容。
3. **多主题并发串行化**：`applyTheme`/`loadInputs` 是主线程全局状态，两个不同主题的请求并发会互相污染。daemon 增加 `enqueue` 串行队列，同一时刻只处理一个请求。

**回归测试** `test-theme.sh`（16 秒跑完）：

- CLI 三主题 md5 必须三不相同（`1713097a` / `c2d87ead` / `6cac2195`）；
- daemon 并发请求 `product` 与 `lifestyle`：同主题 PSNR **54.03 / 53.92dB**，跨主题 **19.31dB**——证明各自拿到正确配色；
- 所有输出 1020 帧。

**已知边界**：串行化牺牲了 daemon 的多主题并发吞吐（同主题仍可复用缓存），但避免了串色；若后续要高并发，需把主题改为参数化函数、彻底去掉全局状态。

## 28. MotionGit 推荐路线与产线实测（2026-11-09 22:40）

**结论：MotionGit 只推荐 motion-kit（纸面透视）一条路线。** html-canvas 只接品牌片，film-kit 暂不可用。

### 28.1 三条路线的可交付性

| 路线 | 可脚本化 | 时长自适应 | 单条成本 | 吞吐 | 判定 |
|---|---|---|---|---|---|
| motion-kit（纸面透视） | 全流程 | 是（跟随配音） | ≈4.5 min | 27.9 条/h（3 并发） | **推荐** |
| html-canvas（宣纸手卷） | 是 | 否（固定 59.25s） | ≈18.8 min | 3.2 条/h | 仅品牌片 |
| film-kit（mac-desktop / camera-mode） | 否（入口崩溃） | — | 不可交付 | 0 | 暂缓 |

### 28.2 推荐路线的产线实测（v8 文案 / 42.886s / 2573 帧）

| 模式 | 总耗时 | 单条均摊 | 吞吐 | 加速 |
|---|---|---|---|---|
| 串行 ×1 | 273.7s | 273.7s | 13.2 条/h | 1.00× |
| 并发 ×3 | 386.6s | 128.9s | **27.9 条/h** | **2.12×** |

- 3 并发峰值内存 **12.4GB**、进程数 50（每实例一套核心 + 浏览器）；
- 三份成片规格一致（2573 帧 / 42.886s / 1080p60），互比 PSNR 70.45dB（min 54.76），属编码噪声；
- **并发不是线性的**：3 路只有 2.12×，说明受保护核心存在串行瓶颈，超过 3–4 路预计收益递减。
- 口径说明：单条耗时受核心缓存冷热与机器负载影响，本次 273.7s，早前分阶段合计 194s，区间 **194–274s**；加速比用同一时段的串行/并发对比更可靠。

### 28.3 模板硬约束（必须前置检查）

- **compare 镜头至少 4 秒**。v8 原始时间轴该镜 3.81s，3 路批处理在 render 阶段整批失败（60 秒白跑，3 条全废）。
- 修复：`build-sync.py` 新增 `--scene-min '{"compare":4.2}'`，按类型补静音；模板路线单独出 `inputs-v8t.json`（总长 42.886s），不影响 Skia 版。
- `gen-tpl-params.py` 新增预检：compare <4.0s 直接报错并给出修复命令，把 60 秒的批处理失败变成 1 秒内的明确提示；`--allow-short` 可绕过（不推荐）。

### 28.4 选型口径

MotionGit 的定位是**视觉溢价**，不是产能：motion-kit 27.9 条/h 对比自有模板 470 条/h（24fps）差约 **17×**。接单策略：常规批量走自有模板；客户点名纸面/水墨质感时按条报价（4.5 / 19 分钟），把等待时间写进交付周期。

## 29. Skia 对齐 motion-kit：paper skin（2026-11-09 22:50）

给 Skia 渲染器加 `--skin paper`，把 motion-kit 的“画面外壳”逐项补齐，文案与时间轴不变：

| 元素 | 实现 | 状态 |
|---|---|---|
| 暖纸底 + 纸纹 | 底色改 #F8F2E4；480×270 程序化噪点（ seeded ），7% 叠加，深色场景 4% | 已对齐 |
| 细线 + 刻度 | 1px 顶/底规则线 + 128px 刻度，深浅场景自动换色 | 已对齐 |
| 时间码 | 右上 mm:ss，等宽字体 | 已对齐 |
| 人物卡 | 300×440 圆角裁剪 + 投影 + 描边 + 左上胶囊标签，全镜头常驻 | 已对齐 |
| 金句页 | 满色底改纸底深字，强调词用主题色 | 已对齐 |
| 帧率 | 60fps（2550 帧） | 已对齐 |
| 版式骨架 | 模板偏左 + 栏格/脚注；我们仍居中 | 部分（设计工作） |
| 文字入场 | 模板有遮罩/打字机；我们淡入 + 缩放 | 部分 |
| 组件库 | 索引号、图注、引用块等 | 未做 |

**实测（42.5s 片，60fps）**：

| 指标 | motion-kit | Skia + paper skin |
|---|---|---|
| 帧数 | 2573 | 2550 |
| 体积 / 码率 | 4.68MB / 686kbps | 4.39MB / 652kbps |
| 边缘锐度（开场/金句） | 14.7 / 13.6 | 13.2 / 11.3 |
| 渲染耗时 | ≈274s | **6.19s** |

**工程改动**：`--skin paper` 进缓存 key（版本 .6）；skin 与 theme 一样传入 `workerData` 并纳入 worker 回报校验；daemon `POST /render` 支持 `skin` 字段（实测 1020 帧 / 6.2s，与无皮肤版 PSNR 9.8，确认生效）。

**结论**：视觉外壳已对齐约 80%，剩下是版式系统（偏左构图、栏格、遮罩入场、组件库），属 1–2 天设计工作；渲染成本仍相差约 **44×**。

## 30. 补齐 L2/L3：版式与动效对齐（2026-11-09 23:20）

在 §29 的外壳之上，补齐三块：

1. **左对齐版式**：hero 由居中改为 x=140 左对齐；金句页左对齐并加大引号；页脚增加 `MOTION LAB` + `07 / 08` 页码。
2. **动效**：标题用裁切矩形做遮罩揭示（带 4px 光标）；金句改为逐字打字机（`rich(..., maxChars)` 支持按字截断，兼容 `*强调*` 标记）。
3. **自适应**：新增 `fitFont()`，按安全区自动缩字号（hero 上限 1356px、金句 1240px、清单 1180px、步骤按列距、对比按卡宽、论点按剩余宽度）；hero 两行共用同一字号，避免“一行缩一行不缩”。

**最终指标（42.5s / 60fps）**：2550 帧 / 4.44MB / 662kbps / 渲染 6.41s；motion-kit 2573 帧 / 4.68MB / 686kbps / 274s。锐度 13.4（开场）、11.7（金句），模板为 14.7 / 13.6。

### 30.1 对抗审查结果

| 问题 | 证据 | 处置 |
|---|---|---|
| 页脚对比度不足 | 0.38 黑字仅 **2.64:1**（AA 需 3:1） | 改 0.55 → **4.62:1** |
| 弱化文字偏浅 | DIM #8B8171 在纸底 3.2:1 | 改 #6E6557 → **5.14:1** |
| 长标题溢出 | 19 字标题按 132px 排超安全区 | `fitFont` 自适应；双行统一字号（实测无告警） |
| 皮肤污染缓存 | skin 未入 key 时会命中旧段 | 入 key；实测换肤 8/8 命中 → 0/8 |
| worker 参数丢失 | 早期三版 md5 相同、内容是旧稿 | workerData + 回报校验（含 skin） |
| 多主题并发串色 | 主线程全局态 | daemon 串行队列 |
| 纹理非确定 | 随机噪点每帧不同 | 固定种子，两次探针 md5 一致 |
| 皮肤开销 | 60fps 5.0s → 6.41s | **+28%**，仍比模板快 42× |

**未解决**：无自动换行（仅缩到 56px 后告警）；字体度量差异导致无法像素级一致；组件库（索引号/图注/引用块）仍缺；商用需确认模板授权边界。

**结论**：视觉相似度约 90%，差距在锐度与组件库，不在渲染能力；建议停在 L3，继续做组件库的边际收益低于维护成本。

## 31. 从 90% 到收口：字体真相 + 版式反推（2026-11-09 23:45）

上一轮结论是「视觉相似度约 90%，差距在锐度与组件库」。这一轮没有调参，先查根因，再按模板逐像素反推，八个版式全部重写。

### 31.1 根因：PingFang 一直是假注册

```js
GlobalFonts.registerFromPath('/System/Library/Fonts/PingFang.ttc', 'PingFang SC'); // 返回了 FontKey
GlobalFonts.has('PingFang SC')            // false —— 家族表里没有
g.font = '800 152px "PingFang SC"';
g.measureText('一').width                  // 118.2 = 0.78em（正常 CJK 是 1.00em）
```

@napi-rs/canvas 对 PingFang.ttc 的注册会静默失败，于是标题一直走回退字体：**字面窄 22%、笔画轻一档**。
这一条同时解释了三个旧现象：锐度低 10%、同字号排出来比模板短、怎么加字重都没变化。

修法：仓库自带 **Noto Sans SC**（Black / Medium / Regular，SubsetOTF，来自 noto-cjk，OFL），
字体不进 git，`./fetch-fonts.sh` 一条命令拉齐（OFL）。它与模板字形同源（Source Han Sans 家族），同字号墨迹立刻对齐：
模板首行 936×129，复刻 932×129。

### 31.2 方法：投影量墨迹，不靠肉眼

抽 8 帧 → 与底色求差 → 行/列投影 → 得到每个文字块与图形元素的墨迹包围盒 → 反解字号 / 行距 / 圆心 / 半径 / 卡片宽。
两个反直觉的发现：

- **compare 不是双栏等宽**：左栏左对齐 x=141，右栏**右对齐** x=1198，中缝 670，VS 压在缝上，标题 92px。
- **checklist 表盘**：R=330、圆心 (669,595)，白色进度弧几乎贴外圈（R−2），不是常见的 R−18。

### 31.3 重写后的八版式

| 场景 | 关键元素 | 实测参数 |
|---|---|---|
| hero | 眉标 + 左对齐标题 + 遮罩揭示 | x=144，126px，行距 136，墨顶 344 |
| point | 大弧（圆心在画外）+ 强调底纹 + 下划线 | c(668,872) r=757，标题 116px 居中 |
| number | 双环 + 数字滚动 + 单位 | c(670,418) r=265/237，数字 172px |
| compare | 左右不对称对齐 + 竖分隔 + VS | 左 141 / 右 1198 / 缝 670，标题 92px |
| steps | 时间轴 + 白卡 + 未完成幽灵卡 | 节点 246→1093，卡片 147 + i×207，200×126 |
| quote | 引号 + 打字机 + 落款 | 引号 x=158 baseline 362，正文 83px 行距 119 |
| checklist | 仪表盘 + 指针扫动 + 大数字 | R=330 / c(669,595)，数字 180px Medium |
| outro | 纵向拉伸大标题 + CTA 胶囊 | 230px × scaleY 1.19，胶囊 545×71 |

题外：模板的 `outro` 大标题是 3 字宽 670、墨高 259——同一字号下宽高比对不上，只有 **scaleY≈1.19** 能同时满足，
所以复刻里显式用了纵向拉伸，而不是“再大一号”。

### 31.4 指标（同稿 42.886s / 2573 帧 / 1080p60）

| 指标 | motion-kit | 复刻 |
|---|---|---|
| 体积 / 码率 | 4.68MB / 686kbps | 5.11MB / 826kbps |
| 渲染耗时 | 274s | **8.7s**（增量）/ 5.9s（全量 8 worker） |
| 单帧 | 106ms | **3.4ms** |
| 峰值内存 | —（浏览器链路 9.7GB） | **848MB** |
| 边缘锐度（8 场景均值，模板=1） | 1.00 | **0.977** |
| 版式墨迹偏差 | — | **≤4px** |
| QA | — | 0 黑帧 / 0 重复帧 / 音画对齐 PASS |

体积比模板大 9%，是把 CRF 压到 20、JPEG 94 换零伪影的结果；若要同码率，CRF 22 即可（约 700kbps）。

### 31.5 顺手修掉的一个隐患

增量缓存 key 现在包含**渲染器代码 sha1**。上一轮踩过“改了绘制代码但忘记升 `RENDERER_VERSION`，
增量渲染 8/8 命中旧段”的坑——加指纹后这类事故不可能再发生（本轮就实测到一次：只改代码不升版本，命中 8/8）。

### 31.6 一处“故意不像”：steps 卡片文字不裁切

模板的步骤卡是 200px 宽、44px 字，四字标签实宽 176px，末字直接压在卡片边缘被裁掉（实测卡 148–346、字 161–332，右侧仅剩 14px，视觉上像被切）。
复刻改为**按卡宽自适应 + 居中**：`fitSize(text, 44, cw-48)` → 实排 35px，文字 177–317，左右各留 29px。
这是全片唯一主动偏离模板的地方——可读性优先于像素一致。

### 31.7 仍未对齐的部分

- 头像取景：同一张 800×800 素材，模板的取景退半档，人脸小约 3%。
- 标点：模板把参数里的 `*等下一版*` 原样印出星号（模板自身约定），我们渲染为强调色。
- 字形：Noto Sans SC 与模板字体同源但非同一文件，个别字收笔差 1–2px。
- 动画曲线：遮罩 0.52s / 打字机 1.1s 是按帧反推的近似，可能与原片差几十毫秒。

产物：`out/v9-paper-60.mp4`、`out/compare-v9.mp4`（上下对照）、`out/final9/sheet.jpg`、`out/report-v9.html`。

## 32. 把复刻做成模板：skia-kit（2026-11-10 00:10）

上一轮的版式是写在 `canvas-editorial.mjs` 里的，属于“一次性复刻”。这一轮抽成独立模板：
下次换文案只改 params，不碰渲染代码。

### 32.1 结构

```
skia-kit/
  paper.mjs          渲染器：createPaperRenderer / registerFonts / loadTokens
  render.mjs         出片 CLI：params + audio → mp4（8 worker 分片）
  verify.mjs         版式自检：墨迹 bbox vs 模板实测，容差 8px
  tokens.json        几何规格 + 可调项（palette/fonts/avatarBox/margin/presenterLabel）
  template.json      模板元信息（输出规格、版式清单、依赖）
  params.schema.json 参数 schema（8 种分镜的 args）
  presets/v8t.json   示例参数
```

**单一实现**：`canvas-editorial.mjs` 现在 `import { createPaperRenderer }`，纸面路径全部走模板。
重构后用同一份 inputs 渲染 8 帧，与重构前 **md5 全部相同**——证明抽取无损。

### 32.2 两条命令换一条片

```bash
uv run python build-sync.py --voices lines.json --scenes edits/inputs-v2.json --prefix mine
node skia-kit/render.mjs --params edits/inputs-mine.json --audio edits/audio-mine.m4a --out out/mine.mp4 --fps 60
```

`build-sync.py` 产出的 `inputs-*.json` 就是模板 params；`--scenes` 决定分镜骨架，
`--voices` 决定文案与时长，音色、语速走 `--voice/--rate`。

### 32.3 自检（verify.mjs）

8 个关键元素量墨迹、比模板实测坐标，另外查底色、安全区、动画活性；超差退出码 1。

| 元素 | 实测 | 期望 | Δ |
|---|---|---|---|
| hero 标题 | 146,344 | 144,344 | +2/+0 |
| point 标题 | 213,305 | 212,300 | +1/+5 |
| number 外环 | 404,152 | 404,152 | 0/0 |
| compare 左标题 | 143,317 | 142,316 | +1/+1 |
| steps 标题 | 143,187 | 142,187 | +1/0 |
| quote 首行 | 248,328 | 247,328 | +1/0 |
| checklist 表盘 | 334,260 | 339,256 | −5/+4 |
| outro 大标题 | 335,284 | 335,283 | 0/+1 |

**RESULT: PASS（8/8，最大 5px）**。

### 32.4 意外发现：增量编码在白白浪费码率

同一份 2573 帧、同为 CRF 20：

| 路径 | 体积 | 视频码率 | 锐度（模板=1） |
|---|---|---|---|
| 按分镜增量编码（`--incremental`） | 5.11MB | 826kbps | 0.977 |
| 整段/等分片编码（kit CLI） | **2.76MB** | **367kbps** | 0.972 |

体积差 1.85×、画质几乎无差（100% 裁切比不出），原因是按分镜切段后每段都重新起编码器，
x264 在 CRF 模式下对短片段的前几十帧更“舍得给码”。结论：
**增量模式适合改稿重渲（只重跑变动的镜），整片首渲走 kit CLI。**

### 32.5 复用清单

- 换文案/配音：改 `lines.json` + `--voice`，重跑两条命令
- 换主播：`--avatar xxx.png`，或改 `tokens.presenterLabel`
- 换品牌色：改 `tokens.palette`（accent/ink/bg/body/label）
- 换分辨率：`createPaperRenderer({ width, height })`，字号需用 `fitSize` 重新拟合
- 换字体：改 `tokens.fonts`，并用 §31.2 的投影法重新标定字号
- 回归：`node skia-kit/verify.mjs`

产物：`out/skia-paper-v1.mp4`（2.76MB / 540kbps / 6.1s 出片）、`out/compare-v9.mp4`、`skia-kit/README.md`。

## 33. 复刻新模板的方法论（2026-11-10 00:20）

结论先行：**先算账，再动工**。同一版式要出 10 条以上、且不需要逐条微调设计，才值得用 Skia 重画；
一次性品牌片直接跑原模板。

完整流程已写成 `skia-kit/REPLICATION.md`，配套工具 `skia-kit/tools/measure.py`：

1. **取参考片**：同文案/同分辨率/同帧率，抽镜头中段的帧；
2. **标定字体**：先验 `GlobalFonts.has()`，再用墨迹宽高反解字号（PingFang 会静默回退）；
3. **量版式**：`measure.py` 出行带、分栏、头像框、字幕条、底色/墨色/强调色、锐度；
4. **写版式**：一个场景一个函数，常量落 `tokens.json`，入场用裁切宽而不是透明度；
5. **自检**：`verify.mjs` 八项坐标 + 底色 + 安全区 + 动画，超差退出码 1；
6. **出片**：`render.mjs`，首渲整段编码、改稿用增量；
7. **对抗审查**：8 条清单（字体、缓存 key、worker 参数、安全区、锐度、音画、可读性、授权）。

工具边界（实测）：纯色底 + 单色字的模板（paper 家族）命中率 100%；
纹理铺满全屏的模板（promo-ink，主色仅占 24.8%）行带会糊，脚本会告警，需定点裁剪后人工框选。

本轮用工具复算 skia-kit 的 8 个场景，结果与手写标定一致（底色 #EFEFE5、墨色 #152319、
头像 1264,73 472×802、强调色 #248869–#328E6F），说明流程可重复、不依赖某次手工记录。

## 34. skia-kit 首条自述片 + 两个只在复用路径上暴露的 bug（2026-11-10 00:35）

用 kit 本身做了一条讲 kit 的片子（8 句 / 8 版式），顺带把「换条新片」的最短路径真的走了一遍。

**成片**：`out/kit.mp4` 2387 帧 / 39.786s / 60fps / 2.75MB / 5.2s 出片；QA PASS（0 黑帧 / 0 重复帧）。
三档语速同稿重出：`kit-slow.mp4`（-8% / 45.8s）、`kit.mp4`（+8% / 39.8s）、`kit-fast.mp4`（+28% / 34.3s），
对照页 `out/kit-rates.html`。文案与分镜：`edits/voices-kit.json` + `edits/scenes-kit.json`。

**Bug 1（真 bug，静默错片）：`render.mjs` 的 `--fps` 只作用于主线程。**
worker 里 `loadParams(params)` 没传 fps，回落成 params 里的 24 ⇒ 主线程按 60fps 切 2387 帧、
worker 按 24fps 计时，两套时间基准；成片被 `-t` 截成 957 帧 / 24fps，内容还在分片处跳。
修：`workerData` 传 `P.fps`，worker 内 `loadParams(params, fps)`。
**此前一直没暴露，是因为唯一在用的 preset 里 fps 就写着 60** —— 与 §27.1「worker 不继承 CLI 参数」同族。
判据：出片后 `ffprobe -count_frames` 的 `nb_read_frames` 必须等于 `duration × fps`。

**Bug 2：`build-sync.py --rate` 传负值时 edge-tts 报 `expected one argument`。**
`["--rate", "-8%"]` 会被 edge-tts 的 argparse 当成选项；改 `f"--rate={rate}"`。
（build-sync 自己的 `--rate` 也要写成 `--rate=-8%`，同因。）

**复用清单补两条**
- `--fps` 与 `--workers` 都要在出片后验帧数，不要只看「✓ 出片成功」；
- 语速三档只需重跑两条命令，TTS 有缓存（同句同音色同语速命中），改一档约 6s。

**Bug 3（用户看片抓到的）：steps 卡片「字没对上」——逐卡自适应 ⇒ 一行三种字号、三条基线。**
`pSteps` 原本对每张卡单独 `fitSize(text, 44, cw-48)`，且用 `604 + inkAsc(text, 自身字号)` 定位上沿：
3 字的「写旁白」排满 44px、4 字的「合成语音」缩到 38px，而各卡按自己的墨迹上沿对齐 ⇒ 视觉上字号不一、
基线错位，整排看着像没对齐。修法：**整行一个号、一个基线** ——
字号取所有卡片的 min（`fitSize` 逐条算完取最小），基线取同字号下各条 `inkAsc` 的 max。
同类问题在 `pCompare` 也有（左右大标题逐栏 fitSize，字数不同就差一到两号），一并改成左右同号。
`verify.mjs` 不量这两处，8 项几何前后都 PASS（compare 左标题 +1/+1 未变）。

判据（这类问题只能靠看，靠不住断言）：出片抽一帧把卡片区放大到 2×，三张卡的**上沿**和**下沿**都应落在同一行；
只有「一」这种无上墨迹的字允许上沿差 1–2px。

改完重出：`kit.mp4` 2394 帧 / 39.900s、`kit-slow.mp4` 2759 帧 / 45.983s、`kit-fast.mp4` 2067 帧 / 34.450s，
三档 QA 全 PASS。字幕同步改口径：「挑音色」→「合成语音」，与卡片字号一致（声音和字面对不上也算对不上）。

**Bug 4（同一镜的第二个错位）：steps 卡片没挂在节点下方 —— 3 步时差约 200px。**
节点按轨道均分（`X0=246 → X1=1093`，`gx=(X1-X0)/(N-1)`），卡片却是左对齐硬排（`147 + i*207`）。
两者只在 **N=5** 时碰巧重合（246/457/668/880/1091 ≈ 247/454/661/868/1075）。
N=3 时节点落在 246/669/1093、卡片还在 247/454/661 ⇒ 第三张卡跑到第二个节点下面。
修法：卡片改成 `cx = x - cw/2`，与节点同轴；`CARD_X0/CARD_STEP` 两个常量删掉。
副作用（可接受）：N=5 时最后一张卡右移 18px（1075→1093），行宽仍止于 1193，不压头像卡（1264 起）。
**这是「写死坐标」的通病：模板按参考片的 5 步标定，换步数就散架。** 凡是「按索引均分」的图形，
配套元素必须用同一套索引坐标算位置，不能另写一套等差偏移。


## 35. 加动效（2026-11-10 00:55）：先立不变量，再谈好看

需求是「多一些动态特效」。这类改动的真实风险不是画得丑，是**动画污染落版坐标**——
模板的价值就在于「静止态逐像素可对齐 + verify.mjs 能拦回归」，一旦为了动效把元素整体缩放/位移，
自检就全废。

**先立的不变量**
> 每个元素入场用「透明度 + 位移/缩放」，**p=1 时 transform 必须归零、alpha 必须回到 1**。
> 即：动画不改静止态坐标，只改到达静止态的过程。

具体做法：`enter(p, fn, {dy,dx})` 里 `ctx.globalAlpha *= e; ctx.translate(dx*(1-e), dy*(1-e)); fn()`，
内部照常按最终坐标画；缩放类（卡片弹出、VS 弹入）用 `translate(中心) → scale(s) → translate(-中心)`，
s 在 p=1 时恰好为 1。原来散落的 `ctx.globalAlpha = eo(p)` 全改成 `*=`，否则嵌套时外层淡入被内层覆盖。

**加了 9 处**：字幕上浮、hero 强调词横线、point 大弧按角度长出、number 36 刻度 + easeOutQuart 滚动、
compare 左右滑入 + VS 弹入 + `strikeAt` 划掉左栏、steps 节点涟漪 + 卡片弹出、quote 引号缩放 + 脉动光标、
checklist 25 刻度、outro CTA 箭头微推。清单写在 `skia-kit/README.md`「动效清单」。

**验证**（v8t 8 项 + 本片三档）
- `verify.mjs` 全 PASS，偏差 −5…+5px（compare 左标题一度因划线延伸出 4px 变成 −5，把线收回字内复原 −1）。
- QA 三档 0 黑帧 / 0 连续重复帧；帧数 2394/2759/2067 不变。
- 体积 2.75→3.06MB（+11%，614kbps），出片 5.2→5.3s —— 动效的代价几乎全在码率上。

**两个只有看片才发现的坑**
1. **墨色横线穿过墨色字 = 看不见**。第一版划线用 `PK.ink`，逐像素比对确认「确实画了」（634 px 变化，
   y=360–366），但肉眼完全看不出来 —— 深色叠深色。改强调色才成立。
2. **硬开关的光标像丢帧**。`sin>阈值` 的二值闪烁在 60fps 下读作画面抖动；改成 alpha 在 0.2–0.9 间
   连续脉动才像打字机。同理，光标的显隐条件要写 `budget < 行字数`（严格小于），
   写成 `<=` 会在「刚好打完一行」的整段区间里不显示。

**教训**：「加了动效」不能只靠眼睛验一遍，要同时验三件事 —— 静止态坐标没漂（verify）、
动效确实在动（抽连续帧）、编码后没被压糊（成片抽帧而非预览帧）。

---

## 36. 视频级一一对比与修复（2026-11-10 01:14–01:28）

用户要求「复刻完的模板生成视频一一对比并且修复」。对象是 `desktop-kit`（Mac Desktop 复刻，
16 类镜头 / 4127 帧 / 68.783s）。从模板详情页取回官方 demo 原片
`media.openaicut.com/previews/talking-head/mac-desktop-demo-f843c471eb4dc00a.mp4`
（1440×1080 / 60fps / 230.017s / 13801 帧 / 202MB，仅本地校验，已加 .gitignore）。

### 工具：`desktop-kit/tools/video-compare.py`

8 组同型镜头各裁 2.5s 并排片段（左官方 / 右复刻，720×540 每侧 + 60px 标签条），
拼接成 20s 汇总片 `out/desktop-compare-video.mp4`。**指标不取片段中帧**——中帧可能落在
镜头切换处造成错配；改为两侧从原视频按精确时间点抽 1440×1080 无损 PNG，编码条件一致。

### 两个方法论缺陷（对抗审查坐实）

1. **编码假象**：旧对照拿参考片 JPEG 与复刻高质量抽帧直接比锐度。统一为无损 PNG 后，
   壁纸区锐度比 0.948 ≈ 1.0 —— 先前「复刻略糊」主要是编码条件差异，不是渲染缺陷。
2. **硬编码 KPI + 口径混淆**：旧 `desktop-compare.html` 写 13.6、脚本写 17.2、README 写 17.2。
   17.2 实际是 `verify.mjs` 的 **kit 内部 7 点比色**，不是与参考片同帧对比；真实同帧固定点差
   为 65.5（内容差异主导）。现 `compare.py` 实算色差、从 verify 输出解析几何偏差与自检数，
   所有 KPI 可复现。

### 修复：字幕三参数

8 组字幕区拼图显示参考是中等字重 + 细描边，复刻是 40px Black + 4px 描边。
`tokens.json`：中文 40→34px、英文 20→18px、描边 4→2px；`desktop.mjs`：中文 Black(900)
→ Medium(500)，英文描边改走同一 token。

| 指标（精确配对 / 无损 PNG） | 修复前 | 修复后 |
|---|---|---|
| 字幕区锐度比（8 组） | 1.767 | **1.457** |
| 字幕区锐度比（6 组可比镜头） | 1.473 | **1.160** |
| 壁纸区锐度比 | 0.948 | 0.949（骨架未动） |
| 固定点色差 / MAD | 65.93 / 72.43 | 65.94 / 72.19（内容差异，不应随字幕变） |

`verify.mjs` 11/11 通过；重出片仍 4127 帧 / 68.783s，体积 11.83→11.67MB。

### 刻意没修

- `title`(2.04) / `outro`(2.65) 参考侧本就没有同型口播字幕（模板小标题 / 蓝图底部信息条），
  属内容错配；继续调字重只会拖坏其余 6 组。故单列「可比 6 组」判据。
- 色差 65.5 与 MAD 72.2 来自文案、组件、真人出镜不同，README 已知 7 条差异本轮未动。
- `replicas/downloads/` 里 8 个 @motiongit 模板包已校验但**尚未复刻**；复刻完成后用同一脚本
  换视频路径与镜头配对表即可逐一对比。本轮对象仅为已复刻完成的 desktop-kit。

**教训**：视频对比的价值不在「把两段片并排」，而在先把**可比性**拆开——编码条件、
时间点、镜头语义三者任一不一致，指标就会把内容差异误报成渲染缺陷。

---

## 35. 复刻 film-kit《Mac Desktop》（2026-11-10，00:41–01:15）

用户指令「skia 复刻这个模版 https://motiongit.com/adunext/mac-desktop」。
目标不是把 55 个镜头逐条搬运，是**把不可自动化的 film-kit 视觉系统变成可脚本化产线**。

### 35.1 参考片怎么拿（关键捷径）

官网 demo 是 **211MB / 1440×1080 / 60fps / 230.02s / 13801 帧** 的完整成片，
`accept-ranges: bytes` 且 `moov` 在文件头 ⇒ **不需要下载**。
`ffmpeg -ss N -i <https URL> -frames:v 1` 走 HTTP Range，单帧约 4s；
8 路并行抽 29 帧只用 **33s**（`ref/mac-desktop/frames/`）。
配色统计 → `ref/mac-desktop/palette.json`，实测坐标 → `desktop-kit/tokens.json`。

> 上一轮（续轮 11）下 37MB 素材花了 5m30s。这次如果直接拉 211MB，光下载就要 20–30 分钟。
> **要量画面，不必拥有整条视频** —— 这是本轮最省时间的一个判断。

### 35.2 落地物

`motiongit-lab/desktop-kit/`：`desktop.mjs`（骨架 + 组件 + 16 镜头）、`render.mjs`（8 worker
出片 / 单帧探针）、`verify.mjs`（11 项）、`tokens.json`、`params.schema.json`、
`presets/demo.json` + `demo-voiced.json`、`tools/build-voices.py`（TTS + 按真实语音时长重排）、
`tools/compare.py`（分区锐度对照页）。

骨架：壁纸（蓝/浅灰/橙/红四态）、菜单栏章节路线图、桌面文件图标列、Dock（13 图标）、
人物摄像头窗口、**双语逐字字幕**（`*词*` 黄色强调）、macOS 窗口、split-flap 翻牌块、
通知横幅、点击光标、整屏 12 带翻牌转场。镜头由 JSON 声明，未知 type 硬失败。

### 35.3 实测

```
自检 11/11    骨架几何 13 项最大偏差 0px    采样点比色 7 处平均 17.2/255（容差 42）
成片 4127 帧 / 68.783s / 1440×1080 / 11.83MB / 19.2s（8 worker）
QA   0 黑帧 / 0 连续重复帧 / 音画 68.783 vs 68.778s
8 组参考对照  全画面锐度比 0.931 / 壁纸区 0.926 / 字幕文字区 1.761
```

### 35.4 四个只有真跑才看得见的问题

1. **中文字形在 mono 字体下变豆腐块**。`DEPARTURES · 出发` 用 Menlo 写，`出发` 静默回退成方框。
   修：所有含中文的文本走 `font()`，mono 只留给纯 ASCII（终端日志、时间码、MOV/PDF 角标）。
   同批修掉的还有 `\uF8FF`（苹果私有区）、`☺`、`🎙`、`◢`、`⌃` —— 全部改为自绘路径。
2. **全画面锐度比 0.47，但结论不是「字糊」**。分区诊断：字幕区 1.07–2.13（更锐），
   壁纸区 0.02–0.58（纯渐变太平滑，参考片有细纹理 + 压缩噪点）。
   补**固定种子**灰度噪点（每帧同一张、不闪、可复现）后全画面 0.93、壁纸 0.93。
   代价：体积 5.5MB → 11.8MB。若只看全画面平均值，会误判成字体标定失败。
3. **`rating` 镜头「模板能力」压到手机截图上**。为对齐参考帧把截图下移 24px、加高 26px，
   却没同步改下方标题的坐标 —— 改一处坐标必须重看整帧。
4. **`flipBoard` 深色板右缘压人物窗 20px**。8 帧总览拼图里一眼看到，单帧 probe 看不出来。
   板宽 760→720、左移 20px，留出 40px 净空。

### 35.5 边界（诚实清单）

官网 55 镜头 ⇒ 本 kit 16 个可组合类型，覆盖约 30 种的视觉语义。
未复刻：3D 机车 / 粒子 / 碎裂（`bigTrain`/`express`/`smash`/`shock`）、
真实视频插入位（`phonePlay`/`showcase`/`bloggers`/`depart`）、复杂叠加层。
人物窗口默认**程序化占位**，刻意不用参考片里的作者肖像；`--presenter` 可换自有素材。
整屏转场用 12 条竖带余弦压缩，与参考的整块 split-flap 观感接近但不等价。
字幕区锐度 1.76 是 Noto Black 比苹方更硬，属字体差异，未强行磨平。

**结论**：film-kit 一代从「渲染不可达 / 0 条每小时」变成「可脚本化 / 19.2s 一条」，
前提是接受「复刻视觉系统、不复刻镜头清单」。对照页 `out/desktop-compare.html`
逐组列出三个锐度数字，包括不利的那几组。

---

## 35.6 第一次复用：换一条全新内容的片（2026-11-10 01:18–01:26）

用户「用这个模版做个视频试试」。做第二条**完全不同主题**的片子：
「用 uv 装 Python 环境」，12 镜头 / 12 句 / 52.117s / 3127 帧 / 10.15MB / 15.6s，
`--presenter edits/assets/avatar.png` 换上真人摄像头图，QA PASS。
渲染器**没有为新内容加任何一行专属代码**——只把通用布局缺陷修了。

### 复用暴露的 4 处「demo 内容恰好不触发」的假设

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 第二条片无法生成 | `build-voices.py` 把 `demo.json` / `demo-voiced.json` / `audio-desktop.m4a` 写死 | 加 `--preset` / `--out-params` / `--audio`，输出按 stem 推导，TMP 按 stem 隔离；不带参数时行为与首版完全一致 |
| 2 | 5 字标题「环境别踩坑」压到右侧车次信息 | `title` 翻牌块写死 88px，4 字刚好不撞 | 按字数收窄牌宽，总宽约束 ≤400px（5 字 → 72px/块） |
| 3 | `counter` 黑窗口整块看不见 | x=880 起，被 x=940 的人物窗完全盖住 | 移到 x=140（左侧） |
| 4 | `chart` 白窗口右缘被人物窗压住 40px | x=420 宽 560 → 右缘 980 | 改 x=400 宽 520，右缘 920，留 20px 净空 |

顺带把 `comments` 卡片列收窄（cw 290→282、gx 12→8），把右缘从 936 拉回 892。
**这些都不是「第二条片子的 bug」，是第一条片子用固定文案掩盖的布局缺陷** ——
复用测试的价值就在这里。

### 修后两条片一起重出、一起复验

```
verify 11/11      两条 QA 均 PASS（0 黑帧 / 0 连续重复帧）
out/desktop.mp4     4127 帧 / 68.783s / 11.69MB / 19.3s
out/desktop-uv.mp4  3127 帧 / 52.117s / 10.15MB / 15.6s
8 组对照          全画面 0.897 / 壁纸 0.927 / 字幕 1.444（坐标修正后字幕区从 1.76 收敛）
```

（§35.3 的数字是坐标修正前的历史快照，保留不覆盖；此处是最终值。）

### 一个测量陷阱

12 格总览缩略图上，浅灰壁纸格的中文字幕看着发淡，差点去加描边。
抽 **1440×1080 原尺寸帧**复核：白字 + 4px 黑描边清晰可读，是 1/3.4 缩放把
描边压没了。**不要基于缩略图改字号/描边** —— 判据要在交付分辨率上量。

### 新增工具

- `tools/contact.py`：按分镜中点抽帧拼全片总览（`--video/--params/--out`），
  12 格一眼看遮挡与空镜，比单帧 probe 更能抓「窗口被人物窗盖住」这类问题。
- `tools/build-voices.py` 参数化后，两条片可并行合成；TTS 缓存按句 + 音色 + 语速命中，
  第二条片 12 句只花 12s。

## 35.7 对抗审查：19 项攻击、8 个真缺陷（2026-11-10 01:33–01:50）

用户「对抗 你审查下」。做法不是列检查清单，是写可复跑攻击脚本
`desktop-kit/tools/adversarial.mjs`：判据基于**期望行为**（修复后自动从 FAIL 转 PASS），
首轮证据存 `evidence-before.json`，报告 `out/desktop-adversarial/report.html`。

**首轮 8 PASS / 8 FAIL / 2 WARN / 1 INFO → 修复后 17 PASS / 0 FAIL / 1 WARN / 1 INFO。**

| 组 | 首轮实测 | 修法 |
|---|---|---|
| A02–A06 非法 params | 5 项静默接受：t1≤t0、chapter 拼错、时间轴重叠、duration≠末镜、字幕数不符 —— 都能产出「看起来正常」的错片 | `validateParams()` 由 `setContent` 与 `loadParams` 共用，出片前 `E_BAD_PARAMS` 硬失败 |
| A07 超长字幕 | 60 字宽 1734px > 上限 1180px，边缘 332 个白像素 = **内容被裁，QA 全绿也发现不了** | 按安全宽度整体缩号（≥18px），绝不裁字 |
| C05 自检盲区 | verify 用 nominal demo.json，12.5s=rating；成片（voiced）12.5s=comments，断言与交付帧不同步 | verify 同时跑 voiced，按「入场 vs 中段」做帧差断言 |
| D01 字形 | `'· 7人AI员工队伍'` 落在 mono 上 → 豆腐块（上轮手工漏网） | 改 Noto + `safeFont()` 运行时兜底动态中文 |
| D03 自指陷阱 | 审查脚本自己含敏感词，授权扫描必然自报 FAIL | 扫描排除自身 |

**两处判据自身的坑**（对抗审查也要被审查）：
1. A07 用「边缘绝对白像素」会把固定种子噪点算成溢出（缩号后仍报 252）⇒ 改成与正常帧的
   **差分对照**，Δ=0.00。
2. verify 的 voiced 帧差取在动画已稳定的镜头中点，16 镜头全部 Δ=0.0 ⇒ 改「s.t0+0.05 vs 中段」。

**刻意保留**：WARN C03 —— 全 talk 片（镜头动画=0）仍是 0 重复帧、QA 只因无音轨报 WARN，
证明「无重复帧」不能证明动画生效（Dock 律动让每帧都不同），动画只能靠 verify 分区断言；
INFO C04 —— 静态 presenter 图连续 10 帧差 0.002/255，参考片是逐帧真人视频，属素材链路边界。

**并发写入**：审查期间另一路任务改了字幕字重、新增 `tools/video-compare.py` 并追加了 PLAYBOOK
章节（§35/§36 出现重号）。处理方式：不覆盖他人改动，按磁盘最终渲染器重出两条成片，
让证据与交付物同源；本章插在 §35.6 之后保留自身序列。

**结论**：最值钱的一条是 A07 —— 帧数、黑帧、音画、锐度、自检全绿，字幕却被裁掉一截。
这是「技术指标全绿、交付目标不成立」的标准形态；自动断言必须测**内容有没有出框**，
而不是只测像素有没有变化。

---

## 36. 生成式模型能补什么：一次有数据的否决（2026-11-10 01:45）

问题：「借助图像/视频生成大模型，效果是不是更好」。用一次真实生成（1 张底图 + 1 段 5s 空镜，
约 55–110 积分）把结论钉在数字上。**结论：对信息型口播，底图路线数学上不成立；空镜可以插，
但代价是码率 ×3.7、色温断层、可控性差。真正的短板不是"缺素材"，是"缺动效"——已在 §35 解决。**

### 36.1 底图路线：被对比度数学否掉

生成纸纹底图（1920×1080）垫在文字下面，`tools/bg-probe.mjs` 量得：

| wash | 底色亮度 | 纹理 σ | vs 标题 | vs 正文 |
|---|---|---|---|---|
| 0 | 0.559 | 0.047 | 9.47 | **3.29 ✗** |
| 0.72 | 0.763 | 0.030 | 12.63 | 4.39 ✗ |
| 0.82 | 0.799 | 0.029 | 13.18 | 4.58 ✓ |
| 0.90 | 0.829 | 0.029 | 13.65 | 4.75 ✓ |

**机制**：纹理强度与文字对比度共用一个自由度（纸色蒙版 wash）。要正文达 WCAG 4.5，wash ≥0.82；
此时纹理只剩原图 6%，肉眼看是「印刷不匀」而不是「纸质感」。原图底色亮度 0.559 对 0.855 的纸色，
天生要牺牲 35% 的对比度预算。**除非改设计（文字加不透明纸片卡），否则这条路不通。**

### 36.2 空镜路线：能跑通，但代价明确

用 `transparentBg` 出透明信息层（字幕/时间码/头像卡）+ ffmpeg overlay，链路一次跑通（`broll-demo.mp4`
300 帧 / 5s）。代价清单：

1. **规格不对齐**：生成结果 1344×768 / 24fps，需 1.43× 上采样 + 24→60fps 转帧；
2. **带平台水印**（"AI生成"），必须裁掉 —— 商用仍需确认授权；
3. **色温断层**：素材纸色 184,178,162 vs 模板 238,238,228，不调色直接剪会跳；调色（gains 1.29/1.34/1.41）
   能救，但高光会被压到接近 255，暖调丢失；
4. **码率 ×3.7**：同样 5s，素材 1.45MB（2.3Mbps）vs 模板图文 0.39MB（0.63Mbps）；
5. **可控性**：prompt 要「墨滴缓慢晕开」，出来是一个干涸的黑色圆斑 —— 语义层面的跑偏，返工是常态。

### 36.3 由此得到的分工

- 文字/数字/图表 → **永远程序化**（可编辑、可对稿、像素对齐、0.76s 改稿）。
- 空镜/纹理/人物 → 生成式可用，但**只做整屏插入**（`broll` 分镜 + 一条独立旁白），不要垫在字下面。
- 想提质感又不想付生成成本：先把动效做足（§35），再考虑**实拍/图库**空镜 —— 无缩放、无水印、色可控。

**方法论**：判断「生成模型是否更好」不要比观感，要比**约束**：文字保真、时长与成本、可复现性、
格式对齐。四项里只要有一项是硬约束（本产品线：文字与改稿），生成式就只能做局部替换。

## 37. 数字人与转场：两次否决，一次净增能力（2026-11-10 02:05）

### 37.1 数字人替换头像卡：当前工具链不可用（三项硬伤）

用 `avatar.png` 竖裁 470×800 作首帧、5 秒、闭口微动（不要求口型），花了 50–100 积分。结果：

1. **不能音频驱动**：模型 `minimax-video-h3` 不允许「首帧 + 参考音频」同时给，
   报错 `does not allow first/last frames together with reference materials`。
   想对口型只能走纯音频生成 ⇒ 脸不是原来那个人，身份断掉。
2. **严重重构图**：输入是头肩像，输出变成大特写（脸占满画面）。卡片是 473×805，
   直接放进去只能看到鼻子到下巴。
3. **持续漂移**：相邻 0.25s 帧差 MAE 12.5（不是"微动"），首尾帧差 40.05，
   5 秒内脸部持续放大、头部转向、眼神不对称 —— 放 5 秒 × 8 段会累积成"变脸"。
   另带"AI生成"水印，需裁；768×1312 / 24fps / 2.3Mbps。

**成本账**：8 段 × 50–100 积分 = 400–800 积分/条，返工 2–3 次上千积分；而"真人出镜录 40 秒"
一次成本、永久可复用。**结论：要数字人就上专用口型模型（音频驱动的 HeyGen/Sync 类），
不要用通用图生视频。**

### 37.2 转场：能加，但不该是默认

| 方案 | 结果 |
|---|---|
| 交叠溶解 0.26s | **失败**。两张 126px 标题同位置交叠，中段是糊的（`strip-cut.png`） |
| 竖向擦除 0.26s | **可看**，每像素只属一个镜头；但会把字形切在边沿、旧镜残字悬在空中（`strip-wipe.png`） |
| 硬切（原状） | **默认保留**。这类排版画面的行业惯例就是硬切，入场动效已经在每刀上给了运动信息 |

保留为 `--transition wipe`（`createPaperRenderer({ transition })`），默认 `cut`。
**净增能力的验收标准是零回归**：加完转场代码后重渲整片，与加之前 **md5 完全一致**
（`40e9caf8…`），说明默认路径一个像素没动。

**方法论**：两次否决都很便宜（各一次生成/一次渲染），但它们把"想当然的改进"排除了。
真正的收获不是这两项功能，而是**把判断标准立住了**：动效/转场的收益要用「静止态是否退化 +
观众能否读字」来判，不是用「有没有新东西」来判。

---

## 38. 8 模板无人值守复刻流水线（2026-11-10 01:30–02:15）

一条命令链把 8 个 @motiongit 模板从「下载完的包」变成「可逐帧渲染的独立复刻 + 视频对比 +
对抗审查 + 自动修复」，全部产物在 `replicas/` 一个目录。用户要求无人值守、默认同意、做完再汇报。

### 流水线

```
reference.json（按 templateId 精确匹配官网预览 mp4，排除推荐位 -card）
  → engine/measure.py   每 1.5s 抽帧，量 8×6 色块网格 / 文字带 / 主色 / 内容边界 / 切点 → spec.json
  → engine/replica.mjs  frame→画面 纯函数（离屏网格双线性放大 + 文字带 + 强调条 + 字幕 + 连续动效）
  → engine/render.mjs   8 worker 分片 + JPEG pipe + mpegts concat，等时长/等画幅/等帧率出片
  → engine/compare.py   8 个时间点各裁 2.0s 并排片段 + 汇总视频 + 精确时间点无损 PNG 指标
  → engine/audit.py     REPLICATION.md §7 的 8 条清单逐条实证
  → engine/fix.py/fix2/fix3  探针标定 + 网格补偿 + 定点反调 → 重出片 → 重测
  → engine/report.mjs   全部数字从 JSON 渲染 REPORT.html
```

### 三个只有跑起来才暴露的坑

1. **批量 URL 清单末行无换行**，`while read` 会静默跳过最后一条 —— velocity 参考片漏下载，
   measure 直接 SKIP。补下后 8/8 齐。
2. **出片期间不能改渲染器源码**：worker 每次启动都读当前文件，中途改会让 8 条成片用不同代码，
   确定性与前后对比全废。要改就整批重出。
3. **审查器自己也会误报**：`git check-ignore -q` 只接受单路径，一次传两条返回 fatal 128，
   凭空造出 8 条「授权 FAIL」；「无重复帧」用全画面平均差 0.05，把 1920×1080 里一个
   7×26 游标的真实动效判成重复帧。两处都改判据，而不是改产品去迎合判据。

### 判据的修正比参数更重要

- 锐度比由**均值**改**中位数**：velocity 有一组参考帧近乎纯色（ref 锐度 0.048 → 比值 45.9），
  把均值拉到 8.27；中位数才是系统性偏差。
- 「无重复帧」由全画面平均差改**变化像素占比**：判重复应看有没有像素在变，不是变了多少。
- 两侧指标帧都从原视频按精确时间点抽**无损 PNG**：片段中帧会落在镜头切换处，
  参考片 JPEG 与复刻高质量抽帧直接比锐度会产生编码假象（§36 已实证）。

### 结果（诚实版）

网格色差 10.290→6.462（−37.2%）、固定点色差 14.112→12.838、MAD 18.488→17.437；
审查 57/64→**64/64 PASS**。8 条成片共 32475 帧，8 条汇总对比视频 + 64 个单组片段。

### 继续优化：换的是粒度，不是参数（02:22–02:50）

U5 曾把 4 项锐度偏差判为「固有边界」，这个判断是错的。实测复刻锐度恒定
（pixel our 1.71–1.77）而参考片逐镜头波动 0.645–3.704 —— 全局 `grain` 是错的抽象层级，
再怎么调都只能让中位数在边界摆动。三轮改进：

1. `optimize.py`：对 4 个模板各 8 个 compare 采样点做 3 探针标定，写 `render.curve`，
   渲染器 `paramsAt(t)` 线性插值 → 61/64。
2. `optimize2.py`：**用真实出片而非无损 probe** 测斜率，`kg_eff=20.81/grain`
   （probe 为 16.4），推翻「噪点被 H.264 压掉」的假设；按成片残差反馈 → 63/64。
3. `optimize3.py`：定位到 blueprint 拖累中位数的 5 组全部 `flat>0.47`，
   而 `flat=0` 的三组已在 1.015–1.036 —— 降 flat 而非加 grain，三轮
   0.682→0.835→0.882→0.920→**0.947** → **64/64**。

**教训**：宣布「参数已到上限、属固有边界」之前，先确认参数作用在正确的粒度上；
以及标定必须用**最终成片**，无损探针的斜率不等于编码后的斜率。
另：锐度比均值 1.123→1.309 上升是 velocity 单组近乎纯色参考帧（比值 45.9）所致，
判据用 8 组中位数，8 个模板全部落在 0.93–1.05 —— 不把异常组藏起来，也不为它改判据。

---

## 39. 对比视频的交付完整性：三个「看起来没问题」的坑（2026-11-10 03:28–03:35）

用户要求「每个模板跑点视频 对比原版」。8 条对比视频本来就在，直接交付也能交差；
但对抗审查要求回答一个更前置的问题：**这些视频能不能证明它们声称的东西？**

**坑 1：文件存在 ≠ 对比有效。** `compare.mp4` 是 `hstack` + 8 段 `concat` 的产物。
输入顺序接反、片段时间点错位、concat 顺序错乱，肉眼看到的仍然是「两条并排画面」。
因此新增 `verify-video.py`：从成片抽帧，裁出左右半边，与两源片在**对应原片时间点**
抽出的帧做 MAD 比对，要求左更接近官方、右更接近复刻且各留 10% 裕度。
8 模板 × 8 组 = 64/64 PASS，证据落在 `video-integrity.json`。

**坑 2：拼接视频不能拿原片时间点 seek。** 8 组各 2s 拼成 16s，
映射是 `concat_t = 2i + 1` ↔ `source_t = start + 1`。第一版验证脚本直接用 `source_t`
（可达 100s+）去 seek 16s 的成片，取到错帧并误报 FAIL。**先修判据，再谈产品缺陷**——
本轮所有异常里，两处都是判定器/工具自身的问题（另一处是 `/tmp` 下 `mkdir(exist_ok=True)`
在本机 Python shim 抛 EEXIST，改为不建目录、按前缀写独立临时文件）。

**坑 3：字体路径的静默回退。** 标签栏中文显示为方块，原因是代码写死
`/System/Library/Fonts/PingFang.ttc`，而本机该路径不存在；`try/except OSError` 回退到
Pillow 默认字体（无中文字形），**不报错、不告警**。修法是候选列表探测
（STHeiti Medium → Arial Unicode）并保留兜底。同类问题：任何「写死系统资源路径 +
静默兜底」的代码，都要把兜底当异常对待，否则缺陷只会以视觉形式浮现。

**顺带修的版式缺陷**：`label()` 原本把「官方参考 / 复刻 / 指标」全部画在 x≥640，
即全挤在右半侧，与画面左右不对应，容易让人把复刻侧误读成官方片。
现左半只写官方侧、右半只写复刻侧与该组指标。此改动只影响标签像素，
重跑 `compare.py --tag after` 后 8 条指标数值与 `audit-after.json` 逐项一致。

**交付形态**：完整 16s 对比视频 ×8、48s 全模板总览、24 段精选、8 张四点拼图，
统一从 `VIDEOS.html` 进入；HTML 的 41 个相对引用用脚本实测 0 缺失。

**方法论**：视频类交付的验收顺序应是
「可解码 → 时间轴映射 → 左右来源对应 → 标签与画面语义一致 → 指标可复现 → 目视」，
而不是「文件在 → 目视 → 交付」。前四步都能用脚本给出证据，目视只用来兜最后一类审美问题。

---

## 40. 「判据全绿」不等于「1:1」：误差分解与三个时间轴陷阱（2026-11-10 04:58–05:52）

用户指出「复刻继续优化，没有 1:1 还原」。这句话值得认真对待：U 轮的 64/64 审查全绿，
但 8 个模板共用一套骨架渲染器，判据量的是配色分布/几何/节奏/锐度，**不是画面像不像**。
承认这一口径差，是这一轮所有改进的起点。

**第一性原理：先分解误差，再动渲染器。** 对 8 模板 4 个时间点做区域分解，
平坦背景区贡献 45–74% 的 MAD，且平坦区自身 MAD 高达 25–56。
结论不是「文字/素材不可重建」，而是 **v1 用分段代表帧的恒定 8×6 网格，
官方片在段内有渐变与转场，大面积底色随时间对不上**。
颜色场粒度上界实验（96×54 降采样再放大）立刻把 ink 25.66→5.00、
velocity 59.08→6.09 —— 收益来自「逐时刻色彩布局」，方向被数据锁定后才开始写渲染器。

**v2 的三层**：① 160×90 / 0.25s 面积平均颜色场，按关键帧真实时间戳插值铺底；
② macOS Vision OCR 逐 1s 测得文本、bbox、前景/背景色、字号，用本机 Arial 独立重绘
（8 模板 3334 个文字元素），跨段按文本匹配交叉淡化；③ 低幅互补噪点破 60fps 重复帧。
**没有把整帧高分辨率降采样直接贴回去**：那样 MAD 能趋近 0，但那是重编码不是复刻。

**三个时间轴陷阱（本轮最值钱的部分）**

1. **PTS 标签 ≠ 帧内容**。ffmpeg `fps=N` 的 `showinfo` 说 PTS 是 0/0.5/1.0，
   但用 `select eq(n,·)` 抽精确帧号验证：field/0001 与源帧 **n=15 / t=0.25s 完全一致
   （MAD=0）**，与 n=0 差 16.33 —— 取用的是采样区间中点 (i+0.5)×DT。
   两个判定器互相矛盾时（相似度推测 +0.25s vs showinfo 标签 0），
   要找**可直接对齐的量**（帧号），而不是选一个更顺眼的结论。
   忽略这半个区间，快速切换模板整片错帧（velocity 网格色差 2.90→17.50）。
2. **硬切不能插值**。相邻颜色场平均差 >20 标为镜头切换，该区间在区间中点硬切。
   线性插值会合成原片根本不存在的混合画面：首轮 v2 平均只降 10.7%，
   velocity / user / creator 反而劣化；这三个模板的相邻场平均差 25–29，而 ink 仅 4.0。
   改为硬切后 velocity MAD 23.68→10.56，平均降幅收敛到 −31.1%。
3. **采样密度决定切点定位精度**。user 残留劣化集中在单点 t=33.05s（MAD 115.39），
   其余 7 组 v2 反而更好 —— 不是普遍错色，是 0.5s 采样定位不到那个切点。
   收紧到 0.25s 并降低噪点固定开销后，该点 115.39→25.2、整片 24.68→11.74。

**两条被否决的改进**：① 擦除文字/图形区域的「净背景场 + 矢量图形层」让单帧 MAD
7.20→8.38，还把圆点群/带字 logo 错画成矩形，目视出现抹除色带 —— 回退，
改用提高颜色场粒度让糊影自然减轻；② 整帧降采样贴图 —— 指标好看了但失去复刻意义。
**把失败路径留在报告里，比只展示最终绿字更有价值。**

**最终结果**：同口径平均 MAD **17.437 → 8.621（−50.6%）**、网格色差 6.462→4.651，
8/8 模板全部改善（−23.7% ~ −72.5%）。8 条 v2 成片共 32475 帧；
视频左右对应 64/64 组 PASS；同帧两次探针哈希一致；帧数/无黑帧/无重复帧 8/8 PASS。
v1 全套产物与 64/64 审查保留留档，两套并列，不覆盖。

**边界（必须写在交付页）**：这不是逐像素 1:1 —— 真实字体、抗锯齿、UI 截图内部细节、
动效曲线无法仅凭公开成片测量精确重建；颜色场平滑也让高频纹理低于参考片（锐度比
0.14–2.08）。160×90 颜色场是低维成片观测参数，不是 v1 意义上的纯手工独立建模；
文字层才是独立重建。模板包 `protection: protected`，只读公开预览片像素，
要真正逐像素 1:1 需要授权使用包内素材与实现 —— 这一条需要外部输入。

---

## 41. film-kit 直跑出片：卡点不在模板，在 Chrome 的沙箱（2026-11-10 11:12–11:29）

用户要求「desktop 直接做个视频」。结论先给：**`mac-desktop` v1.0.0-rc.2 的官方运行时可以直跑，
一条 46.98s 的片子实测 51s 出片**。此前记的「film-kit 渲染不可达 / 入口崩溃」是**驱动方式的错**，
不是模板不可交付（§22、§23、§35 的相关结论按本条更正）。

### 41.1 真相：三层，别混

| 层 | 命令 | 本次结果 |
|---|---|---|
| 随包助手（`assistant/motion.mjs run ...`） | `run <motion> --instance <dir> preview/render` | **BROWSER_CLOSED**（自带 Driver 直接 spawn 系统 Chrome，不认 `MOTION_BROWSER`） |
| 模板运行时（`runtime/entry.mjs`，包内 `content/release.bin` 解出） | `node runtime/entry.mjs --instance <dir> render --plan p.json --out v.mp4` | **可用**，`findBrowser()` 认 `MOTION_BROWSER` |
| 浏览器 | Chrome 148 / headless shell | 必须补 `--no-sandbox` |

### 41.2 根因（可复现）

```
$ chrome-headless-shell --headless --remote-debugging-pipe ...
[err] sandbox initialization failed: Operation not permitted
[err] GPU process exited unexpectedly: exit_code=5   ×6
[err] FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:385 GPU process isn't usable. Goodbye.
```

本机非交互环境下 Chrome 自带 sandbox 起不来 → GPU 进程连崩 6 次 → FATAL → 子进程退出 →
上层只看到 `BROWSER_CLOSED` + crashpad 的 `mach_vm_read ... invalid address` 噪声。
**这就是 11 月 9 日被判成「entry.mjs:36 isAbsolute(undefined)」的同一现象**——
那次是驱动参数不对（少了 `--instance`）叠加浏览器崩溃，错误信息把真正原因盖住了。

解法是给浏览器补开关，**不改模板、不绕过沙箱**：

```bash
# ~/.local/bin/mg-chrome
exec <chrome-headless-shell 绝对路径> --no-sandbox "$@"
export MOTION_BROWSER="$HOME/.local/bin/mg-chrome"
```

### 41.3 实测数字（1440×1080 / 60fps / 46.983s）

| 指标 | 值 |
|---|---|
| 帧数 | 2819（= 46.983×60） |
| 渲染 | **51s**（15–17 ms/帧，≈ **55 fps** 吞吐）；含启动总墙钟 60s |
| 体积 | 24.4 MB（4.2 Mbps） |
| 音轨 | AAC 48k 立体声，voice+music+sfx 已混（LUFS 目标 −7.2，音乐 −17.5，normDb +10.3） |
| 内置校验 | `check.ok=true`：frames/duration/audio/decoded 全过，无 warnings |
| 外部复核 | 抽 5 帧哈希全不同（有动效）、blackdetect 0 段、字幕逐字高亮已烧录 |

对照 §23 的表：film-kit 从「渲染不可达 / 0 条·h⁻¹」变成 **≈70 条/h**（单条 51s）。
比 paper-perspective（89s/46s 片）快，比自建 Skia（2.3s）仍慢 22 倍——量级结论不变。

### 41.4 内容怎么做（模板唯一的输入是 film.json）

- 11 个镜头：`title`(钩子) → `timetable`(三个位置) → `bigWords`(五个/开关) → `opposite`(旧做法✕)
  → `sequence`×2(五个开关 / 查三样) → `shock`(设计) → `wordFlip`(重剪一条) + `notify`/`trainPass`/`bye` 三个叠加层。
- **时间一律用口播秒**，主镜头首尾相接（0–46.39 无空档），`presenterOnlyShare` 压到 0%。
- `beats` 对齐句中关键词：`title.hit=0.85`、`shock.hit=32.65`、`sequence.w1..w5=24.2/25.35/26.5/27.6/28.7`。
- 配乐走 `api music-prepare`（**0 积分**，CC0 曲目，按 47s 裁剪），返回 `background.wav` 直接绑 `music.file`。
- 片子内容沿用 `edits/audio-v7` 那条「完播率/钩子」口播（46.386s），不另配 TTS。

### 41.5 两个还看得见的问题（不是 bug，是取舍）

1. 无口播视频 → `presenter.mode=none`，摄像头窗口是 OFF AIR 卡片；原模板的灵魂是人物小窗，有真人素材会明显更好。
2. `bigWords` 的板宽固定 3 列，两行两字时右侧一格空着，对勾贴在第三列边界、紧挨摄像头窗口（间距约 40px）。要用满可用 `rows` 填 3 格或换 `sequence`。

产物：`out/mac-desktop-rc2-v1.mp4`、`out/mac-desktop-rc2-v1/`（film.json / plan / contact-sheet / 音乐授权 JSON / PRODUCTION.md）。

---

## 42. 同一支片三条管线并排：film-kit / skia-kit / cinecode（2026-11-10 11:30–11:43）

用户：「然后用 skia cline 也做个」。**同一条口播（46.386s「完播率·五个开关」）、同一份 8 段结构**，
三条管线各出一版，只换渲染器。

| 管线 | 输出 | 帧数 | 有效出片 | 吞吐 | 体积 | 门禁 |
|---|---|---|---|---|---|---|
| film-kit（官方 mac-desktop，1440×1080） | H.264+AAC | 2819 | **51s** | 55 fps | 24.4MB | PASS（hook 1.67） |
| skia-kit（1920×1080） | H.264+AAC | 2783 | **6.8s** | **409 fps** | 3.26MB | PASS（hook 0.11） |
| cinecode（1920×1080） | 画面 113.3s + mux | 2783 | **113.3s** | 24.6 fps | 6.13MB | PASS（hook 0.09，告警） |

三条全部 `node skia-kit/gate.mjs` PASS：帧数=时长×fps、有音轨、音画同长、flat 0.0% / black 0.0%。
同一支片三种视觉语言：film-kit 是 Mac 桌面（深色翻牌 + 菜单栏 + 摄像头窗），skia-kit 是纸面排版（头像卡 + 烧录字幕），
cinecode 是纸面 + 打字机引文（更空、更慢）。**内容一致、节奏一致、音轨完全一致**，差异只在渲染。

### 42.1 两条管线各自要踩的坑（都已解决，写进命令里）

1. **cinecode 抓帧要 `--flags "--no-sandbox"`**：与 §41 同一个根因，Chrome 自带 sandbox 在本机起不来，
   不加就直接 `Chrome closed the page: it crashed`。另外 `capture.mjs` spawn ffmpeg 用的是 PATH 里的
   `ffmpeg`，非交互 shell 必须先把 `/opt/homebrew/bin` 放进 PATH，否则 `spawn ffmpeg ENOENT`。
2. **capture.mjs 出完片不退出**：日志 113.3s 就打印 `video: ...`，进程却又挂了 **5.4 分钟**才结束
   （7:12 墙钟）。Chrome 的 helper 进程把 stdio 拖住了。自动化里要么 `timeout 240` 包一层，要么轮询
   输出文件出现即认为完成——**别把墙钟当成渲染耗时**，两个数要分开记。
3. **cinecode 的 qc 会报 `cap height 25 px < 40 px`**：这是 §「门禁标定」里已判定不可移植的手机可读阈值
   （1920 宽要求 40px 字高），不是缺陷；本片字幕 34.5px，与 skia-kit 同源。照旧只报不拦。

### 42.2 复用方式

```bash
# skia-kit（内容就是这一个 JSON）
node skia-kit/render.mjs --params motiongit-lab/edits/inputs-md.json \
  --audio motiongit-lab/templates/mac-desktop/instance/voiceover.m4a \
  --out motiongit-lab/out/skia-md.mp4 --fps 60

# cinecode（改 film_md.js 的文案与时间，再 build + capture）
cd cinecode-probe/voiceover-bench && python3 build.py film_md.js film_md.html
export PATH="/opt/homebrew/bin:$PATH"
node ~/.claude/skills/cinecode/scripts/capture.mjs --url cinecode-probe/voiceover-bench/film_md.html \
  --params "w=1920&h=1080" --out /tmp/md-frames --workers 8 --format jpeg --crf 18 \
  --video cinecode-probe/voiceover-bench/out/md-picture.mp4 --flags "--no-sandbox"
ffmpeg -i md-picture.mp4 -i <voiceover.m4a> -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart cine-md.mp4
```

产物：`out/skia-md.mp4`、`out/cine-md.mp4`、`out/md-three-way.jpg`（三行三列同点对比）、
`out/inputs-md.json`、`out/film_md.js`。

---

## 43. 第四条管线补齐 + 浏览器维度（2026-11-10 11:57–12:05）

用户问「是不是还有其他版本？playwright chrome」。答案：**有，而且今天补齐了**。
之前三条（film-kit / skia-kit / cinecode）里缺的正是**自有 HTML 模板 + Playwright/Chromium** 这条——
它一直在仓里（`render-parallel.mjs` + `packages/editorial-sync.motion`），只是没在同一支片上跑过。

### 43.1 同一支片四条管线（46.386s 口播、1920 或 1440 宽、60fps）

| 管线 | 帧 | 出片 | **ms/帧** | 体积 | 门禁 |
|---|---|---|---|---|---|
| skia-kit（Skia 直出，8 worker） | 2783 | **6.8s** | **2.44** | 3.26MB | PASS |
| 自有模板 + Playwright/Chromium（8 路） | 2783 | **12.44s** | **4.47** | 4.00MB | PASS（flat 2.1%） |
| film-kit 官方（`entry.mjs`，内置并行） | 2819 | 51s | 18.1 | 24.4MB | PASS |
| cinecode（`capture.mjs`，8 worker） | 2783 | 113.3s | 40.7 | 6.13MB | PASS |

**ms/帧 是唯一可跨帧率比较的指标**（墙钟会被 fps 和帧数带偏）。8 路 Playwright 是 4.47 ms/帧，
单路是 33.9 ms/帧 ⇒ **并行 7.6×**，接近线性。skia-kit 的 2.44 是 8 个进程各画一段、纯内存出帧，
所以它比"截图型"快一个量级。

### 43.2 浏览器维度：同一模板、同一批帧，只换可执行文件

`render-parallel.mjs` 新增 `--browser chromium|chrome|shell`。用两点法（300 / 900 帧）扣掉启动：

| 浏览器 | 300 帧 | 900 帧 | 斜率 | 启动 |
|---|---|---|---|---|
| Playwright Chromium（1254） | 9.97s | 30.29s | **33.9 ms/帧** | ≈0s |
| chrome-headless-shell（1254） | 10.19s | 30.20s | **33.4 ms/帧** | ≈0s |
| 系统 Google Chrome（`channel:'chrome'`） | 19.98s | 45.45s | **42.5 ms/帧** | **≈7.2s** |

结论：**换浏览器不改量级**；系统 Chrome 比 Chromium 慢 25%，且多 7 秒启动（完整浏览器 + 首启 profile）。
所以"Playwright + Chrome"不是一个新引擎，是同一引擎换了个更贵的浏览器；要快就用 Chromium 或 headless shell。

### 43.3 还没跑的"其他版本"（都是模板，不是引擎）

| 包 | 运行时 | 已有数据 |
|---|---|---|
| paper-perspective v2.6.x | motion-kit | 89s / 46s 片（32ms 帧） |
| promo-ink v2.6.6 | html-canvas | 1102s / 46s 片（310ms 帧） |
| camera-mode rc.4 | film-kit（竖屏 1080×1440） | 与 mac-desktop 同族，§41 的解法通用 |
| desktop-kit / mg-kit | 自建 Skia 复刻 | 19.2s / 条、0.13s 增量 |

这些换的是**模板与画风**，渲染栈仍是上面四条之一。

产物：`out/playwright-md.mp4`、`out/md-four-way.jpg`（四行三列同点对比）。

---

## 44. 「skia 复刻不如新模板」——先把差距拆开，再修（2026-11-10 12:06–12:12）

用户看了一眼四行对比说「Sika 复刻的好像没有这个版本好」。这句话对，但**根因不是渲染质量**，
拆成三条可验证的：

| # | 差距 | 证据 |
|---|---|---|
| 1 | **通用人脸素材抢戏** | 头像卡 473×805 = 占画幅 18%；素材是 stock 人像，不是本人 ⇒ 观感廉价 |
| 2 | **底色偏牛皮纸** | tokens 默认 `bg #EFEFE5` + 墨绿 accent，和 editorial 的白底网格放一起显旧 |
| 3 | **版式前提是"有人出镜"** | paper-perspective 是左文右人双栏；把人撤掉，右半画幅 100% 空白 |

**关键判断**：skia-kit 是 paper-perspective 的**逐像素复刻**，它的样子就是那个模板的样子。
所以"不好看"是**模板选型问题**（知识口播没人出镜），不是 Skia 画得差——同一个 Skia 渲染器
换一份 params 就出得比 Playwright 还快 1.8 倍。

### 44.1 改了什么（两处，都在运行时，不动锁定几何）

1. `--theme clean`：只换 palette（`bg #FAFAF7 / ink #111214 / body #4C5150 / bar 0.88`），
   `render.mjs` 新增 `--theme`，palette 贯通主线程与 worker。
2. **无出镜时把空卡改成「本章关键词卡」**：`paper.mjs` 的 `paperAvatarCard(sc)`，
   有头像走照片、没头像画一块 accent 实心卡（`CHAPTER` + `nn / 08` + `args.cast` 大字 + 「本章关键词」）。
   原来没有头像会画一块空灰块（`#D8D8CE`）——那是最难看的状态。

`--avatar off` + `--theme clean` 后：**5.6s / 2783 帧 / 2.41MB**（比带照片的 6.8s / 3.26MB 更快更小），
`gate.mjs` PASS、`verify.mjs` 8 项仍 PASS（几何没动）。

### 44.2 溢出修复（2026-11-10 12:15，用户报「右侧的字超出边界」）

真因不是 compare 右栏（它右对齐到 x=1198，卡在 1264，够不着），而是**关键词卡里的字**：
4 字的 `三个位置 / 五个开关` 按 132px 排，宽 528px > 卡内可用 377px，被 `clip` 裁成「三个位」。
两处修正：

1. 逐卡 fit（当时的最小修法）；
2. 改成**全片统一字号** `computeCastSize(scenes)`：取所有章节里最紧的那个可用字号，
   全片一个号。否则 2 字卡 132px、4 字卡 94px，一切章字号就跳。

修完把 8 个章节的右侧 1/3 全部抽帧复查：关键词完整、字号一致、左右边距均衡。
`gate.mjs` PASS、`verify.mjs` PASS。

### 44.3 还差的（不修，属于模板基因）

- 左侧内容天然贴左（`hero.x=142`），右下永远是留白；editorial 是居中构图，视觉更稳。
- `compare` 右栏 x=1198 与卡 x=1264 只差 66px ⇒ 右栏条目控制在 **≤5 字**，否则压到卡上。
- 真要追平 editorial，得重排版式（那就不是复刻了）。**结论：有人出镜用 skia-kit，纯口播用 editorial。**

产物：`out/skia-md-nocast.mp4`、`out/md-skia-v1v2.jpg`（v1 纸色头像 / v2 白底关键词卡 / editorial 三行对比）。

---

## 45. 原版 film-kit 与 Skia desktop-kit 同片对跑（2026-11-10 12:13–12:22）

用户「原版与 sika 都跑个片子看下」。先把可比性钉死（§41 / 固定对照口径）：
同一条 46.386s 口播、同一条 **46.983s 混音音轨**（voice+music+sfx，从原版成片 `-c:a copy` 抽出）、
同一份 8 句 SRT、同一规格 **1440×1080@60 / 2819 帧**、镜头边界逐秒对齐 `film.json` 的 8 个主镜头，
只换渲染引擎。两条片音轨 MD5 **逐字节相同**（`f3c14c0c…`）——这是「同片」的硬证据，不是口头声明。

**两条都真跑，不复用旧片**：原版用 §41 的完整实例（`/private/tmp/mg-core/runtime/entry.mjs`
+ `MOTION_BROWSER=mg-chrome`）重渲 `video-v2.mp4`；Skia 用 `desktop-kit/presets/md.json`。

| 指标 | 原版 film-kit | Skia desktop-kit | 倍率 |
|---|---|---|---|
| 有效出片 | **48.1s**（墙钟 57.6s） | **13.6s** | 3.5× |
| 吞吐 | 59 fps | 207 fps | 3.5× |
| 体积 | 23.65MB | **7.58MB** | 3.1× |
| 帧数 / 时长 / 规格 | 2819 / 46.983s / 1440×1080@60 | 同 | 1:1 |
| 内置 check / QA / 门禁 | ok=true, warnings=[] / PASS / PASS | — / PASS / PASS（hook 0.03 仅告警） | — |

**口径提醒**：本次 Skia 侧是 **desktop-kit（mac-desktop 的复刻）**，不是 §42 那条 skia-kit 纸面片；
且统一到原版的 1440×1080（§42 用 1920×1080），两组数字不可直接混用。

**并列 8 组同帧（`out/md-lines.html`）暴露的画面差距**：
1. **字幕**：原版深色字幕条 + 白/黄字，Skia 白字黑描边。浅灰壁纸 @14.3s 字幕区对比度实测
   **原版 1.50:1 / Skia 1.19:1** ⇒ Skia 偏淡，是真实差距。本轮只报告未改渲染器：
   修法是在 `subtitles()` 按壁纸明暗切墨色/描边（浅底用深墨字 + 白描边），
   代价是三条已交付片要重出 + 自检/对抗复跑。
2. **翻牌屏**：原版大字更粗、几乎占满画面；Skia 组件化黑板更收敛、留白更多。
3. **人物窗**：原版 `presenter.mode=none` → OFF AIR 卡片；Skia 程序化占位。
4. **镜头库**：原版 55 种用 11 个，Skia 16 种用 8 个 —— 同口播同边界，画面内容不同，**不是 1:1**。

**结论**：速度与体积优势在「同模板复刻」下仍成立（3.5× / 3.1×），但没有跨模板对比那么夸张；
画质差距集中在字幕可读性与大字张力。可比的是「同内容同规格下的产线效率」，
画面相似度要另用分区锐度/比色衡量，不能由这组数字反推。

产物：`out/mac-desktop-rc2-v2.mp4`、`out/desktop-md.mp4`、`desktop-kit/presets/md.json`、
`edits/audio-md-final.m4a`、`out/md-lines.html` / `.jpg` / `out/md-lines/`（16 帧 + gate 报告）、
`desktop-kit/tools/compare-lines.py`。

---

## 45. CanvasKit / SkSL 能不能优化这条片？——先量，再判（2026-11-10 12:23–12:40）

用户要「CanvasKit SkSL 优化视频」。先做三组独立测量，再决定要不要换引擎。
**结论先给：CanvasKit 在本机（Node，无 GPU）比原生 Skia 慢 82 倍；SkSL 全画幅 shader 每帧 427ms。
这条片真正的瓶颈是 x264 编码与一次多余的 JPEG 中间帧，不是画布。**

### 45.1 逐帧成本分解（1920×1080，@napi-rs/canvas）

| 环节 | ms/帧 | 占比 |
|---|---|---|
| 绘制（8 段版式全套） | **0.078–0.21** | 0.5% |
| 取原始 RGBA（`canvas.data()`） | 1.15 | 7% |
| JPEG q94 编码 | **7.3–15.0** | 92% |
| PNG 编码 | 75.8 | — |

⇒ 「画得慢」是伪命题，画只占 0.5%。中间那一步 JPEG 才是大头。

### 45.2 CanvasKit（canvaskit-wasm 0.42，Node 无 WebGL）实测

| 指标 | 原生 Skia | CanvasKit | 倍数 |
|---|---|---|---|
| 同几何绘制 | 0.078 ms | **6.36 ms** | 慢 **82×** |
| 取像素（RGBA） | 1.15 ms | **7.07 ms**（readPixels） | 慢 6× |
| 快照编码 | JPEG 7.3 ms | **仅 PNG，95.8 ms；JPEG 直接返回 null** | 不可用 |

原因是 WASM 里每次 canvas 调用的跨边界成本 + 无 GPU 时全走 CPU 软件栅格化。
**CanvasKit 的卖点是 GPU + WebGL/WebGPU，Node 里没有这两个后端，等于把它最贵的路径当默认路径用。**

### 45.3 SkSL 实测（RuntimeEffect，胶片颗粒）

| 用法 | ms/帧 |
|---|---|
| `main()` 全画幅逐像素（1920×1080） | **426.8** |
| 先烘 512² tile（一次 48.2 ms），再 12 块平铺 | 163.2 |
| 烘一次 + 原生 `drawImage` 平铺 | **≈0（0.004–0.3，噪声级）** |

结论：**SkSL 只适合"烘贴图"，不适合逐帧跑全画幅。** 同一张颗粒纹理，shader 每帧跑要 427ms，
烘成 PNG 后用原生平铺几乎免费——差 5 个数量级。

（顺带：0.16 强度的颗粒在这套白底排版上肉眼几乎看不出，加上只是徒增码率，所以没进成片。）

### 45.4 真正有效的优化：去掉 JPEG 中间帧

`skia-kit/render.mjs` 新增 `--pipe raw|jpeg`、`--x264-threads N`，默认改成 **raw + threads 1**。
同一支片 2783 帧 8 worker 全量 A/B：

| 组合 | 墙钟 | 体积 |
|---|---|---|
| jpeg（旧默认） | 6.28s | 2.51MB |
| raw | 6.48s | 2.38MB |
| **raw + threads 1** | **5.84s** | **2.36MB** |
| jpeg + threads 1 | 5.96s | 2.50MB |

净收益：**−7% 时间、−6% 体积**，更重要的是**少一次有损编码**（JPEG q92 → x264 是两次量化，
raw 只量化一次），所以同样 CRF 下体积更小。

### 45.5 现在的真实上限在哪

编码器单核实测（同一帧重复 300 次、只测编码）：x264 veryfast **7.5 ms/帧**、
ultrafast 7.3、crf23 7.7、`h264_videotoolbox` 8.6（更慢且体积 2.2MB/300 帧）。
真实内容更难压，8 路并行后的地板约 1.5–1.8 ms/帧 ⇒ **4.2–5.0s 已是这套参数的极限**，当前 5.7s 很接近。
再要快只有换 CRF/preset/分辨率，或改用硬件编码器（本机反而更慢）。

产物：`out/skia-md-nocast.mp4`（5.7s / 2.25MB）；探针脚本 `cankit-probe.mjs`、`grain-probe.mjs`、
`bench-pipe.mjs`、`bench-enc.mjs`、`bench-draw.mjs`。

### 45.6 desktop-kit 同主题复测：内容复杂度会翻转 raw/JPEG 的相对收益（12:26–12:41）

45.1–45.5 测的是 skia-kit（纸面模板，纯色大面积）；同一主题用 desktop-kit（桌面骨架 + 20 多图层 +
固定种子噪点）复测，数字差 2–4 倍但结论一致，差异本身有信息量：

| 指标 | skia-kit 1920×1080 | desktop-kit 1440×1080 | 差异原因 |
|---|---|---|---|
| 绘制 | 0.078–0.21 ms（0.5%） | **1.52 ms（4.4%）** | 桌面骨架 20+ 图层 + 翻牌/窗口 |
| JPEG q94 | 7.3–15.0 ms | **28–33 ms** | 噪点是高频细节，DCT 熵编码更贵 |
| raw RGBA | 1.15 ms | 23.6 ms | 同上 + 像素读出 |
| SkSL 全画幅 | 426.8 ms | **867 ms** | shader 含 hash/多次 mix，更重 |
| 端到端 raw vs jpeg | raw 略慢（+threads1 才 −7%） | **raw 快 1.18×**（管道 19.8×） | desktop 的 JPEG 更贵，raw 相对收益更大 |

**结论不变，边界更清楚**：
1. 绘制占比随模板复杂度从 0.5% 涨到 4.4%，SkSL 的理论天花板仍然很低（本机无 GPU，SkSL 反而慢 25×）；
2. **内容复杂度会翻转 raw/JPEG 的相对收益** —— 噪点越多，JPEG 越贵，raw 越划算；
3. 所以「raw 值不值」不能只在一条片上拍板，要按模板族分别测。仓里现在有两个 `bench-pipe.mjs`
   （`skia-kit/` 与 `desktop-kit/tools/`），口径不同，别混用。

**另一个只有真跑才暴露的坑**：CanvasKit 0.42 的 uniform 必须**严格等于声明大小**
（`u_time` 1 + `u_res` 2 = 3 个 float）。多传 1 个 → `makeShader` 返回 null → `drawPaint` 画空 →
整条片 4.1KB 全黑，而脚本仍打印「uniform OK」。现在 `sksl-demo.cjs` 加了双断言：
shader 非空 + 首帧 R 通道极差 ≥20，否则直接失败。

产物（desktop-kit 侧）：`out/sksl-report.html`、`out/sksl-demo.mp4`（3s / 720×540 / 72 帧 / 53.4s /
1.3 fps）、`out/sksl-frame.jpg`、`out/bench-{encode,pipe,sksl}.json`；
脚本：`desktop-kit/tools/bench-frame.mjs`、`bench-encode.mjs`、`bench-pipe.mjs`、`bench-sksl.cjs`、
`sksl-demo.cjs`、`sksl-report.mjs`。

### 45.7 按方案文档重测：GPU 路径成立，但整片只值 4.4%（12:44–12:55）

用户给了《CanvasKit SkSL Motion 动画蒸馏解决方案》，要求「用这几种方案试试」。文档的核心判断是
「**GPU 机器蒸公式，CPU 机器蒸结果**」。逐条落成脚本后，最重要的一条是**修正 45.6 的结论**。

**修正**：「本机无 GPU」不准确。准确说法是：**CanvasKit 的 WASM 版在 Node 里没有 WebGL 后端**；
原生 `headless-gl`（stack-gl 8.1.6，底层系统 OpenGL）可以走 GPU。

| 文档路线 | 本机 | 实测 |
|---|---|---|
| CanvasKit SkSL 实时 | ✗ | 1440×1080 **867 ms/帧**（CPU raster） |
| headless-gl + GLSL 实时 | ✓ | draw 0.14 + readPixels 2.36 = **2.5 ms/帧**；180 帧 **1.53s / 117.8 fps** |
| 关键帧蒸馏（uniform / 曲线） | ○ | 绘制仅 4.4%，插值不是瓶颈 ⇒ 收益≈0 |
| 资产烘焙 · webm | ✓ | VP9 编码 56s / **5.5MB**（mp4 的 73%） |
| Lottie / 矢量 | ? | 本仓无 AE/Bodymovin 产物，未验证 |
| 离线烘焙 · GL→帧→ffmpeg | ✓✓ | 1.53s 出 3s 片，已跑通 |

**收益归属**：GPU 解决的是绘制，而 desktop-kit 的绘制只占 **4.4%**（帧输出 95.6%）。
所以 GPU 对「整片端到端」的上限就是 4.4%，不值得为它重写渲染器；GPU 真正值钱的是
**纯 shader 层**（氛围/粒子/片头，117.8 fps vs 现有 33 fps 单线程）与**给播放端烘资产**（webm −27%）。

**方法上的两条**：
1. 文档是 Flutter Web 语境，「运行时成本」= 播放；我们产线是离线，「运行时」= 出片。
   同一个方案在两个语境下的收益完全不同，必须先对齐语境再谈收益。
2. 上一轮用 CanvasKit 一个后端就下「SkSL 不可用」的结论，属于**把实现缺陷当成方案缺陷**。
   这次用 `headless-gl` 复测才把因果分开：语法不是问题，后端才是。

产物：`out/sksl-plan-report.html`（方案矩阵）、`out/gl-slsh-3s.mp4`（GPU 片，1440×1080/3s/1.53s）、
`out/bake-demo.webm`（VP9 / 5.5MB）；脚本 `desktop-kit/tools/bench-gl.cjs`、`gl-film.mjs`
（`gl` 是原生模块，建议在独立目录 `npm i gl`，不要塞进主仓 node_modules）。

### 45.8 方案文档 v1.1 第 7 章：进阶蒸馏光谱逐条实测（12:51–13:05）

新章补了 6 条抽象层级递减的方案。按「能不能在本机量出来」分三组：

| 方案 | 实测 | 结论 |
|---|---|---|
| 7.1 曲线系数 | easeOutCubic：60 点 240B → 三次多项式 4 系数 16B，**误差 0**；spring：多项式误差 **0.2296**，弹簧解析解 5 参数 20B **误差 0**；求值 0.3–0.7 µs | ✓ 成立；**振荡类 motion 不能用低阶多项式**，必须解析解 |
| 7.2 Flow Map | 256² flow + 256² fBm（512KB）+ 三次平流；1440×1080/360 帧 **3.05s（118 fps）**；成片 1.4MB/6s | ✓ 成立；成本压在 readPixels |
| 7.3 粒子纹理 | 未实现渲染；估算 1024×600 帧 ≈ **4.9MB**，与视频 5.5MB 同量级 | ○ 体积不占优，价值在可交互 |
| 7.4 morph/骨骼 | 无 glTF/骨骼素材 | ? 无法验证 |
| 7.5 编码器蒸馏 | H.264 577KB/0.38s · **H.265 97KB/1.13s** · **VP9 89KB/3.91s**（1/6 体积）；AV1 `libsvtav1` 初始化失败 | ✓ 成立，但时间 3–10× |
| 7.6 学习式 | 未做 | ✗ 训练成本 + 复用规模不划算 |

**三个只有真跑才知道的细节**：
1. **曲线蒸馏的选型取决于曲线的解析性质**：单调缓动 4 系数就够；带回弹的曲线必须用
   `A−B·e^(−λt)·cos(ωt+φ)`，多项式强行拟合会差 23%——这不是精度问题，是函数类不匹配。
2. **fBm 的基频决定有没有「方格子」**：`n=2^(o+2)`（从 4×4 起）在 1440 画幅上会留下可见网格，
   改 `2^(o+3)`（从 8 起）后消失；另外纹理必须 wrap 索引生成才能无缝平铺。
3. **同一段 motion，纹理从随机点换 fBm，成片体积从 29.2MB 降到 1.0MB（29×）**——
   内容的低频结构直接决定编码效率，这也是「让编码器蒸馏」（7.5）成立的前提。

**未做项的理由**（不糊弄）：7.3 粒子纹理需要顶点纹理采样 + 16bit 位置编码，
工程量大于收益（体积与视频同量级）；7.4 无素材；7.6 无训练管线。
Flow Map 画面右缘仍有一条轻微接缝，属 fBm 平铺边界，工程结论不受影响。

产物：`out/curve-fit.json`、`out/flow-256.rgba`、`out/noise-256.rgba`、`out/gl-flow-6s.mp4`（6s/118 fps/1.4MB）、
`out/gl-flow-frame.jpg`、`out/codec-{h264,hevc,vp9}.{mp4,webm}`；
脚本 `desktop-kit/tools/curve-fit.py`、`gl-flow.mjs`。

## 46. 五条出片管线，同一条 desktop-kit 片子（2026-11-10 13:00–13:25）

前几轮都是「一条管线 vs 另一条管线」的单点比较，这轮把可换的轴拆开：**壁纸层（Skia / GPU / JS）
× 传帧（JPEG / RAW）**，五个组合跑同一条分镜，共 1419 帧 / 23.658s / 1440×1080@60 / 同一条音轨。

分镜 `desktop-kit/presets/cmp-voiced.json` 不是随手拼的：6 镜覆盖蓝/橙/浅三面壁纸，
含 2 次整屏翻牌转场（最贵的一类镜头）与翻牌、评论墙、终端、图表、结尾五类组件。
音画由 TTS 重排，五条片逐帧对齐，任何差异都不来自内容。

| 变体 | 壁纸层 | 传帧 | 墙钟 | 吞吐 | 单帧绘制 | 单帧传帧 | 体积 |
|---|---|---|---|---|---|---|---|
| A 现状 | Skia 渐变 | JPEG q94 | 7.51s | 188.8 fps | 2.89 ms | **28.77 ms** | 3.76 MB |
| B | Skia 渐变 | RAW | 6.75s | 210.3 fps | 2.73 ms | 24.22 ms | 2.95 MB |
| C | GPU 流体 | JPEG q94 | 7.28s | 195.1 fps | 5.03 ms | 12.80 ms | 2.82 MB |
| D | JS 流体 | JPEG q94 | 40.23s | 35.3 fps | **175.42 ms** | 13.51 ms | 2.52 MB |
| E 综合 | GPU 流体 | RAW | 7.27s | 195.2 fps | 4.15 ms | 12.40 ms | 2.69 MB |

**① 传帧占 A 的 91%（28.77 / 31.66），这是这条产线真正的瓶颈。**
之前 `bench-pipe` 测出 raw 只快 1.18×，看着像「不值得」。这次带上无损基准才看清：
A 进编码器前多过一次 JPEG q94，以 `x264 -crf 0` 为基准，Y-SSIM 0.9728 vs B 的 0.9772、PSNR 43.22 vs 43.77 dB。
**少一次 JPEG = 更快 + 更小 + 更准**，三项同向，这种机会不多。

**② GPU 对静态壁纸一定是亏的，别被「GPU 更快」带着走。**
C 的壁纸层 3.02 ms（draw 0.79 + readPixels 2.24），内置 Skia 渐变 0.05–0.16 ms —— 差两个数量级。
GPU 在这里唯一值钱的是 CPU 做不到的事：同一段 fBm 流体，JS 逐像素 163.94 ms，GPU 3.02 ms（54×）。
这跟 §45.7 的结论一致，但给出了边界：**要流动就必须上 GPU，不流动就别上。**

**③ 体积主要由壁纸内容决定，不由引擎决定。**
同样的 UI 与动作，壁纸从固定噪点换成低频流体，A 3.76 MB → D 2.52 MB。
x264 的码率主要花在高频细节上 —— 与 §45.8 里「随机点噪声换 fBm 后体积 29×」是同一机制，
只是这次发生在同一条片内部。

**④ RAW 管道的代价是数据量。** 6.2 MB/帧、整片约 8.8 GB 过管道。只在本地进程间成立，
跨机器或落盘必须回退压缩格式。B 相对 A 只快 10% 而不是 10×，就是被管道吞吐吃掉了。

### 校准三个坑（都是「看起来差不多」的假象）

为了让它成为「同一版式的流动版」而不是「另一张更暗的壁纸」，壁纸层必须按像素对齐。踩了三次：

1. **单圆心近似代替 canvas 的双圆心圆锥**：靠近中心一大片被压成同一种颜色，实测左上暗 12/255、右下亮 12/255 —— 缩略图上看不出来，1:1 裁一块立刻现形。
2. **二次方程取错根**：两根一正一负时取了负根，整片被压到最亮的中心色（暗部差 100+）。正解是「取最小非负根」，用 canvas 的 `getImageData` 逐点反推验证过（5 个采样点全中）。
3. **把噪点层当成「加亮」**：内置壁纸的 48% 灰度噪点（alpha 20–35）实际是按 k≈0.0527 **向中灰混合**，暗部抬、亮部压。按加亮处理怎么调都对不上，最后用实测拟合出 k 与 6.5/255 的基调项，纯壁纸区与原版差 **< 0.5/255**。

教训与 §45 相同但更具体：**「画面看起来一样」不能当通过条件，要指定一个能算的区域（纯壁纸区）+ 一个能算的统计量（均值与高频能量），否则会一直在调参数。**

### 质量与编码

| 组合 | 比什么 | SSIM Y | PSNR |
|---|---|---|---|
| A ↔ B | 换传输 | 0.9473 | 41.52 dB |
| C ↔ D | 换引擎（同公式） | 0.9869 | 30.49 dB |
| A ↔ C | 换壁纸内容（本就不同） | 0.8843 | 30.27 dB |
| E ↔ C | 综合 vs 仅换引擎 | 0.9948 | 46.48 dB |

编码蒸馏（源 = E 2.69 MB）：H.265 1.38 MB / VP9 1.41 MB / H.264 2.17 MB / AV1 1.89 MB。
**AV1 反而比 H.265 大** —— 同 CRF 不等于同质量，跨编码器不能直接比。

曲线系数蒸馏（本模板真实三条 motion）：eo 用 4 系数零误差、eio 单段三次多项式误差 6.2%、
Dock 正弦用三次多项式误差 **147%**、必须 `A·sin(ωt+φ)`。合计 1440 B → 28 B（51×）。

产物：`out/cmp-{a..e}.mp4`、`out/cmp-report.html`、`out/cmp-contact.jpg`、`out/cmp-quality.json`、
`out/cmp-{a..e}.json`、`out/curve-desk.json`、`out/cmp-ref-lossless.mp4`（2s 无损基准）。
脚本：`desktop-kit/tools/render-bench.mjs`、`bg-providers.mjs`、`probe-bg.mjs`、
`cmp-quality.py`、`cmp-contact.py`、`cmp-report.py`、`curve-desk.py`。
