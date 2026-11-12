/**
 * 壁纸层提供者：把「同一条公式」分别用 GPU 与纯 JS 求值。
 *
 * 为什么要有这个文件：desktop-kit 的壁纸是静态渐变 + 固定噪点，Skia 画它只要 0.05ms。
 * GPU 接进来必然更慢 —— 所以比的是另一件事：**流动氛围**（时间驱动的 fBm）这一层，
 * 两个引擎各自需要多少毫秒。公式、分辨率、调色板、时间轴完全一致，只换求值引擎。
 *
 * GPU 走 headless-gl（原生 OpenGL），不依赖浏览器；JS 走逐像素计算，是 Skia 侧
 * 唯一可行的实现方式（Skia 没有噪声着色器）。
 */
import { createRequire } from 'node:module';
import { ImageData as NapiImageData } from '@napi-rs/canvas';
import { DEFAULT_TOKENS as T } from '../desktop.mjs';

const require = createRequire(import.meta.url);

/** headless-gl 是原生模块，允许从仓外目录加载（不要塞进主仓 node_modules）。 */
export function loadGL() {
  for (const p of [process.env.HEADLESS_GL, 'gl', '/tmp/gl-probe/node_modules/gl']) {
    if (!p) continue;
    try { return require(p); } catch { /* try next */ }
  }
  return null;
}

