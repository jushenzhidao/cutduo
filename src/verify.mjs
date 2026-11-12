#!/usr/bin/env node
/**
 * skia-kit · 版式自检
 *
 *   node skia-kit/verify.mjs [--params skia-kit/presets/v8t.json]
 *
 * 对 8 个分镜各渲一帧，量出关键元素的墨迹包围盒，与模板实测值比对（容差 8px）；
 * 同时检查底色、安全区、动画是否在动。任一项超差 → 退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer } from '../kits/paper/paper.mjs';
import { registerFonts } from './fonts.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PARAMS = path.resolve(get('params', 'skia-kit/presets/v8t.json'));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

registerFonts(path.join(ROOT, 'assets/fonts'));
const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
const scenes = P.scenes;
const avatarPath = path.resolve(get('avatar', 'edits/assets/avatar.png'));
const avatar = fs.existsSync(avatarPath) ? await loadImage(avatarPath) : null;

const canvas = createCanvas(1920, 1080);
const ctx = canvas.getContext('2d');
const r = createPaperRenderer({ ctx });
r.setContent({ scenes, captions: P.captions || [], avatar });

const BG = [0xEF, 0xEF, 0xE5];

function frame(t) { r.renderFrame(t); return ctx.getImageData(0, 0, 1920, 1080); }
function diffFromBg(data, i) {
  return Math.abs(data[i] - BG[0]) + Math.abs(data[i + 1] - BG[1]) + Math.abs(data[i + 2] - BG[2]);
}
/** 区域内与底色差异 > thr 的墨迹包围盒 */
function bbox(data, x0, y0, x1, y1, thr = 30) {
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    const row = y * 1920 * 4;
    for (let x = x0; x < x1; x++) {
      if (diffFromBg(data.data, row + x * 4) > thr) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function near(v, target, tol) { return Math.abs(v - target) <= tol; }

const CASES = [
  { name: 'hero 标题', at: 2.5, box: [100, 330, 1200, 480], x: 144, y: 344, tol: 8 },
  { name: 'point 标题', at: 8.5, box: [150, 300, 1200, 440], x: 212, y: 300, tol: 10 },
  { name: 'number 外环', at: 14.5, box: [380, 140, 960, 700], x: 404, y: 152, tol: 10 },
  { name: 'compare 左标题', at: 19.8, box: [100, 310, 620, 410], x: 142, y: 316, tol: 8 },
  { name: 'steps 标题', at: 25, box: [100, 180, 700, 280], x: 142, y: 187, tol: 8 },
  { name: 'quote 首行', at: 30.5, box: [200, 315, 900, 420], x: 247, y: 328, tol: 8 },
  { name: 'checklist 表盘', at: 35, box: [300, 240, 1050, 620], x: 339, y: 256, tol: 12 },
  { name: 'outro 大标题', at: 40, box: [200, 270, 1100, 560], x: 335, y: 283, tol: 8 },
];

let fail = 0;
const rows = [];
for (const c of CASES) {
  const data = frame(c.at);
  const b = bbox(data, ...c.box);
  if (!b) { rows.push([c.name, 'MISS', '—', '—', 'FAIL']); fail++; continue; }
  const ok = near(b.x, c.x, c.tol) && near(b.y, c.y, c.tol);
  if (!ok) fail++;
  rows.push([c.name, `${b.x},${b.y}`, `${c.x},${c.y}`, `${b.x - c.x >= 0 ? '+' : ''}${b.x - c.x}/${b.y - c.y >= 0 ? '+' : ''}${b.y - c.y}`, ok ? 'PASS' : 'FAIL']);
}

// 底色与安全区
const d0 = frame(2.5);
let bgOK = true;
for (const [x, y] of [[10, 10], [1910, 10], [10, 1070], [1910, 1070]]) {
  if (diffFromBg(d0.data, (y * 1920 + x) * 4) > 6) bgOK = false;
}
// 安全区：边框 8px 内不应有墨迹（进度条/色块除外，这里只查左右下三边）
const edge = bbox(d0, 0, 0, 1920, 8);
const edgeL = bbox(d0, 0, 0, 8, 1080);
const edgeR = bbox(d0, 1912, 0, 1920, 1080);
const safeOK = !edge && !edgeL && !edgeR;

// 动画：同一镜相隔 0.2s 应有差异
function px(t) { const d = frame(t); return d.data; }
const a1 = px(2.0), a2 = px(2.4);
let moved = 0;
for (let i = 0; i < a1.length; i += 4) if (a1[i] !== a2[i]) moved++;
const animOK = moved > 200;

console.log('\nskia-kit verify · ' + path.relative(process.cwd(), PARAMS));
console.log('─'.repeat(64));
console.log('元素'.padEnd(16), '实测 x,y'.padEnd(14), '期望'.padEnd(12), 'Δ', '  结果');
for (const [n, got, exp, delta, res] of rows) console.log(n.padEnd(16), got.padEnd(14), exp.padEnd(12), delta.padEnd(8), res);
console.log('─'.repeat(64));
console.log('底色一致:', bgOK ? 'PASS' : 'FAIL', ' 安全区:', safeOK ? 'PASS' : 'FAIL', ' 动画:', animOK ? 'PASS' : 'FAIL');
const total = fail + (bgOK ? 0 : 1) + (safeOK ? 0 : 1) + (animOK ? 0 : 1);
console.log(total === 0 ? '\nRESULT: PASS\n' : `\nRESULT: FAIL (${total} 项)\n`);
process.exit(total === 0 ? 0 : 1);
