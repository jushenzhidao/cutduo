#!/usr/bin/env node
/**
 * mcp/server.mjs · 云服务端 MCP（Streamable HTTP，零依赖）
 *
 * 为什么是「服务端」而不是本地 stdio：本地 stdio 只能给同一台机器的 agent 用，
 * 而渲染依赖 ffmpeg、24M 字体、以及能把 CPU 跑满的并行度——这些放在服务器上更合适，
 * 客户端只要能发 HTTPS 就能出片。
 *
 * 传输：JSON-RPC 2.0 over `POST /mcp`。单条消息、无状态、不要求 Mcp-Session-Id。
 * 这是 2025-03-26 规范允许的最简形态：请求带 id 就回 200 + JSON，是通知就回 202。
 *
 * 三个非 MCP 路由是必要的补充：
 *   POST /assets        二进制上传（MCP 工具参数是 JSON，塞不进几 MB 的音频）
 *   GET  /files/<name>  产物与资产下载
 *   GET  /health        存活探测（容器与 nginx 用）
 *
 * 鉴权：Authorization: Bearer <CUTDUO_TOKEN>。未设置该环境变量时不校验（仅本地开发）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import * as api from '../api/index.mjs';
import { ApiError, CODE, toApiError } from '../api/errors.mjs';
import { REPO_ROOT, DIRS } from '../src/root.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.CUTDUO_TOKEN || '';
const DATA_DIR = process.env.CUTDUO_DATA ? path.resolve(process.env.CUTDUO_DATA) : path.join(REPO_ROOT, 'data');
const PUBLIC_URL = (process.env.CUTDUO_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MAX_WAIT_SECONDS = Number(process.env.CUTDUO_WAIT_SECONDS || 90);
const MAX_UPLOAD_BYTES = Number(process.env.CUTDUO_MAX_UPLOAD_MB || 64) * 1024 * 1024;
const ASSET_TTL_DAYS = Number(process.env.CUTDUO_ASSET_TTL_DAYS || 7);
const SERVER_VERSION = '2.0.0';
const PROTOCOL_VERSION = '2025-03-26';

const ASSET_DIR = path.join(DATA_DIR, 'assets');
const FILE_DIRS = [DIRS.out, ASSET_DIR];
fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(DIRS.out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (p) => path.relative(DATA_DIR, p);

/* ────────────────────────── 工具定义 ────────────────────────── */

const KIT_ENUM = () => api.capabilities().kits.map((k) => k.id);

const TOOLS = [
  {
    name: 'cutduo_capabilities',
    description: '列出五套版式：id、画幅、默认帧率、内容模型（scenes[]/shots[]/segments[]）、schema 状态、可用 preset、并发上限。选版式前先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cutduo_describe',
    description: '拿单支版式的完整 params schema 与示例，用来构造正确的参数。',
    inputSchema: {
      type: 'object',
      properties: { kit: { type: 'string', enum: KIT_ENUM(), description: '版式 id' } },
      required: ['kit'],
      additionalProperties: false,
    },
  },
  {
    name: 'cutduo_validate',
    description: '只校验参数、不出片。返回精确到 JSON Pointer 的问题列表（如 /scenes/0/t0）。参数写错时先用它，比出片失败快得多。',
    inputSchema: {
      type: 'object',
      properties: {
        kit: { type: 'string', enum: KIT_ENUM() },
        params: { type: 'object', description: '内联参数（与 preset 二选一）' },
        preset: { type: 'string', description: '具名 preset，取自 capabilities 的 presets[].id' },
      },
      required: ['kit'],
      additionalProperties: false,
    },
  },
  {
    name: 'cutduo_render',
    description:
      '出片。默认同步等待最多 90 秒；超过则返回 jobId，改用 cutduo_job_status 轮询。audio 可传上传得到的 assetId（a- 开头）、内置音频文件名，或公网 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        kit: { type: 'string', enum: KIT_ENUM() },
        params: { type: 'object', description: '内联参数' },
        preset: { type: 'string', description: '具名 preset' },
        audio: { type: 'string', description: 'assetId / 内置音频名 / 公网 URL' },
        fps: { type: 'number', description: '覆盖帧率' },
        workers: { type: 'number', description: '并行 worker 数，默认 8' },
        out: { type: 'string', description: '产物文件名（不含目录），默认 <kit>.mp4' },
      },
      required: ['kit'],
      additionalProperties: false,
    },
  },
  {
    name: 'cutduo_job_status',
    description: '查任务状态与结果。status 为 queued/running/done/failed/cancelled；done 时带完整回执（帧数/时长/fps/体积/下载 URL）。',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cutduo_probe',
    description: '出单帧 PNG，用来确认版式与参数对不对，不消耗整片时间（通常 0.3–0.8 秒）。',
    inputSchema: {
      type: 'object',
      properties: {
        kit: { type: 'string', enum: KIT_ENUM() },
        params: { type: 'object' },
        preset: { type: 'string' },
        at: { type: 'number', description: '取第几秒的帧，默认 2.5' },
      },
      required: ['kit'],
      additionalProperties: false,
    },
  },
  {
    name: 'cutduo_gate',
    description: '对已存在的成片跑交付门禁（帧数/音画时长/空帧/黑帧）。返回 PASS/FAIL 与各项指标。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: '产物文件名与回执里的 output.path 一致' } },
      required: ['file'],
      additionalProperties: false,
    },
  },
];

