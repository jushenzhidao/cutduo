#!/usr/bin/env node
/**
 * bgm.mjs · 分层配乐：四层 128 BPM 电子，按段落边界让各层进出。
 * 曲目来自本机 Apple Loops（不入库）。段落边界读 params-abs.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOPS = '/Library/Audio/Apple Loops/Apple';
const LAYERS = {
  a: LOOPS + '/02 Electro House/Binary System Synth Layers.caf',
  b: LOOPS + '/02 Electro House/Blueprint Beat 01.caf',
  c: LOOPS + '/02 Electro House/Acid Test Bass.caf',
  d: LOOPS + '/02 Electro House/Apex Synth.caf',
};
const p = JSON.parse(fs.readFileSync(path.join(HERE, 'params-abs.json'), 'utf8'));
const total = p.durationSeconds;
const sc = p.scenes;
const t1 = sc[Math.min(2, sc.length - 1)].t0;
const t2 = sc[Math.min(Math.floor(sc.length * 0.45), sc.length - 1)].t0;
const t3 = sc[Math.min(Math.floor(sc.length * 0.75), sc.length - 1)].t0;

const env = (pairs) => {
  let e = String(pairs[pairs.length - 1][1]);
  for (let i = pairs.length - 2; i >= 0; i--) e = `if(lt(t,${pairs[i][0]}),${e},${pairs[i][1]})`;
  return e;
};
const lay = (i, name, expr, fi) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono,aloop=loop=-1:size=2147483647,atrim=0:${total},asetpts=N/SR/TB,volume='${expr}':eval=frame${fi ? ',afade=t=in:st=0:d=1.6' : ''}[${name}]`;

const filters = [
  lay(0, 'a', env([[0, 0.30], [t1, 0.40], [t3, 0.46], [total * 0.9, 0.20]]), true),
  lay(1, 'b', env([[0, 0], [t1, 0.32], [t2, 0.16], [t3, 0.40], [total * 0.9, 0]])),
  lay(2, 'c', env([[0, 0], [t3, 0.36], [total * 0.9, 0]])),
  lay(3, 'd', env([[0, 0], [t2, 0.16], [t3, 0], [t3 + 2, 0.15], [total * 0.85, 0]])),
  `[a][b][c][d]amix=inputs=4:normalize=0:duration=first,alimiter=limit=0.85,afade=t=out:st=${(total - 2.2).toFixed(2)}:d=2.2[out]`,
];
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', LAYERS.a, '-i', LAYERS.b, '-i', LAYERS.c, '-i', LAYERS.d,
  '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
  path.join(HERE, 'audio', 'bgm.wav')]);
console.log('✓ audio/bgm.wav', total + 's');
