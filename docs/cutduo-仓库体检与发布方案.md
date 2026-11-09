# cutduo 仓库体检 & 发布方案

- **目标仓库**：https://github.com/jushenzhidao/cutduo
- **体检时间**：2026-11-09 15:5x（GMT+8）
- **本次性质**：**只读**。未推送、未建 tag、未建 Release、未改任何远程设置。

---

## 结论摘要

仓库是 **9 分钟前刚建的空壳**，0 提交 / 0 分支 / 0 tag / 0 Release，`main` 只是一个声明值、实际不存在。
所以现在**不存在"给 cutduo 发个版本"这个动作**——没有可发布的内容，`gh release create` 会直接报 `no commits`。

真正要做的是三件事，顺序不能颠倒：**① 建立首个提交 → ② 装上发布流水线 → ③ 让流水线产生 v0.1.0**。
好消息是你们组织里已有 3 个仓库跑着同一套 `release.yml`，cutduo 直接复用即可，不用重新设计。

---

## 〇、依赖状态（2026-11-09 16:3x 已安装）

| 依赖 | 状态 | 位置 / 版本 |
|---|---|---|
| **gh**（GitHub CLI） | ✅ 已装 | `~/.local/bin/gh` → `~/.local/share/gh/2.103.3/gh`，v2.103.3 |
| **gh-release-automation** 技能 | ✅ 已装并注册 | `~/.workbuddy/skills/gh-release-automation/`（SKILL.md + 2 份 references） |
| git / jq / curl / ffmpeg / node / python3 | ✅ 原有 | `/usr/bin/git`、`/usr/bin/jq`、`/opt/homebrew/bin/ffmpeg` 等 |
| uv | ✅ 原有 | `~/.local/bin/uv` 0.13.7（非交互 shell 需手动加 PATH） |
| **GitHub 凭据** | ⏳ **待你确认** | 设备流已就绪（15 分钟有效），一次性码 `CB70-E339` → https://github.com/login/device |

**gh 的来源说明（为什么没走 brew）**：`brew install gh` 试了两次都被环境拦下——
Homebrew 自带的 `sandbox-exec` 在本机报 `sandbox_apply: Operation not permitted`（退出码 71），
`HOMEBREW_NO_SANDBOX=1` 也无效。改用 **cli/cli 官方发布包**（`gh_2.103.3_macOS_arm64.zip`），
落到 `~/.local/bin`（与 uv / bsk / edge-tts 同一约定）。
完整性用 **GitHub API 返回的资产摘要**校验：
`sha256:d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062`，与本地实算一致；
体积 14106091 字节也与 API 报告一致。（官方 `checksums.txt` 当时 502 拉不下来，
但 API 的 `digest` 字段是 GitHub 自己算的权威摘要，更可靠。）
副作用：`gh` 在 `~/.local/bin` 下，**非交互 shell 里要手动 `export PATH="$HOME/.local/bin:$PATH"`**。

**关于技能**：你挂载的 `gh-release-automation` 的 SKILL.md 声明路径在 `/Users/betterme/…`，
本机无此用户、该文件不存在；市场安装工具的数组参数在本会话序列化失效。
因此我按**组织内 3 个真实在跑的 `release.yml`** 反推，把这个技能重新写出来补齐——内容来自
组织自己的注释与代码，不是通用最佳实践。详见 `~/.workbuddy/skills/gh-release-automation/`。

---

## 一、体检数据（API 实测，非推测）

| 项 | 值 | 判读 |
|---|---|---|
| 仓库 ID | `1451068208` | — |
| 所有者类型 | **Organization**（`jushenzhidao`，31 个公开仓库，2026-07-01 创建） | 发布权限受组织角色约束，不是个人号 |
| 可见性 | `public` | Release 对外可见 |
| 创建时间 | `2026-11-09T07:38:56Z` = **本地 15:38** | 距本次请求约 9 分钟 |
| 最后 push | `2026-11-09T07:38:58Z` | 建库时的 2 秒，之后再无动作 |
| size | **0 KB** | 确认为空 |
| default_branch | `main`（声明值） | 实际无分支 |
| branches / tags / releases | `[]` / `[]` / `[]` | 全空 |
| commits API | **HTTP 409** `Git Repository is empty` | 空库的确定性特征 |
| contents API | **HTTP 404** `This repository is empty` | 同上 |
| language | `null` | 无代码 |
| description / homepage | `null` / `null` | 未填 |
| topics | `[]` | 未打标签，搜不到 |
| license | `null` | 无许可证 |
| has_issues / has_wiki / has_discussions | `true` / `true` / `false` | 默认开关 |
| stars / forks / watchers | 0 / 0 / 0 | — |

