#!/usr/bin/env node
// check-screens.mjs — script.json 里 screens 的结构校验。
//
// 为什么要有（2026-11-14）：我写 `hero.lines` 时手滑成 `["文字A","文字B"]`（正确是 `[["文字",时刻],…]`），
// 成片照常渲染——因为 pHero 用 `lines.map(([s]) => …)` 解构，第二项被当成"时刻"直接忽略。
// 结果：强调句整段消失、时刻变成字符串、**没有任何工具报警**。lint 只管文案，gate 只管成片。
//
// 这类错误的共同点：**形状错了但渲染器不炸**，所以只能在数据层拦。
//
// 判据（只查各段型**明确规定**的字段，不做通用形状扫描——第一版做了，
// 结果把 quote.lines、compare.items、grid.origin 这些本来就该是纯数组的字段全判成错，
// 18 支片报错 16 支。判据比缺陷还吵的时候，人就会整片忽略它）：
//   3. quote / outro 的 lines 必须是**纯字符串数组**（写成元组是最常见的反向错误）
//   4. hero / point.cards / steps / checklist 的元组数组必须每项都是 [string, number]
//   4b. compare 的 left/right.items 必须是字符串数组
//   5. chart.items 必须是 {label, value} 且 value 有限
//
// 用法：node tools/check-screens.mjs [slug ...] | --all
// 退出码：0 通过 / 1 有结构错误

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 这些段型的 `lines` 是纯字符串数组（写成元组不报错但会渲染成 "[object Object]" 或整行消失）
const STRING_LINES = new Set(['quote', 'outro']);
// 这些段型用 [文字, 时刻] 元组
const TUPLE_FIELDS = {
  hero: ['lines'],
  point: ['cards'],
  steps: ['steps'],
  checklist: ['items'],
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function checkScreen(type, sc, where) {
  const hits = [];

  // 3. quote / outro：lines 必须是纯字符串
  if (STRING_LINES.has(type) && Array.isArray(sc.lines)) {
    sc.lines.forEach((l, i) => {
      if (typeof l !== 'string') {
        hits.push({ trail: `${where}.lines[${i}]`, msg: `${type} 的 lines 应为字符串数组，这里拿到 ${Array.isArray(l) ? '数组（元组写法是 point/hero 的，不是这里的）' : typeof l}` });
      }
    });
  }

  // 4. 元组字段：每一项都必须是 [string, number]
  for (const key of TUPLE_FIELDS[type] || []) {
    if (!Array.isArray(sc[key])) continue;
    sc[key].forEach((it, i) => {
      if (!Array.isArray(it) || it.length !== 2) {
        hits.push({ trail: `${where}.${key}[${i}]`, msg: `应为 [文字, 时刻] 二元组，拿到 ${JSON.stringify(it).slice(0, 40)}` });
      } else if (typeof it[0] !== 'string' || !isNum(it[1])) {
        hits.push({ trail: `${where}.${key}[${i}]`, msg: `应为 [string, number]，拿到 [${typeof it[0]}, ${typeof it[1]}]` });
      }
    });
  }

  // 4b. compare 的左右栏 items 是纯字符串（写成元组是最常见的反向错误）
  if (type === 'compare') {
    for (const side of ['left', 'right']) {
      const col = sc[side];
      if (!col || !Array.isArray(col.items)) continue;
      col.items.forEach((it, i) => {
        if (typeof it !== 'string') {
          hits.push({ trail: `${where}.${side}.items[${i}]`, msg: `compare 的 items 应为字符串，拿到 ${Array.isArray(it) ? '数组' : typeof it}` });
        }
      });
    }
  }

  // 5. chart.items
  if (type === 'chart' && Array.isArray(sc.items)) {
    sc.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || !isNum(Number(it.value))) {
        hits.push({ trail: `${where}.items[${i}]`, msg: `chart.items 需要 {label, value:数字}，拿到 ${JSON.stringify(it).slice(0, 40)}` });
      }
    });
  }

  return hits;
}

function lintOne(slug) {
  const f = path.join(ROOT, `content/${slug}/script.json`);
  if (!existsSync(f)) return null;
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return { slug, hits: [{ trail: 'script.json', msg: `JSON 解析失败：${e.message}` }] }; }
  const hits = [];
  (j.beats || []).forEach((b, bi) => {
    const type = b.type;
    if (!type) { hits.push({ trail: `beats[${bi}]`, msg: `缺 type 字段（build 会退回骨架段型，容易与本意不符）` }); return; }
    const screens = b.screens || [];
    if (!screens.length) { hits.push({ trail: `beats[${bi}]`, msg: '没有 screens（整拍会退回骨架默认画面）' }); return; }
    screens.forEach((sc, si) => hits.push(...checkScreen(type, sc, `${b.id}[${si}]`)));
  });
  return { slug, hits };
}

const argv = process.argv.slice(2);
let slugs = argv.filter((a) => !a.startsWith('-'));
if (argv.includes('--all') || !slugs.length) {
  slugs = readdirSync(path.join(ROOT, 'content')).filter((d) => existsSync(path.join(ROOT, `content/${d}/script.json`)));
}

let bad = 0, total = 0;
for (const slug of slugs) {
  const r = lintOne(slug);
  if (!r) continue;
  total++;
  if (!r.hits.length) continue;
  bad++;
  console.log(`✗ ${slug}`);
  for (const h of r.hits.slice(0, 8)) console.log(`    ${h.trail}  ${h.msg}`);
  if (r.hits.length > 8) console.log(`    …共 ${r.hits.length} 处`);
}
console.log(`\n${bad ? 'RESULT' : '✓'} 结构校验：${total - bad}/${total} 通过${bad ? `，${bad} 支有问题` : ''}`);
process.exit(bad ? 1 : 0);
