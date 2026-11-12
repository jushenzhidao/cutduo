#!/usr/bin/env node
/**
 * Chrome 逐帧截图性能剖析：同一页面、同一批帧，比较几种捕获路径。
 * 用法: node profile-chrome.mjs [--package packages/editorial-sync.motion] [--inputs edits/inputs-v5-xiaoxiao.json] [--frames 80]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PKG = path.resolve(get('package', 'packages/editorial-sync.motion'));
const INPUTS = path.resolve(get('inputs', 'edits/inputs-v5-xiaoxiao.json'));
const FRAMES = Number(get('frames', 80));
const tmp = fs.mkdtempSync('/tmp/mg-prof-');
execFileSync('python3', ['safe-unpack.py', PKG, tmp]);
const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'motion.json'), 'utf8'));
const inputs = JSON.parse(fs.readFileSync(INPUTS, 'utf8'));
const entry = path.join(tmp, manifest.runtime.entry);
const entryDir = path.dirname(entry);
let html = fs.readFileSync(entry, 'utf8');
html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_, src) =>
  `<script>\n${fs.readFileSync(path.resolve(entryDir, src), 'utf8')}\n</script>`);
html = html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (_, href) =>
  `<style>\n${fs.readFileSync(path.resolve(entryDir, href), 'utf8')}\n</style>`);
const boot = `<script>window.MOTION_INPUTS=${JSON.stringify(inputs).replace(/</g, '\\u003c')};</script>`;
html = html.replace(/<head[^>]*>/i, (h) => h + boot);

const W = manifest.output.width, H = manifest.output.height;
const NUM = manifest.output.fps.num, DEN = manifest.output.fps.den;
const clip = { x: 0, y: 0, width: W, height: H, scale: 1 };

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { avg, p50: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)] };
}

async function run(label, fn, page) {
  const seekMs = [], shotMs = [];
  for (let f = 0; f < FRAMES; f++) {
    const t = f * DEN / NUM;
    seekMs.push(await page.evaluate((tt) => {
      const a = performance.now();
      window.seek(tt);
      return performance.now() - a;
    }, t));
    const a = performance.now();
    await fn(page);
    shotMs.push(performance.now() - a);
  }
  const s = stats(seekMs), p = stats(shotMs);
  const total = s.avg + p.avg;
  console.log(`${label.padEnd(34)} seek ${s.avg.toFixed(2)}ms | shot avg ${p.avg.toFixed(2)} / p50 ${p.p50.toFixed(2)} / p90 ${p.p90.toFixed(2)}ms | 单帧≈${total.toFixed(2)}ms`);
  return total;
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.setContent(html, { waitUntil: 'load' });
const cdp = await context.newCDPSession(page);

// 热身
for (let i = 0; i < 8; i++) await page.screenshot({ type: 'jpeg', quality: 90, clip });

console.log(`\n=== Chrome 截图路径对比（${W}×${H}, ${FRAMES} 帧）===`);
async function safeRun(label, fn) {
  try { return await run(label, fn, page); }
  catch (e) { console.log(`${label.padEnd(34)} 不可用: ${String(e.message).split('\n')[0]}`); return null; }
}

const t1 = await safeRun('A. Playwright screenshot', (p) => p.screenshot({ type: 'jpeg', quality: 94, clip }));
const t2 = await safeRun('B. CDP fromSurface=true', (p) => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, clip, captureBeyondViewport: false, fromSurface: true }));
const t3 = await safeRun('C. CDP fromSurface=false', (p) => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, clip, captureBeyondViewport: false, fromSurface: false }));
const t4 = await safeRun('D. CDP + optimizeForSpeed', (p) => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, clip, captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: true }));

await page.addStyleTag({ content: '.sc{contain:layout style paint} #stage{contain:strict} .e{contain:layout style}' });
const t5 = await safeRun('E. D + CSS contain', (p) => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, clip, captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: true }));

// F: 非活动场景 content-visibility:hidden
await page.evaluate(() => {
  const orig = window.renderAt;
  window.renderAt = function (t) {
    orig(t);
    for (const sc of document.querySelectorAll('.sc')) {
      sc.style.contentVisibility = sc.style.display === 'none' ? 'hidden' : 'visible';
    }
  };
});
const t6 = await safeRun('F. E + content-visibility', (p) => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, clip, captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: true }));

console.log('\n=== 汇总（900 帧估算）===');
for (const [k, v] of Object.entries({ A: t1, B: t2, C: t3, D: t4, E: t5, F: t6 })) {
  if (v == null) { console.log(`${k}: 不可用`); continue; }
  console.log(`${k}: ${v.toFixed(2)}ms/帧 → ${(v * 900 / 1000).toFixed(1)}s / 900帧`);
}
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
