#!/usr/bin/env node
/**
 * intake-apply.mjs · Phase 2：把 intake 计划落成可验证的机械动作
 *
 *   node tools/intake-apply.mjs --plan out/intake/foo/plan.json          # dry-run
 *   node tools/intake-apply.mjs --plan out/intake/foo/plan.json --yes    # 真正写
 *   node tools/intake-apply.mjs --plan out/intake/foo/plan.json --yes --full
 *
 * 只做两类写入，且都不复制上游源码：
 *   rehost  → 生成 api/kits/<id>.mjs（把已在 templates/own/<id> 或 kits/<id> 的模板接进 API）
 *   semi/full → 调 tools/new-template.py 生成 templates/own/<id> 骨架（画面语言仍要人写）
 *
 * 明确不做：
 *   · 不把 refs/vendor 直接当模板复制（来源形态 / 凭据 / 三件套兼容性需要人先决定）；
 *   · 不自动写 docs/distillations.json（蒸馏结论要人确认后登记）；
 *   · 不自动 commit / push；
 *   · 不覆盖已存在的 target（要重做请先人工删旧文件）。
 *
 * 退出码：0 完成或 dry-run；1 检查失败；2 计划/前置条件不成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：
  node tools/intake-apply.mjs --plan out/intake/<id>/plan.json [--yes] [--full] [--json]
                              [--templates-dir templates/own] [--api-dir api/kits]

默认 dry-run；--yes 才写。rehost 只生成 adapter；semi/full 只生成骨架。`);
  process.exit(0);
}
function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const PLAN_ARG = flag('plan');
const YES = argv.includes('--yes');
const FULL = argv.includes('--full');
const JSON_OUT = argv.includes('--json');
const TEMPLATES_DIR = path.resolve(REPO_ROOT, flag('templates-dir', 'templates/own'));
const API_DIR = path.resolve(REPO_ROOT, flag('api-dir', 'api/kits'));

if (!PLAN_ARG) {
  console.error('缺 --plan。先跑：node tools/intake.mjs plan --source <目录或 .motion>');
  process.exit(2);
}
const planPath = path.isAbsolute(PLAN_ARG) ? PLAN_ARG : path.resolve(REPO_ROOT, PLAN_ARG);
if (!fs.existsSync(planPath)) {
  console.error(`计划不存在：${planPath}\n  先跑：node tools/intake.mjs plan --source <目录或 .motion>`);
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
} catch (e) {
  console.error(`计划不是合法 JSON：${e.message}`);
  process.exit(2);
}
if (plan.schema !== 'cutduo-intake-plan/1') {
  console.error(`计划 schema 不认识：${plan.schema}`);
  process.exit(2);
}

const id = String(plan.id || '').replace(/[^A-Za-z0-9._-]+/g, '-');
if (!id) {
  console.error('计划里没有可用的 id');
  process.exit(2);
}
const mode = plan.mode?.resolved;
if (!['original', 'rehost', 'semi', 'full'].includes(mode)) {
  console.error(`计划 mode 不认识：${mode}`);
  process.exit(2);
}

const source = path.resolve(REPO_ROOT, plan.source?.resolved || '');
if (!fs.existsSync(source)) {
  console.error(`源不存在（计划可能过期）：${source}\n  重跑 plan`);
  process.exit(2);
}
const sourceStat = fs.statSync(source);
if (sourceStat.isFile() && plan.source?.bytes && sourceStat.size !== plan.source.bytes) {
  console.error(`源体积已变（计划 ${plan.source.bytes} → 现在 ${sourceStat.size}），先重跑 plan`);
  process.exit(2);
}

const codes = new Set((plan.blockers || []).map((b) => b.code));
const hardAlways = ['ZIP_UNSAFE'];
const hardForRehost = ['REHOST_PROTECTED', 'REHOST_DOM_ENGINE', 'CONTENT_MODEL_MISSING', 'CREDENTIALS_PRESENT'];
const hardForSemi = ['CONTENT_MODEL_MISSING', 'CONTENT_MODEL_PROTECTED'];
const hard = [
  ...hardAlways,
  ...(mode === 'rehost' ? hardForRehost : []),
  ...(mode === 'semi' ? hardForSemi : []),
];
const refused = hard.filter((c) => codes.has(c));
if (refused.length) {
  console.error(`拒绝 apply：计划里有 blocking —— ${refused.join(' / ')}`);
  console.error('  rehost 需要干净的源码；semi/full 的骨架不复制源文件，但 CREDENTIALS_PRESENT 仍会拦 rehost。');
  process.exit(2);
}

const rel = (p) => path.relative(REPO_ROOT, p).replaceAll(path.sep, '/') || '.';
const actions = [];
const checks = [];
const created = [];

function run(name, cmd, args, timeoutMs = 300000) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const ok = r.status === 0;
  checks.push({ name, ok, status: r.status, output: out.slice(-1600) });
  return { ok, out, status: r.status };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/* ── 1. rehost：生成 API adapter（不复制源码） ─────────────────── */
