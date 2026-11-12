# bench · 一次性基准与探针

历史实验脚本，不是产线入口。产线入口在 `desktop-kit/`、`skia-kit/` 与 `content/`。

## 运行方式（重要）

脚本用 `process.cwd()` 解析 `assets/fonts`、`edits/inputs-md.json`，**必须从仓库根运行**：

```bash
cd motiongit-lab
node bench/bench-enc.mjs
node bench/probe-kit.mjs
bash bench/bench-limit.sh
```

两个 shell 已改成 `cd "$(dirname "$0")/.."`，自身会回到仓库根；JS 脚本不会，必须手动在根执行。
ESM 的 `../skia-kit/paper.mjs` 不受位置影响（`motiongit-lab/skia-kit` 存在）。

## 清单（19）

| 类别 | 文件 | 回答什么问题 |
|---|---|---|
| 成本 | `bench-draw.mjs` | 绘制成本（含 JPEG/PNG 编码） |
| 成本 | `bench-enc.mjs` | 只测编码：同帧推 300 次 |
| 成本 | `bench-pipe.mjs` | JPEG 中间帧 vs RAW 直供 |
| 成本 | `bench-ffmpeg.py` | 编码档位耗时/体积/PSNR |
| 并发 | `bench-limit.sh` | worker 数 / 峰值内存极限 |
| 并发 | `bench-three.sh` | 串行 / 4 路 / 8 路对比 |
| 并发 | `mem-monitor.py` | 进程树 RSS 峰值 |
| 并发 | `proc-args.py` | 进程参数/环境读取 |
| 探针 | `cankit-probe.mjs` | CanvasKit / SkSL 三问 |
| 探针 | `grain-probe.mjs` | SkSL 烘颗粒 tile 的成本 |
| 探针 | `probe-kit.mjs` | 按分镜中点抽帧成 PNG |
| 探针 | `profile-chrome.mjs` | Chrome 逐帧截图路径对比 |
| 探针 | `profile-engines.mjs` | Chromium / WebKit / Firefox 对比 |
| 拼图 | `mk-compare.mjs` | 四管线同点对比（需 `/tmp/cmp/*.jpg`） |
| 拼图 | `mk-compare-skia.mjs` | 三版 Skia 对比 |
| 拼图 | `mk-label.mjs` | 批量打标签 |
| 截图 | `shot.mjs` / `shot2.mjs` | Playwright 截 HTML 报告 |
| 字体 | `font-metrics.mjs` | 三字重实测字宽与墨迹边界 |

## 已修的可移植性问题（2026-11-12）

- `bench-draw.mjs`：3 处硬编码绝对路径 → 相对 import + cwd 相对路径；
- `bench-limit.sh` / `bench-three.sh`：`cd $(dirname)` → `cd $(dirname)/..`；
- `probe-kit.mjs`：`./skia-kit` → `../skia-kit`。

移动后验证：全部 `node --check` / `bash -n` / `py_compile` 通过，`probe-kit` 与 `bench-draw` 实跑出结果。
