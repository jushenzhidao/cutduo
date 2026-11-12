#!/usr/bin/env node
/**
 * CanvasKit + SkSL 单帧基准（正确 uniform 布局）。
 * 对照 @napi-rs/canvas 的 1.5ms 绘制 / 28ms 帧输出，判断 SkSL 值不值得接。
 *
 *   node desktop-kit/tools/bench-sksl.cjs [--frames 12] [--json out.json]
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '../..');
const BIN = path.join(ROOT, 'node_modules/canvaskit-wasm/bin');
const init = require(path.join(BIN, 'canvaskit.js'));
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(get('frames', 12));
const JSON_OUT = get('json', null);

const SKSL = `
uniform float u_time;
uniform float2 u_res;
float hash(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }
half4 main(float2 p) {
  float2 uv = p / u_res;
  float band = 0.5 + 0.5 * sin(uv.x * 5.0 - u_time * 1.2);
  float3 bg = mix(float3(0.035, 0.080, 0.240), float3(0.160, 0.360, 0.820), uv.y * 0.65 + band * 0.22);
  float n = hash(floor(p * 0.5)) - 0.5;
  return half4(bg + n * 0.022, 1.0);
}`;

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: s[Math.floor(s.length / 2)], max: s.at(-1) };
};

init({ locateFile: (f) => path.join(BIN, f) }).then((CK) => {
  const eff = CK.RuntimeEffect.Make(SKSL);
  if (!eff) throw new Error('SkSL 编译失败');
  const rows = [];
  for (const [W, H] of [[1440, 1080], [720, 540]]) {
    const ii = { width: W, height: H, colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB };
    const m = CK.Malloc(Uint8Array, W * H * 4);
    const surf = CK.MakeRasterDirectSurface(ii, m, W * 4);
    const cv = surf.getCanvas(), paint = new CK.Paint();
    for (let i = 0; i < 2; i++) {   // warmup
      const sh = eff.makeShader(new Float32Array([i / 60, W, H])); paint.setShader(sh);
      cv.drawPaint(paint); surf.flush(); sh.delete();
    }
    // A: SkSL draw + 零拷贝 raw
    const raw = [];
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      const sh = eff.makeShader(new Float32Array([i / 60, W, H]));
      if (!sh) throw new Error('makeShader null');
      paint.setShader(sh); cv.drawPaint(paint); surf.flush(); sh.delete();
      const px = m.toTypedArray();
      raw.push(performance.now() - a);
      if (i === 0) {
        let mn = 255, mx = 0;
        for (let k = 0; k < px.length; k += 4) { if (px[k] < mn) mn = px[k]; if (px[k] > mx) mx = px[k]; }
        if (mx - mn < 20) throw new Error(`像素退化 ${mn}..${mx}`);
      }
    }
    // B: SkSL draw + PNG
    const png = [];
    for (let i = 0; i < Math.min(N, 6); i++) {
      const a = performance.now();
      const sh = eff.makeShader(new Float32Array([i / 60, W, H]));
      paint.setShader(sh); cv.drawPaint(paint); surf.flush(); sh.delete();
      const img = surf.makeImageSnapshot();
      const b = img.encodeToBytes(CK.ImageFormat.PNG);
      img.delete();
      png.push(performance.now() - a);
      if (i === 0) console.log(`  ${W}x${H} PNG bytes ${b && b.length}`);
    }
    rows.push({ w: W, h: H, raw: stat(raw), png: stat(png) });
    surf.dispose();
  }
  console.log('SkSL 单帧耗时（CPU raster，正确 3-float uniform）');
  for (const r of rows) {
    console.log(`  ${r.w}x${r.h}  零拷贝 raw ${r.raw.mean.toFixed(1)} ms (p50 ${r.raw.p50.toFixed(1)})  ·  PNG ${r.png.mean.toFixed(1)} ms`);
  }
  if (JSON_OUT) fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(rows, null, 2));
}).catch((e) => { console.error('FAIL', e); process.exit(1); });
