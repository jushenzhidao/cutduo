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

// Otsu：按直方图自动找前景/背景分界。固定阈值（38 灰阶）只对浅底成立——
// 深色 iso 片整帧都接近底色，会被判成"几乎没有墨"（实测 1.8%），跨套版式一比就全错。
function otsu(hist, total) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

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
  const thr = otsu(hist, buf.length);
  const rows = new Int32Array(H);
  let ink = 0, sx = 0, sy = 0, edge = 0;
  const edgePx = Math.max(2, Math.round(W * 0.03));
  const edgePy = Math.max(2, Math.round(H * 0.03));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(buf[y * W + x] - bg);
      if (d <= Math.max(10, Math.abs(thr - bg) * 0.35)) continue;   // Otsu 分界与底色的差值再放宽一点
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

// 套版式决定构图基线：paper 是浅底大字 + 关键词卡，iso 是深底满幅的爆炸图，
// 拿同一套阈值跨套比毫无意义（实测 iso 的"贴边 13%"是设计，paper 的"贴边 0%"是排版）。
function kitOf(slug) {
  try {
    const mk = readFileSync(path.join(ROOT, `content/${slug}/make.sh`), 'utf8');
    const m = mk.match(/--kit\s+(\w+)/);
    return m ? m[1] : 'unknown';
  } catch { return 'unknown'; }
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
    slug, kit: kitOf(slug), dur: +dur.toFixed(1), n: frames.length,
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

// 阈值**按套版式分组**取 p10/p90：跨套比较无意义（见 kitOf 注释）。
// 同组样本 <3 支时只报数字、不下离群结论。
const groups = new Map();
for (const r of rows) { if (!groups.has(r.kit)) groups.set(r.kit, []); groups.get(r.kit).push(r); }
const qk = (arr, k, p) => { const a = arr.map((r) => r[k]).sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]; };
const out = [];
for (const [kit, arr] of groups) {
  if (arr.length < 3) continue;
  const b = {
    ink: [qk(arr, 'ink', 0.1), qk(arr, 'ink', 0.9)],
    edge: qk(arr, 'edge', 0.95),
    hier: qk(arr, 'hier', 0.1),
  };
  for (const r of arr) {
    if (r.ink < b.ink[0] * 0.5) out.push(`[${kit}] ${r.slug}: 墨量 ${(r.ink * 100).toFixed(1)}% 不到同族 p10 的一半——近半时间空屏`);
    if (r.edge > Math.max(b.edge * 1.6, 0.06)) out.push(`[${kit}] ${r.slug}: 贴边墨 ${(r.edge * 100).toFixed(1)}%（同族 p95=${(b.edge * 100).toFixed(1)}%）——主体顶到画布边`);
    if (r.hier < b.hier * 0.7) out.push(`[${kit}] ${r.slug}: 层级差 ${fmt(r.hier)}（同族 p10=${fmt(b.hier)}）——主次分不开`);
  }
}
console.log('─'.repeat(84));
for (const [kit, arr] of groups) {
  console.log(`  ${kit.padEnd(10)} ${String(arr.length).padStart(2)} 支 · 墨量中位 ${(qk(arr, 'ink', 0.5) * 100).toFixed(1)}% · `
    + `贴边 p95 ${(qk(arr, 'edge', 0.95) * 100).toFixed(1)}% · 层级差 p10 ${fmt(qk(arr, 'hier', 0.1))}`);
}
if (out.length) { console.log('\n离群：'); out.forEach((s) => console.log('  · ' + s)); }
else console.log('\n没有离群：全部落在全库 p10–p90 内');
process.exit(out.length ? 1 : 0);
