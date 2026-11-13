#!/usr/bin/env node
/**
 * replica-captions.mjs — 从成片反推字幕元素（区间 + 文案图）
 *
 * 用法:
 *   node tools/replica-captions.mjs --video ref.mp4 --out out/x/caps            # 只出区间与条带图
 *   node tools/replica-captions.mjs --video ref.mp4 --out out/x/caps --from caps.json  # 用人工读出的文案生成参数
 *
 * 原理：字幕是烧录的静态文本，同一句内相邻帧的字幕带几乎不变；
 * 换句/淡入淡出时字幕带 MAE 会出现尖峰。按尖峰切区间，再取区间中段出条带图供人工/OCR 读文案。
 * 不依赖 OCR：本机没有可靠中文 OCR，条带图由人读，读出的文案写进 caps.json 再回填。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const VIDEO = arg('video');
const OUT = path.resolve(arg('out', 'out/replica-caps'));
const W = Number(arg('w', 568));
const H = Number(arg('h', 320));
const FROM = arg('from', null);
if (!VIDEO) { console.error('用法: node tools/replica-captions.mjs --video ref.mp4 --out dir'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const FRAME = W * H * 3;
const BAND_Y0 = Math.round(H * 0.8);   // 字幕带起点（含淡入淡出）
const bandH = H - BAND_Y0;

function reader(video) {
  const p = spawn(FFMPEG, ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}:flags=lanczos,fps=30`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0); const waiters = []; const ready = []; let closed = false;
  p.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= FRAME) {
      const f = Buffer.from(buf.subarray(0, FRAME)); buf = buf.subarray(FRAME);
      const w = waiters.shift(); if (w) w(f); else ready.push(f);
    }
  });
  p.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return { next: () => new Promise((res) => (ready.length ? res(ready.shift()) : closed ? res(null) : waiters.push(res))) };
}

const ink = (buf) => {
  let n = 0;
  for (let y = BAND_Y0; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const i = (y * W + x) * 3, j = (y * W + x - 1) * 3;
      const l = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
      const lp = 0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2];
      if (l > 190 && Math.abs(l - lp) > 26) n++;
    }
  }
  return n;
};
const bandMae = (a, b) => {
  let s = 0, n = 0;
  for (let y = BAND_Y0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3;
  }
  return s / n;
};

if (FROM) {
  // 第二遍：把人工读出的文案与区间合并成 captions
  const caps = JSON.parse(fs.readFileSync(FROM, 'utf8'));
  for (const c of caps) {
    if (!c.text) throw new Error(`区间 ${c.start}-${c.end} 还没有文案`);
  }
  fs.writeFileSync(path.join(OUT, 'captions.json'), JSON.stringify(caps, null, 2));
  console.log(`captions.json 已写入，共 ${caps.length} 条`);
  process.exit(0);
}

const R = reader(VIDEO);
const inks = [];
const frames = [];
const maes = [];
let prev = null;
const keep = [];   // 每 0.2s 留一帧做条带图
let idx = 0;
for (;;) {
  const f = await R.next();
  if (!f) break;
  inks.push(ink(f));
  maes.push(prev ? bandMae(prev, f) : 0);
  prev = f;
  idx++;
}
// 区间：ink 过阈值
const ON = 120;
const spans = [];
let cur = null;
for (let i = 0; i < inks.length; i++) {
  const on = inks[i] > ON;
  if (on && cur === null) cur = { s: i, e: i };
  else if (on) cur.e = i;
  else if (cur) { spans.push(cur); cur = null; }
}
if (cur) spans.push(cur);
// 合并间隔 < 0.12s 的（淡入淡出的空档不算换句）
const merged = [];
for (const sp of spans) {
  const last = merged[merged.length - 1];
  if (last && (sp.s - last.e) / 30 < 0.12) last.e = sp.e;
  else merged.push({ ...sp });
}

// 区间内部换句：字幕带两帧差异出现尖峰即切（静态句之间差异≈0，换句必然跳）
// 换句的判据不是差分尖峰（淡入淡出把差分摊平到多帧），而是**墨迹谷**：
// 句间必然淡出到接近 0，用区间内墨迹中位数的一半做谷底阈值最稳。
const pieces = [];
for (const sp of merged) {
  const vals = [];
  for (let i = sp.s; i <= sp.e; i++) vals.push(inks[i]);
  const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const thr = med * 0.45;
  let s = sp.s;
  let i = sp.s + 3;
  while (i <= sp.e - 3) {
    if (inks[i] < thr && inks[i + 1] < thr) {
      let j = i;
      while (j <= sp.e - 3 && inks[j] < thr) j++;
      if (j - i >= 2 && i - s > 6 && sp.e - j > 6) { pieces.push({ s, e: i - 1 }); s = j; }
      i = j;
    } else i++;
  }
  pieces.push({ s, e: sp.e });
}
const list0 = pieces.filter((p) => p.e - p.s > 6);

const stamp = (i) => `${(i / 30).toFixed(2)}`;
const list = list0.map((sp) => ({
  start: +stamp(sp.s), end: +stamp(sp.e + 1),
  mid: +((sp.s + sp.e) / 2 / 30).toFixed(2),
  // 区间内的"内部切换"尖峰（同一区间里换句）
  cuts: maes.map((m, i) => ({ i, m })).filter((o) => o.i > sp.s + 2 && o.i < sp.e - 2 && o.m > 6).map((o) => +stamp(o.i)),
}));

// 条带图：每条字幕一行，时间戳在左侧
const rowsImg = [];
for (const c of list) {
  const file = path.join(OUT, `strip_${c.mid.toFixed(2).replace('.', '_')}.png`);
  execFileSync(FFMPEG, ['-v', 'error', '-ss', String(c.mid), '-i', VIDEO,
    '-frames:v', '1', '-vf', `crop=${W}:${bandH}:0:${BAND_Y0}`, '-y', file]);
  rowsImg.push({ ...c, file });
}
const SH = bandH + 22;
const sheet = createCanvas(W + 130, SH * rowsImg.length);
const g = sheet.getContext('2d');
g.fillStyle = '#101010'; g.fillRect(0, 0, sheet.width, sheet.height);
g.font = '600 15px monospace';
for (let i = 0; i < rowsImg.length; i++) {
  const im = await loadImage(rowsImg[i].file);
  g.drawImage(im, 130, i * SH);
  g.fillStyle = '#7CFCBA';
  g.fillText(`${rowsImg[i].start}s`, 6, i * SH + 16);
  g.fillText(`#${i}`, 6, i * SH + 34);
  g.fillStyle = '#333'; g.fillRect(0, (i + 1) * SH - 1, sheet.width, 1);
}
fs.writeFileSync(path.join(OUT, 'captions-sheet.png'), sheet.toBuffer('image/png'));
fs.writeFileSync(path.join(OUT, 'spans.json'), JSON.stringify(list, null, 2));
console.log(`检出 ${list.length} 条字幕区间 → ${path.join(OUT, 'spans.json')}`);
for (const c of list) console.log(`  ${c.start}–${c.end}s  内部切点:${c.cuts.length ? c.cuts.join(',') : '无'}`);
console.log('条带总图 →', path.join(OUT, 'captions-sheet.png'));
