/* kit.js — 科普版式绘图原语与图标库
 * 全部为 canvas 2D 纯绘制：零外部资源、零网络、零随机（hash 决定"手绘抖动"）。
 * 坐标约定：1920×1080 绝对像素；图标在 0..1 归一化空间绘制后缩放。
 */
(function () {
  'use strict';
  const MK = (window.MK = window.MK || {});

  /* --------------------------------- 调色板 --------------------------------- */
  MK.T = {
    cream: '#FEFBEC',
    mint: '#B7EBD8',
    sky: '#A6DCEA',
    ink: '#2C3A3E',
    inkSoft: '#63767A',
    pop: '#FD2551',
    popDeep: '#B71339',
    sun: '#FFD84D',
    jade: '#26A38C',
    jadeDeep: '#0E7A5F',
    blue: '#2B7FD4',
    organ: '#F4A492',
    organDeep: '#DE7A66',
    white: '#FFFFFF',
  };

  // macOS 无 Yuanti（圆体需另行下载）⇒ 用苹方 + 同色描边膨胀（bolden）逼近卡通胖标题
  const FONT_ROUND = '"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif';
  const FONT_SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Heiti SC",sans-serif';

  // Skia 宿主（@napi-rs/canvas）不做 weight 合成，必须按字重映射到已注册的字体族。
  // 浏览器不注入 window.__FONTS 时，下面的 fontCss 输出与原来完全一致的字符串。
  // Skia 宿主（@napi-rs/canvas）不做 weight 合成，必须按字重+字号映射到已注册的字体族。
  // 映射依据是原设计的真实意图：PingFang 最粗只有 SemiBold，700 的"胖标题"靠 heavy 同色描边补重。
  //   - 大字号（>=64px）的 700+ → NotoSC Black，关闭 heavy 膨胀
  //   - 小字号的 700 → NotoSC Medium + 保留 heavy 膨胀（等价于原 Semibold+PAD）
  // 不注入 window.__FONTS 的浏览器环境，fontCss 输出与改动前逐字一致。
  const SKIA_FONTS = (typeof window !== 'undefined' && window.__FONTS) || null;
  function familyOf(size, weight, kind) {
    const w = Number(weight) || 700;
    const px = Math.round(size);
    if (SKIA_FONTS) {
      const black = w >= 800 || (w >= 700 && px >= 64);
      return { fam: black ? 'NotoSC Black' : (w >= 500 ? 'NotoSC Medium' : 'NotoSC Regular'), bold: black };
    }
    return { fam: kind === 'sans' ? FONT_SANS : FONT_ROUND, bold: false };
  }
  function fontCss(size, weight, kind, italic) {
    const px = Math.round(size);
    const f = familyOf(size, weight, kind);
    if (SKIA_FONTS) return `${italic ? 'italic ' : ''}${px}px "${f.fam}"`;
    return `${italic ? 'italic ' : ''}${Number(weight) || 700} ${px}px ${f.fam}`;
  }
  MK.fontCss = fontCss;

  /* --------------------------------- 工具 --------------------------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, v) => a + (b - a) * v;
  const ease = (v) => { v = clamp(v, 0, 1); return 1 - Math.pow(1 - v, 3); };
  const easeInOut = (v) => { v = clamp(v, 0, 1); return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2; };
  // 带一点回弹的入场（0→1 过冲到 1.08 再回落）
  const pop = (v) => {
    v = clamp(v, 0, 1);
    const c = 1.70158 * 1.15, c3 = c + 1;
    return 1 + c3 * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2);
  };
  const hash = (i) => { const s = Math.sin(i * 127.1 + 0.37) * 43758.5453; return s - Math.floor(s); };

  function rgba(hex, a) {
    const h = String(hex || '#ffffff').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function shade(hex, k) { // k<1 变暗，k>1 变亮
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    const f = (v) => clamp(Math.round(v * k), 0, 255);
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  MK.u = { clamp, lerp, ease, easeInOut, pop, hash, rgba, shade };

  /* -------------------------------- 路径原语 -------------------------------- */
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }
  MK.rrect = rrect;

  /* --------------------------------- 文字 --------------------------------- */
  // o: {size, weight, color, align, baseline, stroke, strokeColor, maxW, font, spacing, italic, alpha}
  function text(ctx, str, x, y, o) {
    o = o || {};
    const fam = o.font === 'sans' ? FONT_SANS : FONT_ROUND;
    let size = o.size || 48;
    const weight = o.weight || 700;
    const spacing = o.spacing || 0;
    const set = () => {
      ctx.font = fontCss(size, weight, o.font, o.italic);
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = o.baseline || 'alphabetic';
    };
    set();
    const chars = [...String(str)];
    const measure = () => chars.reduce((s, c) => s + ctx.measureText(c).width, 0) + spacing * (chars.length - 1);
    if (o.maxW) {
      const w = measure();
      if (w > o.maxW) { size = Math.max(12, Math.floor(size * o.maxW / w)); set(); }
    }
    ctx.save();
    if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
    // 手绘感：粗体卡通字加圆角连接
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const drawRun = (fn) => {
      let cx = x;
      if (o.align === 'center') cx = x - measure() / 2;
      else if (o.align === 'right') cx = x - measure();
      for (const ch of chars) {
        fn(ch, cx);
        cx += ctx.measureText(ch).width + spacing;
      }
    };
    if (o.stroke) {
      ctx.strokeStyle = o.strokeColor || MK.T.ink;
      ctx.lineWidth = o.stroke;
      drawRun((ch, cx) => ctx.strokeText(ch, cx, y));
    }
    // 实测：同色描边 > 2.2px 会把密集汉字（量 / 囊 / 鼻）的横缝糊死，变成实心方块
    const heavy = o.heavy !== undefined ? o.heavy
      : (!o.noHeavy && Number(weight) >= 700 && !familyOf(size, weight, o.font).bold ? Math.min(size * 0.05, 2.2) : 0);
    if (heavy > 0.4) {
      // 同色描边把字撑胖：苹方最粗只有 SemiBold，靠这层补到 Black 的视觉重量
      ctx.strokeStyle = o.color || MK.T.ink;
      ctx.lineWidth = heavy;
      drawRun((ch, cx) => ctx.strokeText(ch, cx, y));
    }
    ctx.fillStyle = o.color || MK.T.ink;
    drawRun((ch, cx) => ctx.fillText(ch, cx, y));
    ctx.restore();
    return measure();
  }
  MK.text = text;
  MK.measure = (ctx, str, size, weight, font) => {
    ctx.save();
    ctx.font = fontCss(size, weight || 700, font);
    const w = ctx.measureText(String(str)).width;
    ctx.restore();
    return w;
  };

  /* -------------------------------- 背景纸 -------------------------------- */
  // kind: cream（讲解位奶油底）| mint（青绿格子）| sky（蓝格子）| deep（深色，用于对比页）
  function paintPaper(ctx, W, H, kind, t) {
    const T = MK.T;
    if (kind === 'mint' || kind === 'sky') {
      const base = kind === 'mint' ? T.mint : T.sky;
      const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
      g.addColorStop(0, shade(base, 1.04));
      g.addColorStop(1, shade(base, 0.94));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const cell = 74;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.62)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= W; x += cell) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
      for (let y = 0; y <= H; y += cell) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
      ctx.stroke();
      ctx.strokeStyle = rgba(shade(base, 0.72), 0.28);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x += cell) { ctx.moveTo(x + 1.5, 0); ctx.lineTo(x + 1.5, H); }
      for (let y = 0; y <= H; y += cell) { ctx.moveTo(0, y + 1.5); ctx.lineTo(W, y + 1.5); }
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (kind === 'deep') {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#22323A'); g.addColorStop(0.6, '#1A272E'); g.addColorStop(1, '#131D22');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      return;
    }
    // cream：奶油底 + 暖色渐晕
    ctx.fillStyle = T.cream; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.74, H * 0.3, 0, W * 0.74, H * 0.3, W * 0.62);
    glow.addColorStop(0, rgba('#FFE9A8', 0.30));
    glow.addColorStop(1, rgba('#FFE9A8', 0));
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    const gl2 = ctx.createRadialGradient(W * 0.1, H * 0.86, 0, W * 0.1, H * 0.86, W * 0.4);
    gl2.addColorStop(0, rgba('#BFE6D6', 0.22));
    gl2.addColorStop(1, rgba('#BFE6D6', 0));
    ctx.fillStyle = gl2; ctx.fillRect(0, 0, W, H);
  }
  // 纸底是纯静态的（网格线 / 渐变都与时间无关）：Skia 宿主注入 __createCanvas 后
  // 缓存成离屏位图，每帧只做一次 drawImage。浏览器不注入，仍走原来的每帧重绘路径。
  const PAPER_CACHE = new Map();
  function paper(ctx, W, H, kind, t) {
    const mk = (typeof window !== 'undefined' && window.__createCanvas) || null;
    if (!mk) return paintPaper(ctx, W, H, kind, t);
    const key = kind + ':' + W + 'x' + H;
    let off = PAPER_CACHE.get(key);
    if (!off) {
      off = mk(W, H);
      paintPaper(off.getContext('2d'), W, H, kind, 0);
      PAPER_CACHE.set(key, off);
    }
    ctx.drawImage(off, 0, 0);
  }
  MK.paper = paper;

  /* ------------------------------ 卡通标签与贴纸 ------------------------------ */
  // 黄色斜切标签（参考片「超声耦合剂」）：黄底 + 蓝右斜边 + 深蓝字
  function tagSun(ctx, str, x, y, size, o) {
    o = o || {};
    const T = MK.T;
    const padX = size * 0.42, h = size * 1.42, skew = size * 0.30;
    ctx.save();
    ctx.font = fontCss(size, 700, undefined);
    const w = ctx.measureText(str).width + padX * 2;
    ctx.translate(x, y);
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    const s = o.scale === undefined ? 1 : o.scale;
    ctx.scale(s, s);
    // 蓝底斜切
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w - skew, h); ctx.lineTo(-skew, h); ctx.closePath();
    ctx.fillStyle = o.back || T.blue; ctx.fill();
    ctx.lineWidth = size * 0.14; ctx.strokeStyle = T.white; ctx.stroke();
    // 黄面
    ctx.beginPath();
    ctx.moveTo(skew * 0.55, size * 0.13); ctx.lineTo(w - skew * 0.35, size * 0.13);
    ctx.lineTo(w - skew * 1.15, h - size * 0.16); ctx.lineTo(-skew * 0.2, h - size * 0.16); ctx.closePath();
    ctx.fillStyle = o.fill || T.sun; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(x + skew * 0.4, y + h * 0.72);
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    if (o.scale !== undefined) ctx.scale(o.scale, o.scale);
    text(ctx, str, 0, 0, { size, weight: 700, color: o.color || '#1B5FB0', align: 'left' });
    ctx.restore();
    return w;
  }

  // 深绿梯形标题条（参考片「用途广泛」「安全无辐射」）
  function bannerJade(ctx, str, cx, y, size, o) {
    o = o || {};
    const T = MK.T;
    const padX = size * 1.05, h = size * 1.55, skew = size * 0.42;
    ctx.save();
    ctx.font = fontCss(size, 700, undefined);
    const w = Math.max(ctx.measureText(str).width + padX * 2, h * 2.6);
    ctx.translate(cx, y);
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    const s = o.scale === undefined ? 1 : o.scale;
    ctx.scale(s, s);
    // 白描边层（外扩）
    const bx = -w / 2, ow = size * 0.16;
    ctx.beginPath();
    ctx.moveTo(bx - ow + skew, -h / 2 - ow); ctx.lineTo(bx + w + ow, -h / 2 - ow);
    ctx.lineTo(bx + w + ow - skew, h / 2 + ow); ctx.lineTo(bx - ow, h / 2 + ow); ctx.closePath();
    ctx.fillStyle = T.white; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx + skew, -h / 2); ctx.lineTo(bx + w, -h / 2);
    ctx.lineTo(bx + w - skew, h / 2); ctx.lineTo(bx, h / 2); ctx.closePath();
    ctx.fillStyle = o.fill || T.jadeDeep; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(cx, y + h * 0.34);
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    if (o.scale !== undefined) ctx.scale(o.scale, o.scale);
    text(ctx, str, 0, 0, { size, weight: 700, color: T.white, align: 'center' });
    ctx.restore();
    return w;
  }

  // 手写感红字（参考片「发炎的阑尾」）：红字 + 白边 + 深红阴影
  function handText(ctx, str, x, y, size, o) {
    o = o || {};
    const T = MK.T;
    ctx.save();
    ctx.translate(x, y);
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    if (o.scale !== undefined) ctx.scale(o.scale, o.scale);
    text(ctx, str, size * 0.06, size * 0.06, {
      size, weight: 700, color: rgba('#7A1024', 0.35), align: 'center', stroke: size * 0.15, strokeColor: rgba('#7A1024', 0.35),
    });
    text(ctx, str, 0, 0, {
      size, weight: 700, color: o.color || T.pop, align: 'center',
      stroke: size * 0.12, strokeColor: o.strokeColor || T.white,
    });
    ctx.restore();
  }

  // 荧光笔划痕
  function marker(ctx, x1, y1, x2, y2, color, w) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(color, 0.34);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x1, y1 + w * 0.35);
    ctx.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + w * 0.5, x2, y2 + w * 0.2);
    ctx.stroke();
    ctx.strokeStyle = rgba(color, 0.20);
    ctx.lineWidth = w * 0.55;
    ctx.beginPath();
    ctx.moveTo(x1 + w * 0.3, y1 + w * 0.62);
    ctx.lineTo(x2 - w * 0.2, y2 + w * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // 爆炸贴（封面强调）
  function burst(ctx, cx, cy, R, o) {
    o = o || {};
    const T = MK.T;
    const spikes = o.spikes || 18;
    ctx.save();
    ctx.translate(cx, cy);
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    const pts = [];
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const outer = i % 2 === 0;
      const jitter = 1 + (hash(i) - 0.5) * (o.jitter === undefined ? 0.10 : o.jitter);
      const r = (outer ? R : R * (o.inner || 0.73)) * jitter;
      pts.push([Math.cos(a) * r, Math.sin(a) * r * (o.squash || 0.94)]);
    }
    const path = () => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    // 白色外描边（外扩 2 层，模拟贴纸白边）
    path(); ctx.strokeStyle = T.white; ctx.lineWidth = R * 0.055; ctx.lineJoin = 'round'; ctx.stroke();
    path(); ctx.strokeStyle = o.edge || T.popDeep; ctx.lineWidth = R * 0.03; ctx.stroke();
    path(); ctx.fillStyle = o.fill || T.pop; ctx.fill();
    ctx.restore();
  }
  MK.burst = burst; MK.tagSun = tagSun; MK.bannerJade = bannerJade; MK.handText = handText; MK.marker = marker;

  /* --------------------------------- 圆环卡 --------------------------------- */
  // 参考片「圆形放大图解」/「黄底圆形图标卡」
  function ringCard(ctx, cx, cy, r, o) {
    o = o || {};
    const T = MK.T;
    ctx.save();
    if (o.shadow !== false) {
      ctx.beginPath(); ctx.arc(cx, cy + r * 0.06, r * 1.04, 0, Math.PI * 2);
      ctx.fillStyle = rgba('#1C3A34', 0.10); ctx.fill();
    }
    // 外绿环
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = o.ring || T.white; ctx.fill();
    if (o.ring2) {
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.965, 0, Math.PI * 2);
      ctx.fillStyle = o.ring2; ctx.fill();
    }
    // 内圆
    ctx.beginPath(); ctx.arc(cx, cy, r * (o.innerRatio || 0.86), 0, Math.PI * 2);
    ctx.fillStyle = o.fill || T.sun; ctx.fill();
    // 虚线圈
    if (o.dash !== false) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((o.spin || 0));
      ctx.beginPath(); ctx.arc(0, 0, r * 1.1, 0, Math.PI * 2);
      ctx.setLineDash([r * 0.10, r * 0.075]);
      ctx.lineWidth = r * 0.035; ctx.strokeStyle = o.dashColor || rgba(T.white, 0.9);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    return r * (o.innerRatio || 0.86);
  }
  MK.ringCard = ringCard;

  /* --------------------------------- 图标库 --------------------------------- */
  // 所有图标：以 (0,0)-(1,1) 为界，`s` 缩放后绘制
  const ICON = {};

  function organFill(ctx, c1, c2) {
    const g = ctx.createLinearGradient(0, 0, 0.6, 1);
    g.addColorStop(0, c1 || MK.T.organ);
    g.addColorStop(1, c2 || MK.T.organDeep);
    return g;
  }
  // 拟人化眼睛（参考片器官带表情）
  function eyes(ctx, x1, x2, y, r) {
    [[x1], [x2]].forEach(([x]) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = r * 0.22; ctx.strokeStyle = '#4A2B26'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x + r * 0.18, y + r * 0.06, r * 0.44, 0, Math.PI * 2); ctx.fillStyle = '#3A2320'; ctx.fill();
      ctx.beginPath(); ctx.arc(x + r * 0.34, y - r * 0.24, r * 0.14, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    });
  }

  // 结肠（大肠）：粗管倒 U + 分节 + 盲肠/阑尾 + 中心小肠；实心方块不像肠，必须用管
  ICON.gut = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    const g = ctx.createLinearGradient(0.1, 0.1, 0.9, 0.9);
    g.addColorStop(0, '#F8B6A4'); g.addColorStop(1, '#E08270');
    const flow = () => {
      ctx.beginPath();
      ctx.moveTo(0.26, 0.88);
      ctx.bezierCurveTo(0.15, 0.80, 0.15, 0.34, 0.26, 0.24);
      ctx.bezierCurveTo(0.36, 0.14, 0.64, 0.14, 0.74, 0.24);
      ctx.bezierCurveTo(0.85, 0.34, 0.85, 0.80, 0.74, 0.88);
    };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    flow(); ctx.lineWidth = 0.215; ctx.strokeStyle = '#C25E4C'; ctx.stroke();
    flow(); ctx.lineWidth = 0.175; ctx.strokeStyle = g; ctx.stroke();
    // 结肠袋：沿管横向分节
    ctx.strokeStyle = 'rgba(194,94,76,0.5)'; ctx.lineWidth = 0.016;
    for (let i = 0; i < 4; i++) {
      const y = 0.36 + i * 0.135;
      [-1, 1].forEach((d) => {
        ctx.beginPath();
        ctx.moveTo(0.5 + d * 0.245, y);
        ctx.lineTo(0.5 + d * 0.345, y + 0.03);
        ctx.stroke();
      });
    }
    for (let i = 0; i < 3; i++) {
      const x = 0.34 + i * 0.16;
      ctx.beginPath(); ctx.moveTo(x, 0.14); ctx.lineTo(x + 0.02, 0.24); ctx.stroke();
    }
    // 盲肠 + 阑尾
    ctx.beginPath(); ctx.arc(0.26, 0.86, 0.115, 0, Math.PI * 2);
    ctx.fillStyle = '#E88C7A'; ctx.fill();
    ctx.lineWidth = 0.022; ctx.strokeStyle = '#C25E4C'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0.30, 0.94);
    ctx.bezierCurveTo(0.33, 1.02, 0.26, 1.06, 0.20, 1.02);
    ctx.lineWidth = 0.062; ctx.strokeStyle = '#F2A492'; ctx.stroke();
    ctx.lineWidth = 0.02; ctx.strokeStyle = '#C25E4C'; ctx.stroke();
    // 小肠（中心波浪盘绕）
    ctx.beginPath();
    ctx.moveTo(0.40, 0.30);
    for (let i = 0; i < 6; i++) {
      const yy = 0.38 + i * 0.075;
      ctx.quadraticCurveTo(i % 2 ? 0.36 : 0.64, yy + 0.03, 0.5, yy + 0.075);
    }
    ctx.lineWidth = 0.082; ctx.strokeStyle = '#F7C0B0'; ctx.stroke();
    ctx.lineWidth = 0.018; ctx.strokeStyle = 'rgba(194,94,76,0.45)'; ctx.stroke();
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.ellipse(0.24, 0.44, 0.035, 0.075, -0.15, 0, Math.PI * 2); ctx.fill();
    if (o.mark) {
      ctx.beginPath(); ctx.arc(o.mark[0], o.mark[1], 0.058, 0, Math.PI * 2);
      ctx.fillStyle = '#FFE04D'; ctx.fill();
      ctx.lineWidth = 0.02; ctx.strokeStyle = '#C25E4C'; ctx.stroke();
    }
    if (o.eyes) eyes(ctx, 0.42, 0.58, 0.215, 0.048);
    ctx.restore();
  };

  ICON.stomach = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0.34, 0.10);
    ctx.bezierCurveTo(0.26, 0.16, 0.24, 0.34, 0.30, 0.50);
    ctx.bezierCurveTo(0.36, 0.68, 0.50, 0.86, 0.64, 0.84);
    ctx.bezierCurveTo(0.80, 0.82, 0.86, 0.66, 0.80, 0.52);
    ctx.bezierCurveTo(0.74, 0.38, 0.58, 0.34, 0.52, 0.26);
    ctx.bezierCurveTo(0.48, 0.20, 0.50, 0.12, 0.44, 0.09);
    ctx.closePath();
    ctx.fillStyle = organFill(ctx); ctx.fill();
    ctx.lineWidth = 0.035; ctx.strokeStyle = '#C25E4C'; ctx.stroke();
    // 食道
    ctx.beginPath(); ctx.moveTo(0.42, 0.10); ctx.quadraticCurveTo(0.44, 0.02, 0.52, 0.02);
    ctx.lineWidth = 0.075; ctx.strokeStyle = '#F0A08C'; ctx.lineCap = 'round'; ctx.stroke();
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.ellipse(0.44, 0.46, 0.07, 0.11, 0.3, 0, Math.PI * 2); ctx.fill();
    if (o.eyes) eyes(ctx, 0.50, 0.68, 0.50, 0.05);
    ctx.restore();
  };

  ICON.gallbladder = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    // 胆囊（梨形）
    ctx.beginPath();
    ctx.moveTo(0.44, 0.20);
    ctx.bezierCurveTo(0.66, 0.22, 0.76, 0.42, 0.68, 0.62);
    ctx.bezierCurveTo(0.62, 0.78, 0.46, 0.86, 0.38, 0.72);
    ctx.bezierCurveTo(0.30, 0.56, 0.32, 0.34, 0.44, 0.20);
    ctx.closePath();
    ctx.fillStyle = organFill(ctx, '#9FD8C0', '#5FAE92'); ctx.fill();
    ctx.lineWidth = 0.032; ctx.strokeStyle = '#3F8B72'; ctx.stroke();
    // 胆管
    ctx.beginPath(); ctx.moveTo(0.44, 0.20);
    ctx.bezierCurveTo(0.40, 0.10, 0.34, 0.06, 0.26, 0.04);
    ctx.lineWidth = 0.045; ctx.strokeStyle = '#6FBF9F'; ctx.lineCap = 'round'; ctx.stroke();
    if (o.stone) {
      ctx.beginPath(); ctx.arc(0.55, 0.55, 0.075, 0, Math.PI * 2);
      ctx.fillStyle = '#FFE04D'; ctx.fill(); ctx.lineWidth = 0.02; ctx.strokeStyle = '#C79500'; ctx.stroke();
    }
    ctx.restore();
  };

  ICON.appendix = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    const g = ctx.createLinearGradient(0.3, 0.1, 0.3, 0.95);
    g.addColorStop(0, '#F6B2A2'); g.addColorStop(1, o.inflamed ? '#EE6A5A' : '#E2917E');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 阑尾本体：从盲肠根部向下弯出
    const tube = () => {
      ctx.beginPath();
      ctx.moveTo(0.60, 0.20);
      ctx.bezierCurveTo(0.58, 0.40, 0.50, 0.52, 0.42, 0.62);
      ctx.bezierCurveTo(0.36, 0.70, 0.34, 0.80, 0.38, 0.88);
    };
    tube(); ctx.lineWidth = 0.20; ctx.strokeStyle = '#C2594A'; ctx.stroke();
    tube(); ctx.lineWidth = 0.145; ctx.strokeStyle = g; ctx.stroke();
    // 末端球头（炎症处更红）
    ctx.beginPath(); ctx.arc(0.385, 0.885, 0.105, 0, Math.PI * 2);
    ctx.fillStyle = o.inflamed ? '#E85B4B' : '#E2917E'; ctx.fill();
    ctx.lineWidth = 0.022; ctx.strokeStyle = '#B84A3C'; ctx.stroke();
    // 根部（盲肠）
    ctx.beginPath(); ctx.arc(0.60, 0.185, 0.135, 0, Math.PI * 2);
    ctx.fillStyle = '#F1A08C'; ctx.fill();
    ctx.lineWidth = 0.024; ctx.strokeStyle = '#B84A3C'; ctx.stroke();
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(0.535, 0.40, 0.028, 0.055, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  ICON.kidney = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0.50, 0.08);
    ctx.bezierCurveTo(0.80, 0.06, 0.88, 0.40, 0.74, 0.66);
    ctx.bezierCurveTo(0.64, 0.86, 0.36, 0.92, 0.32, 0.74);
    ctx.bezierCurveTo(0.28, 0.58, 0.44, 0.52, 0.42, 0.40);
    ctx.bezierCurveTo(0.40, 0.24, 0.34, 0.10, 0.50, 0.08);
    ctx.closePath();
    ctx.fillStyle = organFill(ctx, '#E88C7A', '#C25E4C'); ctx.fill();
    ctx.lineWidth = 0.032; ctx.strokeStyle = '#A34A3C'; ctx.stroke();
    // 肾盂
    ctx.beginPath(); ctx.moveTo(0.50, 0.40); ctx.quadraticCurveTo(0.40, 0.50, 0.50, 0.62);
    ctx.lineWidth = 0.05; ctx.strokeStyle = '#F7D2C6'; ctx.stroke();
    if (o.stone) {
      ctx.beginPath(); ctx.arc(0.56, 0.34, 0.07, 0, Math.PI * 2);
      ctx.fillStyle = '#FFE04D'; ctx.fill(); ctx.lineWidth = 0.018; ctx.strokeStyle = '#C79500'; ctx.stroke();
    }
    ctx.restore();
  };

  ICON.uterus = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0.34, 0.30);
    ctx.bezierCurveTo(0.42, 0.44, 0.42, 0.66, 0.50, 0.82);
    ctx.bezierCurveTo(0.58, 0.66, 0.58, 0.44, 0.66, 0.30);
    ctx.bezierCurveTo(0.60, 0.24, 0.54, 0.28, 0.50, 0.34);
    ctx.bezierCurveTo(0.46, 0.28, 0.40, 0.24, 0.34, 0.30);
    ctx.closePath();
    ctx.fillStyle = organFill(ctx, '#F5A0A8', '#D96A78'); ctx.fill();
    ctx.lineWidth = 0.03; ctx.strokeStyle = '#B04C5C'; ctx.stroke();
    // 两侧输卵管
    [[0.34, 0.30, 0.16, 0.18], [0.66, 0.30, 0.84, 0.18]].forEach(([x1, y1, x2, y2]) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo((x1 + x2) / 2, y1 - 0.08, x2, y2);
      ctx.lineWidth = 0.055; ctx.strokeStyle = '#F08C96'; ctx.lineCap = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x2, y2, 0.06, 0, Math.PI * 2); ctx.fillStyle = '#F08C96'; ctx.fill();
    });
    ctx.restore();
  };

  // 肠套叠：一段肠管套进另一段
  ICON.intussusception = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    // 外层
    ctx.beginPath(); ctx.moveTo(0.08, 0.30); ctx.lineTo(0.52, 0.30);
    ctx.quadraticCurveTo(0.60, 0.30, 0.60, 0.42);
    ctx.lineTo(0.60, 0.58); ctx.quadraticCurveTo(0.60, 0.70, 0.52, 0.70);
    ctx.lineTo(0.08, 0.70);
    ctx.lineWidth = 0.16; ctx.strokeStyle = '#F2A492'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.lineWidth = 0.13; ctx.strokeStyle = '#F7B6A6'; ctx.stroke();
    // 内层（套入）
    ctx.beginPath(); ctx.moveTo(0.92, 0.36); ctx.lineTo(0.56, 0.36);
    ctx.quadraticCurveTo(0.46, 0.36, 0.46, 0.50);
    ctx.quadraticCurveTo(0.46, 0.64, 0.56, 0.64); ctx.lineTo(0.92, 0.64);
    ctx.lineWidth = 0.13; ctx.strokeStyle = '#E88C7A'; ctx.stroke();
    // 套入端
    ctx.beginPath(); ctx.arc(0.46, 0.50, 0.075, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD84D'; ctx.fill(); ctx.lineWidth = 0.02; ctx.strokeStyle = '#C25E4C'; ctx.stroke();
    ctx.restore();
  };

  // 超声探头
  ICON.probe = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    const g = ctx.createLinearGradient(0, 0.2, 0, 1);
    g.addColorStop(0, '#F2F4F5'); g.addColorStop(0.5, '#D5DBDE'); g.addColorStop(1, '#B7C0C4');
    ctx.beginPath();
    ctx.moveTo(0.30, 0.06); ctx.lineTo(0.70, 0.06);
    ctx.quadraticCurveTo(0.74, 0.06, 0.74, 0.12);
    ctx.lineTo(0.74, 0.40);
    ctx.quadraticCurveTo(0.74, 0.52, 0.64, 0.56);
    ctx.lineTo(0.64, 0.78);
    ctx.quadraticCurveTo(0.64, 0.92, 0.50, 0.92);
    ctx.quadraticCurveTo(0.36, 0.92, 0.36, 0.78);
    ctx.lineTo(0.36, 0.56);
    ctx.quadraticCurveTo(0.26, 0.52, 0.26, 0.40);
    ctx.lineTo(0.26, 0.12);
    ctx.quadraticCurveTo(0.26, 0.06, 0.30, 0.06);
    ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 0.022; ctx.strokeStyle = '#8C9AA0'; ctx.stroke();
    // 阵元面
    ctx.beginPath(); ctx.moveTo(0.36, 0.86); ctx.quadraticCurveTo(0.50, 0.94, 0.64, 0.86);
    ctx.lineWidth = 0.04; ctx.strokeStyle = '#5D6A70'; ctx.stroke();
    // 线缆
    ctx.beginPath(); ctx.moveTo(0.50, 0.06); ctx.quadraticCurveTo(0.55, -0.06, 0.80, -0.02);
    ctx.lineWidth = 0.035; ctx.strokeStyle = '#9AA6AB'; ctx.stroke();
    ctx.restore();
  };

  // 超声机
  ICON.scanner = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    // 机身
    ctx.fillStyle = '#EEF1F2';
    MK.rrect(ctx, 0.10, 0.30, 0.56, 0.62, 0.05); ctx.fill();
    ctx.lineWidth = 0.02; ctx.strokeStyle = '#9AA6AB'; ctx.stroke();
    // 屏幕
    ctx.fillStyle = '#33424A';
    MK.rrect(ctx, 0.15, 0.35, 0.46, 0.34, 0.03); ctx.fill();
    // 屏内超声图
    ctx.save();
    MK.rrect(ctx, 0.15, 0.35, 0.46, 0.34, 0.03); ctx.clip();
    ctx.fillStyle = 'rgba(180,220,235,0.35)';
    ctx.beginPath(); ctx.moveTo(0.38, 0.35); ctx.lineTo(0.18, 0.69); ctx.lineTo(0.58, 0.69); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(0.38, 0.55, 0.07, 0.10, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // 控制面板
    ctx.fillStyle = '#DDE2E4';
    MK.rrect(ctx, 0.15, 0.72, 0.46, 0.10, 0.02); ctx.fill();
    ['#9AA6AB', '#9AA6AB', '#9AA6AB'].forEach((c, i) => {
      ctx.beginPath(); ctx.arc(0.22 + i * 0.06, 0.77, 0.014, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    });
    // 探头支架
    ctx.fillStyle = '#C9D0D3';
    MK.rrect(ctx, 0.66, 0.46, 0.06, 0.16, 0.02); ctx.fill();
    ctx.save(); ctx.translate(0.62, 0.30); ICON.probe(ctx, 0.14, {}); ctx.restore();
    // 底座
    ctx.fillStyle = '#C9D0D3';
    MK.rrect(ctx, 0.24, 0.90, 0.30, 0.06, 0.02); ctx.fill();
    ctx.restore();
  };

  // X 光片（对比页）：深色片基 + 脊柱 + 肋骨，一眼可辨
  ICON.xray = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.save();
    ctx.shadowColor = 'rgba(20,50,60,0.18)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    MK.rrect(ctx, 0.16, 0.04, 0.68, 0.92, 0.07);
    ctx.fillStyle = '#2E4149'; ctx.fill();
    ctx.restore();
    ctx.save();
    MK.rrect(ctx, 0.16, 0.04, 0.68, 0.92, 0.07); ctx.clip();
    // 片基渐层
    const g = ctx.createLinearGradient(0, 0, 0, 1);
    g.addColorStop(0, 'rgba(120,190,215,0.30)'); g.addColorStop(1, 'rgba(60,110,135,0.22)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1, 1);
    // 脊柱
    ctx.strokeStyle = '#E8F4F8'; ctx.lineCap = 'round';
    ctx.lineWidth = 0.055;
    ctx.beginPath(); ctx.moveTo(0.5, 0.14); ctx.lineTo(0.5, 0.78); ctx.stroke();
    ctx.fillStyle = '#E8F4F8';
    for (let i = 0; i < 7; i++) {
      MK.rrect(ctx, 0.455, 0.16 + i * 0.088, 0.09, 0.055, 0.02); ctx.fill();
    }
    // 肋骨
    ctx.strokeStyle = 'rgba(232,244,248,0.85)'; ctx.lineWidth = 0.026;
    for (let i = 0; i < 5; i++) {
      const y = 0.20 + i * 0.092, sp = 0.055 + i * 0.012;
      [-1, 1].forEach((d) => {
        ctx.beginPath();
        ctx.moveTo(0.5, y);
        ctx.quadraticCurveTo(0.5 + d * sp * 2.4, y + 0.012, 0.5 + d * sp * 3.6, y + 0.085);
        ctx.stroke();
      });
    }
    // 骨盆
    ctx.beginPath();
    ctx.moveTo(0.30, 0.76); ctx.quadraticCurveTo(0.5, 0.94, 0.70, 0.76);
    ctx.lineWidth = 0.045; ctx.strokeStyle = 'rgba(232,244,248,0.9)'; ctx.stroke();
    ctx.restore();
    // 辐射角标
    ctx.beginPath(); ctx.arc(0.79, 0.19, 0.115, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD84D'; ctx.fill();
    ctx.lineWidth = 0.018; ctx.strokeStyle = '#3A2A00'; ctx.stroke();
    ctx.fillStyle = '#3A2A00';
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
      ctx.beginPath(); ctx.moveTo(0.79, 0.19);
      ctx.arc(0.79, 0.19, 0.082, a - 0.42, a + 0.42); ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0.79, 0.19, 0.026, 0, Math.PI * 2); ctx.fillStyle = '#FFD84D'; ctx.fill();
    ctx.restore();
  };

  ICON.drop = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0.50, 0.04);
    ctx.bezierCurveTo(0.50, 0.04, 0.20, 0.42, 0.20, 0.60);
    ctx.bezierCurveTo(0.20, 0.78, 0.34, 0.92, 0.50, 0.92);
    ctx.bezierCurveTo(0.66, 0.92, 0.80, 0.78, 0.80, 0.60);
    ctx.bezierCurveTo(0.80, 0.42, 0.50, 0.04, 0.50, 0.04);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0.1, 0, 1);
    g.addColorStop(0, o.c1 || '#7BE0C0'); g.addColorStop(1, o.c2 || '#2BB48C');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 0.025; ctx.strokeStyle = '#1B8A6B'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.ellipse(0.41, 0.58, 0.06, 0.10, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  ICON.shield = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0.50, 0.06); ctx.lineTo(0.86, 0.20);
    ctx.quadraticCurveTo(0.88, 0.62, 0.50, 0.94);
    ctx.quadraticCurveTo(0.12, 0.62, 0.14, 0.20);
    ctx.closePath();
    ctx.fillStyle = '#4FD1A5'; ctx.fill();
    ctx.lineWidth = 0.03; ctx.strokeStyle = '#1B8A6B'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.32, 0.50); ctx.lineTo(0.45, 0.64); ctx.lineTo(0.70, 0.34);
    ctx.lineWidth = 0.075; ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  };

  ICON.clock = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath(); ctx.arc(0.5, 0.5, 0.42, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 0.06; ctx.strokeStyle = '#2B7FD4'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.5, 0.5); ctx.lineTo(0.5, 0.26);
    ctx.moveTo(0.5, 0.5); ctx.lineTo(0.68, 0.58);
    ctx.lineWidth = 0.055; ctx.strokeStyle = '#2B7FD4'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();
  };

  ICON.radiation = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath(); ctx.arc(0.5, 0.5, 0.40, 0, Math.PI * 2); ctx.fillStyle = '#FFE04D'; ctx.fill();
    ctx.fillStyle = '#3A2A00';
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
      ctx.beginPath(); ctx.moveTo(0.5, 0.5);
      ctx.arc(0.5, 0.5, 0.30, a - 0.44, a + 0.44); ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0.5, 0.5, 0.10, 0, Math.PI * 2); ctx.fillStyle = '#FFE04D'; ctx.fill();
    ctx.restore();
  };

  ICON.check = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.beginPath(); ctx.moveTo(0.18, 0.52); ctx.lineTo(0.42, 0.76); ctx.lineTo(0.84, 0.24);
    ctx.lineWidth = 0.13; ctx.strokeStyle = '#26A38C'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  };

  ICON.child = (ctx, s, o) => {
    o = o || {};
    ctx.save(); ctx.scale(s, s);
    // 头
    ctx.beginPath(); ctx.arc(0.5, 0.28, 0.20, 0, Math.PI * 2);
    ctx.fillStyle = o.skin || '#FBD3BC'; ctx.fill();
    ctx.lineWidth = 0.02; ctx.strokeStyle = '#D9A188'; ctx.stroke();
    // 头发
    ctx.beginPath(); ctx.arc(0.5, 0.26, 0.205, Math.PI * 1.05, Math.PI * 1.95);
    ctx.lineWidth = 0.09; ctx.strokeStyle = o.hair || '#5A3B2E'; ctx.lineCap = 'round'; ctx.stroke();
    // 眼睛（哭）
    eyes(ctx, 0.43, 0.57, 0.29, 0.035);
    // 泪
    ctx.beginPath(); ctx.ellipse(0.38, 0.37, 0.022, 0.035, 0, 0, Math.PI * 2); ctx.fillStyle = '#8FD8F5'; ctx.fill();
    // 身体
    ctx.beginPath();
    ctx.moveTo(0.32, 0.92); ctx.lineTo(0.34, 0.58);
    ctx.quadraticCurveTo(0.5, 0.48, 0.66, 0.58);
    ctx.lineTo(0.68, 0.92);
    ctx.closePath();
    ctx.fillStyle = o.cloth || '#FF9EC0'; ctx.fill();
    ctx.lineWidth = 0.02; ctx.strokeStyle = '#E07AA0'; ctx.stroke();
    ctx.restore();
  };

  ICON.question = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    ctx.lineWidth = 0.22; ctx.strokeStyle = '#FFB300'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(0.26, 0.28);
    ctx.bezierCurveTo(0.26, 0.06, 0.76, 0.04, 0.74, 0.32);
    ctx.bezierCurveTo(0.72, 0.54, 0.50, 0.52, 0.50, 0.72);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0.50, 0.90, 0.07, 0, Math.PI * 2); ctx.fillStyle = '#FFB300'; ctx.fill();
    ctx.restore();
  };

  ICON.eyes = (ctx, s) => {
    ctx.save(); ctx.scale(s, s);
    [[0.28, 0.5], [0.72, 0.5]].forEach(([x, y]) => {
      ctx.beginPath(); ctx.ellipse(x, y, 0.20, 0.26, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 0.035; ctx.strokeStyle = '#3A2320'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x + 0.02, y + 0.04, 0.11, 0, Math.PI * 2); ctx.fillStyle = '#3A2320'; ctx.fill();
      ctx.beginPath(); ctx.arc(x + 0.07, y - 0.05, 0.035, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    });
    ctx.restore();
  };

  MK.icon = function (name, ctx, x, y, size, o) {
    const fn = ICON[name];
    if (!fn) return false;
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    fn(ctx, size, o || {});
    ctx.restore();
    return true;
  };
  MK.ICON = ICON;

  /* -------------------------------- 声波 / 箭头 -------------------------------- */
  MK.soundWave = function (ctx, x, y, dir, t, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir >= 0 ? 1 : -1, 1);
    for (let i = 0; i < 3; i++) {
      const ph = (t * 1.6 + i * 0.33) % 1;
      ctx.beginPath();
      ctx.arc(0, 0, 30 + i * 26 + ph * 12, -0.55, 0.55);
      ctx.lineWidth = 9 - i * 1.6;
      ctx.strokeStyle = rgba(color || '#39B7E8', (1 - ph) * 0.85);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
  };

  MK.arrow = function (ctx, x1, y1, x2, y2, color, w) {
    w = w || 14;
    const a = Math.atan2(y2 - y1, x2 - x1);
    const head = w * 2.2;
    ctx.save();
    ctx.strokeStyle = color || MK.T.pop;
    ctx.fillStyle = color || MK.T.pop;
    ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - Math.cos(a) * head * 0.8, y2 - Math.sin(a) * head * 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(a - 0.45) * head, y2 - Math.sin(a - 0.45) * head);
    ctx.lineTo(x2 - Math.cos(a + 0.45) * head, y2 - Math.sin(a + 0.45) * head);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };

  /* --------------------------------- 角标 --------------------------------- */
  // 参考片左下角品牌角标：卡通 IP + 品牌字
  MK.cornerBadge = function (ctx, W, H, brand, alpha) {
    if (!brand || brand.show === false) return;
    const T = MK.T;
    ctx.save();
    ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
    const x = 58, y = H - 238;
    // 圆形 IP
    ctx.beginPath(); ctx.arc(x + 52, y + 52, 50, 0, Math.PI * 2);
    ctx.fillStyle = '#EAF7F2'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = T.jade; ctx.stroke();
    ctx.save(); ctx.translate(x + 52, y + 52 + 6);
    ICON.drop(ctx, 62, { c1: '#8FE8CB', c2: '#2BB48C' });
    ctx.restore();
    MK.text(ctx, String(brand.text || ''), x + 118, y + 44,
      { size: 30, weight: 700, color: T.ink, font: 'sans' });
    if (brand.tag) {
      MK.text(ctx, String(brand.tag), x + 118, y + 82,
        { size: 21, weight: 500, color: rgba(T.ink, 0.55), font: 'sans' });
    }
    ctx.restore();
  };

  /* -------------------------------- 3D 道具 -------------------------------- */
  // 与人物同一套 flux-3-image 生成的软胶材质；index.html 的 <img data-prop> 会被内联成 dataURL
  const PROPS = (window.__MK_PROPS = window.__MK_PROPS || {});
  function collectProps() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('img[data-prop]').forEach((el) => { PROPS[el.dataset.prop] = el; });
  }
  collectProps();

  // 口型贴片：与人物同一构图的嘴部差异图（闭→半开→大张），只在变化区域有 alpha
  const MOUTHS = (window.__MK_MOUTHS = window.__MK_MOUTHS || {});
  if (typeof document !== 'undefined') {
    document.querySelectorAll('img[data-mouth]').forEach((el) => { MOUTHS[el.dataset.mouth] = el; });
  }

  // 返回 true 表示画了图；false 时调用方回退到矢量图标
  MK.prop = function (name, ctx, x, y, size) {
    if (!name) return false;
    const im = PROPS[name];
    if (!im || !im.complete || !im.naturalWidth) return false;
    ctx.save();
    ctx.drawImage(im, x - size / 2, y - size / 2, size, size);
    ctx.restore();
    return true;
  };
  MK.hasProp = (name) => !!(name && PROPS[name] && PROPS[name].complete && PROPS[name].naturalWidth);

  /* ------------------------------- 会动的人物 ------------------------------- */
  // 分层骨骼：躯干（呼吸）→ 手臂（手势）→ 颈头（点头/摇头/眨眼/口型）
  // o.mouth 0..1 控制口型开合，o.armL/R 0..1 控制抬手，o.nod -1..1 点头，o.shake -1..1 摇头
  MK.figure = function (ctx, o) {
    const T = MK.T;
    const U = (o.scale === undefined ? 1 : o.scale);
    const skin = o.skin || '#FBD3BC';
    const hair = o.hair || '#4A342C';
    const coat = o.coat || '#C9703A';
    const t = o.t || 0;
    const breath = o.breathe === false ? 0 : Math.sin(t * 1.15) * 3.2;
    const blinkPhase = (t + (o.blinkSeed || 0)) % 3.9;
    const blink = blinkPhase < 0.14 ? Math.abs(Math.cos((blinkPhase / 0.14) * Math.PI)) : 1;
    const eyeY = 1 - (1 - blink) * 0.86;
    const mouth = clamp(o.mouth || 0, 0, 1);
    const headRot = (o.nod || 0) * 0.17 + (o.shake || 0) * 0.11 + Math.sin(t * 0.7) * 0.008;
    const look = (o.look || 0) * 7;

    ctx.save();
    ctx.translate(o.cx, o.baseY);
    ctx.scale(U, U);

    // 背景光晕
    const g = ctx.createRadialGradient(0, -420, 0, 0, -420, 340);
    g.addColorStop(0, rgba(T.sun, 0.26)); g.addColorStop(1, rgba(T.sun, 0));
    ctx.fillStyle = g; ctx.fillRect(-360, -780, 720, 780);

    ctx.translate(0, breath);

    // ---- 手臂（先画，被身体压住，只露外侧）----
    // 不用旋转：旋转会把手臂转到身体背后或穿过画面。直接算肩→手的端点，用曲线连接。
    const arm = (side, k) => {
      const sx = side * 126, sy = -366;
      const hx = sx + side * (12 + k * 104);
      const hy = sy + 188 - k * 236;
      const qx = sx + side * (34 + k * 44), qy = sy + 96 - k * 58;
      const gArm = ctx.createLinearGradient(sx, sy, hx, hy);
      gArm.addColorStop(0, shade(coat, 1.06));
      gArm.addColorStop(0.55, coat);
      gArm.addColorStop(1, shade(coat, 0.84));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, hx, hy);
      ctx.lineWidth = 52; ctx.lineCap = 'round'; ctx.strokeStyle = '#8A4A22'; ctx.stroke();
      ctx.lineWidth = 42; ctx.strokeStyle = gArm; ctx.stroke();
      // 袖口
      ctx.beginPath(); ctx.arc(hx, hy, 24, 0, Math.PI * 2);
      ctx.fillStyle = '#FBF6EE'; ctx.fill();
      // 手
      ctx.beginPath(); ctx.ellipse(hx + side * 9, hy + 34, 23, 26, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#EFC1A8'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(180,120,90,0.45)'; ctx.stroke();
    };
    arm(-1, clamp(o.armL || 0, 0, 1));
    arm(1, clamp(o.armR || 0, 0, 1));

    // ---- 躯干 ----
    ctx.beginPath();
    ctx.moveTo(-206, 0);
    ctx.bezierCurveTo(-204, -252, -168, -368, -98, -404);
    ctx.quadraticCurveTo(0, -426, 98, -404);
    ctx.bezierCurveTo(168, -368, 204, -252, 206, 0);
    ctx.closePath();
    const gt = ctx.createLinearGradient(-120, -430, 120, 0);
    gt.addColorStop(0, shade(coat, 1.08)); gt.addColorStop(1, shade(coat, 0.92));
    ctx.fillStyle = gt; ctx.fill();
    // 白衬衫 V 领
    ctx.beginPath();
    ctx.moveTo(-92, -404); ctx.lineTo(0, -272); ctx.lineTo(92, -404);
    ctx.quadraticCurveTo(0, -380, -92, -404);
    ctx.closePath(); ctx.fillStyle = '#FBF6EE'; ctx.fill();
    // 翻领
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(120,64,32,0.5)';
    ctx.beginPath(); ctx.moveTo(-92, -404); ctx.lineTo(-28, -276);
    ctx.moveTo(92, -404); ctx.lineTo(28, -276); ctx.stroke();
    // 下摆
    ctx.beginPath(); ctx.moveTo(-164, -132); ctx.quadraticCurveTo(0, -104, 164, -132);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(120,64,32,0.26)'; ctx.stroke();

    // ---- 颈 + 头（绕脖根旋转）----
    ctx.save();
    ctx.translate(0, -432);
    ctx.rotate(headRot);
    ctx.translate(0, 432);
    // 脖子
    ctx.beginPath(); MK.rrect(ctx, -40, -486, 80, 96, 26); ctx.fillStyle = '#EFC1A8'; ctx.fill();
    // 头发后层
    ctx.beginPath(); ctx.ellipse(0, -586, 150, 176, 0, 0, Math.PI * 2); ctx.fillStyle = hair; ctx.fill();
    // 脸
    ctx.beginPath(); ctx.ellipse(0, -580, 108, 126, 0, 0, Math.PI * 2); ctx.fillStyle = skin; ctx.fill();
    // 刘海
    ctx.beginPath();
    ctx.moveTo(-124, -624);
    ctx.bezierCurveTo(-120, -740, 120, -740, 124, -624);
    ctx.bezierCurveTo(96, -676, 52, -700, 0, -698);
    ctx.bezierCurveTo(-52, -700, -96, -676, -124, -624);
    ctx.closePath(); ctx.fillStyle = hair; ctx.fill();
    // 眼睛（眨眼前后压扁）
    [-46, 46].forEach((dx) => {
      ctx.save();
      ctx.translate(dx + look, -592);
      ctx.scale(1, eyeY);
      ctx.beginPath(); ctx.ellipse(0, 0, 15, 18, 0, 0, Math.PI * 2); ctx.fillStyle = '#3A2A22'; ctx.fill();
      if (eyeY > 0.4) { ctx.beginPath(); ctx.arc(5, -6, 5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
      ctx.restore();
    });
    // 眉毛
    ctx.strokeStyle = hair; ctx.lineWidth = 7; ctx.lineCap = 'round';
    [-46, 46].forEach((dx) => {
      ctx.beginPath(); ctx.moveTo(dx - 20 + look, -630); ctx.quadraticCurveTo(dx + look, -640, dx + 20 + look, -630); ctx.stroke();
    });
    // 嘴：口型开合
    const mh = 2.2 + mouth * 8.6;
    const mw = 17 - mouth * 2.5;
    ctx.beginPath();
    ctx.ellipse(0, -530 + mouth * 4, mw, mh, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#8E3F33'; ctx.fill();
    if (mouth > 0.1) {
      ctx.beginPath(); ctx.ellipse(0, -527 + mouth * 4, mw * 0.55, mh * 0.38, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(235,145,145,0.8)'; ctx.fill();
    }
    // 上唇
    ctx.beginPath();
    ctx.moveTo(-mw, -532 + mouth * 2); ctx.quadraticCurveTo(0, -538 + mouth * 2, mw, -532 + mouth * 2);
    ctx.lineWidth = 4; ctx.strokeStyle = '#B5603F'; ctx.lineCap = 'round'; ctx.stroke();
    // 腮红
    [-76, 76].forEach((dx) => {
      ctx.beginPath(); ctx.ellipse(dx, -548, 24, 15, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(240,140,120,0.32)'; ctx.fill();
    });
    // 听诊器（随头轻摆）
    ctx.beginPath();
    ctx.moveTo(-52, -398);
    ctx.bezierCurveTo(-84, -312, -42, -262, 10, -268);
    ctx.lineWidth = 9; ctx.strokeStyle = '#3C4A4E'; ctx.stroke();
    ctx.beginPath(); ctx.arc(20, -270, 17, 0, Math.PI * 2); ctx.fillStyle = '#3C4A4E'; ctx.fill();
    ctx.restore();

    ctx.restore();
  };

  /* --------------------------------- 字幕 --------------------------------- */
  // 参考片字幕：居中、白字、粗黑描边、位于底部安全区内
  // 字幕折行：优先在标点处断（取最靠近中点且两行都放得下的），否则按字数均分。
  // 目的：长句不要一路缩字号——62px 缩到 30 多 px，手机上直接不可读。
  const CAP_PUNCT = '，、：；。！？—,.;:!?';
  function wrapCaption(ctx, text, maxW, size, weight, font) {
    const m = (str) => MK.measure(ctx, str, size, weight, font);
    if (m(text) <= maxW) return [text];
    const chars = [...text];
    let best = -1;
    for (let i = 1; i < chars.length; i++) {
      if (!CAP_PUNCT.includes(chars[i - 1])) continue;
      const a = chars.slice(0, i).join(''), b = chars.slice(i).join('');
      if (m(a) <= maxW && m(b) <= maxW) {
        if (best < 0 || Math.abs(i - chars.length / 2) < Math.abs(best - chars.length / 2)) best = i;
      }
    }
    if (best > 0) return [chars.slice(0, best).join(''), chars.slice(best).join('')];
    const half = Math.ceil(chars.length / 2);
    return [chars.slice(0, half).join(''), chars.slice(half).join('')];
  }

  MK.caption = function (ctx, W, H, cap, style, t) {
    if (!cap || !cap.text) return;
    const s = style || {};
    const maxW = W - 260;
    const weight = s.weight || 700;
    const font = s.font || 'sans';
    let size = s.size || 62;
    let lines = String(cap.text).split('\n').filter((x) => String(x).trim());

    if (lines.length === 1) {
      const wrapped = wrapCaption(ctx, lines[0], maxW, size, weight, font);
      if (wrapped.length > 1) lines = wrapped;
    }
    // 两行必须统一字号：逐行各自套 maxW 会缩出两种大小，观感是"一句话里字忽大忽小"
    if (lines.length > 1) size = Math.min(size, 50);   // 折行本身就意味着信息密度高，先降一档
    const widest = Math.max(...lines.map((ln) => MK.measure(ctx, ln, size, weight, font)));
    if (widest > maxW) size = Math.max(44, Math.floor(size * maxW / widest));

    // 折行后字幕块会向上长高，不能顶进正文区。
    // 注意要按**视觉顶端**（基线 − 0.78em 的字形高）判，直接拿基线判会差出约 45px。
    const gap = size * (lines.length > 1 ? 1.22 : 1.32);
    let y = s.y || H - 78;
    const floor = H * 0.88;
    const visualTop = y - (lines.length - 1) * gap - size * 0.78;
    if (visualTop < floor) y += floor - visualTop;

    lines.forEach((ln, i) => {
      MK.text(ctx, ln, W / 2, y - (lines.length - 1 - i) * gap, {
        size,
        weight,
        color: s.color || '#FFFFFF',
        align: 'center',
        stroke: s.stroke === undefined ? size * 0.19 : s.stroke,
        strokeColor: s.strokeColor || '#1B2B30',
        font,
        maxW,
      });
    });
  };
})();
