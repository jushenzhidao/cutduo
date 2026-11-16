#!/usr/bin/env node
/**
 * 常驻渲染 daemon：进程内复用 Skia / 字体 / 场景 / worker 池，消除冷启动与 worker 启动开销。
 *
 * 启动: node render-daemon.mjs 7799
 * 请求: POST /render {"inputs":"edits/inputs-v6.json","out":"out/x.mp4","audio":"edits/audio-v6.m4a","workers":8}
 * 健康: GET /health
 */
import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { loadInputs, renderIncremental, mixAudio, initCanvas, renderFrame, applyTheme, setSkin } from './canvas-editorial.mjs';

class WorkerPool {
  constructor(size, inputsPath, theme = 'knowledge') {
    this.idle = [];
    this.queue = [];
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./canvas-editorial.mjs', import.meta.url), {
        workerData: { persistent: true, inputsPath, theme },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      w.on('message', (m) => {
        if (m && m.ready) { this.idle.push(w); this.flush(); }
      });
      w.on('error', (e) => console.error('pool worker error', e));
      this.workers.push(w);
    }
  }
  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.flush();
    });
  }
  flush() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const { task, resolve, reject } = this.queue.shift();
      const onMsg = (m) => {
        w.off('message', onMsg);
        if (m && m.ok) {
          const bad = (task.theme && m.theme !== task.theme)
            || (task.skin && m.skin !== task.skin)
            || (task.inputsPath && m.inputsPath !== path.resolve(task.inputsPath));
          if (bad) {
            reject(new Error(`worker 参数不一致：期望 ${task.theme}/${task.skin}/${path.resolve(task.inputsPath)}，实际 ${m.theme}/${m.skin}/${m.inputsPath}`));
            return;
          }
          resolve(m); this.idle.push(w); this.flush();
        } else reject(new Error((m && m.error) || 'worker failed'));
      };
      w.on('message', onMsg);
      w.postMessage(task);
    }
  }
}

const DEFAULT_INPUTS = path.resolve('edits/inputs-v6.json');
loadInputs(DEFAULT_INPUTS);
initCanvas();
renderFrame(1.0); // warmup：字体、Skia 表面、绘制缓存
const POOL_SIZE = Math.max(1, Number(process.argv[3] || 8));
const POOL = new WorkerPool(POOL_SIZE, DEFAULT_INPUTS);

// 主题/输入是主线程全局状态，多主题请求必须串行，否则互相污染
let RENDER_QUEUE = Promise.resolve();
function enqueue(fn) {
  const run = RENDER_QUEUE.then(fn, fn);
  RENDER_QUEUE = run.catch(() => {});
  return run;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/render') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    for await (const c of req) body += c;
    const { inputs, out, audio, workers = 8, cacheMaxBytes, theme = 'knowledge', skin = '' } = JSON.parse(body || '{}');
    if (!out || !audio) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'out/audio required' }));
      return;
    }
    const ip = path.resolve(inputs || DEFAULT_INPUTS);
    const t0 = Date.now();
    const outPath = await enqueue(async () => {
      applyTheme(theme);
      setSkin(skin);
      loadInputs(ip);
      const list = await renderIncremental({ workers, inputsPath: ip, concat: false, pool: POOL, cacheMaxBytes, theme, skin });
      mixAudio(list, audio, out, true);
      return out;
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, ms: Date.now() - t0, out }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
});

const port = Number(process.argv[2] || 7799);
server.listen(port, '127.0.0.1', () => console.log('daemon listening ' + port));
