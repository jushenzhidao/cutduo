#!/usr/bin/env node
// pacing.mjs — 节奏体检：最长静止 / 段末落位停留 / 是真静还是小面积动作。
//
// 为什么需要这个（2026-11-14，蒸馏 anything2explainer 后的结论）：
// gate.mjs 现在能判「空帧 / 黑帧 / 冻结 / 音画差」，但判不了**节奏**——「元素入场就停着等下一拍」
// 和「元素刚落位就切走」是同一枚硬币的两面，两者都不影响完整性，成片照样 PASS，观感却是平的。
// 上游把这两个现象量化成了两个数（最长静止 ≤3 s、末拍落位后停 30–45 帧），这份工具做同一件事，
// 但换成这个仓库的口径。
//
// 三个口径差异，照抄上游会全错（实测数据见 docs/探究-anything2explainer-2026-11-14.md §三）：
//   1. 上游的「静止」= 320×180 灰度平均变化 <0.35，而它**每 3 帧抽一张**、片是 30fps
//      ⇒ 时间基线是 **0.1 秒**（STEP/fps），不是 1 帧。本仓 1920×1080@60fps，若拿相邻帧比，
//      基线只有 0.017 秒，同一段慢动作的差分只有上游的 1/6，读数会全线虚低（实测：生日悖论
//      相邻帧口径 96.7% 判静止，0.1 秒口径 93%）。所以这里按 `--equiv-fps`（**默认 10**，
//      即 0.1 秒基线）比较「相隔 k 帧」的两帧，k = fps/equiv，把时间基线拉回与上游同尺度。
//      帧率归一靠这条；面积归一不靠——差分是均值，与分辨率无关。
//   2. 上游按「镜头」统计（分镜表帧区间），本仓按「段」统计（params 的 scenes / segments）。
//      段 = 一个画面单元，与上游的镜头语义一致，所以 hold 的语义可以直接平移：
//      「末拍元素落位 → 离场」= 段末最后一次大变化之后，画面还稳了多久。
//   3. 上游黑底白线（lum>120 取前景），本仓 paper 是浅底深字、science 是深底。
//      本工具不看前景色，只量**变化量**，所以与底色无关——这是选择差分口径而不是构图口径的原因。
//
// 用法：
//   node tools/pacing.mjs out/birthday-paradox-final.mp4 --params content/birthday-paradox/params.json
//   node tools/pacing.mjs out/x.mp4 --cuts 0,7.9,16.2        # 手给段界（秒）
//   node tools/pacing.mjs out/x.mp4 --params ... --json qc/pacing.json
//
// 判据（默认值，2026-11-14 在本仓 4 支科普片上标定，见 LIMIT 注释）：
//   最长静止  > stillMax   → ✗  段内有一段画面完全不动（观众读作卡住）
//   段末 hold < holdMin    → ✗  落位即切（观众读作"刚看到就没了"）
//   真静（最长静止段内变化像素中位数 < quietPx）→ 提示"给这一段的动词配个动作"，不要加漂浮/呼吸
//   stillPct 只报不判（沿用本仓 gate.mjs 对"静止"的一贯态度：版式节奏不是缺陷）

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as BINS from '../src/bins.mjs';

const FFMPEG = BINS.FFMPEG;
const FFPROBE = BINS.FFPROBE;
const PROBE_W = 640;   // 差分采样宽（下游再 2×2 压到 320 算均值，与上游帧度量同尺度）
const PROBE_H = 360;

// 与上游 motion_check.py 同量级，但经过本仓语料复核（见 docs 标定表）。
const LIMIT = {
  stillMean: 0.35,   // 320×180 灰度平均变化低于此值 = 静止帧（上游 THR，0.1 s 时间基线下）
  holdMean: 1.5,     // 低于此值 = "没有大面积变化"，用于数段末稳定期（上游 HOLD_THR）
  // 最长静止上限：**按版式分档，不能只有一个数**。2026-11-14 在本仓语料上实测（内容区，0.1 s 基线）：
  //   cute-mv（MG）静止占比 6%、最长 0.57 s       ← 天生连续运动，任何静止阈值都碰不到
  //   benford 86% / 5.17 s · gut-antibiotic 86% / 6.83 s · selection-bias 91% / 5.92 s   ← 排版式，静止是设计
  //   birthday-paradox 92% / **17.77 s**          ← 同一版式的离群值，也是"节奏拖"的实证
  // 上游的 3.0 s 是 MG 口径；直接搬会把 4 支科普片全判失败、却对 MG 片毫无作用。
  // 所以默认取排版式语料的最大值 + 余量（8 s），--strict 才用上游 3 s（MG / 短科普）。
  stillMax: 8.0,
  holdMin: 30,       // 段末稳定期下限（帧，30fps 口径；60fps 片自动折算）。这是**下界**判据：
                     // 排版式几乎每段都远超它（实测 min 34–286 f），只有"落位即切"才会掉下来。
  quietPx: 200,      // 640×360 下变化像素数的"真静"下限（上游 800px 是在 1280×720 上量的，按面积折算 1/4）
};

