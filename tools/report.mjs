#!/usr/bin/env node
/**
 * tools/report.mjs · 片库总览（一条命令看全部状态）
 *
 *   node tools/report.mjs            # 生成 out/report/index.html
 *   node tools/report.mjs --no-gate  # 跳过门禁（快速看一眼）
 *
 * 为什么需要它：片子散在 content/<slug>/（稿子与参数）、out/*.mp4（成片）、
 * out/publish/<slug>/（发布包）三处，门禁结论只在终端里出现过一次就没了。
 * 实测有一次 `content/selection-bias` 是自己出的片，我完全不知道它存在——
 * 这就是"没有总览"的代价。
 *
 * 只读，不改任何东西。门禁结果现场跑（每支 3–5 s），不落缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_GATE = process.argv.includes('--no-gate');
const OUT = path.join(ROOT, 'out', 'report');
fs.mkdirSync(OUT, { recursive: true });

const probe = (file, sel, ent) => {
  try {
    return execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel,
      '-show_entries', ent, '-of', 'json', file], { encoding: 'utf8' });
  } catch { return null; }
};

const films = [];
for (const slug of fs.readdirSync(path.join(ROOT, 'content'))) {
  const dir = path.join(ROOT, 'content', slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  const paramsFile = path.join(dir, 'params-abs.json');
  if (!fs.existsSync(paramsFile)) continue;

  const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
  const script = fs.existsSync(path.join(dir, 'script.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')) : {};
  const segs = params.scenes || params.segments || [];
  const mp4 = path.join(ROOT, 'out', slug + '.mp4');

  let spec = null, sizeMB = null, mtime = null;
  if (fs.existsSync(mp4)) {
    const v = JSON.parse(probe(mp4, 'v:0', 'stream=width,height,r_frame_rate,nb_frames') || '{}').streams?.[0] || {};
    const f = JSON.parse(probe(mp4, 'v:0', 'format=duration') || '{}').format || {};
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).trim());
    spec = { w: v.width, h: v.height, fps: Math.round(eval((v.r_frame_rate || '0/1').replace('/', '/'))),
      frames: Number(v.nb_frames) || null, duration: +dur.toFixed(2) };
    sizeMB = +(fs.statSync(mp4).size / 1e6).toFixed(2);
    mtime = fs.statSync(mp4).mtime.toISOString().slice(0, 16).replace('T', ' ');
  }

  // 封面：优先进发布包，其次抽一帧
  let cover = null;
  const pubCover = path.join(ROOT, 'out', 'publish', slug, 'cover.jpg');
  const thumb = path.join(OUT, slug + '.jpg');
  if (fs.existsSync(pubCover)) cover = '../publish/' + slug + '/cover.jpg';
  else if (fs.existsSync(thumb)) cover = slug + '.jpg';
  else if (mp4) {
    try {
      // 抽 40% 处的帧：第 1 秒往往还是片头/淡入，缩略图会是一片空
      const at = Math.max(0.5, Number(params.durationSeconds || 3) * 0.4).toFixed(2);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', at, '-i', mp4, '-frames:v', '1',
        '-vf', 'scale=480:-2', thumb]);
      cover = slug + '.jpg';
    } catch { /* 抽不出就留空 */ }
  }

  // 门禁：先登记，循环结束后并发跑（串行跑 4 支要 1 分多钟）
  let verdict = null, warns = [], gateArgs = null;
  if (!NO_GATE && mp4) {
    const facts = path.join(dir, 'facts.md');
    gateArgs = [path.join(ROOT, 'src', 'gate.mjs'), mp4, '--blank', '--require-loudness'];
    if (fs.existsSync(facts)) gateArgs.push('--facts', facts);
  }

  const factRows = fs.existsSync(path.join(dir, 'facts.md'))
    ? (fs.readFileSync(path.join(dir, 'facts.md'), 'utf8').match(/^\|\s*\d+\s*\|/gm) || []).length : 0;
  const pub = path.join(ROOT, 'out', 'publish', slug);
  const hasPub = fs.existsSync(path.join(pub, 'post.txt'));
  const hasVertical = fs.existsSync(path.join(pub, slug + '-9x16.mp4'));

  films.push({
    slug,
    title: (script.title || slug),
    template: script.template || '?',
    tier: script.tier || '?',
    beats: (script.beats || []).length,
    segments: segs.length,
    types: [...new Set(segs.map((s) => s.type))],
    fps: params.fps,
    duration: spec ? spec.duration : params.durationSeconds,
    sizeMB, spec, mtime, cover, verdict, warns, factRows, hasPub, hasVertical,
    _gateArgs: gateArgs,
  });
}

/* 并发跑门禁 */
const gateArgsOf = films.map((f) => f._gateArgs);   // 由构造时挂上
await Promise.all(films.map(async (f, i) => {
  const args = gateArgsOf[i];
  if (!args) return;
  try {
    const { stdout } = await execFileP('node', args, { encoding: 'utf8', cwd: ROOT });
    const line = stdout.split('\n').find((l) => l.startsWith(f.slug + '.mp4')) || '';
    const cols = line.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
    f.verdict = cols[cols.length - 1] || null;
    f.warns = stdout.split('\n').filter((l) => /^(warn|FAIL|facts)\b/.test(l)).map((l) => l.replace(/^\S+\s+/, ''));
  } catch (e) {
    f.verdict = 'ERR';
    f.warns = [String(e.message).split('\n')[0]];
  }
}));

films.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

