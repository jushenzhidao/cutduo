/**
 * kits/iso/plan.mjs · 分镜 → 通道关键帧 + 机位 + 字卡 + 层标注窗口
 *
 * 八种镜头（与上游 storyboard 同构）：
 *   hero / rise / explode / part / action / array / stack / assemble / end
 *
 * 三条从上游继承的硬规则（不是审美，是"不炸"的条件）：
 *   1. 每个镜头开头先把全部通道钉住（hold），否则上一镜的残值会在镜间缓慢漂移。
 *   2. 收拢先收阵列、再合层；展开先分层、再飞散。反过来会让下落的层砸进还没收回的阵列。
 *   3. 换镜不硬切，用 0.25–0.3 s 的甩镜（五次方缓动）；停留时镜头仍缓慢漂移，只有最后半秒静止。
 *
 * 机位不手抄预设：每个镜头按"这一镜要拍的主体"（整机 / 核心件 / 某个阵列 / 某一层）
 * 在当时的通道状态下求包围盒，反算 zoom 与 pan。手抄的 zoom 一换产品就不成立，
 * 而且核心件被 pull 抬走后会直接顶出画面（实测两轮）。
 */
import { clamp, makeCamera, partOffset } from './model.mjs';

const ease = {
  lin: (x) => x,
  io: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  o: (x) => 1 - Math.pow(1 - x, 3),
  i: (x) => x * x * x,
  whip: (x) => (x < 0.5 ? 16 * Math.pow(x, 5) : 1 - Math.pow(-2 * x + 2, 5) / 2),
};

const CHANNELS = ['lift', 'ex', 'pull', 'split', 'hover', 'act'];

function sampleTrack(track, t, fallback = 0) {
  if (!track || !track.length) return fallback;
  if (t <= track[0].t) return track[0].v;
  for (let i = 1; i < track.length; i++) {
    const b = track[i];
    if (t <= b.t) {
      const a = track[i - 1];
      const span = b.t - a.t;
      const u = span <= 1e-9 ? 1 : clamp((t - a.t) / span, 0, 1);
      const e = (ease[b.ease] || ease.io)(u);
      return a.v + (b.v - a.v) * e;
    }
  }
  return track[track.length - 1].v;
}

function sampleCam(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b.t) {
      const a = keys[i - 1];
      const span = b.t - a.t;
      const u = span <= 1e-9 ? 1 : clamp((t - a.t) / span, 0, 1);
      const e = (ease[b.ease] || ease.io)(u);
      const L = (p, q) => p + (q - p) * e;
      return {
        yaw: L(a.yaw, b.yaw), pitch: L(a.pitch, b.pitch), zoom: L(a.zoom, b.zoom),
        panX: L(a.panX, b.panX), panY: L(a.panY, b.panY),
        focus: [L(a.focus[0], b.focus[0]), L(a.focus[1], b.focus[1]), L(a.focus[2], b.focus[2])],
      };
    }
  }
  return keys[keys.length - 1];
}

/** 字卡位置（1920×1080 基准，与上游同一套）：普通左上、爆炸左中、收尾左下。 */
const CARD_POS = { top: [130, 150], mid: [130, 380], end: [120, 790] };

