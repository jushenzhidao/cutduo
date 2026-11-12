#!/usr/bin/env node
/**
 * Skia（无浏览器）版 editorial 剪辑：读取同一份 inputs，用 Canvas 2D 重绘 8 段分镜，
 * 输出 JPEG 帧流给 FFmpeg 编码，再与同一条音轨混音。
 *
 * 用法:
 *   node canvas-editorial.mjs --inputs edits/inputs-v6.json --out out/skia-cut.mp4 \
 *     --audio edits/audio-v6.m4a [--probe out/skia-probe.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from './skia-kit/paper.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const INPUTS = path.resolve(get('inputs', 'edits/inputs-v6.json'));
const OUT = path.resolve(get('out', 'out/skia-cut.mp4'));
const AUDIO = get('audio', 'edits/audio-v6.m4a');
const PROBE = get('probe', null);
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// 字体：Noto Sans SC（与 motion-kit 同源的思源黑体）优先，PingFang 兜底。
// 注意：Skia 对 PingFang.ttc 的注册是静默失败的（GlobalFonts.has 返回 false），
// 旧版一直在用回退字体渲染，字形偏窄偏细——这是“锐度差一截”的根因。
const FONT_DIR = path.resolve('assets/fonts');
const HAS_NOTO = registerFonts(FONT_DIR) > 0;
if (!HAS_NOTO) {
  for (const p of ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc']) {
    try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, 'PingFang SC'); } catch { /* ignore */ }
  }
}
const warnedText = new Set();
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

const W = 1920, H = 1080;
let d, scenes, captions, FPS, DURATION, FRAMES;
let LOADED_INPUTS = null;
function loadInputs(p = INPUTS) {
  d = JSON.parse(fs.readFileSync(p, 'utf8'));
  scenes = d.scenes || [];
  captions = d.captions || [];
  FPS = d.fps || 24;
  DURATION = d.durationSeconds;
  FRAMES = Math.round(DURATION * FPS);
  LOADED_INPUTS = path.resolve(p);
}
loadInputs();

// 口播头像：默认加载 edits/assets/avatar.png，--avatar off 可关闭
const AVATAR_ARG = get('avatar', 'edits/assets/avatar.png');
const SHOW_AVATAR = AVATAR_ARG !== 'off';
const AVATAR_PATH = SHOW_AVATAR ? path.resolve(AVATAR_ARG) : null;
let avatarImg = null;
if (AVATAR_PATH && fs.existsSync(AVATAR_PATH)) {
  try { avatarImg = await loadImage(AVATAR_PATH); } catch (e) { console.warn('  ⚠ 头像加载失败:', e.message); }
}

let SKIN = String(get('skin', d.skin || ''));
const THEMES = {
  knowledge: { paper: '#F7F7F5', ink: '#0A0A0A', accent: '#2462EA', accent2: '#5B8CFF', dim: '#8C8C8C', red: '#E5484D', soft: 'rgba(36,98,234,0.10)', onAccent: '#FFFFFF', mark: '#0A0A0A' },
  product:   { paper: '#F1F6F9', ink: '#0B1620', accent: '#0E7C86', accent2: '#3FB6BE', dim: '#7C8B95', red: '#D94841', soft: 'rgba(14,124,134,0.12)', onAccent: 'rgba(255,255,255,0.62)', mark: '#FFFFFF' },
  lifestyle: { paper: '#FBF4E8', ink: '#1F1710', accent: '#B8431A', accent2: '#E08A5B', dim: '#8C7A68', red: '#C0392B', soft: 'rgba(184,67,26,0.12)', onAccent: 'rgba(255,255,255,0.58)', mark: '#FFF1DD' },
};
let THEME_NAME = 'knowledge';
let THEME = THEMES.knowledge;
let PAPER, INK, BLUE, RED, DIM;
function applyTheme(name) {
  const n = THEMES[name] ? name : 'knowledge';
  THEME_NAME = n; THEME = THEMES[n];
  PAPER = THEME.paper; INK = THEME.ink; BLUE = THEME.accent; RED = THEME.red; DIM = THEME.dim;
}
function applySkin() {
  if (SKIN !== 'paper') return;
  PAPER = '#EFEFE5';
  if (THEME_NAME === 'knowledge') { BLUE = '#1E8A66'; INK = '#15231A'; DIM = '#6E7869'; }
  else { INK = '#16201A'; DIM = '#6E7869'; }
}
applyTheme(String(get('theme', d.theme || 'knowledge')));
applySkin();
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif';
const MONO = '"Menlo", "PingFang SC", monospace';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const pr = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - x, 3);

let grainCanvas = null;
function makeGrain() {
  const c = createCanvas(480, 270);
  const g = c.getContext('2d');
  const img = g.createImageData(480, 270);
  let s = 20261109;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 196 + rnd() * 59;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

let canvas = null, ctx = null;
function initCanvas() {
  canvas = createCanvas(W, H);
  ctx = canvas.getContext('2d');
  if (SKIN === 'paper' && !grainCanvas) grainCanvas = makeGrain();
}

function grid(color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 240) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 240) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
}

