#!/usr/bin/env node
/**
 * verify-calibration.mjs — 把 calibration.json 变成可执行断言
 *
 * 为什么要有：可复用元数据如果只是一份"数字清单"，agent 拿到也不知道对不对；
 * 能跑起来才算契约。这个脚本按 calibration.json 里的 verify.method 渲染探针帧、
 * 用同一套掩膜量一遍，超差即 FAIL（退出码 1）。
 *
 *   node tools/verify-calibration.mjs --params out/newfilm/triage.vo.json
 *   node tools/verify-calibration.mjs --params kits/science/template/presets/demo.vo.json --json
 *
 * 归属判断：entry.appliesTo.profile 与 params.profile 不一致 → SKIP（不是失败）。
 * 这正是"哪一代外观"能被机器区分的地方，别把 SKIP 当 PASS。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ASJSON = process.argv.includes('--json');

const KIT = arg('kit', 'science');
const CAL_PATH = path.resolve(REPO_ROOT, 'kits', KIT, 'template', 'calibration.json');
const PARAMS = arg('params', null);
if (!PARAMS) {
  console.error('用法: node tools/verify-calibration.mjs --params <preset.json> [--json]');
  process.exit(2);
}
const CAL = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));

// ---- 时间轴：支持 segments(dur 累加) 与 scenes(t0/t1) 两种写法 ----
let acc = 0;
const segs = (P.segments || []).map((s) => {
  const t0 = s.t0 === undefined ? acc : s.t0;
  const t1 = s.t1 === undefined ? t0 + Number(s.dur || 0) : s.t1;
  acc = t1;
  return { type: s.type, t0, t1 };
});
const caps = P.captions || [];
const profile = P.profile || 'current';

function probeTime(kind) {
  if (kind === 'caption') {
    const c = caps[0];
    if (!c) return null;
    return +(((c.start + c.end) / 2)).toFixed(2);
  }
  const s = segs.find((x) => x.type === kind);
  if (!s) return null;
  const mid = s.t0 + (s.t1 - s.t0) * 0.55;
  return +Math.min(Math.max(mid, s.t0 + 1.2), s.t1 - 0.6).toFixed(2);
}

// ---- 探针 ----
const TMP = fs.mkdtempSync('/tmp/calprobe-');
const cache = new Map();
/** 渲染探针帧并返回 PNG 路径（同一 kind 只渲一次）。 */
function probeAt(kind) {
  const t = probeTime(kind);
  if (t === null) return null;
  const key = `${kind}@${t}`;
  if (cache.has(key)) return cache.get(key);
  const out = path.join(TMP, `${kind}_${String(t).replace('.', '_')}.png`);
  execFileSync('node', ['render.mjs', '--kit', KIT, '--params', PARAMS, '--probe', out, '--at', String(t)],
    { cwd: REPO_ROOT, stdio: 'ignore' });
  cache.set(key, out);
  return out;
}

// 同步读像素：用 ffmpeg 转成 rawvideo 一帧，避免 async/await 铺满全文件
function pixels(file) {
  const raw = path.join(TMP, 'f.rgb');
  const { width, height } = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' })).streams[0];
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', raw]);
  const buf = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return { buf, w: width, h: height };
}

// ---- 测量方法（与标定时用的掩膜保持一致） ----
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