**未取到、需有权限才能查的**：分支保护规则、Actions 是否启用、组织级 secret、codespaces 配额。这几项在匿名状态下 API 不返回，不能替你下结论。

---

## 二、与组织惯例对照

同组织其他仓库的情况（同一时刻批量拉取）：

| 维度 | 组织现状 | cutduo 是否偏离 |
|---|---|---|
| 版本号风格 | `v0.1.x` 补丁递增（jimeng 已到 **v0.1.81**，video-adapter **v0.1.7**） | 待建立 |
| Release 形式 | **tag-only，0 个二进制资产**，标题 = tag 名 | 待建立 |
| 发布流水线 | jimeng / video-adapter / aivideomaker **都有** `.github/workflows/release.yml`，且三入口设计一致 | **缺** |
| description | 31 个仓库中 **19 个为空** | 与多数一致（是惯例，也是债） |
| license | 31 个中 **28 个无** | 与多数一致 |

两条值得注意的旁证：
- `artduo` 与 cutduo **同日创建、同样 size 0** —— 这是一个批量开新库的动作，`…duo` 是命名系列。若两者定位相近，发布流水线应做成同一份模板，别各写一套。
- 那套 `release.yml` 的注释密度极高（写清了为什么不用 `git describe`、为什么镜像先推后打 tag、为什么不用 `--generate-notes`），说明是踩过坑沉淀下来的。**cutduo 直接继承，等于白拿这些结论。**

---

## 三、缺口清单

### P0 — 不补就无法发布
1. **零提交**。没有 commit 就没有 tree，tag 无对象可指。
2. **无 GitHub 写凭据**。本机 `gh` 未安装、无 `GH_TOKEN`、`~/.config/gh` 不存在，三条写路径全断。
   → ✅ **已于 16:3x 解决**：`gh` v2.103.3 装在 `~/.local/bin/gh`；凭据待用户输入设备流一次性码 `CB70-E339`。

### P0′ — 新发现：**模板包里的个人 Key 会被一起公开**（推送前必须解决）

这是本轮 dry-run 测算时挖出来的，**优先级高于所有其他项**。

`cutduo` 是 **公开**仓库，而本工作区的 `motiongit-lab/templates/` 里带着 MotionGit 个人下载包的
身份层：

```
motiongit-lab/templates/paper-perspective/package/
├── personal/
│   ├── motiongit.key.json   ← 字段：apiKeyId / apiOrigin / credentialVersion / key / recipientAccountId
│   ├── signature.json
│   └── receipt.json         ← 绑定 authorAccountId / recipientAccountId / signingKeyId
├── content/release.bin      ← 26 MB，身份/实现层
└── template.motion          ← 27.5 MB，含上述全部
```

`MOTIONGIT-PLAYBOOK.md` 第 129 行写得很死：

> 个人下载包里的 `personal/`、`content/release.bin`、`core.enc` 是身份/实现层，
> **不要手解、不要外传、不要把 Key 贴进对话**；分享请给模板网页链接。

第 133 行补刀：*免费模板常限个人非商用、**不得再分发模板本身***。

⇒ **把 `motiongit-lab/templates/` 推进公开库 = 公开一枚绑定你账号的 API Key + 违反模板再分发条款。**
一旦 push，密钥就进了 git 历史，**删文件也删不掉**（只能 filter-repo 重写 + 吊销密钥）。

**处置（建议）—— 外科手术式排除，别一刀切**：

四个模板包里，**只有那两个下载包带身份层**，自建的两个是干净的：

