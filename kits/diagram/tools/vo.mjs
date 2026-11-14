#!/usr/bin/env node
/**
 * kits/diagram/tools/vo.mjs · 图示版式的配音驱动
 *
 * 跟 templates/_scaffold/tools/vo.py 同一套原则（时间轴跟随配音，不迁就），但结构不同：
 * 这里的一段 = 一句口播 + 一张图，没有 scene/line 的嵌套，所以不复用那份脚本。
 *
 * 做的事：
 *   1. 逐句 edge-tts，实测每句时长（不估）
 *   2. segment.duration = 段首留白 + 本句音频 + 段尾留白，最短 2.6s
 *   3. 把每句按起点写进一条全长静音轨，导出 wav
 *   4. 输出新的 params（带实测时长与每段音频起点）
 *
 *   node kits/diagram/tools/vo.mjs --params kits/diagram/presets/film.json \
 *     --out-params out/film.vo.json --out-audio out/film.vo.wav
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SR = 44100;
const LEAD_DEFAULT = 0.42; // 段首留白：给图示入场
const END_DEFAULT = 0.62; // 段尾留白：让最后一帧站住
const GAP_DEFAULT = 0.18; // 段内句间气口：两句之间要有一口气，但不能像两段
const MIN_SEC = 2.8;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

/** ffmpeg 出来的 wav 头长度不固定（LIST/INFO 块），按 data chunk 找真身 */
function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`不是 wav：${file}`);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    }
    if (id === 'data') {
      if (!fmt) throw new Error('wav 缺 fmt');
      if (fmt.channels !== 1 || fmt.sampleRate !== SR || fmt.bits !== 16) {
        throw new Error(`wav 格式不对：${JSON.stringify(fmt)}，期望 1ch/${SR}/16bit`);
      }
      return buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav 缺 data chunk');
}

function wavFile(pcm, file) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

function tts(text, outWav, voice, rate) {
  const mp3 = outWav.replace(/\.wav$/, '.mp3');
  execFileSync('edge-tts', ['--voice', voice, '--rate', rate, '--text', text, '--write-media', mp3], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp3, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', outWav]);
  return readWavPcm(outWav);
}

function main() {
  const paramsPath = arg('params');
  if (!paramsPath) throw new Error('缺 --params');
  const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  const segs = params.segments ?? [];
  if (!segs.length) throw new Error('segments 为空');

  const voice = arg('voice', 'zh-CN-XiaoxiaoNeural');
  const rate = arg('rate', '+8%');
  const outParams = arg('out-params', 'out/diagram.vo.json');
  const outAudio = arg('out-audio', 'out/diagram.vo.wav');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvo-'));
  const timeline = [];
  // 片头标题卡不配音，但它占时间 ⇒ 音频整体后移，否则第一句会压在卡上
  let cursor = Number(params.titleCard?.duration ?? 0);
  const pieces = [];

  const lead = Number(params.lead ?? LEAD_DEFAULT);
  const endPad = Number(params.endPad ?? END_DEFAULT);
  const gap = Number(params.lineGap ?? GAP_DEFAULT);

  segs.forEach((seg, i) => {
    // 一段可以有 1..n 句。为什么不是"一段一句"：锚点常落在段内第二句上
    // （先给对比，再给数字），画面必须知道那一句的真实开口时刻。
    // 只给 line 字符串时按单句处理，老预设一个字段都不用改。
    const lines = Array.isArray(seg.lines)
      ? seg.lines.filter(Boolean)
      : [seg.line ?? seg.title ?? ''].filter(Boolean);
    if (!lines.length) throw new Error(`第 ${i + 1} 段缺 line / lines（口播稿）`);

    const said = [];
    let inSeg = lead;
    lines.forEach((text, k) => {
      const wav = path.join(tmp, `s${i}-${k}.wav`);
      const pcm = tts(text, wav, voice, rate);
      const speech = pcm.length / 2 / SR;
      said.push({ text, pcm, at: cursor + inSeg, speech });
      inSeg += speech + (k < lines.length - 1 ? gap : 0);
    });

    const speechTotal = said.reduce((a, s) => a + s.speech, 0);
    const dur = Math.max(MIN_SEC, inSeg + endPad);
    timeline.push({
      index: i,
      start: cursor,
      dur,
      speech: speechTotal,
      audioAt: cursor + lead,
      line: lines.join(''),
      lines: said.map((s) => ({
        text: s.text,
        at: Number(s.at.toFixed(3)),
        speech: Number(s.speech.toFixed(3)),
      })),
    });
    for (const s of said) pieces.push({ pcm: s.pcm, at: s.at });
    cursor += dur;
  });

  // 全长静音底，把每句按起点写进去
  const totalSamples = Math.ceil(cursor * SR);
  const track = Buffer.alloc(totalSamples * 2);
  for (const p of pieces) {
    const off = Math.round(p.at * SR) * 2;
    p.pcm.copy(track, off, 0, Math.min(p.pcm.length, track.length - off));
  }
  wavFile(track, outAudio);

  const out = {
    ...params,
    audio: outAudio,
    segments: segs.map((seg, i) => ({ ...seg, duration: Number(timeline[i].dur.toFixed(3)) })),
    _timeline: timeline.map((t) => ({
      index: t.index,
      start: Number(t.start.toFixed(3)),
      duration: Number(t.dur.toFixed(3)),
      speech: Number(t.speech.toFixed(3)),
      audioAt: Number(t.audioAt.toFixed(3)),
      line: t.line,
      lines: t.lines,
    })),
  };
  fs.mkdirSync(path.dirname(outParams), { recursive: true });
  fs.writeFileSync(outParams, JSON.stringify(out, null, 2) + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        total: Number(cursor.toFixed(2)),
        segments: timeline.length,
        outParams,
        outAudio,
        perSegment: timeline.map((t) => `${t.dur.toFixed(2)}s/${t.speech.toFixed(2)}s`),
      },
      null,
      2
    )
  );
}

main();
