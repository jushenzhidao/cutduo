// Skia Canvas 多线程并行基准（worker_threads）
// 依赖: npm i @napi-rs/canvas
// 用法: node canvas-bench-parallel.js
// 与 canvas-bench.js 使用同一套绘制内容，便于横向对比。
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const W = 1920, H = 1080;
const FONT = '-apple-system, "PingFang SC", sans-serif';

function draw(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#F7F7F5');
  g.addColorStop(1, '#E9EEF8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 240) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 240) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  ctx.fillStyle = '#0A0A0A';
  ctx.font = `700 150px ${FONT}`;
  ctx.fillText('先讲清楚', 146, 380 + Math.sin(t) * 10);
  ctx.fillStyle = '#2462EA';
  ctx.fillText('再讲漂亮', 146, 560);

  const items = ['结论', '证据', '例子'];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(146 + i * 420, 700, 380, 170);
    ctx.fillStyle = '#0A0A0A';
    ctx.font = `500 42px ${FONT}`;
    ctx.fillText(items[i], 180 + i * 420, 790);
  }

  ctx.fillStyle = 'rgba(16,20,34,0.9)';
  ctx.fillRect(660, 960, 600, 70);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 36px ${FONT}`;
  ctx.fillText('字幕示例', 760, 1006);
}

if (!isMainThread) {
  const { createCanvas } = require('@napi-rs/canvas');
  const { frames, warm } = workerData;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < warm; i++) { draw(ctx, i); canvas.toBuffer('image/jpeg', 94); }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < frames; i++) { draw(ctx, i); canvas.toBuffer('image/jpeg', 94); }
  parentPort.postMessage({ ms: Number(process.hrtime.bigint() - t0) / 1e6, frames });
} else {
  const TOTAL = 240;
  console.log(`\nSkia Canvas 并行扩展（每组总帧数 ${TOTAL}，1920×1080，draw + JPEG 94）`);
  (async () => {
    for (const n of [1, 2, 4, 8]) {
      const per = Math.ceil(TOTAL / n);
      const t0 = Date.now();
      const results = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
        const w = new Worker(__filename, { workerData: { frames: per, warm: 3 } });
        w.once('message', resolve);
        w.once('error', reject);
      })));
      const wall = Date.now() - t0;
      const frames = per * n;
      const cpu = results.reduce((a, r) => a + r.ms, 0) / 1000;
      console.log(`  ${String(n).padStart(2)} worker: wall ${String(wall).padStart(5)}ms / ${frames} 帧 → `
        + `${(wall / frames).toFixed(2)}ms/帧 · ${(frames / (wall / 1000)).toFixed(0)} fps · `
        + `CPU 合计 ${cpu.toFixed(1)}s（加速比 ${(cpu / (wall / 1000)).toFixed(2)}×）`);
    }
  })();
}
