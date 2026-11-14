#!/usr/bin/env node
/**
 * check-beats.mjs — 「一拍拆多段但 screens 不够」的静态检查
 *
 *   node tools/check-beats.mjs                 扫所有片
 *   node tools/check-beats.mjs --slug benford  只扫一支
 *
 * 为什么要有：本仓分镜的硬规则是「一拍拆 N 段，必须有 N 份 screens」。
 * 违反时后果不是报错，而是**同一画面重放 N 遍**——观众看到标题出现、消失、再出现。
 * 成片照样 PASS（帧数、空帧、响度全对），只有读屏幕才发现。
 *
 * 实测（2026-11-14）：7 支片里 4 支违反，benford 一拍重放 4 次（0s→4.38s 均差 0.16）。
 * 这条规则写在 MEMORY §6.5，但从来没有工具检查过。
 *
 * 判定口径：
 *   · 段按 `beat` 字段分组（build 时写入）；没有 beat 的段按"连续同 type 且 args 相同"归组
 *   · 每组段数 N > 该拍的 screens 数 M ⇒ 重放 N−M 次
 *   · 只报「净重放」：N=2 M=2 不报；N=3 M=2 报 1 次
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

export function beatStats(slug) {
  const dir = path.join(REPO_ROOT, 'content', slug);
  const pAbs = path.join(dir, 'params-abs.json');
  const pScript = path.join(dir, 'script.json');
  if (!fs.existsSync(pAbs)) return null;
  const P = JSON.parse(fs.readFileSync(pAbs, 'utf8'));
  const scenes = P.scenes || [];
  if (!scenes.length) return null;

  let screensPerBeat = {};
  if (fs.existsSync(pScript)) {
    try {
      const S = JSON.parse(fs.readFileSync(pScript, 'utf8'));
      for (const b of S.beats || []) screensPerBeat[b.id] = (b.screens || []).length;
    } catch { /* script 坏了就只用段数 */ }
  }

  // 按 beat 分组；无 beat 时退化为"连续同 type + 同 args"
  const groups = new Map();
  let fallback = 0;
  let prevKey = null;
  for (const [i, s] of scenes.entries()) {
    let key = s.beat;
    if (!key) {
      const sig = s.type + '|' + JSON.stringify(s.args || {});
      if (sig !== prevKey) fallback++;
      key = `~auto${fallback}`;
      prevKey = sig;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i, type: s.type, t0: s.t0, t1: s.t1 });
  }

  const rows = [];
  for (const [beat, segs] of groups) {
    const M = screensPerBeat[beat];
    const N = segs.length;
    if (M === undefined) {
      // 没有 script.json 或该拍没有 screens 记录，只能报段数
      if (N > 1) rows.push({ beat, N, M: null, extra: N - 1, from: segs[0].t0, to: segs[N - 1].t1, types: [...new Set(segs.map((s) => s.type))] });
      continue;
    }
    if (N > M) rows.push({ beat, N, M, extra: N - M, from: segs[0].t0, to: segs[N - 1].t1, types: [...new Set(segs.map((s) => s.type))] });
  }
  return { slug, scenes: scenes.length, beats: groups.size, rows };
}

import { fileURLToPath } from 'node:url';

/** 只在直接运行时走 CLI；被 gate.mjs import 时只提供函数 */
const IS_CLI = process.argv[1] === fileURLToPath(import.meta.url);

if (IS_CLI) {
  const contentDir = path.join(REPO_ROOT, 'content');
  const slugs = fs.readdirSync(contentDir).filter((d) => {
    if (ONLY && d !== ONLY) return false;
    return fs.existsSync(path.join(contentDir, d, 'params-abs.json'));
  });

  const out = slugs.map(beatStats).filter(Boolean);
  const bad = out.filter((r) => r.rows.length);

  if (ASJSON) {
    console.log(JSON.stringify({ films: out.length, bad: bad.length, detail: bad }, null, 2));
  } else {
    console.log(`\n拍/段/screens 一致性 · ${out.length} 支片`);
    console.log('─'.repeat(76));
    for (const r of bad) {
      console.log(`  ✗ ${r.slug}  ${r.scenes} 段 / ${r.beats} 拍`);
      for (const b of r.rows) {
        const screens = b.M === null ? '无 screens 记录' : `${b.M} 份 screens`;
        console.log(`      ${String(b.beat).padEnd(8)} ${b.N} 段 / ${screens}  重放 ${b.extra} 次  [${b.from.toFixed(1)}–${b.to.toFixed(1)}s]  ${b.types.join('/')}`);
      }
    }
    const ok = out.filter((r) => !r.rows.length);
    if (ok.length) console.log(`\n  ✓ 通过：${ok.map((r) => r.slug).join('、')}`);
    console.log('─'.repeat(76));
    const totalExtra = bad.reduce((n, r) => n + r.rows.reduce((m, b) => m + b.extra, 0), 0);
    if (!totalExtra) console.log('没有重放：每一拍都有足够的 screens\n');
    else {
      console.log(`RESULT: ${totalExtra} 处重放（${bad.length}/${out.length} 支片）`);
      console.log('  修法：给该拍补 screens（每份对应一段），或把该拍的时长合并成一段。\n');
    }
  }
  process.exit(bad.length ? 1 : 0);

}
