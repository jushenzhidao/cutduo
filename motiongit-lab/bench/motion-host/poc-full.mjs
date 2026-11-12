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
const TPL_NAME = (() => { const i = process.argv.indexOf('--template'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'mac-desktop'; })();
const TPL = path.join(REPO, 'templates/vendor', TPL_NAME);
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

// 前置检测：DOM/CSS 渲染的模板换宿主不成立（需要浏览器布局引擎）
if (fs.existsSync(path.join(ENGINE, 'src/dom.js'))) {
  console.error(`${TPL_NAME} 使用 DOM/CSS 渲染（src/dom.js），换宿主需要自建布局引擎，不成立。`);
  console.error('用 check-hostable.mjs 查可换宿主的模板；该模板请走 motion-render.mjs（Chromium）。');
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(2);
}

// ① plan 里有编译后的 FILM，直接拿来当时间轴
const instDir = path.join(TPL, 'instance');
const planFile = fs.existsSync(instDir)
  ? fs.readdirSync(instDir).filter((f) => /^plan-.*\.json$/.test(f)).sort().pop()
  : null;

// 有 instance 就用模板自带的编译结果；没有就用 --shot/--props 手工造一条最小时间轴
let FILM;
if (planFile) {
  FILM = JSON.parse(fs.readFileSync(path.join(instDir, planFile), 'utf8')).FILM;
} else {
  const cliGet2 = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const shotName = cliGet2('shot', 'headline');
  const props = JSON.parse(cliGet2('props', JSON.stringify({
    look: 'ink', kicker: 'SKIA HOST', line1: '换宿主', line2: '*可行*',
    number: 480, suffix: '+', numberLabel: 'fps 实测', stamp: '已验证',
  })));
  FILM = {
    fps: Number(cliGet2('fps', 60)), width: Number(cliGet2('width', 1080)), height: Number(cliGet2('height', 1440)),
    end: 4, talkEnd: 4, tail: 0, ins: [], beats: [], globals: {}, presenter: { mode: 'video' },
    shots: [{ i: 0, type: shotName, layer: 'main', t0: 0, t1: 4, beats: { wow: 0.55 }, props }],
    custom: [],
  };
  console.log(`${TPL_NAME}: 无 instance，手工造 FILM（${shotName} / ${FILM.width}x${FILM.height}）`);
}

fs.mkdirSync(path.join(ENGINE, 'data'), { recursive: true });
fs.writeFileSync(path.join(ENGINE, 'data', 'film.js'), `export const FILM = ${JSON.stringify(FILM)};\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'venv.js'), `export const VENV = { fps: 30, v: [] };\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'face.js'), `export const FACE = { n: 0 };\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'subs.js'), `export const SUBS = [];\n`);
console.log(`FILM: ${FILM.shots.length} 镜 / ${FILM.end.toFixed(2)}s / ${FILM.fps}fps / ${FILM.width}x${FILM.height}`);

// ② 宿主 shim：main.js 的 DOM 依赖只有 getElementById / createElement / fonts / title
const canvas = createCanvas(FILM.width, FILM.height);
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

// --check：验证 frame(t) 是否无状态（分片并行前提）
// 同一时刻「直接渲染」与「先跑一段再渲染」应逐字节一致，否则分片会错位。
if (process.argv.includes('--check')) {
  await window.renderAt(0.2);
  await window.renderAt(10);
  const a = canvas.toBuffer('image/png');
  await window.renderAt(10);          // 连续渲染 10s
  await window.renderAt(10.5);
  await window.renderAt(11);          // 跳到 11s
  await window.renderAt(10);          // 再回到 10s
  const b = canvas.toBuffer('image/png');
  console.log(`无状态检查：${a.equals(b) ? 'PASS（逐字节一致）' : `FAIL（差 ${a.length} vs ${b.length} 字节）`}`);
}

// --bench：测连续渲染的每帧成本（不含编码）
if (process.argv.includes('--bench')) {
  const N = 90;
  await window.renderAt(0.5);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await window.renderAt(0.5 + i / FILM.fps);
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
