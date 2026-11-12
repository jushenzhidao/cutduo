// Skia Canvas 无浏览器渲染基准（对照 Chromium 截图）
// 依赖: npm i @napi-rs/canvas
// 用法: node canvas-bench.js
// 实测（Apple M5 Ultra）：draw + JPEG(94) ≈ 13.2ms/帧；draw + PNG ≈ 210ms/帧
const { createCanvas } = require('@napi-rs/canvas');

const W = 1920, H = 1080;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
const FONT = '-apple-system, "PingFang SC", sans-serif';

function draw(t) {
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

const N = 120;
for (let i = 0; i < 10; i++) { draw(i); canvas.toBuffer('image/jpeg', 94); }

let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { draw(i); canvas.toBuffer('image/jpeg', 94); }
const jpegMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

t0 = process.hrtime.bigint();
for (let i = 0; i < 30; i++) { draw(i); canvas.toBuffer('image/png'); }
const pngMs = Number(process.hrtime.bigint() - t0) / 1e6 / 30;

console.log(`Skia Canvas ${W}×${H}`);
console.log(`  draw + JPEG(94): ${jpegMs.toFixed(2)} ms/frame`);
console.log(`  draw + PNG:      ${pngMs.toFixed(2)} ms/frame`);
