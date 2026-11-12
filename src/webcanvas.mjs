/**
 * src/webcanvas.mjs · 任意 Canvas2D 模板的 Skia 宿主（通用）
 *
 * 与 kits/* 里专用适配器的分工：science.mjs 认姿态图/口型贴片等专有概念；
 * 本文件不认任何具体版式，只认三件套约定：
 *
 *   src/kit.js     绘制原语（纯 Canvas2D）
 *   src/layouts.js 版式函数
 *   src/stage.js   编排（时间轴/字幕/角标/淡出，宿主无关）
 *
 * 三文件都用 IIFE + `typeof window !== 'undefined' ? window : this` 取根对象，
 * 所以这里给出一个 window 对象即可，源码零改动。
 *
 * 与浏览器的唯一差异是字体：浏览器有 PingFang SC，Skia 只能注册什么用什么，
 * 因此注入 __FONT_PICK 按字重映射到随包 Noto 三档（Skia 不做 weight 合成）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { registerFonts } from './fonts.mjs';

/** 字重 → 已注册字体族。与 kits/science 的 FONT_MAP 同口径，避免两套宿主字形不一致。 */
export function pickFont(weight) {
  const w = Number(weight) || 700;
  if (w >= 700) return 'NotoSC Black';
  if (w >= 500) return 'NotoSC Medium';
  return 'NotoSC Regular';
}

function boot(srcDir) {
  const win = { __MK_IMAGES: {}, __MK_FIGS: {} };
  win.window = win;
  win.__FONT_PICK = pickFont;
  win.__createCanvas = createCanvas;

  for (const f of ['kit.js', 'layouts.js', 'stage.js']) {
    const p = path.join(srcDir, f);
    if (!fs.existsSync(p)) {
      throw new Error(
        `缺少 ${p}\n  通用宿主要求三件套：kit.js / layouts.js / stage.js。` +
          '\n  只有 main.js 的模板（如 distill）先拆分，或继续走浏览器宿主。'
      );
    }
    // 参数名 window 遮蔽自由变量，源码里的 window.MK 即落到 win 上
    new Function('window', fs.readFileSync(p, 'utf8'))(win);
  }
  if (!win.MK || !win.L) throw new Error('绘制层加载失败：window.MK / window.L 未定义');
  if (typeof win.createStage !== 'function') throw new Error('编排层加载失败：window.createStage 未定义');
  return win;
}

/**
 * @param {object} opts
 * @param {string} opts.srcDir        模板 src 目录（含 kit.js / layouts.js / stage.js）
 * @param {string} [opts.templateDir] 模板根目录（解析相对素材路径用），默认 srcDir 的上级
 * @param {object} [opts.canvas]      复用画布
 * @param {object} [opts.ctx]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 */
export function createWebCanvasRenderer(opts = {}) {
  registerFonts(); // 幂等；缺字体只告警不中断
  const srcDir = path.resolve(opts.srcDir);
  const templateDir = path.resolve(opts.templateDir || path.dirname(srcDir));
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const canvas = opts.canvas || createCanvas(W, H);
  const ctx = opts.ctx || canvas.getContext('2d');

  const win = boot(srcDir);
  const stage = win.createStage({ ctx, W, H, MK: win.MK, L: win.L });

  let pending = Promise.resolve();

  /** 只预载段参数里出现的、看起来像路径的图片；找不到静默跳过（与浏览器 onerror 一致） */
  async function primeImages(inp) {
    const jobs = [];
    const add = (src) => {
      if (!src || typeof src !== 'string') return;
      if (!/^(\.{0,2}\/|\/)/.test(src)) return;
      if (win.__MK_IMAGES[src]) return;
      const abs = path.isAbsolute(src) ? src : path.resolve(templateDir, src);
      jobs.push(
        loadImage(abs)
          .then((im) => {
            win.__MK_IMAGES[src] = im;
          })
          .catch(() => {})
      );
    };
    for (const s of inp.scenes || inp.segments || []) {
      const a = s.args || s;
      add(a.figureImage);
      add(a.image);
      (a.items || []).forEach((it) => add(it && it.image));
      (a.callouts || []).forEach((c) => add(c && c.image));
    }
    if (jobs.length) await Promise.all(jobs);
  }

  return {
    canvas,
    setContent(inp) {
      stage.setContent(inp);
      pending = primeImages(inp);
    },
    ready() {
      return pending;
    },
    renderFrame(t) {
      stage.renderFrame(t);
    },
    duration() {
      return stage.duration();
    },
  };
}