/* ────────────────────────── 工具实现 ────────────────────────── */

/** 把 audio 的三种写法收敛成服务端绝对路径。 */
function resolveAudio(audio) {
  if (!audio) return null;
  if (/^https?:\/\//.test(audio)) {
    throw new ApiError(CODE.BAD_REQUEST, '暂不支持公网 URL 音轨', {
      hint: '请先 POST /assets 上传，拿到 assetId 后在 audio 里引用',
      fix: `curl -X POST ${PUBLIC_URL}/assets?name=x.m4a -H "Authorization: Bearer $CUTDUO_TOKEN" --data-binary @x.m4a`,
    });
  }
  if (audio.startsWith('a-')) {
    const hit = fs.readdirSync(ASSET_DIR).find((f) => f.startsWith(audio));
    if (!hit) {
      throw new ApiError(CODE.AUDIO_MISSING, `assetId 不存在：${audio}`, {
        hint: '资产超过保留期会被清理',
        fix: `重新 POST ${PUBLIC_URL}/assets 上传`,
      });
    }
    return path.join(ASSET_DIR, hit);
  }
  const builtin = path.join(DIRS.audio, audio);
  if (fs.existsSync(builtin)) return builtin;
  throw new ApiError(CODE.AUDIO_MISSING, `找不到音轨：${audio}`, {
    hint: 'audio 只接受 assetId（a- 开头）或内置音频文件名',
    fix: '先上传：POST /assets?name=x.m4a --data-binary @x.m4a',
  });
}

/** 出片：提交 job 并同步等待，超时降级为 jobId。 */
async function doRender(args) {
  const req = { kit: args.kit };
  if (args.params) req.params = args.params;
  if (args.preset) req.preset = args.preset;
  const audio = resolveAudio(args.audio);
  if (audio) req.audio = audio;
  const overrides = {};
  if (args.fps != null) overrides.fps = args.fps;
  if (args.workers != null) overrides.workers = args.workers;
  if (Object.keys(overrides).length) req.overrides = overrides;
  if (args.out) req.out = path.join(DIRS.out, path.basename(args.out));

  const sub = api.submitJob(req);
  const deadline = Date.now() + MAX_WAIT_SECONDS * 1000;
  let st = api.jobStatus(sub.jobId);

  while (!['done', 'failed', 'cancelled'].includes(st.status) && Date.now() < deadline) {
    await sleep(400);
    st = api.jobStatus(sub.jobId);
  }

  if (st.status === 'done') return withUrl(st.receipt);
  if (st.status === 'failed') {
    throw new ApiError(st.error?.code || CODE.RENDER_FAILED, st.error?.message || '渲染失败', {
      hint: st.error?.hint,
      fix: st.error?.fix,
      details: st.error?.details,
    });
  }
  // 排队中或仍在跑：交给调用方轮询
  return {
    pending: true,
    jobId: sub.jobId,
    status: st.status,
    queuePosition: st.queuePosition ?? null,
    note: `超过 ${MAX_WAIT_SECONDS}s 未完成，用 cutduo_job_status 轮询`,
  };
}

