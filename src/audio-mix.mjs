/**
 * src/audio-mix.mjs · 动作音效事件轨 + 配乐 + 人声 ducking
 *
 * 补的是 collage 半蒸馏时缺的那一层：上游的音频不是"一条背景音乐"，
 * 而是 **33 个事件按场景重放、停留处静音、配乐在人声下 ducking**。
 * 这里实现同一套语义，资产自己出：
 *
 *   params.audio = {
 *     "mode": "effects-only" | "external-music" | "none",
 *     "music": "assets/audio/bed.m4a",          // external-music 时必填
 *     "voice": "assets/audio/vo.wav",            // 可选，用于 ducking
 *     "cues": [ { "at": 4.5, "src": "whoosh", "gain": 0.5 } ]
 *   }
 *
 * `src` 三种形态：
 *   1. 内置合成音（whoosh / tick / impact / rise）—— 程序合成，零依赖；
 *   2. **earshot 音色 id**（`cut_hit/punch`、`whoosh_fast/tight`，形如 `category/member`）
 *      —— 252 条配方音效，纯 DSP（numpy/scipy），无模型无网络，MIT。
 *      首次渲染进缓存（`~/.cache/cutduo/esfx`），之后零成本；
 *      每条自带实测 `onset_s / peak_s / end_s`，`align` 可按参考点对齐；
 *   3. 文件路径 —— 自己准备资产。
 *
 * cue 字段（除 at / src 外都可省）：
 *   gain     线性倍数，默认 0.4（旧语义，保持兼容）
 *   gainDb   dB 增益（优先于 gain；earshot 推荐表用这个，如 -8）
 *   align    "onset"（默认）| "peak" | "end"：让哪个参考点落在 at
 *   lead     额外提前量（秒，负值提前）：如嗖声要最响点晚 37ms → align:"peak", lead:+0.037
 *   dur / apex / pitch / seed  透传给 earshot 配方
 *
 * 混音交给 ffmpeg：事件用 adelay 定位、amix 叠加、sidechaincompress 做 ducking。
 * 输出 wav，再由 src/pipeline.mjs 统一转 aac（mp4 里不能放 PCM）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from './pipeline.mjs';

const SR = 48000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 内置合成音 ---------------- */

function writeWav(file, samples, sr = SR) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/** 简单的确定性噪声：不能 Math.random，否则每次渲染音效不同 */
function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 * 2 - 1;
  };
}

const SYNTH = {
  // 转场：噪声过扫描低通，起音快、尾巴长
  whoosh(len = 0.5) {
    const n = Math.floor(len * SR);
    const out = new Float32Array(n);
    const noise = rnd(0x9e3779b9);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const cutoff = 0.5 * Math.pow(1 - p, 2.2) + 0.02;  // 6000Hz → 200Hz
      lp += ((noise() * 0.9) - lp) * cutoff;
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, p * 1.1)), 0.7);
      out[i] = lp * env * 0.9;
    }
    return out;
  },
  // UI 点击：短正弦 + 一点噪声，40ms
  tick(len = 0.045) {
    const n = Math.floor(len * SR);
    const out = new Float32Array(n);
    const noise = rnd(0x1234567);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const env = Math.pow(1 - p, 6);
      out[i] = (Math.sin((2 * Math.PI * 1500 * i) / SR) * 0.7 + noise() * 0.12) * env;
    }
    return out;
  },
  // 落点：低频冲击 + 30ms 噪声
  impact(len = 0.75) {
    const n = Math.floor(len * SR);
    const out = new Float32Array(n);
    const noise = rnd(0xabcdef1);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const f = 92 - 46 * Math.min(1, p * 2.6);
      const env = Math.pow(1 - p, 3.4);
      const noiseBurst = p < 0.05 ? noise() * (1 - p / 0.05) * 0.5 : 0;
      out[i] = (Math.sin((2 * Math.PI * f * i) / SR) * 0.85 + noiseBurst) * env;
    }
    return out;
  },
  // 上升：锯齿扫频，用于"即将出现"
  rise(len = 0.6) {
    const n = Math.floor(len * SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const f = 180 + 620 * p * p;
      const ph = (2 * Math.PI * f * i) / SR;
      const saw = ((ph / (2 * Math.PI)) % 1) * 2 - 1;
      out[i] = saw * Math.pow(p, 0.8) * 0.5;
    }
    return out;
  },
};

export const BUILTIN_CUES = Object.keys(SYNTH);

/* ---------------- earshot 音效（可选依赖） ---------------- */

/** earshot 音色 id：`category/member`，两段都是小写字母数字下划线 */
const EFX_ID = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/i;

const EFX_FALLBACK = [
  [/^(cut_hit|impact|pro_impact|glitch|pro_glitch|logo_sting|pro_logo_sting)/, 'impact'],
  [/^(whoosh|swipe)/, 'whoosh'],
  [/^(riser|reverse_swell|downlifter|pro_riser)/, 'rise'],
  [/^(click|toggle|pro_pop|pro_pop_in|ui_pop|pro_typing|knock|mallet|shimmer|pro_shimmer|swish)/, 'tick'],
];

