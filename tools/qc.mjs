#!/usr/bin/env node
// qc.mjs — 一支片出完之后的统一质检入口（make.sh 最后一步调它）。
//
// 为什么要有（2026-11-14）：仓里已有的检查不少，但**没有任何一支 make.sh 串过它们**——
// check-beats / adversarial / narration-lint / case-loop 全靠人记得手跑，等于没有。
// 更糟的是原来每支 make.sh 的末行是 `node src/gate.mjs … | grep -E "PASS|FAIL|…"`：
// **管道的退出码是 grep 的**，gate 判 FAIL 时 grep 照常匹配到 "FAIL" 并返回 0，
// set -e 不会中断 ⇒ 出片脚本"成功"退出、坏片照样进 out/。
//
// 这里按「便宜的先跑、贵的后跑」排序，一次跑完并把结果写进案例库：
//   0. 结构校验 check-screens（硬拦 —— shape 错了渲染器不炸，只会静默丢内容）
//   1. 文案体检 narration-lint（只报不拦 —— 文案质量是判断题，不该卡住流水线）
//   2. 分镜一致性 check-beats（硬拦，秒级，且必须在渲染前跑过一遍；这里再跑是兜底）
//   3. 门禁 gate（硬拦，--json 落盘）
//   4. 案例 case-loop（复用 gate 的 json，不再跑第二遍）
//
// 用法：node tools/qc.mjs <slug>
// 退出码：0 通过 / 1 有硬缺陷 / 2 输入错误

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!slug) { console.error('用法: node tools/qc.mjs <slug>'); process.exit(2); }

const video = path.join(ROOT, `out/${slug}.mp4`);
if (!existsSync(video)) { console.error(`找不到成片: ${video}`); process.exit(2); }
const contentDir = path.join(ROOT, `content/${slug}`);
const facts = path.join(contentDir, 'facts.md');
const chain = path.join(contentDir, 'params-chain.json');
const abs = path.join(contentDir, 'params.json');

const run = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', ...opts });

/* ── 0. 结构校验（硬拦）：形状错了但渲染器不炸，只能在这里拦 ── */
console.log('── QC 0/5 结构校验（script.json 的 screens）');
const sch = run([path.join(ROOT, 'tools/check-screens.mjs'), slug]);
process.stdout.write(sch.stdout || '');
if (sch.status !== 0) {
  console.error('✗ screens 结构错误：修好再出片（这类错误渲染器不会报错，只会静默丢内容）');
  process.exit(1);
}

/* ── 1. 文案体检（只报不拦） ── */
console.log('── QC 1/5 文案体检（只报不拦）');
const lint = run([path.join(ROOT, 'tools/narration-lint.mjs'), slug]);
process.stdout.write(lint.stdout || '');
if (lint.status !== 0) console.log('   （以上为提示，不拦截出片）');

/* ── 2. 分镜一致性：交给 gate 的 --beats-check（同一份实现，别跑两遍）
       渲染前的快速预检在 make.sh 里已经跑过一次，这里只作为最终判定 ── */
console.log('── QC 2/5 分镜一致性（随门禁一起判）');

/* ── 3. 门禁（硬拦） ── */
console.log('── QC 3/5 门禁');
const gateJson = path.join(os.tmpdir(), `qc-gate-${slug}.json`);
const gateArgs = [path.join(ROOT, 'src/gate.mjs'), video, '--json', gateJson,
  '--blank', '--loudness', '--bgm', '--ocr', '2', '--pacing', '--require-beats', slug];
if (existsSync(facts)) gateArgs.push('--facts', facts);
if (existsSync(abs)) gateArgs.push('--pacing-params', existsSync(chain) ? chain : abs);
const gate = run(gateArgs);
// 把表格打出来（但退出码取 gate 自己的，不是管道里的 grep）
const table = (gate.stdout || '').split('\n').filter((l) => /PASS|FAIL|film|spec|^-|LUFS/.test(l));
if (table.length) console.log(table.join('\n'));
if (gate.stderr && gate.stderr.trim()) console.error(gate.stderr.trim());

/* ── 3b. 构图量化（可选，只报不拦：阈值是同族相对的，会误报） ── */
if (process.argv.includes('--composition')) {
  console.log('── QC 3b 构图量化');
  const comp = run([path.join(ROOT, 'tools/composition.mjs'), slug]);
  process.stdout.write(comp.stdout || '');
}

/* ── 4. 案例（复用 gate 的 json） ── */
console.log('── QC 4/5 案例留痕');
const cs = run([path.join(ROOT, 'tools/case-loop.mjs'), slug, '--gate-json', gateJson, '--quiet']);
process.stdout.write(cs.stdout || '');

if (gate.status !== 0) {
  console.error(`✗ 门禁 FAIL（退出码 ${gate.status}）——见 docs/cases/${slug}.md`);
  process.exit(1);
}
console.log(`✓ ${slug} 通过（案例 docs/cases/${slug}.md）`);
process.exit(0);