function bg(theme) {
  if (theme === 'ink') { ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H); grid('rgba(255,255,255,0.06)'); }
  else if (theme === 'blue') { ctx.fillStyle = BLUE; ctx.fillRect(0, 0, W, H); grid('rgba(255,255,255,0.10)'); }
  else { ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H); grid('rgba(0,0,0,0.05)'); }
}

function tag(text, dark) {
  ctx.font = `400 22px ${MONO}`;
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.55)' : DIM;
  ctx.fillText(text, 64, 72);
}

function measureRich(text, font) {
  ctx.font = font;
  return String(text).split(/(\*[^*]+\*)/).filter(Boolean)
    .reduce((a, s) => a + ctx.measureText(s.startsWith('*') ? s.slice(1, -1) : s).width, 0);
}

function fitFont(text, size, maxWidth, weight = 800, min = 56) {
  let s = size;
  while (s > min && measureRich(text, `${weight} ${s}px ${FONT}`) > maxWidth) s -= 4;
  if (measureRich(text, `${weight} ${s}px ${FONT}`) > maxWidth && !warnedText.has('fit:' + text)) {
    warnedText.add('fit:' + text);
    console.warn(`  ⚠ 已缩到最小 ${s}px 仍超出 ${Math.round(maxWidth)}px：${text}`);
  }
  return s;
}

function rich(text, x, y, font, color, accent, align = 'left', maxChars = null) {
  ctx.font = font;
  let parts = String(text).split(/(\*[^*]+\*)/).filter(Boolean).map((s) =>
    s.startsWith('*') ? { t: s.slice(1, -1), c: accent } : { t: s, c: null });
  if (maxChars != null) {
    let left = Math.max(0, Math.floor(maxChars));
    const cut = [];
    for (const p of parts) {
      if (left <= 0) break;
      const chars = [...p.t];
      if (chars.length <= left) { cut.push(p); left -= chars.length; }
      else { cut.push({ t: chars.slice(0, left).join(''), c: p.c }); left = 0; }
    }
    parts = cut;
  }
  const widths = parts.map((p) => ctx.measureText(p.t).width);
  const total = widths.reduce((a, b) => a + b, 0);
  if (!warnedText.has(String(text)) && (align === 'center' ? total > W - 160 : x + total > W - 80)) {
    warnedText.add(String(text));
    console.warn(`  ⚠ 文本可能超出安全区（${Math.round(total)}px）：${text}`);
  }
  let cx = align === 'center' ? x - total / 2 : x;
  parts.forEach((p, i) => { ctx.fillStyle = p.c || color; ctx.fillText(p.t, cx, y); cx += widths[i]; });
  return total;
}

function card(x, y, w, h, fill, stroke, r = 22) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
}

function fadeUp(e, p, dy = 24) {
  ctx.globalAlpha = eo(p);
  const y = 0;
  ctx.translate(0, dy * (1 - eo(p)));
  return () => { ctx.translate(0, -dy * (1 - eo(p))); ctx.globalAlpha = 1; };
}

function drawHero(t, a, dark) {
  bg('paper');
  tag('// 01 — 开场', false);
  const skin = SKIN === 'paper';
  const X = skin ? 140 : 960;
  const lines = a.lines || [];
  let heroSize = null;
  if (skin) for (const [text] of lines) heroSize = Math.min(heroSize ?? 168, fitFont(text, 168, 1356));
  lines.forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.3);
    if (p <= 0) return;
    const size = skin ? heroSize : (i === lines.length - 1 ? 190 : 150);
    const y = 540 + (i - (lines.length - 1) / 2) * 230 + (1 - eo(p)) * 30;
    const font = `800 ${size}px ${FONT}`;
    ctx.save();
    ctx.globalAlpha = eo(p);
    if (skin) {
      const total = measureRich(text, font);
      ctx.beginPath();
      ctx.rect(X - 10, y - size * 1.06, total * eo(p) + 20, size * 1.36);
      ctx.clip();
      rich(text, X, y, font, INK, BLUE, 'left');
      if (p < 0.98) { ctx.fillStyle = BLUE; ctx.fillRect(X + total * eo(p) + 8, y - size * 0.82, 4, size * 0.96); }
    } else {
      rich(text, X, y, font, INK, BLUE, 'center');
    }
    ctx.restore();
  });
  if (a.sub) {
    const lastAt = lines.length ? lines[lines.length - 1][1] : 0;
    const p = pr(t, lastAt + 0.6, lastAt + 0.9);
    if (p > 0) {
      ctx.save(); ctx.globalAlpha = eo(p);
      ctx.font = `400 26px ${MONO}`; ctx.fillStyle = DIM;
      ctx.textAlign = skin ? 'left' : 'center';
      ctx.fillText(a.sub, X, 900); ctx.textAlign = 'left'; ctx.restore();
    }
  }
}

