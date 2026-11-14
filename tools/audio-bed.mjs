#!/usr/bin/env node
/**
 * tools/audio-bed.mjs · 通用配乐层（paper 与 science 两种版式都能用）
 *
 *   node tools/audio-bed.mjs --slug benford
 *   node tools/audio-bed.mjs --slug gut-antibiotic --style chillwave --dry
 *
 * 做两件事：
 *   1. 用本机 Apple Loops 铺 4 层配乐（鼓 / 贝斯 / 和声 / 氛围），按段落边界让各层进出
 *   2. 调 src/audio-mix.mjs 把旁白（vo-norm.wav）与配乐混成 mix-final.wav（带 ducking）
 *
 * 为什么单独写一个：content/<片>/bgm.mjs 是 paper 专用的——它读 `scenes[i].t0`，
 * 而 science 用 `segments[].dur` 累积，喂进去会直接读不出边界。这里两种容器都认。
 *
 * 曲目路径是本机资源（`/Library/Audio/Apple Loops/Apple`），不入库；
 * 找不到就报错并列出可用曲风，不静默降级成"没配乐"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPS = '/Library/Audio/Apple Loops/Apple';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const STYLES = {
  // 每一层：鼓 / 贝斯 / 和声 / 氛围。选曲原则是**不抢旁白**——都是中低频、无强旋律。
  electrohouse: ['02 Electro House/Blueprint Beat 01.caf', '02 Electro House/Acid Test Bass.caf',
    '02 Electro House/Binary System Synth Layers.caf', '02 Electro House/Apex Synth.caf'],
  chillwave: ['07 Chillwave/Acoustic Layers Beat 01.caf', '07 Chillwave/Beach Run Bass.caf',
    '07 Chillwave/Chill Chords Acoustic Guitar.caf', '07 Chillwave/Beach Run Synth.caf'],
  hiphop: ['01 Hip Hop/Blue Print Beat 01.caf', '01 Hip Hop/Amber Bass.caf',
    '01 Hip Hop/Soft Keys.caf', '01 Hip Hop/Cloud Pad.caf'],
};

const slug = arg('slug');
if (!slug) {
  console.error('用法: node tools/audio-bed.mjs --slug <片名> [--style electrohouse|chillwave|hiphop] [--dry]');
  process.exit(2);
}

const DIR = path.join(ROOT, 'content', slug);
const p = JSON.parse(fs.readFileSync(path.join(DIR, 'params-abs.json'), 'utf8'));

/* ---------- 段落边界：scenes（t0 绝对）与 segments（dur 累积）都认 ---------- */
const GAP = 0.25;
const items = p.scenes || p.segments || [];
if (!items.length) { console.error('params 里既没有 scenes 也没有 segments'); process.exit(2); }

const starts = [];
let acc = 0;
for (const s of items) {
  const dur = Number.isFinite(s.t0) && Number.isFinite(s.t1) ? s.t1 - s.t0 : (Number(s.dur) || 0);
  starts.push(Number.isFinite(s.t0) ? s.t0 : acc);
  acc = (Number.isFinite(s.t0) ? s.t0 : acc) + dur + (p.scenes ? 0 : GAP);
}
const total = Number(p.durationSeconds) || acc;
const at = (frac) => starts[Math.min(starts.length - 1, Math.max(0, Math.floor(starts.length * frac)))];
const t1 = starts[Math.min(2, starts.length - 1)];
const t2 = at(0.45);
const t3 = at(0.75);

/* ---------- 选层 ---------- */
const style = arg('style', 'electrohouse');
const layers = STYLES[style];
if (!layers) { console.error(`未知曲风 ${style}；可用：${Object.keys(STYLES).join(' / ')}`); process.exit(2); }
const files = layers.map((f) => path.join(LOOPS, f));
const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error('缺 loop 文件：\n  ' + missing.join('\n  '));
  console.error('可用曲风目录：' + (fs.existsSync(LOOPS) ? fs.readdirSync(LOOPS).join(' / ') : '（本机没有 Apple Loops）'));
  process.exit(2);
}

/* ---------- 包络：一条曲线给每层，段落推进时密度上升，收尾回落 ---------- */
const env = (pairs) => {
  let e = String(pairs[pairs.length - 1][1]);
  for (let i = pairs.length - 2; i >= 0; i--) e = `if(lt(t,${pairs[i][0]}),${e},${pairs[i][1]})`;
  return e;
};
const lay = (i, name, expr, fadeIn) =>
  `[${i}:a]aresample=48000,aformat=channel_layouts=mono,aloop=loop=-1:size=2147483647,atrim=0:${total},` +
  `asetpts=N/SR/TB,volume='${expr}':eval=frame${fadeIn ? ',afade=t=in:st=0:d=1.6' : ''}[${name}]`;

const filters = [
  lay(0, 'a', env([[0, 0.28], [t1, 0.38], [t3, 0.44], [total * 0.9, 0.18]]), true),
  lay(1, 'b', env([[0, 0], [t1, 0.30], [t2, 0.15], [t3, 0.38], [total * 0.9, 0]])),
  lay(2, 'c', env([[0, 0], [t3, 0.34], [total * 0.9, 0]])),
  lay(3, 'd', env([[0, 0], [t2, 0.15], [t3, 0], [t3 + 2, 0.14], [total * 0.85, 0]])),
  `[a][b][c][d]amix=inputs=4:normalize=0:duration=first,alimiter=limit=0.85,afade=t=out:st=${(total - 2.2).toFixed(2)}:d=2.2[out]`,
];

const bgm = path.join(DIR, 'audio', 'bgm.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y',
  ...files.flatMap((f) => ['-i', f]),
  '-filter_complex', filters.join(';'), '-map', '[out]',
  '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', bgm]);
console.log(`✓ audio/bgm.wav  ${total.toFixed(2)}s  · ${style}  · 4 层`);

if (process.argv.includes('--dry')) process.exit(0);

/* ---------- 混音 ---------- */
const vo = path.join(DIR, 'audio', 'vo-norm.wav');
if (!fs.existsSync(vo)) { console.error('缺 audio/vo-norm.wav（先跑 make.sh 的响度归一）'); process.exit(2); }

const { buildMix } = await import(path.join(ROOT, 'src/audio-mix.mjs'));
const cues = (p.audio && p.audio.cues) || [];
const out = path.join(DIR, 'audio', 'mix-final.wav');
const r = buildMix({
  out, duration: total, mode: 'external-music', music: bgm, voice: vo,
  musicGain: 0.5, cues,
});
console.log(`✓ audio/mix-final.wav  ${r ? 'ok' : '失败'}  · ${cues.length} 条音效`);
