// kit.js · 绘制原语层（night-card）
//
// 硬约束：
//   1) 纯 Canvas2D：不碰 document / window / createElement。
//   2) 不出现文案与配色字面量：文字来自 preset，颜色只来自下面这张完整调色板 + theme 覆盖。
//
// 这套原语只服务一种画面：竖屏、深底、一句话。所以刻意不提供图表、表格、多栏排版，
// 那些能力应该在新模板里做，不要往这里加。

(function (root) {
  'use strict';

  const FONT = 'PingFang SC';

  function pickFont(weight, size) {
    const pick = root.__FONT_PICK;
    return pick ? pick(weight || 700, size || 48) : FONT;
  }

  // 完整调色板。env.T = 本表 + preset.theme 覆盖。
  // 深色底上 ink 是「主文字色」（暖白），不是墨色——语义键名沿用骨架，值按深色重设。
  const T = {
    bg: '#0A0A0C',
    bgSoft: '#151318',
    ink: '#F2EDE3',
    white: '#FFFFFF',
    muted: '#8A8478',
    dim: '#3A353C',
    accent: '#E0A94A',
    accentSoft: '#8A6526',
    paper: '#F4EFE4',
    sun: '#F2C14E',
    pop: '#E05263',
    blue: '#3F8FD2',
  };

  const u = {
    clamp(x, a, b) { return Math.max(a, Math.min(b, x)); },
    ease(t) { const x = u.clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); },
    // 更慢的一条：先快后极慢，给大标题用，避免收尾的机械感
    settle(t) { const x = u.clamp(t, 0, 1); return 1 - Math.pow(1 - x, 4); },
    rgba(hex, a) {
      const h = String(hex || '#000').replace('#', '');
      const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    },
    // 确定性伪随机：同一 seed 每次渲染结果一致，多 worker 分片才不会出现接缝
    rand(seed) {
      let s = (seed | 0) || 1;
      return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
    },
  };

  // 颗粒点集只算一次，坐标归一化到 0..1
  const GRAIN = (() => {
    const r = u.rand(20261113);
    const out = [];
    for (let i = 0; i < 420; i++) out.push([r(), r(), 0.35 + r() * 0.65]);
    return out;
  })();

  function fontOf(weight, size) {
    return `${weight || 700} ${size || 48}px ${pickFont(weight, size)}`;
  }

  function widthOf(ctx, s, size, weight) {
    ctx.font = fontOf(weight, size);
    return ctx.measureText(s).width;
  }

  // 折行：中文逐字断，英文不拆词。先按显式 \n 分段。
  function wrap(ctx, text, maxW, size, weight) {
    const paras = String(text === undefined || text === null ? '' : text).split('\n');
    const out = [];
    for (const p of paras) {
      const tokens = p.match(/[A-Za-z0-9'’\-]+|\s+|[^\s]/g) || [];
      let line = '';
      for (const tk of tokens) {
        const next = line + tk;
        if (line && widthOf(ctx, next, size, weight) > maxW) {
          out.push(line.replace(/\s+$/, ''));
          line = /^\s+$/.test(tk) ? '' : tk;
        } else {
          line = next;
        }
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }

  // 字号自适应：在 maxSize..minSize 之间降档，直到行数与宽度都满足。
  // 返回行高，调用方用 size * lineHeight 推总高度，不要自己再猜。
  function fitText(ctx, text, maxW, opt) {
    const o = opt || {};
    const maxSize = o.maxSize || 120;
    const minSize = o.minSize || 56;
    const maxLines = o.maxLines || 3;
    const weight = o.weight || 700;
    const lh = o.lineHeight || 1.42;
    let size = Math.round(maxSize);
    for (; size >= minSize; size -= 4) {
      const lines = wrap(ctx, text, maxW, size, weight);
      if (lines.length <= maxLines) {
        return { lines, size, lineHeight: Math.round(size * lh), overflow: false };
      }
    }
    return { lines: wrap(ctx, text, maxW, minSize, weight), size: minSize, lineHeight: Math.round(minSize * lh), overflow: true };
  }

  const MK = {
    T,
    u,

    fontOf,
    widthOf,
    wrap,
    fitText,

    // 深色底：主渐变 + 右上一团极淡暖光。暖光 alpha 高于 0.10 会显脏。
    ground(ctx, W, H, env) {
      const T2 = (env && env.T) || T;
      const g = ctx.createLinearGradient(0, 0, W * 0.45, H);
      g.addColorStop(0, T2.bg);
      g.addColorStop(1, T2.bgSoft);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const r = ctx.createRadialGradient(W * 0.84, H * 0.12, 0, W * 0.84, H * 0.12, Math.max(W, H) * 0.62);
      r.addColorStop(0, u.rgba(T2.accent, 0.085));
      r.addColorStop(0.55, u.rgba(T2.accent, 0.022));
      r.addColorStop(1, u.rgba(T2.accent, 0));
      ctx.fillStyle = r;
      ctx.fillRect(0, 0, W, H);
    },

    // 四周压暗，把视线收到中间
    vignette(ctx, W, H, strength) {
      const s = strength === undefined ? 0.52 : strength;
      const g = ctx.createRadialGradient(W * 0.5, H * 0.45, Math.min(W, H) * 0.28, W * 0.5, H * 0.45, Math.max(W, H) * 0.82);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${s})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    },

    // 颗粒：1.4px 方点，alpha 很低。作用是让大面积深色不出现色带、不显空。
    grain(ctx, W, H, alpha) {
      const a = alpha === undefined ? 0.045 : alpha;
      ctx.save();
      ctx.globalAlpha *= a;
      ctx.fillStyle = '#FFFFFF';
      for (let i = 0; i < GRAIN.length; i++) {
        const p = GRAIN[i];
        ctx.fillRect(Math.round(p[0] * W), Math.round(p[1] * H), 1.4, 1.4);
      }
      ctx.restore();
    },

    // 缓慢推近：整段只推 amp（默认 3%），比入场飞入更耐看，也不会在切点露出边框
    ken(ctx, W, H, t, dur, amp) {
      const k = 1 + (amp === undefined ? 0.03 : amp) * u.clamp((t || 0) / (dur || 1), 0, 1);
      ctx.translate(W * 0.5, H * 0.46);
      ctx.scale(k, k);
      ctx.translate(-W * 0.5, -H * 0.46);
    },

    text(ctx, str, x, y, opt) {
      const o = opt || {};
      ctx.save();
      ctx.font = fontOf(o.weight, o.size);
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = o.baseline || 'alphabetic';
      ctx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
      if (o.stroke) {
        ctx.lineWidth = o.stroke;
        ctx.strokeStyle = o.strokeColor || T.bg;
        ctx.lineJoin = 'round';
        ctx.strokeText(str, x, y);
      }
      ctx.fillStyle = o.color || T.ink;
      ctx.fillText(str, x, y);
      ctx.restore();
    },

    // 字距加宽的小标签。Canvas2D 的 letterSpacing 在 Skia 侧不一定有，手工排更稳。
    tracked(ctx, str, x, y, opt) {
      const o = opt || {};
      const s = String(str || '');
      const chars = Array.from(s);
      if (!chars.length) return 0;
      const tr = o.tracking === undefined ? 6 : o.tracking;
      const size = o.size || 30;
      const weight = o.weight || 600;
      ctx.save();
      ctx.font = fontOf(weight, size);
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
      const ws = chars.map((c) => ctx.measureText(c).width);
      const total = ws.reduce((a, b) => a + b, 0) + tr * (chars.length - 1);
      let px = o.align === 'center' ? x - total / 2 : o.align === 'right' ? x - total : x;
      ctx.fillStyle = o.color || T.muted;
      for (let i = 0; i < chars.length; i++) {
        ctx.fillText(chars[i], px, y);
        px += ws[i] + tr;
      }
      ctx.restore();
      return total;
    },

    // 逐字浮现：位置固定、只动透明度，所以不会因为字数变化导致整行抖动。
    // p 从 0 到 1，字依次亮起；p=1 时全部可见。
    reveal(ctx, lines, x, y0, size, lineH, opt, p) {
      const o = opt || {};
      const weight = o.weight || 700;
      const align = o.align || 'left';
      const color = o.color || T.ink;
      const prog = u.clamp(p === undefined ? 1 : p, 0, 1);
      const rows = lines.map((l) => Array.from(l));
      const total = rows.reduce((n, r) => n + r.length, 0);
      ctx.save();
      ctx.font = fontOf(weight, size);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = color;
      let idx = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let rowW = 0;
        const ws = row.map((c) => { const w = ctx.measureText(c).width; rowW += w; return w; });
        let px = align === 'center' ? x - rowW / 2 : align === 'right' ? x - rowW : x;
        for (let j = 0; j < row.length; j++) {
          // 底线 0.22：段首整句已经隐约在场，逐字只是把透明度推到 1。
          // 不设底线会出现「切点只有前三个字」的半句帧，看起来像渲染错误。
          const lit = u.clamp((prog * (total + 4) - idx) / 2.4, 0, 1);
          const a = 0.22 + 0.78 * lit;
          ctx.globalAlpha = o.alpha === undefined ? a : a * o.alpha;
          ctx.fillText(row[j], px, y0 + i * lineH);
          px += ws[j];
          idx++;
        }
      }
      ctx.restore();
    },

    rule(ctx, x, y, w, color, h) {
      if (w <= 0) return;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), h === undefined ? 2 : h);
    },

    dot(ctx, x, y, r, color) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    },

    // 竖屏字幕：默认落在 0.845 高度，避开短视频底部的操作栏。
    // 情绪向卡片的正文就是大字，字幕只在有旁白时开。
    caption(ctx, W, H, cap, style, t) {
      const s = style || {};
      const size = s.size || Math.round(H * 0.028);
      const rawY = s.y === undefined ? 0.845 : Number(s.y);
      const y = rawY <= 1 ? Math.round(H * rawY) : Math.round(rawY);
      const k = u.clamp(Math.min((t - cap.start) / 0.12, (cap.end - t) / 0.12), 0, 1);
      ctx.save();
      ctx.globalAlpha *= k;
      MK.text(ctx, cap.text, W / 2, y, {
        size,
        align: 'center',
        weight: 500,
        color: s.color || T.white,
        stroke: s.stroke === undefined ? 0 : s.stroke,
        strokeColor: s.strokeColor || T.bg,
      });
      ctx.restore();
    },

    // 左下角标：竖屏往上提到 0.93H，别和字幕区打架
    cornerBadge(ctx, W, H, opt, alpha) {
      const o = opt || {};
      if (o.show === false) return;
      const size = Math.round(H * 0.0145);
      ctx.save();
      ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
      MK.tracked(ctx, o.text || '', 96, H - Math.round(H * 0.062), {
        size,
        tracking: 4,
        color: T.muted,
        weight: 500,
      });
      ctx.restore();
    },

    // 入场缩放：下限必须 > 0。返回 0 会让 `if (k <= 0) return` 变成假门禁。
    enter(t, dur) {
      return Math.max(0.9, u.settle((t || 0) / (dur || 0.6)));
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MK;
  else root.MK = MK;
})(typeof window !== 'undefined' ? window : this);
