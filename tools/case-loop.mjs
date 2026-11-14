#!/usr/bin/env node
// case-loop.mjs — 一条片的「对抗审查」驱动器：把能自动化的检查固化，每次出片自动跑一遍并留痕。
//
// 为什么要有它（2026-11-14）：这条产线的缺陷有三类，靠人眼看帧每次都会漏：
//   1. 完整性（帧数 / 空帧 / 黑帧 / 响度）—— gate.mjs 已经覆盖；
//   2. 节奏（长时间无变化 / 落位即切）—— tools/pacing.mjs 覆盖；
//   3. **结构性语义错误**：同拍两段重放同一画面、章节号分母是子段数、字幕被截断、
//      台账里的数字没上屏。这三类成片照样 PASS，只能靠"读屏幕"发现。
// 本工具做第 3 类，并把 1、2 的读数汇总进同一份案例，形成可回溯的留痕。
//
// 用法：
//   node tools/case-loop.mjs <slug>            # 审查 content/<slug>/ 对应的 out/<slug>.mp4
//   node tools/case-loop.mjs <slug> --quiet    # 只写文件，不打印表格
// 产物：docs/cases/<slug>.md（案例）+ docs/cases/LOG.md（追加一行留痕）
// 退出码：0 无硬缺陷；1 有硬缺陷（需修复后复测）；2 输入错误

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as BINS from '../src/bins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = BINS.FFMPEG;
const CASE_DIR = path.join(ROOT, 'docs/cases');

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith('-'));
const quiet = argv.includes('--quiet');
if (!slug) { console.error('用法: node tools/case-loop.mjs <slug>'); process.exit(2); }

const video = path.join(ROOT, `out/${slug}.mp4`);
const scriptPath = path.join(ROOT, `content/${slug}/script.json`);
// 两份参数分工：节奏用链式那份（渲染真正用的），拍映射用绝对那份（有 t0/t1，能对齐段与拍）。
// 链式参数里是 from:'@prev'，没有 t0，拿它映射段→拍会全部落空（实测 round-window 结构检查因此空转）。
const chainPath = path.join(ROOT, `content/${slug}/params-chain.json`);
const absPath = path.join(ROOT, `content/${slug}/params.json`);
const paramsPath = existsSync(chainPath) ? chainPath : (existsSync(absPath) ? absPath : '');
const mapPath = existsSync(absPath) ? absPath : paramsPath;
const factsPath = path.join(ROOT, `content/${slug}/facts.md`);
if (!existsSync(video)) { console.error(`找不到成片: ${video}`); process.exit(2); }
if (!existsSync(scriptPath)) { console.error(`找不到 script.json: ${scriptPath}`); process.exit(2); }

const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const beats = script.beats || [];

/* ---------- 1. 门禁（含台账）+ 2. 节奏：都走现成工具，不在这里重实现 ---------- */
function runGate() {
  const j = path.join(os.tmpdir(), `case-gate-${slug}.json`);
  const args = [path.join(ROOT, 'src/gate.mjs'), video, '--json', j,
    '--blank', '--loudness', '--ocr', '2', '--pacing'];
  if (existsSync(factsPath)) args.push('--facts', factsPath);
  if (paramsPath) args.push('--pacing-params', paramsPath);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
  // gate 在 FAIL 时退出码 1，结果照样有效
  try { return JSON.parse(readFileSync(j, 'utf8'))[0] || null; } catch { return null; }
}

function runPacing() {
  const j = path.join(os.tmpdir(), `case-pacing-${slug}.json`);
  const args = [path.join(ROOT, 'tools/pacing.mjs'), video, '--json', j];
  if (paramsPath) args.push('--params', paramsPath);
  spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
  try { return JSON.parse(readFileSync(j, 'utf8')).films[0] || null; } catch { return null; }
}

/* ---------- 3. 读屏幕：三类成片 PASS 也发现不了的语义错误 ---------- */
// 取 640×360 灰度帧做比对（与 pacing 同口径，避免两套缩放引入差异）
function grayAt(t, file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'scale=640:360:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  return r.stdout && r.stdout.length >= 640 * 360 ? r.stdout : null;
}

