#!/usr/bin/env node
/**
 * intake.mjs · 模板接入的「只读计划器」（Phase 1）
 *
 *   node tools/intake.mjs plan --source templates/own/night-card
 *   node tools/intake.mjs plan --source refs/vendor/x/template.motion --mode semi
 *   node tools/intake.mjs plan --source refs/vendor/x --json --strict
 *
 * 它做什么：
 *   1. 只读识别输入形态（目录 / .motion ZIP / package 目录）；
 *   2. 静态分类：engine / method / assets / mixed，估计该停在哪一级；
 *   3. 查保护与凭据（protection / release.bin / *.enc / personal/）；
 *   4. 对 .motion 调 tools/distill-inspect.py 提取内容模型（只读，产物写 out/）；
 *   5. 输出 out/intake/<id>/{plan.json,plan.md}，并把阻塞项与下一步写清楚。
 *
 * 它不做什么（刻意）：
 *   · 不执行模板里的任何代码；
 *   · 不解包 ZIP（只用 unzip -Z1 列目录）；
 *   · 不写 kits/、api/、templates/、docs/；
 *   · 不判断「画面好不好」——那必须人看抽帧（Phase 2 的 visual_review）。
 *
 * 退出码：0 计划已产出；1 --strict 且有 blocking；2 输入读不了。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
  console.log(`用法：
  node tools/intake.mjs plan --source <目录或 .motion> [--id <id>] [--mode auto|original|rehost|semi|full]
                              [--json] [--strict] [--no-inspect] [--out-dir out/intake]

只读：不执行模板代码、不解包 ZIP、不写 kits/api/templates/docs。
输出：out/intake/<id>/plan.{json,md}（以及 .motion 的 distill 报告）。
退出码：0 计划已产出；1 --strict 且有 blocking；2 输入读不了。`);
  process.exit(0);
}
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
if (cmd !== 'plan') {
  console.error('用法：node tools/intake.mjs plan --source <目录|.motion> [--id <id>] [--mode auto|original|rehost|semi|full] [--json] [--strict] [--no-inspect] [--out-dir out/intake]');
  process.exit(2);
}

function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const SOURCE_IN = flag('source');
const MODE_REQ = flag('mode', 'auto');
const ID_REQ = flag('id');
const JSON_OUT = argv.includes('--json');
const STRICT = argv.includes('--strict');
const NO_INSPECT = argv.includes('--no-inspect');
const OUT_DIR = path.resolve(REPO_ROOT, flag('out-dir', 'out/intake'));
const MODES = new Set(['auto', 'original', 'rehost', 'semi', 'full']);

if (!SOURCE_IN) {
  console.error('缺 --source。例：node tools/intake.mjs plan --source refs/vendor/x/template.motion');
  process.exit(2);
}
if (!MODES.has(MODE_REQ)) {
  console.error(`--mode 非法：${MODE_REQ}（可选 ${[...MODES].join(' / ')}）`);
  process.exit(2);
}
if (/^https?:\/\//.test(SOURCE_IN)) {
  console.error('Phase 1 只接本地路径：先把包下载到 refs/vendor/ 再跑（远程抓取属于 Phase 3，涉及 pin 与来源记录）。');
  process.exit(2);
}

const SOURCE = path.isAbsolute(SOURCE_IN) ? SOURCE_IN : path.resolve(REPO_ROOT, SOURCE_IN);
if (!fs.existsSync(SOURCE)) {
  console.error(`源不存在：${SOURCE}`);
  process.exit(2);
}

const rel = (p) => path.relative(REPO_ROOT, p).replaceAll(path.sep, '/') || '.';

/** 包名优先取 manifest.template.id；下载形态的 template.motion / package 取上一级目录名。 */
function guessId(src, manifest) {
  if (manifest?.templateId) return manifest.templateId;
  const base = path.basename(src, path.extname(src));
  if (base === 'template' || base === 'package') return path.basename(path.dirname(src));
  return base;
}
const isZip = fs.statSync(SOURCE).isFile();
if (isZip && !/\.(motion|zip)$/i.test(SOURCE)) {
  console.error(`只接目录或 .motion/.zip 包，收到文件：${SOURCE}`);
  process.exit(2);
}

/* ── 只读扫描 ───────────────────────────────────────────────────── */

function hashFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function listZip(file) {
  const out = execFileSync('unzip', ['-Z1', file], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20000,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function walkDir(root) {
  const entries = [];
  const skipped = [];
  let bytes = 0;
  let symlinks = 0;
  let truncated = false;
  const MAX = 6000;
  const stack = [{ abs: root, rel: '' }];
  while (stack.length) {
    const cur = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch (e) {
      skipped.push(`${cur.rel || '.'}: ${e.code || e.message}`);
      continue;
    }
    for (const d of dirents) {
      const childRel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      if (d.name === 'node_modules' || d.name === '.git' || d.name === '.DS_Store') continue;
      if (entries.length >= MAX) { truncated = true; break; }
      const abs = path.join(cur.abs, d.name);
      if (d.isSymbolicLink()) { symlinks++; continue; }
      if (d.isDirectory()) { stack.push({ abs, rel: childRel }); continue; }
      if (!d.isFile()) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { /* 读不到就记 0，不阻断 */ }
      entries.push({ rel: childRel, size });
      bytes += size;
    }
    if (truncated) break;
  }
  return { entries, bytes, skipped, symlinks, truncated };
}

function readText(relPath, max = 512 * 1024) {
  // package-dir 的根在 <dir>/package；其余输入根就是 SOURCE。
  const p = path.join(packageRoot || SOURCE, relPath);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  if (!st.isFile() || st.size > max) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(relPath) {
  const t = readText(relPath);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/* ── 形态与证据 ─────────────────────────────────────────────────── */

let scan;
let names;
let kind;
let packageRoot = null;

if (isZip) {
  kind = 'motion-zip';
  try {
    names = listZip(SOURCE);
  } catch (e) {
    console.error(`读不了 ZIP：${SOURCE}\n  ${String(e.stderr || e.message).split('\n').slice(-4).join('\n  ')}`);
    console.error('  修法：确认它是合法 .motion/.zip；本工具只读列目录，不会解包。');
    process.exit(2);
  }
  scan = {
    entries: names.map((n) => ({ rel: n, size: null })),
    bytes: fs.statSync(SOURCE).size,
    skipped: [],
    symlinks: 0,
    truncated: false,
  };
} else {
  // 旧下载形态：<dir>/package/motion.json
  const pkgMotion = path.join(SOURCE, 'package', 'motion.json');
  if (fs.existsSync(pkgMotion)) {
    kind = 'package-dir';
    packageRoot = path.join(SOURCE, 'package');
  } else {
    kind = 'directory';
    packageRoot = SOURCE;
  }
  scan = walkDir(packageRoot);
  names = scan.entries.map((e) => e.rel);
}

const lowerNames = names.map((n) => n.toLowerCase());
const has = {
  motionJson: names.some((n) => n === 'motion.json' || n.endsWith('/motion.json')),
  guide: names.some((n) => n === 'guide.json' || n === 'assistant/guide.json'),
  schema: names.some((n) => n === 'params.schema.json' || n.endsWith('/params.schema.json')),
  threePiece: ['src/kit.js', 'src/layouts.js', 'src/stage.js'].every((f) => names.includes(f)),
  dom: names.includes('src/dom.js'),
  canvas: names.includes('src/kit.js') || names.includes('src/layouts.js'),
  releaseBin: names.some((n) => n.endsWith('content/release.bin')),
  // release.bin 是内容归档（可能是嵌套 ZIP），不等于加密；protection 字段才是权威。
  encrypted: names.some((n) => n.endsWith('.enc')),
  personal: names.some((n) => /(^|\/)personal\//.test(n) || /(^|\/)(\.key|credentials?|token)(\.|$)/i.test(n)),
  license: names.some((n) => /(^|\/)(licen[cs]e|licen[cs]es|copying)(\/|\.|$)/i.test(n)),
};

const extCount = {};
for (const n of names) {
  const m = n.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  const e = m ? m[1] : '(none)';
  extCount[e] = (extCount[e] || 0) + 1;
}
const topExt = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([ext, count]) => ({ ext, count }));

const codeExt = new Set(['js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sh']);
const mediaExt = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'otf', 'ttf', 'woff', 'woff2']);
const codeFiles = Object.entries(extCount).filter(([e]) => codeExt.has(e)).reduce((n, [, c]) => n + c, 0);
const mediaFiles = Object.entries(extCount).filter(([e]) => mediaExt.has(e)).reduce((n, [, c]) => n + c, 0);
const docFiles = Object.entries(extCount).filter(([e]) => ['md', 'txt', 'json'].includes(e)).reduce((n, [, c]) => n + c, 0);

let manifest = null;
if (packageRoot) {
  const m = readJson('motion.json');
  if (m) {
    manifest = {
      format: m.format || null,
      specVersion: m.specVersion || null,
      templateId: m.template?.id || null,
      templateName: m.template?.name || null,
      runtime: m.runtime?.profile || null,
      engine: m.runtime?.engine || null,
      protection: m.content?.protection || 'n/a',
      contentPath: m.content?.path || null,
      licenseFile: m.license?.file || null,
      output: m.output ? {
        width: m.output.width ?? null,
        height: m.output.height ?? null,
        fps: m.output.fps?.num ?? m.output.fps ?? null,
      } : null,
    };
  }
}

let packageJson = null;
if (packageRoot) {
  const p = readJson('package.json');
  if (p) {
    packageJson = {
      name: p.name || null,
      dependencies: Object.keys(p.dependencies || {}),
      devDependencies: Object.keys(p.devDependencies || {}),
    };
  }
}

has.license = has.license || !!manifest?.licenseFile;
let license = null;
if (!packageRoot && has.license) {
  // ZIP 只列目录，不读文件内容；知道有 LICENSE 即可，具体条款要人看。
  license = { file: '(zip) LICENSE', detected: ['unknown'] };
}
if (packageRoot) {
  const licenseFile = manifest?.licenseFile || names.find((n) => /(^|\/)(licen[cs]e|licen[cs]es|copying)(\/|\.|$)/i.test(n));
  if (licenseFile) {
    const text = readText(licenseFile, 24 * 1024) || '';
    const t = text.toLowerCase();
    const detected = [
      ['apache', /apache license/],
      ['mit', /mit license/],
      ['gpl', /gnu general public license/],
      ['agpl', /affero general public license/],
      ['non-commercial', /non[- ]commercial/],
      ['commons-clause', /commons clause/],
      ['proprietary', /proprietary|all rights reserved/],
    ].filter(([, re]) => re.test(t)).map(([k]) => k);
    license = { file: licenseFile, detected: detected.length ? detected : ['unknown'] };
  }
}

// 目录源可以扫主入口，判断 DOM / Canvas2D；ZIP 只靠文件名，不读内容。
if (packageRoot) {
  // 三件套的 main.js 是宿主入口，允许碰 document（取 canvas 是宿主职责）；
  // 只有 kit.js / layouts.js 必须纯 Canvas2D。别把宿主能力误判成 DOM 引擎。
  const probeFiles = has.threePiece ? ['src/kit.js', 'src/layouts.js'] : ['src/main.js', 'main.js', 'src/index.js'];
  const entry = probeFiles.map((f) => readText(f, 256 * 1024)).filter(Boolean).join('\n');
  if (/document\.(createElement|querySelector|getElementById|appendChild)/.test(entry)) has.dom = true;
  if (/(getContext\s*\(\s*['"]2d['"]|createCanvas|OffscreenCanvas)/.test(entry)) has.canvas = true;
  const deps = [...(packageJson?.dependencies || []), ...(packageJson?.devDependencies || [])].join(' ');
  if (/\b(react|react-dom|vue|three|remotion|pixi)\b/.test(deps)) has.dom = true;
  if (/\b(canvas|@napi-rs\/canvas|skia-canvas)\b/.test(deps)) has.canvas = true;
}

// 先按文件名给一个初值；ZIP 的 protection 要等 distill-inspect 报告出来再校正。
let protection = manifest?.protection || (has.encrypted ? 'protected' : 'n/a');
let encrypted = has.encrypted || protection === 'protected';

/* ── 调 distill-inspect（只对「有 motion.json 且不是三件套」的包） ── */
let inspect = { eligible: false, ran: false, ok: false, outDir: null, report: null, error: null };
const inspectEligible = has.motionJson && !has.threePiece;
if (inspectEligible && !NO_INSPECT) {
  inspect.eligible = true;
  const idGuess = ID_REQ || guessId(SOURCE, manifest);
  const outDir = path.join(OUT_DIR, sanitize(idGuess), 'distill');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    execFileSync('python3', ['tools/distill-inspect.py', '--package', SOURCE, '--out', outDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    inspect = {
      eligible: true,
      ran: true,
      ok: true,
      outDir,
      report: path.join(outDir, 'report.md'),
      error: null,
    };
  } catch (e) {
    inspect = {
      eligible: true,
      ran: true,
      ok: false,
      outDir,
      report: null,
      error: (e.stdout || '') + (e.stderr || '') || e.message,
    };
  }
}

// ZIP 的 manifest 只能从 distill-inspect 的报告里补；目录源已经在上面读到。
if (!manifest && inspect.ok && fs.existsSync(inspect.report)) {
  const text = fs.readFileSync(inspect.report, 'utf8');
  const mm = text.match(/runtime：`([^`]*)`\s*·\s*protection：`([^`]*)`/);
  const sm = text.match(/规范：`([^`]*)`\s*\/\s*specVersion `([^`]*)`/);
  manifest = {
    format: sm?.[1] || null,
    specVersion: sm?.[2] || null,
    runtime: mm?.[1] || null,
    protection: mm?.[2] || 'n/a',
    source: 'distill-report',
  };
  // 报告里才是权威的 protection：release.bin 可能是 open 的嵌套内容归档。
  protection = manifest.protection;
  encrypted = has.encrypted || protection === 'protected';
}

/* ── 分类与模式 ─────────────────────────────────────────────────── */

let kindGuess = 'unknown';
let reasons = [];
if (has.threePiece || (codeFiles >= 10 && (has.canvas || has.dom)) || (codeFiles >= 20)) {
  kindGuess = 'engine';
  reasons.push(has.threePiece ? '有 kit.js + layouts.js + stage.js 三件套' : `代码文件 ${codeFiles} 个，含渲染入口`);
} else if (docFiles >= 3 && codeFiles <= 5) {
  kindGuess = 'method';
  reasons.push(`文档/规则 ${docFiles} 个、代码 ${codeFiles} 个`);
} else if (mediaFiles >= codeFiles * 3 && codeFiles <= 5) {
  kindGuess = 'assets';
  reasons.push(`媒体 ${mediaFiles} 个、代码 ${codeFiles} 个`);
} else if (codeFiles && docFiles) {
  kindGuess = 'mixed';
  reasons.push(`代码 ${codeFiles} 个、文档 ${docFiles} 个`);
}

function autoMode() {
  if (has.threePiece) return ['rehost', '已是三件套，可直接做结构/冒烟；不需要重新蒸馏'];
  if (encrypted) return ['original', '源码加密（protected / release.bin / .enc），换宿主不成立；走 Chrome 或只借规则'];
  if (has.dom) return ['original', '引擎是 DOM/CSS，换宿主等于写半个浏览器；走 Chrome'];
  if (has.guide || has.schema) return ['semi', '内容模型（guide / schema）可读，适合半蒸馏'];
  if (codeFiles >= 1) return ['full', '没有可读内容模型，只能重写渲染层（全蒸馏）'];
  return ['original', '没有代码入口，按原版素材处理'];
}

const [modeAuto, modeWhy] = autoMode();
const mode = MODE_REQ === 'auto' ? modeAuto : MODE_REQ;
const depth = mode;

let confidence = 0.45;
if (has.motionJson) confidence += 0.15;
if (has.guide) confidence += 0.1;
if (has.schema) confidence += 0.1;
if (has.threePiece) confidence += 0.15;
if (packageJson) confidence += 0.05;
if (kindGuess === 'unknown') confidence -= 0.2;
confidence = Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2))));

let summary;
if (mode === 'rehost') summary = '结构已具备宿主条件；先做结构体检与单帧冒烟，再决定是否接 API。';
else if (mode === 'semi') summary = '内容模型可读；保留它的段型/字段契约，渲染层自己写。';
else if (mode === 'full') summary = '没有可直接借的渲染层或内容模型；按设计参考重写，成本最高。';
else summary = '不进入本仓渲染层；走 Chrome 原版链路，或只借规则。';

/* ── 阻塞项 ─────────────────────────────────────────────────────── */

const blockers = [];
const add = (code, severity, message, fix) => blockers.push({ code, severity, message, fix });

const unsafeZip = names.some((n) => n.startsWith('/') || n.split('/').includes('..'));
if (unsafeZip) add('ZIP_UNSAFE', 'block', 'ZIP 含绝对路径或 ../ 条目，解包会越界', '不要解包；先人工检查包来源');
if (has.personal) add('CREDENTIALS_PRESENT', 'block', '源内含 personal/ / 密钥 / token 类文件', '不得复制进仓库；只做静态阅读，必要时先脱敏');
if (mode === 'rehost' && encrypted) add('REHOST_PROTECTED', 'block', '源码加密，换宿主没有可用的渲染源码', '改走 original（Chrome）或 rules（只借规则）');
if (mode === 'rehost' && has.dom) add('REHOST_DOM_ENGINE', 'block', '引擎是 DOM/CSS，不是 Canvas2D', '走 Chrome；要做本仓版式只能全蒸馏');
if (mode === 'semi' && !has.guide && !has.schema) add('CONTENT_MODEL_MISSING', 'block', '找不到 guide.json / params.schema.json，半蒸馏没有内容模型可借', '改走 full（重写）或 original');
if (mode === 'semi' && encrypted && !has.guide) add('CONTENT_MODEL_PROTECTED', 'block', '内容模型在加密载体里，且外层没有 guide', '只能 original 或 rules');
if (encrypted && !['rehost', 'semi'].includes(mode)) add('PROTECTED_SOURCE', 'warn', '源是 protected / release.bin / .enc', '可以走 Chrome 或只借规则；不要试图复制渲染代码');
if (isZip && has.releaseBin && !has.threePiece) {
  add('WRAPPER_PACKAGE', 'warn', '这是个人下载包：通常只含内容模型（release.bin），不含可换宿主的渲染源码', '目标若是换宿主，请改用已解包的源码目录；若只借内容模型，按 semi 处理');
}
// 许可/协议按用户 2026-11-15 指令不作为工具阻断项。
// 仍记录 license 到 evidence，便于追溯；是否合规由使用者自行判断。
if (scan.truncated) add('SOURCE_TRUNCATED', 'warn', `文件超过 6000 个，扫描已截断`, '先确认这不是素材包；必要时分目录评估');
if (scan.bytes > 200 * 1024 * 1024) add('SOURCE_LARGE', 'warn', `源体积 ${(scan.bytes / 1048576).toFixed(1)} MB`, '只读评估没问题；apply 前确认不需要整包入库');
if (inspect.eligible && inspect.ran && !inspect.ok) add('EXTRACT_FAILED', 'warn', 'distill-inspect 提取失败', `看 ${rel(inspect.outDir)} 的 stderr；不影响静态分类`);
if (scan.skipped.length) add('READ_SKIPPED', 'warn', `有 ${scan.skipped.length} 个目录/文件读不到`, '检查权限；不要用 sudo 跑本工具');

/* ── 计划输出 ───────────────────────────────────────────────────── */

function sanitize(s) {
  return String(s || 'template').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
}

const id = sanitize(ID_REQ || guessId(SOURCE, manifest));
const planDir = path.join(OUT_DIR, id);
fs.mkdirSync(planDir, { recursive: true });
const planPath = path.join(planDir, 'plan.json');
const planMdPath = path.join(planDir, 'plan.md');

const digest = isZip
  ? { algo: 'sha256', kind: 'file', value: hashFile(SOURCE) }
  : {
      algo: 'sha256',
      kind: 'tree',
      value: crypto.createHash('sha256')
        .update(scan.entries.map((e) => `${e.rel}:${e.size}`).sort().join('\n'))
        .digest('hex'),
      note: '按相对路径 + 体积，不读文件内容；用于幂等，不是内容指纹',
    };

const sourceInfo = {
  input: SOURCE_IN,
  resolved: rel(SOURCE),
  kind,
  bytes: scan.bytes,
  fileCount: scan.entries.length,
  truncated: scan.truncated,
  symlinks: scan.symlinks,
  digest,
};

const stages = [
  { id: 'received', status: 'done', detail: `${kind} · ${scan.entries.length} 个文件` },
  { id: 'unpacked', status: 'skipped', detail: isZip ? '只读列目录，不解包' : '目录输入，无需解包' },
  { id: 'classified', status: 'done', detail: `${kindGuess} / ${mode}` },
  { id: 'extracted', status: inspect.ok ? 'done' : (inspect.eligible ? 'failed' : 'skipped'), detail: inspect.ok ? rel(inspect.outDir) : (inspect.eligible ? 'distill-inspect 失败' : '无 motion.json 或已是三件套') },
  { id: 'scaffolded', status: 'pending', detail: 'Phase 2 才写文件（templates/own 或 api/kits 草稿）' },
  { id: 'smoke', status: 'pending', detail: 'Phase 2：template-smoke / check-docs' },
  { id: 'registered', status: 'pending', detail: 'Phase 2：api registry 自动发现 + inventory' },
  { id: 'visual_review', status: 'pending', detail: '人工：抽帧看画面，不能自动判' },
];

// 本地日期：toISOString 是 UTC，在东八区会把「今天」写成昨天。
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const blockCodes = blockers.filter((b) => b.severity === 'block').map((b) => b.code);
const nextActions = [];
if (blockCodes.length) {
  nextActions.push(`只读评估可以继续；进入 Phase 2 前必须处理：${blockCodes.join(' / ')}`);
}
if (mode === 'rehost' && isZip && has.releaseBin) {
  nextActions.push('先确认这是下载包还是源码目录：template.motion 通常只有内容模型，不能直接 rehost');
}
if (mode === 'rehost') {
  nextActions.push(`结构体检：python3 tools/check-template.py --src ${sourceInfo.resolved}`);
  nextActions.push(`单帧/四关冒烟：python3 tools/template-smoke.py --template ${sourceInfo.resolved}`);
  nextActions.push(`确认画面后接入：templates/own/${id} 或 api/kits/${id}.mjs，再跑 npm run inv && npm run check`);
} else if (mode === 'semi') {
  if (inspect.ok) nextActions.push(`先读 ${rel(inspect.outDir)}/report.md 与 guide.draft.json，确认保留哪些段型`);
  nextActions.push('确认内容模型后：python3 tools/new-template.py --id ' + id);
  nextActions.push('渲染层自己写（kit.js / layouts.js），不要 import 上游代码');
  nextActions.push(`登记：docs/distillations.json（kind / depth / status / artifacts），再 npm run distill:md`);
} else if (mode === 'full') {
  nextActions.push(`先写分析：docs/${id}-蒸馏-${today}.md（定性 / 可平移 / 不可平移 / 对抗审查）`);
  nextActions.push('再决定版式落点；没有内容模型时不要假装能半蒸馏');
  nextActions.push('渲染层从 templates/_scaffold 开始，自己写画面语言');
} else {
  nextActions.push('走 Chrome 原版链路，本仓不落渲染代码');
  nextActions.push('若以后要长期产线，确认 guide/schema 可读后重跑 --mode semi');
}
nextActions.push('人工确认分类后再进入 Phase 2；本工具不会自动提交');

const plan = {
  schema: 'cutduo-intake-plan/1',
  createdAt: new Date().toISOString(),
  tool: 'tools/intake.mjs',
  source: sourceInfo,
  id,
  mode: { requested: MODE_REQ, resolved: mode, reason: MODE_REQ === 'auto' ? modeWhy : '由 --mode 指定' },
  verdict: { kind: kindGuess, depth, confidence, summary, reasons },
  evidence: {
    has,
    manifest,
    packageJson,
    license,
    extensions: topExt,
    topFiles: scan.entries.slice(0, 24).map((e) => e.rel),
    skipped: scan.skipped.slice(0, 8),
  },
  inspect: inspect.eligible || inspect.ran ? { ran: inspect.ran, ok: inspect.ok, outDir: inspect.outDir ? rel(inspect.outDir) : null, report: inspect.report ? rel(inspect.report) : null, error: inspect.error ? String(inspect.error).slice(-1200) : null } : null,
  blockers,
  stages,
  nextActions,
  artifacts: {
    planJson: rel(planPath),
    planMd: rel(planMdPath),
    distillDir: inspect.outDir ? rel(inspect.outDir) : null,
  },
};

fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');

/* ── Markdown ───────────────────────────────────────────────────── */
const tick = (v) => (v ? '✓' : '—');
const blockRows = blockers.length
  ? blockers.map((b) => `| ${b.severity === 'block' ? '**BLOCK**' : b.severity} | \`${b.code}\` | ${b.message} | ${b.fix} |`).join('\n')
  : '| — | — | 无 | — |';
const md = [
  `# 模板接入评估 · ${id}`,
  '',
  '> **只读计划**：本工具没有执行模板代码、没有解包 ZIP、没有写 `kits/` / `api/` / `templates/` / `docs/`。',
  `> 生成时间：${plan.createdAt}`,
  '',
  '## 一、结论',
  '',
  '| 项 | 值 |',
  '|---|---|',
  `| 定性 | **${kindGuess}** |`,
  `| 建议深度 | **${depth}** |`,
  `| 置信度 | ${confidence} |`,
  `| 模式 | ${MODE_REQ === 'auto' ? `auto → ${mode}` : mode} |`,
  `| 一句话 | ${summary} |`,
  '',
  '**判断依据**：' + (reasons.length ? reasons.join('；') : '证据不足，按 unknown 处理') + '。',
  '',
  '## 二、来源',
  '',
  '| 项 | 值 |',
  '|---|---|',
  `| 输入 | \`${SOURCE_IN}\` |`,
  `| 解析 | \`${sourceInfo.resolved}\` |`,
  `| 形态 | ${kind} |`,
  `| 体积 / 文件数 | ${(scan.bytes / 1048576).toFixed(2)} MB / ${scan.entries.length}${scan.truncated ? '（已截断）' : ''} |`,
  `| 指纹 | ${digest.kind} · \`${digest.value.slice(0, 16)}…\` |`,
  `| 保护 | ${protection}${encrypted ? '（加密/受限）' : ''} |`,
  `| runtime | ${manifest?.runtime || '—'} |`,
  `| 输出 | ${manifest?.output ? `${manifest.output.width}×${manifest.output.height}@${manifest.output.fps}` : '—'} |`,
  '',
  '## 三、静态证据',
  '',
  '| 检查 | 结果 |',
  '|---|---|',
  `| motion.json | ${tick(has.motionJson)} |`,
  `| guide.json | ${tick(has.guide)} |`,
  `| params.schema.json | ${tick(has.schema)} |`,
  `| 三件套（kit/layouts/stage） | ${tick(has.threePiece)} |`,
  `| DOM 引擎迹象 | ${tick(has.dom)} |`,
  `| Canvas2D 迹象 | ${tick(has.canvas)} |`,
  `| release.bin / .enc | ${tick(has.releaseBin || has.encrypted)} |`,
  `| personal/ 或密钥 | ${tick(has.personal)} |`,
  '',
  '扩展名分布：' + topExt.map((e) => `\`${e.ext}\` ${e.count}`).join(' · '),
  '',
  '## 四、阻塞项',
  '',
  '| 级别 | code | 说明 | 修法 |',
  '|---|---|---|---|',
  blockRows,
  '',
  '## 五、阶段',
  '',
  '| 阶段 | 状态 | 说明 |',
  '|---|---|---|',
  ...stages.map((s) => `| ${s.id} | ${s.status} | ${s.detail} |`),
  '',
  '## 六、下一步',
  '',
  ...nextActions.map((a) => `- ${a}`),
  '',
  '## 七、附',
  '',
  inspect.ran
    ? `- 内容模型提取：\`${rel(inspect.outDir)}\`${inspect.ok ? '' : '（失败，见 error）'}`
    : '- 未运行 distill-inspect（没有 motion.json、已是三件套，或 --no-inspect）',
  `- 计划 JSON：\`${rel(planPath)}\``,
  '',
].join('\n');
fs.writeFileSync(planMdPath, md);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
} else {
  console.log(`intake plan → ${rel(planDir)}`);
  console.log(`  ${kindGuess} / ${mode} / 置信度 ${confidence} / ${blockers.filter((b) => b.severity === 'block').length} 个 blocking`);
  console.log(`  ${scan.entries.length} 个文件 · ${(scan.bytes / 1048576).toFixed(2)} MB · ${kind}`);
  if (blockers.length) {
    console.log('  阻塞/警告：');
    for (const b of blockers) console.log(`    [${b.severity}] ${b.code} — ${b.message}`);
  }
  console.log(`  next: ${nextActions[0] || '—'}`);
}

if (STRICT && blockers.some((b) => b.severity === 'block')) process.exit(1);
process.exit(0);
