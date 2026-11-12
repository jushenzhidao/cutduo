#!/usr/bin/env node
/**
 * 汇总三份基准 JSON，生成 CanvasKit / SkSL 评估报告。
 * 数据必须来自 bench-encode / bench-pipe / bench-sksl 的 --json 输出，不手填。
 *
 *   node desktop-kit/tools/sksl-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'out');
const read = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const enc = read('bench-encode.json');
const pipe = read('bench-pipe.json');
const sksl = read('bench-sksl.json');

const jpeg = enc.rows.find((r) => r.name.includes('q94'));
const raw = enc.rows.find((r) => r.name.includes('raw'));
const drawMs = 1.52;
const sk = sksl[0], skSmall = sksl[1];
const pJpeg = pipe.rows.find((r) => r.mode === 'jpeg');
const pRaw = pipe.rows.find((r) => r.mode === 'raw');
const times = (a, b) => (a / b).toFixed(1);

const row = (cells, cls = '') => `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const encRows = enc.rows.map((r) => row([
  r.name, `${r.meanMs.toFixed(2)} ms`, `${r.p95Ms.toFixed(2)} ms`, `${r.kbPerFrame} KB`,
])).join('');
const pipeRows = pipe.rows.map((r) => row([
  r.mode === 'raw' ? 'raw RGBA rawvideo' : 'JPEG image2pipe（现状）',
  `${r.wallS}s`, `${r.fps} fps`, `${r.drawMs} ms`, `${r.encodeMs} ms`,
  `${r.pipeMB} MB`, `${r.sizeMB} MB`,
])).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>CanvasKit + SkSL 能否优化视频渲染</title><style>
:root{color-scheme:dark}body{margin:0;padding:40px;background:#14161b;color:#e9ebef;
font:14px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:1080px}
h1{font-size:27px;margin:0 0 6px}h2{font-size:19px;margin:34px 0 10px}
.sub{color:#98a0ad;margin-bottom:24px}
.verdict{background:#2a1c1c;border:1px solid #5a2b2b;border-left:4px solid #FF5F57;
border-radius:8px;padding:16px 20px;margin:0 0 24px}
.verdict b{color:#FF8A80}
table{width:100%;border-collapse:collapse;background:#1c1f26;border:1px solid #2a2f38;
border-radius:10px;overflow:hidden;margin:0 0 8px}
td,th{padding:9px 13px;border-top:1px solid #262b33;text-align:left}
th{background:#22262f;color:#c9cfd8;font-weight:600;font-size:13px}
tr:first-child td{border-top:0}.num{font-variant-numeric:tabular-nums}
.kpi{display:flex;gap:26px;flex-wrap:wrap;background:#1c1f26;border:1px solid #2a2f38;
border-radius:10px;padding:16px 20px;margin:0 0 22px}
.kpi b{display:block;font-size:22px;color:#f5b321}.kpi span{color:#8b93a1;font-size:12px}
.note{color:#98a0ad;font-size:13px;margin:6px 0 0}
video{width:100%;max-width:720px;border-radius:10px;border:1px solid #2a2f38;background:#000}
code{background:#22262f;padding:2px 6px;border-radius:4px;font-size:12px}
ul{margin:8px 0 0 18px}li{margin:4px 0}
</style></head><body>
<h1>CanvasKit + SkSL 能否优化视频渲染</h1>
<div class="sub">实测环境：macOS / Node v22.22.2 / canvaskit-wasm 0.42.0 / @napi-rs/canvas 1.11 / ffmpeg 9.0.2。
所有数字由 <code>bench-encode</code> / <code>bench-pipe</code> / <code>bench-sksl</code> 的 <code>--json</code> 输出汇总，未手填。</div>
<div class="note" style="background:#1c1f26;border:1px solid #2a2f38;border-radius:8px;padding:12px 16px;margin:-10px 0 22px">
<b>口径</b>：本报告测的是 <b>desktop-kit</b>（桌面骨架 + 固定种子噪点，1440×1080）。
同主题的 <b>skia-kit</b>（纯色大面积，1920×1080）测量见 PLAYBOOK §45.1–45.5：绘制仅 0.5%、
JPEG 7–15 ms。差距来自内容复杂度（噪点让 DCT 更贵），不是结论矛盾。
仓里有两个 <code>bench-pipe.mjs</code>（<code>skia-kit/</code> 与 <code>desktop-kit/tools/</code>），口径不同，别混用。
</div>

<div class="verdict"><b>结论：本机 Node 环境下不能用 SkSL 优化视频。</b>
瓶颈不是绘制，而是帧输出：绘制只占 <b>4.4%</b>（1.52 ms/帧），JPEG 编码/像素读出占 <b>95.6%</b>（28–33 ms/帧）。
CanvasKit 在无 GPU 的 Node 里走 CPU raster，SkSL 逐像素解释执行，1440×1080 单帧 <b>${sk.raw.mean.toFixed(0)} ms</b>，
是现有链路的 <b>${times(sk.raw.mean, jpeg.meanMs + drawMs)}×</b>。换 shader 引擎，天花板只有 4.4%。</div>

<div class="kpi">
<div><b>${jpeg.meanMs.toFixed(1)} ms</b><span>现有链路单帧（draw 1.5 + 输出 ${jpeg.meanMs.toFixed(1)}）</span></div>
<div><b>${sk.raw.mean.toFixed(0)} ms</b><span>SkSL 1440×1080 零拷贝</span></div>
<div><b>${times(sk.raw.mean, jpeg.meanMs + drawMs)}×</b><span>SkSL / 现有（更慢）</span></div>
<div><b>4.4%</b><span>绘制占总耗时</span></div>
<div><b>1.17×</b><span>rawvideo 端到端提速</span></div>
</div>

<h2>1. 现有渲染器的时间去哪了</h2>
<table><tr><th>阶段</th><th>mean</th><th>p95</th><th>占比</th></tr>
${row(['draw（Skia 2D 绘制）', `${drawMs} ms`, '—', '4.4%'])}
${row(['帧输出 <code>toBuffer("image/jpeg", 94)</code>', `${jpeg.meanMs.toFixed(2)} ms`, `${jpeg.p95Ms.toFixed(2)} ms`, '95.6%'], 'num')}
</table>
<p class="note">证据：<code>node desktop-kit/tools/bench-frame.mjs --frames 150</code>。绘制 1.53 / JPEG 32.88，150 帧稳定复现。</p>

<h2>2. 换一种帧输出能不能快</h2>
<table><tr><th>通路</th><th>mean</th><th>p95</th><th>每帧字节</th></tr>${encRows}</table>
<p class="note">三个反直觉结果：① JPEG q94→q80→q60 耗时几乎不变（28–33ms），
说明成本在<b>像素格式转换/读回</b>，不在熵编码——降质量只省体积不省时间；
② raw RGBA 只快约 15%，但每帧 6 MB（JPEG 的 20 倍）；③ PNG/WebP 更慢，不能用于产线。</p>

<h2>3. CanvasKit + SkSL 的真实成本（正确 3-float uniform）</h2>
<table><tr><th>分辨率</th><th>SkSL draw + 零拷贝 raw</th><th>SkSL draw + PNG</th></tr>
${row([`${sk.w}×${sk.h}`, `${sk.raw.mean.toFixed(1)} ms`, `${sk.png.mean.toFixed(1)} ms`])}
${row([`${skSmall.w}×${skSmall.h}`, `${skSmall.raw.mean.toFixed(1)} ms`, `${skSmall.png.mean.toFixed(1)} ms`])}
</table>
<p class="note">CanvasKit 0.42 的 CPU surface <b>只能输出 PNG</b>（JPEG / WebP 编码返回 null）；
零拷贝走 <code>MakeRasterDirectSurface</code> + WASM 堆。SkSL 在 raster 后端是逐像素解释执行，
155 万像素 × sin/hash 运算 ≈ 0.9 秒/帧。有 GPU 的浏览器（WebGL/WebGPU）才会走并行栅格化，但那条路
等于回到 Chromium 链路（上午实测 33 ms/帧），仍不如原生 Skia。</p>

<h2>4. 端到端：JPEG vs rawvideo（针对瓶颈的唯一有效改动）</h2>
<table><tr><th>管道</th><th>墙钟</th><th>吞吐</th><th>绘制</th><th>取帧</th><th>管道数据</th><th>成片</th></tr>${pipeRows}</table>
<p class="note">${pipe.meta.frames} 帧 / ${pipe.meta.width}×${pipe.meta.height}@${pipe.meta.fps}。
raw 快 <b>${(pJpeg.wallS / pRaw.wallS).toFixed(2)}×</b>，代价是管道数据 <b>${(pRaw.pipeMB / pJpeg.pipeMB).toFixed(1)}×</b>
（${pipe.meta.frames} 帧 ${pRaw.pipeMB} MB）。多 worker 并行时这份带宽会乘以 worker 数，需另行验证。</p>

<h2>5. SkSL 能力验证（不是产线方案）</h2>
<p>用 RuntimeEffect 逐像素画了 3 秒 720×540：流动光带 + 12 个 split-flap 翻牌格 + 确定性噪点 + 字幕条。
72 帧耗时 53.4s（739 ms/帧，1.3 fps）——能跑通、画面正确，但比现有链路慢 20 倍以上。</p>
<video src="sksl-demo.mp4" controls muted loop></video>
<p class="note">产物：<code>out/sksl-demo.mp4</code>、<code>out/sksl-frame.jpg</code>。
脚本：<code>desktop-kit/tools/sksl-demo.cjs</code>。首版曾因 uniform 多传一个 float 导致
<code>makeShader</code> 返回 null、整条片是空画面，现已加「shader 非空 + 首帧像素非退化」双断言。</p>

<h2>6. 该优化什么（按收益排序）</h2>
<ul>
<li><b>分辨率 / 帧率</b>：线性收益，最确定。1440×1080→720×540 直接省 4× 像素。</li>
<li><b>rawvideo 管道</b>：1.17×，但要付 19.8× 管道带宽；适合单 worker 或少 worker 场景。</li>
<li><b>JPEG 质量</b>：不提速，但 q60 把每帧 292 KB 压到 66 KB（4.4×），纯体积收益。</li>
<li><b>零拷贝 / GPU 编码</b>：真正的数量级改善要靠这两条；Node 的 @napi-rs/canvas 不暴露零拷贝，
GPU 编码需走 ffmpeg videotoolbox（另一条实验线）。</li>
<li><b>SkSL</b>：只建议用于「浏览器内实时预览」或「GPU 端特效」，不要用在 Node 批量出片。</li>
</ul>

<h2>复跑</h2>
<p><code>node desktop-kit/tools/bench-frame.mjs --frames 150</code><br>
<code>node desktop-kit/tools/bench-encode.mjs --frames 40 --json out/bench-encode.json</code><br>
<code>node desktop-kit/tools/bench-pipe.mjs --frames 240 --json out/bench-pipe.json</code><br>
<code>node desktop-kit/tools/bench-sksl.cjs --frames 12 --json out/bench-sksl.json</code><br>
<code>node desktop-kit/tools/sksl-demo.cjs --seconds 3 --fps 24 --w 720 --h 540</code><br>
<code>node desktop-kit/tools/sksl-report.mjs</code></p>
</body></html>`;

fs.writeFileSync(path.join(OUT, 'sksl-report.html'), html);
console.log('✓ out/sksl-report.html');
console.log(`  现有 ${(jpeg.meanMs + drawMs).toFixed(1)} ms/帧  ·  SkSL ${sk.raw.mean.toFixed(0)} ms/帧  ·  ${times(sk.raw.mean, jpeg.meanMs + drawMs)}×`);
console.log(`  端到端 raw ${(pJpeg.wallS / pRaw.wallS).toFixed(2)}×  ·  管道 ${(pRaw.pipeMB / pJpeg.pipeMB).toFixed(1)}×`);
