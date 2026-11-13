// kit.js · 绘制原语层
//
// 硬约束：本文件必须是纯 Canvas2D。
//   禁止 document / window / createElement —— 这些只出现在 index.html。
//   原因：同一份代码要同时喂 Chromium 与 Skia（见 SKIA-SPEC.md），碰 DOM 就断掉换宿主这条路。
//
// 约定：每个函数第一个参数是 ctx（CanvasRenderingContext2D 或 Skia 兼容对象）；
//       不自己创建 canvas、不自己读文件、不出现任何文案或颜色字面量（从 preset 来）。

(function (root) {
  'use strict';

  const FONT = 'PingFang SC';

  // 字体解析：浏览器用系统字体；Skia 侧没有 PingFang，注入 __FONT_PICK 按字重映射到
  // 随包 Noto（GlobalFonts 注册名）。不注入时行为与原来完全一致，浏览器端零回归。
  function pickFont(weight, size) {
    const pick = root.__FONT_PICK;
    return pick ? pick(weight || 700, size || 48) : FONT;
  }

  // 完整调色板：env.T 必须是「本表 + theme 覆盖」的合并结果。
  // 只把 theme 传进绘制函数会让 white/organ 这类基础色变成 undefined（真实踩过）。
  const T = {
    bg: '#101a1e',
    paper: '#f4efe4',
    ink: '#1d2a2f',
    white: '#ffffff',
    muted: '#7f939a',
    accent: '#2fbfa0',
    sun: '#f2c14e',
    pop: '#e05263',
    blue: '#3f8fd2',
  };

  const u = {
    clamp(x, a, b) { return Math.max(a, Math.min(b, x)); },
    ease(t) { const x = u.clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); },
    rgba(hex, a) {
      const h = String(hex || '#000').replace('#', '');
      const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    },
  };

  const MK = {
    T,
    u,

    // 渐变底：极轻的两色过渡，避免大面积纯色出现色带
    paper(ctx, W, H, tone, t) {
      const c1 = tone === 'dark' ? '#0d161a' : T.paper;
      const c2 = tone === 'dark' ? '#16262c' : '#efe7d8';
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    },

    rect(ctx, x, y, w, h, fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
    },

    text(ctx, str, x, y, opt) {
      const o = opt || {};
      ctx.save();
      ctx.font = `${o.weight || 700} ${o.size || 48}px ${o.family || pickFont(o.weight, o.size)}`;
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = o.baseline || 'alphabetic';
      if (o.stroke) {
        ctx.lineWidth = o.stroke;
        ctx.strokeStyle = o.strokeColor || T.ink;
        ctx.lineJoin = 'round';
        ctx.strokeText(str, x, y);
      }
      ctx.fillStyle = o.color || T.ink;
      ctx.fillText(str, x, y);
      ctx.restore();
    },

    // 烧录字幕：始终落在安全区内。y 由 preset 给，缺省按画布高度推。
    caption(ctx, W, H, cap, style, t) {
      const s = style || {};
      const size = s.size || Math.round(H * 0.057);
      // y 两种写法：≤1 视为相对高度（跨画幅安全），>1 视为绝对像素（旧 preset 兼容）
      const rawY = s.y === undefined ? 0.907 : Number(s.y);
      const y = rawY <= 1 ? Math.round(H * rawY) : Math.round(rawY);
      const k = u.clamp(Math.min((t - cap.start) / 0.10, (cap.end - t) / 0.10), 0, 1);
      ctx.save();
      ctx.globalAlpha *= k;
      MK.text(ctx, cap.text, W / 2, y, {
        size,
        align: 'center',
        color: s.color || T.white,
        stroke: s.stroke === undefined ? 6 : s.stroke,
        strokeColor: s.strokeColor || '#101a1e',
      });
      ctx.restore();
    },

    // 左下角角标
    cornerBadge(ctx, W, H, opt, alpha) {
      const o = opt || {};
      if (o.show === false) return;
      const size = Math.round(H * 0.026);
      ctx.save();
      ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
      MK.text(ctx, o.text || '', 96, H - 56, { size, color: T.muted, weight: 600 });
      ctx.restore();
    },

    // 入场缩放：下限必须 > 0。返回 0 会让「if (k <= 0) return」变成假门禁——
    // 真正的判断要用时间，见 guide.pitfalls。
    enter(t, dur) {
      return Math.max(0.82, u.ease((t || 0) / (dur || 0.5)));
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MK;
  else root.MK = MK;
})(typeof window !== 'undefined' ? window : this);