// 同屏重复：结构优先 + 像素兜底。
//
// 结构判据是确定性的：一拍被拆成 N 段，但 script.json 只写了 M 份 screens，N>M 就必然
// 从第 M+1 段起复用第 1 份。这一条不依赖抽帧，也不受动画相位影响。
// 像素判据只作兜底（两份 screens 写得几乎一样），且**只比内容区**——把字幕带算进去的话，
// 同一画面配不同字幕会被判成"不同"（实测 round-window 第1段 vs 第3段 全幅均差 2.21，
// 其中大半来自字幕与进度条）。
function duplicateSegments(segs, screensByBeat) {
  const structural = [];
  const byBeat = new Map();
  for (const s of segs) if (s.beat) byBeat.set(s.beat, (byBeat.get(s.beat) || 0) + 1);
  for (const [beat, n] of byBeat) {
    const have = screensByBeat.get(beat) || 1;
    if (n > have) structural.push({ beat, parts: n, screens: have });
  }

  // 像素兜底：每段与**同拍的所有更早段**比（不只是相邻段——3 段拍的复用发生在第 1↔第 3 段）
  const crop = (f) => { const out = Buffer.alloc(640 * (310 - 36)); for (let y = 36; y < 310; y++) f.copy(out, (y - 36) * 640, y * 640, y * 640 + 640); return out; };
  // 采样点取段中（0.8–3.5s 之间按段长取），不取段首：
  // 段首 0.8s 元素还在入场，两段都接近空白 ⇒ 会被判成"雷同"（benford 的 grid 段实测如此）。
  const frames = segs.map((s) => {
    const at = s.t0 + Math.min(3.5, Math.max(0.8, (s.dur || 5) * 0.55));
    const g = grayAt(at, video);
    return { t0: s.t0, beat: s.beat, f: g ? crop(g) : null };
  });
  const pixel = [];
  for (let i = 1; i < frames.length; i++) {
    for (let j = 0; j < i; j++) {
      if (frames[i].beat !== frames[j].beat) continue;
      const a = frames[j].f, b = frames[i].f;
      if (!a || !b) continue;
      let acc = 0;
      for (let k = 0; k < a.length; k++) acc += Math.abs(a[k] - b[k]);
      const mean = acc / a.length;
      if (mean < 0.35) pixel.push({ pair: `${frames[j].t0}s ↔ ${frames[i].t0}s`, mean: +mean.toFixed(2) });
    }
  }
  return { structural, pixel };
}

// 章节号：卡面写 `NN / MM`，MM 必须是**拍数**而不是子段数
function chapterNumbers(ocrLines, beatCount) {
  const hits = [];
  for (const l of ocrLines || []) {
    // 负向前瞻必须有：概率「1 / 365」会被读成章节号「1/36」（实测 birthday-v2）。
    // 章节号的分母后面不可能还跟着数字。
    const m = l.text.match(/(\d{1,2})\s*[/／]\s*(\d{1,2})(?!\d)/);
    if (m) hits.push({ t: l.t, shown: `${m[1]}/${m[2]}`, denom: Number(m[2]) });
  }
  const bad = hits.filter((h) => h.denom !== beatCount);
  return { total: hits.length, bad, beatCount };
}

// 字幕完整性：拿文案逐句去屏幕文字里找。
// 不能用"包含"：OCR 会认错字（实测「住」→「佳」、「纤」→「经」），一句 13 字错 1 字就判缺失。
// 改用**子序列命中率**：句子里的字有多少按顺序出现在这一屏上，≥0.7 视为读到。
// 再按时间桶把同一屏的多行拼起来，否则长句被 OCR 断成两行也会漏判。
function subtitleCoverage(ocrLines) {
  const clean = (s) => String(s).replace(/[\s，。！？、；：""''（）—…·]/g, '');
  const buckets = new Map();
  for (const l of ocrLines || []) {
    const k = l.t;
    buckets.set(k, (buckets.get(k) || '') + clean(l.text));
  }
  const screens = [...buckets.values()];
  // 连续 3 桶也各拼一份：一句 20 字在小屏上会跨 2–3 次采样，只拼相邻两桶仍会漏。
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i++) {
    screens.push((buckets.get(keys[i - 1]) || '') + (buckets.get(keys[i]) || ''));
    if (i >= 2) screens.push((buckets.get(keys[i - 2]) || '') + (buckets.get(keys[i - 1]) || '') + (buckets.get(keys[i]) || ''));
  }

  // 长公共子序列（LCS）而不是贪心子序列：贪心遇到句中一处误识就再也对不上
  // （「住」被认成「佳」之后指针卡死在那个字上，12 字句只能算出 5 字命中 = 0.42）。
  const lcs = (a, b) => {
    const n = a.length, m = b.length;
    if (!n || !m) return 0;
    let prev = new Array(m + 1).fill(0), cur = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      const t = prev; prev = cur; cur = t; cur.fill(0);
    }
    return prev[m];
  };
  const ratio = (needle, hay) => (needle.length ? lcs(needle, hay) / needle.length : 1);

  const sentences = [];
  for (const b of beats) {
    for (const part of String(b.text || '').split(/[，。！？；：、]/).filter((x) => clean(x).length >= 5)) {
      sentences.push({ beat: b.id, text: part.trim(), key: clean(part) });
    }
  }
  const miss = [];
  for (const s of sentences) {
    let best = 0;
    for (const sc of screens) { const r = ratio(s.key, sc); if (r > best) best = r; if (best >= 0.98) break; }
    if (best < 0.7) miss.push({ ...s, score: +best.toFixed(2) });
  }
  return { total: sentences.length, miss };
}

