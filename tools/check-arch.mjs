#!/usr/bin/env node
/**
 * tools/check-arch.mjs · 架构不变量检查
 *
 * 为什么需要这一支：`docs:check` 15 项测的是「文档与清单一致」，它抓得到
 * 「新增 kit 没写进 README」，抓不到「新增 kit 时顺手又写了一套 ffmpeg 管道」。
 * 这一支补的正是后者——测架构，不测文档。
 *
 * 三条不变量（定义见 docs/仓库整理规划-2026-11-16.md §三）：
 *   I1 单实现   帧循环 / 编码 / 封装只在 src/ 一个模块
 *   I2 单门     非宿主文件不直接引用渲染入口（绕过 api/）
 *   I3 契约单向 capabilities 里登记的 entry.script 真实存在
 *
 *   node tools/check-arch.mjs           # 人读
 *   node tools/check-arch.mjs --json    # 机器读
 *   node tools/check-arch.mjs --strict  # 有问题时退出码 1（默认只报不拦）
 *   node tools/check-arch.mjs --self-test  # 负向自检：造违规文件，断言检查器能抓到
 *
 * 上线策略沿用 src/gate.mjs 的经验：新指标先只报不拦，确认误报率后再 --strict。
 * 拦不住自己的检查器等于没装，所以 --self-test 是它的一部分，不是可选装饰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/root.mjs';

const JSON_OUT = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');
const SELF_TEST = process.argv.includes('--self-test');

/* ── 扫描范围：仓库代码，排除产物 / 依赖 / 外来源码 / 性能探针 ───────── */
const SKIP_DIRS = new Set(['node_modules', 'out', 'refs', 'vendor', '.git', 'deliverables', 'packages', '.workbuddy']);
const CODE_EXT = /\.(mjs|js|ts|py|sh)$/;

/**
 * 豁免表：文件 → 理由。
 * 每条都必须写成「为什么这条引用是合法的」，不接受「先放行再补」。
 * bench 类豁免是设计上的：探针的目的是测底层性能，绕门是合理的，拦掉会让探针失真。
 */
// 当前无 I1 豁免。2026-11-16 P3 把 editorial 的 encodeRange 并入 src/pipeline.mjs 后清空。
// 这个对象保留着：豁免机制本身要用，清空不等于废除——但任何新增条目都必须写清「为什么这条是合法的」。
const ALLOW_I1 = {};

/**
 * 2026-11-16 审计：这张表原有 11 条，清空后实测只命中 5 条 —— **6 条是无效豁免**。
 * 成因：I2 判据收紧过两次（先剥注释、再要求真 spawn），收紧后没有回头清豁免表。
 * 无效豁免比漏豁免更危险：它让将来真发生的绕门落进一个"已批准"的洞里。
 * 所以下面加了 staleI2Allow()，把「豁免表里的条目必须真的会命中」也变成一条门禁。
 */
const ALLOW_I2 = {
  // 以下 5 条：确实出现 `spawn(...render.mjs...)`，但不是"绕门出片"
  'tools/intake-apply.mjs': '落机械动作时生成 adapter/骨架，spawn 的是脚手架而非出片',
  'tools/intake-copy.mjs': '抽取 vendor 源码，spawn 的是拷贝而非出片',
  'tools/new-film.mjs': '新建片时生成 make.sh，spawn 用于落地文件而非出片',
  'tools/verify-calibration.mjs': '标定校验：要拿真实入口跑一遍再比指标，属验证而非出片',
  'tools/template-smoke.py': '冒烟对象是任意模板目录（没有 kit id、未接入 API），只能走 render.mjs 的目录形态',
};

