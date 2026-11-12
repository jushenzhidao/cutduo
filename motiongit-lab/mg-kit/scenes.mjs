/**
 * mg-kit · MG 动画验证场景（纯 Skia Canvas 2D，无浏览器、无生成式模型）
 *
 * 设计不变量：renderFrame(t) 是纯函数。所有粒子、转子、节拍、网格形变都由 t
 * 解析求出，不依赖上一帧状态 —— 这样任意帧可独立 seek，8 个 worker 分片
 * 渲染也不会在分片边界出现跳变。
 *
 * 与 skia-kit/paper.mjs 的关系：只复用字体注册约定，不复用版式。
 * 这里的 5 个镜头专门覆盖微信文章《Fotor Agent 用代码写视频》里的动效类型。
 */
const W = 1920;
const H = 1080;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const pr = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - clamp(x), 3);
const eo4 = (x) => 1 - Math.pow(1 - clamp(x), 4);
const eio = (x) => { const q = clamp(x); return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; };
const lerp = (a, b, k) => a + (b - a) * k;
/** 固定种子 hash：噪点、星点、粒子初相都靠它，保证逐帧确定性。 */
const hash = (i, j = 0, s = 0) => {
  const x = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453;
  return x - Math.floor(x);
};

const F = {
  black: '"NotoSC Black", "PingFang SC", sans-serif',
  med: '"NotoSC Medium", "PingFang SC", sans-serif',
  reg: '"NotoSC Regular", "PingFang SC", sans-serif',
  mono: '"Menlo", "SF Mono", monospace',
};

function font(size, family = F.med) { return `${size}px ${family}`; }
function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function label(c, text, x, y, size, color, family = F.mono, align = 'left') {
  c.font = font(size, family);
  c.fillStyle = color;
  c.textAlign = align;
  c.fillText(text, x, y);
  c.textAlign = 'left';
}
/** 逐字遮罩揭示：整行照常按最终坐标画，用 clip 宽度控制露出的比例。 */
function revealLine(c, segments, x, y, p, size, family) {
  c.save();
  c.font = font(size, family);
  let total = 0;
  for (const s of segments) total += c.measureText(s.text).width;
  const ew = total * eo4(p);
  c.beginPath(); c.rect(x - 4, y - size * 1.15, ew + 8, size * 1.5); c.clip();
  let cx = x;
  for (const s of segments) {
    c.fillStyle = s.color;
    c.fillText(s.text, cx, y);
    cx += c.measureText(s.text).width;
  }
  c.restore();
  return total;
}

/* ───────────────────────── 镜头 1 · 文字动效 ───────────────────────── */
function intro(t, s) {
  const c = CTX, p = t - s.t0;
  c.fillStyle = '#F6F5EF'; c.fillRect(0, 0, W, H);
  // 纸面细点 + 极淡网格
  for (let i = 0; i < 46; i++) for (let j = 0; j < 26; j++) {
    const a = hash(i, j) * 0.055;
    if (a < 0.012) continue;
    c.fillStyle = `rgba(22,40,28,${a})`;
    c.fillRect(60 + i * 40, 60 + j * 40, 1.6, 1.6);
  }
  const GREEN = '#1E8A66', INK = '#16231B', SUB = '#7C8679';
  // 顶部标签
  label(c, 'MOTION GRAPHICS   /   01 — 文字动效', 142, 122, 24, GREEN);
  c.strokeStyle = 'rgba(22,40,28,0.14)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(142, 152); c.lineTo(W - 142, 152); c.stroke();

  // 主标题：逐字揭示 + 强调色
  c.save();
  c.globalAlpha = eo(pr(p, 0.05, 0.5));
  c.translate(0, 26 * (1 - eo(pr(p, 0.05, 0.6))));
  revealLine(c, [
    { text: '大白话 · 讲透 ', color: INK },
    { text: '硬核', color: GREEN },
    { text: ' AI', color: INK },
  ], 142, 400, pr(p, 0.22, 1.55), 116, F.black);
  c.restore();
  // 强调词下划线生长
  const uw = pr(p, 1.15, 2.05);
  c.fillStyle = GREEN;
  c.fillRect(142 + 116 * 6.30, 424, 236 * eo(uw), 8);

  c.save();
  c.globalAlpha = eo(pr(p, 0.85, 1.6));
  c.translate(0, 20 * (1 - eo(pr(p, 0.85, 1.7))));
  label(c, '「北茗的 AI 茶馆」', 142, 535, 60, '#4A574C', F.reg);
  c.restore();

  // 右上几何：旋转方框 + 同心圆（纯代码 MG 原语）
  const gx = 1560, gy = 400, rot = p * 0.42;
  c.save(); c.translate(gx, gy); c.rotate(rot);
  c.strokeStyle = 'rgba(30,138,102,0.55)'; c.lineWidth = 3;
  c.strokeRect(-105, -105, 210, 210);
  c.restore();
  for (let k = 0; k < 3; k++) {
    c.beginPath(); c.arc(gx, gy, 38 + k * 42, 0, Math.PI * 2);
    c.strokeStyle = `rgba(22,40,28,${0.22 - k * 0.05})`; c.lineWidth = 2; c.stroke();
  }
  c.beginPath(); c.arc(gx, gy, 7, 0, Math.PI * 2); c.fillStyle = GREEN; c.fill();
  // 公转光点：落版后仍保持逐帧可见的连续运动
  for (let k = 0; k < 3; k++) {
    const a = t * (1.5 + k * 0.55) + k * 2.1;
    c.fillStyle = k === 1 ? 'rgba(164,71,47,0.85)' : 'rgba(30,138,102,0.80)';
    c.beginPath(); c.arc(gx + Math.cos(a) * (150 + k * 14), gy + Math.sin(a) * (150 + k * 14), 7 - k, 0, Math.PI * 2); c.fill();
  }
  label(c, 'TYPE / GRID / TIME', gx, gy + 200, 20, SUB, F.mono, 'center');

  // 底部说明 + 生长线
  const lw = eo(pr(p, 1.5, 2.6));
  c.fillStyle = GREEN; c.fillRect(142, 700, 620 * lw, 3);
  c.save(); c.globalAlpha = eo(pr(p, 1.7, 2.5));
  label(c, '文字 · 图形 · 时间轴 —— 全部由代码逐帧定义', 142, 760, 30, '#4A574C', F.reg);
  c.restore();
  label(c, 'NO MODEL / NO GLITCH / DETERMINISTIC', 142, 830, 20, SUB, F.mono);
}

