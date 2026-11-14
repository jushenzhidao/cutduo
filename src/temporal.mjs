#!/usr/bin/env node
/**
 * src/temporal.mjs · 时间轴契约：帧是唯一真相，秒是派生
 *
 * 与 src/timing.mjs 的分工（别混）：
 *   timing.mjs   工时账本 —— 一支片花了多少 author / render / revision，用来找优化点
 *   temporal.mjs 时间轴契约 —— 成片里每个镜头落在哪几帧，用来拒绝坏参数
 *
 * 为什么要有这个文件：本仓所有版式都按帧渲染，但 params 里的时间写成浮点秒
 * （`t0: 12.433, t1: 20.101`）。三件事没人管，一出就是成片上的可见错误：
 *   1. 窗口倒序或空（`t1 <= t0`）—— 渲染器画出一段 0 帧的镜头，静默跳过；
 *   2. 边界不在帧上（`t1 * 60 = 1206.06`）—— 逐帧取整后相邻镜头之间漏一帧或多一帧；
 *   3. 相邻窗口重叠 —— 后一个镜头抢走前一帧，转场闪一下。
 *
 * 模型取自 hypit 的分层（Narrative → Alignment → Projection → Instant/Window），
 * 本仓只需要后两层：**Window（绝对、半开、帧边界）** 与 **Extent（帧数）**。
 * 语义层（哪句话）归内容侧，渲染器不该知道。
 *
 * 三条硬规则（照它的校验语义，自己实现）：
 *   - 半开区间 `[start, end)`，必须非空；
 *   - 端点是**帧边界**（整帧），不是任意浮点；
 *   - 窗口属于某条 Timeline（同一 fps），越界即拒绝。
 * 校验器**不裁剪、不修复、不推断** —— 有问题就报出来，让人改声明。
 *
 * 声明式写法（对应 hypit 的 from/until/for 编辑语义）：
 *   { from: 2,  for: 0.5 }      起点锚定，改时长时末端跟随
 *   { until: 3, for: 0.5 }      末端锚定，改时长时起点跟随
 *   { from: 2,  until: 3 }      两端锚定
 * 改哪个字段只影响它声明的那一端，不需要手动同步另一个。
 *
 * CLI：
 *   node src/temporal.mjs <params.json> [...] [--allow-overlap]
 */

import fs from 'node:fs';
import path from 'node:path';

/* ---------------- 帧 ⇄ 秒 ---------------- */

/** 秒 → 帧。四舍五入到最近整帧（不要 floor：0.9999*30 会被截到 29） */
export const toFrame = (sec, fps) => Math.round(Number(sec) * Number(fps));

/** 帧 → 秒 */
export const toSeconds = (frame, fps) => Number(frame) / Number(fps);

/** 时间值偏离最近帧边界多少（单位：帧） */
export const frameError = (sec, fps) =>
  Math.abs(Number(sec) * Number(fps) - Math.round(Number(sec) * Number(fps)));

/* ---------------- 时间线 ---------------- */

export function makeTimeline({ fps, durationSeconds }) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) throw new Error(`fps 非法：${fps}`);
  const frames = durationSeconds === undefined || durationSeconds === null
    ? null : toFrame(durationSeconds, f);
  return {
    fps: f,
    frames,
    duration: frames === null ? null : toSeconds(frames, f),
    has(frame) { return this.frames === null ? frame >= 0 : frame >= 0 && frame <= this.frames; },
  };
}

/* ---------------- 窗口 ---------------- */

/**
 * 构造一个已校验的窗口。非法直接抛——构造阶段就不该产生坏值。
 */
export function makeWindow(startSec, endSec, tl, key = '') {
  const sf = toFrame(startSec, tl.fps);
  const ef = toFrame(endSec, tl.fps);
  if (ef <= sf) throw new Error(`${key} 空窗口或倒序：[${startSec}, ${endSec}) → [${sf}, ${ef}) 帧`);
  if (!tl.has(sf) || !tl.has(ef)) {
    throw new Error(`${key} 越界：[${sf}, ${ef}) 超出时间线 ${tl.frames ?? '?'} 帧`);
  }
  return {
    key,
    startFrame: sf, endFrame: ef,
    start: toSeconds(sf, tl.fps), end: toSeconds(ef, tl.fps),
    duration: toSeconds(ef - sf, tl.fps), frames: ef - sf,
  };
}

/**
 * 声明式窗口：三种写法语义不同，返回的 `edit` 说明改时长时该动哪一端。
 */
