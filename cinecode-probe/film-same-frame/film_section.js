// ============================== FILM ==============================
const TITLE = '同一帧';
const PURPOSE = 'cinematic';
const FINISH = { shutter: null, weave: 0, tone: null };
const FPS = 24;
const DURATION = 15;                         // seconds; the picture and the sound both follow this
const BPM = 96;                              // music grid; cue times sit on beats and bars: beat(n), bar(n)
const BEAT0 = 0;                             // film time of beat 0 (a bar line); 0 when the music clip starts on a downbeat
const beat = (n) => BEAT0 + n * 60 / BPM, bar = (n) => beat(4 * n);

// The look pass over the whole frame: grade (a CSS filter), bloom, texture, vignette, grain, drawings per second
// (hold: 24 = on ones; 12 = on twos), line (outline width) and steps (toon bands). ?look=<id> previews another family.
const LOOKS = {
  'cinematic-realistic': { grade: 'contrast(1.05) saturate(0.96)', bloom: 0.22, texture: null, vignette: 0.15, grain: 0.045, grainHold: 1, hold: 24, line: 0, steps: 0,
    palette: { bg: '#151b26', ink: '#f2ece0', accent: '#e6b06a', dim: '#44505f' } },
  'papercut-collage': { grade: 'contrast(1.03) saturate(1.02)', bloom: 0.06, texture: 'paper', vignette: 0.08, grain: 0.035, grainHold: Infinity, hold: 24, line: 0.0015, steps: 2,
    palette: { bg: '#efe6d6', ink: '#1f1d1a', accent: '#c0392b', dim: '#8a8578' } },
  'retro-synthwave-vhs': { grade: 'saturate(1.2) contrast(1.08)', bloom: 0.4, texture: 'scanlines', vignette: 0.4, grain: 0.05, grainHold: 1, hold: 24, line: 0, steps: 0,
    palette: { bg: '#12081f', ink: '#f6e9ff', accent: '#ff4d9d', dim: '#4b2a6b' } },
};
const LOOK_ID = new URLSearchParams(location.search).get('look') || 'papercut-collage';
const LOOK = LOOKS[LOOK_ID] ?? LOOKS['cinematic-realistic'];

const OWN_MUSIC = null;
const INSTRUMENTS = [];
const CAST = {};
const FORMULAS = {};
const PALETTE = { bg: '#efe6d6', ink: '#1f1d1a', accent: '#c0392b', dim: '#8a8578' };

// Faces are system families without files or packages: left null, the three roles fall back to TYPE_FALLBACK, which is
// declared further down the file (a const, so it cannot be touched from here at parse time). tuneType() runs on the
// first draw of every scene and only swaps the fallback families for the film's own (serif display, sans text).
const TYPE = {
  lang: 'zh-CN',
  roles: { display: null, text: null, mono: null },
  check: { strings: { display: [TITLE] }, sizes: { text: 0.042 } },
};
let typeTuned = false;
function tuneType() {
  if (typeTuned) return;
  TYPE_FALLBACK.display = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
  TYPE_FALLBACK.text = '"PingFang SC", "Hiragino Sans GB", sans-serif';
  TYPE_FALLBACK.mono = 'ui-monospace, "SF Mono", Menlo, monospace';
  typeTuned = true;
}

// Cues are shared by picture and sound, so a hit on screen and its sound land on the same frame.
const CUES = { lock: beat(2), split: beat(6), same: beat(12), change: beat(18), end: DURATION };

const VO = [];
const CAPTIONS = null;
const CAPTION_STYLE = { role: 'display', accentRole: 'display', size: 0.062, caps: false, ink: PALETTE.ink, hi: PALETTE.ink, accent: PALETTE.accent, punch: 0.07 };

const SCENES = [
  { chapter: 'C1', from: 0, to: CUES.split, draw: sLock, action: 'two frames slide in and lock into one', amb: { kind: 'air', gain: 0.035 } },
  { chapter: 'C1', from: CUES.split, to: CUES.same, draw: sSplit, action: 'the frame splits in two and each half prints the same hash', amb: { kind: 'room', gain: 0.04 } },
  { chapter: 'C2', from: CUES.same, to: CUES.change, draw: sSame, action: 'every character of the two hashes ticks off', in: { type: 'dissolve', dur: 0.4 }, amb: { kind: 'room', gain: 0.04 } },
  { chapter: 'C2', from: CUES.change, to: DURATION, draw: sChange, action: 'three cells of the grid recompute', in: { type: 'dissolve', dur: 0.4 }, amb: { kind: 'air', gain: 0.035 } },
];

