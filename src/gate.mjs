#!/usr/bin/env node
// gate.mjs — delivery gates calibrated on this repo's own films, not copied from another kit.
//
// Why this file exists (2026-11-10): cinecode's qc.py offers `hook` (first 2 s must move, mean >= 0.5) and a phone
// type minimum (40 px cap at a 1080 short side). Measured against the 19 films already delivered here:
//   hook_mean  0.06 .. 5.29   p10 0.09  p50 0.31   -> a 0.5 line fails 13 of 19, including every voice-over film
//   mean L*    0.40 .. 91.3   (three replicas are dark by design) -> a lightness floor rejects legitimate work
//   dup frames 0 .. 36.8 %    (layout holds)      -> duplicates are a design choice, not a defect
// So those three are reported, never gated. What is gate-able is whether the file is a finished, playable film at all:
// the frame count matches the clock, there is sound, sound and picture end together, and no second of the film is an
// empty frame (almost no luma range) or a black frame, whatever palette the film uses.
//
// Usage:
//   node gate.mjs out/film.mp4 [more.mp4 ...] [--json report.json] [--html report.html] [--quiet]
// Exit code 1 when any film fails a hard gate.

import { execFileSync, spawnSync } from 'node:child_process';
import * as BINS from './bins.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseFacts, check as factsCheck } from '../tools/facts-check.mjs';

const FFMPEG = BINS.FFMPEG;
const FFPROBE = BINS.FFPROBE;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Calibrated limits: the corpus maximum plus a margin, so a normal film cannot trip them.
const LIMIT = {
  flatPct: 8,        // corpus max 5.26 (editorial-cut-v4)
  blackPct: 3,       // corpus max 1.75 (replica promo-pixel)
  avDelta: 0.10,     // seconds between picture and sound
  hookWarn: 0.10,    // corpus p10
  dupWarn: 40,       // corpus max 36.8
  yavgWarn: 6,       // near-black: worth a look, not a fail
  // Longest freeze, measured 2026-11-14 on 26 films in out/ + deliverables/ at freezedetect n=0.002 d=1:
  //   max 8.5 (cutduo-showreel-44s) · 6.1 (clay-vo) · 5.3 · 5.0 · 4.9 · 4.3 ... 12 of 26 exceed 3 s.
  // The upstream vibe-knowledge rule "no still frame over 3 s" is a knowledge-short pacing rule (cuts every
  // 2.75 s); applying it here would fail half the catalogue, and the 8.5 s hold is a deliberate layout beat.
  // So: report only. 10 s = corpus max + 1.5 s margin, i.e. "freeze this long is probably a stuck recorder".
  freezeWarn: 10,
  // BGM 铺底：静音段合计超过这个数就说明没铺满。有 BGM 的片实测 0.0 s，无 BGM 的 28.7-28.9 s，
  // 取 2 s 作余量（给首尾刻意的淡入淡出留空间）。
  bgmGapWarn: 2,
  // 响度口径：本仓交付走 loudnorm -16 LUFS（tools/add-bgm.mjs 写死），2026-11-14 实测 5 支走该链路的
  // 成片全部落在 -15.9 LUFS / 真峰值 -1.0 ~ -1.5 dBTP，与口径一致。容差 ±2 LU。
  // 未走 loudnorm 的素材片实测 -30.6 / -26.9 / -25.8 / -19.0 / -18.6 / -18.1，所以只报不拦。
  loudTarget: -16,
  loudTol: 2,
  tpMax: -0.5,     // 真峰值超过 -0.5 dBTP 就有削波与平台响度惩罚风险
};

function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration',
    '-show_entries', 'format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  const d = JSON.parse(out);
  const v = (d.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (d.streams || []).find((s) => s.codec_type === 'audio') || null;
  const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  return {
    w: v.width, h: v.height,
    fps: den ? num / den : 0,
    frames: Number(v.nb_read_frames || 0),
    dur: Number(d.format?.duration || 0),
    size: Number(d.format?.size || 0),
    vcodec: v.codec_name || null,
    audio: a ? { codec: a.codec_name, dur: Number(a.duration || 0) } : null,
  };
}

function stats(file, fps) {
  const step = Math.max(1, Math.round(fps || 24));
  const r = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-an', '-vf',
    `select='not(mod(n,${step}))',signalstats,metadata=print:file=-`, '-f', 'null', '-'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const grab = (re) => [...r.matchAll(re)].map((m) => Number(m[1]));
  const ymin = grab(/YMIN=(\d+)/g), ymax = grab(/YMAX=(\d+)/g), yavg = grab(/YAVG=([\d.]+)/g);
  const n = Math.min(ymin.length, ymax.length);
  if (!n) return null;
  let flat = 0, black = 0;
  for (let i = 0; i < n; i++) {
    if (ymax[i] - ymin[i] < 40) flat++;
    if (ymax[i] < 24) black++;
  }
  return {
    samples: n,
    flatPct: +(100 * flat / n).toFixed(2),
    blackPct: +(100 * black / n).toFixed(2),
    yavg: +(yavg.reduce((a, b) => a + b, 0) / Math.max(1, yavg.length)).toFixed(1),
  };
}