export function declareWindow(spec, tl, key = '') {
  const has = (k) => spec[k] !== undefined && spec[k] !== null;
  let start, end, edit;
  if (has('from') && has('until')) {
    start = Number(spec.from); end = Number(spec.until);
    edit = { mode: 'from+until', note: '两端锚定；移动时要同时改两个值' };
  } else if (has('from') && has('for')) {
    start = Number(spec.from); end = start + Number(spec.for);
    edit = { mode: 'from+for', note: '起点锚定；改时长只动 for，末端自动跟随' };
  } else if (has('until') && has('for')) {
    end = Number(spec.until); start = end - Number(spec.for);
    edit = { mode: 'until+for', note: '末端锚定；改时长只动 for，起点自动跟随' };
  } else {
    throw new Error(`${key} 声明不完整：需要 {from,until} / {from,for} / {until,for}，收到 ${JSON.stringify(spec)}`);
  }
  return { ...makeWindow(start, end, tl, key), edit };
}

/* ---------------- 从 params 提取窗口 ---------------- */

/**
 * 值是否像个时间（数字或纯数字字符串）。
 * 必须严格：`from` / `until` 在内容里也常用来表示"出处""直到"——
 * night-card 的 quote 段就有 { dur: 9, from: "某个凌晨 · 03:47" }，
 * 宽松判断会把它当成时间声明，直接拦死整支片（2026-11-14 冒烟实测）。
 */
const isTimeValue = (v) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()));

const ABS_PAIRS = [
  ['scenes', 't0', 't1'],
  ['shots', 't0', 't1'],
  ['segments', 't0', 't1'],
  ['captions', 'start', 'end'],
];

/**
 * 把一份 params 里的时间声明摊平。`segments[{dur}]` 按出现顺序累加成绝对窗口（science 用）。
 */
export function windowsOf(params) {
  const out = [];
  for (const [arrKey, a, b] of ABS_PAIRS) {
    const arr = params?.[arrKey];
    if (!Array.isArray(arr)) continue;
    const rows = [];
    arr.forEach((item, i) => {
      if (item == null) return;
      if (item[a] !== undefined && item[b] !== undefined) {
        rows.push({ kind: arrKey, index: i, mode: 'absolute', start: Number(item[a]), end: Number(item[b]) });
      } else if (item.dur !== undefined) {
        // dur 优先：同时出现 dur 与内容字段 from（出处）时，按相对时长理解
        rows.push({ kind: arrKey, index: i, mode: 'relative', dur: Number(item.dur) });
      } else if (isTimeValue(item.from) || isTimeValue(item.until)) {
        // 声明式：{from,for} / {until,for} / {from,until} —— 展开成绝对窗口再校验
        const tl0 = makeTimeline({ fps: Number(params?.fps || 30), durationSeconds: params?.durationSeconds });
        try {
          const w = declareWindow(item, tl0, `${arrKey}[${i}]`);
          rows.push({ kind: arrKey, index: i, mode: 'declared', start: w.start, end: w.end, edit: w.edit });
        } catch (e) {
          rows.push({ kind: arrKey, index: i, mode: 'conflict', note: e.message });
        }
      }
    });
    const abs = rows.filter((r) => r.mode === 'absolute');
    const rel = rows.filter((r) => r.mode === 'relative');
    if (abs.length && rel.length) {
      rows.push({ kind: arrKey, index: -1, mode: 'conflict',
        note: `${arrKey} 同时存在 ${a}/${b} 与 dur 两种写法，无法判断按哪种累加` });
    }
    if (rel.length) {
      let t = 0;
      for (const r of rel) { r.start = t; t += r.dur; r.end = t; }
    }
    out.push(...rows);
  }
  return out;
}

/* ---------------- 引用：@prev ---------------- */

/**
 * 解析时间引用。目前只支持"接上一段末端"这一种——它覆盖了顺移场景的绝大多数：
 *
 *   {"from": "@prev",       "for": 7.42}   紧接上一段
 *   {"from": "@prev+0.25",  "for": 7.42}   留 0.25s 拍间隔
 *   {"until": "@prev",      "for": 3}      倒过来锚定末端
 *
 * 不引入 `@scenes[2].end` 这类跨段引用：它需要拓扑排序与环检测，而真正需要跨段跳转时
 * 应该由内容侧（各片的 build.py）从配音重建整条轴，而不是在 params 里手写图。
 */
export function resolveRef(v, prevEnd) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s.startsWith('@')) return v;
  const m = s.match(/^@prev(?:\.end)?\s*(?:([+-])\s*([\d.]+))?$/);
  if (!m) throw new Error(`不认识的引用「${s}」（只支持 @prev / @prev+N / @prev-N）`);
  const off = m[2] ? Number(m[2]) : 0;
  return prevEnd + (m[1] === '-' ? -off : off);
}

/* ---------------- 规范化：声明式 → 绝对 ---------------- */

/**
 * 把 `{from, for}` / `{until, for}` / `{from, until}` 展开成 `t0/t1`（或 `start/end`），
 * 返回**新对象**，不改入参。渲染器因此完全不用认识声明式——它照旧读 t0/t1。
 *
 * 在 auditTiming 之前调用：校验和渲染必须用同一套展开，否则会出现"校验过了但渲染错位"。
 */
