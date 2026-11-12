#!/usr/bin/env node
// gate.mjs — delivery gates calibrated on this repo's own films, not copied from another kit.
//
// Why this file exists (2026-11-10): cinecode's qc.py offers `hook` (first 2 s must move, mean >= 0.5) and a phone
// type minimum (40 px cap at a 1080 short side). Measured against the 19 films already delivered here:
//   hook_mean  0.06 .. 5.29   p10 0.09  p50 0.31   -> a 0.5 line fails 13 of 19, including every voice-over film
//   mean L*    0.40 .. 91.3   (three replicas are dark by design) -> a lightness floor rejects legitimate work
//   dup frames 0 .. 36.8 %    (layout holds)      -> duplicates are a design choice, not a defect
// So those three are reported, never gated. What is gate-able is whether the file is a finished, playable film at all:
// the frame count matches the clock, there is sound, sound and picture end together, and no second of the film is an
// empty frame (almost no luma range) or a black frame, whatever palette the film uses.
//
// Usage:
//   node gate.mjs out/film.mp4 [more.mp4 ...] [--json report.json] [--html report.html] [--quiet]
// Exit code 1 when any film fails a hard gate.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

// Calibrated limits: the corpus maximum plus a margin, so a normal film cannot trip them.
const LIMIT = {
  flatPct: 8,        // corpus max 5.26 (editorial-cut-v4)
  blackPct: 3,       // corpus max 1.75 (replica promo-pixel)
  avDelta: 0.10,     // seconds between picture and sound
  hookWarn: 0.10,    // corpus p10
  dupWarn: 40,       // corpus max 36.8
  yavgWarn: 6,       // near-black: worth a look, not a fail
};

function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration',
    '-show_entries', 'format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  const d = JSON.parse(out);
  const v = (d.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (d.streams || []).find((s) => s.codec_type === 'audio') || null;
  const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  return {
    w: v.width, h: v.height,
    fps: den ? num / den : 0,
    frames: Number(v.nb_read_frames || 0),
    dur: Number(d.format?.duration || 0),
    size: Number(d.format?.size || 0),
    vcodec: v.codec_name || null,
    audio: a ? { codec: a.codec_name, dur: Number(a.duration || 0) } : null,
  };
}

function stats(file, fps) {
  const step = Math.max(1, Math.round(fps || 24));
  const r = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-an', '-vf',
    `select='not(mod(n,${step}))',signalstats,metadata=print:file=-`, '-f', 'null', '-'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const grab = (re) => [...r.matchAll(re)].map((m) => Number(m[1]));
  const ymin = grab(/YMIN=(\d+)/g), ymax = grab(/YMAX=(\d+)/g), yavg = grab(/YAVG=([\d.]+)/g);
  const n = Math.min(ymin.length, ymax.length);
  if (!n) return null;
  let flat = 0, black = 0;
  for (let i = 0; i < n; i++) {
    if (ymax[i] - ymin[i] < 40) flat++;
    if (ymax[i] < 24) black++;
  }
  return {
    samples: n,
    flatPct: +(100 * flat / n).toFixed(2),
    blackPct: +(100 * black / n).toFixed(2),
    yavg: +(yavg.reduce((a, b) => a + b, 0) / Math.max(1, yavg.length)).toFixed(1),
  };
}

