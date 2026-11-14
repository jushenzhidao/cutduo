#!/usr/bin/env node
/**
 * synth-bgm.mjs — 代码合成配乐（零外部音频资产、零新依赖）
 *
 *   node tools/synth-bgm.mjs --out assets/audio/bgm/lofi-90.wav --duration 90 --bpm 84 --style lofi
 *   node tools/synth-bgm.mjs --style electrohouse --duration 62 --params content/x/params-abs.json
 *
 * 为什么要有：`tools/audio-bed.mjs` 依赖本机 Apple Loops（`/Library/Audio/Apple Loops/Apple`），
 * 那是**不入库的本机资源**——换一台机器、进 CI，配乐直接出不来；每换一种曲风还要手工调 TRIM
 * （实测 hiphop 要 ×2.6，因为 Afloat 比 electrohouse 低 9–13 dB）。
 *
 * 这里改成从零合成：参数在代码里，输出可复现，换机不失效。
 *
 * 架构约定吸收自 mg-styles-15 的 mgaudio（numpy+numba+pedalboard 的完整 DSP 库）：
 *   · 声音 = 缓冲 + 同步点（这里配乐不用同步点，但音效接口将来照此设计）
 *   · form 以 drop 为锚：intro → build → drop → outro，和声从 drop 起算（intro 走进行末尾=回转）
 *   · music 与 sfx 分两组（本工具只做 music；音效仍由 buildMix 的 cues 负责）
 * 但不移植它的实现：那套依赖 numpy/numba/pedalboard，与本仓「Skia 直出、零浏览器」的取向相反。
 * 本文件纯 Node（Float32Array + 一阶 IIR），确定性，90s 约 1–2 秒算完。
 *
 * 与 mgaudio 的差异（明确的取舍）：
 *   · 音色简单（正弦/锯齿 + 一阶滤波），没有 PolyBLEP 抗混叠、没有 FM/Karplus-Strong
 *   · 但**段落能和画面段边界对齐**——mgaudio 面向 10s demo，段边界是固定比例；我们的 drop
 *     直接取 params 里信息最满的那一段起点，配乐的高潮和画面高潮是同一个时刻
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FFMPEG, FFPROBE } from '../src/bins.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const OUT = arg('out');
const DUR = Number(arg('duration', 0)) || 0;
const STYLE = arg('style', 'electrohouse');
const BPM_ARG = Number(arg('bpm', 0)) || 0;
const PARAMS = arg('params');
const SR = 48000;
const ROOT_OFFSET = Number(arg('root', 0));   // 半音偏移，用于换调

if (!OUT) {
  console.error(`用法: node tools/synth-bgm.mjs --out <wav> --duration <秒> [--style <曲风>] [--bpm <n>] [--params <json>]

  --style   electrohouse | chillwave | hiphop | ambient（缺省 electrohouse）
  --bpm     不给就用曲风默认
  --params  给了就从段边界推 drop（信息最满的那一段起点），配乐高潮与画面高潮对齐
  --root    半音偏移（换调），缺省 0`);
  process.exit(2);
}

/* ---------------- 曲风 ---------------- */

// 音阶用半音偏移；prog 是和声进行的根音（相对主音的半音数）
const STYLES = {
  electrohouse: {
    bpm: 122, root: 57 /* A3 */, scale: [0, 3, 5, 7, 10], prog: [0, 0, 5, 3],
    kick: 'four', bass: 'offbeat', padWave: 'saw', padLevel: 0.16, bassLevel: 0.30, hatLevel: 0.10,
  },
  chillwave: {
    bpm: 84, root: 53 /* F3 */, scale: [0, 2, 4, 7, 9], prog: [0, 5, 3, 4],
    kick: 'soft', bass: 'half', padWave: 'sine', padLevel: 0.22, bassLevel: 0.26, hatLevel: 0.05,
  },
  hiphop: {
    bpm: 88, root: 52 /* E3 */, scale: [0, 3, 5, 7, 10], prog: [0, 8, 5, 7],
    kick: 'boombap', bass: 'sub', padWave: 'sine', padLevel: 0.20, bassLevel: 0.32, hatLevel: 0.08,
  },
  ambient: {
    bpm: 72, root: 52, scale: [0, 2, 4, 7, 9], prog: [0, 5, 3, 4],
    kick: 'none', bass: 'none', padWave: 'sine', padLevel: 0.30, bassLevel: 0, hatLevel: 0,
  },
};

const S = STYLES[STYLE];
if (!S) { console.error(`不认识的曲风：${STYLE}（可选：${Object.keys(STYLES).join(' / ')}）`); process.exit(2); }
const BPM = BPM_ARG || S.bpm;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

/* ---------------- 时长与段落 ---------------- */

