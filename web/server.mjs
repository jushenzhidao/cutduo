#!/usr/bin/env node
/**
 * web/server.mjs — 客户自助出片的本地服务（零依赖）
 *
 *   node web/server.mjs [--port 8787] [--host 127.0.0.1]
 *
 * 接口：
 *   GET  /                      单页表单
 *   GET  /api/spec              表单元数据（段类型、容量、图标、音色、示例）
 *   POST /api/jobs              提交表单 → { jobId }
 *   POST /api/validate          只校验不渲染 → { ok, errors }
 *   GET  /api/jobs/:id          进度（读 status.json）
 *   GET  /api/jobs/:id/video    成品（Range 支持，可拖动进度）
 *   GET  /api/jobs              最近任务列表
 *
 * 三条实现约束：
 *   1. **一个任务一个独立进程**（detached + unref）：HTTP 进程重启不影响正在跑的渲染；
 *   2. **状态只落文件**（out/web/<id>/status.json），不存内存——重启后前端照样能查；
 *   3. **并发靠排队**：每单本身 8 worker，多开只会互相拖慢。超出上限进排队，
 *      由每次 /api/jobs 或状态轮询触发补位（lazy scheduling）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';
import { TYPES, CAPACITY, ICONS, DISCS, STICKERS, VOICES, SAMPLE, build } from './lib/build.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8787));
const HOST = arg('host', '127.0.0.1');
const WEB_DIR = path.join(REPO_ROOT, 'out', 'web');
const PUBLIC = path.join(REPO_ROOT, 'web', 'public');
/** 并发上限：默认 2（每单 8 worker，4 核以上机器都够用），CUTDUO_WEB_MAX_JOBS 可覆盖。 */
const MAX = (() => {
  const e = Number(process.env.CUTDUO_WEB_MAX_JOBS);
  return Number.isFinite(e) && e > 0 ? Math.floor(e) : Math.max(1, Math.min(3, Math.floor(os.cpus().length / 8)));
})();

fs.mkdirSync(WEB_DIR, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const newId = () => {
  const d = new Date();
  return `w-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
};

const jobDir = (id) => path.join(WEB_DIR, id);
const statusOf = (id) => {
  const p = path.join(jobDir(id), 'status.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { stage: 'unknown' }; }
};
const specOf = (id) => {
  const p = path.join(jobDir(id), 'spec.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

function listJobs(limit = 20) {
  if (!fs.existsSync(WEB_DIR)) return [];
  return fs.readdirSync(WEB_DIR)
    .filter((d) => fs.existsSync(path.join(WEB_DIR, d, 'status.json')))
    .map((d) => ({ id: d, ...statusOf(d) }))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, limit);
}

function runningCount() {
  return listJobs(100).filter((j) => !j.failed && j.stage !== 'done').length;
}

/** 排队：有空位就启动最早的 queued 任务。每次查询都会顺带补位（没人查说明没人在等）。 */
function pump() {
  const jobs = listJobs(100);
  const running = jobs.filter((j) => !j.failed && j.stage !== 'done' && j.stage !== 'queued').length;
  if (running >= MAX) return;
  const next = jobs.filter((j) => j.stage === 'queued').sort((a, b) => a.startedAt - b.startedAt)[0];
  if (!next) return;
  launch(next.id);
}

function launch(id) {
  const specFile = path.join(jobDir(id), 'spec.json');
  const child = spawn('node', [path.join(REPO_ROOT, 'web', 'pipeline.mjs'), '--id', id, '--spec', specFile], {
    cwd: REPO_ROOT, detached: true, stdio: 'ignore',
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  child.unref();
  fs.writeFileSync(path.join(jobDir(id), 'status.json'),
    JSON.stringify({ id, stage: 'queued', pct: 0, msg: '排队中', startedAt: Date.now() }, null, 2));
  // 立刻改写为 running 由 pipeline 负责；这里只保证 queued 状态落下
  setTimeout(() => {
    const s = statusOf(id);
    if (s && s.stage === 'queued') fs.writeFileSync(path.join(jobDir(id), 'status.json'),
      JSON.stringify({ ...s, stage: 'starting', msg: '启动中' }, null, 2));
  }, 400);
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 2e6) { reject(new Error('请求体过大（上限 2MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, rel) {
  const file = path.join(PUBLIC, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/** 成品：支持 Range，前端 <video> 才能拖动进度条。 */
function serveVideo(req, res, id) {
  const st = statusOf(id);
  if (!st || !st.video) { json(res, 404, { error: '还没有成品' }); return; }
  const file = path.resolve(REPO_ROOT, st.video);
  if (!fs.existsSync(file)) { json(res, 404, { error: '文件已不存在' }); return; }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-type': 'video/mp4',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-length': size, 'content-type': 'video/mp4', 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/spec' && req.method === 'GET') {
      return json(res, 200, {
        types: TYPES, capacity: CAPACITY, icons: ICONS, discs: DISCS, stickers: STICKERS,
        voices: VOICES, sample: SAMPLE, maxJobs: MAX, running: runningCount(),
      });
    }

    if (p === '/api/sample' && req.method === 'GET') return json(res, 200, SAMPLE);

    if (p === '/api/validate' && req.method === 'POST') {
      const spec = await readBody(req);
      const r = build(spec);
      return json(res, 200, { ok: r.ok, errors: r.errors, segments: r.params ? r.params.segments.length : 0, captions: r.params ? r.params.captions.length : 0 });
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const spec = await readBody(req);
      const v = build(spec);
      if (!v.ok) return json(res, 400, { error: '表单有 ' + v.errors.length + ' 处需要改', errors: v.errors });
      const id = newId();
      fs.mkdirSync(jobDir(id), { recursive: true });
      fs.writeFileSync(path.join(jobDir(id), 'spec.json'), JSON.stringify(spec, null, 2));
      fs.writeFileSync(path.join(jobDir(id), 'status.json'),
        JSON.stringify({ id, stage: 'queued', pct: 0, msg: '排队中', startedAt: Date.now() }, null, 2));
      pump();
      return json(res, 202, { jobId: id, queued: runningCount() >= MAX });
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      pump();
      return json(res, 200, { jobs: listJobs(Number(url.searchParams.get('limit') || 20)), maxJobs: MAX });
    }

    const mJob = /^\/api\/jobs\/([\w-]+)$/.exec(p);
    if (mJob && req.method === 'GET') {
      pump();
      const st = statusOf(mJob[1]);
      if (!st) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, { ...st, spec: specOf(mJob[1]) });
    }

    const mVideo = /^\/api\/jobs\/([\w-]+)\/video$/.exec(p);
    if (mVideo) return serveVideo(req, res, mVideo[1]);

    if (p.startsWith('/api/')) return json(res, 404, { error: '未知接口' });

    return serveStatic(res, p);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`客户出片台 → http://${HOST}:${PORT}`);
  console.log(`  并发上限 ${MAX} · 产物 out/web/ · Ctrl+C 停止`);
});
