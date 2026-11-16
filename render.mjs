#!/usr/bin/env node
/**
 * render.mjs · 内置版式统一出片入口（Skia，无浏览器）
 *
 *   node render.mjs --kit paper --params kits/paper/presets/v8t.json \
 *     --audio edits/audio-v8t.m4a --out out/kit.mp4
 *
 * 走 `--kit` 的有：paper / science / clay / collage / iso，以及 templates/own/ 下的三件套模板。
 * 独立入口的三支（desk / editorial / mg）不走这里，走 --kit 会给出明确提示而不是「找不到 kit」。
 *
 * 外壳（参数解析 / probe / 分片 / concat / 回执）在 src/entry-kit.mjs；
 * 本文件只留「按 --kit 选 renderer」这件事，以及带声明式时间与关键词锚点的 params 载入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, loadTokens } from './kits/paper/paper.mjs';
import { createScienceRenderer } from './kits/science/science.mjs';
import { applyProfile } from './kits/science/profile.mjs';
import { createWebCanvasRenderer } from './src/webcanvas.mjs';
import { createClayRenderer } from './kits/clay/clay.mjs';
import { createCollageRenderer } from './kits/collage/collage.mjs';
import { createIsoRenderer } from './kits/iso/iso.mjs';
import { registerFonts } from './src/fonts.mjs';
import { buildMix } from './src/audio-mix.mjs';
import { auditTiming, normalizeTiming } from './src/temporal.mjs';
import { REPO_ROOT, DIRS, resolveInput } from './src/root.mjs';
import { parseStdArgs, handleProbeOrDeterminism, renderPart, runShards } from './src/entry-kit.mjs';

/**
 * --kit 解析：内置五支走专用适配器；其余视为模板名（templates/own/<name>）
 * 或直接的 src 目录。通用路径要求三件套 kit.js / layouts.js / stage.js。
 */
