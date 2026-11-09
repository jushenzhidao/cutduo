# 剪辑渲染工作区

围绕「视频剪辑 / 渲染」的三个项目 + 验收材料。当前总 **566 MB**（2026-11-09 清理后，原 1.0 GB），剩余以模板源码与回归语料为主。

## 地图

| 目录 | 是什么 | 入口 |
|---|---|---|
| `renderd/` | 商业级视频渲染服务：**IR 进，成片 + 证据回执出**。REST + MCP 双接口，SQLite / PostgreSQL 双后端，FFmpeg + MLT 双编译后端。已具备 Linux 云端单机部署能力 | `renderd/README.md`、`make -C renderd doctor`、**`renderd/docs/DEPLOY-LINUX.md`** |
| `cutproof/` | 剪辑渲染「可验证性」最小闭环：素材进得来 → 成片敢交付，全链路可重跑 | `cutproof/README.md`、`./cutproof/ci/gate.sh` |
| `motiongit-lab/` | MotionGit `.motion` 模板（ZIP 源码包）的运行时实验与基准：解包、改参、逐帧渲染、并行/进程模型测量 | `motiongit-lab/MOTIONGIT-PLAYBOOK.md` |
| `deliverables/` | 5 份 HTML 交付报告（浏览器打开） | `deliverables/落地总报告.html` |
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
```

## 体积治理

2026-11-09 做过一次清理：1.0 GB → 566 MB，删掉的全部是「跑一遍就能再生成」的媒体产物，
源码、模板、语料、证据 JSON 一件没动。完整清单与重跑命令见 `docs/仓库清理-2026-11-09.md`。

| 位置 | 现在 | 性质 |
|---|---|---|
| `motiongit-lab/templates/` | 115 MB | `.motion` 模板与解包素材，**核心资产** |
| `cutproof/res/` + `corpus/` | 209 MB | 回归基线语料，**删了就没法复现** |
| `motiongit-lab/out/` | 91 MB | 27 个 `editorial-*` 成品 + 每类基准 1 个样本 |
| `renderd/var/sample/` | 48 MB | 真实素材 + 人工抽帧截图，**唯一副本** |
| `motiongit-lab/node_modules/` | 48 MB | `npm ci` 可重建 |
| `motiongit-lab/edits/` | 27 MB | 编辑工程 |
| `cutproof/assets/` | 18 MB | 测试素材 |
| `cutproof/out/` | 708 KB | 只留断言证据（回执、测量、缩略图） |
| `renderd/var/` 其余 | 7 MB | 145 个 JSON 证据与运行时数据 |

`.gitignore` 已把 `renderd/var/`、`*/out/`、`node_modules/` 划出版本库边界。
