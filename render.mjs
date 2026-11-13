#!/usr/bin/env node
/**
 * skia-kit · 一条命令出片（无浏览器）
 *
 *   node skia-kit/render.mjs --params kits/paper/presets/v8t.json \
 *     --audio edits/audio-v8t.m4a --out out/kit.mp4
 *
 * 只依赖 @napi-rs/canvas + ffmpeg：把 params 里的 8 个分镜逐帧画成 JPEG，
 * 管道喂给 libx264，最后与音轨合成。默认 8 个 worker 分片并行。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planShards, partArgs, pumpFrames, spawnPart, concatParts, report } from './src/pipeline.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, loadTokens } from './kits/paper/paper.mjs';
import { createScienceRenderer } from './kits/science/science.mjs';
import { applyProfile } from './kits/science/profile.mjs';
import { createWebCanvasRenderer } from './src/webcanvas.mjs';
import { createClayRenderer } from './kits/clay/clay.mjs';
import { createCollageRenderer } from './kits/collage/collage.mjs';
import { registerFonts } from './src/fonts.mjs';
import { buildMix } from './src/audio-mix.mjs';
import { REPO_ROOT, DIRS, resolveInput } from './src/root.mjs';


/**
 * --kit 解析：science / paper 是内置专用适配器；其余视为模板名（templates/own/<name>）
 * 或直接的 src 目录。通用路径要求三件套 kit.js / layouts.js / stage.js。
 */
function kitSpec(kit) {
  if (kit === 'science' || kit === 'paper' || kit === 'clay' || kit === 'collage') return { kind: kit };
  // 三种写法都认：模板名 / 模板根目录 / src 目录本身
  const cands = [
    path.resolve(REPO_ROOT, 'templates', 'own', kit, 'src'),
    path.resolve(kit, 'src'),
    path.resolve(kit),
  ];
  const srcDir = cands.find((d) => fs.existsSync(path.join(d, 'kit.js')));
  if (!srcDir) {
    throw new Error(
      `找不到 kit：${kit}\n  试过：${cands.join('\n        ')}\n  可用：science / paper / clay / collage / <模板名>` +
      '\n  模板须在 templates/own/<name>/src（三件套）或直接传目录路径'
    );
  }
  const templateDir = path.dirname(srcDir);
  // 路径恰好指向内置适配器的模板时，仍走专用适配器：
  // science 要预载姿态图/口型贴片，通用宿主不认识这些概念，会静默退化成矢量人物。
  const rel = path.relative(REPO_ROOT, srcDir).split(path.sep).join('/');
  if (rel === 'kits/science/template/src') return { kind: 'science' };

  const spec = { kind: 'webcanvas', srcDir, templateDir };
  // 画幅以模板 manifest 为准：不读这一步，竖屏模板会被渲成横屏（此前 5 处写死 1920x1080）
  const mp = path.join(templateDir, 'motion.json');
  if (fs.existsSync(mp)) {
    try {
      const o = JSON.parse(fs.readFileSync(mp, 'utf8')).output || {};
      if (o.width) spec.width = Number(o.width);
      if (o.height) spec.height = Number(o.height);
    } catch {
      /* manifest 坏了就让默认值兜底，不阻断出片 */
    }
  }
  return spec;
}

/** 默认 worker 数：每 worker 约吃 2 核（node 进程 + ffmpeg 子进程），上限 32 下限 4。
 *  实测：30 核 M5 用 16 最快（5.6s vs 8 worker 6.7s）；64 核 Xeon 用 32 最快（19.4s vs 22.0s）。
 *  代价是分片变多、体积略增约 5%（mpegts 分片边界更多）。 */
function defaultWorkers() {
  return Math.min(32, Math.max(4, Math.floor(os.cpus().length / 2)));
}

function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    kit: get('kit', 'paper'),
    params: resolveInput(get('params', 'kits/paper/presets/v8t.json')),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', 'out/kit.mp4')),
    workers: Math.max(1, Number(get('workers', defaultWorkers()))),
    fps: get('fps', null),
    crf: String(get('crf', 20)),
    jpeg: Number(get('jpeg', 94)),
    preset: get('preset', 'veryfast'),
    avatar: resolveInput(get('avatar', 'edits/assets/avatar.png'), false),
    theme: get('theme', null),
    transition: get('transition', 'cut'),
    transitionDur: Number(get('transition-dur', 0.26)),
    // 默认 raw：中间不再出 JPEG（少一次有损编码，同等 CRF 下体积小 6%），实测也略快。
    // --pipe jpeg 保留给需要"中间帧可回放/体积小"的场合。
    pipe: get('pipe', 'raw'),
    x264Threads: get('x264-threads', '1'),   // 每个 worker 一个编码线程：8 路时避免线程超订
    probe: get('probe', null),
    at: Number(get('at', 2.5)),
  };
}

const A = parseArgs(process.argv.slice(2));

