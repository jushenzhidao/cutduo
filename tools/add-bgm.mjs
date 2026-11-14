#!/usr/bin/env node
/**
 * add-bgm.mjs — 给成片加背景音乐（带 sidechain 下潜）
 *
 * 三个动作，一条命令：
 *   1. 把音乐循环/裁到与视频等长，首尾淡入淡出、轻微低通（去掉刺耳的高频齿音）；
 *   2. 用 voice 当 sidechain 把音乐压下去（说话时自动下潜，句间回弹）——不做这一步，
 *      要么 BGM 盖人声、要么把 BGM 调到听不见；
 *   3. 只做固定增益 + 限幅，**不做 loudnorm**——单趟 loudnorm 是动态增益，段间电平被来回拉，
 *      实测加 BGM 后同一秒反而比原片低 2.8 dB（听感"忽大忽小"），所以不用。
 *      ⇒ 响度必须在**配音环节**归一（见下方"旁白电平"），成片这里补不回来。
 *
 *   node tools/add-bgm.mjs --video in.mp4 --loop "Mellow Drizzle Soft Pad" --out out.mp4
 *   node tools/add-bgm.mjs --video in.mp4 --music /path/track.m4a --gain -20 --out out.mp4
 *
 * 曲库：默认从本机 Apple Loops 里按名字找（GarageBand 随系统装）。**不把 .caf 拷进仓库**——
 * Apple Loops 的许可允许用在作品里，不允许单独再分发循环素材。所以这里只记路径，
 * 成片里混好的音轨随成片走。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const VIDEO = arg('video');
const OUT = arg('out');
const AUDIO = arg('audio', null);   // 独立人声/旁白轨：给了就不从视频里取，避免「先压 160k 再压 192k」的二次有损
const MUSIC = arg('music', null);
const LOOP = arg('loop', 'Mellow Drizzle Soft Pad');
const GAIN = Number(arg('gain', -15));      // 音乐基础电平（dB）：配乐自身 RMS 约 -15dBFS，压到 -30 左右
const DUCK = arg('duck', 'on');
const DUCK_THR = Number(arg('duck-thr', 0.125));   // ≈ -18dBFS：人声正常音量刚好在阈值上，只有重音才压
const DUCK_RATIO = Number(arg('duck-ratio', 2.5));
const FADE_IN = Number(arg('fade-in', 2.0));
const FADE_OUT = Number(arg('fade-out', 3.0));
if (!VIDEO || !OUT) { console.error('用法: node tools/add-bgm.mjs --video in.mp4 [--audio 旁白.wav] [--loop 名字|--music 路径] --out out.mp4'); process.exit(2); }

// 旁白电平：edge-tts 原始输出约 -23.7 LUFS，不归一就直接混，成片会落在 -23 档（偏离交付口径 -16）。
// 正确做法是在配音阶段加一步：ffmpeg -i vo.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 vo-norm.wav
const LOOPS_ROOT = '/Library/Audio/Apple Loops';

function findLoop(name) {
  // 在 Apple Loops 里按文件名（不含扩展名）精确找，找不到再模糊一次
  const hits = execFileSync('find', [LOOPS_ROOT, '-type', 'f', '-name', '*.caf'], { encoding: 'utf8', maxBuffer: 1e7 })
    .split('\n').filter(Boolean);
  const exact = hits.find((p) => path.basename(p, '.caf').toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const loose = hits.find((p) => path.basename(p, '.caf').toLowerCase().includes(name.toLowerCase()));
  return loose || null;
}

const music = MUSIC || findLoop(LOOP);
if (!music) {
  console.error(`找不到配乐「${MUSIC || LOOP}」。\n  指定文件：--music /path/track.m4a\n  或用本机 Apple Loops：--loop "<名字>"（${LOOPS_ROOT} 下 .caf）`);
  process.exit(2);
}
if (!fs.existsSync(music)) { console.error(`配乐文件不存在：${music}`); process.exit(2); }
if (AUDIO && !fs.existsSync(AUDIO)) { console.error(`旁白文件不存在：${AUDIO}`); process.exit(2); }

// 输入槽位：有独立旁白时 0=视频 1=旁白 2=音乐，否则 0=视频（自带人声）1=音乐
const VO_IN = AUDIO ? 1 : 0;
const MUS_IN = AUDIO ? 2 : 1;

const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO], { encoding: 'utf8' }).trim());
const fadeOutSt = Math.max(0, dur - FADE_OUT).toFixed(2);

// 循环方式：**不能用 -stream_loop**。那是首尾硬接，每 8.3s 一个断口，
// 在安静的人声片子上一听就是"啪"一下。这里用 N 份拷贝 + 逐段 acrossfade（1s）拼接，
// 拼接后总长 N*L-(N-1)*d，取够片长即可。
const loopDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', music], { encoding: 'utf8' }).trim());
const XF = Number(arg('xfade', 1.0));
const copies = Math.max(2, Math.ceil((dur + XF) / Math.max(0.5, loopDur - XF)) + 1);

const parts = [];
// 每份拷贝：统一格式 → 基础增益 → 低通去齿音
parts.push(`[${MUS_IN}:a]aformat=sample_rates=44100:channel_layouts=mono,volume=${GAIN}dB,lowpass=f=9000,asplit=${copies}` +
  Array.from({ length: copies }, (_, i) => `[c${i}]`).join(''));
let prev = 'c0';
for (let i = 1; i < copies; i++) {
  const out = i === copies - 1 ? 'looped' : `x${i}`;
  parts.push(`[${prev}][c${i}]acrossfade=d=${XF}:c1=tri:c2=tri[${out}]`);
  prev = out;
}
parts.push(`[looped]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB,afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=${fadeOutSt}:d=${FADE_OUT}[bgm]`);
parts.push(`[${VO_IN}:a]aformat=sample_rates=44100:channel_layouts=mono[vo]`);
parts.push(`[vo]asplit=2[vo1][vo2]`);
parts.push(DUCK === 'on'
  ? `[bgm][vo2]sidechaincompress=threshold=${DUCK_THR}:ratio=${DUCK_RATIO}:attack=20:release=450:makeup=1[bed]`
  : `[bgm]anull[bed]`);
// 用固定增益 + 限幅，不用单趟 loudnorm：单趟是动态增益，段与段电平会被来回拉，
// 实测加 BGM 后同一秒反而比原片低 2.8dB（听感是"声音忽大忽小"）。
parts.push(`[vo1][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=0:attack=5:release=50[aout]`);
const chain = parts.join(';');

execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-i', VIDEO,
  ...(AUDIO ? ['-i', AUDIO] : []),
  '-i', music,
  '-filter_complex', chain,
  '-map', '0:v', '-map', '[aout]',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '1', '-movflags', '+faststart',
  // 画面是主时钟：旁白 wav 常比视频长几十毫秒（vo.py 多写 0.12s 防止截掉末帧），
  // 不裁的话容器时长跟着音轨走，帧数检查会报「4770 ≠ 79.624×60」。
  '-t', dur.toFixed(3),
  OUT,
], { stdio: 'inherit' });

const after = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', OUT], { encoding: 'utf8' });
const info = JSON.parse(after).format;
console.log(`✓ ${OUT}`);
console.log(`  旁白 ${AUDIO ? path.basename(AUDIO) + '（独立轨，单次编码）' : '取自视频'}`);
console.log(`  配乐 ${path.basename(music)}（${(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', music], { encoding: 'utf8' }).trim())).toFixed(1)}s 循环）· 基础电平 ${GAIN}dB · duck=${DUCK}${DUCK === 'on' ? ` (thr ${DUCK_THR} / ratio ${DUCK_RATIO})` : ''}`);
console.log(`  ${dur.toFixed(2)}s / ${(Number(info.size) / 1e6).toFixed(2)}MB`);
