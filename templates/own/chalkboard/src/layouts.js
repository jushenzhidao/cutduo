// layouts.js · 八个几何机制的版式（纯 Canvas2D）
//
// 每个版式 = 一个函数：(ctx, W, H, t, dur, args, env) => void
//   t      段内时间（秒，从 0 起）
//   dur    本段时长
//   args   本段参数，形状就是 params.schema.json 里 mechanism 那一支
//   env    { T: 完整调色板 + theme 覆盖, palette }
//
// 构图是自写的：统一「板面 → 标题带 → 左主图 / 右数据」两栏。
// 左栏画几何，右栏给可核对的数值与结论。坐标全部按 W/H 比例，不写死 1920×1080。
//
// 硬约束（与 kit.js 同）：纯 Canvas2D，不碰 document / window。

(function (root) {
  'use strict';

  const MK = root.MK;
  const { clamp, lerp } = MK.u;
  const G = MK.geo;
  const T = MK.T;

  // ── 通用 ──
  const MARGIN = 0.045;
  const BODY_TOP = 0.165;
  const BODY_BOT = 0.885;

  const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d === undefined ? 1 : d) : '–');
  const cue = (c, k, def) => (c && Number.isFinite(c[k]) ? c[k] : def);

  // 段内时间轴：structure → focus → explain → settle
  function cuesOf(t, dur, c) {
    return {
      structure: cue(c, 'structure', 0),
      focus: cue(c, 'focus', Math.min(0.55, dur * 0.06)),
      explain: cue(c, 'explain', Math.min(1.6, dur * 0.18)),
      settle: cue(c, 'settle', Math.max(dur - 0.9, dur * 0.72)),
    };
  }

  // 板面 + 标题带。返回内容区矩形。
  function board(ctx, W, H, r, t, cc) {
    MK.board(ctx, W, H, { seed: r.seed || 11 });
    const x0 = W * MARGIN, x1 = W * (1 - MARGIN);
    const p = MK.strokeAt(t, cc.structure, 0.5);
    const size = Math.round(H * 0.041);

    MK.label(ctx, r.title || '', x0, H * 0.108, {
      size, width: W * 0.66, color: T.white, align: 'left', maxLines: 2,
      alpha: clamp(p * 1.6, 0, 1),
    });

    // 标题下的粉笔横线：从左向右描
    MK.line(ctx, [[x0, H * 0.128], [x1, H * 0.128]], 'dim', 2, MK.strokeAt(t, cc.structure + 0.15, 0.7), 41);

    // 右上：机制名（板书页眉）
    MK.text(ctx, String(r.mechanism || '').toUpperCase(), x1, H * 0.072, {
      size: Math.round(H * 0.019), color: T.dim, align: 'right', face: 'body', alpha: clamp(p, 0, 1) * 0.7,
    });

    return { x: x0, y: H * BODY_TOP, w: x1 - x0, h: H * (BODY_BOT - BODY_TOP), W, H };
  }

  function leftBox(area, share) {
    const s = share || 0.58;
    return { x: area.x, y: area.y, w: area.w * s - area.w * 0.03, h: area.h };
  }
  function rightBox(area, share) {
    const s = share || 0.58;
    return { x: area.x + area.w * s + area.w * 0.005, y: area.y, w: area.w * (1 - s) - area.w * 0.005, h: area.h };
  }

  // ── 轨道视图：太阳 + 遮挡片 + 轨道椭圆 + 球（+ 平行光线） ──
  function orbitView(ctx, box, r, s, t, opt) {
    const o = opt || {};
    const beta = o.beta === undefined ? 0 : o.beta;
    const M = r.model;
    const center = [box.x + box.w * (o.cx === undefined ? 0.55 : o.cx), box.y + box.h * (o.cy === undefined ? 0.5 : o.cy)];
    const R = Math.min(box.w * 0.33, box.h * 0.39);
    const inc = (o.display ? (M.displayInclinationDegrees === undefined ? M.inclinationDegrees : M.displayInclinationDegrees) : M.inclinationDegrees) || 0;
    const incRad = inc * G.DEG;
    const prog = o.progress === undefined ? 1 : o.progress;

    const path = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      path.push(G.project(G.position(a, s.node, incRad, M.orbitRadius), M.orbitRadius, beta, center, R));
    }
    MK.line(ctx, path, 'white', 2.8, prog, 101);

    // 倾斜时补一条未倾斜基准轨道，观众才看得出"斜了多少"
    if (beta > 0.05 || incRad > 0.01) {
      const base = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        base.push(G.project(G.position(a, 0, 0, M.orbitRadius), M.orbitRadius, beta, center, R));
      }
      ctx.save();
      ctx.globalAlpha *= 0.42;
      MK.line(ctx, base, 'yellow', 1.6, prog, 211);
      ctx.restore();
    }

    const sun = [center[0] - R - box.w * 0.075, center[1]];
    MK.disc(ctx, sun[0], sun[1], Math.min(38, box.w * 0.032), 'yellow', '#b7a55e', prog);
    MK.disc(ctx, center[0], center[1], Math.min(40, box.w * 0.034), 'blue', '#2b4650', prog);

    const mp = G.project(G.position(s.theta, s.node, incRad, M.orbitRadius), M.orbitRadius, beta, center, R);
    MK.line(ctx, [center, mp], 'blue', 2.2, prog, 307);

    // 平行光线：4 条带流动箭头。半球出现后再画，避免抢视觉
    if (prog > 0.5) {
      for (let j = 0; j < 4; j++) {
        const yy = center[1] - R * 0.5 + (j * R) / 2.4;
        const a = [sun[0] + box.w * 0.035, yy];
        const b = [center[0] + R * 1.06, yy];
        ctx.save();
        ctx.globalAlpha *= 0.62 * clamp((prog - 0.5) * 3, 0, 1);
        MK.line(ctx, [a, b], 'yellow', 1.9, 1, 401 + j);
        const uu = ((t * 0.16 + j * 0.19) % 1 + 1) % 1;
        const xx = lerp(a[0], b[0], uu);
        MK.line(ctx, [[xx - 15, yy], [xx, yy]], 'yellow', 1.8, 1, 409 + j);
        MK.line(ctx, [[xx - 7, yy - 6], [xx, yy], [xx - 7, yy + 6]], 'yellow', 1.8, 1, 419 + j);
        ctx.restore();
      }
    }

    if (o.hideBody !== true) {
      const br = Math.min(34, box.w * 0.028);
      MK.sphere(ctx, mp[0], mp[1], br, s, o.view === undefined ? beta : o.view, {
        shadow: o.shadow === true,
        alpha: clamp(prog * 1.3, 0, 1),
      });
    }

    const ls = Math.round(box.h * 0.029);
    if (o.title !== false) {
      MK.label(ctx, (r.labels && r.labels.orbit) || '轨道', center[0], center[1] + R + box.h * 0.055, {
        size: ls, width: box.w * 0.9, color: T.white, alpha: clamp(prog, 0, 1),
      });
    }
    // 源与片各贴自己的图形，不做「一行两个名字」——分不清谁是谁。
    // labels:false 用于缩略图，缩略尺寸下这些字必然糊成一团。
    if (o.labels !== false) {
      const sunR = Math.min(38, box.w * 0.032);
      const occR = Math.min(40, box.w * 0.034);
      MK.label(ctx, (r.labels && r.labels.source) || '光源', sun[0], sun[1] + sunR + box.h * 0.055, {
        size: Math.round(ls * 0.8), width: box.w * 0.3, color: T.yellow, alpha: clamp(prog, 0, 1), maxLines: 1, bg: T.board,
      });
      MK.label(ctx, (r.labels && r.labels.occluder) || '遮挡片', center[0], center[1] + occR + box.h * 0.045, {
        size: Math.round(ls * 0.8), width: box.w * 0.3, color: T.blue, alpha: clamp(prog, 0, 1), maxLines: 1, bg: T.board,
      });
    }

    return { center, R, moon: mp, sun };
  }

  // ── 相位盘：从观察者看到的球 + 数值 ──
  function phasePanel(ctx, box, r, s, t, opt) {
    const o = opt || {};
    const p = o.progress === undefined ? 1 : o.progress;
    // 球必须落在框内：半径按框高 0.22 取，球心 0.33h → 球底 0.55h，框底 0.60h
    const radius = Math.min(box.w * 0.26, box.h * 0.19);
    const x = box.x + box.w * 0.5;
    const y = box.y + box.h * 0.33;
    const top = box.y + box.h * 0.04;
    const bot = box.y + box.h * 0.575;

    // 视点框：只是分区提示，压到 0.4 以下，别和球抢视线
    ctx.save();
    ctx.globalAlpha *= 0.3;
    MK.line(ctx, [
      [box.x + box.w * 0.06, top],
      [box.x + box.w * 0.94, top],
      [box.x + box.w * 0.94, bot],
      [box.x + box.w * 0.06, bot],
      [box.x + box.w * 0.06, top],
    ], 'dim', 1.4, MK.strokeAt(t, o.at === undefined ? 0 : o.at, 0.7), 503);
    ctx.restore();

    MK.sphere(ctx, x, y, radius, s, 'observer', { shadow: o.shadow === true, alpha: clamp(p * 1.2, 0, 1) });

    MK.label(ctx, o.title || (r.labels && r.labels.view) || '观察者所见', x, box.y + box.h * 0.005, {
      size: Math.round(box.h * 0.034), width: box.w * 0.92, color: T.blue, alpha: clamp(p, 0, 1),
    });
    // 本体名放在球下沿内侧，避免压球
    MK.label(ctx, (r.labels && r.labels.body) || '本体', x, bot + box.h * 0.042, {
      size: Math.round(box.h * 0.028), width: box.w * 0.92, color: T.white, alpha: clamp(p, 0, 1),
    });

    MK.label(ctx, (r.labels && r.labels.lit) || '可见受光比例', x, box.y + box.h * 0.685, {
      size: Math.round(box.h * 0.031), width: box.w * 0.92, color: T.yellow, alpha: clamp(p, 0, 1),
    });
    MK.number(ctx, fmt(100 * s.fraction, r.decimals) + ' %', x, box.y + box.h * 0.775, {
      size: Math.round(box.h * 0.058), color: T.yellow, alpha: clamp(p, 0, 1),
    });

    if (o.shadow) {
      MK.label(ctx, (r.labels && r.labels.blocked) || '被遮挡比例', x, box.y + box.h * 0.875, {
        size: Math.round(box.h * 0.029), width: box.w * 0.92, color: T.blue, alpha: clamp(p, 0, 1),
      });
      MK.number(ctx, fmt(100 * s.blocked, r.decimals) + ' %', x, box.y + box.h * 0.97, {
        size: Math.round(box.h * 0.044), color: T.blue, alpha: clamp(p, 0, 1),
      });
    }
    return { x, y, r: radius };
  }

  // ── 截面：本影圆 + 球体按 (pos.y, pos.z) 真实偏移 ──
  function shadowSection(ctx, box, r, s, t, opt) {
    const o = opt || {};
    const p = o.progress === undefined ? 1 : o.progress;
    const M = r.model;
    const x = box.x + box.w * 0.5;
    const y = box.y + box.h * 0.46;
    const range = Math.max(s.umbra, M.bodyRadius, Math.hypot(s.pos[1], s.pos[2]) + M.bodyRadius);
    const scale = Math.min(box.w * 0.34, box.h * 0.26) / Math.max(range, 1e-9);
    const bx = x + s.pos[1] * scale;
    const by = y - s.pos[2] * scale;

    const rr = Math.max(1, s.umbra * scale);
    const br = Math.max(1, M.bodyRadius * scale);
    MK.circle(ctx, x, y, rr, 'white', p, 2.6, 601);

    // 本影内部用排线压暗：粉笔黑板没有渐变，只有线
    if (s.umbra > 0) {
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.clip();
      ctx.globalAlpha *= 0.5 * p;
      ctx.strokeStyle = MK.u.rgba(T.white, 0.18);
      ctx.lineWidth = 1.1;
      const step = Math.max(5, rr * 0.16);
      for (let k = -40; k < 40; k++) {
        ctx.beginPath();
        ctx.moveTo(x - rr + k * step, y - rr);
        ctx.lineTo(x - rr + k * step + rr * 2, y + rr);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 球心到影心一条细线：标出偏移量，说明"为什么只遮住一部分"
    MK.line(ctx, [[x, y], [bx, by]], 'dim', 1.4, p * 0.8, 611);

    MK.sphere(ctx, bx, by, br, s, 'observer', { shadow: false, alpha: clamp(p, 0, 1) });

    // 重叠区：球 ∩ 影。**必须画在球之后**——先画会被球体填充整个盖掉，
    // 上一版就是这样，红色一点都看不见。半透明红浮在球面上，才是"被影盖住"。
    if (s.blocked > 1e-6) {
      ctx.save();
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.clip();
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.clip();
      ctx.globalAlpha *= 0.62 * clamp(p, 0, 1);
      ctx.fillStyle = T.red;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }

    MK.label(ctx, '同一状态的遮挡截面', x, box.y + box.h * 0.06, {
      size: Math.round(box.h * 0.036), width: box.w * 0.94, color: T.white, alpha: clamp(p, 0, 1),
    });
    // 数值上移到 0.87：0.955 正好落进字幕带（0.912H 起的「擦净板面」），
    // 字幕一宽就把数字擦掉一截，看起来像渲染坏了。
    MK.label(ctx, (r.labels && r.labels.blocked) || '被遮挡比例', x, box.y + box.h * 0.78, {
      size: Math.round(box.h * 0.033), width: box.w * 0.94, color: T.blue, alpha: clamp(p, 0, 1),
    });
    MK.number(ctx, fmt(100 * s.blocked, r.decimals) + ' %', x, box.y + box.h * 0.87, {
      size: Math.round(box.h * 0.056), color: T.blue, alpha: clamp(p, 0, 1),
    });
    return { x, y, scale };
  }

  // ── 光路图：源 → 靶，N 条光，遇最近挡板即止 ──
  function rayView(ctx, box, r, s, t, opt) {
    const o = opt || {};
    const O = r.optics;
    const p = o.progress === undefined ? 1 : o.progress;
    const blockers = O.blockers || [];
    const xs = [O.source[0], O.target[0], ...blockers.map((b) => b.x)];
    const ys = [O.source[1], O.target[1], ...blockers.map((b) => b.y)];
    const minX = Math.min(...xs) - 1.2, maxX = Math.max(...xs) + 1.2;
    const minY = Math.min(...ys) - 1.6, maxY = Math.max(...ys) + 1.6;
    const sc = Math.min((box.w * 0.84) / (maxX - minX), (box.h * 0.7) / (maxY - minY));
    const tx = (q) => box.x + box.w * 0.5 + (q - (minX + maxX) / 2) * sc;
    const ty = (q) => box.y + box.h * 0.5 + (q - (minY + maxY) / 2) * sc;

    // 挡板在光线之下
    for (const b of blockers) {
      MK.disc(ctx, tx(b.x), ty(b.y), Math.max(2, b.r * sc), 'blue', '#2b4650', p);
      MK.label(ctx, b.label || b.id, tx(b.x), ty(b.y) - Math.max(10, b.r * sc) - box.h * 0.02, {
        size: Math.round(box.h * 0.028), width: box.w * 0.34, color: T.blue, alpha: clamp(p, 0, 1),
      });
    }

    for (const beam of s.beams) {
      const a = [tx(beam.start[0]), ty(beam.start[1])];
      const b = [tx(beam.end[0]), ty(beam.end[1])];
      const col = beam.reachable ? 'yellow' : 'red';
      ctx.save();
      ctx.globalAlpha *= beam.reachable ? 0.85 : 0.7;
      MK.line(ctx, [a, b], col, 2, p, 701 + Math.round(a[0]));
      ctx.restore();
      const ph = [tx(beam.photon[0]), ty(beam.photon[1])];
      ctx.save();
      ctx.globalAlpha *= 0.9 * clamp(p, 0, 1);
      ctx.fillStyle = MK.u.rgba(T[col], 0.9);
      ctx.beginPath(); ctx.arc(ph[0], ph[1], Math.max(1.6, box.h * 0.004), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    MK.disc(ctx, tx(O.source[0]), ty(O.source[1]), Math.max(8, box.h * 0.026), 'yellow', '#b7a55e', p);
    MK.label(ctx, (r.labels && r.labels.source) || '光源', tx(O.source[0]), ty(O.source[1]) + box.h * 0.075, {
      size: Math.round(box.h * 0.03), width: box.w * 0.4, color: T.yellow, alpha: clamp(p, 0, 1),
    });
    MK.circle(ctx, tx(O.target[0]), ty(O.target[1]), Math.max(8, box.h * 0.026), 'white', p, 2.6, 809);
    MK.label(ctx, (r.labels && r.labels.body) || '接收面', tx(O.target[0]), ty(O.target[1]) + box.h * 0.075, {
      size: Math.round(box.h * 0.03), width: box.w * 0.4, color: T.white, alpha: clamp(p, 0, 1),
    });
    return { tx, ty, sc };
  }

  // ── 条件清单：4 个几何谓词的真假 ──
  const COND_NAMES = {
    'near-opposition': '处于对向位置',
    'within-shadow-height': '位于影高范围',
    'shadow-contact': '发生圆面重叠',
    'direct-center-ray': '中心光路可达',
  };

  function conditionRows(ctx, box, r, s, t, cc) {
    const list = r.conditions && r.conditions.length ? r.conditions : ['near-opposition', 'within-shadow-height', 'shadow-contact'];
    const vals = s.conditions || G.conditions(s);
    const rowH = box.h / (list.length + 1.2);
    list.forEach((k, i) => {
      const y = box.y + box.h * 0.06 + i * rowH;
      const p = MK.strokeAt(t, cc.explain + i * 0.645, 0.6);
      MK.label(ctx, COND_NAMES[k] || k, box.x + box.w * 0.5, y, {
        size: Math.round(box.h * 0.045), width: box.w * 0.94, color: T.white, alpha: clamp(p, 0, 1),
      });
      MK.label(ctx, vals[k] ? '成立' : '不成立', box.x + box.w * 0.5, y + rowH * 0.42, {
        size: Math.round(box.h * 0.05), width: box.w * 0.94,
        color: vals[k] ? T.blue : T.dim, alpha: p >= 1 ? 1 : 0,
      });
    });
    const all = list.every((k) => vals[k]);
    MK.label(ctx, all ? '所选条件全部满足' : '继续分别核对条件', box.x + box.w * 0.5, box.y + box.h * 0.96, {
      size: Math.round(box.h * 0.042), width: box.w * 0.94, color: T.blue,
      alpha: MK.strokeAt(t, cc.settle, 0.3),
    });
    return all;
  }

  // ── 八个机制 ──
  const L = {};

  // 1. 同一球体沿轨道运动，看受光比例怎么变
  L['orbit-phase'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');
    const A = leftBox(area, 0.6), B = rightBox(area, 0.6);
    orbitView(ctx, A, r, s, t, { progress: MK.strokeAt(t, cc.focus, 0.95) });
    phasePanel(ctx, B, r, s, t, { progress: MK.strokeAt(t, cc.explain, 0.6), at: cc.explain });
    MK.cornerBadge(ctx, W, H, { text: (r.unit ? '单位 ' + r.unit + ' · ' : '') + '几何示意，不是真实比例' }, 0.85);
  };

  // 2. 把球取出放大，看光线来自哪边
  L['surface-view'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');

    // 先整图，再推近，最后把轨道缩到右侧当定位图
    const q = MK.strokeAt(t, cc.focus, 0.8);
    const back = MK.strokeAt(t, cc.settle - 0.8, 0.8);
    const amount = q * (1 - back);

    const big = { x: area.x, y: area.y, w: area.w * 0.56, h: area.h };
    const cx = big.x + big.w * 0.52;
    const cy = big.y + big.h * 0.46;
    const rad = Math.min(big.w * 0.27, big.h * 0.31) * lerp(1.0, 1.18, amount);

    if (amount > 0.12) {
      ctx.save();
      ctx.globalAlpha *= clamp((amount - 0.12) * 2, 0, 1) * 0.9;
      // 光线必须画到球面上，留空会被读成「几根断线」
      for (let j = 0; j < 5; j++) {
        // 5 条均布在 ±0.8r 内：超出这个范围的线头会悬在球外，看着像画错了
        const yy = cy + rad * (-0.8 + (j * 0.4));
        const x1 = cx - rad * Math.sqrt(Math.max(0, 1 - Math.pow((yy - cy) / rad, 2))) * 0.99;
        MK.line(ctx, [[cx - rad * 1.72, yy], [x1, yy]], 'yellow', 2.2, 1, 901 + j);
        MK.line(ctx, [[x1 - rad * 0.09, yy - rad * 0.035], [x1, yy], [x1 - rad * 0.09, yy + rad * 0.035]], 'yellow', 2.2, 1, 921 + j);
      }
      ctx.restore();
    }
    MK.sphere(ctx, cx, cy, rad, s, 'observer', { shadow: false, alpha: clamp(q * 1.2, 0, 1) });

    if (amount > 0.4) {
      ctx.save();
      ctx.globalAlpha *= clamp((amount - 0.4) * 2, 0, 1) * 0.8;
      const ex = cx + rad * 1.45, ey = cy;
      MK.line(ctx, [[cx + rad * 1.06, cy], [ex, ey]], 'blue', 2, 1, 1009);
      MK.line(ctx, [[ex - 12, ey - 7], [ex, ey], [ex - 12, ey + 7]], 'blue', 2, 1, 1013);
      MK.label(ctx, (r.labels && r.labels.view) || '观察方向', ex, ey - area.h * 0.04, {
        size: Math.round(area.h * 0.03), width: big.w * 0.4, color: T.blue,
      });
      ctx.restore();
    }

    const B = rightBox(area, 0.56);
    MK.label(ctx, (r.labels && r.labels.lit) || '可见受光比例', B.x + B.w * 0.5, B.y + B.h * 0.12, {
      size: Math.round(area.h * 0.036), width: B.w * 0.94, color: T.yellow, alpha: MK.strokeAt(t, cc.explain, 0.5),
    });
    MK.number(ctx, fmt(100 * s.fraction, r.decimals) + ' %', B.x + B.w * 0.5, B.y + B.h * 0.22, {
      size: Math.round(area.h * 0.07), color: T.yellow, alpha: MK.strokeAt(t, cc.explain, 0.5),
    });

    // 缩略轨道：定位这个特写来自轨道上哪一点
    orbitView(ctx, { x: B.x, y: B.y + B.h * 0.34, w: B.w, h: B.h * 0.62 }, r, s, t, {
      progress: MK.strokeAt(t, cc.focus, 0.9), display: false, title: false, labels: false,
    });
    MK.cornerBadge(ctx, W, H, { text: (r.unit ? '单位 ' + r.unit + ' · ' : '') + '球面按可见受光比例绘制' }, 0.85);
  };

  // 3. 连续遮挡：本影盖住球面多少
  L['shadow-overlap'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');

    const A = { x: area.x, y: area.y, w: area.w * 0.5, h: area.h };
    const B = { x: area.x + area.w * 0.52, y: area.y, w: area.w * 0.48, h: area.h * 0.5 };
    const Cc = { x: area.x + area.w * 0.52, y: area.y + area.h * 0.54, w: area.w * 0.48, h: area.h * 0.46 };

    orbitView(ctx, A, r, s, t, { progress: MK.strokeAt(t, cc.focus, 0.95), shadow: true });
    phasePanel(ctx, B, r, s, t, { progress: MK.strokeAt(t, cc.explain, 0.6), at: cc.explain, shadow: true });
    shadowSection(ctx, Cc, r, s, t, { progress: MK.strokeAt(t, cc.explain + 0.5, 0.7) });
    MK.cornerBadge(ctx, W, H, { text: (r.unit ? '单位 ' + r.unit + ' · ' : '') + '本影按锥形几何计算，不是贴图' }, 0.85);
  };

  // 4. 同一轨道有倾角：俯视排成线仍可能避开遮挡
  L['inclined-orbit'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');
    const M = r.model;

    const A = leftBox(area, 0.6), B = rightBox(area, 0.6);
    orbitView(ctx, A, r, s, t, {
      progress: MK.strokeAt(t, cc.focus, 0.95),
      beta: Math.PI * 0.43 * MK.strokeAt(t, cc.focus, 0.9),
      display: true,
      shadow: true,
    });
    phasePanel(ctx, B, r, s, t, { progress: MK.strokeAt(t, cc.explain, 0.6), at: cc.explain, shadow: true });

    // 实际倾角与示意倾角必须分两处写，否则观众会当成真实比例
    // 倾角说明并进底部角标一行：右栏已被四行数值占满，硬塞必然压字；
    // 左栏底部又紧贴字幕带。合并是唯一不牺牲可读性的位置。
    const disp = M.displayInclinationDegrees === undefined ? M.inclinationDegrees : M.displayInclinationDegrees;
    MK.cornerBadge(ctx, W, H, {
      text: '实际倾角 ' + fmt(M.inclinationDegrees, r.decimals) + '° · 示意倾角 ' + fmt(disp, r.decimals) + '° · 画面角度为示意，不是真实比例',
    }, MK.strokeAt(t, cc.explain + 0.6, 0.5));
  };

  // 5. 同一个三维状态，两个投影看起来不同
  L['projection-compare'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');

    const half = area.w * 0.48;
    const A = { x: area.x, y: area.y, w: half, h: area.h * 0.84 };
    const B = { x: area.x + area.w * 0.52, y: area.y, w: half, h: area.h * 0.84 };
    const p = MK.strokeAt(t, cc.focus, 0.95);

    // 两个 beta 是同一状态的两种看法，不是两次运动：共用一个 s
    orbitView(ctx, A, r, s, t, { progress: p, beta: 0, title: true, display: true });
    orbitView(ctx, B, r, s, t, { progress: p, beta: Math.PI * 0.43, title: false, display: true });

    MK.label(ctx, '正视投影', A.x + A.w * 0.5, area.y + area.h * 0.9, {
      size: Math.round(area.h * 0.036), width: A.w * 0.9, color: T.white, alpha: clamp(p, 0, 1),
    });
    MK.label(ctx, '俯视投影', B.x + B.w * 0.5, area.y + area.h * 0.9, {
      size: Math.round(area.h * 0.036), width: B.w * 0.9, color: T.white, alpha: clamp(p, 0, 1),
    });
    MK.label(ctx, '同一个三维状态，两个投影', area.x + area.w * 0.5, area.y + area.h * 0.985, {
      size: Math.round(area.h * 0.038), width: area.w * 0.9, color: T.yellow, alpha: MK.strokeAt(t, cc.settle, 0.4),
    });
  };

  // 6. 显式两条件与两种变暗原因
  L['causal-compare'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');
    const s2 = G.physical(r.comparison.model, r.comparison.phaseKeys, r.comparison.nodeKeys, t, 'body-1');

    const half = area.w * 0.48;
    const A = { x: area.x, y: area.y, w: half, h: area.h * 0.8 };
    const B = { x: area.x + area.w * 0.52, y: area.y, w: half, h: area.h * 0.8 };
    const pa = MK.strokeAt(t, cc.focus, 0.7);
    const pb = MK.strokeAt(t, cc.explain, 0.7);

    phasePanel(ctx, A, r, s, t, {
      progress: pa, at: cc.focus, shadow: false,
      title: (r.labels && r.labels.actual) || '实际原因',
    });
    phasePanel(ctx, B, r, s2, t, {
      progress: pb, at: cc.explain, shadow: true,
      title: (r.comparison && r.comparison.label) || '比较项',
    });

    MK.line(ctx, [[area.x + area.w * 0.5, area.y + area.h * 0.12], [area.x + area.w * 0.5, area.y + area.h * 0.56]], 'dim', 1.8, MK.strokeAt(t, cc.explain, 0.6), 1201);
    MK.text(ctx, 'VS', area.x + area.w * 0.5, area.y + area.h * 0.4, {
      size: Math.round(area.h * 0.05), color: T.dim, align: 'center', alpha: clamp(pb, 0, 1) * 0.8,
    });

    MK.label(ctx, '两种外观相近，原因不同', area.x + area.w * 0.5, area.y + area.h * 0.92, {
      size: Math.round(area.h * 0.04), width: area.w * 0.9, color: T.yellow, alpha: MK.strokeAt(t, cc.settle, 0.5),
    });
  };

  // 7. 光路拓扑：最近遮挡与可达性
  L['ray-topology'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.rayState(r.optics, t, dur);

    const A = { x: area.x, y: area.y, w: area.w * 0.62, h: area.h * 0.86 };
    const B = { x: area.x + area.w * 0.65, y: area.y, w: area.w * 0.35, h: area.h * 0.86 };
    rayView(ctx, A, r, s, t, { progress: MK.strokeAt(t, cc.focus, 0.9) });

    const list = r.optics.blockers || [];
    const per = {};
    for (const b of s.beams) if (b.blockedBy) per[b.blockedBy] = (per[b.blockedBy] || 0) + 1;
    list.forEach((b, i) => {
      const y = B.y + B.h * (0.08 + i * 0.16);
      const p = MK.strokeAt(t, cc.explain + i * 0.5, 0.6);
      MK.label(ctx, b.label || b.id, B.x + B.w * 0.5, y, {
        size: Math.round(area.h * 0.036), width: B.w * 0.96, color: T.blue, alpha: clamp(p, 0, 1),
      });
      MK.label(ctx, '拦截 ' + (per[b.id] || 0) + ' 条', B.x + B.w * 0.5, y + B.h * 0.055, {
        size: Math.round(area.h * 0.03), width: B.w * 0.96, color: T.dim, alpha: clamp(p, 0, 1),
      });
    });
    MK.label(ctx, '通达 ' + s.clear + ' / ' + s.total, B.x + B.w * 0.5, B.y + B.h * 0.82, {
      size: Math.round(area.h * 0.042), width: B.w * 0.96, color: T.yellow, alpha: MK.strokeAt(t, cc.settle, 0.5),
    });
    MK.label(ctx, '每条光路停在遇到的第一块遮板', area.x + area.w * 0.5, area.y + area.h * 0.955, {
      size: Math.round(area.h * 0.033), width: area.w * 0.94, color: T.white, alpha: MK.strokeAt(t, cc.settle, 0.4),
    });
  };

  // 8. 条件判定：几何状态驱动结论
  L['condition-proof'] = function (ctx, W, H, t, dur, r, env) {
    const cc = cuesOf(t, dur, r.cueTimes);
    const area = board(ctx, W, H, r, t, cc);
    const s = G.physical(r.model, r.phaseKeys, r.nodeKeys, t, 'body-0');
    s.conditions = G.conditions(s);

    const A = { x: area.x, y: area.y, w: area.w * 0.56, h: area.h * 0.88 };
    const B = { x: area.x + area.w * 0.59, y: area.y, w: area.w * 0.41, h: area.h * 0.88 };
    orbitView(ctx, A, r, s, t, {
      progress: MK.strokeAt(t, cc.focus, 0.95),
      beta: Math.PI * 0.4,
      title: false,
      shadow: true,
    });
    conditionRows(ctx, B, r, s, t, cc);
  };

  root.L = L;
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
})(typeof window !== 'undefined' ? window : this);