/**
 * 主题：只换 palette（色），不动任何几何——几何是 paper-perspective 的测量值，改了就不是复刻了。
 * clean 是给"知识口播"调的一版：底色更白、正文更中性、字幕条更实，靠近现代排版而不是牛皮纸。
 */
const THEMES = {
  clean: {
    bg: '#FAFAF7', ink: '#111214', accent: '#2462EA', body: '#4C5150', label: '#7A807C',
    bar: 'rgba(17,18,20,0.88)', ring: 'rgba(36,98,234,0.22)', hair: 'rgba(0,0,0,0.08)',
  },
};
const PALETTE = A.theme ? THEMES[A.theme] : null;
if (A.theme && !PALETTE) throw new Error(`unknown --theme ${A.theme}（可选：${Object.keys(THEMES).join(' / ')}）`);

/** segments（科普版式：每段 dur）→ 统一场景轴（t0/t1） */
function normalizeSegments(segs) {
  let acc = 0;
  return segs.map((s) => {
    const t0 = acc;
    acc += Number(s.dur || 3);
    // 平铺参数（title / sub / point …）必须原样带过来：骨架类模板直接写在段上，
    // 只取 s.args 会把它们静默丢掉（症状：浏览器有标题、Skia 没有）。args 显式声明时优先。
    const { type, dur, args, ...rest } = s;
    const merged = { ...rest, ...(args || {}) };
    return { type, t0, t1: acc, args: Object.keys(merged).length ? merged : args || {} };
  });
}

function loadParams(file, fpsOverride, kit) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  let scenes = d.scenes || (Array.isArray(d.segments) ? normalizeSegments(d.segments) : []);
  if (!scenes.length) throw new Error('params 里没有 scenes / segments');
  const fps = Number(fpsOverride || d.fps || 60);
  // 帧网格对齐（opt-in）：dur 是浮点秒，累加会积出 1e-15 级误差，导致
  // "恰好落在切点上的那一帧"被判给上一段——整帧错，MAE 30+，但人眼看不出成因。
  // 打开 snapToFrames 后 t0/t1 一律取 round(t*fps)/fps，帧号即真相。
  // 默认关闭：老 params 的段长不是帧整数倍，打开会把边界帧挪 1 帧，属于行为变更。
  if (d.snapToFrames === true) {
    const q = (x) => Math.round(x * fps) / fps;
    for (const s of scenes) { s.t0 = q(s.t0); s.t1 = q(s.t1); }
  }
  // 外观档案（params.profile）：只覆盖几何/外观，不碰文案；args 显式写的优先。
  // 放在帧网格对齐之前——档案里的值可能是小数秒级别的几何，和 t0/t1 无关。
  if (d.profile && kit === 'science') scenes = applyProfile(scenes, d.profile);
  const duration = d.durationSeconds || scenes[scenes.length - 1].t1;
  return { ...d, scenes, captions: d.captions || [], fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}

async function loadAvatar(p) {
  if (!p || p === 'off') return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  if (!fs.existsSync(abs)) return null;
  try { return await loadImage(abs); } catch { return null; }
}

