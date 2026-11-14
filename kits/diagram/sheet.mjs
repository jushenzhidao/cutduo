#!/usr/bin/env node
/**
 * kits/diagram/sheet.mjs · 图示段型的样张工具
 *
 * 一次出四类各一张 1920×1080 单图 + 一张 2×2 总览，用来肉眼比对版式。
 * 不参与出片，纯验证；改了 family 的几何就跑一遍看有没有塌。
 *
 *   node kits/diagram/sheet.mjs --out out/diagram-sheet
 */

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { DIRS, REPO_ROOT } from '../../src/root.mjs';
import { drawDiagram, validateDiagram } from './diagram.mjs';
import { CANVAS, FRAME, PALETTES } from './tokens.mjs';

const FONT_FILES = [
  ['NotoSansSC-Black.otf', 'NotoSC Black'],
  ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
  ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
  ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Regular'],
];

function registerFonts() {
  const dir = path.join(DIRS.assets, 'fonts');
  for (const [file, alias] of FONT_FILES) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) throw new Error(`缺字体：${p}（先跑 bash tools/fetch-fonts.sh）`);
    GlobalFonts.registerFromPath(p, alias);
  }
}

const RECIPES = [
  {
    family: 'data-bar',
    duration: 6,
    title: '四类样本的规模',
    unit: '个',
    note: '虚构教学数据，仅用于版式验证。',
    items: [
      { id: 'a', label: '样本 A', value: 20, unit: '个' },
      { id: 'b', label: '样本 B', value: 35, unit: '个' },
      { id: 'c', label: '样本 C', value: 50, unit: '个' },
      { id: 'd', label: '样本 D', value: 15, unit: '个' },
    ],
  },
  {
    family: 'data-line',
    duration: 7,
    title: '四次测量的读数',
    unit: '单位',
    note: '虚构观测序列，不表示未来预测。',
    items: [
      { id: 'p1', label: '第 1 次', x: 0, value: 8, unit: '单位' },
      { id: 'p2', label: '第 2 次', x: 2, value: 12, unit: '单位' },
      { id: 'p3', label: '第 3 次', x: 5, value: 9, unit: '单位' },
      { id: 'p4', label: '第 4 次', x: 9, value: 17, unit: '单位' },
    ],
  },
  {
    family: 'hierarchy',
    duration: 6,
    title: '资料与子类别',
    items: [
      { id: 'all', label: '资料' },
      { id: 'notes', label: '文字记录', parent: 'all' },
      { id: 'tables', label: '数据表', parent: 'all' },
      { id: 'interview', label: '访谈记录', parent: 'notes' },
    ],
  },
  {
    family: 'cycle',
    duration: 7,
    title: '首尾相接的三步',
    items: [
      { id: 'submit', label: '提交', text: '交出当前版本' },
      { id: 'feedback', label: '反馈', text: '获得具体意见' },
      { id: 'adjust', label: '调整', text: '形成下一版本' },
    ],
  },
  {
    family: 'definition',
    duration: 6,
    title: '两个容易混的概念',
    items: [
      { id: 'latency', label: '延迟', text: '一次请求从发出到拿到结果的总时间，包含排队、传输和处理。' },
      { id: 'throughput', label: '吞吐', text: '单位时间内能处理完多少请求，跟单次快慢不是一回事。' },
    ],
  },
  {
    family: 'compare',
    duration: 6,
    title: '改版前后的两项指标',
    beforeLabel: '改版前',
    afterLabel: '改版后',
    items: [
      { id: 'load', label: '首屏加载', before: '2.4 秒', after: '0.9 秒' },
      { id: 'mem', label: '常驻内存', before: '820 MB', after: '560 MB' },
    ],
  },
  {
    family: 'process',
    duration: 7,
    title: '一次改动的四个环节',
    items: [
      { id: 'draft', label: '起稿', text: '先定结构' },
      { id: 'review', label: '评审', text: '挑出硬伤' },
      { id: 'revise', label: '修改', text: '只改关节点' },
      { id: 'ship', label: '交付', text: '跑完门禁' },
    ],
  },
  {
    family: 'causal',
    duration: 7,
    title: '一个直接原因和两个结果',
    items: [
      { id: 'stale', label: '缓存没失效' },
      { id: 'slow', label: '首屏变慢' },
      { id: 'retry', label: '重试变多' },
    ],
    links: [
      { from: 'stale', to: 'slow' },
      { from: 'stale', to: 'retry' },
    ],
  },
  {
    family: 'parts',
    duration: 6,
    title: '一次加载的时间都花在哪',
    items: [
      { id: 'net', label: '网络', value: 420, unit: 'ms' },
      { id: 'parse', label: '解析', value: 180, unit: 'ms' },
      { id: 'exec', label: '执行', value: 260, unit: 'ms' },
      { id: 'paint', label: '绘制', value: 140, unit: 'ms' },
    ],
  },
  {
    family: 'experiment',
    duration: 6,
    title: '同一段代码的两种条件',
    items: [
      { id: 'c1', condition: '关闭缓存', result: '每次都要重新算一遍，平均 1.8 秒' },
      { id: 'c2', condition: '开启缓存', result: '命中后直接返回，平均 0.3 秒' },
    ],
  },
  {
    family: 'evidence',
    duration: 6,
    title: '一句原文',
    items: [
      {
        id: 'q1',
        text: '所有模型都是错的，但有些是有用的。',
        source: '统计学家 George Box，1976',
      },
    ],
  },
  {
    family: 'formula',
    duration: 7,
    title: '把总时长拆开',
    formula: 'T = a + b × n',
    items: [
      { id: 'T', symbol: 'T', meaning: '总耗时', value: '2.1 s' },
      { id: 'a', symbol: 'a', meaning: '固定开销', value: '0.4 s' },
      { id: 'b', symbol: 'b', meaning: '单次增量', value: '0.17 s' },
      { id: 'n', symbol: 'n', meaning: '请求次数', value: '10' },
    ],
  },
  {
    family: 'recap',
    duration: 7,
    title: '三句话收住',
    items: [
      { id: 'r1', label: '先量再改', text: '没有数字的优化只是换了一种写法。' },
      { id: 'r2', label: '瓶颈只有一个', text: '同时改三处，等于不知道是哪处起效。' },
      { id: 'r3', label: '留一条退路', text: '能回滚，才敢动关节点。' },
    ],
  },
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

async function main() {
  registerFonts();
  const outDir = path.resolve(REPO_ROOT, arg('out', 'out/diagram-sheet'));
  fs.mkdirSync(outDir, { recursive: true });
  const palette = PALETTES[arg('palette', 'paper')] ?? PALETTES.paper;

  const box = { x: FRAME.x, y: FRAME.y, width: FRAME.width, height: FRAME.height };
  const report = [];

  for (const r of RECIPES) {
    const check = validateDiagram(r);
    if (!check.ok) {
      report.push({ family: r.family, ok: false, errors: check.errors });
      continue;
    }
    const cv = createCanvas(CANVAS.w, CANVAS.h);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    const t0 = Date.now();
    const state = drawDiagram(ctx, r, r.duration * 0.55, box, { palette });
    const ms = Date.now() - t0;
    const file = path.join(outDir, `${r.family}.png`);
    fs.writeFileSync(file, cv.toBuffer('image/png'));
    report.push({ family: r.family, ok: true, ms, file, elements: state.bounds.length });
  }

  // 4×4 总览：加载真图缩放，不重绘 —— 重绘时版面尺寸变了，折行跟单图对不上，
  // 总览就会"看起来比单图更挤"，误导判断（第一版就是这么错的）。
  const TW = 460;
  const TH = Math.round((TW * 9) / 16);
  const COLS = 4;
  const PAD = 10;
  const rows = Math.ceil(RECIPES.length / COLS);
  const sheet = createCanvas(COLS * TW + (COLS + 1) * PAD, rows * (TH + 30) + PAD * 2 + 28);
  const sctx = sheet.getContext('2d');
  sctx.fillStyle = '#1b1b19';
  sctx.fillRect(0, 0, sheet.width, sheet.height);
  sctx.fillStyle = '#e8e4d8';
  sctx.font = '600 20px "NotoSC Black"';
  sctx.fillText('kits/diagram · 13 类图示（自绘，Skia 直出）', PAD, 24);

  for (let i = 0; i < RECIPES.length; i++) {
    const f = path.join(outDir, `${RECIPES[i].family}.png`);
    if (!fs.existsSync(f)) continue;
    const x = PAD + (i % COLS) * (TW + PAD);
    const y = 28 + Math.floor(i / COLS) * (TH + 30) + PAD;
    const img = await loadImage(f);
    sctx.drawImage(img, x, y, TW, TH);
    sctx.fillStyle = '#9aa08c';
    sctx.font = '500 16px "NotoSC Black"';
    sctx.fillText(RECIPES[i].family, x + 2, y + TH + 19);
  }
  const sheetFile = path.join(outDir, 'sheet.png');
  fs.writeFileSync(sheetFile, sheet.toBuffer('image/png'));

  console.log(JSON.stringify({ outDir, sheet: sheetFile, report }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
