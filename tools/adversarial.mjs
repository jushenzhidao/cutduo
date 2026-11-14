#!/usr/bin/env node
/**
 * adversarial.mjs — 生成后的对抗审查执行器
 *
 * 为什么要有：仓里已有两道门（`src/gate.mjs` 判"是不是一支能播的片"，
 * `tools/verify-calibration.mjs` 判"像不像那一代外观"），但这两道都**不看内容层**。
 * 历史上真出过的事故——切点帧错位、元素等到段尾才出现、整片黑底、PCM 音轨让浏览器静音——
 * 都能过 gate。这里把这些"能过门但一看就错"的情形写成断言。
 *
 *   node tools/adversarial.mjs --video out/x.mp4 --params out/x.vo.json
 *   node tools/adversarial.mjs --video out/x.mp4 --params out/x.vo.json --ref ref.mp4
 *
 * 分级：BLOCKER（不可交付）/ WARN（能交但要解释）/ NOTE（提醒，不影响结论）
 * 退出码只在有 BLOCKER 时非 0——WARN 不该拦住流水线，但必须被打印出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const VIDEO = arg('video');
const PARAMS = arg('params');
const REF = arg('ref', null);
const ASJSON = process.argv.includes('--json');
if (!VIDEO || !PARAMS) {
  console.error('用法: node tools/adversarial.mjs --video <mp4> --params <preset.json> [--ref <mp4>] [--json]');
  process.exit(2);
}

const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
// fps 先按 params 兜底，探测到视频后以**成片实测帧率**为准（见下方 ffprobe 段）：
// 用 params 的 30 去切 60fps 的帧序列，切点索引会整体减半，8 个切点全被判成"重复帧"。
let fps = Number(P.fps || 30);
const rows = [];
const add = (level, id, msg) => rows.push({ level, id, msg });

// ───────────────────────── 1. 结构层（只读 params，不碰画面） ─────────────────────────
let acc = 0;
// science 用 segments（无 t0/t1，按 dur 累加），paper 用 scenes（带 t0/t1，段间有 0.25s gap）。
// 只认 segments 时 paper 片会被判成"0 段"，进而刷出 seg.sum 的假 BLOCKER。
// 段边界换算成帧号。两种参数的边界算法**不一样**，混用会得到假的"重复帧"：
//   · segments（science）：无 t0/t1，渲染器按 t >= t0 逐帧比较 ⇒ 边界在 ceil；
//     设了 snapToFrames 时渲染器会把 t0 量化 ⇒ 边界在 round。
//   · scenes（paper/editorial）：窗口在 temporal 层解析成帧区间 ⇒ 边界在 round。
// 用错一个（对 paper 用 ceil）会把"切后第一帧"和"切后第二帧"拿来比，差异恒为 0。
const boundaryOf = (sec) => (P.segments
  ? (P.snapToFrames === true ? Math.round(sec * fps) : Math.ceil(sec * fps - 1e-9))
  : Math.round(sec * fps));

const segs = (P.segments || P.scenes || []).map((s) => {
  const t0 = s.t0 === undefined ? acc : Number(s.t0);
  const t1 = s.t1 === undefined ? t0 + Number(s.dur || 0) : Number(s.t1);
  acc = t1;
  return { type: s.type, t0, t1, dur: t1 - t0, args: s.args || s };
});
const total = segs.length ? segs[segs.length - 1].t1 : 0;
const declared = Number(P.durationSeconds || total);

if (Math.abs(declared - total) > 1 / fps + 1e-6) {
  add('BLOCKER', 'seg.sum', `durationSeconds ${declared.toFixed(3)} ≠ 各段之和 ${total.toFixed(3)}（差 ${(declared - total).toFixed(3)}s）——末段会被截断或多出黑尾`);
}
for (const [i, s] of segs.entries()) {
  if (s.dur < 0.8) add('WARN', 'seg.short', `段${i + 1} ${s.type} 只有 ${s.dur.toFixed(2)}s，低于 0.8s：观众看不清，除非是刻意快切`);
}

// 元素等太久 / 永远等不到
const lateKeys = [];
for (const [i, s] of segs.entries()) {
  const a = s.args || {};
  const ats = [];
  if (Array.isArray(a.itemAt)) a.itemAt.forEach((v, k) => ats.push([`itemAt[${k}]`, Number(v)]));
  (a.callouts || []).forEach((c, k) => { if (c && c.at !== undefined) ats.push([`callouts[${k}].at`, Number(c.at)]); });
  for (const [name, t] of ats) {
    if (!Number.isFinite(t)) continue;
    if (t > s.dur) add('BLOCKER', 'elem.never', `段${i + 1} ${s.type} 的 ${name}=${t}s 超过段长 ${s.dur.toFixed(2)}s：该项永远不会出现`);
    else if (t > s.dur - 0.8) lateKeys.push(`段${i + 1} ${name}=${t}s（段长 ${s.dur.toFixed(2)}s）`);
  }
}
for (const m of lateKeys) add('WARN', 'elem.late', `${m}：出现后停留不足 0.8s`);

// 文案容量（62px 单行舒适上限 26 字；折行是兜底，不是设计）
const caps = P.captions || [];
const LONG = 26;
for (const [i, c] of caps.entries()) {
  const len = String(c.text || '').length;
  if (len > LONG) add('WARN', 'cap.long', `第${i + 1}句 ${len} 字 > ${LONG}：会折行并降档，cover/tip 这类底部有内容的版式会变挤`);
  const d = Number(c.end) - Number(c.start);
  if (d < 0.6) add('WARN', 'cap.short', `第${i + 1}句只停 ${d.toFixed(2)}s：来不及读`);
  if (d > 9) add('WARN', 'cap.longhold', `第${i + 1}句停 ${d.toFixed(2)}s：字幕挂太久，像是漏切`);
}
for (let i = 1; i < caps.length; i++) {
  const gap = Number(caps[i].start) - Number(caps[i - 1].end);
  if (gap >= 0 && gap < 0.1) add('NOTE', 'cap.gap', `第${i}→${i + 1}句间隔 ${gap.toFixed(2)}s，句间没有呼吸`);
}

// 外观档案被显式参数覆盖（档案说一代，args 写另一代 → 成片"似是而非"）
if (P.profile) {
  const appearanceKeys = ['figureCx', 'subY', 'bodyW', 'shoulderW', 'flankX', 'flankY', 'mouth', 'mouthStyle', 'figures'];
  const hit = [];
  for (const [i, s] of segs.entries()) {
    for (const k of appearanceKeys) if (s.args && s.args[k] !== undefined) hit.push(`段${i + 1}.${k}`);
  }
  if (hit.length) add('NOTE', 'profile.override', `声明 profile=${P.profile}，但 args 显式覆盖了外观：${hit.join(' / ')}`);
}

// 素材引用：图片/道具必须真的存在，并且有来源记录。
// 为什么查：`organImage` 这类字段在 Skia 侧曾长期被静默忽略（PROPS 恒空），
// 片子照样出、门禁照样过，只是画面退回了矢量图标——最典型的"看起来对、其实错"。
const PROPS_DIR = arg('props-dir', path.join('kits', 'science', 'template', 'assets', 'props'));
const imageRefs = [];
for (const [i, s] of segs.entries()) {
  const a = s.args || {};
  const push = (key, v) => { if (typeof v === 'string' && v) imageRefs.push({ seg: i + 1, key, val: v }); };
  push('organImage', a.organImage);
  push('figureImage', a.figureImage);
  (a.items || []).forEach((it, k) => push(`items[${k}].image`, it && it.image));
  (a.callouts || []).forEach((c, k) => push(`callouts[${k}].image`, c && c.image));
}
for (const ref of imageRefs) {
  const isPath = ref.val.includes('/') || ref.val.startsWith('.');
  const file = isPath ? path.resolve(REPO_ROOT, ref.val) : path.join(REPO_ROOT, PROPS_DIR, `${ref.val}.png`);
  if (!fs.existsSync(file)) {
    add('BLOCKER', 'asset.missing', `段${ref.seg} ${ref.key}="${ref.val}" 找不到文件（${path.relative(REPO_ROOT, file)}）：会静默退回矢量图标，画面与预期不是同一个`);
    continue;
  }
  const sidecar = file.replace(/\.png$/, '.source.json');
  if (!fs.existsSync(sidecar)) {
    add('WARN', 'asset.source', `段${ref.seg} ${ref.key}="${ref.val}" 没有来源记录（缺 ${path.basename(sidecar)}）：对外发布前补 provider/prompt/license`);
  }
}

// 配音与画面人物的性别一致性。
// 背景：默认讲解员（assets/figures）是女性，而 guide 里 narrator 曾默认写成男声云扬，
// 「男声讲 + 女性人物」这种不一致肉眼一秒能看出，但门禁和标定都查不到。
// 这里靠 preset.voices（vo.py 现在会写回实际音色）判断；换 figureImage / figureGender 可显式豁免。
const VOICE_GENDER = {
  'zh-CN-XiaoxiaoNeural': 'female', 'zh-CN-XiaoyiNeural': 'female',
  'zh-CN-liaoning-XiaobeiNeural': 'female', 'zh-CN-shaanxi-XiaoniNeural': 'female',
  'zh-CN-YunyangNeural': 'male', 'zh-CN-YunjianNeural': 'male',
  'zh-CN-YunxiNeural': 'male', 'zh-CN-YunxiaNeural': 'male',
};
const usedVoices = [...new Set(Object.values(P.voices || {}))].filter(Boolean);
const maleVoices = usedVoices.filter((v) => VOICE_GENDER[v] === 'male');
const talkWithFigure = segs.filter((s) => s.type === 'talk' && (s.args || {}).figure !== 'none');
const hasCustomFigure = talkWithFigure.some((s) => !!(s.args || {}).figureImage);
if (maleVoices.length && talkWithFigure.length && !hasCustomFigure && P.figureGender !== 'male') {
  add('WARN', 'voice.gender',
    `旁白是男声（${maleVoices.join(' / ')}），但 talk 段画的是内置女性讲解员：声音与画面不是同一个人。` +
    '三种解法——换女声 / figure:none / 提供 figureImage；确实要男声就写 figureGender:"male" 显式声明');
}

// ───────────────────────── 2. 音画（ffprobe） ─────────────────────────
let streams = [];
try {
  streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,duration,r_frame_rate', '-show_entries', 'format=duration', '-of', 'json', VIDEO],
  { encoding: 'utf8', maxBuffer: 1e7 })).streams || [];
} catch (e) {
  add('BLOCKER', 'probe.fail', `ffprobe 读不了这个文件：${e.message.split('\n')[0]}`);
}
const v = streams.find((s) => s.codec_type === 'video');
// 帧号换算必须用成片自己的帧率：--fps 60 出片而 preset 写 30 是常态（规格优先版）。
if (v && v.r_frame_rate && v.r_frame_rate !== '0/0') {
  const [rn, rd] = String(v.r_frame_rate).split('/').map(Number);
  const real = rd ? rn / rd : rn;
  if (real > 0 && Math.abs(real - fps) > 0.01) fps = real;
}
const au = streams.find((s) => s.codec_type === 'audio');
if (au && au.codec_name !== 'aac') {
  add('BLOCKER', 'audio.codec', `音轨是 ${au.codec_name}：mp4 里塞 PCM 会让浏览器/Safari 整轨静音（pipeline 应转 aac）`);
}
if (!au && caps.length) {
  add('WARN', 'audio.missing', '有字幕但没有音轨：口播片缺声音，除非这是无声版');
}
if (v && au) {
  const dv = Number(v.duration), da = Number(au.duration);
  if (Math.abs(dv - da) > 0.12) add('WARN', 'av.delta', `画面 ${dv.toFixed(2)}s vs 声音 ${da.toFixed(2)}s，差 ${Math.abs(dv - da).toFixed(2)}s`);
}

// ───────────────────────── 3. 画面（低分辨率解码，看方差与入场） ─────────────────────────
const W = 320, H = 180;
function stats(file) {
  const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`,
    '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const FRAME = W * H;
  let buf = Buffer.alloc(0);
  const out = [];
  const waiters = [];
  let closed = false;
  p.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= FRAME) {
      const f = buf.subarray(0, FRAME); buf = buf.subarray(FRAME);
      let sum = 0, sum2 = 0;
      for (let i = 0; i < FRAME; i++) { sum += f[i]; sum2 += f[i] * f[i]; }
      const mean = sum / FRAME;
      const std = Math.sqrt(Math.max(0, sum2 / FRAME - mean * mean));
      // 8×8 块均值签名：用来判断"切点前后是不是同一画面"。
      // 只比整帧亮度是错的——两种版式可以亮度一样但内容完全不同（实测误报 3/7）。
      const sig = new Uint8Array(64);
      const bw = W / 8, bh = H / 8;
      for (let by = 0; by < 8; by++) {
        for (let bx = 0; bx < 8; bx++) {
          let acc2 = 0, n = 0;
          const x0 = Math.floor(bx * bw), x1 = Math.floor((bx + 1) * bw);
          const y0 = Math.floor(by * bh), y1 = Math.floor((by + 1) * bh);
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { acc2 += f[y * W + x]; n++; }
          sig[by * 8 + bx] = Math.round(acc2 / Math.max(1, n));
        }
      }
      const w = waiters.shift();
      if (w) w({ mean, std, sig }); else out.push({ mean, std, sig });
    }
  });
  p.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return { next: () => new Promise((r) => (out.length ? r(out.shift()) : closed ? r(null) : waiters.push(r))) };
}

const R = stats(VIDEO);
const frameStats = [];
for (;;) {
  const f = await R.next();
  if (!f) break;
  frameStats.push(f);
}

/** 段首帧 vs 段内最大值：判断"切进来那一刻是不是空的"。 */
const segStats = [];
for (const [i, s] of segs.entries()) {
  const q = boundaryOf(s.t0);
  const a = Math.max(0, q);
  const b = Math.min(frameStats.length, boundaryOf(s.t1));
  const slice = frameStats.slice(a, b);
  if (!slice.length) continue;
  const stds = slice.map((x) => x.std);
  const maxStd = Math.max(...stds);
  const first = stds[0];
  const meanStd = stds.reduce((x, y) => x + y, 0) / stds.length;
  const meanLuma = slice.reduce((x, y) => x + y.mean, 0) / slice.length;
  segStats.push({ i, type: s.type, t0: s.t0, first, maxStd, meanStd, meanLuma, frames: slice.length });

  // 整段近乎纯色：背景函数漏画、元素没出来、或者渲成了黑底
  if (maxStd < 8) {
    add('BLOCKER', 'frame.flat', `段${i + 1} ${s.type} 整段几乎纯色（最大对比度 ${maxStd.toFixed(1)}，平均亮度 ${meanLuma.toFixed(0)}）：背景/元素没画出来`);
  } else if (meanLuma < 18) {
    add('BLOCKER', 'frame.dark', `段${i + 1} ${s.type} 平均亮度 ${meanLuma.toFixed(0)}：像黑底`);
  }

  // 段首空帧：入场太慢，硬切那一刻观众看到的是空白
  if (first < maxStd * 0.3 && maxStd - first > 12) {
    add('WARN', 'frame.emptyStart',
      `段${i + 1} ${s.type} 首帧对比度 ${first.toFixed(1)} vs 段内峰值 ${maxStd.toFixed(1)}：切点像空帧` +
      '（单段可能是刻意入场；多段连续出现说明入场普遍从 t=0 起算，应提前到 -0.1s）');
  }
}

