#!/usr/bin/env node
// 旁白 + 分层配乐 + 音效事件 → 混音（ducking 在 src/audio-mix.mjs）
import fs from 'node:fs';
const ROOT = new URL('../..', import.meta.url).pathname;
const D = new URL('.', import.meta.url).pathname;
const { buildMix } = await import(ROOT + 'src/audio-mix.mjs');
const { auditTiming } = await import(ROOT + 'src/temporal.mjs');
const p = JSON.parse(fs.readFileSync(D + 'params-abs.json', 'utf8'));
const ta = auditTiming(p);
if (!ta.ok) { console.error('时间轴校验失败：', ta.errors); process.exit(2); }
const cues = (p.audio && p.audio.cues) || [];
const r = buildMix({
  out: D + 'audio/mix-final.wav', duration: p.durationSeconds,
  mode: 'external-music', music: D + 'audio/bgm.wav', voice: D + 'audio/vo-norm.wav',
  musicGain: 0.5, cues,
});
console.log('混音', r ? '✓' : '✗', p.durationSeconds + 's ·', cues.length, '条音效');
