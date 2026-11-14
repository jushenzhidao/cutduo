/**
 * kits/diagram/families.mjs · 13 类图示的绘制器
 *
 * 本批实现 4 类（data-bar / data-line / hierarchy / cycle），覆盖「数据」与「关系」两个
 * 现有 kit 缺失的表达。其余 9 类留在 TODO 列表里，等这 4 类的版式手感确认后再补 ——
 * 一次性写 13 类只会得到 13 个半成品。
 *
 * 每个 draw(ctx, recipe, progress, box, env) 的契约：
 *   recipe   —— 内容（family 决定字段，见 catalog.mjs）
 *   progress —— 0..1 的段内进度，函数自己决定谁先出场
 *   box      —— 可用矩形，所有几何都相对它算，不写死绝对坐标
 *   env      —— { palette, fonts }
 * 返回 state：{ bounds[], revealed, capacity }，门禁与调试都吃这个。
 */

import {
  CapacityError,
  activeIndex,
  badge,
  clamp,
  drawGrid,
  drawRule,
  easeOutCubic,
  easeOutQuint,
  elbow,
  fitText,
  fmtNum,
  measure,
  niceStep,
  stagger,
  wrapWithin,
} from './layout.mjs';
import { CAPACITY } from './tokens.mjs';

/* ──────────────────────────── data-bar ──────────────────────────── */

/**
 * 横向条形比较。为什么横条不竖柱：我们的片子是 16:9，标签是中文词组（4–8 字），
 * 竖柱要把标签斜排或缩写；横条把标签放左边、数值放右边，一个字都不用改。
 */