function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate,nb_frames', '-show_entries', 'format=duration', '-of', 'json', file],
  { encoding: 'utf8' });
  const d = JSON.parse(out);
  const s = (d.streams || [])[0] || {};
  const [n, m] = String(s.r_frame_rate || '30/1').split('/').map(Number);
  return {
    w: s.width, h: s.height,
    fps: m ? n / m : 30,
    dur: Number(d.format?.duration || 0),
    frames: Number(s.nb_frames || 0),
  };
}

// 段界：优先 params（scenes[].t0+dur / segments[].dur 前缀和），其次 --cuts。
// 与 src/temporal.mjs 的约定一致：scenes 用 t0，segments 只用 dur 累加。
function segmentsFromParams(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  // 本仓两种写法：scenes 有的是绝对 {t0,t1}（build 产物），有的只有 {dur}（手写）；
  // segments（science 系）只有 dur，必须前缀和——与 src/temporal.mjs 同一约定。
  // 链式写法（params-chain.json，渲染真正用的那份）：from 是 '@prev' / '@prev+0.25'，
  // 要按前一段的末尾递推，不能当绝对秒读。渲染用的就是它，取段界应当优先用它。
  const isChain = (s) => typeof s.from === 'string' && s.from.startsWith('@prev');
  const chainArr = Array.isArray(j.scenes) && j.scenes.length ? j.scenes
    : (Array.isArray(j.segments) && j.segments.length ? j.segments : []);
  if (chainArr.length && (isChain(chainArr[0]) || typeof chainArr[0].for === 'number')) {
    let end = 0;
    return chainArr.map((s) => {
      let t0 = 0;
      if (typeof s.from === 'number') t0 = s.from;
      else if (isChain(s)) {
        const m = String(s.from).match(/^@prev([+-]\d*\.?\d+)?$/);
        t0 = end + (m && m[1] ? Number(m[1]) : 0);
      }
      const dur = Number(s.for ?? s.dur ?? 0);
      end = t0 + dur;
      return { t0, dur, type: s.type };
    });
  }
  const norm = (arr) => arr.map((s) => {
    if (typeof s.t0 === 'number' && typeof s.t1 === 'number') return { t0: s.t0, dur: s.t1 - s.t0, type: s.type };
    if (typeof s.t0 === 'number' && typeof s.dur === 'number') return { t0: s.t0, dur: s.dur, type: s.type };
    return { t0: null, dur: Number(s.dur || 0), type: s.type };
  });
  const fill = (list) => {
    let t = 0;
    return list.map((s) => { if (s.t0 == null) { s.t0 = t; } t = s.t0 + s.dur; return s; });
  };
  if (Array.isArray(j.segments) && j.segments.length) return fill(norm(j.segments));
  if (Array.isArray(j.scenes) && j.scenes.length) return fill(norm(j.scenes));
  return null;
}

function segmentsFromCuts(spec) {
  const cuts = spec.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push({ t0: cuts[i], dur: cuts[i + 1] - cuts[i], type: `S${i + 1}` });
  return out;
}

