// CanvasKit + SkSL 可行性探针：回答三个问题
//   1) 逐帧绘制用 CanvasKit（WASM/Skia CPU）会不会比 @napi-rs/canvas（原生 Skia）快？
//   2) SkSL 全画幅 shader（胶片颗粒）每帧多少钱？离线烘一张 tile 再平铺又是多少？
//   3) CanvasKit 能不能替代现在的 JPEG 管道？（它有没有 JPEG 编码器、raw readback 多贵）
// 用法：node cankit-probe.mjs
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);
const BIN = path.join(process.cwd(), 'node_modules/canvaskit-wasm/bin');
const CK = await require(path.join(BIN, 'canvaskit.js'))({ locateFile: (f) => path.join(BIN, f) });

const W = 1920, H = 1080, N = 120;
const out = {};
function bench(name, fn) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn();
  out[name] = +((performance.now() - t0) / N).toFixed(3);
}

// ---- 1) 原生 Skia（@napi-rs/canvas）----
const nc = createCanvas(W, H);
const nx = nc.getContext('2d');
function nativeDraw() {
  nx.fillStyle = '#FAFAF7'; nx.fillRect(0, 0, W, H);
  for (let k = 0; k < 24; k++) {
    nx.fillStyle = k % 3 ? '#111214' : '#2462EA';
    nx.beginPath();
    nx.roundRect(120 + (k % 6) * 280, 160 + Math.floor(k / 6) * 170, 240, 120, 8);
    nx.fill();
  }
  nx.fillStyle = 'rgba(17,18,20,0.88)'; nx.fillRect(160, 930, 1600, 70);
}
bench('native_draw', nativeDraw);
bench('native_jpeg94', () => nc.toBuffer('image/jpeg', 94));
bench('native_raw_rgba', () => nc.data());

// ---- 2) CanvasKit CPU 表面 ----
const surface = CK.MakeSurface(W, H);
const cv = surface.getCanvas();
const pFill = new CK.Paint(), pInk = new CK.Paint(), pBlue = new CK.Paint();
pInk.setColor(CK.Color4f(0.067, 0.071, 0.078, 1));
pBlue.setColor(CK.Color4f(0.141, 0.384, 0.918, 1));
function ckDraw() {
  pFill.setColor(CK.Color4f(0.980, 0.980, 0.969, 1));
  cv.drawRect(CK.LTRBRect(0, 0, W, H), pFill);
  for (let k = 0; k < 24; k++) {
    const p = k % 3 ? pInk : pBlue;
    const x = 120 + (k % 6) * 280, y = 160 + Math.floor(k / 6) * 170;
    cv.drawRRect(CK.RRectXY(CK.LTRBRect(x, y, x + 240, y + 120), 8, 8), p);
  }
  pFill.setColor(CK.Color4f(0.067, 0.071, 0.078, 0.88));
  cv.drawRect(CK.LTRBRect(160, 930, 1760, 1000), pFill);
}
bench('ck_draw', ckDraw);
bench('ck_snapshot_png', () => { ckDraw(); const img = surface.makeImageSnapshot(); const b = img.encodeToBytes(CK.ImageFormat.PNG, 100); img.delete(); if (!b) throw new Error('png null'); });
bench('ck_readpixels_rgba', () => { ckDraw(); const img = surface.makeImageSnapshot(); const b = img.readPixels(0, 0, { width: W, height: H, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }); img.delete(); if (!b) throw new Error('readPixels null'); });

// JPEG 支持性
{
  const img = surface.makeImageSnapshot();
  out.canvaskit_jpeg_supported = !!img.encodeToBytes(CK.ImageFormat.JPEG, 94);
  img.delete();
}

// ---- 3) SkSL 颗粒 ----
const GRAIN = `
uniform float2 uSize;
uniform float uSeed;
uniform float uAmount;
float hash(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }
half4 main(float2 xy) {
  float n = hash(xy + uSeed) - 0.5;
  return half4(0.0, 0.0, 0.0, half(n * uAmount));
}`;
const eff = CK.RuntimeEffect.Make(GRAIN);
out.sksl_compiled = !!eff;
if (!eff) out.sksl_error = CK.getLastError?.();

if (eff) {
  const gp = new CK.Paint();
  gp.setShader(eff.makeShader([W, H, 0, 0.16]));
  bench('sksl_grain_fullframe', () => cv.drawRect(CK.LTRBRect(0, 0, W, H), gp));

  // 烘一张 512 tile（一次），再平铺整帧
  const TS = 512;
  const ts = CK.MakeSurface(TS, TS);
  const tp = new CK.Paint();
  tp.setShader(eff.makeShader([TS, TS, 0, 0.16]));
  const t0 = performance.now();
  ts.getCanvas().drawRect(CK.LTRBRect(0, 0, TS, TS), tp);
  const tile = ts.makeImageSnapshot();
  out.sksl_tile_bake_ms = +(performance.now() - t0).toFixed(3);
  const tilesX = Math.ceil(W / TS), tilesY = Math.ceil(H / TS);
  out.tile_grid = `${tilesX}x${tilesY}`;
  const dp = new CK.Paint();
  bench('sksl_tile_tiled_fullframe', () => {
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++)
      cv.drawImageRect(tile, CK.LTRBRect(0, 0, TS, TS), CK.LTRBRect(tx * TS, ty * TS, tx * TS + TS, ty * TS + TS), dp);
  });
  fs.writeFileSync('/tmp/grain-tile.png', Buffer.from(tile.encodeToBytes(CK.ImageFormat.PNG, 100)));
}

console.log(JSON.stringify(out, null, 2));