/* ───────────────── 镜头 2 · 复古档案 / 时间轴 / 转子 ───────────────── */
function archive(t, s) {
  const c = CTX, p = t - s.t0;
  const PAPER = '#E7DDC4', INK = '#3B2D20', OLIVE = '#7A6A3A', RED = '#A4472F';
  c.fillStyle = PAPER; c.fillRect(0, 0, W, H);
  // 做旧斑点（确定性）
  for (let i = 0; i < 90; i++) {
    const x = hash(i, 1) * W, y = hash(i, 2) * H, r = 2 + hash(i, 3) * 16;
    c.fillStyle = `rgba(90,66,38,${0.015 + hash(i, 4) * 0.045})`;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  // 暗角
  const vg = c.createRadialGradient(W / 2, H / 2, 260, W / 2, H / 2, 1100);
  vg.addColorStop(0, 'rgba(60,42,22,0)'); vg.addColorStop(1, 'rgba(60,42,22,0.34)');
  c.fillStyle = vg; c.fillRect(0, 0, W, H);

  label(c, 'CASE 01   /   人物传记', 150, 108, 22, OLIVE);
  // 打字机标题
  const title = 'ALAN TURING   1912 — 1954';
  const n = Math.floor(eo(pr(p, 0.15, 1.35)) * title.length);
  label(c, title.slice(0, n), 150, 190, 58, INK, F.black);
  if (p < 1.5 && Math.floor(p * 3) % 2 === 0) { c.fillStyle = INK; c.fillRect(150 + c.measureText(title.slice(0, n)).width + 6, 148, 5, 52); }
  label(c, '档案编号 T-1936 / COMPUTABLE NUMBERS', 150, 232, 20, OLIVE);

  // 档案照片卡（程序化剪影，不使用外部人像素材）
  c.save();
  const cardIn = eo4(pr(p, 0.3, 1.1));
  c.globalAlpha = cardIn;
  c.translate(150 + (1 - cardIn) * -55, 288 + (1 - cardIn) * 34);
  c.rotate(-0.045);
  c.fillStyle = 'rgba(50,36,20,0.22)'; rr(c, 12, 14, 452, 470, 6); c.fill();
  c.fillStyle = '#F6F0DE'; rr(c, 0, 0, 452, 470, 6); c.fill();
  c.strokeStyle = 'rgba(59,45,32,0.3)'; c.lineWidth = 1.5; rr(c, 14, 14, 424, 442, 3); c.stroke();
  // 照片区：半色调网点 + 头肩剪影
  const px = 28, py = 28, pw = 396, ph = 320;
  c.fillStyle = '#C9BFA4'; c.fillRect(px, py, pw, ph);
  for (let i = 0; i < 30; i++) for (let j = 0; j < 24; j++) {
    const r = 1 + hash(i, j, 7) * 2.2;
    c.fillStyle = `rgba(70,56,38,${0.08 + hash(i, j, 9) * 0.22})`;
    c.beginPath(); c.arc(px + 8 + i * 13.2, py + 8 + j * 13.2, r, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = '#4A3B2A';
  c.beginPath(); c.ellipse(px + pw / 2, py + 148, 76, 96, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(px + pw / 2 - 158, py + ph);
  c.quadraticCurveTo(px + pw / 2 - 130, py + 224, px + pw / 2, py + 218);
  c.quadraticCurveTo(px + pw / 2 + 130, py + 224, px + pw / 2 + 158, py + ph);
  c.closePath(); c.fill();
  c.fillStyle = 'rgba(246,240,222,0.13)'; c.fillRect(px, py, pw, ph);
  label(c, 'FIG. 01  /  BLETCHLEY PARK, 1943', 28, 396, 19, INK, F.mono);
  label(c, '档案照片 · 由几何与网点程序化生成', 28, 428, 18, OLIVE, F.reg);
  c.restore();

  // Enigma 转子：三圈独立转速，全部由 t 直接求角度
  const rx = 1550, ry = 350, R = 162;
  c.save(); c.translate(rx, ry);
  c.strokeStyle = 'rgba(59,45,32,0.22)'; c.lineWidth = 1;
  c.beginPath(); c.arc(0, 0, R + 18, 0, Math.PI * 2); c.stroke();
  const rings = [
    { r: R, speed: 0.42, n: 26, col: 'rgba(59,45,32,0.78)', w: 2 },
    { r: R * 0.70, speed: -0.67, n: 20, col: 'rgba(122,106,58,0.85)', w: 2 },
    { r: R * 0.40, speed: 1.05, n: 14, col: 'rgba(164,71,47,0.85)', w: 2 },
  ];
  for (let k = 0; k < rings.length; k++) {
    const g = rings[k];
    c.save(); c.rotate(p * g.speed);
    c.strokeStyle = g.col; c.lineWidth = g.w;
    c.beginPath(); c.arc(0, 0, g.r, 0, Math.PI * 2); c.stroke();
    for (let i = 0; i < g.n; i++) {
      const a = (i / g.n) * Math.PI * 2;
      c.beginPath();
      c.moveTo(Math.cos(a) * (g.r - 12), Math.sin(a) * (g.r - 12));
      c.lineTo(Math.cos(a) * (g.r + 12), Math.sin(a) * (g.r + 12));
      c.stroke();
    }
    c.restore();
  }
  c.fillStyle = INK; c.beginPath(); c.arc(0, 0, 12, 0, Math.PI * 2); c.fill();
  c.strokeStyle = RED; c.lineWidth = 3;
  c.beginPath(); c.moveTo(0, -R - 26); c.lineTo(0, -R + 4); c.stroke();
  c.restore();
  label(c, 'ENIGMA / ROTORS', rx, ry + R + 56, 20, OLIVE, F.mono, 'center');
  label(c, '三转子 · 差速旋转', rx, ry + R + 86, 19, INK, F.reg, 'center');

  // 推进时间轴：连线按进度生长，节点逐个点亮
  const ax0 = 190, ax1 = 1730, ay = 792;
  c.strokeStyle = 'rgba(59,45,32,0.20)'; c.lineWidth = 3;
  c.beginPath(); c.moveTo(ax0, ay); c.lineTo(ax1, ay); c.stroke();
  const grow = eo(pr(p, 1.0, 4.3));
  c.strokeStyle = '#6E7A3C'; c.lineWidth = 4;
  c.beginPath(); c.moveTo(ax0, ay); c.lineTo(lerp(ax0, ax1, grow), ay); c.stroke();
  const nodes = [
    ['1912', '出生'], ['1936', '可计算数'], ['1939', '破译 Enigma'],
    ['1950', '图灵测试'], ['1954', '逝世'],
  ];
  for (let i = 0; i < nodes.length; i++) {
    const x = lerp(ax0 + 60, ax1 - 60, i / (nodes.length - 1));
    const on = pr(p, 1.05 + i * 0.72, 1.55 + i * 0.72);
    const e = eo4(on);
    // 涟漪
    const ripple = pr(p, 1.05 + i * 0.72, 1.05 + i * 0.72 + 0.9);
    c.beginPath(); c.arc(x, ay, 10 + 46 * ripple, 0, Math.PI * 2);
    c.strokeStyle = `rgba(110,122,60,${0.5 * (1 - ripple)})`; c.lineWidth = 2; c.stroke();
    c.save(); c.globalAlpha = e;
    c.fillStyle = on > 0 ? '#F2EAD4' : PAPER;
    c.beginPath(); c.arc(x, ay, 11, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#6E7A3C'; c.lineWidth = 3; c.stroke();
    label(c, nodes[i][0], x, ay - 46, 34, INK, F.black, 'center');
    label(c, nodes[i][1], x, ay + 52, 22, OLIVE, F.reg, 'center');
    c.restore();
  }
  // 游标
  const cx = lerp(ax0, ax1, grow);
  c.fillStyle = RED; c.beginPath(); c.arc(cx, ay, 6, 0, Math.PI * 2); c.fill();
}

/* ──────── 镜头 3 · 黑洞：2.5D 透视网格 + 吸积盘粒子 + 喷流 ──────── */
function blackhole(t, s) {
  const c = CTX, p = t - s.t0;
  c.fillStyle = '#05070E'; c.fillRect(0, 0, W, H);
  // 星场（确定性 + 解析闪烁）
  for (let i = 0; i < 230; i++) {
    const x = hash(i, 11) * W, y = hash(i, 12) * H;
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (0.7 + hash(i, 13)) + i));
    c.fillStyle = `rgba(${180 + Math.floor(hash(i, 14) * 70)},${195 + Math.floor(hash(i, 15) * 55)},255,${0.10 + hash(i, 16) * 0.5 * tw})`;
    c.fillRect(x, y, 1 + hash(i, 17) * 1.6, 1 + hash(i, 17) * 1.6);
  }

  // 弯曲时空网格：3D 点 → 2D 透视投影，形变是解析势阱函数
  const yaw = 0.28 + 0.20 * Math.sin(t * 0.26);
  const pitch = 1.03 + 0.06 * Math.cos(t * 0.21);
  const cyaw = Math.cos(yaw), syaw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  function proj(x, y, z) {
    const X = x * cyaw - z * syaw;
    const Z = x * syaw + z * cyaw;
    const Y = y * cp - Z * sp;
    const D = y * sp + Z * cp;
    const sc = 780 / Math.max(2.2, D + 10.5);
    return [W * 0.55 + X * sc, H * 0.66 + Y * sc, sc];
  }
  const well = (x, z) => 3.4 / (1 + (x * x + z * z) * 0.20);
  const N = 22, step = 0.62, span = N * step / 2;
  c.lineWidth = 1.4;
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i <= N; i++) {
      const u = -span + i * step;
      c.beginPath();
      for (let j = 0; j <= N; j++) {
        const v = -span + j * step;
        const x = axis ? u : v, z = axis ? v : u;
        const [sx, sy] = proj(x, well(x, z), z);
        if (j === 0) c.moveTo(sx, sy); else c.lineTo(sx, sy);
      }
      const d = Math.abs(u) / span;
      c.strokeStyle = `rgba(${60 + Math.floor(90 * d)},${130 + Math.floor(90 * d)},${220 - Math.floor(40 * d)},${0.14 + 0.38 * (1 - d)})`;
      c.stroke();
    }
  }

  const cx = W * 0.55, cy = H * 0.455, R = 112;
  const tilt = 0.33 + 0.045 * Math.sin(t * 0.3);
  const scale = 118;
  // 盘的椭圆辉光（先画后半球 → 黑洞 → 前半球）
  c.save(); c.translate(cx, cy); c.scale(1, Math.sin(tilt));
  const halo = c.createRadialGradient(0, 0, R * 0.7, 0, 0, R * 4.3);
  halo.addColorStop(0, 'rgba(255,214,140,0.54)');
  halo.addColorStop(0.32, 'rgba(232,112,42,0.26)');
  halo.addColorStop(1, 'rgba(232,112,42,0)');
  c.fillStyle = halo; c.beginPath(); c.arc(0, 0, R * 4.3, 0, Math.PI * 2); c.fill();
  c.restore();

  const drawParticles = (front) => {
    for (let i = 0; i < 620; i++) {
      const u = hash(i, 21), v = hash(i, 22);
      const r = 1.22 + 3.55 * Math.pow(u, 0.72);
      const omega = 2.35 / Math.pow(r, 1.5);          // 开普勒差速：内圈更快
      const ang = v * Math.PI * 2 + omega * (t - s.t0) * 1.7;
      const isFront = Math.sin(ang) > 0;
      if (isFront !== front) continue;
      const jitter = (hash(i, 23) - 0.5) * 0.30 / r;
      const sx = cx + Math.cos(ang) * r * scale;
      const sy = cy + Math.sin(ang) * r * scale * Math.sin(tilt) + jitter * 46;
      const doppler = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(ang)); // 靠近侧更亮
      const heat = 1 - (r - 1.22) / 3.55;
      const rr8 = Math.floor(lerp(226, 255, heat));
      const gg = Math.floor(lerp(104, 244, heat));
      const bb = Math.floor(lerp(38, 205, heat));
      const a = (0.30 + 0.68 * doppler) * (front ? 1 : 0.72);
      c.fillStyle = `rgba(${rr8},${gg},${bb},${a})`;
      const sz = 1.4 + heat * 2.2 + hash(i, 24) * 1.6;
      c.fillRect(sx, sy, sz, sz);
    }
  };
  drawParticles(false);

  // 喷流（沿 ± 极轴，解析抛物线推进）
  for (let i = 0; i < 150; i++) {
    const dir = i % 2 ? 1 : -1;
    const u = (hash(i, 31) + (t - s.t0) * (0.16 + hash(i, 32) * 0.12)) % 1;
    const spread = (hash(i, 33) - 0.5) * (26 + u * 190);
    const sy = cy + dir * (R * 0.8 + u * 470);
    const a = (1 - u) * 0.34 * (0.4 + hash(i, 34) * 0.6);
    c.fillStyle = `rgba(${Math.floor(lerp(120, 190, u))},${Math.floor(lerp(190, 225, u))},255,${a})`;
    c.beginPath(); c.arc(cx + spread, sy, 1 + (1 - u) * 2.4, 0, Math.PI * 2); c.fill();
  }

  // 黑洞本体 + 光子环 + 引力透镜色差
  c.save();
  const lens = c.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.55);
  lens.addColorStop(0, 'rgba(120,160,255,0.0)');
  lens.addColorStop(0.55, 'rgba(120,160,255,0.20)');
  lens.addColorStop(0.78, 'rgba(255,190,120,0.28)');
  lens.addColorStop(1, 'rgba(255,190,120,0)');
  c.fillStyle = lens; c.beginPath(); c.arc(cx, cy, R * 1.55, 0, Math.PI * 2); c.fill();
  c.restore();
  c.fillStyle = '#020306'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
  for (let k = 0; k < 5; k++) {
    c.beginPath(); c.arc(cx, cy, R + 4 + k * 3.4, 0, Math.PI * 2);
    c.strokeStyle = `rgba(255,${190 - k * 12},${120 - k * 14},${0.55 - k * 0.10})`;
    c.lineWidth = 2.4; c.stroke();
  }
  drawParticles(true);

  // 标题
  label(c, 'CASE 02   /   科学原理', 130, 112, 22, '#7FA8D8');
  label(c, '黑洞', 130, 216, 92, '#F2F5FF', F.black);
  label(c, 'HOW SPACETIME BENDS', 130, 272, 26, '#8FA8C8', F.mono);
  c.fillStyle = '#E8702A'; c.fillRect(130, 302, 108 * eo(pr(p, 0.3, 1.2)), 5);

  // 引线标注（按进度生长）
  const ann = (x0, y0, x1, y1, zh, en, delay, align) => {
    const g = eo(pr(p, delay, delay + 0.85));
    c.strokeStyle = `rgba(180,205,240,${0.62 * g})`; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(lerp(x0, x1, g), lerp(y0, y1, g)); c.stroke();
    c.fillStyle = '#E8702A';
    c.beginPath(); c.arc(x0, y0, 4.5 * g, 0, Math.PI * 2); c.fill();
    c.save(); c.globalAlpha = eo(pr(p, delay + 0.35, delay + 1.1));
    label(c, zh, x1 + (align === 'right' ? -12 : 12), y1 - 8, 26, '#EEF3FF', F.med, align);
    label(c, en, x1 + (align === 'right' ? -12 : 12), y1 + 20, 18, '#8FA8C8', F.mono, align);
    c.restore();
  };
  ann(cx + 300, cy - 28, 1470, 330, '吸积盘', 'ACCRETION DISK · v ∝ r⁻³ᐟ²', 1.3, 'left');
  ann(cx - 72, cy + 74, 720, 690, '事件视界', 'EVENT HORIZON · rₛ = 2GM/c²', 2.1, 'right');

  // 动力学文字：读数随 t 变化
  c.save(); c.globalAlpha = eo(pr(p, 2.6, 3.4));
  c.fillStyle = 'rgba(10,16,28,0.62)'; rr(c, 1430, 790, 370, 156, 8); c.fill();
  c.strokeStyle = 'rgba(140,180,230,0.22)'; c.lineWidth = 1; rr(c, 1430, 790, 370, 156, 8); c.stroke();
  label(c, 'LIVE / SIMULATION', 1454, 826, 18, '#7FA8D8');
  label(c, `轨道速度  ${(0.28 + 0.16 * (0.5 + 0.5 * Math.sin(t * 0.8))).toFixed(2)} c`, 1454, 872, 27, '#F2F5FF', F.med);
  label(c, `网格倾角  ${(pitch * 57.2958).toFixed(1)}°`, 1454, 912, 22, '#A8BFD8', F.mono);
  c.restore();
}