const SFX = [
  { at: 1.25 - 0.6, voice: 'whoosh', dur: 1.2, gain: 0.24, wet: 0.2 },
  { at: CUES.lock, voice: 'hit', gain: 0.55, wet: 0.3 },
  { at: CUES.split - 0.6, voice: 'whoosh', dur: 1.2, gain: 0.2, wet: 0.2 },
  { at: CUES.same - 0.6, voice: 'whoosh', dur: 1.2, gain: 0.18, wet: 0.25 },
  { at: CUES.same, voice: 'hit', gain: 0.4, wet: 0.3 },
  { at: CUES.same + 1.0, voice: 'tick', gain: 0.16, wet: 0.2 },
  { at: CUES.change - 0.7, voice: 'riser', dur: 0.7, gain: 0.2, wet: 0.15 },
  { at: CUES.change, voice: 'hit', gain: 0.6, wet: 0.3 },
];

const ROOM = { secs: 2.0, decay: 3.0, tone: 5000 };

const ARRANGEMENT = [
  { section: 'intro', from: 0, to: CUES.split, parts: [] },
  { section: 'split', from: CUES.split, to: CUES.same, parts: [] },
  { section: 'proof', from: CUES.same, to: CUES.change, parts: [] },
  { section: 'turn', from: CUES.change, to: DURATION, parts: [] },
];

// ---- drawing blocks --------------------------------------------------------------------------------------------
// Layout: the stage sits above centre, the line of type below it; a vertical ruler runs down the left edge in every
// scene and carries the running time, so the four scenes read as one film and not four cards.
const STAGE_Y = -0.3, LINE_Y = 0.26;

// One frame cell: a rounded outline with three scan bars, the film's motif. Units are the short side.
function frameCard(g, S, x, y, w, h, col, a = 1, bars = 1) {
  g.save(); g.globalAlpha = a; g.strokeStyle = col; g.lineWidth = 0.0032;
  g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, 0.012); g.stroke();
  if (bars > 0) {
    g.globalAlpha = a * bars;
    for (let i = 0; i < 3; i++) {
      const yy = y - h * 0.21 + i * h * 0.21;
      g.beginPath(); g.moveTo(x - w * 0.3, yy); g.lineTo(x + w * 0.3, yy); g.stroke();
    }
  }
  g.restore();
}

// A monospaced row typed left to right (p = share of the string already on screen), centred on cx.
function monoRow(g, S, s, cx, y, size, col, p = 1, alpha = 1) {
  g.save(); g.scale(0.01, 0.01); g.globalAlpha = alpha;
  setType(g, TYPE, 'mono', size * 100, { short: 260 });
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = col;
  const chars = [...s], n = Math.ceil(clamp(p) * chars.length);
  const w = chars.map((ch) => g.measureText(ch).width / 100);
  let xx = cx - w.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < chars.length; i++) { if (i < n && chars[i] !== ' ') g.fillText(chars[i], xx * 100, y * 100); xx += w[i]; }
  g.restore();
}

// The travelling motif: fifteen seconds as a ruler, one tick per second, a dot on the head.
function ruler(g, S, t) {
  const x = -0.415, y0 = -0.66, y1 = 0.12, h = y1 - y0;
  g.save();
  g.strokeStyle = PALETTE.ink; g.globalAlpha = 0.18; g.lineWidth = 0.0018;
  g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
  for (let s = 0; s <= DURATION; s++) {
    const yy = y0 + h * (s / DURATION);
    g.beginPath(); g.moveTo(x, yy); g.lineTo(x + (s % 5 === 0 ? 0.02 : 0.01), yy); g.stroke();
  }
  g.globalAlpha = 0.85; g.fillStyle = PALETTE.accent;
  g.beginPath(); g.arc(x, y0 + h * clamp(t / DURATION), 0.0072, 0, TAU); g.fill();
  g.restore();
}

// The frame of the film itself: one hairline just inside the edge, in screen space, so the 9:16 reads as a window and
// the edges are never pure black.
function edgeFrame(g, S) {
  const m = 0.05 * S.u;
  g.save(); g.globalAlpha = 0.09; g.strokeStyle = PALETTE.ink; g.lineWidth = Math.max(1, 0.0016 * S.u);
  g.strokeRect(m, m, S.W - 2 * m, S.H - 2 * m); g.restore();
}

const HX = 'a3f19c047b2e';