/**
 * 找 earshot 的 python。
 * - `EARSHOT_PY=none` 显式禁用（降级为内置合成音）；
 * - `EARSHOT_PY=/path` 显式指定即强制使用，找不到该路径就报错降级（不再回退探测）——
 *   否则线上机器悄悄用上本机路径，行为不可复现；
 * - 未设置时探测约定安装路径。
 */
export function earshotPython() {
  const explicit = process.env.EARSHOT_PY;
  if (explicit) return explicit === 'none' ? null : explicit;
  const cands = [
    path.join(os.homedir(), 'tools/earshot/.venv/bin/python'),
    path.join(os.homedir(), 'tools/earshot/.venv/bin/python3'),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

/** 缓存目录：同 id 同参数只渲染一次 */
function efxCacheDir() {
  return process.env.EARSHOT_CACHE || path.join(os.homedir(), '.cache', 'cutduo', 'esfx');
}

/** 缓存文件名：参数参与哈希，改参数自然换 key */
function efxCachePath(c) {
  const sig = [c.src, c.dur ?? '', c.apex ?? '', c.pitch ?? '', c.seed ?? ''].join('|');
  const h = crypto.createHash('sha1').update(sig).digest('hex').slice(0, 10);
  return path.join(efxCacheDir(), `${c.src.replace('/', '__')}-${h}.wav`);
}

function efxFallbackId(src) {
  for (const [re, id] of EFX_FALLBACK) if (re.test(src)) return id;
  return 'tick';
}

function linearGain(c) {
  if (c.gainDb !== undefined && c.gainDb !== null) return Math.pow(10, Number(c.gainDb) / 20);
  return c.gain === undefined ? 0.4 : Number(c.gain);
}

/**
 * 批量把 earshot cue 渲染成 wav（缓存命中则跳过）。
 * @returns {Map<string,{file:string,onset:number,peak:number,end:number}>} key = cachePath
 */
function ensureEfx(list) {
  const need = new Map();   // cachePath → spec item
  for (const c of list) {
    const out = efxCachePath(c);
    if (!need.has(out)) need.set(out, {
      id: c.src, out,
      dur: c.dur ?? null, apex: c.apex ?? null,
      pitch: c.pitch ?? null, seed: c.seed ?? null,
    });
  }
  const py = earshotPython();
  if (!py) return null;                      // 调用方决定降级

  const spec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'esfx-')), 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ items: [...need.values()] }));

  let out;
  try {
    out = execFileSync(py, [path.join(ROOT, 'tools/esfx-render.py'), '--spec', spec], {
      encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    // 非零退出时 stdout 里仍有 JSON（见脚本约定），优先用它
    out = e.stdout || '';
    if (!out) return null;
  }
  let j;
  try { j = JSON.parse(out.trim().split('\n').pop()); } catch { return null; }

  const map = new Map();
  for (const it of j.items || []) {
    map.set(it.file, { file: it.file, onset: it.onset_s ?? 0, peak: it.peak_s ?? 0, end: it.end_s ?? 0 });
  }
  const cached = (j.items || []).filter((i) => i.cached).length;
  const fresh = (j.items || []).length - cached;
  const bad = (j.errors || []).length;
  if (fresh || bad) {
    console.log(`  earshot 音效 ${j.items.length} 条（新渲染 ${fresh}，缓存 ${cached}${bad ? `，失败 ${bad}` : ''}）`);
  }
  // earshot 的 checks 是 warning 级（尾部截断、音高爬升、点击声…），不阻断交付但必须可见；
  // 只在"新渲染"时提示，缓存命中不重复刷屏。
  for (const i of j.items || []) {
    if (!i.cached && i.checks_ok === false && i.checks_summary) {
      console.warn(`  ⚠ earshot 自检 ${i.checks_summary}`);
    }
  }
  for (const e of j.errors || []) console.warn(`  ⚠ earshot ${e.id}: ${e.error}`);
  return map.size ? map : null;
}

/** 按参考点算延迟（秒）：让 onset/peak/end 落在 at + lead */
function efxDelay(c, meta) {
  const base = Number(c.at) + (c.lead === undefined ? 0 : Number(c.lead));
  const align = c.align || 'onset';
  const ref = align === 'peak' ? meta.peak : align === 'end' ? meta.end : meta.onset;
  return base - (ref || 0);
}

/* ---------------- 混音 ---------------- */

/**
 * @returns {string|null} 混音后的 wav 路径；null = 无音频可用
 */
export function buildMix({ out, duration, mode = 'external-music', music, voice, cues = [], musicGain = 0.55 }) {
  if (mode === 'none') return null;
  const useMusic = mode === 'external-music' && music && fs.existsSync(music);
  const useVoice = voice && fs.existsSync(voice);
  const list = (cues || []).filter((c) => c && Number(c.at) >= 0);

  if (!useMusic && !useVoice && !list.length) return null;

  // 先把 earshot 那部分批量渲好（一次进程），失败则整批降级
  const efxCues = list.filter((c) => c.src && !BUILTIN_CUES.includes(c.src) && EFX_ID.test(c.src) && !fs.existsSync(String(c.src)));
  let efxMeta = null;
  if (efxCues.length) {
    efxMeta = ensureEfx(efxCues);
    if (!efxMeta) {
      const py = earshotPython();
      const why = py ? `${py} 无法执行` : '未找到 earshot，可设 EARSHOT_PY';
      console.warn(`  ⚠ earshot 不可用（${why}），${efxCues.length} 条音效降级为内置合成音`);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'));
  const inputs = [];
  const filters = [];
  const mixLabels = [];
  let idx = 0;

  if (useMusic) {
    inputs.push('-i', music);
    filters.push(`[${idx}:a]aresample=${SR},volume=${musicGain},aformat=channel_layouts=mono[bed]`);
    idx++;
  }
  if (useVoice) {
    inputs.push('-i', voice);
    filters.push(`[${idx}:a]aresample=${SR},aformat=channel_layouts=mono[voice]`);
    idx++;
  }

  // 配乐在人声下让位：sidechain 用 voice 压 bed。
  // voice 要同时做"触发 sidechain"和"进最终混音"两件事，**必须显式 asplit**：
  // 直接两次引用 [voice] 时第二个分支拿到的是空 pad，旁白会从成片里消失
  // （2026-11-14 实测：105s 片混完 -21.0 LUFS，比旁白单独 -16.9 还低，就是这个原因）。
  if (useMusic && useVoice) {
    filters.push('[voice]asplit=2[voiceKey][voiceMix]');
    filters.push('[bed][voiceKey]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=280[bedd]');
    filters.push('[bedd]anull[bedUse]');
    mixLabels.push('[bedUse]', '[voiceMix]');
  } else if (useMusic) {
    mixLabels.push('[bed]');
    if (useVoice) mixLabels.push('[voice]');
  } else if (useVoice) {
    mixLabels.push('[voice]');
  }

  list.forEach((c, i) => {
    let file = c.src;
    let at = Number(c.at);
    let name = c.src;

    if (BUILTIN_CUES.includes(c.src)) {
      file = path.join(tmp, `${c.src}.wav`);
      if (!fs.existsSync(file)) writeWav(file, SYNTH[c.src]());
    } else if (efxMeta && EFX_ID.test(String(c.src))) {
      const meta = efxMeta.get(efxCachePath(c));
      if (meta) {
        file = meta.file;
        at = efxDelay(c, meta);          // 参考点对齐
        name = `${c.src}@${c.align || 'onset'}`;
      } else {
        // 单条渲染失败：降级
        const fb = efxFallbackId(c.src);
        file = path.join(tmp, `${fb}-${i}.wav`);
        writeWav(file, SYNTH[fb]());
        name = `${c.src}→${fb}`;
      }
    } else if (EFX_ID.test(String(c.src)) && !fs.existsSync(String(c.src))) {
      // earshot 整批不可用：按 category 降级为语义相近的内置音
      const fb = efxFallbackId(c.src);
      file = path.join(tmp, `${fb}-${i}.wav`);
      writeWav(file, SYNTH[fb]());
      name = `${c.src}→${fb}`;
    }

    if (!file || !fs.existsSync(file)) {
      console.warn(`  ⚠ 音效 ${c.src} 找不到，跳过（at=${c.at}s）`);
      return;
    }
    if (at < 0) {
      console.warn(`  ⚠ 音效 ${name} 对齐后落在负时间（${at.toFixed(3)}s），钳到 0`);
      at = 0;
    }
    inputs.push('-i', file);
    const ms = Math.round(at * 1000);
    const gain = linearGain(c);
    filters.push(`[${idx}:a]aresample=${SR},volume=${gain},aformat=channel_layouts=mono,adelay=${ms}:all=1[c${i}]`);
    mixLabels.push(`[c${i}]`);
    idx++;
  });

  if (!mixLabels.length) return null;

  const total = Math.max(1, mixLabels.length);
  filters.push(
    // amix 的 duration=longest 取的是**输入**最长者；最后一条音效在 53s 结束时，
    // 输出就只有 53s，成片音轨会短 4s。必须先 apad 补到目标时长再 atrim。
    `${mixLabels.join('')}amix=inputs=${total}:normalize=0:duration=longest,` +
    // level=false 是关键：alimiter 默认 auto level=true 会把峰值**抬回** limit，
    // 等于没限幅（实测成片真峰值 0.2 dBTP，加音效后必越线）。
    // limit=0.86 ≈ -1.3 dBFS：AAC 编码会有 inter-sample 过冲，混音阶段要留出这 1 dB。
    `alimiter=limit=0.86:level=false,apad=whole_dur=${Number(duration).toFixed(3)},` +
    `atrim=0:${Number(duration).toFixed(3)}[out]`
  );

  const graph = filters.join(';');
  if (process.env.MIX_DEBUG) console.error('[mix graph]\n' + graph + '\n[inputs]\n' + inputs.filter((x) => x !== '-i').join('\n'));
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', graph,
    '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '1',
    out,
  ]);
  return out;
}
