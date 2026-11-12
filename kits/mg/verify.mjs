#!/usr/bin/env node
/**
 * 纯函数 / 分片边界验证：
 *   同一帧号，在「按序渲染」与「乱序渲染」两种调用顺序下，PNG 字节必须一致。
 * 覆盖所有 worker 分片边界（每 240 帧一处）与镜头切点。
 *
 *   node mg-kit/verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../skia-kit/paper.mjs';
import { createMGRenderer } from './scenes.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
registerFonts(path.join(HERE, '..', 'assets', 'fonts'));
const P = JSON.parse(fs.readFileSync(path.join(HERE, 'params.json'), 'utf8'));
const canvas = createCanvas(1920, 1080);
const r = createMGRenderer({ ctx: canvas.getContext('2d') });
r.setContent({ scenes: P.scenes });

const total = Math.round(P.durationSeconds * P.fps);
const per = Math.ceil(total / 8);
const frames = new Set([0, 1, total - 1, 17, 99]);
for (let b = per; b < total; b += per) { frames.add(b - 1); frames.add(b); frames.add(b + 1); }
for (const s of P.scenes) { const f = Math.round(s.t0 * P.fps); frames.add(f - 1); frames.add(f); frames.add(f + 2); }
const list = [...frames].filter((f) => f >= 0 && f < total).sort((a, b) => a - b);

const digest = (f) => {
  r.renderFrame(f / P.fps);
  return crypto.createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
};
const ordered = new Map(list.map((f) => [f, digest(f)]));
const shuffled = [...list].reverse().filter((_, i) => i % 2 === 0)
  .concat([...list].filter((_, i) => i % 2 === 1));
let mismatches = 0;
for (const f of shuffled) if (digest(f) !== ordered.get(f)) mismatches++;

// 相邻帧必须有变化（抽样，排除静帧）
let identical = 0;
for (const f of list) {
  if (f + 1 < total && digest(f) === digest(f + 1)) identical++;
}

const result = {
  frames_checked: list.length,
  worker_boundaries_checked: Math.floor((total - 1) / per),
  order_independent_mismatches: mismatches,
  identical_adjacent_pairs: identical,
  verdict: mismatches === 0 && identical === 0 ? 'PASS' : 'FAIL',
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.verdict === 'PASS' ? 0 : 1);
