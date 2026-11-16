#!/usr/bin/env node
/**
 * desktop-kit · 一条命令出片（Skia，无浏览器）
 *
 *   node kits/desk/render.mjs --params content/demo.json \
 *     --audio edits/audio-desktop.m4a --out out/desktop.mp4
 *
 * 外壳在 src/entry-kit.mjs；这里只留本支独有的：params 校验、片段的预抽帧与照片注入、
 * presenter 贴片。字体注册统一走 src/fonts.mjs（原先从 desktop.mjs 另抽了一份，
 * 与 mg/paper 的注册逻辑重复，且换字体要改两处）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDesktopRenderer, validateParams, DEFAULT_TOKENS } from './desktop.mjs';
import { registerFonts } from '../../src/fonts.mjs';
import { DIRS, resolveInput } from '../../src/root.mjs';
import { parseStdArgs, handleProbeOrDeterminism, renderPart, runShards } from '../../src/entry-kit.mjs';

const W = DEFAULT_TOKENS.width;
const H = DEFAULT_TOKENS.height;

const A = parseStdArgs(process.argv.slice(2), {
  params: 'content/demo.json',
  out: 'out/desktop.mp4',
});
const PRESENTER = resolveInput(A.get('presenter', null), false);

function loadParams(file, fpsOverride) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateParams(d); // 主线程与 worker 共用同一份判据，非法时间轴在出片前就失败
  const fps = Number(fpsOverride || d.fps || 60);
  const duration = d.durationSeconds || d.shots[d.shots.length - 1].t1;
  return { ...d, fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}

/** 载入视频片段的预抽帧（preset.clips: key → { dir, fps }）。 */
async function loadClips(P, t0 = -1e9, t1 = 1e9) {
  const out = {};
  for (const [k, c] of Object.entries(P.clips || {})) {
    // 只加载落在本进程负责区间内的片段：每段 50 帧 × 3.7MB，8 兄弟全载会撑爆内存
    const used = (P.shots || []).some((sh) => sh.type === 'clip' && (sh.args || {}).key === k
      && sh.t1 > t0 && sh.t0 < t1);
    if (!used) continue;
    const dir = resolveInput(c.dir, false);
    if (!dir || !fs.existsSync(dir)) { console.warn(`clip "${k}" 目录缺失: ${c.dir}`); continue; }
    const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
    out[k] = await Promise.all(files.map((f) => loadImage(path.join(dir, f))));
  }
  return out;
}

async function loadPhotos(P) {
  const out = {};
  // 缺失必须在这里就汇总出来：原先 `catch { /* skip */ }` 让缺图完全静默，
  // 直到渲染到那个镜头才抛「photo "x" 没有注入素材」，而且不带文件路径。
  // 2026-11-13 用这条查出了 24 处失效引用（edits/assets → assets/media 没回写）。
  const missing = [];
  for (const [k, rel] of Object.entries(P.photos || {})) {
    const f = resolveInput(rel, false);
    if (!f || !fs.existsSync(f)) { missing.push(`${k} → ${rel}（文件不存在）`); continue; }
    try {
      out[k] = await loadImage(f);
    } catch (e) {
      missing.push(`${k} → ${rel}（解码失败：${e.message}）`);
    }
  }
  if (missing.length) {
    console.warn(`⚠ ${missing.length} 张照片未载入；渲染到对应镜头会抛错：`);
    for (const m of missing) console.warn(`    ${m}`);
  }
  return out;
}

async function loadPresenter(p) {
  if (!p || p === 'off' || !fs.existsSync(p)) return null;
  try { return await loadImage(p); } catch { return null; }
}

async function makeRenderer(P, presenter, start = 0, end = P.frames) {
  const canvas = createCanvas(W, H);
  const r = createDesktopRenderer({ ctx: canvas.getContext('2d') });
  r.setContent({
    shots: P.shots, captions: P.captions, chapters: P.chapters, brand: P.brand, presenter,
    photos: await loadPhotos(P),
    clips: await loadClips(P, start / P.fps, end / P.fps),
  });
  return { canvas, r };
}

if (!isMainThread) {
  const { start, end, part, params, crf, jpeg, preset, fps, presenter } = workerData;
  registerFonts(DIRS.fonts);
  const P = loadParams(params, fps);
  const { canvas, r } = await makeRenderer(P, await loadPresenter(presenter), start, end);
  await renderPart({ renderer: r, canvas, P, pipe: 'jpeg', crf, preset, jpeg, start, end, part, width: W, height: H });
  parentPort.postMessage({ ok: true, frames: end - start });
} else {
  registerFonts(DIRS.fonts);
  const P = loadParams(A.params, A.fps);

  await handleProbeOrDeterminism({
    A, P,
    makeRenderer: async () => makeRenderer(P, await loadPresenter(PRESENTER)),
    width: W, height: H,
    label: `desk · ${path.basename(A.params)} · ${W}×${H}`,
  });

  await runShards({
    entryUrl: new URL(import.meta.url), P, A, width: W, height: H,
    workerData: { presenter: PRESENTER },
    tmpPrefix: 'desktop-kit',
  });
}