const MEASURE = {
  'image.size': (img) => [img.w, img.h],
  'ink.darkBBoxBottom': (img) => {
    const { buf, w, h } = img;
    let y1 = -1;
    for (let y = Math.round(h * 0.78); y < h; y++) {
      for (let x = Math.round(w * 0.12); x < w * 0.88; x++) {
        const i = (y * w + x) * 3;
        if (luma(buf[i], buf[i + 1], buf[i + 2]) < 95) { y1 = y; break; }
      }
    }
    return y1 < 0 ? null : +(y1 / h).toFixed(4);
  },
  'ink.firstBandTop': (img) => bands(img)[0]?.top ?? null,
  'ink.firstBandLeft': (img) => bands(img)[0]?.x0 ?? null,
  'ink.secondBandTop': (img) => bands(img)[1]?.top ?? null,
  'ink.lastBandTop': (img) => {
    const b = bands(img);
    return b.length ? b[b.length - 1].top : null;
  },
  'ink.leftEdge': (img) => {
    const { buf, w, h } = img;
    for (let x = Math.round(w * 0.04); x < w * 0.5; x++) {
      for (let y = Math.round(h * 0.15); y < h * 0.78; y++) {
        const i = (y * w + x) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (luma(r, g, b) < 120 || sat > 70) return +(x / w).toFixed(4);
      }
    }
    return null;
  },
  'mask.hotCenter': (img) => {
    const { buf, w, h } = img;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < h * 0.8; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (buf[i] > 200 && buf[i + 1] < 70 && buf[i + 2] < 110) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : [+(((x0 + x1) / 2) / w).toFixed(4), +(((y0 + y1) / 2) / h).toFixed(4)];
  },
  'mask.yellowTop': (img) => {
    const { buf, w, h } = img;
    for (let y = Math.round(h * 0.3); y < h * 0.85; y++) {
      for (let x = Math.round(w * 0.1); x < w * 0.9; x++) {
        const i = (y * w + x) * 3;
        if (buf[i] > 230 && buf[i + 1] > 190 && buf[i + 2] < 140) return +(y / h).toFixed(4);
      }
    }
    return null;
  },
  'mask.hairCenterX': (img) => {
    const b = hairBox(img);
    return b ? +(((b.x0 + b.x1) / 2) / img.w).toFixed(4) : null;
  },
  'mask.hairTop': (img) => {
    const b = hairBox(img);
    return b ? +(b.y0 / img.h).toFixed(4) : null;
  },
};

/** 讲解位文字带：左半区、纵向 0.15–0.78H，按行统计墨迹，返回连续行带。 */
function bands(img) {
  const { buf, w, h } = img;
  const x0 = Math.round(w * 0.05), x1 = Math.round(w * 0.45);
  const y0 = Math.round(h * 0.15), y1 = Math.round(h * 0.78);
  const rows = new Array(h).fill(0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (luma(r, g, b) < 120 || sat > 70) rows[y]++;
    }
  }
  const out = [];
  let cur = null;
  for (let y = y0; y < y1; y++) {
    const on = rows[y] > (x1 - x0) * 0.01;
    if (on && !cur) cur = { top: y, bot: y };
    else if (on) cur.bot = y;
    else if (cur) { if (cur.bot - cur.top >= h * 0.012) out.push(finish(cur)); cur = null; }
  }
  if (cur && cur.bot - cur.top >= h * 0.012) out.push(finish(cur));
  return out;

  function finish(band) {
    let xa = 1e9, xb = -1;
    for (let y = band.top; y <= band.bot; y++) {
      for (let x = Math.round(w * 0.05); x < Math.round(w * 0.45); x++) {
        const i = (y * w + x) * 3;
        const r = buf[i], g = buf[i + 1], b2 = buf[i + 2];
        const sat = Math.max(r, g, b2) - Math.min(r, g, b2);
        if (luma(r, g, b2) < 120 || sat > 70) { if (x < xa) xa = x; if (x > xb) xb = x; }
      }
    }
    return { top: +(band.top / h).toFixed(4), x0: +(xa / w).toFixed(4), x1: +(xb / w).toFixed(4) };
  }
}

