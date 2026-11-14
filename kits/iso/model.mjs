/**
 * kits/iso/model.mjs · 等轴测爆炸图的几何层（Skia / Canvas2D，无浏览器）
 *
 * 内容模型（与上游 iso-explode-film 的 SPEC 同构，但字段全是声明式 JSON）：
 *   layers  —— 从上到下的装配层；爆炸时按这个顺序逐层抬起
 *   parts   —— 凸块零件（box / cyl / prism），一件一个 {x,y,z,w,d,h,r,material}
 *   arrays  —— 重复件（电芯、芯片、键帽…）按 8 扇区 × 3 圈飞散
 *   hero    —— 特写拆解的核心件：一份 out + 若干 step 子件
 *   mech    —— 机构动作（按压 / 滑移），行程写 travel
 *
 * 为什么零件必须是凸块：画家算法按面心深度排序，两件互相穿插时排不出稳定顺序，
 * 画面会闪。凸块 + 贴面（不重叠）是这套排序成立的前提，也是上游的硬规则。
 *
 * 世界坐标：x 向右、y 朝观察者、z 向上，单位 mm。
 */

const RAD = Math.PI / 180;
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** 默认材质：外壳一主色、内部件 2–3 中性色 + 一个功能色（上游配色规则）。 */
export const DEFAULT_MATERIALS = {
  shell: '#e7e6e0',
  shellDark: '#c6c4bb',
  bracket: '#3b3c42',
  cell: '#2f5fc6',
  cellTop: '#3f74de',
  pcb: '#1e3a2c',
  chip: '#232529',
  steel: '#b7bbc2',
  copper: '#b06a3c',
  pad: '#83868c',
  accent: '#d64b32',
  signal: '#f4f1e4',
  prop: '#dad7cf',
  screw: '#9aa0a8',
};

const hex = (s) => {
  const t = String(s).replace('#', '');
  const n = t.length === 3 ? t.split('').map((c) => c + c).join('') : t;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
};
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rgba = (rgb, a = 1) => `rgba(${rgb.map((v) => Math.round(clamp(v, 0, 255))).join(',')},${a})`;

/** 圆角矩形（CCW，逆时针），半径会被夹到半宽半深。 */
export function roundedRect(cx, cy, w, d, r, steps = 7) {
  const hw = w / 2, hd = d / 2;
  const rad = Math.max(0, Math.min(r, hw, hd));
  const pts = [];
  const corners = [
    [hw - rad, hd - rad, 0],
    [-hw + rad, hd - rad, 90],
    [-hw + rad, -hd + rad, 180],
    [hw - rad, -hd + rad, 270],
  ];
  for (const [x, y, a0] of corners) {
    const n = rad > 0 ? steps : 1;
    for (let i = 0; i <= n; i++) {
      const a = (a0 + (rad > 0 ? (90 * i) / n : 45)) * RAD;
      pts.push([cx + x + rad * Math.cos(a), cy + y + rad * Math.sin(a)]);
    }
  }
  return pts;
}

/** 圆（CCW）。 */
export function circle(cx, cy, r, seg = 28) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (360 * i) / seg * RAD;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** 由 CCW 平面多边形 + 高度生成棱柱的面。底面朝下、侧面外法线。 */
function prismFaces(pts2, z0, z1, material) {
  const k = pts2.length;
  const faces = [];
  faces.push({ pts: pts2.map(([x, y]) => [x, y, z1]), n: [0, 0, 1], material, top: true });
  faces.push({ pts: [...pts2].reverse().map(([x, y]) => [x, y, z0]), n: [0, 0, -1], material, top: false });
  for (let i = 0; i < k; i++) {
    const [x1, y1] = pts2[i];
    const [x2, y2] = pts2[(i + 1) % k];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    // CCW 多边形的外法线是 (dy, -dx)
    faces.push({
      pts: [[x1, y1, z0], [x2, y2, z0], [x2, y2, z1], [x1, y1, z1]],
      n: [dy / len, -dx / len, 0],
      material,
      top: false,
    });
  }
  return faces;
}

/** 一件零件的面集。kind 决定截面：box（圆角矩形）/ cyl / prism（自定义凸多边形）。 */
function buildFaces(spec) {
  const z0 = Number(spec.z) || 0;
  const h = Number(spec.h) || 1;
  const z1 = z0 + h;
  const kind = spec.kind || 'box';
  if (kind === 'cyl') {
    const pts = circle(Number(spec.x) || 0, Number(spec.y) || 0, Number(spec.r) || 5, Number(spec.seg) || 26);
    return prismFaces(pts, z0, z1, spec.material);
  }
  if (kind === 'prism') {
    const pts = (spec.pts || []).map(([x, y]) => [x, y]);
    if (pts.length < 3) throw new Error(`iso: prism ${spec.id} 需要 pts（≥3 个点）`);
    return prismFaces(pts, z0, z1, spec.material);
  }
  const pts = roundedRect(
    Number(spec.x) || 0,
    Number(spec.y) || 0,
    Number(spec.w) || 10,
    Number(spec.d) || 10,
    Number(spec.r) || 0,
    Number(spec.roundSteps) || 6,
  );
  return prismFaces(pts, z0, z1, spec.material);
}

