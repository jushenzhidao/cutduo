// kit.js · 粉笔黑板原语（纯 Canvas2D）
//
// 硬约束：不碰 document / window / createElement —— 双宿主（Chromium + Skia）的前提。
// 所有抖动来自**确定性伪随机**（seed 由元素 id 与下标给出），同一帧多画一次结果完全一致。
// 用时间当种子会让粉笔毛边逐帧重算，成片看起来在"沸腾"（sketchnote 那支真踩过）。
//
// 粉笔质感不靠贴图，靠三层描边 + 弧长重采样抖动 + 沿线粉尘点：
//   贴图方案要离屏 canvas，浏览器与 Skia 的 drawImage 行为不完全一致，且换画幅会糊。

(function (root) {
  'use strict';

  // 手写体族：粉笔字用 LongCang（龙藏体，笔画断开、像真粉笔）；数据与正文用霞鹜文楷。
  // 末尾必须带系统兜底，否则字体没注册时 Skia 会静默回退到默认无衬线（画面仍出，但不像黑板）。
  const FACE = {
    chalk: 'LongCang, "LXGW WenKai", "PingFang SC", sans-serif',
    body: '"LXGW WenKai", "PingFang SC", sans-serif',
  };

  // 完整调色板：env.T = 本表 + theme 覆盖。只传 theme 会让 white/yellow 变 undefined。
  const T = {
    board: '#0e1a14',      // 板面
    boardDeep: '#0a120e',  // 板面暗角
    boardEdge: '#080f0b',  // 边框
    ink: '#1a2620',
    white: '#f2efe2',
    dim: '#9aa398',
    yellow: '#e8c86a',
    blue: '#7fb3c8',
    red: '#d98a72',
    green: '#8fbf8a',
    shade: '#1c2c26',      // 背光半球
    lit: '#e4e3cc',        // 受光半球
    umbra: '#301c17',      // 本影
  };

  const u = {
    clamp(x, a, b) { return Math.max(a, Math.min(b, x)); },
    lerp(a, b, t) { return a + (b - a) * t; },
    ease(t) { const x = u.clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); },
    inOut(t) { const x = u.clamp(t, 0, 1); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; },
    // 确定性伪随机：同 seed 恒定
    rnd(seed) {
      const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
      return x - Math.floor(x);
    },
    rgba(hex, a) {
      const h = String(hex || '#000').replace('#', '');
      const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    },
    dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); },
  };

  // ── 几何：照搬上游内容模型的语义（不是抄绘制代码，见 SPEC.md §1） ──
  const DEG = Math.PI / 180;
  const geo = {
    DEG,
    dot(a, b) { return a.reduce((s, x, i) => s + x * b[i], 0); },
    cross(a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    },
    unit(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); },
    mix2(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; },

    // 轨道位置：平面内角 θ 绕节点轴倾斜 incl。返回 3D（光源在 -x，观察者在原点）
    position(theta, node, incl, R) {
      const a = Math.PI - theta - node;
      const ca = Math.cos(a), sa = Math.sin(a);
      const n = Math.cos(node), s = Math.sin(node);
      const ci = Math.cos(incl), si = Math.sin(incl);
      return [R * (ca * n - sa * s * ci), R * (ca * s + sa * n * ci), R * sa * si];
    },

    // 3D → 屏幕：绕 x 轴俯仰 beta
    project(pos, R, beta, center, radius) {
      return [
        center[0] + (pos[0] / R) * radius,
        center[1] + ((pos[1] * Math.cos(beta) - pos[2] * Math.sin(beta)) / R) * radius,
      ];
    },

    // 两圆交叠面积占小圆的比例：本影盖住球体多少
    overlap(r, R, d) {
      if (d >= r + R) return 0;
      if (d <= Math.abs(R - r)) return Math.min(1, (R * R) / (r * r));
      const a = Math.acos(u.clamp((d * d + r * r - R * R) / (2 * d * r), -1, 1));
      const b = Math.acos(u.clamp((d * d + R * R - r * r) / (2 * d * R), -1, 1));
      const area = r * r * a + R * R * b - 0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
      return u.clamp(area / (Math.PI * r * r), 0, 1);
    },

    // 相位角轨道：单调三次 Hermite，斜率同号时才平滑（避免过冲出假的"倒退"）
    angleTrack(t, k) {
      if (!k || k.length < 2) return 0;
      if (t <= k[0][0]) return k[0][1];
      if (t >= k[k.length - 1][0]) return k[k.length - 1][1];
      let i = 1;
      while (i < k.length - 1 && t >= k[i][0]) i++;
      const a = k[i - 1], b = k[i], h = b[0] - a[0];
      const d = (b[1] - a[1]) / h;
      const slope = (j) => {
        if (j === 0) return (k[1][1] - k[0][1]) / (k[1][0] - k[0][0]);
        if (j === k.length - 1) return (k[j][1] - k[j - 1][1]) / (k[j][0] - k[j - 1][0]);
        const l = (k[j][1] - k[j - 1][1]) / (k[j][0] - k[j - 1][0]);
        const r = (k[j + 1][1] - k[j][1]) / (k[j + 1][0] - k[j][0]);
        return l * r <= 0 ? 0 : (2 * l * r) / (l + r);
      };
      let m0 = slope(i - 1), m1 = slope(i);
      if (d === 0) { m0 = 0; m1 = 0; }
      else {
        const rr = Math.hypot(m0 / d, m1 / d);
        if (rr > 3) { m0 *= 3 / rr; m1 *= 3 / rr; }
      }
      const s = (t - a[0]) / h, s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * a[1] + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * b[1] + (s3 - s2) * h * m1;
    },

    // 球体物理状态：位置、视线基、可见受光比例、本影半径、被挡比例
    physical(model, phaseKeys, nodeKeys, t, id) {
      const theta = geo.angleTrack(t, phaseKeys) * DEG;
      const node = geo.angleTrack(t, nodeKeys) * DEG;
      const pos = geo.position(theta, node, (model.inclinationDegrees || 0) * DEG, model.orbitRadius);
      const eye = geo.unit(pos.map((v) => -v));
      const right = geo.unit(geo.cross(eye, [0, 0, 1]));
      const up = geo.unit(geo.cross(right, eye));
      const light = [-1, 0, 0];
      // 相位：光源与视线的夹角决定可见受光比例。正对光源=1（满），背对=0（新）
      const fraction = (1 + geo.dot(light, eye)) / 2;
      // 本影：光源不是点光源，遮挡片投出的锥形本影在球所在平面的半径
      const umbra = pos[0] > 0
        ? Math.max(0, model.occluderRadius - (pos[0] * (model.sourceRadius - model.occluderRadius)) / model.sourceDistance)
        : 0;
      const blocked = umbra ? geo.overlap(model.bodyRadius, umbra, Math.hypot(pos[1], pos[2])) : 0;
      // 中心光线：光源到球心这条线是否擦过遮挡片
      const source = [-model.sourceDistance, 0, 0];
      const v = pos.map((q, i) => q - source[i]);
      const vv = geo.dot(v, v) || 1;
      const s = u.clamp(-geo.dot(source, v) / vv, -1e9, 1e9);
      const closest = source.map((q, i) => q + s * v[i]);
      const centerRayClear = Math.hypot(closest[0], closest[1], closest[2]) >= model.occluderRadius;
      return { id, t, theta, node, pos, eye, right, up, light, fraction, umbra, blocked, centerRayClear, model };
    },

    // 光路：每条光线与挡板求交，取最近交点截断
    rayState(o, t, dur) {
      const beams = [];
      const n = Math.max(1, o.rays | 0);
      for (let i = 0; i < n; i++) {
        const yy = n === 1 ? 0 : (i / (n - 1) - 0.5) * o.spread;
        const a = [o.source[0], o.source[1] + yy];
        const b = [o.target[0], o.target[1] + yy];
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const A = vx * vx + vy * vy;
        const hits = [];
        for (const z of o.blockers || []) {
          const dx = a[0] - z.x, dy = a[1] - z.y;
          const B = 2 * (dx * vx + dy * vy);
          const Cc = dx * dx + dy * dy - z.r * z.r;
          const disc = B * B - 4 * A * Cc;
          if (disc >= 0) {
            const s = (-B - Math.sqrt(disc)) / (2 * A);
            if (s >= 0 && s <= 1) hits.push({ id: z.id, s });
          }
        }
        hits.sort((p, q) => p.s - q.s);
        const h = hits[0];
        beams.push({
          id: 'ray-' + i,
          start: a,
          target: b,
          end: h ? geo.mix2(a, b, h.s) : b,
          blockedBy: h ? h.id : null,
          reachable: !h,
          // 光点在光路上跑：纯粹视觉，不影响结论
          photon: geo.mix2(a, h ? geo.mix2(a, b, h.s) : b, ((t * 0.35 + i / n) % 1 + 1) % 1),
        });
      }
      return { beams, clear: beams.filter((b) => b.reachable).length, total: beams.length };
    },

    // 四个几何谓词：condition-proof 的判据
    conditions(s) {
      const near = s.pos[0] > 0 && Math.abs(Math.sin(s.theta)) < Math.sin(5 * DEG);
      const height = s.umbra > 0 && Math.abs(s.pos[2]) <= s.umbra + s.model.bodyRadius;
      return {
        'near-opposition': near,
        'within-shadow-height': height,
        'shadow-contact': s.blocked > 1e-8,
        'direct-center-ray': s.centerRayClear,
      };
    },
  };

  // ── 路径工具 ──

  // 按弧长重采样并加确定性抖动。抖动量与种子绑定，与时间无关。
  function jitterPath(pts, amp, seed) {
    if (pts.length < 2) return pts.slice();
    let total = 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) { total += u.dist(pts[i - 1], pts[i]); cum.push(total); }
    const step = 7;
    const n = Math.max(2, Math.min(420, Math.round(total / step)));
    const out = [];
    for (let j = 0; j <= n; j++) {
      const target = (total * j) / n;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < target) i++;
      const seg = cum[i] - cum[i - 1] || 1;
      const r = (target - cum[i - 1]) / seg;
      const p = geo.mix2(pts[i - 1], pts[i], u.clamp(r, 0, 1));
      if (j > 0 && j < n && amp > 0) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
        const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l, ny = dx / l;
        const off = (u.rnd(seed + j * 7.13) - 0.5) * 2 * amp;
        p[0] += nx * off; p[1] += ny * off;
      }
      out.push(p);
    }
    return out;
  }

  // 截取路径前 p 比例（按弧长）
  function cutPath(pts, p) {
    if (p >= 1) return pts;
    if (p <= 0) return [];
    let total = 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) { total += u.dist(pts[i - 1], pts[i]); cum.push(total); }
    const target = total * p;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] <= target) out.push(pts[i]);
      else { out.push(geo.mix2(pts[i - 1], pts[i], (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1))); break; }
    }
    return out;
  }

  function tracePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  const MK = {
    T, u, geo, FACE,

    // ── 板面 ──
    board(ctx, W, H, opt) {
      const o = opt || {};
      const g = ctx.createLinearGradient(0, 0, W * 0.55, H);
      g.addColorStop(0, o.top || T.board);
      g.addColorStop(1, o.bottom || T.boardDeep);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // 粉笔灰：低密度、very low alpha，压住大色块的"塑料感"
      const seed = o.seed || 11;
      ctx.save();
      for (let i = 0; i < 320; i++) {
        const x = u.rnd(seed + i * 3.7) * W;
        const y = u.rnd(seed + i * 9.1 + 5) * H;
        const r = 0.6 + u.rnd(seed + i * 1.9) * 2.2;
        ctx.fillStyle = u.rgba(T.white, 0.012 + u.rnd(seed + i * 4.4) * 0.03);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      // 擦痕：几条极淡的弧线，模拟上一课没擦净
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 4; i++) {
        const y0 = H * (0.18 + i * 0.22) + u.rnd(seed + i) * 30;
        const pts = jitterPath([[W * 0.06, y0], [W * 0.4, y0 - 12], [W * 0.78, y0 + 6], [W * 0.95, y0 - 8]], 2.4, seed + i * 31);
        ctx.strokeStyle = u.rgba(T.white, 0.016);
        ctx.lineWidth = 26;
        ctx.lineCap = 'round';
        tracePath(ctx, pts); ctx.stroke();
      }
      ctx.restore();
    },

    // 板框：一圈内阴影，让画面不是"满幅贴图"
    frame(ctx, W, H) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, u.rgba('#000000', 0.45));
      g.addColorStop(0.14, u.rgba('#000000', 0));
      g.addColorStop(0.86, u.rgba('#000000', 0));
      g.addColorStop(1, u.rgba('#000000', 0.5));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    },

    // ── 粉笔线：三层描边 + 粉尘 ──
    line(ctx, pts, col, w, p, seed) {
      const prog = p === undefined ? 1 : p;
      if (prog <= 0 || !pts || pts.length < 2) return;
      const path = cutPath(pts, prog);
      if (path.length < 2) return;
      const color = T[col] || col;
      const base = ctx.globalAlpha;
      const sd = seed === undefined ? 7 : seed;
      const width = w === undefined ? 3 : w;

      const rough = jitterPath(path, Math.min(2.6, width * 0.55), sd);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 外晕：粉笔在黑板上的散射
      ctx.globalAlpha = base * 0.22;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 2.4;
      tracePath(ctx, rough); ctx.stroke();
      // 主体
      ctx.globalAlpha = base * 0.78;
      ctx.lineWidth = width;
      tracePath(ctx, rough); ctx.stroke();
      // 芯：更亮更细，制造中间实两边虚的粉笔断面
      ctx.globalAlpha = base * 0.58;
      ctx.lineWidth = Math.max(0.7, width * 0.42);
      tracePath(ctx, path); ctx.stroke();
      ctx.restore();

      // 粉尘：沿线撒点，密度随长度
      if (width >= 2) {
        ctx.save();
        for (let i = 0; i < path.length; i += 2) {
          const r0 = u.rnd(sd + i * 2.13);
          if (r0 > 0.5) continue;
          const q = path[i];
          const rr = 0.8 + u.rnd(sd + i * 5.7) * (width * 0.6);
          ctx.globalAlpha = base * (0.06 + u.rnd(sd + i * 8.1) * 0.14);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(q[0] + (u.rnd(sd + i) - 0.5) * width * 1.8, q[1] + (u.rnd(sd + i * 3.3) - 0.5) * width * 1.8, rr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    },

    circle(ctx, x, y, r, col, p, w, seed) {
      if (r < 0.3) return;
      const n = 56;
      const pts = [];
      const prog = p === undefined ? 1 : p;
      const from = -Math.PI / 2;
      const span = Math.PI * 2 * u.clamp(prog, 0, 1);
      for (let i = 0; i <= n; i++) {
        const a = from + (span * i) / n;
        pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
      }
      MK.line(ctx, pts, col, w === undefined ? 2.6 : w, 1, seed === undefined ? 19 : seed);
    },

    // 实心圆盘（光源、遮挡片）：淡填充 + 粉笔轮廓
    disc(ctx, x, y, r, col, fill, p) {
      const prog = p === undefined ? 1 : p;
      if (prog <= 0) return;
      ctx.save();
      ctx.globalAlpha *= u.clamp(prog * 1.4, 0, 1);
      ctx.fillStyle = u.rgba(fill || T[col] || col, 0.5);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      MK.circle(ctx, x, y, r, col, prog, 2.8, 23 + r);
    },

    // ── 球体：按可见受光比例画真实明暗界线 ──
    // 界线是半椭圆 x = -c·√(r²-y²)，c = dot(light, eye)。c=0 时是直线（半相），
    // c=±1 时退化成整圆/空。这比"画个圆再盖个圆"正确：后者在 c 接近 0 时形状会错。
    sphere(ctx, x, y, r, s, view, opt) {
      const o = opt || {};
      const eye = view === 'observer' || !view ? s.eye : [0, Math.sin(view), Math.cos(view)];
      const right = (view === 'observer' || !view) ? s.right : [1, 0, 0];
      const up = (view === 'observer' || !view) ? s.up : [0, -Math.cos(view), Math.sin(view)];
      const lx = geo.dot(s.light, right), ly = geo.dot(s.light, up);
      const c = geo.dot(s.light, eye);
      const rot = Math.atan2(-ly, lx);
      const alpha = o.alpha === undefined ? 1 : o.alpha;
      const base = ctx.globalAlpha;   // 本影边界在 restore 之后还要用它还原透明度

      ctx.save();
      ctx.globalAlpha = base * alpha;
      ctx.translate(x, y);
      ctx.rotate(rot);

      // 背光面
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = o.shade || T.shade;
      ctx.fill();

      // 受光面：右半圆 + 明暗界线 x = -c·√(r²-y²) 从上下顶点收回。
      // 界线端点落在圆的**上下顶点**，不是左右端点——端点搞错会填出一个歪的月牙
      // （上一版就填错了，表现为满相时仍然全暗）。
      const cc = u.clamp(c, -1, 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.clip();
      const N = 48;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      for (let i = 0; i <= N; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / N;   // -90° → +90°，经 (r,0)
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      for (let i = 1; i <= N; i++) {
        const yy = r - (2 * r * i) / N;               // +r → -r
        const limb = Math.sqrt(Math.max(0, r * r - yy * yy));
        ctx.lineTo(-cc * limb, yy);
      }
      ctx.closePath();
      ctx.fillStyle = o.lit || T.lit;
      ctx.fill();

      // 表面：极淡的斑驳，月球不是纯白
      ctx.globalAlpha *= 0.22;
      for (let i = 0; i < 26; i++) {
        const r0 = u.rnd(913 + i * 3.1), r1 = u.rnd(417 + i * 7.7);
        const px = (r0 - 0.5) * 1.7 * r, py = (r1 - 0.5) * 1.7 * r;
        if (Math.hypot(px, py) > r * 0.96) continue;
        ctx.fillStyle = u.rgba('#8a8474', 0.05 + r0 * 0.08);
        ctx.beginPath(); ctx.arc(px, py, r * (0.03 + r1 * 0.07), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      // 本影：落在球面上的暗斑（带圆面重叠的真实偏移与半径）
      if (o.shadow && s.pos[0] > 0 && s.umbra > 0 && s.blocked > 0) {
        const off = [0, -s.pos[1], -s.pos[2]];
        const cx = (geo.dot(off, right) / s.model.bodyRadius) * r;
        const cy = (-geo.dot(off, up) / s.model.bodyRadius) * r;
        const rr = (s.umbra / s.model.bodyRadius) * r;
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = u.rgba(T.umbra, 0.55);
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // 影的边界单独描一圈红：粉笔黑板上"影从哪开始"必须看得见。
        // 这里仍在 translate+rotate 后的局部坐标里，直接用 arc，不要再走 MK.circle（那会二次变换）。
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
        ctx.strokeStyle = T.red;
        ctx.globalAlpha = base * 0.22 * alpha;
        ctx.lineWidth = Math.max(4, rr * 0.06);
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = base * 0.62 * alpha;
        ctx.lineWidth = Math.max(1.4, rr * 0.018);
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      ctx.restore();

      // 轮廓：最后画，避免被填充盖掉
      MK.circle(ctx, x, y, r, o.rim || 'white', 1, 2.2, 31 + Math.round(r));
      return { x, y, r };
    },

    // ── 文字 ──
    text(ctx, str, x, y, opt) {
      const o = opt || {};
      const size = o.size || 32;
      const family = o.face === 'body' ? FACE.body : FACE.chalk;
      const base = ctx.globalAlpha;
      const a = o.alpha === undefined ? 1 : u.clamp(o.alpha, 0, 1);
      ctx.save();
      ctx.font = `${size}px ${family}`;
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = o.baseline || 'alphabetic';
      const color = o.color || T.white;
      // 先垫一圈板色：黑板上字压线是常态，靠"擦净"解决而不是挪位置。
      // 这比给每个标签手算避让更稳——线是随参数动的，避让表会失效。
      if (o.bg) {
        ctx.globalAlpha = base * a * 0.95;
        ctx.lineWidth = Math.max(4, size * 0.36);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = o.bg;
        ctx.strokeText(String(str), x, y);
      }
      // 粉笔字：极淡外扩描边（笔画边缘的粉），再压实心
      if (o.glow !== false) {
        ctx.globalAlpha = base * a * 0.18;
        ctx.lineWidth = Math.max(2, size * 0.09);
        ctx.strokeStyle = color;
        ctx.lineJoin = 'round';
        ctx.strokeText(String(str), x, y);
      }
      ctx.globalAlpha = base * a;
      ctx.fillStyle = color;
      ctx.fillText(String(str), x, y);
      ctx.restore();
      return size;
    },

    // 折行标签：中文按字折，超过 maxLines 直接报错（不静默缩字号——那会让版面失控）
    label(ctx, str, x, y, opt) {
      const o = opt || {};
      const size = o.size || 28;
      const maxW = o.width || 520;
      const maxLines = o.maxLines || 2;
      const family = o.face === 'body' ? FACE.body : FACE.chalk;
      ctx.save();
      ctx.font = `${size}px ${family}`;
      const chars = [...String(str)];
      const lines = [];
      let cur = '';
      for (const ch of chars) {
        if (cur && ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; }
        else cur += ch;
      }
      if (cur) lines.push(cur);
      ctx.restore();
      if (lines.length > maxLines) {
        throw new Error('粉笔标签超出可读容量（' + lines.length + ' > ' + maxLines + ' 行）：' + str);
      }
      const lh = size * 1.28;
      const align = o.align || 'center';
      lines.forEach((ln, i) => {
        const yy = y + i * lh;
        MK.text(ctx, ln, x, yy, { size, color: o.color, align, face: o.face, alpha: o.alpha, bg: o.bg });
      });
      return { lines: lines.length, height: lines.length * lh };
    },

    // 数据：等宽数字感靠字距，不靠字体（LongCang 的数字就是手写体）
    number(ctx, str, x, y, opt) {
      const o = opt || {};
      MK.text(ctx, str, x, y, {
        size: o.size || 44,
        color: o.color || T.yellow,
        align: o.align || 'center',
        face: 'body',
      });
    },

    // ── 字幕（烧录） ──
    // 底条不是"半透明黑方块"，而是**擦净的一条板面**：黑板上写字前会先擦一块，
    // 这样字幕既读得清，又不像是 UI 贴在画面上。
    caption(ctx, W, H, cap, style, t) {
      const s = style || {};
      const size = s.size || Math.round(H * 0.048);
      const rawY = s.y === undefined ? 0.915 : Number(s.y);
      const y = rawY <= 1 ? Math.round(H * rawY) : Math.round(rawY);
      const k = u.clamp(Math.min((t - cap.start) / 0.08, (cap.end - t) / 0.08), 0, 1);
      ctx.save();
      ctx.globalAlpha *= k;

      ctx.font = `${size}px ${FACE.body}`;
      ctx.textAlign = 'center';
      const w = ctx.measureText(cap.text).width;
      const padX = size * 1.25, padY = size * 0.62;
      const bx = W / 2 - w / 2 - padX;
      const bw = w + padX * 2;
      const by = y - size * 0.8 - padY;
      const bh = size + padY * 2;

      ctx.fillStyle = u.rgba(T.board, 0.94);
      ctx.fillRect(bx, by, bw, bh);
      // 上下沿的擦痕：一条确定性的淡粉笔线，表示这块是擦出来的
      const sd = Math.round(cap.start * 1000) % 997;
      ctx.save();
      ctx.globalAlpha *= 0.35;
      MK.line(ctx, [[bx + 8, by + 2], [bx + bw - 8, by + 2]], 'dim', 2.4, 1, sd);
      MK.line(ctx, [[bx + 14, by + bh - 2], [bx + bw - 14, by + bh - 2]], 'dim', 2.4, 1, sd + 7);
      ctx.restore();

      MK.text(ctx, cap.text, W / 2, y, { size, color: s.color || T.white, align: 'center', face: 'body', glow: false });
      ctx.restore();
    },

    // 左上角角标（板擦槽 / 章节号）
    cornerBadge(ctx, W, H, opt, alpha) {
      const o = opt || {};
      if (o.show === false) return;
      const size = Math.round(H * 0.021);
      ctx.save();
      ctx.globalAlpha *= alpha === undefined ? 1 : alpha;
      // 贴底：字幕带在 0.912H 附近，角标必须让开，否则两行字挤在一起
      MK.text(ctx, o.text || '', 96, H - 34, { size, color: T.dim, face: 'body' });
      ctx.restore();
    },

    // 入场缩放：下限必须 > 0。返回 0 会让「if (k<=0) return」变成假门禁。
    enter(t, dur) {
      return Math.max(0.82, u.ease((t || 0) / (dur || 0.5)));
    },

    // 描出进度：段首 0.85s 内从 0 到 1，之后恒 1
    strokeAt(t, at, dur) {
      const d = dur === undefined ? 0.85 : dur;
      return u.clamp((t - (at || 0)) / d, 0, 1);
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MK;
  else root.MK = MK;
})(typeof window !== 'undefined' ? window : this);
