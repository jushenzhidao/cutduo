#!/usr/bin/env node
/**
 * check-times.mjs — 扫「段内时刻越界」（静态检查，不出片，秒级）
 *
 *   node tools/check-times.mjs                     扫 content/* / kits 下所有 params
 *   node tools/check-times.mjs --slug sample-1000  只扫一支
 *
 * 为什么要有：paper 的 `scenes[].args` 里的时刻是**绝对秒**（`renderFrame(t)` 用绝对 t 去比），
 * 越界不会报错——`pr(t, at, at+0.52)` 在该段内永远返回 0，元素**永不出现**，画面只是少了一块。
 * 这类事故在 MEMORY §五 记了一整节，但一直靠人肉发现。
 *
 * 实测抓到的第一例（2026-11-14）：`content/sample-1000/script.json` 的 compare 段写着
 * `"strikeAt": 9`，而该段只有 4.41s ⇒ 划线永不出现。build 会忠实地把它换算成 `t0+9`。
 *
 * 判定：`args` 内所有时刻必须落在 `[t0, t1]` 内。
 * 注意 **不要检查 `from`**——`number.from` 是数值起点不是时间（含 from 会从 18 滚到 30）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/root.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const ONLY = arg('slug');
const ASJSON = process.argv.includes('--json');
const TOL = Number(arg('tol', 0.01));   // 容差：帧取整会带来 1e-3 级误差

/** 时间字段白名单（与 temporal.mjs 的口径一致，**不含 from**） */
const NAMED = new Set(['at', 'leftAt', 'rightAt', 'strikeAt', 'itemAt']);

function collect(node, out, where) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    // 元组写法：[文案, 绝对秒]、[文案, 绝对秒, 'slam']
    if (node.length >= 2 && typeof node[0] === 'string' && Number.isFinite(node[1])) {
      out.push({ t: node[1], where, kind: 'tuple' });
    }
    node.forEach((v, i) => collect(v, out, `${where}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (NAMED.has(k) && Number.isFinite(v)) out.push({ t: v, where: `${where}.${k}`, kind: 'named' });
    else if (k !== 'from' && k !== 'until') collect(v, out, `${where}.${k}`);
  }
}

function scanFile(file) {
  let P;
  try { P = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { file, error: `JSON 解析失败：${e.message}`, rows: [] };
  }
  const scenes = P.scenes || [];
  if (!scenes.length) return { file, rows: [], skipped: '无 scenes' };
  // paper 的 args 时刻是绝对秒；science 传 localT，args 是段内相对秒。
  // 原 params 有 segments ⇒ science 语义。判错会把正常片全报成越界。
  const relMode = Array.isArray(P.segments) && P.segments.length > 0;
  const rows = [];
  let checked = 0;
  scenes.forEach((s, i) => {
    if (!Number.isFinite(s.t0) || !Number.isFinite(s.t1)) return;
    const span = s.t1 - s.t0;
    const ts = [];
    collect(s.args || {}, ts, s.type || `scenes[${i}]`);
    for (const r of ts) {
      checked++;
      if (relMode) {
        if (r.t < -TOL) rows.push({ ...r, index: i, t0: 0, t1: span, why: '段内时刻为负' });
        else if (r.t > span + TOL) rows.push({ ...r, index: i, t0: 0, t1: span, why: '超出段时长' });
      } else if (r.t < s.t0 - TOL) rows.push({ ...r, index: i, t0: s.t0, t1: s.t1, why: '早于段起点' });
      else if (r.t > s.t1 + TOL) rows.push({ ...r, index: i, t0: s.t0, t1: s.t1, why: '晚于段末' });
    }
  });
  return { file, rows, checked, relMode };
}

/* ---------------- 找文件 ---------------- */
function findParams() {
  const out = [];
  const contentDir = path.join(REPO_ROOT, 'content');
  if (fs.existsSync(contentDir)) {
    for (const d of fs.readdirSync(contentDir)) {
      if (ONLY && d !== ONLY) continue;
      const dir = path.join(contentDir, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/^params(-abs|-chain)?\.json$/.test(f)) out.push(path.join(dir, f));
      }
    }
  }
  if (!ONLY) {
    const kitsDir = path.join(REPO_ROOT, 'kits');
    if (fs.existsSync(kitsDir)) {
      for (const kit of fs.readdirSync(kitsDir)) {
        const pdir = path.join(kitsDir, kit, 'presets');
        if (!fs.existsSync(pdir)) continue;
        for (const f of fs.readdirSync(pdir)) if (f.endsWith('.json')) out.push(path.join(pdir, f));
      }
    }
  }
  return out;
}

const files = findParams();
if (!files.length) { console.error(`没有可检查的 params${ONLY ? `（--slug ${ONLY}）` : ''}`); process.exit(2); }

const results = files.map(scanFile);
const bad = results.filter((r) => r.rows.length);
const total = results.reduce((n, r) => n + (r.checked || 0), 0);
const totalBad = bad.reduce((n, r) => n + r.rows.length, 0);

if (ASJSON) {
  console.log(JSON.stringify({ files: results.length, checked: total, violations: totalBad, bad }, null, 2));
} else {
  console.log(`\n时刻越界检查 · ${results.length} 份 params / ${total} 个时刻（paper 绝对秒 / science 段内相对秒）`);
  console.log('─'.repeat(74));
  for (const r of results) {
    if (r.error) { console.log(`  ✗ ${path.relative(REPO_ROOT, r.file)}  ${r.error}`); continue; }
    if (r.skipped) continue;
    if (!r.rows.length) continue;
    console.log(`  ✗ ${path.relative(REPO_ROOT, r.file)}  ${r.rows.length} 处`);
    for (const v of r.rows.slice(0, 8)) {
      console.log(`      ${String(v.where).padEnd(26)} t=${v.t.toFixed(2)}  段=[${v.t0.toFixed(2)}, ${v.t1.toFixed(2)}]  ${v.why}`);
    }
    if (r.rows.length > 8) console.log(`      …另 ${r.rows.length - 8} 处`);
  }
  console.log('─'.repeat(74));
  if (!totalBad) console.log(`全部落在段内（${results.filter((r) => !r.skipped && !r.error).length} 份有 scenes）\n`);
  else {
    console.log(`RESULT: FAIL (${totalBad} 处 / ${bad.length} 份) — 越界的元素在成片里永远不会出现。\n` +
      '  修法：把该时刻改到段内（常见原因：照抄了上一段的绝对秒、或把段内秒写成整段秒数）。\n');
  }
}
process.exit(totalBad ? 1 : 0);