/**
 * @param {object} content params.content
 * @returns {{layers, parts, faces, arrays, hero, mechs, bounds, radius, materials, staticParts}}
 */
export function createModel(content = {}) {
  const materials = { ...DEFAULT_MATERIALS, ...(content.materials || {}) };
  const palette = {};
  for (const [k, v] of Object.entries(materials)) palette[k] = hex(v);

  const layers = (content.layers || []).map((l, i) => ({ ...l, index: i }));
  if (!layers.length) throw new Error('iso: content.layers 为空——先定装配层（从上到下）');
  const NL = layers.length;
  const radius = Number(content.radius) || 120;
  const mats = { ...palette };
  const liftH = 0.15 * radius;

  const travelOf = (i) => {
    const L = layers[i];
    if (L.travel !== undefined) return Number(L.travel);
    if (i === NL - 1) return -0.07 * radius;
    return radius * (0.1 + 1.3 * Math.pow((NL - 1 - i) / Math.max(1, NL - 1), 1.1));
  };

  const arrays = {};
  for (const a of content.arrays || []) arrays[a.id] = { ...a };
  const hero = content.hero ? { pull: 20, hover: 10, steps: [], size: 20, ...content.hero } : null;
  const mechs = (content.mech || []).map((m) => ({ dir: [0, 0, -1], travel: 1.5, ...m }));

  const parts = [];
  const faces = [];
  const used = new Set();
  for (const spec of content.parts || []) {
    if (!spec.id) throw new Error('iso: 零件缺 id');
    if (used.has(spec.id)) throw new Error(`iso: 零件 id 重复：${spec.id}`);
    used.add(spec.id);
    const li = layers.findIndex((l) => l.id === spec.layer);
    if (li < 0) throw new Error(`iso: 零件 ${spec.id} 的 layer=${spec.layer} 不在 layers 里`);
    if (!palette[spec.material]) throw new Error(`iso: 零件 ${spec.id} 的 material=${spec.material} 未定义`);

    const part = {
      ...spec,
      layer: li,
      layerId: layers[li].id,
      index: parts.length,
      material: spec.material,
      color: palette[spec.material],
      travel: travelOf(li),
      static: !!spec.static,
    };
    const pf = buildFaces(spec);
    for (const f of pf) {
      f.part = part.index;
      f.color = palette[f.material] || part.color;
      // 面心，用于排序与阴影
      const c = [0, 0, 0];
      for (const p of f.pts) { c[0] += p[0] / f.pts.length; c[1] += p[1] / f.pts.length; c[2] += p[2] / f.pts.length; }
      f.c = c;
    }
    part.faces = faces.length;
    part.faceCount = pf.length;
    // 零件包围盒与中心（特写取景、标注锚点都用它）
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const f of pf) for (const p of f.pts) {
      bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]);
      by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]);
      bz0 = Math.min(bz0, p[2]); bz1 = Math.max(bz1, p[2]);
    }
    part.bbox = [[bx0, bx1], [by0, by1], [bz0, bz1]];
    part.center = [(bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2];
    faces.push(...pf);
    parts.push(part);
  }

  // 阵列归组：按相对阵列中心的角度分 8 扇区、距离分 3 圈（上游同口径）
  for (const part of parts) {
    if (!part.array) continue;
    const a = arrays[part.array];
    if (!a) throw new Error(`iso: 零件 ${part.id} 引用了不存在的 array ${part.array}`);
    const cx = a.cx || 0, cy = a.cy || 0;
    const dx = (part.x || 0) - cx, dy = (part.y || 0) - cy;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
    const sector = Math.floor(((ang + 180) % 360) / 45) % 8;
    const dist = Math.hypot(dx, dy);
    // rings 是「圈间距（mm）」，不是圈数：不写就全算第 0 圈（两件电芯这种小阵列本来就一圈）
    const ring = a.rings ? Math.min(2, Math.floor(dist / a.rings)) : 0;
    part.arrayInfo = { id: part.array, sector, ring, dir: dist > 1e-6 ? [dx / dist, dy / dist] : [0, 1] };
    a.count = (a.count || 0) + 1;
  }

  // 阵列中心与半宽：不写就按成员零件的重心与最远边缘推（镜头取景用）
  for (const [id, a] of Object.entries(arrays)) {
    const els = parts.filter((p) => p.arrayInfo && p.arrayInfo.id === id);
    if (!els.length) throw new Error(`iso: array ${id} 没有任何零件引用`);
    if (a.cx === undefined) a.cx = els.reduce((s, p) => s + p.center[0], 0) / els.length;
    if (a.cy === undefined) a.cy = els.reduce((s, p) => s + p.center[1], 0) / els.length;
    a.hx = Math.max(...els.map((p) => Math.abs(p.center[0] - a.cx) + (p.bbox[0][1] - p.bbox[0][0]) / 2));
    a.hy = Math.max(...els.map((p) => Math.abs(p.center[1] - a.cy) + (p.bbox[1][1] - p.bbox[1][0]) / 2));
    a.ringCount = Math.max(...els.map((p) => p.arrayInfo.ring)) + 1;
  }

  const bounds = content.bounds || (() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const f of faces) for (const p of f.pts) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
    }
    return [[x0, x1], [y0, y1], [z0, z1]];
  })();

  // 核心件悬空时，阴影要落在它下面那一层（顶壳）上，而不是桌面
  const heroIds = new Set(parts.filter((p) => p.hero !== undefined).map((p) => p.id));
  const heroBaseZ = Math.max(...parts.filter((p) => !heroIds.has(p.id)).map((p) => p.bbox[2][1]));

  return { layers, parts, faces, arrays, hero, mechs, bounds, radius, palette, mats, liftH, travelOf, content, heroBaseZ };
}