let dur = DUR;
let drop = null;
if (PARAMS && fs.existsSync(PARAMS)) {
  const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
  const sc = P.scenes || [];
  if (!dur) dur = Number(P.durationSeconds) || 0;
  // drop = 信息最满的那一段起点：优先 chart/grid/number，其次最长的段
  const rank = { chart: 0, grid: 1, number: 2, compare: 3, steps: 4 };
  const cand = sc.filter((s) => Number.isFinite(Number(s.t0)))
    .sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || (b.t1 - b.t0) - (a.t1 - a.t0));
  if (cand.length) drop = Number(cand[0].t0);
}
if (!dur) dur = 60;
if (!(dur > 1)) { console.error(`时长不对：${dur}`); process.exit(2); }

// form：drop 缺省落在 42%（mgaudio 的默认），build 提前 2 小节进场。
// 必须夹在片长内：BAR*2 在慢曲风下是 6.7s，5 秒的片子会算出 drop=6.7s、outro=13.3s（全在片外，
// energy() 于是整片走 intro 分支，段落结构失效）。实测 5s/72bpm 就是这个数。
if (drop == null || !(drop > 0) || drop > dur - 1) {
  drop = Math.max(0.4, Math.min(dur * 0.42, dur - 0.9));
}
const build = Math.max(0, Math.min(drop - BAR * 2, drop * 0.6));
// outro 不该总压在最后 2 小节：90s 的片子若 drop 一路到 87s，等于 84% 都是最高能量，
// 段落结构就没了。让 outro 落在 drop 之后的 78% 处，并至少留 2 小节收尾。
// outro 同样夹在片长内，且必须 > drop（短片里 BAR*2 会把它顶到片外）
const outroMin = drop + Math.min(BAR * 2, (dur - drop) * 0.5);
const outro = Math.max(drop + 0.2, Math.min(dur - 0.25, Math.max(outroMin, drop + (dur - drop) * 0.78)));

// 能量曲线：intro 0.34 → build 0.52 → drop 1.0 → outro 0.55 → 收尾 0.3
const CYCLE = BAR * 8;        // 8 小节为一个呼吸周期（副歌—过门—副歌）
function energy(t) {
  if (t < build) return 0.34 + 0.06 * (t / Math.max(1e-6, build));
  if (t < drop) return 0.40 + 0.60 * ((t - build) / Math.max(1e-6, drop - build));
  if (t < outro) {
    // drop 内部按 8 小节呼吸：最后 2 小节回落到 0.62，再顶起来。
    // 不做这一层，长片的 drop 段是一条 75 秒的直线（实测 90s 片 drop 从 11.4s 到 87.1s）。
    const k = ((t - drop) % CYCLE) / CYCLE;
    if (k > 0.75) return 1.0 - 0.38 * ((k - 0.75) / 0.25);
    return 1.0;
  }
  const k = (t - outro) / Math.max(1e-6, dur - outro);
  return 1.0 - 0.7 * k;
}

/* ---------------- 确定性 PRNG（不用 Math.random） ---------------- */

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {                       // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;     // [0,1)
  };
}
const rng = makeRng(0x9e3779b9);

/* ---------------- 振荡器与滤波 ---------------- */

const TAU = Math.PI * 2;
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** 一阶 IIR 低通：够用且绝对稳定。a 由截止频率算 */
function lowpassCoeff(fc, sr = SR) {
  const x = Math.exp(-TAU * fc / sr);
  return 1 - x;
}

/** 锯齿（有混叠，配合低通后听感可接受；本工具只做铺底） */
const saw = (phase) => 2 * (phase - Math.floor(phase)) - 1;

/* ---------------- 渲染 ---------------- */

const N = Math.ceil(dur * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);

const lpPadL = { y: 0 }, lpPadR = { y: 0 };
const lpBass = { y: 0 };
let prevHat = 0;