/** 头发包围盒：右半区、0.2–0.65H 内的深色像素（避开字幕与角标）。 */
function hairBox(img) {
  const { buf, w, h } = img;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = Math.round(h * 0.18); y < h * 0.62; y++) {
    for (let x = Math.round(w * 0.55); x < w; x++) {
      const i = (y * w + x) * 3;
      // 只认发色：手臂描边是 #8A4A22（r≈138），用 r<105 把它挡掉，
      // 否则抬手的手势会把"头发包围盒"拉宽，测出来的 cx 偏右 3%。
      if (buf[i] < 105 && buf[i + 1] < 95 && buf[i + 2] < 95) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// ---- 逐条判定 ----
const rows = [];
for (const e of CAL.entries) {
  const m = e.verify?.method;
  if (!m) { rows.push({ id: e.id, status: 'NO-METHOD', note: '未实现断言' }); continue; }
  if (e.verify.probe && e.appliesTo?.profile && e.appliesTo.profile !== '*' && e.appliesTo.profile !== profile) {
    rows.push({ id: e.id, status: 'SKIP', note: `appliesTo ${e.appliesTo.profile} ≠ params.profile ${profile}` });
    continue;
  }
  // param.* 直接读 params，不需要渲染（画幅/帧率/淡出这类是参数层面的承诺）
  if (String(m).startsWith('param.')) {
    const key = m.slice(6);
    const got = P[key];
    const tol = e.verify.tolerance ?? 0;
    const delta = typeof got === 'number' ? Math.abs(e.value - got) : null;
    const pass = delta !== null && delta <= tol + 1e-9;
    rows.push({
      id: e.id, status: pass ? 'PASS' : 'FAIL', want: e.value, got: got ?? '—',
      delta: delta === null ? null : +delta.toFixed(4), tol, at: 'params',
      note: pass ? '' : (got === undefined ? 'params 里没有这个字段' : '超差'),
    });
    continue;
  }
  const kind = e.verify.probe;
  const t = kind ? probeTime(kind) : null;
  if (kind && t === null) { rows.push({ id: e.id, status: 'SKIP', note: `params 里没有 ${kind} 段` }); continue; }
  const img = kind ? pixels(probeAt(kind)) : null;
  const got = img ? MEASURE[m]?.(img) : null;
  if (got === null || got === undefined) { rows.push({ id: e.id, status: 'NO-DATA', note: '掩膜没找到目标' }); continue; }
  const tol = e.verify.tolerance ?? 0;
  let delta;
  if (Array.isArray(e.value)) {
    delta = Math.max(...e.value.map((v, i) => Math.abs(v - got[i])));
  } else {
    delta = Math.abs(e.value - got);
  }
  const pass = delta <= tol + 1e-9;
  rows.push({
    id: e.id, status: pass ? 'PASS' : 'FAIL',
    want: e.value, got, delta: +Number(delta).toFixed(4), tol,
    at: t, note: pass ? '' : '超差',
  });
}

const fail = rows.filter((r) => r.status === 'FAIL').length;
const pass = rows.filter((r) => r.status === 'PASS').length;
const skip = rows.filter((r) => r.status === 'SKIP').length;
const referenceOnly = rows.filter((r) => r.status === 'NO-METHOD' || r.status === 'NO-DATA').length;
// 可断言条目数下限：防止有人把 verify.method 改成 null 之后"断言变少但依然全绿"
const floor = CAL.assertable ?? 0;
const coverageShort = pass + skip < floor;

if (ASJSON) {
  console.log(JSON.stringify({
    kit: KIT, params: PARAMS, profile, pass, fail, skip, referenceOnly,
    assertableFloor: floor, coverageShort, rows,
  }, null, 2));
} else {
  console.log(`标定断言 · ${CAL.schema} · profile=${profile}`);
  console.log('检查项                       期望            实测            容差    判定');
  for (const r of rows) {
    const fmt = (v) => (Array.isArray(v) ? v.map((x) => Number(x).toFixed(4)).join(',') : v === undefined ? '—' : String(v));
    console.log(
      r.id.padEnd(28),
      fmt(r.want).padEnd(15),
      fmt(r.got).padEnd(15),
      String(r.tol ?? '').padEnd(7),
      r.status, r.note ? '  ' + r.note : '',
    );
  }
  console.log(`\nPASS ${pass} · FAIL ${fail} · SKIP ${skip} · 只供参考 ${referenceOnly}`);
  if (coverageShort) {
    console.log(`⚠ 可断言条目只有 ${pass + skip} 条，低于 calibration.assertable=${floor} —— 有断言被改成 null 或掩膜失效`);
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail || coverageShort ? 1 : 0);