const totalDur = films.reduce((s, f) => s + (f.duration || 0), 0);
const totalMB = films.reduce((s, f) => s + (f.sizeMB || 0), 0);
const pass = films.filter((f) => f.verdict === 'PASS').length;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const card = (f) => `
  <article class="card">
    <div class="thumb">${f.cover ? `<img src="${f.cover}" alt="">` : '<div class="noimg">无成片</div>'}
      <span class="badge ${f.verdict === 'PASS' ? 'ok' : f.verdict ? 'bad' : 'na'}">${f.verdict || '—'}</span>
    </div>
    <div class="body">
      <h3>${esc(f.title)}</h3>
      <p class="meta">${f.template} 母版 · ${f.tier} · ${f.beats} 拍 → ${f.segments} 段 · ${f.fps}fps</p>
      <p class="nums">${f.duration ? f.duration.toFixed(1) + ' s' : '—'} · ${f.sizeMB ? f.sizeMB + ' MB' : '—'}${f.spec ? ` · ${f.spec.w}×${f.spec.h}` : ''}</p>
      <p class="types">${f.types.map((t) => `<code>${t}</code>`).join(' ')}</p>
      <p class="flags">
        台账 <b>${f.factRows}</b> 条 ·
        发布包 <b class="${f.hasPub ? 'ok' : 'na'}">${f.hasPub ? '已生成' : '未生成'}</b> ·
        竖屏 <b class="${f.hasVertical ? 'ok' : 'na'}">${f.hasVertical ? '有' : '无'}</b>
      </p>
      ${f.warns.length ? `<ul class="warns">${f.warns.slice(0, 3).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="file">${f.mtime || '—'}</p>
    </div>
  </article>`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>片库总览 · ${films.length} 支</title>
<style>
  :root{--bg:#EFEFE5;--ink:#15231A;--dim:#6E7869;--line:rgba(0,0,0,.10);--acc:#1E8A66;--red:#C0392B}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.6 "Noto Sans SC","PingFang SC",-apple-system,sans-serif;padding:40px 32px 64px}
  header{max-width:1240px;margin:0 auto 28px}
  h1{font-size:30px;margin:0 0 6px;letter-spacing:.5px}
  .sub{color:var(--dim);font-size:14px}
  .stats{display:flex;gap:28px;margin:20px 0 0;flex-wrap:wrap}
  .stat b{font-size:24px;font-weight:700;letter-spacing:-.5px}
  .stat span{display:block;color:var(--dim);font-size:12px;letter-spacing:1px}
  .grid{max-width:1240px;margin:0 auto;display:grid;
    grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:22px}
  .card{background:#F7F7F0;border:1px solid var(--line);border-radius:10px;overflow:hidden;
    display:flex;flex-direction:column}
  .thumb{position:relative;background:#DCDCD0;aspect-ratio:16/9;overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .noimg{display:grid;place-items:center;height:100%;color:var(--dim);font-size:13px}
  .badge{position:absolute;top:10px;right:10px;padding:3px 9px;border-radius:4px;
    font:600 11px/1.6 ui-monospace,monospace;letter-spacing:1px}
  .badge.ok{background:var(--acc);color:#fff}
  .badge.bad{background:var(--red);color:#fff}
  .badge.na{background:rgba(0,0,0,.45);color:#fff}
  .body{padding:16px 18px 18px}
  h3{margin:0 0 6px;font-size:17px}
  .meta,.nums{color:var(--dim);font-size:13px;margin:2px 0}
  .types{margin:10px 0 8px;display:flex;flex-wrap:wrap;gap:5px}
  code{background:rgba(30,138,102,.10);color:#166B50;padding:1px 6px;border-radius:3px;
    font:500 11px/1.7 ui-monospace,monospace}
  .flags{margin:6px 0 0;font-size:13px;color:var(--dim)}
  .flags b{color:var(--ink)}
  .flags b.ok{color:var(--acc)} .flags b.na{color:#A08A5A}
  .warns{margin:10px 0 0;padding:10px 12px 10px 26px;background:rgba(192,57,43,.06);
    border-left:3px solid rgba(192,57,43,.5);border-radius:4px;font-size:12px;color:#7A3A33}
  .warns li{margin:2px 0}
  .file{margin:12px 0 0;font:11px/1.6 ui-monospace,monospace;color:#9AA394}
  footer{max-width:1240px;margin:36px auto 0;color:var(--dim);font-size:12px}
</style></head><body>
<header>
  <h1>片库总览</h1>
  <p class="sub">生成于 ${new Date().toLocaleString('zh-CN')}${NO_GATE ? ' · 门禁未跑（--no-gate）' : ' · 门禁现场跑'}</p>
  <div class="stats">
    <div class="stat"><b>${films.length}</b><span>支片</span></div>
    <div class="stat"><b>${totalDur.toFixed(0)} s</b><span>总时长</span></div>
    <div class="stat"><b>${totalMB.toFixed(1)} MB</b><span>总体积</span></div>
    <div class="stat"><b>${pass}/${films.length}</b><span>门禁 PASS</span></div>
    <div class="stat"><b>${films.filter((f) => f.hasPub).length}</b><span>已生成发布包</span></div>
  </div>
</header>
<div class="grid">${films.map(card).join('')}</div>
<footer>数据来自 content/&lt;片&gt;/params-abs.json · out/*.mp4 · out/publish/&lt;片&gt;/　位图均为成片原帧</footer>
</body></html>`;

const outFile = path.join(OUT, 'index.html');
fs.writeFileSync(outFile, html);
console.log(`✓ out/report/index.html  ${films.length} 支 · ${totalDur.toFixed(0)}s · ${totalMB.toFixed(1)}MB · PASS ${pass}/${films.length}`);
for (const f of films) console.log(`   ${(f.verdict || '—').padEnd(5)} ${f.title}  ${f.duration ? f.duration.toFixed(1) + 's' : ''}`);
