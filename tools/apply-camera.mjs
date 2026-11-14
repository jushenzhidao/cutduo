#!/usr/bin/env node
/**
 * apply-camera.mjs — 按「拍」批量编排段级运镜
 *
 *   node tools/apply-camera.mjs --params content/round-window/params-abs.json \
 *     --types hero,quote --z 1.06 --out content/round-window/params-cam.json
 *
 * 为什么需要这一层：本仓的分镜几乎都是**一拍拆多段**（同一份 screens 重放 2–5 遍）。
 * 如果按段逐个加 `camera`，观众看到的是「推近 → 跳回 1.0 → 再推近」，比不加还难看。
 *
 * 所以相机必须按**连续同型段组**（≈ 一拍）分配：
 *   1 段：push（推到位后停）
 *   2 段：push → pull（推到 1.06，再拉回 1.0，一个完整呼吸）
 *   ≥3 段：push → hold… → pull（中间段保持在 1.06，衔接点逐像素连续）
 *
 * 只在**静态构图**段用（hero / quote / outro / checklist）。chart / grid 这类元素自己在长的段
 * 加了会两个运动打架 —— 本工具默认拒绝，需要显式 --force 才给它们加。
 *
 * 输出写到 `--out`，不改原 params。原文件仍可出片（零回归）。
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const SRC = arg('params');
const OUT = arg('out');
const TYPES = (arg('types', 'hero,quote,outro') || '').split(',').map((s) => s.trim()).filter(Boolean);
const Z = Number(arg('z', 1.06));
const FORCE = process.argv.includes('--force');
const PUSH_DUR = arg('push-dur', null);
const PULL_DUR = arg('pull-dur', null);

if (!SRC || !OUT) {
  console.error(`用法: node tools/apply-camera.mjs --params <params.json> --out <新文件> [选项]

  --types hero,quote,outro   给哪些段型加（默认 hero,quote,outro）
  --z 1.06                   放大倍数（必须 >1；只放大不缩小）
  --push-dur / --pull-dur    覆盖推/拉的时长（默认 = 该段时长，即整段缓慢推）
  --force                    允许给 chart/grid 这类"元素自己在动"的段型加（默认拒绝）`);
  process.exit(2);
}

const DYNAMIC = new Set(['chart', 'grid', 'steps', 'number', 'broll']);
const P = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const scenes = P.scenes || [];
if (!scenes.length) { console.error('没有 scenes（science 的 segments 请先转成 scenes）'); process.exit(2); }

if (!(Z > 1)) { console.error(`--z 必须 >1（收到 ${Z}）：缩远会露出画布外的空白`); process.exit(2); }

/* ---------- 找连续同型段组 ---------- */
const groups = [];
for (let i = 0; i < scenes.length; i++) {
  const t = scenes[i].type;
  const prev = groups[groups.length - 1];
  if (prev && prev.type === t && prev.idx[prev.idx.length - 1] === i - 1) prev.idx.push(i);
  else groups.push({ type: t, idx: [i] });
}

/* ---------- 分配 ---------- */
const applied = [];
let skipped = 0;
for (const g of groups) {
  if (!TYPES.includes(g.type)) continue;
  if (DYNAMIC.has(g.type) && !FORCE) { skipped += g.idx.length; continue; }
  const n = g.idx.length;
  g.idx.forEach((si, k) => {
    const s = scenes[si];
    const span = Number(s.t1) - Number(s.t0);
    const cam = { kind: 'cut' };
    if (n === 1) {
      cam.kind = 'push';
      cam.dur = PUSH_DUR ? Number(PUSH_DUR) : +span.toFixed(2);
    } else if (k === 0) {
      cam.kind = 'push';
      cam.dur = PUSH_DUR ? Number(PUSH_DUR) : +span.toFixed(2);
    } else if (k === n - 1) {
      cam.kind = 'pull';
      cam.dur = PULL_DUR ? Number(PULL_DUR) : +span.toFixed(2);
    } else {
      cam.kind = 'hold';
    }
    cam.z = Z;
    s.args = s.args || {};
    s.args.camera = cam;
    applied.push({ i: si, type: s.type, kind: cam.kind, span: +span.toFixed(2) });
  });
}

if (!applied.length) {
  console.error(`没有可应用的段：types=${TYPES.join(',')}，影片段型=${[...new Set(scenes.map((s) => s.type))].join(',')}`);
  process.exit(2);
}

fs.writeFileSync(OUT, JSON.stringify(P, null, 1) + '\n');
console.log(`\n运镜编排 → ${path.relative(process.cwd(), OUT)}  （z=${Z}）`);
console.log('─'.repeat(64));
for (const a of applied) console.log(`  [${String(a.i).padStart(2)}] ${a.type.padEnd(9)} ${a.kind.padEnd(5)} 段长 ${a.span}s`);
console.log('─'.repeat(64));
console.log(`  ${applied.length} 段已加相机${skipped ? `，${skipped} 段动态构图已跳过（--force 可强制）` : ''}`);
const kinds = applied.reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {});
console.log(`  push ${kinds.push || 0} / hold ${kinds.hold || 0} / pull ${kinds.pull || 0}\n`);