// Opening motion: mean frame-to-frame luma change over the first two seconds, 64px wide.
function hook(file) {
  const r = execFileSync(FFMPEG, ['-hide_banner', '-t', '2', '-i', file, '-an', '-vf',
    'scale=64:36,format=gray,tblend=all_mode=difference,signalstats,metadata=print:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const v = [...r.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : 0;
}

function firstFrameYmax(file) {
  const r = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-frames:v', '1', '-an', '-vf',
    'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const m = [...r.matchAll(/YMAX=(\d+)/g)];
  return m.length ? Number(m[0][1]) : 255;
}

function judge(file, opt) {
  const p = probe(file);
  p.firstYmax = firstFrameYmax(file);
  const s = stats(file, p.fps) || { samples: 0, flatPct: 0, blackPct: 0, yavg: 0 };
  const hk = hook(file);
  const expect = Math.round(p.dur * p.fps);
  const fails = [], warns = [];

  if (Math.abs(p.frames - expect) > 1) fails.push(`帧数 ${p.frames} ≠ ${p.dur.toFixed(3)}s × ${p.fps}fps = ${expect}`);
  if (!p.audio) (opt.requireAudio ? fails : warns).push('无音轨（素材可无声；成品加 --require-audio 判失败）');
  else if (Math.abs(p.audio.dur - p.dur) > LIMIT.avDelta) fails.push(`音画时长差 ${Math.abs(p.audio.dur - p.dur).toFixed(2)}s`);
  if (p.firstYmax < 24) warns.push(`首帧接近黑场（YMAX=${p.firstYmax}）——参考片淡入时正常，短视频平台不建议`);
  if (s.flatPct > LIMIT.flatPct) fails.push(`空帧 ${s.flatPct}% > ${LIMIT.flatPct}%`);
  if (s.blackPct > LIMIT.blackPct) fails.push(`黑帧 ${s.blackPct}% > ${LIMIT.blackPct}%`);

  if (hk < LIMIT.hookWarn) warns.push(`开场运动 ${hk} < ${LIMIT.hookWarn}（告警，不是失败）`);
  if (s.yavg < LIMIT.yavgWarn) warns.push(`平均亮度 Y=${s.yavg}（近黑，看是否压片）`);

  return {
    file: path.relative(process.cwd(), file) || file,
    ...p, ...s, hook: hk, expect,
    verdict: fails.length ? 'FAIL' : 'PASS', fails, warns,
  };
}

function table(rows) {
  const head = ['film', 'spec', 'frames', 'flat%', 'black%', 'hook', 'Y', 'verdict'];
  const lines = rows.map((r) => [
    path.basename(r.file),
    `${r.w}x${r.h}@${r.fps}`,
    `${r.frames}/${r.expect}`,
    r.flatPct.toFixed(1),
    r.blackPct.toFixed(1),
    r.hook.toFixed(2),
    String(r.yavg),
    r.verdict,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  return [fmt(head), w.map((n) => '-'.repeat(n)).join('  '), ...lines.map(fmt)].join('\n');
}

function html(rows) {
  const ok = rows.filter((r) => r.verdict === 'PASS').length;
  const cell = (r) => `<tr class="${r.verdict === 'PASS' ? 'ok' : 'bad'}">
    <td>${path.basename(r.file)}</td><td>${r.w}×${r.h}@${r.fps}</td>
    <td>${r.frames}/${r.expect}</td><td>${r.flatPct.toFixed(1)}%</td><td>${r.blackPct.toFixed(1)}%</td>
    <td>${r.hook.toFixed(2)}</td><td>${r.yavg}</td><td>${r.verdict}</td>
    <td>${[...r.fails, ...r.warns].join('；') || '—'}</td></tr>`.replace(/\n\s*/g, '');
  return `<!doctype html><meta charset="utf-8"><title>交付门禁报告</title>
<style>
 body{margin:0;padding:36px 40px;background:#f4f1ea;color:#1f1d1a;font:14px/1.65 -apple-system,"PingFang SC",sans-serif}
 h1{font-size:20px;font-weight:600;margin:0 0 6px} p.lede{color:#6b6459;margin:0 0 22px;max-width:900px}
 table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 0 #e2dccf}
 th,td{padding:8px 10px;border-bottom:1px solid #ece7db;text-align:left;font-size:13px}
 th{background:#efe9dc;font-weight:600} td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6),td:nth-child(7){font-variant-numeric:tabular-nums}
 tr.bad td:last-child,tr.bad td:nth-child(8){color:#a32d2d} tr.bad{background:#fcf3f2}
 tr.ok td:nth-child(8){color:#3b6d11}
 .note{margin-top:24px;color:#6b6459;font-size:13px;max-width:900px}
 code{background:#ece7db;padding:1px 4px;border-radius:3px}
</style>
<h1>交付门禁报告 · ${ok}/${rows.length} 通过</h1>
<p class="lede">只拦交付完整性：帧数与时钟一致、有声、音画同长、没有空帧或黑帧。
开场运动（hook）、平均亮度（Y）、重复帧只报不拦——在这 19 支成片上的分布是连续的，设一条线只会误伤。</p>
<table><thead><tr><th>成片</th><th>规格</th><th>帧数/应有</th><th>空帧</th><th>黑帧</th><th>hook</th><th>Y</th><th>判定</th><th>说明</th></tr></thead>
<tbody>${rows.map(cell).join('')}</tbody></table>
<p class="note">阈值来自本仓 19 支已交付成片的实测分布：空帧 ≤ ${LIMIT.flatPct}%（实测最大 5.26）、
黑帧 ≤ ${LIMIT.blackPct}%（最大 1.75）、音画差 ≤ ${LIMIT.avDelta}s。
告警线 hook &lt; ${LIMIT.hookWarn}（实测 p10 = 0.09）。重新标定请跑 <code>cinecode-probe/gate-calib/calibrate.py</code>。</p>`;
}

function parseArgs(argv) {
  const files = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--html') opt[a.slice(2)] = argv[++i];
    else if (a.startsWith('--json=')) opt.json = a.slice(7);
    else if (a.startsWith('--html=')) opt.html = a.slice(7);
    else if (a === '--quiet') opt.quiet = true;
    else if (a === '--require-audio') opt.requireAudio = true;
    else files.push(a);
  }
  return { files, opt };
}

const { files, opt } = parseArgs(process.argv.slice(2));
if (!files.length) {
  console.error('usage: node gate.mjs <film.mp4> [more.mp4 ...] [--json out.json] [--html out.html] [--require-audio] [--quiet]');
  process.exit(2);
}
const rows = files.map((f) => judge(f, opt));
if (!opt.quiet) {
  console.log(table(rows));
  for (const r of rows) for (const m of [...r.fails, ...r.warns]) console.log(`${r.verdict === 'FAIL' ? 'FAIL' : 'warn'}  ${path.basename(r.file)}: ${m}`);
}
if (opt.json) writeFileSync(opt.json, JSON.stringify(rows, null, 2));
if (opt.html) writeFileSync(opt.html, html(rows));
process.exit(rows.some((r) => r.verdict === 'FAIL') ? 1 : 0);