export function drawDataBar(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY['data-bar'];
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `data-bar 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }

  const raw = items.map((it) => Number(it.value));
  if (raw.some((v) => !Number.isFinite(v))) {
    throw new CapacityError('DIAGRAM_VALUE', 'data-bar 的 value 必须是数字');
  }
  // 条形图没有零轴中线，负值画不出来。归零但要留痕，别静默改数。
  const notes = raw.some((v) => v < 0) ? [`负值已按 0 处理：${raw.filter((v) => v < 0).join(', ')}`] : [];
  const vals = raw.map((v) => Math.max(0, v));
  const maxV = Math.max(...vals, 1);
  const unit = r.unit ?? items.find((it) => it.unit)?.unit ?? '';

  const labelW = Math.min(300, Math.max(150, box.width * 0.22));
  const axisX = box.x + labelW;
  const maxBarW = box.width - labelW - 150;
  // 数值列对齐在"最长条末端 + 24"，不是版心右缘 —— 否则短条的数字要跨半个屏幕去对
  const valueX = axisX + maxBarW + 24;

  const top0 = box.y + 108;
  const rowGap = 18;
  // 行高上限 190：老预设 8 条时是 71（不受影响），20 秒片只有 3 条时
  // 不该缩在顶部 1/3 里 —— 600px 的留白看着像没加载完。
  const rowH = Math.min(190, (box.height - (top0 - box.y) - 56 - rowGap * (items.length - 1)) / items.length);
  const blockH = rowH * items.length + rowGap * (items.length - 1);
  const top = top0 + Math.max(0, (box.height - (top0 - box.y) - 56 - blockH) / 2);
  // 条高与字号跟着行高走：行高 190 配 26px 的细条，读起来像进度条不像数据
  const barH = Math.max(14, Math.min(56, rowH * 0.28));
  const labelSize = Math.round(clamp(rowH * 0.3, 26, 52));
  const valueSize = Math.round(clamp(rowH * 0.26, 26, 44));

  if (unit) {
    ctx.save();
    ctx.font = `${env.frame.unitSize}px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`单位 / unit：${unit}`, box.x, box.y + 64);
    ctx.restore();
  }

  const baselineTop = top - 10;
  const baselineBottom = top + rowH * items.length + rowGap * (items.length - 1) + 4;

  ctx.save();
  ctx.strokeStyle = palette.ink;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(axisX + 0.5, baselineTop);
  ctx.lineTo(axisX + 0.5, baselineBottom);
  ctx.stroke();
  ctx.restore();

  const bounds = [];
  let revealed = 0;

  const act = env.active(p, items.length);
  items.forEach((it, i) => {
    const y = top + i * (rowH + rowGap);
    const q = env.reveal(p, i, items.length, 0.12); // 条与数值：念到那个数才长
    const qRow = env.rowReveal(p, i, items.length, 0.12); // 行标签：念到名字就先立住
    const emph = it.emphasis === true;
    const isActive = i === act;
    const barAlpha = isActive ? 1 : i < act ? 0.66 : 0.36;

    // 正在讲的那一条：左侧一根短线 + 条不降透明度。没有这个，条长完就静止，
    // 观众听到"第三条"时图上没有任何指向。
    if (isActive && q > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette.accent;
      ctx.fillRect(axisX - 16, y + rowH / 2 - 22, 4, 44);
      ctx.restore();
    }

    const labelFit = fitText(ctx, it.label ?? it.id ?? '', labelW - 28, fonts.black, {
      start: labelSize,
      min: Math.max(18, labelSize - 14),
      maxLines: 2,
    });
    if (labelFit.overflow && labelFit.lines.length > 2) {
      throw new CapacityError('DIAGRAM_CAPACITY', `data-bar 标签超长：${it.label}`);
    }
    ctx.save();
    ctx.font = `${labelFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelY = y + rowH / 2 - ((labelFit.lines.length - 1) * labelFit.size * 1.2) / 2;
    labelFit.lines.forEach((ln, k) => {
      ctx.globalAlpha = clamp(qRow * 1.6);
      ctx.fillText(ln, box.x, labelY + k * labelFit.size * 1.2);
    });
    ctx.restore();

    const fullW = (vals[i] / maxV) * maxBarW;
    const w = fullW * easeOutQuint(q);
    if (w > 0.5) {
      ctx.save();
      ctx.globalAlpha = barAlpha * (emph ? 1 : 0.94);
      ctx.fillStyle = palette.accent;
      ctx.fillRect(axisX + 6, y + (rowH - barH) / 2, w, barH);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = easeOutCubic(clamp((q - 0.45) / 0.55));
    ctx.font = `${isActive || emph ? valueSize + 4 : valueSize}px ${fonts.med}`;
    ctx.fillStyle = isActive ? palette.accent : palette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtNum(raw[i]), valueX, y + rowH / 2);
    ctx.restore();

    if (q > 0.05) revealed++;
    bounds.push({ x: axisX + 6, y: y + (rowH - barH) / 2, width: Math.max(w, 1), height: barH });
  });

  return { bounds, revealed, capacity: items.length, notes };
}

/* ──────────────────────────── data-line ──────────────────────────── */

/**
 * 折线序列。横轴按真实 x 间距排（不是等距）—— 等距会让「第 3 次和第 5 次」
 * 看起来一样远，读者会读错趋势。
 */
export function drawDataLine(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY['data-line'];
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `data-line 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }

  const unit = r.unit ?? items.find((it) => it.unit)?.unit ?? '';
  const xs = items.map((it, i) => (Number.isFinite(Number(it.x)) ? Number(it.x) : i));
  const ys = items.map((it) => Number(it.value));
  if (ys.some((v) => !Number.isFinite(v))) {
    throw new CapacityError('DIAGRAM_VALUE', 'data-line 的 value 必须是数字');
  }

  const padL = 120;
  const padR = 64;
  const padT = 108;
  const padB = 96;
  const plot = {
    x: box.x + padL,
    y: box.y + padT,
    width: box.width - padL - padR,
    height: box.height - padT - padB,
  };

  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMax = Math.max(...ys, 1);
  const yMin = Math.min(...ys, 0); // 有负值时零轴要在中间，不能贴底
  const span = Math.max(1e-6, yMax - yMin);
  const yTop = yMax + span * 0.08; // 顶留 8%，不让峰值贴边
  const yBot = yMin < 0 ? yMin - span * 0.08 : 0;

  const px = (v) => plot.x + ((v - x0) / Math.max(1e-6, x1 - x0)) * plot.width;
  const py = (v) => plot.y + plot.height - ((v - yBot) / Math.max(1e-6, yTop - yBot)) * plot.height;

  // 刻度用「整步长」而不是点值：读者要的是 5/10/15 这种参考线，不是 8.5
  const step = niceStep(yTop - yBot, 4);
  const ticks = [];
  for (let v = Math.ceil(yBot / step) * step; v <= yTop + 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);

  if (unit) {
    ctx.save();
    ctx.font = `${env.frame.unitSize}px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`单位 / unit：${unit}`, box.x, box.y + 64);
    ctx.restore();
  }

  // 横向参考线取代方格：方格不服务读数，参考线才对应刻度
  ctx.save();
  ctx.lineWidth = 1;
  ticks.forEach((v) => {
    const y = py(v);
    if (y < plot.y - 1 || y > plot.y + plot.height + 1) return;
    ctx.strokeStyle = palette.rule;
    ctx.globalAlpha = v === 0 ? 0.5 : 0.34;
    ctx.beginPath();
    ctx.moveTo(plot.x, y + 0.5);
    ctx.lineTo(plot.x + plot.width, y + 0.5);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.font = `${env.frame.unitSize}px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtNum(v), plot.x - 14, y);
  });
  ctx.restore();

  // Y 轴与 X 轴
  ctx.save();
  ctx.strokeStyle = palette.ink;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(plot.x + 0.5, plot.y - 6);
  ctx.lineTo(plot.x + 0.5, py(yBot));
  ctx.lineTo(plot.x + plot.width, py(yBot));
  ctx.stroke();
  ctx.restore();

  // 折线：按进度裁到第 k 段
  const n = items.length;
  const segTotal = n - 1;
  const travelled = easeOutCubic(clamp(p / 0.5)) * segTotal;
  ctx.save();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px(xs[0]), py(ys[0]));
  for (let i = 1; i < n; i++) {
    if (travelled <= i) {
      const f = clamp(travelled - (i - 1));
      const ax = px(xs[i - 1]);
      const ay = py(ys[i - 1]);
      const bx = px(xs[i]);
      const by = py(ys[i]);
      ctx.lineTo(ax + (bx - ax) * f, ay + (by - ay) * f);
      break;
    }
    ctx.lineTo(px(xs[i]), py(ys[i]));
  }
  ctx.stroke();
  ctx.restore();

  const bounds = [];
  items.forEach((it, i) => {
    const on = travelled >= i - 0.001;
    const isCurrent = on && travelled < i + 1;
    const X = px(xs[i]);
    const Y = py(ys[i]);

    if (on) {
      // 当前点加一圈光环：讲到哪一点要能看出来，否则观众只能靠声音找
      if (isCurrent) {
        ctx.save();
        ctx.strokeStyle = palette.accent;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(X, Y, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(X, Y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = clamp((travelled - i) * 2);
      ctx.font = `24px ${fonts.med}`;
      ctx.fillStyle = palette.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtNum(ys[i]), X, Y - 16);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = easeOutCubic(clamp(p / 0.25));
    ctx.font = `${env.frame.unitSize + 2}px ${fonts.med}`;
    ctx.fillStyle = palette.body;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xl = String(it.label ?? `#${i + 1}`);
    const lines = wrapWithin(ctx, xl, plot.width / n - 8, env.frame.unitSize + 2, fonts.med, 2) ?? [xl];
    lines.forEach((ln, k) => ctx.fillText(ln, X, plot.y + plot.height + 18 + k * 26));
    ctx.restore();

    bounds.push({ x: X - 8, y: Y - 8, width: 16, height: 16 });
  });

  return { bounds, revealed: Math.round(travelled) + 1, capacity: items.length, notes: [] };
}

/* ──────────────────────────── hierarchy ──────────────────────────── */

/**
 * 层级结构。用「编号圆点 + 下方文字 + 直角折线」，不画方框 ——
 * 方框会把 8 个节点变成 8 个色块，视觉重量压过内容。
 */
export function drawHierarchy(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.hierarchy;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `hierarchy 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const roots = items.filter((it) => !it.parent || !byId.has(it.parent));
  if (roots.length !== 1) {
    throw new CapacityError('DIAGRAM_STRUCTURE', `hierarchy 需要恰好一个根节点，实际 ${roots.length}`);
  }
  const children = new Map(items.map((it) => [it.id, []]));
  items.forEach((it) => {
    if (it.parent && byId.has(it.parent)) children.get(it.parent).push(it);
  });

  // 分层：BFS 定 level，同层按出现顺序排（顺序即语义，别按字母排）
  const level = new Map([[roots[0].id, 0]]);
  const order = [];
  const queue = [roots[0]];
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    for (const ch of children.get(cur.id) ?? []) {
      level.set(ch.id, (level.get(cur.id) ?? 0) + 1);
      queue.push(ch);
    }
  }
  const depth = Math.max(...level.values()) + 1;
  if (depth > 4) throw new CapacityError('DIAGRAM_CAPACITY', 'hierarchy 最深 4 层，再多读不清');

  const perLevel = new Map();
  order.forEach((it) => {
    const l = level.get(it.id);
    perLevel.set(l, (perLevel.get(l) ?? 0) + 1);
  });
  // 层距按「去掉顶部标题余量与底部标签余量」后的高度算，不再直接除以层数。
  // 第一版均分导致整棵树挤在上半屏，下面空一大片。
  const nodeR = 15;
  const labelSize = 26;
  // 层距 + 整体垂直居中：高度先按内容算，剩余空间对半分。
  // （第一版从 box.y+70 起排，最后一层之下空 170px，整棵树看着悬在上方。）
  const nodeGap = nodeR * 2 + 10 + labelSize * 1.24; // 一层节点自身占的高度
  // 层距取「可用均分」与「上限 190」的较小值：均分会把 3 层树拉成 700px 高，
  // 看着像松散的三条横线；封顶后整棵树才有"一棵树"的密度。
  const evenGap = depth > 1 ? (box.height - nodeGap - 40) / (depth - 1) : 0;
  const layerH = depth > 1 ? Math.min(190, Math.max(120, evenGap)) : 0;
  const contentH = layerH * (depth - 1) + nodeGap;
  const topPad = box.y + Math.max(16, (box.height - contentH) / 2);
  const cyOf = (l) => topPad + layerH * l;

  // 位置与标签行数一起算：连线要避开标签块，不能从文字中间穿过去。
  // （第一版就是从 badge 下方直接拉线，竖段正好压住父节点的字。）
  const pos = new Map();
  const labelLines = new Map();
  const counters = new Map();
  order.forEach((it) => {
    const l = level.get(it.id);
    const k = counters.get(l) ?? 0;
    counters.set(l, k + 1);
    const cnt = perLevel.get(l);
    const cx = box.x + (box.width * (k + 0.5)) / cnt;
    const cy = cyOf(l);
    pos.set(it.id, { cx, cy });
    const lines = wrapWithin(ctx, it.label ?? it.id, box.width / Math.max(1, cnt) - 24, labelSize, fonts.black, 2);
    if (!lines) throw new CapacityError('DIAGRAM_CAPACITY', `hierarchy 节点标签超长：${it.label}`);
    labelLines.set(it.id, lines);
  });

  const labelBottomOf = (id) => {
    const { cy } = pos.get(id);
    return cy + nodeR + 10 + (labelLines.get(id)?.length ?? 1) * labelSize * 1.24;
  };

  // 连线先画，节点压在上面（视觉上"挂在线上"而不是"线穿过去"）。
  // 线不做半截：断在半路的直角折线读起来像画错了，方向感全靠整条线。
  ctx.save();
  ctx.globalAlpha = easeOutCubic(clamp((p - 0.1) / 0.4));
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  order.forEach((it) => {
    const parent = it.parent && byId.get(it.parent);
    if (!parent) return;
    const a = pos.get(parent.id);
    const b = pos.get(it.id);
    const y0 = labelBottomOf(parent.id) + 6;
    const y1 = b.cy - nodeR;
    if (y1 <= y0) return;
    elbow(ctx, a.cx, y0, b.cx, y1, y0 + (y1 - y0) * 0.55);
  });
  ctx.restore();

  const bounds = [];
  order.forEach((it, i) => {
    const { cx, cy } = pos.get(it.id);
    const q = env.rowReveal(p, i, order.length, 0.12);
    ctx.save();
    ctx.globalAlpha = q;
    const cur = Math.min(order.length - 1, Math.floor(clamp(p / 0.85) * order.length));
    badge(ctx, cx, cy, i + 1, palette, nodeR, i === cur ? 'active' : i < cur ? 'done' : 'idle');
    ctx.font = `${labelSize}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    labelLines.get(it.id).forEach((ln, k) => ctx.fillText(ln, cx, cy + nodeR + 10 + k * labelSize * 1.24));
    ctx.restore();
    bounds.push({ x: cx - nodeR, y: cy - nodeR, width: nodeR * 2, height: nodeR * 2 });
  });

  return { bounds, revealed: order.length, capacity: items.length };
}