export function buildPlan({ scenes = [], content = {}, model, W = 1920, H = 1080, types = [] }) {
  const R = model.radius;
  const NL = model.layers.length;

  const tracks = {};
  const K = (name, t, v, ease = 'io') => {
    (tracks[name] ||= []).push({ t, v, ease });
  };
  const burstK = (id, t, v, ease = 'io') => K(`burst:${id}`, t, v, ease);
  const val = (name, t) => sampleTrack(tracks[name], t, 0);
  const poseAt = (t) => {
    const S = { lift: 0, ex: 0, pull: 0, split: 0, hover: 0, act: 0, burst: {} };
    for (const c of CHANNELS) S[c] = val(c, t);
    for (const id of Object.keys(model.arrays)) S.burst[id] = val(`burst:${id}`, t);
    return S;
  };

  const heroIds = new Set(model.parts.filter((p) => p.hero !== undefined).map((p) => p.id));
  const heroParts = model.parts.filter((p) => heroIds.has(p.id));
  const solid = model.parts.filter((p) => !p.static);
  const byArray = (id) => model.parts.filter((p) => p.arrayInfo?.id === id);
  const byLayer = (id) => model.parts.filter((p) => p.layerId === id && !p.static);

  const camKeys = [];
  const camK = (t, target, ease = 'io') => camKeys.push({ t, ...target, ease });
  const camCur = (t) => sampleCam(camKeys, t);

  /**
   * 按主体包围盒反算机位。
   * fill = 主体占画面的比例（0.5 表示留一半空气）。
   */
  function fitCam({ parts, S, yaw, pitch, aim = [0.56, 0.5], fill = 0.62 }) {
    if (!parts.length) throw new Error('iso: fitCam 收到空主体');
    const offs = parts.map((p) => partOffset(model, p, S));
    const c = [0, 0, 0];
    parts.forEach((p, i) => {
      c[0] += (p.center[0] + offs[i][0]) / parts.length;
      c[1] += (p.center[1] + offs[i][1]) / parts.length;
      c[2] += (p.center[2] + offs[i][2]) / parts.length;
    });

    /** 在给定 zoom 下量主体包围盒（针孔透视不是线性的，必须实测而不是按比例缩放） */
    const measure = (zoom) => {
      const cam = makeCamera({ yaw, pitch, zoom, panX: 0, panY: 0, focus: c, W, H, radius: R });
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      parts.forEach((p, i) => {
        const b = p.bbox;
        for (const x of [b[0][0], b[0][1]]) for (const y of [b[1][0], b[1][1]]) for (const z of [b[2][0], b[2][1]]) {
          const [sx, sy] = cam.project([x + offs[i][0], y + offs[i][1], z + offs[i][2]]);
          x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
          y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
      });
      return { cam, bw: Math.max(8, x1 - x0), bh: Math.max(8, y1 - y0), mx: (x0 + x1) / 2, my: (y0 + y1) / 2 };
    };

    // 两遍：第一遍定 zoom 量级，第二遍在真实 zoom 下复测（近处零件会被透视放大）
    let zoom = 1;
    for (let pass = 0; pass < 2; pass++) {
      const m = measure(zoom);
      zoom *= Math.min((fill * W) / m.bw, (fill * H) / m.bh);
    }
    const m = measure(zoom);
    // 主体占满 fill 时，画面中心只能落在 [半宽, W−半宽] 内
    const halfW = (m.bw) / 2 + 20;
    const halfH = (m.bh) / 2 + 20;
    const cx = Math.min(Math.max(aim[0] * W, halfW), Math.max(halfW, W - halfW));
    const cy = Math.min(Math.max(aim[1] * H, halfH), Math.max(halfH, H - halfH));
    return { yaw, pitch, zoom, panX: cx - m.mx, panY: cy - m.my, focus: c };
  }

  /** 甩镜：起点钉在当前机位，0.26 s 后到目标。 */
  const whipTo = (t, target, dur = 0.26) => {
    const cur = camCur(Math.max(0, t - 1e-4));
    if (cur) camK(t - 1e-3, { ...cur }, 'lin');
    camK(t + dur, target, 'whip');
  };
  const drift = (base, dyaw = 4, dzoom = 0.035) => ({ ...base, yaw: base.yaw + dyaw, zoom: base.zoom * (1 + dzoom) });
  /** 末尾静止：最后 0.45 s 机位不动。落位还在漂的镜头会被 pacing 的 hold 判据抓住。 */
  const settle = (tEnd, cam) => {
    camK(Math.max(0, tEnd - 0.8), cam, 'io');
    camK(tEnd, { ...cam }, 'lin');
  };

  const cards = [];
  const addCard = (t0, t1, card, pos = 'top') => {
    if (!card || !card.big) return;
    const [x, y] = card.x != null ? [card.x, card.y] : CARD_POS[pos];
    cards.push({
      t0, t1, x, y,
      big: String(card.big).replace('{parts}', String(model.parts.length)),
      small: String(card.small || '').replace('{parts}', String(model.parts.length)),
      align: card.align || 'left',
    });
  };

  const pin = (t) => {
    for (const c of CHANNELS) K(c, t, val(c, t), 'lin');
    for (const id of Object.keys(model.arrays)) burstK(id, t, val(`burst:${id}`, t), 'lin');
  };

  const heroLift = (S) => {
    if (!model.hero) return 0;
    const steps = model.hero.steps || [];
    return (S.lift || 0) * model.liftH
      + (S.pull || 0) * model.hero.pull
      + clamp(S.split || 0, 0, 1) * (steps[0] || 0);
  };

  let labelsWindow = null;
  const heroWins = [];
  /** 近摄镜头（特写/阵列/夹层）只让主体保持实色，其余零件降到 13% 幽灵 */
  const subjectWins = [];
  const exTime = (t0, dur, v) => t0 + 0.25 + (v / NL) * (0.62 * dur);

  const YAW = { hero: -27, wide: -20, part: -34, action: -57, array: -46, stack: -60 };
  const PITCH = { hero: 46, wide: 25, part: 20, action: 12, array: 19, stack: 11 };

  const firstCam = fitCam({ parts: solid, S: poseAt(0), yaw: YAW.hero, pitch: PITCH.hero, aim: [0.54, 0.5], fill: 0.6 });
  camK(0, { ...firstCam, zoom: firstCam.zoom * 0.965, yaw: firstCam.yaw - 2 }, 'lin');

  for (const scene of scenes) {
    const t0 = Number(scene.t0) || 0;
    const t1 = Number(scene.t1) || t0 + 3;
    const d = t1 - t0;
    const type = scene.type || 'hero';
    const args = scene.args || {};
    pin(t0);

    if (type === 'hero') {
      K('lift', t0 + 0.01, 0);
      K('ex', t0 + 0.01, 0);
      const target = fitCam({ parts: solid, S: poseAt(t1), yaw: YAW.hero, pitch: PITCH.hero, aim: [0.54, 0.5], fill: 0.6 });
      // 开场要有可见的运动：只推 3% 时 gate 的 hook 判 0.02（几乎静止），观众也读不出镜头在走
      if (t0 > 0.01) whipTo(t0, target);
      else camK(t0 + 0.02, { ...target, zoom: target.zoom * 0.94, yaw: target.yaw - 3 }, 'io');
      settle(t1, drift(target, 5, 0.08));
      if (args.intro === 'act') {
        const p0 = t0 + 0.45;
        for (let i = 0; i < 2; i++) {
          K('act', p0 + i * 0.9, 1, 'o');
          K('act', p0 + i * 0.9 + 0.28, 0, 'io');
        }
      }
    } else if (type === 'rise') {
      K('lift', t0 + 0.05, 0, 'io');
      K('lift', t0 + Math.min(d - 1.0, 0.9), 1, 'io');
      const from = fitCam({ parts: solid, S: poseAt(t0 + 0.02), yaw: YAW.wide, pitch: PITCH.wide, aim: [0.56, 0.5], fill: 0.66 });
      const to = fitCam({ parts: solid, S: poseAt(t1), yaw: YAW.wide, pitch: PITCH.wide, aim: [0.56, 0.5], fill: 0.66 });
      camK(t0, from, 'lin');
      settle(t1, to);
    } else if (type === 'explode') {
      K('lift', t0 + 0.02, 1, 'lin');
      K('ex', t0 + 0.25, 0, 'io');
      K('ex', t0 + 0.25 + 0.58 * d, NL, 'io');
      let stagger = 0;
      for (const [id, a] of Object.entries(model.arrays)) {
        const li = model.layers.findIndex((l) => l.id === a.layer);
        const at = exTime(t0, d, Math.max(0.55, li + 0.55)) + stagger * 0.18;
        burstK(id, at, 0, 'io');
        burstK(id, at + Math.min(0.75, 0.35 * d), 1, 'io');
        stagger++;
      }
      // 分层是一个持续过程：机位跟着"当下已经张开多少"走，只给末状态取景会让
      // 前三分之一的时间用一个远景拍一堆还挤在一起的层（实测主体只占画面 1/4）。
      const target = fitCam({ parts: solid, S: poseAt(t1 - 0.02), yaw: YAW.wide, pitch: PITCH.wide, aim: [0.58, 0.5], fill: 0.66 });
      const midA = fitCam({ parts: solid, S: poseAt(t0 + 0.7 * d), yaw: YAW.wide, pitch: PITCH.wide, aim: [0.56, 0.5], fill: 0.66 });
      whipTo(t0, midA, 0.3);
      camK(t0 + 0.72 * d, midA, 'io');
      K('ex', t0 + 0.25 + 0.58 * d, NL, 'io');
      settle(t1, drift(target, 4, 0.025));
      labelsWindow = { t0: t0 + 0.45 * d, t1 };
      addCard(t0 + 0.35, t1 - 0.08, args.card, 'mid');
    } else if (type === 'part') {
      for (const id of Object.keys(model.arrays)) {
        burstK(id, t0 + 0.02, val(`burst:${id}`, t0), 'lin');
        burstK(id, t0 + 0.16, 0, 'o');
      }
      K('ex', t0 + 0.02, val('ex', t0), 'lin');
      K('ex', t0 + 0.2, 0, 'io');
      K('pull', t0 + 0.34, 0, 'lin');
      K('pull', t0 + Math.min(d - 0.05, 0.86), 1, 'io');
      const steps = model.hero?.steps || [];
      if (steps.length) {
        K('split', t0 + 0.6, 0, 'lin');
        K('split', t0 + Math.min(d - 0.03, 0.6 + 0.42 * steps.length), steps.length, 'io');
      }
      const target = fitCam({ parts: heroParts, S: poseAt(t1 - 0.02), yaw: YAW.part, pitch: PITCH.part, aim: [0.54, 0.5], fill: 0.62 });
      whipTo(t0 + 0.16, target, 0.2);
      settle(t1, { ...target, yaw: target.yaw - 3, zoom: target.zoom * 1.02 });
      addCard(t0 + 0.3, t1 - 0.06, args.card, 'top');
      heroWins.push({ t0, t1, ref: heroLift(poseAt(t1 - 0.02)) });
      subjectWins.push({ t0, t1, ids: heroParts.map((x) => x.id) });
    } else if (type === 'action') {
      const steps = model.hero?.steps || [];
      K('split', t0 + 0.02, val('split', t0), 'lin');
      K('split', t0 + 0.2, 0, 'io');
      K('hover', t0 + 0.3, 0, 'io');
      K('hover', t0 + 0.62, 1, 'io');
      const p0 = t0 + 0.72, gap = Math.max(0.26, Math.min(0.4, (d - 0.8) / 3));
      for (let i = 0; i < 3; i++) {
        const depth = 0.7 + i * 0.15;
        K('act', p0 + i * gap, 0, 'lin');
        K('act', p0 + i * gap + gap * 0.45, Math.min(1, depth), 'o');
        if (i < 2) K('act', p0 + i * gap + gap * 0.85, 0, 'io');
      }
      K('act', t1 - 0.55, 1, 'io');
      const target = fitCam({ parts: heroParts, S: poseAt(t1 - 0.02), yaw: YAW.action, pitch: PITCH.action, aim: [0.54, 0.52], fill: 0.6 });
      whipTo(t0 + 0.06, target, 0.18);
      settle(t1, { ...target, yaw: target.yaw - 2 });
      addCard(t0 + 0.25, t1 - 0.06, args.card, 'top');
      heroWins.push({ t0, t1, ref: heroLift(poseAt(t1 - 0.02)) });
      subjectWins.push({ t0, t1, ids: heroParts.map((x) => x.id) });
    } else if (type === 'array') {
      const id = args.array || Object.keys(model.arrays)[0];
      const a = model.arrays[id];
      K('pull', t0 + 0.02, val('pull', t0), 'lin');
      K('pull', t0 + 0.18, 0, 'o');
      K('split', t0 + 0.02, val('split', t0), 'lin');
      K('split', t0 + 0.18, 0, 'o');
      K('hover', t0 + 0.02, val('hover', t0), 'lin');
      K('hover', t0 + 0.18, 0, 'o');
      K('act', t0 + 0.02, val('act', t0), 'lin');
      K('act', t0 + 0.18, 0, 'o');
      if (a) {
        const li = model.layers.findIndex((l) => l.id === a.layer);
        K('ex', t0 + 0.02, val('ex', t0), 'lin');
        K('ex', t0 + 0.34, clamp(li + 1, 1, NL), 'io');
        burstK(id, t0 + 0.02, 0, 'lin');
        burstK(id, t0 + 0.34, 0, 'lin');
        burstK(id, t0 + Math.min(d - 0.05, 0.34 + 0.55 * d), 1, 'io');
      }
      // 取景必须按「落定后的 yaw」算：先 fit 再漂移 8°，长边投影会变宽、右边被切（实测两轮）
      const yawEnd = YAW.array + 8;
      const target = fitCam({ parts: byLayer(a.layer), S: poseAt(t1 - 0.02), yaw: yawEnd, pitch: PITCH.array, aim: [0.58, 0.52], fill: 0.78 });
      const early = fitCam({ parts: byLayer(a.layer), S: poseAt(t0 + 0.3), yaw: yawEnd + 16, pitch: PITCH.array, aim: [0.58, 0.52], fill: 0.78 });
      whipTo(t0 + 0.05, early, 0.2);
      camK(t0 + Math.min(d - 0.15, 0.34 + 0.55 * d), target, 'io');
      settle(t1, target);
      addCard(t0 + 0.3, t1 - 0.06, args.card, 'top');
      // 阵列镜头保留「它所在那一层」作上下文，只把其它层淡出
      subjectWins.push({ t0, t1, ids: byLayer(a.layer).map((x) => x.id) });
    } else if (type === 'stack') {
      const layerId = args.layer || content.stackLayer || model.layers[Math.min(2, NL - 1)].id;
      const li = model.layers.findIndex((l) => l.id === layerId);
      K('ex', t0 + 0.02, val('ex', t0), 'lin');
      K('ex', t0 + 0.34, clamp(li + 1.6, 1, NL), 'io');
      const yawEnd = YAW.stack + 8;
      const target = fitCam({ parts: byLayer(layerId), S: poseAt(t1 - 0.02), yaw: yawEnd, pitch: PITCH.stack, aim: [0.58, 0.5], fill: 0.56 });
      const early = fitCam({ parts: byLayer(layerId), S: poseAt(t0 + 0.25), yaw: YAW.stack, pitch: PITCH.stack, aim: [0.58, 0.5], fill: 0.56 });
      whipTo(t0 + 0.05, early, 0.2);
      camK(t0 + 0.5 * d, target, 'io');
      settle(t1, target);
      addCard(t0 + 0.32, t1 - 0.06, args.card, 'top');
      subjectWins.push({ t0, t1, ids: byLayer(layerId).map((x) => x.id) });
    } else if (type === 'assemble') {
      const exploded = fitCam({ parts: solid, S: poseAt(t0 + 0.02), yaw: YAW.wide, pitch: PITCH.wide, aim: [0.58, 0.5], fill: 0.66 });
      whipTo(t0, exploded, 0.24);
      K('ex', t0 + 0.05, val('ex', t0), 'lin');
      K('ex', t0 + 0.05 + 0.55 * d, 0, 'io');
      for (const id of Object.keys(model.arrays)) {
        burstK(id, t0 + 0.05, val(`burst:${id}`, t0), 'lin');
        burstK(id, t0 + 0.05 + 0.25 * d, 0, 'io');
      }
      K('lift', t0 + 0.55 * d, 1, 'lin');
      K('lift', t0 + 0.8 * d, 0, 'io');
      // 中间机位跟着塌到一半的堆栈，末段才回产品机位
      const mid = fitCam({ parts: solid, S: poseAt(t0 + 0.55 * d), yaw: YAW.wide, pitch: PITCH.wide, aim: [0.56, 0.5], fill: 0.66 });
      camK(t0 + 0.5 * d, mid, 'io');
      const hero = fitCam({ parts: solid, S: poseAt(t1), yaw: YAW.hero, pitch: PITCH.hero, aim: [0.54, 0.5], fill: 0.6 });
      settle(t1, hero);
      labelsWindow = { t0: t0 + 0.05, t1: t0 + 0.3 * d };
    } else if (type === 'end') {
      K('lift', t0 + 0.01, 0);
      K('ex', t0 + 0.01, 0);
      for (const id of Object.keys(model.arrays)) burstK(id, t0 + 0.01, 0);
      const target = fitCam({ parts: solid, S: poseAt(t1), yaw: YAW.hero, pitch: PITCH.hero, aim: [0.5, 0.48], fill: 0.58 });
      whipTo(t0, target);
      camK(t1 - 0.5, drift(target, 1.4, 0.012), 'io');
      camK(t1, drift(target, 1.4, 0.012), 'lin');
      addCard(t0 + 0.1, t1, args.card, 'end');
    } else {
      const list = types.length ? types.join('/') : 'hero/rise/explode/part/action/array/stack/assemble/end';
      throw new Error(`iso: 未知镜头类型 ${type}（可用 ${list}）`);
    }
  }

  // whipTo 会先插一个 t−1e-3 的起点键，键序可能倒退；采样按数组顺序走，
  // 不排序会读到"未来"的键，镜头卡在两个机位之间（实测 zoom 停在 7.8 而不是 9.5）。
  camKeys.sort((a, b) => a.t - b.t);
  for (const k of Object.keys(tracks)) tracks[k].sort((a, b) => a.t - b.t);

  const duration = scenes.length ? Number(scenes[scenes.length - 1].t1) : 0;

  return {
    duration,
    labelsWindow,
    sample(t) {
      const S = { lift: 0, ex: 0, pull: 0, split: 0, hover: 0, act: 0, burst: {} };
      for (const c of CHANNELS) S[c] = val(c, t);
      for (const id of Object.keys(model.arrays)) S.burst[id] = val(`burst:${id}`, t);

      const cam = { ...sampleCam(camKeys, t) };
      const win = heroWins.find((w) => t >= w.t0 && t <= w.t1);
      if (win) {
        // 只补「当前 − 取景时」的差值：取景本身已按末状态算过，重复加会把主体顶出画面
        cam.focus = [cam.focus[0], cam.focus[1], cam.focus[2] + (heroLift(S) - win.ref)];
      }

      const live = cards
        .filter((c) => t >= c.t0 && t <= c.t1)
        .map((c) => {
          const inA = clamp((t - c.t0) / 0.35, 0, 1);
          const outA = clamp((c.t1 - t) / 0.18, 0, 1);
          return { ...c, a: Math.min(inA, outA), rise: (1 - ease.o(inA)) * 18 };
        });

      const showLabels = labelsWindow && t >= labelsWindow.t0 && t <= labelsWindow.t1;
      const sw = subjectWins.find((w) => t >= w.t0 && t <= w.t1);
      return { t, cam, S, cards: live, labels: showLabels, heroWindow: !!win, subject: sw ? new Set(sw.ids) : null, model };
    },
    _tracks: tracks,
    _cams: camKeys,
  };
}
