#!/usr/bin/env node
/**
 * intake-copy.mjs · 把 vendor 包里的「源码/内容模型」抽取到一个参考目录
 *
 *   node tools/intake-copy.mjs --plan out/intake/mac-desktop/plan.json --out /tmp/mac-src
 *   node tools/intake-copy.mjs --plan out/intake/mac-desktop/plan.json --yes
 *
 * 按用户 2026-11-15 指令：**许可/协议不作为工具阻断项**，也不删除源里的 LICENSE / NOTICE。
 * 但仍排除 personal/、*.key、credentials、token 这类凭据——这不是许可问题，是泄露问题。
 *
 * 重要边界：抽取出来的是**参考源码/内容模型**，不是三件套模板。
 * 它不能直接 `render.mjs --kit` 出片；要接入仍需人写 adapter / 画面语言。
 *
 * 默认 dry-run；--yes 才写。拒绝覆盖已存在的目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：
  node tools/intake-copy.mjs --plan out/intake/<id>/plan.json [--out <目录>] [--yes] [--json]

默认 --out refs/replicas/<id>/vendor-source；默认 dry-run，--yes 才写。
抽取 release.bin / engine / native/source / src，保留 LICENSE，排除 personal/ 与密钥。`);
  process.exit(0);
}
function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const PLAN = flag('plan');
const YES = argv.includes('--yes');
const JSON_OUT = argv.includes('--json');
if (!PLAN) {
  console.error('缺 --plan。先跑：node tools/intake.mjs plan --source <目录或 .motion>');
  process.exit(2);
}
const planPath = path.isAbsolute(PLAN) ? PLAN : path.resolve(REPO_ROOT, PLAN);
if (!fs.existsSync(planPath)) {
  console.error(`计划不存在：${planPath}`);
  process.exit(2);
}
let plan;
try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); }
catch (e) { console.error(`计划不是合法 JSON：${e.message}`); process.exit(2); }
const id = String(plan.id || '').replace(/[^A-Za-z0-9._-]+/g, '-');
if (!id) { console.error('计划没有 id'); process.exit(2); }
const source = path.resolve(REPO_ROOT, plan.source?.resolved || '');
if (!fs.existsSync(source)) { console.error(`源不存在（计划可能过期）：${source}`); process.exit(2); }
const OUT = path.resolve(REPO_ROOT, flag('out', `refs/replicas/${id}/vendor-source`));
const srcAbs = path.resolve(source);
if (OUT === srcAbs || OUT.startsWith(srcAbs + path.sep)) {
  console.error(`拒绝把抽取物写进源目录内部：${rel(OUT)}（会递归复制）`);
  process.exit(2);
}
if (fs.existsSync(OUT)) {
  console.error(`拒绝覆盖已存在的目录：${path.relative(REPO_ROOT, OUT)}`);
  process.exit(2);
}

const rel = (p) => path.relative(REPO_ROOT, p).replaceAll(path.sep, '/') || '.';
const namesOf = (zip) => execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .split('\n').map((s) => s.trim()).filter(Boolean);
const unsafe = (names) => names.some((n) => n.startsWith('/') || n.split('/').includes('..'));

// 凭据不是许可问题；无论用户怎么说都不复制。
const CRED = /(^|\/)(personal|credentials?)(\/|$)|(^|\/)(\.key|[^/]*\.key|[^/]*token[^/]*)$/i;

function copyTree(src, dst, skipped) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name);
    const t = path.join(dst, d.name);
    const r = path.relative(src, s);
    if (CRED.test(r) || d.name === 'node_modules' || d.name === '.git' || d.name === '__pycache__') {
      skipped.push(path.relative(REPO_ROOT, s));
      continue;
    }
    if (d.isSymbolicLink()) { skipped.push(path.relative(REPO_ROOT, s)); continue; }
    if (d.isDirectory()) copyTree(s, t, skipped);
    else if (d.isFile()) { fs.copyFileSync(s, t); }
  }
}

function extractZip(zip, dst, skipped) {
  const names = namesOf(zip);
  if (unsafe(names)) throw new Error(`ZIP 含越界路径，拒绝抽取：${rel(zip)}`);
  fs.mkdirSync(dst, { recursive: true });
  // unzip 的 -x 模式过滤 personal/ 与密钥；不依赖 Node 解压库。
  execFileSync('unzip', ['-qq', '-o', zip, '-d', dst,
    '-x', 'personal/*', '*/personal/*', '*.key', '*/credentials/*', '*/receipt.json', '*/signature.json',
  ], { maxBuffer: 64 * 1024 * 1024 });
  for (const n of names) if (CRED.test(n)) skipped.push(n);
}

