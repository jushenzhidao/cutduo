/**
 * kits/iso/iso.mjs · 等轴测爆炸大片（iso-explode-film 蒸馏版）
 *
 * 上游是「HTML/SVG 逐帧截图 + Python 透视合成」：Chrome 一帧一截，再回灌 OpenCV 做
 * 透视、运动模糊与字卡。本实现把整条链压进 Skia Canvas2D：投影、凸块面、画家排序、
 * 明暗、桌面、阴影、字卡、层标注都在一个 ctx 里画完，不经过浏览器，也不落中间帧。
 *
 * 保留上游的内容模型（几乎逐字段同构）：
 *   layers / parts / arrays / hero / mech + 八种镜头
 * 丢掉上游的实现假设：
 *   · SVG 分组 + 逐姿态预算遮挡顺序 —— 改成面级深度排序（凸块 + 贴面成立）
 *   · 屏幕空间透视单应 —— 改成投影时直接做针孔除法
 *   · 代码合成配乐 —— 交给本仓 params.audio / tools/audio-bed.mjs
 *
 *   const r = createIsoRenderer({ ctx, width, height, fps });
 *   r.setContent({ scenes, content });
 *   r.renderFrame(3.2);
 */
import { createCanvas } from '@napi-rs/canvas';
import { createModel, makeCamera, partOffset, facing, orderParts, clamp, rgba } from './model.mjs';
import { buildPlan } from './plan.mjs';

/**
 * 九种镜头。放在渲染器文件里是有意的：tools/check-kit-contract.mjs 只扫渲染器源码，
 * 段型常量写在 plan.mjs 里它提取不到，会把 EASE / LOOK 的键当成段型（实测 7 种假段型）。
 */
export const SCENE_TYPES = ['hero', 'rise', 'explode', 'layer', 'part', 'action', 'array', 'stack', 'assemble', 'orbit', 'end'];

const FONT = {
  big: 'NotoSC Regular',
  mid: 'NotoSC Medium',
  mono: 'JBMono',
  monoMed: 'JBMonoMedium',
};

/** 4 级明暗（上游 SHADES=4）：把连续光照量化成硬边，才有"等轴测工具图"的味道。 */
const SHADE_LEVELS = [0.6, 0.74, 0.88, 1.0];
const LIGHT = (() => {
  const v = [-0.42, 0.48, 0.82];
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
})();

const looks = {
  split: {
    wall: ['#fbfbf9', '#ecebe8'],
    ink: [24, 24, 27],
    sub: [96, 94, 98],
    line: [40, 38, 40, 0.32],
    card: [24, 24, 27],
    rim: null,
    tone: 1,
  },
  dark: {
    wall: ['#0a0b10', '#06070a'],
    ink: [246, 244, 238],
    sub: [206, 202, 194],
    line: [210, 220, 255, 0.3],
    card: [246, 244, 238],
    rim: [198, 214, 255, 0.22],
    // 深色底上白色外壳会顶到纯白、看着像没过色调映射；整体压 18%，亮边交给 rim
    tone: 0.82,
  },
};

/** 凸多边形按半平面裁剪（桌面分色用）。keep: a*x + b*y <= c */
function clipHalf(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] - c;
    const dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const u = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u]);
    }
  }
  return out;
}