function walk(dir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (CODE_EXT.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

/* ── 编码点的识别（供 I1 观察项与自检使用） ─────────────────────── */
const SPAWNS = /\b(spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/;
const ENCODES = /libx264/;

/** 剥掉整行注释：注释里提到 libx264 不代表真的在编码（render.mjs 头部就写了）。 */
function stripComments(src) {
  return src.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#'));
  }).join('\n');
}

/* ── I1：出片入口必须复用 src/pipeline.mjs ───────────────────────── */

/**
 * 判据收窄的经过（值得留着，避免下次又走一遍）：
 * 第一版扫全仓的 `libx264` 字样，报出 19 个文件，其中大半是误报——
 * 注释里提到编码器（render.mjs / mg）、错误正则（api/errors.mjs）、
 * 流复制 `-c:v copy`（normalize.mjs / add-bgm.mjs）、装环境的 setup.sh。
 * 第二版要求「spawn + libx264 同时在场」，降到 8 个，但仍然把 reframe（后处理转码）
 * 和 desk 的探针工具算了进去——它们**本来就该**自己调 ffmpeg。
 *
 * 真正的风险只有一种：**新的出片入口自己写了一套帧循环 + 编码**。
 * 所以判据改为数据驱动——从 api/capabilities.json 取 entry.script，
 * 每个出片入口必须复用 src/ 的管道：直接 import `src/pipeline.mjs`，
 * 或经 `src/entry-kit.mjs`（它内部就是 pipeline）。新加 kit 自动纳入，不靠人工登记。
 */
const PIPELINE_IMPORT = /from\s+['"][^'"]*src\/(pipeline|entry-kit)\.mjs['"]/;

function outputEntries() {
  const file = path.join(REPO_ROOT, 'api', 'capabilities.json');
  if (!fs.existsSync(file)) return null;
  const caps = JSON.parse(fs.readFileSync(file, 'utf8'));
  return [...new Set((caps.kits || []).map((k) => k.entry && k.entry.script).filter(Boolean))];
}

/** 观察项：全仓还有多少处自己起 ffmpeg 编码。只报数字，不参与判定。 */
function encodeSites() {
  const sites = [];
  for (const f of walk(REPO_ROOT)) {
    const r = rel(f);
    if (r.startsWith('src/')) continue;
    if (r.startsWith('bench/') || r.includes('/tools/bench-')) continue;
    if (r.startsWith('kits/') && r.includes('/tools/')) continue; // kit 内部开发工具
    if (r.startsWith('tools/legacy/')) continue;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    if (SPAWNS.test(code) && ENCODES.test(code)) sites.push(r);
  }
  return sites;
}

/** 给定一组入口，返回其中没有复用管道的。抽成纯函数是为了让自检能喂假数据。 */
function entriesWithoutPipeline(entries) {
  const bare = [];
  for (const e of entries) {
    if (ALLOW_I1[e]) continue;
    const abs = path.join(REPO_ROOT, e);
    if (!fs.existsSync(abs)) { bare.push(`${e}（文件不存在）`); continue; }
    if (!PIPELINE_IMPORT.test(fs.readFileSync(abs, 'utf8'))) bare.push(e);
  }
  return bare;
}

function checkI1() {
  const entries = outputEntries();
  if (!entries) {
    return { id: 'I1', name: '单实现', pass: false, detail: 'api/capabilities.json 缺失（先跑 npm run api:cap）', hits: [] };
  }
  const bare = entriesWithoutPipeline(entries);
  const sites = encodeSites();
  return {
    id: 'I1', name: '单实现',
    pass: bare.length === 0,
    detail: bare.length
      ? `${bare.length} 个出片入口没复用 src/pipeline.mjs：${bare.join(', ')}`
      : `${entries.length} 个出片入口全部复用 src/pipeline.mjs`,
    hits: bare,
    observe: sites.length ? `另有 ${sites.length} 处工具自己调 ffmpeg 编码（后处理/探针，非出片入口）：${sites.join(', ')}` : null,
  };
}

/* ── I2：非宿主文件不得直连渲染入口 ──────────────────────────────── */
const ENTRY_REF = /render\.mjs|canvas-editorial\.mjs/;
const HOST_DIRS = ['tools', 'web', 'harness', 'mcp'];

function scanI2(allow) {
  const hits = [];
  for (const d of HOST_DIRS) {
    for (const f of walk(path.join(REPO_ROOT, d))) {
      const r = rel(f);
      // tools/legacy/ 是已停止维护的归档区：里面是 2026-11-13 重构后的断链脚本
      // （引用不存在的 packages/*.motion 与错位的 canvas-editorial.mjs）。
      // 保留它们只为追溯，不参与任何门禁，也不该被当成"活着的绕门路径"。
      if (r.startsWith('tools/legacy/')) continue;
      if (allow[r]) continue;
      // 剥注释再匹配：`tools/contact-sheet.mjs` 只在头注释里写了「同源做法见 render.mjs」，
      // 那是出处说明，不是调用。不剥注释会把它误报成绕门（2026-11-16 首次跑就撞上）。
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (!ENTRY_REF.test(code)) continue;
      // .mjs/.js 要求「真的起了进程」才算绕门：`knowledge/new.mjs` 只是在 console.log
      // 里提示用户去跑 render.mjs，那不是调用。shell/python 里 `node render.mjs` 本身就是调用。
      const isScript = /\.(sh|py)$/.test(r);
      if (isScript || SPAWNS.test(code)) hits.push(r);
    }
  }
  return hits;
}

/**
 * 元门禁：豁免表里的每一条都必须真的会命中。
 * 不命中的条目不是"暂时用不上"，而是"判据已经不需要它了却还留着"——那会掩盖将来的真违规。
 */
function staleI2Allow() {
  const real = new Set(scanI2({}));
  return Object.keys(ALLOW_I2).filter((k) => !real.has(k));
}

function checkI2() {
  const hits = scanI2(ALLOW_I2);
  const stale = staleI2Allow();
  const pass = hits.length === 0 && stale.length === 0;
  return {
    id: 'I2', name: '单门',
    pass,
    detail: hits.length
      ? `${hits.length} 个文件绕过 api/ 直连渲染入口：${hits.join(', ')}`
      : stale.length
        ? `豁免表有 ${stale.length} 条无效条目（实际不命中）：${stale.join(', ')}`
        : '所有宿主只经 api/ 调用，豁免表无冗余条目',
    hits: [...hits, ...stale],
    observe: stale.length ? `无效豁免会掩盖将来的真实违规，删掉它们：${stale.join(', ')}` : null,
  };
}

/* ── I3：capabilities 登记的入口必须真实存在 ─────────────────────── */
function checkI3() {
  const file = path.join(REPO_ROOT, 'api', 'capabilities.json');
  if (!fs.existsSync(file)) {
    return { id: 'I3', name: '契约单向', pass: false, detail: 'api/capabilities.json 缺失（先跑 npm run api:cap）', hits: [] };
  }
  const caps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = [];
  let n = 0;
  for (const k of caps.kits || []) {
    const s = k.entry && k.entry.script;
    if (!s) continue;
    n++;
    if (!fs.existsSync(path.join(REPO_ROOT, s))) missing.push(`${k.id} → ${s}`);
  }
  return {
    id: 'I3', name: '契约单向',
    pass: missing.length === 0,
    detail: missing.length
      ? `${missing.length} 支登记的入口不存在：${missing.join(', ')}`
      : `${n} 支 entry.script 全部存在`,
    hits: missing,
  };
}

/* ── 负向自检：检查器必须能抓到人造违规 ─────────────────────────── */
function selfTest() {
  // 自检样例不能用点开头：walk() 跳过 `.` 开头的文件（编辑器临时文件），
  // 用 `.arch-selftest.mjs` 会让样例永远扫不到，自检假 PASS。这是它第一次跑就抓到的自身缺陷。
  const tmp = path.join(REPO_ROOT, 'tools', 'arch-selftest-tmp.mjs');
  const lines = [];
  let ok = true;

  // 造一个「出片入口但不复用管道」的样例，喂给纯函数断言它会被报出来。
  fs.writeFileSync(tmp, `import { spawn } from 'node:child_process';\nspawn('ffmpeg', ['-c:v', 'libx264']);\n`);
  const bare = entriesWithoutPipeline(['tools/arch-selftest-tmp.mjs']);
  const caughtI1 = bare.includes('tools/arch-selftest-tmp.mjs');
  lines.push(`  ${caughtI1 ? 'PASS' : 'FAIL'}  I1 能抓到没复用 pipeline 的出片入口`);
  ok = ok && caughtI1;

  // 观察项也要能真的数出自己 spawn ffmpeg 的文件
  const caughtSites = encodeSites().includes('tools/arch-selftest-tmp.mjs');
  lines.push(`  ${caughtSites ? 'PASS' : 'FAIL'}  I1 观察项能数出自己起 ffmpeg 的文件`);
  ok = ok && caughtSites;

  // 同一个文件也应触发 I2（真的 spawn 了渲染入口）
  fs.writeFileSync(tmp, `import { spawn } from 'node:child_process';\nspawn('node', ['render.mjs', '--params', 'x.json']);\n`);
  const i2 = checkI2();
  const caughtI2 = i2.hits.includes('tools/arch-selftest-tmp.mjs');
  lines.push(`  ${caughtI2 ? 'PASS' : 'FAIL'}  I2 能抓到绕过 api/ 直连入口的文件`);
  ok = ok && caughtI2;

  // 反向确认：只在字符串里提到 render.mjs（例如错误提示），不算绕门
  fs.writeFileSync(tmp, `console.log('出片失败：render.mjs 返回非零');\n`);
  const fpI2 = checkI2().hits.includes('tools/arch-selftest-tmp.mjs');
  lines.push(`  ${!fpI2 ? 'PASS' : 'FAIL'}  I2 不会把提示字符串里的 render.mjs 误报成绕门`);
  ok = ok && !fpI2;

  // 元门禁：塞一条永不命中的豁免，必须被 staleI2Allow 抓出来
  ALLOW_I2['tools/__selftest_never__.mjs'] = '自检用：这个文件不存在，也不该被豁免';
  const stale = staleI2Allow();
  const caughtStale = stale.includes('tools/__selftest_never__.mjs');
  delete ALLOW_I2['tools/__selftest_never__.mjs'];
  lines.push(`  ${caughtStale ? 'PASS' : 'FAIL'}  I2 元门禁能识别无效豁免条目`);
  ok = ok && caughtStale;

  // 反向确认不会误报：只写注释提到 libx264，不该被数成编码点
  fs.writeFileSync(tmp, `// 这条管道最终喂给 libx264\nconst x = 1;\n`);
  const falsePositive = encodeSites().includes('tools/arch-selftest-tmp.mjs');
  lines.push(`  ${!falsePositive ? 'PASS' : 'FAIL'}  I1 不会把注释里的 libx264 误报成编码点`);
  ok = ok && !falsePositive;

  fs.rmSync(tmp, { force: true });

  // I3：登记的入口必须能被解析。这条不改文件，只验 json 结构与目录可读。
  const i3 = checkI3();
  lines.push(`  ${i3.hits.length === 0 ? 'PASS' : 'FAIL'}  I3 能解析 capabilities 的 entry.script（${i3.detail}）`);
  ok = ok && i3.hits.length === 0;

  console.log('check-arch 负向自检');
  for (const l of lines) console.log(l);
  console.log(ok ? '\n自检通过：三条不变量都能报错' : '\n自检失败：检查器抓不到人造违规，等于没装');
  return ok ? 0 : 1;
}

/* ── 主流程 ───────────────────────────────────────────────────────── */
if (SELF_TEST) process.exit(selfTest());

const results = [checkI1(), checkI2(), checkI3()];
const failed = results.filter((r) => !r.pass);

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: failed.length === 0,
    invariants: results.map(({ id, name, pass, detail, hits, observe }) => ({ id, name, pass, detail, hits, observe: observe || null })),
    allowed: { i1: Object.keys(ALLOW_I1), i2: Object.keys(ALLOW_I2) },
  }, null, 2));
} else {
  console.log('架构不变量检查');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id} ${r.name}  ${r.detail}`);
    if (r.observe) console.log(`        · ${r.observe}`);
  }
  const n1 = Object.keys(ALLOW_I1).length;
  const n2 = Object.keys(ALLOW_I2).length;
  console.log(`\n豁免：I1 ${n1} 条 / I2 ${n2} 条（每条理由见 tools/check-arch.mjs 头部）`);
  if (failed.length && !STRICT) {
    console.log('只报不拦：加 --strict 才以退出码 1 失败');
  }
}

process.exit(failed.length && STRICT ? 1 : 0);
