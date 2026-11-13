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
 * `src` 可以是文件路径，也可以是内置合成音（whoosh / tick / impact / rise）。
 * 内置音是**程序合成**，不是上游那 33 个音效 —— 上游发行时已剥离（见审查报告附录）。
 *
 * 混音交给 ffmpeg：事件用 adelay 定位、amix 叠加、sidechaincompress 做 ducking。
 * 输出 wav，再由 src/pipeline.mjs 统一转 aac（mp4 里不能放 PCM）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { FFMPEG } from './pipeline.mjs';

const SR = 48000;

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

  // 配乐在人声下让位：sidechain 用 voice 压 bed
  if (useMusic && useVoice) {
    filters.push('[bed][voice]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=280[bedd]');
    filters.push('[bedd]anull[bedUse]');
    mixLabels.push('[bedUse]');
  } else if (useMusic) {
    mixLabels.push('[bed]');
  }
  if (useVoice) mixLabels.push('[voice]');

  list.forEach((c, i) => {
    let file = c.src;
    if (BUILTIN_CUES.includes(c.src)) {
      file = path.join(tmp, `${c.src}.wav`);
      if (!fs.existsSync(file)) writeWav(file, SYNTH[c.src]());
    }
    if (!file || !fs.existsSync(file)) {
      console.warn(`  ⚠ 音效 ${c.src} 找不到，跳过（at=${c.at}s）`);
      return;
    }
    inputs.push('-i', file);
    const ms = Math.round(Number(c.at) * 1000);
    const gain = c.gain === undefined ? 0.4 : Number(c.gain);
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
    `alimiter=limit=0.95,apad=whole_dur=${Number(duration).toFixed(3)},` +
    `atrim=0:${Number(duration).toFixed(3)}[out]`
  );

  const graph = filters.join(';');
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', graph,
    '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '1',
    out,
  ]);
  return out;
}
