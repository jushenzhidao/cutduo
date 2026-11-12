// ============================== FILM ==============================
// 同一个口播脚本的 cinecode 版：8 个版式，时间轴与 skia-kit 的 inputs-v4.json 逐秒对齐，成片用同一条 audio-v4.m4a。
// 所以两条管线只差渲染器，不差内容、不差节奏、不差声音。
const TITLE = '表达原则';
const PURPOSE = 'ad';
const FINISH = { shutter: null, weave: 0, tone: null };
const FPS = 24;
const DURATION = 37.146;                     // = inputs-v4.json 的 durationSeconds
const BPM = 96;
const BEAT0 = 0;
const beat = (n) => BEAT0 + n * 60 / BPM, bar = (n) => beat(4 * n);

const LOOKS = {
  'papercut-collage': { grade: 'contrast(1.03) saturate(1.02)', bloom: 0.05, texture: 'paper', vignette: 0.07, grain: 0.03, grainHold: Infinity, hold: 24, line: 0.0015, steps: 2,
    palette: { bg: '#efe6d6', ink: '#1f1d1a', accent: '#c0392b', dim: '#8a8578' } },
};
const LOOK_ID = new URLSearchParams(location.search).get('look') || 'papercut-collage';
const LOOK = LOOKS[LOOK_ID] ?? LOOKS['papercut-collage'];

const OWN_MUSIC = null;
const INSTRUMENTS = [];
const CAST = {};
const FORMULAS = {};
const PALETTE = { bg: '#efe6d6', ink: '#1f1d1a', accent: '#c0392b', dim: '#8a8578' };

const TYPE = {
  lang: 'zh-CN',
  roles: { display: null, text: null, mono: null },
  check: { strings: { display: [TITLE] }, sizes: { text: 0.033 } },
};
let typeTuned = false;
function tuneType() {
  if (typeTuned) return;
  TYPE_FALLBACK.display = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
  TYPE_FALLBACK.text = '"PingFang SC", "Hiragino Sans GB", sans-serif';
  TYPE_FALLBACK.mono = 'ui-monospace, "SF Mono", Menlo, monospace';
  typeTuned = true;
}

// Scene boundaries: identical to inputs-v4.json (t0/t1), so the two films cut on the same frames.
const SC = { hero: 0, point: 6.112, number: 11.292, compare: 14.264, steps: 18.316, quote: 24.336, check: 27.98, outro: 33.376, end: DURATION };
const CUES = { ...SC };

const VO = [];
const CAPTIONS = null;
const CAPTION_STYLE = { role: 'display', accentRole: 'display', size: 0.05, caps: false, ink: PALETTE.ink, hi: PALETTE.ink, accent: PALETTE.accent, punch: 0.07 };

const SCENES = [
  { chapter: 'C1', from: SC.hero, to: SC.point, draw: sHero, action: 'the first line rises, then the second answers it', amb: null },
  { chapter: 'C1', from: SC.point, to: SC.number, draw: sPoint, action: 'two phrases land and three cards follow', amb: null },
  { chapter: 'C1', from: SC.number, to: SC.compare, draw: sNumber, action: 'the counter turns from 0 to 1', amb: null },
  { chapter: 'C2', from: SC.compare, to: SC.steps, draw: sCompare, action: 'the left column is struck through', amb: null },
  { chapter: 'C2', from: SC.steps, to: SC.quote, draw: sSteps, action: 'four nodes light along the rail', amb: null },
  { chapter: 'C3', from: SC.quote, to: SC.check, draw: sQuote, action: 'the second line answers the first', amb: null },
  { chapter: 'C3', from: SC.check, to: SC.outro, draw: sCheck, action: 'three boxes tick off', amb: null },
  { chapter: 'C3', from: SC.outro, to: SC.end, draw: sOutro, action: 'the credits settle', amb: null },
];

const SFX = [];
const ROOM = { secs: 1.6, decay: 2.6, tone: 5000 };
const ARRANGEMENT = [{ section: 'all', from: 0, to: DURATION, parts: [] }];

