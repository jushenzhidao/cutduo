#!/usr/bin/env node
/**
 * sfx-check.mjs · 音效链路的判据（把 r07 那条手写记录变成可执行的）
 *
 *   node tools/sfx-check.mjs                    # 正跑
 *   node tools/sfx-check.mjs --self-test        # 负向自检：检查器自己能不能报错
 *   node tools/sfx-check.mjs --video <mp4> --cues <json> --mixed <mp4>
 *
 * 为什么需要：音效这一节原先只有一条手写在 `logs/r07.log` 里的结论。
 * 手写记录能证明"当时跑过"，不能证明"现在还对"——改了 cue 表或重渲了片子，
 * 那份 log 仍然是 PASS。判据必须是可重跑的。
 *
 * 五条判据（对应 docs/jimeng/02-音效-2026-11-16.md）：
 *   C1 cue 表结构合法（kind 在四种之内、t/dur/gain 是数、dur 不为负）
 *   C2 **每个硬切点都有 impact（±50ms）** —— 这是那篇文档里唯一一条"没有例外"的规则
 *   C3 混音产物时长与源片一致（±0.02s）且有音频流
 *   C4 交付门禁 PASS（LUFS / 帧数 / 音画差）
 *   C5 反证：用 sfx-probe 回读成片，切点附近必须能测到能量突增
 *       （测不到 = 音效被配乐埋了，C2 的"配了"不等于"听得见"）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SELF_TEST = argv.includes('--self-test');

const VIDEO = path.resolve(REPO_ROOT, get('video', 'out/jimeng-showreel.mp4'));
const MIXED = path.resolve(REPO_ROOT, get('mixed', 'out/jimeng-showreel-sfx.mp4'));
const CUES = path.resolve(REPO_ROOT, get('cues', 'content/jimeng-showreel/sfx.json'));

const KINDS = new Set(['impact', 'riser', 'whoosh', 'tick']);
const CUT_TOL = 0.05;   // impact 与硬切点的允许偏移（原片实测 −9/+45/−2/+22ms）

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 32 << 20 });

/* ───────────────────────────── 取硬切点 */

function sceneCuts(video) {
  const r = run('ffmpeg', ['-hide_banner', '-i', video, '-vf', "select='gt(scene,0.18)',showinfo", '-f', 'null', '-']);
  const txt = (r.stderr || '') + (r.stdout || '');
  const ts = [...new Set([...txt.matchAll(/pts_time:([0-9.]+)/g)].map((m) => +m[1]))].sort((a, b) => a - b);
  const merged = [];
  for (const t of ts) {
    if (merged.length && t - merged[merged.length - 1] < 0.12) continue;
    merged.push(t);
  }
  return merged;
}

/* ───────────────────────────── 检查 */

const results = [];
function check(id, name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r.ok;
    detail = r.detail || '';
  } catch (e) {
    ok = false;
    detail = `异常：${e.message}`;
  }
  results.push({ id, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

function loadCues() {
  if (!fs.existsSync(CUES)) return { err: `cue 表不存在：${CUES}` };
  try {
    const t = JSON.parse(fs.readFileSync(CUES, 'utf8'));
    return { table: t, cues: Array.isArray(t.cues) ? t.cues : [] };
  } catch (e) {
    return { err: `不是合法 JSON：${e.message}` };
  }
}

function c1() {
  const { err, cues } = loadCues();
  if (err) return { ok: false, detail: err };
  if (!cues.length) return { ok: false, detail: 'cues[] 为空' };
  for (const [i, c] of cues.entries()) {
    if (!KINDS.has(c.kind)) return { ok: false, detail: `cue[${i}] 未知 kind "${c.kind}"` };
    if (!Number.isFinite(c.t) || c.t < 0) return { ok: false, detail: `cue[${i}] t 非法` };
    if (c.dur !== undefined && (!Number.isFinite(c.dur) || c.dur <= 0)) return { ok: false, detail: `cue[${i}] dur 非法` };
    if (c.gain !== undefined && !Number.isFinite(c.gain)) return { ok: false, detail: `cue[${i}] gain 非法` };
  }
  return { ok: true, detail: `${cues.length} 个 cue` };
}

function c2() {
  const { err, cues } = loadCues();
  if (err) return { ok: false, detail: err };
  if (!fs.existsSync(VIDEO)) return { ok: false, detail: `源片不存在：${VIDEO}` };
  const cuts = sceneCuts(VIDEO);
  if (!cuts.length) return { ok: false, detail: '没有检出任何硬切点（片子是单镜头？）' };
  const misses = [];
  const rows = [];
  for (const c of cuts) {
    const near = cues
      .filter((x) => x.kind === 'impact' && Math.abs(x.t - c) <= CUT_TOL)
      .sort((a, b) => Math.abs(a.t - c) - Math.abs(b.t - c))[0];
    if (near) rows.push(`${c.toFixed(3)}←impact@${near.t.toFixed(3)}(${((near.t - c) * 1000).toFixed(0)}ms)`);
    else misses.push(c.toFixed(3));
  }
  return {
    ok: misses.length === 0,
    detail: misses.length
      ? `${cuts.length} 个切点漏配 ${misses.length} 个：${misses.join(', ')}`
      : `${cuts.length}/${cuts.length} 命中：${rows.join(' ')}`,
  };
}

function c3() {
  if (!fs.existsSync(MIXED)) return { ok: false, detail: `混音产物不存在：${MIXED}（先跑 tools/sfx-synth.mjs --mix）` };
  const a = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO]);
  const b = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type', '-of', 'json', MIXED]);
  const dSrc = Number((a.stdout || '').trim());
  const p = JSON.parse(b.stdout || '{}');
  const dOut = Number(p.format?.duration);
  const hasAudio = (p.streams || []).some((s) => s.codec_type === 'audio');
  if (!Number.isFinite(dOut)) return { ok: false, detail: '读不到产物时长' };
  if (!hasAudio) return { ok: false, detail: '产物没有音频流' };
  const diff = Math.abs(dOut - dSrc);
  return { ok: diff <= 0.02, detail: `${dSrc.toFixed(3)}s → ${dOut.toFixed(3)}s（差 ${diff.toFixed(3)}s）` };
}

