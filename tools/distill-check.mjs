#!/usr/bin/env node
/**
 * distill-check.mjs · 蒸馏登记表的校验与索引生成
 *
 *   node tools/distill-check.mjs            # 写 docs/蒸馏-索引.md
 *   node tools/distill-check.mjs --check    # 只校验（smoke / CI 用）
 *   node tools/distill-check.mjs --md       # 打到 stdout
 *
 * 为什么需要：吸收外部技能时最容易发生的不是「做错」，而是**做完没登记**——
 * 三个月后没人知道某个工具/段型是从哪来的、为什么留、能不能删。约定是：
 * 一次吸收 = 一份分析文档 + 至少一个可运行产物 + 一条登记。
 *
 * 本检查只验**结构**（文件存在、字段合法、状态与产物不矛盾），不评价结论对不对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/root.mjs';

const INDEX = path.join(REPO_ROOT, 'docs', 'distillations.json');
const MD = path.join(REPO_ROOT, 'docs', '蒸馏-索引.md');
const CHECK = process.argv.includes('--check');
const PRINT_MD = process.argv.includes('--md');

const KINDS = { engine: '引擎', method: '方法包', assets: '素材包', mixed: '混合' };
const DEPTHS = { original: '原版', rehost: '换宿主', semi: '半蒸馏', full: '全蒸馏', rules: '只借规则' };
const STATUS = { landed: '已落地', partial: '部分落地', assessed: '已评估', rejected: '不采纳' };

const errors = [];

if (!fs.existsSync(INDEX)) {
  console.error('FAIL  docs/distillations.json 不存在');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
} catch (e) {
  console.error(`FAIL  docs/distillations.json 不是合法 JSON：${e.message}`);
  process.exit(1);
}

const entries = Array.isArray(data.entries) ? data.entries : [];
if (!entries.length) errors.push('entries 为空');

const seen = new Set();
for (const e of entries) {
  const tag = e.id || '(缺 id)';
  for (const k of ['id', 'date', 'upstream', 'kind', 'status', 'doc']) {
    if (!e[k]) errors.push(`${tag}: 缺字段 ${k}`);
  }
  if (e.id && seen.has(e.id)) errors.push(`${tag}: id 重复`);
  if (e.id) seen.add(e.id);
  if (e.date && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errors.push(`${tag}: date 必须是 YYYY-MM-DD`);
  if (e.kind && !KINDS[e.kind]) errors.push(`${tag}: kind 非法（${Object.keys(KINDS).join(' / ')}）`);
  if (e.status && !STATUS[e.status]) errors.push(`${tag}: status 非法（${Object.keys(STATUS).join(' / ')}）`);
  if (e.depth && !DEPTHS[e.depth]) errors.push(`${tag}: depth 非法（${Object.keys(DEPTHS).join(' / ')}）`);

  if (e.doc && !fs.existsSync(path.join(REPO_ROOT, e.doc))) {
    errors.push(`${tag}: doc 不存在 → ${e.doc}`);
  }
  const arts = Array.isArray(e.artifacts) ? e.artifacts : [];
  for (const a of arts) {
    if (!fs.existsSync(path.join(REPO_ROOT, a))) errors.push(`${tag}: artifact 不存在 → ${a}`);
  }
  // 已落地 / 部分落地必须有产物，且至少一个可执行/可渲染的代码产物。
  if ((e.status === 'landed' || e.status === 'partial')) {
    if (!arts.length) errors.push(`${tag}: status=${e.status} 但 artifacts 为空`);
    else {
      // 先判存在再 stat：缺失的目录会在 statSync 抛异常，把「报告一条错误」变成「整个检查崩掉」。
      const runnable = arts.some((a) => {
        if (/\.(mjs|js|py|sh)$/.test(a)) return true;
        const abs = path.join(REPO_ROOT, a);
        return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
      });
      if (!runnable) errors.push(`${tag}: status=${e.status} 但 artifacts 里没有可运行/可渲染的产物`);
    }
  }
}

function markdown() {
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, entries.filter((e) => e.status === k).length]));
  const rows = entries
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)))
    .map((e) => {
      const art = (e.artifacts || []);
      const artText = art.length
        ? (art.length === 1 ? `\`${path.basename(art[0])}\`` : `\`${path.basename(art[0])}\` +${art.length - 1}`)
        : '—';
      return `| \`${e.id}\` | ${e.date} | ${e.upstream} | ${KINDS[e.kind] || e.kind} | ${DEPTHS[e.depth] || e.depth || '—'} | ${STATUS[e.status] || e.status} | ${artText} | \`${e.doc}\` |`;
    });
  return [
    '# 蒸馏索引（自动生成）',
    '',
    '> 由 `tools/distill-check.mjs` 从 [`distillations.json`](distillations.json) 生成，**不要手改**。',
    '> 方法论见 [`蒸馏-方法论.md`](蒸馏-方法论.md)。登记/修改后跑 `npm run distill:md`。',
    '',
    `共 **${entries.length}** 条：已落地 ${counts.landed} / 部分落地 ${counts.partial} / 已评估 ${counts.assessed} / 不采纳 ${counts.rejected}。`,
    '',
    '| id | 日期 | 上游 | 定性 | 深度 | 状态 | 落地产物 | 文档 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '**怎么读**：`定性` 是上游属于引擎、方法包还是素材包——决定能借什么；`深度` 是停在哪一级；',
    '`落地产物` 为空只允许出现在「已评估 / 不采纳」两种状态。',
    '',
  ].join('\n');
}

if (errors.length) {
  for (const e of errors) console.error('FAIL  ' + e);
  console.error(`\n${errors.length} 项不合法 —— 索引不可信，先修登记`);
  process.exit(1);
}

const next = markdown();
if (PRINT_MD) {
  console.log(next);
  process.exit(0);
}
const prev = fs.existsSync(MD) ? fs.readFileSync(MD, 'utf8') : '';

if (CHECK) {
  if (prev === next) {
    console.log(`PASS  蒸馏索引与登记一致（${entries.length} 条）`);
    process.exit(0);
  }
  console.error('FAIL  docs/蒸馏-索引.md 已过期');
  console.error('  修法：node tools/distill-check.mjs');
  process.exit(1);
}

fs.writeFileSync(MD, next);
console.log(`蒸馏索引 → docs/蒸馏-索引.md · ${entries.length} 条`);
