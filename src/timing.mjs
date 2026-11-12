#!/usr/bin/env node
// timing.mjs — 把一支片的工时拆成三个时钟，边做边记，攒出自己的分布。
//
// 为什么拆三个：同一支 37 秒口播，渲染 2.3 秒、首版 9 分钟、返修 4 分钟。合成一个"总耗时"就再也看不出
// 该优化哪里——而且会得出相反结论（渲染慢 6.9 倍，对总量只有 2.5% 的影响）。
//
// 三个时钟：
//   author   从动手到第一版能看（写版式、写参数、对齐时间轴）
//   render   跑渲染的时间（用 `run` 自动量，不用手记）
//   revision 第一版之后所有返修（改构图、修伪影、重出）
//   other    begin 到 end 之间没被前两者覆盖的空档（想事、看片、开会）
//
// 用法：
//   node timing.mjs begin "kit-v4 口播" --pipeline skia-kit
//   node timing.mjs run node skia-kit/render.mjs --params edits/inputs-v4.json --out out/x.mp4
//   node timing.mjs phase revision --note "右列字幕压脸"
//   node timing.mjs run node skia-kit/render.mjs --params edits/inputs-v4.json --out out/x.mp4
//   node timing.mjs end --video out/x.mp4
//   node timing.mjs report
//
// 记录写到 motiongit-lab/timing/ledger.jsonl（一行一支片），可提交、可 diff、可长期累积。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 走 realpath：曾用软链暴露入口，不走 realpath 时不同调用路径会写到两个账本
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ROOT = path.resolve(path.dirname(SELF), '..');
const DIR = path.join(ROOT, 'tools', 'timing');
const LEDGER = path.join(DIR, 'ledger.jsonl');
const OPEN = path.join(DIR, 'open.json');
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const PHASES = ['author', 'render', 'revision', 'other'];

mkdirSync(DIR, { recursive: true });
const now = () => Date.now();
const load = () => (existsSync(OPEN) ? JSON.parse(readFileSync(OPEN, 'utf8')) : null);
const save = (o) => writeFileSync(OPEN, JSON.stringify(o, null, 2));
const need = () => {
  const o = load();
  if (!o) { console.error('没有进行中的记录，先 begin'); process.exit(2); }
  return o;
};

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[k] = true; else { opt[k] = next; i++; }
    } else if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    else pos.push(a);
  }
  return { pos, opt };
}

// 把已累计的时间滚到 pending 阶段里（每次切换/结束时调用）
function roll(o) {
  if (!o.since) return;
  const d = (now() - o.since) / 1000;
  o.phases[o.pending] = (o.phases[o.pending] || 0) + d;
  o.since = now();
}

function probeVideo(file) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-show_entries', 'format=duration,size',
      '-of', 'json', file], { encoding: 'utf8' });
    const d = JSON.parse(out), s = (d.streams || [])[0] || {};
    const [n, den] = String(s.r_frame_rate || '0/1').split('/').map(Number);
    return {
      w: s.width, h: s.height, fps: den ? +(n / den).toFixed(3) : 0,
      frames: Number(s.nb_read_frames || 0),
      dur: +(Number(d.format?.duration || 0)).toFixed(3),
      mb: +((Number(d.format?.size || 0)) / 1e6).toFixed(2),
    };
  } catch { return null; }
}

const r1 = (x) => Math.round(x * 10) / 10;

function cmdBegin(pos, opt) {
  if (load()) { console.error('已有进行中的记录，先 end 或 --force'); process.exit(2); }
  save({
    film: pos[0] || path.basename(process.cwd()),
    pipeline: opt.pipeline || 'unknown',
    note: opt.note || '',
    startedAt: new Date().toISOString(),
    since: now(), pending: 'author',
    phases: { author: 0, render: 0, revision: 0, other: 0 },
    renders: [],
  });
  console.log(`▶ ${pos[0] || 'film'} · pipeline ${opt.pipeline || 'unknown'} · author 计时开始`);
}

function cmdRun(cmd) {
  const o = need();
  if (!cmd.length) { console.error('run 后面要跟命令'); process.exit(2); }
  roll(o);                                  // 先把 author 结算掉
  const t0 = now();
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  const d = (now() - t0) / 1000;
  o.since = now();
  o.renders.push({ cmd: cmd.join(' '), s: r1(d), code: r.status });
  o.phases.render = (o.phases.render || 0) + d;   // run 一律记 render
  save(o);
  console.log(`⏱ ${path.basename(cmd[0])} 用时 ${r1(d)}s（记入 render）`);
  if (r.status) process.exit(r.status);
}

function cmdPhase(pos, opt) {
  const o = need();
  const p = pos[0];
  if (!PHASES.includes(p)) { console.error(`phase 只能是 ${PHASES.join(' / ')}`); process.exit(2); }
  roll(o);
  o.pending = p;
  if (opt.note) o.note = (o.note ? o.note + '；' : '') + opt.note;
  save(o);
  console.log(`→ 切到 ${p}${opt.note ? `（${opt.note}）` : ''}`);
}

