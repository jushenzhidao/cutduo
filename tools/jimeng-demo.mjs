#!/usr/bin/env node
/**
 * jimeng-demo.mjs · 按「即梦 Motion Showreel」语法做一支 15 秒片
 *
 * 规则来源：docs/jimeng/01-motion-showreel-2026-11-16.md 的 §2 九条。
 * 这不是 kit，是一次**验证性复刻**：用来回答"那套语法换成本仓的素材还成不成立"。
 *
 *   node tools/jimeng-demo.mjs                       # 出 PNG 序列 → out/jimeng-demo/frames
 *   node tools/jimeng-demo.mjs --at 3.2 --out a.png  # 单帧
 *
 * 刻意的取舍（都在蒸馏文档里写了理由）：
 *   · 字体用思源宋体 Black 代替 Didone —— 中文的高对比衬线等价物，不引新西文字体。
 *   · "真 UI 截图"换成**真实数据的自绘卡**（params / 回执 / 门禁），不伪造截图。
 *   · 无旁白，2.5s/镜。中文口播塞不进这个节奏，所以这支片只能是音乐驱动。
 *   · 30fps，拖影 1–2 帧（60fps 的片子要减半）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { registerFonts } from '../src/fonts.mjs';
import { DIRS, REPO_ROOT } from '../src/root.mjs';

/* ───────────────────────────── 参数与常量 */

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DEFAULT_PARAMS = 'content/jimeng-showreel/params.json';
const PARAMS_PATH = path.resolve(REPO_ROOT, get('params', DEFAULT_PARAMS));
const raw = (() => {
  if (!fs.existsSync(PARAMS_PATH)) {
    console.error(`FAIL  找不到参数文件：${PARAMS_PATH}\n      换题材用 --params <json>；默认片在 ${DEFAULT_PARAMS}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'));
  } catch (e) {
    console.error(`FAIL  ${PARAMS_PATH} 不是合法 JSON：${e.message}`);
    process.exit(2);
  }
})();

/** 六个构图是代码，不是数据：换文字换数据不用改这里，换版式才要。 */
const PAINTERS = {
  scatter: drawScatter,
  gather: drawGather,
  recall: drawRecall,
  arrange: drawArrange,
  route: drawRoute,
  lockup: drawLockup,
};

/**
 * 校验只拦「会静默产废片」的情况。缺一个字段就崩，比渲出一支空片好——
 * 空片能过 gate（0 空帧 0 黑帧），会被当成成功。
 */
function validate(p) {
  const die2 = (m) => {
    console.error(`FAIL  ${PARAMS_PATH}\n      ${m}`);
    process.exit(2);
  };
  if (!p || typeof p !== 'object' || Array.isArray(p)) die2('顶层必须是对象');
  if (!p.meta || typeof p.meta !== 'object') die2('缺 meta 对象');
  const dur = Number(p.meta.duration);
  if (!(dur > 0)) die2('meta.duration 必须是正数');
  if (!Array.isArray(p.scenes) || !p.scenes.length) die2('缺 scenes[]（至少一段）');

  const seen = new Set();
  for (const sc of p.scenes) {
    if (!sc || !sc.id) die2('scene 缺 id');
    if (!PAINTERS[sc.id]) die2(`未知 scene id: ${sc.id}（可用：${Object.keys(PAINTERS).join(' / ')}）`);
    if (seen.has(sc.id)) die2(`scene id 重复: ${sc.id}`);
    seen.add(sc.id);
    const a = Number(sc.t0);
    const b = Number(sc.t1);
    if (!Number.isFinite(a) || !Number.isFinite(b)) die2(`scene ${sc.id}: t0/t1 必须是数字`);
    if (!(b > a)) die2(`scene ${sc.id}: t1(${b}) 必须大于 t0(${a})`);
    if (b > dur + 1e-6) die2(`scene ${sc.id}: t1(${b}) 超出 meta.duration(${dur})`);
  }
  /** 每个构图要哪些字段是代码知识，必须在这里一次校验完；
   *  放到渲染里检查就等于"第 300 帧才崩"，片子已经渲了一半。 */
  const REQUIRED = {
    scatter: ['words', 'verdict'],
    gather: ['eyebrow', 'title', 'sub', 'cta', 'cards'],
    recall: ['eyebrow', 'title', 'cmd', 'runLabel', 'count', 'rows'],
    arrange: ['note', 'tags', 'card'],
    route: ['eyebrow', 'lines'],
    lockup: ['name', 'slogan', 'cta', 'platforms'],
  };
  for (const sc of p.scenes) {
    for (const k of REQUIRED[sc.id] || []) {
      const val = sc[k];
      if (val === undefined || val === null || val === '') die2(`scene ${sc.id} 缺字段 ${k}`);
    }
  }

  const sorted = [...p.scenes].sort((x, y) => x.t0 - y.t0);
  if (Math.abs(Number(sorted[0].t0)) > 1e-6) die2('第一段必须从 t0=0 开始');
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(Number(sorted[i].t0) - Number(sorted[i - 1].t1)) > 1e-6) {
      die2(`时间轴不连续：${sorted[i - 1].id} 止于 ${sorted[i - 1].t1}，${sorted[i].id} 起于 ${sorted[i].t0}`);
    }
  }
}
validate(raw);

/**
 * 每个文本槽位的**可用宽度**（像素，1920×1080 基准）。
 * 这些数字不是拍的，是从下面的绘制坐标反推的：
 *   标题 x=170 起，右侧卡片墙起于 1010 ⇒ 可用 840，再留 40 安全边 = 800
 *   STORY 卡宽 336、内边距 24 ⇒ 288；列表再缩进 26 ⇒ 262
 * 换版式时这里要跟着改，**它就是版式的文字容量声明**。
 */
const TEXT_SLOTS = [
  { sc: 'gather', path: ['title', 0], size: 104, fam: 'serif', maxW: 800, what: '标题第一行' },
  { sc: 'gather', path: ['title', 1], size: 104, fam: 'serif', maxW: 800, what: '标题第二行' },
  { sc: 'gather', path: ['sub', 0], size: 30, fam: 'ui', maxW: 800, what: '副文案' },
  { sc: 'gather', path: ['sub', 1], size: 30, fam: 'ui', maxW: 800, what: '副文案第二行', optional: true },
  { sc: 'gather', path: ['cta'], size: 30, fam: 'ui', maxW: 128, what: '按钮文字' },
  { sc: 'gather', path: ['cards', 0, 'title'], size: 34, fam: 'ui', maxW: 288, what: '第一张卡标题' },
  { sc: 'gather', path: ['cards', 0, 'items'], size: 22, fam: 'ui', maxW: 262, each: true, what: '卡内清单项' },
  { sc: 'gather', path: ['cards', 1, 'lines'], size: 19, fam: 'mono', maxW: 274, each: true, what: 'JSON 行' },
  { sc: 'gather', path: ['cards', 2, 'label'], size: 20, fam: 'mono', maxW: 252, what: '数据标签' },
  { sc: 'gather', path: ['cards', 2, 'value'], size: 58, fam: 'mono', maxW: 200, what: '主数值' },
  { sc: 'gather', path: ['cards', 3, 'lines'], size: 21, fam: 'mono', maxW: 226, each: true, what: '门禁行' },
  { sc: 'gather', path: ['cards', 4, 'text'], size: 26, fam: 'ui', maxW: 282, what: '统计条正文' },
  { sc: 'gather', path: ['cards', 4, 'sub'], size: 19, fam: 'ui', maxW: 282, what: '统计条副文' },
  { sc: 'recall', path: ['title'], size: 96, fam: 'serif', maxW: 1580, join: true, what: '整行标题（两段合计）' },
  { sc: 'recall', path: ['cmd'], size: 31, fam: 'mono', maxW: 918, what: '命令行' },
  { sc: 'recall', path: ['count'], size: 21, fam: 'mono', maxW: 900, what: '计数行' },
  { sc: 'recall', path: ['rows'], size: 30, fam: 'ui', maxW: 874, eachRow: 0, what: '结果行标题' },
  { sc: 'recall', path: ['rows'], size: 20, fam: 'mono', maxW: 874, eachRow: 1, what: '结果行副文' },
  { sc: 'arrange', path: ['note', 0], size: 28, fam: 'ui', maxW: 1400, what: '浮层正文' },
  { sc: 'arrange', path: ['note', 1], size: 20, fam: 'ui', maxW: 1400, what: '浮层次行', optional: true },
  { sc: 'arrange', path: ['card', 'title'], size: 34, fam: 'ui', maxW: 368, what: '中心卡标题' },
  { sc: 'arrange', path: ['card', 'sub'], size: 21, fam: 'mono', maxW: 368, what: '中心卡副文' },
  { sc: 'route', path: ['lines', 0], size: 112, fam: 'serif', maxW: 990, what: '大字第一行' },
  { sc: 'route', path: ['lines', 1], size: 112, fam: 'serif', maxW: 990, what: '大字第二行', optional: true },
  { sc: 'lockup', path: ['name'], size: 86, fam: 'serif', maxW: 1200, what: '品牌名' },
  { sc: 'lockup', path: ['slogan'], size: 40, fam: 'serif', maxW: 1520, join: true, what: 'slogan（两段合计）' },
  { sc: 'lockup', path: ['cta'], size: 28, fam: 'ui', maxW: 200, what: '按钮文字' },
];

const pick = (obj, keyPath) => keyPath.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * 版式容量校验：用**真实字体**量每一段文案，装不下就拒绝。
 *
 * 为什么不自动缩字号：字号是这套片子的设计决策（原片 104/96/112/86 各有出处），
 * 按文案长度自动缩会悄悄破坏层级——`写一句。` 和 `往里掉，就出不来。` 应该是同一个字号。
 * 也不能换行：双色标题的第二行有语义，断行会拆散「主句 / 结论」。
 * 所以选择**报错并给出字数上限**，让人改文案，而不是让机器改版式。
 */
function validateLayout(p, ctx) {
  const fonts = { serif: '"SerifCN", "NotoSC Regular"', ui: '"NotoSC Regular"', mono: '"JBMono", "NotoSC Regular"' };
  const fails = [];
  for (const slot of TEXT_SLOTS) {
    const sc = p.scenes.find((x) => x.id === slot.sc);
    if (!sc) continue;
    let vals = pick(sc, slot.path);
    if (vals == null) continue;
    if (slot.join) vals = [vals.join('')];
    else if (slot.each) vals = Array.isArray(vals) ? vals : [];
    else if (slot.eachRow != null) vals = (vals || []).map((r) => r[slot.eachRow]).filter((v) => v != null);
    else vals = [vals];

    for (const v of vals) {
      if (v === '') continue;
      ctx.font = `${slot.size}px ${fonts[slot.fam]}`;
      const w = ctx.measureText(String(v)).width;
      if (w > slot.maxW) {
        /* 中文近等宽，用 1 个字宽反推上限，比"超了 36px"更好用 */
        const per = slot.size;
        const cap = Math.max(1, Math.floor(slot.maxW / per));
        const pstr = slot.path.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('');
        fails.push(`${slot.sc}.${pstr}（${slot.what}）`
          + `「${v}」需要 ${Math.round(w)}px，可用 ${slot.maxW}px —— 建议 ≤${cap} 字`);
      }
    }
  }
  if (fails.length) {
    console.error(`FAIL  ${PARAMS_PATH}\n      有 ${fails.length} 段文案超出所在版位的容量：`);
    for (const f of fails) console.error(`        · ${f}`);
    console.error('      字号与版位是设计决策，不会按文案长度自动缩；请缩短文案或改 TEXT_SLOTS 的 maxW。');
    process.exit(2);
  }
}

const P = raw;
const S = Object.fromEntries(P.scenes.map((sc) => [sc.id, sc]));
const W = Number(P.meta.width) || 1920;
const H = Number(P.meta.height) || 1080;
const FPS = Number(P.meta.fps) || 30;
const DUR = Number(P.meta.duration);

const OUT_DIR = path.resolve(get('out', 'out/jimeng-demo'));
const AT = get('at') ? Number(get('at')) : null;

/* 主题色：浅底宝蓝、深底青绿（原片就是随底色换强调色，不是固定品牌色） */
const C = {
  ink: '#111214',
  ink2: 'rgba(17,18,20,0.62)',
  ink3: 'rgba(17,18,20,0.38)',
  paper: '#F3F4F5',
  night: '#07080B',
  blue: '#2F3BE8',
  blueSoft: '#E8EAFF',
  teal: '#3FD9A0',
  white: '#FFFFFF',
  white2: 'rgba(255,255,255,0.66)',
  white3: 'rgba(255,255,255,0.34)',
};

/**
 * 时间轴来自 params：段的起止、明暗、构图都不写死在代码里。
 * 硬切点的位置因此由数据决定（默认片仍是 2.5 / 10.0 / 12.5）。
 */
const SCENES = P.scenes
  .map((sc) => ({ ...sc, dark: !!sc.dark, draw: PAINTERS[sc.id] }))
  .sort((a, b) => a.t0 - b.t0);

/* ───────────────────────────── 小工具 */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - clamp(t)) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** 段内进度，0 前 / 1 后 */
const prog = (local, start, dur) => clamp((local - start) / dur);

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

/** 等高线拖影：同一元素按时间回退重画，alpha 递减。原片是快门拖影，不是缓动。 */
function ghosts(ctx, local, deltas, fn) {
  for (let i = deltas.length - 1; i >= 0; i--) {
    ctx.save();
    ctx.globalAlpha = 0.13 - i * 0.04;
    ctx.translate(-deltas[i] * 260, 0); // 沿运动方向轻微错位
    fn(local - deltas[i]);
    ctx.restore();
  }
  fn(local);
}

/** 逐字绘制，模拟字距（@napi-rs/canvas 的 letterSpacing 在部分版本是空实现） */
function tracked(ctx, text, x, y, tracking) {
  const chars = [...text];
  let cx = x;
  for (const ch of chars) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
  return cx - x - tracking;
}

function trackedWidth(ctx, text, tracking) {
  const chars = [...text];
  return chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + tracking * Math.max(0, chars.length - 1);
}

/** eyebrow 三件套：NN · PHRASE + 短横线 */
function eyebrow(ctx, local, num, phrase, color, alpha = 1) {
  const e = easeOut(prog(local, 0.06, 0.3)) * alpha;
  if (e <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = e;
  ctx.font = '23px "JBMono", "NotoSC Regular"';
  ctx.fillStyle = color;
  const t = `${num} · ${phrase}`;
  const w = tracked(ctx, t, 170, 300 - 8 * (1 - e), 3.4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(170, 322);
  ctx.lineTo(170 + Math.min(w * 0.4, 46) * e, 322);
  ctx.stroke();
  ctx.restore();
}

/** 类型药丸：卡片左上角的实色标签，本片"每张卡都像真东西"的一半原因 */
function pill(ctx, x, y, text, color, size = 17) {
  ctx.font = `${size}px "JBMono", "NotoSC Regular"`;
  const w = trackedWidth(ctx, text, 1.6) + size * 1.5;
  const h = size * 1.85;
  ctx.fillStyle = color;
  rr(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = C.white;
  tracked(ctx, text, x + size * 0.75, y + h / 2 + size * 0.36, 1.6);
  return { w, h };
}

/** 四角星：✦ U+2726 在 JBMono / NotoSC / SerifCN 里都没有字形，只能画。 */
function star4(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.32;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 柔和投影卡（白卡用），返回绘制内容的内部坐标变换 */
function card(ctx, x, y, w, h, rot, opt = {}) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  ctx.shadowColor = opt.shadow || 'rgba(20,26,60,0.13)';
  ctx.shadowBlur = opt.blur ?? 34;
  ctx.shadowOffsetY = opt.dy ?? 14;
  ctx.fillStyle = opt.fill || C.white;
  rr(ctx, 0, 0, w, h, opt.r ?? 22);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  if (opt.stroke) {
    ctx.strokeStyle = opt.stroke;
    ctx.lineWidth = opt.strokeW || 2;
    ctx.stroke();
  }
  return { w, h };
}

/* ───────────────────────────── 背景 */

/**
 * 背景是**静态**的（浅底 2400 个点、深底 30 条网格线），逐帧重画纯属浪费。
 * 但实测收益有限：450 帧 154s → 126s（−18%），真正的瓶颈是 PNG 编码
 * （每帧约 180ms 的 toBuffer + 写盘）。这层留着是因为它零成本，且背景
 * 一旦复杂化就是几千次绘制；别指望它把渲染从分钟级降下来。
 */
const BG_CACHE = {};
function bgLayer(dark) {
  const key = dark ? 'night' : 'paper';
  if (!BG_CACHE[key]) {
    const c = createCanvas(W, H);
    const x = c.getContext('2d');
    if (dark) paintDark(x);
    else paintLight(x);
    BG_CACHE[key] = c;
  }
  return BG_CACHE[key];
}
function lightBg(ctx) {
  ctx.drawImage(bgLayer(false), 0, 0);
}
function darkBg(ctx) {
  ctx.drawImage(bgLayer(true), 0, 0);
}

/** 浅底：冷灰白 + 细点阵 + 中心径向亮（原片不是纯白） */
function paintLight(ctx) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.62, H * 0.42, 0, W * 0.62, H * 0.42, W * 0.62);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(238,240,243,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(20,26,60,0.055)';
  for (let y = 18; y < H; y += 26) {
    for (let x = 18; x < W; x += 26) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 深底：近黑 + 青色网格 + 中心冷光 */
function paintDark(ctx) {
  ctx.fillStyle = C.night;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.52, H * 0.45, 0, W * 0.52, H * 0.45, W * 0.58);
  g.addColorStop(0, 'rgba(52,96,220,0.16)');
  g.addColorStop(0.55, 'rgba(38,60,140,0.06)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(120,220,255,0.055)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += 128) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

/** 明暗插值：只在三个硬切点附近 0.1s 内过渡，其余恒定 */
/**
 * 硬切点 = 相邻两段明暗不同的那些边界，由数据推导。
 * 早先写死 [[2.5,0,1],[10.0,1,0],[12.5,0,1]]：默认片对，换题材改时长就全错位，
 * 而且不会报错——只是整片的明暗节奏悄悄变成"前半白后半黑"。
 */
const EDGES = SCENES.slice(1)
  .map((sc, i) => {
    const prev = SCENES[i];
    return [Number(sc.t0), prev.dark ? 0 : 1, sc.dark ? 0 : 1];
  })
  .filter(([, a, b]) => a !== b);
function bgAt(t) {
  let prev = 0;
  for (const [at, a, b] of EDGES) {
    if (t >= at + 0.05) { prev = b; continue; }
    if (t >= at - 0.05) return lerp(a, b, (t - (at - 0.05)) / 0.1);
    return prev;
  }
  return prev;
}

/* ───────────────────────────── 镜 1 · SCATTER（黑） */
/* 碎片在纵深里漂浮，四个词逐个亮起，最后否掉：拼不起来。 */

const FRAGMENTS = [
  { x: 250, y: 210, w: 300, h: 180, rot: -7, z: 0.82, kind: 'json', at: 0.10 },
  { x: 1420, y: 170, w: 260, h: 150, rot: 6, z: 0.76, kind: 'log', at: 0.18 },
  { x: 1560, y: 640, w: 300, h: 200, rot: -4, z: 0.9, kind: 'frame', at: 0.26 },
  { x: 200, y: 700, w: 280, h: 170, rot: 5, z: 0.86, kind: 'gl', at: 0.34 },
  { x: 700, y: 120, w: 200, h: 110, rot: -12, z: 0.66, kind: 'chip', at: 0.42 },
  { x: 1120, y: 840, w: 220, h: 120, rot: 8, z: 0.7, kind: 'chip', at: 0.5 },
];

/** 碎片词的四个槽位（x, y）。词序由 params 决定，槽位由版式决定。 */
const WORD_SLOTS = [[330, 400], [1180, 330], [1420, 760], [470, 830]];

function drawScatter(ctx, local) {
  darkBg(ctx, local);

  /* 不画顶部小节名：HUD 已经给了镜头号，SCATTER 又没有对应的功能段，
     两层编号会互相干扰；原片这一镜的小节名也压在了漂浮碎片上。 */

  /* 漂浮碎片：从纵深推进，带拖影 */
  for (const f of FRAGMENTS) {
    const e = easeOut(prog(local, f.at, 0.45));
    if (e <= 0.01) continue;
    const s = lerp(1.18, 1, e) * (0.9 + f.z * 0.14);
    const dx = (1 - e) * 120 * (f.x < W / 2 ? -1 : 1);
    ghosts(ctx, local, [0.033, 0.066], () => {
      ctx.save();
      ctx.globalAlpha *= 0.5;
      ctx.translate(f.x + f.w / 2 + dx, f.y + f.h / 2);
      ctx.rotate((f.rot * Math.PI) / 180);
      ctx.scale(s, s);
      ctx.translate(-f.w / 2, -f.h / 2);
      ctx.globalAlpha = 0.5;
      fragmentCard(ctx, f);
      ctx.restore();
    });
  }

  /* 四个碎片词逐个亮起。位置是版式（代码），文字来自 params */
  const WORDS = (S.scatter.words || []).slice(0, WORD_SLOTS.length).map((w, i) => [
    w,
    0.32 + i * 0.16,
    WORD_SLOTS[i][0],
    WORD_SLOTS[i][1],
  ]);
  for (const [word, at, x, y] of WORDS) {
    const e = prog(local, at, 0.22);
    if (e <= 0) continue;
    ctx.save();
    ctx.globalAlpha = easeOut(e) * 0.9;
    ctx.font = '54px "SerifCN", "NotoSC Regular"';
    ctx.fillStyle = C.white2;
    ctx.fillText(word, x, y);
    ctx.restore();
  }

  /* 结论：整句否掉。白字不染色 —— 这一镜没有"解决方案"，只有问题。 */
  const e2 = easeOut(prog(local, 1.30, 0.45));
  if (e2 > 0) {
    ctx.save();
    ctx.globalAlpha = e2;
    ctx.font = '104px "SerifCN", "NotoSC Regular"';
    ctx.fillStyle = C.white;
    const verdict = S.scatter.verdict;
    const w = ctx.measureText(verdict).width;
    ctx.fillText(verdict, (W - w) / 2, H / 2 + 38 + (1 - e2) * 18);
    ctx.restore();
  }
}

/** 碎片卡：极暗玻璃 + 细描边，只给"有东西但读不清"的暗示 */
function fragmentCard(ctx, f) {
  ctx.fillStyle = 'rgba(16,20,30,0.86)';
  rr(ctx, 0, 0, f.w, f.h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(140,200,255,0.24)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.font = '12px "JBMono", "NotoSC Regular"';
  ctx.fillStyle = 'rgba(150,210,255,0.5)';
  if (f.kind === 'json') {
    ['{', '  "kit": "paper",', '  "preset": "v8t",', '  "fps": 60', '}'].forEach((l, i) => {
      ctx.fillText(l, 18, 34 + i * 22);
    });
  } else if (f.kind === 'log') {
    ['08:12 render', '08:19 fail', '08:31 retry', '08:44 ?'].forEach((l, i) => {
      ctx.fillText(l, 18, 36 + i * 26);
    });
  } else if (f.kind === 'frame') {
    ctx.fillStyle = 'rgba(80,120,220,0.22)';
    rr(ctx, 14, 14, f.w - 28, f.h - 60, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,210,255,0.55)';
    ctx.fillText('frame 0217', 18, f.h - 18);
  } else if (f.kind === 'gl') {
    ['段型 11 / 复用 3.2', 'L* 41.8', 'hook 0.93'].forEach((l, i) => {
      ctx.fillText(l, 18, 38 + i * 30);
    });
  } else {
    ctx.fillStyle = 'rgba(63,217,160,0.2)';
    rr(ctx, 12, 12, f.w - 24, f.h - 24, 10);
    ctx.fill();
  }
}

/* ───────────────────────────── 镜 2 · GATHER（白） */
/* 左文右卡：文件说"写一句就出片"，右侧五张卡是这条链路的真实产物。 */

function drawGather(ctx, local, globalT) {
  lightBg(ctx, globalT);

  const enter = easeOut(prog(local, 0.0, 0.5));
  /* 左下同心圆涟漪（原片极淡的一层，给纸面一点"活"） */
  ctx.save();
  ctx.globalAlpha = 0.5 * enter;
  ctx.strokeStyle = 'rgba(47,59,232,0.10)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(250, 900, 120 + i * 62 + (local * 18) % 30, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  eyebrow(ctx, local, S.gather.eyebrow[0], S.gather.eyebrow[1], C.blue);

  /* 双色标题：只染后半句 */
  const t1 = easeOut(prog(local, 0.12, 0.5));
  ctx.save();
  ctx.font = '104px "SerifCN", "NotoSC Regular"';
  ctx.fillStyle = C.ink;
  ctx.globalAlpha = t1;
  ctx.fillText(S.gather.title[0], 170, 430 + (1 - t1) * 22);
  ctx.fillStyle = C.blue;
  const t2 = easeOut(prog(local, 0.24, 0.5));
  ctx.globalAlpha = t2;
  ctx.fillText(S.gather.title[1], 170, 545 + (1 - t2) * 22);
  ctx.restore();

  /* 副文案两层：第二层灰、更小位移 —— 层级不靠字号，靠对比度 */
  const s1 = easeOut(prog(local, 0.40, 0.4));
  ctx.save();
  ctx.font = '30px "NotoSC Regular"';
  ctx.fillStyle = 'rgba(17,18,20,0.78)';
  ctx.globalAlpha = s1;
  ctx.fillText(S.gather.sub[0], 170, 640);
  ctx.fillStyle = C.ink3;
  ctx.globalAlpha = easeOut(prog(local, 0.50, 0.4));
  ctx.fillText(S.gather.sub[1] || '', 170, 686);
  ctx.restore();

  /* CTA：实色胶囊，本片唯一的实心按钮 */
  const b = easeOut(prog(local, 0.62, 0.4));
  if (b > 0) {
    ctx.save();
    ctx.globalAlpha = b;
    ctx.translate(170, 740 + (1 - b) * 16);
    ctx.shadowColor = 'rgba(47,59,232,0.34)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = C.blue;
    rr(ctx, 0, 0, 232, 88, 44);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = C.white;
    ctx.font = '30px "NotoSC Medium"';
    ctx.fillText(S.gather.cta, 46, 56);
    ctx.font = '30px "JBMono", "NotoSC Regular"';
    ctx.fillText('→', 176, 56);
    ctx.restore();
  }

  /** 五张卡的槽位：位置/旋转/尺寸都不等，部分重叠。**只放几何，不放文案**。 */
const CARD_SLOTS = [
  { x: 1010, y: 168, w: 336, h: 282, rot: -2.6, at: 0.30, kind: 'story' },
  { x: 1396, y: 148, w: 322, h: 236, rot: 2.1, at: 0.36, kind: 'params' },
  { x: 1076, y: 466, w: 300, h: 196, rot: 1.6, at: 0.44, kind: 'render' },
  { x: 1420, y: 424, w: 300, h: 214, rot: -1.9, at: 0.50, kind: 'gate' },
  { x: 1176, y: 704, w: 430, h: 118, rot: 0.4, at: 0.58, kind: 'stat' },
];

/* 右侧卡片墙：位置/旋转/尺寸都不等，部分重叠 */
  /* 五个槽位是版式；卡里的文字与数值全部来自 params.cards（按顺序对位） */
  const cards = (S.gather.cards || [])
    .slice(0, CARD_SLOTS.length)
    .map((c, i) => ({ ...CARD_SLOTS[i], ...c }));
  for (const c of cards) {
    const e = easeOut(prog(local, c.at, 0.5));
    if (e <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate((1 - e) * 110, 0);
    card(ctx, c.x, c.y, c.w, c.h, c.rot);
    drawCardBody(ctx, c);
    ctx.restore();
  }
}

function drawCardBody(ctx, c) {
  const { w, h, kind } = c;
  const pad = 24;
  if (kind === 'story') {
    pill(ctx, pad, pad, c.pill, C.blue, 16);
    ctx.fillStyle = C.ink;
    ctx.font = '34px "NotoSC Medium"';
    ctx.fillText(c.title, pad, 108);
    ctx.font = '22px "NotoSC Regular"';
    const done = Number.isFinite(c.done) ? c.done : 2;
    (c.items || []).forEach((s, i) => {
      const y = 158 + i * 30;
      const on = i < done;
      ctx.strokeStyle = on ? C.blue : 'rgba(17,18,20,0.22)';
      ctx.lineWidth = 2;
      rr(ctx, pad, y - 13, 16, 16, 4);
      ctx.stroke();
      if (on) {
        ctx.beginPath();
        ctx.moveTo(pad + 3, y - 5);
        ctx.lineTo(pad + 7, y - 1);
        ctx.lineTo(pad + 14, y - 10);
        ctx.stroke();
      }
      ctx.fillStyle = on ? C.ink2 : C.ink3;
      ctx.fillText(s, pad + 26, y);
    });
  } else if (kind === 'params') {
    pill(ctx, pad, pad, c.pill, C.teal, 16);
    ctx.fillStyle = 'rgba(17,18,20,0.82)';
    ctx.font = '19px "JBMono", "NotoSC Regular"';
    (c.lines || []).forEach((l, i) => {
      ctx.fillText(l, pad, 96 + i * 23);
    });
  } else if (kind === 'render') {
    pill(ctx, pad, pad, c.pill, C.blue, 16);
    ctx.fillStyle = C.ink;
    ctx.font = '20px "JBMono", "NotoSC Regular"';
    ctx.fillText(c.label || '', pad, 100);
    ctx.font = '58px "JBMono", "NotoSC Regular"';
    ctx.fillText(String(c.value ?? ''), pad, 156);
    ctx.font = '22px "JBMono", "NotoSC Regular"';
    ctx.fillStyle = C.ink2;
    ctx.fillText(c.unit || '', pad + 128, 164);
    const barFrac = Number.isFinite(c.bar) ? Math.max(0, Math.min(1, c.bar)) : 0.82;
    ctx.fillStyle = 'rgba(47,59,232,0.16)';
    rr(ctx, pad, h - 28, w - pad * 2, 8, 4);
    ctx.fill();
    ctx.fillStyle = C.blue;
    rr(ctx, pad, h - 28, (w - pad * 2) * barFrac, 8, 4);
    ctx.fill();
  } else if (kind === 'gate') {
    pill(ctx, pad, pad, c.pill, C.teal, 16);
    (c.lines || []).forEach((s, i) => {
      const y = 100 + i * 32;
      ctx.fillStyle = C.teal;
      ctx.font = '20px "JBMono", "NotoSC Regular"';
      ctx.fillText('✓', pad, y);
      ctx.fillStyle = C.ink2;
      ctx.font = '21px "JBMono", "NotoSC Regular"';
      ctx.fillText(s, pad + 26, y);
    });
  } else {
    ctx.fillStyle = C.ink;
    ctx.font = '26px "NotoSC Medium"';
    ctx.fillText(c.text || '', pad, 72);
    ctx.fillStyle = C.ink3;
    ctx.font = '19px "NotoSC Regular"';
    ctx.fillText(c.sub || '', pad, 104);
    ctx.fillStyle = C.blueSoft;
    rr(ctx, w - pad - 78, 30, 78, 58, 29);
    ctx.fill();
    ctx.fillStyle = C.blue;
    ctx.font = '27px "JBMono", "NotoSC Regular"';
    ctx.fillText('→', w - pad - 52, 68);
  }
}

/* ───────────────────────────── 镜 3 · RECALL（白，连续演化） */
/* 居中单栏：命令行 + 三条回执。与镜 2 之间没有硬切，是卡片群收拢后的重排。 */

function drawRecall(ctx, local, globalT) {
  lightBg(ctx, globalT);

  /* 上一镜的残影：卡片群向中心收拢并淡出（"收拢成一条命令"的暗示） */
  const fade = 1 - easeOut(prog(local, 0, 0.42));
  if (fade > 0.02) {
    ctx.save();
    ctx.globalAlpha = fade * 0.5;
    for (const c of [
      { x: 1010, y: 168, w: 336, h: 250, rot: -2.6 },
      { x: 1396, y: 148, w: 322, h: 236, rot: 2.1 },
      { x: 1076, y: 466, w: 300, h: 196, rot: 1.6 },
      { x: 1420, y: 424, w: 300, h: 214, rot: -1.9 },
    ]) {
      const k = 1 - 0.24 * (1 - fade);
      const cx = (c.x + c.w / 2 - W / 2) * k + W / 2;
      const cy = (c.y + c.h / 2 - H / 2) * k + H / 2;
      card(ctx, cx - c.w / 2, cy - c.h / 2, c.w, c.h, c.rot * fade, { blur: 24, dy: 8 });
    }
    ctx.restore();
  }

  eyebrow(ctx, local, S.recall.eyebrow[0], S.recall.eyebrow[1], C.blue);

  /* 标题居中 —— 这一镜换信息轴：从横向两栏改成纵向单栏 */
  const e1 = easeOut(prog(local, 0.10, 0.45));
  ctx.save();
  ctx.globalAlpha = e1;
  ctx.font = '96px "SerifCN", "NotoSC Regular"';
  const a = S.recall.title[0];
  const b = S.recall.title[1];
  const wa = ctx.measureText(a).width;
  const wb = ctx.measureText(b).width;
  const total = wa + wb;
  const x0 = (W - total) / 2;
  const y = 300 + (1 - e1) * 20;
  ctx.fillStyle = C.ink;
  ctx.fillText(a, x0, y);
  ctx.fillStyle = C.blue;
  ctx.fillText(b, x0 + wa, y);
  ctx.restore();

  /* 命令行：白底胶囊 + 聚焦描边 + 闪动光标 */
  const e2 = easeOut(prog(local, 0.26, 0.45));
  if (e2 > 0) {
    const bx = 400;
    const by = 388;
    const bw = 1120;
    const bh = 132;
    ctx.save();
    ctx.globalAlpha = e2;
    ctx.translate(0, (1 - e2) * 18);
    ctx.shadowColor = 'rgba(20,26,60,0.12)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 16;
    ctx.fillStyle = C.white;
    rr(ctx, bx, by, bw, bh, 66);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(47,59,232,0.55)';
    ctx.lineWidth = 2.5;
    rr(ctx, bx, by, bw, bh, 66);
    ctx.stroke();

    /* 命令文本 + 光标 */
    ctx.font = '31px "JBMono", "NotoSC Regular"';
    ctx.fillStyle = C.ink;
    const cmd = S.recall.cmd;
    tracked(ctx, cmd, bx + 62, by + 78, 1.2);
    if (Math.floor(local * 2) % 2 === 0) {
      const cw = trackedWidth(ctx, cmd, 1.2);
      ctx.fillStyle = C.blue;
      ctx.fillRect(bx + 66 + cw, by + 50, 3, 42);
    }

    /* Run 按钮 */
    ctx.fillStyle = 'rgba(17,18,20,0.05)';
    rr(ctx, bx + bw - 132, by + 30, 100, 72, 36);
    ctx.fill();
    ctx.fillStyle = C.ink2;
    ctx.font = '26px "JBMono", "NotoSC Regular"';
    ctx.fillText(S.recall.runLabel, bx + bw - 108, by + 76);
    ctx.restore();
  }

  /* 计数行 + 右侧强调色短条 */
  const e3 = easeOut(prog(local, 0.40, 0.4));
  if (e3 > 0) {
    ctx.save();
    ctx.globalAlpha = e3;
    ctx.font = '21px "JBMono", "NotoSC Regular"';
    ctx.fillStyle = C.ink3;
    ctx.fillText(S.recall.count, 400, 566);
    ctx.fillStyle = C.blue;
    ctx.fillRect(1330, 556, 60 * e3, 4);
    ctx.fillStyle = 'rgba(17,18,20,0.12)';
    ctx.fillRect(1390, 557, 130, 2);
    ctx.restore();
  }

  /* 三条回执：逐行进，越往下越淡 —— 用对比度表示"列表还有更多" */
  const rows = S.recall.rows;
  rows.forEach(([title, sub, tag], i) => {
    const e = easeOut(prog(local, 0.44 + i * 0.08, 0.4));
    if (e <= 0.01) return;
    const y = 620 + i * 108;
    const dim = 1 - i * 0.22;
    ctx.save();
    ctx.globalAlpha = e * dim;
    ctx.translate(0, (1 - e) * 16);
    ctx.fillStyle = C.white;
    rr(ctx, 400, y, 1120, 92, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,60,0.07)';
    ctx.lineWidth = 1.5;
    rr(ctx, 400, y, 1120, 92, 18);
    ctx.stroke();

    ctx.fillStyle = C.teal;
    ctx.font = '30px "JBMono", "NotoSC Regular"';
    ctx.fillText('✓', 434, y + 60);

    ctx.fillStyle = C.ink;
    ctx.font = '30px "NotoSC Medium"';
    ctx.fillText(title, 486, y + 46);
    ctx.fillStyle = C.ink3;
    ctx.font = '20px "JBMono", "NotoSC Regular"';
    ctx.fillText(sub, 486, y + 76);

    /* 头一条用实色、其余降饱和 —— 同一字段只靠填充分级 */
    ctx.fillStyle = i === 0 ? C.blue : 'rgba(17,18,20,0.08)';
    rr(ctx, 1380, y + 26, 106, 40, 20);
    ctx.fill();
    ctx.fillStyle = i === 0 ? C.white : C.ink2;
    ctx.font = '19px "JBMono", "NotoSC Regular"';
    const tagW = ctx.measureText(tag).width;
    ctx.fillText(tag, 1380 + (106 - tagW) / 2, y + 52);
    ctx.restore();
  });

  /* 底部渐隐：第 4 行开始被遮住，暗示还有更多 */
  const g = ctx.createLinearGradient(0, H * 0.86, 0, H);
  g.addColorStop(0, 'rgba(243,244,245,0)');
  g.addColorStop(1, 'rgba(243,244,245,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.86, W, H * 0.14);
}

/* ───────────────────────────── 镜 4 · ARRANGE（白，无大字） */
/* 纯图段：一张卡 + 四个标签连着它。上一镜文字密，这一镜靠图换气。 */

/** 四个标签的槽位（x, y, 朝卡方向）。文字来自 params.tags */
const ARR_TAG_SLOTS = [
  { x: 560, y: 300, side: 1 },
  { x: 1330, y: 268, side: -1 },
  { x: 500, y: 700, side: 1 },
  { x: 1330, y: 726, side: -1 },
];

function drawArrange(ctx, local, globalT) {
  lightBg(ctx, globalT);

  /* 中心蓝色辉光 —— 这张卡是全场唯一焦点 */
  const gl = easeOut(prog(local, 0.02, 0.6));
  ctx.save();
  ctx.globalAlpha = gl * 0.85;
  const g = ctx.createRadialGradient(W / 2, H * 0.47, 0, W / 2, H * 0.47, 620);
  g.addColorStop(0, 'rgba(47,59,232,0.16)');
  g.addColorStop(0.5, 'rgba(47,59,232,0.05)');
  g.addColorStop(1, 'rgba(47,59,232,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  /* 中心卡：蓝描边 + 外发光 */
  const e = easeOut(prog(local, 0.04, 0.5));
  const cw = 420;
  const chh = 520;
  const cx = (W - cw) / 2;
  const cy = H / 2 - chh / 2 + 10;
  if (e > 0) {
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(W / 2, cy + chh / 2);
    ctx.scale(lerp(0.94, 1, e), lerp(0.94, 1, e));
    ctx.translate(-W / 2, -(cy + chh / 2));
    ctx.shadowColor = 'rgba(47,59,232,0.24)';
    ctx.shadowBlur = 60;
    ctx.fillStyle = C.white;
    rr(ctx, cx, cy, cw, chh, 26);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(47,59,232,0.62)';
    ctx.lineWidth = 2.5;
    rr(ctx, cx, cy, cw, chh, 26);
    ctx.stroke();

    /* 顶部渐变缩略（"成片"的抽象） */
    const th = 258;
    const tg = ctx.createLinearGradient(cx, cy, cx, cy + th);
    tg.addColorStop(0, '#B9C4F2');
    tg.addColorStop(0.55, '#8A9BE8');
    tg.addColorStop(1, '#6D7FD8');
    ctx.fillStyle = tg;
    ctx.save();
    rr(ctx, cx + 16, cy + 16, cw - 32, th, 18);
    ctx.clip();
    ctx.fillRect(cx + 16, cy + 16, cw - 32, th);
    /* 抽象山形 + 太阳 */
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(cx + cw * 0.66, cy + 92, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.beginPath();
    ctx.moveTo(cx + 16, cy + th + 16);
    ctx.lineTo(cx + 150, cy + 120);
    ctx.lineTo(cx + 250, cy + th + 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.26)';
    ctx.beginPath();
    ctx.moveTo(cx + 190, cy + th + 16);
    ctx.lineTo(cx + 300, cy + 160);
    ctx.lineTo(cx + 400, cy + th + 16);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const cardCfg = S.arrange.card || {};
    pill(ctx, cx + 30, cy + 32, cardCfg.pill || 'FILM', 'rgba(10,14,40,0.82)', 15);

    ctx.fillStyle = C.ink;
    ctx.font = '34px "NotoSC Medium"';
    ctx.fillText(cardCfg.title || '', cx + 26, cy + th + 62);
    ctx.fillStyle = C.ink3;
    ctx.font = '21px "JBMono", "NotoSC Regular"';
    ctx.fillText(cardCfg.sub || '', cx + 26, cy + th + 96);

    /* 两个数据点：一个实色一个降级（同字段不同数值只改饱和度） */
    ctx.fillStyle = C.blue;
    rr(ctx, cx + 26, cy + th + 124, 104, 38, 19);
    ctx.fill();
    ctx.fillStyle = C.white;
    ctx.font = '18px "JBMono", "NotoSC Regular"';
    ctx.fillText((cardCfg.stats || [])[0] || '', cx + 52, cy + th + 149);
    ctx.fillStyle = C.ink3;
    ctx.font = '19px "NotoSC Regular"';
    ctx.fillText((cardCfg.stats || [])[1] || '', cx + 152, cy + th + 150);
    ctx.restore();
  }

  /* 四个标签 → 虚线连到卡边 */
  const arrTags = ARR_TAG_SLOTS.map((slot, i) => ({ ...slot, text: (S.arrange.tags || [])[i] || '' }))
    .filter((t) => t.text);
  arrTags.forEach((tg, i) => {
    const e2 = easeOut(prog(local, 0.22 + i * 0.09, 0.45));
    if (e2 <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = e2;
    ctx.font = '27px "NotoSC Medium"';
    const tw = ctx.measureText(tg.text).width + 56;
    const th2 = 62;
    const tx = tg.x - tw / 2;
    const ty = tg.y - th2 / 2;

    /* 虚线：从标签靠卡的一侧连到卡边 */
    const cEdgeX = tg.side > 0 ? cx : cx + cw;
    const startX = tg.side > 0 ? tx + tw : tx;
    ctx.strokeStyle = 'rgba(47,59,232,0.34)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 9]);
    ctx.beginPath();
    ctx.moveTo(startX, tg.y);
    ctx.lineTo(cEdgeX + (tg.side > 0 ? -8 : 8) * (1 - e2), tg.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = C.white;
    rr(ctx, tx, ty, tw, th2, th2 / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(47,59,232,0.26)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = C.blue;
    ctx.fillText(tg.text, tx + 28, tg.y + 10);

    /* 端点小圆 */
    ctx.fillStyle = C.blue;
    ctx.beginPath();
    ctx.arc(cEdgeX + (tg.side > 0 ? -4 : 4), tg.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  /* 左上 AI 浮层：用产品语气替掉章节标签（原片这一手） */
  const e3 = easeOut(prog(local, 0.30, 0.45));
  if (e3 > 0) {
    ctx.save();
    ctx.globalAlpha = e3;
    star4(ctx, 178, 291, 10, C.teal);
    ctx.fillStyle = C.ink;
    ctx.font = '28px "NotoSC Medium"';
    ctx.fillText((S.arrange.note || [])[0] || '', 202, 200);
    ctx.fillStyle = C.ink3;
    ctx.font = '20px "NotoSC Regular"';
    ctx.fillText((S.arrange.note || [])[1] || '', 202, 234);
    ctx.restore();
  }
}

/* ───────────────────────────── 镜 5 · ROUTE（黑） */
/* 层叠大字 + 玻璃卡片。11.0s 处一次单帧白闪，复刻原片的强调手法。 */

function drawRoute(ctx, local, globalT) {
  darkBg(ctx, globalT);

  /* 白闪（第 330 帧 = 11.0s） */
  const flash = Math.max(0, 1 - Math.abs(local - 1.0) / 0.055);
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(235,245,255,${flash * 0.5})`;
    ctx.fillRect(0, 0, W, H);
  }

  const e0 = easeOut(prog(local, 0.05, 0.3));
  ctx.save();
  ctx.globalAlpha = e0 * 0.9;
  ctx.font = '23px "JBMono", "NotoSC Regular"';
  ctx.fillStyle = C.teal;
  tracked(ctx, `${S.route.eyebrow[0]} · ${S.route.eyebrow[1]}`, 180, 300, 3.4);
  ctx.fillStyle = 'rgba(63,217,160,0.5)';
  ctx.fillRect(180, 322, 46, 2);
  ctx.restore();

  /* 层叠大字：三层重影沿 x 漂移（原片的"快门拖影"在文字上的用法） */
  const e = easeOut(prog(local, 0.10, 0.55));
  if (e > 0) {
    /* 两行：第一行白、第二行强调色；行数由 params 决定，最多两行（版式只有两个基线） */
    const lines = S.route.lines.slice(0, 2).map((text, i) => ({
      text,
      color: i === 0 ? C.white : C.teal,
      y: 520 + i * 130,
    }));
    ctx.save();
    ctx.font = '112px "SerifCN", "NotoSC Regular"';
    for (const [li, ln] of lines.entries()) {
      const le = easeOut(prog(local, 0.10 + li * 0.12, 0.55));
      if (le <= 0) continue;
      for (let i = 3; i >= 1; i--) {
        ctx.globalAlpha = le * (0.10 + (3 - i) * 0.05);
        ctx.fillStyle = i === 3 ? C.blue : ln.color;
        ctx.fillText(ln.text, 180 + i * 16 * (1 - e), ln.y + (1 - le) * 16);
      }
      ctx.globalAlpha = le;
      ctx.fillStyle = ln.color;
      ctx.fillText(ln.text, 180, ln.y + (1 - le) * 16);
    }
    ctx.restore();
  }

  /* 玻璃卡片：半透明 + 细描边 + 内部模糊色块 */
  const g = easeOut(prog(local, 0.26, 0.55));
  if (g > 0) {
    const bx = 1210;
    const by = 330;
    const bw = 470;
    const bh = 470;
    ctx.save();
    ctx.globalAlpha = g * 0.96;
    ctx.translate(W / 2, H / 2);
    ctx.rotate((1.6 * Math.PI) / 180);
    ctx.translate(-W / 2, -H / 2);
    ctx.translate(0, (1 - g) * 30);

    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    rr(ctx, bx, by, bw, bh, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,220,255,0.28)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    /* 内部三行"模糊的列表"：不写具体字，只给块 */
    ['rgba(120,170,255,0.30)', 'rgba(63,217,160,0.26)', 'rgba(190,210,255,0.18)'].forEach((col, i) => {
      const y = by + 74 + i * 92;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      rr(ctx, bx + 34, y, bw - 68, 62, 14);
      ctx.fill();
      ctx.fillStyle = col;
      rr(ctx, bx + 34, y, 6, 62, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,240,255,0.34)';
      rr(ctx, bx + 58, y + 18, (bw - 68) * (0.5 - i * 0.08), 9, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,240,255,0.18)';
      rr(ctx, bx + 58, y + 36, (bw - 68) * 0.3, 8, 4);
      ctx.fill();
    });

    /* 手绘曲线：从右下到左上，带端点 */
    const path = easeInOut(prog(local, 0.42, 0.7));
    if (path > 0) {
      ctx.strokeStyle = C.teal;
      ctx.lineWidth = 3.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const p0 = [bx + 70, by + bh - 90];
      const p1 = [bx + 170, by + bh - 190];
      const p2 = [bx + 280, by + bh - 200];
      const p3 = [bx + bw - 70, by + 120];
      const steps = Math.max(2, Math.floor(path * 60));
      for (let i = 0; i <= steps; i++) {
        const u = (i / 60) * path;
        const x = (1 - u) ** 3 * p0[0] + 3 * (1 - u) ** 2 * u * p1[0] + 3 * (1 - u) * u ** 2 * p2[0] + u ** 3 * p3[0];
        const y = (1 - u) ** 3 * p0[1] + 3 * (1 - u) ** 2 * u * p1[1] + 3 * (1 - u) * u ** 2 * p2[1] + u ** 3 * p3[1];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = C.teal;
      ctx.beginPath();
      ctx.arc(p3[0], p3[1], 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(63,217,160,0.22)';
      ctx.beginPath();
      ctx.arc(p3[0], p3[1], 17, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ───────────────────────────── 镜 6 · LOCKUP（白） */

const DOTS = Array.from({ length: 34 }, (_, i) => {
  const a = i * 2.399963; // 黄金角，散得均匀
  const r = 180 + (i % 11) * 52;
  return {
    x: W / 2 + Math.cos(a) * r * 1.5,
    y: H / 2 + Math.sin(a) * r * 0.95,
    s: 1.6 + (i % 4) * 0.9,
    c: i % 3 === 0 ? C.teal : C.blue,
    d: (i % 7) * 0.06,
  };
});

function drawLockup(ctx, local, globalT) {
  lightBg(ctx, globalT);

  /* 星点：极淡，先出现，给"落版"一点空气感 */
  DOTS.forEach((d) => {
    const e = prog(local, 0.1 + d.d, 0.6);
    if (e <= 0) return;
    ctx.save();
    ctx.globalAlpha = easeOut(e) * 0.3;
    ctx.fillStyle = d.c;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  /* logo 方块 */
  const e0 = easeOut(prog(local, 0.08, 0.5));
  if (e0 > 0) {
    const s = lerp(0.86, 1, e0);
    ctx.save();
    ctx.globalAlpha = e0;
    ctx.translate(W / 2, 330);
    ctx.scale(s, s);
    ctx.shadowColor = 'rgba(47,59,232,0.3)';
    ctx.shadowBlur = 40;
    ctx.fillStyle = C.blue;
    rr(ctx, -46, -46, 92, 92, 24);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    /* 内部：一条上升曲线 + 终点青绿点（"一句话 → 一条片"） */
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-22, 18);
    ctx.bezierCurveTo(-6, 18, -4, -6, 8, -10);
    ctx.bezierCurveTo(16, -13, 18, -16, 22, -22);
    ctx.stroke();
    ctx.fillStyle = C.teal;
    ctx.beginPath();
    ctx.arc(22, -22, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* 品牌字 */
  const e1 = easeOut(prog(local, 0.18, 0.5));
  ctx.save();
  ctx.globalAlpha = e1;
  ctx.font = '86px "SerifCN", "NotoSC Regular"';
  ctx.fillStyle = C.ink;
  const bw = ctx.measureText(S.lockup.name).width;
  ctx.fillText(S.lockup.name, (W - bw) / 2, 490 + (1 - e1) * 14);
  ctx.restore();

  /* slogan：后半句染色，与前面三镜同一规则 */
  const e2 = easeOut(prog(local, 0.30, 0.5));
  ctx.save();
  ctx.globalAlpha = e2;
  ctx.font = '40px "SerifCN", "NotoSC Regular"';
  const p1 = S.lockup.slogan[0];
  const p2 = S.lockup.slogan[1] || '';
  const w1 = ctx.measureText(p1).width;
  const w2 = ctx.measureText(p2).width;
  const sx = (W - w1 - w2) / 2;
  ctx.fillStyle = C.ink;
  ctx.fillText(p1, sx, 572);
  ctx.fillStyle = C.blue;
  ctx.fillText(p2, sx + w1, 572);
  ctx.restore();

  /* CTA */
  const e3 = easeOut(prog(local, 0.44, 0.5));
  if (e3 > 0) {
    ctx.save();
    ctx.globalAlpha = e3;
    ctx.translate(W / 2, 650 + (1 - e3) * 14);
    ctx.shadowColor = 'rgba(47,59,232,0.32)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = C.blue;
    rr(ctx, -150, 0, 300, 84, 42);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = C.white;
    ctx.font = '28px "NotoSC Medium"';
    ctx.fillText(S.lockup.cta, -108, 52);
    ctx.font = '28px "JBMono", "NotoSC Regular"';
    ctx.fillText('→', 74, 52);
    ctx.restore();
  }

  /* 平台清单：中间用 · 分隔，最小字级 */
  const e4 = easeOut(prog(local, 0.58, 0.5));
  if (e4 > 0) {
    ctx.save();
    ctx.globalAlpha = e4 * 0.8;
    ctx.font = '21px "JBMono", "NotoSC Regular"';
    ctx.fillStyle = C.ink3;
    const txt = (S.lockup.platforms || []).join('   ·   ');
    const tw = trackedWidth(ctx, txt, 2.4);
    tracked(ctx, txt, (W - tw) / 2, 820, 2.4);
    ctx.restore();
  }
}

/* ───────────────────────────── 主流程 */

registerFonts();
/* 中文 Didone 等价物：思源宋体 Black。单独注册，不进 src/fonts.mjs ——
   它只服务这支验证片，不该让五支内置 kit 的字体表跟着变。 */
const SERIF = path.join(DIRS.fonts, 'NotoSerifSC-Black.otf');
if (!fs.existsSync(SERIF)) {
  console.error(`FAIL  缺 ${SERIF}\n      下载：curl -L -o assets/fonts/NotoSerifSC-Black.otf \\\n        https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Serif/SubsetOTF/SC/NotoSerifSC-Black.otf`);
  process.exit(2);
}
GlobalFonts.registerFromPath(SERIF, 'SerifCN');

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

/* 必须在字体注册之后跑：否则量到的是回退字体的宽度，校验等于没做 */
validateLayout(P, ctx);

function renderFrame(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  const mix = bgAt(t);
  /* 深底先铺，浅底叠在上面：插值时不会出现中间灰 */
  if (mix < 0.995) {
    darkBg(ctx, t);
    if (mix > 0.005) {
      ctx.save();
      ctx.globalAlpha = mix;
      lightBg(ctx, t);
      ctx.restore();
    }
  } else {
    lightBg(ctx, t);
  }

  /* 只画"当前镜"和"上一镜的收尾"：5.0 / 7.5 两处是交叉演化，不是切点 */
  for (const s of SCENES) {
    const local = t - s.t0;
    if (local < 0 || t > s.t1 + 0.5) continue;
    const isLast = t > s.t1;
    if (isLast && s.id !== 'gather' && s.id !== 'recall') continue;
    if (local > (s.t1 - s.t0) + 0.5) continue;
    s.draw(ctx, Math.min(local, s.t1 - s.t0 + 0.5), t);
  }
}

if (AT !== null) {
  renderFrame(AT);
  /* --at 时 --out 指文件（目录默认值在这里换成单帧文件名） */
  const p = /\.png$/i.test(OUT_DIR) ? OUT_DIR : path.join(OUT_DIR, `frame-${AT.toFixed(2)}.png`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, canvas.toBuffer('image/png'));
  console.log(`✓ ${AT}s → ${p}`);
  process.exit(0);
}

const FRAMES = Math.round(DUR * FPS);
fs.mkdirSync(OUT_DIR, { recursive: true });
const t0 = Date.now();
for (let f = 0; f < FRAMES; f++) {
  renderFrame(f / FPS);
  fs.writeFileSync(path.join(OUT_DIR, `${String(f + 1).padStart(5, '0')}.png`), canvas.toBuffer('image/png'));
  if (f % 60 === 0) process.stdout.write(`\r  渲染 ${f}/${FRAMES}`);
}
process.stdout.write(`\r  渲染 ${FRAMES}/${FRAMES}\n`);
console.log(`✓ ${FRAMES} 帧 → ${OUT_DIR}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
