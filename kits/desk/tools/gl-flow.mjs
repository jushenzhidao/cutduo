#!/usr/bin/env node
/**
 * 7.2 Flow Map 蒸馏：一张 256² 位移场纹理 + fragment 三次平流采样，
 * 替代「每帧实时算流体」。产出 6s / 1440×1080 成片，测单帧与端到端。
 *
 * 依赖：headless-gl（原生模块，建议独立目录 npm i gl）
 *   NODE_PATH=/tmp/gl-probe/node_modules node desktop-kit/tools/gl-flow.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const createGL = require('gl');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');
const W = 1440, H = 1080, FPS = 60, FRAMES = 360;
const OUT = path.join(ROOT, 'out/gl-flow-6s.mp4');
const FLOW = path.join(ROOT, 'out/flow-256.rgba');
const NOISE = path.join(ROOT, 'out/noise-256.rgba');
for (const f of [FLOW, NOISE]) if (!fs.existsSync(f)) throw new Error(`缺少纹理 ${f}：先跑 curve-fit.py`);

const VS = `attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FS = `precision highp float;
uniform sampler2D u_flow; uniform sampler2D u_noise;
uniform float u_time; uniform vec2 u_res;
varying vec2 v_uv;
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
void main(){
  vec2 uv = v_uv;
  vec2 flow = texture2D(u_flow, uv).rg * 2.0 - 1.0;
  float ph = u_time * 0.11;
  vec2 p = uv;
  float acc = 0.0; float wsum = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    p += flow * (0.014 + 0.010 * fi) * (0.75 + 0.25 * sin(u_time * 0.7 + fi));
    float n1 = texture2D(u_noise, p * 1.0 + vec2(ph * 0.30, -ph * 0.22)).r;
    float n2 = texture2D(u_noise, p * 2.3 - vec2(ph * 0.55, ph * 0.41)).r;
    float w = 1.0 / (1.0 + fi);
    acc += (n1 * 0.65 + n2 * 0.35) * w;
    wsum += w;
  }
  acc /= wsum;
  vec3 deep = vec3(0.020, 0.055, 0.150);
  vec3 glow = vec3(0.180, 0.520, 1.000);
  vec3 col = mix(deep, glow, smoothstep(0.15, 0.95, acc));
  col += vec3(0.030, 0.060, 0.120) * smoothstep(0.55, 1.0, luma(col));
  col += (texture2D(u_noise, v_uv * u_res * 0.5).r - 0.5) * 0.020;
  float vign = smoothstep(0.95, 0.25, length(uv - 0.5));
  col *= 0.55 + 0.45 * vign;
  gl_FragColor = vec4(col, 1.0);
}`;

const gl = createGL(W, H, { preserveDrawingBuffer: true });
if (!gl) throw new Error('无法创建 GL 上下文');
const compile = (t, s) => {
  const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
  if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
  return o;
};
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'a_pos');
gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

function tex(unit, file, uniform) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, fs.readFileSync(file));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.uniform1i(gl.getUniformLocation(prog, uniform), unit);
}
tex(0, FLOW, 'u_flow');
tex(1, NOISE, 'u_noise');
const uTime = gl.getUniformLocation(prog, 'u_time');
gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), W, H);
gl.viewport(0, 0, W, H);

const ff = spawn('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(FPS),
  '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', OUT], { stdio: ['pipe', 'ignore', 'inherit'] });
const done = new Promise((res) => ff.once('close', res));

const pixels = Buffer.alloc(W * H * 4);
const t0 = performance.now();
let drawTotal = 0, readTotal = 0;
for (let i = 0; i < FRAMES; i++) {
  const a = performance.now();
  gl.uniform1f(uTime, i / FPS);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  const b = performance.now();
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const c = performance.now();
  drawTotal += b - a; readTotal += c - b;
  if (!ff.stdin.write(pixels)) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
const code = await done;
if (code !== 0) throw new Error('ffmpeg exit ' + code);
const wall = performance.now() - t0;
let mn = 255, mx = 0;
for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] < mn) mn = pixels[i]; if (pixels[i] > mx) mx = pixels[i]; }
console.log(`flow map ${W}x${H} ${FRAMES} 帧 / 6s @${FPS}fps`);
console.log(`墙钟 ${(wall / 1000).toFixed(2)}s  ·  ${(FRAMES / (wall / 1000)).toFixed(1)} fps  ·  draw ${(drawTotal / FRAMES).toFixed(2)}ms  readPixels ${(readTotal / FRAMES).toFixed(2)}ms`);
console.log(`成片 ${OUT}  ${(fs.statSync(OUT).size / 1048576).toFixed(2)}MB  ·  末帧 R ${mn}..${mx}`);
console.log(`纹理：flow 256² + noise 256² = 512KB（未压缩）`);
