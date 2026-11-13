/* NativeClay: actual Clay r2 material source and original motion helpers, privately scoped. */
(()=>{'use strict';const K={};
  // ---------- math ----------
  K.clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  K.lerp = (a, b, t) => a + (b - a) * t;
  K.map = (t, a, b) => K.clamp((t - a) / (b - a)); // 0..1 progress of t through [a,b]
  K.mix2 = (p, q, t) => [K.lerp(p[0], q[0], t), K.lerp(p[1], q[1], t)];
  K.dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

  const bez = (x1, y1, x2, y2) => (x) => {
    // cubic-bezier timing, solved by bisection (deterministic, fast enough)
    let lo = 0, hi = 1, s = x;
    for (let i = 0; i < 24; i++) {
      s = (lo + hi) / 2;
      const bx = 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
      if (bx < x) lo = s; else hi = s;
    }
    return 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  };
  K.ease = {
    linear: (t) => t,
    in: (t) => t * t * t,
    out: (t) => 1 - (1 - t) ** 3,
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
    sine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    expoOut: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
    expoIn: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
    quintOut: (t) => 1 - (1 - t) ** 5,
    smooth: (t) => t * t * t * (t * (6 * t - 15) + 10),
    backOut: (t, s = 1.7) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
    // damped spring settling to 1; f = oscillations/sec feel, d = damping
    spring: (t, f = 2.2, d = 6) => (t <= 0 ? 0 : 1 - Math.exp(-d * t) * Math.cos(2 * Math.PI * f * t)),
    bezier: bez,
    swift: bez(0.65, 0, 0.35, 1),
    emph: bez(0.2, 0, 0, 1),
  };
  // eased progress through window [a,b]
  K.p = (t, a, b, e = K.ease.out) => e(K.map(t, a, b));
  // 0→1 in, hold, 1→0 out (for elements with a life span)
  K.life = (t, a, b, fin = 0.4, fout = 0.3, e = K.ease.out) =>
    Math.min(e(K.map(t, a, a + fin)), 1 - K.ease.in(K.map(t, b - fout, b)));
  // stepped time for "on twos" animation (fps of the element, not the camera)
  K.step = (t, fps = 12) => Math.floor(t * fps) / fps;

  // ---------- deterministic randomness ----------
  K.rng = (seed = 1) => {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let r = Math.imul(a ^ (a >>> 15), 1 | a);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };
  const hash = (i, s) => {
    let h = (i * 374761393 + s * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  K.noise = (x, seed = 0) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return K.lerp(hash(i, seed), hash(i + 1, seed), u) * 2 - 1;
  };

  // ---------- polylines ----------
  K.cum = (pts) => {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + K.dist(pts[i - 1], pts[i]));
    return c;
  };
  K.pointAt = (pts, frac, cum = K.cum(pts)) => {
    const L = cum[cum.length - 1] * K.clamp(frac);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < L) i++;
    const seg = cum[i] - cum[i - 1] || 1, u = (L - cum[i - 1]) / seg;
    return K.mix2(pts[i - 1], pts[i], K.clamp(u));
  };
  // stroke the first `frac` of a polyline; returns the pen tip
  K.partial = (ctx, pts, frac, cum = K.cum(pts)) => {
    if (frac <= 0 || pts.length < 2) return null;
    const L = cum[cum.length - 1] * Math.min(1, frac);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    let tip = pts[0];
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] <= L) { ctx.lineTo(pts[i][0], pts[i][1]); tip = pts[i]; continue; }
      const u = (L - cum[i - 1]) / (cum[i] - cum[i - 1]);
      tip = K.mix2(pts[i - 1], pts[i], u);
      ctx.lineTo(tip[0], tip[1]);
      break;
    }
    ctx.stroke();
    return tip;
  };
  K.line = (a, b, n = 24) => Array.from({ length: n + 1 }, (_, i) => K.mix2(a, b, i / n));
  K.arc = (cx, cy, rx, ry, a0, a1, n = 64) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = K.lerp(a0, a1, i / n);
      return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    });
  K.quad = (a, c, b, n = 40) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const s = i / n, m = 1 - s;
      return [m * m * a[0] + 2 * m * s * c[0] + s * s * b[0], m * m * a[1] + 2 * m * s * c[1] + s * s * b[1]];
    });
  // hand-made wobble: low-frequency offset along the normal
  K.wobble = (pts, amp = 2, seed = 1, freq = 0.012) => {
    const cum = K.cum(pts);
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const n = K.noise(cum[i] * freq, seed) * amp;
      return [p[0] - (dy / l) * n, p[1] + (dx / l) * n];
    });
  };


  // ---------- colour ----------
  K.hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  K.rgba = (h, a = 1) => {
    const [r, g, b] = K.hex(h);
    return `rgba(${r},${g},${b},${a})`;
  };
  K.mixColor = (h1, h2, t) => {
    const a = K.hex(h1), b = K.hex(h2);
    return `rgb(${a.map((v, i) => Math.round(K.lerp(v, b[i], t))).join(',')})`;
  };

  // cached offscreen layers (paper grain, static backgrounds)
  const cache = {};
  K.cached = (key, w, h, fn) => {
    if (!cache[key]) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      fn(c.getContext('2d'), w, h);
      cache[key] = c;
    }
    return cache[key];
  };
  K.grain = (key, w, h, amt = 10, seed = 7, mono = true) =>
    K.cached('grain:' + key, w, h, (g) => {
      const im = g.createImageData(w, h), r = K.rng(seed);
      for (let i = 0; i < im.data.length; i += 4) {
        const v = (r() - 0.5) * amt;
        im.data[i] = 128 + v;
        im.data[i + 1] = 128 + (mono ? v : (r() - 0.5) * amt);
        im.data[i + 2] = 128 + (mono ? v : (r() - 0.5) * amt);
        im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
    });


K.font=(size,family,weight=400)=>weight+' '+size+'px '+family;
const oldMK=window.MK;
/* motion-kit.js — shared animation toolkit for the knowledge-explainer upgrade (2026-10-17).
 *
 * Load after engine/core.js. Pure functions of t; no state survives between frames except
 * caches keyed by content. Everything here exists because the current batch failed at it:
 *
 *   MK.cue(...)        land a motion on the spoken word, not on "sentence start + 0.3s"
 *   MK.spring(...)     closed-form damped spring (overshoot + settle) for anything that moves
 *   MK.follow(...)     overlapping action: a value that trails a driver by a lag and spring
 *   MK.stagger(...)    cascade N items with eased start offsets (not a uniform i*k)
 *   MK.morph(...)      move one identity from layout A to layout B on an arc with spring settle
 *   MK.Cam             world camera with log-zoom, eased pans, hold, and a soft "breathe"
 *   MK.dof/MK.shadow   depth layering: blurred far layer, contact shadow, lift on pick-up
 *   MK.highlight(...)  draw-on underline / ring / box that grows to a target and decays
 *   MK.counter(...)    rolling tabular number driven by a value, never by wall time
 *   MK.pulse(...)      one-shot emphasis (scale + ring) at an event time
 *   MK.ghost(...)      motion trail: redraw the last k samples of a path with falloff
 *   MK.events          collect action events (time + kind) for the mixer — same clock as picture
 */
(() => {
  const MK = (window.MK = {});
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const TAU = Math.PI * 2;
  MK.clamp = clamp; MK.lerp = lerp;

  // ------------------------------------------------------------------ easing
  const bez = (x1, y1, x2, y2) => (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let lo = 0, hi = 1, s = x;
    for (let i = 0; i < 22; i++) {
      s = (lo + hi) / 2;
      const bx = 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
      if (bx < x) lo = s; else hi = s;
    }
    return 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  };
  MK.ease = {
    // Material-style curves: enter decelerates, exit accelerates, standard does both.
    enter: bez(0.05, 0.7, 0.1, 1),
    exit: bez(0.3, 0, 0.8, 0.15),
    standard: bez(0.2, 0, 0, 1),
    swift: bez(0.65, 0, 0.35, 1),
    anticip: bez(0.36, -0.35, 0.3, 1.0), // dips back before going (anticipation)
    linear: (u) => u,
    out3: (u) => 1 - (1 - u) ** 3,
    inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
  };
  MK.p = (t, a, d, e = MK.ease.standard) => e(clamp((t - a) / d));

  // ------------------------------------------------------------------ spring
  // Closed-form damped harmonic response of a unit step at t0 (value 0 → 1).
  // freq: oscillations/s of the undamped system; zeta < 1 overshoots. Deterministic.
  MK.spring = (t, t0, freq = 2.2, zeta = 0.45) => {
    const x = t - t0;
    if (x <= 0) return 0;
    const w = TAU * freq;
    if (zeta >= 1) return 1 - (1 + w * x) * Math.exp(-w * x);
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w * x) * (Math.cos(wd * x) + (zeta * w / wd) * Math.sin(wd * x));
  };
  // Spring between two values, starting at t0.
  MK.springTo = (t, t0, from, to, freq, zeta) => lerp(from, to, MK.spring(t, t0, freq, zeta));
  // A chain of spring targets: [{t, v}] — each new target springs from the current value.
  MK.springTrack = (t, keys, freq = 2.0, zeta = 0.55) => {
    let v = keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      if (t < keys[i].t) break;
      const start = v;
      const next = keys[i + 1];
      const tEnd = next && t >= next.t ? next.t : t;
      v = lerp(start, keys[i].v, MK.spring(tEnd, keys[i].t, keys[i].freq || freq, keys[i].zeta || zeta));
    }
    return v;
  };

  // ------------------------------------------------------------------ cues (word timing)
  // WORDS comes from kit/align-words.py: sentences[id].chars = [[char, a, b] | null, ...]
  // MK.cue('c04s02', '十八') → time the phrase starts being spoken (first match, or nth).
  MK.cue = (sid, phrase, o = {}) => {
    const S = window.WORDS && window.WORDS.sentences[sid];
    if (!S) throw new Error('MK.cue: no word timing for ' + sid);
    const text = S.text;
    let idx = -1, from = 0;
    for (let k = 0; k <= (o.nth || 0); k++) { idx = text.indexOf(phrase, from); from = idx + 1; if (idx < 0) break; }
    if (idx < 0) throw new Error(`MK.cue: "${phrase}" not in ${sid}: ${text}`);
    const chars = S.chars.slice(idx, idx + phrase.length).filter(Boolean);
    if (!chars.length) throw new Error(`MK.cue: "${phrase}" in ${sid} has only punctuation`);
    const a = chars[0][1], b = chars[chars.length - 1][2];
    return o.end ? b + (o.offset || 0) : a + (o.offset || 0);
  };
  // Window covering the phrase: {a, b, d}
  MK.span = (sid, phrase, o = {}) => {
    const a = MK.cue(sid, phrase, o), b = MK.cue(sid, phrase, { ...o, end: true });
    return { a, b, d: Math.max(0.05, b - a) };
  };

  // ------------------------------------------------------------------ cascades
  // Start time for item i of n across a window of length d (seconds); items share `each`
  // seconds of motion. curve shapes the cascade (front-loaded by default: first items go fast).
  MK.stagger = (i, n, t0, d, curve = (u) => 1 - (1 - u) ** 2) => t0 + d * curve(n <= 1 ? 0 : i / (n - 1));
  // Progress of item i in a cascade with per-item duration `each`.
  MK.cascade = (t, i, n, t0, d, each = 0.45, e = MK.ease.enter, curve) => e(clamp((t - MK.stagger(i, n, t0, d, curve)) / each));

  // ------------------------------------------------------------------ overlapping action
  // Value that follows driver(t) with a delay and spring-like smoothing (secondary motion).
  // Implemented as a short exponentially weighted history so it stays a pure function of t.
  MK.follow = (t, driver, lag = 0.08, smooth = 0.12, samples = 10) => {
    let acc = 0, wsum = 0;
    for (let k = 0; k < samples; k++) {
      const dt = lag + (k / (samples - 1)) * smooth * 3;
      const w = Math.exp(-(dt - lag) / Math.max(1e-3, smooth));
      acc += driver(t - dt) * w; wsum += w;
    }
    return acc / wsum;
  };

  // ------------------------------------------------------------------ morph between layouts
  // Move one identity from point A to point B: arc lift, eased travel, spring settle,
  // optional squash along travel direction. Returns {x, y, sx, sy, rot, u}.
  MK.morph = (t, t0, d, A, B, o = {}) => {
    const u = clamp((t - t0) / d);
    const e = (o.ease || MK.ease.swift)(u);
    const lift = (o.lift ?? 40) * Math.sin(Math.PI * e);
    let x = lerp(A[0], B[0], e), y = lerp(A[1], B[1], e) - lift;
    // settle: tiny spring overshoot after arrival, along travel direction
    if (u >= 1 && o.settle !== false) {
      const s = 1 - MK.spring(t, t0 + d, o.freq || 3, o.zeta || 0.35);
      const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
      x += (dx / L) * s * (o.overshoot ?? 6); y += (dy / L) * s * (o.overshoot ?? 6);
    }
    // squash/stretch from instantaneous speed (|de/du| peaks mid-travel)
    const sp = u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
    const k = (o.stretch ?? 0.18) * sp;
    const rot = Math.atan2(B[1] - A[1], B[0] - A[0]);
    return { x, y, sx: 1 + k, sy: 1 - k * 0.6, rot, u, e };
  };

  // ------------------------------------------------------------------ camera
  // Keys: {t, x, y, z, r?, hold?, e?}. Zoom in log space; optional breathing that never
  // accumulates (bounded sinusoid, amplitude scales down while moving).
  MK.Cam = class {
    constructor(keys, o = {}) { this.keys = keys; this.breathe = o.breathe ?? 0.004; this.W = o.W || 1920; this.H = o.H || 1080; }
    at(t) {
      const K = this.keys;
      let c;
      if (t <= K[0].t) c = { ...K[0] };
      else if (t >= K[K.length - 1].t) c = { ...K[K.length - 1] };
      else {
        let i = 1; while (t >= K[i].t) i++;
        const a = K[i - 1], b = K[i];
        const ht = a.t + (a.hold || 0);
        const u = t < ht ? 0 : (b.e || MK.ease.swift)(clamp((t - ht) / (b.t - ht)));
        c = { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), u)), r: lerp(a.r || 0, b.r || 0, u), moving: u > 0 && u < 1 };
      }
      const amp = this.breathe * (c.moving ? 0.3 : 1);
      c.z *= 1 + amp * Math.sin(t * 0.55);
      c.x += amp * 600 * Math.sin(t * 0.31 + 1.3);
      c.y += amp * 350 * Math.sin(t * 0.43 + 0.4);
      return c;
    }
    apply(ctx, t) {
      const c = this.at(t);
      ctx.translate(this.W / 2, this.H / 2);
      if (c.r) ctx.rotate(c.r);
      ctx.scale(c.z, c.z);
      ctx.translate(-c.x, -c.y);
      return c;
    }
    // world → screen for labels that must stay screen-crisp while following an object
    toScreen(t, x, y) {
      const c = this.at(t), cs = Math.cos(c.r || 0), sn = Math.sin(c.r || 0);
      const dx = (x - c.x) * c.z, dy = (y - c.y) * c.z;
      return [this.W / 2 + dx * cs - dy * sn, this.H / 2 + dx * sn + dy * cs];
    }
  };

  // ------------------------------------------------------------------ depth
  // Draw fn into a cached offscreen layer and composite it blurred (far plane / focus pull).
  const layers = {};
  MK.layer = (key, W, H) => {
    if (!layers[key]) { const c = document.createElement('canvas'); c.width = W; c.height = H; layers[key] = c; }
    const c = layers[key], g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    return { canvas: c, ctx: g };
  };
  MK.dof = (ctx, key, W, H, blurPx, alpha, fn) => {
    const L = MK.layer(key, W, H);
    fn(L.ctx);
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (blurPx > 0.2) ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    ctx.drawImage(L.canvas, 0, 0);
    ctx.restore();
  };
  // Contact shadow under an object at height h (0 = resting). Wider/softer as it lifts.
  MK.shadow = (ctx, x, y, w, h = 0, o = {}) => {
    const k = 1 + h / 60;
    ctx.save();
    ctx.globalAlpha *= (o.alpha ?? 0.22) / k;
    ctx.filter = `blur(${(2 + h * 0.25).toFixed(1)}px)`;
    ctx.fillStyle = o.color || '#000';
    ctx.beginPath(); ctx.ellipse(x, y, w * 0.5 * k, w * 0.12 * k, 0, 0, TAU); ctx.fill();
    ctx.restore();
  };

  // ------------------------------------------------------------------ emphasis
  // Hand-drawn style mark that draws on at t0 over d, holds, then decays at tOut.
  // kind: 'underline' | 'box' | 'ring' | 'bracket'. rect = [x, y, w, h].
  MK.highlight = (ctx, t, t0, rect, o = {}) => {
    const d = o.d || 0.42, draw = MK.ease.enter(clamp((t - t0) / d));
    if (draw <= 0) return;
    const out = o.tOut != null ? MK.ease.exit(clamp((t - o.tOut) / 0.3)) : 0;
    if (out >= 1) return;
    const [x, y, w, h] = rect;
    ctx.save();
    ctx.globalAlpha *= 1 - out;
    ctx.strokeStyle = o.color || '#E8412B';
    ctx.lineWidth = o.width || 4;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    const kind = o.kind || 'underline';
    if (kind === 'underline') {
      const yy = y + h + (o.gap ?? 8);
      ctx.moveTo(x, yy); ctx.lineTo(x + w * draw, yy + Math.sin(draw * 3) * 1.2);
    } else if (kind === 'box') {
      const per = 2 * (w + h), L = per * draw, pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
      let acc = 0; ctx.moveTo(x, y);
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + seg >= L) { const u = (L - acc) / seg; ctx.lineTo(lerp(pts[i - 1][0], pts[i][0], u), lerp(pts[i - 1][1], pts[i][1], u)); break; }
        ctx.lineTo(...pts[i]); acc += seg;
      }
    } else if (kind === 'ring') {
      const cx = x + w / 2, cy = y + h / 2, a0 = -Math.PI * 0.6;
      ctx.ellipse(cx, cy, w * 0.6, h * 0.75, -0.06, a0, a0 + TAU * 1.04 * draw);
    } else if (kind === 'bracket') {
      ctx.moveTo(x + 14, y); ctx.lineTo(x, y); ctx.lineTo(x, y + h * draw); if (draw > 0.98) ctx.lineTo(x + 14, y + h);
    }
    ctx.stroke();
    ctx.restore();
  };
  // One-shot pulse at t0: returns {s, ring, a} — scale bump and an expanding ring radius/alpha.
  MK.pulse = (t, t0, o = {}) => {
    const x = t - t0;
    if (x < 0 || x > (o.d || 0.7)) return { s: 1, ring: 0, a: 0 };
    const u = x / (o.d || 0.7);
    return { s: 1 + (o.amp ?? 0.12) * Math.sin(Math.PI * Math.min(1, x / 0.28)) * Math.exp(-x * 4), ring: (o.r ?? 60) * MK.ease.out3(u), a: (1 - u) ** 2 };
  };

  // ------------------------------------------------------------------ numbers
  // Rolling tabular counter. value is the *current true value* (a number); digits roll
  // vertically between integers so the display never jumps or shows a false value for long.
  // Fast counts (more than ~4 per second) should pass roll:false and an integer value:
  // a digit that is always mid-roll reads as a blur.
  MK.counter = (ctx, value, x, y, o = {}) => {
    const size = o.size || 64, digits = o.digits || String(Math.ceil(Math.abs(o.max ?? value))).length;
    ctx.save();
    ctx.font = `${o.weight || 800} ${size}px ${o.family || 'sans-serif'}`;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const adv = ctx.measureText('0').width + (o.track ?? -size * 0.03);
    const x0 = o.align === 'right' ? x - digits * adv : o.align === 'center' ? x - (digits * adv) / 2 : x;
    ctx.beginPath(); ctx.rect(x0 - 4, y - size * 0.95, digits * adv + 8, size * 1.15); ctx.clip();
    const v = Math.max(0, value);
    for (let i = 0; i < digits; i++) {
      const place = 10 ** (digits - 1 - i);
      const raw = v / place;               // e.g. 18.4 / 10 = 1.84 for the tens digit
      const d0 = Math.floor(raw) % 10;
      // roll only during the last fraction of the lower place's cycle
      const lowerFrac = place === 1 ? raw - Math.floor(raw) : ((v % place) / place);
      const roll = place === 1 ? MK.ease.inOut(clamp((lowerFrac - 0.5) * 2)) : MK.ease.inOut(clamp((lowerFrac - 0.9) * 10));
      const leading = place > 1 && v < place && !o.zeros;
      const noRoll = o.roll === false;
      ctx.fillStyle = o.color || '#111';
      if (leading) { if (o.ghost) { ctx.globalAlpha = o.ghost; ctx.fillText('0', x0 + i * adv, y); ctx.globalAlpha = 1; } continue; }
      if (noRoll) { ctx.fillText(String(Math.floor(Math.round(v) / place) % 10), x0 + i * adv, y); continue; }
      ctx.fillText(String(d0), x0 + i * adv, y - roll * size * 1.05);
      if (roll > 0) ctx.fillText(String((d0 + 1) % 10), x0 + i * adv, y + (1 - roll) * size * 1.05);
    }
    ctx.restore();
    return { x0, w: digits * adv };
  };

  // ------------------------------------------------------------------ trails
  // Draw fn(x, y, alpha) at k earlier samples of path(t) for a motion trail.
  MK.ghost = (t, path, fn, o = {}) => {
    const k = o.k || 6, dt = o.dt || 1 / 60;
    for (let i = k; i >= 1; i--) { const [x, y] = path(t - i * dt * (o.spacing || 2)); fn(x, y, (o.alpha ?? 0.35) * (1 - i / (k + 1))); }
  };

  // ------------------------------------------------------------------ events for the mixer
  // Scenes call MK.events.add(...) while building their plan (not per frame). The mixer
  // reads window.__motionEvents through the existing renderer/qa path.
  MK.events = {
    list: [],
    add(time, kind, o = {}) { this.list.push({ time: +time.toFixed(4), kind, duration: o.duration || 0.2, gainDb: o.gainDb ?? -24, pan: o.pan ?? 0, note: o.note || '', id: o.id || `${kind}-${this.list.length}` }); return time; },
    sorted() { return [...this.list].sort((a, b) => a.time - b.time); },
  };
})();