if (!isMainThread) {
  const { start, end, part, params, crf, jpeg, preset, tokensPath, fps, transition, transitionDur, palette, pipe, x264Threads, kit, brand, subtitle, theme, fadeOutSeconds, width, height } = workerData;
  const W = Number(width) || 1920;
  const H = Number(height) || 1080;
  registerFonts(DIRS.fonts);
  // fps 必须由主线程显式传入：params 里常是 24，CLI 的 --fps 60 只改主线程会导致
  // worker 按 24fps 计时（帧号/时间轴错位、成片被截短）。
  const P = loadParams(params, fps, kit);
  const avatar = await loadAvatar(workerData.avatar);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const spec = kitSpec(kit);
  // content 是「与时间轴无关的内容块」（歌词/关键词/纸条这类）。
  // 不显式透传的话，通用宿主只拿到 scenes，模板会静默变成"有画面没文字"。
  const stageContent = { scenes: P.scenes, captions: P.captions, media: P.media, content: P.content || null, brand, subtitle, theme, fadeInSeconds: P.fadeInSeconds, fadeOutSeconds };
  const r = spec.kind === 'science'
    ? createScienceRenderer({ canvas, ctx, width: W, height: H, fps: P.fps, brand, subtitle, theme, fadeOutSeconds })
    : spec.kind === 'paper'
      ? createPaperRenderer({ ctx, tokens: tokensPath ? loadTokens(tokensPath) : undefined, palette, transition, transitionDur })
      : spec.kind === 'clay'
        ? createClayRenderer({ canvas, ctx, width: W, height: H, subtitle, brand })
        : spec.kind === 'collage'
        ? createCollageRenderer({ canvas, ctx, width: W, height: H, fps: P.fps })
        : createWebCanvasRenderer({ srcDir: spec.srcDir, templateDir: spec.templateDir, canvas, ctx, width: W, height: H });
  r.setContent(spec.kind === 'paper' ? { scenes: P.scenes, captions: P.captions, avatar } : stageContent);
  if (spec.kind === 'science' || spec.kind === 'webcanvas' || spec.kind === 'collage') await r.ready();

  const ff = spawnPart(partArgs({
    pipe, fps: P.fps, width: W, height: H, crf, preset, jpeg, x264Threads, part,
  }));
  await pumpFrames({ renderer: r, canvas, fps: P.fps, start, end, ff, pipe, jpeg });
  parentPort.postMessage({ ok: true, frames: end - start });
} else {
  const t0 = Date.now();
  registerFonts(DIRS.fonts);
  const P = loadParams(A.params, A.fps, A.kit);

  if (A.probe) {
    const avatar = await loadAvatar(A.avatar);
    const SPEC = kitSpec(A.kit);
    const OUT_W = Number(P.width || SPEC.width || 1920);
    const OUT_H = Number(P.height || SPEC.height || 1080);
    const canvas = createCanvas(OUT_W, OUT_H);
    const r0 = canvas.getContext('2d');
    const spec = SPEC;
    const probeContent = { scenes: P.scenes, captions: P.captions, media: P.media, content: P.content || null, brand: P.brand, subtitle: P.subtitle, theme: P.theme, fadeInSeconds: P.fadeInSeconds, fadeOutSeconds: P.fadeOutSeconds };
    const r = spec.kind === 'science'
      ? createScienceRenderer({ canvas, ctx: r0, width: OUT_W, height: OUT_H, brand: P.brand, subtitle: P.subtitle, theme: P.theme, fadeOutSeconds: P.fadeOutSeconds })
      : spec.kind === 'paper'
        ? createPaperRenderer({ ctx: r0, palette: PALETTE })
        : spec.kind === 'clay'
          ? createClayRenderer({ canvas, ctx: r0, width: OUT_W, height: OUT_H, subtitle: P.subtitle, brand: P.brand })
          : spec.kind === 'collage'
          ? createCollageRenderer({ canvas, ctx: r0, width: OUT_W, height: OUT_H, fps: P.fps })
          : createWebCanvasRenderer({ srcDir: spec.srcDir, templateDir: spec.templateDir, canvas, ctx: r0, width: OUT_W, height: OUT_H });
    r.setContent(spec.kind === 'paper' ? { scenes: P.scenes, captions: P.captions, avatar } : probeContent);
    if (spec.kind === 'science' || spec.kind === 'webcanvas' || spec.kind === 'collage') await r.ready();
    r.renderFrame(A.at);
    fs.writeFileSync(A.probe, canvas.toBuffer('image/png'));
    console.log('probe →', A.probe, `${P.frames} 帧计划`);
    process.exit(0);
  }

  const SPEC = kitSpec(A.kit);
  // params 显式声明 > 模板 manifest > 1920×1080
  const OUT_W = Number(P.width || SPEC.width || 1920);
  const OUT_H = Number(P.height || SPEC.height || 1080);

  // 音频：params.audio 有事件轨/配乐时先混一条，再交给 concatParts。
  // 优先级：--audio（命令行显式指定）> params.audio > 无音轨。
  let audioPath = A.audio;
  if (!A.audio && P.audio) {
    const mixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixout-'));
    const mixed = buildMix({
      out: path.join(mixDir, 'mix.wav'),
      duration: P.durationSeconds,
      mode: P.audio.mode || 'external-music',
      music: P.audio.music ? resolveInput(P.audio.music, false) : null,
      voice: P.audio.voice ? resolveInput(P.audio.voice, false) : null,
      cues: P.audio.cues || [],
      musicGain: P.audio.musicGain,
    });
    if (mixed) {
      audioPath = mixed;
      console.log(`  音效事件 ${(P.audio.cues || []).length} 条 · 混音 → ${path.basename(mixed)}`);
    }
  }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skia-kit-'));
  const segs = planShards(P.frames, A.workers, TMP);
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, params: A.params, fps: P.fps,
        width: OUT_W, height: OUT_H,
        transition: A.transition, transitionDur: A.transitionDur,
        avatar: A.avatar, crf: A.crf, jpeg: A.jpeg, preset: A.preset, palette: PALETTE,
        pipe: A.pipe, x264Threads: A.x264Threads, kit: A.kit,
        brand: P.brand || null, subtitle: P.subtitle || null, theme: P.theme || null,
        fadeOutSeconds: P.fadeOutSeconds },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.once('message', (m) => (m && m.ok ? resolve(m) : reject(new Error(m && m.error))));
    w.once('error', reject);
  })));

  concatParts({
    parts: segs.map((s) => s.part), tmpDir: TMP, out: A.out,
    audio: audioPath, fps: P.fps, frames: P.frames,
  });
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ out: A.out, frames: P.frames, fps: P.fps, startedAt: t0, workers: A.workers });
}