// C1 · 同一帧: two cells come in from the sides and land on top of each other. The bars draw in only after the lock,
// so the collision itself reads as two bare outlines.
function sLock(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.14, 1.0);
  const e = EASE.out(MOTION.at(t, 0.2, 1.05));
  const dx = lerp(0.6, 0, e);
  const bars = MOTION.at(t, CUES.lock - 0.05, 0.4);
  edgeFrame(g, S);
  plane(g, S, cam, 0, (g) => {
    frameCard(g, S, -dx, STAGE_Y, 0.34, 0.192, PALETTE.ink, 0.9 - 0.2 * e, bars);
    frameCard(g, S, dx, STAGE_Y, 0.34, 0.192, PALETTE.ink, 0.9 - 0.2 * e, bars);
    const seam = 1 - MOTION.at(t, CUES.lock, 0.45);
    if (seam > 0) {
      g.save(); g.globalAlpha = seam * 0.85; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.004;
      g.beginPath(); g.moveTo(0, STAGE_Y - 0.096); g.lineTo(0, STAGE_Y + 0.096); g.stroke(); g.restore();
    }
    const rk = MOTION.at(t, CUES.lock, 0.7);
    if (rk > 0 && rk < 1) circle(g, S, 0, STAGE_Y, lerp(0.02, 0.26, EASE.out(rk)), PALETTE.accent, 0.0035 * (1 - rk));
    ruler(g, S, t);
  });
  const tr = MOTION.at(t, 0.8, 1.0);
  plane(g, S, cam, 0, (g) => text(g, S, TITLE, 0, LINE_Y, 0.108, PALETTE.ink, 1, null, { reveal: EASE.out(tr), by: 'char', spread: 0.55 }));
  flash(g, S, Math.max(0, 1 - Math.abs(t - CUES.lock) * 9) * 0.12);
}

// C1 · 算两次: the single cell pulls back and splits into two; each half prints the hash under itself.
function sSplit(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.05);
  const e = EASE.inOut(MOTION.at(t, CUES.split + 0.15, 0.85));
  const x = lerp(0, 0.172, e);
  const w = lerp(0.34, 0.222, e), h = w * 0.565;
  const y = lerp(STAGE_Y, STAGE_Y - 0.07, e);
  edgeFrame(g, S);
  plane(g, S, cam, 0, (g) => {
    frameCard(g, S, -x, y, w, h, PALETTE.ink, 0.88);
    frameCard(g, S, x, y, w, h, PALETTE.ink, 0.88);
    if (e > 0.04) {
      monoRow(g, S, HX, -x, y + h / 2 + 0.07, 0.028, PALETTE.accent, MOTION.at(t, CUES.split + 0.7, 1.5));
      monoRow(g, S, HX, x, y + h / 2 + 0.07, 0.028, PALETTE.accent, MOTION.at(t, CUES.split + 0.85, 1.5));
    }
    ruler(g, S, t);
  });
  const tr = MOTION.at(t, CUES.split + 0.2, 0.95);
  plane(g, S, cam, 0, (g) => text(g, S, '算两次', 0, LINE_Y, 0.108, PALETTE.ink, 1, null, { reveal: EASE.out(tr), by: 'char', spread: 0.55 }));
}

// C2 · 一模一样: the two rows settle, an equals sign arrives between them, then each of the 12 characters ticks off.
function sSame(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.06, 1.0);
  const e = EASE.inOut(MOTION.at(t, CUES.same + 0.1, 0.7));
  const x = 0.172, w = 0.222, h = w * 0.565, y = lerp(STAGE_Y - 0.07, STAGE_Y - 0.09, e);
  const hy = y + h / 2 + 0.07;
  edgeFrame(g, S);
  plane(g, S, cam, 0, (g) => {
    frameCard(g, S, -x, y, w, h, PALETTE.ink, 0.8);
    frameCard(g, S, x, y, w, h, PALETTE.ink, 0.8);
    monoRow(g, S, HX, -x, hy, 0.028, PALETTE.ink, 1, 0.88);
    monoRow(g, S, HX, x, hy, 0.028, PALETTE.ink, 1, 0.88);
    const eq = EASE.out(MOTION.at(t, CUES.same + 0.4, 0.45));
    if (eq > 0) {
      g.save(); g.globalAlpha = eq * 0.95; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.0062; g.lineCap = 'round';
      for (const dy of [-0.014, 0.014]) { g.beginPath(); g.moveTo(-0.026 * eq, hy + dy); g.lineTo(0.026 * eq, hy + dy); g.stroke(); }
      g.restore();
    }
    const tp = MOTION.at(t, CUES.same + 0.4, 1.25);
    const n = Math.ceil(clamp(tp) * 12);
    for (let i = 0; i < n; i++) {
      for (const sx of [-x, x]) {
        g.fillStyle = PALETTE.accent; g.globalAlpha = 0.9;
        g.beginPath(); g.roundRect(sx - 0.0858 + i * 0.0156 - 0.004, hy + 0.04, 0.008, 0.008, 0.002); g.fill();
      }
    }
    g.globalAlpha = 1;
    if (n >= 12) monoRow(g, S, '12 / 12', 0, 0.08, 0.026, PALETTE.accent, 1, 0.9);
    ruler(g, S, t);
  });
  const tr = MOTION.at(t, CUES.same + 0.2, 0.9);
  plane(g, S, cam, 0, (g) => text(g, S, '一模一样', 0, LINE_Y, 0.108, PALETTE.ink, 1, null, { reveal: EASE.out(tr), by: 'char', spread: 0.5 }));
}