const MK=window.MK;window.MK=oldMK;
const Material=(()=>{const E=K.ease,TAU=Math.PI*2;
  // ---------- palette ----------
  const C = {
    skyTop: '#F1D2BF', skyLow: '#F8E8D9', glow: '#FFF1D6',
    ground: '#E4CAA4', groundHi: '#EFDcbd', groundLo: '#D3B48A',
    hillA: '#CAD4B4', hillB: '#E9CFB6',
    ink: '#4A3A2E', mute: '#8C7462',
    leaf: { base: '#A2BE8B', hi: '#D2E3B9', lo: '#6F9065' },
    leaf2: { base: '#98B582', hi: '#C7DBAE', lo: '#66875C' },
    stem: { base: '#8DAC79', hi: '#BBD3A4', lo: '#5D7D55' },
    chl: { base: '#5F8C56', hi: '#8DB678', lo: '#3D673B' },
    grana: { base: '#4C7A45', hi: '#7AA868', lo: '#2F5530' },
    guard: { base: '#B8D09F', hi: '#E1EDCF', lo: '#7F9F70' },
    pot: { base: '#D49B7B', hi: '#EDC4A8', lo: '#A86F55' },
    potRim: { base: '#DCA685', hi: '#F2CDB2', lo: '#AF7659' },
    soil: { base: '#86624D', hi: '#A58069', lo: '#5A4033' },
    root: '#EBD9BE',
    sun: { base: '#F4C46B', hi: '#FCE6AE', lo: '#DC9E4C' },
    water: { base: '#9AC5E3', hi: '#DDF0FA', lo: '#6698C2' },
    cC: { base: '#7B7F86', hi: '#AAAEB4', lo: '#53575E' },
    cO: { base: '#D0D4D8', hi: '#F3F4F5', lo: '#A3A9AF' },
    o2: { base: '#F2F5F4', hi: '#FFFFFF', lo: '#BFCAD3' },
    glu: { base: '#EDBC58', hi: '#FADF98', lo: '#C68A31' },
    card: { base: '#F6ECDC', hi: '#FFF9EE', lo: '#D9C7AB' },
    tile: { base: '#E8A587', hi: '#F7CDB8', lo: '#C17A5F' },
    pill: { base: '#F7EEDF', hi: '#FFFBF3', lo: '#DCCBB2' },
    light: '#FFE7A8',
  };

  // ---------- helpers ----------
  const scaleOf = (ctx) => { const m = ctx.getTransform(); return Math.hypot(m.a, m.b); };
  const h2 = (n) => n.toString(16).padStart(2, '0');
  const mixHex = (a, b, t) => { const p = K.hex(a), q = K.hex(b); return '#' + p.map((v, i) => h2(Math.round(K.lerp(v, q[i], K.clamp(t))))).join(''); };
  const mixCol = (c1, c2, t) => ({ base: mixHex(c1.base, c2.base, t), hi: mixHex(c1.hi, c2.hi, t), lo: mixHex(c1.lo, c2.lo, t) });
  // jelly: damped cosine; sx = 1 + j, sy = 1 - j (opposite phase keeps the volume)
  const jel = (t, t0, amp = 0.22, f = 2.4, d = 5.2) => { const u = t - t0; return u < 0 ? 0 : amp * Math.exp(-d * u) * Math.cos(TAU * f * u); };
  // pop in from nothing, stretched first, then wobble to rest
  const pop = (t, t0, dur = 0.34, amp = 0.2) => {
    if (t < t0) return null;
    const u = K.map(t, t0, t0 + dur), s = E.out(u);
    const j = u < 1 ? -0.18 * Math.sin(Math.PI * u) : jel(t, t0 + dur, amp);
    return { s, sx: s * (1 + j), sy: s * (1 - j) };
  };
  // fall from above, stretched while falling, squash on landing, jelly settle
  const fall = (t, t0, t1, h, amp = 0.26) => {
    if (t < t0) return null;
    if (t < t1) { const u = (t - t0) / (t1 - t0); return { dy: -h * (1 - u * u), sx: 1 - 0.1 * u, sy: 1 + 0.16 * u }; }
    const j = jel(t, t1, amp, 2.3, 5.2);
    return { dy: 0, sx: 1 + j, sy: 1 - j };
  };
  const squashAt = (ctx, ax, ay, sx, sy, dy = 0, rot = 0) => {
    ctx.translate(ax, ay + dy);
    if (rot) ctx.rotate(rot);
    ctx.scale(sx, sy);
    if (rot) ctx.rotate(-rot);
    ctx.translate(-ax, -ay);
  };
  const qb = (a, c, b, u) => { const m = 1 - u; return [m * m * a[0] + 2 * m * u * c[0] + u * u * b[0], m * m * a[1] + 2 * m * u * c[1] + u * u * b[1]]; };

  // ---------- clay texture (fingerprints, pits, tool marks), cached ----------
  function clayTile() {
    return K.cached('clay-tile', 512, 512, (g, w, h) => {
      const im = g.createImageData(w, h), rnd = K.rng(23);
      for (let i = 0; i < im.data.length; i += 4) {
        const v = 128 + (rnd() - 0.5) * 16;
        im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const r = K.rng(9);
      const wrap = (fn) => { for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) { g.save(); g.translate(ox, oy); fn(); g.restore(); } };
      // soft lumps
      for (let k = 0; k < 70; k++) {
        const x = r() * w, y = r() * h, rr = 18 + r() * 70, lt = r() < 0.5;
        wrap(() => {
          const gr = g.createRadialGradient(x, y, 0, x, y, rr);
          gr.addColorStop(0, lt ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)');
          gr.addColorStop(1, 'rgba(128,128,128,0)');
          g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
        });
      }
      // fingerprints: sets of concentric wavy ridges, partial arcs
      for (let k = 0; k < 7; k++) {
        const x = r() * w, y = r() * h, rot = r() * TAU, n = 9 + Math.floor(r() * 7), ex = 0.6 + r() * 0.3;
        const a0 = r() * TAU, span = 1.6 + r() * 2.4;
        for (let i = 0; i < n; i++) {
          const rad = 6 + i * 3.4;
          wrap(() => {
            g.save(); g.translate(x, y); g.rotate(rot); g.scale(1, ex);
            g.beginPath();
            for (let s = 0; s <= 40; s++) {
              const a = a0 + (span * s) / 40, rr = rad + Math.sin(a * 5 + i) * 0.7;
              const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
              s ? g.lineTo(px, py) : g.moveTo(px, py);
            }
            g.restore();
            g.lineWidth = 1.1;
            g.strokeStyle = i % 2 ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.12)';
            g.stroke();
          });
        }
      }
      // tool smears
      for (let k = 0; k < 26; k++) {
        const x = r() * w, y = r() * h, a = r() * TAU, l = 30 + r() * 90, bend = (r() - 0.5) * 30;
        wrap(() => {
          g.beginPath(); g.moveTo(x, y);
          g.quadraticCurveTo(x + Math.cos(a) * l / 2 - Math.sin(a) * bend, y + Math.sin(a) * l / 2 + Math.cos(a) * bend, x + Math.cos(a) * l, y + Math.sin(a) * l);
          g.lineWidth = 2 + r() * 3; g.strokeStyle = 'rgba(255,255,255,0.06)'; g.stroke();
          g.translate(1.2, 1.6); g.lineWidth = 1.2; g.strokeStyle = 'rgba(0,0,0,0.06)'; g.stroke();
        });
      }
      // pits
      for (let k = 0; k < 520; k++) {
        const x = r() * w, y = r() * h, rr = 0.6 + r() * 1.5;
        wrap(() => {
          g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(x + 0.7, y + 0.8, rr, 0, TAU); g.fill();
          g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
        });
      }
    });
  }
  let TEX = null;
  const texPat = (ctx) => (TEX || (TEX = ctx.createPattern(clayTile(), 'repeat')));

  // ---------- the clay renderer ----------
  // path(c) builds the outline in current coords; (cx,cy,r) = rough centre/radius for shading.
  // o: h (height above backdrop → cast shadow), sa, ir (inner-shadow size), tex, ts, spec, inner(ctx)
  function clay(ctx, path, cx, cy, r, col, o = {}) {
    const S = scaleOf(ctx), a = ctx.globalAlpha, h = o.h ?? 8;
    ctx.save();
    if (h > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(130,84,56,${o.sa ?? 0.3})`;
      ctx.shadowBlur = Math.min(90, (o.sb ?? h * 1.7) * S);
      ctx.shadowOffsetX = h * 0.65 * S; ctx.shadowOffsetY = h * 0.95 * S;
      ctx.beginPath(); path(ctx); ctx.fillStyle = col.lo; ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.45, r * 0.05, cx - r * 0.08, cy - r * 0.08, r * 1.3);
    g.addColorStop(0, col.hi); g.addColorStop(0.5, col.base); g.addColorStop(1, col.lo);
    ctx.beginPath(); path(ctx); ctx.fillStyle = g; ctx.fill();
    ctx.save();
    ctx.beginPath(); path(ctx); ctx.clip();
    const P = texPat(ctx);
    P.setTransform(new DOMMatrix().translate(cx + (o.tx || 0), cy + (o.ty || 0)).scale(o.ts || 0.5));
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = a * (o.tex ?? 0.6);
    ctx.fillStyle = P; ctx.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = a;
    if (o.inner) o.inner(ctx);
    const ir = o.ir ?? r;
    const ring = () => { ctx.beginPath(); ctx.rect(cx - r * 4, cy - r * 4, r * 8, r * 8); path(ctx); };
    ctx.fillStyle = '#000';
    ctx.shadowColor = `rgba(70,44,30,${o.occ ?? 0.36})`;
    ctx.shadowBlur = Math.min(70, ir * 0.32 * S);
    ctx.shadowOffsetX = -ir * 0.11 * S; ctx.shadowOffsetY = -ir * 0.15 * S;
    ring(); ctx.fill('evenodd');
    ctx.shadowColor = `rgba(255,251,242,${o.rim ?? 0.6})`;
    ctx.shadowBlur = Math.min(40, ir * 0.14 * S);
    ctx.shadowOffsetX = ir * 0.06 * S; ctx.shadowOffsetY = ir * 0.08 * S;
    ring(); ctx.fill('evenodd');
    ctx.restore();
    if ((o.spec ?? 0.35) > 0) {
      const sx = cx - r * 0.4, sy = cy - r * 0.46;
      const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.42);
      sg.addColorStop(0, `rgba(255,255,255,${o.spec ?? 0.35})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save(); ctx.beginPath(); path(ctx); ctx.clip();
      ctx.fillStyle = sg; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- shapes ----------
  function smoothClosed(c, pts) {
    const n = pts.length, mid = (i) => { const p = pts[i % n], q = pts[(i + 1) % n]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
    const s = mid(n - 1);
    c.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) { const m = mid(i); c.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]); }
    c.closePath();
  }
  const polarPts = (cx, cy, rf, n = 64) => Array.from({ length: n }, (_, i) => { const th = (i / n) * TAU, r = rf(th); return [cx + Math.cos(th) * r, cy + Math.sin(th) * r]; });
  const polarPath = (cx, cy, rf, n = 64) => { const pts = polarPts(cx, cy, rf, n); return (c) => smoothClosed(c, pts); };
  const irr = (seed, amp = 0.04) => {
    const r = K.rng(seed), p = [r() * TAU, r() * TAU, r() * TAU];
    return (th) => 1 + amp * (0.55 * Math.sin(2 * th + p[0]) + 0.3 * Math.sin(3 * th + p[1]) + 0.18 * Math.sin(5 * th + p[2]));
  };
  const ball = (ctx, x, y, r, col, seed, o = {}) => { const k = irr(seed, o.amp ?? 0.045); clay(ctx, polarPath(x, y, (th) => r * k(th), 48), x, y, r, col, o); };
  const hexR = (R, th, rot = -Math.PI / 2) => {
    const ph = (((th - rot) % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3);
    return (R * Math.cos(Math.PI / 6)) / Math.cos(ph - Math.PI / 6);
  };
  const hexSoft = (R, th) => K.lerp(hexR(R, th), R * 0.94, 0.16);
  const dropR = (R, th, tip) => R * (1 + tip * 0.95 * Math.pow(Math.max(0, -Math.sin(th)), 5));


return{C,clay,ball,polarPath,irr,jel,pop,fall,squashAt};})();
const N=Material,C={blue:'#5788a5',soap:{base:'#b5cda3',hi:'#e4eecf',lo:'#809967'}};const D={line(g,pts,col,w=2){g.save();g.strokeStyle=col;g.lineWidth=w;g.lineCap='round';g.lineJoin='round';g.beginPath();pts.forEach((p,i)=>i?g.lineTo(...p):g.moveTo(...p));g.stroke();g.restore()},circle(g,x,y,r,fill,stroke,w=2){g.beginPath();g.arc(x,y,r,0,Math.PI*2);if(fill){g.fillStyle=fill;g.fill()}if(stroke){g.strokeStyle=stroke;g.lineWidth=w;g.stroke()}}};
 function lumpRaw(g,x,y,rx,ry,col,seed=1,o={}){const q=N.irr(seed,.023);N.clay(g,N.polarPath(x,y,a=>rx*ry/Math.hypot(ry*Math.cos(a),rx*Math.sin(a))*q(a),72),x,y,Math.max(rx,ry),col,{h:8,sa:.23,ir:Math.min(rx,ry),tex:.63,ts:.56,spec:.4,occ:.25,rim:.52,...o})}
 C.lump=(g,x,y,rx,ry,col=C.oil,seed=1,sx=1,sy=1)=>{if(rx<.1||ry<.1)return;const key='clay-'+col.base+'-'+seed;const im=K.cached(key,384,384,c=>lumpRaw(c,192,192,138,138,col,seed));g.save();g.translate(x,y);g.scale(sx,sy);g.drawImage(im,-rx*192/138,-ry*192/138,rx*384/138,ry*384/138);g.restore()};
 C.molecule=(g,x,y,a,scale=1,headPulse=0,tailPulse=0)=>{g.save();g.translate(x,y);g.rotate(a);g.scale(scale,scale);const tr=g.getTransform(),hi=Math.hypot(tr.a,tr.b)>1.3,f=hi?6:1,im=K.cached('clay-molecule'+(hi?'-hi':''),240*f,110*f,c=>{c.scale(f,f);D.line(c,[[50,55],[58,52],[66,59],[74,52],[82,58],[91,54]],'#a46c3f',12);D.line(c,[[50,53],[58,50],[66,57],[74,50],[82,56],[91,52]],'#edb983',6);N.ball(c,50,55,12,N.C.water,7,{h:3,tex:.65,ir:10})});g.drawImage(im,-50,-55,240,110);if(headPulse>0){g.save();g.globalAlpha*=headPulse;D.circle(g,0,0,20,null,C.blue,3);g.restore()}if(tailPulse>0){g.save();g.globalAlpha*=tailPulse;D.line(g,[[13,-15],[43,-15]],'#b97839',4);g.restore()}g.restore()};
 C.sponge=(g,x,y,squeeze=0)=>{g.save();g.translate(x,y);const sx=1+.09*squeeze;g.scale(sx,1/sx);const im=K.cached('green-sponge',500,220,c=>{lumpRaw(c,250,110,175,60,C.soap,8);for(let i=0;i<15;i++)D.circle(c,130+i%5*60,85+Math.floor(i/5)*22,3,'#869f79')});g.drawImage(im,-250,-110);g.restore()};