// ---- page furniture --------------------------------------------------------------------------------------------
const LR = 0.84;                             // left/right margin in world units (16:9: x is ±0.888)
function chrome(g, S, t) {
  g.save();
  g.globalAlpha = 0.55; g.fillStyle = PALETTE.ink;
  label(g, S, 'MOTION LAB', -LR, -0.428, 0.019, PALETTE.ink, null, 0.55, 'left');
  const tc = `00:${String(Math.floor(t)).padStart(2, '0')}:${String(Math.floor((t % 1) * 24)).padStart(2, '0')}`;
  label(g, S, tc, LR, -0.428, 0.017, PALETTE.ink, null, 0.55, 'right');
  g.globalAlpha = 0.18; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0012;
  g.beginPath(); g.moveTo(-LR, -0.415); g.lineTo(LR, -0.415); g.stroke();
  g.restore();
  captionBand(g, S, t);
}

// 烧录字幕：时间点取自 sync-plan-v4.json 的 segments，音轨里每一句都落在同一条上。
const LINES = [
  [0.35, 6.112, '先讲清楚，再讲漂亮。一条视频，一个问题。'],
  [6.112, 11.292, '别堆信息，先搭结构：结论、证据、例子。'],
  [11.292, 14.264, '一页只讲一个观点。'],
  [14.264, 18.316, '堆信息听完就忘，搭结构能复述。'],
  [18.316, 24.336, '四步骨架：抛问题、给结论、摆证据、收行动。'],
  [24.336, 27.98, '记住的不是信息量，是结构。'],
  [27.98, 33.376, '发布前三问：说得清吗，证据够吗，能照做吗。'],
];
function captionBand(g, S, t) {
  const row = LINES.find(([a, b]) => t >= a && t < b);
  if (!row) return;
  const k = Math.min(1, (t - row[0]) / 0.18, (row[1] - t) / 0.18);
  g.save(); g.globalAlpha = 0.22 * k; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0012;
  g.beginPath(); g.moveTo(-LR, 0.395); g.lineTo(LR, 0.395); g.stroke(); g.restore();
  label(g, S, row[2], 0, 0.432, 0.032, PALETTE.ink, null, 0.9 * k, 'center');
}

function sub(g, S, str, y, size, a = 1) {
  if (a <= 0.01) return;
  label(g, S, str, 0, y, size, PALETTE.dim, null, a, 'center');
}
function kicker(g, S, str, y, a = 1) {
  if (a <= 0.01) return;
  g.save(); g.globalAlpha = a; g.fillStyle = PALETTE.accent;
  g.beginPath(); g.roundRect(-0.012, y - 0.006, 0.024, 0.024, 0.003); g.fill(); g.restore();
}
function row(g, S, str, x, y, size, a, mark = true) {
  if (a <= 0.01) return;
  if (mark) {
    g.save(); g.globalAlpha = a * 0.9; g.fillStyle = PALETTE.accent;
    g.beginPath(); g.roundRect(x - 0.026, y - 0.006, 0.012, 0.012, 0.002); g.fill(); g.restore();
  }
  label(g, S, str, x, y + 0.011, size, PALETTE.ink, null, a, 'left');
}

// ---- scenes ----------------------------------------------------------------------------------------------------
function sHero(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.08, 1.0);   // already moving on frame 0
  const r1 = (1 - EASE.out(MOTION.at(t, 0.05, 0.55))) * 0.055;     // the line itself travels: ink moving, not a fade
  const r2 = (1 - EASE.out(MOTION.at(t, 0.70, 0.55))) * 0.055;
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    text(g, S, '先讲清楚', 0, -0.12 + r1, 0.115, PALETTE.ink, 1, null, { reveal: EASE.out(MOTION.at(t, 0.05, 0.5)), by: 'word' });
    text(g, S, '再讲漂亮', 0, 0.10 + r2, 0.115, PALETTE.accent, 1, null, { reveal: EASE.out(MOTION.at(t, 0.70, 0.5)), by: 'word' });
    const rule = EASE.inOut(MOTION.at(t, 1.42, 0.55));   // the rule draws itself: motion across the empty gap
    if (rule > 0) {
      g.save(); g.globalAlpha = 0.5; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0026;
      g.beginPath(); g.moveTo(-0.16 * rule, 0.245); g.lineTo(0.16 * rule, 0.245); g.stroke(); g.restore();
    }
    const rs = (1 - EASE.out(MOTION.at(t, 1.9, 0.5))) * 0.03;
    sub(g, S, '一条视频，一个问题', 0.33 + rs, 0.034, MOTION.at(t, 1.9, 0.45) * 0.95);
  });
}

