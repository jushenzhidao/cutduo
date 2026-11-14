#!/usr/bin/env node
// composition.mjs — 构图量化：把"这片看着空/挤/偏"变成可比较的数字。
//
// 为什么要有（2026-11-14）：本仓对画面的判断一直是人眼。节奏有 pacing、完整性有 gate、
// 分镜有 check-beats，但"这一屏主次不分""主体贴边了"全靠看。上游那套构图指标（主体尺度、
// 柔光、紫色碎片）是给 MG 风格标定的，paper 是浅底深字、没有发光主角，直译会全误判。
//
// 这里改用不依赖"谁是主角"的四个量：
//   1. ink%     墨量占比        —— 过满 / 过空
//   2. 重心偏移  墨迹质心与画面中心的距离（按宽归一） —— 构图是否偏
//   3. 边缘侵占  距画布边缘 3% 内的墨占比 —— 是否快贴边（竖屏会被平台 UI 压住）
//   4. 层级差    最高墨带 / 墨带中位数 —— 主次是否分得开（<1.5 就是一片字一样大）
//
// 阈值不写死：先跑全库拿分布，取 p5/p95 之外才算离群。所以本工具的输出分两段——
// 「本片读数」和「本片在全库分布里的位置」。
//
// 用法：node tools/composition.mjs <slug> | --all [--json]
// 退出码：0 无离群 / 1 有离群（相对全库分布）

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as BINS from '../src/bins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = BINS.FFMPEG;
const W = 480, H = 270;          // 采样分辨率：够量行带，又不至于慢
const CAPTION_Y = 0.60;          // 字幕带以上算"构图区"（字幕每片都在同一位置，会污染重心）
const SAMPLE_STEP = 1.5;         // 秒

const gray = (file, t) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  return r.stdout && r.stdout.length >= W * H ? r.stdout : null;
};

/** 单帧构图读数 */
function measureFrame(buf) {
  // 背景色 = 直方图众数（paper 是浅底、science 是米色底，都成立）
  const hist = new Int32Array(256);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  let bg = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;

  // 墨带只在**文字区**（左侧 60%）统计：右侧关键词卡是一整块实心色块，
  // 按整屏投影会把它和标题连成一条，层级差恒等于 1（实测 sample-1000）。
  const TEXT_W = Math.round(W * 0.6);
  const rows = new Int32Array(H);
  let ink = 0, sx = 0, sy = 0, edge = 0;
  const edgePx = Math.max(2, Math.round(W * 0.03));
  const edgePy = Math.max(2, Math.round(H * 0.03));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(buf[y * W + x] - bg);
      if (d <= 38) continue;                 // 与底色差不足 38 灰阶的算背景
      ink++; sx += x; sy += y;
      if (x < TEXT_W) rows[y]++;
      if (x < edgePx || x >= W - edgePx || y < edgePy || y >= H - edgePy) edge++;
    }
  }
  if (!ink) return { ink: 0, cx: 0.5, cy: 0.5, edge: 0, bands: [], hier: 1 };

  // 墨带：连续有墨的行合成一段，段高 = 一行字的高度
  const bands = [];
  let start = -1;
  for (let y = 0; y < H; y++) {
    const on = rows[y] > TEXT_W * 0.01;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { bands.push(y - start); start = -1; }
  }
  if (start >= 0) bands.push(H - start);
  const sorted = [...bands].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
  const max = sorted.length ? sorted[sorted.length - 1] : 1;

  return {
    ink: ink / (W * H),
    cx: (sx / ink) / W,
    cy: (sy / ink) / H,
    edge: edge / ink,
    bands: bands.length,
    hier: med ? max / med : 1,
  };
}

