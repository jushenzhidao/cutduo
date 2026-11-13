# 02 · 换宿主（rehost）· 借它的渲染器

**一句话**：模板源码不动，只把「谁跑它」从 Chromium 换成 Skia（`@napi-rs/canvas`）。
省掉浏览器，不省它的绘制逻辑。

## 两条判据（缺一不可）

1. **源码可读**：`protection: open`。`protected` 是 AES-256-GCM 密文，换宿主需要源码 ⇒ 不做。
2. **引擎是 Canvas2D**：没有 `src/dom.js`，`createElement` 只出现 `'canvas'`
   （`createElement('div'/'img')` 就不是 Canvas2D 了）。

```bash
cd motiongit-lab
node bench/motion-host/check-hostable.mjs          # 扫 templates/vendor 下全部模板
node bench/motion-host/check-hostable.mjs --json   # 同上，输出 JSON
```

## 现有实例

| 模板 | 实测 | 备注 |
|---|---|---|
| `refs/vendor/mac-desktop/` | 24 worker **480 fps**（官方 55 fps 的 8.7×） | 目前换宿主最优的一个 |
| `refs/vendor/knowledge-explainer-sketchnote/` | 通用图解 **184 fps**；手绘 native 单核 **14 fps** | 判据脚本现标 ✗（6 处非 canvas `createElement`），实测是 iframe / script / 进度条 div / video 四条**未被内容触达**的路径，实际可换 |
| **`kits/clay/`** | 2100 帧 / 70s / **8.0s（262 fps）** / 1.89MB | 2026-11-13 落地。上游 `native-python-node/1`，但绘制层是纯 Canvas2D，**原样跑 `native-clay.js`**，只接管 window / 字体 / 背景 / 段边界。见 `kits/clay/README.md` |

sketchnote 的手绘 native 族单核只有 14 fps（每帧上万次绘制 + 逐笔记账），**必须多进程才划算**：
12 worker 138.9 fps，比 Chrome 8 实例的 32.9 fps 快 4.2×。

## 落点与脚本

- 模板：`refs/vendor/<name>/`（**原封不动**）
- 宿主 shim：`motiongit-lab/bench/motion-host/<name>-host.mjs`
- 单帧探针：`bench/motion-host/poc-<name>.mjs`
- 整片：`bench/motion-host/render-*-<name>.mjs`

```bash
cd motiongit-lab
node bench/motion-host/poc.mjs comments 1.2                             # mac-desktop 单帧
node bench/motion-host/render-parallel.mjs --workers 24 --limit 600     # 分片整片
```

## 三条铁律

1. **别拿换宿主当性能手段**：省的是 Chromium 依赖与可定制性，不是时间；
   重绘制型模板单核反而更慢（sketchnote 手绘 70.4ms vs Chrome 24.03ms）。
2. **能白拿的只有两处**：关掉模板自带审计/记账链路（约 1.3×）、缓存每帧重复绘制的静态层（约 20%）。
3. **多进程是最后手段**，只对纯 JS 计算型模板有效；Chrome 多实例在重绘制场景几乎不扩展。
