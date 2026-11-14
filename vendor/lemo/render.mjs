#!/usr/bin/env node
/**
 * render.mjs · midcentury-toon 一条命令出片
 *
 *   node vendor/lemo/render.mjs --params content/lemo-vacuum/script.json --out out/x.mp4
 *   node vendor/lemo/render.mjs --params <script.json> --out <mp4> --audio <mix.m4a>   # 跳过配音与混音
 *
 * 流程：配音（缺就 TTS）→ 时长 → 页面算时间轴 → 混音 → 渲染画面 → 封装 → 自检。
 *
 * 为什么先配音再排版：这支风格的段落长度按旁白时长取整到 132 BPM 的小节，
 * 顺序反了会得到"画面等声音"或"声音被切"。durs 是时间线的输入，不是输出。
 *
 * 为什么混音时刻表问页面要：页面对每一步有 J-cut（旁白提前半拍），
 * 外部按内容顺序猜时间必然差半拍。window.SRT 是唯一事实来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));           // vendor/lemo
const DEMO = path.join(HERE, 'styles/midcentury-toon/demo');
const REPO = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);

const PARAMS = arg('params');
const OUT = arg('out');
const AUDIO_IN = arg('audio');
const FPS = Number(arg('fps', 24));
const WORKERS = Number(arg('workers', 4));
const CRF = Number(arg('crf', 20));
const VOICE_RATE = arg('rate', '+6%');
const BGM_STYLE = arg('bgm', 'chillwave');
const BGM_BPM = Number(arg('bpm', 100));
const KEEP = flag('keep');                                           // 保留中间产物，便于查错

if (!PARAMS || !OUT) {
  console.error(`用法: node vendor/lemo/render.mjs --params <script.json> --out <mp4>
  --audio <mix.m4a>   自带音轨（跳过 TTS 与混音）
  --fps 24 --workers 4 --crf 20
  --bgm chillwave --bpm 100 --rate +6%
  --keep              保留 out/.lemo-work 里的中间产物`);
  process.exit(2);
}

const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };
const say = (msg) => console.log('  ' + msg);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) die(`${cmd} 失败（${r.status}）\n${(r.stderr || '').trim().split('\n').slice(-6).join('\n')}`);
  return r;
};
const probeDur = (f) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).stdout.trim());
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

// ---------------------------------------------------------------- 0. 参数
if (!fs.existsSync(PARAMS)) die(`找不到内容文件：${PARAMS}`);
const content = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
const steps = content.steps || [];
if (steps.length < 2 || steps.length > 5) die(`steps 必须是 2–5 个（现在是 ${steps.length}）：页面的三步版式按 3 写死，超过 3 个锁版会挤`);
for (const [i, s] of steps.entries()) if (!s.title || !s.line) die(`steps[${i}] 缺 title 或 line`);
if (!content.hook?.line || !content.payoff?.plan || !content.outro?.line) die('缺 hook.line / payoff.plan / outro.line');

const work = path.join(REPO, 'out/.lemo-work', sha(fs.readFileSync(PARAMS)) + '-' + process.pid);
fs.mkdirSync(work, { recursive: true });
const id = path.basename(PARAMS, '.json');
const audioDir = path.join(path.dirname(PARAMS), 'audio');
fs.mkdirSync(audioDir, { recursive: true });

// ---------------------------------------------------------------- 1. 配音（缺哪句补哪句）
const keys = ['hook', ...steps.map((_, i) => 'step' + i), 'tip', 'outro'];
const lines = { hook: content.hook.line, tip: content.tip?.line || '', outro: content.outro.line };
steps.forEach((s, i) => { lines['step' + i] = s.line; });

const voice = content.voice?.id || 'zh-CN-YunyangNeural';
const ttsWav = {};
if (!AUDIO_IN) {
  say(`配音 · ${voice}`);
  for (const k of keys) {
    const wav = path.join(audioDir, k + '.wav');
    const txt = path.join(audioDir, k + '.txt');
    const want = lines[k] || '';
    const have = fs.existsSync(wav) && fs.existsSync(txt) && fs.readFileSync(txt, 'utf8') === want;
    if (!have) {
      if (!want) die(`${k} 没有文案，但页面需要它`);
      const mp3 = path.join(work, k + '.mp3');
      const r = spawnSync('edge-tts', ['--voice', voice, `--rate=${VOICE_RATE}`, '--text', want, '--write-media', mp3], { encoding: 'utf8' });
      if (r.status !== 0) {
        // 换机/断网时不要静默出无声片
        die(`edge-tts 合成失败（${k}）：${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}\n` +
            `  修法：联网后重试；或自己放好 ${wav} 与同名 .txt，再带 --audio 跳过配音`);
      }
      run('ffmpeg', ['-v', 'error', '-y', '-i', mp3, '-ar', '48000', '-ac', '1', wav]);
      fs.writeFileSync(txt, want);
    }
    ttsWav[k] = wav;
  }
}

// ---------------------------------------------------------------- 2. 时长 + 3. 时间轴
let durs = {};
if (!AUDIO_IN) {
  for (const k of keys) durs[k] = Math.round(probeDur(ttsWav[k]) * 1000) / 1000;
  say('时长 · ' + keys.map((k) => `${k} ${durs[k]}s`).join(' · '));
}

const tag = sha(JSON.stringify({ c: content, d: durs }));
const stageContent = path.join(DEMO, `content-${tag}.json`);
const stageDurs = path.join(DEMO, `durs-${tag}.json`);
fs.writeFileSync(stageContent, JSON.stringify(content, null, 1));
fs.writeFileSync(stageDurs, JSON.stringify(durs, null, 1));

function chromium() {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const cache = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cache)) return undefined;                        // 交给 playwright 自己找
  const dirs = fs.readdirSync(cache).filter((n) => n.startsWith('chromium_headless_shell-')).sort();
  for (const d of dirs.reverse()) {
    for (const rel of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(cache, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const q = `content=${path.basename(stageContent)}&durs=${path.basename(stageDurs)}`;
// page.mjs 在模块顶层读 PLAYWRIGHT_CHROME，必须先设环境再 import，否则拿到的还是 undefined
const exe = chromium();
if (exe) process.env.PLAYWRIGHT_CHROME = exe;
const { openDemo, closeServer } = await import('./core/render/page.mjs');

let DUR = 0, SRT = [];
{
  const { browser, page } = await openDemo(DEMO, { q });
  const info = await page.evaluate(() => ({ DUR: window.DUR, SRT: window.SRT }));
  DUR = Number(info.DUR); SRT = info.SRT || [];
  await browser.close(); closeServer();
}
if (!(DUR > 0)) die('页面没有给出正的 window.DUR：内容或 durs 坏了');
say(`时间轴 · ${DUR.toFixed(2)}s / ${SRT.length} 条旁白`);

// ---------------------------------------------------------------- 4. 混音
let audioPath = AUDIO_IN;
if (!audioPath) {
  const bgm = path.join(work, 'bgm.wav');
  run('node', [path.join(REPO, 'tools/synth-bgm.mjs'), '--out', bgm, '--duration', String(DUR + 0.2), '--style', BGM_STYLE, '--bpm', String(BGM_BPM)], { cwd: REPO });

  // 旁白落在页面给的 t0 上；顺序与 SRT 一致（hook → steps → tip → outro）
  const cues = SRT.slice(0, keys.length);
  if (cues.length !== keys.length) die(`页面只给了 ${cues.length} 条时间点，期望 ${keys.length}`);
  const inputs = [];
  for (const k of keys) inputs.push('-i', ttsWav[k]);
  inputs.push('-i', bgm);

  const build = (gain) => {
    const parts = [];
    keys.forEach((k, i) => {
      const ms = Math.round(cues[i].t0 * 1000);
      parts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`);
    });
    parts.push(`[${keys.length}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.16[bg]`);
    parts.push(`${keys.map((_, i) => `[v${i}]`).join('')}[bg]amix=inputs=${keys.length + 1}:normalize=0,` +
      `acompressor=threshold=0.09:ratio=3.2:attack=6:release=260:makeup=9,volume=${gain}dB,` +
      `alimiter=limit=0.74:level=false:attack=5:release=50[out]`);
    return parts.join(';');
  };
  const measure = (f) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
    const i = /"input_i" : "(-?[\d.]+)"/.exec(r.stderr); const tp = /"input_tp" : "(-?[\d.]+)"/.exec(r.stderr);
    return { i: i ? Number(i[1]) : NaN, tp: tp ? Number(tp[1]) : NaN };
  };
  const raw = path.join(work, 'mix-raw.wav');
  run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', build(0), '-map', '[out]', '-ar', '44100', '-ac', '2', raw]);
  const m = measure(raw);
  const gain = Math.round((-16 - m.i) * 100) / 100;
  // macOS 原生 aac 会在这类密集内容上把真峰值抬 ~10dB；aac_at 正常。编码后再测一次。
  const enc = (['aac_at', 'aac']).find((c) => spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout.includes(c));
  audioPath = path.join(work, 'mix.m4a');
  // 限幅器会吃掉一部分增益，一次算不准：测一次、修一次，最多两轮
  let g = gain, f = { i: NaN, tp: NaN };
  for (let pass = 0; pass < 3; pass++) {
    run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', build(g), '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', enc, '-b:a', '192k', audioPath]);
    f = measure(audioPath);
    if (Math.abs(f.i + 16) <= 0.4 || pass === 2) break;
    g = Math.round((g - (f.i + 16)) * 100) / 100;
  }
  say(`混音 · ${f.i.toFixed(1)} LUFS / ${f.tp.toFixed(1)} dBTP（${enc}，增益 ${g}dB）`);
  if (f.tp > -0.5) die(`真峰值 ${f.tp} dBTP 超 -0.5：先降 PARAMS 的音量或换编码器，不要硬出`);
}

// ---------------------------------------------------------------- 5. 画面
const silent = path.join(work, 'video.mp4');
const t0 = Date.now();
const r = spawnSync('node', [path.join(HERE, 'core/render/video.mjs'), DEMO, '--fps', String(FPS), '--workers', String(WORKERS), '--q', q, '--out', silent], { cwd: HERE, encoding: 'utf8' });
if (r.status !== 0) die(`画面渲染失败：\n${(r.stderr || '').trim().split('\n').slice(-8).join('\n')}`);
say(`画面 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- 6. 封装 + 自检
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
run('ffmpeg', ['-v', 'error', '-y', '-i', silent, '-i', audioPath, '-c:v', 'libx264', '-preset', 'medium',
  '-crf', String(CRF), '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', OUT]);

const size = (fs.statSync(OUT).size / 1048576).toFixed(1);
const aud = run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', OUT]).stdout.trim();
say(`成片 · ${probeDur(OUT).toFixed(2)}s / ${size}MB / 音轨 ${aud}`);
if (aud !== 'aac') die(`音轨是 ${aud}，mp4 不吃非 aac：检查 --audio 的来源`);

if (!KEEP) {
  fs.rmSync(work, { recursive: true, force: true });
} else {
  say(`中间产物 · ${work}`);
}
fs.rmSync(stageContent, { force: true });
fs.rmSync(stageDurs, { force: true });
console.log(`✓ ${path.resolve(OUT)}`);