/* ──────────────────────────── cycle ──────────────────────────── */

/**
 * 循环。节点均分在矩形环上（不是正圆）—— 正圆在 16:9 里会让上下两个节点挤在
 * 屏幕边缘，而文字的阅读区在中带。矩形环把节点推到四角/四边中点，留白更匀。
 */
export function drawCycle(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.cycle;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `cycle 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }

  // 矩形环居中；节点按「角度等分后投影到矩形」定位，而不是按周长均分。
  // 周长均分在 n=3 时会把第三个节点甩到左下角偏内，看着像排歪了。
  const cx0 = box.x + box.width / 2;
  const cy0 = box.y + box.height / 2 - 10;
  const hw = box.width * 0.40;
  const hh = box.height * 0.30;
  const ring = { x: cx0 - hw, y: cy0 - hh, width: hw * 2, height: hh * 2 };

  // 沿矩形周长参数化：箭头与跑动点必须走边，不能取两点连线中点。
  // （第一版就取了两点中点，箭头全飘在环里面，看着像装饰。）
  const W = ring.width;
  const H = ring.height;
  const L = 2 * (W + H);
  const at = (u) => {
    let d = ((u % 1) + 1) % 1 * L;
    if (d <= W) return { x: ring.x + d, y: ring.y, ang: 0 };
    d -= W;
    if (d <= H) return { x: ring.x + W, y: ring.y + d, ang: Math.PI / 2 };
    d -= H;
    if (d <= W) return { x: ring.x + W - d, y: ring.y + H, ang: Math.PI };
    d -= W;
    return { x: ring.x, y: ring.y + H - d, ang: -Math.PI / 2 };
  };
  const uOf = (pt) => {
    const eps = 1.5;
    if (Math.abs(pt.y - ring.y) < eps) return (pt.x - ring.x) / L;
    if (Math.abs(pt.x - (ring.x + W)) < eps) return (W + (pt.y - ring.y)) / L;
    if (Math.abs(pt.y - (ring.y + H)) < eps) return (W + H + (ring.x + W - pt.x)) / L;
    return (2 * W + H + (ring.y + H - pt.y)) / L;
  };

  const n = items.length;
  const pts = items.map((_, i) => {
    const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const tx = Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return { x: cx0 + dx * t, y: cy0 + dy * t };
  });
  const us = pts.map(uOf);

  // 环线
  ctx.save();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.rect(ring.x, ring.y, W, H);
  ctx.stroke();
  ctx.restore();

  // 方向箭头：画在两个节点之间的路径中点上，沿边切线方向
  for (let i = 0; i < n; i++) {
    let du = us[(i + 1) % n] - us[i];
    if (du <= 0) du += 1;
    const mid = at(us[i] + du / 2);
    // 节点常常正好落在矩形角上，箭头会被徽标吞掉。离任一端太近就跳过这一段。
    const near = Math.min(
      Math.hypot(mid.x - pts[i].x, mid.y - pts[i].y),
      Math.hypot(mid.x - pts[(i + 1) % n].x, mid.y - pts[(i + 1) % n].y)
    );
    if (near < 52) continue;
    ctx.save();
    ctx.translate(mid.x, mid.y);
    ctx.rotate(mid.ang);
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -5.4);
    ctx.lineTo(-6, 5.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 跑动点：同样沿边走
  const moveIdx = clamp(p) * n;
  const i0 = Math.floor(moveIdx) % n;
  let du = us[(i0 + 1) % n] - us[i0];
  if (du <= 0) du += 1;
  const mp = at(us[i0] + du * (moveIdx - Math.floor(moveIdx)));
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.arc(mp.x, mp.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bounds = [];
  items.forEach((it, i) => {
    const pt = pts[i];
    const q = env.rowReveal(p, i, n, 0.12);
    ctx.save();
    ctx.globalAlpha = q;
    badge(ctx, pt.x, pt.y, i + 1, palette, 15);

    // 说明文字：默认放节点下方；贴近版心底时翻到上方，避免被裁
    const below = pt.y + 24 + 96 < box.y + box.height;
    const dir = below ? 1 : -1;
    ctx.textAlign = 'center';
    ctx.textBaseline = below ? 'top' : 'bottom';

    const titleFit = fitText(ctx, it.label ?? it.id, 240, fonts.black, { start: 28, min: 20, maxLines: 1 });
    ctx.font = `${titleFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    const titleY = below ? pt.y + 24 : pt.y - 24;
    ctx.fillText(titleFit.lines[0] ?? '', pt.x, titleY);

    if (it.text) {
      const subFit = fitText(ctx, it.text, 260, fonts.reg, { start: 22, min: 16, maxLines: 2 });
      ctx.font = `${subFit.size}px ${fonts.reg}`;
      ctx.fillStyle = palette.label;
      subFit.lines.forEach((ln, k) => {
        const y = below
          ? titleY + titleFit.size * 1.3 + k * subFit.size * 1.3
          : titleY - titleFit.size * 1.1 - (subFit.lines.length - 1 - k) * subFit.size * 1.3;
        ctx.fillText(ln, pt.x, y);
      });
    }
    ctx.restore();
    bounds.push({ x: pt.x - 130, y: below ? pt.y : pt.y - 120, width: 260, height: 120 });
    void dir;
  });

  return { bounds, revealed: n, capacity: n, notes: [] };
}

