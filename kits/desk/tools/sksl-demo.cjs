#!/usr/bin/env node
/**
 * CanvasKit + SkSL 能力验证：用 RuntimeEffect 逐像素画一条短片。
 * 走 MakeRasterDirectSurface 零拷贝拿 RGBA → ffmpeg rawvideo，绕开 WASM 不支持的 JPEG 编码。
 *
 * 注意：这是「能不能做」的验证，不是产线方案。本机 Node 无 GPU，
 * SkSL 在 CPU raster 下逐像素解释执行，慢于原生 Skia 约一个数量级（见 bench 报告）。
 *
 *   node desktop-kit/tools/sksl-demo.cjs --seconds 3 --fps 24 --w 720 --h 540
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '../..');
const BIN = path.join(ROOT, 'node_modules/canvaskit-wasm/bin');
const init = require(path.join(BIN, 'canvaskit.js'));
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const W = Number(get('w', 720)), H = Number(get('h', 540));
const FPS = Number(get('fps', 24)), SECONDS = Number(get('seconds', 3));
const OUT = path.resolve(get('out', path.join(ROOT, 'out/sksl-demo.mp4')));
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// SkSL：流动光带壁纸 + 一排 split-flap 翻牌块 + 确定性细噪点。
const SKSL = `
uniform float u_time;
uniform float2 u_res;
float hash(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }
half4 main(float2 p) {
  float2 uv = p / u_res;
  float band = 0.5 + 0.5 * sin(uv.x * 5.0 - u_time * 1.2);
  float3 bg = mix(float3(0.035, 0.080, 0.240), float3(0.160, 0.360, 0.820),
                  clamp(uv.y * 0.65 + band * 0.22, 0.0, 1.0));
  float2 grid = float2(6.0, 2.0);
  float2 cell = floor(uv * grid);
  float2 local = fract(uv * grid);
  float flip = step(0.5, fract(u_time * 0.55 + hash(cell) * 0.7));
  float inTile = step(0.06, local.x) * step(local.x, 0.94)
               * step(0.10, local.y) * step(local.y, 0.90);
  float row = step(0.34, uv.y) * step(uv.y, 0.66);
  float seam = step(abs(local.y - 0.5), 0.010);
  float3 tile = mix(float3(0.070, 0.075, 0.090), float3(0.130, 0.140, 0.165), flip);
  float3 col = mix(bg, tile, inTile * row);
  col = mix(col, float3(0.0), seam * inTile * row * 0.55);
  float n = hash(floor(p * 0.5)) - 0.5;
  col += n * 0.022;
  // 底部字幕条（纯 shader，无文字）
  float bar = step(0.86, uv.y) * step(uv.y, 0.95) * step(0.12, uv.x) * step(uv.x, 0.88);
  col = mix(col, float3(0.03, 0.035, 0.045), bar * 0.75);
  return half4(col, 1.0);
}`;

init({ locateFile: (f) => path.join(BIN, f) }).then(async (CK) => {
  const eff = CK.RuntimeEffect.Make(SKSL);
  if (!eff) throw new Error('SkSL 编译失败: ' + (eff && eff.errorText ? eff.errorText() : 'unknown'));
  const ii = { width: W, height: H, colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB };
  const mallocObj = CK.Malloc(Uint8Array, W * H * 4);
  const surface = CK.MakeRasterDirectSurface(ii, mallocObj, W * 4);
  if (!surface) throw new Error('MakeRasterDirectSurface 失败');
  const canvas = surface.getCanvas();
  const paint = new CK.Paint();

  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(FPS),
    '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', OUT], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise((res) => ff.once('close', res));

  const frames = Math.round(FPS * SECONDS);
  const t0 = performance.now();
  let drawMs = 0, firstFrame = null;
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const a = performance.now();
    // CanvasKit 0.42 的 uniform 必须严格等于声明大小：u_time(1) + u_res(2) = 3 个 float。
    // 多传一个会返回 null（首版就是这么出了一条空片），必须显式断言。
    const sh = eff.makeShader(new Float32Array([t, W, H]));
    if (!sh) throw new Error('makeShader 返回 null：uniform 布局与 SkSL 声明不匹配');
    paint.setShader(sh);
    canvas.drawPaint(paint);
    surface.flush();
    sh.delete();
    const b = performance.now();
    const px = mallocObj.toTypedArray();
    const buf = Buffer.from(px.buffer, px.byteOffset, px.byteLength);
    if (f === 0) {
      // 断言首帧不是退化画面：R 通道极差 < 20 说明 shader 没真正执行
      let mn = 255, mx = 0;
      for (let i = 0; i < buf.length; i += 4) { if (buf[i] < mn) mn = buf[i]; if (buf[i] > mx) mx = buf[i]; }
      if (mx - mn < 20) throw new Error(`首帧像素退化（R ${mn}..${mx}），shader 未执行`);
      firstFrame = Buffer.from(buf);
    }
    if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once('drain', res));
    drawMs += b - a;
  }
  ff.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
  const wall = performance.now() - t0;
  fs.writeFileSync(path.join(ROOT, 'out/sksl-first-frame.raw'), firstFrame);
  console.log(`✓ ${OUT}`);
  console.log(`  CanvasKit ${W}x${H} @${FPS}fps / ${frames} 帧 / ${SECONDS}s`);
  console.log(`  墙钟 ${(wall / 1000).toFixed(1)}s  ·  SkSL 绘制 ${(drawMs / frames).toFixed(1)} ms/帧  ·  ${(frames / (wall / 1000)).toFixed(1)} fps`);
  console.log(`  成片 ${(fs.statSync(OUT).size / 1048576).toFixed(2)}MB  ·  SkSL 编译 OK / uniform u_time+u_res OK`);
  surface.dispose(); paint.delete();
}).catch((e) => { console.error('FAIL', e); process.exit(1); });
