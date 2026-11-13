// layouts.js · 四个手绘版式（纯 Canvas2D）
//
// 版式函数签名：(ctx, W, H, t, dur, a, env)
//   t    段内时间（秒，从 0 起）
//   a    段参数（平铺写法：seg.args || seg）
//   env  { T: 完整调色板 + theme 覆盖 }
//
// 三条纪律：
//   1. 所有坐标按 W/H 比例算，不写死 1920×1080（换画幅才不崩）
//   2. 抖动种子来自元素下标，不来自时间（否则线条逐帧发抖）
//   3. 逐项出现必须显式判时间 `if (t < at) return` —— enter() 有 0.82 下限，永远不会是 0

(function (root) {
  'use strict';

  const MK = root.MK;
  const L = {};
  const { clamp, ease, rgba } = MK.u;

  /* ── 公共件 ───────────────────────────────────────────── */

  // 逐字测量：算出「第 from 到第 to 个字」的像素区间（中文不能按字数×字号估）
  function spanOf(ctx, text, size, from, to) {
    const chars = Array.from(String(text));
    const ws = chars.map((c) => MK.measure(ctx, c, size, 700));
    const total = ws.reduce((s, x) => s + x, 0);
    const a = ws.slice(0, clamp(from, 0, chars.length)).reduce((s, x) => s + x, 0);
    const b = ws.slice(0, clamp(to, 0, chars.length)).reduce((s, x) => s + x, 0);
    return { start: a, width: b - a, total };
  }

  function markedLabel(ctx, text, x, y, size, hl, seed) {
    if (hl && hl[1] > hl[0]) {
      const sp = spanOf(ctx, text, size, hl[0], hl[1]);
      MK.highlight(ctx, x + sp.start, y - size * 0.76, sp.width, size * 0.9, { seed });
    }
    MK.text(ctx, text, x, y, { size, weight: 700 });
  }

  function heading(ctx, W, H, a, env) {
    const T = env.T;
    const x = Math.round(W * 0.083);
    const ts = Math.round(H * 0.058);
    MK.text(ctx, a.title || '', x, Math.round(H * 0.135), { size: ts, weight: 700, color: T.ink });
    const tw = MK.measure(ctx, a.title || '', ts, 700);
    MK.handLine(ctx, x - 4, H * 0.163, x + tw + 8, H * 0.163, { color: T.accent, width: 5, seed: 7, amp: 2 });
    if (a.subtitle) {
      MK.text(ctx, a.subtitle, x, Math.round(H * 0.205), { size: Math.round(H * 0.03), weight: 500, color: T.muted });
    }
    return Math.round(H * 0.245);
  }

  function conclusion(ctx, W, H, lines, env, alpha) {
    if (!lines || !lines.length) return;
    const T = env.T;
    ctx.save();
    ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
    const y = Math.round(H * 0.79);
    const size = Math.round(H * 0.032);
    lines.forEach((ln, i) => {
      MK.text(ctx, ln, W / 2, y + i * size * 1.6, { size, weight: 600, color: T.ink, align: 'center' });
    });
    ctx.restore();
  }

  /* ── 1. 步骤序列：每步出现后保留 ──────────────────────── */

  L['step-sequence'] = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    MK.paper(ctx, W, H, 'cream', t);
    const top = heading(ctx, W, H, a, env);

    const items = (a.items || []).slice(0, 6);
    const n = Math.max(1, items.length);
    const gap = W * 0.022;
    const totalW = W * 0.83;
    const cardW = (totalW - gap * (n - 1)) / n;
    const cardH = H * 0.30;
    const x0 = (W - totalW) / 2;
    const y0 = top + H * 0.035;

    items.forEach((it, i) => {
      const at = 0.25 + i * 1.35;
      if (t < at) return; // 显式时间门：enter() 有下限，不能用 k<=0 判断
      const k = MK.enter(t - at, 0.55);
      const x = x0 + i * (cardW + gap);
      const isCurrent = i === n - 1 || t < 0.25 + (i + 1) * 1.35;

      ctx.save();
      ctx.translate(x + cardW / 2, y0 + cardH / 2 + (1 - k) * H * 0.03);
      ctx.scale(k, k);
      ctx.translate(-(x + cardW / 2), -(y0 + cardH / 2));

      MK.sticky(ctx, x, y0, cardW, cardH, {
        color: i % 2 ? T.stickyAlt : T.sticky,
        seed: 20 + i * 17,
      });

      const cx = x + cardW * 0.16, cy = y0 + cardH * 0.19;
      const r = Math.min(cardW, cardH) * 0.085;
      ctx.strokeStyle = T.ink;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      MK.text(ctx, String(i + 1), cx, cy + r * 0.42, { size: Math.round(r * 1.15), weight: 700, align: 'center' });

      MK.icon(it.icon || 'concept', ctx, x + cardW * 0.84, cy, r * 1.9, rgba(T.ink, isCurrent ? 0.9 : 0.45));

      const lsize = Math.round(cardH * 0.155);
      const ly = y0 + cardH * 0.47;
      const lsp = spanOf(ctx, it.label || '', lsize, 0, Array.from(it.label || '').length);
      markedLabel(ctx, it.label || '', x + (cardW - lsp.total) / 2, ly, lsize, it.highlight, 40 + i);

      const nsize = Math.round(cardH * 0.088);
      (it.notes || []).slice(0, 2).forEach((note, j) => {
        MK.text(ctx, note, x + cardW * 0.12, y0 + cardH * (0.64 + j * 0.16), {
          size: nsize, weight: 500, color: rgba(T.ink, 0.72),
        });
      });

      ctx.restore();
    });

    const doneAt = 0.25 + (n - 1) * 1.35 + 0.8;
    if (t >= doneAt) conclusion(ctx, W, H, a.conclusion, env, ease((t - doneAt) / 0.6));
  };

  /* ── 2. 关键词标注：整页只有一个词 ────────────────────── */

  L['keyword-annotation'] = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    MK.paper(ctx, W, H, 'cream', t);
    heading(ctx, W, H, a, env);

    const it = (a.items || [])[0] || { label: '', notes: [] };
    const label = it.label || '';
    const size = Math.round(W * 0.095);
    const cx = W / 2;
    const cy = H * 0.47;

    const k = MK.enter(t, 0.5);
    const sp = spanOf(ctx, label, size, 0, Array.from(label).length);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    MK.highlight(ctx, -sp.total / 2 - 8, -size * 0.62, sp.total + 16, size * 0.78, { seed: 3, alpha: 0.66 });
    MK.text(ctx, label, -sp.total / 2, size * 0.28, { size, weight: 700, color: T.ink });
    ctx.restore();

    const notes = (it.notes || []).slice(0, 2);
    notes.forEach((note, i) => {
      const at = 0.9 + i * 0.55;
      if (t < at) return;
      const kk = ease((t - at) / 0.45);
      const left = i === 0;
      const nx = left ? W * 0.20 : W * 0.80;
      const ny = H * 0.68;
      const sx = cx + (left ? -sp.total / 2 - 12 : sp.total / 2 + 12);
      const sy = cy + size * 0.12;

      ctx.save();
      ctx.globalAlpha *= kk;
      MK.handLine(ctx, sx, sy, nx + (left ? 30 : -30), ny - 26, {
        color: rgba(T.ink, 0.7), width: 2.4, seed: 61 + i * 9, amp: 2.4,
      });
      ctx.beginPath();
      ctx.arc(nx + (left ? 30 : -30), ny - 26, 5, 0, Math.PI * 2);
      ctx.fillStyle = T.accent;
      ctx.fill();

      const nsize = Math.round(H * 0.032);
      MK.text(ctx, note, left ? nx + 30 : nx - 30, ny, {
        size: nsize, weight: 600, color: T.ink, align: 'center',
      });
      ctx.restore();
    });

    if (t >= 2.2) conclusion(ctx, W, H, a.conclusion, env, ease((t - 2.2) / 0.6));
  };

  /* ── 3. 便签修订：旧行划掉，新行贴上 ──────────────────── */

  L['sticky-revision'] = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    MK.paper(ctx, W, H, 'cream', t);
    heading(ctx, W, H, a, env);

    const items = (a.items || []).slice(0, 6);
    const rev = a.revision || {};
    const n = Math.max(1, items.length);
    const cols = n <= 2 ? n : 2;
    const cardW = W * 0.21;
    const cardH = H * 0.25;
    const gapX = W * 0.035;
    const gapY = H * 0.04;
    const gridW = cols * cardW + (cols - 1) * gapX;
    const x0 = (W - gridW) / 2;
    const y0 = H * 0.27;

    items.forEach((it, i) => {
      const at = 0.18 + i * 0.55;
      if (t < at) return;
      const k = MK.enter(t - at, 0.5);
      const col = i % cols, row = Math.floor(i / cols);
      const x = x0 + col * (cardW + gapX);
      const y = y0 + row * (cardH + gapY);
      const tilt = ((i % 3) - 1) * 0.022;
      const targeted = it.id === rev.targetId;

      ctx.save();
      ctx.translate(x + cardW / 2, y + cardH / 2);
      ctx.rotate(tilt);
      ctx.scale(k, k);
      ctx.translate(-(x + cardW / 2), -(y + cardH / 2));

      MK.sticky(ctx, x, y, cardW, cardH, {
        color: targeted ? T.stickyAlt : T.sticky,
        seed: 30 + i * 13,
      });

      const lsize = Math.round(cardH * 0.135);
      markedLabel(ctx, it.label || '', x + cardW * 0.1, y + cardH * 0.31, lsize, [0, 2], 50 + i);

      const nsize = Math.round(cardH * 0.082);
      (it.notes || []).slice(0, 2).forEach((note, j) => {
        const ny = y + cardH * (0.44 + j * 0.16);
        const struck = targeted && t >= 1.7;
        MK.text(ctx, note, x + cardW * 0.1, ny, {
          size: nsize, weight: 500, color: rgba(T.ink, struck ? 0.45 : 0.8),
        });
        if (struck) {
          const w = MK.measure(ctx, note, nsize, 500);
          MK.strike(ctx, x + cardW * 0.08, ny - nsize * 0.22, w + 6, 70 + i * 5 + j);
        }
      });

      ctx.restore();
    });

    // 修订：一张白便签从下方推入，盖住被改的那张
    if (rev.lines && rev.lines.length && t >= 2.3) {
      const idx = Math.max(0, items.findIndex((x) => x.id === rev.targetId));
      const col = idx % cols, row = Math.floor(idx / cols);
      // 白便签只盖下半张：上半留出原标签与被划掉的那行，否则「改了什么」看不见
      const bx = x0 + col * (cardW + gapX) + cardW * 0.11;
      const by = y0 + row * (cardH + gapY) + cardH * 0.6;
      const bw = cardW * 0.78, bh = cardH * 0.34;
      const kk = ease((t - 2.3) / 0.55);

      ctx.save();
      ctx.globalAlpha *= kk;
      ctx.translate(0, (1 - kk) * H * 0.04);
      ctx.shadowColor = 'rgba(43,42,38,0.22)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = T.white;
      ctx.fillRect(bx, by, bw, bh);
      ctx.restore();

      MK.handRect(ctx, bx, by, bw, bh, { seed: 88, width: 2.4, color: rgba(T.ink, 0.6) });
      const rsize = Math.round(bh * 0.24);
      rev.lines.slice(0, 2).forEach((ln, j) => {
        if (t < 2.45 + j * 0.22) return;
        MK.text(ctx, ln, bx + bw * 0.08, by + bh * (0.4 + j * 0.36), {
          size: rsize, weight: 700, color: T.red,
        });
      });
    }
  };

  /* ── 4. 回环：要点排成环，一条箭头收口 ────────────────── */

  L['return-loop'] = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    MK.paper(ctx, W, H, 'cream', t);
    heading(ctx, W, H, a, env);

    const items = (a.items || []).slice(0, 6);
    const rt = a.return || {};
    const n = Math.max(3, items.length);
    const cx = W / 2;
    const cy = H * 0.5;
    const rx = W * 0.26, ry = H * 0.19;
    const size = Math.round(H * 0.038);

    const pos = (i) => {
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
      return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
    };

    items.forEach((it, i) => {
      const at = 0.15 + i * 0.42;
      if (t < at) return;
      const k = MK.enter(t - at, 0.45);
      const p = pos(i);
      const r = Math.round(H * 0.062);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(k, k);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? T.stickyAlt : T.sticky;
      ctx.fill();
      ctx.strokeStyle = T.ink;
      ctx.lineWidth = 2.6;
      ctx.stroke();
      MK.icon(it.icon || 'concept', ctx, 0, -r * 0.3, r * 0.8, rgba(T.ink, 0.8));
      MK.text(ctx, it.label || '', 0, r * 0.78, { size: Math.round(size * 0.6), weight: 700, align: 'center' });
      ctx.restore();
    });

    if (rt.fromId && rt.toId && t >= 1.4) {
      const fi = items.findIndex((x) => x.id === rt.fromId);
      const ti = items.findIndex((x) => x.id === rt.toId);
      if (fi >= 0 && ti >= 0) {
        const p1 = pos(fi), p2 = pos(ti);
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        // 控制点必须沿「连线法线」偏移：若沿径向偏移，两点相对时(180°)控制点会落在圆心，
        // 曲线退化成一条穿过圆心的直线（真踩过）。
        const vx = p2.x - p1.x, vy = p2.y - p1.y;
        const vlen = Math.hypot(vx, vy) || 1;
        let nx = -vy / vlen, ny = vx / vlen;
        let bulge = Math.min(W, H) * 0.17;
        // 朝远离圆心的一侧弯
        if (Math.hypot(mx + nx * bulge - cx, my + ny * bulge - cy) <
            Math.hypot(mx - nx * bulge - cx, my - ny * bulge - cy)) {
          bulge = -bulge;
        }
        const ctrl = { x: mx + nx * bulge, y: my + ny * bulge };
        const kk = ease((t - 1.4) / 0.7);

        ctx.save();
        ctx.globalAlpha *= kk;
        ctx.strokeStyle = T.red;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, p2.x, p2.y);
        ctx.stroke();

        const te = 0.92;
        const bx = (1 - te) * (1 - te) * p1.x + 2 * (1 - te) * te * ctrl.x + te * te * p2.x;
        const by = (1 - te) * (1 - te) * p1.y + 2 * (1 - te) * te * ctrl.y + te * te * p2.y;
        const ang = Math.atan2(p2.y - by, p2.x - bx);
        for (const d of [0.45, -0.45]) {
          ctx.beginPath();
          ctx.moveTo(p2.x, p2.y);
          ctx.lineTo(p2.x - 20 * Math.cos(ang + d), p2.y - 20 * Math.sin(ang + d));
          ctx.stroke();
        }

        if (rt.label) {
          const lx = 0.25 * p1.x + 0.5 * ctrl.x + 0.25 * p2.x;
          const ly = 0.25 * p1.y + 0.5 * ctrl.y + 0.25 * p2.y;
          const lsize = Math.round(H * 0.028);
          const lw = MK.measure(ctx, rt.label, lsize, 700);
          MK.highlight(ctx, lx - lw / 2 - 8, ly - lsize * 0.85, lw + 16, lsize * 1.1, { seed: 9, alpha: 0.75 });
          MK.text(ctx, rt.label, lx, ly, { size: lsize, weight: 700, color: T.ink, align: 'center' });
        }
        ctx.restore();
      }
    }

    if (t >= 2.2) conclusion(ctx, W, H, a.conclusion, env, ease((t - 2.2) / 0.6));
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.L = L;
})(typeof window !== 'undefined' ? window : this);