/* ─────── 镜头 4 · Token：等轴投影 + 五色积木 + 程序化节拍 ─────── */
function token(t, s) {
  const c = CTX, p = t - s.t0;
  c.fillStyle = '#F4F0E6'; c.fillRect(0, 0, W, H);
  // 淡等轴网格
  c.strokeStyle = 'rgba(60,70,60,0.055)'; c.lineWidth = 1;
  for (let k = -14; k <= 14; k++) {
    c.beginPath(); c.moveTo(W / 2 + k * 92, 0); c.lineTo(W / 2 + k * 92 + H * 1.732, H); c.stroke();
    c.beginPath(); c.moveTo(W / 2 + k * 92, H); c.lineTo(W / 2 + k * 92 + H * 1.732, 0); c.stroke();
  }
  label(c, 'CASE 03   /   概念科普', 130, 108, 22, '#8A7A55');
  c.save(); c.globalAlpha = eo(pr(p, 0.1, 0.8));
  label(c, '1 个 Token 到底有多大？', 130, 196, 70, '#25322A', F.black);
  c.restore();
  label(c, 'ISOMETRIC MINIATURE · BPM 120', 130, 238, 21, '#8A7A55', F.mono);

  const S = 128, ox = 905, oy = 610;
  const iso = (x, y, z) => [ox + (x - y) * 0.866 * S, oy + (x + y) * 0.5 * S - z * S];
  const poly = (pts, fill, stroke) => {
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath(); c.fillStyle = fill; c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.2; c.stroke(); }
  };
  const shade = (hex, k) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  };
  // 等轴底座
  const base = [iso(-2.2, -2.2, 0), iso(2.2, -2.2, 0), iso(2.2, 2.2, 0), iso(-2.2, 2.2, 0)];
  poly(base.map(([x, y]) => [x, y + 18]), 'rgba(40,50,40,0.13)');
  poly(base, '#E6E0D1', 'rgba(70,80,70,0.28)');
  for (let i = -2; i <= 2; i++) {
    c.strokeStyle = 'rgba(70,80,70,0.10)'; c.lineWidth = 1;
    let a = iso(i, -2.2, 0), b = iso(i, 2.2, 0);
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    a = iso(-2.2, i, 0); b = iso(2.2, i, 0);
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
  }

  const blocks = [
    { x: -1.7, y: -1.0, col: '#4E8FD6', zh: '字' },
    { x: -0.5, y: -1.6, col: '#E05B4B', zh: '词' },
    { x: 0.7, y: -1.0, col: '#E8B23A', zh: '子词' },
    { x: -1.1, y: 0.5, col: '#3FA37A', zh: '标点' },
    { x: 0.1, y: 1.0, col: '#8C6FD0', zh: '空格' },
  ];
  const beat = 0.5;   // BPM 120，程序化节拍（非音频 onset 检测）
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const g = clamp((p - (0.55 + k * beat)) / 0.46);
    if (g <= 0) continue;
    const h = eo4(g) + 0.10 * Math.sin(g * Math.PI * 2) * (1 - g);
    // 落版后持续浮动：避免 60fps 输出里出现整段静帧
    const z = Math.max(0.02, h + 0.045 * Math.sin(t * 2.4 + k * 1.3) * clamp((g - 0.85) / 0.15));
    const [bx, by] = iso(b.x, b.y, 0);
    // 地面阴影
    c.fillStyle = `rgba(40,50,40,${0.10 * h})`;
    c.beginPath(); c.ellipse(bx, by + 6, 96, 44, 0, 0, Math.PI * 2); c.fill();
    const P = (dx, dy, dz) => iso(b.x + dx, b.y + dy, dz * z);
    poly([P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)], shade(b.col, 1.0), 'rgba(255,255,255,0.28)');
    poly([P(0, 1, 1), P(1, 1, 1), P(1, 1, 0), P(0, 1, 0)], shade(b.col, 0.70), 'rgba(0,0,0,0.10)');
    poly([P(1, 0, 1), P(1, 1, 1), P(1, 1, 0), P(1, 0, 0)], shade(b.col, 0.52), 'rgba(0,0,0,0.12)');
    // 标签牌随积木一起升起
    c.save(); c.globalAlpha = eo(pr(p, 0.75 + k * beat, 1.15 + k * beat));
    const top = P(0.5, 0.5, 1);
    c.fillStyle = 'rgba(255,255,255,0.94)'; rr(c, top[0] - 44, top[1] - 62, 88, 38, 8); c.fill();
    label(c, b.zh, top[0], top[1] - 35, 23, '#25322A', F.med, 'center');
    c.restore();
  }

  // 右侧信息卡
  c.save();
  const ci = eo4(pr(p, 2.6, 3.35));
  c.globalAlpha = ci; c.translate((1 - ci) * 90, 0);
  c.fillStyle = '#FFFFFF'; rr(c, 1380, 320, 410, 250, 14); c.fill();
  c.strokeStyle = 'rgba(60,70,60,0.14)'; c.lineWidth = 1.5; rr(c, 1380, 320, 410, 250, 14); c.stroke();
  label(c, '1 TOKEN  ≈', 1412, 380, 22, '#8A7A55', F.mono);
  label(c, `${(0.75 * Math.min(1, pr(p, 3.0, 4.0))).toFixed(2)} 词`, 1412, 452, 62, '#25322A', F.black);
  label(c, '英文按子词切分，中文常按字切分', 1412, 500, 21, '#5B675C', F.reg);
  label(c, '—— 同一句话，计费可能不同', 1412, 536, 21, '#5B675C', F.reg);
  c.restore();

  // 漂浮光点：每个拍间仍有连续运动
  for (let i = 0; i < 14; i++) {
    const a = t * (0.7 + hash(i, 51) * 0.9) + i * 0.9;
    const fx = 960 + (300 + hash(i, 52) * 420) * Math.cos(a);
    const fy = 540 + (120 + hash(i, 53) * 210) * Math.sin(a * 0.8 + i);
    c.fillStyle = `rgba(90,120,95,${0.10 + hash(i, 54) * 0.14})`;
    c.beginPath(); c.arc(fx, fy, 3 + hash(i, 55) * 4, 0, Math.PI * 2); c.fill();
  }

  // 节拍指示条
  label(c, 'BEAT GRID / 120 BPM', 130, 900, 20, '#8A7A55', F.mono);
  for (let i = 0; i < 12; i++) {
    const on = p >= 0.55 + i * beat;
    const cur = Math.abs(p - (0.55 + i * beat)) < beat / 2;
    c.fillStyle = cur ? '#E05B4B' : on ? '#3FA37A' : 'rgba(60,70,60,0.14)';
    rr(c, 130 + i * 44, 920, 30, 20, 5); c.fill();
  }
  label(c, '积木生长逐块落在拍点上（节拍由参数解析生成）', 130, 982, 21, '#5B675C', F.reg);
}