function sPoint(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.04);
  const slam = MOTION.back(MOTION.at(t, 7.35, 0.45), 1.4);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    text(g, S, '别堆信息，', 0, -0.26, 0.058, PALETTE.dim, 1, null, { reveal: EASE.out(MOTION.at(t, 6.5, 0.6)), by: 'word' });
    if (t > 7.3) text(g, S, '先搭结构', 0, -0.14, 0.09 * (0.92 + 0.08 * slam), PALETTE.ink, 1, null, { reveal: EASE.out(MOTION.at(t, 7.35, 0.55)), by: 'word' });
    const items = [['先给结论', 8.13], ['再摆证据', 8.99], ['最后举例', 9.85]];
    items.forEach(([s, at], i) => row(g, S, s, -0.36, 0.02 + i * 0.105, 0.042, EASE.out(MOTION.at(t, at, 0.5))));
  });
}

function sNumber(g, k, t, S) {
  tuneType();
  const cam = CAM.base();
  const p = EASE.out(MOTION.at(t, 11.64, 0.87));
  const n = Math.round(p * 1);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    sub(g, S, '一页只讲', -0.30, 0.036, EASE.out(MOTION.at(t, 11.45, 0.5)));
    text(g, S, String(n), 0, -0.02, 0.30, PALETTE.accent, 1, null, { reveal: p > 0 ? 1 : 0.001, by: 'char' });
    text(g, S, '个观点', 0, 0.20, 0.062, PALETTE.ink, 1, null, { reveal: EASE.out(MOTION.at(t, 11.9, 0.6)), by: 'word' });
    const a = MOTION.at(t, 12.4, 0.6);
    if (a > 0) {
      g.save(); g.globalAlpha = a * 0.45; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0026;
      g.beginPath(); g.moveTo(-0.14, 0.275); g.lineTo(0.14, 0.275); g.stroke(); g.restore();
    }
    sub(g, S, '贪多，是大多数讲解失败的原因', 0.35, 0.032, a * 0.95);
  });
}

function sCompare(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.02, 1.0);
  const L = [[-0.78, '堆信息', ['术语先行', '例子散落', '听完就忘'], 14.58], [0.04, '搭结构', ['结论先行', '一层层展开', '能复述给别人'], 15.44]];
  const strike = MOTION.at(t, 16.18, 0.45);
  const stamp = EASE.out(MOTION.at(t, 16.6, 0.4));
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    g.save(); g.globalAlpha = 0.2; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0016;
    g.beginPath(); g.moveTo(-0.03, -0.24); g.lineTo(-0.03, 0.28); g.stroke(); g.restore();
    L.forEach(([x, title, items, at], ci) => {
      const a = EASE.out(MOTION.at(t, at, 0.55));
      label(g, S, title, x, -0.10 + 0.011, 0.05, ci ? PALETTE.ink : PALETTE.dim, null, a, 'left');
      items.forEach((s, i) => row(g, S, s, x, 0.02 + i * 0.075, 0.032, EASE.out(MOTION.at(t, at + 0.22 + i * 0.16, 0.45)), ci === 1));
    });
    if (strike > 0) {
      g.save(); g.strokeStyle = PALETTE.accent; g.lineWidth = 0.0045; g.lineCap = 'round'; g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(-0.80, 0.12); g.lineTo(-0.80 + 0.46 * EASE.out(strike), 0.12); g.stroke(); g.restore();
    }
    if (stamp > 0.01) {
      g.save(); g.globalAlpha = stamp; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.0035;
      g.beginPath(); g.roundRect(-0.78, 0.20, 0.13, 0.055, 0.004); g.stroke();
      label(g, S, '淘汰', -0.715, 0.244, 0.026, PALETTE.accent, null, 1, 'center');
      g.restore();
    }
  });
}

