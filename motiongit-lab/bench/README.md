# bench · 一次性基准与探针

这里放**历史实验脚本**，不是产线入口。产线入口在 `desktop-kit/` 与 `content/`。

## 运行方式（重要）

这些脚本用 `process.cwd()` 解析 `assets/fonts`、`edits/inputs-md.json`，**必须从仓库根运行**：

```bash
cd motiongit-lab
node bench/bench-enc.mjs
node bench/grain-probe.mjs
node bench/font-metrics.mjs
```

在 `bench/` 里直接 `node xxx.mjs` 会报找不到字体/输入。ESM 的 `../skia-kit/paper.mjs` 不受影响
（根目录软链与 `motiongit-lab/skia-kit` 指向同一处）。

## 清单

| 文件 | 回答什么问题 | 预期输出 |
|---|---|---|
| `font-metrics.mjs` | 900/800/700 三个字重的实测字宽与墨迹边界（原名 `t.mjs`） | 控制台数字 |
| `bench-enc.mjs` | 只测编码：同一帧推 300 次，排除绘制与 JPEG | 编码耗时/体积 |
| `grain-probe.mjs` | SkSL 烘一颗颗粒 tile 再平铺的成本 | `/tmp/grain-on.png`、`/tmp/grain-off.png` + 毫秒数 |

## 为什么只搬了三个

其余基准有硬性阻碍，见 `../AGENTS.md` §4：

- `bench-draw.mjs`：硬编码绝对路径，移动或换机器即断；
- `bench-limit.sh` / `bench-three.sh`：`cd "$(dirname "$0")"`，移动后相对路径全断；
- `profile-*` / `shot*`：依赖 `process.cwd()` 且被文档多处引用；
- `canvas-editorial.mjs` / `render-*.{mjs,py}`：它们是渲染引擎，不是一次性脚本，不该进 `bench/`。

结论：**先修依赖，再移动**。每次不超过 5 个文件，移动后跑一次探针 + `verify.mjs`。
