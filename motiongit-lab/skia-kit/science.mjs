/**
 * science.mjs — 科普版式渲染器（Skia / @napi-rs/canvas，无浏览器）
 *
 * 与 paper.mjs 的区别：paper 是逐像素反推后重写的版式；
 * 本文件是 templates/own/science-explainer 那套 canvas 2D 版式的**宿主移植**：
 * 版式代码（kit.js / layouts.js）逐字不动，只把运行环境从
 * 「浏览器 window + DOM canvas + new Image」换成「@napi-rs/canvas + 注入字体表」。
 *
 * 这样做的好处是保真：同一份绘制逻辑，不存在"照着重画"带来的偏差。
 * 代价是字体必须按字重映射（Skia 不做 weight 合成），见 FONT_MAP。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
// 模板目录经过一次重组（templates/ → templates/own/），按存在性探测，两个位置都认。
const SRC_CANDIDATES = [
  path.resolve(HERE, '..', 'templates', 'own', 'science-explainer', 'src'),
  path.resolve(HERE, '..', 'templates', 'science-explainer', 'src'),
];
const SRC_DIR = SRC_CANDIDATES.find((d) => fs.existsSync(path.join(d, 'kit.js'))) || SRC_CANDIDATES[0];

/** 字重 → 已注册字体族。key 必须是数字或字符串化的百位。 */
const FONT_MAP = {
  round: {
    900: 'NotoSC Black', 800: 'NotoSC Black', 700: 'NotoSC Black',
    600: 'NotoSC Medium', 500: 'NotoSC Medium',
    400: 'NotoSC Regular', 300: 'NotoSC Regular', 200: 'NotoSC Regular',
    default: 'NotoSC Black',
  },
  sans: {
    900: 'NotoSC Black', 800: 'NotoSC Black', 700: 'NotoSC Black',
    600: 'NotoSC Medium', 500: 'NotoSC Medium',
    400: 'NotoSC Regular', 300: 'NotoSC Regular', 200: 'NotoSC Regular',
    default: 'NotoSC Regular',
  },
};

/** 注册三档字重（与 paper.mjs 共用同一批文件，名字一致）。 */
export function registerScienceFonts(dir = path.resolve(HERE, '..', 'assets', 'fonts')) {
  const want = [
    ['NotoSansSC-Black.otf', 'NotoSC Black'],
    ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
    ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
  ];
  const miss = [];
  for (const [file, name] of want) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) { miss.push(file); continue; }
    if (!GlobalFonts.has(name)) GlobalFonts.registerFromPath(p, name);
    if (!GlobalFonts.has(name)) miss.push(`${file}(注册失败)`);
  }
  if (miss.length) throw new Error(`字体缺失或注册失败：${miss.join(', ')}（先跑 ./fetch-fonts.sh）`);
  return want.length;
}

/**
 * 把两段 canvas 版式源码装进一个最小的 window 环境。
 * kit.js / layouts.js 都是 IIFE + window.MK / window.L 的写法，
 * 因此这里只需要给出一个 window 对象，源码本身不用改。
 */
function bootLayouts() {
  const win = { __MK_IMAGES: {}, __MK_FIGS: {} };
  win.window = win;
  win.__FONTS = FONT_MAP;
  win.__createCanvas = createCanvas;   // 供 kit.js 缓存静态纸底
  for (const f of ['kit.js', 'layouts.js']) {
    const p = path.join(SRC_DIR, f);
    if (!fs.existsSync(p)) throw new Error(`缺少版式源码 ${p}`);
    const code = fs.readFileSync(p, 'utf8');
    // 参数名 window 遮蔽自由变量，源码里的 window.MK 即落到 win 上
    new Function('window', code)(win);
  }
  if (!win.MK || !win.L) throw new Error('版式源码加载失败：window.MK / window.L 未定义');
  return win;
}

/** 图片预载：把 params 里引用的图先解码进 window.__MK_IMAGES（可选素材位）。 */
async function primeImages(win, scenes) {
  const jobs = [];
  for (const s of scenes) {
    const a = s.args || {};
    const add = (src) => {
      if (!src || win.__MK_IMAGES[src]) return;
      jobs.push(loadImage(src).then((im) => { win.__MK_IMAGES[src] = im; }).catch(() => {}));
    };
    add(a.figureImage);
    (a.items || []).forEach((it) => add(it && it.image));
    (a.callouts || []).forEach((c) => add(c && c.image));
  }
  if (jobs.length) await Promise.all(jobs);
}

const TMPL_DIR = path.dirname(SRC_DIR);

/**
 * 姿态图（assets/figures/{idle,explain,point,open}.png）。
 * 浏览器由 index.html 的 <img data-fig> 提供；Skia 侧没有 DOM，
 * layouts.js 的 collectFigures() 会直接 return —— 不补这一步，人物会静默退化成矢量版，
 * 与浏览器成片不是同一个形象。
 */
