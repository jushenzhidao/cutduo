#!/usr/bin/env node
/**
 * tools/render-all.mjs · 批量出片：扫 content/<片>/，按状态决定重建还是直接渲
 *
 *   node tools/render-all.mjs --list      只列状态，不动手
 *   node tools/render-all.mjs             出所有「可渲染」的片（不重新配音）
 *   node tools/render-all.mjs --rebuild   强制走 make.sh（会重算时间轴、重混音）
 *   node tools/render-all.mjs --slug a,b  只出指定片
 *
 * 四种状态：
 *   skeleton  只有 script.json，从没出过片（脚手架刚建出来）
 *   stale     script.json 比 params-chain.json 新 —— 改了稿但没重建
 *   ready     params-chain.json + audio/mix-final.wav 都在，且不旧于 script.json
 *   done      out/<slug>.mp4 比 params-chain.json 新 —— 已出且是最新的
 *
 * 为什么默认不重建：一次 make.sh 要重配音（edge-tts 逐段）+ 重混音，几十秒到几分钟；
 * 只想批量重渲时应该跳过这些。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes('--' + n);

const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);

function scan() {
  if (!fs.existsSync(CONTENT)) return [];
  return fs.readdirSync(CONTENT)
    .filter((d) => fs.statSync(path.join(CONTENT, d)).isDirectory())
    .map((slug) => {
      const dir = path.join(CONTENT, slug);
      const script = path.join(dir, 'script.json');
      // science 版式没有链式版（它用 segments + dur 累积），只有 params-abs.json
      const chain = fs.existsSync(path.join(dir, 'params-chain.json'))
        ? path.join(dir, 'params-chain.json')
        : path.join(dir, 'params-abs.json');
      // paper 用混音轨 mix-final.wav；science 目前只有归一后的旁白 vo-norm.wav
      const mix = ['audio/mix-final.wav', 'audio/vo-norm.wav']
        .map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || path.join(dir, 'audio/mix-final.wav');
      const out = path.join(ROOT, 'out', slug + '.mp4');
      const make = path.join(dir, 'make.sh');
      if (!fs.existsSync(script)) return { slug, status: 'no-script' };

      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(script, 'utf8')); } catch { /* 读坏了当骨架 */ }
      const beats = (meta.beats || []).length;

      let status;
      if (!fs.existsSync(chain)) status = 'skeleton';
      else if (mtime(script) > mtime(chain)) status = 'stale';
      else if (!fs.existsSync(mix)) status = 'stale';
      else if (fs.existsSync(out) && mtime(out) >= mtime(chain)) status = 'done';
      else status = 'ready';

      return { slug, status, dir, make, chain, mix, out, beats, title: meta.title || '', tier: meta.tier || '', template: meta.template || '' };
    })
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

const ICON = { skeleton: '○', stale: '~', ready: '●', done: '✓', 'no-script': '?' };
const rows = scan();

if (flag('list') || !rows.length) {
  console.log(`\n${rows.length} 个目录\n`);
  const head = ['状态', '片名', '母版/档', '拍', '目录'];
  const lines = rows.map((r) => [
    `${ICON[r.status] || ' '} ${r.status}`,
    r.title || r.slug, `${r.template || '?'}/${r.tier || '?'}`, String(r.beats || ''), r.slug,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] || '').length)));
  const fmt = (c) => c.map((x, i) => String(x || '').padEnd(w[i])).join('  ');
  console.log(fmt(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const l of lines) console.log(fmt(l));
  console.log('\n○ skeleton 刚建目录 / ~ stale 改了稿没重建 / ● ready 可渲染 / ✓ done 已是最新');
  if (!flag('list')) console.log('（没有任何可渲染的片，先写 script.json 或跑 make.sh）');
  process.exit(0);
}

const only = arg('slug') ? new Set(String(arg('slug')).split(',').map((s) => s.trim())) : null;
const rebuild = flag('rebuild');
const queue = rows.filter((r) => (only ? only.has(r.slug) : true) && r.status !== 'no-script');

const todo = [];
for (const r of queue) {
  if (rebuild) { if (r.status !== 'no-script') todo.push(r); }
  else if (r.status === 'ready' || r.status === 'stale') todo.push(r);
}
if (!todo.length) {
  console.log('没有需要出片的（全是 skeleton 或 done）。用 --list 看状态，或 --rebuild 强制重建。');
  process.exit(0);
}

console.log(`\n出片 ${todo.length} 支${rebuild ? '（--rebuild：走 make.sh）' : ''}\n`);
let bad = 0;
for (const r of todo) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${r.slug} … `);
  try {
    if (rebuild) {
      execFileSync('bash', [r.make], { cwd: r.dir, stdio: 'pipe' });
    } else {
      // 走已生成的 params + 混音，只重渲
      execFileSync('node', [path.join(ROOT, 'render.mjs'), '--kit', 'paper',
        '--params', r.chain, '--audio', r.mix, '--out', r.out], { cwd: ROOT, stdio: 'pipe' });
    }
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    const mb = fs.existsSync(r.out) ? (fs.statSync(r.out).size / 1e6).toFixed(2) : '?';
    console.log(`✓ ${s}s · ${mb}MB`);
  } catch (e) {
    bad++;
    const msg = (e.stderr || e.stdout || Buffer.from('')).toString().trim().split('\n').slice(-3).join(' | ');
    console.log(`✗ ${msg.slice(0, 160)}`);
  }
}

// 统一过门禁
if (!bad) {
  const outs = todo.map((r) => r.out).filter((f) => fs.existsSync(f));
  if (outs.length) {
    console.log('\n── 门禁');
    try {
      execFileSync('node', [path.join(ROOT, 'src/gate.mjs'), ...outs], { cwd: ROOT, stdio: 'inherit' });
    } catch { bad++; }
  }
}
process.exit(bad ? 1 : 0);
