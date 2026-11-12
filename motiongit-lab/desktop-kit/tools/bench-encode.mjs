#!/usr/bin/env node
/**
 * 帧输出通路微基准：找出渲染器真正的瓶颈，判断 SkSL / 换引擎值不值。
 *
 *   node desktop-kit/tools/bench-encode.mjs [--frames 60]
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCanvas } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, loadTokens } from '../desktop.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KIT = path.resolve(HERE, '..');
const ROOT = path.resolve(KIT, '..');
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(get('frames', 60));
const T = loadTokens();

registerFonts(path.join(ROOT, 'assets', 'fonts'));
const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'md.json'), 'utf8'));
const c = createCanvas(T.width, T.height), g = c.getContext('2d');
const r = createDesktopRenderer({ ctx: g });
r.setContent(P);

const JSON_OUT = get('json', null);
const MODES = [
  ['jpeg q94（现状）', () => c.toBuffer('image/jpeg', 94)],
  ['jpeg q80', () => c.toBuffer('image/jpeg', 80)],
  ['jpeg q60', () => c.toBuffer('image/jpeg', 60)],
  ['webp q94', () => c.toBuffer('image/webp', 94)],
  ['webp q80', () => c.toBuffer('image/webp', 80)],
  ['png', () => c.toBuffer('image/png')],
  ['raw RGBA (getImageData)', () => g.getImageData(0, 0, T.width, T.height).data],
];
const rows = [];

for (const [name, fn] of MODES) {
  try {
    for (let i = 0; i < 4; i++) { r.renderFrame(i / 60); fn(); }
    const xs = [], sizes = [];
    for (let i = 0; i < N; i++) {
      r.renderFrame((i / 60) % 10);
      const a = performance.now();
      const b = fn();
      xs.push(performance.now() - a);
      sizes.push(b.length || b.byteLength || 0);
    }
    xs.sort((a, b) => a - b);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const row = { name, meanMs: Number(mean.toFixed(2)), p95Ms: Number(xs[Math.floor(N * .95)].toFixed(2)),
      kbPerFrame: Math.round(sizes[0] / 1024) };
    rows.push(row);
    console.log(`${row.name.padEnd(24)} ${row.meanMs.toFixed(2).padStart(7)} ms   p95 ${row.p95Ms.toFixed(2).padStart(6)}   ${String(row.kbPerFrame).padStart(6)} KB/帧`);
  } catch (e) { console.log(`${name.padEnd(24)} ERR ${String(e.message).slice(0, 90)}`); }
}
if (JSON_OUT) fs.writeFileSync(path.resolve(JSON_OUT),
  JSON.stringify({ meta: { width: T.width, height: T.height, frames: N, jpeg: 94 }, rows }, null, 2));
