#!/usr/bin/env node
/**
 * gen-capabilities.mjs — 生成 / 校验 api/capabilities.json
 *
 * 为什么需要：这份清单是给 agent 读的"有哪些能力"。它由代码生成，但生成动作
 * 以前靠人记得跑，结果入库文件停在 5 支（缺 clay / collage / night-card），
 * 而 smoke 只验代码、不验文件 —— 漂移可以一直没人发现。
 *
 *   node tools/gen-capabilities.mjs          # 写回 api/capabilities.json
 *   node tools/gen-capabilities.mjs --check  # 只比较，不一致 exit 1（给 smoke / CI 用）
 *
 * 两条约定：
 *   · 去掉 repoRoot：绝对路径不进库，换机器必冲突；
 *   · 末尾补换行：diff 干净，编辑器不报 missing newline。
 */
import fs from 'node:fs';
import path from 'node:path';
import { capabilities } from '../api/index.mjs';
import { REPO_ROOT } from '../src/root.mjs';

const OUT = path.resolve(REPO_ROOT, 'api', 'capabilities.json');
const CHECK = process.argv.includes('--check');

function render() {
  const data = capabilities();
  delete data.repoRoot;
  return JSON.stringify(data, null, 2) + '\n';
}

const next = render();
const exists = fs.existsSync(OUT);
const prev = exists ? fs.readFileSync(OUT, 'utf8') : '';

if (CHECK) {
  if (prev === next) {
    console.log('PASS  capabilities.json 与代码一致');
    process.exit(0);
  }
  // 给可执行的诊断：差在哪几条 kit，而不是甩一个 diff
  let hint = '';
  try {
    const a = JSON.parse(prev), b = JSON.parse(next);
    const idsA = (a.kits || []).map((k) => k.id);
    const idsB = (b.kits || []).map((k) => k.id);
    const missing = idsB.filter((id) => !idsA.includes(id));
    const extra = idsA.filter((id) => !idsB.includes(id));
    if (missing.length) hint += `  文件缺：${missing.join(' / ')}\n`;
    if (extra.length) hint += `  文件多：${extra.join(' / ')}（代码里已没有）\n`;
    if (!missing.length && !extra.length) hint += '  kit 集合相同，差异在字段（如 calibration / presets）。\n';
  } catch {
    hint = '  文件不是合法 JSON。\n';
  }
  console.error('FAIL  api/capabilities.json 与代码不一致：\n' + hint +
    '  修法：node tools/gen-capabilities.mjs');
  process.exit(1);
}

if (prev === next) {
  console.log('capabilities.json 已是最新，未改动');
  process.exit(0);
}
fs.writeFileSync(OUT, next);
const kits = JSON.parse(next).kits.map((k) => k.id);
console.log(`capabilities.json 已更新 · ${kits.length} 支：${kits.join(' / ')}`);