const META={
  "schema": "NativeClayCatalog/1",
  "styleId": "clay",
  "runtime": "native-clay.js",
  "global": "NativeClay",
  "sourceRevision": "rev2",
  "families": [
    {
      "id": "split-merge",
      "name": "面积守恒的拆分与合并",
      "classification": "adapted-native",
      "sourceUnits": [
        "c01s02",
        "c04s01",
        "c04s02"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 9,
      "maxDuration": 45,
      "semantic": "The visible cross-section union and necks are renormalized from the actual polygon area; descendants preserve their root lineage.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6,
        "parts": {
          "min": 2,
          "max": 3,
          "labelMaxCodepoints": 8,
          "maxMinWeightRatio": 16
        }
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    },
    {
      "id": "interface-bind",
      "name": "同一头尾对象在界面附着",
      "classification": "adapted-native",
      "sourceUnits": [
        "c02s01",
        "c02s04",
        "c03s01",
        "c03s02",
        "c04s03"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 8,
      "maxDuration": 45,
      "semantic": "The tail crosses the actual material boundary while the head remains on the outside; attachment count is evaluated from actual arrivals.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6,
        "agents": {
          "min": 4,
          "max": 12
        }
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    },
    {
      "id": "shear-break",
      "name": "受力、细颈与分裂",
      "classification": "adapted-native",
      "sourceUnits": [
        "c04s01",
        "c04s02",
        "c04s04"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 9,
      "maxDuration": 45,
      "semantic": "A material sponge moves in the force direction. Deformation and branching depend on the declared force threshold, not a text-only counter.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6,
        "parts": {
          "min": 2,
          "max": 3,
          "labelMaxCodepoints": 8,
          "maxMinWeightRatio": 16
        }
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    },
    {
      "id": "lineage-track",
      "name": "同一批后代的出处与路径",
      "classification": "adapted-native",
      "sourceUnits": [
        "c01s04",
        "c06s01",
        "c07s03",
        "c08s02",
        "c08s03"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 12,
      "maxDuration": 45,
      "semantic": "Parent origins and descendant identity remain in state; the visible trace joins their actual history rather than spawning new untracked drops.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6,
        "parts": {
          "min": 2,
          "max": 3,
          "labelMaxCodepoints": 8,
          "maxMinWeightRatio": 16
        }
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    },
    {
      "id": "channel-transport",
      "name": "实际通道中的流动搬运",
      "classification": "adapted-native",
      "sourceUnits": [
        "c06s01",
        "c06s02",
        "c06s04"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 12,
      "maxDuration": 45,
      "semantic": "A declared channel carries the same material objects to the collector. The channel and actual drawn particles are checked against actual drawn obstacles.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    },
    {
      "id": "focus-return",
      "name": "现场对象放大并原位返回",
      "classification": "adapted-native",
      "sourceUnits": [
        "c02s01",
        "c03s01",
        "c05s01",
        "c06s01"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 8,
      "maxDuration": 45,
      "semantic": "The selected actual identity leaves its context, magnifies with a source leader, and returns; it is never duplicated in the context.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    },
    {
      "id": "alternative-compare",
      "name": "明确条件的替代分支",
      "classification": "adapted-native",
      "sourceUnits": [
        "c06s03"
      ],
      "sourceImplementation": "source/clay-stage.js; source/narrative-stage.js; source/chapters/*; source/episode/native.js",
      "minDuration": 12,
      "maxDuration": 45,
      "semantic": "Two explicitly labelled conditional copies share initial source identities; a closed gate retains the material, an open gate transports it.",
      "input": {
        "nodes": {
          "min": 1,
          "max": 4
        },
        "value": {
          "min": 0.01,
          "max": 10000,
          "withinViewMaxMinRatio": 16
        },
        "labelMaxCodepoints": 16,
        "unitMaxCodepoints": 6
      },
      "motion": {
        "sourceFocusOutSeconds": 1.42,
        "sourceFocusReturnSeconds": 2.22,
        "sourceShearNeckSeconds": 1.871,
        "sourceShearBreakSeconds": 2.321,
        "sourceFlowSeconds": 7.23,
        "fixedLocalClock": true,
        "longerDuration": "Reading/identity verification continues; native motion windows are not uniformly stretched."
      },
      "events": {
        "sourceSynth": "source/audio/foley-mix.py",
        "clock": "same pure state action clock; actual arrival/threshold/break times",
        "tailSeconds": 0.35
      }
    }
  ]
}
,SCHEMA={
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "NativeClayRecipe/1",
  "oneOf": [
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "parts",
        "direction"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "parts": {
          "type": "array",
          "minItems": 2,
          "maxItems": 3,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "weight"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8
              },
              "weight": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              }
            },
            "additionalProperties": false
          }
        },
        "direction": {
          "enum": [
            "split",
            "merge"
          ]
        },
        "mechanism": {
          "const": "split-merge"
        },
        "family": {
          "const": "split-merge"
        },
        "duration": {
          "type": "number",
          "minimum": 9,
          "maximum": 45
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "agents"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "agents": {
          "type": "integer",
          "minimum": 4,
          "maximum": 12
        },
        "mechanism": {
          "const": "interface-bind"
        },
        "family": {
          "const": "interface-bind"
        },
        "duration": {
          "type": "number",
          "minimum": 8,
          "maximum": 45
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "parts",
        "force",
        "threshold"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "parts": {
          "type": "array",
          "minItems": 2,
          "maxItems": 3,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "weight"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8
              },
              "weight": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              }
            },
            "additionalProperties": false
          }
        },
        "force": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "threshold": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 100
        },
        "mechanism": {
          "const": "shear-break"
        },
        "family": {
          "const": "shear-break"
        },
        "duration": {
          "type": "number",
          "minimum": 9,
          "maximum": 45
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "parts"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "parts": {
          "type": "array",
          "minItems": 2,
          "maxItems": 3,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "weight"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8
              },
              "weight": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              }
            },
            "additionalProperties": false
          }
        },
        "mechanism": {
          "const": "lineage-track"
        },
        "family": {
          "const": "lineage-track"
        },
        "duration": {
          "type": "number",
          "minimum": 12,
          "maximum": 45
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "route",
        "obstacles"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "route": {
          "type": "array",
          "minItems": 2,
          "maxItems": 12,
          "items": {
            "type": "object",
            "required": [
              "x",
              "y"
            ],
            "properties": {
              "x": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              },
              "y": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              }
            },
            "additionalProperties": false
          }
        },
        "obstacles": {
          "type": "array",
          "maxItems": 8,
          "items": {
            "type": "object",
            "required": [
              "id",
              "x",
              "y",
              "r"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "x": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              },
              "y": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              },
              "r": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 0.15
              }
            },
            "additionalProperties": false
          }
        },
        "mechanism": {
          "const": "channel-transport"
        },
        "family": {
          "const": "channel-transport"
        },
        "duration": {
          "type": "number",
          "minimum": 12,
          "maximum": 45
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "focusId"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            },
            "return": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "focusId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "mechanism": {
          "const": "focus-return"
        },
        "family": {
          "const": "focus-return"
        },
        "duration": {
          "type": "number",
          "minimum": 8,
          "maximum": 45
        }
      },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": [
        "mechanism",
        "title",
        "nodes",
        "unit",
        "valueUnit",
        "route",
        "obstacles",
        "conditions"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 48,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 44
        },
        "unit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "valueUnit": {
          "type": "string",
          "minLength": 1,
          "maxLength": 6
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2
        },
        "language": {
          "enum": [
            "zh-CN",
            "en"
          ]
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "value"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "value": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 10000
              },
              "color": {
                "type": "string",
                "pattern": "^#[0-9A-Fa-f]{6}$"
              }
            },
            "additionalProperties": false
          }
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "cueTimes": {
          "type": "object",
          "required": [],
          "properties": {
            "act": {
              "type": "number",
              "minimum": 0,
              "maximum": 45
            }
          },
          "additionalProperties": false
        },
        "labels": {
          "type": "object",
          "required": [],
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "parts": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "attached": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "transported": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "remaining": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "force": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "threshold": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "alternative": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "magnified": {
              "type": "string",
              "minLength": 1,
              "maxLength": 28
            },
            "total": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "open": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            },
            "closed": {
              "type": "string",
              "minLength": 1,
              "maxLength": 12
            }
          },
          "additionalProperties": false
        },
        "route": {
          "type": "array",
          "minItems": 2,
          "maxItems": 12,
          "items": {
            "type": "object",
            "required": [
              "x",
              "y"
            ],
            "properties": {
              "x": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              },
              "y": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              }
            },
            "additionalProperties": false
          }
        },
        "obstacles": {
          "type": "array",
          "maxItems": 8,
          "items": {
            "type": "object",
            "required": [
              "id",
              "x",
              "y",
              "r"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "x": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              },
              "y": {
                "type": "number",
                "minimum": 0.06,
                "maximum": 0.94
              },
              "r": {
                "type": "number",
                "minimum": 0.01,
                "maximum": 0.15
              }
            },
            "additionalProperties": false
          }
        },
        "conditions": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "gateOpen"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16
              },
              "gateOpen": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        "mechanism": {
          "const": "alternative-compare"
        },
        "family": {
          "const": "alternative-compare"
        },
        "duration": {
          "type": "number",
          "minimum": 12,
          "maximum": 45
        }
      },
      "additionalProperties": false
    }
  ]
}
;
/* Data-driven adaptations of the selected Clay r2 material/continuity mechanisms.
 * Original source performance remains a separate explicitly bound immutable route. */
