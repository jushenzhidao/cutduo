/**
 * desktop-kit · Mac Desktop 模板的 Skia 复刻（无浏览器）
 *
 * 参考来源：motiongit.com/adunext/mac-desktop 官方 demo（1440×1080 / 60fps / 230.02s）。
 * 复刻的是「视觉系统」而非 55 个镜头的逐条搬运：常驻 macOS 桌面骨架 + 组件库
 * + 数据驱动的镜头 switch。所有几何与配色来自对 29 帧参考画面的量化标定，
 * 落在 tokens.json；verify.mjs 用逐采样点比色与几何断言钉住。
 *
 *   import { createDesktopRenderer, registerFonts } from './desktop.mjs';
 *   registerFonts('assets/fonts');
 *   const r = createDesktopRenderer({ ctx });
 *   r.setContent({ shots, captions, presenter });
 *   r.renderFrame(t);
 */
import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const TOKENS_PATH = path.join(HERE, 'tokens.json');
export function loadTokens(p = TOKENS_PATH) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export const DEFAULT_TOKENS = loadTokens();

/** 字体是这套版式的命门：缺字重会静默回退，字面宽度与笔画厚度同时跑偏。 */
export function registerFonts(dir = path.join(HERE, '..', '..', 'assets', 'fonts')) {
  let ok = 0;
  for (const [file, name] of [
    ['NotoSansSC-Black.otf', 'NotoSC Black'],
    ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
    ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
  ]) {
    const p = path.join(dir, file);
    try { if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, name); ok++; } } catch { /* ignore */ }
  }
  return ok;
}

/**
 * 参数校验：渲染器与出片 CLI 共用同一份判据。
 * 「静默接受错误输入」比「报错」危险得多 —— 错的时间轴会产出一条看起来正常的片子。
 */
export function validateParams(d) {
  const bad = (m) => { throw new Error(`desktop-kit: E_BAD_PARAMS ${m}`); };
  if (!d || !Array.isArray(d.shots) || !d.shots.length) bad('shots 为空');
  const shots = [...d.shots].sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (!SHOT_TYPES.includes(s.type)) bad(`未知镜头类型 "${s.type}"`);
    if (!Number.isFinite(s.t0) || !Number.isFinite(s.t1)) bad(`#${i} t0/t1 必须是有限数`);
    if (!(s.t1 > s.t0)) bad(`#${i} t1(${s.t1}) <= t0(${s.t0})`);
    if (i + 1 < shots.length && Math.abs(s.t1 - shots[i + 1].t0) > 0.002) {
      bad(`#${i} 与 #${i + 1} 时间轴不连续（gap/overlap ${(shots[i + 1].t0 - s.t1).toFixed(3)}s）`);
    }
  }
  const chapters = d.chapters || [];
  if (chapters.length) {
    const names = new Set(chapters.map((c) => c.name));
    for (const s of shots) if (s.chapter && !names.has(s.chapter)) bad(`chapter "${s.chapter}" 不在 chapters 中`);
  }
  if (d.durationSeconds != null && Math.abs(d.durationSeconds - shots.at(-1).t1) > 0.002) {
    bad(`durationSeconds(${d.durationSeconds}) ≠ 末镜 t1(${shots.at(-1).t1})`);
  }
  const caps = d.captions || [];
  // 空 captions 是合法的无字幕片；非空则必须与 shots 一一对应，否则字幕会整体错位。
  if (caps.length && caps.length !== shots.length) bad(`captions(${caps.length}) 与 shots(${shots.length}) 数量不一致`);
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i], s = shots[i];
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start) bad(`字幕 #${i} 时间非法`);
    if (c.start < s.t0 - 0.5 || c.end > s.t1 + 0.5) bad(`字幕 #${i} 越出镜头 #${i}`);
  }
  return true;
}

/** 已落地的镜头类型。未在表内的 type 会明确报错，不静默降级成 talk。 */
export const SHOT_TYPES = [
  'title', 'talk', 'flipBoard', 'comments', 'rating', 'terminal', 'counter', 'station',
  'notify', 'chart', 'tickets', 'ranking', 'chat', 'files', 'checklist', 'outro',
  'photo', 'clip',
];