function drawPoint(t, a) {
  bg('ink'); tag('// 02 — 论点', true);
  const words = a.words || [];
  let x = 146;
  words.forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.28);
    if (p <= 0) return;
    ctx.save(); ctx.globalAlpha = eo(p);
    const pfs = fitFont(text, 146, Math.max(200, 1400 - x), 800, 48);
    const w = rich(text, x, 340 + (1 - eo(p)) * 20, `800 ${pfs}px ${FONT}`, '#FFFFFF', THEME.accent2);
    x += w + 8;
    ctx.restore();
  });
  (a.cards || []).forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.35);
    if (p <= 0) return;
    const w = SKIN === 'paper' ? 430 : 520;
    const gap = SKIN === 'paper' ? 24 : 30;
    ctx.save(); ctx.globalAlpha = eo(p);
    const cx = 146 + i * (w + gap), cy = 600 + (1 - eo(p)) * 20;
    card(cx, cy, w, 170, '#141414', 'rgba(255,255,255,0.08)');
    ctx.font = `400 19px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`// 0${i + 1}`, cx + 24, cy + 34);
    ctx.font = `600 44px ${FONT}`; ctx.fillStyle = '#FFFFFF';
    ctx.fillText(text, cx + 28, cy + 120);
    ctx.restore();
  });
}

function drawNumber(t, a) {
  bg('blue'); tag('// 03 — 数据', true);
  const at = a.at, dur = a.dur || 1.4;
  const p = pr(t, at, at + dur);
  const val = Math.round((a.from || 0) + ((a.value ?? 0) - (a.from || 0)) * eo(p));
  ctx.font = `600 56px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(a.label || '', 146, 260);
  ctx.font = `700 230px ${MONO}`; ctx.fillStyle = '#FFFFFF';
  ctx.fillText(String(val), 146, 470);
  const numW = ctx.measureText(String(val)).width;
  ctx.font = `700 90px ${FONT}`; ctx.fillStyle = '#FFFFFF';
  ctx.fillText(a.unit || '', 146 + numW + 18, 452);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.roundRect(146, 640, 1200, 14, 7); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.roundRect(146, 640, 1200, 14, 7); ctx.clip();
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(146, 640, 1200 * eo(p), 14); ctx.restore();
  if (a.sub) {
    const q = pr(t, at + dur, at + dur + 0.3);
    if (q > 0) { ctx.save(); ctx.globalAlpha = eo(q); ctx.font = `500 40px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.78)'; ctx.fillText(a.sub, 146, 720); ctx.restore(); }
  }
}

function drawCompare(t, a) {
  bg('paper'); tag('// 04 — 对比', false);
  const pl = pr(t, a.leftAt, a.leftAt + 0.4), prr = pr(t, a.rightAt, a.rightAt + 0.4);
  const cw = SKIN === 'paper' ? 660 : 760;
  const col = (side, x, blue, p) => {
    if (p <= 0) return;
    ctx.save(); ctx.globalAlpha = eo(p);
    const y = 260 + (1 - eo(p)) * 24;
    card(x - cw / 2, y, cw, 600, blue ? BLUE : '#FFFFFF', blue ? null : 'rgba(0,0,0,0.08)');
    ctx.font = `400 19px ${MONO}`; ctx.fillStyle = blue ? 'rgba(255,255,255,0.7)' : DIM;
    ctx.fillText('// ' + (blue ? 'after' : 'before'), x - cw / 2 + 44, y + 36);
    ctx.font = `700 70px ${FONT}`; ctx.fillStyle = blue ? '#FFFFFF' : INK;
    ctx.fillText(side.title, x - cw / 2 + 44, y + 132);
    (side.items || []).forEach((s, i) => {
      const ifs = fitFont((blue ? '→ ' : '· ') + s, 42, cw - 88, 500, 22);
      ctx.font = `500 ${ifs}px ${FONT}`; ctx.fillStyle = blue ? '#FFFFFF' : 'rgba(10,10,10,0.62)';
      ctx.fillText((blue ? '→ ' : '· ') + s, x - cw / 2 + 44, y + 260 + i * 90);
    });
    ctx.restore();
  };
  col(a.left, SKIN === 'paper' ? 480 : 530, false, pl);
  col(a.right, SKIN === 'paper' ? 1180 : 1390, true, prr);
  const q = pr(t, a.strikeAt, a.strikeAt + 0.25);
  if (q > 0) {
    ctx.save(); ctx.globalAlpha = 1 - pr(t, a.strikeAt + 0.9, a.strikeAt + 1.2);
    ctx.fillStyle = RED;
    ctx.beginPath(); ctx.roundRect(180, 552, (SKIN === 'paper' ? 620 : 700) * eo(q), 10, 5); ctx.fill(); ctx.restore();
  }
  const s = pr(t, a.strikeAt + 0.35, a.strikeAt + 0.8);
  if (s > 0 && a.stamp) {
    ctx.save(); ctx.globalAlpha = eo(s); ctx.translate(530, 560); ctx.rotate(-0.18); ctx.scale(0.9 + 0.1 * eo(s), 0.9 + 0.1 * eo(s));
    ctx.strokeStyle = RED; ctx.lineWidth = 8; ctx.beginPath(); ctx.roundRect(-190, -60, 380, 120, 16); ctx.stroke();
    ctx.font = `800 96px ${FONT}`; ctx.fillStyle = RED; ctx.textAlign = 'center'; ctx.fillText(a.stamp, 0, 34);
    ctx.textAlign = 'left'; ctx.restore();
  }
}

