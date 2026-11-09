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