function applyRehost() {
  const srcRel = rel(source);
  const underTemplates = srcRel === `templates/own/${id}` || srcRel.startsWith(`templates/own/${id}/`);
  const underKits = srcRel === `kits/${id}` || srcRel.startsWith(`kits/${id}/`);
  if (!underTemplates && !underKits) {
    console.error(`拒绝 rehost：源不在 templates/own/${id} 或 kits/${id}（当前 ${srcRel}）`);
    console.error('  本工具不把 vendor 包当模板复制；需要参考源码用 intake-copy，或先整理成模板。');
    process.exit(2);
  }
  const target = path.join(API_DIR, `${id}.mjs`);
  if (fs.existsSync(target)) {
    console.error(`拒绝覆盖已存在的 adapter：${rel(target)}`);
    process.exit(2);
  }

  const motion = readJson(path.join(source, 'motion.json')) || {};
  const schemaRel = underTemplates ? `templates/own/${id}/params.schema.json` : `kits/${id}/params.schema.json`;
  const schemaAbs = path.join(REPO_ROOT, schemaRel);
  const presetsDir = path.join(source, 'presets');
  const presetFiles = fs.existsSync(presetsDir)
    ? fs.readdirSync(presetsDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  const presets = presetFiles.map((f) => ({
    id: path.basename(f, '.json'),
    path: rel(path.join(presetsDir, f)),
    note: '由 intake apply 登记；内容归模板自身',
  }));
  const defaultPreset = presets.find((p) => p.id === 'default') || presets[0] || null;
  const w = Number(motion.output?.width || 1920);
  const h = Number(motion.output?.height || 1080);
  const fps = Number(motion.output?.fps?.num || motion.output?.fps || 30);
  const name = String(motion.template?.name || id);
  const schemaStatus = fs.existsSync(schemaAbs) ? 'complete' : 'missing';
  const code = `import { cliAdapter } from './_runner.mjs';

// 由 tools/intake-apply.mjs 生成；源：${srcRel}
export const capability = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(`由 intake 接入：${srcRel}。视觉与内容模型归模板自身；adapter 只负责把入口/参数暴露给 API。`)},
  contentModel: {
    name: '模板自定义（见 params.schema.json）',
    required: true,
    note: ${JSON.stringify(`字段契约以 ${schemaRel} 与模板 guide.json 为准；intake 不推断内容语义。`)},
  },
  output: { width: ${w}, height: ${h}, fpsChoices: [24, 30, 60], fpsDefault: ${fps} },
  paramsSchema: ${JSON.stringify(schemaStatus === 'complete' ? schemaRel : null)},
  schemaStatus: ${JSON.stringify(schemaStatus)},
  presets: ${JSON.stringify(presets, null, 2)},
  defaultPreset: ${JSON.stringify(defaultPreset ? defaultPreset.path : null)},
  audio: { required: false, note: '口播片请给 audio；纯画面可省略' },
  extras: { source: 'intake', intakePlan: ${JSON.stringify(rel(planPath))} },
  entry: { type: 'cli', script: 'render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: ${JSON.stringify(id)},
});
`;
  actions.push({ type: 'write', path: rel(target), status: YES ? 'writing' : 'planned' });
  if (!YES) return { target: null };

  fs.mkdirSync(API_DIR, { recursive: true });
  fs.writeFileSync(target, code);
  created.push(target);

  const syntax = run('node --check', process.execPath, ['--check', target]);
  if (!syntax.ok) return { target, failed: true };

  for (const [name, cmd, args] of [
    ['gen-capabilities', process.execPath, ['tools/gen-capabilities.mjs']],
    ['inventory', process.execPath, ['tools/inventory.mjs']],
    ['check-docs', process.execPath, ['tools/check-docs.mjs']],
    ['api.probe', process.execPath, ['api/cli.mjs', 'probe', '--kit', id, '--out', `out/intake/${id}/probe.mp4`, '--at', '2', '--json']],
  ]) {
    const r = run(name, cmd, args, name === 'api.probe' ? 180000 : 120000);
    if (!r.ok) return { target, failed: true };
  }
  return { target, failed: false };
}

/* ── 2. semi/full：生成骨架（不复制源码） ─────────────────────── */
function applyScaffold() {
  const target = path.join(TEMPLATES_DIR, id);
  if (fs.existsSync(target)) {
    console.error(`拒绝覆盖已存在的模板目录：${rel(target)}`);
    process.exit(2);
  }
  const title = String(plan.evidence?.manifest?.templateName || id);
  const summary = String(plan.verdict?.summary || '由 intake 生成的骨架').slice(0, 200);
  const args = [
    'tools/new-template.py', '--id', id, '--title', title,
    '--summary', summary, '--source', plan.source?.resolved || '', '--out-dir', rel(TEMPLATES_DIR),
  ];
  actions.push({ type: 'scaffold', path: rel(target), command: ['python3', ...args].join(' '), status: YES ? 'running' : 'planned' });
  if (!YES) return { target: null };

  const mk = run('new-template', 'python3', args, 180000);
  if (!mk.ok) return { target, failed: true };
  const chk = run('check-template', 'python3', ['tools/check-template.py', '--src', target], 120000);
  if (!chk.ok) return { target, failed: true };
  const smoke = run('template-smoke', 'python3', ['tools/template-smoke.py', '--template', target], 300000);
  if (!smoke.ok) return { target, failed: true };
  return { target, failed: false };
}

/* ── 3. 执行 ───────────────────────────────────────────────────── */
let result;
if (mode === 'original') {
  actions.push({ type: 'noop', reason: 'original 不落本仓渲染代码；走 Chrome 原版链路' });
  result = { target: null, failed: false };
} else if (mode === 'rehost') {
  result = applyRehost();
} else {
  result = applyScaffold();
}

if (FULL && YES && result?.target && !result.failed) {
  run('npm run check', 'npm', ['run', 'check'], 600000);
}

/* 失败时只撤掉本次新建的 adapter；骨架保留给人看/修 */
if (result?.failed && mode === 'rehost' && created.length) {
  for (const f of created) {
    try { fs.rmSync(f, { force: true }); } catch { /* 尽力恢复 */ }
  }
  run('restore-capabilities', process.execPath, ['tools/gen-capabilities.mjs'], 120000);
  run('restore-inventory', process.execPath, ['tools/inventory.mjs'], 120000);
}

const failed = result?.failed || checks.some((c) => c.name !== 'restore-capabilities' && c.name !== 'restore-inventory' && !c.ok);
const out = {
  schema: 'cutduo-intake-apply/1',
  createdAt: new Date().toISOString(),
  plan: rel(planPath),
  id,
  mode,
  yes: YES,
  dryRun: !YES,
  actions,
  checks,
  created: created.map(rel),
  ...(failed ? { error: '检查失败；rehost 的 adapter 已撤回（若本次新建）' } : {}),
  nextActions: mode === 'rehost'
    ? ['若 probe 通过：跑 npm run check；然后人工抽帧看画面', '在 docs/distillations.json 登记后再 npm run distill:md']
    : ['按模板 README 填 guide → schema → preset，再写 kit.js / layouts.js 的画面语言', `写完后跑 python3 tools/template-smoke.py --template ${rel(path.join(TEMPLATES_DIR, id))}`, '确认画面后再生成 api/kits/<id>.mjs 或走 intake rehost'],
};

const outJson = path.join(path.dirname(planPath), 'apply.json');
fs.writeFileSync(outJson, JSON.stringify(out, null, 2) + '\n');

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  console.log(`intake apply → ${rel(outJson)}`);
  console.log(`  ${mode} / ${YES ? 'WRITE' : 'dry-run'} / ${actions.length} 个动作`);
  for (const a of actions) console.log(`  - ${a.type}: ${a.path || a.reason || ''}${a.status ? ` [${a.status}]` : ''}`);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);
  if (failed) console.log('  失败：见 apply.json 的 checks；rehost adapter 已撤回');
  else console.log(`  next: ${out.nextActions[0]}`);
}

process.exit(failed ? 1 : 0);