function measureFilm(slug) {
  const file = path.join(ROOT, `out/${slug}.mp4`);
  if (!existsSync(file)) return null;
  const probe = spawnSync(BINS.FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const dur = Number((probe.stdout || '0').trim());
  const frames = [];
  for (let t = 0.6; t < dur - 0.4; t += SAMPLE_STEP) {
    const buf = gray(file, t);
    if (!buf) continue;
    frames.push({ t: +t.toFixed(1), ...measureFrame(buf) });
  }
  if (!frames.length) return null;
  const pick = (k) => frames.map((f) => f[k]).filter(Number.isFinite);
  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return {
    slug, dur: +dur.toFixed(1), n: frames.length,
    ink: med(pick('ink')),
    cx: med(pick('cx')),
    cy: med(pick('cy')),
    edge: med(pick('edge')),
    hier: med(pick('hier')),
    // 重心漂移：全片重心偏离画面中心的量（只在构图区内算，因字幕带已排除）
    driftX: med(pick('cx').map((v) => Math.abs(v - 0.5))),
    driftY: med(pick('cy').map((v) => Math.abs(v - 0.5))),
    inkMax: Math.max(...pick('ink')),
    inkMin: Math.min(...pick('ink')),
  };
}

/* ── 入口 ── */
const argv = process.argv.slice(2);
const ASJSON = argv.includes('--json');
let slugs = argv.filter((a) => !a.startsWith('-'));
if (argv.includes('--all') || !slugs.length) {
  slugs = readdirSync(path.join(ROOT, 'out'))
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => f.replace(/\.mp4$/, ''))
    .filter((s) => existsSync(path.join(ROOT, `content/${s}`)));
}

const rows = slugs.map(measureFilm).filter(Boolean);
if (ASJSON) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const fmt = (v, d = 2) => (v == null ? '—' : (+v).toFixed(d));
console.log(`\n构图量化 · ${rows.length} 支片（采样 1/${SAMPLE_STEP}s，排除字幕带 y>${CAPTION_Y}）`);
console.log('─'.repeat(84));
console.log('片'.padEnd(18) + '墨量%'.padStart(7) + '重心偏X'.padStart(9) + '重心偏Y'.padStart(9)
  + '贴边%'.padStart(8) + '层级差'.padStart(8) + '  空/满');
for (const r of rows) {
  console.log(r.slug.padEnd(18)
    + (r.ink * 100).toFixed(1).padStart(7)
    + fmt(r.driftX).padStart(9) + fmt(r.driftY).padStart(9)
    + (r.edge * 100).toFixed(1).padStart(8) + fmt(r.hier).padStart(8)
    + `  ${(r.inkMin * 100).toFixed(1)}–${(r.inkMax * 100).toFixed(1)}`);
}

// 数据驱动阈值：全库 p10–p90 之外才算离群
const q = (k, p) => { const a = rows.map((r) => r[k]).sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]; };
const bounds = {
  ink: [q('ink', 0.1), q('ink', 0.9)],
  driftX: [0, q('driftX', 0.95)],
  edge: [0, q('edge', 0.95)],
  hier: [q('hier', 0.1), 99],
};
const out = [];
for (const r of rows) {
  if (r.ink < bounds.ink[0] * 0.6) out.push(`${r.slug}: 墨量 ${(r.ink * 100).toFixed(1)}% 低于全库 p10 的六成——近半时间是空屏`);
  if (r.driftX > bounds.driftX[1] * 1.25) out.push(`${r.slug}: 重心横向偏 ${fmt(r.driftX)}（全库 p95=${fmt(bounds.driftX[1])}）——构图持续偏一侧`);
  if (r.edge > bounds.edge[1] * 1.3) out.push(`${r.slug}: 贴边墨占比 ${(r.edge * 100).toFixed(1)}%（p95=${(bounds.edge[1] * 100).toFixed(1)}%）——主体快顶到画布边`);
  if (r.hier < bounds.hier[0] * 0.8) out.push(`${r.slug}: 层级差 ${fmt(r.hier)}（p10=${fmt(bounds.hier[0])}）——全屏字一样大，主次不分`);
}
console.log('─'.repeat(84));
console.log(`全库分布：墨量 ${(bounds.ink[0] * 100).toFixed(1)}–${(bounds.ink[1] * 100).toFixed(1)}% · `
  + `重心偏X ≤${fmt(bounds.driftX[1])} · 贴边 ≤${(bounds.edge[1] * 100).toFixed(1)}% · 层级差 ≥${fmt(bounds.hier[0])}`);
if (out.length) { console.log('\n离群：'); out.forEach((s) => console.log('  · ' + s)); }
else console.log('\n没有离群：全部落在全库 p10–p90 内');
process.exit(out.length ? 1 : 0);
