#!/usr/bin/env node
/**
 * harness/patch.mjs — 应用 agent 的改动（带白名单与不变式）
 *
 *   node harness/patch.mjs --task harness/tasks/hip-v4.json --set 'segments[3].args.itemAt[0]=1.2'
 *   node harness/patch.mjs --task ... --file patch.json      # [{op:'set',path,value}]
 *   node harness/patch.mjs --task ... --set '...=1.2' --dry-run
 *
 * 为什么要白名单：harness 的整个价值是"可审计的自动迭代"。如果 agent 能改任何字段，
 * 它会把 `durationSeconds` 改成刚好落进区间、把 `captions` 删到不超时长——
 * 分数好看了，片子废了。所以**能改什么由任务定义**，不由 agent 心情决定。
 *
 * 写出去的文件是 `out/harness/<task>/next.json`，run.mjs 优先用它当下一轮输入并消费掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/root.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TASK_FILE = arg('task');
const FILE = arg('file');
const SETS = process.argv.reduce((acc, x, i, arr) => (x === '--set' ? [...acc, arr[i + 1]] : acc), []);
const DRY = process.argv.includes('--dry-run');
if (!TASK_FILE || (!FILE && !SETS.length)) {
  console.error("用法: node harness/patch.mjs --task <task.json> (--file patch.json | --set 'path=value') [--dry-run]");
  process.exit(2);
}

const task = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, TASK_FILE), 'utf8'));
const TASK_DIR = path.join(REPO_ROOT, 'out', 'harness', task.id);
const NEXT = path.join(TASK_DIR, 'next.json');

// 输入：优先用还没消费的 next.json，否则用最新一轮的 params.json，否则 base
const rounds = fs.existsSync(TASK_DIR) ? fs.readdirSync(TASK_DIR).filter((d) => /^round-\d+$/.test(d)).sort() : [];
const latest = rounds.length ? path.join(TASK_DIR, rounds[rounds.length - 1], 'params.json') : null;
const src = fs.existsSync(NEXT) ? NEXT : (latest && fs.existsSync(latest) ? latest : path.resolve(REPO_ROOT, task.base));
const params = JSON.parse(fs.readFileSync(src, 'utf8'));

const ops = FILE
  ? JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, FILE), 'utf8'))
  : SETS.map((s) => {
    const at = s.indexOf('=');
    if (at < 0) { console.error(`--set 需要 path=value 形式：${s}`); process.exit(2); }
    const p = s.slice(0, at);
    let v = s.slice(at + 1);
    try { v = JSON.parse(v); } catch { /* 当字符串 */ }
    return { op: 'set', path: p, value: v };
  });

/** `segments[3].args.itemAt[0]` → ['segments', 3, 'args', 'itemAt', 0] */
function tokens(p) {
  const out = [];
  const re = /\.?([A-Za-z_$][\w$]*)|\[(\d+)\]/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(p))) {
    if (m.index !== consumed) throw new Error(`路径写法不支持：${p}`);
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
    consumed = m.index + m[0].length;
  }
  if (consumed !== p.length) throw new Error(`路径写法不支持：${p}`);
  return out;
}

/** 白名单匹配：`segments[].args.*` 允许任意下标；`*` 允许任意末级键名。 */
function allowed(p) {
  const list = task.allow || [];
  const norm = p.replace(/\[\d+\]/g, '[]');
  return list.some((rule) => {
    if (rule === norm) return true;
    const rr = rule.replace(/\.\*$/, '');
    if (rule.endsWith('.*') && (norm === rr || norm.startsWith(rr + '.'))) return true;
    return false;
  });
}

function setAt(obj, tk, value) {
  let cur = obj;
  for (let i = 0; i < tk.length - 1; i++) {
    const k = tk[i];
    if (cur[k] === undefined || cur[k] === null) {
      if (typeof tk[i + 1] === 'number') throw new Error(`路径不存在：${tk.join('.')}（数组越界）`);
      throw new Error(`路径不存在：${tk.join('.')}`);
    }
    cur = cur[k];
  }
  const last = tk[tk.length - 1];
  if (Array.isArray(cur) && typeof last === 'number' && (last < 0 || last >= cur.length)) {
    throw new Error(`数组下标越界：${tk.join('.')}（长度 ${cur.length}）`);
  }
  if (!Array.isArray(cur) && !(last in cur) && !(task.allow || []).some((r) => r.endsWith('.*'))) {
    throw new Error(`字段不存在：${tk.join('.')}（新增字段需要在 task.allow 里显式放开 .*）`);
  }
  cur[last] = value;
}

const before = JSON.parse(JSON.stringify(params));
const applied = [];
for (const op of ops) {
  if (op.op !== 'set') { console.error(`只支持 set，收到 ${op.op}`); process.exit(2); }
  if (!allowed(op.path)) {
    console.error(`✗ 白名单拒绝：${op.path}\n  允许的前缀：\n    ${(task.allow || ['（未配置 allow，任何改动都会被拒）']).join('\n    ')}`);
    process.exit(2);
  }
  try { setAt(params, tokens(op.path), op.value); }
  catch (e) { console.error(`✗ ${op.path}：${e.message}`); process.exit(2); }
  applied.push(op);
}

// 不变式：段长和必须等于 durationSeconds（这条改了就等于绕过门禁）
const sum = (params.segments || []).reduce((a, s) => a + Number(s.dur || 0), 0);
if (params.durationSeconds !== undefined && Math.abs(sum - params.durationSeconds) > 0.05) {
  params.durationSeconds = +sum.toFixed(3); // 自动同步，并记录
  applied.push({ op: 'set', path: 'durationSeconds', value: params.durationSeconds, auto: true });
}

const diff = applied.filter((a) => JSON.stringify(before) !== JSON.stringify(params));

if (DRY) {
  console.log(`（dry-run）将应用 ${applied.length} 处改动：`);
  for (const a of applied) console.log(`  ${a.path} = ${JSON.stringify(a.value)}${a.auto ? '  [自动同步]' : ''}`);
  process.exit(0);
}

fs.mkdirSync(TASK_DIR, { recursive: true });
fs.writeFileSync(NEXT, JSON.stringify(params, null, 2));
fs.writeFileSync(path.join(TASK_DIR, 'next.diff.json'), JSON.stringify({ from: path.relative(REPO_ROOT, src), applied }, null, 2));
console.log(`✓ 已写 ${path.relative(REPO_ROOT, NEXT)}（${applied.length} 处改动，来源 ${path.relative(REPO_ROOT, src)}）`);
for (const a of applied) console.log(`  ${a.path} = ${JSON.stringify(a.value)}${a.auto ? '  [自动同步]' : ''}`);
