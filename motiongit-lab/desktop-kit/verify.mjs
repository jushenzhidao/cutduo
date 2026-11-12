#!/usr/bin/env node
/**
 * desktop-kit · 版式自检
 *
 * 判据不是「看起来像」，是三条可量化的：
 *   1) 骨架几何 = 参考片实测坐标（容差 8px）
 *   2) 关键采样点颜色 ≈ 参考帧（平均通道差 ≤ 42）
 *   3) 动画真的在动（入场 / 逐字字幕 / 章节转场三处帧差）
 * 另加：字体注册、16 个镜头类型全部可渲染、未知类型硬失败、安全区。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, loadTokens, SHOT_TYPES } from './desktop.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REF = path.join(ROOT, 'ref', 'mac-desktop', 'frames', 't104.jpg');
const PARAMS = path.join(ROOT, 'desktop-kit', 'presets', 'demo.json');
const T = loadTokens();
const W = T.width, H = T.height;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
}

function px(d, x, y, w = W) {
  const i = (Math.round(y) * w + Math.round(x)) * 4;
  return [d[i], d[i + 1], d[i + 2]];
}
function diff(a, b) { return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3; }

function frameAt(params, at, presenter = null) {
  const c = createCanvas(W, H), g = c.getContext('2d');
  const r = createDesktopRenderer({ ctx: g });
  r.setContent({ ...params, presenter });
  r.renderFrame(at);
  return g.getImageData(0, 0, W, H).data;
}
function frameDigest(d, boxes) {
  let sum = 0;
  for (const [x, y, w, h] of boxes) {
    for (let yy = y; yy < y + h; yy += 4) for (let xx = x; xx < x + w; xx += 4) {
      const i = (yy * W + xx) * 4;
      sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    }
  }
  return sum;
}
function areaDiff(a, b, boxes) {
  let s = 0, n = 0;
  for (const [x, y, w, h] of boxes) {
    for (let yy = y; yy < y + h; yy += 3) for (let xx = x; xx < x + w; xx += 3) {
      const i = (yy * W + xx) * 4;
      s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
  }
  return s / Math.max(1, n);
}

async function main() {
  const nFonts = registerFonts(path.join(ROOT, 'assets', 'fonts'));
  check('字体注册 Noto Sans SC 三字重', nFonts === 3 && GlobalFonts.has('NotoSC Black'),
    `registered=${nFonts}, hasBlack=${GlobalFonts.has('NotoSC Black')}`);

  const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
  const c = createCanvas(W, H);
  const r = createDesktopRenderer({ ctx: c.getContext('2d') });
  r.setContent(P);
  const geo = r.geometry();

  /* 1. 骨架几何：参考片 t104 实测 */
  const REF_GEO = {
    menuH: 26, dockX: 280, dockY: 1000, dockW: 880, dockH: 74,
    presenterX: 940, presenterW: 378, iconX: 1370,
    subtitleZhY: 958, windowX: 40, windowY: 140, windowW: 895, windowH: 760,
  };
  const g = { ...geo.menuH !== undefined ? { menuH: geo.menuH } : {},
    dockX: geo.dock.x, dockY: geo.dock.y, dockW: geo.dock.w, dockH: geo.dock.h,
    presenterX: geo.presenter.x, presenterW: geo.presenter.w, iconX: geo.iconX,
    subtitleZhY: geo.subtitle.zhY, windowX: geo.window.x, windowY: geo.window.y,
    windowW: geo.window.w, windowH: geo.window.h };
  const worst = Object.entries(REF_GEO).map(([k, v]) => [k, Math.abs(g[k] - v)]).sort((a, b) => b[1] - a[1])[0];
  check('骨架几何 13 项（容差 8px）', worst[1] <= 8, `最大偏差 ${worst[0]}=${worst[1]}px`);

  /* 2. 采样点比色：只取骨架/背景，避开文案（参考片与复刻片文案不同） */
  if (!fs.existsSync(REF)) {
    check('参考帧存在', false, REF);
  } else {
    const img = await loadImage(REF);
    const rc = createCanvas(W, H), rg = rc.getContext('2d');
    rg.drawImage(img, 0, 0, W, H);
    const refD = rg.getImageData(0, 0, W, H).data;
    const our = frameAt(P, 12.5);
    const SAMPLES = [
      ['浅灰壁纸左上', 20, 120], ['浅灰壁纸顶部', 720, 40], ['浅灰壁纸右下', 1380, 930],
      ['白窗口主体', 500, 500], ['白窗口标题栏', 500, 160],
      ['Dock 背景', 300, 1070], ['菜单栏', 700, 8],
    ];
    const ds = SAMPLES.map(([n, x, y]) => [n, diff(px(refD, x, y), px(our, x, y))]);
    const avg = ds.reduce((a, b) => a + b[1], 0) / ds.length;
    check('采样点比色 7 处（平均 ≤42）', avg <= 42,
      `avg=${avg.toFixed(1)}  ` + ds.map(([n, v]) => `${n}:${v.toFixed(0)}`).join(' '));
  }

  /* 3. 安全区：字幕必须在 Dock 上方，窗口不越界 */
  check('字幕在 Dock 上方且留 ≥20px', T.subtitle.zhY < T.dock.y - 20,
    `zhY=${T.subtitle.zhY}, dockY=${T.dock.y}`);
  const w = T.window.default;
  check('默认窗口在安全区内', w.x >= 0 && w.y >= T.menuBar.h && w.x + w.w <= W && w.y + w.h <= H,
    `${w.x},${w.y} ${w.w}x${w.h}`);

  /* 4. 动画活性：入场 / 逐字字幕 / 翻牌转场 */
  // 只量翻牌块本身（420,284 起 250x160）；全窗口采样会把 118x146 的牌稀释掉。
  const entryBoxes = [[410, 280, 270, 160]];
  const a1 = frameAt(P, 11.25), a2 = frameAt(P, 12.5), a3 = frameAt(P, 11.85);
  const dEntry = areaDiff(a1, a2, entryBoxes), dMid = areaDiff(a2, a3, entryBoxes);
  check('翻牌入场动画有帧差', dEntry > 3 && dMid > 1,
    `端点Δ=${dEntry.toFixed(1)} 中段Δ=${dMid.toFixed(1)}`);
  const capBoxes = [[300, 900, 840, 100]];
  const b1 = frameAt(P, 11.35), b2 = frameAt(P, 12.0);
  check('逐字字幕有帧差', areaDiff(b1, b2, capBoxes) > 2,
    `Δ=${areaDiff(b1, b2, capBoxes).toFixed(1)}`);
  const trBoxes = [[0, 0, W, 900]];
  const t1 = frameAt(P, 32.0), t2 = frameAt(P, 33.2);
  check('章节翻牌转场有帧差', areaDiff(t1, t2, trBoxes) > 5,
    `Δ=${areaDiff(t1, t2, trBoxes).toFixed(1)}`);

  /* 5. 镜头覆盖：nominal + 交付时间轴（voiced）都要能渲，且成片时间点上动画真的在动 */
  let rendered = 0, err = '';
  try {
    for (const s of P.shots) { frameAt(P, (s.t0 + s.t1) / 2); rendered++; }
  } catch (e) { err = String(e.message || e); }
  let vCount = 0, vDiff = 0, vErr = '';
  const VOICED_PARAMS = path.join(ROOT, 'desktop-kit', 'presets', 'demo-voiced.json');
  if (fs.existsSync(VOICED_PARAMS)) {
    try {
      const V = JSON.parse(fs.readFileSync(VOICED_PARAMS, 'utf8'));
      const vBoxes = [[300, 200, 840, 700]];
      for (const s of V.shots) {
        // 对比「镜头刚入场」与「镜头中段」：稳定期两帧本就相同，取稳定期会误判动画失效。
        const a = frameAt(V, s.t0 + 0.05), b = frameAt(V, (s.t0 + s.t1) / 2);
        vDiff = Math.max(vDiff, areaDiff(a, b, vBoxes));
        vCount++;
      }
    } catch (e) { vErr = String(e.message || e); }
  }
  const voicedOK = vCount > 0 && vDiff > 1 && !vErr;
  check('全部分镜可渲染（nominal + 交付 voiced）',
    rendered === P.shots.length && !err && voicedOK,
    `nominal ${rendered}/${P.shots.length} · voiced ${vCount} 镜头 / 最大帧差 ${vDiff.toFixed(1)}` +
    `${err || vErr ? ' err=' + (err || vErr) : ''}`);
  // photo 依赖外部素材（Pexels 实拍图），示例分镜里没有，单独做「缺素材必须抛错」的负向断言
  const NEEDS_ASSET = new Set(['photo', 'clip']);
  const pure = SHOT_TYPES.filter((t) => !NEEDS_ASSET.has(t));
  const types = new Set(P.shots.map((s) => s.type));
  check(`示例覆盖全部 ${pure.length} 个纯组件镜头类型`, pure.every((t) => types.has(t)),
    `${types.size}/${pure.length}` + (types.has('photo') ? ' · 含 photo' : ''));

  let photoErr = '';
  try {
    const c = createCanvas(W, H);
    const r2 = createDesktopRenderer({ ctx: c.getContext('2d') });
    r2.setContent({ shots: [{ type: 'photo', t0: 0, t1: 1, args: { key: 'missing' } }], captions: [] });
    r2.renderFrame(0.5);
  } catch (e) { photoErr = String(e.message || e); }
  check('photo 缺素材时硬失败', /没有注入素材/.test(photoErr), photoErr || '未抛错');

  let clipErr = '';
  try {
    const c = createCanvas(W, H);
    const r3 = createDesktopRenderer({ ctx: c.getContext('2d') });
    r3.setContent({ shots: [{ type: 'clip', t0: 0, t1: 1, args: { key: 'missing' } }], captions: [] });
    r3.renderFrame(0.5);
  } catch (e) { clipErr = String(e.message || e); }
  check('clip 缺帧序列时硬失败', /没有注入帧序列/.test(clipErr), clipErr || '未抛错');

  /* 6. 负向：未知镜头类型必须硬失败，不能静默降级 */
  let rejected = false;
  try {
    const c2 = createCanvas(W, H);
    createDesktopRenderer({ ctx: c2.getContext('2d') })
      .setContent({ shots: [{ type: 'noSuchShot', t0: 0, t1: 1 }] });
  } catch (e) { rejected = /未知镜头类型/.test(String(e.message || e)); }
  check('未知镜头类型硬失败', rejected);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
