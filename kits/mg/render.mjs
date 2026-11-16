#!/usr/bin/env node
/**
 * mg-kit · 一条命令出片（纯 Skia，无浏览器）
 *
 *   node kits/mg/render.mjs --params kits/mg/params.json --out out/mg-demo.mp4
 *   node kits/mg/render.mjs --params kits/mg/params.json --probe out/mg-t12.png --at 12.4
 *
 * 外壳（参数解析 / probe / 分片 / concat / 回执）在 src/entry-kit.mjs，
 * 这里只留本支独有的三件事：params 模型、renderer 构造、worker 入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../../src/fonts.mjs';
import { DIRS } from '../../src/root.mjs';
import { createMGRenderer } from './scenes.mjs';
import { parseStdArgs, handleProbeOrDeterminism, renderPart, runShards } from '../../src/entry-kit.mjs';

const W = 1920;
const H = 1080;

const A = parseStdArgs(process.argv.slice(2), {
  params: 'kits/mg/params.json',
  out: 'kits/mg/out/mg-demo.mp4',
});

function loadParams(file, fpsOverride) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!d.scenes || !d.scenes.length) throw new Error('params 里没有 scenes');
  const fps = Number(fpsOverride || d.fps || 60);
  const duration = d.durationSeconds || d.scenes[d.scenes.length - 1].t1;
  return { ...d, fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}

function makeRenderer(params, fps) {
  const P = loadParams(params, fps);
  const canvas = createCanvas(W, H);
  const r = createMGRenderer({ ctx: canvas.getContext('2d') });
  r.setContent({ scenes: P.scenes });
  return { P, canvas, r };
}

if (!isMainThread) {
  registerFonts(DIRS.fonts);
  const { P, canvas, r } = makeRenderer(workerData.params, workerData.fps);
  await renderPart({
    renderer: r, canvas, P, pipe: 'jpeg',
    crf: workerData.crf, preset: workerData.preset, jpeg: workerData.jpeg,
    start: workerData.start, end: workerData.end, part: workerData.part,
    width: W, height: H,
  });
  parentPort.postMessage({ ok: true, frames: workerData.end - workerData.start });
} else {
  registerFonts(DIRS.fonts);
  const { P, canvas, r } = makeRenderer(A.params, A.fps);
  // 已建好就复用，不重建：probe 与 det 都只读同一份 renderer
  await handleProbeOrDeterminism({
    A, P, makeRenderer: async () => ({ canvas, r }),
    width: W, height: H, label: `mg · ${path.basename(A.params)} · ${W}×${H}`,
  });
  await runShards({ entryUrl: new URL(import.meta.url), P, A, width: W, height: H, tmpPrefix: 'mg-kit' });
}