const cl=K.clamp,mix=K.lerp,TAU=Math.PI*2,clone=x=>JSON.parse(JSON.stringify(x));
let drawAudit=null;
const FAMILIES=new Map(META.families.map(c=>[c.id,c]));
const palette=[{base:'#daa442',hi:'#ffdd86',lo:'#9d6628'},{base:'#b5cda3',hi:'#e4eecf',lo:'#809967'},{base:'#9ac5e3',hi:'#ddf0fa',lo:'#6698c2'},{base:'#d49b7b',hi:'#edc4a8',lo:'#a86f55'}];
const labelDefaults={en:{source:'Source',parts:'Descendants',attached:'Attached',transported:'Transported',remaining:'Remaining',force:'Force',threshold:'Threshold',alternative:'Conditional comparison',magnified:'Same identity · magnified',total:'Total',open:'Open',closed:'Closed'},'zh-CN':{source:'出处',parts:'后代',attached:'已附着',transported:'已移出',remaining:'仍保留',force:'作用力',threshold:'分裂阈值',alternative:'假设分支对照',magnified:'同一对象 · 放大观察',total:'合计',open:'打开',closed:'关闭'}};
function errorsOf(v,s,at='$',out=[]){if(s.const!==undefined&&v!==s.const)out.push(at+' must be '+s.const);if(s.enum&&!s.enum.includes(v))out.push(at+' unsupported value');if(s.type){const ok=s.type==='object'?v&&typeof v==='object'&&!Array.isArray(v):s.type==='array'?Array.isArray(v):s.type==='integer'?Number.isSafeInteger(v):s.type==='number'?Number.isFinite(v):typeof v===s.type;if(!ok){out.push(at+' invalid type');return out}}if(typeof v==='string'){if(s.minLength!==undefined&&[...v].length<s.minLength)out.push(at+' empty');if(s.maxLength!==undefined&&[...v].length>s.maxLength)out.push(at+' exceeds '+s.maxLength+' codepoints');if(s.pattern&&!new RegExp(s.pattern).test(v))out.push(at+' invalid format')}if(typeof v==='number'&&(s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum))out.push(at+' outside numerical limits');if(Array.isArray(v)){if(s.minItems!==undefined&&v.length<s.minItems||s.maxItems!==undefined&&v.length>s.maxItems)out.push(at+' outside item limits');v.forEach((x,i)=>s.items&&errorsOf(x,s.items,at+'['+i+']',out))}if(v&&typeof v==='object'&&!Array.isArray(v)){for(const k of s.required||[])if(v[k]===undefined)out.push(at+'.'+k+' required');for(const[k,x]of Object.entries(v)){if(s.properties?.[k])errorsOf(x,s.properties[k],at+'.'+k,out);else if(s.additionalProperties===false)out.push(at+'.'+k+' unknown field')}}return out}
function validate(input){try{const r=clone(input||{});r.mechanism=String(r.mechanism||r.family||'').replace(/^clay[.:]/,'');r.family=r.mechanism;r.duration??=FAMILIES.get(r.mechanism)?.minDuration;r.decimals??=1;r.seed??=26;r.language??='zh-CN';r.labels={...labelDefaults[r.language],...r.labels};const schema=SCHEMA.oneOf.find(s=>s.properties.mechanism.const===r.mechanism);if(!schema)return{ok:false,errors:['Unknown Clay mechanism.'],normalized:null};const errors=errorsOf(r,schema);if(errors.length)return{ok:false,errors,normalized:null};const ids=new Set();for(const n of r.nodes){if(ids.has(n.id))errors.push('Node ids must be unique.');ids.add(n.id)}if(Math.max(...r.nodes.map(n=>n.value))/Math.min(...r.nodes.map(n=>n.value))>16)errors.push('Within one view value ratio must be <=16; choose a common larger unit or separate views.');if(r.parts){if(Math.max(...r.parts.map(p=>p.weight))/Math.min(...r.parts.map(p=>p.weight))>16)errors.push('Within one split the part weight ratio must be <=16.');const pids=new Set();for(const p of r.parts){if(pids.has(p.id))errors.push('Part ids must be unique.');pids.add(p.id)}const end=r.nodes.flatMap(n=>r.parts.map((p,i)=>i===Math.floor(r.parts.length/2)?n.id:n.id+'-'+p.id));if(new Set(end).size!==end.length)errors.push('Descendant ids collide with another root/descendant.')}if(r.focusId&&!ids.has(r.focusId))errors.push('focusId must identify an actual node.');if(r.conditions&&r.conditions[0].id===r.conditions[1].id)errors.push('Conditional branch ids must differ.');const act=r.cueTimes?.act??1.2;if(r.cueTimes&&Object.values(r.cueTimes).some(v=>v>=r.duration-.3))errors.push('Verified cues must precede the exit.');if(act<.35)errors.push('Action cue needs at least .35 seconds of entrance.');if(r.mechanism==='focus-return'&&(r.cueTimes?.return??4.8)<act+1.82)errors.push('Focus return must follow the complete 1.42s lift and a .4s inspection window.');const last=r.mechanism==='focus-return'?(r.cueTimes?.return??4.8)+2.22:['channel-transport','alternative-compare'].includes(r.mechanism)?act+7.23:r.mechanism==='interface-bind'?act+3.2+.38:r.mechanism==='lineage-track'?10.2:act+4.921;if(last>r.duration-.3)errors.push('Duration/cues do not preserve this mechanism’s original-speed action windows.');if(r.route){const len=r.route.slice(1).reduce((v,p,i)=>v+Math.hypot(p.x-r.route[i].x,p.y-r.route[i].y),0);if(len<.68)errors.push('The explicit transport route must span at least .68 normalized units.');if(r.route.some((p,i)=>i&&(p.x-r.route[i-1].x<.04||Math.hypot(p.x-r.route[i-1].x,p.y-r.route[i-1].y)<.04)))errors.push('Route advances must be distinct and at least .04 along the flow direction.');for(const shape of [{x:0,y:0,width:1600,height:700},{x:0,y:0,width:900,height:1200}]){const s=flowState(r,act,shape,false);for(const o of s.obstacles){for(let i=1;i<s.route.length;i++)if(pointSegment(o,s.route[i-1],s.route[i])<o.bound+s.channelWidth/2+2)errors.push('Actual channel intersects obstacle '+o.id+' in '+(shape.height>shape.width?'portrait':'landscape')+'.')}}}return{ok:!errors.length,errors:[...new Set(errors)],normalized:errors.length?null:r}}catch(e){return{ok:false,errors:['Malformed Clay recipe: '+e.message],normalized:null}}}
function normalized(input){const v=validate(input);if(!v.ok)throw Error('NativeClay recipe invalid: '+v.errors.join('; '));return v.normalized}
const area=pts=>Math.abs(pts.reduce((n,p,i)=>{const q=pts[(i+1)%pts.length];return n+p.x*q.y-q.x*p.y},0))/2;
function inside(p,pts){let yes=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes}return yes}
function pointSegment(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,u=cl(((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1));return Math.hypot(p.x-a.x-u*dx,p.y-a.y-u*dy)}
function boundaryDistance(p,pts){return Math.min(...pts.map((a,i)=>pointSegment(p,a,pts[(i+1)%pts.length])))}
function polygonHit(a,b){const x=bounds(a),y=bounds(b);if(x.x>=y.x+y.width||x.x+x.width<=y.x||x.y>=y.y+y.height||x.y+x.height<=y.y)return false;if(inside(a[0],b)||inside(b[0],a))return true;const orient=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){const p=a[i],q=a[(i+1)%a.length],r=b[j],s=b[(j+1)%b.length];if(orient(p,q,r)*orient(p,q,s)<-1e-8&&orient(r,s,p)*orient(r,s,q)<-1e-8)return true}return false}

