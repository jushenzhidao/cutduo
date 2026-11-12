// ============================== FILM ==============================
// 同一条口播（「完播率 · 五个开关」，46.386s）的 cinecode 版：8 个版式，时间轴与 skia-kit 的
// inputs-md.json 逐秒对齐，成片用同一条 voiceover.m4a。两条管线只差渲染器，不差内容、不差节奏、不差声音。
const TITLE = '完播率';
const PURPOSE = 'ad';
const FINISH = { shutter: null, weave: 0, tone: null };
const FPS = 60;
const DURATION = 46.386;                     // = inputs-md.json 的 durationSeconds
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

// Scene boundaries: identical to inputs-md.json (t0/t1), so the two films cut on the same frames.
const SC = { hero: 0, point: 5.39, number: 12.09, compare: 16.42, steps: 22.57, quote: 30.63, check: 33.39, outro: 40.68, end: DURATION };
const CUES = { ...SC };

const VO = [];
const CAPTIONS = null;
const CAPTION_STYLE = { role: 'display', accentRole: 'display', size: 0.05, caps: false, ink: PALETTE.ink, hi: PALETTE.ink, accent: PALETTE.accent, punch: 0.07 };

const SCENES = [
  { chapter: 'C1', from: SC.hero, to: SC.point, draw: sHero, action: 'the first line rises, then the answer lands', amb: null },
  { chapter: 'C1', from: SC.point, to: SC.number, draw: sPoint, action: 'three positions tick in one by one', amb: null },
  { chapter: 'C2', from: SC.number, to: SC.compare, draw: sNumber, action: 'the counter turns from 0 to 5', amb: null },
  { chapter: 'C2', from: SC.compare, to: SC.steps, draw: sCompare, action: 'the old way is struck through', amb: null },
  { chapter: 'C3', from: SC.steps, to: SC.quote, draw: sSteps, action: 'five switches light along the rail', amb: null },
  { chapter: 'C3', from: SC.quote, to: SC.check, draw: sQuote, action: 'the second line answers the first', amb: null },
  { chapter: 'C4', from: SC.check, to: SC.outro, draw: sCheck, action: 'three checks tick off before publishing', amb: null },
  { chapter: 'C4', from: SC.outro, to: SC.end, draw: sOutro, action: 'the credits settle', amb: null },
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
  const tc = `00:${String(Math.floor(t)).padStart(2, '0')}:${String(Math.floor((t % 1) * FPS)).padStart(2, '0')}`;
  label(g, S, tc, LR, -0.428, 0.017, PALETTE.ink, null, 0.55, 'right');
  g.globalAlpha = 0.18; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0012;
  g.beginPath(); g.moveTo(-LR, -0.415); g.lineTo(LR, -0.415); g.stroke();
  g.restore();
  captionBand(g, S, t);
}

// 烧录字幕：时间点与 voiceover.srt 的 8 句逐秒对齐。
const LINES = [
  [0.4, 4.744, '观众划走，不是没耐心，是前几秒没钩子。'],
  [5.394, 11.586, '前 3 秒、每 5 秒、结尾，三个位置决定完播、转发和关注。'],
  [12.086, 15.926, '五个开关，每多一个，留存就多一截。'],
  [16.426, 22.57, '旧做法先铺垫、慢进主题；新做法先给结果，每段一个钩子。'],
  [23.07, 30.126, '五个开关：先给结果、每段一问、画面换点、节奏加速、结尾留钩。'],
  [30.626, 33.386, '留存不是运气，是设计。'],
  [33.886, 40.678, '发布前查三样：前 3 秒有钩吗，每 5 秒有变化吗，结尾有下一个问题吗。'],
  [41.178, 45.786, '下一期，用这套开关，重剪一条属于你的片子。'],
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
  const r1 = (1 - EASE.out(MOTION.at(t, 0.5, 0.55))) * 0.055;
  const r2 = (1 - EASE.out(MOTION.at(t, 1.7, 0.55))) * 0.055;
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    text(g, S, '观众划走', 0, -0.12 + r1, 0.115, PALETTE.ink, 1, null, { reveal: EASE.out(MOTION.at(t, 0.5, 0.5)), by: 'word' });
    text(g, S, '因为前几秒没钩子', 0, 0.10 + r2, 0.088, PALETTE.accent, 1, null, { reveal: EASE.out(MOTION.at(t, 1.7, 0.6)), by: 'word' });
    const rule = EASE.inOut(MOTION.at(t, 2.6, 0.55));
    if (rule > 0) {
      g.save(); g.globalAlpha = 0.5; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0026;
      g.beginPath(); g.moveTo(-0.16 * rule, 0.235); g.lineTo(0.16 * rule, 0.235); g.stroke(); g.restore();
    }
    const rs = (1 - EASE.out(MOTION.at(t, 3.2, 0.5))) * 0.03;
    sub(g, S, '前 3 秒决定一切', 0.315 + rs, 0.034, MOTION.at(t, 3.2, 0.45) * 0.95);
  });
}

function sPoint(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.04);
  const slam = MOTION.back(MOTION.at(t, 6.6, 0.45), 1.4);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    text(g, S, '前 3 秒、每 5 秒、结尾', 0, -0.26, 0.052, PALETTE.dim, 1, null, { reveal: EASE.out(MOTION.at(t, 5.75, 0.6)), by: 'word' });
    if (t > 6.55) text(g, S, '三个位置', 0, -0.13, 0.095 * (0.92 + 0.08 * slam), PALETTE.ink, 1, null, { reveal: EASE.out(MOTION.at(t, 6.6, 0.55)), by: 'word' });
    const items = [['决定完播', 8.0], ['决定转发', 9.4], ['决定关注', 10.9]];
    items.forEach(([s, at], i) => row(g, S, s, -0.36, 0.02 + i * 0.105, 0.042, EASE.out(MOTION.at(t, at, 0.5))));
  });
}