function c4() {
  if (!fs.existsSync(MIXED)) return { ok: false, detail: '混音产物不存在' };
  const r = run('node', ['src/gate.mjs', MIXED]);
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = r.status === 0 && /PASS/.test(out);
  const lufs = (out.match(/(-?\d+\.\d+)\s+PASS/) || [])[1];
  return { ok: pass, detail: pass ? `LUFS ${lufs ?? '?'}` : out.split('\n').filter(Boolean).slice(-2).join(' | ') };
}

function c5() {
  if (!fs.existsSync(MIXED)) return { ok: false, detail: '混音产物不存在' };
  const tmp = path.join(REPO_ROOT, 'out', 'sfx-check-probe.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const r = spawnSync('python3', ['tools/sfx-probe.py', MIXED, '--json', tmp], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    return { ok: false, detail: `sfx-probe 失败：${(r.stderr || '').slice(-200)}` };
  }
  const p = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.unlinkSync(tmp);
  const impacts = p.impacts || [];
  const whooshes = p.whooshes || [];
  const misses = [];
  for (const c of p.cuts || []) {
    const hit = [...impacts.map((e) => ({ e, k: 'impact' })), ...whooshes.map((e) => ({ e, k: 'whoosh' }))]
      .some(({ e }) => Math.abs(e.t - c) <= 0.35);
    if (!hit) misses.push(c.toFixed(3));
  }
  return {
    ok: misses.length === 0,
    detail: misses.length
      ? `${misses.length} 个切点在音频上测不到突增：${misses.join(', ')}（配了但听不见）`
      : `回读命中 ${(p.cuts || []).length}/${(p.cuts || []).length}`,
  };
}

/* ───────────────────────────── 自检：造坏样本，检查器必须报错 */

function selfTest() {
  const base = JSON.parse(fs.readFileSync(CUES, 'utf8'));
  const tmpDir = path.join(REPO_ROOT, 'out', 'sfx-selftest');
  fs.mkdirSync(tmpDir, { recursive: true });

  const cases = [
    ['删掉最后一个 impact（切点漏配）', (t) => {
      const idx = t.cues.map((c) => c.kind).lastIndexOf('impact');
      t.cues.splice(idx, 1);
      return t;
    }, 'C2'],
    ['impact 挪到切点外 200ms（超容差）', (t) => {
      const imp = t.cues.find((c) => c.kind === 'impact');
      imp.t += 0.2;
      return t;
    }, 'C2'],
    ['kind 写成 foley（未知类型）', (t) => {
      t.cues[0].kind = 'foley';
      return t;
    }, 'C1'],
  ];

  let allCaught = true;
  for (const [i, [label, mutate, expectId]] of cases.entries()) {
    const f = path.join(tmpDir, `bad-${i}.json`);
    fs.writeFileSync(f, JSON.stringify(mutate(JSON.parse(JSON.stringify(base))), null, 2));
    /* 只跑静态判据（C1/C2），C3–C5 依赖产物，坏样本不该触发它们 */
    const r = spawnSync('node', ['tools/sfx-check.mjs', '--cues', f, '--static-only'], { encoding: 'utf8' });
    const caught = r.status !== 0 && new RegExp(`FAIL\\s+${expectId}`).test(r.stdout || '');
    console.log(`  ${caught ? 'PASS' : 'FAIL'}  自检·${label} → 期望 ${expectId} 报错，实际 ${caught ? '报错' : '未报错'}`);
    if (!caught) allCaught = false;
  }

  /* 正向样本必须仍然通过静态判据，否则等于"什么都报错" */
  const r = spawnSync('node', ['tools/sfx-check.mjs', '--static-only'], { encoding: 'utf8' });
  const okGreen = r.status === 0;
  console.log(`  ${okGreen ? 'PASS' : 'FAIL'}  自检·正样本仍通过（防止检查器恒报错）`);
  if (!okGreen) allCaught = false;

  return allCaught;
}

/* ───────────────────────────── 主流程 */

if (SELF_TEST) {
  console.log('sfx-check 负向自检');
  const ok = selfTest();
  console.log(`\n  ${ok ? '全部符合预期' : '自检未通过 —— 检查器抓不到人造违规'}`);
  process.exit(ok ? 0 : 1);
}

const STATIC_ONLY = argv.includes('--static-only');
console.log(`sfx-check · cues=${path.relative(REPO_ROOT, CUES)}`);
check('C1', 'cue 表结构', c1);
check('C2', `每个硬切点都有 impact（±${CUT_TOL * 1000}ms）`, c2);
if (!STATIC_ONLY) {
  check('C3', '混音产物时长一致且有音轨', c3);
  check('C4', '交付门禁', c4);
  check('C5', '回读反证：切点能测到能量突增', c5);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
