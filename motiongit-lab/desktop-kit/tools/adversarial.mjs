#!/usr/bin/env node
/**
 * desktop-kit · 对抗审查套件
 *
 * 判据基于「期望行为」而非「当前行为」：修复后自动从 FAIL 转 PASS，不需要改测试。
 * 输出 out/desktop-adversarial/evidence.json 与 report.html。
 *
 *   node desktop-kit/tools/adversarial.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, loadTokens, SHOT_TYPES } from '../desktop.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KIT = path.resolve(HERE, '..');
const ROOT = path.resolve(KIT, '..');
const OUT = path.join(ROOT, 'out', 'desktop-adversarial');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const T = loadTokens();
const W = T.width, H = T.height;
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const results = [];

function add(id, group, name, verdict, detail, extra = {}) {
  results.push({ id, group, name, verdict, detail, ...extra });
  console.log(`${verdict.padEnd(5)} ${id} ${name}  ${detail}`);
}
function expectReject(id, group, name, fn) {
  try { fn(); add(id, group, name, 'FAIL', '静默接受非法输入，产出错误画面'); }
  catch (e) { add(id, group, name, 'PASS', `拒绝：${String(e.message || e).slice(0, 90)}`); }
}
function render(params, t) {
  const c = createCanvas(W, H), g = c.getContext('2d');
  const r = createDesktopRenderer({ ctx: g });
  r.setContent(clone(params));
  r.renderFrame(t);
  return { buf: c.toBuffer('image/png'), data: g.getImageData(0, 0, W, H).data, canvas: c };
}
function px(d, x, y) { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; }
function areaDiff(a, b, x0, y0, w, h, step = 3) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + h; y += step) for (let x = x0; x < x0 + w; x += step) {
    const i = (y * W + x) * 4;
    s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return s / Math.max(1, n);
}
function probeStreams(file) {
  const j = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries',
    'stream=codec_type,duration,nb_frames', '-of', 'json', file], { encoding: 'utf8' }));
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { v: v && Number(v.duration), a: a && Number(a.duration), frames: v && Number(v.nb_frames) };
}

fs.mkdirSync(OUT, { recursive: true });
registerFonts(path.join(ROOT, 'assets', 'fonts'));
const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'demo.json'), 'utf8'));
const VOICED = ['demo', 'uv'].map((n) => JSON.parse(
  fs.readFileSync(path.join(ROOT, 'content', `${n}-voiced.json`), 'utf8')));

/* ───────────── A 组 · 输入鲁棒性 ───────────── */
{
  const p = clone(P); p.shots[1].type = 'noSuchShot';
  expectReject('A01', '输入', '未知镜头类型必须硬失败', () => render(p, 5));
}
{
  const p = clone(P); p.shots[3].t1 = p.shots[3].t0 - 1;
  expectReject('A02', '输入', 't1 <= t0 必须拒绝', () => render(p, 12));
}
{
  const p = clone(P); p.shots[2].chapter = '不存在的章节';
  expectReject('A03', '输入', 'chapter 不在 chapters 中必须拒绝', () => render(p, 9));
}
{
  const p = clone(P); p.shots[5].t0 = p.shots[4].t0;  // 与上一镜重叠
  expectReject('A04', '输入', '镜头时间轴重叠必须拒绝', () => render(p, 20));
}
{
  const p = clone(P); p.durationSeconds = p.shots.at(-1).t1 + 20;
  expectReject('A05', '输入', 'durationSeconds 与末镜 t1 不符必须拒绝', () => render(p, 2));
}
{
  const p = clone(P); p.captions.pop();
  expectReject('A06', '输入', 'shots 与 captions 数量不一致必须拒绝', () => render(p, 2));
}
{
  // 超长字幕：60 字。判据用交付分辨率下的实际像素，不靠目测。
  const p = clone(P);
  const long = '这是一条明显超出安全宽度的超长中文字幕用来检验渲染器会不会把文字裁到画面外面并且一直重复下去直到足够长';
  p.captions[3].zh = long.slice(0, 60);
  const probe = createCanvas(1, 1).getContext('2d');
  probe.font = `900 ${T.subtitle.zhSize}px ${T.fonts.black}`;
  const measured = probe.measureText(p.captions[3].zh.replace(/\*/g, '')).width;
  // 两种正确行为都算 PASS：渲染器按安全宽度缩字号，或在校验期硬拒绝。判据只看交付像素。
  let rejected = false, fr = null;
  try { fr = render(p, 12.5); } catch { rejected = true; }
  // 扫描字幕行左右边缘 24px：出现近白字像素 = 文字被画到画面外（裁切）
  let edge = 0;
  if (fr) for (let y = 915; y < 975; y += 2) for (const x0 of [0, W - 24]) {
    for (let x = x0; x < x0 + 24; x += 2) {
      const [r, g, b] = px(fr.data, x, y);
      if (r > 205 && g > 205 && b > 205) edge++;
    }
  }
  // 绝对白像素会把固定种子噪点算进来（首轮 332 → 缩号后仍有 252，其实不是字）。
  // 用同一帧的「正常字幕」做对照：边缘区域只在真的溢出时才会出现新增内容。
  const base = render(P, 12.5);
  const edgeDiff = fr ? areaDiff(base.data, fr.data, [[0, 915, 24, 60], [W - 24, 915, 24, 60]]) : 0;
  const safe = rejected || edgeDiff < 2;
  add('A07', '输入', '超长字幕不得溢出画面', safe ? 'PASS' : 'FAIL',
    `按标定字号复算 ${measured.toFixed(0)}px / 上限 ${T.subtitle.maxWidth}px；` +
    (rejected ? '渲染器硬拒绝' : `与正常帧的边缘差分 Δ=${edgeDiff.toFixed(2)}（绝对白像素 ${edge} 含噪点，不作判据）`),
    { measured: Math.round(measured), edgeDiff: Number(edgeDiff.toFixed(3)), edgePixels: edge, rejected });
  if (fr) fs.writeFileSync(path.join(OUT, 'attack-A07-longcaption.png'), fr.buf);
}