export function createIsoRenderer(opts = {}) {
  const ctx = opts.ctx;
  if (!ctx) throw new Error('createIsoRenderer: ctx is required');
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const fps = opts.fps || 60;

  let model = null;
  let plan = null;
  let lookName = 'split';
  let look = looks.split;
  let title = 'PRODUCT';

  function setContent(c = {}) {
    const content = c.content || {};
    model = createModel(content);
    plan = buildPlan({ scenes: c.scenes || [], content, model, W, H, types: SCENE_TYPES });
    // 同一套动画出两版配色：上游也是这么做的（process.env.ISO_LOOK）。
    // 环境变量优先，其次 params.content.look，默认橙色桌面版。
    const envLook = process.env.ISO_LOOK;
    lookName = envLook === 'dark' || envLook === 'split' ? envLook : (content.look === 'dark' ? 'dark' : 'split');
    look = looks[lookName];
    title = content.title || content.name || 'PRODUCT';
    return { parts: model.parts.length, layers: model.layers.length };
  }

  // ---------------- 背景 ----------------

  function drawBackdrop() {
    const g = ctx.createLinearGradient(0, 0, W * 0.75, H);
    g.addColorStop(0, look.wall[0]);
    g.addColorStop(1, look.wall[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (lookName === 'dark') {
      const glows = [
        [0.16, 0.1, 0.55, [58, 148, 132], 0.24],
        [0.86, 0.2, 0.5, [74, 82, 176], 0.2],
        [0.2, 0.92, 0.55, [92, 54, 118], 0.18],
        [0.52, 0.42, 0.42, [255, 255, 255], 0.055],
      ];
      for (const [x, y, r, rgb, a] of glows) {
        const rad = Math.max(W, H) * r;
        const rg = ctx.createRadialGradient(W * x, H * y, 0, W * x, H * y, rad);
        rg.addColorStop(0, rgba(rgb, a));
        rg.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }

    // 桌面分色：屏幕空间的一条斜线（左灰右橙）。
    // 早先按世界 x=常量 投一条线，结果是「近水平」而不是「近竖直」——世界上沿 y 的线
    // 在 yaw −30° 附近投出来是斜的，而且特写下远端会落到相机背后把橙色铺满整帧。
    // 这块只是摄影棚背景，不必有三维含义，直接给一条屏幕斜线最稳（字卡永远在灰侧）。
    const lx = W * 0.58;
    const tilt = W * 0.07;
    const p1 = [lx + tilt, -40];
    const p2 = [lx - tilt, H + 40];
    let dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    let nx = -dy, ny = dx;
    if (nx < 0) { nx = -nx; ny = -ny; }
    const E = 4000;
    const poly = [
      [p1[0] - dx * E, p1[1] - dy * E],
      [p2[0] + dx * E, p2[1] + dy * E],
      [p2[0] + dx * E + nx * E, p2[1] + dy * E + ny * E],
      [p1[0] - dx * E + nx * E, p1[1] - dy * E + ny * E],
    ];
    const og = ctx.createLinearGradient(lx - tilt, 0, W, H);
    og.addColorStop(0, '#f68a5c');
    og.addColorStop(0.55, '#e86840');
    og.addColorStop(1, '#c94a2d');
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = og;
    ctx.fill();
    // 地面在下缘压一点暗，画面才不是一块平色
    const floor = ctx.createLinearGradient(0, H * 0.55, 0, H);
    floor.addColorStop(0, 'rgba(60,30,15,0)');
    floor.addColorStop(1, 'rgba(60,30,15,0.10)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, H * 0.55, W, H * 0.45);
  }

  /** 核心件特写：在它下面那一层的表面上落一块软阴影，否则零件像浮在空中。 */
  function drawHeroShadow(state) {
    if (!state.heroWindow || lookName !== 'split') return;
    const cam = currentCam;
    const part = model.hero?.part ? model.parts.find((p) => p.id === model.hero.part) : null;
    if (!part) return;
    const z = model.heroBaseZ + (state.S.lift || 0) * model.liftH + 0.2;
    const [cx, cy] = cam.project([part.center[0], part.center[1], z]);
    const k = cam.k;
    const rx = Math.max(40, model.hero.size * 2.6 * k);
    const ry = rx * 0.34;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    rg.addColorStop(0, 'rgba(70,44,28,0.20)');
    rg.addColorStop(0.6, 'rgba(70,44,28,0.09)');
    rg.addColorStop(1, 'rgba(70,44,28,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 物体在桌面上的软阴影：屏幕空间椭圆 + 径向渐变（比 3D 投影便宜且稳）。 */
  function drawShadow() {
    if (lookName !== 'split') return;
    const cam = currentCam;
    const zb = model.bounds[2][0];
    const [cx, cy] = cam.project([0, 0, zb - 0.6]);
    const k = cam.k;
    const rx = 1.15 * model.radius * k;
    const ry = rx * Math.max(0.12, Math.sin((cam.pitchAngle || 30) * Math.PI / 180) * 0.5);
    ctx.save();
    ctx.translate(cx, cy + ry * 0.15);
    ctx.scale(1, ry / rx);
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    rg.addColorStop(0, 'rgba(74,46,30,0.30)');
    rg.addColorStop(0.55, 'rgba(74,46,30,0.16)');
    rg.addColorStop(1, 'rgba(74,46,30,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------------- 物体 ----------------

  let currentCam = null;
  let blurCanvas = null, blurCtx = null, subCanvas = null, subCtx = null;

  function shadeColor(base, n) {
    const lam = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    let idx = Math.min(3, Math.floor(lam * 4));
    // 侧面比 top 稍暗一档，避免大面积同色读不出转折
    if (n[2] < 0.5) idx = Math.max(0, idx - 1);
    const f = SHADE_LEVELS[idx] * (look.tone || 1);
    return [base[0] * f, base[1] * f, base[2] * f];
  }

  function drawObject(state, alphaMul = 1, target = ctx) {
    const cam = currentCam;
    const { S } = state;
    // 先定零件级顺序（分离轴 + 拓扑），再在零件内部按面深度画。
    // 凸块自身不遮挡自己，背面剔除后剩下的面怎么排都对。
    const order = orderParts(model, S, cam);
    const subject = state.subject || null;
    const list = [];
    for (const pi of order) {
      const part = model.parts[pi];
      const off = partOffset(model, part, S);
      const local = [];
      for (let fi = 0; fi < part.faceCount; fi++) {
        const f = model.faces[part.faces + fi];
        if (!facing(f.n, cam)) continue;
        const c = [f.c[0] + off[0], f.c[1] + off[1], f.c[2] + off[2]];
        local.push({ f, off, depth: cam.depth(c) });
      }
      local.sort((a, b) => a.depth - b.depth);
      for (const it of local) { it.isSubject = subject ? subject.has(part.id) : false; it.ghost = subject ? !it.isSubject : false; }
      list.push(...local);
    }

    target.lineJoin = 'round';
    for (const item of list) {
      const { f, off } = item;
      target.globalAlpha = (item.ghost ? 0.08 : 1) * alphaMul;
      const pts = f.pts;
      target.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = cam.project([pts[i][0] + off[0], pts[i][1] + off[1], pts[i][2] + off[2]]);
        if (i === 0) target.moveTo(p[0], p[1]); else target.lineTo(p[0], p[1]);
      }
      target.closePath();
      const col = shadeColor(f.color, f.n);
      target.fillStyle = rgba(col);
      target.fill();
      // 同色描边盖住相邻面的抗锯齿缝（细到看不出是描边）
      target.strokeStyle = rgba(col);
      target.lineWidth = 0.8;
      target.stroke();
      if (look.rim && !item.ghost) {
        target.strokeStyle = rgba(look.rim);
        target.lineWidth = 0.7;
        target.stroke();
      }
      // 单层展示：主体描一圈亮边。黑玻璃、电芯这类深色件在深底上只有轮廓可读，
      // 不描边就只剩"更黑的一块"（24 层片的屏幕/电池两镜实测）
      if (item.isSubject) {
        target.strokeStyle = 'rgba(214,228,255,0.45)';
        target.lineWidth = 1.1;
        target.stroke();
      }
    }
    target.globalAlpha = 1;
  }

  // ---------------- 层标注 ----------------

  function layerAnchors(state) {
    const { S } = state;
    const out = [];
    for (const layer of model.layers) {
      const parts = model.parts.filter((p) => p.layer === layer.index);
      if (!parts.length) continue;
      // 层的实际位移 = 通道位移 + 该层零件（含阵列飞散）的平均抬升。
      // 只算通道时，电芯这种飞散的层标注会低 40–90 mm，指到空气里。
      let dzSum = 0;
      for (const p of parts) dzSum += partOffset(model, p, S)[2];
      const dz = dzSum / parts.length;
      // 锚点取「左缘 + 中层高」：层的左上角投影后常常离开零件轮廓，
      // 指向的是空气（实测电芯那条线钉在支架上）。
      let x0 = Infinity, y0 = 0, z0 = 0, z1 = 0, n = 0;
      for (const p of parts) {
        x0 = Math.min(x0, p.bbox[0][0]);
        y0 += (p.bbox[1][0] + p.bbox[1][1]) / 2;
        z0 += p.bbox[2][0];
        z1 += p.bbox[2][1];
        n++;
      }
      out.push({ layer, point: [x0 - 2, y0 / n, (z0 + z1) / (2 * n) + dz], dz, index: layer.index });
    }
    return out;
  }

  function drawLabels(state) {
    if (!state.labels) return;
    const cam = currentCam;
    const anchors = layerAnchors(state).map((a) => {
      const [x, y] = cam.project(a.point);
      const alpha = clamp((state.S.ex || 0) - a.index - 0.55, 0, 1);
      return { ...a, sx: x, sy: y, alpha };
    }).filter((a) => a.alpha > 0.01);
    if (!anchors.length) return;

    anchors.sort((a, b) => a.sy - b.sy);
    const colX = W * 0.795;
    let cursor = Math.max(H * 0.22, anchors[0].sy - 18);
    for (const a of anchors) {
      a.ty = Math.max(a.sy, cursor);
      cursor = a.ty + 46;
    }

    for (const a of anchors) {
      const al = a.alpha;
      ctx.save();
      ctx.globalAlpha = al;
      ctx.strokeStyle = rgba(look.line);
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(a.sx, a.sy, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = rgba(look.ink, 0.9);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(a.sx + 6, a.sy);
      ctx.lineTo(colX - 16, a.ty);
      ctx.lineTo(colX, a.ty);
      ctx.stroke();
      // 中文层名 + 英文小字（上游同一套：Regular 32 / Light 15）
      ctx.fillStyle = rgba(look.ink, 0.94);
      ctx.font = `30px "${FONT.mid}"`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(a.layer.zh || a.layer.id, colX + 10, a.ty - 2);
      if (a.layer.en) {
        ctx.fillStyle = rgba(look.sub, 0.9);
        ctx.font = `12px "${FONT.mono}"`;
        ctx.fillText(tracked(a.layer.en.toUpperCase(), 2.4), colX + 10, a.ty + 18);
      }
      ctx.restore();
    }
  }

  // ---------------- 字卡 ----------------

  function tracked(s, sp) {
    // Canvas2D 的 letterSpacing 在部分宿主不生效，自己插空格（只用于等宽西文）
    return sp > 0 ? s.split('').join('\u2009') : s;
  }

  function drawCards(state, t) {
    for (const c of state.cards) {
      ctx.save();
      ctx.globalAlpha = c.a;
      const x = c.x;
      const y = c.y + c.rise;
      const big = c.big || '';
      const size = [...big].length <= 4 ? 132 : 104;
      ctx.fillStyle = rgba(look.card);
      ctx.font = `300 ${size}px "${FONT.big}"`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(big, x, y + size * 0.78);
      if (c.small) {
        ctx.fillStyle = rgba(look.sub);
        ctx.font = `26px "${FONT.mid}"`;
        ctx.fillText(c.small, x + 3, y + size * 0.78 + 46);
      }
      ctx.restore();
    }
  }

  // ---------------- 图版标记 ----------------

  function drawPlate() {
    const m = 54;
    const len = 26;
    ctx.save();
    ctx.strokeStyle = rgba(look.ink, 0.28);
    ctx.lineWidth = 1;
    const corners = [
      [m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x, y + sy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + sx * len, y);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(look.sub, 0.85);
    ctx.font = `12px "${FONT.mono}"`;
    ctx.fillText('FIG. 01', m + 4, m + 26);
    const right = `ANATOMY · ${title}`;
    ctx.textAlign = 'right';
    ctx.fillText(right, W - m - 4, m + 26);
    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.46, Math.min(W, H) * 0.28, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, lookName === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(40,30,20,0.10)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---------------- 帧 ----------------

  function renderFrame(t) {
    if (!plan) throw new Error('iso: 先 setContent()');
    const state = plan.sample(t);
    const camState = state.cam;
    const radius = model.radius;
    const distance = clamp((9 * radius * 2.2) / Math.max(1, camState.zoom), 2.6 * radius, 9 * radius);
    const cam = makeCamera({
      ...camState, yaw: camState.yaw, pitch: camState.pitch,
      W, H, radius, distance,
    });
    cam.pitchAngle = camState.pitch;
    currentCam = cam;

    ctx.save();
    drawBackdrop();
    drawShadow();
    drawHeroShadow(state);
    // 运动模糊：转场期间往回采 4 个样本，越旧越淡，最后再画当前帧。
    // 单帧只多画 3 次物体（36 件 / 886 面），只发生在 0.2–0.3 s 的转场窗口里。
    if (state.blur > 0.15) {
      // 真运动模糊：每个子帧先单独画成一张不透明的离屏图，再按 1/N 加性叠到累加图上。
      // 直接在主画布叠半透明残影只会得到"重影边"；直接在一张图上叠子帧会因同帧多面叠加而过曝。
      const n = 8;
      const shutter = 0.8 / fps;
      if (!blurCanvas) {
        blurCanvas = createCanvas(W, H);
        blurCtx = blurCanvas.getContext('2d');
        subCanvas = createCanvas(W, H);
        subCtx = subCanvas.getContext('2d');
      }
      blurCtx.setTransform(1, 0, 0, 1, 0, 0);
      blurCtx.globalCompositeOperation = 'source-over';
      blurCtx.globalAlpha = 1;
      blurCtx.clearRect(0, 0, W, H);
      for (let i = 0; i < n; i++) {
        const s2 = plan.sample(Math.max(0, t - (shutter * i) / n));
        const cam2 = makeCamera({ ...s2.cam, W, H, radius, distance: clamp((9 * radius * 2.2) / Math.max(1, s2.cam.zoom), 2.6 * radius, 9 * radius) });
        cam2.pitchAngle = s2.cam.pitch;
        const keep = currentCam;
        currentCam = cam2;
        subCtx.setTransform(1, 0, 0, 1, 0, 0);
        subCtx.globalCompositeOperation = 'source-over';
        subCtx.globalAlpha = 1;
        subCtx.clearRect(0, 0, W, H);
        drawObject(s2, 1, subCtx);
        currentCam = keep;
        blurCtx.globalCompositeOperation = 'lighter';
        blurCtx.globalAlpha = 1 / n;
        blurCtx.drawImage(subCanvas, 0, 0);
      }
      blurCtx.globalAlpha = 1;
      ctx.globalAlpha = 1;
      ctx.drawImage(blurCanvas, 0, 0);
    } else {
      drawObject(state);
    }
    drawLabels(state);
    drawVignette();
    drawCards(state, t);
    drawPlate();
    ctx.restore();
  }

  return { setContent, renderFrame, get model() { return model; }, get plan() { return plan; } };
}

export { createModel } from './model.mjs';