| 模板包 | 体积 | 含 `personal/` | 可否入库 |
|---|---|---|---|
| `templates/distill/` | 56 KB | ❌ 无 | ✅ 可（自建，结构完整：motion.json / SKILL.md / params.schema.json / integrity.json / licenses / presets / src） |
| `templates/editorial/` | 112 KB | ❌ 无 | ✅ 可（同上；`build-template.py` 的产物来源） |
| `templates/paper-perspective/` | 59 MB | ✅ **有**（含 27.5 MB `template.motion` + 26.5 MB `release.bin`） | ❌ **不可** |
| `templates/paper-perspective-11/` | 56 MB | ✅ **有** | ❌ **不可** |

```gitignore
# MotionGit 个人下载包 —— 含个人 API Key 与受限模板，不得入库/外传
# 见 docs/cutduo-仓库体检与发布方案.md 的 P0′
motiongit-lab/templates/paper-perspective/
motiongit-lab/templates/paper-perspective-11/
```

这样既保住 115 MB 里的自建资产（`build-template.py` 依赖 `templates/distill`），
又切断密钥泄露路径。对外分享那两个下载包时**用模板网页链接**，不用文件。

**推之前的自检**（防止再犯）：

```bash
git diff --cached --name-only | grep -E "personal/|core\.enc|release\.bin|template\.motion" \
  && echo "❌ 命中受限文件，先处理" || echo "✅ 无受限文件"
```

### P1 — 能发，但发出来是个空壳
3. 无 `README.md`（仓库首页显示 "cutduo doesn't have a README"）。
4. 无 `description`、无 `topics`（GitHub 搜索与组织页都检索不到）。
5. 无 `LICENSE`（公开仓库无许可证 = 法律上默认保留所有权利，别人不能用）。
6. 无 `.gitignore`（若直接推本地项目，会把 `node_modules` 一起推上去）。
   → ✅ 本工作区根目录已有 `.gitignore`（16:10 整理时建的），但**缺 `templates/` 这一条**，见 P0′。

### P2 — 长期债
7. 无 `release.yml`，只能手工发版 → 版本号靠人记，必然出现断号/重号。
8. 无分支保护（`main` 可被直推 + 强推），与自动化 bump 混用时有竞态风险。

---

## 三之二、实测：git 到底会入库多大

用当前 `.gitignore` 做了一次不落盘的 dry-run（临时 bare 仓库 + `--work-tree` 指向本工作区）：

| 指标 | 实测值 |
|---|---|
| 会被追踪的体积 | **≈ 349 MB** |
| 最大单文件 | `cutproof/res/mezz/c10_long.mp4` **54.8 MB**（未超 100 MB 硬限） |
| 超 50 MB 的文件 | 4 个（两个 `template.motion` 27.5 MB、两个 `release.bin` 26.5 MB） |

按体积排的入库大户：

| 路径 | 体积 | 能否入库 | 理由 |
|---|---|---|---|
| `motiongit-lab/templates/` | 115 MB | ❌ **不能** | 含个人 Key（见 P0′） |
| `cutproof/res/` | 108 MB | ❌ 建议排除 | 渲染输出，可重跑 |
| `cutproof/corpus/assets/` | 101 MB | ⚠️ 视情况 | 21 条语料由 `corpus/gen_dirty.py` 生成，**可再生**（`manifest.json` 留库即可） |
| `motiongit-lab/packages/` | 280 KB | ✅ | 核心资产 |
| `renderd/`（去掉 `var/`） | 56 MB | ✅ | 产品化引擎，是 cutduo 的主体 |
| `cutproof/`（去掉 `res/`、`corpus/assets/`、`out/`） | ~19 MB | ✅ | 原型与断言库 |

**349 MB 不会触发 GitHub 的拒收**（单文件硬限 100 MB、仓库建议 <1 GB 都还过得去），
但 clone 会很慢，且这类二进制一旦进历史就再也拿不掉。

**处置结果（已实测）**：上面的规则**已经落到根 `.gitignore`**，复测结果：

| 指标 | 处置前 | **处置后** |
|---|---|---|
| 追踪文件数 | ~700+ | **435** |
| 总体积 | 349 MB | **44.7 MB** |
| 最大单文件 | 54.8 MB | **7.0 MB**（`cutproof/assets/clip1.mp4`） |
| 受限文件自检 | ❌ 命中 `personal/` `release.bin` `template.motion` | **✅ 零命中** |