const padA = lowpassCoeff(1800);
const bassA = lowpassCoeff(220);

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const e = energy(t);
  const inDrop = t >= drop && t < outro;
  const beatPhase = (t % BEAT) / BEAT;
  const barPos = (t % BAR) / BAR;
  const barIdx = Math.floor(t / BAR);

  // ── Pad：本小节的和弦（根音 + 三音 + 五音），drop 后叠一层高八度
  const chordRoot = S.root + ROOT_OFFSET + S.prog[barIdx % S.prog.length];
  const third = S.scale.includes(4) ? 4 : 3;        // 大调三音 4 / 小调三音 3
  let pad = 0;
  for (const iv of [0, third, 7]) {
    const f = hz(chordRoot + iv);
    const ph = t * f;
    pad += S.padWave === 'saw' ? saw(ph) * 0.5 : Math.sin(TAU * ph);
  }
  if (inDrop) pad += 0.5 * Math.sin(TAU * t * hz(chordRoot + 12));
  pad /= 3;
  // 慢呼吸（0.07Hz）+ 段落能量
  const breath = 0.82 + 0.18 * Math.sin(TAU * 0.07 * t);
  const padSig = pad * S.padLevel * e * breath;
  lpPadL.y += padA * (padSig - lpPadL.y);
  // 右声道轻微失谐，避免单声道塌陷（不做 Haas 延迟——那不明空）
  lpPadR.y += padA * (padSig * 1.004 - lpPadR.y);

  // ── Bass：按 kick 型决定触发点
  let bassEnv = 0, bassF = 0;
  if (S.bass === 'offbeat') {
    const p = (t % BEAT) / BEAT;
    if (p > 0.5) { bassEnv = Math.exp(-6 * (p - 0.5)); }
    bassF = hz(chordRoot - 12);
  } else if (S.bass === 'half') {
    const p = (t % (BEAT * 2)) / (BEAT * 2);
    bassEnv = Math.exp(-2.6 * p) * (p < 0.9 ? 1 : 0);
    bassF = hz(chordRoot - 12);
  } else if (S.bass === 'sub') {
    const p = (t % BAR) / BAR;
    bassEnv = 0.7 + 0.3 * Math.exp(-3 * (p % 0.5) / 0.5);
    bassF = hz(chordRoot - 12);
  }
  if (bassF > 0) {
    const bs = Math.sin(TAU * t * bassF) * S.bassLevel * bassEnv * e;
    lpBass.y += bassA * (bs - lpBass.y);
  }

  // ── Kick
  let kick = 0;
  const kphase = (t % BEAT) / BEAT;
  const kOn = S.kick === 'four' ? true
    : S.kick === 'soft' ? kphase < 0.5
      : S.kick === 'boombap' ? (barPos < 0.26 || (barPos > 0.5 && barPos < 0.76)) : false;
  if (kOn && kphase < 0.32) {
    // 音高包络：160Hz → 45Hz，指数下坠，这是 kick 的"皮"
    const f = 45 + 115 * Math.exp(-26 * kphase * BEAT);
    // 2ms 起音：不加这一步，波形从 0 突跳到峰值，频谱上是一根贯穿全频段的竖线（click 声）
    const atk = Math.min(1, (kphase * BEAT) / 0.002);
    kick = Math.sin(TAU * t * f) * atk * Math.exp(-7.5 * (kphase * BEAT) / 0.1) * 0.55 * e;
  }

  // ── Hat：高通噪声，八分音符
  let hat = 0;
  const hphase = (t % (BEAT / 2)) / (BEAT / 2);
  if (S.hatLevel > 0 && hphase < 0.18) {
    const n = rng() * 2 - 1;
    const hp = n - prevHat; prevHat = n;            // 一阶差分≈高通
    const hatAtk = Math.min(1, (hphase * BEAT / 2) / 0.001);
    hat = hp * hatAtk * Math.exp(-38 * hphase) * S.hatLevel * e;
  }

  const mono = lpPadL.y + lpBass.y + kick * 0.9 + hat;
  L[i] = mono;
  R[i] = lpPadR.y + lpBass.y + kick * 0.9 + hat * 0.6;
}

/* ---------------- 归一化 + 写 wav ---------------- */

// 峰值归一到 -3 dBFS（真正的 -20 LUFS 交给下面 ffmpeg loudnorm，避免二次削顶）
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = peak > 0 ? 0.7079 / peak : 1;

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
const raw = path.join(path.dirname(path.resolve(OUT)), '.synth-raw.wav');
writeWav(raw, L, R, g, SR);

// 用 ffmpeg 做两件事：响度归一到 -20 LUFS（BGM 层级，人声之下）、真峰值 ≤ -1.5 dBTP。
// 不做的话，"多大音量"就取决于曲风的鼓点密度——实测四种曲风峰值差 6 dB 以上。
execFileSync(FFMPEG, [
  '-v', 'error', '-y', '-i', raw,
  '-af', 'loudnorm=I=-20:TP=-1.5:LRA=9',
  '-ar', String(SR), '-ac', '2', '-c:a', 'pcm_s16le', OUT,
]);
fs.unlinkSync(raw);

const d = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], { encoding: 'utf8' }).trim());
console.log(`✓ ${path.relative(process.cwd(), OUT)}`);
console.log(`  ${STYLE} · ${BPM}bpm · ${d.toFixed(2)}s · drop ${drop.toFixed(1)}s (build ${build.toFixed(1)}s / outro ${outro.toFixed(1)}s)`);

/* ---------------- WAV 写入（16-bit PCM） ---------------- */

function writeWav(file, l, r, gain, sr) {
  const n = l.length;
  const data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28);
  data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, l[i] * gain));
    const b = Math.max(-1, Math.min(1, r[i] * gain));
    data.writeInt16LE((a * 32767) | 0, o); o += 2;
    data.writeInt16LE((b * 32767) | 0, o); o += 2;
  }
  fs.writeFileSync(file, data);
}
