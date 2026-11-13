/**
 * kits/clay/clay.mjs · 黏土图示（换宿主：直接跑上游 Canvas2D 源码）
 *
 * 与 science.mjs 的分工：
 *   - science.mjs 管的是**我们自建**的模板（三件套 + 姿态图/口型预载）
 *   - 本文件管的是**第三方模板**：原样加载 `vendor/native-clay.js`，只做三件事
 *       1) 给它一个 window（它要 document.createElement('canvas') 和 document.fonts）
 *       2) 把 font-family 映射到有中文的 Noto（它写死 ClaySans / Inter / ClayKai）
 *       3) 把我们的 segments[] 翻译成它的 recipe 并逐帧调 draw
 *
 * 上游是 `native-python-node/1` runtime，但**绘制层是纯 Canvas2D**
 * （getContext('2d') + beginPath + createRadialGradient + shadowBlur），
 * 所以换宿主成立，不需要半蒸馏。判据只有一条：有没有 getContext('2d')。
 *
 * 上游源码：knowledge-explainer-clay v2.7.4 · @adunext · 见 vendor/LICENSE-TEMPLATE.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, DOMMatrix, DOMPoint, GlobalFonts } from '@napi-rs/canvas';
import { registerFonts } from '../../src/fonts.mjs';
import { REPO_ROOT } from '../../src/root.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VENDOR = path.join(HERE, 'vendor', 'native-clay.js');
const FONT_DIR = path.join(REPO_ROOT, 'assets', 'fonts');

/** recipe 允许出现的字段（含 mechanism）。上游对多余字段宽容，但少一个就画不出东西。 */
const RECIPE_FIELDS = [
  'id', 'mechanism', 'title', 'nodes', 'unit', 'valueUnit', 'decimals', 'language',
  'seed', 'cueTimes', 'labels', 'family', 'duration',
  'parts', 'direction', 'agents', 'force', 'threshold', 'route', 'obstacles',
  'focusId', 'conditions',
];

let CLAY = null;