/**
 * 通道 → 每件零件的位移（mm）。
 * 通道：lift（离台 0–1）、ex（层展开 0–NL）、burst（每阵列 0–1）、pull / split / hover / act
 */
export function partOffset(model, part, S) {
  if (part.static) return [0, 0, 0];
  let dx = 0, dy = 0, dz = 0;
  if (!S) return [dx, dy, dz];

  const exLocal = clamp((S.ex ?? 0) - part.layer, 0, 1);
  dz += (S.lift ?? 0) * model.liftH + exLocal * part.travel;

  if (part.arrayInfo) {
    const a = model.arrays[part.arrayInfo.id];
    const rise = a.rise ?? 0.4 * model.radius;
    const spread = a.spread ?? 0.6;
    const raw = clamp((S.burst?.[a.id] ?? 0) - part.arrayInfo.ring * 0.14, 0, 1);
    const e = easeIO(raw);
    const ringScale = 1 + part.arrayInfo.ring * 0.32;
    dx += part.arrayInfo.dir[0] * rise * spread * e * ringScale;
    dy += part.arrayInfo.dir[1] * rise * spread * e * ringScale;
    dz += rise * e * (0.7 + 0.3 * part.arrayInfo.ring) * ringScale;
  }

  if (model.hero && part.hero !== undefined) {
    const h = model.hero;
    if (part.hero === 'out') {
      dz += (S.pull ?? 0) * h.pull - (S.hover ?? 0) * h.hover;
    } else {
      const i = Number(part.hero);
      dz += (S.pull ?? 0) * h.pull + clamp((S.split ?? 0) - i, 0, 1) * (h.steps[i] || 0);
      dz -= (S.hover ?? 0) * h.hover;
    }
  }

  if (part.mech !== undefined && model.mechs[part.mech]) {
    const m = model.mechs[part.mech];
    dx += (S.act ?? 0) * m.travel * m.dir[0];
    dy += (S.act ?? 0) * m.travel * m.dir[1];
    dz += (S.act ?? 0) * m.travel * m.dir[2];
  }
  return [dx, dy, dz];
}

/** 相机基向量：把世界点投到屏幕（含针孔透视，近距离特写才有广告感）。 */
export function makeCamera({ yaw, pitch, roll = 0, zoom, panX = 0, panY = 0, focus = [0, 0, 0], W, H, radius, distance }) {
  const a = yaw * RAD, e = pitch * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(e), se = Math.sin(e);
  const k = (zoom * H) / (2.2 * radius);
  const D = distance || 9 * radius;
  let right = [ca, sa, 0];
  let up = [-sa * se, ca * se, ce];
  const dir = [sa * ce, -ca * ce, se]; // 指向观察者
  if (roll) {
    // 荷兰角：绕视线轴转屏幕基向量（right/up 仍正交，dir 不变）
    const cr = Math.cos(roll * RAD), sr = Math.sin(roll * RAD);
    const r2 = [right[0] * cr + up[0] * sr, right[1] * cr + up[1] * sr, right[2] * cr + up[2] * sr];
    const u2 = [-right[0] * sr + up[0] * cr, -right[1] * sr + up[1] * cr, -right[2] * sr + up[2] * cr];
    right = r2;
    up = u2;
  }
  return {
    k, D, right, up, dir, panX, panY, focus, W, H,
    project(p) {
      const q = [p[0] - focus[0], p[1] - focus[1], p[2] - focus[2]];
      const depth = q[0] * dir[0] + q[1] * dir[1] + q[2] * dir[2];
      const persp = D / Math.max(D * 0.25, D - depth);
      const sx = q[0] * right[0] + q[1] * right[1] + q[2] * right[2];
      const sy = q[0] * up[0] + q[1] * up[1] + q[2] * up[2];
      return [W / 2 + panX + sx * k * persp, H / 2 + panY - sy * k * persp, depth];
    },
    /** 只算深度（排序用） */
    depth(p) {
      const q = [p[0] - focus[0], p[1] - focus[1], p[2] - focus[2]];
      return q[0] * dir[0] + q[1] * dir[1] + q[2] * dir[2];
    },
  };
}

