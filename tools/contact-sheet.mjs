#!/usr/bin/env node
/**
 * contact-sheet.mjs — 扫片拼图 + 卡点拼图（只看，不出片）
 *
 *   node tools/contact-sheet.mjs --video out/benford.mp4
 *   node tools/contact-sheet.mjs --video out/benford.mp4 --params out/benford.vo.json
 *   node tools/contact-sheet.mjs --video out/benford.mp4 --marks 8.2,15.1,29.4 --outdir /tmp/sheet
 *
 * 为什么要有：`src/gate.mjs` 判的是成片指标（空帧率、黑帧率、响度、音画差），
 * 它抓不到「标题被截断」「两个字叠在一起」「关键词卡比口播早 0.4 秒」这三类事故。
 * 这三类只能靠人眼看，而逐帧看片子不现实——把片子摊成格子，一眼扫完。
 *
 * 两张图：
 *   扫片_N.png   每秒 1/every 帧，4×8 格。看截断、叠字、闪烁、空白、字幕是否跟着换。
 *                **镜头交界前后 0.5s 最容易出事**，先看那一带。
 *   卡点.png     每个关键词「开始前 lead 秒」与「开始后 trail 秒」各一帧，一行两个词。
 *                「前」那格还没有动作、「后」那格已经出现 = 卡上了。
 *
 * 卡点时刻的来源（优先级自上而下）：
 *   1. --marks t1,t2,…       显式给秒数
 *   2. --params <preset>     取段起点（scenes[].t0 / segments[].dur 前缀和）
 *   3. 都没有                  只出扫片
 *
 * 同源做法见 dashi-animationstyle 的 render.mjs --scan / --check-marks。
 * 差别：这里用 @napi-rs/canvas 拼卡点图，好加秒数与关键词标注；扫片仍交给 ffmpeg tile。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FFMPEG, FFPROBE } from '../src/bins.mjs';
import { registerFonts } from '../src/fonts.mjs';
import { DIRS } from '../src/root.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const VIDEO = arg('video');
if (!VIDEO || !fs.existsSync(VIDEO)) {
  console.error(`用法: node tools/contact-sheet.mjs --video <mp4> [选项]

  --video <mp4>       要看的成片（必填）
  --params <json>     从 params 的段起点取卡点时刻
  --marks t1,t2,…     直接给卡点秒数
  --every 0.33        扫片间隔秒（默认 0.33，约每秒 3 帧）
  --cols 4 --rows 8   扫片每张格子数（默认 4×8＝32 格）
  --cell 480          格宽像素（默认 480）
  --lead 0.1          卡点前偏移秒（默认 0.1）
  --trail 0.35        卡点后偏移秒（默认 0.35）
  --outdir <dir>      输出目录（默认 <成片目录>/check）`);
  process.exit(2);
}

const PARAMS = arg('params');
const MARKS_ARG = arg('marks');
const EVERY = Math.max(0.1, Number(arg('every', 0.33)));
const COLS = Math.max(1, Number(arg('cols', 4)));
const ROWS = Math.max(1, Number(arg('rows', 8)));
const CELL = Math.max(120, Number(arg('cell', 480)));
const LEAD = Number(arg('lead', 0.1));
const TRAIL = Number(arg('trail', 0.35));
const OUTDIR = path.resolve(arg('outdir', path.join(path.dirname(VIDEO), 'check')));
fs.mkdirSync(OUTDIR, { recursive: true });

/* ---------------- 探片 ---------------- */
const probe = JSON.parse(execFileSync(FFPROBE, [
  '-v', 'error', '-show_entries', 'format=duration:stream=width,height,r_frame_rate',
  '-of', 'json', VIDEO,
], { encoding: 'utf8' }));
const dur = Number(probe.format?.duration) || 0;
const v = (probe.streams || []).find((s) => s.width);
if (!dur || !v) { console.error('读不出时长或画幅，确认这是视频文件'); process.exit(2); }
const VW = Number(v.width); const VH = Number(v.height);
if (!(dur > 0.5)) { console.error(`片长 ${dur}s 太短，不够摊成格子`); process.exit(2); }

const label = path.basename(VIDEO);
console.log(`\n拼图 · ${label} · ${dur.toFixed(2)}s · ${VW}×${VH}`);

/* ---------------- 一、扫片 ---------------- */
const per = COLS * ROWS;
const cells = Math.max(1, Math.ceil(dur / EVERY));
const sheets = Math.ceil(cells / per);
const sheetFiles = [];
for (let i = 0; i < sheets; i++) {
  const start = i * per * EVERY;
  const span = Math.min(dur - start - 1e-3, per * EVERY);
  if (span <= 0.01) break;
  const out = path.join(OUTDIR, `扫片_${i + 1}.png`);
  const vf = `fps=1/${EVERY}:round=near,scale=${CELL}:-2,tile=${COLS}x${ROWS}:padding=6:color=white`;
  execFileSync(FFMPEG, [
    '-v', 'error', '-y', '-ss', start.toFixed(3), '-t', span.toFixed(3), '-i', VIDEO,
    '-vf', vf, '-frames:v', '1', out,
  ]);
  sheetFiles.push(out);
}
console.log(`  扫片     ${sheetFiles.length} 张（每张 ${per} 格，第 1 格是 ${sheets ? '0.0' : '—'}s 起，` +
  `覆盖 ${(sheets * per * EVERY).toFixed(1)}s）`);
