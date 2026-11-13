// kit.js · 可爱角色歌词 MV 的绘制原语（纯 Canvas2D）
//
// 硬约束：不碰 document / window / createElement —— 这是双宿主的前提（见 SKIA-SPEC.md）。
// 随机一律用**确定性伪随机** rnd(seed)：同 seed 每帧完全一致，否则草与雨会逐帧跳动。
//
// 三层原语：
//   · 角色层 chibi()   —— 两骨 IK + 胶囊手臂，表情/呼吸/呆毛都在这里
//   · 场景层 sky/sun/cloud/tree/building/... —— 只画矢量，不认镜头
//   · 文字层 lyricBar/note/bigWord      —— 三种叠加，位置与字号来自上游 recipe

(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  // 字体分流：浏览器走系统楷体/快乐体；Skia 由 src/webcanvas.mjs 注入 __FAM 指向随包 OFL 字体。
  // 不注入时回落到 __FONT_PICK（Noto），画面仍成立，只是字形没那么"手写"。
  const FAM = root.__FAM || {
    kai: '"LXGW WenKai","Kaiti SC","STKaiti",serif',
    kuai: '"ZCOOL KuaiLe","PingFang SC",sans-serif',
    sans: '"PingFang SC",sans-serif',
  };

  function pickFont(weight, size) {
    const f = root.__FONT_PICK;
    return f ? f(weight || 700, size || 48) : FAM.sans;
  }

  // 角色配色：一套衣服穿全片，靠背景换情绪（上游也是这么做的）
  const C = {
    skin: '#FFE3C8',
    skinShade: '#F4C7A4',
    hair: '#4E352A',
    hairLit: '#6B4A38',
    dress: '#FFF4E2',
    dressShade: '#F0DCC0',
    trim: '#F2A7A0',
    ink: '#4A3328',
    blush: 'rgba(244,150,150,0.55)',
  };

  const u = {
    clamp(x, a, b) { return Math.max(a, Math.min(b, x)); },
    lerp(a, b, k) { return a + (b - a) * k; },
    ease(t) { const x = u.clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); },
    eo(t) { const x = u.clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); },
    // 区间可见度：t0 淡入 fi，t1 之后 fo 淡出
    vis(t, t0, t1, fi, fo) {
      return Math.min(u.clamp((t - t0) / (fi === undefined ? 0.3 : fi), 0, 1),
        u.clamp((t1 + (fo === undefined ? 0.3 : fo) - t) / (fo === undefined ? 0.3 : fo), 0, 1));
    },
    // 回弹弹出：从 0 冲到 1 再回坐，用于关键词"砸下来"
    pop(t, t0, d) {
      const k = u.clamp((t - t0) / (d || 0.35), 0, 1);
      if (k <= 0) return 0;
      const s = 1.70158 * 1.4; const x = k - 1;
      return 1 + x * x * ((s + 1) * x + s);
    },
    rgba(hex, a) {
      const h = String(hex || '#000').replace('#', '');
      const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    },
    mix(a, b, k) {
      const p = (h) => { const n = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)); };
      const A = p(a), B = p(b);
      const c = A.map((v, i) => Math.round(u.lerp(v, B[i], k)));
      return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
    },
  };

  // 确定性伪随机：同 seed 恒定
  function rnd(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  // ---------- 基础形状 ----------

  function rr(ctx, x, y, w, h, r) {
    const k = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.lineTo(x + w - k, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + k);
    ctx.lineTo(x + w, y + h - k);
    ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
    ctx.lineTo(x + k, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - k);
    ctx.lineTo(x, y + k);
    ctx.quadraticCurveTo(x, y, x + k, y);
    ctx.closePath();
  }

  function vgrad(ctx, x0, y0, x1, y1, c0, c1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    return g;
  }

  // ---------- 角色 ----------

  const POSES = {
    wave: { hand: [152, -500], tilt: -3, far: [-126, -186] },
    umbrella: { hand: [190, -380], tilt: 2, far: [-118, -196] },
    hold: { hand: [72, -300], tilt: 3, far: [-112, -200] },
    throw: { hand: [150, -180], tilt: 1, far: [-122, -188] },
    lookup: { hand: [112, -200], tilt: -6, far: [-118, -196] },
    point: { hand: [250, -452], tilt: -4, far: [-120, -192] },
    draw: { hand: [190, -260], tilt: 4, far: [-108, -204] },
    shade: { hand: [152, -434], tilt: -2, far: [-116, -198] },
    hands: { hand: [130, -210], tilt: 0, far: [-112, -200] },
  };

  // 两骨 IK：给定肩与腕，解肘；flip 决定肘朝哪边弯
  function ik(shoulder, target, upper, lower, flip) {
    const dx = target[0] - shoulder[0], dy = target[1] - shoulder[1];
    let dist = Math.hypot(dx, dy);
    const maxD = upper + lower - 1;
    if (dist > maxD) dist = maxD;
    if (dist < 1) dist = 1;
    const dir = [dx / (dist || 1), dy / (dist || 1)];
    const cos = u.clamp((upper * upper + dist * dist - lower * lower) / (2 * upper * dist), -1, 1);
    const a = Math.acos(cos);
    const ang = Math.atan2(dir[1], dir[0]) + a * flip;
    return {
      elbow: [shoulder[0] + Math.cos(ang) * upper, shoulder[1] + Math.sin(ang) * upper],
      wrist: [shoulder[0] + dir[0] * dist, shoulder[1] + dir[1] * dist],
    };
  }

  // 胶囊肢体：外圈深色描边 + 内层皮肤，圆头圆尾，弯折不断线
  function limb(ctx, a, b, c, w, fill, ink) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(b[0], b[1], c[0], c[1]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = w + 7;
    ctx.stroke();
    ctx.strokeStyle = fill;
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 画一个 chibi 角色。坐标原点在**脚底**，向上为负。
   * @param {object} o {x,y,s,pose,tint,alpha}
   */
  function chibi(ctx, t, o) {
    const s = o.s || 1;
    const P = POSES[o.pose] || POSES.wave;
    const bob = Math.sin(t * 2.05 + 0.5) * 2.4;
    const sway = Math.sin(t * 1.12 + 0.3) * 1.0;
    const blinkPh = (t + 0.9) % 3.6;
    const eyeOpen = blinkPh < 0.16 ? Math.abs(blinkPh / 0.08 - 1) : 1;

    // 手势位移：挥手摆腕、抛纸团的上抛、画线的来回
    let hand = [P.hand[0], P.hand[1]];
    if (o.pose === 'wave') hand = [hand[0] + Math.sin(t * 5.2) * 14, hand[1] + Math.cos(t * 5.2) * 8];
    if (o.pose === 'throw') {
      const k = u.eo(u.clamp((t - 0.25) / 0.85, 0, 1));
      hand = [u.lerp(150, 230, k), u.lerp(-180, -472, k)];
    }
    if (o.pose === 'draw') hand = [hand[0] + Math.sin(t * 3.1) * 42, hand[1] + Math.cos(t * 3.1) * 9];
    if (o.pose === 'point') hand = [hand[0] + Math.sin(t * 1.7) * 6, hand[1] + Math.sin(t * 2.3) * 5];

    ctx.save();
    ctx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
    ctx.translate(o.x, o.y + bob);
    ctx.rotate((sway + P.tilt * 0.25) * Math.PI / 180);
    ctx.scale(s, s);

    // 地面投影：跟着呼吸缩放，避免人物"贴纸感"
    ctx.save();
    ctx.globalAlpha *= 0.15;
    ctx.fillStyle = '#3A2415';
    ctx.beginPath();
    ctx.ellipse(0, 4, 138 + Math.sin(t * 2.05) * 3, 22, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    const headY = -404, headR = 110;
    const shoulderY = -292;
    const SH = 86; // 肩点外移：手肘抬高时不压脸，这是第一版最明显的毛病

    // 后侧手臂（远离镜头那只）
    const far = ik([-SH, shoulderY], P.far, 104, 98, 1);
    limb(ctx, [-SH, shoulderY], far.elbow, far.wrist, 24, C.skinShade, C.ink);
    ctx.beginPath();
    ctx.arc(far.wrist[0], far.wrist[1], 15, 0, TAU);
    ctx.fillStyle = C.skinShade; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();

    // 前臂先解算再决定层次：手举过头时手臂要压在头后面，
    // 否则会从脸颊上横穿过去（第一版就是这个观感）。
    const sol = ik([SH, shoulderY], hand, 104, 98, -1);
    const armOverHead = hand[1] < -380;
    const drawFrontArm = () => {
      limb(ctx, [SH, shoulderY], sol.elbow, sol.wrist, 25, C.skin, C.ink);
      ctx.beginPath();
      ctx.arc(sol.wrist[0], sol.wrist[1], 16, 0, TAU);
      ctx.fillStyle = C.skin; ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();
      if (o.pose === 'umbrella') umbrella(ctx, sol.wrist, t);
      if (o.pose === 'throw' && t < 0.9) paperBall(ctx, sol.wrist);
      if (o.pose === 'draw') pencil(ctx, sol.wrist);
      if (o.pose === 'point') paperPlane(ctx, sol.wrist[0] + 46, sol.wrist[1] - 26, -0.42, 0.9, '#FFFDF4', C.ink);
    };

    if (armOverHead) drawFrontArm();

    // 腿 + 鞋：短、圆，鞋要看出是鞋
    for (const sx of [-28, 28]) {
      limb(ctx, [sx, -84], [sx, -50], [sx, -20], 26, C.skin, C.ink);
      ctx.beginPath();
      ctx.ellipse(sx, -12, 26, 15, 0, 0, TAU);
      ctx.fillStyle = '#7A5540'; ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();
    }

    // 裙身：A 字摆，hem 有弧度
    ctx.beginPath();
    ctx.moveTo(-64, -316);
    ctx.bezierCurveTo(-80, -256, -108, -164, -122, -78);
    ctx.quadraticCurveTo(0, -54, 122, -78);
    ctx.bezierCurveTo(108, -164, 80, -256, 64, -316);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, -120, -316, 120, -70, C.dress, C.dressShade);
    ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();

    // 下摆一道浅色花边
    ctx.beginPath();
    ctx.moveTo(-118, -88);
    ctx.quadraticCurveTo(0, -64, 118, -88);
    ctx.strokeStyle = C.trim; ctx.lineWidth = 9; ctx.stroke();

    // 领口 + 两颗扣子
    ctx.beginPath();
    ctx.moveTo(-34, -312); ctx.lineTo(0, -276); ctx.lineTo(34, -312);
    ctx.closePath();
    ctx.fillStyle = '#FFF9EC'; ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.fillStyle = C.trim;
    ctx.beginPath(); ctx.arc(0, -252, 7, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -222, 7, 0, TAU); ctx.fill();

    // 后发（在头后）
    ctx.beginPath();
    ctx.ellipse(0, headY + 8, 126, 126, 0, 0, TAU);
    ctx.fillStyle = C.hair; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();

    // 耳朵
    ctx.fillStyle = C.skin;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * 106, headY + 16, 21, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.stroke();
    }

    // 脸
    ctx.beginPath();
    ctx.ellipse(0, headY + 8, headR, 106, 0, 0, TAU);
    ctx.fillStyle = vgrad(ctx, 0, headY - 96, 0, headY + 108, '#FFF1DE', C.skin);
    ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();

    // 刘海：三瓣 + 两侧发丝（发丝随时间轻摆）
    const swayX = Math.sin(t * 1.8) * 5;
    ctx.beginPath();
    ctx.moveTo(-108, headY - 6);
    ctx.bezierCurveTo(-126, headY - 118, 126, headY - 122, 108, headY - 8);
    ctx.quadraticCurveTo(76, headY - 48, 40, headY - 20);
    ctx.quadraticCurveTo(6, headY - 60, -30, headY - 22);
    ctx.quadraticCurveTo(-72, headY - 50, -108, headY - 6);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, 0, headY - 112, 0, headY - 8, C.hairLit, C.hair);
    ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();

    // 碎发：压在刘海上，破掉"头盔感"
    ctx.beginPath();
    ctx.moveTo(-6, headY - 96);
    ctx.quadraticCurveTo(10, headY - 54, 2, headY - 16);
    ctx.quadraticCurveTo(-14, headY - 54, -20, headY - 92);
    ctx.closePath();
    ctx.fillStyle = C.hair; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(30, headY - 92);
    ctx.quadraticCurveTo(48, headY - 56, 40, headY - 22);
    ctx.quadraticCurveTo(22, headY - 56, 16, headY - 90);
    ctx.closePath();
    ctx.fillStyle = C.hair; ctx.fill();
    // 发丝高光
    ctx.save();
    ctx.globalAlpha *= 0.28;
    ctx.strokeStyle = '#FFF3E2'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-58, headY - 74);
    ctx.quadraticCurveTo(-20, headY - 96, 14, headY - 82);
    ctx.stroke();
    ctx.restore();

    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * 100, headY - 24);
      ctx.quadraticCurveTo(sx * 124 + swayX * sx, headY + 34, sx * 108 + swayX * 0.6, headY + 92);
      ctx.quadraticCurveTo(sx * 92, headY + 46, sx * 86, headY - 2);
      ctx.closePath();
      ctx.fillStyle = C.hair; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.stroke();
    }

    // 呆毛
    ctx.beginPath();
    ctx.moveTo(-2, headY - 106);
    ctx.bezierCurveTo(4 + swayX, headY - 160, 34 + swayX, headY - 174, 50 + swayX, headY - 144);
    ctx.bezierCurveTo(56 + swayX, headY - 128, 44 + swayX, headY - 122, 36 + swayX, headY - 130);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.stroke();
    ctx.strokeStyle = C.hair; ctx.lineWidth = 6; ctx.stroke();

    // 眼睛（眨眼用纵向缩放，不是逐帧切换形状）
    for (const sx of [-1, 1]) {
      const ex = sx * 39, ey = headY + 22;
      if (eyeOpen > 0.15) {
        ctx.save();
        ctx.translate(ex, ey);
        ctx.scale(1, eyeOpen);
        ctx.beginPath(); ctx.ellipse(0, 0, 12, 17, 0, 0, TAU);
        ctx.fillStyle = C.ink; ctx.fill();
        ctx.beginPath(); ctx.arc(-3, -6, 4.2, 0, TAU);
        ctx.fillStyle = '#FFFFFF'; ctx.fill();
        ctx.beginPath(); ctx.arc(3, 6, 2.2, 0, TAU);
        ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.moveTo(ex - 12, ey);
        ctx.quadraticCurveTo(ex, ey + 8, ex + 12, ey);
        ctx.strokeStyle = C.ink; ctx.lineWidth = 4.5; ctx.stroke();
      }
      // 眉
      ctx.beginPath();
      ctx.moveTo(ex - 12, ey - 28);
      ctx.quadraticCurveTo(ex, ey - 35, ex + 12, ey - 28);
      ctx.strokeStyle = u.rgba('#4E352A', 0.72); ctx.lineWidth = 4; ctx.stroke();
      // 腮红
      ctx.save();
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = '#F49494';
      ctx.beginPath(); ctx.ellipse(sx * 66, headY + 56, 20, 9, sx * 0.16, 0, TAU); ctx.fill();
      ctx.restore();
    }

    // 嘴：随幅度微笑
    const smile = u.clamp(0.5 + Math.sin(t * 1.4) * 0.1, 0.3, 0.8);
    ctx.beginPath();
    ctx.arc(0, headY + 52, 18, 0.18 + (1 - smile) * 0.15, Math.PI - 0.18 - (1 - smile) * 0.15);
    ctx.strokeStyle = '#A9545A'; ctx.lineWidth = 4.5; ctx.lineCap = 'round'; ctx.stroke();

    // 手在肩下时才压在身前（写字、撑伞这类动作）
    if (!armOverHead) drawFrontArm();

    ctx.restore();
  }

  function umbrella(ctx, wrist, t) {
    // 伞面固定在头顶（本地坐标原点 = 身体中轴），杆斜到手上：
    // 跟着手走会让伞偏到一边，头就淋雨了（第一版）
    const cx = 70, cy = -556;
    ctx.save();
    // 伞面
    ctx.beginPath();
    ctx.moveTo(cx - 132, cy);
    ctx.quadraticCurveTo(cx, cy - 166, cx + 132, cy);
    ctx.quadraticCurveTo(cx + 66, cy + 16, cx + 44, cy + 2);
    ctx.quadraticCurveTo(cx, cy + 18, cx - 44, cy + 2);
    ctx.quadraticCurveTo(cx - 66, cy + 16, cx - 132, cy);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, 0, cy - 110, 0, cy + 10, '#FFD9DE', '#F09AA6');
    ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();
    // 伞骨
    ctx.strokeStyle = u.rgba('#4A3328', 0.55); ctx.lineWidth = 3;
    for (const k of [-0.66, -0.33, 0, 0.33, 0.66]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 100);
      ctx.quadraticCurveTo(cx + k * 60, cy - 78, cx + k * 130, cy);
      ctx.stroke();
    }
    // 伞柄：从伞心斜到手腕
    ctx.beginPath();
    ctx.moveTo(cx, cy - 104); ctx.lineTo(wrist[0], wrist[1] + 4);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();
  }

  function paperBall(ctx, wrist) {
    ctx.save();
    ctx.translate(wrist[0], wrist[1] - 10);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const r = 22 + rnd(i + 3) * 6;
      const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.9;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#FFF8E8'; ctx.fill();
    ctx.strokeStyle = u.rgba('#6B5238', 0.7); ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  function pencil(ctx, wrist) {
    ctx.save();
    ctx.translate(wrist[0], wrist[1]);
    ctx.rotate(-0.62);
    ctx.fillStyle = '#F2A93B';
    ctx.fillRect(-6, -64, 12, 66);
    ctx.fillStyle = '#C98A2C';
    ctx.fillRect(-6, -64, 5, 66);
    ctx.beginPath();
    ctx.moveTo(-6, 2); ctx.lineTo(6, 2); ctx.lineTo(0, 18); ctx.closePath();
    ctx.fillStyle = '#F3D9B0'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-2.4, 12); ctx.lineTo(2.4, 12); ctx.lineTo(0, 18); ctx.closePath();
    ctx.fillStyle = '#4A3328'; ctx.fill();
    ctx.restore();
  }

  // ---------- 场景原语 ----------

  function sky(ctx, W, H, top, bottom) {
    ctx.fillStyle = vgrad(ctx, 0, 0, 0, H, top, bottom);
    ctx.fillRect(0, 0, W, H);
  }

  function sun(ctx, x, y, r, core, glow) {
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 5.2);
    g.addColorStop(0, u.rgba(glow, 0.55));
    g.addColorStop(0.35, u.rgba(glow, 0.18));
    g.addColorStop(1, u.rgba(glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 5.4, y - r * 5.4, r * 10.8, r * 10.8);
    // 本体：外缘不画硬边，否则逆光镜头会像贴了一枚奶油圆片
    const cg = ctx.createRadialGradient(x, y, r * 0.05, x, y, r);
    cg.addColorStop(0, '#FFFFFF');
    cg.addColorStop(0.32, core);
    cg.addColorStop(0.82, u.rgba(glow, 0.55));
    cg.addColorStop(1, u.rgba(glow, 0));
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = cg; ctx.fill();
  }

  function cloud(ctx, x, y, s, color, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, 108 * s, 44 * s, 0, 0, TAU);
    ctx.ellipse(x - 66 * s, y + 8 * s, 62 * s, 32 * s, 0, 0, TAU);
    ctx.ellipse(x + 70 * s, y + 6 * s, 70 * s, 34 * s, 0, 0, TAU);
    ctx.ellipse(x + 12 * s, y - 30 * s, 64 * s, 46 * s, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function building(ctx, x, y, w, h, color, winColor, seed, t) {
    ctx.fillStyle = color;
    rr(ctx, x, y - h, w, h, 8);
    ctx.fill();
    const cols = Math.max(2, Math.floor(w / 46));
    const rows = Math.max(2, Math.floor(h / 58));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = rnd(seed + r * 13 + c * 7);
        if (lit < 0.45) continue;
        const flick = 0.55 + 0.45 * Math.sin(t * 0.7 + r + c);
        ctx.save();
        ctx.globalAlpha *= 0.55 + flick * 0.35;
        ctx.fillStyle = winColor;
        ctx.fillRect(x + 14 + c * (w - 20) / cols, y - h + 18 + r * 56, 16, 20);
        ctx.restore();
      }
    }
  }

  function tree(ctx, x, y, s, trunk, leaf, leafDark) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.quadraticCurveTo(-8, -90, -10, -150);
    ctx.lineTo(10, -150);
    ctx.quadraticCurveTo(8, -90, 14, 0);
    ctx.closePath();
    ctx.fillStyle = trunk; ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -206, 118, 96, 0, 0, TAU);
    ctx.fillStyle = leafDark; ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-30, -226, 82, 74, 0, 0, TAU);
    ctx.ellipse(46, -212, 74, 66, 0, 0, TAU);
    ctx.fillStyle = leaf; ctx.fill();
    ctx.restore();
  }

  function wire(ctx, pts, color, w) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const sag = 34 + Math.abs(b[0] - a[0]) * 0.06;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + sag, b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  function ground(ctx, W, y, color, edge) {
    ctx.fillStyle = color;
    ctx.fillRect(0, y, W, 1080 - y);
    if (edge) {
      ctx.save();
      ctx.globalAlpha *= 0.5;
      ctx.strokeStyle = edge; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, y + 2); ctx.lineTo(W, y + 2); ctx.stroke();
      ctx.restore();
    }
  }

  // 草：三根一簇，seed 控制疏密与高度
  function grass(ctx, W, y, color, seed, n, alpha) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const x = rnd(seed + i * 3.7) * W;
      const h = 16 + rnd(seed + i * 9.1) * 28;
      const sway = Math.sin(i + x * 0.01) * 6;
      ctx.lineWidth = 2 + rnd(seed + i) * 2;
      ctx.beginPath();
      ctx.moveTo(x, y + 4);
      ctx.quadraticCurveTo(x + sway * 0.5, y - h * 0.6, x + sway, y - h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 光尘：确定性起点 + 时间漂移
  function motes(ctx, t, W, H, color, seed, n, dir) {
    ctx.save();
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const baseX = rnd(seed + i * 5.3) * W;
      const baseY = rnd(seed + i * 8.7) * H;
      const sp = 6 + rnd(seed + i * 2.1) * 16;
      const x = (baseX + t * sp * (dir || 1) * 0.6) % (W + 80) - 40;
      const y = baseY + Math.sin(t * 0.8 + i) * 22;
      const r = 1.6 + rnd(seed + i * 4.4) * 3.2;
      ctx.globalAlpha = 0.18 + rnd(seed + i * 6.6) * 0.4;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function paperPlane(ctx, x, y, rot, s, fill, ink) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(-30, 8); ctx.lineTo(30, -6); ctx.lineTo(-6, 26); ctx.lineTo(-8, 6);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 2.6; ctx.strokeStyle = u.rgba(ink, 0.75); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-30, 8); ctx.lineTo(-8, 6);
    ctx.strokeStyle = u.rgba(ink, 0.5); ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  function birds(ctx, t, x, y, s, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const bx = x + i * 74 * s, by = y + Math.sin(t * 0.9 + i) * 8 * s;
      const flap = 4 + Math.sin(t * 6 + i * 1.7) * 3;
      ctx.beginPath();
      ctx.moveTo(bx - 16 * s, by);
      ctx.quadraticCurveTo(bx - 8 * s, by - flap * s, bx, by);
      ctx.quadraticCurveTo(bx + 8 * s, by - flap * s, bx + 16 * s, by);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 静态颗粒：seed 固定 → 每帧同一张"胶片感"，不会闪
  function grain(ctx, W, H, alpha, seed) {
    ctx.save();
    ctx.fillStyle = '#000';
    for (let i = 0; i < 900; i++) {
      const x = rnd(seed + i * 1.37) * W;
      const y = rnd(seed + i * 2.71 + 9) * H;
      ctx.globalAlpha = alpha * (0.35 + rnd(seed + i * 3.3) * 0.65);
      ctx.fillRect(x, y, 1.6, 1.6);
    }
    ctx.restore();
  }

  function vignette(ctx, W, H, alpha) {
    const g = ctx.createRadialGradient(W / 2, H * 0.46, H * 0.34, W / 2, H * 0.5, H * 0.92);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(24,14,6,' + (alpha === undefined ? 0.24 : alpha) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---------- 文字层 ----------

  function tracked(ctx, str, cx, y, o) {
    const chars = Array.from(String(str));
    const size = o.size;
    const track = o.track === undefined ? 0 : o.track;
    ctx.font = (o.weight || 400) + ' ' + size + 'px ' + (o.family || FAM.sans);
    if (o.measureOnly) return ctx;
    const ws = chars.map((c) => ctx.measureText(c).width);
    const total = ws.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1);
    let x = o.align === 'center' ? cx - total / 2 : cx;
    // 以调用方的 globalAlpha 为基准做乘法：直接赋值会把外层淡出覆盖掉（大字层踩过）
    const base = ctx.globalAlpha * (o.alpha === undefined ? 1 : o.alpha);
    for (let i = 0; i < chars.length; i++) {
      ctx.globalAlpha = base * (o.alphaFor ? o.alphaFor(i / Math.max(1, chars.length - 1)) : 1);
      ctx.fillText(chars[i], x, y);
      x += ws[i] + track;
    }
    ctx.globalAlpha = base;
    return total;
  }

  // 底部歌词条：62px 楷体 + 6px 字距 + 两层投影（上游 recipe 的实测值）
  function lyricBar(ctx, W, H, line, style, t) {
    const st = style || {};
    const size = st.size || 62;
    const y = H - (st.bottom || 96);
    const o = u.vis(t, line.s, line.e, 0.25, 0.3);
    if (o <= 0) return;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(28,16,8,0.62)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = st.color || '#FFFFFF';
    tracked(ctx, line.zh, W / 2, y, {
      size, track: st.track === undefined ? 6 : st.track,
      family: st.family || FAM.kai, align: 'center', alpha: o,
    });
    ctx.restore();
  }

  // 手写纸条：奶油纸 + 阴影 + 一截胶带，40px 楷体
  function note(ctx, W, H, n, t) {
    const o = u.vis(t, n.s, n.e, 0.3, 0.3);
    if (o <= 0) return;
    const k = u.pop(t, n.s, 0.45);
    const size = n.size || 40;
    const padX = 30, padY = 22;
    const lines = String(n.text).split('\n');
    ctx.save();
    ctx.font = 400 + ' ' + size + 'px ' + FAM.kai;
    const wText = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width));
    const w = wText + padX * 2;
    const h = lines.length * size * 1.42 + padY * 2;
    const x = n.x === undefined ? 130 : n.x;
    const y = n.y === undefined ? 200 : n.y;
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(((n.rot === undefined ? -6 : n.rot) * Math.PI) / 180);
    ctx.scale(k, k);
    ctx.globalAlpha *= o;
    ctx.shadowColor = 'rgba(60,40,20,0.28)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#FFF9E8';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.shadowColor = 'transparent';
    // 胶带
    ctx.save();
    ctx.globalAlpha *= 0.55;
    ctx.fillStyle = '#EBD9B4';
    ctx.translate(0, -h / 2);
    ctx.rotate(0.03);
    ctx.fillRect(-38, -12, 76, 24);
    ctx.restore();
    ctx.fillStyle = '#3A2C20';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, -h / 2 + padY + size * 0.72 + i * size * 1.42);
    }
    ctx.restore();
  }

  // 关键词 3D 大字：10 层实心偏移 + 4px 描边 + 轻微摆动（上游 recipe）
  function bigWord(ctx, W, H, w, t) {
    const o = u.vis(t, w.s, w.e, 0.12, 0.3);
    if (o <= 0) return;
    const k = u.pop(t, w.s, 0.5);
    const size = w.size || 150;
    const rot = Math.sin((t - w.s) * 2.2) * 1.6;
    const x = w.x === undefined ? W / 2 : w.x;
    const y = w.y === undefined ? 190 : w.y;
    const track = 6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(k, k);
    ctx.globalAlpha *= o;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '400 ' + size + 'px ' + FAM.kuai;
    // 厚度：从远到近叠 10 层，远层先画
    for (let i = 10; i >= 1; i--) {
      ctx.fillStyle = '#5A2A08';
      tracked(ctx, w.text, 0, i, { size, track, family: FAM.kuai, align: 'center', measureOnly: false });
    }
    // 描边（外扩 4px）
    ctx.lineJoin = 'round';
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#7A3A0C';
    const chars = Array.from(String(w.text));
    const ws = chars.map((c) => ctx.measureText(c).width);
    const total = ws.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1);
    let cx0 = -total / 2;
    for (let i = 0; i < chars.length; i++) {
      ctx.strokeText(chars[i], cx0, 0);
      cx0 += ws[i] + track;
    }
    ctx.fillStyle = '#FFE28A';
    tracked(ctx, w.text, 0, 0, { size, track, family: FAM.kuai, align: 'center' });
    ctx.restore();
  }

  const MK = {
    T: C,
    u,
    rnd,
    rr,
    sky, sun, cloud, building, tree, wire, ground, grass, motes, paperPlane, birds, grain, vignette,
    chibi, umbrella, paperBall, pencil,
    lyricBar, note, bigWord, tracked, pickFont, FAM,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MK;
  else root.MK = MK;
})(typeof window !== 'undefined' ? window : this);
