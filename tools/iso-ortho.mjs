#!/usr/bin/env node
/**
 * 正交三视图（合体态，统一比例尺）。
 *
 * 用途只有一件：和素材照片并排核外廓比例——宽高厚对不对得上。
 * 透视图里几层叠在一起量不出比例；统一比例尺的三视图能量。
 * 层级顺序不看这张图，看爆炸帧（透视图更清楚）。
 *
 * 用法：
 *   node tools/iso-ortho.mjs --params content/iso-iphone-deep/params.json --out out/ortho.png
 *
 * 相机 distance = 600R 逼近正交（project 的 persp = D/(D−depth) → 1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { createModel, makeCamera, partOffset, orderParts, facing } from '../kits/iso/model.mjs';
import { registerFonts } from '../src/fonts.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};

const paramsPath = arg('--params');
if (!paramsPath) {
  console.error('用法：node tools/iso-ortho.mjs --params <params.json> [--out out/ortho.png]');
  process.exit(1);
}
const outPath = arg('--out', 'out/ortho.png');

registerFonts(); // 不注册就只有豆腐块：napi-rs 不自动读系统字体

const P = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
const content = P.content || {};
const model = createModel(content);

const W = 1920;
const H = 820;
const COLS = 3;
const CW = W / COLS;
const PADX = 64;
const PADY = 70;

const S0 = { lift: 0, ex: 0, pull: 0, split: 0, hover: 0, act: 0, burst: {} };

/** 产品本体：static 件是参照方块这类道具（不随通道位移、也不是产品的一部分），
 *  算进外包会把 168 mm 的电源量成 238 mm。 */
const PRODUCT = model.parts.filter((p) => !p.static);

/** 实测外包：不信 content.bounds——手写常量常年和零件对不上，radius 与取景全跟着偏 */
function realBounds() {
  const b = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (const p of PRODUCT) {
    const off = partOffset(model, p, S0);
    for (let a = 0; a < 3; a++) {
      b[a][0] = Math.min(b[a][0], p.bbox[a][0] + off[a]);
      b[a][1] = Math.max(b[a][1], p.bbox[a][1] + off[a]);
    }
  }
  return b;
}
const RB = realBounds();
const R = Math.max(RB[0][1] - RB[0][0], RB[1][1] - RB[1][0], RB[2][1] - RB[2][0]) / 2;

const VIEWS = [
  { id: 'FRONT', yaw: 0, pitch: 0, across: 0, label: '宽 × 厚' },
  { id: 'SIDE', yaw: 90, pitch: 0, across: 1, label: '深 × 厚' },
  { id: 'TOP', yaw: 0, pitch: 90, across: 0, label: '宽 × 深' },
];

/** 针孔透视非线性：量 → 定 zoom → 再量（同 fitCam 的两遍实测） */
function measureAt(spec, zoom) {
  const cam = makeCamera({
    yaw: spec.yaw, pitch: spec.pitch, zoom, panX: 0, panY: 0,
    focus: [0, 0, 0], W: CW, H, radius: R, distance: 600 * R,
  });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of PRODUCT) {
    const b = p.bbox;
    for (const x of [b[0][0], b[0][1]]) for (const y of [b[1][0], b[1][1]]) for (const z of [b[2][0], b[2][1]]) {
      const [sx, sy] = cam.project([x, y, z]);
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
  }
  return { cam, bw: Math.max(6, x1 - x0), bh: Math.max(6, y1 - y0), mx: (x0 + x1) / 2, my: (y0 + y1) / 2 };
}

// 三格共用一个 zoom ⇒ 统一比例尺（一个 mm 在三格里占同样像素）
const usableW = CW - PADX * 2;
const usableH = H - PADY * 2;
let zoom = 1;
for (let pass = 0; pass < 3; pass++) {
  let lim = Infinity;
  for (const v of VIEWS) {
    const m = measureAt(v, zoom);
    lim = Math.min(lim, usableW / m.bw, usableH / m.bh);
  }
  zoom *= lim;
}

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#f7f6f3';
ctx.fillRect(0, 0, W, H);

