# 剪辑渲染工作区

围绕「视频剪辑 / 渲染」的三个项目 + 验收材料。当前总 **2.1 GB**（2026-11-12 清理后；清理前 2.7 GB）。11-09 曾从 1.0 GB 清到 566 MB，此后几轮基准、复刻与成片又推高，本轮按同一口径再清一次。体积治理记录见 `docs/仓库清理-2026-11-09.md` 与 `docs/仓库清理-2026-11-12.md`。

## 地图

| 目录 | 是什么 | 入口 |
|---|---|---|
| `renderd/` | 商业级视频渲染服务：**IR 进，成片 + 证据回执出**。REST + MCP 双接口，SQLite / PostgreSQL 双后端，FFmpeg + MLT 双编译后端。已具备 Linux 云端单机部署能力 | `renderd/README.md`、`make -C renderd doctor`、**`renderd/docs/DEPLOY-LINUX.md`** |
| `cutproof/` | 剪辑渲染「可验证性」最小闭环：素材进得来 → 成片敢交付，全链路可重跑 | `cutproof/README.md`、`./cutproof/ci/gate.sh` |
| `motiongit-lab/` | MotionGit `.motion` 模板（ZIP 源码包）的运行时实验与基准：解包、改参、逐帧渲染、并行/进程模型测量 | `motiongit-lab/MOTIONGIT-PLAYBOOK.md` |
| `skia-kit/` | 纸面口播模板（Skia，无浏览器）：一条命令出片、版式自检、新模板测量工具。`./skia-kit` 是指向 `motiongit-lab/skia-kit` 的软链，从工作区根或 motiongit-lab 里都能直接跑 | `skia-kit/README.md`、`skia-kit/REPLICATION.md` |
| `desktop-kit/` | Mac Desktop 模板的 Skia 复刻：1440×1080 / 60fps，桌面骨架 + 16 个版式镜头 + `photo`/`clip` 两类素材镜头、13 项量化自检、按真实配音重排分镜。出片经验已蒸馏成用户级 skill `~/.workbuddy/skills/desktop-video-pipeline/` | `motiongit-lab/desktop-kit/README.md`、`motiongit-lab/out/desktop-compare.html`、`out/desktop.mp4` |
| `motiongit-lab/content/` | **内容分镜**（15 个 JSON）：每支片的镜头、文案、素材引用；与渲染代码分离，改内容不进代码目录 | `content/hotpot.json` |
| `motiongit-lab/mg-kit/` | MG 动效验证：纯 Skia 逐帧、5 类镜头（文字 / 档案时间轴 / 黑洞 2.5D 粒子 / 等轴积木 / 信息卡），带确定性自检 | `node mg-kit/render.mjs`、`deliverables/MG动效能力验证.html` |
| `deliverables/` | 7 份 HTML 交付报告（浏览器打开） | `deliverables/落地总报告.html` |
| `docs/` | 跨项目文档（外部仓库体检等） | — |

根目录 `result.md` / `decisions.md` / `progress.md` / `blockers.md` 是 renderd 这一轮的**验收四件套**，内部路径引用都以工作区根为基准，故保持在根目录。

## 三个项目的关系

```
cutproof            证明「这条路能走通」
   ↓ 结论沉淀
renderd             把它做成能起服务、能排队、能重启恢复的产品
   ↑ 素材与模板来源
motiongit-lab       真实模板运行时与性能基准（含 SKIA / Chromium 进程模型实测）
```

- **cutproof** 是 P0 阶段：先回答「同一份 IR 能不能每次都出同一支片子、渲染错了能不能比客户先知道」。
- **renderd** 是产品化：同一个判定标准，加上幂等提交、租约回收、内容寻址缓存、三层断言、证据回执、配额与租户隔离。
- **motiongit-lab** 提供真实素材与渲染压力来源，同时也是模板格式（`.motion` = ZIP 源码包）的调研产物。

## 文档索引

