// layouts.js · 版式层
//
// 一个版式 = 一个函数：(ctx, W, H, t, dur, args, env, frame) => void
//   t      段内时间（秒，从 0 起）
//   dur    本段时长
//   args   本段参数，来自 preset.segments[].args
//   env    { T: 完整调色板+theme 覆盖, palette: 原始 theme }
//
// 硬约束（与 kit.js 同）：纯 Canvas2D，不碰 document / window。
// 文案零硬编码：所有文字来自 args。
//
// 新增版式的顺序：先定 capacity（能装多少字）→ 再写绘制 → 最后登记到 guide.layouts。

(function (root) {
  'use strict';

  const MK = root.MK;
  const L = {};

  // 封面：标题 + 副题，左侧竖条强调
  L.cover = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    MK.paper(ctx, W, H, 'cream', t);

    const k = MK.enter(t, 0.55);
    ctx.save();
    ctx.translate(W * 0.5, H * 0.5);
    ctx.scale(k, k);
    ctx.translate(-W * 0.5, -H * 0.5);

    MK.rect(ctx, 96, H * 0.36, 12, 132, T.accent);
    MK.text(ctx, a.title || '', 140, H * 0.44, { size: 92, color: T.ink });
    MK.text(ctx, a.sub || '', 142, H * 0.52, { size: 40, color: T.muted, weight: 500 });

    ctx.restore();
  };

  // 讲解位：标题条 + 一个要点
  L.explain = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    MK.paper(ctx, W, H, 'cream', t);

    // 标题条从左侧滑入
    const p = MK.u.ease(t / 0.5);
    const barW = 720 * (0.7 + 0.3 * p);
    MK.rect(ctx, 0, 0, barW, 132, T.accent);

    ctx.save();
    ctx.globalAlpha *= MK.u.clamp(t / 0.3, 0, 1);
    MK.text(ctx, a.title || '', 96, 92, { size: 56, color: T.white });
    ctx.restore();

    // 要点：硬切段首就已推进 20–30%，避免切点出现空帧
    const k = Math.max(0.86, MK.u.ease((t + 0.16) / 0.5));
    ctx.save();
    ctx.translate(96, H * 0.46);
    ctx.scale(k, k);
    MK.text(ctx, a.point || '', 0, 0, { size: 72, color: T.ink });
    ctx.restore();
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.L = L;
})(typeof window !== 'undefined' ? window : this);