/* ─────────────── 镜头 5 · 信息卡 / 图表 / 收尾 ─────────────── */
function outro(t, s) {
  const c = CTX, p = t - s.t0;
  c.fillStyle = '#0C1018'; c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W / 2, H * 0.4, 80, W / 2, H * 0.4, 1000);
  glow.addColorStop(0, 'rgba(46,96,160,0.24)'); glow.addColorStop(1, 'rgba(46,96,160,0)');
  c.fillStyle = glow; c.fillRect(0, 0, W, H);
  label(c, '04   /   结论', 130, 108, 22, '#6E9AD0');
  label(c, '代码写视频 · 三项可验证的能力', 130, 190, 66, '#F2F6FF', F.black);
  label(c, 'WHAT THE RENDERER ACTUALLY GUARANTEES', 130, 234, 21, '#7E94B4', F.mono);

  const cards = [
    { zh: '文字零乱码', en: 'GLYPH-EXACT', d1: '字形来自字体文件栅格化，', d2: '不经过任何模型猜测。', sample: '中文排版 · 数字 · 公式 rₛ = 2GM/c²' },
    { zh: '改参数即重出片', en: 'PARAMETRIC', d1: '文案 / 配色 / 节拍 / 时长', d2: '全在一份 params.json 里。', sample: '{ "type": "token", "args": { "bpm": 120 } }' },
    { zh: '逐帧确定性', en: 'DETERMINISTIC', d1: '任意帧可独立 seek，', d2: '8 个 worker 并行无接缝。', sample: 'frame = f(t)  /  no hidden state' },
  ];
  for (let i = 0; i < cards.length; i++) {
    const k = cards[i], x = 130 + i * 570;
    const g = eo4(pr(p, 0.35 + i * 0.34, 1.05 + i * 0.34));
    c.save(); c.globalAlpha = g; c.translate(0, (1 - g) * 44);
    c.fillStyle = 'rgba(255,255,255,0.045)'; rr(c, x, 310, 530, 336, 14); c.fill();
    c.strokeStyle = 'rgba(140,180,230,0.18)'; c.lineWidth = 1.5; rr(c, x, 310, 530, 336, 14); c.stroke();
    c.fillStyle = ['#4E8FD6', '#E8B23A', '#3FA37A'][i]; rr(c, x + 28, 342, 54, 6, 3); c.fill();
    // 边框流光：卡片落版后仍有持续运动
    const sweep = ((t * 300 + i * 190) % 1060);
    const lx = sweep < 530 ? x + sweep : x + 530 - (sweep - 530);
    c.fillStyle = 'rgba(140,200,255,0.55)';
    c.beginPath(); c.arc(clamp(lx, x + 8, x + 522), 310, 3.2, 0, Math.PI * 2); c.fill();
    label(c, `0${i + 1}`, x + 28, 404, 22, '#7E94B4', F.mono);
    label(c, k.zh, x + 28, 462, 42, '#F2F6FF', F.black);
    label(c, k.en, x + 28, 494, 18, '#7E94B4', F.mono);
    label(c, k.d1, x + 28, 540, 23, '#AFC2DC', F.reg);
    label(c, k.d2, x + 28, 572, 23, '#AFC2DC', F.reg);
    c.fillStyle = 'rgba(8,14,24,0.55)'; rr(c, x + 28, 590, 474, 42, 6); c.fill();
    label(c, k.sample, x + 42, 618, 19, '#8FB8E8', F.mono);
    c.restore();
  }

  // 柱状图：5 个镜头对应 5 根柱，按进度生长
  label(c, 'SCENE COVERAGE', 130, 730, 20, '#7E94B4', F.mono);
  const names = ['文字', '档案', '黑洞', 'Token', '收尾'];
  for (let i = 0; i < 5; i++) {
    const x = 130 + i * 260, hMax = 118;
    const g = eo(pr(p, 1.2 + i * 0.22, 2.1 + i * 0.22));
    c.fillStyle = 'rgba(255,255,255,0.06)'; rr(c, x, 766, 180, hMax, 6); c.fill();
    c.fillStyle = ['#4E8FD6', '#A98B54', '#E8702A', '#8C6FD0', '#3FA37A'][i];
    const pulse = 1 + 0.055 * Math.sin(t * 3.1 + i * 0.9) * clamp((p - 2.1) / 0.6);
    const h = hMax * g * pulse;
    rr(c, x, 766 + hMax - h, 180, h, 6); c.fill();
    label(c, names[i], x, 914, 21, '#AFC2DC', F.reg);
    label(c, `${Math.round(g * 100)}%`, x + 180, 766 + hMax - h - 12, 20, '#6E9AD0', F.mono, 'right');
  }
  c.strokeStyle = 'rgba(140,180,230,0.22)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(130, 950); c.lineTo(130 + 1490 * eo(pr(p, 2.2, 3.6)), 950); c.stroke();
  c.save(); c.globalAlpha = eo(pr(p, 2.5, 3.4));
  label(c, 'MOTION GRAPHICS  /  CODE, NOT PROMPT', 130, 1000, 24, '#8FB8E8', F.mono);
  c.restore();
}