// 逐帧差分：ffmpeg 出一路 640×360 灰度，Node 边读边算，不落盘。
// 为什么要自己算而不是用 ffmpeg 的 tblend：需要"相隔 k 帧"的差分（帧率归一口径）+ 变化像素计数，
// tblend 只能相邻帧相减，60fps 上读数会小一半。
function analyze(file, info, opt) {
  const k = Math.max(1, Math.round(info.fps / opt.equivFps));   // 归一到 equiv-fps 口径的帧距
  const crop = opt.content;                                     // [top, bottom] 比例
  const y0 = Math.round(PROBE_H * crop[0]);
  const y1 = Math.round(PROBE_H * crop[1]);

  const args = ['-v', 'error', '-i', file, '-an', '-vf',
    `scale=${PROBE_W}:${PROBE_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'];
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const frameBytes = PROBE_W * PROBE_H;
  const ring = [];                     // 只留 k+1 帧，窗口足够
  const diffMean = [];                 // 与第 i-k 帧的差（index 对齐到 i）
  const diffPx = [];
  let buf = Buffer.alloc(0);
  let idx = 0;

  return new Promise((resolve, reject) => {
    p.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameBytes) {
        const f = buf.subarray(0, frameBytes);
        buf = buf.subarray(frameBytes);
        ring.push(f);
        if (ring.length > k + 1) ring.shift();
        if (ring.length === k + 1) {
          const prev = ring[0];
          let acc = 0, cnt = 0, changed = 0;
          for (let y = y0; y < y1; y++) {
            const base = y * PROBE_W;
            for (let x = 0; x < PROBE_W; x++) {
              const d = f[base + x] - prev[base + x];
              const a = d < 0 ? -d : d;
              acc += a; cnt++;
              if (a > 25) changed++;
            }
          }
          diffMean.push(acc / cnt);
          diffPx.push(changed);
        } else {
          diffMean.push(null); diffPx.push(null);
        }
        idx++;
      }
    });
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', () => resolve({ diffMean, diffPx, k, frames: idx }));
  });
}

function statsForSeg(seg, i0, i1, data, info, opt, continuous) {
  const k = data.k;
  const from = Math.max(i0, k), to = Math.min(i1, data.frames - 1);
  const d = [], px = [];
  for (let i = from; i <= to; i++) { if (data.diffMean[i] != null) { d.push(data.diffMean[i]); px.push(data.diffPx[i]); } }
  if (!d.length) return { type: seg.type, dur: +(i1 - i0 + 1) / info.fps, stillPct: 0, longestS: 0, holdFrames30: 0, holdS: 0, quietPx: 0, quiet: false, flags: [] };

  // 静止帧：diffMean 每个下标都有一项（第 i 帧 vs 第 i-k 帧），相邻下标相隔 **1 帧**，
  // 所以连续长度 best 就是连续帧数，换算秒要除以 fps，不是乘 k/fps。
  const still = d.filter((v) => v < LIMIT.stillMean).length / d.length;
  let run = 0, best = 0, bestEnd = -1;
  d.forEach((v, i) => { run = v < LIMIT.stillMean ? run + 1 : 0; if (run > best) { best = run; bestEnd = i; } });
  const longestS = best / info.fps;

  // 安静段里的"真静 vs 小面积动作"。
  // 只看中位数会把"每 10 秒换一行字"判成完全冻结（中位仍是 0），所以另数"有可见局部变化"的帧数：
  // 均值 <0.35 只说明整屏平均没动，一次明显的局部替换（一行字、一个数字）会被面积摊薄掉。
  // 三个读数一起看才准：
  //   quietPx  整段静止帧的「变化像素」中位数  → 有没有在动
  //   events   有可见局部变化的帧数             → 动了多少次
  //   ampPct   那些变化帧的典型面积（占内容区）→ 每次动得多大
  // 只看均值会把「每 4 秒揭示一行字、每次只占 0.5% 面积」判成冻结——实测 birthday-paradox 的
  // steps 段就是这样：16.15 s 里有 88 次变化，但每次只有 ~870 px（0.5%），均值永远够不到 0.35。
  // 这和「真的没动」是两种病，修法相反：一个要加动作，一个要加大幅度。
  let quietPx = 0, events = 0, ampPct = 0;
  const areaPx = 640 * (310 - 36);
  if (best > 0) {
    const s0 = Math.max(0, bestEnd - best + 1);
    const segPx = px.slice(s0, bestEnd + 1);
    const sorted = [...segPx].sort((a, b) => a - b);
    quietPx = sorted[Math.floor(sorted.length / 2)] || 0;
    const hit = segPx.filter((v) => v >= 50);       // ≥50 像素：一行字/一个数字的量级
    events = hit.length;
    if (hit.length) {
      // 用 p90 而不是中位：一次动画的头尾帧只变几十像素，中位会把「每次揭示多大」估低一半。
      const hs = [...hit].sort((a, b) => a - b);
      ampPct = +(hs[Math.floor(hs.length * 0.9)] / areaPx * 100).toFixed(2);
    }
  }

  // 段末 hold = 段尾最后一段「安静」有多长。两个必须处理的边界：
  //
  //  1. params 的 t1 来自音频时长，与画面切点常差 ±0.1 s（实测 gut-antibiotic 段界 16.488 s、
  //     画面 16.40 s 就切了）。差的这几帧会让切点本身落进段内，差分飙到 40。
  //  2. 差分是 diffMean[i] = |帧i − 帧(i−k)|，一次硬切会让**切点之后持续若干帧**都偏高
  //     （实测 4 帧：0.60 → 3.33 → 6.17 → 7.07 → 6.90）。
  //
  // 所以先从段尾往前跳过整段"活动帧"，落到最后一个安静帧，再从那里往回数连续安静帧。
  // 反过来做（先数、遇活动就停）会让起点落在切的拖尾里，hold 恒为 0，全片误报"落位即切"。
  let e = i1;
  while (e > i0 + k && data.diffMean[e] != null && data.diffMean[e] >= LIMIT.holdMean) e--;
  let hold = 0;
  for (let i = e; i > i0 + k; i--) {
    if (data.diffMean[i] != null && data.diffMean[i] < LIMIT.holdMean) hold += 1; else break;
  }
  // diffMean[i] 量的是 (i−k, i] 这一段，所以运动刚停的头 k 帧读不出来，读数恒少 k 帧。
  // 合成对照实测：静止 1.0 s（30 帧）后切，不补时读 27 f、补 k 后 30 f。
  // 补回测量窗口，判据才不会因为口径而误杀（本仓真片最小 34 f，本不敏感，但合成用例会露馅）。
  if (hold > 0) hold = Math.min(hold + k, i1 - i0 + 1);
  const holdFrames30 = Math.round(hold * (30 / info.fps));  // 归一到 30fps 口径，与 holdMin 可比

  // 最长静止落在哪、属于哪一类 —— 光给一个秒数无法修，得能直接跳到那一段。
  // 归因按「这段静止从段首多快开始」与「是否一直停到段尾」分三类，修法完全不同：
  //   全程停  整段就没有动作      → 给动词配动作，或并进相邻拍（不要加漂浮）
  //   入场即停 前面有过动作，之后一直停 → 上游「入场即停」，后段全是空转
  //   中段停  停了又动            → 中间那段是多余的
  let worst = null;
  if (best > 0) {
    const runStart = from + (bestEnd - best + 1);
    const runEnd = from + bestEnd;               // 帧号（含）
    const offset = (runStart - i0) / info.fps;    // 距段首多远开始停
    const reachesEnd = runEnd >= i1 - 2;
    const kind = !reachesEnd ? '中段停' : (offset < 1.5 ? '全程停' : '入场即停');
    const frozen = events === 0;
    const smallAmp = events > 0 && ampPct < 1.0;    // <1% 面积 = 小面积动作（上游 800–2500px@1280×720 ≈ 0.09–0.27%）
    worst = {
      from: +(runStart / info.fps).toFixed(2),
      to: +((runEnd + 1) / info.fps).toFixed(2),
      dur: +longestS.toFixed(2),
      offset: +offset.toFixed(2),
      kind: frozen ? kind : (smallAmp ? `${kind}·小幅度` : `${kind}·稀疏`),
      events, ampPct,
      advice: frozen
        ? `这段 ${longestS.toFixed(1)}s 真的没动：给这一拍的动词配动作，或并进相邻拍（不要加漂浮/呼吸）`
        : smallAmp
          ? `${longestS.toFixed(1)}s 里只有 ${events} 次变化、每次约 ${ampPct}% 面积：幅度太小，`
            + '把这些揭示做大（放大主体 / 加位移与光），不要加新元素'
          : `${longestS.toFixed(1)}s 里只有 ${events} 次变化、每次约 ${ampPct}% 面积：`
            + '一拍一换、中间空转，考虑拆拍或并拍',
    };
  }

  const flags = [];
  if (longestS > LIMIT.stillMax) flags.push(`still ${longestS.toFixed(1)}s>${LIMIT.stillMax}`);
  // hold 只在**有段界**时判：
  //   · 连续运动型（全片静止 <20%）没有"落位"这个动作 —— cute-mv 全片 6%、hold 恒为 0，照判 100% 假阳性；
  //   · 单段模式（没给 --params/--cuts，type=ALL）量到的是"片尾最后一个元素到结束"，那里没有切点，
  //     末尾本来就该收束（实测 night-card / chalkboard 全片模式 hold 14 f，是口径不是缺陷）。
  const hasCuts = seg.type !== 'ALL';
  if (hasCuts && !continuous && holdFrames30 < LIMIT.holdMin) flags.push(`hold ${holdFrames30}f<${LIMIT.holdMin}`);
  const quiet = best > 0 && quietPx < LIMIT.quietPx;

  return {
    type: seg.type, dur: +(i1 - i0 + 1) / info.fps,
    stillPct: +(still * 100).toFixed(0),
    longestS: +longestS.toFixed(2),
    worst,
    holdFrames30, holdS: +(holdFrames30 / 30).toFixed(2),
    quietPx, quiet, flags,
  };
}

function parseArgs(argv) {
  // params 可重复给，按顺序与 files 一一对应（多片各用各的段界）；只给一个则对所有片生效。
  const o = { equivFps: 10, content: [0.10, 0.86], json: '', params: [], cuts: '' };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--equiv-fps') o.equivFps = Number(argv[++i]);
    else if (a === '--content') o.content = String(argv[++i]).split(',').map(Number);
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--params') o.params.push(argv[++i]);
    else if (a === '--cuts') o.cuts = argv[++i];
    else if (a === '--still-max') LIMIT.stillMax = Number(argv[++i]);
    else if (a === '--hold-min') LIMIT.holdMin = Number(argv[++i]);
    else if (a === '--strict') { LIMIT.stillMax = 3.0; }   // MG / 短科普口径（上游值）
    else if (!a.startsWith('-')) files.push(a);
  }
  return { o, files };
}

async function main() {
  const { o, files } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.error('用法: node tools/pacing.mjs <video.mp4> [--params params.json | --cuts 0,7.9,16.2] [--json out.json]');
    process.exit(2);
  }
  const out = [];
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    if (!existsSync(file)) { console.error(`文件不存在: ${file}`); process.exitCode = 2; continue; }
    const info = probe(file);
    const pf = o.params[fi] || o.params[0];   // 一一对应；只给一个则复用
    let segs = null;
    if (pf) {
      // 显式给了 params 却取不到段界（没有 scenes/segments、或读不到文件）→ 报错。
      // 不能静默退化成单段模式：那会用量错的段界继续跑，读数和结论都是假的。
      try {
        segs = segmentsFromParams(pf);
      } catch (e) {
        console.error(`--params ${pf} 读取失败：${e.message}`);
        process.exitCode = 2; continue;
      }
      if (!segs || !segs.length) {
        console.error(`--params ${pf} 里没有 scenes / segments，取不到段界`);
        process.exitCode = 2; continue;
      }
    } else if (o.cuts) {
      segs = segmentsFromCuts(o.cuts);
    }
    if (!segs) {
      // 没有段界就整片当一段：能出"全片最长静止"，出不了 hold 的分布
      segs = [{ t0: 0, dur: info.dur, type: 'ALL' }];
    }
    const data = await analyze(file, info, o);
    // 先量全片静止占比，决定 hold 是否适用（连续运动型不判 hold）
    const allD = data.diffMean.filter((v) => v != null);
    const filmStill = allD.length ? allD.filter((v) => v < LIMIT.stillMean).length / allD.length * 100 : 0;
    const continuous = filmStill < 20;
    const rows = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const i0 = Math.round(s.t0 * info.fps);
      const i1 = Math.min(Math.round((s.t0 + s.dur) * info.fps) - 1, data.frames - 1);
      if (i1 <= i0) continue;
      rows.push({ i: i + 1, t0: +s.t0.toFixed(2), ...statsForSeg(s, i0, i1, data, info, o, continuous) });
    }

    const bad = rows.filter((r) => r.flags && r.flags.length);
    const h = (arr) => {
      const v = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      return v.length ? { min: v[0], p10: v[Math.floor(v.length * 0.1)], med: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : {};
    };
    const sum = {
      file: path.basename(file), w: info.w, h: info.h, fps: +info.fps.toFixed(2), dur: +info.dur.toFixed(2),
      segs: rows.length,
      equivK: data.k,
      filmStillPct: +filmStill.toFixed(0),
      continuous,
      longestStill: h(rows.map((r) => r.longestS)),
      hold: h(rows.map((r) => r.holdFrames30)),
      stillPct: h(rows.map((r) => r.stillPct)),
      fail: bad.length,
    };
    out.push({ sum, rows });

    const name = path.basename(file);
    console.log(`\n${name}  ${info.w}×${info.h}@${info.fps.toFixed(0)}  ${info.dur.toFixed(1)}s  ${rows.length} 段  (差分口径 ${data.k} 帧/采样 ≈ ${o.equivFps}fps；全片静止 ${filmStill.toFixed(0)}%${continuous ? ' → 连续运动型，hold 不判' : ''})`);
    console.log(`${'#'.padStart(3)} ${'t0'.padStart(6)} ${'type'.padEnd(10)} ${'dur'.padStart(6)} ${'still%'.padStart(6)} ${'最长静'.padStart(7)} ${'hold'.padStart(6)} ${'静px'.padStart(6)}  判定${segs.length === 1 && segs[0].type === 'ALL' ? '  (单段模式：hold 不判)' : ''}`);
    for (const r of rows) {
      const v = r.flags && r.flags.length ? `✗ ${r.flags.join(' ')}` : 'OK';
      console.log(`${String(r.i).padStart(3)} ${String(r.t0).padStart(6)} ${String(r.type || '').padEnd(10)} ${String(r.dur.toFixed(1)).padStart(6)} ${String(r.stillPct).padStart(5)}% ${String(r.longestS).padStart(6)}s ${String(r.holdFrames30).padStart(5)}f ${String(r.quietPx).padStart(6)}  ${v}${r.quiet ? ' 〔真静〕' : ''}`);
    }
    // 把"哪一段、停多久、为什么"直接打出来：只有秒数的话，修的人得自己回去找。
    const hot = rows.filter((r) => r.worst && r.worst.dur > LIMIT.stillMax)
      .sort((x, y) => y.worst.dur - x.worst.dur);
    if (hot.length) {
      console.log('最该修（按最长静止排序，前 3 处）：');
      for (const r of hot.slice(0, 3)) {
        const w = r.worst;
        console.log(`  ${w.from.toFixed(1)}–${w.to.toFixed(1)}s  ${String(w.dur).padStart(5)}s  ${String(r.type || '').padEnd(9)} ${w.kind} —— ${w.advice}`);
      }
    }
    console.log(`合计：最长静止 max ${sum.longestStill.max}s / p50 ${sum.longestStill.med}s；hold min ${sum.hold.min}f / p50 ${sum.hold.med}f；不达标 ${sum.fail}/${rows.length} 段`);
  }
  // 多片汇总：按最坏段排序，一眼看出该先修哪支
  if (out.length > 1) {
    const rank = out.map((f) => {
      const segs = f.rows.filter((r) => r.worst);
      const w = segs.sort((a, b) => b.worst.dur - a.worst.dur)[0];
      return {
        name: f.sum.file,
        worst: w ? w.worst.dur : 0,
        type: w ? w.worst.kind : '-',
        still: f.sum.filmStillPct,
        hold: f.sum.hold.min,
        fail: f.sum.fail,
        n: f.sum.segs,
      };
    }).sort((a, b) => b.worst - a.worst);
    console.log(`\n${'片名'.padEnd(30)} ${'最坏段'.padStart(7)} ${'静止%'.padStart(6)} ${'hold'.padStart(6)} ${'不达标'.padStart(8)}  归因`);
    for (const r of rank) {
      console.log(`${r.name.padEnd(30)} ${String(r.worst + 's').padStart(7)} ${String(r.still + '%').padStart(6)} ${String(r.hold + 'f').padStart(6)} ${String(r.fail + '/' + r.n).padStart(8)}  ${r.type}`);
    }
  }
  if (o.json) {
    writeFileSync(o.json, JSON.stringify({ limits: LIMIT, films: out }, null, 2));
    console.log(`\n→ ${o.json}`);
  }
  // 段不达标 → 1；输入错误（exitCode 已置 2）优先于 0 但让位于 1
  if (out.some((f) => f.sum.fail)) process.exitCode = 1;
  else process.exitCode = process.exitCode || 0;
}

main().catch((e) => { console.error(e.message); process.exit(2); });