function findExtractRoot(src) {
  const candidates = [
    path.join(src, 'package', 'content', 'engine'),
    path.join(src, 'package', 'content', 'native', 'source', 'engine'),
    path.join(src, 'package', 'content', 'native'),
    path.join(src, 'engine'),
    path.join(src, 'src'),
  ];
  return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isDirectory()) || null;
}

const actions = [];
const skipped = [];
let filesBefore = 0;

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (e.isFile()) n++;
    }
  }
  return n;
}

try {
  if (fs.statSync(source).isFile()) {
    // .motion：外层解出 content/release.bin，再解内层
    const names = namesOf(source);
    if (unsafe(names)) throw new Error('外层 ZIP 含越界路径');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-copy-'));
    // unzip -d 会保留条目路径，因此实际落在 tmp/content/release.bin
    const release = path.join(tmp, 'content', 'release.bin');
    try {
      execFileSync('unzip', ['-qq', '-o', source, 'content/release.bin', '-d', tmp], { maxBuffer: 64 * 1024 * 1024 });
      if (!fs.existsSync(release)) throw new Error('包内没有 content/release.bin；可能不是 1.0-rc 下载包');
      actions.push({ type: 'extract', from: rel(source), entry: 'content/release.bin', to: rel(OUT) });
      if (YES) extractZip(release, OUT, skipped);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    const release = path.join(source, 'package', 'content', 'release.bin');
    if (fs.existsSync(release) && fs.statSync(release).isFile()) {
      actions.push({ type: 'extract', from: rel(release), to: rel(OUT) });
      if (YES) extractZip(release, OUT, skipped);
    } else {
      const root = findExtractRoot(source);
      if (!root) {
        throw new Error('没找到可抽取的 engine/ native/source/ src；这个包可能只有内容清单，没有源码');
      }
      const dst = path.join(OUT, path.basename(root));
      actions.push({ type: 'copy', from: rel(root), to: rel(dst) });
      if (YES) copyTree(root, dst, skipped);
    }
  }

  if (YES) {
    filesBefore = fs.existsSync(OUT) ? countFiles(OUT) : 0;
    const sourceMd = `# vendor-source · ${id}

> 由 \`tools/intake-copy.mjs\` 从 \`${rel(source)}\` 抽取。
> **这是参考源码 / 内容模型，不是三件套模板，不能直接 render.mjs --kit 出片。**
> 许可/协议按用户 2026-11-15 指令不作为阻断项；源里的 LICENSE / NOTICE 未删除。
> personal/ 与密钥已排除（凭据问题，不是许可问题）。

- 抽取时间：${new Date().toISOString()}
- 文件数：${filesBefore}
- 排除：${skipped.length ? skipped.slice(0, 20).join(', ') + (skipped.length > 20 ? ` … +${skipped.length - 20}` : '') : '无'}
`;
    fs.writeFileSync(path.join(OUT, 'SOURCE.md'), sourceMd);
  }

  const out = {
    schema: 'cutduo-intake-copy/1',
    plan: rel(planPath),
    id,
    source: rel(source),
    out: rel(OUT),
    yes: YES,
    dryRun: !YES,
    actions,
    skipped: skipped.slice(0, 50),
    note: '抽取物是参考源码/内容模型，不是可直出的三件套；接入仍需 adapter 与画面语言。',
  };
  if (JSON_OUT) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else {
    console.log(`intake copy → ${rel(OUT)} ${YES ? '' : '(dry-run)'}`);
    for (const a of actions) console.log(`  ${a.type}: ${a.from} → ${a.to}`);
    if (skipped.length) console.log(`  skipped ${skipped.length} 个凭据/依赖项`);
    if (!YES) console.log('  --yes 才写文件');
  }
} catch (e) {
  console.error(`抽取失败：${e.message}`);
  process.exit(2);
}