| 想知道什么 | 看哪里 |
|---|---|
| renderd 现在能做什么、怎么部署 | `renderd/README.md`、`renderd/docs/API.md`、`renderd/docs/OPS.md` |
| 安全模型与攻击面 | `renderd/docs/SECURITY.md`、`deliverables/对抗审查报告.html` |
| 这一轮做了什么、实测数字 | `result.md`、`deliverables/落地总报告.html` |
| 为什么这么设计 | `decisions.md`（逐条决策 + 理由） |
| 还差什么 | `blockers.md`（每条写清卡在哪、需要什么才能解） |
| MotionGit 模板怎么用 | `motiongit-lab/MOTIONGIT-PLAYBOOK.md` |
| 体积治理与清理记录 | `docs/仓库清理-2026-11-09.md`、`docs/仓库清理-2026-11-12.md` |
| 模板（内容）与代码如何分层 | `docs/模板与代码分离-2026-11-12.md` |
| 一键出片的编排脚本 | `~/.workbuddy/skills/desktop-video-pipeline/scripts/make_film.py` |

## 常用命令

```bash
# renderd
cd renderd
make doctor            # 环境自检
make test              # 全量单测
make test-container    # 容器内端到端
make docker-run        # 起服务（8788 → 容器 8787）

# renderd 部署到 Linux 云主机（单机 Compose：pg + api + worker + 可选 Caddy TLS）
sudo ./deploy/linux/install.sh --domain render.example.com --email ops@example.com --tls
make prod-ready        # 查就绪
make prod-backup       # 备份

# cutproof
./cutproof/ci/gate.sh  # 五步全绿约 1 分钟

# motiongit-lab
cd motiongit-lab && npm ci && node motion-render.mjs --help

# 一键出片（TTS → 混音 → 出片 → QA/门禁），详见用户级 skill
uv run python ~/.workbuddy/skills/desktop-video-pipeline/scripts/make_film.py \
  --preset desktop-kit/presets/<name>.json --music <cc0.wav>

# desktop-kit（Skia 复刻 Mac Desktop，无需浏览器）
cd motiongit-lab
node desktop-kit/verify.mjs                       # 11 项量化自检
node desktop-kit/render.mjs \
  --params desktop-kit/presets/demo-voiced.json \
  --audio edits/audio-desktop.m4a --out out/desktop.mp4 --fps 60
```

## 体积治理

2026-11-09 做过一次清理：1.0 GB → 566 MB；2026-11-12 再做一轮，口径不变：**只删「跑一遍就能再生成」的媒体产物**，源码、模板、语料、证据 JSON、参考片与唯一副本一件不动。完整清单与重跑命令见两份 `docs/仓库清理-*.md`。

| 位置 | 2026-11-12 清理后 | 性质 |
|---|---|---|
| `motiongit-lab/out/` | 696 MB | 104 支 mp4（442 MB）+ 报告/总览；可重跑，已忽略 |
| `motiongit-lab/replicas/` | 288 MB | `out/` 465 MB、`reference/` 187 MB、`downloads/` 50 MB；媒体可重跑，参考片是本地校验唯一副本 |
| `motiongit-lab/ref/` | 203 MB | mac-desktop 官方 demo 与抽帧，本地 1:1 校验用 |
| `cutproof/`（含 `res/` + `corpus/`） | 208 MB | 回归基线语料，**删了就没法复现** |
| `motiongit-lab/templates/` | 166 MB | `.motion` 模板与解包素材，**核心资产** |
| `cinecode-probe/` | 163 MB | 管线对比实验产物（html/json 为证据） |
| `motiongit-lab/edits/` | 76 MB | 编辑工程；含 `render-cache/` 82 MB 缓存、素材 38 MB |
| `renderd/` | 86 MB | 服务源码 + `var/sample/` 唯一副本 |
| `motiongit-lab/node_modules/` | 73 MB | `npm ci` 可重建 |
| `deliverables/` | 308 KB | 交付报告 + skill 分发包 |

`.gitignore` 已把 `renderd/var/`、`motiongit-lab/out/`、`replicas/` 的媒体、`node_modules/`、个人下载模板包（含个人 Key）划出版本库边界。