function polygon(x,y,r,aspect,target,seed=1){const irr=Material.irr(seed,.023),pts=Array.from({length:72},(_,i)=>{const a=i/72*TAU,k=irr(a);return{x:Math.cos(a)*r*k,y:Math.sin(a)*r*aspect*k}}),s=Math.sqrt(target/area(pts));return pts.map(p=>({x:x+p.x*s,y:y+p.y*s}))}
function bounds(pts){const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}}
function geometryNode(n,x,y,r,aspect,seed,extra={}){const target=Math.PI*r*r*aspect,pts=polygon(x,y,r,aspect,target,seed);return{...n,x,y,r,aspect,polygon:pts,area:area(pts),targetArea:target,bound:Math.max(...pts.map(p=>Math.hypot(p.x-x,p.y-y))),seed,...extra}}
function dimensions(box={}){const b=Array.isArray(box)?{x:box[0],y:box[1],width:box[2],height:box[3]}:{x:box.x??0,y:box.y??0,width:box.width??box.w??1440,height:box.height??box.h??760};if(Object.values(b).some(v=>!Number.isFinite(v))||b.width<=0||b.height<=0)throw Error('NativeClay box must have finite positive dimensions.');return b}
function roots(r,box){const B=dimensions(box),portrait=B.height>B.width,n=r.nodes.length,pad=44,top=80,bottom=120,cellW=portrait?B.width-2*pad:(B.width-2*pad)/n,cellH=portrait?(B.height-top-bottom)/n:B.height-top-bottom,max=Math.min(100,cellW*.22,cellH*.22),maxV=Math.max(...r.nodes.map(n=>n.value));return r.nodes.map((o,i)=>geometryNode(o,B.x+pad+(portrait?.5:i+.5)*cellW,B.y+top+(portrait?i+.33:.43)*cellH,max*Math.sqrt(o.value/maxV),.72,r.seed+i*13,{rootId:o.id,origin:{x:B.x+pad+(portrait?.5:i+.5)*cellW,y:B.y+top+(portrait?i+.33:.43)*cellH},cell:{x:B.x+pad+(portrait?0:i)*cellW,y:B.y+top+(portrait?i:0)*cellH,width:cellW,height:cellH},color:o.color||palette[i%palette.length]}))}
function splitClock(r,t){const a=r.cueTimes?.act??1.2;return .55*MK.p(t,a,1.871,MK.ease.swift)+.45*MK.p(t,a+2.6,2.321,MK.ease.swift)}
function section(root,parts,p){p=cl(p);const mid=Math.floor(parts.length/2),sum=parts.reduce((a,b)=>a+b.weight,0),a=parts.map(o=>o.weight/sum),maxR=root.r,spacing=maxR*1.62,centers=parts.map((_,i)=>(i-mid)*spacing*MK.ease.anticip(p)),radii=a.map((w,i)=>maxR*Math.sqrt(i===mid?1-p+p*w:p*w)),extent=Math.max(...centers.map((x,i)=>Math.abs(x)+radii[i])),raw=[];for(let i=0;i<=240;i++){const x=-extent+2*extent*i/240;let y=Math.max(...radii.map((rad,j)=>Math.sqrt(Math.max(0,rad*rad-(x-centers[j])**2))));const d=Math.max(...centers.map(Math.abs));if(Math.abs(x)<d)y=Math.max(y,maxR*.42*Math.pow(1-p,1.5)*Math.sqrt(Math.max(0,1-(x/(d+.01))**2)));raw.push({x,y})}let pts=[...raw.map(q=>({x:q.x,y:-q.y})),...raw.slice().reverse().map(q=>({x:q.x,y:q.y}))],rawArea=area(pts),sy=root.targetArea/Math.max(rawArea,1e-9);pts=pts.map(q=>({x:root.x+q.x,y:root.y+q.y*sy}));return{polygon:pts,area:area(pts),targetArea:root.targetArea,p,sy,centers,radii,bridge:maxR*.42*Math.pow(1-p,1.5)*sy,weights:a}}
function descendants(root,parts){const mid=Math.floor(parts.length/2),sum=parts.reduce((n,p)=>n+p.weight,0);return parts.map((p,j)=>{const fraction=p.weight/sum,radius=root.r*Math.sqrt(fraction);return geometryNode({id:j===mid?root.id:root.id+'-'+p.id,label:p.label,value:root.value*fraction},root.x+(j-mid)*root.r*1.62,root.y,radius,.72,root.seed+j,{rootId:root.id,parentId:j===mid?undefined:root.id,continuation:j===mid,isDescendant:true,sourceId:root.id,origin:root.origin,color:root.color,partId:p.id,fraction,cell:root.cell,labelAnchor:{x:root.cell.x+(j+.5)*root.cell.width/parts.length,y:root.cell.y+root.cell.height-75,width:root.cell.width/parts.length-12}})})}
function splitState(r,t,box){const R=roots(r,box),reverse=r.direction==='merge',force=r.mechanism==='shear-break'?Math.min(1,r.force/r.threshold):1,breaks=r.mechanism!=='shear-break'||r.force>=r.threshold,progress=splitClock(r,t),p=reverse?1-progress:Math.min(breaks?1:.85,progress*force),nodes=[],sections=[],edges=[];for(const root of R){const sectionNow=section(root,r.parts,p);sections.push({...sectionNow,rootId:root.id,value:root.value,source:root});if(p<1-1e-8){nodes.push({...root,...sectionNow,rootId:root.id,color:root.color,phase:'connected'})}else{for(const child of descendants(root,r.parts)){let z=child;if(r.mechanism==='lineage-track'){const u=MK.p(t,6.7,3.5,MK.ease.swift),to={x:child.x,y:child.y+Math.min(95,root.cell.height*.15)},pose=MK.morph(t,6.7,3.5,[child.x,child.y],[to.x,to.y],{lift:34,stretch:0,overshoot:0});const dy=pose.y-child.y;z={...child,x:pose.x,y:pose.y,polygon:child.polygon.map(p=>({x:p.x,y:p.y+dy})),transport:u};edges.push({from:root.id,to:child.id,points:[root.origin,{x:child.x,y:root.origin.y+40},{x:z.x,y:z.y}],source:'actual-root-origin'})}nodes.push(z)}}}return{roots:R,nodes,sections,edges,progress:p,breaks,force:r.force,threshold:r.threshold,counters:{total:R.reduce((n,o)=>n+o.value,0),parts:nodes.length}}}
function agentState(root,j,count,t,act){const at=MK.stagger(j,count,act,3.2),p=MK.p(t,at,.38,MK.ease.swift),a=j/count*TAU-.9,idx=Math.round((a/TAU+1)%1*root.polygon.length)%root.polygon.length,b=root.polygon[idx],ux=(b.x-root.x)/Math.hypot(b.x-root.x,b.y-root.y),uy=(b.y-root.y)/Math.hypot(b.x-root.x,b.y-root.y),scale=Math.min(.66,Math.max(.25,root.r*4.9/(count*45))),margin=12*scale*1.2+3,target={x:b.x+ux*margin,y:b.y+uy*margin},start={x:target.x+ux*58,y:target.y+uy*58},x=mix(start.x,target.x,p),y=mix(start.y,target.y,p),angle=Math.atan2(-uy,-ux),tip={x:x+Math.cos(angle)*41*scale,y:y+Math.sin(angle)*41*scale};return{id:root.id+'-agent-'+j,rootId:root.id,x,y,angle,scale,headRadius:12*scale,tailTip:tip,attached:p>=1-1e-9,arrival:at+.38,headOutside:!inside({x,y},root.polygon)&&boundaryDistance({x,y},root.polygon)>12*scale,tailInside:inside(tip,root.polygon)}}
function flowGeometry(r,box){const B=dimensions(box),portrait=B.height>B.width,along=portrait?B.height-190:B.width-100,cross=portrait?B.width-100:B.height-210,origin={x:B.x+50,y:B.y+85},project=p=>portrait?{x:origin.x+p.y*cross,y:origin.y+p.x*along}:{x:origin.x+p.x*along,y:origin.y+p.y*cross},route=r.route.map(project),obstacles=r.obstacles.map((o,i)=>geometryNode({id:o.id,label:o.id,value:0},project(o).x,project(o).y,o.r*cross,1,r.seed+99+i,{role:'obstacle',color:Material.C.card}));return{route,obstacles,channelWidth:Math.min(58,cross*.14),maxRadius:Math.min(18,along*.02),portrait}}
function pointAt(route,p){const q=K.pointAt(route.map(p=>[p.x,p.y]),p);return{x:q[0],y:q[1]}}
function inverseEase(v){let a=0,b=1;for(let k=0;k<40;k++){const m=(a+b)/2;if(MK.ease.swift(m)<v)a=m;else b=m}return(a+b)/2}
function flowState(r,t,box,gateOpen=true,prefix=''){const G=flowGeometry(r,box),maxV=Math.max(...r.nodes.map(n=>n.value)),act=r.cueTimes?.act??1.2,nodes=r.nodes.map((n,i)=>{const start=.05+i*.1,end=.65+i*.1,p=gateOpen?MK.p(t,act,7.23,MK.ease.swift):0,v=mix(start,end,p),q=pointAt(G.route,v),rad=G.maxRadius*Math.sqrt(n.value/maxV),node=geometryNode({...n,id:prefix+n.id},q.x,q.y,rad,.82,r.seed+i*13,{sourceId:n.id,rootId:n.id,sourceProgress:start,progress:v,transport:p,inCollector:v>=.64-1e-9,color:n.color||palette[i%palette.length],arrivalTime:act+7.23*inverseEase((.64-start)/(end-start))});return node});return{...G,box:dimensions(box),nodes,counters:{transported:nodes.filter(n=>n.inCollector).reduce((a,n)=>a+n.value,0),remaining:nodes.filter(n=>!n.inCollector).reduce((a,n)=>a+n.value,0),total:nodes.reduce((a,n)=>a+n.value,0)},gateOpen}}
function focusState(r,t,box){
 const B=dimensions(box),portrait=B.height>B.width,n=r.nodes.length;
 const context=portrait?{x:B.x+25,y:B.y+80,width:B.width-50,height:B.height*.32}:{x:B.x+25,y:B.y+85,width:B.width*.35,height:B.height-180};
 const focus=portrait?{x:B.x+30,y:B.y+B.height*.47,width:B.width-60,height:B.height*.42}:{x:B.x+B.width*.44,y:B.y+100,width:B.width*.52,height:B.height-200};
 const columns=portrait?Math.min(3,n):Math.min(2,n),rows=Math.ceil(n/columns),cw=context.width/columns,ch=context.height/rows,maxR=Math.min(cw*.22,ch*.20,portrait?34:52),maxV=Math.max(...r.nodes.map(n=>n.value)),act=r.cueTimes?.act??1.2,back=r.cueTimes?.return??4.8,out=MK.p(t,act,1.42,MK.ease.swift),ret=MK.p(t,back,2.22,MK.ease.swift);
 const roots=r.nodes.map((n,i)=>geometryNode(n,context.x+(i%columns+.5)*cw,context.y+(Math.floor(i/columns)+.38)*ch,maxR*Math.sqrt(n.value/maxV),.72,r.seed+i*13,{rootId:n.id,color:n.color||palette[i%palette.length],labelWidth:cw*.56,labelLines:3}));
 const selected=roots.find(n=>n.id===r.focusId),index=roots.indexOf(selected),column=index%columns,gutterX=columns===1?selected.x:context.x+(column===0?1:column)*cw,topY=B.y+(portrait?104:92),target={x:focus.x+focus.width/2,y:focus.y+focus.height*.43};
 const points=[{x:selected.x,y:selected.y},{x:gutterX,y:selected.y},{x:gutterX,y:topY},portrait?{x:B.x+B.width-42,y:topY}:{x:focus.x+focus.width*.12,y:topY},...(portrait?[{x:B.x+B.width-42,y:focus.y+focus.height*.15}]:[]),target].filter((p,i,a)=>!i||Math.hypot(p.x-a[i-1].x,p.y-a[i-1].y)>.01);
 const xy=points.map(p=>[p.x,p.y]),cum=K.cum(xy),total=cum.at(-1),cut=cum.at(-2)/total,progress=t<back?out:1-ret,pair=K.pointAt(xy,progress,cum),scaleMax=Math.min(focus.width*.27,focus.height*.30)/selected.r,grow=MK.ease.swift(cl((out-cut)/(1-cut))),shrink=MK.ease.swift(cl(ret/(1-cut))),scale=mix(mix(1,scaleMax,grow),1,shrink),x=pair[0],y=pair[1],active=t>=act&&t<back+2.22;
 const chosen={...selected,x,y,r:selected.r*scale,polygon:selected.polygon.map(p=>({x:x+(p.x-selected.x)*scale,y:y+(p.y-selected.y)*scale})),visualScale:scale,sourceArea:selected.targetArea,origin:{x:selected.x,y:selected.y}};
 const prefix=points.filter((_,i)=>cum[i]<progress*total).concat({x,y});
 return{roots,nodes:roots.filter(n=>!active||n.id!==r.focusId).concat(active?[chosen]:[]),focus:active?chosen:null,source:selected,edges:active?[{from:selected.id,to:selected.id,points:prefix,source:'actual-selected-identity-routed-trace'}]:[],focusBox:focus,showFocusLabels:t>=act+1.42&&t<back+.3,counters:{total:r.nodes.reduce((a,n)=>a+n.value,0)}};
}

