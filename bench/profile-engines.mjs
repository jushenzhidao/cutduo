#!/usr/bin/env node
/**
 * 渲染引擎对比：Chromium / WebKit / Firefox 对同一 DOM 页面逐帧 seek + 截图。
 * 用法: node profile-engines.mjs [--frames 60]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit, firefox } from 'playwright';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FRAMES = Number(get('frames', 60));
const PKG = path.resolve(get('package', 'packages/editorial-sync.motion'));
const INPUTS = path.resolve(get('inputs', 'edits/inputs-v5-xiaoxiao.json'));

const tmp = fs.mkdtempSync('/tmp/mg-eng-');
execFileSync('python3', ['safe-unpack.py', PKG, tmp]);
const m = JSON.parse(fs.readFileSync(path.join(tmp, 'motion.json'), 'utf8'));
const inputs = JSON.parse(fs.readFileSync(INPUTS, 'utf8'));
const entry = path.join(tmp, m.runtime.entry);
const dir = path.dirname(entry);
let html = fs.readFileSync(entry, 'utf8');
html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_, s) =>
  `<script>\n${fs.readFileSync(path.resolve(dir, s), 'utf8')}\n</script>`);
html = html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (_, h) =>
  `<style>\n${fs.readFileSync(path.resolve(dir, h), 'utf8')}\n</style>`);
html = html.replace(/<head[^>]*>/i, (h) =>
  h + `<script>window.MOTION_INPUTS=${JSON.stringify(inputs).replace(/</g, '\\u003c')};</script>`);

const W = m.output.width, H = m.output.height;
const NUM = m.output.fps.num, DEN = m.output.fps.den;
const clip = { x: 0, y: 0, width: W, height: H };

function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; }

const ENGINES = { chromium, webkit, firefox };
console.log(`\n=== 引擎对比（${W}×${H}，${FRAMES} 帧）===`);
for (const [name, engine] of Object.entries(ENGINES)) {
  let browser;
  try {
    browser = await engine.launch(name === 'chromium'
      ? { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
      : { headless: true });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (window.READY || Promise.resolve()).then(() => document.fonts.ready));

    for (let i = 0; i < 5; i++) {
      await page.evaluate((t) => window.seek(t), i / NUM);
      await page.screenshot({ type: 'jpeg', quality: 90, clip });
    }
    const seek = [], shot = [];
    for (let f = 0; f < FRAMES; f++) {
      const t = f * DEN / NUM;
      seek.push(await page.evaluate((tt) => {
        const a = performance.now();
        window.seek(tt);
        return performance.now() - a;
      }, t));
      const a = performance.now();
      await page.screenshot({ type: 'jpeg', quality: 94, clip });
      shot.push(performance.now() - a);
    }
    const total = avg(seek) + avg(shot);
    console.log(`${name.padEnd(9)} seek ${avg(seek).toFixed(2)}ms | shot avg ${avg(shot).toFixed(2)} / p50 ${pct(shot, .5).toFixed(2)} / p90 ${pct(shot, .9).toFixed(2)}ms | 单帧≈${total.toFixed(2)}ms`);
  } catch (e) {
    console.log(`${name.padEnd(9)} 不可用: ${String(e.message).split('\n')[0]}`);
  } finally {
    if (browser) await browser.close();
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
