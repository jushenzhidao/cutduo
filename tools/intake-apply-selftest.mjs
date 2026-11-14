#!/usr/bin/env node
/**
 * intake-apply-selftest.mjs · Phase 2 的前置条件自测（不写仓库）
 *
 * 覆盖：
 *   1. rehost 目标 adapter 已存在 → 拒绝，不覆盖；
 *   2. semi 计划 dry-run → 只报计划，不生成目录；
 *   3. CREDENTIALS_PRESENT + rehost → 拒绝（凭据不进仓库）。
 *
 * 真正写盘的正向路径由人工在受控模板上跑；
 * 这里只证明「该拒绝的拒绝、dry-run 不落盘」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'intake-apply.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutduo-apply-'));
const templates = path.join(tmp, 'templates');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

function makePlan(id, mode, blockers = []) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  const plan = {
    schema: 'cutduo-intake-plan/1',
    createdAt: new Date().toISOString(),
    id,
    mode: { requested: 'auto', resolved: mode, reason: 'selftest' },
    source: { resolved: 'templates/own/night-card', bytes: null },
    verdict: { kind: 'engine', depth: mode, confidence: 0.95, summary: 'selftest', reasons: [] },
    evidence: { manifest: { templateName: 'Selftest' } },
    blockers,
  };
  const p = path.join(dir, 'plan.json');
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}

function apply(plan, ...extra) {
  const r = spawnSync(process.execPath, [TOOL, '--plan', plan, '--json', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 断言给 stderr */ }
  return { status: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

try {
  /* 1. 已存在 adapter：必须拒绝 */
  const p1 = makePlan('night-card', 'rehost');
  const r1 = apply(p1, '--yes');
  check('rehost 已存在 adapter → exit 2', () => {
    if (r1.status !== 2) throw new Error(`status=${r1.status}\n${r1.stderr}`);
  });

  /* 2. semi dry-run：必须只计划、不创建目录 */
  const p2 = makePlan('zz-apply-dry', 'semi');
  const r2 = apply(p2, '--templates-dir', templates);
  check('semi dry-run → exit 0 且不落盘', () => {
    if (r2.status !== 0) throw new Error(`status=${r2.status}\n${r2.stderr}`);
    if (!r2.json?.dryRun) throw new Error('dryRun 不为 true');
    if (!r2.json.actions.some((a) => a.type === 'scaffold' && a.status === 'planned')) {
      throw new Error('没有 planned scaffold 动作');
    }
    if (fs.existsSync(path.join(templates, 'zz-apply-dry'))) throw new Error('dry-run 创建了目录');
  });

  /* 3. 凭据 blocking：rehost 必须拒绝 */
  const p3 = makePlan('zz-apply-refuse', 'rehost', [
    { code: 'CREDENTIALS_PRESENT', severity: 'block', message: 'fake', fix: 'fake' },
  ]);
  const r3 = apply(p3, '--yes');
  check('CREDENTIALS_PRESENT + rehost → exit 2', () => {
    if (r3.status !== 2) throw new Error(`status=${r3.status}\n${r3.stderr}`);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
