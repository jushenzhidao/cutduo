#!/usr/bin/env node
/**
 * sfx-synth.mjs · 按 cue 表合成音效并混入成片
 *
 * 来源：docs/jimeng/02-音效-2026-11-16.md（原片实测：4/4 个硬切点都有瞬态，偏移 −9/+45/−2/+22ms）
 *
 *   node tools/sfx-synth.mjs --cues content/jimeng-showreel/sfx.json --dur 15 --out out/sfx.wav
 *   node tools/sfx-synth.mjs --cues ... --dur 15 --mix out/jimeng-showreel.mp4 --out out/x.mp4
 *
 * 为什么自己合成而不是找音效库：`tools/esfx-render.py` 依赖 earshot 素材包，
 * 那是**不入库的本机资源**——换机器、进 CI 就没声了。这里的四种音色全部由
 * 参数决定（确定性 PRNG），换机不失效，且能按 cue 表精确到 10ms。
 *
 * 四种音色都不是"拟真"，是**结构信号**：
 *   impact  低频下滑 + 噪声爆，告诉耳朵"这里换了场景"
 *   riser   带通噪声频率上行，告诉耳朵"马上要变"
 *   whoosh  带通噪声快速过峰，告诉耳朵"东西被移动了"
 *   tick    极短高频，告诉耳朵"新元素落位"
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);
const die = (m, code = 2) => {
  console.error(`FAIL  ${m}`);
  process.exit(code);
};

const SR = 48000;
const CUES = get('cues', 'content/jimeng-showreel/sfx.json');
const DUR = Number(get('dur', 15));
const OUT = path.resolve(get('out', 'out/sfx.wav'));
const MIX = get('mix', null);
const MIX_OUT = get('out-mixed', null) || (MIX ? MIX.replace(/\.mp4$/i, '-sfx.mp4') : null);

if (has('help') || !fs.existsSync(CUES)) die(`用法见文件头；cue 表不存在：${CUES}`);

let table;
try {
  table = JSON.parse(fs.readFileSync(CUES, 'utf8'));
} catch (e) {
  die(`${CUES} 不是合法 JSON：${e.message}`);
}
const cues = Array.isArray(table.cues) ? table.cues : [];
if (!cues.length) die('cue 表里没有 cues[]');

/* ───────────────────────────── 校验：越界必须报错，不能静默裁掉 */

const KINDS = new Set(['impact', 'riser', 'whoosh', 'tick']);
for (const [i, c] of cues.entries()) {
  if (!KINDS.has(c.kind)) die(`cue[${i}]: 未知 kind "${c.kind}"（可用：${[...KINDS].join(' / ')}）`);
  if (!Number.isFinite(c.t) || c.t < 0) die(`cue[${i}]: t 必须是非负数`);
  const d = Number.isFinite(c.dur) ? c.dur : 0.3;
  if (c.t >= DUR) die(`cue[${i}]: t=${c.t}s 已达到或超出片长 ${DUR}s —— 这个音效永远听不到`);
  if (c.t + d > DUR + 0.001) die(`cue[${i}]: t+dur=${(c.t + d).toFixed(3)}s 超出片长 ${DUR}s —— 会被截断`);
}

/* ───────────────────────────── 合成原语 */

/** 确定性 PRNG（mulberry32）：同一 cue 表永远得到同一段波形，才能做 md5 比对 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
  };
}

/** 一阶低通：截止频率可逐样本变化，用于 riser 的频率上行 */
const lowpass = (fc, sr = SR) => {
  let y = 0;
  return (x, f) => {
    const a = 1 - Math.exp((-2 * Math.PI * (f || fc)) / sr);
    y += a * (x - y);
    return y;
  };
};
const highpass = (fc, sr = SR) => {
  let y = 0;
  let px = 0;
  return (x, f) => {
    const a = 1 / (1 + (2 * Math.PI * (f || fc)) / sr);
    y = a * (y + x - px);
    px = x;
    return y;
  };
};

const nOf = (sec) => Math.max(1, Math.round(sec * SR));

/* ───────────────────────────── 四种音色 */

function impact(dur, seed) {
  const n = nOf(dur);
  const r = rng(seed);
  const out = new Float32Array(n);
  const lp = lowpass(3200);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // 低频下滑 92Hz → 38Hz，衰减 0.09s：这是"胸口"的那一下
    const f = 92 * Math.exp(-t / 0.14) + 38;
    phase += (2 * Math.PI * f) / SR;
    const thump = Math.sin(phase) * Math.exp(-t / 0.10);
    // 噪声爆 30ms：给"咔"的瞬态，没有它低频听起来像鼓而不是撞击
    const burst = lp(r()) * Math.exp(-t / 0.028);
    // 中频 click 1.8kHz / 12ms：满配乐里只有低频的话会被完全埋掉（实测全频 Δ 不到
    // 8dB，检测器认不出来，人耳也一样）。真实撞击声的"脆"都在这条频段上。
    const click = Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t / 0.012);
    out[i] = thump * 0.85 + burst * 1.2 + click * 0.62;
  }
  return out;
}