/* ──────────────────────────── definition ──────────────────────────── */

/**
 * 概念定义：左边术语、右边释义，逐行分栏。
 * 不用"术语在上、释义在下"的堆叠：一屏放 4–6 条时，堆叠会让读者找不到哪句配哪个词。
 */
export function drawDefinition(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.definition;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `definition 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }

  const termW = Math.min(360, Math.max(220, box.width * 0.30));
  const gapW = 56;
  const descX = box.x + termW + gapW;
  const descW = box.width - termW - gapW;
  const rowH = Math.min(220, box.height / items.length);
  const startY = box.y + (box.height - rowH * items.length) / 2;

  const bounds = [];
  const actDef = env.active(p, items.length);
  items.forEach((it, i) => {
    const y = startY + i * rowH;
    const q = env.rowReveal(p, i, items.length, 0.12);
    const isActive = i === actDef;

    if (isActive && q > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette.accent;
      ctx.fillRect(box.x - 22, y + rowH / 2 - 30, 4, 60);
      ctx.restore();
    }

    // 只在项之间画分隔线：第一项上面那条会变成一根孤零零的顶线
    if (i > 0) {
      ctx.save();
      ctx.globalAlpha = q * 0.5;
      ctx.strokeStyle = palette.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(box.x, y + 0.5);
      ctx.lineTo(box.x + box.width, y + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = q;
    const termFit = fitText(ctx, it.label ?? it.id, termW, fonts.black, {
      start: Math.round(clamp(rowH * 0.3, 30, 60)),
      min: 22,
      maxLines: 2,
    });
    ctx.font = `${termFit.size}px ${fonts.black}`;
    ctx.fillStyle = isActive ? palette.accent : palette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const termY = y + rowH / 2 - ((termFit.lines.length - 1) * termFit.size * 1.2) / 2;
    termFit.lines.forEach((ln, k) => ctx.fillText(ln, box.x, termY + k * termFit.size * 1.2));

    if (it.text) {
      const descFit = fitText(ctx, it.text, descW, fonts.reg, {
        start: Math.round(clamp(rowH * 0.17, 26, 38)),
        min: 19,
        maxLines: 3,
      });
      if (descFit.overflow && descFit.lines.length > 3) {
        throw new CapacityError('DIAGRAM_CAPACITY', `definition 释义过长：${it.label}`);
      }
      ctx.font = `${descFit.size}px ${fonts.reg}`;
      ctx.fillStyle = palette.body;
      const blockH = descFit.lines.length * descFit.size * 1.42;
      descFit.lines.forEach((ln, k) => {
        ctx.fillText(ln, descX, y + rowH / 2 - blockH / 2 + descFit.size * 0.9 + k * descFit.size * 1.42);
      });
    }
    ctx.restore();

    bounds.push({ x: box.x, y, width: box.width, height: rowH });
  });

  return { bounds, revealed: items.length, capacity: items.length, notes: [] };
}

/* ──────────────────────────── compare ──────────────────────────── */

/**
 * 前后对比：同一行保持同一对象，左右两列换状态。
 * 跟 paper 的 compare（两段大标题对峙）不同：这里比的是"同一批对象的两个读数"，
 * 所以必须有行标签，否则读者对不上号。
 */
export function drawCompare(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.compare;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `compare 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }

  const labelW = Math.min(330, box.width * 0.26);
  const colW = (box.width - labelW - 40) / 2;
  const leftX = box.x + labelW;
  const rightX = leftX + colW + 40;
  const headerH = 76;
  const rowH = Math.min(180, (box.height - headerH) / items.length);
  // 表头跟着数据块一起居中：固定贴顶会让「表头—第一行」之间空出一大截
  const blockH = headerH + rowH * items.length;
  const blockTop = box.y + (box.height - blockH) / 2;
  const startY = blockTop + headerH;

  ctx.save();
  // 表头是对比的两个主语，用 24px 灰字等于没标 —— 观众分不清左右两列各是谁
  ctx.font = `30px ${fonts.black}`;
  ctx.fillStyle = palette.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(r.beforeLabel ?? '前', leftX + colW / 2, blockTop + 32);
  ctx.fillText(r.afterLabel ?? '后', rightX + colW / 2, blockTop + 32);
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(rightX - 20, blockTop + 8);
  ctx.lineTo(rightX - 20, blockTop + blockH - 8);
  ctx.stroke();
  ctx.restore();

  const bounds = [];
  const actCmp = env.active(p, items.length);
  items.forEach((it, i) => {
    const y = startY + i * rowH;
    const q = env.rowReveal(p, i, items.length, 0.12);
    const isActive = i === actCmp;
    if (isActive && q > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette.accent;
      ctx.fillRect(box.x - 22, y + rowH / 2 - 28, 4, 56);
      ctx.restore();
    }
    ctx.save();
    // 左列跟"讲的是哪台"走（rowAt 那组），右列跟"什么时候开始说快的那台"走（at 那组）。
    // 合成一个进度的话，念"慢的那台"时右边已经亮着，对比就没有悬念了。
    const qAfter = env.reveal(p, i, items.length, 0.12);
    ctx.globalAlpha = q;

    const labFit = fitText(ctx, it.label ?? it.id, labelW - 24, fonts.black, { start: 28, min: 18, maxLines: 2 });
    ctx.font = `${labFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labY = y + rowH / 2 - ((labFit.lines.length - 1) * labFit.size * 1.2) / 2;
    labFit.lines.forEach((ln, k) => ctx.fillText(ln, box.x, labY + k * labFit.size * 1.2));

    // 前：压暗；后：强调色。差异靠色阶，不靠箭头（箭头会把"对比"讲成"转变"）
    const val = (text, cx, accent, alpha) => {
      if (text === undefined || text === null) return;
      const f = fitText(ctx, String(text), colW, fonts.med, { start: 40, min: 20, maxLines: 2 });
      ctx.globalAlpha = alpha;
      ctx.font = `${f.size}px ${fonts.med}`;
      ctx.fillStyle = accent ? palette.accent : palette.label;
      ctx.textAlign = 'center';
      const h = f.lines.length * f.size * 1.24;
      f.lines.forEach((ln, k) => ctx.fillText(ln, cx + colW / 2, y + rowH / 2 - h / 2 + f.size * 0.85 + k * f.size * 1.24));
    };
    val(it.before, leftX, false, q);
    val(it.after, rightX, true, qAfter);
    ctx.restore();
    bounds.push({ x: box.x, y, width: box.width, height: rowH });
  });

  return { bounds, revealed: items.length, capacity: items.length, notes: [] };
}

/* ──────────────────────────── process ──────────────────────────── */

/**
 * 流程：横向节点 + 箭头。节点均分，箭头落在中点。
 * 超过 6 步就报错：横向排 8 个节点时每个只有 190px，中文标签会折成两行破版面。
 */
export function drawProcess(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.process;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `process 需要 ${cap.min}–${cap.max} 步，实际 ${items.length}`);
  }

  const n = items.length;
  const stepW = box.width / n;
  const cy = box.y + box.height * 0.45;
  const r0 = 17;

  // 主轴：一条贯穿的细线，节点压在上面
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = palette.rule;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(box.x + stepW / 2, cy + 0.5);
  ctx.lineTo(box.x + box.width - stepW / 2, cy + 0.5);
  ctx.stroke();
  ctx.restore();

  const bounds = [];
  items.forEach((it, i) => {
    const cx = box.x + stepW * (i + 0.5);
    const q = env.rowReveal(p, i, n, 0.12);
    const cur = Math.min(n - 1, Math.floor(clamp(p / 0.9) * n));

    // 箭头：画在上一节点与本节点之间
    if (i > 0) {
      const ax = box.x + stepW * (i - 1 + 0.5) + r0 + 12;
      const bx = cx - r0 - 12;
      const aq = easeOutCubic(clamp((q - 0.15) / 0.5));
      if (bx > ax) {
        ctx.save();
        ctx.globalAlpha = aq;
        ctx.fillStyle = palette.accent;
        const mx = ax + (bx - ax) * 0.5;
        ctx.beginPath();
        ctx.moveTo(mx + 10, cy);
        ctx.lineTo(mx - 6, cy - 7);
        ctx.lineTo(mx - 6, cy + 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.globalAlpha = q;
    badge(ctx, cx, cy, i + 1, palette, r0, i === cur ? 'active' : i < cur ? 'done' : 'idle');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const titleFit = fitText(ctx, it.label ?? it.id, stepW - 28, fonts.black, { start: 28, min: 18, maxLines: 2 });
    ctx.font = `${titleFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    titleFit.lines.forEach((ln, k) => ctx.fillText(ln, cx, cy + r0 + 16 + k * titleFit.size * 1.24));
    if (it.text) {
      const subFit = fitText(ctx, it.text, stepW - 24, fonts.reg, { start: 21, min: 15, maxLines: 2 });
      ctx.font = `${subFit.size}px ${fonts.reg}`;
      ctx.fillStyle = palette.label;
      const baseY = cy + r0 + 16 + titleFit.lines.length * titleFit.size * 1.24 + 8;
      subFit.lines.forEach((ln, k) => ctx.fillText(ln, cx, baseY + k * subFit.size * 1.3));
    }
    ctx.restore();
    bounds.push({ x: cx - r0, y: cy - r0, width: r0 * 2, height: r0 * 2 });
  });

  return { bounds, revealed: n, capacity: n, notes: [] };
}