function stateNormalized(r,t,box){const B=dimensions(box);let s;if(['split-merge','shear-break','lineage-track'].includes(r.mechanism))s=splitState(r,t,B);else if(r.mechanism==='interface-bind'){const R=roots(r,B).map(root=>{if(B.height<=B.width)return root;const dx=-B.width*.18;return{...root,x:root.x+dx,polygon:root.polygon.map(p=>({x:p.x+dx,y:p.y})),origin:{x:root.origin.x+dx,y:root.origin.y},labelAnchor:{x:B.x+B.width*.78,y:root.y-8,width:B.width*.34}}}),agents=R.flatMap(root=>Array.from({length:r.agents},(_,j)=>agentState(root,j,r.agents,t,r.cueTimes?.act??1.2)));s={roots:R,nodes:R,agents,counters:{attached:agents.filter(a=>a.attached).length,total:r.nodes.reduce((a,n)=>a+n.value,0)}}}else if(r.mechanism==='focus-return')s=focusState(r,t,B);else if(r.mechanism==='alternative-compare'){const portrait=B.height>B.width,gap=35,boxes=portrait?[{x:B.x,y:B.y+55,width:B.width,height:(B.height-90-gap)/2},{x:B.x,y:B.y+55+(B.height-90+gap)/2,width:B.width,height:(B.height-90-gap)/2}]:[{x:B.x,y:B.y+45,width:(B.width-gap)/2,height:B.height-60},{x:B.x+(B.width+gap)/2,y:B.y+45,width:(B.width-gap)/2,height:B.height-60}],branches=r.conditions.map((c,i)=>({...flowState(r,t,boxes[i],c.gateOpen,c.id+'/'),condition:c,box:boxes[i]}));s={branches,nodes:branches.flatMap(b=>b.nodes),obstacles:branches.flatMap(b=>b.obstacles),counters:{total:r.nodes.reduce((a,n)=>a+n.value,0)}}}else s=flowState(r,t,B,true);return{time:t,mechanism:r.mechanism,box:B,...s}}
function state(input,t,box={width:1440,height:760}){const r=normalized(input);if(!Number.isFinite(t)||t<0||t>r.duration+.001)throw Error('NativeClay time outside recipe.');return stateNormalized(r,t,box)}
function fmt(v,r){if(v>0&&Number(v.toFixed(r.decimals))===0)return '<'+(10**-r.decimals).toFixed(r.decimals);return(Number(v).toFixed(r.decimals)).replace(/\.0+$/,'').replace(/(\.\d*?[1-9])0+$/,'$1')}
function color(v){if(typeof v!=='string')return v||palette[0];const h=K.hex(v),mixTo=(goal,p)=>'#'+h.map((x,i)=>Math.round(x+(goal[i]-x)*p).toString(16).padStart(2,'0')).join('');return{base:v,hi:mixTo([255,246,220],.5),lo:mixTo([70,45,30],.45)}}
function drawMaterialNode(g,node,options={}){const pts=node.polygon,b=bounds(pts),col=color(node.color||palette[0]);let recorded=false;Material.clay(g,c=>{pts.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();if(drawAudit&&!recorded){const m=c.getTransform();drawAudit.push({id:node.id,role:node.role||'material',polygon:pts.map(p=>({x:m.a*p.x+m.c*p.y+m.e,y:m.b*p.x+m.d*p.y+m.f}))});recorded=true}},node.x,node.y,Math.max(b.width,b.height)*.62,col,{h:7,sa:.23,ir:Math.max(8,Math.min(b.width,b.height)*.52),tex:.65,ts:.56,spec:.4,occ:.25,rim:.52,...options});return{rect:b,area:area(pts)}}
function line(g,points,col,width=2,dashed=false){g.save();g.strokeStyle=col;g.lineWidth=width;g.lineCap='round';g.lineJoin='round';if(dashed)g.setLineDash([6,6]);g.beginPath();points.forEach((p,i)=>i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y));g.stroke();g.restore()}
function words(g,value,x,y,width,size=23,col='#4a3a2e',maxLines=2,ledger,id){g.save();g.font=`600 ${size}px ClaySans`;g.textAlign='center';g.textBaseline='alphabetic';g.fillStyle=col;let lines=[],part='';for(const c of String(value)){if(part&&g.measureText(part+c).width>width){lines.push(part);part=c}else part+=c}if(part)lines.push(part);if(lines.length>maxLines){g.restore();throw Error('NativeClay label capacity exceeded: '+id)}for(let i=0;i<lines.length;i++){const yy=y+i*size*1.25,w=g.measureText(lines[i]).width;g.fillText(lines[i],x,yy);ledger?.box?.({id:id+'-'+i,role:'label',rect:{x:x-w/2,y:yy-size,width:w,height:size*1.25}})}g.restore();return lines.length*size*1.25}
function drawTransport(g,r,t,s,ledger,prefix=''){line(g,s.route,'#aacbd9',s.channelWidth);line(g,s.route,'#deeff3',s.channelWidth*.52);for(const o of s.obstacles){drawMaterialNode(g,o,{h:5});ledger?.box?.({id:prefix+o.id,role:'obstacle',rect:bounds(o.polygon)})}const body=()=>{for(const n of s.nodes){drawMaterialNode(g,n,{h:4});ledger?.box?.({id:n.id,role:'material',rect:bounds(n.polygon)})}};body();const a=s.route[0],b=s.route.at(-1),portrait=s.portrait,captionWidth=portrait?Math.min(s.box.width-30,320):Math.min(290,s.box.width*.42),labelX=x=>cl(x,s.box.x+captionWidth/2+10,s.box.x+s.box.width-captionWidth/2-10);words(g,r.labels.source+' '+fmt(s.counters.remaining,r)+' '+r.valueUnit,labelX(a.x),portrait?a.y-30:a.y-50,captionWidth,22,undefined,2,ledger,prefix+'source');words(g,r.labels.transported+' '+fmt(s.counters.transported,r)+' '+r.valueUnit,labelX(b.x),portrait?b.y+55:b.y+64,captionWidth,22,undefined,2,ledger,prefix+'transported');if(!s.gateOpen){const gate=pointAt(s.route,.63),d=s.channelWidth*.65;line(g,[{x:gate.x-d,y:gate.y-d},{x:gate.x+d,y:gate.y+d}],'#a76d3b',10);words(g,r.labels.closed,gate.x,gate.y-d-20,180,22,undefined,2,ledger,prefix+'closed')}return body}
function draw(g,input,t,box,options={}){const r=normalized(input),s=stateNormalized(r,t,box),B=s.box,labelsAndShapes=[],ledger={items:labelsAndShapes,box(q){labelsAndShapes.push(q);options.ledger?.box?.(q)}};drawAudit=[];g.save();try{words(g,r.title,B.x+B.width/2,B.y+32,B.width-30,26,'#4a3a2e',2,ledger,'title');if(s.branches){for(const b of s.branches){words(g,b.condition.label,b.box.x+b.box.width/2,b.box.y+20,b.box.width-20,24,'#4a3a2e',2,ledger,b.condition.id+'-title');drawTransport(g,r,t,b,ledger,b.condition.id+'/')}words(g,r.labels.alternative+' · '+r.nodes.length+' '+r.unit,B.x+B.width/2,B.y+B.height-10,B.width-30,22,'#8c7462',2,ledger,'branch-note');return s}if(s.route){drawTransport(g,r,t,s,ledger);words(g,r.nodes.length+' '+r.unit,B.x+B.width/2,B.y+B.height-12,B.width-30,22,'#8c7462',2,ledger,'source-count');return s}for(const e of s.edges||[])line(g,e.points,'#8c7462',2,true);if(r.mechanism==='lineage-track')for(const root of s.roots){g.save();g.globalAlpha=.35;line(g,root.polygon.concat(root.polygon[0]),'#8c7462',1.5,true);g.restore();words(g,root.id,root.x,root.y-root.r*.72-25,root.cell.width*.8,21,'#8c7462',2,ledger,'origin-'+root.id)}for(const n of s.nodes){const actual=drawMaterialNode(g,n);ledger?.box?.({id:n.id,role:'material',rect:actual.rect});if(r.mechanism!=='focus-return'||!s.focus||n.id!==s.focus.id){const child=!!n.isDescendant,width=n.labelAnchor?.width??(child?Math.max(90,n.r*2.4):n.cell?.width*.85||n.labelWidth||160),labelX=n.labelAnchor?.x??n.x,bb=bounds(n.polygon),labelY=n.labelAnchor?.y??(bb.y+bb.height+(s.agents?118:34));if(child&&Math.abs(labelX-n.x)>15)line(g,[{x:n.x,y:bb.y+bb.height+4},{x:labelX,y:labelY-27}],'#b89a80',1.4);const h=words(g,n.label,labelX,labelY,width,22,'#4a3a2e',n.labelLines||2,ledger,n.id+'-label');words(g,fmt(n.value,r)+(child?'':' '+r.valueUnit),labelX,labelY+h+1,width,22,'#8c7462',2,ledger,n.id+'-value')}}for(const a of s.agents||[]){C.molecule(g,a.x,a.y,a.angle,a.scale);drawAudit.push({id:a.id,role:'agent-head',circle:{x:a.x,y:a.y,r:a.headRadius*1.05},rootId:a.rootId,attached:a.attached});ledger?.box?.({id:a.id,role:'attached-agent',rect:{x:a.x-a.headRadius*1.1,y:a.y-a.headRadius*1.1,width:a.headRadius*2.2,height:a.headRadius*2.2}})}if(s.agents)words(g,r.labels.attached+' '+s.counters.attached+' / '+s.agents.length+' '+r.unit,B.x+B.width/2,B.y+B.height-35,B.width-20,26,'#5788a5',2,ledger,'attached-readout');if(['split-merge','shear-break','lineage-track'].includes(r.mechanism))words(g,r.labels.total+' '+fmt(s.counters.total,r)+' '+r.valueUnit+' · '+r.labels.parts+' '+s.nodes.length+' '+r.unit,B.x+B.width/2,B.y+B.height-(r.mechanism==='shear-break'?60:28),B.width-30,23,'#8c7462',2,ledger,'total-conserved');if(r.mechanism==='shear-break'){const a=r.cueTimes?.act??1.2,p=MK.p(t,a,1.871,MK.ease.swift),back=MK.p(t,a+2.6,2.321,MK.ease.swift),x=mix(B.x+B.width*.22,B.x+B.width*.78,p)-B.width*.56*back,y=B.y+118+23*Math.sin(Math.PI*p);g.save();g.translate(x,y);const sc=Math.min(.65,B.width/800);g.scale(sc,sc);C.sponge(g,0,0,Math.sin(Math.PI*p)*Math.min(1,r.force/r.threshold));g.restore();words(g,r.labels.force+' '+fmt(r.force,r)+' · '+r.labels.threshold+' '+fmt(r.threshold,r),B.x+B.width/2,B.y+B.height-25,B.width-30,23,'#a76d3b',2,ledger,'force-readout')}if(s.focus&&s.showFocusLabels){const n=s.focus,b=bounds(n.polygon),width=s.focusBox.width*.9;words(g,r.labels.magnified,n.x,b.y-35,width,23,'#5788a5',2,ledger,'focus-label');const h=words(g,n.label,n.x,b.y+b.height+43,width,24,'#4a3a2e',2,ledger,'focus-name');words(g,fmt(n.value,r)+' '+r.valueUnit,n.x,b.y+b.height+44+h,width,24,'#8c7462',2,ledger,'focus-value')}if(r.mechanism==='focus-return')words(g,r.labels.source+' · '+r.nodes.length+' '+r.unit,B.x+B.width/2,B.y+B.height-22,B.width-30,22,'#8c7462',2,ledger,'focus-source-count');return s}finally{s.drawnGeometry=drawAudit;drawAudit=null;g.restore();{const material=s.drawnGeometry.filter(q=>q.role==='material'),obstacles=s.drawnGeometry.filter(q=>q.role==='obstacle');for(const a of material)for(const b of obstacles)if(polygonHit(a.polygon,b.polygon))throw Error('NativeClay actual particle/obstacle intersection: '+a.id+' / '+b.id);for(let i=0;i<material.length;i++)for(let j=i+1;j<material.length;j++)if(polygonHit(material[i].polygon,material[j].polygon))throw Error('NativeClay actual particle intersection: '+material[i].id+' / '+material[j].id);const labels=labelsAndShapes.filter(q=>q.role==='label');for(const l of labels){const q=l.rect;if(q.x<B.x-2||q.y<B.y-2||q.x+q.width>B.x+B.width+2||q.y+q.height>B.y+B.height+2)throw Error('NativeClay layout capacity: label outside '+l.id);const poly=[{x:q.x,y:q.y},{x:q.x+q.width,y:q.y},{x:q.x+q.width,y:q.y+q.height},{x:q.x,y:q.y+q.height}];for(const m of material)if(polygonHit(poly,m.polygon))throw Error('NativeClay layout capacity: label/material overlap '+l.id+' / '+m.id);for(const h of s.drawnGeometry.filter(o=>o.role==='agent-head')){const c=h.circle,x=cl(c.x,q.x,q.x+q.width),y=cl(c.y,q.y,q.y+q.height);if(Math.hypot(c.x-x,c.y-y)<c.r)throw Error('NativeClay layout capacity: label/agent overlap '+l.id+' / '+h.id)}}for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i].rect,b=labels[j].rect;if(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>2&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>2)throw Error('NativeClay layout capacity: label overlap '+labels[i].id+' / '+labels[j].id)}}}}
function events(input){const r=normalized(input),out=[],act=r.cueTimes?.act??1.2,emit=(time,kind,note,duration=.1,step=0,pan=0)=>{const ordinal=out.length;out.push({id:(r.id||r.mechanism)+'-'+ordinal,time:+time.toFixed(6),kind,note,duration,step,pan,gainDb:-31,origin:'adapted',sourceOrdinal:ordinal,seed:2026101700+(r.seed-26)*4096+ordinal,sourceSynth:'NativeClay.source/audio/foley-mix.py'})};if(['split-merge','shear-break','lineage-track'].includes(r.mechanism)){emit(act,'slide-tone','Material section develops connected necks',1.871);if(r.mechanism!=='shear-break'||r.force>=r.threshold)r.nodes.forEach((n,i)=>emit(act+4.921,r.direction==='merge'?'thunk':'pop',(r.direction==='merge'?'Tracked descendants rejoin parent ':'Actual descendants become separate from ')+n.id,.15,i,(i-(r.nodes.length-1)/2)*.3));if(r.mechanism==='shear-break'){emit(act,'thunk','Material sponge makes actual force contact');emit(act+2.6,'scratch','Second shearing stroke acts on the same material',2.321)}if(r.mechanism==='lineage-track')emit(6.7,'slide','The same descendants follow their recorded origins',3.5)}else if(r.mechanism==='interface-bind')r.nodes.forEach((n,i)=>{for(let j=0;j<r.agents;j++)emit(MK.stagger(j,r.agents,act,3.2)+.38,'tick',n.id+'-agent-'+j+' reaches the actual interface',.07,j,(i-(r.nodes.length-1)/2)*.35)});else if(r.mechanism==='focus-return'){emit(act,'whoosh','Actual selected identity leaves context for magnification',1.42);emit(r.cueTimes?.return??4.8,'whoosh','Same selected identity returns to its source location',2.22)}else{emit(act,'whoosh-in','Declared channel opens without changing material identity',.8);for(const branch of r.conditions||[{id:'flow',gateOpen:true}]){if(!branch.gateOpen){emit(act+.35,'thunk','Conditional gate closes; identities remain in the liquid');continue}for(let i=0;i<r.nodes.length;i++){const start=.05+i*.1,end=.65+i*.1,time=act+7.23*inverseEase((.64-start)/(end-start));emit(time,'dot-land',branch.id+'/'+r.nodes[i].id+' enters the actual collection region',.1,i,.4)}}}return out.sort((a,b)=>a.time-b.time||a.sourceOrdinal-b.sourceOrdinal)}
const nativeScriptURL=typeof document!=='undefined'?document.currentScript?.src:null;
async function loadFonts(baseURL=new URL('./',nativeScriptURL||location.href).href){const fontBase=new URL('source/engine/fonts/',baseURL);for(const [name,file]of [['ClaySans','NotoSansSC.ttf'],['ClayLat','Inter.ttf'],['ClayKai','LXGWWenKai-500.woff']]){if([...document.fonts].some(f=>f.family===name&&f.status==='loaded'))continue;const f=new FontFace(name,`url(${new URL(file,fontBase)})`,name==='ClayKai'?{}:{weight:'100 900'});await f.load();document.fonts.add(f)}await document.fonts.ready;return true}

