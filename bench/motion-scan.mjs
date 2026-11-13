#!/usr/bin/env node
/**
 * bench/motion-scan.mjs · 量"画面横向移动速度"（px/s），用来给滚动类镜头定标
 *
 *   node bench/motion-scan.mjs video <file.mp4> <t0> <t1> [fps=10]
 *   node bench/motion-scan.mjs kit   <params> <t0> <t1> [fps=10]
 *
 * 原理：把每帧压成一条**列亮度剖面**，相邻两帧做互相关，取使 SSD 最小的平移量 dx。
 * 对一个横向滑动的卡片，dx 就是它的位移；对静止画面 dx=0。
 * 单帧看不出速度——速度是二阶量，必须成对比较，这也是「抽中段单帧」永远漏掉它的原因。
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE_W = 480;
const MAX_SHIFT = 90; // 剖面宽度下的最大搜索位移（≈0.19 屏/帧@10fps 上限 1.9 屏/秒）

function profile(gray, w, h) {
  const col = new Float32Array(PROFILE_W);
  const sx = w / PROFILE_W;
  for (let x = 0; x < PROFILE_W; x++) {
    let s = 0;
    for (let y = 0; y < h; y += 2) s += gray[y * w + Math.min(w - 1, Math.floor(x * sx))];
    col[x] = s / (h / 2);
  }
  return col;
}

function bestShift(a, b) {
  let best = 0;
  let bestErr = Infinity;
  for (let d = -MAX_SHIFT; d <= MAX_SHIFT; d++) {
    let err = 0;
    let n = 0;
    for (let x = 0; x < PROFILE_W; x++) {
      const j = x + d;
      if (j < 0 || j >= PROFILE_W) continue;
      const e = a[x] - b[j];
      err += e * e;
      n++;
    }
    if (n < PROFILE_W * 0.5) continue;
    err /= n;
    // 位移越大越可能是伪匹配：加一点先验惩罚，避免纹理周期造成的跳变
    const cost = err * (1 + Math.abs(d) * 0.0015);
    if (cost < bestErr) { bestErr = cost; best = d; }
  }
  return best;
}

async function scanFrames(frames, fps) {
  const rows = [];
  let prev = null;
  for (const f of frames) {
    const img = await loadImage(f);
    const c = createCanvas(img.width, img.height);
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    const gray = new Uint8ClampedArray(img.width * img.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    const p = profile(gray, img.width, img.height);
    if (prev) {
      const dx = bestShift(prev, p) * (img.width / PROFILE_W);
      rows.push({ t: 0, v: dx * fps });
    }
    prev = p;
  }
  return rows;
}

const [mode, target, t0s, t1s, fpss] = process.argv.slice(2);
const t0 = Number(t0s || 0);
const t1 = Number(t1s || 8);
const fps = Number(fpss || 10);

let frames = [];
let times = [];
if (mode === 'video') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mscan-'));
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t0), '-t', String(t1 - t0), '-i', target,
    '-vf', `fps=${fps},scale=960:-1`, '-q:v', '2', path.join(dir, 'f%04d.jpg')], { stdio: 'inherit' });
  frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
  times = frames.map((_, i) => t0 + i / fps);
} else {
  const { registerFonts } = await import('../src/fonts.mjs');
  const { createCollageRenderer } = await import('../kits/collage/collage.mjs');
  registerFonts();
  const P = JSON.parse(fs.readFileSync(target, 'utf8'));
  const cv = createCanvas(1920, 1080);
  const ctx = cv.getContext('2d');
  const r = createCollageRenderer({ canvas: cv, ctx, width: 1920, height: 1080, fps: 60 });
  r.setContent({ scenes: P.scenes, brand: P.brand });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mscan-'));
  const n = Math.round((t1 - t0) * fps);
  for (let i = 0; i <= n; i++) {
    const t = t0 + i / fps;
    r.renderFrame(t);
    const p = path.join(dir, `f${String(i).padStart(4, '0')}.jpg`);
    fs.writeFileSync(p, cv.toBuffer('image/jpeg', 92));
    frames.push(p);
    times.push(t);
  }
}

const rows = await scanFrames(frames, fps);
const v = (r) => Math.round(r.v);
const moving = rows.filter((r) => Math.abs(r.v) > 200);
console.log(`# ${mode} ${path.basename(target)}  ${t0}–${t1}s @${fps}fps`);
console.log(rows.map((r, i) => `${(times[i + 1]).toFixed(1)}s ${String(v(r)).padStart(6)} px/s`).join('\n'));
if (moving.length) {
  const speeds = moving.map((r) => Math.abs(r.v)).sort((a, b) => a - b);
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  console.log(`\n移动帧 ${moving.length}/${rows.length} · 均值 ${Math.round(mean)} px/s · 峰值 ${Math.round(speeds[speeds.length - 1])} px/s · P90 ${Math.round(speeds[Math.floor(speeds.length * 0.9)])} px/s`);
} else {
  console.log('\n几乎无横向位移');
}
