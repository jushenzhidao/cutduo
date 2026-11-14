#!/usr/bin/env node
/**
 * check-docs.mjs · 文档与代码的漂移检查（只报事实，不改文件）
 *
 *   node tools/check-docs.mjs
 *
 * 为什么需要：2026-11-15 实测同一件事有五套数字——README 7 支、kits/README 8 支、
 * API 清单 9 支、STYLES 11 支、真实可渲染 13 支。根因不是谁写错，而是**清单靠手抄**。
 * 现在版式事实由 docs/inventory.json 生成，本检查负责三件事：
 *
 *   1. inventory 是否过期（有新版式没重新生成）
 *   2. 关键文档是否漏了某一支（按 id 逐一查，不查数量措辞）
 *   3. 文档里的文件路径 / npm script 是否还存在（搬家后的高频断链）
 *
 * 它不判断文案好坏，也不校验历史文档——带日期的归档保留当时路径是特性。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';
import { list } from '../api/registry.mjs';

const CAPS = list();
const KIT_IDS = CAPS.map((c) => c.id).filter((id) => fs.existsSync(path.join(REPO_ROOT, 'kits', id)));
const failures = [];
const passes = [];

function pass(msg) { passes.push(msg); }
function fail(msg, detail = '') { failures.push({ msg, detail }); }

/* ── 1. inventory 新鲜度 ─────────────────────────────────────────── */
try {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'inventory.mjs'), '--check'], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  pass('inventory 与代码一致');
} catch (e) {
  fail('inventory 过期', (e.stdout || '') + (e.stderr || ''));
}

/* ── 2. kits/ 目录必须全部接进 API ───────────────────────────────── */
const kitDirs = fs.readdirSync(path.join(REPO_ROOT, 'kits'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
const missingApi = kitDirs.filter((id) => !CAPS.some((c) => c.id === id));
if (missingApi.length) fail(`kits/ 有目录没接 API：${missingApi.join(' / ')}`, '新增 api/kits/<id>.mjs（文件名必须等于 id）');
else pass(`kits/ 全部接入 API（${kitDirs.length} 支）`);

// 反方向：API 声明了某个 id，但磁盘上没有对应的 kit 或三件套模板。
// 自动发现只保证「文件被加载」，不保证「入口还在」——删目录/改名会留下孤儿能力。
const orphanApi = CAPS.filter((c) => {
  const asKit = fs.existsSync(path.join(REPO_ROOT, 'kits', c.id));
  const asTemplate = fs.existsSync(path.join(REPO_ROOT, 'templates', 'own', c.id));
  return !asKit && !asTemplate;
});
if (orphanApi.length) fail(`API 有孤儿能力（找不到 kits/ 或 templates/own/）：${orphanApi.map((c) => c.id).join(' / ')}`, '删掉 api/kits/<id>.mjs，或把目录补回来');

// 入口文件静态存在性：adapter 在 render 时才 assertEntry，能提前查就别等出片。
const badEntry = CAPS.filter((c) => c.entry?.script && !fs.existsSync(path.join(REPO_ROOT, c.entry.script)));
if (badEntry.length) fail(`API 入口不存在：${badEntry.map((c) => `${c.id}→${c.entry.script}`).join(' / ')}`);
else pass(`API 入口文件全部存在（${CAPS.length} 支）`);

/* ── 3. 关键文档必须提到每一支 kit ───────────────────────────────── */
const docsToCover = ['README.md', 'kits/README.md', 'kits/STYLES.md', 'docs/inventory.md'];
for (const rel of docsToCover) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) { fail(`${rel} 不存在`); continue; }
  const text = fs.readFileSync(abs, 'utf8');
  const missing = kitDirs.filter((id) => !text.includes('`' + id + '`'));
  if (missing.length) fail(`${rel} 漏了版式：${missing.join(' / ')}`, '该文件是版式入口，漏一支就会让 agent 选不到');
  else pass(`${rel} 覆盖全部 ${kitDirs.length} 支`);
}

/* ── 4. 数字声明（只查明确写「N 套版式 / 共 N 支」的地方） ───────── */
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function toNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (a ? CN[a] : 1) * 10 + (b ? CN[b] : 0);
  }
  return CN[s] ?? NaN;
}
const claims = [
  { file: 'README.md', re: /([一二三四五六七八九十\d]+)\s*套版式/g, expect: kitDirs.length, what: '套版式' },
  { file: 'kits/README.md', re: /([一二三四五六七八九十\d]+)\s*套版式/g, expect: kitDirs.length, what: '套版式' },
  { file: 'package.json', re: /([一二三四五六七八九十\d]+)\s*套版式/g, expect: kitDirs.length, what: '套版式' },
  { file: 'docs/AGENTS.md', re: /共([一二三四五六七八九十\d]+)支/g, expect: kitDirs.length, what: '共N支' },
];
for (const c of claims) {
  const abs = path.join(REPO_ROOT, c.file);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  for (const m of text.matchAll(c.re)) {
    const n = toNum(m[1]);
    // 「自己加一套版式」是动作描述，不是数量声明；只查 >=2 的声明。
    if (n >= 2 && n !== c.expect) fail(`${c.file} 数字漂移：${m[0]}（应为 ${c.expect}）`, `真实版式数来自 kits/ 目录；修文案或改用 docs/inventory.md`);
  }
}