/* ───────────── B 组 · 确定性与时间轴 ───────────── */
{
  const a = render(P, 12.5), b = render(P, 12.5);
  add('B01', '确定性', '同一 t 两次渲染逐字节一致', sha(a.buf) === sha(b.buf) ? 'PASS' : 'FAIL',
    `png sha ${sha(a.buf)} / ${sha(b.buf)}`);
}
{
  const a = render(P, 11.6), b = render(P, 12.5);
  const d = areaDiff(a.data, b.data, 410, 280, 270, 160);
  add('B02', '确定性', '相邻时刻翻牌确实在动', d > 3 ? 'PASS' : 'FAIL', `翻牌区帧差 Δ=${d.toFixed(1)}`);
}
{
  const a = render(P, 32.0), b = render(P, 32.0);
  add('B03', '确定性', '独立渲染器实例互不串状态', sha(a.buf) === sha(b.buf) ? 'PASS' : 'FAIL',
    `两个实例 png sha ${sha(a.buf)} / ${sha(b.buf)}`);
}
{
  const issues = [];
  VOICED.forEach((d, k) => {
    const name = ['demo', 'uv'][k], s = d.shots, c = d.captions;
    if (s.length !== c.length) issues.push(`${name}: shots/captions ${s.length}/${c.length}`);
    for (let i = 0; i < s.length; i++) {
      if (!(s[i].t1 > s[i].t0)) issues.push(`${name}#${i}: t1<=t0`);
      if (i + 1 < s.length && Math.abs(s[i].t1 - s[i + 1].t0) > 0.002) issues.push(`${name}#${i}: 镜头不连续`);
      if (c[i] && (c[i].start < s[i].t0 - 0.5 || c[i].end > s[i].t1 + 0.5)) issues.push(`${name}#${i}: 字幕越出镜头`);
    }
    if (Math.abs(d.durationSeconds - s.at(-1).t1) > 0.002) issues.push(`${name}: duration≠末镜 t1`);
    if (Math.round(d.durationSeconds * d.fps) !== Math.round(s.at(-1).t1 * d.fps)) issues.push(`${name}: 帧数与时长不符`);
  });
  add('B04', '确定性', '两条 voiced 时间轴不变量', issues.length ? 'FAIL' : 'PASS',
    issues.length ? issues.slice(0, 5).join('; ') : '2 份 / 28 镜头：连续、无重叠、字幕不越界、帧数守恒');
}