const mm = (v) => (Math.round(v * 10) / 10).toFixed(1);
const span = (a) => mm(RB[a][1] - RB[a][0]);

/** 尺寸线：横线 + 两端短竖 + 中间标注 */
function dimLine(x0, x1, y, text) {
  ctx.strokeStyle = 'rgba(40,44,52,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y - 7); ctx.lineTo(x0, y + 7);
  ctx.moveTo(x1, y - 7); ctx.lineTo(x1, y + 7);
  ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.fillStyle = '#3a3f47';
  ctx.font = '19px "NotoSC Medium"';
  ctx.textAlign = 'center';
  ctx.fillText(text, (x0 + x1) / 2, y - 13);
  ctx.textAlign = 'left';
}

VIEWS.forEach((spec, ci) => {
  const ox = ci * CW;
  const m = measureAt(spec, zoom);
  const cam = makeCamera({
    yaw: spec.yaw, pitch: spec.pitch, zoom,
    panX: CW / 2 - m.mx, panY: H / 2 - m.my,
    focus: [0, 0, 0], W: CW, H, radius: R, distance: 600 * R,
  });

  ctx.save();
  ctx.translate(ox, 0);
  ctx.beginPath();
  ctx.rect(0, 0, CW, H);
  ctx.clip();

  // 零件级拓扑后再按面深度（同渲染器，避免大板压小件翻面）
  const order = orderParts(model, S0, cam);
  const items = [];
  for (const pi of order) {
    const part = model.parts[pi];
    if (part.static) continue; // 道具不进核对图
    for (let fi = 0; fi < part.faceCount; fi++) {
      const f = model.faces[part.faces + fi];
      if (!facing(f.n, cam)) continue;
      items.push({ f, poly: f.pts.map((v) => cam.project(v)) });
    }
  }
  ctx.lineJoin = 'round';
  for (const it of items) {
    const t = 0.80 + 0.20 * (it.f.n[2] * 0.5 + 0.5);
    const g = Math.round(216 * t);
    ctx.fillStyle = `rgb(${g},${g + 2},${Math.round(g * 0.99)})`;
    ctx.beginPath();
    it.poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,34,40,0.28)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = '#1d2025';
  ctx.font = '22px "NotoSC Black"';
  ctx.fillText(spec.id, ox + 28, 42);
  ctx.fillStyle = '#767b84';
  ctx.font = '15px "NotoSC Regular"';
  ctx.fillText(spec.label, ox + 28, 66);

  const by = H / 2 + m.bh / 2 + 48;
  dimLine(ox + CW / 2 - m.bw / 2, ox + CW / 2 + m.bw / 2, by, span(spec.across));

  ctx.strokeStyle = 'rgba(24,26,30,0.10)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, 0.5, CW - 1, H - 1);
});

const scale = (2.2 * R) / (zoom * H);
ctx.fillStyle = '#8a8f97';
ctx.font = '15px "NotoSC Regular"';
ctx.fillText(
  `${model.layers.length} 层 · ${model.parts.length} 件 · 统一比例 ${scale.toFixed(3)} mm/px · ${path.basename(paramsPath)}`,
  30, H - 14,
);

// 与声明的 bounds 对账
const dec = content.bounds;
if (dec) {
  const diffs = [0, 1, 2].map((a) => Math.abs((dec[a][1] - dec[a][0]) - (RB[a][1] - RB[a][0])) / Math.max(1, RB[a][1] - RB[a][0]));
  const worst = Math.max(...diffs);
  if (worst > 0.02) {
    const s = `⚠ bounds 与实测不符：声明 ${mm(dec[0][1] - dec[0][0])}×${mm(dec[1][1] - dec[1][0])}×${mm(dec[2][1] - dec[2][0])}，实测 ${span(0)}×${span(1)}×${span(2)}（最大偏差 ${(worst * 100).toFixed(1)}%）`;
    console.warn(`[iso-ortho] ${s}`);
    ctx.fillStyle = '#b4472c';
    ctx.fillText(s, 30, H - 36);
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log(`[iso-ortho] ${outPath}  ${W}×${H}  ${model.layers.length} 层 / ${model.parts.length} 件 / ${scale.toFixed(3)} mm/px`);