/* ──────────────────────────── causal ──────────────────────────── */

/**
 * 因果：左列原因、右列结果，箭头按 links 连。
 * 不做多级自动分层（那是 hierarchy 的活）：因果图一旦超过两层，
 * 箭头会互相穿插，读者分不清"谁导致谁"。两层是能读清的上限。
 */
export function drawCausal(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.causal;
  const items = r.items ?? [];
  const links = r.links ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `causal 需要 ${cap.min}–${cap.max} 个节点，实际 ${items.length}`);
  }
  if (!links.length) throw new CapacityError('DIAGRAM_STRUCTURE', 'causal 至少要有一条 links');

  const byId = new Map(items.map((it) => [it.id, it]));
  const targets = new Set(links.map((l) => l.to));
  const causes = items.filter((it) => !targets.has(it.id));
  const effects = items.filter((it) => targets.has(it.id));
  if (!causes.length) throw new CapacityError('DIAGRAM_STRUCTURE', 'causal 里没有起点（所有节点都有入边）');

  // 列宽按内容实测定，不用固定百分比：词短的时候 30% 版心会把箭头拉成一条长鞭，
  // 两头空空，读起来像两条断掉的线。
  const inset = 40;
  const measW = (it) => {
    ctx.font = `34px ${fonts.black}`;
    return Math.min(box.width * 0.32, measure(ctx, it.label ?? it.id));
  };
  const leftW = Math.max(120, ...causes.map(measW));
  const rightW = Math.max(120, ...effects.map(measW));
  // 不两端对齐：左右贴版心会让箭头横跨 1200px，两条弧线扁成平行线。
  // 固定中间留 340，整块再居中。
  const gap = 340;
  const blockW = leftW + gap + rightW;
  const blockX = box.x + Math.max(inset, (box.width - blockW) / 2);
  const leftX = blockX;
  const rightX = blockX + leftW + gap;

  const posOf = new Map();
  const place = (arr, x, w) => {
    // 行距封顶 + 整列居中：两个节点时按版心均分会拉到上下两头，中间空 200px
    const rowH = Math.min(190, box.height / Math.max(1, arr.length));
    const top = box.y + (box.height - rowH * arr.length) / 2;
    arr.forEach((it, i) => {
      const cy = top + rowH * (i + 0.5);
      posOf.set(it.id, { x, w, cy });
    });
  };
  place(causes, leftX, leftW);
  place(effects, rightX, rightW);

  const bounds = [];
  const actC = env.active(p, items.length);
  const drawNode = (it, i, total) => {
    const pos = posOf.get(it.id);
    const q = env.rowReveal(p, i, total, 0.12);
    const isActive = i === actC;
    ctx.save();
    ctx.globalAlpha = q;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const f = fitText(ctx, it.label ?? it.id, pos.w, fonts.black, { start: 34, min: 18, maxLines: 2 });
    ctx.font = `${f.size}px ${fonts.black}`;
    ctx.fillStyle = isActive ? palette.accent : palette.ink;
    const h = f.lines.length * f.size * 1.24;
    f.lines.forEach((ln, k) => ctx.fillText(ln, pos.x, pos.cy - h / 2 + f.size * 0.85 + k * f.size * 1.24));
    const textW = Math.min(pos.w, Math.max(...f.lines.map((ln) => measure(ctx, ln))));
    // 文字下面一条短线：没有它，节点在 16:9 里就是几个飘着的词
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = isActive ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.cy + h / 2 + 8);
    ctx.lineTo(pos.x + textW, pos.cy + h / 2 + 8);
    ctx.stroke();
    if (it.text) {
      ctx.font = `20px ${fonts.reg}`;
      ctx.fillStyle = palette.label;
      ctx.fillText(it.text, pos.x, pos.cy + h / 2 + 42);
    }
    ctx.restore();
    bounds.push({ x: pos.x, y: pos.cy - h / 2, width: textW, height: h });
    pos.edgeX = pos.x + textW;
  };
  items.forEach((it, i) => drawNode(it, i, items.length));

  // 箭头后画：它需要节点的实测右缘，而且线压在节点上的部分正好被基线挡住
  ctx.save();
  ctx.globalAlpha = easeOutCubic(clamp((p - 0.15) / 0.5));
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  ctx.fillStyle = palette.accent;
  links.forEach((l) => {
    const a = posOf.get(l.from);
    const b = posOf.get(l.to);
    if (!a || !b) throw new CapacityError('DIAGRAM_STRUCTURE', `causal 的 link 指向不存在的节点：${l.from} → ${l.to}`);
    const x0 = a.edgeX + 30;
    const y0 = a.cy;
    const x1 = b.x - 26;
    const y1 = b.cy;
    const cx = (x0 + x1) / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
    ctx.stroke();
    const ang = Math.atan2(y1 - y0, x1 - x0);
    ctx.save();
    ctx.translate(x1, y1);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -5.5);
    ctx.lineTo(-6, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (l.label) {
      ctx.save();
      ctx.font = `20px ${fonts.reg}`;
      ctx.fillStyle = palette.label;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(l.label, cx, (y0 + y1) / 2 - 8);
      ctx.restore();
    }
  });
  ctx.restore();

  return { bounds, revealed: items.length, capacity: items.length, notes: [`因 ${causes.length} / 果 ${effects.length}`] };
}