// Opening motion: mean frame-to-frame luma change over the first two seconds, 64px wide.
function hook(file) {
  const r = execFileSync(FFMPEG, ['-hide_banner', '-t', '2', '-i', file, '-an', '-vf',
    'scale=64:36,format=gray,tblend=all_mode=difference,signalstats,metadata=print:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const v = [...r.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : 0;
}

function firstFrameYmax(file) {
  const r = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-frames:v', '1', '-an', '-vf',
    'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const m = [...r.matchAll(/YMAX=(\d+)/g)];
  return m.length ? Number(m[0][1]) : 255;
}

// Longest still stretch. freezedetect works on the decoded picture, so it also catches a stuck recorder
// (two writers on one picture.mp4 produces minutes of frozen frames, not a bad encode).
// Note: freezedetect logs to stderr, unlike signalstats which we route to stdout with `metadata=print:file=-`.
function freeze(file, dur) {
  const p = spawnSync(FFMPEG, ['-nostats', '-i', file, '-an', '-vf',
    'fps=10,scale=480:-2,freezedetect=n=0.002:d=1', '-f', 'null', '-'], { encoding: 'utf8' });
  const r = (p.stderr || '') + (p.stdout || '');
  const durs = [...r.matchAll(/freeze_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
  const starts = [...r.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  // 冻到片尾时 ffmpeg 只打 freeze_start、不打 freeze_duration（流结束时没有"恢复"事件）。
  // 少了这一步，最严重的情况——录制卡死到结尾——反而检测不出来。按 片长 - 最后起点 补齐。
  if (durs.length < starts.length && starts.length) {
    durs.push(Math.max(0, Number(dur || 0) - starts[starts.length - 1]));
  }
  const max = durs.length ? Math.max(...durs) : 0;
  const i = durs.indexOf(max);
  return { count: durs.length, max: +max.toFixed(2), at: i >= 0 ? starts[i] : null };
}

/* ---------------- BGM 铺底检测 ---------------- */

// 配置里写了"加了 BGM"不算数，成片音轨里真有才算。
//
// 试过与参考曲做互相关（vibe-knowledge qa.py 的做法，阈值 0.12）：在本仓混音链路上**不成立**。
// 2026-11-14 实测，参考曲 Mellow Drizzle Soft Pad：
//   hip-v1-female-bgm 0.058 · hip-v3-male-bgm 0.080   （都有 BGM）
//   hip-v1-female     0.048 · hip-v3-male     0.024   （都没有）
// 有/无只差 0.03，抄 0.12 会把两首真 BGM 判成"没有"。原因是 gain -15 dB + 低通 + sidechain + loudnorm
// 把波形改得面目全非；"平均音量"同样分不出（-16.9 vs -17.0 dB）。
//
// 有分辨力的是**旁白间隙**：BGM 铺满时不存在 -45 dB 以下的静音段。
//   hip-v1-female-bgm 0 段 / 0.0 s     hip-v1-female 22 段 / 28.9 s
//   hip-v3-male-bgm   0 段 / 0.0 s     hip-v3-male   20 段 / 28.7 s
// 注意这是**单向**判据：发现静音段可断定没铺满；0 段不能反推有 BGM（旁白密到没间隙也会是 0 段）。
function bgmBed(file) {
  const p = spawnSync(FFMPEG, ['-nostats', '-i', file, '-vn', '-af',
    'silencedetect=n=-45dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
  const r = (p.stderr || '') + (p.stdout || '');
  const durs = [...r.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
  const total = durs.reduce((a, b) => a + b, 0);
  return {
    gaps: durs.length,
    total: +total.toFixed(2),
    max: durs.length ? +Math.max(...durs).toFixed(2) : 0,
  };
}


/* ---------------- 空镜检查 ---------------- */

/**
 * 只靠 freeze 抓不到"画面空着但一直在动"或"画面空着但完全不动"。
 * 实测《本福特定律》40–43 秒画面只有一条淡弧线，freeze 只报 5.2s（告警线 10s），
 * 帧数/空帧/黑帧全部通过 —— 观众看到的是"卡住了"。
 *
 * 这里换一个指标：**画面主体区（去掉底部字幕）的灰度标准差**，也就是"这一屏有多少东西"。
 *   - 纯纸背景 ≈ 1.5
 *   - 引文页（几行小字）≈ 18–20
 *   - 有图文版式 ≈ 56
 * 连续 ≥2 秒低于 12 就报"疑似空镜"。只报不拦 —— paper 是留白版式，阈值太紧会误伤。
 */
function checkBlank(file, { minStd = 12, minDur = 2, skipTail = 4 } = {}) {
  const W = 240, H = 105, SZ = W * H;        // 1920×842 主体区缩到 240×105
  let buf;
  try {
    buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf',
      `fps=1,crop=1920:842:0:0,scale=${W}:${H}:flags=area,format=gray`,
      '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  } catch { return null; }

  const n = Math.floor(buf.length / SZ);
  const std = [];
  for (let i = 0; i < n; i++) {
    const o = i * SZ;
    let s = 0, s2 = 0;
    for (let j = 0; j < SZ; j++) { const v = buf[o + j]; s += v; s2 += v * v; }
    const mean = s / SZ;
    std.push(Math.sqrt(Math.max(0, s2 / SZ - mean * mean)));
  }

  // 找连续低于阈值的区间。
  // skipTail：片尾卡（outro）天然只有两行大字，信息量在 6 左右，会被判成空镜——
  // 那是版式设计，不是缺陷。默认跳过最后 4 秒。
  const upto = Math.max(0, std.length - skipTail);
  const runs = [];
  let cur = null;
  for (let i = 0; i < upto; i++) {
    if (std[i] < minStd) {
      if (!cur) cur = { from: i, to: i, min: std[i] };
      else { cur.to = i; cur.min = Math.min(cur.min, std[i]); }
    } else if (cur) {
      if (cur.to - cur.from + 1 >= minDur) runs.push(cur);
      cur = null;
    }
  }
  if (cur && cur.to - cur.from + 1 >= minDur) runs.push(cur);
  return { seconds: std.length, runs, median: std.slice().sort((a, b) => a - b)[Math.floor(std.length / 2)] };
}

/* ---------------- 字幕回读 ---------------- */

/**
 * 字幕有没有真的显示出来。
 * 做法：拿 params.captions 的文本，与该时刻 OCR 读到的**字幕区**（画面下方 y<0.3）比对字符覆盖率。
 *
 * 为什么只报不拦：OCR 对逐字擦除动画的首字常常读不到（实测「一个班」读成「个班」），
 * 覆盖率天然打不满。所以它抓的是"整条字幕没出现 / 被裁掉大半"，不是逐字校对。
 * 门槛 0.6：漏一两个字仍然过，漏半句就报出来。
 */
function checkCaptions(params, ocrLines, fps, band = [0, 0.3]) {
  const caps = Array.isArray(params?.captions) ? params.captions : [];
  if (!caps.length) return null;
  let worst = null, shown = 0;
  // 阅读时间：一条字幕至少要停 max(1.8s, 字数/语速)。
  // 取自制 lemo-opuscar 的 STYLE.md §4（它写的是 max(1.8s, speech + 0.6s)），但**去掉 +0.6**：
  // 本仓字幕与配音同步，一条覆盖 N 字时说话时长就是 N/5.5，"停留 ≥ 说话 + 0.6"在数学上永远不成立
  // （照搬实测 22/39 条全报）。去掉缓冲后它只抓真正的"一闪而过"。
  const CPS = 5.5;
  const rushing = [];
  for (const c of caps) {
    const hold = Number(c.end) - Number(c.start);
    const n = [...String(c.text || '')].filter((ch) => !/[，。；：？！,.;:!?\s]/.test(ch)).length;
    const need = Math.max(1.8, n / CPS);
    if (hold < need - 1e-6) rushing.push({ text: c.text, start: c.start, hold: +hold.toFixed(2), need: +need.toFixed(2) });
  }
  for (const c of caps) {
    const mid = (Number(c.start) + Number(c.end)) / 2;
    // band = 字幕带（距底部的归一化起止）。横屏字幕在 0–13%，竖屏在 35–40%：
    // 写死 0.3 会让竖屏片 15/15 条全报"没读全"（实测），而画面其实清清楚楚。
    const near = ocrLines.filter((l) => Math.abs(l.t - mid) <= 1.4 && l.y >= band[0] && l.y <= band[1]);
    const screen = near.map((l) => l.text).join('');
    const chars = [...String(c.text || '')].filter((ch) => !/[，。、；：？！,.;:!?\s]/.test(ch));
    if (!chars.length) continue;
    const hit = chars.filter((ch) => screen.includes(ch)).length;
    const cov = hit / chars.length;
    if (cov >= 0.6) shown++;
    if (!worst || cov < worst.cov) worst = { text: c.text, start: c.start, cov, seen: screen.slice(0, 24) };
  }
  return { total: caps.length, shown, worst, rushing };
}

/* ---------------- 动效密度 ---------------- */

/**
 * 画面"什么时候不动了"。
 *
 * freezedetect 抓不到这类问题：它的判据是 0.2% 的像素变化，而电平柱之类的常驻小元素
 * 只占画面 0.02%。要用**全画面平均差分**，并且不能缩图（13px 的鼠标缩到 240px 宽就没了）。
 *
 * 做法：2fps 抽帧 → tblend 与前一帧求差 → signalstats 取 Y 均值（0–255）。
 * 实测参考值：完全静止 0.00–0.05｜只有电平柱在动 0.10–0.30｜元素入场/鼠标 0.4–3｜换屏 10+
 *
 * 判据：连续 ≥2s 的差分都低于 0.08（≈0.03%）就算"这段卡住了"。
 */
function motionOf(file, quiet = 0.08, minRun = 2) {
  const p = spawnSync(FFMPEG, ['-v', 'info', '-i', file, '-vf',
    // select 跳过 tblend 的预热帧：它前 7 帧输出的是原图而不是差分（YAVG=原图平均亮度），
    // 不跳过会把"完全静止"的片判成"一直在动"（实测静态图前 7 个值是 3.47）。
    'fps=2,scale=320:-2,tblend=all_mode=difference,select=\'gte(n\\,2)\',signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const vals = [...(p.stderr || '').matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
  if (!vals.length) return null;
  const runs = [];
  let cur = null;
  vals.forEach((v, i) => {
    if (v < quiet) {
      if (!cur) cur = { from: i / 2, to: (i + 1) / 2 };
      else cur.to = (i + 1) / 2;
    } else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  const long = runs.filter((r) => r.to - r.from >= minRun);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    avg: +avg.toFixed(3),
    still: long.length,
    worst: long.sort((a, b) => (b.to - b.from) - (a.to - a.from))[0] || null,
    // 有电平柱的片天然 >=0.1，没有的片会到 0.03——这是版式差异，不是质量问题
  };
}

/* ---------------- 响度 ---------------- */

// ebur128 的 Summary 打在 stderr，且 Integrated loudness 与 True peak 是两段，要跨行取。
function loudness(file) {
  const p = spawnSync(FFMPEG, ['-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const r = p.stderr || '';
  const i = r.match(/Integrated loudness:[\s\S]*?I:\s+(-?[\d.]+) LUFS/);
  const tp = r.match(/True peak:[\s\S]*?Peak:\s+(-?[\d.]+) dBFS/);
  if (!i) return null;
  return { lufs: +i[1], tp: tp ? +tp[1] : null };
}

/* ---------------- OCR：读回屏幕字 ---------------- */
const OCR_BIN = path.join(os.homedir(), '.cache/cutduo/bin/ocr');
const OCR_SRC = path.join(ROOT, 'tools/ocr.swift');

/** 编译/复用 Vision OCR 二进制。只在 --ocr 时走这条路，默认交付门禁不依赖 macOS。 */
function ocrBinary() {
  if (existsSync(OCR_BIN) && statSync(OCR_BIN).mtimeMs >= statSync(OCR_SRC).mtimeMs) return OCR_BIN;
  const has = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
  if (has.status !== 0) return null;
  mkdirSync(path.dirname(OCR_BIN), { recursive: true });
  const c = spawnSync('swiftc', ['-O', OCR_SRC, '-o', OCR_BIN], { encoding: 'utf8' });
  return c.status === 0 ? OCR_BIN : null;
}

/** 抽帧 → OCR。返回 {frames, lines:[{t,y,text}]} */
function readScreen(file, interval) {
  const bin = ocrBinary();
  if (!bin) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateocr-'));
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf',
    `fps=1/${interval},scale=1600:-2`, path.join(dir, 'f_%04d.png')], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const imgs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  if (!imgs.length) return null;
  const o = spawnSync(bin, imgs.map((f) => path.join(dir, f)), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (o.status !== 0) return null;
  const lines = [];
  let cur = 0;
  for (const ln of (o.stdout || '').split('\n')) {
    const at = ln.match(/^@@ (\d+)/);
    if (at) { cur = Number(at[1]); continue; }
    const m = ln.match(/^\[y([\d.]+) h([\d.]+)\] (.*)$/);
    if (m && m[3].trim().length > 1) lines.push({ t: +((cur - 1) * interval).toFixed(2), y: +m[1], text: m[3].trim() });
  }
  return { frames: imgs.length, lines };
}

/**
 * 归一化：去空白、去标点、小写、0/O 与 1/l/I 合并。
 * **小数点保留**——删掉它会让「50.7」变成「507」，然后在章节号「05 / 09」里命中。
 */
const norm = (s) => String(s).replace(/[\s\u3000]+/g, '')
  .replace(/[，。、：；！？,;:!?'"“”‘’（）()【】\[\]—\-_/·]/g, '')
  .toLowerCase().replace(/o/g, '0').replace(/[li]/g, '1');

/**
 * 在 hay 里找 needle。
 * 短串（<4）必须精确包含：2 个字符的「99」在容错 1 位时必然命中「01」「09」这类章节号，
 * 2026-11-14 实测过这个假阳性——门禁报「屏幕有 50.7」，实际屏幕写的是「05 / 09」。
 * 长串只容 1 个字符误差（OCR 会错一个字，但不该错两个字）。
 */
function fuzzyHas(hay, needle) {
  const a = norm(hay), b = norm(needle);
  if (!b) return false;
  if (a.includes(b)) return true;
  if (b.length < 4) return false;
  const tol = 1;
  for (let i = 0; i + b.length <= a.length; i++) {
    let diff = 0;
    for (let j = 0; j < b.length && diff <= tol; j++) if (a[i + j] !== b[j]) diff++;
    if (diff <= tol) return true;
  }
  return false;
}

function judge(file, opt) {
  const p = probe(file);
  p.firstYmax = firstFrameYmax(file);
  const s = stats(file, p.fps) || { samples: 0, flatPct: 0, blackPct: 0, yavg: 0 };
  const hk = hook(file);
  const fz = freeze(file, p.dur);
  const expect = Math.round(p.dur * p.fps);
  const fails = [], warns = [];

  if (Math.abs(p.frames - expect) > 1) fails.push(`帧数 ${p.frames} ≠ ${p.dur.toFixed(3)}s × ${p.fps}fps = ${expect}`);
  if (!p.audio) (opt.requireAudio ? fails : warns).push('无音轨（素材可无声；成品加 --require-audio 判失败）');
  else if (Math.abs(p.audio.dur - p.dur) > LIMIT.avDelta) fails.push(`音画时长差 ${Math.abs(p.audio.dur - p.dur).toFixed(2)}s`);
  if (p.firstYmax < 24) warns.push(`首帧接近黑场（YMAX=${p.firstYmax}）——参考片淡入时正常，短视频平台不建议`);
  if (s.flatPct > LIMIT.flatPct) fails.push(`空帧 ${s.flatPct}% > ${LIMIT.flatPct}%`);
  if (s.blackPct > LIMIT.blackPct) fails.push(`黑帧 ${s.blackPct}% > ${LIMIT.blackPct}%`);

  if (hk < LIMIT.hookWarn) warns.push(`开场运动 ${hk} < ${LIMIT.hookWarn}（告警，不是失败）`);
  if (s.yavg < LIMIT.yavgWarn) warns.push(`平均亮度 Y=${s.yavg}（近黑，看是否压片）`);
  // 静止只报不拦：本仓 26 支片里 12 支有 >3 s 的静止段（最长 8.5 s），是版式节奏不是缺陷。
  // 超过 10 s 才提示"疑似录制卡死"——这一条能抓到并发写坏 picture.mp4 那类事故。
  if (fz.max >= LIMIT.freezeWarn) {
    warns.push(`最长静止 ${fz.max}s @ ${fz.at}s（≥${LIMIT.freezeWarn}s：查是否录制卡死 / 两路写同一个文件）`);
  }

  // BGM 铺底：只有显式 --bgm / --require-bgm 才查（多数素材片本来就没配乐，默认报会刷噪音）
  let bed = null;
  if ((opt.bgm || opt.requireBgm) && p.audio) {
    bed = bgmBed(file);
    if (bed.total > LIMIT.bgmGapWarn) {
      const msg = `无铺底音乐：静音 ${bed.gaps} 段 / 合计 ${bed.total}s（最长 ${bed.max}s）`;
      (opt.requireBgm ? fails : warns).push(msg);
    }
  }

  // 响度：偏离 -16 LUFS 口径或真峰值过高才报（历史素材片本来就没走 loudnorm）
  let loud = null;
  if (p.audio) {
    loud = loudness(file);
    if (loud) {
      const off = Math.abs(loud.lufs - LIMIT.loudTarget) > LIMIT.loudTol;
      const hot = loud.tp !== null && loud.tp > LIMIT.tpMax;
      const req = opt.loudness || opt.requireLoudness;
      if (off) (opt.requireLoudness ? fails : warns).push(`响度 ${loud.lufs} LUFS 偏离口径 ${LIMIT.loudTarget}±${LIMIT.loudTol}`);
      if (hot) (opt.requireLoudness ? fails : warns).push(`真峰值 ${loud.tp} dBTP > ${LIMIT.tpMax}（削波风险）`);
      if (!req && !off && !hot) { /* 正常，不刷屏 */ }
    }
  }

  // OCR 回读：默认只产出 ocr.txt 供对照（屏幕上的数字对不对，机器判不了，人/agent 能）；
  // 给了 --expect 才做正向断言——"这条片屏幕上必须有这几个字"，缺失默认告警，--require-expect 才拦。
  let oc = null;
  const expectHits = [];
  if (opt.ocr) {
    oc = readScreen(file, opt.ocr);
    if (!oc) warns.push('OCR 不可用（需要 macOS + swiftc），不影响其余判定');
    else if (opt.expect) {
      for (const want of String(opt.expect).split(',').map((s) => s.trim()).filter(Boolean)) {
        const hit = oc.lines.find((l) => fuzzyHas(l.text, want));
        if (hit) expectHits.push({ want, t: hit.t, raw: hit.text });
        else (opt.requireExpect ? fails : warns).push(`屏幕未见「${want}」（OCR 读回 ${oc.frames} 帧）`);
      }
    }
  }

  // 空镜：画面有没有"东西"（只报不拦，见 checkBlank 注释）
  let blank = null;
  if (opt.blank) {
    blank = checkBlank(file);
    if (blank && blank.runs.length) {
      const worst = blank.runs.slice().sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      warns.push(`疑似空镜 ${blank.runs.length} 处（最长 ${worst.from}–${worst.to + 1}s，该段信息量 ${worst.min.toFixed(1)}）`);
    }
  }

  // 动效密度：有没有超过 2 秒画面完全不动（只报不拦，见 motionOf 注释）
  let motion = null;
  if (opt.motion) {
    motion = motionOf(file);
    if (motion && motion.still) {
      const w = motion.worst;
      warns.push(`画面静止 ${motion.still} 处（最长 ${w.from}–${w.to}s，平均差分 ${motion.avg}）`
        + ' —— 段是不是太长了？加 cursor 落点或拆段');
    }
  }

  // 字幕回读：字幕真的显示出来了吗（只报不拦，见 checkCaptions 注释）
  let capCheck = null;
  if (opt.captionParams && oc) {
    try {
      const cp = JSON.parse(readFileSync(opt.captionParams, 'utf8'));
      // 字幕带：横屏默认 [0,0.3]（距底 30% 内）；竖屏字幕在 0.35–0.40，要显式传 --subtitle-y
      capCheck = checkCaptions(cp, oc.lines, opt.ocr, opt.subtitleBand || [0, 0.3]);
      if (capCheck && capCheck.rushing.length) {
        const w = capCheck.rushing.reduce((a, b) => (b.hold - b.need < a.hold - a.need ? b : a));
        warns.push(`字幕 ${capCheck.rushing.length}/${capCheck.total} 条停留不足（最短 ${w.hold}s / 需 ${w.need}s：`
          + `「${String(w.text).slice(0, 14)}」）——要么少一条，要么这一屏字数降下来`);
      }
      if (capCheck && capCheck.shown < capCheck.total) {
        const miss = capCheck.total - capCheck.shown;
        warns.push(`字幕 ${miss}/${capCheck.total} 条没读全（最低覆盖 ${(capCheck.worst.cov * 100).toFixed(0)}%：`
          + `「${String(capCheck.worst.text).slice(0, 16)}」屏上读作「${capCheck.worst.seen}」）`);
      }
    } catch (e) {
      warns.push(`字幕参数读取失败：${e.message}`);
    }
  }

  // 台账对照：把「没出处不上屏」变成可执行检查——台账里的数字必须在屏幕上真的出现
  let factCheck = null;
  if (opt.facts && oc) {
    try {
      const facts = parseFacts(readFileSync(opt.facts, "utf8"));
      factCheck = factsCheck(facts, oc.lines);
      if (factCheck.missing.length) {
        const names = factCheck.missing.slice(0, 3).map((m) => m.claim).join('、');
        (opt.requireFacts ? fails : warns).push(
          `台账 ${factCheck.missing.length} 条数字未上屏（${names}${factCheck.missing.length > 3 ? '…' : ''}）`);
      }
      // 反向：屏幕上有、台账里没有出处的数字。默认只报前三个——
      // 这个方向噪点多（图表标注、装饰数字），全列出来没人看，但完全不报又会漏掉"无出处的断言"。
      if (factCheck.orphans.length) {
        const top = factCheck.orphans.slice(0, 3).map((o) => `${o.num}@${o.t}s`).join('、');
        warns.push(`台账外数字 ${factCheck.orphans.length} 个（${top}${factCheck.orphans.length > 3 ? '…' : ''}）——有出处就补进 facts.md`);
      }
    } catch (e) {
      warns.push(`台账读取失败：${e.message}`);
    }
  }

  return {
    file: path.relative(process.cwd(), file) || file,
    ...p, ...s, hook: hk, freeze: fz, expect, ocr: oc ? { frames: oc.frames, lines: oc.lines.length } : null,
    facts: factCheck ? { total: factCheck.hits.length + factCheck.missing.length + factCheck.noNumbers.length,
      hits: factCheck.hits.length, missing: factCheck.missing.length, orphans: factCheck.orphans.length } : null,
    ocrLines: oc ? oc.lines : null, bgm: bed, loud, capCheck, blank, motion,
    expectHits, verdict: fails.length ? 'FAIL' : 'PASS', fails, warns,
  };
}

/** 秒 → m:ss.s，用于 ocr.txt 的时间列 */
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function table(rows) {
  const head = ['film', 'spec', 'frames', 'flat%', 'black%', 'hook', 'Y', 'freeze', 'LUFS', 'verdict'];
  const lines = rows.map((r) => [
    path.basename(r.file),
    `${r.w}x${r.h}@${r.fps}`,
    `${r.frames}/${r.expect}`,
    r.flatPct.toFixed(1),
    r.blackPct.toFixed(1),
    r.hook.toFixed(2),
    String(r.yavg),
    r.freeze.max ? r.freeze.max.toFixed(1) + 's' : '—',
    r.loud ? r.loud.lufs.toFixed(1) : '—',
    r.verdict,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  return [fmt(head), w.map((n) => '-'.repeat(n)).join('  '), ...lines.map(fmt)].join('\n');
}

function html(rows) {
  const ok = rows.filter((r) => r.verdict === 'PASS').length;
  const cell = (r) => `<tr class="${r.verdict === 'PASS' ? 'ok' : 'bad'}">
    <td>${path.basename(r.file)}</td><td>${r.w}×${r.h}@${r.fps}</td>
    <td>${r.frames}/${r.expect}</td><td>${r.flatPct.toFixed(1)}%</td><td>${r.blackPct.toFixed(1)}%</td>
    <td>${r.hook.toFixed(2)}</td><td>${r.yavg}</td><td>${r.freeze.max ? r.freeze.max.toFixed(1) + 's' : '—'}</td><td>${r.loud ? r.loud.lufs.toFixed(1) : '—'}</td><td>${r.verdict}</td>
    <td>${[...r.fails, ...r.warns].join('；') || '—'}</td></tr>`.replace(/\n\s*/g, '');
  return `<!doctype html><meta charset="utf-8"><title>交付门禁报告</title>
<style>
 body{margin:0;padding:36px 40px;background:#f4f1ea;color:#1f1d1a;font:14px/1.65 -apple-system,"PingFang SC",sans-serif}
 h1{font-size:20px;font-weight:600;margin:0 0 6px} p.lede{color:#6b6459;margin:0 0 22px;max-width:900px}
 table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 0 #e2dccf}
 th,td{padding:8px 10px;border-bottom:1px solid #ece7db;text-align:left;font-size:13px}
 th{background:#efe9dc;font-weight:600} td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6),td:nth-child(7),td:nth-child(8),td:nth-child(9){font-variant-numeric:tabular-nums}
 tr.bad td:last-child,tr.bad td:nth-child(10){color:#a32d2d} tr.bad{background:#fcf3f2}
 tr.ok td:nth-child(10){color:#3b6d11}
 .note{margin-top:24px;color:#6b6459;font-size:13px;max-width:900px}
 code{background:#ece7db;padding:1px 4px;border-radius:3px}
</style>
<h1>交付门禁报告 · ${ok}/${rows.length} 通过</h1>
<p class="lede">只拦交付完整性：帧数与时钟一致、有声、音画同长、没有空帧或黑帧。
开场运动（hook）、平均亮度（Y）、最长静止（freeze）、重复帧只报不拦——在这批成片上的分布是连续的，设一条线只会误伤。</p>
<table><thead><tr><th>成片</th><th>规格</th><th>帧数/应有</th><th>空帧</th><th>黑帧</th><th>hook</th><th>Y</th><th>最长静止</th><th>LUFS</th><th>判定</th><th>说明</th></tr></thead>
<tbody>${rows.map(cell).join('')}</tbody></table>
<p class="note">阈值来自本仓成片的实测分布：空帧 ≤ ${LIMIT.flatPct}%（实测最大 5.26）、
黑帧 ≤ ${LIMIT.blackPct}%（最大 1.75）、音画差 ≤ ${LIMIT.avDelta}s。
告警线 hook &lt; ${LIMIT.hookWarn}（实测 p10 = 0.09）、最长静止 ≥ ${LIMIT.freezeWarn}s（26 支实测最大 8.5s，
12 支有 &gt;3s 的版式静场——所以静止只报不拦）、响度偏离 ${LIMIT.loudTarget}±${LIMIT.loudTol} LUFS
（交付走 loudnorm −16，实测 5 支全落 −15.9；未走该链路的素材片 −18~−31 只报不拦）。重新标定请跑 <code>cinecode-probe/gate-calib/calibrate.py</code>。</p>`;
}

function parseArgs(argv) {
  const files = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--html') opt[a.slice(2)] = argv[++i];
    else if (a.startsWith('--json=')) opt.json = a.slice(7);
    else if (a.startsWith('--html=')) opt.html = a.slice(7);
    else if (a === '--quiet') opt.quiet = true;
    else if (a === '--require-audio') opt.requireAudio = true;
    else if (a === '--ocr') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0 && !String(argv[i + 1]).endsWith('.mp4')) { opt.ocr = n; i++; }
      else opt.ocr = 2;
    }
    else if (a === '--expect') opt.expect = argv[++i];
    else if (a === '--require-expect') opt.requireExpect = true;
    else if (a === '--bgm') opt.bgm = true;
    else if (a === '--require-bgm') { opt.bgm = true; opt.requireBgm = true; }
    else if (a === '--loudness') opt.loudness = true;
    else if (a === '--require-loudness') { opt.loudness = true; opt.requireLoudness = true; }
    else if (a === '--facts') opt.facts = argv[++i];
    else if (a === '--caption-check') opt.captionParams = argv[++i];
    else if (a === '--blank') opt.blank = true;
    else if (a === '--motion') opt.motion = true;
    else if (a === '--subtitle-y') {
      const [lo, hi] = String(argv[++i]).split(',').map(Number);
      opt.subtitleBand = [lo, hi];
    }
    else if (a === '--require-facts') opt.requireFacts = true;
    else if (a === '--ocr-out') opt.ocrOut = argv[++i];
    else files.push(a);
  }
  return { files, opt };
}

const { files, opt } = parseArgs(process.argv.slice(2));
if (!files.length) {
  console.error('usage: node gate.mjs <film.mp4> [more.mp4 ...] [--json out.json] [--html out.html] [--require-audio] [--quiet]\n' +
    '       node gate.mjs <film.mp4> --ocr [秒=2] [--expect "文字1,文字2"] [--require-expect] [--ocr-out ocr.txt]\n' +
    '       node gate.mjs <film.mp4> --bgm | --require-bgm      # 查音轨有没有铺底音乐（单向判据）\n' +
    '       node gate.mjs <film.mp4> --loudness | --require-loudness   # -16 LUFS 口径 + 真峰值\n' +
    '       node gate.mjs <film.mp4> --facts facts.md [--require-facts]  # 台账里的数字必须在屏幕上出现\n' +
    '       node gate.mjs <film.mp4> --caption-check params.json        # 字幕是否真的显示出来（容错）\n' +
    '       node gate.mjs <film.mp4> --blank                            # 画面是否"空着"（信息量判据）',
    '       node gate.mjs <film.mp4> --caption-check p.json --subtitle-y 0.28,0.45   # 竖屏的字幕带',
    '       node gate.mjs <film.mp4> --motion                           # 有没有超过 2 秒画面完全不动');
  process.exit(2);
}
if (opt.facts && !opt.ocr) opt.ocr = 2;    // 台账对照要靠屏幕字，没给 --ocr 就默认 2 秒一帧
if (opt.captionParams && (!opt.ocr || opt.ocr > 1)) opt.ocr = 1;   // 字条平均 2-3s，抽帧必须更密
const rows = files.map((f) => judge(f, opt));
if (!opt.quiet) {
  console.log(table(rows));
  // 按消息自身级别打印，不跟着整片判定走：一条 warn 不该因为同片另有 fail 就被标成 FAIL
  for (const r of rows) {
    for (const m of r.fails) console.log(`FAIL  ${path.basename(r.file)}: ${m}`);
    for (const m of r.warns) console.log(`warn  ${path.basename(r.file)}: ${m}`);
  }
  for (const r of rows) {
    if (!r.facts) continue;
    console.log(`facts ${path.basename(r.file)}: 台账 ${r.facts.total} 条 · 兑现 ${r.facts.hits} · 未上屏 ${r.facts.missing} · 台账外数字 ${r.facts.orphans}`);
  }
  for (const r of rows) for (const h of r.expectHits || []) {
    console.log(`ok    ${path.basename(r.file)}: 屏幕有「${h.want}」@${h.t}s（OCR 原样：${h.raw}）`);
  }
}
// OCR 结果落盘：给了 --ocr-out 就写那里，否则写到临时目录并打印路径（不污染仓库）
for (const r of rows) {
  if (!r.ocr || !r.ocrLines) continue;
  const out = opt.ocrOut || path.join(os.tmpdir(), `ocr-${path.basename(r.file, '.mp4')}.txt`);
  writeFileSync(out, r.ocrLines.map((l) => `${fmtTime(l.t)}  ${l.text}`).join('\n'));
  if (!opt.quiet) console.log(`OCR   ${path.basename(r.file)}: ${r.ocr.frames} 帧 / ${r.ocr.lines} 行 → ${out}`);
}
if (opt.json) writeFileSync(opt.json, JSON.stringify(rows, null, 2));
if (opt.html) writeFileSync(opt.html, html(rows));
process.exit(rows.some((r) => r.verdict === 'FAIL') ? 1 : 0);