function kitSpec(kit) {
  if (kit === 'science' || kit === 'paper' || kit === 'clay' || kit === 'collage' || kit === 'iso') return { kind: kit };
  // 三种写法都认：模板名 / 模板根目录 / src 目录本身
  const cands = [
    path.resolve(REPO_ROOT, 'templates', 'own', kit, 'src'),
    path.resolve(kit, 'src'),
    path.resolve(kit),
  ];
  const srcDir = cands.find((d) => fs.existsSync(path.join(d, 'kit.js')));
  if (!srcDir) {
    // 三支版式有独立入口，走 --kit 一定失败。不写清这一点，用户只会看到"找不到 kit"然后翻文档。
    const ownEntry = { desk: 'npm run desk', editorial: 'npm run editorial', mg: 'npm run mg' }[kit];
    throw new Error(
      `找不到 kit：${kit}\n` +
      (ownEntry ? `  这支版式有自己的入口：${ownEntry}（不走 --kit）\n` : '') +
      `  试过：${cands.join('\n        ')}\n` +
      '  可走 --kit：paper / science / clay / collage / iso / night-card / chalkboard / cute-mv / sketchnote\n' +
      '  独立入口：desk（npm run desk）/ editorial（npm run editorial）/ mg（npm run mg）\n' +
      '  模板须在 templates/own/<name>/src（三件套）或直接传目录路径'
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

const A = parseStdArgs(process.argv.slice(2), {
  params: 'kits/paper/presets/v8t.json',
  out: 'out/kit.mp4',
});
// 本支独有的开关（不放进 parseStdArgs：其它入口没有这些概念）
A.kit = A.get('kit', 'paper');
A.avatar = resolveInput(A.get('avatar', 'edits/assets/avatar.png'), false);
A.theme = A.get('theme', null);
A.transition = A.get('transition', 'cut');
A.transitionDur = Number(A.get('transition-dur', 0.26));
// 默认 raw：中间不再出 JPEG（少一次有损编码，同等 CRF 下体积小 6%），实测也略快。
// --pipe jpeg 保留给需要"中间帧可回放/体积小"的场合。
A.pipe = A.get('pipe', 'raw');
A.x264Threads = A.get('x264-threads', '1'); // 每个 worker 一个编码线程：8 路时避免线程超订

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
  // 声明式时间先展开：{from,for} / {until,for} / {from,until} → t0/t1。
  // 渲染器只认绝对秒，声明式的编辑语义在 src/temporal.mjs 里；两步必须用同一套展开，
  // 否则会"校验按声明算、渲染按绝对算"，错位悄无声息。
  const d = normalizeTiming(
    JSON.parse(fs.readFileSync(file, 'utf8')),
    { fps: Number(fpsOverride || 0) || undefined },
  );
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

/**
 * 唯一的一处 renderer 构造。
 * 原先 worker 与 probe 各写了一份，参数还不一样（probe 少了 transition/tokens），
 * 导致「probe 出来的单帧」不代表成片。合成一处后两者天然一致。
 */
async function buildRenderer({ P, kit, W, H, palette, transition, transitionDur, tokensPath, avatar, brand, subtitle, theme, fadeOutSeconds }) {
  const spec = kitSpec(kit);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // content 是「与时间轴无关的内容块」（歌词/关键词/纸条这类）。
  // 不显式透传的话，通用宿主只拿到 scenes，模板会静默变成"有画面没文字"。
  const stageContent = {
    scenes: P.scenes, captions: P.captions, media: P.media,
    content: P.content || null, lyricStyle: P.lyricStyle || null,
    brand, subtitle, theme, fadeInSeconds: P.fadeInSeconds, fadeOutSeconds,
  };
  const r = spec.kind === 'science'
    ? createScienceRenderer({ canvas, ctx, width: W, height: H, fps: P.fps, brand, subtitle, theme, fadeOutSeconds })
    : spec.kind === 'paper'
      ? createPaperRenderer({ ctx, tokens: tokensPath ? loadTokens(tokensPath) : undefined, palette, transition, transitionDur })
      : spec.kind === 'clay'
        ? createClayRenderer({ canvas, ctx, width: W, height: H, subtitle, brand })
        : spec.kind === 'collage'
          ? createCollageRenderer({ canvas, ctx, width: W, height: H, fps: P.fps })
          : spec.kind === 'iso'
            ? createIsoRenderer({ canvas, ctx, width: W, height: H, fps: P.fps })
            : createWebCanvasRenderer({ srcDir: spec.srcDir, templateDir: spec.templateDir, canvas, ctx, width: W, height: H });
  r.setContent(spec.kind === 'paper' ? { scenes: P.scenes, captions: P.captions, avatar } : stageContent);
  if (spec.kind === 'science' || spec.kind === 'webcanvas' || spec.kind === 'collage' || spec.kind === 'iso') await r.ready();
  return { canvas, r, spec };
}

if (!isMainThread) {
  const w = workerData;
  const W = Number(w.width) || 1920;
  const H = Number(w.height) || 1080;
  registerFonts(DIRS.fonts);
  // fps 必须由主线程显式传入：params 里常是 24，CLI 的 --fps 60 只改主线程会导致
  // worker 按 24fps 计时（帧号/时间轴错位、成片被截短）。
  const P = loadParams(w.params, w.fps, w.kit);
  const { canvas, r } = await buildRenderer({
    P, kit: w.kit, W, H, palette: w.palette,
    transition: w.transition, transitionDur: w.transitionDur, tokensPath: w.tokensPath,
    avatar: await loadAvatar(w.avatar),
    brand: w.brand, subtitle: w.subtitle, theme: w.theme, fadeOutSeconds: w.fadeOutSeconds,
  });
  await renderPart({
    renderer: r, canvas, P, pipe: w.pipe || 'raw',
    crf: w.crf, preset: w.preset, jpeg: w.jpeg, x264Threads: w.x264Threads,
    start: w.start, end: w.end, part: w.part, width: W, height: H,
  });
  parentPort.postMessage({ ok: true, frames: w.end - w.start });
} else {
  registerFonts(DIRS.fonts);
  // loadParams 会展开声明式时间与关键词锚点。锚点引用的词不在表里、或落点越出本段，
  // 都会在这里抛——必须给人话 + 退出码 2，而不是让 Node 把堆栈甩出来（退出码 1 会被
  // 上层脚本当成"崩溃"而不是"参数错"）。
  let P;
  try {
    P = loadParams(A.params, A.fps, A.kit);
  } catch (e) {
    console.error(`\n参数无法载入：${path.basename(A.params)}\n  ${e.message}\n`);
    process.exit(2);
  }

  // 时间轴校验（src/temporal.mjs）：空窗口、越界、取整后重叠都会在成片上变成可见错误，
  // 而 gate 看不出这类问题（它只验成片像素，不读 params —— 实测倒序能骗过全部门禁）。
  // **默认拦**：未配音骨架（captions 全 0–1s）在校验器内部已降级为告警，不会误伤。
  // 逃生阀 --allow-time-drift 只告警；--strict-time 保留为显式同义词。
  {
    const ta = auditTiming(P);
    const drift = process.argv.includes('--allow-time-drift');
    for (const e of ta.errors) console.log(`  ⏱ 时间错  ${e}`);
    for (const w of ta.warnings) console.log(`  ⏱ 时间告警 ${w}`);
    if (ta.errors.length && !drift) {
      console.error(`\n时间轴校验失败（${ta.errors.length} 项）：空窗口 / 越界 / 取整后重叠会让成片出错，\n` +
        `而交付门禁看不出来。修 params；确认无害可加 --allow-time-drift 放行。`);
      process.exit(2);
    }
  }

  const SPEC = kitSpec(A.kit);
  // params 显式声明 > 模板 manifest > 1920×1080
  const W = Number(P.width || SPEC.width || 1920);
  const H = Number(P.height || SPEC.height || 1080);

  await handleProbeOrDeterminism({
    A, P,
    makeRenderer: async () => buildRenderer({
      P, kit: A.kit, W, H, palette: PALETTE,
      transition: A.transition, transitionDur: A.transitionDur,
      avatar: await loadAvatar(A.avatar),
      brand: P.brand, subtitle: P.subtitle, theme: P.theme, fadeOutSeconds: P.fadeOutSeconds,
    }),
    width: W, height: H,
    label: `${A.kit} · ${path.basename(A.params)} · ${W}×${H}`,
  });

  // 音频：params.audio 有事件轨/配乐时先混一条，再交给 concatParts。
  // 优先级：--audio（命令行显式指定）> params.audio > 无音轨。
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
      A.audio = mixed;
      console.log(`  音效事件 ${(P.audio.cues || []).length} 条 · 混音 → ${path.basename(mixed)}`);
    }
  }

  await runShards({
    entryUrl: new URL(import.meta.url), P, A, width: W, height: H,
    pipe: A.pipe,
    workerData: {
      transition: A.transition, transitionDur: A.transitionDur,
      avatar: A.avatar, palette: PALETTE,
      x264Threads: A.x264Threads, kit: A.kit,
      brand: P.brand || null, subtitle: P.subtitle || null,
      theme: P.theme || null, fadeOutSeconds: P.fadeOutSeconds,
    },
    tmpPrefix: 'skia-kit',
  });
}
