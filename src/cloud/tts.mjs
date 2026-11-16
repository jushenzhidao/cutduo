/**
 * src/cloud/tts.mjs · 侧车能力层的第一项：按 captions 时间窗配音
 *
 * 为什么需要它
 * ------------
 * 云端出片一直是无声的（`hasAudio: false`）。不是忘了配，是容器里只有 node，
 * 而 edge-tts 是 Python 包 —— 能力根本不存在。2026-11-16 补上。
 *
 * 为什么不做「按真实配音重排时间轴」
 * --------------------------------
 * `kits/desk/tools/build-voices.py` 走的是那条路：配音先跑，再按实测时长重排
 * 全部 shot 的 t0/t1。代价是配音一变、整片时间轴全变，且每个 kit 的内容模型不同，
 * 得为每支写一份重排逻辑。
 *
 * 这里换一个更窄的假设：**params 里已经有 captions，每条自带 {start, end} 时间窗**。
 * 配音只要塞进窗口，画面一帧都不用动。实测 13 句余量 0.9–2.28s，窗口是够的。
 * 窗口塞不下时才裁剪并记录，而不是悄悄改时间轴。
 *
 * 未来的云端能力往哪加
 * --------------------
 * 这个目录的定位是「需要网络/凭据/可能失败」的侧车能力，TTS 只是第一个。
 * 加新能力时保持同样的契约：**输入可哈希、输出落地成文件、失败可降级、命中缓存要上报**。
 * 这样调用方（api 层）不需要知道具体 provider。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG, FFPROBE, EDGE_TTS } from '../bins.mjs';

const execFileP = promisify(execFile);

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const DEFAULT_RATE = '+0%';
/** 单句合成超时。edge-tts 正常 0.6–2s/句，10s 已经很不正常了。 */
const PER_SENTENCE_TIMEOUT_MS = 15000;

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** 去掉文案里的强调标记（`*锅先开*`），TTS 不该念出星号。 */
function plain(zh) {
  return String(zh || '').replace(/\*/g, '').trim();
}

function probeDuration(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' }).trim();
  return Number(out) || 0;
}

/**
 * 逐句合成（带磁盘缓存）。
 *
 * 缓存单位是**句子**而不是整条音轨：改一句文案只重合成那一句，
 * 而不是整片重来。缓存 key 含文本、voice、rate —— 换声音必然要重录。
 */