/** 面法线是否朝向观察者（背面剔除）。 */
export const facing = (n, cam) => n[0] * cam.dir[0] + n[1] * cam.dir[1] + n[2] * cam.dir[2] > 0;

/**
 * 零件级绘制顺序（画家算法）。
 *
 * 为什么不能只按面心深度排：顶壳是一块 152×74 的大板，面心深度会被 x/y 拉低，
 * 结果"电芯画在顶壳上面"——实测第一版就是这个错。上游用「两两之间的分离平面」
 * 预算遮挡顺序，本质是同一个问题。
 *
 * 这里对每对零件做分离轴测试：只要在某个轴上完全分开，就由该轴决定谁在前；
 * 三个轴都重叠（AABB 互穿）时才退回深度。得到一张偏序图后拓扑排序。
 * 30 件零件 435 对，每帧算一次在 60fps 下可忽略。
 */
export function orderParts(model, S, cam) {
  const n = model.parts.length;
  const boxes = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = model.parts[i];
    const off = partOffset(model, p, S);
    const b = p.bbox;
    boxes[i] = [b[0][0] + off[0], b[0][1] + off[0], b[1][0] + off[1], b[1][1] + off[1], b[2][0] + off[2], b[2][1] + off[2]];
  }
  const d = cam.dir;
  const next = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  const add = (before, after) => { next[before].push(after); indeg[after]++; };
  const depthOf = (i) => cam.depth(centerOf(boxes[i]));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = boxes[i], B = boxes[j];
      let vote = 0; // 1 = i 在前面，-1 = j 在前面，2 = 两个轴给出相反结论
      let separated = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-6) continue;
        const amin = A[a * 2], amax = A[a * 2 + 1];
        const bmin = B[a * 2], bmax = B[a * 2 + 1];
        let v = 0;
        if (amax <= bmin + 1e-6) v = d[a] < 0 ? 1 : -1; // i 在坐标更小的一侧
        else if (bmax <= amin + 1e-6) v = d[a] < 0 ? -1 : 1;
        else continue; // 该轴重叠
        separated = true;
        if (!vote) vote = v;
        else if (vote !== v) vote = 2;
      }
      if (vote === 1) add(j, i);
      else if (vote === -1) add(i, j);
      // vote === 2（两轴结论相反）或 AABB 互穿：不建边。
      // 互穿时按深度补边会把距离差当顺序，环就是这么来的（32 条边被违反）；
      // 互穿本身是内容错误（上游的硬规则就是零件不许穿插），排序器不该替它擦屁股。
    }
  }

  // 拓扑排序 + 环兜底：队列空了还有剩，就挑"最远"的那件强制出队（只在环内可能错序）
  const indegLeft = indeg.slice();
  const queue = [];
  for (let i = 0; i < n; i++) if (!indegLeft[i]) queue.push(i);
  const order = [];
  const done = new Array(n).fill(false);
  while (order.length < n) {
    if (!queue.length) {
      let pick = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        const dpt = depthOf(i);
        if (dpt < best) { best = dpt; pick = i; }
      }
      if (pick < 0) break;
      queue.push(pick);
    }
    const i = queue.shift();
    if (done[i]) continue;
    done[i] = true;
    order.push(i);
    for (const j of next[i]) if (!done[j]) {
      indegLeft[j]--;
      if (indegLeft[j] <= 0) queue.push(j);
    }
  }

  if (process.env.ISO_DEBUG_ORDER) {
    const pos = new Map(order.map((v, k) => [v, k]));
    const bad = [];
    for (let a = 0; a < n; a++) for (const b of next[a]) if (pos.get(a) > pos.get(b)) bad.push(`${model.parts[a].id}->${model.parts[b].id}`);
    if (bad.length) console.error('[iso] 违反偏序的边：', bad.slice(0, 10).join(' '), '共', bad.length);
    const ids = order.map((i) => `${model.parts[i].id}(${depthOf(i).toFixed(0)})`);
    console.error(`[iso] order n=${n} ordered=${order.length}\n  ${ids.join(' > ')}`);
  }
  return order;
}

const centerOf = (b) => [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];