/* ──────────────────────────── parts ──────────────────────────── */

/**
 * 部分与整体：100% 堆叠条 + 图例。
 * 不用饼图：饼图在 1080 高度下半径受限，两项相近时肉眼分不出大小；
 * 堆叠条的长度比角度好判断，也方便把百分比写在图例里。
 */
export function drawParts(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.parts;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `parts 需要 ${cap.min}–${cap.max} 项，实际 ${items.length}`);
  }
  const vals = items.map((it) => Number(it.value));
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new CapacityError('DIAGRAM_VALUE', 'parts 的 value 必须是非负数字');
  }
  const total = vals.reduce((a, b) => a + b, 0) || 1;

  const barY = box.y + box.height * 0.28;
  const barH = 92;
  const gap = 3;
  const alphas = [1, 0.72, 0.54, 0.4, 0.3, 0.22];

  const segs = [];
  let cursorX = box.x;
  items.forEach((it, i) => {
    const w = (vals[i] / total) * box.width;
    segs.push({ it, i, x: cursorX, w: Math.max(2, w - gap) });
    cursorX += w;
  });

  // 整条按一个进度从左往右扫，而不是每段各自从 0 宽度长出来。
  // 逐段长会让人以为"总量在变"，堆叠条表达的是比例，比例不能动。
  const reveal = easeOutCubic(clamp(p / 0.4));
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, barY - 4, box.width * reveal, barH + 8);
  ctx.clip();
  segs.forEach(({ i, x, w }) => {
    ctx.globalAlpha = alphas[Math.min(i, alphas.length - 1)];
    ctx.fillStyle = palette.accent;
    ctx.fillRect(x, barY, w, barH);
  });
  ctx.restore();

  // 百分比：跟着条的扫描前沿出现，但只写在前沿之后
  const actP = env.active(p, items.length);
  segs.forEach(({ it, i, x, w }) => {
    if (w < 66) return;
    if (x + w > box.x + box.width * reveal) return;
    const isActive = i === actP && p > 0.3;
    if (isActive) {
      ctx.save();
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.moveTo(x + w / 2, barY - 10);
      ctx.lineTo(x + w / 2 - 8, barY - 22);
      ctx.lineTo(x + w / 2 + 8, barY - 22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = clamp((reveal - (x + w - box.x) / box.width) * 6 + 0.25);
    ctx.font = `${isActive ? 34 : 28}px ${fonts.med}`;
    // 浅色段上用深字：白字压在 40% 透明度红底上看不清
    ctx.fillStyle = alphas[Math.min(i, alphas.length - 1)] > 0.45 ? palette.badgeInk : palette.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round((vals[i] / total) * 100)}%`, x + w / 2, barY + barH / 2);
    ctx.restore();
    void it;
  });

  // 图例：逐项淡入；色块和文字分开设 alpha，避免色块被"文字透明度"带淡
  const legY = barY + barH + 104;
  const colW = box.width / 2;
  segs.forEach(({ it, i }, k) => {
    const col = k % 2;
    const row = Math.floor(k / 2);
    const lx = box.x + col * colW;
    const ly = legY + row * 88;
    // 图例跟条形同一个进度，只做轻微错峰：条扫到 30% 而图例才出两项，观众会以为漏了一段
    const q = easeOutCubic(clamp((reveal - k * 0.08) / 0.4));

    ctx.save();
    ctx.globalAlpha = q * alphas[Math.min(i, alphas.length - 1)];
    ctx.fillStyle = palette.accent;
    ctx.fillRect(lx, ly - 12, 24, 24);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = q;
    ctx.font = `30px ${fonts.med}`;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.label ?? it.id, lx + 36, ly);
    ctx.font = `22px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.fillText(`${fmtNum(vals[i])}${it.unit ? ' ' + it.unit : ''}`, lx + 230, ly);
    ctx.restore();
  });

  return {
    bounds: segs.map((s) => ({ x: s.x, y: barY, width: s.w, height: barH })),
    revealed: items.length,
    capacity: items.length,
    notes: [`合计 ${fmtNum(total)}`],
  };
}

