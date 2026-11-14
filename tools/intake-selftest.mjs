#!/usr/bin/env node
/**
 * intake-selftest.mjs · Phase 1 计划器的负向/正向自测
 *
 *   node tools/intake-selftest.mjs
 *
 * 不碰仓库：所有 fixture 与产物都在系统临时目录，结束时删除。
 * 覆盖三种输入：
 *   1. 三件套模板（templates/own/night-card）→ rehost，无 blocking；
 *   2. 0.1-draft .motion ZIP（临时构造）→ semi，能跑 distill-inspect；
 *   3. protected 目录（含 personal/ 假凭据）→ 必须报 blocking，--mode rehost --strict 退出 1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'intake.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutduo-intake-'));
const outDir = path.join(tmp, 'out');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

function plan(source, ...extra) {
  const r = spawnSync(process.execPath, [TOOL, 'plan', '--source', source, '--json', '--out-dir', outDir, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 留空，断言会给出行号 */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

try {
  /* ── 1. 三件套：应判 rehost，且不因宿主 main.js 误报 DOM ── */
  const night = path.join(ROOT, 'templates', 'own', 'night-card');
  const p1 = plan(night);
  check('三件套：exit 0', () => {
    if (p1.status !== 0) throw new Error(`status=${p1.status}\n${p1.stderr}`);
    if (!p1.json) throw new Error('stdout 不是 JSON');
  });
  check('三件套：rehost / 无 blocking / 有 LICENSE', () => {
    const p = p1.json;
    if (p.verdict.depth !== 'rehost') throw new Error(`depth=${p.verdict.depth}`);
    const blocks = p.blockers.filter((b) => b.severity === 'block');
    if (blocks.length) throw new Error(`unexpected blocks: ${blocks.map((b) => b.code).join(',')}`);
    if (!p.evidence.has.license) throw new Error('license 未识别');
    if (p.evidence.has.dom) throw new Error('三件套 main.js 被误判成 DOM 引擎');
  });

  /* ── 2. 临时构造 0.1-draft .motion ── */
  const semiSrc = path.join(tmp, 'fake-semi');
  write(path.join(semiSrc, 'motion.json'), JSON.stringify({
    format: 'motiongit-template',
    specVersion: '0.1.0-draft.1',
    template: { id: 'fake-semi', name: 'Fake Semi' },
    runtime: { profile: 'html-canvas/1', engine: 'test' },
    parameters: { schema: 'params.schema.json', defaultPreset: 'presets/default.json' },
    content: { protection: 'open' },
    output: { width: 1920, height: 1080, fps: { num: 30, den: 1 } },
  }, null, 2));
  write(path.join(semiSrc, 'assistant', 'guide.json'), JSON.stringify({
    layouts: [
      { type: 'hero', args: { title: 'T' } },
      { type: 'point', args: { text: 'T' } },
    ],
  }, null, 2));
  write(path.join(semiSrc, 'params.schema.json'), JSON.stringify({
    type: 'object',
    properties: {
      segments: {
        type: 'array',
        items: {
          oneOf: [
            { properties: { type: { const: 'hero' } }, required: ['type'] },
            { properties: { type: { const: 'point' } }, required: ['type'] },
          ],
        },
      },
    },
  }, null, 2));
  write(path.join(semiSrc, 'src', 'kit.js'), "export const draw = (ctx) => ctx.getContext('2d');\n");
  write(path.join(semiSrc, 'LICENSE'), 'MIT License\n\nCopyright (c) test\n');
  const semiZip = path.join(tmp, 'fake-semi.motion');
  let zipOk = true;
  try {
    execFileSync('zip', ['-q', '-r', '-X', semiZip, '.'], { cwd: semiSrc });
  } catch (e) {
    zipOk = false;
    console.log(`SKIP  .motion ZIP（本机没有 zip：${e.message}）`);
  }
  if (zipOk) {
    const p2 = plan(semiZip);
    check('.motion：semi / 有 guide+schema / 提取器跑通', () => {
      if (p2.status !== 0) throw new Error(`status=${p2.status}\n${p2.stderr}`);
      const p = p2.json;
      if (p.source.kind !== 'motion-zip') throw new Error(`kind=${p.source.kind}`);
      if (p.verdict.depth !== 'semi') throw new Error(`depth=${p.verdict.depth}`);
      if (!p.evidence.has.guide || !p.evidence.has.schema) throw new Error('guide/schema 未识别');
      if (!p.inspect || !p.inspect.ran) throw new Error('distill-inspect 未运行');
      if (!p.inspect.ok) throw new Error(`distill-inspect 失败：${p.inspect.error}`);
      if (p.blockers.some((b) => b.severity === 'block')) throw new Error('unexpected blocking');
    });
  }

  /* ── 2.5 旧下载形态：<dir>/package/motion.json ── */
  const pkgSrc = path.join(tmp, 'fake-package');
  fs.cpSync(semiSrc, path.join(pkgSrc, 'package'), { recursive: true });
  const p25 = plan(pkgSrc);
  check('package 目录：识别 package-dir 且仍判 semi', () => {
    if (p25.status !== 0) throw new Error(`status=${p25.status}\n${p25.stderr}`);
    const p = p25.json;
    if (p.source.kind !== 'package-dir') throw new Error(`kind=${p.source.kind}`);
    if (p.verdict.depth !== 'semi') throw new Error(`depth=${p.verdict.depth}`);
    if (!p.evidence.has.motionJson) throw new Error('package/motion.json 未识别');
  });

  /* ── 2.8 zip-slip：只列目录也要把 ../ 标成 blocking（不解包） ── */
  const slipZip = path.join(tmp, 'slip.motion');
  try {
    execFileSync('python3', ['-c', [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1], "w")',
      'z.writestr("motion.json", "{}")',
      'z.writestr("../evil.txt", "x")',
      'z.close()',
    ].join('\n'), slipZip]);
    const p28 = plan(slipZip);
    check('zip-slip：报 ZIP_UNSAFE', () => {
      if (p28.status !== 0) throw new Error(`status=${p28.status}\n${p28.stderr}`);
      if (!p28.json.blockers.some((b) => b.code === 'ZIP_UNSAFE')) throw new Error('缺 ZIP_UNSAFE');
    });
  } catch (e) {
    console.log(`SKIP  zip-slip（构造失败：${e.message}）`);
  }

  /* ── 2.9 抽取源码：保留 LICENSE、排除 personal/ ── */
  const copyZip = path.join(tmp, 'fake-copy.motion');
  try {
    const copySrc = path.join(tmp, 'copy-src');
    write(path.join(copySrc, 'motion.json'), JSON.stringify({
      format: 'motiongit-template',
      specVersion: '1.0.0-rc.1',
      template: { id: 'fake-copy', name: 'Fake Copy' },
      runtime: { profile: 'motiongit-host/1' },
      content: { path: 'content/release.bin', protection: 'open' },
      output: { width: 1920, height: 1080, fps: { num: 30, den: 1 } },
    }, null, 2));
    write(path.join(copySrc, 'engine', 'foo.js'), 'export const x = 1;\n');
    write(path.join(copySrc, 'personal', 'key.txt'), 'fake-token-do-not-use\n');
    write(path.join(copySrc, 'licenses', 'L.txt'), 'license text\n');
    execFileSync('python3', ['-c', `
import sys, zipfile, io, os
root = sys.argv[1]
inner = io.BytesIO()
with zipfile.ZipFile(inner, "w") as zi:
    for sub in ["engine", "personal", "licenses"]:
        for dp, _, fs in os.walk(os.path.join(root, sub)):
            for f in fs:
                p = os.path.join(dp, f)
                zi.write(p, os.path.relpath(p, root))
with zipfile.ZipFile(sys.argv[2], "w") as zo:
    zo.write(os.path.join(root, "motion.json"), "motion.json")
    zo.writestr("content/release.bin", inner.getvalue())
`, copySrc, copyZip]);
    const pc = plan(copyZip);
    const copyOut = path.join(tmp, 'copy-out');
    const rc = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'intake-copy.mjs'),
      '--plan', path.join(outDir, pc.json.id, 'plan.json'), '--out', copyOut, '--yes', '--json'], {
      cwd: ROOT, encoding: 'utf8',
    });
    check('intake-copy：抽 engine / 保留 LICENSE / 排除 personal', () => {
      if (rc.status !== 0) throw new Error(`status=${rc.status}\n${rc.stderr}`);
      if (!fs.existsSync(path.join(copyOut, 'engine', 'foo.js'))) throw new Error('engine/foo.js 未抽出');
      if (!fs.existsSync(path.join(copyOut, 'licenses', 'L.txt'))) throw new Error('licenses 未保留');
      if (fs.existsSync(path.join(copyOut, 'personal', 'key.txt'))) throw new Error('personal 被复制');
    });
  } catch (e) {
    console.log(`SKIP  intake-copy（构造失败：${e.message}）`);
  }

  /* ── 3. protected + personal 假凭据 ── */
  const prot = path.join(tmp, 'fake-protected');
  write(path.join(prot, 'motion.json'), JSON.stringify({
    format: 'motiongit-template',
    specVersion: '0.1.0-draft.1',
    template: { id: 'fake-protected', name: 'Fake Protected' },
    runtime: { profile: 'html-canvas/1' },
    content: { protection: 'protected', path: 'content/release.bin' },
    output: { width: 1920, height: 1080, fps: { num: 30, den: 1 } },
  }, null, 2));
  write(path.join(prot, 'content', 'release.bin'), 'not-a-real-encrypted-payload\n');
  write(path.join(prot, 'core.enc'), 'fake\n');
  write(path.join(prot, 'package', 'personal', 'key.txt'), 'fake-token-do-not-use\n');
  write(path.join(prot, 'LICENSE'), 'Proprietary — all rights reserved\n');

  const p3 = plan(prot);
  check('protected：识别 CREDENTIALS_PRESENT / PROTECTED_SOURCE', () => {
    if (p3.status !== 0) throw new Error(`status=${p3.status}\n${p3.stderr}`);
    const codes = new Set(p3.json.blockers.map((b) => b.code));
    if (!codes.has('CREDENTIALS_PRESENT')) throw new Error('缺 CREDENTIALS_PRESENT');
    if (!codes.has('PROTECTED_SOURCE')) throw new Error('缺 PROTECTED_SOURCE');
  });
  check('protected：auto 不强行 rehost', () => {
    if (p3.json.verdict.depth === 'rehost') throw new Error('auto 把 protected 判成 rehost');
  });

  const p4 = plan(prot, '--mode', 'rehost', '--strict');
  check('protected：--mode rehost --strict 退出 1 且报 REHOST_PROTECTED', () => {
    if (p4.status !== 1) throw new Error(`status=${p4.status}`);
    const codes = new Set((p4.json?.blockers || []).map((b) => b.code));
    if (!codes.has('REHOST_PROTECTED')) throw new Error('缺 REHOST_PROTECTED');
  });

  /* ── 4. 产物存在，且没有写进仓库 ── */
  check('计划产物只落在 --out-dir', () => {
    const id = p1.json.id;
    for (const f of ['plan.json', 'plan.md']) {
      const p = path.join(outDir, id, f);
      if (!fs.existsSync(p)) throw new Error(`缺 ${p}`);
    }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
