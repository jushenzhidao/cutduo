// 判断一个 .motion 模板能否「换宿主」到 Skia（@napi-rs/canvas）
//
//   node bench/motion-host/check-hostable.mjs            # 扫 templates/vendor 下全部
//   node bench/motion-host/check-hostable.mjs --json     # 输出 JSON
//
// 两条判据，缺一不可：
//   ① 源码可读：motion.json 的 content.protection 必须是 open（或缺失）
//   ② 引擎是 Canvas2D：src/ 里没有 dom.js，且 document.createElement 只出现在宿主入口
//      —— DOM/CSS 渲染需要浏览器布局引擎，换宿主等于自己写半个 Chrome，不成立
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const VENDOR = path.join(REPO, 'templates/vendor');
const asJson = process.argv.includes('--json');

const rows = [];
for (const name of fs.readdirSync(VENDOR).sort()) {
  const pkg = path.join(VENDOR, name, 'package');
  const manPath = path.join(pkg, 'motion.json');
  if (!fs.existsSync(manPath)) continue;

  let protection = 'missing', bin = null;
  try {
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    protection = man?.content?.protection ?? 'open';
    bin = man?.content?.path ? path.join(pkg, man.content.path) : null;
  } catch { /* 清单坏了 */ }

  let jsFiles = 0, encFiles = 0, hasDom = false, createEl = 0;
  if (bin && fs.existsSync(bin)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostable-'));
    try {
      execFileSync('unzip', ['-q', bin, '-d', tmp], { stdio: 'ignore' });
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            if (/\.enc$/.test(e.name)) encFiles++;
            else if (/\.(js|mjs)$/.test(e.name)) {
              jsFiles++;
              const s = fs.readFileSync(p, 'utf8');
              if (/(^|\/)dom\.js$/.test(p)) hasDom = true;
              // 只统计「非 canvas」的 createElement：离屏 canvas 可 shim，div/img 需要真 DOM
              for (const m of s.matchAll(/document\.createElement\(\s*['"]([a-z]+)['"]/g)) {
                if (m[1] !== 'canvas') createEl++;
              }
            }
          }
        }
      };
      walk(tmp);
    } catch { /* 解包失败 */ }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  const open = protection === 'open' || protection === 'missing';
  const canvas2d = jsFiles > 0 && !hasDom && createEl === 0;
  const ok = open && canvas2d;

  let why = '';
  if (!open) why = `源码加密（${encFiles} 个 .enc）`;
  else if (hasDom) why = 'DOM/CSS 渲染（有 dom.js）';
  else if (createEl > 0) why = `镜头里直接建 DOM（createElement ×${createEl}）`;
  else if (jsFiles === 0) why = '包里没有明文 JS';

  rows.push({ name, protection, jsFiles, encFiles, hasDom, createEl, hostable: ok, why });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('模板'.padEnd(24), 'protection'.padEnd(11), 'js'.padStart(4), 'enc'.padStart(5), ' 换宿主');
  for (const r of rows) {
    console.log(
      r.name.padEnd(24),
      r.protection.padEnd(11),
      String(r.jsFiles).padStart(4),
      String(r.encFiles).padStart(5),
      r.hostable ? '✓ 可行' : `✗ ${r.why}`,
    );
  }
  console.log('\n判据：① content.protection 为 open ② src/ 无 dom.js 且镜头不直接 createElement');
}
