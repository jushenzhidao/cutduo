// layouts.js · 9 个镜头（每个 = 一个场景 + 一个角色位）
//
// 版式结构借自上游 recipe：时长、顺序、情绪走向（暖橙 → 灰蓝 → 米 → 暖棕 → 冷灰 → 粉 → 纸 → 金 → 深金）。
// 但每一笔都是本仓自写：上游是把 Remotion 的 canvas 直接搬过去，这里是纯 Canvas2D 的场景重组。
//
// 每个版式签名一致：(ctx, W, H, t, dur, args, env)
//   t   = 镜头内秒数（从 0 开始）
//   args = {x, y, s, pose} 可选覆盖，缺省取镜头默认位
//   env = { T: 完整调色板, palette: 主题覆盖 }

(function (root) {
  'use strict';

  const L = {};
  const TAU = Math.PI * 2;

  // 缓慢推镜：1.00 → 1.05，焦点在人物胸口。硬切之间靠它区分"静态图"和"镜头"。
  function cam(ctx, t, dur, k, fx, fy) {
    const z = 1 + k * Math.min(1, t / Math.max(0.01, dur));
    ctx.translate(fx, fy);
    ctx.scale(z, z);
    ctx.translate(-fx, -fy);
  }

  function figOf(args, def) {
    const a = args || {};
    return {
      x: a.x === undefined ? def.x : a.x,
      y: a.y === undefined ? def.y : a.y,
      s: a.s === undefined ? def.s : a.s,
      pose: a.pose || def.pose,
    };
  }

  /* S1 · 街道（0–4.25）暖橙午后：招牌、电线、梧桐、浮尘 */
  L.street = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.045, (args && args.x) || 760, 620);
    MK.sky(ctx, W, H, '#FFE1B4', '#E8A159');
    MK.sun(ctx, 1548, 208, 64, '#FFF8DC', '#FFEDB4');

    // 远景楼群：低对比，靠一层雾拉开空间
    for (let i = 0; i < 5; i++) {
      MK.building(ctx, 980 + i * 190, 902, 168, 250 + (i % 3) * 46,
        u.mix('#E7A867', '#F0BE86', i / 5), '#FFF1C9', 11 + i, t);
    }
    ctx.save();
    const fog = ctx.createLinearGradient(760, 0, 1320, 0);
    fog.addColorStop(0, 'rgba(243,196,140,0)');
    fog.addColorStop(1, 'rgba(243,196,140,0.55)');
    ctx.fillStyle = fog;
    ctx.fillRect(700, 400, W - 700, 502);
    ctx.restore();

    MK.wire(ctx, [[-40, 232], [520, 268], [1140, 226], [1960, 262]], 'rgba(96,62,38,0.45)', 3);

    MK.tree(ctx, 168, 926, 1.2, '#8A5A38', '#D9924E', '#C0763C');
    MK.tree(ctx, 1880, 934, 1.05, '#8A5A38', '#D9924E', '#C0763C');

    MK.ground(ctx, W, 906, '#D3874B', '#B86F3A');
    // 路面亮带：太阳正对的那一段
    ctx.save();
    ctx.globalAlpha *= 0.5;
    const pool = ctx.createRadialGradient(1160, 1010, 40, 1160, 1010, 460);
    pool.addColorStop(0, 'rgba(255,224,174,0.55)');
    pool.addColorStop(1, 'rgba(255,224,174,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(640, 906, 1040, 174);
    ctx.restore();

    MK.grass(ctx, W, 1010, 'rgba(120,72,38,0.55)', 7, 60, 0.8);
    MK.motes(ctx, t, W, H, '#FFE9B8', 21, 46, 1);
    MK.chibi(ctx, t, figOf(args, { x: 760, y: 962, s: 1.08, pose: 'wave' }));
    MK.vignette(ctx, W, H, 0.2);
    MK.grain(ctx, W, H, 0.05, 5);
    ctx.restore();
  };

  /* S2 · 乌云（4.25–7.9）灰蓝：云压下来，雨斜着走 */
  L.cloud = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.03, 700, 640);
    MK.sky(ctx, W, H, '#CBD5E1', '#7B8CA0');

    for (let i = 0; i < 4; i++) {
      const sp = 12 + i * 9;
      const x = ((i * 520 + t * sp) % 2300) - 160;
      MK.cloud(ctx, x, 150 + i * 44, 1.15 + i * 0.12, u.rgba('#DCE4EE', 0.9), 0.85 - i * 0.12);
    }
    MK.cloud(ctx, 1280, 120, 1.5, 'rgba(150,164,182,0.9)', 0.55);
    MK.cloud(ctx, 300, 96, 1.7, 'rgba(146,160,178,0.8)', 0.5);

    // 雨：seed 固定，靠时间纵向平移；不逐帧重抽，否则整片会"闪"
    ctx.save();
    ctx.strokeStyle = 'rgba(232,240,248,0.55)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 110; i++) {
      const bx = MK.rnd(i * 2.3) * (W + 200) - 100;
      const sp = 520 + MK.rnd(i * 5.1) * 420;
      const y = (MK.rnd(i * 7.7) * H + t * sp) % (H + 120) - 60;
      const len = 26 + MK.rnd(i * 3.9) * 34;
      ctx.beginPath();
      ctx.moveTo(bx, y); ctx.lineTo(bx - 8, y + len);
      ctx.stroke();
    }
    ctx.restore();

    MK.ground(ctx, W, 936, '#8896A6', '#6B7887');
    // 水洼 + 反光
    ctx.save();
    ctx.fillStyle = 'rgba(206,220,234,0.55)';
    ctx.beginPath(); ctx.ellipse(1180, 1004, 230, 34, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha *= 0.5;
    ctx.fillStyle = '#F0F6FC';
    ctx.beginPath(); ctx.ellipse(1120, 998, 92, 10, 0, 0, TAU); ctx.fill();
    ctx.restore();

    MK.chibi(ctx, t, figOf(args, { x: 700, y: 962, s: 1.04, pose: 'umbrella' }));
    MK.vignette(ctx, W, H, 0.26);
    MK.grain(ctx, W, H, 0.055, 9);
    ctx.restore();
  };

  /* S3 · 房间（7.9–11.05）米色：窗、桌、纸堆，话写在纸上 */
  L.room = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.04, 1200, 620);
    MK.sky(ctx, W, H, '#F7F0E2', '#E2CEB2');

    // 窗：外框 + 天空 + 十字棂
    ctx.fillStyle = u.rgba('#B58B62', 0.25);
    ctx.fillRect(158, 128, 546, 512);
    ctx.fillStyle = '#FFFBF3';
    ctx.fillRect(176, 146, 510, 476);
    const gw = ctx.createLinearGradient(0, 146, 0, 622);
    gw.addColorStop(0, '#FFE7BE'); gw.addColorStop(1, '#F6C68C');
    ctx.fillStyle = gw;
    ctx.fillRect(190, 160, 482, 448);
    // 窗外远景：一条屋顶线 + 两棵树，窗才不像贴纸
    ctx.fillStyle = 'rgba(214,150,96,0.55)';
    ctx.beginPath();
    ctx.moveTo(190, 520); ctx.lineTo(300, 470); ctx.lineTo(420, 512);
    ctx.lineTo(520, 478); ctx.lineTo(672, 516); ctx.lineTo(672, 608); ctx.lineTo(190, 608);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(150,112,72,0.35)';
    ctx.beginPath(); ctx.arc(280, 470, 40, 0, TAU); ctx.arc(560, 452, 34, 0, TAU); ctx.fill();
    ctx.fillStyle = '#FFFBF3';
    ctx.fillRect(424, 160, 14, 448);
    ctx.fillRect(190, 372, 482, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(190, 160); ctx.lineTo(360, 160); ctx.lineTo(190, 470); ctx.closePath(); ctx.fill();

    // 窗帘
    ctx.fillStyle = 'rgba(240,220,190,0.85)';
    ctx.beginPath();
    ctx.moveTo(120, 112);
    ctx.bezierCurveTo(168, 240, 140, 420, 176, 660);
    ctx.lineTo(96, 700); ctx.lineTo(72, 120); ctx.closePath(); ctx.fill();

    MK.ground(ctx, W, 892, '#CBB093', '#AD8B67');
    // 地板缝：向消失点收，不用等距横线（会像百叶窗）
    ctx.save();
    ctx.strokeStyle = 'rgba(120,90,62,0.16)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const x = 120 + i * 300;
      ctx.beginPath();
      ctx.moveTo(x, 1080); ctx.lineTo(760 + (x - 760) * 0.35, 892);
      ctx.stroke();
    }
    ctx.restore();

    // 桌：桌面 + 两条腿
    ctx.fillStyle = '#D9B68C';
    ctx.fillRect(700, 786, 470, 34);
    ctx.fillStyle = '#C39C6F';
    ctx.fillRect(724, 820, 26, 166);
    ctx.fillRect(1120, 820, 26, 166);
    // 纸堆
    for (let i = 0; i < 5; i++) {
      ctx.save();
      ctx.translate(782, 780 - i * 12);
      ctx.rotate(-0.04 + i * 0.02);
      ctx.fillStyle = i % 2 ? '#FFFDF6' : '#FCF6E7';
      ctx.fillRect(0, 0, 138, 14);
      ctx.restore();
    }
    // 台灯
    ctx.strokeStyle = '#8A6A4A'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(1064, 786); ctx.lineTo(1064, 690); ctx.stroke();
    ctx.fillStyle = '#8A6A4A';
    ctx.beginPath(); ctx.ellipse(1064, 786, 30, 8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#F4B45E';
    ctx.beginPath();
    ctx.moveTo(1014, 692); ctx.lineTo(1114, 692); ctx.lineTo(1094, 636); ctx.lineTo(1034, 636);
    ctx.closePath(); ctx.fill();
    // 灯光
    ctx.save();
    ctx.globalAlpha *= 0.35;
    const lg = ctx.createRadialGradient(1064, 700, 10, 1064, 700, 210);
    lg.addColorStop(0, 'rgba(255,214,140,0.9)'); lg.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.arc(1064, 700, 210, 0, TAU); ctx.fill();
    ctx.restore();

    MK.motes(ctx, t, W, H, '#FFF2D0', 33, 34, 1);
    MK.chibi(ctx, t, figOf(args, { x: 1452, y: 958, s: 1.0, pose: 'hold' }));
    MK.vignette(ctx, W, H, 0.2);
    MK.grain(ctx, W, H, 0.05, 13);
    ctx.restore();
  };

  /* S4 · 公园（11.05–15.3）暖棕：长椅、树、纸团被丢出去 */
  L.park = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.042, 900, 640);
    MK.sky(ctx, W, H, '#FAD3A0', '#C87B3C');
    MK.sun(ctx, 1600, 330, 56, '#FFF3CE', '#FFD79B');

    MK.tree(ctx, 120, 906, 1.35, '#7E5133', '#C9803F', '#A9662F');
    MK.tree(ctx, 1806, 916, 1.2, '#7E5133', '#C9803F', '#A9662F');
    MK.ground(ctx, W, 884, '#B8783F', '#9A5F30');

    // 长椅
    ctx.fillStyle = '#8A5A36';
    ctx.fillRect(1360, 806, 250, 18);
    ctx.fillRect(1360, 838, 250, 18);
    ctx.fillRect(1372, 856, 16, 78);
    ctx.fillRect(1582, 856, 16, 78);
    ctx.fillStyle = '#7A4B2C';
    ctx.fillRect(1352, 770, 266, 16);

    // 纸团：抛物线飞出画面
    for (let i = 0; i < 3; i++) {
      const k = u.clamp((t - 0.45 - i * 0.85) / 1.9, 0, 1);
      if (k <= 0 || k >= 1) continue;
      const x = 1010 + k * 520;
      const y = 700 - Math.sin(k * Math.PI) * 330 + k * 150;
      ctx.save();
      ctx.globalAlpha *= 1 - k * 0.45;
      ctx.translate(x, y);
      ctx.rotate(k * 5 + i);
      ctx.beginPath();
      for (let j = 0; j < 8; j++) {
        const a = (j / 8) * TAU, r = 20 + MK.rnd(j + i) * 5;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#FFF8E8'; ctx.fill();
      ctx.strokeStyle = 'rgba(110,80,50,0.6)'; ctx.lineWidth = 2.5; ctx.stroke();
      // 两道折痕：不然就是一颗白蛋
      ctx.beginPath();
      ctx.moveTo(-12, -8); ctx.lineTo(4, 2); ctx.lineTo(-6, 12);
      ctx.moveTo(10, -10); ctx.lineTo(2, 6);
      ctx.strokeStyle = 'rgba(140,110,80,0.45)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }

    MK.grass(ctx, W, 1016, 'rgba(110,66,32,0.55)', 17, 70, 0.85);
    MK.motes(ctx, t, W, H, '#FFE2B4', 41, 30, 1);
    MK.chibi(ctx, t, figOf(args, { x: 880, y: 966, s: 1.02, pose: 'throw' }));
    MK.vignette(ctx, W, H, 0.22);
    MK.grain(ctx, W, H, 0.055, 17);
    ctx.restore();
  };

  /* S5 · 城市（15.3–19.8）冷灰：楼比人高，窗口亮着 */
  L.city = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.05, 1240, 640);
    MK.sky(ctx, W, H, '#A7B0BB', '#59616B');

    for (let i = 0; i < 6; i++) {
      const x = 60 + i * 320;
      const h = 430 + MK.rnd(i * 3.1) * 430;
      MK.building(ctx, x, 926, 250, h, u.mix('#6E7781', '#565E68', i / 6), '#FFE7AE', 31 + i, t);
    }
    // 近处一栋压前景，制造纵深（也要有窗，否则像一块挡板）
    MK.building(ctx, -80, 926, 300, 760, '#454D56', '#FFE7AE', 47, t);

    MK.wire(ctx, [[-20, 210], [560, 250], [1200, 208], [1960, 246]], 'rgba(40,46,54,0.5)', 3);
    MK.ground(ctx, W, 926, '#4B535C', '#3B424A');

    // 车灯拖影
    ctx.save();
    ctx.globalAlpha *= 0.5;
    ctx.fillStyle = '#FFE0A6';
    ctx.beginPath(); ctx.ellipse(300 + (t * 210) % 1400, 1010, 90, 6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#FFB4A0';
    ctx.beginPath(); ctx.ellipse(1700 - (t * 160) % 1400, 1042, 70, 5, 0, 0, TAU); ctx.fill();
    ctx.restore();

    MK.motes(ctx, t, W, H, '#E4EAF2', 51, 22, -1);
    MK.chibi(ctx, t, figOf(args, { x: 1330, y: 986, s: 0.84, pose: 'lookup' }));
    MK.vignette(ctx, W, H, 0.3);
    MK.grain(ctx, W, H, 0.06, 23);
    ctx.restore();
  };

  /* S6 · 山坡（19.8–23.75）粉：纸飞机从手里飞出去 */
  L.hill = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.038, 760, 640);
    MK.sky(ctx, W, H, '#FCD2E0', '#D887A3');
    MK.sun(ctx, 1520, 300, 58, '#FFF6E4', '#FFD9E4');

    // 远山 + 近坡
    ctx.fillStyle = u.rgba('#C9738F', 0.55);
    ctx.beginPath();
    ctx.moveTo(-40, 780);
    ctx.bezierCurveTo(360, 620, 760, 760, 1160, 700);
    ctx.bezierCurveTo(1460, 656, 1720, 720, 1960, 690);
    ctx.lineTo(1960, 1080); ctx.lineTo(-40, 1080); ctx.closePath(); ctx.fill();

    ctx.fillStyle = '#B8607E';
    ctx.beginPath();
    ctx.moveTo(-40, 900);
    ctx.bezierCurveTo(420, 806, 900, 906, 1280, 858);
    ctx.bezierCurveTo(1580, 820, 1780, 874, 1960, 852);
    ctx.lineTo(1960, 1080); ctx.lineTo(-40, 1080); ctx.closePath(); ctx.fill();

    // 纸飞机航线：一条二次贝塞尔 + 虚点尾迹
    const k = u.clamp((t - 0.4) / 3.0, 0, 1);
    const p0 = [968, 520], p1 = [1210, 300], p2 = [1760, 236];
    const bx = (kk) => (1 - kk) * (1 - kk) * p0[0] + 2 * (1 - kk) * kk * p1[0] + kk * kk * p2[0];
    const by = (kk) => (1 - kk) * (1 - kk) * p0[1] + 2 * (1 - kk) * kk * p1[1] + kk * kk * p2[1];
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 14; i++) {
      const kk = k * (i / 14);
      ctx.beginPath(); ctx.arc(bx(kk), by(kk), 3.2, 0, TAU); ctx.fill();
    }
    ctx.restore();
    const ang = Math.atan2(by(Math.min(1, k + 0.02)) - by(k), bx(Math.min(1, k + 0.02)) - bx(k)) || 0;
    MK.paperPlane(ctx, bx(k), by(k), ang, 1.25, '#FFFDF4', '#B8607E');

    MK.grass(ctx, W, 1018, 'rgba(140,64,90,0.6)', 29, 80, 0.85);
    MK.grass(ctx, W, 962, 'rgba(150,72,96,0.35)', 37, 70, 0.7);
    MK.motes(ctx, t, W, H, '#FFE6F0', 61, 34, 1);
    MK.chibi(ctx, t, figOf(args, { x: 700, y: 962, s: 1.06, pose: 'point' }));
    MK.vignette(ctx, W, H, 0.2);
    MK.grain(ctx, W, H, 0.05, 29);
    ctx.restore();
  };

  /* S7 · 纸面（23.75–26.55）纸白：横线、铅笔、一笔画完 */
  L.paper = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.035, 1180, 640);
    MK.sky(ctx, W, H, '#F8F1E4', '#E2D2B8');

    ctx.save();
    ctx.strokeStyle = 'rgba(126,102,70,0.16)';
    ctx.lineWidth = 2;
    for (let y = 130; y < H; y += 88) {
      ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W - 60, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(180,120,90,0.22)';
    ctx.beginPath(); ctx.moveTo(150, 60); ctx.lineTo(150, H - 40); ctx.stroke();
    ctx.restore();

    // 铅笔正在画的线：从 260 走到 1020，末端跟着手
    const prog = u.clamp((t - 0.5) / 2.0, 0, 1);
    ctx.save();
    ctx.strokeStyle = '#7A6A56';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const k = (i / 60) * prog;
      const x = 1236 - k * 936;
      const y = 706 + Math.sin(k * 7.2) * 24 - k * 54;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // 角落涂鸦：证明"这是纸，不是纯色"
    ctx.save();
    ctx.strokeStyle = 'rgba(126,102,70,0.35)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(1720, 210, 46 + i * 16, 0.3, 2.4);
      ctx.stroke();
    }
    ctx.restore();

    MK.chibi(ctx, t, figOf(args, { x: 1060, y: 958, s: 1.0, pose: 'draw' }));
    MK.vignette(ctx, W, H, 0.18);
    MK.grain(ctx, W, H, 0.045, 31);
    ctx.restore();
  };

  /* S8 · 金色傍晚（26.55–29.8）：逆光、草浪、飞机远了 */
  L.dusk = function (ctx, W, H, t, dur, args) {
    const MK = root.MK, u = MK.u;
    ctx.save();
    cam(ctx, t, dur, 0.04, 820, 640);
    MK.sky(ctx, W, H, '#FFE0AC', '#D2833F');
    MK.sun(ctx, 1430, 742, 146, '#FFF6D8', '#FFD08A');

    ctx.fillStyle = 'rgba(180,96,44,0.55)';
    ctx.beginPath();
    ctx.moveTo(-40, 820);
    ctx.bezierCurveTo(380, 742, 820, 830, 1240, 786);
    ctx.bezierCurveTo(1560, 752, 1780, 806, 1960, 780);
    ctx.lineTo(1960, 1080); ctx.lineTo(-40, 1080); ctx.closePath(); ctx.fill();

    MK.birds(ctx, t, 1180, 300, 0.9, 'rgba(96,52,24,0.55)');
    MK.paperPlane(ctx, 1620 - (t * 24) % 200, 372, -0.24, 0.9, '#FFF8E4', '#B96A34');

    MK.ground(ctx, W, 946, '#A85F2C', '#8B4A1F');
    // 草浪：两排，疏密不同
    MK.grass(ctx, W, 1006, 'rgba(120,60,24,0.55)', 71, 90, 0.9);
    MK.grass(ctx, W, 1044, 'rgba(92,44,16,0.6)', 73, 80, 0.9);

    MK.motes(ctx, t, W, H, '#FFEBC4', 83, 50, 1);
    MK.chibi(ctx, t, figOf(args, { x: 820, y: 962, s: 1.02, pose: 'shade' }));
    MK.vignette(ctx, W, H, 0.26);
    MK.grain(ctx, W, H, 0.055, 37);
    ctx.restore();
  };

  /* S9 · 结尾（29.8–33）深金：人退到左边，留出写纸条的地方 */
  L.final = function (ctx, W, H, t, dur, args) {
    const MK = root.MK;
    ctx.save();
    cam(ctx, t, dur, 0.05, 620, 640);
    MK.sky(ctx, W, H, '#FFE9C6', '#C9762F');
    MK.sun(ctx, 1310, 790, 168, '#FFFBEC', '#FFD89A');

    ctx.fillStyle = 'rgba(150,74,30,0.5)';
    ctx.beginPath();
    ctx.moveTo(-40, 852);
    ctx.bezierCurveTo(420, 786, 900, 862, 1320, 820);
    ctx.bezierCurveTo(1620, 792, 1800, 836, 1960, 812);
    ctx.lineTo(1960, 1080); ctx.lineTo(-40, 1080); ctx.closePath(); ctx.fill();
    MK.ground(ctx, W, 968, '#8E4A1E', '#723A16');

    MK.birds(ctx, t, 1420, 250, 0.72, 'rgba(94,46,16,0.45)');
    MK.grass(ctx, W, 1024, 'rgba(96,44,14,0.55)', 91, 70, 0.85);
    MK.motes(ctx, t, W, H, '#FFF0CE', 97, 44, 1);
    MK.chibi(ctx, t, figOf(args, { x: 520, y: 962, s: 1.04, pose: 'hands' }));
    MK.vignette(ctx, W, H, 0.24);
    MK.grain(ctx, W, H, 0.05, 41);
    ctx.restore();
  };

  root.L = L;

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
})(typeof window !== 'undefined' ? window : this);