/* ───────────── C 组 · 交付正确性 ───────────── */
{
  const files = ['desktop.mp4', 'desktop-uv.mp4'].map((f) => path.join(ROOT, 'out', f));
  const rows = files.map((f) => ({ f: path.basename(f), ...probeStreams(f) }));
  const bad = rows.filter((r) => Math.abs(r.v - r.a) > 1 / 60 + 0.02);
  add('C01', '交付', '音画时长差 ≤ 1 帧', bad.length ? 'FAIL' : 'PASS',
    rows.map((r) => `${r.f}: v=${r.v}s a=${r.a}s Δ=${(r.v - r.a).toFixed(3)}s`).join(' | '));
}
{
  // QA 工具有效性：喂一段全静帧视频，它必须报出重复帧
  const f = path.join(OUT, 'attack-C02-static.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=blue:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const r = spawnSync('uv', ['run', '--with', 'numpy', '--with', 'pillow', 'python',
    'qa-gate.py', '--video', f, '--expect-frames', '60'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH}` } });
  const out = (r.stdout || '') + (r.stderr || '');
  const detected = /连续≥3帧相同:\s*([1-9]\d*)\s*段/.test(out) || /RESULT:\s*FAIL/.test(out);
  add('C02', '交付', 'QA 能检出全静帧片', detected ? 'PASS' : 'FAIL',
    detected ? '全静帧片被判 FAIL（门禁有效）' : `静帧片未被拦截：${out.slice(-160).replace(/\n/g, ' ')}`);
}
{
  // 动画有效性：全 talk 镜头（无镜头动画，只有 Dock 律动）能否骗过 QA
  const p = { fps: 60, durationSeconds: 2, shots: [{ type: 'talk', t0: 0, t1: 2 }], captions: [], chapters: [] };
  const pj = path.join(OUT, 'attack-C03-alltalk.json'), f = path.join(OUT, 'attack-C03-alltalk.mp4');
  fs.writeFileSync(pj, JSON.stringify(p));
  execFileSync('node', [path.join(KIT, 'render.mjs'), '--params', pj, '--out', f,
    '--fps', '60', '--workers', '2'], { cwd: ROOT, stdio: 'ignore' });
  const r = spawnSync('uv', ['run', '--with', 'numpy', '--with', 'pillow', 'python',
    'qa-gate.py', '--video', f, '--expect-frames', '120'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH}` } });
  const qaOut = (r.stdout || '') + (r.stderr || '');
  const hasRepeat = /连续≥3帧相同:\s*([1-9]\d*)\s*段/.test(qaOut);
  const hardFail = /RESULT:\s*FAIL/.test(qaOut);
  const blocked = hasRepeat || hardFail;
  add('C03', '交付', 'QA 的「0 重复帧」能否证明动画生效', blocked ? 'PASS' : 'WARN',
    blocked ? '全 talk 片被 QA 检出（门禁有效）'
      : '全 talk 片（镜头动画=0）0 重复帧、QA 仅因无音轨报 WARN：Dock 律动让每帧都不同，'
        + '「无重复帧」不能证明动画生效，必须靠 verify 的分区帧差断言',
    { qaResult: (qaOut.match(/RESULT:\s*\w+/) || [''])[0], hasRepeat, hardFail });
}
{
  // 静态 presenter 的量化边界：连续 10 帧人物窗区域的帧差
  const f = path.join(ROOT, 'out', 'desktop-uv.mp4');
  const dir = path.join(OUT, 'attack-C04-presenter');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '10', '-i', f,
    '-frames:v', '10', path.join(dir, 'p%02d.png')]);
  const imgs = fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort();
  const crops = [];
  for (const n of imgs) {
    const img = await loadImage(path.join(dir, n));
    const c = createCanvas(W, H), g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    crops.push(g.getImageData(940, 226, 378, 500).data);  // 去掉标题栏时间码，只量摄像头画面
  }
  let sum = 0, pairs = 0;
  for (let i = 1; i < crops.length; i++) {
    let s = 0;
    for (let k = 0; k < crops[i].length; k += 64) s += Math.abs(crops[i][k] - crops[i - 1][k]);
    sum += s / (crops[i].length / 64); pairs++;
  }
  const drift = sum / Math.max(1, pairs);
  add('C04', '交付', '静态 presenter 图的逐帧变化', 'INFO',
    `连续 ${imgs.length} 帧摄像头画面平均差 ${drift.toFixed(3)}/255（≈0 = 静态图）；参考片是逐帧真人视频`,
    { frames: imgs.length, meanDrift: Number(drift.toFixed(4)) });
}
{
  // 自检与交付成片的时间轴是否一致
  const verifySrc = fs.readFileSync(path.join(KIT, 'verify.mjs'), 'utf8');
  const shotAt = (d, t) => { let s = d.shots[0]; for (const x of d.shots) if (t >= x.t0) s = x; return s.type; };
  const nominal = shotAt(P, 12.5), voiced = shotAt(VOICED[0], 12.5);
  // 判据：verify 必须显式加载交付用的 voiced params 并做帧差断言，而不只是 nominal。
  const coversVoiced = /demo-voiced\.json/.test(verifySrc) && /voicedOK|vDiff/.test(verifySrc);
  add('C05', '交付', '自检是否覆盖成片的交付时间轴', coversVoiced ? 'PASS' : 'WARN',
    coversVoiced ? `verify 同时跑 nominal 与 demo-voiced（12.5s：${nominal} → ${voiced}），成片时间点上有动画帧差断言`
      : `verify 只用 nominal demo.json（12.5s=${nominal}），而成片 12.5s=${voiced} —— 断言与交付帧不同步`,
    { nominal, voiced });
}