export function normalizeTiming(params, { fps } = {}) {
  const f = Number(fps ?? params?.fps);
  const out = JSON.parse(JSON.stringify(params));
  if (!Number.isFinite(f) || f <= 0) return out;
  // durationSeconds 也允许写引用，这样"改一段时长"只需要动 1 个字段：
  //   "durationSeconds": "@last"  → 取所有窗口的最大末端
  const durIsRef = typeof out.durationSeconds === 'string' && out.durationSeconds.startsWith('@');
  const tl = makeTimeline({ fps: f, durationSeconds: durIsRef ? undefined : out.durationSeconds });
  let converted = 0;
  let maxEnd = 0;
  for (const [arrKey, a, b] of ABS_PAIRS) {
    const arr = out[arrKey];
    if (!Array.isArray(arr)) continue;
    let prevEnd = 0;                    // 顺序解析：@prev 指向上一个已解析窗口的末端
    for (const item of arr) {
      if (item == null) continue;
      // 先把引用换成数字，再判断是不是声明式
      if (item.from !== undefined) item.from = resolveRef(item.from, prevEnd);
      if (item.until !== undefined) item.until = resolveRef(item.until, prevEnd);
      if (item[b] !== undefined) { prevEnd = Number(item[b]); maxEnd = Math.max(maxEnd, prevEnd); }

      if (item[a] !== undefined && item[b] !== undefined) continue;   // 已是绝对
      if (item.dur !== undefined) {                                   // 相对时长由渲染器累加
        prevEnd = prevEnd + Number(item.dur);
        continue;
      }
      if (!isTimeValue(item.from) && !isTimeValue(item.until)) continue;  // from 可能是"出处"（内容字段）
      const w = declareWindow(item, tl, `${arrKey}`);
      // 展开时直接落到帧上：`for: 12.43` 这类十进制在 t0+for 时会带 1e-4 级误差，
      // 个别帧边界会被取整到相邻帧（实测 6339 帧里有 16 帧与手写版不一致）。
      // 声明式窗口本来就是"作者按帧想"，落在帧上没有副作用。
      item[a] = toSeconds(w.startFrame, f);
      item[b] = toSeconds(w.endFrame, f);
      prevEnd = item[b];
      maxEnd = Math.max(maxEnd, prevEnd);
      delete item.from; delete item.until; delete item.for;
      converted++;
    }
  }
  if (durIsRef) {
    if (maxEnd <= 0) throw new Error(`durationSeconds 写成了引用「${out.durationSeconds}」，但没有任何可解析的窗口末端`);
    const m = String(out.durationSeconds).match(/^@last\s*(?:([+-])\s*([\d.]+))?$/);
    if (!m) throw new Error(`durationSeconds 的引用只支持 @last / @last+N / @last-N，收到「${out.durationSeconds}」`);
    const off = m[2] ? Number(m[2]) : 0;
    // 常用 `@last+0.02` 留一点尾帧，避免最后一段的收尾动画被切掉
    out.durationSeconds = +(maxEnd + (m[1] === '-' ? -off : off)).toFixed(4);
  }
  if (converted) out._timingNormalized = converted;
  return out;
}

/* ---------------- 校验 ---------------- */

const OVERLAP_EPS = 1e-6;