// C2 · 所以敢改: the whole film as 28 cells; three of them recompute, the rest hold their last frame.
function sChange(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.05, 1.0);
  const e = EASE.out(MOTION.at(t, CUES.change + 0.15, 0.7));
  const cols = 7, rows = 4, cw = 0.098, ch = 0.058, gx = 0.0105, gy = 0.0105;
  const tw = cols * cw + (cols - 1) * gx, th = rows * ch + (rows - 1) * gy;
  const x0 = -tw / 2 + cw / 2, y0 = STAGE_Y - th / 2 + ch / 2;
  const hot = [9, 10, 16];
  edgeFrame(g, S);
  plane(g, S, cam, 0, (g) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, x = x0 + c * (cw + gx), y = y0 + r * (ch + gy), on = hot.includes(i);
      const pulse = 0.5 + 0.5 * Math.sin(t * 6.5 + i * 0.9);
      g.save();
      if (on) { g.globalAlpha = (0.16 + 0.34 * pulse) * e; g.fillStyle = PALETTE.accent;
        g.beginPath(); g.roundRect(x - cw / 2, y - ch / 2, cw, ch, 0.008); g.fill(); }
      g.globalAlpha = on ? (0.45 + 0.5 * pulse) * e : 0.15;
      g.strokeStyle = on ? PALETTE.accent : PALETTE.ink; g.lineWidth = on ? 0.003 : 0.0022;
      g.beginPath(); g.roundRect(x - cw / 2, y - ch / 2, cw, ch, 0.008); g.stroke();
      g.restore();
    }
    ruler(g, S, t);
  });
  const tr = MOTION.at(t, CUES.change + 0.25, 0.95);
  plane(g, S, cam, 0, (g) => {
    text(g, S, '所以敢改', 0, LINE_Y, 0.108, PALETTE.ink, 1, null, { reveal: EASE.out(tr), by: 'char', spread: 0.5 });
    label(g, S, '改一行，只重算受影响的几秒', 0, LINE_Y + 0.14, 0.042, PALETTE.ink, null, MOTION.at(t, CUES.change + 0.95, 0.8) * 0.82, 'center');
  });
}

// The score is written on the film's own clock; OFF (from ?off=) shifts it so one window of it can be rendered per
// pass: this browser cannot render an OfflineAudioContext longer than ~8 s here, so the soundtrack comes out in pieces.
function score(ctx, out, OFF = 0, LEN = DURATION) {
  const seg = (t0, dur, fn) => {                       // clip a sustained voice to the window, never below zero
    const a = Math.max(0, t0 - OFF), b = Math.min(LEN, t0 + dur - OFF);
    if (b - a > 0.02) fn(a, b - a);
  };
  const at = (t) => t - OFF;                           // a one-shot lands only when it falls inside the window
  const hit = (t, fn) => { if (t >= OFF && t < OFF + LEN) fn(at(t)); };
  seg(0, 5.3, (a, d) => pad(ctx, out, a, d, [130.81, 155.56, 196.00], 0.05));          // Cm
  seg(5.0, 5.2, (a, d) => pad(ctx, out, a, d, [103.83, 130.81, 155.56], 0.046));       // Ab
  seg(10.0, 5.0, (a, d) => pad(ctx, out, a, d, [155.56, 196.00, 233.08], 0.054));      // Eb
  seg(0, 4.9, (a, d) => bass(ctx, out, a, d, 65.41, 0.085));
  seg(5.0, 4.9, (a, d) => bass(ctx, out, a, d, 51.91, 0.085));
  seg(10.0, 4.9, (a, d) => bass(ctx, out, a, d, 77.78, 0.095));
  for (let b = 4; b < 24; b += 4) hit(beat(b), (t) => kick(ctx, out, t, 0.2));
  for (let b = 6; b < 18; b++) hit(beat(b), (t) => tick(ctx, out, t, b % 2 ? 0.018 : 0.03));
}