/** 回执里补下载 URL，客户端不必自己拼。 */
function withUrl(receipt) {
  if (!receipt?.output) return receipt;
  return {
    ...receipt,
    output: {
      ...receipt.output,
      downloadUrl: `${PUBLIC_URL}/files/${path.basename(receipt.output.path)}`,
    },
  };
}

const HANDLERS = {
  async cutduo_capabilities() {
    const c = api.capabilities();
    return {
      apiVersion: c.apiVersion,
      limits: c.limits,
      kits: c.kits.map((k) => ({
        id: k.id,
        name: k.name,
        contentModel: k.contentModel.name,
        output: `${k.output.width}x${k.output.height}@${k.output.fpsDefault}`,
        schemaStatus: k.schemaStatus,
        presets: k.presets.map((p) => p.id),
      })),
    };
  },
  async cutduo_describe(args) {
    const d = api.describe(args.kit);
    return { id: d.id, name: d.name, output: d.output, schema: d.schema, presets: d.presets, examples: d.examples };
  },
  async cutduo_validate(args) {
    return api.validate(args);
  },
  async cutduo_render(args) {
    return doRender(args);
  },
  async cutduo_job_status(args) {
    const st = api.jobStatus(args.jobId);
    // done 的回执里带相对路径，补一个可直接下载的 URL，客户端不必自己拼
    return st.receipt ? { ...st, receipt: withUrl(st.receipt) } : st;
  },
  async cutduo_probe(args) {
    const req = { kit: args.kit };
    if (args.params) req.params = args.params;
    if (args.preset) req.preset = args.preset;
    req.out = path.join(DIRS.out, `${args.kit}-probe.mp4`);
    if (args.at != null) req.overrides = { at: args.at };
    const r = await api.probe(req);
    return { ...r, downloadUrl: `${PUBLIC_URL}/files/${path.basename(r.output.path)}` };
  },
  async cutduo_gate(args) {
    const file = path.join(DIRS.out, path.basename(args.file));
    return api.gate(file);
  },
};

/* ────────────────────────── JSON-RPC ────────────────────────── */

function toolError(e) {
  const err = toApiError(e);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: false, error: err.toJSON() }, null, 2),
    }],
    isError: true,
  };
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cutduo', version: SERVER_VERSION },
        instructions:
          '视频出片服务。先用 cutduo_capabilities 选版式，用 cutduo_describe 拿参数 schema，' +
          '再用 cutduo_render 出片（默认同步等待 90s，超时返回 jobId 用 cutduo_job_status 轮询）。' +
          '音轨先用 POST /assets 上传拿 assetId。',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // 通知不回包

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const fn = HANDLERS[name];
      if (!fn) {
        return reply({
          content: [{ type: 'text', text: `未知工具：${name}。可用：${Object.keys(HANDLERS).join(', ')}` }],
          isError: true,
        });
      }
      try {
        const out = await fn(args);
        return reply({
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          ...(out && out.ok === false ? { isError: true } : {}),
        });
      } catch (e) {
        return reply(toolError(e));
      }
    }

    default:
      if (isNotification) return null;
      return fail(-32601, `不支持的方法：${method}`);
  }
}

/* ────────────────────────── HTTP ────────────────────────── */

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function authed(req) {
  if (!TOKEN) return true; // 本地开发不设 token
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  // 定长比较，避免按字节短路泄漏 token 长度信息
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) {
      throw new ApiError(CODE.BAD_REQUEST, '请求体超过 4MB', {
        hint: '音频请走 POST /assets 上传，不要塞进 JSON',
      });
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 单独包一层：JSON 语法错误是调用方的输入问题（-32700），不是服务端内部错误
    throw new ApiError(CODE.BAD_REQUEST, `请求体不是合法 JSON：${e.message}`, {
      hint: 'Content-Type 应为 application/json，且只能发单条 JSON-RPC 消息',
    });
  }
}

