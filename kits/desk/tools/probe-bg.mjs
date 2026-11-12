#!/usr/bin/env node
/**
 * 探针：GPU 壁纸层要接到 Skia 上，必须先知道「贴回去」这一段的真实成本。
 * 单测四个原语，任何一项超过预算，混合方案就不成立。
 */
import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const W = 1440, H = 1080;
const require = createRequire(import.meta.url);
function loadGL() {
  for (const p of [process.env.HEADLESS_GL, 'gl', '/tmp/gl-probe/node_modules/gl']) {
    if (!p) continue;
    try { return require(p); } catch { /* next */ }
  }
  return null;
}
const glCreate = loadGL();
const stat = (xs) => { xs.sort((a, b) => a - b); return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: xs[xs.length >> 1] }; };

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

/* 1. putImageData：6.2MB 的全屏像素贴回 canvas */
{
  const raw = Buffer.alloc(W * H * 4, 128);
  const arr = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
  // 构造一次，避免把 ImageData 分配算进成本
  const probe = new NapiImageData(arr, W, H);
  const xs = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    probe.data[0] = i & 255;               // 制造微小差异，防优化
    ctx.putImageData(probe, 0, 0);
    xs.push(performance.now() - a);
  }
  const s = stat(xs);
  console.log(`putImageData 1440x1080      ${s.mean.toFixed(2)} ms   p50 ${s.p50.toFixed(2)}`);
}

/* 2. drawImage 全屏：作为对照（Skia 内部 memcpy + 变换） */
{
  const layer = createCanvas(W, H);
  const lg = layer.getContext('2d');
  lg.fillStyle = '#123456'; lg.fillRect(0, 0, W, H);
  const xs = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    ctx.drawImage(layer, 0, 0);
    xs.push(performance.now() - a);
  }
  const s = stat(xs);
  console.log(`drawImage 全屏 canvas      ${s.mean.toFixed(2)} ms   p50 ${s.p50.toFixed(2)}`);
}

/* 3. 现状 wallpaper()：双渐变 + 噪点贴图 */
{
  const noise = createCanvas(W, H);
  const ng = noise.getContext('2d');
  ng.fillStyle = 'rgba(255,255,255,0.08)'; ng.fillRect(0, 0, W, H);
  const xs = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    const g = ctx.createRadialGradient(W * 0.62, H * 0.42, 60, W * 0.55, H * 0.55, W * 0.95);
    g.addColorStop(0, '#2D5BD6'); g.addColorStop(0.42, '#1B3577');
    g.addColorStop(0.78, '#0B1430'); g.addColorStop(1, '#0B1430');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const v = ctx.createLinearGradient(0, 0, W, H);
    v.addColorStop(0, 'rgba(0,0,0,0.20)'); v.addColorStop(0.45, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.06)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = 0.48; ctx.drawImage(noise, 0, 0); ctx.restore();
    xs.push(performance.now() - a);
  }
  const s = stat(xs);
  console.log(`现状 wallpaper()           ${s.mean.toFixed(2)} ms   p50 ${s.p50.toFixed(2)}`);
}

/* 4. 纯 JS 逐像素 fBm：Skia 侧若想自己做流体氛围，只有这条路 */
{
  const xs = [];
  for (let i = 0; i < 3; i++) {
    const a = performance.now();
    const im = ctx.createImageData(W, H);
    const d = im.data;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const u = x / W, v = y / H;
        const n = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453;
        const f = n - Math.floor(n);
        const k = (y * W + x) * 4;
        d[k] = 20 + f * 40; d[k + 1] = 30 + f * 60; d[k + 2] = 90 + f * 120; d[k + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    xs.push(performance.now() - a);
  }
  const s = stat(xs);
  console.log(`JS 逐像素 fBm(1 oct)       ${s.mean.toFixed(1)} ms    p50 ${s.p50.toFixed(1)}`);
}

/* 5. GPU：fBm 流体 + readPixels */
if (glCreate) {
  const gl = glCreate(W, H, { preserveDrawingBuffer: true });
  if (!gl) { console.log('GPU 上下文创建失败'); process.exit(0); }
  const VS = `attribute vec2 a; void main(){ gl_Position=vec4(a,0.,1.); }`;
  const FS = `precision highp float;
  uniform vec3 u;            // u.x=time u.yz=res
  float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float n2(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
  float fbm(vec2 p){ float s=0.,a=.5; for(int k=0;k<5;k++){ s+=a*n2(p); p*=2.03; a*=.5; } return s; }
  void main(){ vec2 uv=gl_FragCoord.xy/u.yz;
    float t=u.x*.12;
    vec2 q=uv*3.0;
    vec2 w=vec2(fbm(q+vec2(0.,t)), fbm(q+vec2(5.2,1.3)-t));
    float f=fbm(q+w*1.6);
    vec3 c=mix(vec3(.04,.07,.20),vec3(.16,.32,.86),smoothstep(.2,.9,f));
    c=mix(c,vec3(.55,.40,.95),smoothstep(.6,1.,f)*.5);
    c*=1.0-0.55*length(uv-0.5);
    gl_FragColor=vec4(c,1.);}`;
  const mk = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = gl.getUniformLocation(pr, 'u'); gl.uniform3f(u, 0, W, H);
  gl.viewport(0, 0, W, H);

  const pixels = Buffer.alloc(W * H * 4);
  const draw = [], read = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    gl.uniform3f(u, i / 60, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const b = performance.now();
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const c = performance.now();
    draw.push(b - a); read.push(c - b);
  }
  const sd = stat(draw), sr = stat(read);
  console.log(`GPU fBm draw               ${sd.mean.toFixed(2)} ms   p50 ${sd.p50.toFixed(2)}`);
  console.log(`GPU readPixels 1440x1080   ${sr.mean.toFixed(2)} ms   p50 ${sr.p50.toFixed(2)}`);

  // 合成路径：readPixels → putImageData
  const arr = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const im = new NapiImageData(arr, W, H);
  const comp = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    gl.uniform3f(u, i / 60, W, H); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    ctx.putImageData(im, 0, 0);
    comp.push(performance.now() - a);
  }
  const sc = stat(comp);
  console.log(`GPU 背景 → canvas 合成       ${sc.mean.toFixed(2)} ms   p50 ${sc.p50.toFixed(2)}`);
}