export function createDesktopRenderer(opts = {}) {
  const ctx = opts.ctx;
  if (!ctx) throw new Error('createDesktopRenderer: ctx is required');
  const W = opts.width || DEFAULT_TOKENS.width;
  const H = opts.height || DEFAULT_TOKENS.height;
  const T = opts.tokens || DEFAULT_TOKENS;
  const P = T.palette;
  const F = T.fonts;

  // 所有绘制都走 G：整屏翻牌转场会把 G 临时切到离屏 canvas，画完再切回。
  let G = ctx;
  const off = [createCanvas(W, H), createCanvas(W, H)];
  const offCtx = off.map((c) => c.getContext('2d'));

  // 壁纸细纹理：参考片实测壁纸区梯度 2.5–4.7，纯渐变只有 0.1–2.7。
  // 用固定种子的灰度噪点补齐中高频，且不随 t 变化（不会闪），保证逐帧确定性。
  const noise = createCanvas(W, H);
  {
    const ng = noise.getContext('2d');
    const im = ng.createImageData(W, H);
    let seed = 0x5EED1234;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0, n = W * H; i < n; i++) {
      const v = rnd() * 255, k = i * 4;
      im.data[k] = v; im.data[k + 1] = v; im.data[k + 2] = v;
      im.data[k + 3] = 20 + ((rnd() * 16) | 0);
    }
    ng.putImageData(im, 0, 0);
  }

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const pr = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));
  const eo = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const eio = (x) => { const q = clamp(x); return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; };
  const lerp = (a, b, k) => a + (b - a) * k;

  let shots = [], captions = [], chapters = [], presenterImg = null, brand = '';
  // 照片素材表：key → Image。由 setContent 注入，缺失时硬失败而不是画空白。
  let photos = {};
  // 视频片段：key → Image[]（预抽帧）。渲染器不内嵌解码器，按时间取帧。
  let clips = {};
  // 当前帧壁纸是否为深色：直接画在壁纸上的文字要跟着换墨色，否则浅底白字不可读
  let curDark = true;
  const onWall = (darkInk, lightInk) => (curDark ? darkInk : lightInk);
  const onWallStroke = () => (curDark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.86)');

  /* ────────────────────────── 基础绘制 ────────────────────────── */
  function rr(g, x, y, w, h, r) {
    const k = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + k, y);
    g.arcTo(x + w, y, x + w, y + h, k);
    g.arcTo(x + w, y + h, x, y + h, k);
    g.arcTo(x, y + h, x, y, k);
    g.arcTo(x, y, x + w, y, k);
    g.closePath();
  }
  function box(x, y, w, h, fill, r = 0, stroke = null, lw = 1) {
    G.save();
    rr(G, x, y, w, h, r);
    if (fill) { G.fillStyle = fill; G.fill(); }
    if (stroke) { G.strokeStyle = stroke; G.lineWidth = lw; G.stroke(); }
    G.restore();
  }
  function shadow(x, y, w, h, r, alpha = 0.28, blur = 34, dy = 14) {
    G.save();
    G.shadowColor = `rgba(0,0,0,${alpha})`;
    G.shadowBlur = blur; G.shadowOffsetY = dy;
    box(x, y, w, h, '#00000001', r);
    G.restore();
  }
  // 运行时兜底：动态文本（终端日志、计数器、用户自定义行）若含中文却落在等宽字体上，
  // 会自动切回 Noto。静态字面量由 D01 常驻扫描钉住，两层一起防豆腐块。
  const CJK_RE = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  function safeFont(text, f) {
    if (!CJK_RE.test(String(text)) || !/mono|Menlo/i.test(String(f))) return f;
    const m = String(f).match(/([\d.]+)px/);
    return m ? `400 ${m[1]}px ${F.regular}` : f;
  }
  function txt(s, x, y, font, color, align = 'left', stroke = null, sw = 3) {
    G.save();
    G.font = safeFont(s, font); G.textAlign = align; G.textBaseline = 'alphabetic';
    if (stroke) {
      G.strokeStyle = stroke; G.lineWidth = sw; G.lineJoin = 'round'; G.miterLimit = 2;
      G.strokeText(String(s), x, y);
    }
    G.fillStyle = color; G.fillText(String(s), x, y);
    G.restore();
  }
  function tw(s, font) { G.font = safeFont(s, font); return G.measureText(String(s)).width; }
  function fitSize(s, start, maxW, fontFn, min = 12) {
    let n = start;
    while (n > min && tw(s, fontFn(n)) > maxW) n -= 1;
    return n;
  }
  function font(size, weight = 'regular') {
    const f = weight === 'black' ? F.black : weight === 'medium' ? F.medium : F.regular;
    return `${weight === 'black' ? 900 : weight === 'medium' ? 500 : 400} ${size}px ${f}`;
  }
  function mono(size) { return `500 ${size}px ${F.mono}`; }

  /** 不用私有区/emoji 字形：Noto Sans SC 对它们会静默回退成豆腐块，必须自绘。 */
  function appleMark(x, y, color) {
    G.save(); G.fillStyle = color;
    G.beginPath();
    G.ellipse(x + 5, y - 4, 4.2, 5, -0.2, 0, Math.PI * 2); G.fill();
    G.beginPath();
    G.ellipse(x + 11, y - 4, 4.2, 5, 0.2, 0, Math.PI * 2); G.fill();
    G.beginPath();
    G.ellipse(x + 8, y + 2, 7.2, 6.2, 0, 0, Math.PI * 2); G.fill();
    G.beginPath(); G.ellipse(x + 8, y - 12, 2.4, 2.2, -0.5, 0, Math.PI * 2); G.fill();
    G.restore();
  }
  function windowGlyphs(x, y, color) {
    G.save(); G.strokeStyle = color; G.lineWidth = 1.6; G.lineCap = 'round';
    // 分享：方框 + 上箭头
    G.strokeRect(x - 26, y - 12, 12, 14);
    G.beginPath(); G.moveTo(x - 20, y - 15); G.lineTo(x - 20, y + 1);
    G.moveTo(x - 23, y - 12); G.lineTo(x - 20, y - 15); G.lineTo(x - 17, y - 12); G.stroke();
    // 信息：圆圈 + i
    G.beginPath(); G.arc(x, y - 5, 7, 0, Math.PI * 2); G.stroke();
    G.beginPath(); G.moveTo(x, y - 8); G.lineTo(x, y - 1); G.stroke();
    G.beginPath(); G.arc(x, y - 11, 1, 0, Math.PI * 2); G.fillStyle = color; G.fill();
    G.restore();
  }

  /** 解析 *强调词*；返回逐字数组，交给 drawRich 做逐字揭示。 */
  function parseRich(s) {
    const out = []; let acc = false;
    for (const ch of String(s)) { if (ch === '*') { acc = !acc; continue; } out.push({ ch, acc }); }
    return out;
  }
  function richWidth(chars, f) { return chars.reduce((a, c) => a + tw(c.ch, f), 0); }
  function drawRich(chars, x, y, f, color, accent, align = 'center', limit = 1e9, stroke = null, sw = 3) {
    const n = Math.min(chars.length, Math.floor(limit));
    const vis = chars.slice(0, n);
    const total = richWidth(vis, f);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    G.save(); G.textBaseline = 'alphabetic';
    for (const c of vis) {
      const w = tw(c.ch, f);
      if (stroke) {
        G.font = f; G.textAlign = 'left'; G.strokeStyle = stroke; G.lineWidth = sw;
        G.lineJoin = 'round'; G.strokeText(c.ch, cx, y);
      }
      G.font = f; G.textAlign = 'left'; G.fillStyle = c.acc ? accent : color;
      G.fillText(c.ch, cx, y);
      cx += w;
    }
    G.restore();
    return total;
  }

  /* ────────────────────────── 常驻桌面骨架 ────────────────────────── */
  function wallpaper(theme, t) {
    // 外部可替换壁纸层（对比实验用）：返回 true 表示「已画完」，不再走内置渐变。
    // 这是 GPU/JS 氛围层接入 Skia 版式的唯一缝，其余 UI 绘制完全共用。
    if (typeof opts.wallpaper === 'function' && opts.wallpaper(G, theme, { w: W, h: H, t }) === true) return;
    const key = theme === 'orange' ? 'orangeWall' : theme === 'red' ? 'redWall' : theme === 'light' ? 'lightWall' : 'blueWall';
    const c = P[key];
    const g = G.createRadialGradient(W * 0.62, H * 0.42, 60, W * 0.55, H * 0.55, W * 0.95);
    g.addColorStop(0, c[2]); g.addColorStop(0.42, c[1]);
    g.addColorStop(0.78, c[0]); g.addColorStop(1, c[3] || c[0]);
    G.fillStyle = g; G.fillRect(0, 0, W, H);
    // 参考片里蓝色壁纸左上有明显的暗角；用一层线性渐变补偿，保持确定性（无随机噪点）。
    const v = G.createLinearGradient(0, 0, W, H);
    v.addColorStop(0, 'rgba(0,0,0,0.20)'); v.addColorStop(0.45, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.06)');
    G.fillStyle = v; G.fillRect(0, 0, W, H);
    G.save(); G.globalAlpha = 0.48; G.drawImage(noise, 0, 0); G.restore();
  }

  function menuBar(chapter, idx, darkBg) {
    const M = T.menuBar;
    G.save();
    G.fillStyle = darkBg ? 'rgba(24,26,32,0.72)' : M.bg;
    G.fillRect(0, 0, W, M.h);
    const fg = darkBg ? '#F2F3F5' : M.fg;
    // 左：苹果标记 + 应用名 + 菜单项
    appleMark(12, 13, fg);
    let x = 38;
    txt(M.appName, x, 18, font(13, 'medium'), fg); x += tw(M.appName, font(13, 'medium')) + 20;
    for (const m of M.menus) { txt(m, x, 18, font(13), fg); x += tw(m, font(13)) + 20; }
    // 中：章节路线图（一条线 + 节点，当前节点实心蓝）
    const R = M.route;
    G.strokeStyle = darkBg ? 'rgba(255,255,255,0.42)' : 'rgba(30,34,42,0.34)';
    G.lineWidth = 1.2; G.beginPath(); G.moveTo(R.x0, R.y); G.lineTo(R.x1, R.y); G.stroke();
    const step = (R.x1 - R.x0) / (R.nodes - 1);
    const active = Math.max(0, Math.min(R.nodes - 1, idx));
    for (let i = 0; i < R.nodes; i++) {
      const nx = R.x0 + i * step;
      G.beginPath(); G.arc(nx, R.y, i === active ? R.r + 1.2 : R.r, 0, Math.PI * 2);
      G.fillStyle = i <= active ? P.blue : (darkBg ? '#C9CDD4' : '#F6F7F9');
      G.fill();
      if (i < active) { G.strokeStyle = P.blue; G.lineWidth = 1.4; G.beginPath(); G.moveTo(nx, R.y); G.lineTo(nx + step, R.y); G.stroke(); }
    }
    txt(chapter || '', R.x1 + 14, R.y + 4, font(11, 'medium'), fg);
    // 右：状态图标 + 日期
    let rx = W - 16;
    txt(M.date, rx, 18, font(12, 'medium'), fg, 'right');
    rx -= tw(M.date, font(12, 'medium')) + 18;
    for (let i = 0; i < 5; i++) {
      box(rx - 14, 8, 10, 10, darkBg ? 'rgba(255,255,255,0.72)' : 'rgba(20,22,28,0.72)', 2);
      rx -= 18;
    }
    G.restore();
  }

  function desktopIcons(highlight = -1, dark = false) {
    const D = T.desktopIcons;
    for (let i = 0; i < D.items.length; i++) {
      const it = D.items[i], y = D.y0 + i * D.gap, x = D.x - D.w / 2;
      G.save();
      if (i === highlight) { G.shadowColor = 'rgba(255,255,255,0.9)'; G.shadowBlur = 18; }
      if (it.kind === 'folder') {
        box(x - 3, y + 8, D.w + 6, 40, '#4A9BF0', 6);
        box(x - 3, y + 2, 22, 12, '#4A9BF0', 4);
      } else if (it.kind === 'mov') {
        box(x + 3, y + 4, 50, 46, '#F2F3F5', 4, '#D6D9DE', 1);
        box(x + 3, y + 34, 50, 16, '#F5A11B', 0);
        txt('MOV', x + 28, y + 47, mono(10), '#FFFFFF', 'center');
      } else if (it.kind === 'mp4') {
        box(x + 6, y + 2, 44, 50, '#FBFBFB', 3, '#D6D9DE', 1);
        box(x + 12, y + 8, 32, 22, '#E9EAEC', 2);
        txt('···', x + 28, y + 24, font(14, 'medium'), '#9AA0A8', 'center');
      } else {
        box(x + 7, y + 2, 42, 50, '#FBFBFB', 3, '#D6D9DE', 1);
        box(x + 14, y + 40, 28, 10, '#E23B3B', 2);
        txt('PDF', x + 28, y + 48, mono(8), '#FFFFFF', 'center');
      }
      G.restore();
      // 文件名：深色壁纸用白字黑描边，浅色壁纸反过来（参考片实测）
      const lc = dark ? '#FFFFFF' : '#2A2D33', ls = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.82)';
      txt(it.label, D.x, y + 68, font(D.labelSize, 'medium'), lc, 'center', ls, 3);
    }
  }

  function dock(t) {
    const D = T.dock;
    G.save();
    G.shadowColor = 'rgba(0,0,0,0.24)'; G.shadowBlur = 22; G.shadowOffsetY = 8;
    box(D.x, D.y, D.w, D.h, D.bg, D.r, 'rgba(255,255,255,0.55)', 1);
    G.restore();
    const drawIcon = (kind, x, y, s) => {
      const r = 12;
      switch (kind) {
        case 'finder': {
          box(x, y, s, s, '#4A9BF0', r);
          G.save(); G.strokeStyle = '#FFFFFF'; G.fillStyle = '#FFFFFF'; G.lineWidth = 3; G.lineCap = 'round';
          G.beginPath(); G.arc(x + s * 0.36, y + s * 0.38, 2.6, 0, Math.PI * 2); G.fill();
          G.beginPath(); G.arc(x + s * 0.64, y + s * 0.38, 2.6, 0, Math.PI * 2); G.fill();
          G.beginPath(); G.arc(x + s / 2, y + s * 0.50, 11, 0.18 * Math.PI, 0.82 * Math.PI); G.stroke();
          G.restore(); break;
        }
        case 'wechat': box(x, y, s, s, '#34C759', r); txt('●', x + s / 2, y + s * 0.68, font(26), '#FFFFFF', 'center'); break;
        case 'player': box(x, y, s, s, '#1C1C1E', r); txt('▶', x + s / 2 + 2, y + s * 0.68, font(22), '#FFFFFF', 'center'); break;
        case 'music': box(x, y, s, s, '#FA2B56', r); txt('♪', x + s / 2, y + s * 0.7, font(28), '#FFFFFF', 'center'); break;
        case 'calendar': box(x, y, s, s, '#FBFBFB', r); box(x, y, s, 14, '#E8453C', r); txt('28', x + s / 2, y + s * 0.78, font(24, 'black'), '#1A1B1E', 'center'); break;
        case 'terminal': box(x, y, s, s, '#1C1C1E', r); txt('>_', x + s / 2, y + s * 0.66, mono(20), '#FFFFFF', 'center'); break;
        case 'notes': box(x, y, s, s, '#FFD426', r); box(x + 8, y + 10, s - 16, 5, 'rgba(0,0,0,0.18)', 2); box(x + 8, y + 22, s - 16, 5, 'rgba(0,0,0,0.18)', 2); box(x + 8, y + 34, s - 20, 5, 'rgba(0,0,0,0.18)', 2); break;
        case 'safari': {
          box(x, y, s, s, '#2E8BFF', r);
          G.save(); G.strokeStyle = '#FFFFFF'; G.lineWidth = 3;
          G.beginPath(); G.arc(x + s / 2, y + s / 2, 19, 0, Math.PI * 2); G.stroke();
          G.fillStyle = '#FF5F57'; G.beginPath();
          G.moveTo(x + s / 2 + 15, y + s / 2 - 11); G.lineTo(x + s / 2 - 9, y + s / 2 + 2);
          G.lineTo(x + s / 2 + 3, y + s / 2 + 13); G.closePath(); G.fill();
          G.restore(); break;
        }
        case 'obs': box(x, y, s, s, '#1C1C1E', r); txt('0:47', x + s / 2, y + s * 0.65, mono(13), '#F5B321', 'center'); break;
        case 'flag': box(x, y, s, s, '#E8B23A', r); box(x, y + 20, s, 18, '#2C4FA8', 0); break;
        case 'phone': box(x + 12, y, s - 24, s, '#2C3E6B', 9, '#8FA4D0', 2); break;
        case 'download': box(x, y, s, s, '#4A9BF0', r); txt('↓', x + s / 2, y + s * 0.72, font(30, 'black'), '#FFFFFF', 'center'); break;
        case 'trash': box(x + 8, y + 6, s - 16, s - 8, '#C9CDD2', 6); txt('≡', x + s / 2, y + s * 0.62, font(24), '#7C828A', 'center'); break;
      }
    };
    let x = D.firstX;
    for (const k of D.icons) {
      // 参考片里 Dock 图标有轻微呼吸律动，随音乐节拍；这里用 1.6px 的确定性正弦。
      const bob = Math.sin(t * 2.1 + x * 0.02) * 1.2;
      drawIcon(k, x, D.firstY + bob, D.icon);
      x += D.icon + D.gap;
    }
    G.save(); G.strokeStyle = 'rgba(60,64,72,0.28)'; G.lineWidth = 1;
    G.beginPath(); G.moveTo(D.separatorX, D.y + 14); G.lineTo(D.separatorX, D.y + D.h - 14); G.stroke(); G.restore();
    x = D.tailX;
    for (const k of D.tail) { drawIcon(k, x, D.firstY, D.icon); x += D.icon + D.gap; }
  }

  function presenter(t, hidden = false, override = null) {
    if (hidden) return;
    const C = override ? Object.assign({}, T.presenter, override) : T.presenter;
    G.save();
    shadow(C.x, C.y, C.w, C.h, C.r, 0.34, 30, 10);
    // 画面（或程序化占位）
    G.save(); rr(G, C.x, C.y, C.w, C.h, C.r); G.clip();
    if (presenterImg) {
      const ir = presenterImg.width / presenterImg.height, cr = C.w / C.h;
      let sx = 0, sy = 0, sw = presenterImg.width, sh = presenterImg.height;
      if (ir > cr) { sw = presenterImg.height * cr; sx = (presenterImg.width - sw) / 2; }
      else { sh = presenterImg.width / cr; sy = (presenterImg.height - sh) / 2; }
      G.drawImage(presenterImg, sx, sy, sw, sh, C.x, C.y, C.w, C.h);
    } else {
      const g = G.createLinearGradient(C.x, C.y, C.x + C.w, C.y + C.h);
      g.addColorStop(0, '#1A2A2A'); g.addColorStop(0.5, '#243B38'); g.addColorStop(1, '#101819');
      G.fillStyle = g; G.fillRect(C.x, C.y, C.w, C.h);
      // 摄像头占位：抽象头部 + 肩线，避免误用他人肖像
      G.fillStyle = 'rgba(255,255,255,0.10)';
      G.beginPath(); G.ellipse(C.x + C.w / 2, C.y + C.h * 0.44, 78, 96, 0, 0, Math.PI * 2); G.fill();
      G.beginPath(); G.ellipse(C.x + C.w / 2, C.y + C.h * 0.98, 168, 128, 0, 0, Math.PI * 2); G.fill();
      txt('CAM 01', C.x + C.w / 2, C.y + C.h * 0.62, mono(13), 'rgba(255,255,255,0.32)', 'center');
    }
    // 标题栏
    G.fillStyle = P.boardTitle; G.fillRect(C.x, C.y, C.w, C.titleH);
    [[P.red, 0], [P.yellow, 1], [P.green, 2]].forEach(([c, i]) => {
      G.beginPath(); G.arc(C.x + 16 + i * 18, C.y + C.titleH / 2, 5, 0, Math.PI * 2);
      G.fillStyle = c; G.fill();
    });
    txt(C.title, C.x + C.w / 2, C.y + 18, font(12, 'medium'), '#F4F5F7', 'center');
    txt('●  ' + mmss(t), C.x + C.w - 12, C.y + 18, font(10, 'medium'), '#E9706B', 'right');
    // ON AIR 胶囊
    box(C.x + 12, C.y + C.titleH + 10, 76, 22, 'rgba(10,12,14,0.78)', 11);
    G.beginPath(); G.arc(C.x + 24, C.y + C.titleH + 21, 4, 0, Math.PI * 2); G.fillStyle = P.green; G.fill();
    txt(C.onAir, C.x + 34, C.y + C.titleH + 26, mono(10), '#EFF1F3');
    // 底部控制条
    const cw = C.controlsW, cx = C.x + (C.w - cw) / 2, cy = C.y + C.h - C.controlsH - 16;
    box(cx, cy, cw, C.controlsH, 'rgba(10,12,14,0.76)', C.controlsH / 2);
    // 麦克风 / 挂断都自绘，避免 emoji 与私有区字形在 Noto 下变豆腐块
    G.save(); G.fillStyle = '#F2F3F5'; G.strokeStyle = '#F2F3F5'; G.lineWidth = 2;
    rr(G, cx + 18, cy + 9, 12, 17, 6); G.fill();
    G.beginPath(); G.arc(cx + 24, cy + 17, 9, Math.PI, 0); G.stroke();
    G.beginPath(); G.moveTo(cx + 24, cy + 26); G.lineTo(cx + 24, cy + 30); G.stroke();
    G.restore();
    for (let i = 0; i < 7; i++) box(cx + 52 + i * 9, cy + 16, 5, 6 + (i < 4 ? 6 : 2), i < 4 ? P.green : 'rgba(255,255,255,0.34)', 2);
    G.beginPath(); G.arc(cx + cw - 26, cy + C.controlsH / 2, 13, 0, Math.PI * 2); G.fillStyle = '#E8463C'; G.fill();
    G.save(); G.strokeStyle = '#FFFFFF'; G.lineWidth = 3; G.lineCap = 'round';
    G.beginPath(); G.moveTo(cx + cw - 34, cy + 15); G.lineTo(cx + cw - 18, cy + 21); G.stroke();
    G.restore();
    G.restore(); G.restore();
  }

  function subtitles(t, dark = true) {
    const S = T.subtitle;
    const cap = captions.find((c) => t >= c.start && t < c.end);
    if (!cap) return;
    // 墨色随壁纸明暗切换：白字+黑描边在浅灰壁纸上实测只有 1.26–1.53:1（不可读），
    // 浅底改用深墨字 + 白描边（≈15:1）。这是参考片没有、但交付必须解决的问题。
    const ink = dark ? P.caption : '#14161A';
    const inkStroke = dark ? P.captionStroke : 'rgba(255,255,255,0.92)';
    const accent = dark ? P.accentBright : '#A85A00';
    const sw = dark ? S.strokeWidth : Math.max(2, S.strokeWidth - 1);
    const chars = parseRich(cap.zh || '');
    // 字重/字号/描边按官方 demo 字幕区逐像素标定：参考是中等字重 + 细描边，
    // 早先的 Black/40px/4px 让字幕区锐度比达到 1.77×（见 tools/video-compare.py）。
    // 长文案按安全宽度整体缩一号，绝不裁字（模板原版会裁，那是缺陷不是设计）。
    let size = S.zhSize;
    while (size > 18 && richWidth(chars, font(size, 'medium')) > S.maxWidth) size -= 1;
    const f = font(size, 'medium');
    const reveal = clamp((t - cap.start) / Math.max(0.22, Math.min(1.1, (cap.end - cap.start) * 0.42)));
    const n = 1 + Math.floor(reveal * chars.length);
    drawRich(chars, W / 2, S.zhY, f, ink, accent, 'center', n, inkStroke, sw);
    if (cap.en) {
      const ep = pr(t, cap.start + 0.06, cap.start + 0.42);
      G.save(); G.globalAlpha = ep;
      txt(cap.en, W / 2, S.enY, font(S.enSize, 'medium'), ink, 'center', inkStroke, sw);
      G.restore();
    }
  }

  function cursor(t, s) {
    if (!s.args || !s.args.cursor) return;
    // cursor 可以是单个对象，也可以是数组：一段里飞多次，才不会出现
    // "前 1 秒动、后 4 秒定格"（实测段长 5.8s 时，单次 0.8s 只占 14%）。
    const list = Array.isArray(s.args.cursor) ? s.args.cursor : [s.args.cursor];
    for (const c of list) {
      const p = pr(t, s.t0 + (c.at || 0), s.t0 + (c.at || 0) + 0.8);
      if (p > 0 && p < 1) { drawCursor(c, p); return; }
    }
  }

  function drawCursor(c, p) {
    const x = lerp(c.from ? c.from[0] : 300, c.x, eo(p)), y = lerp(c.from ? c.from[1] : 700, c.y, eo(p));
    G.save();
    if (p > 0.78) {
      const r = (p - 0.78) / 0.22 * 34;
      G.strokeStyle = `rgba(255,255,255,${0.7 * (1 - (p - 0.78) / 0.22)})`;
      G.lineWidth = 3; G.beginPath(); G.arc(x, y, r, 0, Math.PI * 2); G.stroke();
    }
    G.translate(x, y); G.scale(1.5, 1.5);
    G.beginPath(); G.moveTo(0, 0); G.lineTo(0, 18); G.lineTo(4.5, 14); G.lineTo(8, 21);
    G.lineTo(11, 19.5); G.lineTo(7.5, 12.8); G.lineTo(13, 12.5); G.closePath();
    G.fillStyle = '#FFFFFF'; G.strokeStyle = '#111318'; G.lineWidth = 1.4; G.fill(); G.stroke();
    G.restore();
  }

  /* ────────────────────────── 组件 ────────────────────────── */
  function macWindow(x, y, w, h, o = {}) {
    const Wi = T.window, dark = !!o.dark, titleH = o.titleH || Wi.titleH;
    shadow(x, y, w, h, Wi.r, 0.30, 36, 16);
    G.save(); rr(G, x, y, w, h, Wi.r); G.clip();
    G.fillStyle = dark ? P.board : P.paper; G.fillRect(x, y, w, h);
    G.fillStyle = dark ? P.boardTitle : P.paperTitle;
    G.fillRect(x, y, w, titleH);
    G.restore();
    [[P.red, 0], [P.yellow, 1], [P.green, 2]].forEach(([c, i]) => {
      G.beginPath(); G.arc(x + Wi.dotX + i * Wi.dotGap, y + titleH / 2, Wi.dotR, 0, Math.PI * 2);
      G.fillStyle = c; G.fill();
    });
    if (o.title) txt(o.title, x + w / 2, y + titleH / 2 + 5, font(14, 'medium'), dark ? '#E9EAEC' : '#2E3136', 'center');
    if (o.right) windowGlyphs(x + w - 22, y + titleH / 2, dark ? '#9BA0A7' : '#7B8087');
    return { x, y: y + titleH, w, h: h - titleH };
  }

  /** split-flap 单块：上半/下半之间有一道 1px 缝，翻动时按余弦压缩。 */
  function flipTile(ch, x, y, w, h, p = 1, o = {}) {
    const r = o.r == null ? 8 : o.r;
    const size = o.size || Math.round(h * 0.62);
    const f = font(size, 'black');
    const col = o.color || '#F7F7F5';
    const scaleY = p < 1 ? Math.max(0.04, Math.abs(Math.cos(Math.PI * p))) : 1;
    G.save();
    box(x, y, w, h, o.bg || P.tile, r, o.edge || P.tileEdge, 1);
    G.save();
    rr(G, x, y, w, h, r); G.clip();
    G.translate(0, y + h / 2); G.scale(1, scaleY); G.translate(0, -(y + h / 2));
    G.globalAlpha = p < 1 ? 0.45 + 0.55 * p : 1;
    // 翻过 55% 才露出目标字符；之前是翻动中的空牌（split-flap 的中缝状态）。
    const shown = p > 0.55 ? ch : (o.next || '');
    txt(shown, x + w / 2, y + h / 2 + size * 0.35, f, col, 'center');
    G.restore();
    G.strokeStyle = 'rgba(0,0,0,0.55)'; G.lineWidth = 1;
    G.beginPath(); G.moveTo(x + 4, y + h / 2); G.lineTo(x + w - 4, y + h / 2); G.stroke();
    G.restore();
  }
  function flipWord(word, x, y, tile, gap, p, o = {}) {
    const chars = Array.from(String(word));
    const th = o.h || tile;
    for (let i = 0; i < chars.length; i++) {
      const local = clamp(p * (chars.length + 2) - i);
      flipTile(chars[i], x + i * (tile + gap), y, tile, th, local, o);
    }
    return chars.length * (tile + gap) - gap;
  }
  function notification(x, y, w, h, o = {}) {
    G.save(); G.shadowColor = 'rgba(0,0,0,0.3)'; G.shadowBlur = 24; G.shadowOffsetY = 8;
    box(x, y, w, h, o.dark ? 'rgba(30,32,36,0.90)' : 'rgba(248,249,250,0.86)', 16);
    G.restore();
    box(x + 12, y + 14, 42, 42, o.iconBg || '#FA2B56', 10);
    txt(o.icon || '♪', x + 33, y + 43, font(22), '#FFFFFF', 'center');
    txt(o.title || '', x + 66, y + 32, font(15, 'black'), o.dark ? '#F5F6F8' : '#1D1F23');
    txt(o.body || '', x + 66, y + 54, font(12), o.dark ? '#B8BCC3' : '#666B72');
    if (o.action) txt(o.action, x + w - 16, y + 32, font(12, 'medium'), '#8C9199', 'right');
  }
  function dashedBox(x, y, w, h, color, fill = null) {
    G.save();
    if (fill) { rr(G, x, y, w, h, 8); G.fillStyle = fill; G.fill(); }
    G.setLineDash([7, 6]); G.lineWidth = 1.6; G.strokeStyle = color;
    rr(G, x, y, w, h, 8); G.stroke(); G.setLineDash([]);
    G.restore();
  }
  function mmss(t) {
    const s = Math.max(0, Math.floor(t));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  /* ────────────────────────── 镜头 ────────────────────────── */
  const SHOTS = {
    /** 开场：深色翻牌屏 + 车次信息（对应 demo 0s / AI 存储） */
    title(t, s) {
      const a = s.args || {}, x = 40, y = 48, w = 860, h = 620;
      const b = macWindow(x, y, w, h, { dark: true, title: a.app || '时代列车', right: '⌕  ···' });
      txt('DEPARTURES · 出发', b.x + 18, b.y + 26, font(11, 'medium'), P.accent);
      const tabs = ['出发', '到达', '线路'];
      tabs.forEach((v, i) => box(b.x + 340 + i * 54, b.y + 8, 48, 24, i === 0 ? '#33363B' : 'rgba(255,255,255,0.05)', 6));
      tabs.forEach((v, i) => txt(v, b.x + 364 + i * 54, b.y + 25, font(11), i === 0 ? '#F0F1F3' : '#8B8F96', 'center'));
      txt('G47 · 15:04', x + w - 18, b.y + 26, mono(11), '#8B8F96', 'right');
      const p = pr(t, s.t0 + 0.15, s.t0 + 1.5);
      // 标题字数不固定：按字数收窄牌宽，保证总宽 ≤400，不压到 b.x+500 的车次信息。
      // demo 是 4 字（88px/块），第二条片子 5 字「环境别踩坑」用 72px/块。
      const hn = Array.from(a.headline || 'AI 存储').length;
      const tile = Math.min(88, Math.floor((400 - 10 * (hn - 1)) / hn));
      flipWord(a.headline || 'AI 存储', b.x + 60, b.y + 48, tile, 10, p,
        { size: Math.round(tile * 0.7) });
      txt('车次', b.x + 500, b.y + 92, font(13), '#8B8F96');
      txt(a.train || 'AI 快车', b.x + 500, b.y + 126, font(28, 'black'), '#F5F6F8');
      txt('状态', b.x + 500, b.y + 166, font(13), '#8B8F96');
      txt(a.status || '票中', b.x + 500, b.y + 202, font(28, 'black'), P.accent);
      for (let r = 0; r < 2; r++) for (let i = 0; i < 6; i++) {
        const tw2 = i < 2 ? 196 : 88;
        box(b.x + 60 + i * (i < 2 ? 206 : 98), b.y + 200 + r * 108, tw2, 98, 'rgba(255,255,255,0.035)', 4);
      }
      for (let i = 0; i < 10; i++) box(b.x + 60 + i * 68, b.y + 430, 58, 32, 'rgba(255,255,255,0.04)', 3);
    },

    /** 纯口播：桌面骨架 + 人物窗，可选一条通知 */
    talk(t, s) {
      const a = s.args || {};
      if (a.notify) {
        const p = pr(t, s.t0 + (a.notify.at || 0.1), s.t0 + (a.notify.at || 0.1) + 0.45);
        G.save(); G.globalAlpha = eo(p); G.translate(0, -18 * (1 - eo(p)));
        notification(1030, 34, 292, 88, a.notify); G.restore();
      }
      if (a.label) {
        const p = pr(t, s.t0, s.t0 + 0.5);
        G.save(); G.globalAlpha = eo(p);
        txt(a.label, 80, 180, font(54, 'black'), onWall(P.paper, '#14161A'),
          'left', onWallStroke(), 5);
        G.restore();
      }
    },

    /** 全屏深色翻牌屏：逐字揭示大标题 */
    flipBoard(t, s) {
      const a = s.args || {};
      const p = pr(t, s.t0 + 0.1, s.t0 + 1.4);
      // 右缘止于 900，给 x=940 的人物摄像头窗口留 40px 净空（抽帧复核抓到的遮挡）
      box(180, 250, 720, 300, P.board, 16);
      txt(a.kicker || '// STILL BOARD', 212, 292, font(13, 'medium'), P.accent);
      flipWord(a.word || '一般', 212, 320, 118, 12, p, { size: 84 });
      if (a.sub) txt(a.sub, 212, 500, font(24, 'medium'), '#C9CDD4');
      for (let i = 0; i < 16; i++) box(212 + i * 42, 520, 30, 8, 'rgba(255,255,255,0.06)', 2);
    },

    /** 评论截图瀑布（3 列 × 4 行，逐张入场） */
    comments(t, s) {
      const a = s.args || {}, items = a.items || [];
      const cols = 3, cw = 282, ch = 148, gx = 8, gy = 12, x0 = 30, y0 = 56;
      for (let i = 0; i < Math.min(12, items.length); i++) {
        const c = i % cols, r = Math.floor(i / cols);
        const x = x0 + c * (cw + gx), y = y0 + r * (ch + gy);
        const p = pr(t, s.t0 + 0.08 * i, s.t0 + 0.08 * i + 0.42);
        if (p <= 0) continue;
        G.save(); G.globalAlpha = eo(p); G.translate(0, 26 * (1 - eo(p)));
        box(x, y, cw, ch, items[i].hi ? '#E08A0A' : '#1A1C20', 10, 'rgba(255,255,255,0.08)', 1);
        [[P.red, 0], [P.yellow, 1], [P.green, 2]].forEach(([col, k]) => {
          G.beginPath(); G.arc(x + 16 + k * 15, y + 16, 4, 0, Math.PI * 2); G.fillStyle = col; G.fill();
        });
        txt(`评论 ${String(i + 1).padStart(2, '0')}.png`, x + cw / 2, y + 20, font(11, 'medium'), '#C9CDD4', 'center');
        const words = String(items[i].text || '');
        for (let l = 0; l < 3; l++) {
          const line = words.slice(l * 15, (l + 1) * 15);
          if (line) txt(line, x + 14, y + 48 + l * 22, font(13), items[i].hi ? '#1A1208' : '#D7D9DE');
        }
        G.restore();
      }
    },

    /** 白窗口评估：手机截图 + 翻牌评价 + 虚线能力格（t104 原帧） */
    rating(t, s) {
      const a = s.args || {}, x = 40, y = 140, w = 895, h = 760;
      const b = macWindow(x, y, w, h, { title: a.title || '评估 — 前辈的作品', right: '⌃  ⓘ' });
      // 左：竖版手机截图
      const px = b.x + 60, py = b.y + 68, pw = 196, ph = 370;
      shadow(px, py, pw, ph, 8, 0.35, 22, 8);
      box(px - 5, py - 5, pw + 10, ph + 10, '#15161A', 4);
      box(px, py, pw, ph, '#EAE8DE', 2);
      box(px, py, pw, 26, '#1C1D20', 2);
      txt('前辈的作品.mp4', px + 10, py + 18, font(9), '#EDEFEE');
      const hs = fitSize(a.phoneTitle || '我给自己组建了7人AI员工队伍', 26, pw - 24, (n) => font(n, 'black'), 14);
      txt((a.phoneTitle || '我给自己组建了7人AI员工队伍').slice(0, 9), px + 12, py + 78, font(hs, 'black'), '#15161A');
      txt((a.phoneTitle || '我给自己组建了7人AI员工队伍').slice(9, 18), px + 12, py + 78 + hs + 2, font(hs, 'black'), '#8E2FA8');
      txt('· 7人AI员工队伍', px + 12, py + ph - 24, font(9, 'medium'), '#55585C');
      // 中：评价
      txt('评价', b.x + 380, b.y + 76, font(24), '#9DA1A6');
      const p = pr(t, s.t0 + 0.2, s.t0 + 1.2);
      flipWord(a.verdict || '一般', b.x + 380, b.y + 100, 118, 12, p, { size: 80, h: 146, bg: '#15161A' });
      // 下：模板能力 + 10 格
      txt(a.barLabel || '模板能力', b.x + 60, b.y + 520, font(28, 'black'), '#15161A');
      const n = a.filled == null ? 2 : a.filled, total = 10;
      for (let i = 0; i < total; i++) {
        const bx = b.x + 60 + i * 84, by = b.y + 540;
        const ip = pr(t, s.t0 + 0.35 + i * 0.05, s.t0 + 0.75 + i * 0.05);
        dashedBox(bx, by, 76, 66, 'rgba(60,64,70,0.42)', i < n && ip > 0 ? P.accent : null);
      }
      if (a.foot) txt(a.foot, b.x + 154, b.y + 634, font(22, 'medium'), P.accent);
    },

    /** 深色终端：滚动日志 + 闪烁光标 */
    terminal(t, s) {
      const a = s.args || {};
      const b = macWindow(150, 300, 720, 430, { dark: true, title: a.title || 'terminal — zsh', right: '—  □  ×' });
      const lines = a.lines || ['$ git status', 'On branch main', '$ npm run build', '✓ 16 modules transformed', '$ render --preset desktop', 'done in 2.3s'];
      const n = Math.floor(pr(t, s.t0, s.t0 + 1.6) * lines.length);
      for (let i = 0; i < n; i++) {
        const l = lines[i];
        txt(l, b.x + 24, b.y + 40 + i * 30, mono(16), l.startsWith('$') ? P.green : l.startsWith('✓') || l.startsWith('done') ? P.accent : '#D6D9DE');
      }
      if (Math.floor(t * 2) % 2 === 0) box(b.x + 24 + tw(lines[Math.min(n, lines.length - 1)] || '', mono(16)), b.y + 26 + n * 30, 10, 18, P.accent, 1);
    },

    /** 翻牌数字计数器 */
    counter(t, s) {
      const a = s.args || {};
      // 放在左侧：x=880 会被 x=940 的人物摄像头窗口整块盖住（第二次复用才暴露）。
      const x = 140, y = 200, w = 420, h = 230;
      shadow(x, y, w, h, 12, 0.3, 26, 10);
      box(x, y, w, h, P.board, 12);
      txt(a.label || '累计下载', x + 24, y + 36, font(12, 'medium'), P.accent);
      const p = pr(t, s.t0 + 0.1, s.t0 + 1.1);
      flipWord(a.value || '1000+', x + 24, y + 56, 68, 8, p, { size: 46 });
      if (a.sub) txt(a.sub, x + 24, y + h - 24, font(14), '#9DA2AA');
    },

    /** 站牌砸入（整屏翻牌转场后的章节标题） */
    station(t, s) {
      const a = s.args || {};
      const p = pr(t, s.t0, s.t0 + 0.42);
      const e = 1 - Math.pow(1 - p, 4);
      const w = 360, h = 116, x = W / 2 - w / 2, y = 180;
      G.save(); G.translate(0, -260 * (1 - e));
      shadow(x, y, w, h, 10, 0.32, 26, 10);
      box(x, y, w, h, '#FBFBFB', 10, '#15161A', 3);
      const fs = fitSize(a.name || '前靠站', 52, w - 40, (n) => font(n, 'black'), 24);
      txt(a.name || '前靠站', W / 2, y + 70, font(fs, 'black'), '#15161A', 'center');
      box(x + 24, y + h - 16, w - 48, 4, '#15161A', 2);
      G.restore();
      if (a.sub) {
        G.save(); G.globalAlpha = pr(t, s.t0 + 0.3, s.t0 + 0.7);
        txt(a.sub, W / 2, y + h + 54, font(22, 'medium'), onWall('#F5F6F8', '#14161A'),
          'center', onWallStroke(), 4);
        G.restore();
      }
    },

    /** 通知横幅叠加 + 点击光标 */
    notify(t, s) {
      const a = s.args || {};
      const p = pr(t, s.t0 + 0.1, s.t0 + 0.5);
      G.save(); G.globalAlpha = eo(p); G.translate(0, -24 * (1 - eo(p)));
      notification(1030, 34, 292, 88, a);
      G.restore();
      if (a.message) {
        const b = macWindow(360, 360, 520, 210, { dark: true, title: a.messageTitle || '消息', right: '···' });
        txt(a.message, b.x + 28, b.y + 70, font(26, 'black'), '#F5F6F8');
      }
    },

    /** 白窗口 + 折线图 */
    chart(t, s) {
      const a = s.args || {};
      // 右缘止于 920，给 x=940 的人物窗口留 20px 净空
      const b = macWindow(400, 200, 520, 500, { title: a.title || '增长曲线', right: '⌃  ⓘ' });
      const x0 = b.x + 56, y0 = b.y + 40, w = b.w - 100, h = b.h - 110;
      G.save(); G.strokeStyle = 'rgba(30,34,40,0.10)'; G.lineWidth = 1;
      for (let i = 0; i <= 4; i++) { G.beginPath(); G.moveTo(x0, y0 + i * h / 4); G.lineTo(x0 + w, y0 + i * h / 4); G.stroke(); }
      G.restore();
      const pts = a.points || [0.06, 0.10, 0.16, 0.22, 0.30, 0.42, 0.55, 0.72, 0.92];
      const p = pr(t, s.t0 + 0.1, s.t0 + 1.3);
      G.save(); G.strokeStyle = P.blue; G.lineWidth = 4; G.lineJoin = 'round'; G.lineCap = 'round';
      G.beginPath();
      pts.forEach((v, i) => {
        const X = x0 + i * w / (pts.length - 1), Y = y0 + h - v * h * eo(clamp(p * 1.4 - i * 0.05));
        i === 0 ? G.moveTo(X, Y) : G.lineTo(X, Y);
      });
      G.stroke(); G.restore();
      txt(a.value || '+ 900%', x0 + w - 20, y0 + 44, font(28, 'black'), P.blue, 'right');
    },

    /** 票券卡 + 价格翻牌 + 印章 */
    tickets(t, s) {
      const a = s.args || {};
      const x = 180, y = 300, w = 560, h = 280;
      shadow(x, y, w, h, 14, 0.28, 28, 10);
      box(x, y, w, h, '#F6F1E4', 14, 'rgba(20,22,26,0.15)', 1);
      box(x, y, 12, h, P.accent, 0);
      txt(a.kicker || 'TICKET · 车票', x + 36, y + 48, font(13, 'medium'), '#8A7040');
      txt(a.title || 'AI 快车道', x + 36, y + 106, font(48, 'black'), '#15161A');
      txt(a.sub || '单程 · 先上车', x + 36, y + 148, font(18, 'medium'), '#6A6F76');
      G.save(); G.setLineDash([6, 6]); G.strokeStyle = 'rgba(20,22,26,0.25)'; G.lineWidth = 1;
      G.beginPath(); G.moveTo(x + 36, y + 180); G.lineTo(x + w - 36, y + 180); G.stroke(); G.setLineDash([]); G.restore();
      const p = pr(t, s.t0 + 0.2, s.t0 + 1.0);
      flipWord(a.price || '¥ 0', x + 36, y + 200, 56, 6, p, { size: 34 });
      // 印章
      G.save(); G.translate(x + w - 96, y + h - 78); G.rotate(-0.18);
      box(-52, -26, 104, 52, 'rgba(214,58,48,0.0)', 8, '#D63A30', 3);
      txt(a.stamp || '已检票', 0, 8, font(20, 'black'), '#D63A30', 'center');
      G.restore();
    },

    /** 排名翻牌换位（t176 原帧） */
    ranking(t, s) {
      const a = s.args || {};
      const x = 100, y = 240, w = 640, h = 300;
      shadow(x, y, w, h, 12, 0.30, 26, 10);
      box(x, y, w, h, '#15161A', 12);
      txt('排名 · RANKING', x + 24, y + 34, font(11, 'medium'), P.accent);
      const rows = a.rows || ['计业存公到', '行技飞'];
      const p = pr(t, s.t0 + 0.15, s.t0 + 1.2);
      rows.forEach((row, r) => {
        const chars = Array.from(row);
        txt(String(r + 1), x + 26, y + 112 + r * 96, font(44, 'black'), r === 0 ? P.accent : '#A6A9AE');
        for (let i = 0; i < chars.length; i++) {
          const lp = clamp(p * (chars.length + 2) - i - r * 0.6);
          flipTile(chars[i], x + 122 + i * 78, y + 58 + r * 96, 68, 68, lp, { size: 42 });
        }
      });
      if (a.sub) txt(a.sub, x + w / 2, y + h + 56, font(28, 'black'),
        onWall('#F5F6F8', '#15161A'), 'center', onWallStroke(), 4);
    },

    /** 聊天窗口 + 竖屏视频插入 */
    chat(t, s) {
      const a = s.args || {};
      const b = macWindow(140, 180, 620, 620, { title: a.title || '信息', right: '⌕  ···' });
      const msgs = a.messages || ['这个模板真好用', '能不能给我一份？', '已经发你邮箱了'];
      msgs.forEach((m, i) => {
        const p = pr(t, s.t0 + 0.25 * i, s.t0 + 0.25 * i + 0.4);
        if (p <= 0) return;
        const left = i % 2 === 0, bx = left ? b.x + 28 : b.x + b.w - 28 - Math.min(360, tw(m, font(20)) + 40);
        const by = b.y + 40 + i * 92;
        G.save(); G.globalAlpha = eo(p);
        box(bx, by, Math.min(360, tw(m, font(20)) + 40), 58, left ? '#E9EAEC' : P.blue, 16);
        txt(m, bx + 20, by + 36, font(20), left ? '#1D1F23' : '#FFFFFF');
        G.restore();
      });
      // 竖屏插入视频位
      const vx = b.x + b.w - 190, vy = b.y + b.h - 300;
      box(vx, vy, 150, 270, '#15161A', 8, 'rgba(255,255,255,0.2)', 2);
      txt('▶', vx + 75, vy + 150, font(40), '#FFFFFF', 'center');
    },

    /** 文件图标散开 */
    files(t, s) {
      const a = s.args || {}, n = a.count || 8;
      for (let i = 0; i < n; i++) {
        const p = pr(t, s.t0 + i * 0.06, s.t0 + i * 0.06 + 0.5);
        const ang = -0.9 + i * (1.8 / Math.max(1, n - 1));
        const R = 240 * eo(p);
        const x = 520 + Math.cos(ang) * R - 30, y = 620 - Math.sin(ang) * R - 34;
        G.save(); G.globalAlpha = eo(p);
        box(x, y, 60, 68, i % 3 === 0 ? '#4A9BF0' : '#FBFBFB', 6, 'rgba(20,22,26,0.18)', 1);
        txt(String(i + 1), x + 30, y + 42, font(20, 'black'), i % 3 === 0 ? '#FFFFFF' : '#15161A', 'center');
        G.restore();
      }
    },

    /** 清单 / 矩阵（16 套模板） */
    checklist(t, s) {
      const a = s.args || {};
      const b = macWindow(80, 160, 840, 680, { title: a.title || '模板清单', right: '⌃  ⓘ' });
      txt(String(a.value || '16'), b.x + 40, b.y + 110, font(92, 'black'), '#15161A');
      txt(a.unit || '套模板', b.x + 170, b.y + 110, font(30, 'medium'), '#5B6068');
      const n = a.count || 16, cols = 8;
      for (let i = 0; i < n; i++) {
        const p = pr(t, s.t0 + i * 0.03, s.t0 + i * 0.03 + 0.35);
        const x = b.x + 40 + (i % cols) * 96, y = b.y + 160 + Math.floor(i / cols) * 96;
        G.save(); G.globalAlpha = eo(p); G.translate(0, 14 * (1 - eo(p)));
        box(x, y, 78, 78, i % 5 === 0 ? P.accent : '#DCE9F8', 8);
        G.restore();
      }
    },

    /** 结尾：票券 + 光标关闭摄像头窗口 */
    outro(t, s) {
      const a = s.args || {};
      const x = 200, y = 250, w = 620, h = 360;
      shadow(x, y, w, h, 14, 0.30, 30, 12);
      box(x, y, w, h, '#F6F1E4', 14);
      txt(a.title || '谢谢观看', x + 40, y + 96, font(58, 'black'), '#15161A');
      (a.lines || ['把模板换成你的内容', '一条命令出片']).forEach((l, i) => {
        txt('·  ' + l, x + 44, y + 160 + i * 40, font(22, 'medium'), '#4A4F56');
      });
      box(x + 40, y + h - 82, 220, 48, P.blue, 24);
      txt(a.cta || '去试试 →', x + 150, y + h - 50, font(20, 'black'), '#FFFFFF', 'center');
      if (a.brand) txt(a.brand, x + w - 36, y + h - 48, font(16, 'medium'), '#8A7040', 'right');
    },

    /**
     * 照片镜头：full = 全屏铺底（横图）+ 慢推 + 底部压暗；window = 相框卡片（竖图）。
     * 素材由 setContent({ photos }) 注入；缺图直接抛错，不画空白。
     */
    photo(t, s) {
      const a = s.args || {};
      const img = photos[a.key];
      if (!img) throw new Error(`desktop-kit: photo "${a.key}" 没有注入素材`);

      if (a.layout === 'window') {
        const x = 150, y = 112, w = 520, h = 700, tb = 30;
        shadow(x, y, w, h, 14, 0.32, 32, 12);
        G.save(); rr(G, x, y, w, h, 14); G.clip();
        G.fillStyle = '#141519'; G.fillRect(x, y, w, h);
        const sc = Math.min(w / img.width, h / img.height);
        const iw = img.width * sc, ih = img.height * sc;
        G.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
        G.restore();
        G.save(); rr(G, x, y, w, tb, 14); G.clip();
        G.fillStyle = P.boardTitle; G.fillRect(x, y, w, tb); G.restore();
        [[P.red, 0], [P.yellow, 1], [P.green, 2]].forEach(([c, i]) => {
          G.beginPath(); G.arc(x + 16 + i * 18, y + tb / 2, 5, 0, Math.PI * 2);
          G.fillStyle = c; G.fill();
        });
        txt(a.file || '南京 · 照片', x + 78, y + tb / 2 + 4, font(12, 'medium'), '#E8EAEE');
        txt(a.credit || 'Pexels', x + w - 12, y + tb / 2 + 4, font(10), '#8B9099', 'right');
        if (a.title) txt(a.title, x + 6, y + h + 48, font(34, 'black'), onWall('#F5F6F8', '#15161A'), 'left', onWallStroke(), 4);
        if (a.sub) txt(a.sub, x + 8, y + h + 80, font(18, 'medium'), onWall('#C9CDD4', '#4A4F56'));
        return;
      }

      const g = G.createLinearGradient(0, H * 0.52, 0, H);
      g.addColorStop(0, 'rgba(6,8,12,0)');
      g.addColorStop(0.55, 'rgba(6,8,12,0.55)');
      g.addColorStop(1, 'rgba(6,8,12,0.86)');
      G.fillStyle = g; G.fillRect(0, H * 0.52, W, H * 0.48);
      G.save(); G.globalAlpha = pr(t, s.t0 + 0.1, s.t0 + 0.9);
      if (a.title) txt(a.title, 80, 812, font(56, 'black'), '#FFFFFF', 'left', 'rgba(0,0,0,0.45)', 6);
      if (a.sub) txt(a.sub, 82, 858, font(22, 'medium'), 'rgba(255,255,255,0.88)');
      G.restore();
      txt(a.credit || 'Pexels', W - 24, H - 50, font(11, 'medium'), 'rgba(255,255,255,0.6)', 'right');
    },

    /**
     * 视频片段：底图由 drawAll 按时间取帧画好，这里只负责压暗、标题与时间码。
     * 加时间码是刻意的：让观众知道这是真实素材，不是生成的静帧。
     */
    clip(t, s) {
      const a = s.args || {};
      const frames = clips[a.key];
      if (!frames) throw new Error(`desktop-kit: clip "${a.key}" 没有注入帧序列`);
      const fps = a.fps || 20;
      const idx = Math.min(frames.length - 1, Math.max(0, Math.floor((t - s.t0) * fps)));

      const g = G.createLinearGradient(0, H * 0.52, 0, H);
      g.addColorStop(0, 'rgba(6,8,12,0)');
      g.addColorStop(0.55, 'rgba(6,8,12,0.55)');
      g.addColorStop(1, 'rgba(6,8,12,0.86)');
      G.fillStyle = g; G.fillRect(0, H * 0.52, W, H * 0.48);

      // 左上：录制指示 + 时间码（等宽字，弱化存在感）
      const mm = String(Math.floor(idx / fps / 60)).padStart(2, '0');
      const ss = String(Math.floor(idx / fps) % 60).padStart(2, '0');
      const ff = String(Math.floor((idx % fps) * 100 / fps)).padStart(2, '0');
      G.beginPath(); G.arc(86, 66, 5, 0, Math.PI * 2); G.fillStyle = '#F04A42'; G.fill();
      txt(`${mm}:${ss}.${ff}`, 100, 71, mono(13), 'rgba(255,255,255,0.82)');

      G.save(); G.globalAlpha = pr(t, s.t0 + 0.1, s.t0 + 0.7);
      if (a.title) txt(a.title, 80, 812, font(56, 'black'), '#FFFFFF', 'left', 'rgba(0,0,0,0.45)', 6);
      if (a.sub) txt(a.sub, 82, 858, font(22, 'medium'), 'rgba(255,255,255,0.88)');
      G.restore();
      txt(a.credit || 'Pexels 素材', W - 24, H - 50, font(11, 'medium'), 'rgba(255,255,255,0.6)', 'right');
    },
  };

  /**
   * 照片取景：cover（铺满，按 focus 取主体）+ 可选 Ken Burns 推近。
   * 竖图直接铺 4:3 会切掉主体，所以另有 window 布局（contain 进卡片）。
   */
  /**
   * 照片的明暗不能用「章节壁纸」推断 —— 玄武湖那张章节是浅色壁纸，底部其实是深色水面。
   * 缩到 64×48 取底部 40%（字幕区）的平均亮度，判一次缓存住。
   */
  const photoDarkCache = {};
  function photoIsDark(key, img) {
    if (photoDarkCache[key] != null) return photoDarkCache[key];
    const c = createCanvas(64, 48), g = c.getContext('2d');
    g.drawImage(img, 0, 0, 64, 48);
    const d = g.getImageData(0, 0, 64, 48).data;
    let sum = 0, n = 0;
    for (let y = 28; y < 48; y++) for (let x = 0; x < 64; x++) {
      const k = (y * 64 + x) * 4;
      sum += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; n++;
    }
    photoDarkCache[key] = (sum / n) < 110;
    return photoDarkCache[key];
  }

  function drawPhotoCover(img, x, y, w, h, zoom = 1, fx = 0.5, fy = 0.5) {
    const ir = img.width / img.height, cr = w / h;
    let sw, sh;
    if (ir > cr) { sh = img.height; sw = sh * cr; } else { sw = img.width; sh = sw / cr; }
    sw /= zoom; sh /= zoom;
    const sx = (img.width - sw) * clamp(fx), sy = (img.height - sh) * clamp(fy);
    G.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  /* ────────────────────────── 编排 ────────────────────────── */
  function shotAt(t) {
    for (let i = shots.length - 1; i >= 0; i--) if (t >= shots[i].t0) return i;
    return 0;
  }
  function chapterOf(s) {
    if (!s || !s.chapter) return { name: '', idx: 0, wall: 'blue' };
    const hit = chapters.find((c) => c.name === s.chapter);
    const idx = Math.max(0, chapters.findIndex((c) => c.name === s.chapter));
    return { name: s.chapter, idx, wall: (hit && hit.wall) || 'blue' };
  }

  function drawAll(g, t, idx) {
    G = g;
    G.save(); G.setTransform(1, 0, 0, 1, 0, 0); G.clearRect(0, 0, W, H);
    const s = shots[idx];
    const ch = chapterOf(s);
    const ph = s.type === 'photo' ? photos[(s.args || {}).key] : null;
    const cl = s.type === 'clip' ? clips[(s.args || {}).key] : null;
    if (s.type === 'clip' && !cl) throw new Error(`desktop-kit: clip "${(s.args || {}).key}" 没有注入帧序列`);
    const fullBleed = (!!ph || !!cl) && (s.args || {}).layout !== 'window';
    let dark = ch.wall === 'blue' || ch.wall === 'red';
    // full 布局在 photo()/clip() 里恒叠底部 0.86 压暗渐变，字幕区「合成后」必然是深色 → 白字。
    // 原素材亮度不是有效判据：实测 boil 片段底部均值 139 会被误判成浅底深墨字，直接读不出来。
    // autoDark=true 可显式回退到原素材实测；dark=false 留给将来「不压暗」的特殊镜头。
    if (fullBleed) {
      const a = s.args || {};
      dark = a.autoDark === true
        ? photoIsDark(s.type === 'clip' ? 'clip:' + a.key : a.key, ph || cl[0])
        : a.dark !== false;
    }
    curDark = dark;
    if (fullBleed) {
      const p = pr(t, s.t0, s.t1), z = 1.05 + 0.07 * p;   // 慢推：1.05 → 1.12
      if (ph) drawPhotoCover(ph, 0, 0, W, H, z, (s.args || {}).fx, (s.args || {}).fy);
      else {
        // 视频本身在动，不再叠加推镜，否则会晕
        const fps = (s.args && s.args.fps) || 20;
        const idx = Math.min(cl.length - 1, Math.max(0, Math.floor((t - s.t0) * fps)));
        drawPhotoCover(cl[idx], 0, 0, W, H, 1, (s.args || {}).fx, (s.args || {}).fy);
      }
      // 深色照片上菜单栏与图标是白字：顶部压暗一层，避免白字落在亮天空上
      if (dark) {
        const tg = G.createLinearGradient(0, 0, 0, 300);
        tg.addColorStop(0, 'rgba(0,0,0,0.42)'); tg.addColorStop(1, 'rgba(0,0,0,0)');
        G.fillStyle = tg; G.fillRect(0, 0, W, 300);
      }
    } else {
      wallpaper(ch.wall, t);
    }
    menuBar(ch.name, ch.idx, dark);
    desktopIcons(s.args && s.args.iconHighlight, dark);
    const fn = SHOTS[s.type];
    if (!fn) throw new Error(`desktop-kit: 未知镜头类型 "${s.type}"，可用：${SHOT_TYPES.join(', ')}`);
    fn(t, s);
    dock(t);
    presenter(t, s.args && s.args.noPresenter, s.args && s.args.presenterBox);
    subtitles(t, dark);
    cursor(t, s);
    if (brand && !(s.args && s.args.noBrand)) {
      txt(brand, W - 24, H - 24, font(13, 'medium'), dark ? 'rgba(255,255,255,0.55)' : 'rgba(20,22,28,0.45)', 'right');
    }
    G.restore();
    G = ctx;
  }

  /** 整屏翻牌转场：12 条竖带，按余弦压缩逐条翻到下一镜头。 */
  function flipTransition(t, idx) {
    const cur = shots[idx], prev = shots[idx - 1];
    const dur = T.flip.transitionDuration;
    const bands = T.flip.transitionBands;
    drawAll(offCtx[0], cur.t0 - 0.001, idx - 1);
    drawAll(offCtx[1], t, idx);
    const bw = W / bands;
    for (let i = 0; i < bands; i++) {
      const stagger = (i / bands) * (dur * 0.45);
      const p = pr(t, cur.t0 + stagger, cur.t0 + stagger + dur * 0.55);
      const k = Math.max(0.02, Math.abs(Math.cos(Math.PI * p)));
      const src = p < 0.5 ? off[0] : off[1];
      const sx = i * bw, dw = bw * k;
      ctx.drawImage(src, sx, 0, bw, H, sx + (bw - dw) / 2, 0, dw, H);
      if (k < 0.14) { ctx.fillStyle = 'rgba(8,9,12,0.92)'; ctx.fillRect(sx, 0, bw, H); }
    }
  }

  function renderFrame(t) {
    const idx = shotAt(t);
    const cur = shots[idx], prev = shots[idx - 1];
    const chapterChanged = prev && chapterOf(prev).name !== chapterOf(cur).name && chapterOf(cur).name;
    if (chapterChanged && t < cur.t0 + T.flip.transitionDuration) flipTransition(t, idx);
    else drawAll(ctx, t, idx);
  }

  return {
    renderFrame,
    setContent(c) {
      validateParams(c);
      shots = (c.shots || []).slice().sort((a, b) => a.t0 - b.t0);
      captions = (c.captions || []).slice();
      chapters = c.chapters || [];
      presenterImg = c.presenter || null;
      photos = c.photos || {};
      clips = c.clips || {};
      brand = c.brand || '';
      return this;
    },
    get shots() { return shots; },
    get meta() { return { width: W, height: H, fps: T.fps, shotTypes: SHOT_TYPES }; },
    /** 自检用：把指定元素的关键几何暴露出来，不依赖画面识别 */
    geometry() {
      return {
        menuH: T.menuBar.h, dock: T.dock, presenter: T.presenter,
        iconX: T.desktopIcons.x, subtitle: T.subtitle, window: T.window.default,
      };
    },
  };
}