function sSteps(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.03);
  const steps = [['抛问题', 18.79], ['给结论', 19.74], ['摆证据', 20.69], ['收行动', 21.64]];
  const xs = [-0.60, -0.20, 0.20, 0.60];
  const railA = MOTION.at(t, 18.6, 0.6);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    label(g, S, '一条视频的骨架', -LR, -0.32, 0.038, PALETTE.dim, null, EASE.out(MOTION.at(t, 18.5, 0.5)), 'left');
    g.save(); g.globalAlpha = 0.22 * railA; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0018;
    g.beginPath(); g.moveTo(-0.72, -0.02); g.lineTo(0.72, -0.02); g.stroke(); g.restore();
    const prog = EASE.out(MOTION.at(t, 19.0, 1.6));
    g.save(); g.globalAlpha = 0.85; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.0035;
    g.beginPath(); g.moveTo(-0.72, -0.02); g.lineTo(-0.72 + 1.44 * prog, -0.02); g.stroke(); g.restore();
    steps.forEach(([s, at], i) => {
      const a = EASE.out(MOTION.at(t, at, 0.45));
      if (a <= 0.01) return;
      g.save(); g.globalAlpha = a;
      g.fillStyle = PALETTE.accent; g.beginPath(); g.arc(xs[i], -0.02, 0.011, 0, TAU); g.fill();
      g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0026; g.globalAlpha = a * 0.35;
      g.beginPath(); g.moveTo(xs[i], -0.005); g.lineTo(xs[i], 0.06); g.stroke();
      g.restore();
      label(g, S, s, xs[i], 0.095, 0.036, PALETTE.ink, null, a, 'center');
    });
  });
}

function sQuote(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.06, 1.0);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    text(g, S, '让人记住的', 0, -0.10, 0.062, PALETTE.dim, 1, null, { reveal: EASE.out(MOTION.at(t, 24.75, 0.7)), by: 'word' });
    text(g, S, '不是信息量', 0, 0.04, 0.085, PALETTE.accent, 1, null, { reveal: EASE.out(MOTION.at(t, 25.35, 0.7)), by: 'word' });
    label(g, S, '表达原则 · 02', 0, 0.30, 0.032, PALETTE.dim, null, MOTION.at(t, 26.0, 0.6) * 0.9, 'center');
  });
}

function sCheck(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.03);
  const items = [['一句话说得清吗', 28.43], ['证据够不够', 29.33], ['能照着做吗', 30.23]];
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    label(g, S, '发布前三问', -0.42, -0.20, 0.046, PALETTE.ink, null, EASE.out(MOTION.at(t, 28.2, 0.5)), 'left');
    items.forEach(([s, at], i) => {
      const a = EASE.out(MOTION.at(t, at, 0.45));
      if (a <= 0.01) return;
      const y = 0.0 + i * 0.11;
      g.save(); g.globalAlpha = a; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.0032;
      g.beginPath(); g.roundRect(-0.44, y - 0.019, 0.036, 0.036, 0.004); g.stroke();
      g.beginPath(); g.moveTo(-0.432, y - 0.002); g.lineTo(-0.420, y + 0.012); g.lineTo(-0.398, y - 0.014); g.stroke();
      g.restore();
      label(g, S, s, -0.36, y + 0.013, 0.038, PALETTE.ink, null, a, 'left');
    });
  });
}

function sOutro(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.03, 1.0);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    label(g, S, '本期制作说明', -0.42, -0.18, 0.042, PALETTE.dim, null, EASE.out(MOTION.at(t, 33.5, 0.5)), 'left');
    label(g, S, '文案：三条表达原则 · 全新一版', -0.42, -0.04, 0.032, PALETTE.ink, null, EASE.out(MOTION.at(t, 33.75, 0.5)), 'left');
    label(g, S, '配音：edge-tts 云希 · 自制背景音', -0.42, 0.03, 0.032, PALETTE.ink, null, EASE.out(MOTION.at(t, 34.0, 0.5)), 'left');
    const a = EASE.out(MOTION.at(t, 34.6, 0.6));
    if (a > 0.01) {
      g.save(); g.globalAlpha = a * 0.8; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.003;
      g.beginPath(); g.roundRect(-0.42, 0.13, 0.62, 0.052, 0.004); g.stroke(); g.restore();
      label(g, S, '用这个模板把我的方法讲成一条短片', -0.40, 0.166, 0.032, PALETTE.accent, null, a, 'left');
    }
  });
}

function score(ctx, out) {}
