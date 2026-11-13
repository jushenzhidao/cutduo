// layouts.js · 版式层（night-card）
//
// 一个版式 = 一个函数：(ctx, W, H, t, dur, args, env) => void
//   t    段内时间（秒）
//   dur  本段时长
//   args 段参数（来自 preset.segments）
//   env  { T: 完整调色板 + theme 覆盖, palette }
//
// 硬约束：纯 Canvas2D；所有文字来自 args，不写文案字面量。
//
// 这套版式的共同规律：一屏只有一个焦点。任何需要「两个以上视觉重心」的内容，
// 应该拆成两段，而不是把版式塞满。

(function (root) {
  'use strict';

  const MK = root.MK;
  const L = {};

  const SAFE = 96;            // 左右安全边距
  const QUOTE = String.fromCharCode(8220);

  function usable(W) { return W - SAFE * 2; }

  // 统一的开场：底色 + 推近。返回后由调用方 restore。
  function open(ctx, W, H, t, dur, env, amp) {
    MK.ground(ctx, W, H, env);
    ctx.save();
    MK.ken(ctx, W, H, t, dur, amp);
  }

  // 统一收尾：晕影与颗粒固定在屏幕坐标，不随推近移动。
  function close(ctx, W, H) {
    MK.vignette(ctx, W, H, 0.5);
    MK.grain(ctx, W, H, 0.042);
  }

  // 封面：小标签 + 主标题 + 展开的金线 + 副标
  L.cover = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    open(ctx, W, H, t, dur, env, 0.028);

    const cx = W / 2;
    const WU = usable(W);

    if (a.kicker) {
      const kp = MK.u.ease(t / 0.5);
      MK.tracked(ctx, a.kicker, cx, H * 0.255, {
        size: Math.round(H * 0.0146),
        tracking: 9,
        align: 'center',
        color: T.accent,
        alpha: kp,
      });
    }

    const ft = MK.fitText(ctx, a.title, WU, {
      maxSize: Math.round(H * 0.0667),   // 128 @1080x1920
      minSize: Math.round(H * 0.0438),   // 84
      maxLines: 3,
      lineHeight: 1.38,
      weight: 700,
    });
    const blockH = ft.lines.length * ft.lineHeight;
    const top = H * 0.48 - blockH / 2;

    MK.reveal(ctx, ft.lines, cx, top + ft.size * 0.78, ft.size, ft.lineHeight, {
      align: 'center',
      color: T.ink,
      weight: 700,
    }, MK.u.clamp(t / 1.15, 0, 1));

    // 金线：从 0 展开到 76，作为全片唯一的「节奏记号」
    const lp = MK.u.ease((t - 0.35) / 0.8);
    MK.rule(ctx, cx - 38 * lp, top + blockH + H * 0.035, 76 * lp, T.accent, 2);

    if (a.sub) {
      const sp = MK.u.ease((t - 0.5) / 0.7);
      MK.text(ctx, a.sub, cx, top + blockH + H * 0.105, {
        size: Math.round(H * 0.0208),    // 40
        align: 'center',
        color: T.muted,
        weight: 500,
        alpha: sp,
      });
    }

    ctx.restore();
    close(ctx, W, H);
  };

  // 单句宣言：整屏只有一句，字随行数降档
  L.statement = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    open(ctx, W, H, t, dur, env, 0.02);

    const cx = W / 2;
    const WU = usable(W);
    const maxSize = Math.round(H * (a.size === undefined ? 0.0542 : Number(a.size)));  // 104

    const ft = MK.fitText(ctx, a.text, WU, {
      maxSize,
      minSize: Math.round(H * 0.0333),   // 64
      maxLines: 4,
      lineHeight: 1.58,
      weight: 700,
    });
    const blockH = ft.lines.length * ft.lineHeight;
    const top = H * 0.455 - blockH / 2;

    if (a.mark) {
      const mp = MK.u.ease(t / 0.5);
      MK.dot(ctx, cx, top - H * 0.048, 4 * mp, T.accent);
    }

    MK.reveal(ctx, ft.lines, cx, top + ft.size * 0.78, ft.size, ft.lineHeight, {
      align: 'center',
      color: T.ink,
      weight: 700,
    }, MK.u.clamp(t / 1.5, 0, 1));

    if (a.note) {
      const np = MK.u.ease((t - 0.6) / 0.9);
      MK.text(ctx, a.note, cx, top + blockH + H * 0.052, {
        size: Math.round(H * 0.0177),    // 34
        align: 'center',
        color: T.muted,
        weight: 500,
        alpha: np,
      });
    }

    ctx.restore();
    close(ctx, W, H);
  };

  // 引言：图形引号 + 引文 + 出处，不使用任何人物素材
  L.quote = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    open(ctx, W, H, t, dur, env, 0.018);

    const cx = W / 2;
    const WU = usable(W) - 40;

    const qp = MK.u.ease(t / 0.6);
    ctx.save();
    ctx.globalAlpha *= 0.26 * qp;
    MK.text(ctx, QUOTE, SAFE, H * 0.245, {
      size: Math.round(H * 0.115),       // 220
      color: T.accent,
      weight: 700,
    });
    ctx.restore();

    const ft = MK.fitText(ctx, a.text, WU, {
      maxSize: Math.round(H * 0.0438),   // 84
      minSize: Math.round(H * 0.0313),   // 60
      maxLines: 5,
      lineHeight: 1.62,
      weight: 700,
    });
    const top = H * 0.375;

    MK.reveal(ctx, ft.lines, cx, top + ft.size * 0.78, ft.size, ft.lineHeight, {
      align: 'center',
      color: T.ink,
      weight: 700,
    }, MK.u.clamp((t - 0.25) / 1.6, 0, 1));

    if (a.from) {
      const fp = MK.u.ease((t - 0.9) / 0.8);
      const y = H * 0.795;
      MK.rule(ctx, cx - 22, y - H * 0.028, 44 * fp, T.accentSoft, 1);
      MK.tracked(ctx, a.from, cx, y, {
        size: Math.round(H * 0.0156),    // 30
        tracking: 3,
        align: 'center',
        color: T.muted,
        alpha: fp,
      });
    }

    ctx.restore();
    close(ctx, W, H);
  };

  // 对照：上一句压暗、下一句点亮，中间一条线分开
  L.contrast = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    open(ctx, W, H, t, dur, env, 0.022);

    const cx = W / 2;
    const WU = usable(W);

    const p1 = MK.u.ease((t + 0.16) / 0.65);
    ctx.save();
    ctx.translate(0, -14 * (1 - p1));
    MK.text(ctx, a.before || '', cx, H * 0.345, {
      size: Math.round(H * 0.0271),      // 52
      align: 'center',
      color: T.muted,
      weight: 500,
      alpha: 0.55 * p1,
    });
    ctx.restore();

    // 分隔线从中心向两侧展开
    const lp = MK.u.ease((t - 0.25) / 0.7);
    MK.rule(ctx, cx - (WU / 2) * lp, H * 0.462, WU * lp, T.dim, 1);

    const ft = MK.fitText(ctx, a.after, WU, {
      maxSize: Math.round(H * 0.0438),   // 84
      minSize: Math.round(H * 0.0313),   // 60
      maxLines: 3,
      lineHeight: 1.5,
      weight: 700,
    });
    const p2 = MK.u.ease((t + 0.18) / 0.8);
    ctx.save();
    ctx.translate(0, 18 * (1 - p2));
    MK.reveal(ctx, ft.lines, cx, H * 0.545 + ft.size * 0.78, ft.size, ft.lineHeight, {
      align: 'center',
      color: T.ink,
      weight: 700,
      alpha: p2,
    }, MK.u.clamp((t + 0.18) / 1.02, 0, 1));
    ctx.restore();

    ctx.restore();
    close(ctx, W, H);
  };

  // 数字：一个数撑满画面，说明文字退到次要层
  L.number = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    open(ctx, W, H, t, dur, env, 0.025);

    const cx = W / 2;
    const WU = usable(W);

    const ft = MK.fitText(ctx, String(a.value === undefined ? '' : a.value), WU, {
      maxSize: Math.round(H * 0.177),    // 340
      minSize: Math.round(H * 0.0938),   // 180
      maxLines: 1,
      lineHeight: 1.1,
      weight: 700,
    });

    const y = H * 0.46;
    MK.rule(ctx, cx - 34, y - ft.size * 0.86, 68 * MK.u.ease(t / 0.5), T.accent, 2);

    MK.reveal(ctx, ft.lines, cx, y, ft.size, ft.lineHeight, {
      align: 'center',
      color: T.accent,
      weight: 700,
    }, MK.u.clamp(t / 0.9, 0, 1));

    if (a.label) {
      const p = MK.u.ease((t - 0.45) / 0.7);
      MK.text(ctx, a.label, cx, H * 0.565, {
        size: Math.round(H * 0.0229),    // 44
        align: 'center',
        color: T.ink,
        weight: 700,
        alpha: p,
      });
    }

    if (a.note) {
      const p = MK.u.ease((t - 0.65) / 0.8);
      MK.text(ctx, a.note, cx, H * 0.625, {
        size: Math.round(H * 0.0167),    // 32
        align: 'center',
        color: T.muted,
        weight: 500,
        alpha: p,
      });
    }

    ctx.restore();
    close(ctx, W, H);
  };

  // 收尾：短横线 + 一句落款，画面元素最少
  L.outro = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    open(ctx, W, H, t, dur, env, 0.012);

    const cx = W / 2;
    const p = MK.u.ease((t + 0.18) / 0.8);

    ctx.save();
    ctx.globalAlpha *= p;
    MK.rule(ctx, cx - 20, H * 0.395, 40, T.accentSoft, 1);
    MK.text(ctx, a.title || '', cx, H * 0.475, {
      size: Math.round(H * 0.0333),      // 64
      align: 'center',
      color: T.ink,
      weight: 700,
    });
    if (a.sub) {
      MK.text(ctx, a.sub, cx, H * 0.532, {
        size: Math.round(H * 0.0188),    // 36
        align: 'center',
        color: T.muted,
        weight: 500,
      });
    }
    if (a.brand) {
      MK.tracked(ctx, a.brand, cx, H * 0.80, {
        size: Math.round(H * 0.0135),    // 26
        tracking: 6,
        align: 'center',
        color: T.muted,
      });
    }
    ctx.restore();

    ctx.restore();
    close(ctx, W, H);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.L = L;
})(typeof window !== 'undefined' ? window : this);