async function synthSentence({ text, voice, rate, cacheDir }) {
  const key = sha1(`${voice}|${rate}|${text}`);
  const mp3 = path.join(cacheDir, `${key}.mp3`);
  if (fs.existsSync(mp3) && fs.statSync(mp3).size > 512) {
    return { mp3, cached: true };
  }
  await execFileP(EDGE_TTS, [
    '--voice', voice, `--rate=${rate}`, '--text', text, '--write-media', mp3,
  ], { timeout: PER_SENTENCE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size <= 512) {
    throw new Error(`edge-tts 没有产出有效音频：${text.slice(0, 20)}`);
  }
  return { mp3, cached: false };
}

/**
 * 把逐句音频按 captions 的 start 贴到一条全长音轨上。
 *
 * `normalize=0` 是刻意的：amix 默认会按输入数归一化音量，13 句一混音量掉到听不见。
 * 峰值保护留给上层的 loudnorm（见 api 层），这里只负责对齐。
 */
function mixToBed({ clips, totalSeconds, outPath }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', String(totalSeconds), '-i', 'anullsrc=r=44100:cl=mono',
  ];
  for (const c of clips) args.push('-i', c.mp3);

  const chains = clips.map((c, i) => {
    const delay = Math.round(Math.max(0, c.start) * 1000);
    // atrim 到窗口：塞不下的句子在这里被裁掉，由上层记录 overflow
    const trim = c.windowSeconds ? `,atrim=0:${c.windowSeconds.toFixed(3)}` : '';
    return `[${i + 1}:a]aresample=44100${trim},adelay=${delay}|${delay}[a${i}]`;
  });
  const mixIn = ['[0:a]', ...clips.map((_, i) => `[a${i}]`)].join('');
  const fc = `${chains.join(';')};${mixIn}amix=inputs=${clips.length + 1}:normalize=0:dropout_transition=0[out]`;

  args.push('-filter_complex', fc, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k',
    '-ar', '44100', '-ac', '1', outPath);
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * 主入口：给一份 params（带 captions）就产出一条可直接交给渲染器的音轨。
 *
 * @returns {Promise<{audio:string|null, stats:object}>} audio 为 null 表示没做（不可用/无 captions）
 */
export async function synthesizeCaptions({
  params, paramsPath, durationSeconds, cacheDir, voice, rate,
}) {
  const p = params || (paramsPath ? JSON.parse(fs.readFileSync(paramsPath, 'utf8')) : null);
  if (!p) return { audio: null, stats: { reason: 'no-params' } };

  const caps = Array.isArray(p.captions) ? p.captions.filter((c) => plain(c.zh)) : [];
  if (!caps.length) return { audio: null, stats: { reason: 'no-captions' } };

  const total = Number(durationSeconds || p.durationSeconds || 0)
    || Math.max(...caps.map((c) => Number(c.end) || 0));
  if (!(total > 0)) return { audio: null, stats: { reason: 'no-duration' } };

  const v = voice || p.voice || DEFAULT_VOICE;
  const r = rate || p.rate || DEFAULT_RATE;
  fs.mkdirSync(cacheDir, { recursive: true });

  const t0 = Date.now();
  const clips = [];
  const overflow = [];
  let hits = 0;

  for (const c of caps) {
    const text = plain(c.zh);
    const { mp3, cached } = await synthSentence({ text, voice: v, rate: r, cacheDir });
    if (cached) hits++;
    const dur = probeDuration(mp3);
    const windowSeconds = Math.max(0.2, Number(c.end) - Number(c.start));
    if (dur > windowSeconds) {
      overflow.push({ start: c.start, text: text.slice(0, 14), need: +dur.toFixed(2), window: +windowSeconds.toFixed(2) });
    }
    clips.push({ mp3, start: Number(c.start) || 0, windowSeconds, dur });
  }

  // 成品音轨也缓存：同一份 captions 重复出片不该重混
  const bedKey = sha1(`${v}|${r}|${total}|${caps.map((c) => `${c.start}:${plain(c.zh)}`).join('|')}`);
  const audioDir = path.join(path.dirname(cacheDir), 'cloud');
  fs.mkdirSync(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, `tts-${bedKey}.m4a`);

  let bedCached = false;
  if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 2048) {
    bedCached = true;
  } else {
    mixToBed({ clips, totalSeconds: total, outPath: audioPath });
  }

  return {
    audio: audioPath,
    stats: {
      sentences: caps.length,
      sentenceCacheHits: hits,
      bedCached,
      totalSeconds: +total.toFixed(2),
      elapsedMs: Date.now() - t0,
      voice: v,
      rate: r,
      overflow,
    },
  };
}

/** 侧车能力的自述：给 capabilities / health 用，说明这一层当前活到什么程度。 */
export function ttsInfo() {
  let available = false;
  let detail = '';
  try {
    execFileSync(EDGE_TTS, ['--version'], { stdio: 'ignore', timeout: 8000 });
    available = true;
  } catch (e) {
    detail = fs.existsSync(EDGE_TTS) ? String(e.message).slice(0, 120) : `未找到 ${EDGE_TTS}`;
  }
  return {
    id: 'tts',
    provider: 'edge-tts',
    available,
    defaultVoice: DEFAULT_VOICE,
    defaultRate: DEFAULT_RATE,
    failMode: 'soft',
    ...(detail ? { detail } : {}),
  };
}

export const CACHE_ROOT = path.join(os.tmpdir(), 'cutduo-tts-cache');
