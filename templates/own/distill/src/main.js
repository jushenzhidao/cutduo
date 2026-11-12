/* html-canvas/1 · 参考运行时
 * 宿主逐帧调用 window.renderFrame(frame, inputs)。
 * 所有画面都是 frame 的纯函数：不读墙上时钟、不依赖上一帧、不使用随机数。
 * 固定 1280×720 / 30fps / 12s，与 motion.json 的 output 一致。
 */
const c = document.getElementById('c');
const ctx = c.getContext('2d');
const W = c.width, H = c.height;
const FPS = 30, DUR = 12;

const SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,"Helvetica Neue",Arial,sans-serif';
const MONO = '"SF Mono",Menlo,Consolas,monospace';

const DEFAULTS = {
  eyebrow: '.motion 用法蒸馏',
  title: 'MOTIONGIT',
  subtitle: '把视频写成可复用的代码',
  points: [
    '01  .motion = ZIP 模板包',
    '02  params.schema.json 定义能改什么',
    '03  renderFrame(frame, inputs) 逐帧渲染',
  ],
  steps: ['下载 .motion', '交给 AI', '预览', '导出 MP4'],
  outro: '一次蒸馏 · 反复出片',
  accent: '#8B7CFF',
  accent2: '#4FD1C5',
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function ease(v) { v = clamp(v, 0, 1); return 1 - Math.pow(1 - v, 3); }
function lerp(a, b, v) { return a + (b - a) * v; }
function hash(i) { const s = Math.sin(i * 127.1 + 0.37) * 43758.5453; return s - Math.floor(s); }
function fade(t, a, b, f) { return clamp(Math.min((t - a) / f, (b - t) / f), 0, 1); }
function rgba(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function font(size, weight, mono) {
  ctx.font = `${weight} ${Math.round(size)}px ${mono ? MONO : SANS}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
function label(text, x, y, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;   // 乘算，保留外层场景淡入淡出
  let size = o.size || 24;
  font(size, o.weight || 500, o.mono);
  if (o.maxW) {
    const w = ctx.measureText(text).width;
    if (w > o.maxW) { size = Math.max(10, Math.floor(size * o.maxW / w)); font(size, o.weight || 500, o.mono); }
  }
  ctx.fillStyle = o.color || '#ffffff';
  ctx.textAlign = o.align || 'left';
  ctx.fillText(text, x, y);
  ctx.restore();
}
function roundFill(x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
  else ctx.fillRect(x, y, w, h);
}
function timecode(t) { return `00:${String(Math.min(59, Math.floor(t))).padStart(2, '0')}`; }

function background(t, inp) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0a0d18'); g.addColorStop(0.55, '#0d1122'); g.addColorStop(1, '#080a12');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  let glow = ctx.createRadialGradient(W * 0.78, H * 0.2, 0, W * 0.78, H * 0.2, 540);
  glow.addColorStop(0, rgba(inp.accent, 0.18)); glow.addColorStop(1, rgba(inp.accent, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  glow = ctx.createRadialGradient(W * 0.1, H * 0.92, 0, W * 0.1, H * 0.92, 420);
  glow.addColorStop(0, rgba(inp.accent2, 0.10)); glow.addColorStop(1, rgba(inp.accent2, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.032)'; ctx.lineWidth = 1;
  const step = 64, off = (t * 7) % step;
  for (let x = -step + off; x < W + step; x += step) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
  for (let y = -step + off; y < H + step; y += step) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }

  for (let i = 0; i < 52; i++) {
    const bx = hash(i) * W, by = hash(i + 97) * H;
    const r = 0.7 + hash(i + 7) * 1.7;
    ctx.globalAlpha = 0.10 + hash(i + 13) * 0.28;
    ctx.fillStyle = i % 6 === 0 ? inp.accent : '#ffffff';
    ctx.beginPath();
    ctx.arc(bx + Math.sin(t * 0.45 + i) * 9, by + Math.cos(t * 0.35 + i) * 8, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = rgba(inp.accent2, 0.35); ctx.lineWidth = 1.5;
  const m = 40, L = 18;
  [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, sx, sy]) => {
    ctx.beginPath(); ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); ctx.stroke();
  });
}

function chrome(t, inp) {
  label('WORKBUDDY · MOTION LAB', 62, 66, { size: 12, color: 'rgba(255,255,255,0.45)', mono: true });
  label('html-canvas/1  ·  1280×720  ·  30fps', W - 62, 66,
    { size: 12, color: 'rgba(255,255,255,0.34)', align: 'right', mono: true });
  const sceneNo = t < 3.35 ? 1 : t < 6.65 ? 2 : t < 9.7 ? 3 : 4;
  label('SCENE ' + String(sceneNo).padStart(2, '0') + ' / 04', 62, H - 70,
    { size: 12, color: rgba(inp.accent2, 0.7), mono: true });
  label(`${timecode(t)} / 00:12`, W - 62, H - 70,
    { size: 12, color: 'rgba(255,255,255,0.4)', align: 'right', mono: true });
  ctx.fillStyle = 'rgba(255,255,255,0.09)'; ctx.fillRect(62, H - 52, W - 124, 2);
  ctx.fillStyle = inp.accent; ctx.fillRect(62, H - 52, (W - 124) * clamp(t / DUR, 0, 1), 2);
}

function scene1(t, inp) {
  const a = fade(t, 0, 3.35, 0.34); if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;

  const e = ease((t - 0.15) / 0.55);
  ctx.fillStyle = inp.accent2; ctx.fillRect(96, 208 + (1 - e) * 10, 10, 10);
  label(inp.eyebrow, 118, 218 + (1 - e) * 10,
    { size: 16, weight: 600, color: inp.accent2, alpha: e, mono: true });

  const chars = [...inp.title];
  const size = 116;
  font(size, 800);
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const gap = lerp(28, 9, ease((t - 0.45) / 1.1));
  const total = widths.reduce((s, v) => s + v, 0) + gap * (chars.length - 1);
  let x = (W - total) / 2;
  const y = 368;
  chars.forEach((ch, i) => {
    const k = ease((t - 0.45 - i * 0.045) / 0.55);
    ctx.save(); ctx.globalAlpha *= k;
    font(size, 800);
    ctx.fillStyle = '#f5f7ff';
    ctx.shadowColor = rgba(inp.accent, 0.7); ctx.shadowBlur = 26 * (1 - k) + 6;
    ctx.fillText(ch, x, y + (1 - k) * 32);
    ctx.restore();
    x += widths[i] + gap;
  });

  ctx.fillStyle = inp.accent;
  ctx.fillRect((W - total) / 2, 394, total * ease((t - 1.05) / 0.7), 3);

  const s = ease((t - 1.15) / 0.7);
  label(inp.subtitle, W / 2, 462 + (1 - s) * 14,
    { size: 29, weight: 500, color: 'rgba(233,238,255,0.86)', align: 'center', alpha: s });
  label('源码 + 参数契约 + 素材说明 + 许可，打成一个 ZIP 包', W / 2, 508,
    { size: 17, color: 'rgba(233,238,255,0.42)', align: 'center', alpha: ease((t - 1.7) / 0.7) });
  ctx.restore();
}

function scene2(t, inp) {
  const a = fade(t, 3.35, 6.65, 0.3); if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  label('WHAT IS INSIDE', 96, 186, { size: 15, weight: 600, color: inp.accent2, mono: true });
  label('模板里到底装了什么', 96, 238, { size: 40, weight: 700, color: '#f5f7ff' });

  inp.points.forEach((p, i) => {
    const k = ease((t - 3.55 - i * 0.42) / 0.55);
    const y = 330 + i * 100;
    ctx.save(); ctx.globalAlpha *= k;
    const off = (1 - k) * 46;
    ctx.fillStyle = 'rgba(255,255,255,0.035)'; roundFill(96 + off, y - 44, W - 192, 80, 10);
    ctx.fillStyle = inp.accent; ctx.fillRect(96 + off, y - 24, 3, 38);
    const m = String(p).match(/^(\d{2})\s+(.*)$/);
    const num = m ? m[1] : String(i + 1).padStart(2, '0');
    const txt = m ? m[2] : String(p);
    label(num, 120 + off, y + 8, { size: 24, weight: 700, color: inp.accent, mono: true });
    label(txt, 184 + off, y + 8, { size: 27, weight: 500, color: '#e9edff', maxW: W - 330 });
    ctx.restore();
  });
  ctx.restore();
}

function scene3(t, inp) {
  const a = fade(t, 6.65, 9.7, 0.3); if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  label('PIPELINE', 96, 186, { size: 15, weight: 600, color: inp.accent2, mono: true });
  label('从模板到成片', 96, 238, { size: 40, weight: 700, color: '#f5f7ff' });

  const xs = [190, 490, 790, 1090], y = 400, steps = inp.steps.slice(0, 4);
  ctx.lineWidth = 2;
  for (let i = 0; i < xs.length - 1; i++) {
    const k = ease((t - 7.0 - i * 0.55) / 0.5);
    ctx.strokeStyle = rgba(inp.accent, 0.55);
    ctx.beginPath(); ctx.moveTo(xs[i] + 26, y); ctx.lineTo(xs[i] + 26 + (xs[i + 1] - xs[i] - 52) * k, y); ctx.stroke();
  }
  steps.forEach((s, i) => {
    const k = ease((t - 6.85 - i * 0.55) / 0.45);
    ctx.save(); ctx.globalAlpha = a * k;
    ctx.fillStyle = k > 0.55 ? inp.accent : 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.arc(xs[i], y, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(inp.accent, 0.9); ctx.lineWidth = 2; ctx.stroke();
    label(String(i + 1).padStart(2, '0'), xs[i], y + 6,
      { size: 15, weight: 700, color: k > 0.55 ? '#0a0d18' : '#ffffff', align: 'center', mono: true });
    label(String(s), xs[i], y + 66,
      { size: 20, weight: 500, color: '#e9edff', align: 'center', maxW: 230 });
    ctx.restore();
  });
  label('每一帧都由 frame 独立求得，机器快慢不会改变画面', W / 2, 556,
    { size: 18, color: 'rgba(233,238,255,0.48)', align: 'center', alpha: ease((t - 8.6) / 0.6) });
  ctx.restore();
}

function scene4(t, inp) {
  const a = fade(t, 9.7, 12.0, 0.4); if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  const k = ease((t - 9.85) / 0.9);
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = rgba(inp.accent, 0.14 - i * 0.035); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W / 2, H / 2 - 16, 150 + i * 62 + (1 - k) * 70, 0, Math.PI * 2); ctx.stroke();
  }
  label(inp.outro, W / 2, H / 2 + 14 + (1 - k) * 18,
    { size: 62, weight: 700, color: '#f5f7ff', align: 'center', alpha: k, maxW: W - 180 });
  label('下载 .motion → 改参数 → 预览 → 导出 MP4 · 同一风格可以再做一期', W / 2, H / 2 + 70,
    { size: 19, color: 'rgba(233,238,255,0.6)', align: 'center', alpha: ease((t - 10.4) / 0.7) });
  ctx.restore();
}

window.renderFrame = (frame, inputs) => {
  const t = frame / FPS;
  const inp = { ...DEFAULTS, ...(inputs || {}) };
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  background(t, inp);
  scene1(t, inp); scene2(t, inp); scene3(t, inp); scene4(t, inp);
  chrome(t, inp);
  if (t > DUR - 0.65) {
    ctx.fillStyle = rgba('#080a12', ease((t - (DUR - 0.65)) / 0.65) * 0.92);
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
};