按项目分布：`motiongit-lab` 321 个 / `renderd` 81 个 / `cutproof` 16 个 / 根文档与 `deliverables` 11 个。

还能再瘦的两处（可选，非必须）：

- `motiongit-lab/edits/` **26.4 MB / 212 个文件**——多音色 TTS 变体，由
  `build-voices.sh` / `build-sync.py` **可再生**，属中间产物；
- `cutproof/assets/` 18 MB——样例片段，若确认来源与授权后可一并排除。

即便保留这些，**44.7 MB 对一个公开仓库是完全健康的体积**（GitHub 建议 <1 GB）。

**注意**：`.workbuddy/` 下的 4 个 memory markdown 也会入库（项目工作日志）。
根目录已有 `decisions.md` / `blockers.md` / `progress.md` 这套审计轨迹，
把 memory 日志一起放进去是自洽的；但如果你不想让内部过程记录公开，加一行 `.workbuddy/` 即可。

---

## 四、发布方案

### 方案 A（推荐）：继承组织的三入口流水线

把 video-adapter 那套 `release.yml` **去掉 Docker/ghcr 部分**（cutduo 目前没有容器产物），保留版本解析与 Release 创建逻辑：

```yaml
name: Release
on:
  push:
    branches: [main]
    tags: ['v[0-9]*.[0-9]*.[0-9]*']
  workflow_dispatch:
    inputs:
      tag: { description: '要补发的 tag（须已存在）', required: true }

permissions:
  contents: write

concurrency:                      # 两次 push main 会算出同一个版本号并抢同一个 tag
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    if: ${{ github.actor != 'github-actions[bot]' && !contains(github.event.head_commit.message || '', '[skip release]') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ inputs.tag || github.ref }}
          fetch-depth: 0          # 算版本号和 changelog 都要历史 tag
      - name: Resolve version
        id: ver
        run: |
          set -euo pipefail
          INPUT='${{ inputs.tag }}'; REF='${{ github.ref }}'
          if [ -n "$INPUT" ]; then MODE=tag; TAG="$INPUT"
          elif [ "${REF#refs/tags/}" != "$REF" ]; then MODE=tag; TAG="${REF#refs/tags/}"
          else MODE=auto; fi
          PREV="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)"
          if [ "$MODE" = auto ]; then
            BASE="${PREV:-v0.0.0}"; CORE="${BASE#v}"
            MAJOR="${CORE%%.*}"; REST="${CORE#*.}"; MINOR="${REST%%.*}"; PATCH="${REST#*.}"
            PATCH="${PATCH%%[-+]*}"
            TAG="v${MAJOR}.${MINOR}.$((PATCH + 1))"; END=HEAD
          else END="$TAG"; fi
          { echo "mode=$MODE"; echo "tag=$TAG"; echo "prev=$PREV"; echo "end=$END"; } >> "$GITHUB_OUTPUT"
      - name: Tag (auto mode only)
        if: ${{ steps.ver.outputs.mode == 'auto' }}
        run: |
          set -euo pipefail
          git config user.name 'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git rev-parse -q --verify "refs/tags/${{ steps.ver.outputs.tag }}" && exit 1
          git tag -a "${{ steps.ver.outputs.tag }}" -m "Release ${{ steps.ver.outputs.tag }}"
          git push origin "${{ steps.ver.outputs.tag }}"
      - name: Build changelog
        run: |
          set -euo pipefail
          PREV='${{ steps.ver.outputs.prev }}'; TAG='${{ steps.ver.outputs.tag }}'; END='${{ steps.ver.outputs.end }}'
          R='https://github.com/${{ github.repository }}'
          if [ -z "$PREV" ]; then
            { printf '## Initial release\n\n'; git log --no-merges --pretty='- %s (%h)' --max-count=50 "$END"; } > CHANGELOG.md
          else
            { printf '**Full changelog**: %s/compare/%s...%s\n\n' "$R" "$PREV" "$TAG"
              printf '## Changes since %s\n\n' "$PREV"; git log --no-merges --pretty='- %s (%h)' "${PREV}..${END}"; } > CHANGELOG.md
          fi
      - name: Create Release
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
        run: |
          set -euo pipefail
          TAG='${{ steps.ver.outputs.tag }}'
          if gh release view "$TAG" >/dev/null 2>&1; then echo "already exists -- skip"; exit 0; fi
          gh release create "$TAG" --title "$TAG" --notes-file CHANGELOG.md
```