function drawSteps(t, a) {
  bg('paper'); tag('// 05 — 步骤', false);
  const steps = a.steps || [];
  ctx.font = `600 88px ${FONT}`; ctx.fillStyle = INK;
  ctx.fillText(a.title || '', 146, 220);
  const X0 = SKIN === 'paper' ? 170 : 200, X1 = SKIN === 'paper' ? 1480 : 1720, gx = (X1 - X0) / Math.max(1, steps.length - 1);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.beginPath(); ctx.roundRect(X0, 556, X1 - X0, 6, 3); ctx.fill();
  let prog = 0;
  steps.forEach(([, at], i) => { if (i > 0) prog = Math.max(prog, (i - 1 + eo(pr(t, at - 0.4, at))) / Math.max(1, steps.length - 1)); });
  ctx.save(); ctx.beginPath(); ctx.roundRect(X0, 556, (X1 - X0) * prog, 6, 3); ctx.clip();
  ctx.fillStyle = BLUE; ctx.fillRect(X0, 556, X1 - X0, 6); ctx.restore();
  steps.forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.35);
    if (p <= 0) return;
    const cx = X0 + gx * i;
    ctx.save(); ctx.globalAlpha = eo(p);
    ctx.beginPath(); ctx.arc(cx, 560, 42, 0, Math.PI * 2); ctx.fillStyle = BLUE; ctx.fill();
    ctx.font = `700 40px ${FONT}`; ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), cx, 574);
    const fs = fitFont(text, 42, Math.max(84, gx - 24), 600, 24);
    ctx.font = `600 ${fs}px ${FONT}`; ctx.fillStyle = INK;
    ctx.fillText(text, cx, 690);
    ctx.textAlign = 'left'; ctx.restore();
  });
}

function drawQuote(t, a) {
  if (SKIN === 'paper') {
    bg('paper');
    ctx.save();
    ctx.font = `800 220px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillText('“', 132, 330);
    ctx.restore();
    const lines = a.lines || [];
    const totalChars = lines.reduce((n, s) => n + [...s.replace(/\*/g, '')].length, 0);
    const p = pr(t, a.at, a.at + 1.5);
    let budget = Math.round(totalChars * eo(p));
    const qsize = Math.min(...lines.map((l) => fitFont(l, 128, 1240)));
    lines.forEach((line, i) => {
      const plain = [...line.replace(/\*/g, '')].length;
      if (budget <= 0) return;
      rich(line, 150, 500 + i * 176, `800 ${qsize}px ${FONT}`, INK, BLUE, 'left', budget);
      budget -= plain;
    });
    if (a.by) {
      const q = pr(t, a.at + 1.2, a.at + 1.6);
      if (q > 0) {
        ctx.save(); ctx.globalAlpha = eo(q);
        ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(150, 792.5); ctx.lineTo(250, 792.5); ctx.stroke();
        ctx.font = `400 26px ${MONO}`; ctx.fillStyle = DIM;
        ctx.fillText(a.by, 150, 838);
        ctx.restore();
      }
    }
    return;
  }
  bg('blue');
  const p = pr(t, a.at, a.at + 0.45);
  if (p > 0) {
    ctx.save(); ctx.globalAlpha = eo(p);
    const s = 1 + 0.06 * (1 - eo(p));
    ctx.translate(960, 520); ctx.scale(s, s);
    (a.lines || []).forEach((line, i) => {
      rich(line, 0, (i - ((a.lines.length - 1) / 2)) * 180, `800 150px ${FONT}`, THEME.onAccent, THEME.mark, 'center');
    });
    ctx.restore();
  }
  if (a.by) {
    const q = pr(t, a.at + 0.5, a.at + 0.8);
    if (q > 0) { ctx.save(); ctx.globalAlpha = eo(q); ctx.font = `400 28px ${MONO}`; ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.textAlign = 'center'; ctx.fillText(a.by, 960, 860); ctx.textAlign = 'left'; ctx.restore(); }
  }
}

function drawChecklist(t, a) {
  bg('paper'); tag('// 08 — 清单', false);
  ctx.font = `600 88px ${FONT}`; ctx.fillStyle = INK;
  ctx.fillText(a.title || '', 146, 210);
  (a.items || []).forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.4);
    if (p <= 0) return;
    const y = 340 + i * 118;
    ctx.save(); ctx.globalAlpha = eo(p);
    ctx.beginPath(); ctx.arc(180, y + 32, 32, 0, Math.PI * 2); ctx.fillStyle = BLUE; ctx.fill();
    // 用线段画勾，避免字体缺字（PingFang 无 ✓）
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(165, y + 32);
    ctx.lineTo(175, y + 42);
    ctx.lineTo(195, y + 20);
    ctx.stroke();
    const cfs = fitFont(text, 58, 1180, 600, 28);
    ctx.font = `600 ${cfs}px ${FONT}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.fillText(text, 246, y + 52);
    ctx.restore();
  });
}