function boot() {
  if (CLAY) return CLAY;
  if (!fs.existsSync(VENDOR)) {
    throw new Error(
      `缺少 ${VENDOR}\n  它是第三方模板的渲染源码，不入库的部分需自行放置。` +
        '\n  来源：knowledge-explainer-clay v2.7.4 的 content/release.bin → native/native-clay.js'
    );
  }
  registerFonts(FONT_DIR);

  // 上游写死 `600 ${size}px ClaySans` 与 Inter / ClayKai。
  // Skia 不做 fontconfig 回退，所以必须显式把这些族名注册到有中文字形的字体上：
  // 映射到 Inter 会得到一片方框（Inter 无中文），这是真踩过的。
  const noto = path.join(FONT_DIR, 'NotoSansSC-Medium.otf');
  for (const alias of ['ClaySans', 'ClayKai', 'Inter']) {
    try {
      GlobalFonts.registerFromPath(noto, alias);
    } catch {
      /* 已注册过同名族，跳过 */
    }
  }

  const src = fs.readFileSync(VENDOR, 'utf8');
  const noop = () => {};
  const win = {};
  win.window = win;
  win.location = { href: 'file:///clay/' };
  const doc = {
    createElement(tag) {
      return tag === 'canvas' ? createCanvas(16, 16) : { style: {}, appendChild: noop, setAttribute: noop };
    },
    createElementNS: () => ({ style: {} }),
    body: { appendChild: noop, style: {} },
    fonts: { ready: Promise.resolve(), add: noop, [Symbol.iterator]: function* () {} },
    currentScript: null,
    baseURI: 'file:///clay/',
  };
  win.document = doc;
  win.Image = class { set src(_v) {} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  win.performance = { now: () => 0 };
  win.URL = URL;

  // DOMMatrix/DOMPoint 作为参数注入：源码里是自由变量 `new DOMMatrix()`，
  // 只挂在 window 上不生效（free variable 走作用域链，不走 window）。
  new Function(
    'window', 'document', 'location', 'URL', 'Image', 'requestAnimationFrame', 'performance',
    'DOMMatrix', 'DOMPoint', src
  )(win, doc, win.location, URL, win.Image, win.requestAnimationFrame, win.performance, DOMMatrix, DOMPoint);

  if (!win.NativeClay) throw new Error('native-clay.js 加载后没有 window.NativeClay');
  CLAY = win.NativeClay;
  return CLAY;
}

/** 段 → recipe：白名单挑字段，并把 type 映射成 mechanism。 */
function toRecipe(seg) {
  const src = seg.args && Object.keys(seg.args).length ? { ...seg, ...seg.args } : seg;
  const out = {};
  for (const k of RECIPE_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  out.mechanism = out.mechanism || seg.type;
  // duration 必须跟随实际段长：clay 用 t 与 duration 算动画进度。
  // 配音重排后段长会变（70s → 更长的口播版），若 duration 停在旧值，
  // 动画会在段落中途演完，后面是静止帧。
  const d = seg.t1 !== undefined && seg.t0 !== undefined
    ? Number(seg.t1) - Number(seg.t0)
    : Number(seg.dur || 0);
  // 上游 schema 限死 duration ∈ [9, 45]（不是建议值，是硬校验，越界直接抛）。
  // 段长小于 9 时动画只能播到 8/9≈89%，跑不满 —— 所以段长也该 ≥9。
  out.duration = Math.min(45, Math.max(9, Number(d || out.duration || 9)));
  return out;
}

export function createClayRenderer({ canvas, ctx, width, height, subtitle, brand }) {
  const clay = boot();
  let segments = [];
  let captions = [];

  function drawCaption(t) {
    if (!captions.length) return;
    const cap = captions.find((c) => t >= c.start && t < c.end);
    if (!cap) return;
    const s = subtitle || {};
    const size = s.size || Math.round(height * 0.052);
    const rawY = s.y === undefined ? 0.907 : Number(s.y);
    const y = rawY <= 1 ? Math.round(height * rawY) : Math.round(rawY);
    const k = Math.min(1, Math.min((t - cap.start) / 0.1, (cap.end - t) / 0.1));
    ctx.save();
    ctx.globalAlpha *= Math.max(0, k);
    ctx.font = `600 ${size}px NotoSC Medium`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.stroke || 6;
    ctx.strokeStyle = s.strokeColor || '#ffffff';
    ctx.strokeText(cap.text, width / 2, y);
    ctx.fillStyle = s.color || '#2b2a26';
    ctx.fillText(cap.text, width / 2, y);
    ctx.restore();
  }

  function drawBrand(t) {
    const b = brand || {};
    if (b.show === false) return;
    ctx.save();
    ctx.globalAlpha *= 0.75;
    ctx.font = `600 ${Math.round(height * 0.024)}px NotoSC Medium`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#8a8578';
    ctx.fillText(b.text || '', Math.round(width * 0.055), height - Math.round(height * 0.045));
    ctx.restore();
  }

  return {
    setContent(content) {
      segments = (content && content.scenes) || [];
      captions = (content && content.captions) || [];
    },

    async ready() {
      /* 无异步资源要等（字体在 boot 时已同步注册） */
    },

    renderFrame(t) {
      // 段边界以 t0/t1 为准：render.mjs 的 normalizeSegments 会把 dur 换成 t0/t1，
      // 只读 s.dur 会全部落到默认值（7 段 × 6s = 42s，而实际 70s），段匹配整片错位。
      let seg = null;
      let local = 0;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const t0 = Number(s.t0 !== undefined ? s.t0 : 0);
        const t1 = Number(s.t1 !== undefined ? s.t1 : t0 + Number(s.dur || 6));
        if (t >= t0 && (t < t1 || i === segments.length - 1)) {
          seg = s;
          local = Math.min(t - t0, Math.max(0, t1 - t0 - 0.001));
          break;
        }
      }
      if (!seg) {
        // 落在末尾之外：停在最后一段的最后一帧，避免黑屏
        seg = segments[segments.length - 1];
        local = seg ? Number(seg.dur || 6) - 0.001 : 0;
      }
      if (!seg) return;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const box = { x: 0, y: 0, width, height };
      // 背景必须单独画：clay 的 draw() 只管物体，不画底（上游把背景拆成了
      // background/drawBackground 两个导出）。漏这一步，canvas 透明，
      // yuv420p 编码后整支片子是黑底 —— 而且 gate 不会报黑帧（有物体时 YMAX 够高）。
      try {
        clay.drawBackground(ctx, box, { time: local });
      } catch {
        ctx.fillStyle = '#F1D2BF';
        ctx.fillRect(0, 0, width, height);
      }
      try {
        clay.draw(ctx, toRecipe(seg), local, box);
      } catch (e) {
        // 单段出错不该让整片崩：留错误文字，继续下一帧
        ctx.restore();
        ctx.save();
        ctx.fillStyle = '#f6f1e6';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#d05a4e';
        ctx.font = `600 32px NotoSC Medium`;
        ctx.fillText(`clay 段渲染失败：${String(e.message).slice(0, 90)}`, 60, 90);
        ctx.restore();
        ctx.save();
      }
      ctx.restore();

      drawCaption(t);
      drawBrand(t);
    },
  };
}

export { boot as bootClay };