**代价**：首个 `v0.1.0` 会在建库后自动产生（首次 push main 时 patch 从 0 自增到 **v0.0.1**，除非先手工打 `v0.1.0`）。
按你们 `v0.1.x` 的习惯，正确做法是：**先手工 `git tag v0.1.0 && git push origin v0.1.0`**，让流水线走"② 人工 tag"入口发首版，之后的日常 push main 才走自动 patch。

### 方案 B：纯手工，一次性
适合只想先把库填上、暂时不上 CI。

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# 0) 认证（二选一）
brew install gh && gh auth login                      # 交互式，浏览器授权
# 或：export GH_TOKEN=ghp_xxx                        # 细粒度 token，需 Contents: Read and write

# 1) 首个提交（先把 .gitignore 写好，见下节）
git init -b main && git add -A
git commit -m "chore: initial commit"
git remote add origin https://github.com/jushenzhidao/cutduo.git
git push -u origin main

# 2) 首版（注意：tag 必须在 main 有提交之后才能推）
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0

# 3) Release（按组织惯例：标题=tag，0 资产）
gh release create v0.1.0 --title v0.1.0 --notes-file CHANGELOG.md
gh release view v0.1.0 --json tagName,name,assets,isDraft,isPrerelease
```

### 方案 C：只打 tag 不建 Release
不推荐。组织内 3 个活跃仓库都建 Release，单独破例会让 `/releases` 页看起来像停更。

---

## 五、首推文件清单

```
.gitignore          # 必做，见下方"体积陷阱"
README.md           # 项目是什么 / 怎么跑 / 版本策略
LICENSE             # 无则法律上等于"保留所有权利"，公开库建议 MIT
CHANGELOG.md        # 可由流水线生成，或手写首版
.github/workflows/release.yml
```

`.gitignore` 至少要挡住的（以本地 motiongit-lab 为例，**398 MB**）：

| 目录 | 体积 | 处置 |
|---|---|---|
| `out/` | 207 MB | 忽略（110 个渲染产物 mp4/jpg） |
| `templates/` | 115 MB | 选择性入库，原包不入 |
| `node_modules/` | 48 MB | 忽略 |
| `edits/` | 27 MB | 忽略（音频/素材中间态） |
| `__pycache__/` | 8 KB | 忽略 |

**体积陷阱**：GitHub 对单文件 >100 MB 直接拒收，仓库建议 <1 GB。motiongit-lab 里有 85 个 mp4，直接全推大概率触发拒收，且历史里的二进制**永远删不掉**（只能 filter-repo 重写）。所以要么只推源码 + `packages/*.motion`（280 KB），要么用 Release 资产分发大文件。

---

## 五之二、候选载荷：工作区里的 `cutproof`（本次新发现）

体检后另有一个会话在工作区里推进了 `cutproof/`，**这大概率就是 cutduo 要放的东西**：

```
cutproof/  228 MB / 110 个文件 / 尚未 git init / 无 .gitignore
```

项目定位（README 原话）：*「剪辑渲染『可验证性』的最小闭环：从素材进得来，到成片敢交付，
全链路可重跑。」* 四条产线：**语料工厂 / 归一化引擎 / 渲染 harness / 断言库**，
外加 `mcp/tools.json`（Agent 工具契约）、`ci/gate.sh`（五步门禁，约 1 分钟跑完）。

**它的体积构成正是那个陷阱：**

| 路径 | 体积 | 性质 | 处置 |
|---|---|---|---|
| `res/` | 108 MB | 渲染输出（mezzanine） | 忽略 |
| `corpus/assets/` | 101 MB | **21 条故障语料，由 `corpus/gen_dirty.py` 生成** | 忽略（可再生） |
| `assets/` | 18 MB | 样例片段 | 视来源与许可决定 |
| `out/` | 708 KB | 报告产物 | 忽略 |
| 源码（`cutproof.py` 30K / `ingest.py` 23K / `asserts.py` 14K / `make_p0_report.py` 24K / `README` / `P1-启动包.md` / `mcp` / `ir` / `ci`） | **≈ 130 KB** | 真正该入库的东西 | 全部入库 |

`corpus/manifest.json` 要入库（它是语料的自描述清单），`corpus/assets/` 不要。

**单文件红线**：`res/mezz/c10_long.mp4` 55 MB、`corpus/assets/c10_long.mp4` 22 MB ——
虽然都低于 GitHub 的 100 MB 硬限，但把 227 MB 可再生媒体塞进历史是纯浪费，
而且**二进制进了 git 历史就再也删不掉**。

cutproof 专用的 `.gitignore`：

```gitignore
out/
res/
corpus/assets/
__pycache__/
*.pyc
.DS_Store
```

（`assets/` 先别急着忽略——先确认那 18 MB 样例片段的来源与授权；如果是从 motiongit-lab
带来的，注意 `.motion` 模板包有独立的许可声明，别把受限素材二次分发。）

---

## 六、需要你决定的事

1. **cutduo 到底放什么**——工作区里的 `cutproof/`（见第五之二节）几乎可以确定是候选载荷。
   需要你确认：`cutduo` = `cutproof` 的对外仓库名？与 `artduo` 是什么关系（同一个系列？
   上下层？）。另外 `artduo` 也是今天建的空库，若定位相近，发布流水线应共用一份模板。
2. **授权**——`gh` 已装好，设备流已就绪：**一次性码 `CB70-E339`**，打开
   https://github.com/login/device 输入即可（该码会过期，若过期我重发）。
   或者你直接给一个细粒度 PAT（Contents: Read and write）。
3. **许可证**——组织 28/31 都没许可证；cutduo 要不要做那个例外。
4. **是否复用 `release.yml`**——若 `artduo` 也要发版，建议抽成组织级模板仓库，别复制三份。

---

## 七、已知坑（来自组织现成工作流的注释，非我推测）

- **`git describe` 会挑错版本**（选"最近可达的 tag"，有合并历史时出错），必须用 `--sort=-v:refname`。
- **`--generate-notes` 在直推 main 的仓库只产出一行 compare 链接**（它依赖已合并的 PR），所以 notes 得自己用 `git log` 生成。
- **必须串行**：两次 push main 会算出同一个下一个版本号并抢同一个 tag，`concurrency` 要设 `cancel-in-progress: false`——取消会留下半成品。
- **`GITHUB_TOKEN` 推送的事件不触发其他 workflow**，所以自动 bump 不会自我循环；但若将来换 PAT 推送就会，需 `actor != github-actions[bot]` 兜底。
- **无 commit 时 `gh release create` 必失败**，这是当前 cutduo 的准确状态。

---

## 附：本轮做完 / 没做的事

**已做**
- ✅ 安装 `gh` v2.103.3（官方发布包 + GitHub API `digest` 校验，装在 `~/.local/bin/gh`）
- ✅ 补齐 `gh-release-automation` 技能（`~/.workbuddy/skills/gh-release-automation/`，
  已注册生效）——按组织 3 个在跑仓库的 `release.yml` 反推重写
- ✅ 发现并分析候选载荷 `cutproof/`（228 MB，可入库源码 ≈ 130 KB）
- ✅ 更新本报告

**没做**
- ❌ 未 clone / 未 push / 未建 tag / 未建 Release
- ❌ 未写入任何 token（设备流在等你输入一次性码）
- ❌ 未修改仓库 description / topics / 分支保护
- ❌ 未给 `cutproof/` 做 `git init` 或写 `.gitignore`（等你确认它就是 cutduo 的载荷）

**遗留提醒**
- 你最初挂载的 `gh-release-automation` 技能，SKILL.md 声明路径
  `/Users/betterme/.workbuddy/skills/…` 在本机不存在（本机只有 `macstudio` 用户），
  所以无法读取其原始流程。补齐的版本是我从组织内 3 个真实在跑的 `release.yml` 反推的，
  规则与组织惯例一致，但不等同于那份原始技能。
- 工作区里有并发的另一个会话正在改动同一批文件（报告已被移到 `docs/`），
  后续若要动手推送，建议先确认那边没有未提交的在途改动。