async function primeFigures(win) {
  const dir = path.join(TMPL_DIR, 'assets', 'figures');
  if (!fs.existsSync(dir)) return [];
  const names = ['idle', 'explain', 'point', 'open'];
  await Promise.all(names.map(async (name) => {
    const p = path.join(dir, `${name}.png`);
    if (!fs.existsSync(p)) return;
    try { win.__MK_FIGS[name] = await loadImage(p); } catch { /* 缺图就退回矢量人物 */ }
  }));

  // 口型贴片：浏览器由 index.html 的 <img data-mouth> 提供；Skia 侧同样没有 DOM，
  // 不补这一步 figureSlot 里 M.half / M.open 恒为空 ⇒ 口型静默消失（浏览器有、Skia 没有）。
  win.__MK_MOUTHS = win.__MK_MOUTHS || {};
  const mdir = path.join(dir, 'mouth');
  await Promise.all(['half', 'open', 'round'].map(async (k) => {
    const p = path.join(mdir, `m_${k}.png`);
    if (!fs.existsSync(p)) return;
    try { win.__MK_MOUTHS[k] = await loadImage(p); } catch { /* 缺贴片则该档无口型 */ }
  }));

  return Object.keys(win.__MK_FIGS).concat(Object.keys(win.__MK_MOUTHS).map((k) => 'mouth:' + k));
}

/**
 * @param {{width?:number,height?:number,fps?:number,brand?:object,subtitle?:object,
 *          theme?:object,fadeOutSeconds?:number}} opts
 */
export function createScienceRenderer(opts = {}) {
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const canvas = opts.canvas || createCanvas(W, H);
  const ctx = opts.ctx || canvas.getContext('2d');
  const win = bootLayouts();
  const MK = win.MK;
  const L = win.L;
  const { clamp, ease, rgba } = MK.u;

  let state = {
    scenes: [], captions: [], brand: opts.brand || null,
    subtitle: opts.subtitle || {}, theme: opts.theme || {},
    fadeOutSeconds: opts.fadeOutSeconds === undefined ? 0.4 : opts.fadeOutSeconds,
  };
  let primed = null;
  const figuresReady = primeFigures(win);

  function setContent(next = {}) {
    state = {
      scenes: next.scenes || [],
      captions: next.captions || [],
      brand: next.brand || opts.brand || null,
      subtitle: next.subtitle || opts.subtitle || {},
      theme: next.theme || opts.theme || {},
      fadeOutSeconds: next.fadeOutSeconds === undefined ? state.fadeOutSeconds : next.fadeOutSeconds,
    };
    primed = primeImages(win, state.scenes);
    return state;
  }

  function duration() {
    const last = state.scenes[state.scenes.length - 1];
    return last ? Number(last.t1) : 0;
  }

  /** t 秒处的整帧。纯函数：同一 t 多次调用结果一致。 */
  function renderFrame(t) {
    const env = { T: Object.assign({}, MK.T, state.theme || {}), palette: state.theme };
    const total = duration();

    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // 段定位：末帧归最后一段
    let cur = state.scenes[state.scenes.length - 1];
    for (const s of state.scenes) {
      if (t >= s.t0 && t < s.t1) { cur = s; break; }
    }
    if (state.scenes.length && t < state.scenes[0].t0) cur = state.scenes[0];

    if (cur) {
      const localT = clamp(t - cur.t0, 0, cur.t1 - cur.t0);
      const fn = L[cur.type];
      if (fn) fn(ctx, W, H, localT, cur.t1 - cur.t0, cur.args || {}, env);
      else {
        MK.paper(ctx, W, H, 'cream', localT);
        MK.text(ctx, '未知版式：' + cur.type, W / 2, H / 2, { size: 60, align: 'center', color: MK.T.pop, font: 'sans' });
      }
    }

    // 品牌角标（结尾版式不画）
    if (state.brand && (!cur || cur.type !== 'outro')) {
      MK.cornerBadge(ctx, W, H, Object.assign({ show: true }, state.brand), 0.92);
    }

    // 烧录字幕：起止各 0.1s 淡入淡出
    const cap = state.captions.find((s) => t >= s.start && t < s.end);
    if (cap) {
      const k = clamp(Math.min((t - cap.start) / 0.10, (cap.end - t) / 0.10), 0, 1);
      ctx.save();
      ctx.globalAlpha *= k;
      MK.caption(ctx, W, H, cap, state.subtitle || {}, t);
      ctx.restore();
    }

    // 收尾淡出
    if (state.fadeOutSeconds > 0 && total > 0 && t > total - state.fadeOutSeconds) {
      ctx.fillStyle = rgba('#0B1418', ease((t - (total - state.fadeOutSeconds)) / state.fadeOutSeconds) * 0.72);
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    return true;
  }

  return {
    canvas, ctx, renderFrame, setContent, duration,
    /** 素材解码完成后再出片，避免首几帧缺图 */
    ready: () => Promise.all([primed || Promise.resolve(), figuresReady]),
    width: W, height: H,
    layouts: ['cover', 'talk', 'diagram', 'compare', 'matrix', 'focus', 'tip', 'outro'],
  };
}