async function mountPerformance(binding,{baseURL,container}={}){if(!binding||binding.schema!=='NativeClayPerformanceBinding@1'||!binding.timeline||!binding.words||!binding.model||!binding.texts||!Object.keys(binding.texts).length)throw Error('needs-binding: NativeClay source performance requires explicit timeline/words/model/texts and has no content defaults.');const iframe=document.createElement('iframe');iframe.width='1920';iframe.height='1080';iframe.style.cssText='position:absolute;left:-10000px;width:1920px;height:1080px;border:0';(container||document.body).append(iframe);try{await new Promise((ok,fail)=>{iframe.onload=ok;iframe.onerror=fail;iframe.src=new URL('source-performance.html?render=1',new URL(baseURL||'./',nativeScriptURL||document.baseURI)).href});await iframe.contentWindow.initializeNativeClayPerformance(binding)}catch(e){iframe.remove();throw e}return{duration:binding.timeline.duration,frame:iframe,events:()=>clone(iframe.contentWindow.__motionEvents).map((e,k)=>({...e,sourceOrdinal:k,seed:2026101700+k})),renderAt(ctx,t,box){const w=iframe.contentWindow;w.renderFrame(t);if(w.__missingTextBindings?.length)throw Error('needs-binding: '+w.__missingTextBindings.join(', '));const b=dimensions(box),scale=Math.min(b.width/1920,b.height/1080),width=1920*scale,height=1080*scale;ctx.drawImage(w.K.canvas,b.x+(b.width-width)/2,b.y+(b.height-height)/2,width,height);return w.__clayState},dispose(){iframe.remove()}}}

function background(g,t,box,tokens={}){const B=dimensions(box),gr=g.createLinearGradient(0,B.y,0,B.y+B.height);gr.addColorStop(0,tokens.paper||'#F1D2BF');gr.addColorStop(.75,tokens.paperLow||'#F8E8D9');g.save();g.fillStyle=gr;g.fillRect(B.x,B.y,B.width,B.height);g.restore()}
window.NativeClay={version:'2.0.0-author-candidate',catalog:META.families,validate,draw,state,events,loadFonts,mountPerformance,background,drawBackground(g,box,{tokens={},time=0}={}){return background(g,time,box,tokens)},drawMaterialNode,geometry:{area,inside,boundaryDistance,pointSegment},sourcePerformance:{route:'source-performance',bindingSchema:'NativeClayPerformanceBinding@1',defaultBinding:null,contentDefault:'none',scope:'Exact selected Clay rev2 physical model and clock; explicit external words, displayed texts and model. New topics use adapted mechanisms.'}};

})();
