// film-kit 整片「换宿主」PoC：用模板自带 plan 里编译好的 FILM，直接驱动 main.js 在 Skia 上跑
//
//   node bench/motion-host/poc-full.mjs            # 渲染 1/8/20/40s 四帧
//   node bench/motion-host/poc-full.mjs 12 30      # 指定任意时间点
//
// 相比 poc.mjs（单镜头），这里跑的是完整宿主 main.js：壁纸、桌面图标、菜单栏、Dock、
// 摄像头窗口、转场、指针、字幕全都在，等于整片渲染能力。
//
// 需要补 4 个 data/*.js（模板运行时生成，包里没有）：
//   film.js（时间轴，取 plan.FILM）/ venv.js（音乐音量）/ face.js（人像框）/ subs.js（字幕）
// 四者都有空值回退，所以没有素材也能出片——只是人像窗口画占位剪影。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const TPL = path.join(REPO, 'templates/vendor/mac-desktop');
const PKG = path.join(TPL, 'package/content/release.bin');

if (!fs.existsSync(PKG)) {
  console.error(`模板包不存在：${PKG}\n（templates/vendor 不入库，需本地下载）`);
  process.exit(1);
}

const times = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
const AT = times.length ? times : [1, 8, 20, 40];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-full-'));
execFileSync('unzip', ['-q', PKG, '-d', OUT], { stdio: 'inherit' });
const ENGINE = path.join(OUT, 'engine');

// ① plan 里有编译后的 FILM，直接拿来当时间轴
const planFile = fs
  .readdirSync(path.join(TPL, 'instance'))
  .filter((f) => /^plan-.*\.json$/.test(f))
  .sort()
  .pop();
if (!planFile) throw new Error('instance/plan-*.json 不存在');
const plan = JSON.parse(fs.readFileSync(path.join(TPL, 'instance', planFile), 'utf8'));

fs.mkdirSync(path.join(ENGINE, 'data'), { recursive: true });
fs.writeFileSync(path.join(ENGINE, 'data', 'film.js'), `export const FILM = ${JSON.stringify(plan.FILM)};\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'venv.js'), `export const VENV = { fps: 30, v: [] };\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'face.js'), `export const FACE = { n: 0 };\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'subs.js'), `export const SUBS = [];\n`);
console.log(`FILM: ${plan.FILM.shots.length} 镜 / ${plan.FILM.end.toFixed(2)}s / ${plan.FILM.fps}fps`);

// ② 宿主 shim：main.js 的 DOM 依赖只有 getElementById / createElement / fonts / title
const canvas = createCanvas(plan.FILM.width, plan.FILM.height);
globalThis.window = globalThis;
globalThis.window.FILMKIT = { version: 1, warnings: [] };
globalThis.document = {
  getElementById: (id) => (id === 'cv' ? canvas : null),
  createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}),
  fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
  title: '',
};

// ③ Skia 不做字体族名回退，模板的 FAM.zh 首选 "PingFang SC"，必须注册别名
const CJK_DIR = path.join(REPO, 'assets/fonts');
GlobalFonts.registerFromPath(path.join(CJK_DIR, 'NotoSansSC-Medium.otf'), 'PingFang SC');
GlobalFonts.registerFromPath(path.join(CJK_DIR, 'NotoSansSC-Black.otf'), 'PingFang SC Black');

// ④ main.js 末尾的 IIFE 会自己 buildScenes 并 renderAt(0)，完成后把 title 置为 done
await import(pathToFileURL(path.join(ENGINE, 'src/main.js')).href);
for (let i = 0; i < 300; i++) {
  if (document.title === 'done' || String(document.title).startsWith('error')) break;
  await new Promise((r) => setTimeout(r, 50));
}
if (document.title !== 'done') {
  console.error('初始化失败：', document.title);
  process.exit(1);
}

// --bench：测连续渲染的每帧成本（不含编码）
if (process.argv.includes('--bench')) {
  const N = 90;
  await window.renderAt(0.5);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await window.renderAt(0.5 + i / plan.FILM.fps);
  const ms = (performance.now() - t0) / N;
  console.log(`单帧渲染 ${ms.toFixed(2)} ms → 单核 ${(1000 / ms).toFixed(0)} fps`);
}

const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });
for (const t of AT) {
  await window.renderAt(t);
  const p = path.join(outDir, `full-${String(t).replace('.', '_')}.png`);
  fs.writeFileSync(p, canvas.toBuffer('image/png'));
  console.log('wrote', p);
}

console.log('warnings:', JSON.stringify(window.FILMKIT.warnings).slice(0, 400));
fs.rmSync(OUT, { recursive: true, force: true });