// 每拍的真实语速。取 audio/<id>.mp3 的时长而不是 params 里的段长——
// 段长含段间留白，用它算会把语速系统性估低；mp3 时长才是"说这句话用了多久"。
function textPace() {
  const rows = [];
  for (const b of beats) {
    const mp3 = path.join(ROOT, `content/${slug}/audio/${b.id}.mp3`);
    if (!existsSync(mp3)) continue;
    let dur = 0;
    try {
      dur = Number(execFileSync(BINS.FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', mp3], { encoding: 'utf8' }).trim());
    } catch { continue; }
    const chars = String(b.text || '').replace(/[，。！？、；：""''（）—…·\s]/g, '').length;
    if (!dur) continue;
    rows.push({ id: b.id, chars, dur: +dur.toFixed(2), cps: +(chars / dur).toFixed(2) });
  }
  return rows;
}

/* ---------- 汇总 ---------- */
const gate = runGate();
const pace = runPacing();
const ocr = gate && gate.ocrLines ? gate.ocrLines : [];
const segs = (() => {
  // 段界从 pacing 的 rows 拿（它已经解析了 chain / dur / t0 三种写法）
  if (!pace || !pace.rows) return [];
  // rows 里没有 beat id，用 t0 去 params 里对齐
  const p = mapPath ? JSON.parse(readFileSync(mapPath, 'utf8')) : null;
  const list = p && p.scenes ? p.scenes : [];
  return pace.rows.map((r) => {
    const sc = list.find((s) => Math.abs((s.t0 ?? -1) - r.t0) < 0.02) || {};
    return { t0: r.t0, type: r.type, dur: r.dur, beat: sc.beat };
  });
})();

const screensByBeat = new Map(beats.map((b) => [b.id, (b.screens || []).length]));
const dup = duplicateSegments(segs, screensByBeat);
const chap = chapterNumbers(ocr, beats.length);
const sub = subtitleCoverage(ocr);
const tp = textPace();

const findings = [];
if (gate && gate.verdict === 'FAIL') findings.push({ level: '高', what: `门禁 FAIL：${(gate.fails || []).join('；')}` });
if (gate && gate.facts && gate.facts.missing) findings.push({ level: '中', what: `台账 ${gate.facts.missing} 条数字未上屏` });
if (gate && gate.facts && gate.facts.orphans) findings.push({ level: '中', what: `屏幕有 ${gate.facts.orphans} 个台账外数字` });
if (pace && pace.sum.fail) findings.push({ level: '中', what: `节奏 ${pace.sum.fail}/${pace.sum.segs} 段不达标（最长静止 ${pace.sum.longestStill.max}s）` });
if (dup.structural.length) findings.push({ level: '高', what: `同拍拆段数多于 screens 数 ${dup.structural.length} 处：${dup.structural.map((d) => `${d.beat} ${d.parts}段/${d.screens}屏`).join('、')} —— 后段必然重放前段画面` });
if (dup.pixel.length) findings.push({ level: '中', what: `内容区画面雷同 ${dup.pixel.length} 处：${dup.pixel.map((d) => d.pair).join('、')}` });
if (chap.bad.length) findings.push({ level: '中', what: `章节号分母不是拍数（应为 ${beats.length}）：${[...new Set(chap.bad.map((b) => b.shown))].join('、')}` });
// 分两档：<0.5 才算"几乎没读到"，0.5–0.7 只是可疑（OCR 认错字、字幕被压缩都会落到这一档，
// 本例 info-check 的两句实际是字幕做了精简，不是缺陷）。
const hardMiss = sub.miss.filter((m) => m.score < 0.5);
const softMiss = sub.miss.filter((m) => m.score >= 0.5);
if (hardMiss.length) findings.push({ level: '中', what: `字幕疑似缺失 ${hardMiss.length}/${sub.total} 句：${hardMiss.slice(0, 3).map((m) => `${m.text.slice(0, 10)}(${m.score})`).join('、')}` });
if (softMiss.length) findings.push({ level: '低', what: `字幕疑似被压缩/误识 ${softMiss.length} 句（需人工确认）：${softMiss.slice(0, 2).map((m) => `${m.text.slice(0, 8)}(${m.score})`).join('、')}` });
const skewed = tp.filter((r) => r.cps > 6.0 || r.cps < 2.6);
if (skewed.length) findings.push({ level: '低', what: `语速偏离：${skewed.map((r) => `${r.id} ${r.cps}字/秒`).join('、')}` });

const ok = findings.filter((f) => f.level === '高').length === 0;

/* ---------- 写案例 ---------- */
mkdirSync(CASE_DIR, { recursive: true });
const now = new Date();
const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
const md = `# 案例 · ${script.title || slug}

> slug \`${slug}\` · 母版 ${script.template} · ${script.tier || '—'} · 审查于 ${ts}
> 由 \`tools/case-loop.mjs\` 自动生成；「对抗审查」一节是本次审出的问题与修法留痕。

## 一、成片读数

| 项 | 值 |
|---|---|
| 规格 | ${gate ? `${gate.w}×${gate.h}@${gate.fps}` : '—'} |
| 时长 | ${gate ? `${gate.dur ? gate.dur.toFixed(1) : (gate.frames / gate.fps).toFixed(1)}s` : '—'} · ${gate ? gate.frames : '—'} 帧 |
| 空帧 / 黑帧 | ${gate ? `${gate.flatPct}% / ${gate.blackPct}%` : '—'} |
| 最长冻结 | ${gate && gate.freeze ? gate.freeze.max + 's' : '—'} |
| 响度 | ${gate && gate.loud ? gate.loud.lufs + ' LUFS' : '—'} |
| 节奏：最长静止 | ${pace ? pace.sum.longestStill.max + 's' : '—'} |
| 节奏：段末 hold 最小 | ${pace ? pace.sum.hold.min + 'f' : '—'} |
| 节奏：不达标段 | ${pace ? `${pace.sum.fail}/${pace.sum.segs}` : '—'} |
| 台账 | ${gate && gate.facts ? `${gate.facts.total} 条 · 兑现 ${gate.facts.hits} · 未上屏 ${gate.facts.missing} · 台账外 ${gate.facts.orphans}` : '—'} |
| 判定 | ${gate ? gate.verdict : '—'} |

## 二、对抗审查（自动项）

${findings.length
  ? '| 级别 | 问题 |\n|---|---|\n' + findings.map((f) => `| ${f.level} | ${f.what} |`).join('\n')
  : '自动检查项全部通过。'}

### 逐项明细

- **同屏重复（结构）**：${dup.structural.length ? dup.structural.map((d) => `${d.beat} ${d.parts}段/${d.screens}屏`).join('；') : '无（每拍段数 ≤ screens 数）'}
- **同屏重复（像素）**：${dup.pixel.length ? dup.pixel.map((d) => `${d.pair}（均差 ${d.mean}）`).join('；') : '无（同拍各段内容区均差 ≥ 0.35）'}
- **章节号**：读到 ${chap.total} 处，期望分母 ${chap.beatCount}，异常 ${chap.bad.length} 处
- **字幕覆盖**：${sub.total - sub.miss.length}/${sub.total} 句
- **语速**（字/秒，目标 ≈4.1）：${tp.map((r) => `${r.id} ${r.cps}`).join(' · ') || '—'}

## 三、人工审查留痕

（由出片人补充：画面构图、语义是否自洽、同类片对比结论。自动项看不到「画面对不对」。）

`;

writeFileSync(path.join(CASE_DIR, `${slug}.md`), md);

// LOG：一行一次，便于明天扫时间线
const line = `| ${ts} | \`${slug}\` | ${gate ? gate.verdict : '—'} | ${pace ? pace.sum.longestStill.max + 's' : '—'} | ${findings.filter((f) => f.level === '高').length} 高 / ${findings.filter((f) => f.level === '中').length} 中 / ${findings.filter((f) => f.level === '低').length} 低 | ${findings[0] ? findings[0].what.slice(0, 46) : '通过'} |\n`;
const logPath = path.join(CASE_DIR, 'LOG.md');
if (!existsSync(logPath)) {
  writeFileSync(logPath, `# 出片留痕\n\n> 每跑一次 \`node tools/case-loop.mjs <slug>\` 追加一行。时间线倒着看即可。\n\n| 时间 | 片 | 门禁 | 最长静止 | 缺陷 | 首条问题 |\n|---|---|---|---|---|---|\n`);
}
appendFileSync(logPath, line);

if (!quiet) {
  console.log(`${slug}  ${gate ? gate.verdict : '—'}  ${gate ? `${gate.w}×${gate.h}@${gate.fps} ${gate.frames}f` : ''}`);
  console.log(`缺陷：高 ${findings.filter((f) => f.level === '高').length} / 中 ${findings.filter((f) => f.level === '中').length} / 低 ${findings.filter((f) => f.level === '低').length}`);
  for (const f of findings) console.log(`  [${f.level}] ${f.what}`);
  console.log(`→ docs/cases/${slug}.md`);
}
process.exit(ok ? 0 : 1);