function drawOutro(t, a) {
  const light = SKIN === 'paper';
  if (light) bg('paper'); else bg('ink');
  tag('// 制作说明', !light);
  ctx.font = `700 72px ${FONT}`; ctx.fillStyle = light ? INK : '#FFFFFF';
  ctx.fillText(a.title || '', 160, 220);
  ctx.font = `500 40px ${FONT}`; ctx.fillStyle = light ? 'rgba(10,10,10,0.55)' : '#B8B8B8';
  (a.lines || []).forEach((s, i) => ctx.fillText(s, 160, 330 + i * 58));
  card(160, 600, light ? 1360 : 1600, 240, light ? '#FFFFFF' : 'rgba(255,255,255,0.04)', light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)', 16);
  ctx.font = `500 34px ${MONO}`; ctx.fillStyle = light ? BLUE : THEME.accent2;
  ctx.fillText('$', 200, 680);
  const prompt = a.prompt || '';
  const p = pr(t, a.t0 + 1.0, Math.min(a.t1 - 0.8, a.t0 + 1.0 + prompt.length * 0.045));
  ctx.font = `500 34px ${MONO}`; ctx.fillStyle = light ? INK : '#E8ECF8';
  ctx.fillText(prompt.slice(0, Math.round(prompt.length * p)), 244, 680);
  if (Math.floor(t * 2) % 2 === 0) { ctx.fillStyle = light ? BLUE : THEME.accent2; ctx.fillText('▍', 244 + ctx.measureText(prompt.slice(0, Math.round(prompt.length * p))).width + 4, 680); }
}

