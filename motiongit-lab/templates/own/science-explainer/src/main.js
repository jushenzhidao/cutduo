/* main.js — 时间轴与逐帧入口
 * 宿主每帧调用 window.renderFrame(frame, inputs)。
 * 画面是 (frame, inputs) 的纯函数；唯一的异步是首次图片解码（结果缓存）。
 */
(function () {
  'use strict';
  const MK = window.MK;
  const L = window.L;
  const { clamp, ease, rgba } = MK.u;

  const cvs = document.getElementById('c');
  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;
  const FPS = Number(window.__FPS || 30);

  const T = MK.T;

  function resolvedInputs(inputs) {
    const base = window.MOTION_INPUTS || {};
    const inp = Object.assign({}, base, inputs || {});
    inp.theme = Object.assign({}, {
      pop: T.pop, sun: T.sun, jade: T.jade, jadeDeep: T.jadeDeep, blue: T.blue, ink: T.ink,
    }, base.theme || {}, (inputs && inputs.theme) || {});
    return inp;
  }

  // 时间轴：段首尾累计
  function timeline(inp) {
    const segs = Array.isArray(inp.segments) ? inp.segments : [];
    let acc = 0;
    return segs.map((s) => {
      const t0 = acc; acc += Number(s.dur || 3);
      return { seg: s, t0, t1: acc };
    });
  }

  /* -------------------------------- 图片槽 -------------------------------- */
  const IMG = (window.__MK_IMAGES = window.__MK_IMAGES || {});
  const PENDING = {};

  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (IMG[src] && IMG[src].complete) return Promise.resolve(IMG[src]);
    if (PENDING[src]) return PENDING[src];
    PENDING[src] = new Promise((resolve) => {
      const im = new Image();
      im.onload = () => { IMG[src] = im; resolve(im); };
      im.onerror = () => resolve(null);
      im.src = src;
    });
    return PENDING[src];
  }

  async function primeImages(inp) {
    const jobs = [];
    for (const s of inp.segments || []) {
      const a = s.args || {};
      if (a.figureImage) jobs.push(loadImage(a.figureImage));
      (a.items || []).forEach((it) => { if (it && it.image) jobs.push(loadImage(it.image)); });
    }
    if (jobs.length) await Promise.all(jobs);
  }

  /* -------------------------------- 主绘制 -------------------------------- */
  let primed = false;

  window.renderFrame = async function (frame, inputs) {
    const inp = resolvedInputs(inputs);
    if (!primed) { await primeImages(inp); primed = true; }

    const t = frame / FPS;
    const dur = Number(inp.durationSeconds || 0) || (timeline(inp).slice(-1)[0] || {}).t1 || 10;
    // env.T 必须是"完整调色板 + 主题覆盖"：只传 theme 会让 white/organ 等基础色变 undefined
    const env = { T: Object.assign({}, T, inp.theme || {}), palette: inp.theme };

    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // 段定位（末帧落在最后一段）
    const tl = timeline(inp);
    let cur = tl[tl.length - 1];
    for (const s of tl) { if (t >= s.t0 && t < s.t1) { cur = s; break; } }
    if (t < tl[0].t0) cur = tl[0];

    const localT = clamp(t - cur.t0, 0, cur.seg.dur);
    const fn = L[cur.seg.type];
    if (fn) {
      fn(ctx, W, H, localT, cur.seg.dur, cur.seg.args || {}, env);
    } else {
      MK.paper(ctx, W, H, 'cream', localT);
      MK.text(ctx, '未知版式：' + cur.seg.type, W / 2, H / 2, { size: 60, align: 'center', color: T.pop, font: 'sans' });
    }

    // 角标
    if (inp.brand && cur.seg.type !== 'outro') {
      MK.cornerBadge(ctx, W, H, Object.assign({ show: true }, inp.brand), 0.92);
    }

    // 字幕
    const subs = inp.captions || [];
    const cap = subs.find((s) => t >= s.start && t < s.end);
    if (cap) {
      const k = clamp(Math.min((t - cap.start) / 0.10, (cap.end - t) / 0.10), 0, 1);
      ctx.save();
      ctx.globalAlpha *= k;
      MK.caption(ctx, W, H, cap, inp.subtitle || {}, t);
      ctx.restore();
    }

    // 收尾淡出
    const fadeOut = Number(inp.fadeOutSeconds === undefined ? 0.4 : inp.fadeOutSeconds);
    if (fadeOut > 0 && t > dur - fadeOut) {
      ctx.fillStyle = rgba('#0B1418', ease((t - (dur - fadeOut)) / fadeOut) * 0.72);
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    return true;
  };

  // 供 preview / 调试：把当前段号与总时长暴露出来
  window.__motionInfo = () => {
    const inp = resolvedInputs();
    const tl = timeline(inp);
    return { segments: tl.length, total: tl.length ? tl[tl.length - 1].t1 : 0, fps: FPS, size: [W, H] };
  };
})();