const hex = (s) => {
  const v = parseInt(String(s).slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
const WALL = { blue: 'blueWall', light: 'lightWall', orange: 'orangeWall', red: 'redWall' };
const paletteOf = (theme) => {
  const c = T.palette[WALL[theme] || 'blueWall'];
  return { c0: hex(c[0]), c1: hex(c[1]), c2: hex(c[2]), amp: theme === 'light' ? 0.09 : theme === 'orange' ? 0.14 : 0.16 };
};

/* ───────────────────────────── GPU ───────────────────────────── */
const VS = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';

const FS = `precision highp float;
uniform float u_time;
uniform vec2  u_res;
uniform vec3  c0;      // 外圈
uniform vec3  c1;      // 中段
uniform vec3  c2;      // 中心亮部
uniform float u_amp;   // 流体调制幅度（浅色壁纸更小，避免脏）

float h21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);                    // smoothstep，线性插值会留方块边界
  float a = h21(i), b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s / 0.9375;                               // 归一到 0..1
}
void main(){
  // readPixels 的原点在左下，这里直接翻成左上，省一次逐行 memcpy
  vec2 uv = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_res;
  float t = u_time * 0.11;

  vec2 q  = uv * 3.0;
  float f = fbm(q + vec2(0.0, t));                 // 同一公式，JS 侧逐字复刻
  float g = fbm(q * 1.7 + vec2(t * 0.8, -t * 0.6));

  // 复刻 canvas 的双圆心径向渐变 |P-(C0+t·d)| = r0+t·Δr：解二次方程取小根，
  // 单圆心近似会让整片画面明显偏平（实测左上暗 12/255、右下亮 12/255）
  vec2  C0 = vec2(0.62, 0.42) * u_res, C1 = vec2(0.55, 0.55) * u_res;
  float r0 = 60.0, r1 = 0.95 * u_res.x, dr = r1 - r0;
  vec2  dv = C1 - C0, fv = uv * u_res - C0;
  float qa = dot(dv, dv) - dr * dr;
  float qb = -2.0 * (dot(fv, dv) + r0 * dr);
  float qc = dot(fv, fv) - r0 * r0;
  float tg;
  if (abs(qa) < 1e-6) { tg = -qc / max(qb, 1e-6); }
  else {
    float sq = sqrt(max(qb * qb - 4.0 * qa * qc, 0.0));
    float t1 = (-qb - sq) / (2.0 * qa), t2 = (-qb + sq) / (2.0 * qa);
    // 两根一正一负时取正根（负根对应「朝向另一端」的伪解），与 canvas 实测一致
    tg = (t1 >= 0.0 && t2 >= 0.0) ? min(t1, t2) : max(t1, t2);
  }
  vec3 base = mix(c2, c1, clamp(tg / 0.42, 0.0, 1.0));
  base = mix(base, c0, clamp((tg - 0.42) / 0.36, 0.0, 1.0));
  base += (f - 0.5) * u_amp + (g - 0.5) * u_amp * 0.45;

  // 左上暗角：复刻 canvas 线性渐变 0.20 → 0(@45%) → 0.06
  float a = (uv.x + uv.y) * 0.5;
  float alpha = a < 0.45 ? mix(0.20, 0.0, a / 0.45) : mix(0.0, 0.06, (a - 0.45) / 0.55);
  base *= 1.0 - alpha;
  // 固定位置颗粒（不随 t 变化 → 不闪），近似参考片的壁纸织纹
  float grain = h21(gl_FragCoord.xy * 1.37) - 0.5;
  // 内置壁纸的噪点层（灰度、alpha 20–35、globalAlpha 0.48）等效于按 k≈0.0527 向中灰
  // 混合，并把基调抬高 6.5/255；两次都是实测拟合出来的，见 tools/probe-bg.mjs 的校准输出。
  base = mix(base, vec3(0.5), 0.0527);
  base += 0.0255 + grain * 0.012;

  gl_FragColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;

export function createGPUProvider({ width, height }) {
  const glCreate = loadGL();
  if (!glCreate) throw new Error('headless-gl 不可用：请设 HEADLESS_GL 指向 gl 模块，或在独立目录 npm i gl');
  const gl = glCreate(width, height, { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('headless-gl 创建上下文失败');

  const sh = (type, src) => {
    const o = gl.createShader(type);
    gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(o));
    return o;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, width, height);

  const U = {
    time: gl.getUniformLocation(prog, 'u_time'),
    res: gl.getUniformLocation(prog, 'u_res'),
    c0: gl.getUniformLocation(prog, 'c0'),
    c1: gl.getUniformLocation(prog, 'c1'),
    c2: gl.getUniformLocation(prog, 'c2'),
    amp: gl.getUniformLocation(prog, 'u_amp'),
  };
  gl.uniform2f(U.res, width, height);
  gl.uniform3f(U.c0, ...paletteOf('blue').c0);
  gl.uniform3f(U.c1, ...paletteOf('blue').c1);
  gl.uniform3f(U.c2, ...paletteOf('blue').c2);
  gl.uniform1f(U.amp, paletteOf('blue').amp);

  const pixels = Buffer.alloc(width * height * 4);
  const arr = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const image = new NapiImageData(arr, width, height);

  let cur = '';
  const drawMs = [], readMs = [];
  return {
    name: 'gpu',
    paint(ctx, theme, t) {
      if (theme !== cur) {
        const p = paletteOf(theme);
        gl.uniform3f(U.c0, ...p.c0); gl.uniform3f(U.c1, ...p.c1); gl.uniform3f(U.c2, ...p.c2);
        gl.uniform1f(U.amp, p.amp);
        cur = theme;
      }
      const a = performance.now();
      gl.uniform1f(U.time, t || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const b = performance.now();
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const c = performance.now();
      ctx.putImageData(image, 0, 0);
      drawMs.push(b - a); readMs.push(c - b);
      return true;
    },
    stats() {
      const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      return { draws: drawMs.length, drawMs: mean(drawMs), readMs: mean(readMs), totalMs: mean(drawMs) + mean(readMs) };
    },
    dispose() { try { gl.getExtension('STACKGL_destroy_context').destroy(); } catch { /* ignore */ } },
  };
}

/* ───────────────────────────── JS ───────────────────────────── */
/** 与 GPU 完全相同的公式（4 个八度），只是求值在 CPU 上。 */
export function createJSProvider({ width, height }) {
  const inv = 1 / 0.9375;
  const hash = (x, y) => {
    // 与 GLSL 的 h21 逐字对应：fract 两次 + 同一点积，只差 float32/float64 精度
    let px = x * 123.34, py = y * 456.21;
    px -= Math.floor(px); py -= Math.floor(py);
    const dot = px * (px + 45.32) + py * (py + 45.32);
    px += dot; py += dot;
    const v = px * py;
    return v - Math.floor(v);
  };
  const smooth = (f) => f * f * (3 - 2 * f);

  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth(x - ix), fy = smooth(y - iy);
    const a = hash(ix, iy), b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    const top = a + (b - a) * fx, bot = c + (d - c) * fx;
    return top + (bot - top) * fy;
  }
  function fbm(x, y) {
    let s = 0, a = 0.5, px = x, py = y;
    for (let k = 0; k < 4; k++) { s += a * vnoise(px, py); px *= 2.03; py *= 2.03; a *= 0.5; }
    return s * inv;
  }

  const img = new NapiImageData(new Uint8ClampedArray(width * height * 4), width, height);
  const data = img.data;
  const xs = new Float32Array(width);      // 噪声坐标
  const fx = new Float32Array(width);      // 到渐变内圆心的 x 位移
  for (let x = 0; x < width; x++) { xs[x] = (x / width) * 3; fx[x] = x - 0.62 * width; }
  // 双圆心径向渐变的常数项（与 GLSL 同式）
  const CX0 = 0.62 * width, CY0 = 0.42 * height;
  const DVX = 0.55 * width - CX0, DVY = 0.55 * height - CY0;
  const R0 = 60, DR = 0.95 * width - R0;
  const QA = DVX * DVX + DVY * DVY - DR * DR;
  const QB0 = -2 * R0 * DR, QC0 = R0 * R0;

  let cur = '';
  let pal = paletteOf('blue');
  const ms = [];
  return {
    name: 'js',
    paint(ctx, theme, t) {
      if (theme !== cur) { pal = paletteOf(theme); cur = theme; }
      const a = performance.now();
      const tt = (t || 0) * 0.11;
      const { c0, c1, c2, amp } = pal;
      let k = 0;
      for (let y = 0; y < height; y++) {
        const v = y / height;
        const qy = v * 3 + tt;
        const gy = v * 3 * 1.7 - tt * 0.6;
        const fy = y - CY0;
        for (let x = 0; x < width; x++) {
          const qx = xs[x];
          const f = fbm(qx, qy);
          const g = fbm(qx * 1.7 + tt * 0.8, gy);
          const ux = fx[x];
          const qb = -2 * (ux * DVX + fy * DVY + R0 * DR);
          const qc = ux * ux + fy * fy - QC0;
          let tg;
          if (Math.abs(QA) < 1e-6) tg = -qc / (qb || 1e-6);
          else {
            const sq = Math.sqrt(Math.max(qb * qb - 4 * QA * qc, 0));
            const t1 = (-qb - sq) / (2 * QA), t2 = (-qb + sq) / (2 * QA);
            tg = (t1 >= 0 && t2 >= 0) ? Math.min(t1, t2) : Math.max(t1, t2);
          }
          const e1 = Math.min(1, Math.max(0, tg / 0.42));
          const e2 = Math.min(1, Math.max(0, (tg - 0.42) / 0.36));
          let r = c2[0] + (c1[0] - c2[0]) * e1, gg = c2[1] + (c1[1] - c2[1]) * e1, bb = c2[2] + (c1[2] - c2[2]) * e1;
          r += (c0[0] - r) * e2; gg += (c0[1] - gg) * e2; bb += (c0[2] - bb) * e2;
          const m = (f - 0.5) * amp + (g - 0.5) * amp * 0.45;
          const aa = (x / width + v) * 0.5;
          const alpha = aa < 0.45 ? 0.20 * (1 - aa / 0.45) : 0.06 * ((aa - 0.45) / 0.55);
          const vig = 1 - alpha;
          const grain = (hash(x * 1.37, y * 1.37) - 0.5) * 0.012;
          // 与 GPU 侧一致：按 KK=0.0527 向中灰混合，替代内置壁纸的噪点层
          const mix1 = 1 - 0.0527, mixG = 0.5 * 0.0527 + 0.0255;
          data[k] = (((r + m) * vig) * mix1 + mixG + grain) * 255;
          data[k + 1] = (((gg + m) * vig) * mix1 + mixG + grain) * 255;
          data[k + 2] = (((bb + m) * vig) * mix1 + mixG + grain) * 255;
          data[k + 3] = 255;
          k += 4;
        }
      }
      ctx.putImageData(img, 0, 0);
      ms.push(performance.now() - a);
      return true;
    },
    stats() {
      const mean = (xs2) => (xs2.length ? xs2.reduce((a, b) => a + b, 0) / xs2.length : 0);
      return { draws: ms.length, totalMs: mean(ms) };
    },
    dispose() {},
  };
}

export function makeProvider(kind, opts) {
  if (kind === 'gpu') return createGPUProvider(opts);
  if (kind === 'js') return createJSProvider(opts);
  return null;
}