function drawAvatar(t) {
  if (!SHOW_AVATAR) return;
  const cx = 1742, cy = 150, r = 80;
  const pulse = 1 + Math.sin(t * 2.2) * 0.015;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.beginPath(); ctx.arc(0, 0, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = THEME.soft; ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
  if (avatarImg) {
    ctx.drawImage(avatarImg, -r, -r, r * 2, r * 2);
  } else {
    const g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, BLUE); g.addColorStop(1, THEME.accent2);
    ctx.fillStyle = g; ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.fillStyle = '#FFFFFF'; ctx.font = `700 64px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText('晓', 0, 24); ctx.textAlign = 'left';
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 5; ctx.stroke();
  ctx.restore();
  ctx.font = `600 22px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.textAlign = 'right';
  ctx.fillText('晓晓 · 口播', cx + r, cy + r + 34);
  ctx.textAlign = 'left';
}

function drawCaption(t) {
  const c = captions.find((x) => t >= x.start && t < x.end);
  if (!c) return;
  ctx.font = `600 36px ${FONT}`;
  const w = ctx.measureText(c.text).width;
  if (w + 56 > 1500 && !warnedText.has(c.text)) {
    warnedText.add(c.text);
    console.warn('  ⚠ 字幕过长，可能超出安全区：' + c.text);
  }
  const boxW = Math.min(1500, w + 56), h = 72, x = (W - boxW) / 2, y = 958;
  ctx.beginPath(); ctx.roundRect(x, y, boxW, h, 12);
  ctx.fillStyle = 'rgba(16,20,34,0.90)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center';
  ctx.fillText(c.text, W / 2, y + 48);
  ctx.textAlign = 'left';
}

function drawPresenterCard() {
  const x = 1536, y = 120, w = 300, h = 440, r = 20;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.20)';
  ctx.shadowBlur = 30; ctx.shadowOffsetY = 12;
  card(x, y, w, h, '#FFFFFF', null, r);
  ctx.restore();
  if (avatarImg) {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.clip();
    const s = Math.max(w / avatarImg.width, h / avatarImg.height);
    const dw = avatarImg.width * s, dh = avatarImg.height * s;
    ctx.drawImage(avatarImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w, h, r);
  ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 1; ctx.stroke();
  // 左上角标签胶囊（对齐 motion-kit 的呈现方式）
  ctx.font = `500 18px ${FONT}`;
  const label = '晓晓 · 口播';
  const tw = ctx.measureText(label).width;
  ctx.beginPath(); ctx.roundRect(x + 16, y + 16, tw + 26, 38, 19);
  ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.fillText(label, x + 29, y + 42);
  ctx.restore();
}

function drawPaperSkin(t, type, idx = 1, total = 8) {
  if (SKIN !== 'paper' || !grainCanvas) return;
  // point 仍是深墨底、number 是满色底；quote/outro 在 paper skin 下已改为纸底
  const colored = type === 'point' || type === 'number';
  ctx.save();
  ctx.globalAlpha = colored ? 0.04 : 0.07;
  ctx.drawImage(grainCanvas, 0, 0, W, H);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = colored ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(64, 104.5); ctx.lineTo(1856, 104.5);
  ctx.moveTo(64, 1005.5); ctx.lineTo(1856, 1005.5);
  ctx.stroke();
  ctx.beginPath();
  for (let x = 64; x <= 1856; x += 128) { ctx.moveTo(x + 0.5, 1005.5); ctx.lineTo(x + 0.5, 1013.5); }
  ctx.stroke();
  ctx.restore();

  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(Math.floor(t % 60)).padStart(2, '0');
  ctx.save();
  ctx.font = `400 20px ${MONO}`;
  ctx.fillStyle = colored ? 'rgba(255,255,255,0.55)' : DIM;
  ctx.textAlign = 'right';
  ctx.fillText(`${mm}:${ss}`, 1856, 70);
  ctx.textAlign = 'left';
  ctx.font = `400 13px ${MONO}`;
  ctx.fillStyle = colored ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
  ctx.fillText('MOTION LAB', 64, 1046);
  ctx.textAlign = 'right';
  ctx.fillText(`${String(idx).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, 1856, 1046);
  ctx.textAlign = 'left';
  ctx.restore();

  drawPresenterCard();
}

/* ============================================================================
 * 纸面皮肤 v3：按 motion-kit 成片逐像素测量后 1:1 复刻（1920×1080）
 *   - 版心 / 字号 / 行距 / 圆环半径 / 卡片尺寸全部来自模板实测，不再“近似”
 *   - 文本引擎支持：*强调*、自动折行、裁切揭示、逐字打字机、按墨迹顶对齐
 * ========================================================================== */
/* 纸面版式全部来自 skia-kit/paper.mjs（像素级规格 + 可独立复用） */
let paperRenderer = null, paperKey = '';
function getPaper() {
  const key = `${THEME_NAME}|${SKIN}`;
  if (!paperRenderer || paperKey !== key) {
    paperRenderer = createPaperRenderer({
      ctx, width: W, height: H,
      palette: { bg: PAPER, ink: INK, accent: BLUE, body: '#5F6A5C', label: '#6E7869',
        bar: 'rgba(18,18,16,0.62)', ring: 'rgba(30,138,102,0.26)', hair: 'rgba(0,0,0,0.10)' },
    });
    paperKey = key;
  }
  paperRenderer.setContent({ scenes, captions, avatar: avatarImg });
  return paperRenderer;
}

function renderFrame(t) {
  const sc = scenes.find((s) => t >= s.t0 && t < s.t1) || scenes[scenes.length - 1];
  if (!sc) return;
  if (SKIN === 'paper') { getPaper().renderFrame(t); return; }
  const a = { ...sc.args, t0: sc.t0, t1: sc.t1 };
  switch (sc.type) {
    case 'hero': drawHero(t, a); break;
    case 'point': drawPoint(t, a); break;
    case 'number': drawNumber(t, a); break;
    case 'compare': drawCompare(t, a); break;
    case 'steps': drawSteps(t, a); break;
    case 'quote': drawQuote(t, a); break;
    case 'checklist': drawChecklist(t, a); break;
    case 'outro': drawOutro(t, a); break;
    default: bg('paper');
  }
  drawCaption(t);
  drawAvatar(t);
}

if (PROBE) {
  initCanvas();
  renderFrame(Number(get('at', 2.5)));
  fs.writeFileSync(PROBE, canvas.toBuffer('image/png'));
  console.log('probe →', PROBE);
  process.exit(0);
}

const WORKERS = Math.max(1, Number(get('workers', 1)));
const INCREMENTAL = argv.includes('--incremental');
const RENDERER_VERSION = '2026-11-09.9';
/* 代码指纹进缓存 key：只改渲染代码、忘了升版本时，旧段不会再被误命中 */
const RENDERER_HASH = (() => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12); }
  catch { return 'na'; }
})();
const WORKER_HEAP = Number(get('worker-heap', 256)); // 每个 worker 的 V8 堆上限（MB）
const JPEG_Q = Number(get('jpeg-quality', 94));
const PRESET = get('preset', 'veryfast');
const CRF = String(get('crf', 18));
const videoOnly = OUT.replace(/\.mp4$/, '-video.mp4');
const TMP = fs.mkdtempSync(path.join('/tmp', 'mg-skia-'));

async function encodeRange(start, end, target, q = JPEG_Q, p = PRESET, c = CRF) {
  initCanvas();
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', p, '-crf', c, '-pix_fmt', 'yuv420p',
    '-f', 'mpegts', target], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  for (let f = start; f < end; f++) {
    renderFrame(f / FPS);
    const buf = canvas.toBuffer('image/jpeg', q);
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
}

const SEG_INFLIGHT = new Map(); // 跨请求的同 key 渲染去重

/* 缓存 GC：保留当前使用中的 key；按总大小与最后访问时间清理旧段。 */
function gcCache(cacheDir, { keep = new Set(), maxBytes = 200 * 1024 * 1024, maxAgeDays = 14 } = {}) {
  if (!fs.existsSync(cacheDir)) return { removed: 0, freed: 0 };
  const files = fs.readdirSync(cacheDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      const p = path.join(cacheDir, f);
      const st = fs.statSync(p);
      return { p, key: f.replace(/\.ts$/, ''), size: st.size, mtime: st.mtimeMs };
    });
  let total = files.reduce((a, b) => a + b.size, 0);
  let removed = 0;
  let freed = 0;
  const now = Date.now();
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (keep.has(f.key)) continue;
    const stale = now - f.mtime > maxAgeDays * 86400e3;
    if (stale || total > maxBytes) {
      fs.rmSync(f.p, { force: true });
      total -= f.size;
      removed += 1;
      freed += f.size;
    }
  }
  return { removed, freed };
}

/* 增量渲染：按场景切段，段 key = 内容哈希（场景 + 时间轴 + 重叠字幕 + 全局样式 + 编码参数）。
   未变的段直接复用缓存 TS，只重渲变化的段；最后按场景顺序 concat。 */
async function renderIncremental(opts = {}) {
  if (opts.theme) applyTheme(opts.theme);
  if (opts.skin) { SKIN = opts.skin; applySkin(); }  const workers = Math.max(1, opts.workers || WORKERS);
  const inline = !!opts.inline;
  const outPath = opts.videoOnly || opts.out || OUT;
  const cacheDir = path.join(path.dirname(opts.inputsPath || INPUTS), 'render-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  const segs = [];
  let cursor = 0; // 首段必须从 0 开始，段间用游标衔接，避免浮点取整丢帧/重叠
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const end = i === scenes.length - 1 ? FRAMES : Math.round(sc.t1 * FPS);
    const start = cursor;
    cursor = end;
    if (end <= start) continue;
    const caps = captions.filter((c) => c.end > sc.t0 && c.start < sc.t1);
    const key = hash(canon({
      v: RENDERER_VERSION, rh: RENDERER_HASH, type: sc.type, args: sc.args, t0: sc.t0, t1: sc.t1, caps,
      W, H, FPS, brand: d.brand, accent: d.accent, theme: THEME_NAME, skin: SKIN, q: JPEG_Q, p: PRESET, c: CRF,
      avatar: SHOW_AVATAR ? (avatarImg ? `${AVATAR_PATH}:${fs.statSync(AVATAR_PATH).mtimeMs}` : 'geo') : 'off',
    }));
    segs.push({ i, type: sc.type, start, end, key, file: path.join(cacheDir, `${key}.ts`) });
  }
  const hits = segs.filter((s) => fs.existsSync(s.file) && fs.statSync(s.file).size > 1000);
  const miss = segs.filter((s) => !hits.includes(s));
  console.log(`\n incremental: ${segs.length} 段 / 命中 ${hits.length} / 重渲 ${miss.length}`);
  if (inline) {
    for (const seg of miss) await encodeRange(seg.start, seg.end, seg.file, JPEG_Q, PRESET, CRF);
  } else {
    // 段内切分 + 同 key 去重：并发请求命中同一内容段时只渲染一次
    const renderSeg = async (seg) => {
      if (fs.existsSync(seg.file) && fs.statSync(seg.file).size > 1000) return;
      const tasks = [];
      const len = seg.end - seg.start;
      const parts = Math.max(1, Math.ceil(len / 60));
      const per = Math.ceil(len / parts);
      for (let j = 0; j < parts; j++) {
        const s = seg.start + j * per;
        const e = Math.min(seg.end, s + per);
        if (s < e) tasks.push({ s, e, tmp: path.join(TMP, `seg-${seg.key}-${j}.ts`) });
      }
      if (opts.pool) {
        await Promise.all(tasks.map((t) => opts.pool.run({
          start: t.s, end: t.e, part: t.tmp,
          jpegQuality: JPEG_Q, preset: PRESET, crf: CRF,
          inputsPath: opts.inputsPath || INPUTS, theme: THEME_NAME, skin: SKIN,
        })));
      } else {
        for (let i = 0; i < tasks.length; i += workers) {
          await Promise.all(tasks.slice(i, i + workers).map((t) => new Promise((resolve, reject) => {
            const w = new Worker(new URL(import.meta.url), {
              workerData: {
                start: t.s, end: t.e, part: t.tmp,
                jpegQuality: JPEG_Q, preset: PRESET, crf: CRF,
                inputsPath: opts.inputsPath || INPUTS, theme: THEME_NAME, skin: SKIN,
              },
              resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP },
            });
            w.once('message', (m) => {
              if (m && m.theme === THEME_NAME && m.skin === SKIN && m.inputsPath === path.resolve(opts.inputsPath || INPUTS)) resolve(m);
              else reject(new Error(`worker 参数不一致：期望 ${THEME_NAME}/${SKIN || '-'}/${path.resolve(opts.inputsPath || INPUTS)}，实际 ${m?.theme}/${m?.skin}/${m?.inputsPath}`));
            });
            w.once('error', reject);
          })));
        }
      }
      if (tasks.length === 1) {
        fs.renameSync(tasks[0].tmp, seg.file);
      } else {
        const subList = path.join(TMP, `sub-${seg.key}.txt`);
        fs.writeFileSync(subList, tasks.map((t) => `file '${t.tmp}'`).join('\n'));
        execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'concat', '-safe', '0', '-i', subList, '-c', 'copy', seg.file]);
      }
    };
    const jobs = miss.map((seg) => {
      if (SEG_INFLIGHT.has(seg.key)) return SEG_INFLIGHT.get(seg.key);
      const p = renderSeg(seg).finally(() => SEG_INFLIGHT.delete(seg.key));
      SEG_INFLIGHT.set(seg.key, p);
      return p;
    });
    await Promise.all(jobs);
    console.log(`  ✓ 已渲 ${miss.length}/${miss.length} 段（同 key 去重）`);
  }
  if (opts.gc !== false) {
    const g = gcCache(cacheDir, {
      keep: new Set(segs.map((s) => s.key)),
      maxBytes: opts.cacheMaxBytes || 200 * 1024 * 1024,
      maxAgeDays: opts.cacheMaxAgeDays || 14,
    });
    if (g.removed) console.log(`  gc: 清理 ${g.removed} 个旧段 / 释放 ${(g.freed / 1048576).toFixed(1)}MB`);
  }
  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${s.file}'`).join('\n'));
  if (opts.concat === false) return list;
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outPath]);
  return outPath;
}

