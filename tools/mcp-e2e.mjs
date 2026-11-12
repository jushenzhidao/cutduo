#!/usr/bin/env node
/**
 * 云 MCP 端到端验收：模拟真实客户端的完整会话。
 * 用法：TOKEN=xxx node /tmp/mcp-e2e.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'https://cut-mcp.1task.cn';
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('需要 TOKEN 环境变量');
  process.exit(2);
}

let idSeq = 0;
const results = [];
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function post(body) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: r.status, text, json };
}

async function rpc(method, params) {
  return post({ jsonrpc: '2.0', id: ++idSeq, method, ...(params ? { params } : {}) });
}

async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const c = r.json?.result?.content?.[0]?.text;
  let data = null;
  try { data = c ? JSON.parse(c) : null; } catch { /* 纯文本 */ }
  return { rpc: r, isError: !!r.json?.result?.isError, data, raw: c };
}

function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(30)} ${detail}`);
}

const t0 = Date.now();

// 1. 握手
{
  const r = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'workbuddy-e2e', version: '1.0' },
  });
  const v = r.json?.result?.protocolVersion;
  rec('initialize', r.status === 200 && !!v, `HTTP ${r.status} protocolVersion=${v}`);
}

// 2. 通知（无 id，应 202 空体）
{
  const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  rec('notifications/initialized', r.status === 202 && r.text === '', `HTTP ${r.status} body=${r.text.length}B`);
}

// 3. 工具清单
let toolNames = [];
{
  const r = await rpc('tools/list');
  toolNames = (r.json?.result?.tools || []).map((t) => t.name);
  rec('tools/list', toolNames.length === 7, `${toolNames.length} 个：${toolNames.join(' ')}`);
}

// 4. capabilities
{
  const t = await tool('cutduo_capabilities');
  const kits = t.data?.kits || [];
  rec('cutduo_capabilities', kits.length === 5, `${kits.length} 支：${kits.map((k) => `${k.id}(${k.output})`).join(' ')}`);
}

// 5. describe
{
  const t = await tool('cutduo_describe', { kit: 'science' });
  const hasSchema = !!t.data?.schema;
  rec('cutduo_describe', hasSchema, `schema ${hasSchema ? '存在' : '缺失'}，presets ${(t.data?.presets || []).length} 个`);
}

// 6. validate 合法
{
  const t = await tool('cutduo_validate', { kit: 'paper', preset: 'v8t' });
  rec('cutduo_validate（合法）', t.data?.ok === true && !t.isError, `ok=${t.data?.ok} schema=${t.data?.schemaStatus}`);
}

// 7. validate 非法（应 isError + 精确路径）
{
  const t = await tool('cutduo_validate', { kit: 'paper', params: { scenes: [] } });
  const msg = (t.data?.messages || []).join('; ');
  rec('cutduo_validate（非法）', t.isError === true, msg || '(无消息)');
}

// 8. 未知工具
{
  const t = await tool('cutduo_nonexistent');
  rec('未知工具应报错', t.isError === true, (t.raw || '').slice(0, 60));
}

// 9. probe
{
  const s = Date.now();
  const t = await tool('cutduo_probe', { kit: 'mg', preset: 'default', at: 3 });
  const okPng = (t.data?.output?.bytes || 0) > 5000;
  rec('cutduo_probe', okPng, `${t.data?.output?.bytes}B @${t.data?.at}s ${((Date.now() - s) / 1000).toFixed(2)}s`);
}

// 10. render（同步等待）
let renderJobId = null;
let renderPath = null;
{
  const s = Date.now();
  const t = await tool('cutduo_render', { kit: 'mg', preset: 'default', out: 'e2e-mg.mp4' });
  const o = t.data?.output;
  renderJobId = t.data?.jobId || null;
  renderPath = o?.path || null;
  rec(
    'cutduo_render',
    !!o && o.frames > 0,
    o ? `${o.frames} 帧 ${o.durationSeconds}s ${o.fps}fps ${(o.bytes / 1048576).toFixed(2)}MB ${((Date.now() - s) / 1000).toFixed(1)}s` : JSON.stringify(t.data).slice(0, 80),
  );
}

// 11. job_status（用 render 回执里的 jobId 对账）
{
  const t = await tool('cutduo_job_status', { jobId: renderJobId || 'missing' });
  const same = t.data?.status === 'done' && t.data?.receipt?.output?.path === renderPath;
  rec('cutduo_job_status', same, `status=${t.data?.status} 路径一致=${same}`);
}

// 12. gate
{
  const t = await tool('cutduo_gate', { file: 'e2e-mg.mp4' });
  rec('cutduo_gate', t.data?.pass === true, `pass=${t.data?.pass} films=${(t.data?.films || []).length}`);
}

// 13. 下载产物（带 token）
{
  const name = (renderPath || '').split('/').pop();
  const r = await fetch(`${BASE}/files/${name}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const len = Number(r.headers.get('content-length') || 0);
  rec('产物下载（带 token）', r.status === 200 && len > 100000, `HTTP ${r.status} ${(len / 1048576).toFixed(2)}MB`);
}

// 14. 下载不带 token（应 401）
{
  const name = (renderPath || '').split('/').pop();
  const r = await fetch(`${BASE}/files/${name}`);
  rec('产物下载（无 token）', r.status === 401, `HTTP ${r.status}（应为 401）`);
}

const pass = results.filter((x) => x.ok).length;
const total = results.length;
console.log(`\n${pass === total ? '全部通过' : '有失败'}：${pass}/${total}　总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(pass === total ? 0 : 1);
