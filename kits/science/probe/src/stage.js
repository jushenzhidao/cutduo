// stage.js · 编排层（宿主无关）
//
// 这一段是「时间轴 → 段定位 → 版式 → 角标 → 字幕 → 淡出」的全部逻辑。
// 抽出来的理由：浏览器侧 main.js 与 Skia 侧适配器原本各写一份，必然漂移
// （science-explainer 就是两份，改一边忘一边）。这里只写一份，两个宿主都调它。
//
// 硬约束：本文件不碰 DOM、不读文件、不创建 canvas —— 只接收 ctx。
//
// 输入两种形态都认：
//   segments: [{ type, dur, title, ... }]         ← 人写的内容稿（平铺参数）
//   scenes:   [{ type, t0, t1, args: {...} }]     ← skia-kit/render.mjs 归一化后的形态
// 段参数统一成 args：有 seg.args 用它，否则整个 seg 当参数（平铺写法）。

(function (root) {
  'use strict';

  root.createStage = function (opts) {
    const ctx = opts.ctx;
    const W = opts.W;
    const H = opts.H;
    const MK = opts.MK;
    const L = opts.L;
    const { clamp, ease, rgba } = MK.u;

    let state = {
      timeline: [],
      captions: [],
      brand: null,
      subtitle: {},
      theme: {},
      fadeOut: 0.4,
    };

    function toTimeline(inp) {
      if (Array.isArray(inp.scenes) && inp.scenes.length) {
        return inp.scenes.map((s) => ({
          type: s.type,
          t0: Number(s.t0) || 0,
          t1: Number(s.t1) || 0,
          args: s.args || s,
        }));
      }
      const segs = Array.isArray(inp.segments) ? inp.segments : [];
      let acc = 0;
      return segs.map((s) => {
        const t0 = acc;
        acc += Number(s.dur || 3);
        return { type: s.type, t0, t1: acc, args: s.args || s };
      });
    }

    function setContent(inp) {
      const src = inp || {};
      state = {
        timeline: toTimeline(src),
        captions: src.captions || [],
        brand: src.brand || null,
        subtitle: src.subtitle || {},
        theme: src.theme || {},
        fadeOut: src.fadeOutSeconds === undefined ? 0.4 : Number(src.fadeOutSeconds),
      };
      return state;
    }

    function duration() {
      const tl = state.timeline;
      return tl.length ? tl[tl.length - 1].t1 : 0;
    }

    // t 秒处的整帧。纯函数：同一 t 多次调用结果一致（除 canvas 自身无状态外无副作用）。
    function renderFrame(t) {
      const tl = state.timeline;
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      if (!tl.length) {
        ctx.restore();
        return false;
      }

      // 段定位：落在两段之间时归前一段；末帧归最后一段
      let cur = tl[tl.length - 1];
      for (const s of tl) {
        if (t >= s.t0 && t < s.t1) {
          cur = s;
          break;
        }
      }
      if (t < tl[0].t0) cur = tl[0];

      // env.T 必须是「完整调色板 + theme 覆盖」。只传 theme 会让 white 等基础色变 undefined。
      const env = { T: Object.assign({}, MK.T, state.theme), palette: state.theme };
      const localT = clamp(t - cur.t0, 0, cur.t1 - cur.t0);
      const fn = L[cur.type];

      if (fn) {
        fn(ctx, W, H, localT, cur.t1 - cur.t0, cur.args, env);
      } else {
        MK.paper(ctx, W, H, 'cream', localT);
        MK.text(ctx, '未知版式：' + cur.type, W / 2, H / 2, {
          size: 60,
          align: 'center',
          color: MK.T.pop,
        });
      }

      if (state.brand && cur.type !== 'outro') {
        MK.cornerBadge(ctx, W, H, Object.assign({ show: true }, state.brand), 0.9);
      }

      const cap = state.captions.find((s) => t >= s.start && t < s.end);
      if (cap) MK.caption(ctx, W, H, cap, state.subtitle, t);

      const dur = duration();
      if (state.fadeOut > 0 && t > dur - state.fadeOut) {
        ctx.fillStyle = rgba('#0B1418', ease((t - (dur - state.fadeOut)) / state.fadeOut) * 0.72);
        ctx.fillRect(0, 0, W, H);
      }

      ctx.restore();
      return true;
    }

    return { setContent, renderFrame, duration };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.createStage;
})(typeof window !== 'undefined' ? window : this);
