/* layouts.js — 科普片八个版式
 * 全部是 (t, args) 的纯函数：同一 t 必得同一画面，不依赖上一帧。
 * env = { T, theme }
 */
(function () {
  'use strict';
  const MK = window.MK;
  const L = (window.L = window.L || {});
  const { clamp, lerp, ease, easeInOut, pop, rgba, hash } = MK.u;

  // 姿态图：由 index.html 的 <img data-fig> 提供，渲染器会把它们内联成 dataURL
  const FIGS = (window.__MK_FIGS = window.__MK_FIGS || {});
  function collectFigures() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('img[data-fig]').forEach((el) => { FIGS[el.dataset.fig] = el; });
  }
  collectFigures();

  // 手势名 → 姿态图名
  const POSE_OF = { idle: 'idle', explain: 'explain', open: 'open', point: 'point', count: 'explain', nod: 'idle' };

  /* ------------------------------ 通用小部件 ------------------------------ */
  // 带下限的入场：容器类元素从 from 收到 1，保证硬切首帧已是近完整画面
  function enter(v, from) {
    const f = from === undefined ? 0.86 : from;
    return clamp(f + (1 - f) * pop(v), 0, 1.14);
  }

  // 逐行入场：返回 [{k, dy}] 用于绘制
  function linesIn(t, start, gap, dur, n) {
    return Array.from({ length: n }, (_, i) => {
      const k = ease((t - start - i * gap) / dur);
      return { k, dy: (1 - k) * 46, dx: (1 - k) * -34 };
    });
  }

  // 全屏柔和 vignette，收边让画面更"成片"
  function vignette(ctx, W, H, a) {
    const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.36, W / 2, H / 2, W * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(20,40,44,${a === undefined ? 0.10 : a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // 抽象医院走廊（封面用）：天花 / 地面透视 / 两侧门框 / 灯带，分层清晰不画斜切墙
  function hallway(ctx, W, H, t, tint) {
    const hz = H * 0.34;              // 地平线
    ctx.save();
    // 底色
    let g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, '#FDFFFE'); g.addColorStop(1, '#EAF5F1');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz);
    // 地面（透视梯形）
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(W, H);
    ctx.lineTo(W * 0.72, hz); ctx.lineTo(W * 0.28, hz);
    ctx.closePath();
    g = ctx.createLinearGradient(0, hz, 0, H);
    g.addColorStop(0, '#E4F1EC'); g.addColorStop(1, '#CBE3DB');
    ctx.fillStyle = g; ctx.fill();
    // 地面上方两侧（墙面），用整块填充避免斜切边
    g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#F3FAF7'); g.addColorStop(0.28, '#FBFEFC');
    g.addColorStop(0.72, '#FBFEFC'); g.addColorStop(1, '#F3FAF7');
    ctx.fillStyle = g;
    // 左右墙面 = 三角形，与地面梯形的斜边严丝合缝（原先用矩形会盖住地面，形成垂直硬边）
    ctx.beginPath(); ctx.moveTo(0, hz); ctx.lineTo(W * 0.28, hz); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(W, hz); ctx.lineTo(W * 0.72, hz); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    // 尽头门洞
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(W * 0.40, hz - H * 0.05, W * 0.20, H * 0.20);
    ctx.fillStyle = 'rgba(176,212,226,0.45)';
    ctx.fillRect(W * 0.415, hz - H * 0.035, W * 0.17, H * 0.17);
    // 两侧门（近处）
    [0.02, 0.80].forEach((x0, i) => {
      const dw = W * 0.16;
      ctx.fillStyle = i ? '#F7D3B8' : '#F7D3B8';
      ctx.globalAlpha = 0.55;
      MK.rrect(ctx, W * x0, hz - H * 0.02, dw, H * 0.34, 10); ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 6;
      MK.rrect(ctx, W * x0, hz - H * 0.02, dw, H * 0.34, 10); ctx.stroke();
      ctx.globalAlpha = 1;
    });
    // 踢脚线
    ctx.strokeStyle = 'rgba(150,195,185,0.55)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, hz + H * 0.30); ctx.lineTo(W * 0.28, hz); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W, hz + H * 0.30); ctx.lineTo(W * 0.72, hz); ctx.stroke();
    // 天花板灯带
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.55 - i * 0.13;
      ctx.fillStyle = '#FFFFFF';
      const ly = H * (0.07 + i * 0.075), lw = W * (0.26 - i * 0.06), lh = H * (0.018 - i * 0.003);
      ctx.fillRect(W / 2 - lw / 2, ly, lw, lh);
    }
    ctx.globalAlpha = 1;
    // 柔光
    g = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.55);
    g.addColorStop(0, 'rgba(255,255,255,0.62)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (tint) { ctx.fillStyle = rgba(tint, 0.10); ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }

  // 抽象柔光底纹：大色块 + 点阵，替代透视场景，任何画幅都成立
  function softBackdrop(ctx, W, H, t, tint) {
    const T = MK.T;
    ctx.save();
    ctx.fillStyle = '#FDFBF1'; ctx.fillRect(0, 0, W, H);
    const blobs = [
      { x: 0.80, y: 0.16, r: 0.40, c: tint || T.sun, a: 0.30 },
      { x: 0.12, y: 0.88, r: 0.46, c: T.jade, a: 0.16 },
      { x: 0.46, y: 0.52, r: 0.52, c: T.sky, a: 0.30 },
    ];
    blobs.forEach((b) => {
      const g = ctx.createRadialGradient(W * b.x, H * b.y, 0, W * b.x, H * b.y, W * b.r);
      g.addColorStop(0, rgba(b.c, b.a));
      g.addColorStop(0.55, rgba(b.c, b.a * 0.42));
      g.addColorStop(1, rgba(b.c, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    });
    // 点阵
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 44; i++) {
      const x = (hash(i) * 1.04 - 0.02) * W;
      const y = (hash(i + 71) * 1.04 - 0.02) * H;
      const r = 2 + hash(i + 13) * 4;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // 底部柔带，托住字幕
    const gb = ctx.createLinearGradient(0, H * 0.72, 0, H);
    gb.addColorStop(0, 'rgba(255,255,255,0)');
    gb.addColorStop(1, 'rgba(255,255,255,0.55)');
    ctx.fillStyle = gb; ctx.fillRect(0, H * 0.72, W, H * 0.28);
    ctx.restore();
  }

  // 人物位：有 figureImage 用图；否则用会动的分层人物（呼吸/眨眼/口型/手势/点头）
  // talking 由 tools/vo.py 按配音写入：[[段内起, 段内止], ...]，人在说话时嘴才动
  function mouthAt(t, spans) {
    if (!spans || !spans.length) return 0.10 + Math.sin(t * 2.7) * 0.05;
    for (const [s0, s1] of spans) {
      if (t >= s0 - 0.05 && t <= s1 + 0.05) {
        // 语速感：11Hz 开合 + 二次谐波，避免机械匀速
        const v = Math.abs(Math.sin(t * 11.3)) * 0.72 + Math.abs(Math.sin(t * 5.1)) * 0.28;
        return 0.10 + v * 0.85;
      }
    }
    return 0.06;
  }

  // 手势曲线：抬起 → 保持 → 回落（段尾自然收回，不会切在抬手中间）
  function gestureK(t, dur, at) {
    const up = ease((t - at) / 0.5);
    const down = ease((dur - t) / 0.7);
    return clamp(up * down, 0, 1);
  }

  function figureSlot(ctx, W, H, a, t, dur) {
    const T = MK.T;
    const side = a.figure === 'left' ? 'left' : 'right';
    const img = a.figureImage && window.__MK_IMAGES && window.__MK_IMAGES[a.figureImage];
    const cx = (side === 'left' ? 0.245 : 0.755) * W;
    const enter = ease((t - 0.05) / 0.55);
    ctx.save();
    ctx.globalAlpha *= enter;
    ctx.translate((1 - enter) * (side === 'left' ? -70 : 70), 0);
    if (img && img.complete && img.naturalWidth) {
      const sc = Math.min((W * 0.46) / img.naturalWidth, (H * 0.94) / img.naturalHeight);
      const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
      ctx.drawImage(img, cx - w / 2, H - h + (1 - enter) * 30, w, h);
      ctx.restore();
      return;
    }
    const g = a.gesture || 'idle';
    const k = gestureK(t, dur === undefined ? 6 : dur, a.gestureAt === undefined ? 0.9 : a.gestureAt);

    // 有真实姿态图时：idle 与动作图按 k 混合，叠加呼吸/说话起伏
    const imgs = a.figures === false ? null : FIGS;
    if (imgs && imgs.idle && imgs.idle.complete && imgs.idle.naturalWidth) {
      const poseName = POSE_OF[g] || 'idle';
      const pose = (poseName !== 'idle' && imgs[poseName] && imgs[poseName].complete) ? imgs[poseName] : null;
      const mix = pose ? ease(clamp((k - 0.30) / 0.34, 0, 1)) : 0;
      const mouth = mouthAt(t, a.talking);
      const bob = Math.sin(t * 1.15) * 5 + (mouth - 0.1) * 7;
      const tilt = Math.sin(t * 0.62) * 0.006 + (a.gesture === 'nod' ? Math.sin(t * 3.0) * 0.012 * k : 0);
      const HH = H * (a.figureHeight || 0.99);
      const draw = (img, alpha) => {
        if (!img || alpha <= 0.004) return;
        const sc = HH / img.naturalHeight;
        const w = img.naturalWidth * sc;
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.translate(cx, H + bob);
        ctx.rotate(tilt);
        ctx.drawImage(img, -w / 2, -HH, w, HH);
        ctx.restore();
      };
      draw(imgs.idle, 1 - mix);
      draw(pose, mix);
      ctx.restore();
      return;
    }
    let armL = 0, armR = 0, nod = 0;
    if (g === 'explain') { armL = k * 0.92; }
    else if (g === 'open') { armL = k * 0.66; armR = k * 0.66; }
    else if (g === 'point') { armR = k * 1.0; }
    else if (g === 'count') { armL = k * 0.86; nod = Math.sin(t * 3.4) * 0.55 * k; }
    else if (g === 'nod') { nod = Math.sin(t * 3.0) * 0.9 * k; }
    MK.figure(ctx, {
      cx, baseY: H * 0.965, scale: (a.figureScale || 1) * 0.93,
      t, hair: a.hair, skin: a.skin, coat: a.coat,
      mouth: mouthAt(t, a.talking),
      armL, armR, nod,
      look: side === 'left' ? 0.35 : -0.35,
      blinkSeed: a.blinkSeed || 1.3,
    });
    ctx.restore();
  }

  /* --------------------------------- 1 封面 -------------------------------- */
  L.cover = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    if (a.scene === 'hallway') hallway(ctx, W, H, t, a.tint);
    else softBackdrop(ctx, W, H, t, a.tint);

    // 半透明白色横条（参考片封面条）
    const barK = ease((t + 0.24) / 0.55);
    ctx.save();
    ctx.globalAlpha = 0.62 * barK;
    const barY = H * 0.265, barH = H * 0.215;
    const w = lerp(W * 0.2, W * 1.06, barK);
    MK.rrect(ctx, W / 2 - w / 2, barY, w, barH, 26);
    ctx.fillStyle = T.white; ctx.fill();
    ctx.restore();

    // 前缀词
    const k1 = ease((t + 0.12) / 0.45);
    if (k1 > 0) {
      const pSize = a.prefixSize || 116;
      ctx.save();
      ctx.globalAlpha *= k1;
      // 投影层：先画偏移的深蓝描边，让白字在浅底上立起来
      ctx.save();
      ctx.translate(9, 11);
      MK.text(ctx, a.prefix || '', W * 0.135, H * 0.405, {
        size: pSize, weight: 700, color: rgba(T.blue, 0.55),
        stroke: 22, strokeColor: rgba(T.blue, 0.55), maxW: W * 0.44, noHeavy: true,
      });
      ctx.restore();
      MK.text(ctx, a.prefix || '', W * 0.135, H * 0.405, {
        size: pSize, weight: 700, color: T.white,
        stroke: 22, strokeColor: T.blue, maxW: W * 0.44,
      });
      ctx.restore();
    }

    // 爆炸贴 + 主词
    const kb = pop((t + 0.14) / 0.52);
    if (kb > 0) {
      ctx.save();
      ctx.translate(W * 0.632, H * 0.372);
      ctx.rotate(-3.2 * Math.PI / 180);
      ctx.scale(kb, kb);
      MK.burst(ctx, 0, 0, a.burstR || 384, { fill: a.burstFill || T.pop, edge: a.burstEdge || T.popDeep, spikes: 18, jitter: 0.14 });
      MK.text(ctx, a.title || '', 0, 46, {
        size: a.titleSize || 148, weight: 700, color: a.titleFill || T.white,
        align: 'center', stroke: 24, strokeColor: a.titleStroke || T.popDeep,
        maxW: (a.burstR || 384) * 1.40, spacing: -2,
      });
      ctx.restore();
    }

    // 贴纸（眼睛 / 星星）
    if (a.sticker) {
      const ks = pop((t - 0.58) / 0.5);
      ctx.save();
      ctx.translate(W * 0.885, H * 0.155);
      ctx.rotate(10 * Math.PI / 180 + Math.sin(t * 2.2) * 0.03);
      ctx.scale(ks, ks);
      MK.icon(a.sticker, ctx, 0, 0, 112, {});
      ctx.restore();
    }

    // 副标（tagSun 以左上为原点，按实测宽度居中）
    const k2 = pop((t - 0.66) / 0.5);
    if (k2 > 0 && a.sub) {
      const subSize = a.subSize || 54;
      const sw = MK.measure(ctx, a.sub, subSize, 700) + subSize * 1.1;
      ctx.save();
      ctx.translate(W / 2, H * 0.60);
      ctx.scale(k2, k2);
      ctx.translate(-sw / 2, 0);
      MK.tagSun(ctx, a.sub, 0, 0, subSize, {});
      ctx.restore();
    }

    // 底部提示
    if (a.hint) {
      const k3 = ease((t - 1.7) / 0.6);
      MK.text(ctx, a.hint, W / 2, H * 0.90, {
        size: 34, weight: 500, color: rgba(T.ink, 0.55), align: 'center', font: 'sans', alpha: k3,
      });
    }
    vignette(ctx, W, H, 0.06);
    ctx.restore();
  };

  /* -------------------------------- 2 讲解位 -------------------------------- */
  L.talk = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    MK.paper(ctx, W, H, a.paper || 'cream', t);
    figureSlot(ctx, W, H, a, t, dur);

    const left = a.figure === 'left';
    const bx = left ? W * 0.47 : W * 0.105;
    const bw = W * 0.40;

    // 眉毛标
    if (a.eyebrow) {
      const ke = ease((t + 0.08) / 0.4);
      ctx.save(); ctx.globalAlpha *= ke;
      ctx.fillStyle = T.jade;
      MK.rrect(ctx, bx, H * 0.30 - 4, 12, 40, 6); ctx.fill();
      MK.text(ctx, a.eyebrow, bx + 28, H * 0.30 + 34, { size: 32, weight: 500, color: T.jadeDeep, font: 'sans' });
      ctx.restore();
    }

    // 主句
    const lines = a.lines || [];
    const lk = linesIn(t, -0.08, 0.26, 0.42, lines.length);
    lines.forEach((ln, i) => {
      const { k, dx } = lk[i];
      if (k <= 0) return;
      const y = H * 0.42 + i * 132;
      ctx.save(); ctx.globalAlpha *= k; ctx.translate(dx, 0);
      MK.text(ctx, ln, bx, y, {
        size: a.size || 86, weight: 700, color: i === (a.accentLine === undefined ? 0 : a.accentLine) ? T.pop : T.ink,
        maxW: bw, spacing: -1,
      });
      ctx.restore();
      const kw = MK.measure(ctx, ln, a.size || 86, 700);
      if (i === (a.accentLine === undefined ? 0 : a.accentLine)) {
        MK.marker(ctx, bx + 4, y + 32, bx + Math.min(kw, bw) - 6, y + 32, T.sun, 34);
        // 重描字压住划痕
        ctx.save(); ctx.globalAlpha *= k; ctx.translate(dx, 0);
        MK.text(ctx, ln, bx, y, { size: a.size || 86, weight: 700, color: T.pop, maxW: bw, spacing: -1 });
        ctx.restore();
      }
    });

    // 贴纸
    if (a.sticker) {
      const ks = pop((t - 0.5) / 0.42);
      ctx.save();
      ctx.translate(bx + Math.min(bw, W * 0.30) * 0.5, H * 0.735);
      ctx.rotate((a.stickerRot || -8) * Math.PI / 180);
      ctx.scale(ks, ks);
      MK.icon(a.sticker, ctx, 0, 0, a.stickerSize || 190, {});
      ctx.restore();
    }

    // 段内标签
    if (a.label && a.label.text) {
      const kl = pop((t - (a.label.at || 0.6)) / 0.45);
      ctx.save(); ctx.globalAlpha *= clamp(kl, 0, 1);
      const px = (a.label.x === undefined ? 0.30 : a.label.x) * W;
      const py = (a.label.y === undefined ? 0.72 : a.label.y) * H;
      ctx.translate(px, py);
      ctx.scale(clamp(kl, 0.2, 1.2), clamp(kl, 0.2, 1.2));
      MK.tagSun(ctx, a.label.text, 0, 0, a.label.size || 46, { fill: a.label.fill || T.sun });
      ctx.restore();
    }
    vignette(ctx, W, H, 0.05);
    ctx.restore();
  };

  /* ------------------------------- 3 圆框图解 ------------------------------- */
  L.diagram = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    MK.paper(ctx, W, H, a.paper || 'mint', t);

    const cx = (a.cx === undefined ? 0.48 : a.cx) * W;
    const cy = (a.cy === undefined ? 0.505 : a.cy) * H;
    const R = a.r || 352;

    // 圆环入场
    const kr = enter((t + 0.06) / 0.5, 0.90);
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(kr, kr); ctx.translate(-cx, -cy);
    // 外光晕
    const g = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.3);
    g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.3, 0, Math.PI * 2); ctx.fill();
    MK.ringCard(ctx, cx, cy, R, {
      fill: a.discFill || 'rgba(255,255,255,0.92)', ring: 'rgba(255,255,255,0.98)',
      spin: t * 0.12, dashColor: 'rgba(255,255,255,0.95)', innerRatio: 0.93, shadow: false,
    });
    ctx.restore();

    // 器官
    const ko = enter((t + 0.04) / 0.55, 0.92);
    if (ko > 0) {
      const sz = (a.organSize || R * 1.62);
      ctx.save();
      ctx.globalAlpha *= ko;
      ctx.translate(cx, cy + (1 - ko) * 30);
      const sc = 0.92 + ko * 0.08;
      ctx.scale(sc, sc);
      // 已平移到圆心，图标必须以 (0,0) 为锚点绘制，否则会二次偏移到画面外
      const mark = a.mark;
      if (mark && a.pulse) {
        const ph = (Math.sin(t * 5.2) + 1) / 2;
        ctx.save();
        ctx.globalAlpha *= 0.35 + ph * 0.5;
        ctx.beginPath();
        ctx.arc((mark[0] - 0.5) * sz, (mark[1] - 0.5) * sz, 44 + ph * 16, 0, Math.PI * 2);
        ctx.fillStyle = rgba(T.pop, 0.35); ctx.fill();
        ctx.restore();
      }
      MK.icon(a.organ || 'gut', ctx, 0, 0, sz, { eyes: a.eyes !== false, mark: mark && [mark[0], mark[1]] });
      ctx.restore();
    }

    // 探头 + 声波
    if (a.probe && a.probe !== 'none') {
      const dir = a.probe === 'right' ? 1 : -1;
      const kp = ease((t + 0.02) / 0.5);
      const px = cx + dir * (R + 210) + (1 - kp) * dir * 90;
      const py = cy + (a.probeY === undefined ? 60 : a.probeY);
      ctx.save();
      ctx.globalAlpha *= kp;
      const psz = a.probeSize || 300;
      ctx.translate(px, py);
      ctx.rotate(dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      MK.icon('probe', ctx, 0, 0, psz, {});
      ctx.restore();
      if (kp > 0.4) {
        // 声波从探头端面外侧发出，不能被探头本体盖住
        ctx.save();
        ctx.translate(px - dir * psz * 0.42, py);
        ctx.rotate(dir > 0 ? Math.PI : 0);
        MK.soundWave(ctx, 0, 0, 1, t, a.waveColor || '#39B7E8');
        ctx.restore();
      }
    }

    // 标注
    (a.callouts || []).forEach((c, i) => {
      const kc = pop((t - (c.at || 0.55) - i * 0.26) / 0.42);
      if (kc <= 0) return;
      const x = (c.x === undefined ? 0.72 : c.x) * W;
      const y = (c.y === undefined ? 0.50 : c.y) * H;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((c.rot || 0) * Math.PI / 180);
      ctx.scale(kc, kc);
      // 引线（lead 用画布归一化坐标指向病灶）
      if (c.lead) {
        const tw = MK.measure(ctx, c.text, c.size || 74, 700);
        const tx = c.lead[0] * W - x, ty = c.lead[1] * H - y;
        ctx.beginPath();
        ctx.moveTo(-tw / 2 - 4, 6);
        ctx.quadraticCurveTo(-tw / 2 - 70, ty * 0.55, tx, ty);
        ctx.lineWidth = 5; ctx.strokeStyle = rgba(T.pop, 0.7); ctx.setLineDash([13, 11]); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(tx, ty, 11, 0, Math.PI * 2); ctx.fillStyle = T.pop; ctx.fill();
      }
      MK.handText(ctx, c.text, 0, 0, c.size || 74, { color: c.color || T.pop });
      if (c.underline !== false) MK.marker(ctx, -MK.measure(ctx, c.text, c.size || 74, 700) / 2, 26, MK.measure(ctx, c.text, c.size || 74, 700) / 2, 26, c.markColor || '#5FE0B0', 30);
      ctx.restore();
    });

    // 顶部标题条
    if (a.title) {
      const kt = pop((t + 0.02) / 0.45);
      ctx.save(); ctx.globalAlpha *= clamp(kt, 0, 1);
      MK.bannerJade(ctx, a.title, W / 2, H * 0.115, a.titleSize || 58, { scale: 0.86 + 0.14 * clamp(kt, 0, 1) });
      ctx.restore();
    }
    vignette(ctx, W, H, 0.05);
    ctx.restore();
  };

  /* -------------------------------- 4 对比页 -------------------------------- */
  L.compare = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    MK.paper(ctx, W, H, a.paper || 'sky', t);

    if (a.title) {
      const kt = pop((t + 0.02) / 0.4);
      ctx.save(); ctx.globalAlpha *= clamp(kt, 0, 1);
      MK.bannerJade(ctx, a.title, W / 2, H * 0.105, 54, { scale: 0.86 + 0.14 * clamp(kt, 0, 1) });
      ctx.restore();
    }

    const cardY = H * 0.245, cardH = H * 0.465;
    const cw = W * 0.275;
    const sides = [
      { d: a.left || {}, x: W * 0.095, at: -0.04, dir: -1 },
      { d: a.right || {}, x: W * 0.63, at: 0.18, dir: 1 },
    ];
    sides.forEach(({ d, x, at, dir }) => {
      const k = enter((t - at) / 0.5, 0.90);
      if (k <= 0) return;
      ctx.save();
      ctx.globalAlpha *= clamp(k, 0, 1);
      ctx.translate(x + (1 - clamp(k, 0, 1)) * dir * 70, 0);
      // 卡片
      ctx.save();
      ctx.shadowColor = 'rgba(22,60,54,0.14)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 12;
      MK.rrect(ctx, 0, cardY, cw, cardH, 42);
      ctx.fillStyle = d.cardFill || 'rgba(255,255,255,0.94)'; ctx.fill();
      ctx.restore();
      // 图标区
      const ir = cw * 0.28;
      MK.ringCard(ctx, cw / 2, cardY + cardH * 0.36, ir, {
        fill: d.disc || (d.bad ? 'rgba(255,255,255,0.92)' : '#FFE770'),
        ring: 'rgba(255,255,255,0.98)', spin: t * 0.1, shadow: false, innerRatio: 0.9,
        dashColor: d.bad ? 'rgba(180,200,205,0.8)' : 'rgba(255,255,255,0.9)',
      });
      MK.icon(d.icon || 'scanner', ctx, cw / 2, cardY + cardH * 0.36, ir * 1.92, {});
      // 标题
      MK.text(ctx, d.label || '', cw / 2, cardY + cardH * 0.72, {
        size: 62, weight: 700, color: d.bad ? '#6C7B80' : T.jadeDeep, align: 'center', maxW: cw * 0.86,
      });
      // 说明
      if (d.note) {
        MK.text(ctx, d.note, cw / 2, cardY + cardH * 0.88, {
          size: 38, weight: 500, color: rgba(d.bad ? '#6C7B80' : T.ink, 0.72), align: 'center', font: 'sans', maxW: cw * 0.86,
        });
      }
      // 对错角标
      if (d.badge === 'no' || d.badge === 'yes') {
        const bx = cw - 58, by = cardY + 58;
        ctx.beginPath(); ctx.arc(bx, by, 42, 0, Math.PI * 2);
        ctx.fillStyle = d.badge === 'yes' ? T.jade : '#B9C6CA'; ctx.fill();
        ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke();
        if (d.badge === 'yes') {
          ctx.beginPath(); ctx.moveTo(bx - 18, by); ctx.lineTo(bx - 4, by + 15); ctx.lineTo(bx + 20, by - 16);
          ctx.lineWidth = 11; ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(bx - 15, by - 15); ctx.lineTo(bx + 15, by + 15);
          ctx.moveTo(bx + 15, by - 15); ctx.lineTo(bx - 15, by + 15);
          ctx.lineWidth = 11; ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.stroke();
        }
      }
      ctx.restore();
    });

    // 中间箭头
    const ka = pop((t - 0.44) / 0.42);
    if (ka > 0 && a.arrow !== false) {
      ctx.save();
      ctx.translate(W / 2, cardY + cardH * 0.44);
      ctx.scale(ka, ka);
      MK.arrow(ctx, -92, 0, 80, 0, T.pop, 26);
      ctx.restore();
    }

    // 结论
    if (a.conclusion) {
      const kc = pop((t - 0.78) / 0.44);
      if (kc > 0) {
        ctx.save();
        ctx.translate(W / 2, H * 0.772);
        ctx.scale(clamp(kc, 0.5, 1.1), clamp(kc, 0.5, 1.1));
        const sw = MK.measure(ctx, a.conclusion, 50, 700) + 50 * 1.1;
        ctx.translate(-sw / 2, 0);
        MK.tagSun(ctx, a.conclusion, 0, 0, 50, {});
        ctx.restore();
      }
    }
    vignette(ctx, W, H, 0.05);
    ctx.restore();
  };

  /* ------------------------------- 5 图标阵列 ------------------------------- */
  L.matrix = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    MK.paper(ctx, W, H, a.paper || 'mint', t);

    if (a.title) {
      const kt = pop((t + 0.02) / 0.4);
      ctx.save(); ctx.globalAlpha *= clamp(kt, 0, 1);
      MK.bannerJade(ctx, a.title, W / 2, H * 0.105, 56, { scale: 0.86 + 0.14 * clamp(kt, 0, 1) });
      ctx.restore();
    }

    const items = (a.items || []).slice(0, 6);
    const n = items.length;
    const cols = n <= 4 ? n : 3;
    const rows = Math.ceil(n / cols);
    const cellW = W / (cols + 0.4);
    const startX = (W - cellW * cols) / 2 + cellW / 2;
    const startY = H * (rows > 1 ? 0.40 : 0.47);
    const gapY = H * (rows > 1 ? 0.30 : 0);

    items.forEach((it, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const cx = startX + c * cellW;
      const cy = startY + r * gapY;
      const at = (a.itemAt && a.itemAt[i] !== undefined) ? Number(a.itemAt[i]) : 0.02 + i * 0.15;
      const k = enter((t - at) / 0.45, 0.82);
      if (k <= 0) return;
      const R = Math.min(cellW * 0.36, H * 0.168);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(k, k);
      if (it.strike) {
        // 被否定的旧认知
        MK.ringCard(ctx, 0, 0, R, { fill: 'rgba(255,255,255,0.86)', ring: 'rgba(255,255,255,0.95)', innerRatio: 0.9, dash: false, shadow: false });
        MK.icon(it.icon || 'scanner', ctx, 0, 0, R * 1.5, {});
        ctx.strokeStyle = rgba(T.pop, 0.85); ctx.lineWidth = 12; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-R * 0.9, R * 0.85); ctx.lineTo(R * 0.9, -R * 0.85); ctx.stroke();
      } else {
        MK.ringCard(ctx, 0, 0, R, {
          fill: it.disc || '#FFE770', ring: 'rgba(255,255,255,0.98)',
          spin: t * 0.10 + i * 0.4, innerRatio: 0.9, dashColor: 'rgba(255,255,255,0.95)',
        });
        MK.icon(it.icon || 'scanner', ctx, 0, 0, R * 1.62, { eyes: false, stone: it.stone });
      }
      ctx.restore();
      // 标签
      const kl = ease((t - at - 0.12) / 0.4);
      if (kl > 0) {
        ctx.save();
        ctx.globalAlpha *= kl;
        const ly = cy + R + 66;
        const tw = MK.measure(ctx, it.label || '', 44, 700);
        ctx.save();
        ctx.translate(cx - tw / 2 - 26, ly - 42);
        MK.rrect(ctx, 0, 0, tw + 52, 66, 33);
        ctx.fillStyle = it.labelFill || T.jadeDeep; ctx.fill();
        ctx.restore();
        MK.text(ctx, it.label || '', cx, ly + 6, {
          size: 44, weight: 700, color: '#fff', align: 'center', maxW: cellW * 0.9,
        });
        ctx.restore();
      }
    });
    vignette(ctx, W, H, 0.05);
    ctx.restore();
  };

  /* ------------------------------- 6 单卡强调 ------------------------------- */
  L.focus = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    MK.paper(ctx, W, H, a.paper || 'sky', t);

    if (a.title) {
      const kt = pop((t + 0.02) / 0.4);
      ctx.save(); ctx.globalAlpha *= clamp(kt, 0, 1);
      // focus 的标题条比其它版式高一点：要给"旧认知标签"腾出独立一行
      MK.bannerJade(ctx, a.title, W / 2, H * 0.086, 56, { scale: 0.86 + 0.14 * clamp(kt, 0, 1) });
      ctx.restore();
    }

    const cx = W / 2, cy = H * 0.545;
    const R = a.r || 244;
    const k = enter((t + 0.02) / 0.5, 0.88);
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(k, k);
    // 光环
    const g = ctx.createRadialGradient(0, 0, R * 0.9, 0, 0, R * 1.7);
    g.addColorStop(0, rgba(T.white, 0.5)); g.addColorStop(1, rgba(T.white, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * 1.7, 0, Math.PI * 2); ctx.fill();
    MK.ringCard(ctx, 0, 0, R, {
      fill: a.disc || '#FFE770', ring: 'rgba(255,255,255,0.98)',
      spin: t * 0.16, innerRatio: 0.90, dashColor: 'rgba(255,255,255,0.95)',
    });
    MK.icon(a.icon || 'scanner', ctx, 0, 0, R * 1.34, { eyes: false });
    ctx.restore();

    // 左侧被划掉的旧标签
    if (a.strike) {
      const ks = ease((t - 0.42) / 0.4);
      if (ks > 0) {
        ctx.save();
        ctx.globalAlpha *= ks;
        // 旧认知标签居中压在圆卡正上方：视觉上"被推翻的前提"
        const sw = MK.measure(ctx, a.strike, 42, 700) + 60;
        const sy = H * 0.545 - (a.r || 244) - 96;
        ctx.translate(W / 2 - sw / 2, sy);
        ctx.rotate(-3 * Math.PI / 180);
        MK.rrect(ctx, 0, 0, sw, 68, 12);
        ctx.fillStyle = 'rgba(38,163,140,0.9)'; ctx.fill();
        MK.text(ctx, a.strike, 30, 48, { size: 42, weight: 700, color: '#fff' });
        // 划除线
        const kd = ease((t - 0.95) / 0.4);
        ctx.beginPath();
        ctx.moveTo(-8, 34); ctx.lineTo(-8 + (sw + 16) * kd, 34);
        ctx.lineWidth = 9; ctx.strokeStyle = T.pop; ctx.lineCap = 'round'; ctx.stroke();
        ctx.restore();
      }
    }

    // 结论文字
    if (a.claim) {
      const kc = pop((t - 0.7) / 0.45);
      if (kc > 0) {
        ctx.save();
        ctx.globalAlpha *= clamp(kc, 0, 1);
        ctx.translate(W / 2, H * 0.822);
        ctx.scale(clamp(kc, 0.6, 1.08), clamp(kc, 0.6, 1.08));
        MK.handText(ctx, a.claim, 0, 0, a.claimSize || 78, { color: T.pop });
        ctx.restore();
      }
    }
    vignette(ctx, W, H, 0.05);
    ctx.restore();
  };

  /* -------------------------------- 7 便签贴 -------------------------------- */
  L.tip = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    MK.paper(ctx, W, H, a.paper || 'sky', t);

    const k = enter((t + 0.02) / 0.5, 0.88);
    ctx.save();
    ctx.translate(W / 2, H * 0.52);
    ctx.rotate(-1.8 * Math.PI / 180);
    ctx.scale(k, k);
    const pw = W * 0.62, ph = H * 0.55;
    // 纸
    ctx.save();
    ctx.shadowColor = 'rgba(22,60,54,0.18)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
    MK.rrect(ctx, -pw / 2, -ph / 2, pw, ph, 10);
    ctx.fillStyle = '#FFFDF6'; ctx.fill();
    ctx.restore();
    // 纸张横线
    ctx.strokeStyle = 'rgba(120,180,200,0.22)'; ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const y = -ph / 2 + 150 + i * 62;
      ctx.beginPath(); ctx.moveTo(-pw / 2 + 56, y); ctx.lineTo(pw / 2 - 56, y); ctx.stroke();
    }
    // 折角
    ctx.beginPath();
    ctx.moveTo(pw / 2 - 84, -ph / 2); ctx.lineTo(pw / 2, -ph / 2 + 84); ctx.lineTo(pw / 2 - 84, -ph / 2 + 84);
    ctx.closePath(); ctx.fillStyle = '#F2EBD7'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pw / 2 - 84, -ph / 2); ctx.lineTo(pw / 2, -ph / 2 + 84);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(160,150,120,0.5)'; ctx.stroke();
    // 顶部胶带
    ctx.save();
    ctx.translate(0, -ph / 2 - 4); ctx.rotate(-2 * Math.PI / 180);
    ctx.fillStyle = 'rgba(255,216,77,0.72)';
    ctx.fillRect(-120, -22, 240, 46);
    ctx.restore();
    // 左侧色标（替代别针，避免与标题重叠）
    ctx.beginPath(); ctx.arc(-pw / 2 + 40, -ph / 2 + 96, 10, 0, Math.PI * 2);
    ctx.fillStyle = T.pop; ctx.fill();

    // 标题
    const kh = ease((t + 0.02) / 0.4);
    ctx.save(); ctx.globalAlpha *= kh;
    MK.text(ctx, a.head || '知识小贴士', -pw / 2 + 66, -ph / 2 + 128, {
      size: 40, weight: 500, color: T.jadeDeep, font: 'sans',
    });
    const kt = ease((t + 0.1) / 0.4);
    ctx.restore();
    ctx.save(); ctx.globalAlpha *= kt;
    MK.text(ctx, a.title || '', -pw / 2 + 66, -ph / 2 + 226, {
      size: a.titleSize || 68, weight: 700, color: T.ink, maxW: pw - 132,
    });
    ctx.restore();

    // 条目：一句一条，当前条点亮、其余压暗（由 args.itemAt 驱动，vo.py 按配音自动填）
    const items = a.items || [];
    const ats = items.map((_, i) =>
      (a.itemAt && a.itemAt[i] !== undefined) ? Number(a.itemAt[i]) : 0.06 + i * 0.2);
    let act = -1;
    ats.forEach((at, i) => { if (t >= at) act = i; });
    items.forEach((it, i) => {
      const ki = ease((t - ats[i]) / 0.32);
      if (ki <= 0) return;
      const on = i === act;
      const y = -ph / 2 + 318 + i * 88;
      ctx.save();
      ctx.globalAlpha *= ki * (on ? 1 : 0.46);
      ctx.translate((1 - ki) * 26, 0);
      // 勾选圈
      ctx.beginPath(); ctx.arc(-pw / 2 + 92, y - 18, 24, 0, Math.PI * 2);
      ctx.fillStyle = on ? rgba(T.jade, 0.20) : rgba(T.jade, 0.10); ctx.fill();
      ctx.lineWidth = on ? 5 : 4; ctx.strokeStyle = T.jade; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-pw / 2 + 80, y - 18); ctx.lineTo(-pw / 2 + 90, y - 6); ctx.lineTo(-pw / 2 + 106, y - 30);
      ctx.lineWidth = 6; ctx.strokeStyle = T.jade; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
      // 当前条的左侧色标
      if (on) {
        ctx.fillStyle = T.jade;
        MK.rrect(ctx, -pw / 2 + 140, y - 34, 6, 34, 3); ctx.fill();
      }
      MK.text(ctx, it, -pw / 2 + 168, y, {
        size: a.itemSize || 44, weight: on ? 700 : 500,
        color: on ? T.ink : rgba(T.ink, 0.75), font: 'sans', maxW: pw - 240,
      });
      ctx.restore();
    });
    ctx.restore();
    vignette(ctx, W, H, 0.05);
    ctx.restore();
  };

  /* -------------------------------- 8 结尾 -------------------------------- */
  L.outro = function (ctx, W, H, t, dur, a, env) {
    const T = env.T;
    ctx.save();
    // 浅蓝底 + 波浪
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#D8EEF9'); g.addColorStop(1, '#BFE0F5');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 4;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      for (let x = -40; x <= W + 40; x += 20) {
        const y = H * (0.06 + i * 0.26) + Math.sin(x * 0.006 + i * 1.3 + t * 0.4) * 16;
        x === -40 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.globalAlpha = 0.28;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 气泡
    for (let i = 0; i < 12; i++) {
      const bx = hash(i) * W, by = hash(i + 31) * H;
      const r = 6 + hash(i + 7) * 16;
      ctx.beginPath();
      ctx.arc(bx, by + Math.sin(t * 0.6 + i) * 12, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
    }

    const bands = [
      { text: a.line1 || '感谢观看', y: H * 0.395, fill: '#A9DFF0', rot: -4.2, size: a.size1 || 118, at: -0.02 },
      { text: a.line2 || '下期再会', y: H * 0.585, fill: '#7A8FD8', rot: -3.2, size: a.size2 || 96, at: 0.22 },
    ];
    bands.forEach((b) => {
      const k = pop((t - b.at) / 0.5);
      if (k <= 0) return;
      ctx.save();
      ctx.translate(W / 2, b.y);
      ctx.rotate(b.rot * Math.PI / 180);
      ctx.scale(k, k);
      const tw = MK.measure(ctx, b.text, b.size, 700);
      const bw = tw + 260, bh = b.size * 1.5;
      ctx.save();
      ctx.shadowColor = 'rgba(40,80,120,0.22)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
      ctx.fillStyle = b.fill;
      ctx.beginPath();
      ctx.moveTo(-bw / 2 + 34, -bh / 2); ctx.lineTo(bw / 2, -bh / 2);
      ctx.lineTo(bw / 2 - 34, bh / 2); ctx.lineTo(-bw / 2, bh / 2);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      MK.text(ctx, b.text, 14, b.size * 0.34, {
        size: b.size, weight: 700, color: '#fff', align: 'center',
        stroke: 9, strokeColor: 'rgba(46,78,128,0.55)',
      });
      ctx.restore();
    });

    // 引号
    const kq = ease((t - 0.3) / 0.45);
    ctx.save();
    ctx.globalAlpha *= kq;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineCap = 'round';
    [[W * 0.155, H * 0.235, 1], [W * 0.845, H * 0.62, -1]].forEach(([x, y, s]) => {
      ctx.save(); ctx.translate(x, y); ctx.scale(s, 1);
      [0, 34].forEach((dx) => {
        ctx.beginPath();
        ctx.arc(dx, 12, 17, Math.PI * 1.08, Math.PI * 1.92);
        ctx.lineWidth = 11; ctx.stroke();
      });
      ctx.restore();
    });
    ctx.restore();

    if (a.note) {
      const kn = ease((t - 0.55) / 0.45);
      MK.text(ctx, a.note, W / 2, H * 0.855, {
        size: 42, weight: 500, color: 'rgba(36,74,112,0.8)', align: 'center', font: 'sans', alpha: kn,
      });
    }
    ctx.restore();
  };

  L.vignette = vignette;
  L.softBackdrop = softBackdrop;
  L.hallway = hallway;
})();
