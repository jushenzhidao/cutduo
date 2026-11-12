#!/usr/bin/env node
/**
 * 单帧耗时分解：draw / JPEG 编码 / 像素写出。
 * 判断「SkSL 优化有没有意义」的前提——若瓶颈不在绘制，换 shader 引擎不会带来收益。
 *
 *   node desktop-kit/tools/bench-frame.mjs [--params <json>] [--frames 120] [--jpeg 94]
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCanvas } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, loadTokens, DEFAULT_TOKENS } from '../desktop.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KIT = path.resolve(HERE, '..');
const ROOT = path.resolve(KIT, '..');
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const paramsPath = path.resolve(get('params', path.join(KIT, 'presets', 'md.json')));
const N = Number(get('frames', 120));
const JPEG = Number(get('jpeg', 94));
const T = loadTokens();

registerFonts(path.join(ROOT, 'assets', 'fonts'));
const P = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
const canvas = createCanvas(T.width, T.height);
const ctx = canvas.getContext('2d');
const r = createDesktopRenderer({ ctx });
r.setContent(P);

const draw = [], enc = [], bytes = [];
for (let i = 0; i < 10; i++) { r.renderFrame(i / 60); ctx.canvas.toBuffer('image/jpeg', JPEG); }
for (let i = 0; i < N; i++) {
  const t = (i / 60) % (P.durationSeconds || 46.983);
  const a = performance.now();
  r.renderFrame(t);
  const b = performance.now();
  const buf = canvas.toBuffer('image/jpeg', JPEG);
  const c = performance.now();
  draw.push(b - a); enc.push(c - b); bytes.push(buf.length);
}
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)], min: s[0], max: s.at(-1) };
};
const ms = (o) => `mean ${o.mean.toFixed(2)} / p50 ${o.p50.toFixed(2)} / p95 ${o.p95.toFixed(2)} / max ${o.max.toFixed(2)}`;
const ds = stat(draw), es = stat(enc);
const total = ds.mean + es.mean;
console.log(`params  ${path.relative(ROOT, paramsPath)}   ${T.width}x${T.height}  ${N} 帧  jpeg=${JPEG}`);
console.log(`draw    ${ms(ds)} ms   ${(ds.mean / total * 100).toFixed(1)}%`);
console.log(`jpeg    ${ms(es)} ms   ${(es.mean / total * 100).toFixed(1)}%`);
console.log(`合计/帧 ${total.toFixed(2)} ms   理论吞吐 ${(1000 / total).toFixed(0)} fps (单线程)`);
console.log(`帧字节  ${(bytes.reduce((a, b) => a + b, 0) / bytes.length / 1024).toFixed(0)} KB`);