function riser(dur, seed) {
  const n = nOf(dur);
  const r = rng(seed);
  const hp = highpass(500);
  const lp = lowpass(6000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    // 中心频率指数上行 600 → 5200Hz
    const fc = 600 * Math.exp(u * Math.log(5200 / 600));
    const band = lp(hp(r(), fc * 0.6), fc * 1.8);
    // 包络：前 85% 线性渐强，最后 15% 快速收尾（让位给切点上的 impact）
    const env = u < 0.85 ? u / 0.85 : 1 - (u - 0.85) / 0.15 * 0.9;
    out[i] = band * env * 1.2;
  }
  return out;
}

function whoosh(dur, seed) {
  const n = nOf(dur);
  const r = rng(seed);
  const hp = highpass(300);
  const lp = lowpass(2600);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    // 中心频率过峰：300 → 2600 → 500
    const fc = u < 0.45
      ? 300 * Math.exp((u / 0.45) * Math.log(2600 / 300))
      : 2600 * Math.exp(((u - 0.45) / 0.55) * Math.log(500 / 2600));
    const band = lp(hp(r(), fc * 0.55), fc * 1.6);
    const env = Math.sin(Math.PI * u) ** 1.6;
    out[i] = band * env * 1.1;
  }
  return out;
}

function tick(dur, seed) {
  const n = nOf(Math.min(dur, 0.09));
  const r = rng(seed);
  const hp = highpass(4500);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = hp(r()) * Math.exp(-t / 0.006) * 1.4;
  }
  return out;
}

const GEN = { impact, riser, whoosh, tick };

/* ───────────────────────────── 铺到整条轨 */

const total = nOf(DUR);
const L = new Float32Array(total);
const R = new Float32Array(total);

for (const [i, c] of cues.entries()) {
  const dur = Number.isFinite(c.dur) ? c.dur : (c.kind === 'tick' ? 0.06 : 0.35);
  const sig = GEN[c.kind](dur, 0x9e3779b9 ^ (i * 2654435761));
  const gain = 10 ** ((Number.isFinite(c.gain) ? c.gain : -14) / 20);
  const start = Math.round(c.t * SR);
  /* 轻微的左右偏移让音效不糊在正中；按索引交替，确定性 */
  const pan = 0.5 + 0.18 * (i % 2 === 0 ? 1 : -1);
  for (let k = 0; k < sig.length; k++) {
    const j = start + k;
    if (j >= total) break;
    L[j] += sig[k] * gain * (1 - pan) * 1.4;
    R[j] += sig[k] * gain * pan * 1.4;
  }
}

/* 归一：留 3.5dB 余量。
   1.5dB 不够——与 BGM 相加后再过 aac_at，真峰值会被抬到 −0.3 dBTP（实测削波风险）。
   macOS 的 aac 编码器抬峰值是老问题，只能靠编码前多留余量。 */
let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
if (peak > 0) {
  const k = 10 ** (-3.5 / 20) / peak;
  for (let i = 0; i < total; i++) {
    L[i] *= k;
    R[i] *= k;
  }
}

/* ───────────────────────────── 写 WAV（16bit PCM） */

function writeWav(file, l, r) {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // 立体声
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), o);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), o + 2);
    o += 4;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

writeWav(OUT, L, R);
const kinds = cues.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {});
console.log(`✓ 音效轨 ${OUT}  ${DUR}s · ${cues.length} 个 cue（${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(' ')}）`);

/* ───────────────────────────── 混入（可选） */

if (MIX) {
  if (!fs.existsSync(MIX)) die(`要混的成片不存在：${MIX}`);
  const outPath = path.resolve(MIX_OUT);
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', MIX,
    '-i', OUT,
    '-filter_complex', '[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[s];[0:a][s]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy',                     // 画面不动，避免二次编码损失
    '-c:a', 'aac_at', '-b:a', '160k',
    '-ar', '48000', '-ac', '2',
    outPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) die(`混音失败：${(r.stderr || '').slice(-700)}`);
  if (!fs.existsSync(outPath)) die('混音结束但产物不存在');

  const p = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', outPath], { encoding: 'utf8' }).stdout);
  const hasAudio = (p.streams || []).some((s) => s.codec_type === 'audio');
  if (!hasAudio) die('输出没有音频流');
  console.log(`✓ 混音 ${outPath}  ${Number(p.format.duration).toFixed(3)}s  ${(p.streams || []).find((s) => s.codec_type === 'video')?.width}x${(p.streams || []).find((s) => s.codec_type === 'video')?.height}`);
}