function cmdEnd(pos, opt) {
  const o = need();
  roll(o);
  // 浏览器坏了或命令跑在别处时，渲染时间可以从外部实测值录入：--render-s 15.8
  let external = 0;
  if (opt['render-s'] !== undefined) {
    external = Number(opt['render-s']);
    if (!Number.isFinite(external) || external < 0) { console.error('--render-s 需要一个非负秒数'); process.exit(2); }
    o.phases.render = (o.phases.render || 0) + external;
    o.note = (o.note ? o.note + '；' : '') + `render ${external}s 由外部实测录入`;
  }
  const endedAt = now();
  // 外部录入的渲染值可能大于墙钟时长（命令跑在别处），总量取两者较大者，否则占比会算出 >100%
  const wall = (endedAt - new Date(o.startedAt).getTime()) / 1000;
  const known0 = PHASES.reduce((a, p) => a + (o.phases[p] || 0), 0);
  const total = Math.max(wall, known0);
  const known = known0;
  o.phases.other = Math.max(0, o.phases.other + (total - known));   // 没标注的空档归 other
  const video = opt.video ? probeVideo(opt.video) : null;
  const rec = {
    film: o.film, pipeline: o.pipeline, note: o.note,
    startedAt: o.startedAt, endedAt: new Date(endedAt).toISOString(),
    totalS: r1(total),
    ...Object.fromEntries(PHASES.map((p) => [p, r1(o.phases[p] || 0)])),
    renderShare: total > 0 ? +(100 * (o.phases.render || 0) / total).toFixed(2) : 0,
    renders: o.renders, video, source: external ? 'external-render' : 'live',
  };
  appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  writeFileSync(OPEN, 'null');
  console.log(`■ ${o.film}：总计 ${fmtDur(total)}｜author ${fmtDur(o.phases.author)}｜render ${r1(o.phases.render)}s｜revision ${fmtDur(o.phases.revision)}｜other ${fmtDur(o.phases.other)}`);
  console.log(`  渲染占比 ${rec.renderShare}%${video ? ` · ${video.w}×${video.h}@${video.fps} · ${video.frames} 帧 · ${video.mb}MB` : ''}`);
}

// add：一次性录入一条记录（回溯，或在本工具之外完成的片）。source 默认 backfill，报告里与实时记录分开统计。
function cmdAdd(pos, opt) {
  const num = (k) => (opt[k] === undefined ? 0 : Number(opt[k]) || 0);
  const author = num('author'), render = num('render'), revision = num('revision'), other = num('other');
  const sum = author + render + revision + other;
  const total = Math.max(num('total'), sum);
  const rec = {
    film: opt.film || pos[0] || 'untitled', pipeline: opt.pipeline || 'unknown',
    note: opt.note || '', source: opt.source || 'backfill',
    startedAt: opt.at || '', endedAt: opt.at || '',
    totalS: r1(total), author: r1(author), render: r1(render), revision: r1(revision), other: r1(other),
    renderShare: total > 0 ? +(100 * render / total).toFixed(2) : 0,
    renders: [], video: opt.video ? probeVideo(opt.video) : null,
  };
  appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  console.log(`＋ ${rec.film}（${rec.source}）：总计 ${fmtDur(total)}｜author ${fmtDur(author)}｜render ${r1(render)}s｜revision ${fmtDur(revision)}｜渲染占比 ${rec.renderShare}%`);
}

const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}′${String(Math.round(s % 60)).padStart(2, '0')}″` : `${r1(s)}s`);

function pct(v, q) {
  const a = [...v].sort((x, y) => x - y);
  if (!a.length) return 0;
  const k = (a.length - 1) * q / 100, lo = Math.floor(k), hi = Math.min(lo + 1, a.length - 1);
  return r1(a[lo] + (a[hi] - a[lo]) * (k - lo));
}

function cmdReport() {
  if (!existsSync(LEDGER)) { console.log('还没有记录。先 begin 一支片。'); return; }
  const all = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rows = all.filter((r) => (r.source || 'live') === 'live');
  const back = all.filter((r) => (r.source || 'live') !== 'live');
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.pipeline)) by.set(r.pipeline, []);
    by.get(r.pipeline).push(r);
  }
  console.log(`\n实时样本 ${rows.length} 支 · ${by.size} 条产线\n`);
  const head = ['产线', 'n', '总计中位', 'author 中位', 'render 中位', 'revision 中位', '渲染占比'];
  const lines = [];
  for (const [p, rs] of by) {
    lines.push([p, String(rs.length),
      fmtDur(pct(rs.map((r) => r.totalS), 50)),
      fmtDur(pct(rs.map((r) => r.author), 50)),
      `${pct(rs.map((r) => r.render), 50)}s`,
      fmtDur(pct(rs.map((r) => r.revision), 50)),
      `${pct(rs.map((r) => r.renderShare), 50)}%`]);
  }
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ');
  console.log(fmt(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const l of lines) console.log(fmt(l));

  const shares = rows.map((r) => r.renderShare);
  console.log(`\n渲染占总工时：中位 ${pct(shares, 50)}%，p90 ${pct(shares, 90)}%`);
  console.log('—— 若这条低于 5%，优化渲染对交付周期几乎没有影响，力气应放在 author 与 revision。');
  if (back.length) {
    console.log(`\n另有 ${back.length} 条回溯/外部记录（不计入中位数）：`);
    for (const r of back) console.log(`  ${r.film}｜总计 ${fmtDur(r.totalS)}｜author ${fmtDur(r.author)}｜render ${r1(r.render)}s｜revision ${fmtDur(r.revision)}｜占比 ${r.renderShare}%｜${r.source}`);
  }
}

// run 之后全是命令本身（含它自己的 --params 等），不能当我们的参数解析
if (process.argv[2] === 'run') { cmdRun(process.argv.slice(3)); process.exit(0); }

const { pos, opt } = args(process.argv.slice(2));
const cmd = pos.shift();
({
  begin: () => cmdBegin(pos, opt),
  phase: () => cmdPhase(pos, opt),
  end: () => cmdEnd(pos, opt),
  report: cmdReport,
  add: () => cmdAdd(pos, opt),
}[cmd] || (() => { console.error('命令：begin | run | phase | end | report'); process.exit(2); }))();