/**
 * 全局氛围层：解析扫光 + 轨道光点 + 全片进度条。
 * 目的不是装饰，而是保证每个镜头落版后仍存在逐帧可见的连续运动 ——
 * 60fps 输出不该出现整段完全静止的画面。
 */
function ambience(t, s) {
  const c = CTX;
  const light = s.type === 'intro' || s.type === 'archive' || s.type === 'token';
  const col = light ? '20,34,24' : '190,215,255';
  const bx = ((t * 420) % (W + 640)) - 320;
  const g = c.createLinearGradient(bx - 320, 0, bx + 320, 0);
  g.addColorStop(0, `rgba(${col},0)`);
  g.addColorStop(0.5, `rgba(${col},0.055)`);
  g.addColorStop(1, `rgba(${col},0)`);
  c.fillStyle = g; c.fillRect(bx - 320, 0, 640, H);
  for (let k = 0; k < 3; k++) {
    const a = t * (1.15 + k * 0.4) + k * 2.1;
    c.fillStyle = `rgba(${col},${light ? 0.26 : 0.34})`;
    c.beginPath();
    c.arc(W * 0.80 + 120 * Math.cos(a), H * 0.78 + 70 * Math.sin(a), 5 - k, 0, Math.PI * 2);
    c.fill();
  }
  const total = SCENES.length ? SCENES[SCENES.length - 1].t1 : 32;
  const prog = clamp(t / total);
  c.fillStyle = light ? 'rgba(20,34,24,0.10)' : 'rgba(255,255,255,0.10)';
  c.fillRect(0, H - 5, W, 3);
  c.fillStyle = light ? 'rgba(30,138,102,0.85)' : 'rgba(120,190,255,0.85)';
  c.fillRect(0, H - 5, W * prog, 3);
}