async function handleUpload(req, res, url) {
  const name = String(url.searchParams.get('name') || 'asset.bin');
  const ext = (path.extname(name) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const assetId = `a-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const target = path.join(ASSET_DIR, `${assetId}${ext}`);
  const ws = fs.createWriteStream(target);

  let size = 0;
  try {
    // 手动搬运而不是 req.pipe(ws)：超限时 pipe 会让 ws 上的 'finish' 永不触发，
    // 请求就一直挂到 nginx 超时（504），客户端拿不到 413 的真实原因。
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        ws.destroy();
        fs.rmSync(target, { force: true });
        return json(res, 413, {
          ok: false,
          error: {
            code: 'UPLOAD_TOO_LARGE',
            message: `超过 ${MAX_UPLOAD_BYTES / 1048576}MB 上限`,
            fix: '压缩音频（AAC 128k 足够），或调大 CUTDUO_MAX_UPLOAD_MB',
          },
        });
      }
      if (!ws.write(chunk)) await once(ws, 'drain');
    }
    ws.end();
    await once(ws, 'finish');
  } catch {
    ws.destroy();
    fs.rmSync(target, { force: true });
    return json(res, 400, { ok: false, error: { code: 'UPLOAD_ABORTED', message: '上传中断' } });
  }

  if (!size) {
    fs.rmSync(target, { force: true });
    return json(res, 400, { ok: false, error: { code: 'EMPTY_BODY', message: '请求体为空' } });
  }

  json(res, 200, {
    ok: true,
    assetId,
    name,
    bytes: size,
    url: `${PUBLIC_URL}/files/${path.basename(target)}`,
  });
}

function serveFile(res, name) {
  const safe = path.basename(name);
  for (const dir of FILE_DIRS) {
    const p = path.join(dir, safe);
    if (!p.startsWith(dir)) continue;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const stat = fs.statSync(p);
      const type = safe.endsWith('.mp4') ? 'video/mp4'
        : safe.endsWith('.png') ? 'image/png'
          : safe.endsWith('.json') ? 'application/json'
            : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=3600',
      });
      fs.createReadStream(p).pipe(res);
      return;
    }
  }
  json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个文件：${safe}` } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      version: SERVER_VERSION,
      repoRoot: REPO_ROOT,
      dataDir: DATA_DIR,
      maxConcurrent: api.MAX_JOBS,
      auth: TOKEN ? 'enabled' : 'disabled',
    });
  }

  if (!authed(req)) {
    return json(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '缺少或错误的 Bearer token' },
    });
  }

  try {
    if (req.method === 'POST' && url.pathname === '/assets') return await handleUpload(req, res, url);

    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      return serveFile(res, url.pathname.slice('/files/'.length));
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      let msg;
      try {
        msg = await readJson(req);
      } catch (e) {
        const err = toApiError(e);
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
      }
      if (!msg) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '空消息' } });

      const isNotification = msg.id === undefined || msg.id === null;
      const out = await handleRpc(msg);
      if (isNotification || out === null) {
        res.writeHead(202).end(); // 通知：无 body
        return;
      }
      return json(res, 200, out);
    }

    if (req.method === 'GET' && url.pathname === '/mcp') {
      // 协议允许 GET 开 SSE 流；本服务无服务端主动推送，直接告知不支持
      return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '本服务只支持 POST /mcp' } });
    }

    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
  } catch (e) {
    const err = toApiError(e);
    json(res, err.code === CODE.BAD_REQUEST ? 400 : 500, { jsonrpc: '2.0', id: null, error: err.toJSON() });
  }
});

/* ────────────────────────── 过期清理 ────────────────────────── */

function sweep() {
  const cutoff = Date.now() - ASSET_TTL_DAYS * 86400_000;
  let n = 0;
  for (const dir of [ASSET_DIR, path.join(DIRS.out, 'jobs')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); n++; }
      } catch { /* 并发删除，忽略 */ }
    }
  }
  if (n) console.log(`[sweep] 清理 ${n} 个超过 ${ASSET_TTL_DAYS} 天的文件`);
}

server.listen(PORT, HOST, () => {
  console.log(`cutduo mcp ${SERVER_VERSION}  http://${HOST}:${PORT}`);
  console.log(`  repo   ${REPO_ROOT}`);
  console.log(`  data   ${DATA_DIR}`);
  console.log(`  public ${PUBLIC_URL}`);
  console.log(`  auth   ${TOKEN ? 'Bearer token 已启用' : '未启用（本地模式）'}`);
  console.log(`  limits ${api.MAX_JOBS} 并发 / 单次等待 ${MAX_WAIT_SECONDS}s / 上传上限 ${MAX_UPLOAD_BYTES / 1048576}MB`);
  sweep();
  setInterval(sweep, 3600_000).unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`收到 ${sig}，关闭服务`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
