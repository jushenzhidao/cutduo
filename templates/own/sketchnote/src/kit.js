// kit.js · 手绘风原语（纯 Canvas2D）
//
// 硬约束：不碰 document / window / createElement —— 换宿主的前提（见 SKIA-SPEC.md）。
// 抖动一律用**确定性伪随机**：同一个 seed 每帧画出完全相同的线。
// 用时间当种子会让线条逐帧抖动，成片像在震（真踩过）。

(function (root) {
  'use strict';

  const FONT = 'PingFang SC';

  function pickFont(weight, size) {
    const pick = root.__FONT_PICK;
    return pick ? pick(weight || 700, size || 48) : FONT;
  }

  const T = {
    paper: '#f6f1e6',
    ink: '#2b2a26',
    accent: '#e8b33a',
    highlight: '#ffe680',
    sticky: '#fff2b8',
    stickyAlt: '#ffd9c9',
    blue: '#4a7fb5',
    red: '#d05a4e',
    muted: '#8a8578',
    white: '#ffffff',
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

  // 确定性伪随机：同 seed 恒定，跨帧稳定
  function rnd(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  const MK = {
    T,
    u,
    rnd,

    paper(ctx, W, H, tone, t) {
      const base = tone === 'dark' ? '#2b2a26' : T.paper;
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, H);
      if (tone === 'dark') return;
      ctx.save();
      ctx.globalAlpha *= 0.05;
      ctx.strokeStyle = T.muted;
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y += 9) {
        const off = Math.sin(y * 0.02) * 1.6;
        ctx.beginPath();
        ctx.moveTo(0, y + off);
        ctx.lineTo(W, y + off);
        ctx.stroke();
      }
      ctx.restore();
    },

    measure(ctx, str, size, weight) {
      ctx.save();
      ctx.font = `${weight || 700} ${size}px ${pickFont(weight, size)}`;
      const w = ctx.measureText(String(str || '')).width;
      ctx.restore();
      return w;
    },

    text(ctx, str, x, y, opt) {
      const o = opt || {};
      const size = o.size || 48;
      const weight = o.weight || 700;
      ctx.save();
      ctx.font = `${weight} ${size}px ${o.family || pickFont(weight, size)}`;
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

    // 手绘直线：分 4 段，中间端点微偏
    handLine(ctx, x1, y1, x2, y2, opt) {
      const o = opt || {};
      const seed = o.seed || 1;
      const amp = o.amp === undefined ? 1.6 : o.amp;
      const seg = 4;
      ctx.save();
      ctx.strokeStyle = o.color || T.ink;
      ctx.lineWidth = o.width || 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i <= seg; i++) {
        const k = i / seg;
        const px = x1 + (x2 - x1) * k;
        const py = y1 + (y2 - y1) * k;
        const jx = i === 0 || i === seg ? 0 : (rnd(seed + i * 7.1) - 0.5) * amp * 2;
        const jy = i === 0 || i === seg ? 0 : (rnd(seed + i * 13.7) - 0.5) * amp * 2;
        if (i === 0) ctx.moveTo(px + jx, py + jy);
        else ctx.lineTo(px + jx, py + jy);
      }
      ctx.stroke();
      ctx.restore();
    },

    // 手绘矩形：四条边各画一遍
    handRect(ctx, x, y, w, h, opt) {
      const o = opt || {};
      const s = o.seed || 1;
      if (o.fill) {
        ctx.save();
        ctx.fillStyle = o.fill;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      if (o.stroke === false) return;
      const pad = o.inset || 0;
      const X = x + pad, Y = y + pad, W = w - pad * 2, H = h - pad * 2;
      MK.handLine(ctx, X, Y, X + W, Y, { ...o, seed: s });
      MK.handLine(ctx, X + W, Y, X + W, Y + H, { ...o, seed: s + 11 });
      MK.handLine(ctx, X + W, Y + H, X, Y + H, { ...o, seed: s + 23 });
      MK.handLine(ctx, X, Y + H, X, Y, { ...o, seed: s + 37 });
    },

    // 荧光笔：略带倾斜的粗块
    highlight(ctx, x, y, w, h, opt) {
      const o = opt || {};
      ctx.save();
      ctx.globalAlpha *= o.alpha === undefined ? 0.72 : o.alpha;
      ctx.fillStyle = o.color || T.highlight;
      ctx.beginPath();
      const tilt = Math.min(6, h * 0.12);
      ctx.moveTo(x - 3, y + tilt);
      ctx.lineTo(x + w + 3, y - tilt);
      ctx.lineTo(x + w + 1, y + h + tilt);
      ctx.lineTo(x - 1, y + h - tilt);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },

    sticky(ctx, x, y, w, h, opt) {
      const o = opt || {};
      ctx.save();
      ctx.shadowColor = 'rgba(43,42,38,0.18)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 5;
      ctx.fillStyle = o.color || T.sticky;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      MK.handRect(ctx, x, y, w, h, { seed: o.seed || 5, width: 2.2, color: u.rgba(T.ink, 0.55), amp: 1.1 });
    },

    // 划掉一行：两道略斜的红线
    strike(ctx, x, y, w, seed) {
      const s = seed || 3;
      MK.handLine(ctx, x, y, x + w, y - 4, { color: T.red, width: 4, seed: s, amp: 2 });
      MK.handLine(ctx, x + 2, y + 5, x + w - 3, y + 1, { color: T.red, width: 3, seed: s + 9, amp: 2 });
    },

    arrow(ctx, x1, y1, x2, y2, opt) {
      const o = opt || {};
      MK.handLine(ctx, x1, y1, x2, y2, o);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = o.head || 18;
      ctx.save();
      ctx.strokeStyle = o.color || T.ink;
      ctx.lineWidth = o.width || 3;
      ctx.lineCap = 'round';
      for (const d of [0.42, -0.42]) {
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - len * Math.cos(ang + d), y2 - len * Math.sin(ang + d));
        ctx.stroke();
      }
      ctx.restore();
    },

    // 四种简笔图标（纯矢量，不依赖位图）
    icon(name, ctx, cx, cy, size, color) {
      const c = color || T.ink;
      const r = size / 2;
      ctx.save();
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.lineWidth = Math.max(2.5, size * 0.08);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (name === 'concept') {
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2); ctx.fill();
      } else if (name === 'explain') {
        ctx.beginPath(); ctx.moveTo(cx - r * 0.7, cy); ctx.lineTo(cx + r * 0.5, cy); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + r * 0.5, cy - r * 0.35); ctx.lineTo(cx + r * 0.85, cy); ctx.lineTo(cx + r * 0.5, cy + r * 0.35);
        ctx.stroke();
        for (const dy of [-r * 0.55, r * 0.55]) {
          ctx.beginPath(); ctx.moveTo(cx - r * 0.7, cy + dy); ctx.lineTo(cx - r * 0.15, cy + dy); ctx.stroke();
        }
      } else if (name === 'relearn') {
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.72, 0.6, Math.PI * 1.8); ctx.stroke();
        const ang = Math.PI * 1.8;
        const tx = cx + r * 0.72 * Math.cos(ang), ty = cy + r * 0.72 * Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(tx - r * 0.2, ty - r * 0.28); ctx.lineTo(tx + r * 0.02, ty + r * 0.12); ctx.lineTo(tx - r * 0.42, ty + r * 0.16);
        ctx.stroke();
      } else {
        for (let i = 0; i < 3; i++) {
          const y = cy - r * 0.5 + i * r * 0.5;
          const w = r * (1.5 - i * 0.42);
          ctx.beginPath(); ctx.moveTo(cx - r * 0.75, y); ctx.lineTo(cx - r * 0.75 + w, y); ctx.stroke();
        }
      }
      ctx.restore();
    },

    caption(ctx, W, H, cap, style, t) {
      const s = style || {};
      const size = s.size || Math.round(H * 0.057);
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
        strokeColor: s.strokeColor || T.ink,
      });
      ctx.restore();
    },

    cornerBadge(ctx, W, H, opt, alpha) {
      const o = opt || {};
      if (o.show === false) return;
      ctx.save();
      ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
      MK.text(ctx, o.text || '', Math.round(W * 0.0625), H - 56, {
        size: Math.round(H * 0.026), color: T.muted, weight: 600,
      });
      ctx.restore();
    },

    enter(t, dur) {
      return Math.max(0.82, u.ease((t || 0) / (dur || 0.5)));
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MK;
  else root.MK = MK;
})(typeof window !== 'undefined' ? window : this);