/* ── 5. 文档里的文件路径必须存在 ─────────────────────────────────── */
const pathDocs = ['README.md', 'AGENTS.md', 'docs/AGENTS.md', 'kits/README.md', 'kits/STYLES.md', 'docs/API.md'];
const KNOWN = /^(api|src|kits|templates|content|assets|tools|docs|deploy|mcp|web|harness|packages|deliverables|bench)\//;
const SKIP = /[*<>{}]|\.\.\.|^refs\//;
// 这两条是**上游模板内部**的路径（模板自己的 src/），不是本仓文件。
// 文档在讲「怎么判断能不能换宿主」，不能因为本仓没有 src/dom.js 就判断链。
const UPSTREAM_PATHS = new Set(['src/dom.js', 'src/main.js', 'src/kit.js']);
for (const rel of pathDocs) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const bad = new Set();
  for (const span of spans) {
    if (!KNOWN.test(span) || SKIP.test(span) || UPSTREAM_PATHS.has(span)) continue;
    if (!/\.(mjs|js|py|sh|json|md|swift|yml|yaml|toml|txt)$/.test(span)) continue;
    const p = path.join(REPO_ROOT, span);
    if (!fs.existsSync(p)) bad.add(span);
  }
  if (bad.size) fail(`${rel} 有失效路径：${[...bad].join(' / ')}`, '2026-11-13 把脚本收进 tools/ 后，旧表仍写在根目录');
  else pass(`${rel} 路径全部可解析`);
}

/* ── 6. npm run 引用的脚本必须存在 ───────────────────────────────── */
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const scriptNames = new Set(Object.keys(pkg.scripts || {}));
for (const rel of ['README.md', 'AGENTS.md', 'docs/AGENTS.md', 'kits/STYLES.md', 'docs/API.md']) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const refs = new Set([...text.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  const bad = [...refs].filter((n) => !scriptNames.has(n));
  if (bad.length) fail(`${rel} 引用了不存在的 npm script：${bad.join(' / ')}`, '在 package.json scripts 里补上，或改文档');
}

/* ── 7. tools/README.md 必须列出每个工具 ─────────────────────────── */
const toolsReadme = path.join(REPO_ROOT, 'tools', 'README.md');
const toolsDir = path.join(REPO_ROOT, 'tools');
const toolFiles = [];
(function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '__pycache__' || d.name === 'bin' || d.name.startsWith('.')) continue;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) walk(abs);
    else if (/\.(mjs|js|py|sh)$/.test(d.name)) toolFiles.push(path.relative(toolsDir, abs));
  }
})(toolsDir);
if (!fs.existsSync(toolsReadme)) {
  fail('tools/README.md 不存在', '工具索引缺失；agent 只能靠 ls 猜');
} else {
  const text = fs.readFileSync(toolsReadme, 'utf8');
  const missing = toolFiles.filter((f) => !text.includes(path.basename(f)));
  if (missing.length) fail(`tools/README.md 漏了 ${missing.length} 个工具：${missing.slice(0, 8).join(' / ')}${missing.length > 8 ? ' …' : ''}`, '新脚本要登记，否则下一个人不知道它存在');
  else pass(`tools/README.md 覆盖 ${toolFiles.length} 个脚本`);
}

/* ── 8. 蒸馏索引（存在才查，避免新仓启动即失败） ─────────────────── */
if (fs.existsSync(path.join(REPO_ROOT, 'tools', 'distill-check.mjs'))) {
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'distill-check.mjs'), '--check'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    pass('蒸馏索引与产物一致');
  } catch (e) {
    fail('蒸馏索引过期', (e.stdout || '') + (e.stderr || ''));
  }
}

/* ── 汇总 ───────────────────────────────────────────────────────── */
console.log('文档漂移检查');
for (const p of passes) console.log('  PASS  ' + p);
for (const f of failures) {
  console.log('  FAIL  ' + f.msg);
  if (f.detail) console.log('        ' + f.detail.split('\n').filter(Boolean).slice(-4).join('\n        '));
}
if (failures.length) {
  console.log(`\n${failures.length} 项未通过 —— 文档已与代码走散`);
  process.exit(1);
}
console.log(`\n全部通过（${passes.length} 项）`);
