#!/usr/bin/env node
/**
 * tools/knowledge/new.mjs · 按母版生成一期的参数骨架
 *
 *   # 先算复杂度（五项各 0–2）
 *   node tools/knowledge/new.mjs --score 1,0,2,2,1
 *
 *   # 生成骨架（可直接渲染，args 是占位文案）
 *   node tools/knowledge/new.mjs --template A --tier 标准 --title "本福特定律" \
 *     --sub "为什么假账总被数字 1 出卖" -o content/knowledge-bfd.json
 *
 *   # 审一份写好的稿子
 *   node tools/knowledge/new.mjs --audit content/knowledge-bfd.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { scoreComplexity, mismatchedHint, buildSkeleton, audit, guide, planBeats } from './knowledge.mjs';

const arg = (n, d = null, short = null) => {
  let i = process.argv.indexOf('--' + n);
  if (i < 0 && short) i = process.argv.indexOf('-' + short);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes('--' + n);

/* 复杂度 */
if (has('score')) {
  const v = String(arg('score')).split(/[,，]/).map((x) => Number(x.trim()));
  const keys = guide.complexity.dims.map((d) => d.key);
  const scores = Object.fromEntries(keys.map((k, i) => [k, v[i] ?? 1]));
  const r = scoreComplexity(scores);
  console.log(`复杂度 ${r.total}/10 → ${r.band}`);
  for (const d of r.detail) console.log(`  ${d.score}  ${d.label}：${d.level}`);
  console.log(`推荐档位：${r.tiers.join(' / ')}（推荐项排第一）`);
  for (const t of r.tiers) {
    const s = guide.durations[t];
    console.log(`  ${t}：${s.seconds[0]}–${s.seconds[1]}s / ${s.words[0]}–${s.words[1]} 字 / ${s.beats[0]}–${s.beats[1]} 拍`);
    console.log(`    能讲到 ${s.canTell}；要砍掉 ${s.cut}`);
  }
  process.exit(0);
}

/* 审查 */
if (has('audit')) {
  const f = arg('audit');
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = audit(p, { template: arg('template'), tier: arg('tier') });
  console.log(`审查 ${path.basename(f)}：${r.ok ? 'PASS' : 'FAIL'}（${r.stats.beats} 拍 / ${r.stats.chars} 字 / ${r.stats.cps} 字每秒）`);
  for (const e of r.errors) console.log(`  FAIL  ${e}`);
  for (const w of r.warns) console.log(`  warn  ${w}`);
  process.exit(r.ok ? 0 : 1);
}

/* 生成 */
const template = arg('template');
const tier = arg('tier', '标准');
if (!template) {
  console.error('用法: new.mjs --template A|B|C|D|E|F --tier 速览|精讲|标准|深挖 --title "标题" [-o out.json]');
  console.error('      new.mjs --score 1,0,2,2,1        # 只算复杂度与推荐档');
  console.error('      new.mjs --audit file.json        # 审一份稿子');
  process.exit(2);
}
if (!guide.templates[template]) {
  console.error(`未知母版 ${template}。可选：${Object.entries(guide.templates).map(([k, v]) => `${k}=${v.name}`).join(' · ')}`);
  process.exit(2);
}

const params = buildSkeleton({
  template, tier,
  title: arg('title', '未命名'),
  subtitle: arg('sub', ''),
});
const out = arg('out', null, 'o');
const json = JSON.stringify(params, null, 2);
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, json);
  const { beats, dropped } = planBeats(template, tier);
  console.log(`✓ ${out}`);
  console.log(`  ${guide.templates[template].name} · ${tier} · ${beats.length} 拍 · ${params.durationSeconds}s` +
    (dropped ? `（从母版裁掉 ${dropped} 拍）` : ''));
  console.log(`  配对版式：${params._meta.pairing.first}（也可 ${params._meta.pairing.also.join(' / ')}）`);
  console.log(`  渲染：node render.mjs --kit ${params._meta.pairing.first} --params ${out}`);
  console.log(`  换文案后审查：node tools/knowledge/new.mjs --audit ${out}`);
} else {
  console.log(json);
}