/* ──────────────────────────── experiment ──────────────────────────── */

/**
 * 条件观察对照：一行一个"条件 → 观察结果"。
 * 跟 compare 的区别：compare 比的是同一对象的两个时间点，这里比的是不同条件下的一次观察，
 * 所以左边必须是条件（自变量），右边是结果（因变量），中间用箭头表示"观察到"。
 */
export function drawExperiment(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.experiment;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `experiment 需要 ${cap.min}–${cap.max} 组，实际 ${items.length}`);
  }

  const condW = box.width * 0.38;
  const arrowW = 90;
  const resX = box.x + condW + arrowW;
  const resW = box.width - condW - arrowW;
  const rowH = Math.min(150, box.height / items.length);
  const startY = box.y + (box.height - rowH * items.length) / 2;

  const bounds = [];
  const actExp = env.active(p, items.length);
  items.forEach((it, i) => {
    const y = startY + i * rowH;
    const cy = y + rowH / 2;
    const q = env.rowReveal(p, i, items.length, 0.12);
    const isActive = i === actExp;
    if (isActive && q > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette.accent;
      ctx.fillRect(box.x - 22, cy - 40, 4, 80);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = q;
    ctx.font = `24px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`条件 ${i + 1}`, box.x, cy - rowH * 0.28);

    const condFit = fitText(ctx, it.condition ?? it.label ?? '', condW, fonts.black, { start: 32, min: 18, maxLines: 2 });
    ctx.font = `${condFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    const ch = condFit.lines.length * condFit.size * 1.24;
    condFit.lines.forEach((ln, k) => ctx.fillText(ln, box.x, cy + 6 - ch / 2 + condFit.size * 0.85 + k * condFit.size * 1.24));
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = q * 0.85;
    ctx.strokeStyle = palette.accent;
    ctx.fillStyle = palette.accent;
    ctx.lineWidth = 2;
    const ax = box.x + condW + 16;
    const bx = resX - 16;
    ctx.beginPath();
    ctx.moveTo(ax, cy);
    ctx.lineTo(bx - 6, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, cy);
    ctx.lineTo(bx - 10, cy - 6);
    ctx.lineTo(bx - 10, cy + 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = q;
    const resFit = fitText(ctx, it.result ?? '', resW, fonts.med, { start: 30, min: 18, maxLines: 3 });
    ctx.font = `${resFit.size}px ${fonts.med}`;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'left';
    const rh = resFit.lines.length * resFit.size * 1.34;
    resFit.lines.forEach((ln, k) => ctx.fillText(ln, resX, cy - rh / 2 + resFit.size * 0.9 + k * resFit.size * 1.34));
    ctx.restore();

    bounds.push({ x: box.x, y, width: box.width, height: rowH });
  });

  return { bounds, revealed: items.length, capacity: items.length, notes: [] };
}

/* ──────────────────────────── evidence ──────────────────────────── */

/**
 * 证据与出处：引文在上、来源在下。
 * 引号不画成装饰图案，用排版感（大号字形 + 缩进）表达它是引文；
 * 来源必须落地，否则这段字在成片里就成了"我说的"。
 */
export function drawEvidence(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.evidence;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `evidence 需要 ${cap.min}–${cap.max} 条，实际 ${items.length}`);
  }

  const blockH = box.height / items.length;
  const quoteW = box.width * 0.86;
  const indent = 46;

  const bounds = [];
  items.forEach((it, i) => {
    const top = box.y + i * blockH;
    const q = env.rowReveal(p, i, items.length, 0.12);

    ctx.save();
    ctx.globalAlpha = q * 0.35;
    ctx.fillStyle = palette.accent;
    ctx.font = `120px ${fonts.black}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('“', box.x - 6, top + 4);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = q;
    const qFit = fitText(ctx, it.text ?? it.label ?? '', quoteW - indent, fonts.med, { start: 40, min: 20, maxLines: 3 });
    if (qFit.overflow && qFit.lines.length > 3) {
      throw new CapacityError('DIAGRAM_CAPACITY', `evidence 引文过长：${it.text?.slice(0, 12)}…`);
    }
    ctx.font = `${qFit.size}px ${fonts.med}`;
    ctx.fillStyle = palette.ink;
    ctx.textBaseline = 'top';
    const qh = qFit.lines.length * qFit.size * 1.46;
    qFit.lines.forEach((ln, k) => ctx.fillText(ln, box.x + indent, top + 26 + k * qFit.size * 1.46));

    if (it.source) {
      const sy = top + 26 + qh + 26;
      ctx.globalAlpha = q * 0.6;
      ctx.strokeStyle = palette.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(box.x + indent, sy + 0.5);
      ctx.lineTo(box.x + indent + 72, sy + 0.5);
      ctx.stroke();
      ctx.globalAlpha = q;
      ctx.font = `24px ${fonts.reg}`;
      ctx.fillStyle = palette.label;
      ctx.fillText(`—— ${it.source}`, box.x + indent + 92, sy - 12);
    }
    ctx.restore();

    bounds.push({ x: box.x, y: top, width: box.width, height: blockH });
  });

  return { bounds, revealed: items.length, capacity: items.length, notes: [] };
}

/* ──────────────────────────── formula ──────────────────────────── */

/**
 * 可计算公式：上面一行公式，下面一张变量表。
 * 公式不做语法解析（解析器本身比版式贵十倍），整行大字即可；
 * 变量表才是这个段型的价值：符号 → 含义 → 本期取值。
 */
export function drawFormula(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.formula;
  const items = r.items ?? [];
  if (!r.formula) throw new CapacityError('DIAGRAM_STRUCTURE', 'formula 缺少 formula 字段');
  if (items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `formula 变量最多 ${cap.max} 个，实际 ${items.length}`);
  }

  const fFit = fitText(ctx, r.formula, box.width * 0.92, fonts.med, { start: 56, min: 28, maxLines: 2 });
  if (fFit.overflow && fFit.lines.length > 2) {
    throw new CapacityError('DIAGRAM_CAPACITY', '公式过长，拆成两段讲');
  }

  const q0 = easeOutCubic(clamp(p / 0.45));
  ctx.save();
  ctx.globalAlpha = q0;
  ctx.font = `${fFit.size}px ${fonts.med}`;
  ctx.fillStyle = palette.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const fTop = box.y + box.height * 0.14;
  fFit.lines.forEach((ln, k) => ctx.fillText(ln, box.x + box.width / 2, fTop + k * fFit.size * 1.3));
  ctx.restore();

  const tableTop = fTop + fFit.lines.length * fFit.size * 1.3 + 64;
  if (items.length) {
    const rowH = Math.min(76, (box.y + box.height - tableTop - 20) / items.length);
    const symW = 150;
    const valW = 240;
    const meanW = box.width - symW - valW;

    const actF = env.active(p, items.length);
    items.forEach((it, i) => {
      const y = tableTop + i * rowH;
      const q = env.rowReveal(p, i, items.length, 0.12);
      const isActive = i === actF;

      if (isActive) {
        ctx.save();
        ctx.globalAlpha = 0.5 * clamp((p - 0.2) / 0.3);
        ctx.fillStyle = palette.accent;
        ctx.globalAlpha *= 0.1;
        ctx.fillRect(box.x + 44, y + 4, box.width - 88, rowH - 8);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = palette.accent;
        ctx.fillRect(box.x + 44, y + rowH / 2 - 18, 3, 36);
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = q * 0.45;
      ctx.strokeStyle = palette.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(box.x + 60, y + 0.5);
      ctx.lineTo(box.x + box.width - 60, y + 0.5);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = q;
      ctx.textBaseline = 'middle';
      ctx.font = `30px ${fonts.med}`;
      ctx.fillStyle = palette.accent;
      ctx.textAlign = 'left';
      ctx.fillText(it.symbol ?? it.id, box.x + 60, y + rowH / 2);

      ctx.font = `26px ${fonts.reg}`;
      ctx.fillStyle = palette.body;
      const mFit = fitText(ctx, it.meaning ?? '', meanW, fonts.reg, { start: 26, min: 16, maxLines: 1 });
      ctx.font = `${mFit.size}px ${fonts.reg}`;
      ctx.fillText(mFit.lines[0] ?? '', box.x + 60 + symW, y + rowH / 2);

      if (it.value !== undefined && it.value !== null) {
        ctx.font = `30px ${fonts.med}`;
        ctx.fillStyle = palette.ink;
        ctx.textAlign = 'right';
        ctx.fillText(String(it.value), box.x + box.width - 60, y + rowH / 2);
      }
      ctx.restore();
    });
  }

  return { bounds: [{ x: box.x, y: fTop, width: box.width, height: tableTop - fTop }], revealed: 1 + items.length, capacity: items.length, notes: [] };
}

/* ──────────────────────────── recap ──────────────────────────── */

/**
 * 复习收束：编号 + 要点。
 * 编号用两位大数字（01/02），不用圆点徽标 —— 收束段需要"清点"的语气，
 * 徽标那套是流程语气，两者不该混。
 */
export function drawRecap(ctx, r, p, box, env) {
  const { palette, fonts } = env;
  const cap = CAPACITY.recap;
  const items = r.items ?? [];
  if (items.length < cap.min || items.length > cap.max) {
    throw new CapacityError('DIAGRAM_CAPACITY', `recap 需要 ${cap.min}–${cap.max} 条，实际 ${items.length}`);
  }

  const numW = 150;
  const rowH = Math.min(170, box.height / items.length);
  const startY = box.y + (box.height - rowH * items.length) / 2;

  const bounds = [];
  const actRecap = env.active(p, items.length);
  items.forEach((it, i) => {
    const y = startY + i * rowH;
    const cy = y + rowH / 2;
    const q = env.rowReveal(p, i, items.length, 0.12);
    const isActive = i === actRecap;

    ctx.save();
    ctx.globalAlpha = q * (isActive ? 1 : 0.42);
    ctx.font = `64px ${fonts.black}`;
    ctx.fillStyle = isActive ? palette.accent : palette.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1).padStart(2, '0'), box.x, cy);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = q;
    const tFit = fitText(ctx, it.label ?? it.id, box.width - numW - 20, fonts.black, { start: 40, min: 20, maxLines: 2 });
    const hasText = Boolean(it.text);
    const blockH = tFit.lines.length * tFit.size * 1.24 + (hasText ? 34 : 0);
    ctx.font = `${tFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    ctx.textBaseline = 'top';
    tFit.lines.forEach((ln, k) => ctx.fillText(ln, box.x + numW, cy - blockH / 2 + k * tFit.size * 1.24));
    if (hasText) {
      ctx.font = `24px ${fonts.reg}`;
      ctx.fillStyle = palette.label;
      const sFit = fitText(ctx, it.text, box.width - numW - 20, fonts.reg, { start: 24, min: 15, maxLines: 2 });
      sFit.lines.forEach((ln, k) => {
        ctx.fillText(ln, box.x + numW, cy - blockH / 2 + tFit.lines.length * tFit.size * 1.24 + 10 + k * sFit.size * 1.3);
      });
    }
    ctx.restore();

    bounds.push({ x: box.x, y, width: box.width, height: rowH });
  });

  return { bounds, revealed: items.length, capacity: items.length, notes: [] };
}

export const FAMILIES = {
  'data-bar': drawDataBar,
  'data-line': drawDataLine,
  hierarchy: drawHierarchy,
  cycle: drawCycle,
  definition: drawDefinition,
  compare: drawCompare,
  process: drawProcess,
  causal: drawCausal,
  parts: drawParts,
  experiment: drawExperiment,
  evidence: drawEvidence,
  formula: drawFormula,
  recap: drawRecap,
};