for (const f of sheetFiles) console.log(`           ${path.relative(process.cwd(), f)}`);

/* ---------------- 卡点时刻 ---------------- */
/** 从 params 取段起点。paper/scenes 用 t0；science/segments 只有 dur，按前缀和。 */
function marksFromParams(file) {
  const P = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  if (Array.isArray(P.scenes) && P.scenes.length) {
    for (const [i, s] of P.scenes.entries()) {
      const t = Number(s.t0);
      if (Number.isFinite(t)) out.push({ t, name: s.cast || s.title || `#${i + 1}` });
    }
  } else if (Array.isArray(P.segments) && P.segments.length) {
    let t = 0;
    for (const [i, s] of P.segments.entries()) {
      out.push({ t, name: s.title || s.cast || `#${i + 1}` });
      t += Number(s.dur) || 0;
    }
  }
  return out;
}

let marks = [];
if (MARKS_ARG) {
  marks = MARKS_ARG.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
    .map((t, i) => ({ t, name: `#${i + 1}` }));
} else if (PARAMS && fs.existsSync(PARAMS)) {
  marks = marksFromParams(PARAMS);
}
marks = marks.filter((m) => m.t >= 0 && m.t < dur).slice(0, 40);
if (MARKS_ARG && !marks.length) console.log('  --marks 里没有落在片长内的时刻，跳过卡点图');

if (!marks.length) {
  console.log('  卡点     跳过（没给 --marks，--params 里也没有段边界）\n');
  process.exit(0);
}

/* ---------------- 二、卡点图 ---------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
const grab = (t) => {
  const f = path.join(tmp, `f-${t.toFixed(3)}.png`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', VIDEO, '-frames:v', '1', f]);
  return f;
};

registerFonts(DIRS.fonts);
const ch = Math.round(CELL * VH / VW);
const LBL = 34;                     // 每格上方标签高
const PAD = 8;
const gridCols = COLS;
const gridRows = Math.ceil(marks.length / Math.max(1, Math.floor(COLS / 2)));
const W = PAD + gridCols * (CELL + PAD);
const H = PAD + gridRows * (ch + LBL + PAD);
const cv = createCanvas(W, H);
const g = cv.getContext('2d');
g.fillStyle = '#ffffff';
g.fillRect(0, 0, W, H);

const FONT = `${Math.round(CELL * 0.042)}px "NotoSC Regular", sans-serif`;
let placed = 0;
for (let k = 0; k < marks.length; k++) {
  const m = marks[k];
  const row = Math.floor(k / 2);
  const base = (k % 2) * 2;             // 一行两个词：前、后、前、后
  for (const [j, off] of [[0, -LEAD], [1, TRAIL]]) {
    const t = m.t + off;
    if (t < 0 || t >= dur) continue;
    const f = grab(t);
    const img = await loadImage(f);
    const col = base + j;
    const x = PAD + col * (CELL + PAD);
    const y = PAD + row * (ch + LBL + PAD);
    g.drawImage(img, x, y + LBL, CELL, ch);
    g.strokeStyle = j === 0 ? '#b94a48' : '#3a7d44';
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + LBL + 1, CELL - 2, ch - 2);
    g.fillStyle = j === 0 ? '#b94a48' : '#3a7d44';
    g.font = FONT;
    g.textBaseline = 'top';
    const nm = String(m.name).slice(0, 18);
    g.fillText(`${nm} · ${j === 0 ? '前' : '后'} ${off > 0 ? '+' : ''}${off}s = ${t.toFixed(2)}s`, x + 4, y + 6);
    placed++;
  }
}
const cardPath = path.join(OUTDIR, '卡点.png');
fs.writeFileSync(cardPath, cv.toBuffer('image/png'));

const note = ['每个关键词：左格 = 口播说到之前（还没有动作），右格 = 说到之后（应已出现）。',
  '判定：左格已有完整画面 → 早了；右格仍是空的 → 晚了或没出现。', ''];
for (const m of marks) note.push(`${m.name}\t${m.t.toFixed(2)}s\t前 ${(m.t - LEAD).toFixed(2)}s / 后 ${(m.t + TRAIL).toFixed(2)}s`);
fs.writeFileSync(path.join(OUTDIR, '卡点_说明.txt'), note.join('\n') + '\n');

console.log(`  卡点     ${cardPath}（${marks.length} 个时刻，${placed} 格）`);
console.log(`           ${path.join(OUTDIR, '卡点_说明.txt')}`);
console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
