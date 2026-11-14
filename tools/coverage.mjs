#!/usr/bin/env node
/**
 * tools/coverage.mjs · 段型覆盖率体检
 *
 *   node tools/coverage.mjs              # 全部片
 *   node tools/coverage.mjs round-window # 单支
 *
 * 为什么查这个：段型种类决定"视觉重复"的程度。
 * 实测 round-window 用 4 种段型撑了 91 秒——每一屏都差不多，观众会觉得单调，
 * 但帧数、响度、空镜全过，门禁查不出来。
 *
 * 口径：拿 params 里实际出现过的 type，与 kits/<kit>/params.schema.json 的段型 enum 对表。
 * schema 没有枚举的版式（science / clay / mg / editorial）只报"用了几种"，不算覆盖率。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] || null;

/** 从 make.sh 猜版式：支持 --kit X 与独立入口两种写法 */
function kitOf(slug) {
  const mk = path.join(ROOT, 'content', slug, 'make.sh');
  if (!fs.existsSync(mk)) return null;
  const t = fs.readFileSync(mk, 'utf8');
  const m = t.match(/--kit\s+([a-z-]+)/);
  if (m) return m[1];
  for (const k of ['desk', 'editorial', 'mg']) {
    if (new RegExp(`kits/${k}/(render|desktop)`).test(t)) return k;
  }
  return null;
}

/** schema 里的段型枚举 */
function schemaTypes(kit) {
  const p = path.join(ROOT, 'kits', kit, 'params.schema.json');
  if (!fs.existsSync(p)) return null;
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(/"type"\s*:\s*\{[^{}]*"enum"\s*:\s*\[([^\]]+)\]/s)
    || s.match(/"enum"\s*:\s*\[([^\]]{20,})\]/s);
  if (!m) return null;
  return [...m[1].matchAll(/"([a-zA-Z][a-zA-Z0-9_-]*)"/g)].map((x) => x[1]);
}

const rows = [];
for (const dir of fs.readdirSync(path.join(ROOT, 'content'))) {
  if (only && dir !== only) continue;
  const pf = path.join(ROOT, 'content', dir, 'params-abs.json');
  const pf2 = path.join(ROOT, 'content', dir, 'params-chain.json');
  const file = fs.existsSync(pf) ? pf : (fs.existsSync(pf2) ? pf2 : null);
  if (!file) continue;
  const params = JSON.parse(fs.readFileSync(file, 'utf8'));
  const segs = params.scenes || params.segments || params.shots || [];
  if (!segs.length) continue;
  const used = [...new Set(segs.map((s) => s.type).filter(Boolean))].sort();
  // 没有 make.sh 的片（手动跑 render 的）按容器形状兜底：shots → desk
  let kit = kitOf(dir);
  if (!kit && params.shots) kit = 'desk';
  const all = kit ? schemaTypes(kit) : null;
  rows.push({
    slug: dir, kit, segs: segs.length, used, all,
    missing: all ? all.filter((t) => !used.includes(t)) : null,
  });
}

// 主指标是「段/种」而不是覆盖率：
// 覆盖率低不代表单调（D 母版 5 拍天生只有 4 种段型），但「每种段型平均出现几次」
// 直接等于观众看到同一套版式的次数。>=3 次就是明显重复（实测 round-window 4.25、reno-order 3.33）。
for (const r of rows) r.reuse = r.segs / Math.max(1, r.used.length);
rows.sort((a, b) => b.reuse - a.reuse);

console.log(`段型体检 · ${rows.length} 支（按"每种段型平均复用次数"排序）\n`);
for (const r of rows) {
  const r3 = r.reuse.toFixed(2);
  const tag = r.reuse >= 3 ? '  ⚠ 明显重复（同套版式出现 3 次以上）'
    : (r.reuse >= 2 ? '  尚可' : '  丰富');
  console.log(`${r.slug}  ${r.reuse.toFixed(2)} 段/种${tag}`);
  if (r.all) {
    console.log(`  ${r.kit} · ${r.segs} 段 · ${r.used.length}/${r.all.length} 种`);
    console.log(`  ${r.used.join(' ')}`);
    if (r.missing.length) console.log(`  缺：${r.missing.join(' ')}`);
  } else {
    console.log(`  ${r.kit || '?'} · ${r.segs} 段 · ${r.used.length} 种（schema 无枚举）`);
    console.log(`  ${r.used.join(' ')}`);
  }
  console.log('');
}