export function auditTiming(rawParams, { fps, durationSeconds, allowOverlap = false } = {}) {
  const errors = [], warnings = [];
  // **先展开再校验**：声明式、@prev/@last 引用都必须在同一套规范化之后才验得了。
  // 不展开时 `durationSeconds: "@last+0.02"` 会变成 NaN，报出"超出时间线 NaN 帧"这种噪音。
  let params = rawParams;
  try {
    params = normalizeTiming(rawParams, { fps });
  } catch (e) {
    return { ok: false, fps: Number(fps ?? rawParams?.fps), windows: 0, errors: [`时间声明展开失败：${e.message}`], warnings };
  }
  const f = Number(fps ?? params?.fps);
  const dur = durationSeconds ?? params?.durationSeconds;

  if (!Number.isFinite(f) || f <= 0) {
    return { ok: false, fps: f, windows: 0, errors: [`缺少或非法 fps（${fps ?? params?.fps}）`], warnings };
  }
  const tl = makeTimeline({ fps: f, durationSeconds: Number.isFinite(Number(dur)) ? Number(dur) : undefined });

  const raw = windowsOf(params);
  const caps0 = Array.isArray(params?.captions) ? params.captions : [];
  const isSkeletonCaps = caps0.length > 1 &&
    caps0.every((c) => Number(c?.start) === 0 && Number(c?.end) <= 1);
  let checked = 0;
  for (const w of raw) {
    if (w.mode === 'conflict') { errors.push(w.note); continue; }
    const label = `${w.kind}[${w.index}]`;
    // 1) 端点的帧对齐：**只告警不拦**。本仓时间多来自口播实测（浮点秒），
    //    hypit 那边是作者直接声明帧，照搬会把 0.16–0.36 帧的正常偏差全判成错（v8t 一次 30 条）。
    //    真正的风险是"相邻窗口取整后不连续"，那条用帧比较单独判（见下）。
    for (const [name, v] of [['起点', w.start], ['末端', w.end]]) {
      const err = frameError(v, tl.fps);
      if (err > 0.5) warnings.push(`${label} ${name} ${v}s 偏离帧边界 ${err.toFixed(2)} 帧（超过半帧，取整会错开一帧）`);
    }
    // 2) 构造（拒绝空窗口/倒序/越界）
    try {
      const win = makeWindow(w.start, w.end, tl, label);
      if (w.mode === 'relative' && win.frames === 0) errors.push(`${label} dur 折算为 0 帧`);
      checked++;
    } catch (e) {
      // 未配音骨架里，segments 的 dur 是"设计时长"、durationSeconds 是"目标时长"，
      // 本来就不相等（配音后由 vo.py 重算）。这类越界记告警；配音版越界才是真错。
      // 骨架文件的时间字段整体是占位（captions 0–1s、segments 只有设计 dur），
      // 一律降为告警；只有配音版的越界/空窗口才是真错。
      const skeletal = isSkeletonCaps && (w.kind === 'segments' || w.kind === 'captions');
      (skeletal ? warnings : errors).push(e.message);
    }
  }

  // 骨架识别：未配音的模板把 captions 全写成 {start:0,end:0..1}。
  // 这类文件的重叠/空隙是占位造成的，不是内容错误——单独记一条，不刷十几行 FAIL。
  if (isSkeletonCaps) warnings.push(`captions 疑似未配音骨架（${caps0.length} 条全部落在 0–1s），跳过重叠检查`);

  // 3) 同类窗口重叠 / 空隙（转场类版式可能故意重叠，--allow-overlap 关掉）
  if (!allowOverlap) {
    const byKind = {};
    for (const w of raw) {
      if (w.mode === 'conflict' || w.index < 0) continue;
      if (isSkeletonCaps && w.kind === 'captions') continue;
      (byKind[w.kind] ||= []).push(w);
    }
    for (const [kind, list] of Object.entries(byKind)) {
      const sorted = [...list].sort((x, y) => x.start - y.start);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1], cur = sorted[i];
        // 用**帧**比较：取整后 prev 的末帧应当正好是 cur 的首帧。
        // 用秒比会因浮点误差放过真实的 1 帧错位，也会因 0.001s 重叠误报。
        const pe = toFrame(prev.end, tl.fps), cs = toFrame(cur.start, tl.fps);
        if (cs < pe) {
          errors.push(`${kind}[${prev.index}]→[${cur.index}] 取整后重叠 ${pe - cs} 帧（${prev.end}s / ${cur.start}s）`);
        } else if (cs > pe) {
          const gapS = toSeconds(cs - pe, tl.fps);
          if (gapS > 0.5) warnings.push(`${kind}[${prev.index}]→[${cur.index}] 取整后空隙 ${cs - pe} 帧（${gapS.toFixed(2)}s）`);
        }
      }
    }
  }

  return { ok: errors.length === 0, fps: tl.fps, windows: checked, errors, warnings };
}

/* ---------------- CLI ---------------- */

const self = path.resolve(new URL(import.meta.url).pathname);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('用法: node src/temporal.mjs <params.json> [...] [--allow-overlap]');
    process.exit(2);
  }
  const allowOverlap = process.argv.includes('--allow-overlap');
  let bad = 0;
  for (const f of files) {
    let p;
    try { p = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.log(`✗ ${path.basename(f)}  读取失败: ${e.message}`); bad++; continue; }
    if (!Number.isFinite(Number(p?.fps)) && windowsOf(p).length === 0) {
      console.log(`- ${path.basename(f).padEnd(30)} 跳过（不是参数文件：无 fps 也无时间声明）`);
      continue;
    }
    const r = auditTiming(p, { allowOverlap });
    console.log(`${r.ok ? '✓' : '✗'} ${path.basename(f).padEnd(30)} ${r.fps}fps · ${r.windows} 窗口` +
      (r.errors.length ? ` · ${r.errors.length} 错` : '') + (r.warnings.length ? ` · ${r.warnings.length} 告警` : ''));
    for (const e of r.errors) console.log(`     FAIL  ${e}`);
    for (const w of r.warnings) console.log(`     warn  ${w}`);
    if (!r.ok) bad++;
  }
  console.log(`\n${files.length - bad}/${files.length} 通过`);
  process.exit(bad ? 1 : 0);
}
