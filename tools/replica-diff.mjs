#!/usr/bin/env node
/**
 * replica-diff.mjs — 逐帧差分流（复刻验收的仪表）
 *
 * 把参考片与复刻片都解到同一尺寸的 rgb24 裸帧，逐帧一起读，输出：
 *   mae      全帧平均绝对误差（0–255）
 *   capInk   字幕白字像素数（底部 18% 带）—— 用来对齐字幕时序，不靠眼睛
 *   l/r/b    左中右三分区 MAE —— 定位差异落在文字区还是人物区
 *
 *   node tools/replica-diff.mjs --ref a.mp4 --rep b.mp4 --out out/x/diff.json
 *
 * 输出只有 JSON，不做图；要看图用 tools/replica-compare.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const REF = arg('ref');
const REP = arg('rep');
const OUT = path.resolve(arg('out', 'out/replica-diff.json'));
const W = Number(arg('w', 568));
const H = Number(arg('h', 320));
const EVERY = Number(arg('every', 1));
if (!REF || !REP) {
  console.error('用法: node tools/replica-diff.mjs --ref a.mp4 --rep b.mp4 [--out diff.json] [--every 1]');
  process.exit(2);
}

const FRAME = W * H * 3;

function reader(video) {
  const p = spawn(FFMPEG, [
    '-v', 'error', '-i', video,
    '-vf', `scale=${W}:${H}:flags=lanczos,fps=30`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  const fns = [];
  let closed = false;
  p.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= FRAME) {
      const f = Buffer.from(buf.subarray(0, FRAME));
      buf = buf.subarray(FRAME);
      const fn = fns.shift();
      if (fn) fn(f); else pending.push(f);
    }
  });
  const pending = [];
  p.on('close', () => { closed = true; while (fns.length) fns.shift()(null); });
  return {
    next() {
      return new Promise((res) => {
        if (pending.length) return res(pending.shift());
        if (closed) return res(null);
        fns.push(res);
      });
    },
  };
}

const rows = [];
/**
 * 字幕墨迹 = 底部带内「高亮度 + 有明显梯度」的像素数。
 * 只判亮度会把封面那条白底横条算成字幕（实测误报 2 万+），必须叠梯度条件：
 * 白字芯的左右邻域必有深色描边，纯白块的梯度接近 0。
 */
const capInk = (buf) => {
  let n = 0;
  const y0 = Math.round(H * 0.82);
  for (let y = y0; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const i = (y * W + x) * 3;
      const j = (y * W + x - 1) * 3;
      const l = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
      const lp = 0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2];
      if (l > 190 && Math.abs(l - lp) > 26) n++;
    }
  }
  return n;
};

const A = reader(REF);
const B = reader(REP);
let idx = 0;
for (;;) {
  const [fa, fb] = [await A.next(), await B.next()];
  if (!fa || !fb) break;
  if (idx % EVERY === 0) {
    let sum = 0;
    const region = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      const band = y < H / 3 ? 0 : y < (2 * H) / 3 ? 1 : 2;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const d = Math.abs(fa[i] - fb[i]) + Math.abs(fa[i + 1] - fb[i + 1]) + Math.abs(fa[i + 2] - fb[i + 2]);
        sum += d;
        region[band] += d;
      }
    }
    rows.push({
      f: idx, t: +(idx / 30).toFixed(3),
      mae: +(sum / (W * H * 3)).toFixed(3),
      r: [+(region[0] / (W * H / 3 * 3)).toFixed(2), +(region[1] / (W * H / 3 * 3)).toFixed(2), +(region[2] / (W * H / 3 * 3)).toFixed(2)],
      capA: capInk(fa), capB: capInk(fb),
    });
  }
  idx++;
}

const maes = rows.map((r) => r.mae).sort((a, b) => a - b);
const pct = (p) => maes[Math.min(maes.length - 1, Math.floor(maes.length * p))];
const report = {
  ref: REF, rep: REP, frames: idx, size: [W, H],
  summary: {
    maeAvg: +(rows.reduce((s, r) => s + r.mae, 0) / rows.length).toFixed(3),
    maeP50: +pct(0.5).toFixed(3), maeP90: +pct(0.9).toFixed(3), maeP99: +pct(0.99).toFixed(3), maeMax: +maes[maes.length - 1].toFixed(3),
  },
  worst: [...rows].sort((a, b) => b.mae - a.mae).slice(0, 15),
  rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report));

// 控制台只给结论，不给 2215 行
console.log(`帧数 ${idx} | MAE 均值 ${report.summary.maeAvg} / p50 ${report.summary.maeP50} / p90 ${report.summary.maeP90} / max ${report.summary.maeMax}`);
console.log('最差 15 帧：');
for (const w of report.worst) console.log(`  t=${w.t.toFixed(2)}s  mae=${w.mae}  分区=${w.r.join('/')}  字幕墨迹 ref=${w.capA} rep=${w.capB}`);
console.log('明细 →', OUT);