function sNumber(g, k, t, S) {
  tuneType();
  const cam = CAM.base();
  const p = EASE.out(MOTION.at(t, 12.5, 2.2));
  const n = Math.round(p * 5);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    sub(g, S, '五个开关', -0.30, 0.036, EASE.out(MOTION.at(t, 12.2, 0.5)));
    text(g, S, String(n), 0, -0.02, 0.30, PALETTE.accent, 1, null, { reveal: p > 0 ? 1 : 0.001, by: 'char' });
    text(g, S, '个开关', 0, 0.20, 0.062, PALETTE.ink, 1, null, { reveal: EASE.out(MOTION.at(t, 12.6, 0.6)), by: 'word' });
    const a = MOTION.at(t, 14.8, 0.6);
    if (a > 0) {
      g.save(); g.globalAlpha = a * 0.45; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0026;
      g.beginPath(); g.moveTo(-0.14, 0.275); g.lineTo(0.14, 0.275); g.stroke(); g.restore();
    }
    sub(g, S, '每多一个，留存就多一截', 0.35, 0.032, a * 0.95);
  });
}

function sCompare(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.02, 1.0);
  const L = [[-0.78, '旧做法', ['先铺垫', '慢进主题', '等观众自己发现'], 17.1], [0.04, '新做法', ['先给结果', '每段一个钩子', '结尾留问题'], 18.6]];
  const strike = MOTION.at(t, 20.3, 0.45);
  const stamp = EASE.out(MOTION.at(t, 20.9, 0.4));
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
      label(g, S, '换掉', -0.715, 0.244, 0.026, PALETTE.accent, null, 1, 'center');
      g.restore();
    }
  });
}

function sSteps(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.03);
  const steps = [['先给结果', 24.3], ['每段一问', 25.45], ['画面换点', 26.55], ['节奏加速', 27.65], ['结尾留钩', 28.8]];
  const xs = [-0.62, -0.31, 0, 0.31, 0.62];
  const railA = MOTION.at(t, 23.0, 0.6);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    label(g, S, '五个开关，一条一条装上', -LR, -0.32, 0.038, PALETTE.dim, null, EASE.out(MOTION.at(t, 22.9, 0.5)), 'left');
    g.save(); g.globalAlpha = 0.22 * railA; g.strokeStyle = PALETTE.ink; g.lineWidth = 0.0018;
    g.beginPath(); g.moveTo(-0.72, -0.02); g.lineTo(0.72, -0.02); g.stroke(); g.restore();
    const prog = EASE.out(MOTION.at(t, 23.4, 1.6));
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
      label(g, S, s, xs[i], 0.095, 0.034, PALETTE.ink, null, a, 'center');
    });
  });
}

function sQuote(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.06, 1.0);
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    text(g, S, '留存不是运气', 0, -0.10, 0.062, PALETTE.dim, 1, null, { reveal: EASE.out(MOTION.at(t, 31.2, 0.7)), by: 'word' });
    text(g, S, '是设计', 0, 0.04, 0.10, PALETTE.accent, 1, null, { reveal: EASE.out(MOTION.at(t, 31.9, 0.7)), by: 'word' });
    label(g, S, '完播率 · 03', 0, 0.30, 0.032, PALETTE.dim, null, MOTION.at(t, 32.5, 0.6) * 0.9, 'center');
  });
}

function sCheck(g, k, t, S) {
  tuneType();
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.0, 1.03);
  const items = [['前 3 秒有钩吗', 34.7], ['每 5 秒有变化吗', 36.7], ['结尾有下一个问题吗', 38.7]];
  plane(g, S, cam, 0, (g) => {
    chrome(g, S, t);
    label(g, S, '发布前查三样', -0.42, -0.20, 0.046, PALETTE.ink, null, EASE.out(MOTION.at(t, 33.9, 0.5)), 'left');
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
    label(g, S, '本期制作说明', -0.42, -0.18, 0.042, PALETTE.dim, null, EASE.out(MOTION.at(t, 41.0, 0.5)), 'left');
    label(g, S, '文案：完播率 · 五个开关', -0.42, -0.04, 0.032, PALETTE.ink, null, EASE.out(MOTION.at(t, 41.3, 0.5)), 'left');
    label(g, S, '配音：edge-tts · 同一条音轨（skia / film-kit 共用）', -0.42, 0.03, 0.032, PALETTE.ink, null, EASE.out(MOTION.at(t, 41.6, 0.5)), 'left');
    const a = EASE.out(MOTION.at(t, 42.4, 0.6));
    if (a > 0.01) {
      g.save(); g.globalAlpha = a * 0.8; g.strokeStyle = PALETTE.accent; g.lineWidth = 0.003;
      g.beginPath(); g.roundRect(-0.42, 0.13, 0.72, 0.052, 0.004); g.stroke(); g.restore();
      label(g, S, '下一期：用这套开关重剪一条，从钩子开始', -0.40, 0.166, 0.030, PALETTE.accent, null, a, 'left');
    }
  });
}

function score(ctx, out) {}