function mixAudio(video, audio, out, isList = false) {
  const inArgs = isList ? ['-f', 'concat', '-safe', '0', '-i', video] : ['-i', video];
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    ...inArgs, '-i', path.resolve(audio), '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'copy', '-t', String(FRAMES / FPS), '-movflags', '+faststart', out]);
  if (!isList) fs.rmSync(video, { force: true });
}

const isDirect = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname); } catch { return false; }
})();

if (!isMainThread) {
  const { persistent, start, end, part, jpegQuality, preset, crf, inputsPath, theme, skin } = workerData;
  if (skin) SKIN = skin;
  if (theme) applyTheme(theme);
  applySkin();
  if (persistent) {
    if (inputsPath) loadInputs(inputsPath);
    parentPort.on('message', async (msg) => {
      try {
        if (msg.inputsPath) loadInputs(msg.inputsPath);
        if (msg.skin) { SKIN = msg.skin; applySkin(); }
        if (msg.theme) applyTheme(msg.theme);
        await encodeRange(msg.start, msg.end, msg.part, msg.jpegQuality, msg.preset, msg.crf);
        parentPort.postMessage({ ok: true, id: msg.id, inputsPath: LOADED_INPUTS, theme: THEME_NAME, skin: SKIN });
      } catch (e) {
        parentPort.postMessage({ ok: false, id: msg.id, error: String(e?.message || e) });
      }
    });
    parentPort.postMessage({ ok: true, ready: true });
  } else {
    if (inputsPath) loadInputs(inputsPath);
    await encodeRange(start, end, part, jpegQuality, preset, crf);
    parentPort.postMessage({ ok: true, frames: end - start, inputsPath: LOADED_INPUTS, theme: THEME_NAME, skin: SKIN });
  }
} else if (isDirect) {
  const t0 = Date.now();
  if (INCREMENTAL) {
    await renderIncremental({ videoOnly, workers: WORKERS, inputsPath: INPUTS });
  } else if (WORKERS === 1) {
    await encodeRange(0, FRAMES, videoOnly, JPEG_Q, PRESET, CRF);
  } else {
    const per = Math.ceil(FRAMES / WORKERS);
    const segs = [];
    for (let i = 0; i < WORKERS; i++) {
      const s = i * per, e = Math.min(FRAMES, s + per);
      if (s < e) segs.push({ i, s, e });
    }
    await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), {
        workerData: {
          start: seg.s, end: seg.e, part: path.join(TMP, `part-${seg.i}.ts`),
          jpegQuality: JPEG_Q, preset: PRESET, crf: CRF,
          inputsPath: INPUTS, theme: THEME_NAME, skin: SKIN,
        },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP },
      });
      w.once('message', (m) => {
        if (m && m.theme === THEME_NAME && m.skin === SKIN && m.inputsPath === path.resolve(INPUTS)) resolve(m);
        else reject(new Error(`worker 参数不一致：期望 ${THEME_NAME}/${SKIN || '-'}/${path.resolve(INPUTS)}，实际 ${m?.theme}/${m?.skin}/${m?.inputsPath}`));
      });
      w.once('error', reject);
    })));
    const list = path.join(TMP, 'list.txt');
    fs.writeFileSync(list, segs.map((seg) => `file '${path.join(TMP, `part-${seg.i}.ts`)}'`).join('\n'));
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', videoOnly]);
  }
  const enc = ((Date.now() - t0) / 1000).toFixed(2);

  if (AUDIO && fs.existsSync(path.resolve(AUDIO))) {
    mixAudio(videoOnly, AUDIO, OUT);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n✓ ${OUT}  ${FRAMES} 帧 / ${enc}s / ${INCREMENTAL ? '增量模式' : WORKERS + ' worker'}（绘制+JPEG+H.264）`);
}

export { loadInputs, renderIncremental, encodeRange, mixAudio, initCanvas, renderFrame, gcCache, applyTheme, getThemeName, setSkin };
function getThemeName() { return THEME_NAME; }
function setSkin(name) { SKIN = name || ''; applySkin(); }