// 段边界重复帧：用 8×8 签名比内容，而不是比亮度。
// 判据取**相对**阈值（中位切点差异的 35%），因为不同版式的"正常切点差异"本来就不一样大。
const sigDist = (a, b) => {
  let s = 0;
  for (let i = 0; i < 64; i++) s += Math.abs(a[i] - b[i]);
  return s / 64;
};
const cutDists = [];
for (const s of segs.slice(1)) {
  // 新段的第一帧：
  //   snapToFrames=true 时渲染器把 t0 量化成 round(t0·fps)/fps，这里必须用同一个取整方式，
  //   否则会拿"量化前的小数"算出偏一帧的边界，把同一个旧段的相邻两帧当成切点（差异≈0 的假警报）。
  //   没开量化时用 ceil：round 会把边界前一帧算成"切后"。
  const k = boundaryOf(s.t0);
  if (k - 1 < 0 || k >= frameStats.length) continue;
  cutDists.push({ k, d: sigDist(frameStats[k - 1].sig, frameStats[k].sig) });
}
if (cutDists.length) {
  const med = [...cutDists].map((x) => x.d).sort((a, b) => a - b)[Math.floor(cutDists.length / 2)];
  // 绝对阈值：8×8 块均值逐块差 < 4/255 视为同一画面。
  // 相对阈值（中位×0.35）在"平底切平底"时会误报——实测 diagram→matrix 只有 6.0，但内容确实换了。
  const weak = cutDists.filter((x) => x.d < 4);
  if (weak.length) {
    add('WARN', 'cut.duplicate',
      `${weak.length}/${cutDists.length} 个切点前后画面几乎一样：` +
      weak.map((w) => `t=${(w.k / fps).toFixed(2)}s 差异 ${w.d.toFixed(1)}`).join('；') +
      `（中位 ${med.toFixed(1)}）——可能是浮点切点错位，或两段内容撞车`);
  }
}