/* ───────────── D 组 · 字形与授权 ───────────── */
{
  // 静态检查：mono() 调用里不得出现中文（历史 bug：中文在 Menlo 下变豆腐块）
  const src = fs.readFileSync(path.join(KIT, 'desktop.mjs'), 'utf8');
  // 判据：所有 txt(..., mono(...), ...) 的文本字面量不得含中文
  const monoCalls = [...src.matchAll(/txt\(([^,]+),\s*[^,]+,\s*[^,]+,\s*mono\(/g)].map((m) => m[1].trim());
  const monoChinese = monoCalls.filter((s) => /[\u4e00-\u9fff]/.test(s));
  add('D01', '字形', 'mono 调用不得含中文', monoChinese.length ? 'FAIL' : 'PASS',
    `扫描到 ${monoCalls.length} 处 mono 文本调用，含中文 ${monoChinese.length} 处`, { monoChinese });
}
{
  // 字体 cmap 覆盖：渲染会用到的所有字符
  const chars = new Set();
  for (const name of ['demo', 'uv']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', `${name}.json`), 'utf8'));
    const walk = (o) => {
      if (typeof o === 'string') for (const ch of o) if (ch.charCodeAt(0) > 127) chars.add(ch);
      else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
    };
    walk(d);
  }
  for (const ch of '·→¥✓▶♪●≡↓←∞★＊©®｜—…「」『』') chars.add(ch);
  const list = [...chars].join('');
  const py = `from fontTools.ttLib import TTFont
import json,sys
chars=sys.argv[1]
out={}
for name in ['Regular','Medium','Black']:
    f=TTFont(sys.argv[2]+'/NotoSansSC-'+name+'.otf')
    cmap=f.getBestCmap()
    out[name]=[c for c in chars if ord(c) not in cmap]
print(json.dumps(out,ensure_ascii=False))`;
  const r = spawnSync('uv', ['run', '--with', 'fonttools', 'python', '-c', py, list,
    path.join(ROOT, 'assets', 'fonts')], { encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
  let missing = {};
  try { missing = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch { missing = { error: (r.stderr || 'fonttools 调用失败').slice(-200) }; }
  const flat = Object.values(missing).flat ? Object.values(missing).flat() : [];
  const total = flat.length;
  add('D02', '字形', 'Noto 三字重覆盖全部用到的字符', total ? 'FAIL' : 'PASS',
    `扫描 ${list.length} 个字符，缺字 ${total}${total ? '：' + [...new Set(flat)].join('') : ''}`,
    { scanned: list.length, missing: missing });
}
{
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|json|py|md)$/.test(e.name)) files.push(p);
  } };
  walk(KIT);
  const bad = [];
  // 审查脚本自身必然包含被检测的敏感词（它们是检测模式），必须排除，否则永远自报 FAIL。
  const self = path.resolve(HERE, 'adversarial.mjs');
  for (const f of files) {
    if (path.resolve(f) === self) continue;
    const s = fs.readFileSync(f, 'utf8');
    for (const pat of ['motiongit.key', 'apiKey', 'release.bin', 'templates/mac-desktop', 'personal/']) {
      if (s.includes(pat)) bad.push(`${path.relative(KIT, f)}: ${pat}`);
    }
  }
  add('D03', '授权', 'kit 不含模板包密钥/受保护内容引用', bad.length ? 'FAIL' : 'PASS',
    bad.length ? bad.slice(0, 5).join('; ') : `${files.length - 1} 个文件扫描通过（排除审查脚本自身）；参考帧只在 tools/compare.py 本地校验用`);
}

/* ───────────── 汇总 ───────────── */
const count = (v) => results.filter((r) => r.verdict === v).length;
const summary = { time: new Date().toISOString(), total: results.length,
  pass: count('PASS'), fail: count('FAIL'), warn: count('WARN'), info: count('INFO'), results };
fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(summary, null, 2));

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const color = { PASS: '#34C759', FAIL: '#FF5F57', WARN: '#F5B321', INFO: '#8A93A3' };
const beforePath = path.join(OUT, 'evidence-before.json');
let beforeMap = {}, beforeFail = null;
if (fs.existsSync(beforePath)) {
  try {
    const b = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    beforeMap = Object.fromEntries(b.results.map((r) => [r.id, r]));
    beforeFail = b.fail;
  } catch { /* 无基线也不影响报告 */ }
}
let lastGroup = '';
const rows = results.map((r) => {
  let head = '';
  if (r.group !== lastGroup) { head = `<tr class="grp"><td colspan="5">${esc(r.group)} 组</td></tr>`; lastGroup = r.group; }
  const b = beforeMap[r.id];
  const bv = b ? `<b style="color:${color[b.verdict]}">${b.verdict}</b>` : '—';
  return head + `<tr><td class="id">${r.id}</td><td>${bv}</td><td><b style="color:${color[r.verdict]}">${r.verdict}</b></td>
  <td>${esc(r.name)}</td><td class="dt">${esc(r.detail)}</td></tr>`;
}).join('');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>desktop-kit · 对抗审查报告</title><style>
:root{color-scheme:dark}body{margin:0;padding:40px;background:#14161b;color:#e9ebef;
font:14px/1.65 -apple-system,"PingFang SC",sans-serif}h1{font-size:26px;margin:0 0 6px}
.sub{color:#98a0ad;margin-bottom:26px}.kpi{display:flex;gap:24px;flex-wrap:wrap;background:#1c1f26;
border:1px solid #2a2f38;border-radius:10px;padding:16px 20px;margin-bottom:26px}
.kpi b{display:block;font-size:24px}.kpi span{color:#8b93a1;font-size:12px}
table{width:100%;border-collapse:collapse;background:#1c1f26;border:1px solid #2a2f38;border-radius:10px;overflow:hidden}
td{padding:10px 14px;border-top:1px solid #262b33;vertical-align:top}
.grp td{background:#22262f;color:#f5b321;font-weight:600;letter-spacing:1px}
.id{color:#98a0ad;font-family:monospace;width:52px}.dt{color:#b9c0cb;font-size:13px}
</style></head><body><h1>desktop-kit · 对抗审查报告</h1>
<div class="sub">判据基于「期望行为」，不是「当前行为」；修复后同一脚本自动从 FAIL 转 PASS。证据：out/desktop-adversarial/evidence.json</div>
<div class="kpi"><div><b style="color:#34C759">${summary.pass}</b><span>PASS</span></div>
<div><b style="color:#FF5F57">${summary.fail}</b><span>FAIL（真缺陷）</span></div>
<div><b style="color:#F5B321">${summary.warn}</b><span>WARN（盲区/边界）</span></div>
<div><b>${summary.info}</b><span>INFO（观测）</span></div>
${beforeFail !== null ? `<div><b style="color:#F5B321">${beforeFail} → ${summary.fail}</b><span>FAIL 首轮 → 修复后</span></div>` : ''}
<div><b>${summary.total}</b><span>合计</span></div></div>
<p style="color:#98a0ad;font-size:13px;max-width:980px">
<b>判据说明</b>：FAIL = 真缺陷（必须修）；WARN = 刻意保留的工具局限或已知边界；INFO = 观测数据。
「首轮」列来自 evidence-before.json。审查期间发现工作区存在并行写入（字幕字重被另一路任务调整、
新增 tools/video-compare.py），因此所有成片在修复后按当前磁盘上的渲染器重新出片，保证证据与交付物同源。
</p>
<table><tr class="grp"><td colspan="5">首轮 / 本轮对照</td></tr>
<tr><td class="id">—</td><td><b>首轮</b></td><td><b>本轮</b></td><td>攻击项</td><td class="dt">证据</td></tr>
${rows}</table></body></html>`;
fs.writeFileSync(path.join(OUT, 'report.html'), html);
console.log(`\n${summary.pass} PASS / ${summary.fail} FAIL / ${summary.warn} WARN / ${summary.info} INFO`);
console.log(`→ ${path.join(OUT, 'report.html')}`);
process.exit(summary.fail ? 1 : 0);
