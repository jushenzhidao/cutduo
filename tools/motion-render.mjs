#!/usr/bin/env node
/**
 * motion-render.mjs — 一个最小但完整的 MotionGit `.motion` 宿主（html-canvas/1）
 *
 * 流程对齐官网: doctor → check-params → plan → prepare/preview → render
 * 依赖: Node 22+, playwright(chromium), FFmpeg（Homebrew / FFMPEG_PATH / PATH）
 *
 * 安全约定: 只读解包 → 校验 ZIP 路径/符号链接/压缩比 → 先读契约再执行；
 *           页面内联到 setContent，禁用全部网络请求；逐帧调用 window.renderFrame(frame, inputs)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE = path.join(HERE, 'packages', 'hello-motion.motion');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const raw = a.slice(2);
      const eq = raw.indexOf('=');
      if (eq >= 0) out[raw.slice(0, eq)] = raw.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[raw] = argv[++i];
      else out[raw] = true;
    } else out._.push(a);
  }
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function exists(p) {
  return fs.existsSync(p);
}
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function log(...a) {
  console.log(...a);
}
function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/* ---------------------------------- 包读取 ---------------------------------- */

function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc;
}

function loadPackage(pkg) {
  const abs = path.resolve(pkg);
  if (!exists(abs)) die(`包不存在: ${abs}`);
  if (fs.statSync(abs).isDirectory()) {
    return { dir: abs, entries: walk(abs), tmp: null };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-instance-'));
  const r = spawnSync('python3', [path.join(HERE, 'safe-unpack.py'), abs, tmp], { encoding: 'utf8' });
  if (r.status !== 0) die(`安全解包失败: ${(r.stderr || r.stdout || '').trim()}`);
  const entries = r.stdout.trim().split('\n').filter(Boolean);
  return { dir: tmp, entries, tmp };
}

function loadManifest(dir) {
  const p = path.join(dir, 'motion.json');
  if (!exists(p)) die('根目录缺少 motion.json（不是有效的 .motion 包）');
  const m = readJson(p);
  if (m.format !== 'motiongit-template') die(`format 不是 motiongit-template: ${m.format}`);
  if (!['html-canvas/1', 'html-dom/1'].includes(m.runtime?.profile)) die(`本宿主支持 html-canvas/1 与 html-dom/1，当前为 ${m.runtime?.profile}`);
  const refs = [m.runtime?.entry, m.parameters?.schema, m.parameters?.defaultPreset,
    m.guide, m.assets?.manifest, m.license?.file, m.integrity].filter(Boolean);
  for (const ref of refs) {
    if (!exists(path.join(dir, ref))) die(`manifest 引用的文件不存在: ${ref}`);
  }
  return m;
}

/* -------------------------------- 参数契约校验 -------------------------------- */

function validate(schema, data, at = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  const type = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (schema.type) {
    const ok = schema.type === 'integer'
      ? typeof data === 'number' && Number.isInteger(data)
      : type(data) === schema.type;
    if (!ok) { errors.push(`${at}: 期望 ${schema.type}，实际 ${type(data)}`); return errors; }
  }
  if (schema.enum && !schema.enum.includes(data)) errors.push(`${at}: 不在枚举 ${JSON.stringify(schema.enum)} 中`);
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && [...data].length < schema.minLength) errors.push(`${at}: 少于 ${schema.minLength} 字`);
    if (schema.maxLength !== undefined && [...data].length > schema.maxLength) errors.push(`${at}: 超过 ${schema.maxLength} 字`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${at}: 不匹配 ${schema.pattern}`);
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${at}: 小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${at}: 大于 ${schema.maximum}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${at}: 少于 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${at}: 多于 ${schema.maxItems} 项`);
    if (schema.items) data.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
  }
  if (type(data) === 'object') {
    for (const k of schema.required || []) if (!(k in data)) errors.push(`${at}.${k}: 必填缺失`);
    for (const [k, v] of Object.entries(data)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: 未声明的参数`);
    }
  }
  return errors;
}

function effectiveInputs(dir, m, cli) {
  const schemaPath = m.parameters?.schema;
  const schema = schemaPath ? readJson(path.join(dir, schemaPath)) : null;
  const presetName = cli.style
    ? `presets/${String(cli.style).replace(/\.json$/, '')}.json`
    : (m.parameters?.defaultPreset || m.preview?.preset);
  let base = {};
  if (presetName && exists(path.join(dir, presetName))) base = readJson(path.join(dir, presetName));
  if (schema?.properties) {
    for (const [k, s] of Object.entries(schema.properties)) {
      if (!(k in base) && s.default !== undefined) base[k] = s.default;
    }
  }
  const user = cli.inputs ? readJson(path.resolve(cli.inputs)) : {};
  const inputs = { ...base, ...user };
  const errors = validate(schema, inputs);
  return { schema, presetName, base, user, inputs, errors };
}

function outputSpec(m, cli, inputs) {
  const o = m.output || {};
  const width = Number(cli.width || o.width || 1920);
  const height = Number(cli.height || o.height || 1080);
  const num = Number(cli.fps || inputs?.fps || o.fps?.num || 30);
  const den = Number(o.fps?.den || 1);
  const seconds = Number(cli.seconds || inputs?.durationSeconds || o.durationSeconds || 6);
  const frames = Math.round(seconds * num / den);
  return { width, height, num, den, seconds, frames, durationPolicy: o.durationPolicy || 'fixed' };
}

/* --------------------------------- 页面与帧 --------------------------------- */

function inlineEntry(dir, m) {
  const entry = m.runtime.entry;
  const entryDir = path.dirname(path.join(dir, entry));
  let html = fs.readFileSync(path.join(dir, entry), 'utf8');
  html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_, src) => {
    const p = path.resolve(entryDir, src);
    if (!exists(p)) die(`entry 引用的脚本不存在: ${src}`);
    return `<script>\n${fs.readFileSync(p, 'utf8')}\n</script>`;
  });
  html = html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (_, href) => {
    const p = path.resolve(entryDir, href);
    return exists(p) ? `<style>\n${fs.readFileSync(p, 'utf8')}\n</style>` : '';
  });
  html = html.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (all, pre, src, post) => {
    if (/^(data|https?):/.test(src)) return all;
    const p = path.resolve(entryDir, src);
    if (!exists(p)) return all;
    const mime = p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `${pre}data:${mime};base64,${fs.readFileSync(p).toString('base64')}${post}`;
  });
  return html;
}

async function openPage(browser, spec, html, inputs) {
  const context = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: 1,
  });
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(data|blob|about):/.test(u)) return route.continue();
    return route.abort(); // permissions.network = false
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('  [page error]', e.message));
  // 把已校验的输入在页面脚本之前注入，供参数化模板（scene-builder）读取
  const payload = JSON.stringify(inputs || {}).replace(/</g, '\\u003c');
  const boot = `<script>window.MOTION_INPUTS=${payload};</script>`;
  const injected = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (h) => `${h}${boot}`)
    : boot + html;
  await page.setContent(injected, { waitUntil: 'load' });
  const has = await page.evaluate(() => typeof window.renderFrame === 'function' || typeof window.seek === 'function');
  if (!has) die('页面没有暴露 window.renderFrame(frame, inputs) 或 window.seek(t, inputs)');
  return { context, page };
}

async function frameBuffer(page, frame, inputs, spec, jpeg) {
  const t = frame * spec.den / spec.num;
  const dataUrl = await page.evaluate(async ({ f, inp, seconds, useJpeg }) => {
    if (typeof window.renderFrame === 'function') await window.renderFrame(f, inp);
    else await window.seek(seconds, inp);
    const c = document.querySelector('canvas');
    if (!c) return null;
    return useJpeg ? c.toDataURL('image/jpeg', 0.94) : c.toDataURL('image/png');
  }, { f: frame, inp: inputs, seconds: t, useJpeg: jpeg });
  if (dataUrl) return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return page.screenshot({
    type: jpeg ? 'jpeg' : 'png',
    ...(jpeg ? { quality: 94 } : {}),
    clip: { x: 0, y: 0, width: spec.width, height: spec.height },
  });
}

/* ---------------------------------- 命令 ---------------------------------- */

async function getBrowser() {
  const { chromium } = await import('playwright');
  return chromium;
}

async function launchBrowser(cli) {
  const chromium = await getBrowser();
  const exe = cli.chromium || process.env.CHROMIUM_PATH;
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(exe ? { executablePath: path.resolve(exe) } : {}),
  });
}

function brewPrefix() {
  const r = spawnSync('brew', ['--prefix'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function ffmpegBinary() {
  const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  const bp = brewPrefix();
  const candidates = [
    process.env.FFMPEG_PATH,                        // 显式指定优先
    bp ? path.join(bp, 'bin', 'ffmpeg') : null,     // Homebrew 原生 arm64：平台性能最优
    '/opt/homebrew/bin/ffmpeg',
    path.join(HERE, 'bin', 'ffmpeg'),               // 仅当用户自行放入二进制时启用
    r.status === 0 ? r.stdout.trim() : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (!exists(p)) continue;
    const v = spawnSync(p, ['-version'], { encoding: 'utf8' });
    if (v.status === 0 && /ffmpeg version/i.test(v.stdout)) return p;
  }
  return null;
}

function ffprobeBinary(ff) {
  const bp = brewPrefix();
  const cands = [
    bp ? path.join(bp, 'bin', 'ffprobe') : null,
    '/opt/homebrew/bin/ffprobe',
    path.join(HERE, 'bin', 'ffprobe'),
    ff.replace(/ffmpeg$/, 'ffprobe'),
  ].filter(Boolean);
  return cands.find((p) => exists(p)) || null;
}

function ffmpegVersion(ff) {
  const r = spawnSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8' });
  const m = r.stdout.match(/ffmpeg version (\S+)/);
  return m ? m[1] : '?';
}

function supportedEncoders(ff) {
  const r = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

/* 编码器策略（本机实测）：Apple Silicon 多核上，新版多线程 libx264 veryfast 比 VideoToolbox
   硬件编码更快，且 CRF 画质更稳；VideoToolbox 仍需 swscale 搬运帧，短片上反而吃亏。
   硬件编码保留为 --encoder videotoolbox / hevc，适合想把编码挪出 CPU 的长片。 */
function resolveEncoder(ff, cli) {
  const want = String(cli.encoder || 'auto').toLowerCase();
  const available = supportedEncoders(ff);
  const map = {
    auto: 'libx264', software: 'libx264', libx264: 'libx264',
    videotoolbox: 'h264_videotoolbox', hw: 'h264_videotoolbox', hardware: 'h264_videotoolbox',
    h264_videotoolbox: 'h264_videotoolbox',
    hevc: 'hevc_videotoolbox', hevc_videotoolbox: 'hevc_videotoolbox',
  };
  const enc = map[want] || want;
  if (!available.includes(enc)) die(`FFmpeg 不支持编码器 ${enc}；可用 --encoder libx264 / videotoolbox / hevc`);
  return enc;
}

function encoderArgs(enc, s, cli) {
  if (enc === 'libx264') {
    return ['-c:v', 'libx264', '-preset', String(cli.preset || 'veryfast'),
      '-crf', String(cli.crf || 18), '-pix_fmt', 'yuv420p'];
  }
  if (enc.endsWith('_videotoolbox')) {
    const mb = cli.bitrate || `${Math.max(4, Math.round(s.width * s.height * (s.num / s.den) * 0.2 / 1e6))}M`;
    return ['-c:v', enc, '-b:v', String(mb), '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', enc, '-pix_fmt', 'yuv420p'];
}

async function cmdDoctor(cli) {
  const node = process.versions.node;
  const chromium = await getBrowser();
  const exe = chromium.executablePath();
  const ff = await ffmpegBinary();
  const py = spawnSync('python3', ['-V'], { encoding: 'utf8' }).stdout.trim();
  const rows = [
    ['Node.js 22+', Number(node.split('.')[0]) >= 22, node],
    ['Python 3 (安全解包)', !!py, py || '缺失'],
    ['Chromium headless', exists(exe), exe],
    ['FFmpeg', !!ff, ff || '未找到（brew install ffmpeg 或设置 FFMPEG_PATH）'],
  ];
  log('\n doctor · 本地运行时检查');
  for (const [k, ok, v] of rows) log(`  ${ok ? '✓' : '✗'} ${k.padEnd(22)} ${v}`);
  if (ff) {
    const encs = supportedEncoders(ff);
    log(`  · FFmpeg ${ffmpegVersion(ff)} · VideoToolbox 硬件编码 ${/h264_videotoolbox/.test(encs) ? '可用' : '不可用'}`);
    log('  · 默认 libx264 veryfast crf18（本机实测最快）；--encoder videotoolbox / hevc 可切换');
  }
  if (exists(exe)) {
    try {
      const b = await launchBrowser(cli);
      const p = await b.newPage();
      await p.setContent('<canvas id="c" width="2" height="2"></canvas>');
      const ok = await p.evaluate(() => !!document.querySelector('canvas').getContext('2d'));
      log(`  ${ok ? '✓' : '✗'} Canvas 2D 可用`);
      await b.close();
    } catch (e) { log('  ✗ 浏览器启动失败: ' + e.message.split('\n')[0]); }
  }
  log('');
}

function cmdInspect(dir, entries, m) {
  log('\n inspect · 只读检查（未执行包内代码）');
  log(`  条目 ${entries.length} 个: ${entries.join(', ')}`);
  log(`  format        ${m.format}  /  spec ${m.specVersion}`);
  log(`  template      ${m.template?.name} (${m.template?.id} v${m.template?.version})`);
  log(`  runtime       ${m.runtime?.profile} → ${m.runtime?.entry}`);
  log(`  output        ${m.output?.width}×${m.output?.height} @ ${m.output?.fps?.num}/${m.output?.fps?.den} fps, ${m.output?.durationPolicy}`);
  log(`  permissions   ${JSON.stringify(m.permissions || {})}`);
  if (m.guide || exists(path.join(dir, 'guide.json'))) log(`  guide.json    存在（素材契约）`);
  const readme = path.join(dir, 'README.md');
  if (exists(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    log(`  README        前 200 字: ${text.slice(0, 200).replace(/\n/g, ' ')}…`);
  }
  const lic = m.license?.file;
  if (lic) log(`  license       ${fs.readFileSync(path.join(dir, lic), 'utf8').trim()}`);
  const integ = m.integrity;
  if (integ) {
    const ij = readJson(path.join(dir, integ));
    let ok = 0, bad = [];
    for (const [f, hash] of Object.entries(ij.files || {})) {
      if (exists(path.join(dir, f)) && sha256(path.join(dir, f)) === hash) ok++;
      else bad.push(f);
    }
    log(`  integrity     ${ok}/${Object.keys(ij.files || {}).length} 个文件 SHA-256 通过${bad.length ? '，异常: ' + bad.join(', ') : ''}`);
  }
  log('');
}

function cmdCheck(dir, m, cli) {
  const r = effectiveInputs(dir, m, cli);
  log('\n check-params · 参数契约');
  log(`  preset        ${r.presetName || '(无)'}`);
  log(`  用户输入       ${cli.inputs || '(无，使用默认)'}`);
  log(`  effective     ${JSON.stringify(r.inputs, null, 2).replace(/\n/g, '\n  ')}`);
  if (r.errors.length) { r.errors.forEach((e) => log('  ✗ ' + e)); log(''); return { ...r, ok: false }; }
  log('  ✓ 校验通过'); log('');
  return { ...r, ok: true };
}

function cmdPlan(dir, m, cli, r) {
  const s = outputSpec(m, cli, r.inputs);
  log('\n plan · 渲染计划');
  log(`  画幅 ${s.width}×${s.height}  fps ${s.num}/${s.den}  时长 ${s.seconds}s  总帧数 ${s.frames}`);
  log(`  参数 ${Object.keys(r.inputs).join(', ')}`);
  const g = exists(path.join(dir, 'guide.json')) ? readJson(path.join(dir, 'guide.json')) : null;
  if (g?.materials) log(`  素材要求 ${JSON.stringify(g.materials)}`);
  log('  网络 禁用 · 逐帧独立 seek · 默认 libx264 veryfast（--encoder 可切换）');
  log('');
}

async function withPage(spec, html, fn, cli, inputs) {
  const browser = await launchBrowser(cli);
  try {
    const { context, page } = await openPage(browser, spec, html, inputs);
    return await fn({ context, page, browser });
  } finally {
    await browser.close();
  }
}

async function cmdPreview(dir, m, cli, r) {
  const s = outputSpec(m, cli, r.inputs);
  const outDir = path.resolve(cli.out || path.join(HERE, 'out', 'preview'));
  fs.mkdirSync(outDir, { recursive: true });
  const html = inlineEntry(dir, m);
  // 有分镜表时按每个场景的中点抽帧，逐镜检查；否则退回等距抽帧
  const scenes = Array.isArray(r.inputs?.scenes) ? r.inputs.scenes : null;
  const picks = scenes && scenes.length
    ? [...new Set([0, ...scenes.map((sc) => Math.round((Number(sc.t0) + Number(sc.t1)) / 2 * s.num / s.den)), s.frames - 1])]
      .filter((f) => f >= 0 && f < s.frames).sort((a, b) => a - b)
    : [0, Math.round(s.frames * 0.25), Math.round(s.frames * 0.5), Math.round(s.frames * 0.75), s.frames - 1];
  await withPage(s, html, async ({ page }) => {
    for (const f of picks) {
      const buf = await frameBuffer(page, f, r.inputs, s, true);
      fs.writeFileSync(path.join(outDir, `frame-${String(f).padStart(4, '0')}.jpg`), buf);
      log(`  ✓ 关键帧 ${f}/${s.frames - 1}`);
    }
  }, cli, r.inputs);
  const cards = picks.map((f) => `<figure><img src="frame-${String(f).padStart(4, '0')}.jpg"><figcaption>frame ${f} · t=${(f * s.den / s.num).toFixed(2)}s</figcaption></figure>`).join('');
  fs.writeFileSync(path.join(outDir, 'preview.html'),
    `<!doctype html><meta charset="utf-8"><title>.motion 关键帧预览</title><style>body{background:#0d1117;color:#e6edf3;font:14px/1.6 -apple-system,sans-serif;margin:32px}h1{font-size:20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}figure{margin:0}img{width:100%;border-radius:8px;border:1px solid #30363d}figcaption{color:#8b949e;padding:6px 2px}</style><h1>${m.template?.name} · 关键帧预览 · ${s.width}×${s.height} @ ${s.num}/${s.den}fps</h1><main>${cards}</main>`);
  log(`\n preview → ${path.join(outDir, 'preview.html')}\n`);
}

/* 分片并行：总帧切成 N 段，每段独立 Chromium + FFmpeg 输出 MPEG-TS，最后 concat。
   实测 1920×1080 DOM 页面 4 路：30.3s → 7.85s（约 3.9×）。 */
async function renderParallel({ cli, r, s, html, ff, enc, vArgs, out, jpeg, t0 }) {
  const jobs = Math.max(2, Math.min(16, Number(cli.jobs) || 4));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-par-'));
  const per = Math.ceil(s.frames / jobs);
  const segs = [];
  for (let i = 0; i < jobs; i++) {
    const start = i * per;
    const end = Math.min(s.frames, start + per);
    if (start < end) segs.push({ i, start, end });
  }
  const audio = cli.audio ? path.resolve(cli.audio) : null;
  if (audio && !exists(audio)) die(`音频文件不存在: ${audio}`);

  const inputArgs = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', `${s.num}/${s.den}`,
    '-vcodec', jpeg ? 'mjpeg' : 'png', '-i', 'pipe:0',
  ];
  log(`\n render · ${s.frames} 帧 → ${out} · ${segs.length} 路并行`);
  log(`  FFmpeg ${ffmpegVersion(ff)} · ${enc} · ${vArgs.join(' ')}`);

  await Promise.all(segs.map(async (seg) => {
    const part = path.join(tmp, `part-${seg.i}.ts`);
    const browser = await launchBrowser(cli);
    try {
      const { page } = await openPage(browser, s, html, r.inputs);
      const fp = spawn(ff, [...inputArgs, ...vArgs, '-f', 'mpegts', part],
        { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      fp.stderr.on('data', (d) => { err += d.toString(); });
      const done = once(fp, 'close');
      for (let f = seg.start; f < seg.end; f++) {
        const buf = await frameBuffer(page, f, r.inputs, s, jpeg);
        if (!fp.stdin.write(buf)) await once(fp.stdin, 'drain');
      }
      fp.stdin.end();
      const [code] = await done;
      if (code !== 0) throw new Error(`分片 ${seg.i} FFmpeg 退出码 ${code}: ${err.trim().slice(-300)}`);
      log(`  ✓ 分片 ${seg.i + 1}/${segs.length}（${seg.end - seg.start} 帧）`);
    } finally {
      await browser.close();
    }
  }));

  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, segs.map((seg) => `file '${path.join(tmp, `part-${seg.i}.ts`)}'`).join('\n'));
  const concatArgs = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy'];
  if (audio) {
    const videoOnly = path.join(tmp, 'video.mp4');
    execFileSync(ff, [...concatArgs, '-movflags', '+faststart', videoOnly]);
    execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoOnly, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      '-movflags', '+faststart', out]);
  } else {
    execFileSync(ff, [...concatArgs, '-movflags', '+faststart', out]);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const size = fs.statSync(out).size;
  log(`  ✓ 导出完成 ${out} (${(size / 1024 / 1024).toFixed(2)} MB) · ${segs.length} 路 · 耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  const probeBin = ffprobeBinary(ff);
  if (probeBin) {
    const probe = spawnSync(probeBin,
      ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,duration', '-of', 'json', out],
      { encoding: 'utf8' });
    if (probe.status === 0) {
      log('  ✓ ffprobe: ' + probe.stdout.trim().replace(/\s+/g, ' '));
      try {
        const n = Number(JSON.parse(probe.stdout).streams?.[0]?.nb_frames);
        if (Number.isFinite(n) && Math.abs(n - s.frames) > 1) {
          log(`  ⚠ 帧数校验：期望 ${s.frames}，实际 ${n}，可能丢帧`);
        }
      } catch { /* ignore */ }
    }
  }
  log('');
  return out;
}

async function cmdRender(dir, m, cli, r) {
  const t0 = Date.now();
  const s = outputSpec(m, cli, r.inputs);
  const out = path.resolve(cli.out || path.join(HERE, 'out', 'video.mp4'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ff = await ffmpegBinary();
  if (!ff) die('找不到 FFmpeg：brew install ffmpeg，或设置 FFMPEG_PATH');
  const enc = resolveEncoder(ff, cli);
  const vArgs = encoderArgs(enc, s, cli);
  const jpeg = cli.png !== true; // 默认 JPEG 帧流（更快），--png 走无损 PNG
  const html = inlineEntry(dir, m);

  // --jobs N：分片并行（每片独立 Chromium + FFmpeg，最后 concat）
  if (Number(cli.jobs) > 1) {
    return await renderParallel({ cli, r, s, html, ff, enc, vArgs, out, jpeg, t0 });
  }

  const inputArgs = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', `${s.num}/${s.den}`,
    '-vcodec', jpeg ? 'mjpeg' : 'png', '-i', 'pipe:0',
  ];
  const audio = cli.audio ? path.resolve(cli.audio) : null;
  if (audio) {
    if (!exists(audio)) die(`音频文件不存在: ${audio}`);
    inputArgs.push('-i', audio);
  }
  const outputArgs = [
    ...vArgs, '-movflags', '+faststart',
    ...(audio ? ['-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : ['-an']),
    out,
  ];
  const ffproc = spawn(ff, [...inputArgs, ...outputArgs], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ffproc.stderr.on('data', (d) => { stderr += d.toString(); });
  const done = once(ffproc, 'close');

  log(`\n render · ${s.frames} 帧 → ${out}`);
  log(`  FFmpeg ${ffmpegVersion(ff)} · ${enc} · ${vArgs.join(' ')}`);
  await withPage(s, html, async ({ page }) => {
    for (let f = 0; f < s.frames; f++) {
      const buf = await frameBuffer(page, f, r.inputs, s, jpeg);
      if (!ffproc.stdin.write(buf)) await once(ffproc.stdin, 'drain');
      if (f % 30 === 0 || f === s.frames - 1) process.stdout.write(`\r  ${String(f + 1).padStart(4)}/${s.frames} 帧`);
    }
    process.stdout.write('\n');
  }, cli, r.inputs);
  ffproc.stdin.end();
  const [code] = await done;
  if (code !== 0) die(`FFmpeg 退出码 ${code}: ${stderr.trim()}`);
  const size = fs.statSync(out).size;
  log(`  ✓ 导出完成 ${out} (${(size / 1024 / 1024).toFixed(2)} MB) · 耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  const probeBin = ffprobeBinary(ff);
  if (probeBin) {
    const probe = spawnSync(probeBin,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,duration', '-of', 'json', out],
      { encoding: 'utf8' });
    if (probe.status === 0) {
      log('  ✓ ffprobe: ' + probe.stdout.trim().replace(/\s+/g, ' '));
      try {
        const n = Number(JSON.parse(probe.stdout).streams?.[0]?.nb_frames);
        if (Number.isFinite(n) && Math.abs(n - s.frames) > 1) {
          log(`  ⚠ 帧数校验：期望 ${s.frames}，实际 ${n}，可能丢帧`);
        }
      } catch { /* ignore */ }
    }
  }
  log('');
  return out;
}

/* ---------------------------------- 入口 ---------------------------------- */

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const cmd = cli._[0] || 'inspect';
  // 必须 await：try/finally 中直接 return promise 会让 finally 先执行，提前删掉临时解包目录
  if (cmd === 'doctor') return await cmdDoctor(cli);

  const pkg = loadPackage(cli.package || DEFAULT_PACKAGE);
  try {
    const m = loadManifest(pkg.dir);
    if (cmd === 'inspect') { cmdInspect(pkg.dir, pkg.entries, m); return; }
    const r = cmdCheck(pkg.dir, m, cli);
    if (!r.ok) process.exitCode = 1;
    if (cmd === 'check-params') return;
    cmdPlan(pkg.dir, m, cli, r);
    if (cmd === 'plan') return;
    if (!r.ok) die('参数校验未通过，停止渲染');
    if (cmd === 'preview') return await cmdPreview(pkg.dir, m, cli, r);
    if (cmd === 'render') return await cmdRender(pkg.dir, m, cli, r);
    die(`未知命令: ${cmd}（可用: doctor / inspect / check-params / plan / preview / render）`);
  } finally {
    if (pkg.tmp && !cli.keep) fs.rmSync(pkg.tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('✗ ' + (e.stack || e.message)); process.exit(1); });
