#!/usr/bin/env node
// headless-gl GPU 出片：1440x1080 @60fps，3s，rawvideo 喂 ffmpeg。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const createGL = require('gl');
const W = 1440, H = 1080, FPS = 60, FRAMES = 180;
const OUT = new URL('../../out/gl-slsh-3s.mp4', import.meta.url).pathname;

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
console.log(`headless-gl ${W}x${H} ${FRAMES} 帧 / 3s @${FPS}fps`);
console.log(`墙钟 ${(wall / 1000).toFixed(2)}s  ·  ${(FRAMES / (wall / 1000)).toFixed(1)} fps  ·  draw ${(drawTotal / FRAMES).toFixed(2)}ms  readPixels ${(readTotal / FRAMES).toFixed(2)}ms`);
console.log(`成片 ${OUT}  ${(fs.statSync(OUT).size / 1048576).toFixed(2)}MB  ·  末帧 R ${mn}..${mx}`);
