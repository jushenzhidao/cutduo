#!/usr/bin/env node
/**
 * headless-gl 原生 OpenGL 全屏 shader 基准：验证「GPU 路径」在本机是否成立。
 * 与 CanvasKit CPU raster 的 867 ms 对照，也与原生 2D 的 34.4 ms 对照。
 */
const createGL = require('gl');
const { performance } = require('node:perf_hooks');

const W = Number(process.argv[2] || 1440), H = Number(process.argv[3] || 1080);
const N = Number(process.argv[4] || 20);

const VS = `attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `precision highp float;
uniform float u_time; uniform vec2 u_res; varying vec2 v_uv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 uv = v_uv;
  float band = 0.5 + 0.5 * sin(uv.x * 5.0 - u_time * 1.2);
  vec3 bg = mix(vec3(0.035,0.080,0.240), vec3(0.160,0.360,0.820), clamp(uv.y*0.65 + band*0.22, 0.0, 1.0));
  vec2 grid = vec2(6.0, 2.0); vec2 cell = floor(uv*grid); vec2 local = fract(uv*grid);
  float flip = step(0.5, fract(u_time*0.55 + hash(cell)*0.7));
  float inTile = step(0.06,local.x)*step(local.x,0.94)*step(0.10,local.y)*step(local.y,0.90);
  float row = step(0.34,uv.y)*step(uv.y,0.66);
  float seam = step(abs(local.y-0.5), 0.010);
  vec3 tile = mix(vec3(0.070,0.075,0.090), vec3(0.130,0.140,0.165), flip);
  vec3 col = mix(bg, tile, inTile*row);
  col = mix(col, vec3(0.0), seam*inTile*row*0.55);
  col += (hash(floor(v_uv*vec2(u_res)*0.5)) - 0.5) * 0.022;
  float bar = step(0.86,uv.y)*step(uv.y,0.95)*step(0.12,uv.x)*step(uv.x,0.88);
  col = mix(col, vec3(0.03,0.035,0.045), bar*0.75);
  gl_FragColor = vec4(col, 1.0);
}`;

const gl = createGL(W, H, { preserveDrawingBuffer: true });
if (!gl) throw new Error('无法创建 GL 上下文');
gl.getExtension('STACKGL_resize_drawingbuffer');
if (gl.resize) gl.resize(W, H);

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
gl.useProgram(prog);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'a_pos');
gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const uTime = gl.getUniformLocation(prog, 'u_time');
const uRes = gl.getUniformLocation(prog, 'u_res');
gl.uniform2f(uRes, W, H);
gl.viewport(0, 0, W, H);

const pixels = Buffer.alloc(W * H * 4);
const drawMs = [], readMs = [];
for (let i = 0; i < N + 3; i++) {
  const a = performance.now();
  gl.uniform1f(uTime, i / 60);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  const b = performance.now();
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const c = performance.now();
  if (i >= 3) { drawMs.push(b - a); readMs.push(c - b); }
}
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: s[Math.floor(s.length / 2)], max: s.at(-1) };
};
const d = stat(drawMs), r = stat(readMs);
// 像素健全性：R 通道极差
let mn = 255, mx = 0;
for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] < mn) mn = pixels[i]; if (pixels[i] > mx) mx = pixels[i]; }
console.log(`headless-gl ${W}x${H}  ${gl.getParameter(gl.VERSION)}`);
console.log(`draw        ${d.mean.toFixed(2)} ms (p50 ${d.p50.toFixed(2)})`);
console.log(`readPixels  ${r.mean.toFixed(2)} ms (p50 ${r.p50.toFixed(2)})`);
console.log(`合计        ${(d.mean + r.mean).toFixed(2)} ms   ·  R 通道 ${mn}..${mx}`);
require('node:fs').writeFileSync(`/tmp/gl-probe/frame-${W}x${H}.rgba`, pixels);