const SCENE = { intro, archive, blackhole, token, outro };

let CTX = null;
let SCENES = [];

/** 与 skia-kit/paper.mjs 同构的接口：setContent + renderFrame(t)。 */
export function createMGRenderer({ ctx }) {
  CTX = ctx;
  return {
    setContent({ scenes }) { SCENES = scenes || []; },
    renderFrame(t) {
      const c = CTX;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      let s = SCENES[SCENES.length - 1];
      for (const sc of SCENES) if (t >= sc.t0 && t < sc.t1) { s = sc; break; }
      if (!s) { c.restore(); return; }
      (SCENE[s.type] || intro)(t, s);

      // 统一字幕条
      const sub = s.args && s.args.sub;
      if (sub) {
        const p = t - s.t0, dur = s.t1 - s.t0;
        const a = eo(pr(p, 0.32, 0.85)) * (1 - pr(p, dur - 0.42, dur - 0.05));
        if (a > 0.001) {
          c.save(); c.globalAlpha = a;
          c.fillStyle = 'rgba(8,12,18,0.78)';
          c.font = font(30, F.reg);
          const tw = c.measureText(sub).width;
          rr(c, W / 2 - tw / 2 - 30, 986, tw + 60, 54, 10); c.fill();
          label(c, sub, W / 2, 1024, 30, '#F2F5FF', F.reg, 'center');
          c.restore();
        }
      }

      ambience(t, s);

      // 镜头切换：从左向右擦除（0.28s）
      const wp = pr(t, s.t0, s.t0 + 0.28);
      if (wp < 1) {
        const e = eio(wp);
        c.fillStyle = '#080B11'; c.fillRect(W * e, 0, W * (1 - e) + 1, H);
        c.fillStyle = 'rgba(120,200,255,0.85)'; c.fillRect(W * e - 3, 0, 3, H);
      }

      // 常驻角标 + 时间码（动力学文字）
      c.font = font(18, F.mono);
      c.fillStyle = 'rgba(255,255,255,0.30)';
      c.fillText('MG-KIT / SKIA 2D / 1920×1080', 130, 44);
      c.textAlign = 'right';
      c.fillText(`t=${t.toFixed(2)}s  f=${Math.round(t * 60)}`, W - 130, 44);
      c.textAlign = 'left';
      c.restore();
    },
  };
}