// ───────────────────────── 4. 与参考片对比（可选） ─────────────────────────
if (REF) {
  try {
    const r = execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'replica-diff.mjs'),
      '--ref', REF, '--rep', VIDEO, '--out', '/tmp/adv-ref.json'], { encoding: 'utf8', maxBuffer: 1e8 });
    const d = JSON.parse(fs.readFileSync('/tmp/adv-ref.json', 'utf8'));
    add(d.summary.maeAvg > 8 ? 'WARN' : 'NOTE', 'ref.mae',
      `与参考片平均 MAE ${d.summary.maeAvg}（p90 ${d.summary.maeP90}）${d.summary.maeAvg > 8 ? '：超过 8，结构层可能有差' : ''}`);
  } catch (e) {
    add('NOTE', 'ref.fail', `与参考片对比没跑成：${e.message.split('\n')[0]}`);
  }
}

// ───────────────────────── 输出 ─────────────────────────
const blockers = rows.filter((r) => r.level === 'BLOCKER');
const warns = rows.filter((r) => r.level === 'WARN');
const notes = rows.filter((r) => r.level === 'NOTE');

if (ASJSON) {
  console.log(JSON.stringify({
    video: VIDEO, params: PARAMS, ref: REF,
    segments: segs.length, frames: frameStats.length,
    blockers: blockers.length, warns: warns.length, notes: notes.length,
    verdict: blockers.length ? 'BLOCK' : 'PASS',
    rows, segStats,
  }, null, 2));
} else {
  console.log(`对抗审查 · ${path.basename(VIDEO)} · ${segs.length} 段 / ${frameStats.length} 帧`);
  console.log(`段结构：${segStats.map((s) => `${s.type}(${s.maxStd.toFixed(0)})`).join(' → ')}`);
  const tag = { BLOCKER: '✗', WARN: '!', NOTE: '·' };
  for (const r of rows) console.log(`  ${tag[r.level]} [${r.level}] ${r.id}: ${r.msg}`);
  if (!rows.length) console.log('  无问题');
  console.log(`\n结论：${blockers.length ? 'BLOCK' : 'PASS'} · BLOCKER ${blockers.length} / WARN ${warns.length} / NOTE ${notes.length}`);
}
process.exit(blockers.length ? 1 : 0);
